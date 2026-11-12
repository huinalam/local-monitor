"""Read-only desktop lifecycle evidence; hook execution state stays independent."""
import json
import os
import re
from pathlib import Path


def annotation(text):
    # Tokenize strings separately: a title containing 'archived:true' is not a flag.
    tokens = re.findall(r'"(?:\\.|[^"\\])*"|[A-Za-z_][A-Za-z_0-9]*|[{}<>:]|[^\s]', text)
    if not tokens or ":" not in tokens:
        raise ValueError("incomplete annotation")
    depth, result, title = [], None, None
    for i, token in enumerate(tokens):
        if token.startswith('"'):
            if len(token) < 2 or not token.endswith('"'):
                raise ValueError('unterminated string')
        elif token in ('{', '<'):
            depth.append(token)
        elif token in ('}', '>'):
            if not depth or depth.pop() != ('{' if token == '}' else '<'):
                raise ValueError('unbalanced annotation')
        elif token == 'title' and not depth and tokens[i+1:i+2] == [':']:
            try:
                value = json.loads(tokens[i+2])
                title = ' '.join(value.split())[:512] or None if isinstance(value, str) else None
            except (ValueError, IndexError):
                title = None
        elif token == 'archived' and not depth:
            if result is not None or tokens[i+1:i+2] != [':'] or tokens[i+2:i+3] not in (['true'], ['false']):
                raise ValueError('invalid archive flag')
            result = tokens[i+2] == 'true'
    if depth:
        raise ValueError('unbalanced annotation')
    return result or False, title

def archived(text):
    return annotation(text)[0]


class Lifecycle:
    def __init__(self, root, cli_root, ledger):
        self.root, self.cli_root, self.ledger = map(Path, (root, cli_root, ledger))
        self.records, self.missing = {}, {}
        self.titles = {}
        self.load_failed = False
        self.dirty = False
        try:
            if self.ledger.stat().st_size > 4*1024*1024:
                raise ValueError('large ledger')
            data = json.loads(self.ledger.read_text())
            if data.get('schema') != 1 or data.get('root') != str(self.root) or not isinstance(data.get('records'), dict):
                raise ValueError('invalid ledger')
            for sid, r in data['records'].items():
                if (not isinstance(r, dict) or not isinstance(r.get('identity'), list)
                        or len(r['identity']) != 4 or any(type(n) is not int for n in r['identity'])
                        or type(r.get('excluded')) is not bool):
                    raise ValueError('invalid evidence')
            self.records = data['records']
        except FileNotFoundError:
            pass
        except (OSError, ValueError, TypeError):
            self.load_failed = True

    def scan(self, ids):
        self.titles = {}
        excluded = {sid for sid in ids if self.records.get(sid, {}).get('excluded') is True}
        errors = ['antigravity_lifecycle_ledger_invalid'] if self.load_failed else []
        if not ids:
            return excluded, errors
        try:
            dirs = [self.root/'conversations', self.root/'annotations']
            identity, names = [], []
            for d in dirs:
                stat = d.stat()
                identity.extend([stat.st_dev, stat.st_ino])
                names.append(set(os.listdir(d)))
            try:
                cli_names = set(os.listdir(self.cli_root/'conversations'))
            except FileNotFoundError:
                cli_names = set()
        except OSError:
            self.missing.clear()
            # An uninstalled source is normal until a binding has been observed.
            if self.records:
                errors.append('antigravity_lifecycle_unavailable')
            return excluded, errors
        before = json.dumps(self.records, sort_keys=True)
        for sid in ids:
            if not re.fullmatch(r'[A-Za-z0-9_-]{1,200}', sid):
                continue
            record = self.records.get(sid)
            if f'{sid}.db' in cli_names:
                self.missing.pop(sid, None)
                excluded.discard(sid)
                if f'{sid}.db' in names[0] or record:
                    errors.append('antigravity_lifecycle_ambiguous')
                continue
            db, has_annotation = f'{sid}.db' in names[0], f'{sid}.pbtxt' in names[1]
            if db and has_annotation:
                try:
                    p = dirs[1]/f'{sid}.pbtxt'
                    with p.open('r') as f:
                        raw = f.read(65537)
                    if len(raw) > 65536:
                        raise ValueError('large annotation')
                    flag, title = annotation(raw)
                    if title:
                        self.titles[sid] = title
                    self.records[sid] = {'identity': identity, 'excluded': flag}
                    self.missing.pop(sid, None)
                    if flag:
                        excluded.add(sid)
                    else:
                        excluded.discard(sid)
                except (OSError, ValueError, UnicodeError):
                    self.missing.pop(sid, None)
                    errors.append('antigravity_lifecycle_annotation_invalid')
            elif not db and not has_annotation and record and record['identity'] == identity:
                self.missing[sid] = self.missing.get(sid, 0)+1
                if self.missing[sid] >= 2:
                    record['excluded'] = True
                    excluded.add(sid)
            else:
                self.missing.pop(sid, None)
        self.dirty |= before != json.dumps(self.records, sort_keys=True)
        if self.dirty:
            try:
                self.ledger.parent.mkdir(parents=True, exist_ok=True)
                temp = self.ledger.with_suffix('.tmp')
                with temp.open('w') as f:
                    os.chmod(temp, 0o600)
                    json.dump({'schema': 1, 'root': str(self.root), 'records': self.records}, f)
                temp.replace(self.ledger)
                self.dirty = False
                self.load_failed = False
            except OSError:
                errors.append('antigravity_lifecycle_save_failed')
        return excluded, errors
