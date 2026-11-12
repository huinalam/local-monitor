import copy
import json
import math
import os
import sqlite3
import subprocess
import time
from datetime import datetime
from pathlib import Path
from .antigravity_lifecycle import Lifecycle
from .preview import Preview


def stamp(value):
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (TypeError, ValueError, AttributeError):
        return 0


def process_matches(record):
    """PID alone is unsafe: macOS reuses it. procStart is stored in UTC."""
    try:
        pid = int(record['pid'])
        if pid <= 0 or not record.get('procStart'):
            return False
        env = dict(os.environ, TZ='UTC', LC_ALL='C')
        started = subprocess.run(['ps', '-p', str(pid), '-o', 'lstart='],
                                 env=env, capture_output=True, text=True, timeout=2).stdout
        command = subprocess.run(['ps', '-ww', '-p', str(pid), '-o', 'comm='],
                                 capture_output=True, text=True, timeout=2).stdout.strip()
        return (' '.join(started.split()) == ' '.join(record['procStart'].split())
                and ('claude' in command.lower() or '/versions/' in command))
    except (OSError, ValueError, KeyError, subprocess.SubprocessError):
        return False


class Tail:
    """Read only complete JSONL records; bound initial scan and preserve partial writes."""
    def __init__(self):
        self.identity = None
        self.offset = 0

    def read(self, path):
        stat = path.stat()
        identity = (stat.st_dev, stat.st_ino)
        baseline = self.identity != identity or stat.st_size < self.offset
        with path.open('rb') as f:
            if baseline:
                self.offset = max(0, stat.st_size - 2 * 1024 * 1024)
                f.seek(self.offset)
                if self.offset:
                    f.readline()
                    self.offset = f.tell()
            else:
                f.seek(self.offset)
            records = []
            # Bound each poll; unfinished lines stay at the current offset.
            budget = 8 * 1024 * 1024
            while budget > 0:
                line = f.readline()
                if not line or not line.endswith(b'\n'):
                    break
                self.offset = f.tell()
                budget -= len(line)
                try:
                    value = json.loads(line)
                    if isinstance(value, dict):
                        records.append(value)
                except (ValueError, UnicodeError):
                    pass
        self.identity = identity
        return records, baseline


class Detector:
    def __init__(self, codex_home, claude_home, spool, *, alive=process_matches,
                 stale_seconds=600, limit=100, now=time.time, antigravity_home=None):
        self.codex_home, self.claude_home, self.spool = map(Path, (codex_home, claude_home, spool))
        self.alive, self.now = alive, now
        self.stale_seconds, self.limit = stale_seconds, limit
        self.started_at = now()
        self.rows, self.tails, self.seen_hooks, self.emitted = {}, {}, set(), set()
        self.previews = {}
        self.preview_since = {}
        self.preview_refresh = set()
        self.preview_retry_at = {}
        self.errors = []
        self.ready = False
        agy = Path(antigravity_home) if antigravity_home is not None else Path.home()/'.gemini/antigravity'
        self.lifecycle = Lifecycle(agy, agy.parent/'antigravity-cli', self.spool.parent/'antigravity-lifecycle.json')
        self.spool_signatures = {}
        self.process_table = None

    def hook_paths(self, spool, prefix=''):
        """Atomic hook renames change the directory, even when all old files remain."""
        try:
            stat = spool.stat()
            signature = (stat.st_dev, stat.st_ino, stat.st_mtime_ns, stat.st_ctime_ns)
        except FileNotFoundError:
            self.spool_signatures.pop(spool, None)
            return []
        if self.spool_signatures.get(spool) == signature:
            return []
        with os.scandir(spool) as entries:
            names = sorted(entry.name for entry in entries if entry.name.endswith('.json')
                           and prefix+entry.name not in self.seen_hooks)
        self.spool_signatures[spool] = signature
        return [spool/name for name in names]

    def process_alive(self, record, provider):
        if provider == 'claude' and self.alive is not process_matches:
            return self.alive(record)
        if self.process_table is None:
            self.process_table = {}
            try:
                result = subprocess.run(['ps','-axo','pid=,lstart=,comm='],
                    env=dict(os.environ,TZ='UTC',LC_ALL='C'),capture_output=True,text=True,timeout=2)
                if result.returncode == 0:
                    for line in result.stdout.splitlines():
                        fields = line.split(None,6)
                        if len(fields) == 7 and fields[0].isdigit():
                            self.process_table[int(fields[0])] = (' '.join(fields[1:6]),fields[6])
            except (OSError,subprocess.SubprocessError):
                pass
        try:
            pid = int(record['pid'])
            started, command = self.process_table[pid]
            matches = ('claude' in command.lower() or '/versions/' in command) if provider == 'claude' else Path(command).name in ('agy','antigravity')
            return pid > 0 and bool(record.get('procStart')) and started == ' '.join(record['procStart'].split()) and matches
        except (ValueError,TypeError,KeyError,AttributeError):
            return False

    def row(self, provider, sid, cwd='', title=''):
        key = provider + ':' + sid
        if key not in self.rows:
            self.rows[key] = dict(provider=provider, session_id=sid, cwd=cwd,
                                  title=title or Path(cwd).name or sid[:8],
                                  status='unknown', observed_at=0, turn_id=None)
        self.rows[key].update(cwd=cwd or self.rows[key]['cwd'],
                              title=title or self.rows[key]['title'])
        return self.rows[key]

    def transition(self, row, status, at, turn, events, notify):
        if status == 'completed':
            if row.get('completed_turn') != turn or row.get('completed_at') is None:
                # Historical completions retain their original age on startup.
                row['completed_at'] = self.now() if notify else at
                row['completed_turn'] = turn
        elif status != 'disconnected':
            row.pop('completed_at', None)
            row.pop('completed_turn', None)
        row.update(status=status, observed_at=at, turn_id=turn)
        key = (row['provider'], row['session_id'], turn)
        if status == 'completed' and notify and turn and key not in self.emitted:
            self.emitted.add(key)
            events.append(dict(event='response_completed', provider=row['provider'],
                               session_id=row['session_id'], turn_id=turn,
                               title=row['title'], cwd=row['cwd'], at=at))

    def codex(self, events):
        dbs = list(self.codex_home.glob('state_*.sqlite'))
        if not dbs:
            self.errors.append('codex_database_missing')
            return
        db = max(dbs, key=lambda p: int(p.stem.split('_')[-1]))
        try:
            with sqlite3.connect(db.resolve().as_uri() + '?mode=ro', uri=True, timeout=1) as c:
                # Desktop currently persists source=vscode; also shared by the IDE extension.
                fields = {r[1] for r in c.execute('PRAGMA table_info(threads)')}
                title_field = "COALESCE(NULLIF(name,''),title)" if 'name' in fields else 'title'
                rows = c.execute(f"SELECT id,cwd,{title_field},rollout_path,source FROM threads "
                                 "WHERE archived=0 AND source IN ('vscode','cli','exec') "
                                 "ORDER BY updated_at DESC LIMIT ?", (self.limit,)).fetchall()
        except sqlite3.Error:
            self.errors.append('codex_database_unavailable')
            return
        for sid, cwd, title, path, source in rows:
            try:
                rollout = Path(path)
                rollout.stat()
                compressed_only = str(rollout).endswith('.jsonl.zst') and rollout.is_file()
            except FileNotFoundError:
                compressed_only = Path(str(rollout) + '.zst').is_file()
            except (OSError, TypeError):
                compressed_only = False
            if compressed_only:
                self.rows.pop('codex:' + sid, None)
                self.tails.pop(sid, None)
                continue
            row = self.row('codex', sid, cwd, title)
            preview = self.previews.setdefault('codex:' + sid, Preview())
            row['source'] = source
            row.pop('reason', None)
            try:
                tail = self.tails.setdefault(sid, Tail())
                records, baseline = tail.read(Path(path))
                if baseline:
                    row.update(status='unknown', turn_id=None, observed_at=0)
                    preview.clear()
                for item in records:
                    at = stamp(item.get('timestamp'))
                    row['observed_at'] = max(at, row['observed_at'])
                    payload = item.get('payload')
                    if isinstance(payload, dict):
                        if payload.get('type') in ('task_complete', 'agent_message') and payload.get('turn_id') and row['turn_id'] and payload['turn_id'] != row['turn_id']:
                            continue
                        if payload.get('type') != 'task_complete' or row['status'] != 'interrupted':
                            state = preview.codex(item)
                            if state:
                                self.transition(row, state, at, row['turn_id'], events, False)
                    if item.get('type') != 'event_msg' or not isinstance(payload, dict):
                        continue
                    kind = payload.get('type')
                    turn = payload.get('turn_id') or row['turn_id']
                    notify = self.ready and at >= self.started_at
                    # First encounter of an old file never replays historical completion.
                    if baseline and at < self.started_at:
                        notify = False
                    if kind == 'task_started':
                        self.transition(row, 'running', at, turn, events, False)
                    elif kind == 'task_complete':
                        # A late completion for an earlier turn must not end the current one.
                        if (row['turn_id'] and turn != row['turn_id']) or row['status'] == 'interrupted':
                            continue
                        self.transition(row, 'completed', at, turn, events, notify)
                    elif kind == 'turn_aborted':
                        if not row['turn_id'] or turn == row['turn_id']:
                            self.transition(row, 'interrupted', at, turn, events, False)
            except (OSError, TypeError):
                row['status'] = 'unknown'
                row['reason'] = 'rollout_unavailable'
                preview.clear()
            row.pop('preview', None)
            if preview.output():
                row['preview'] = preview.output()

    def claude(self, events):
        # Verification belongs to this scan, not to a past registry observation.
        for row in self.rows.values():
            if row['provider'] == 'claude':
                row.pop('process_verified', None)
        registry = {}
        for path in (self.claude_home / 'sessions').glob('*.json'):
            try:
                r = json.loads(path.read_text())
                sid = r['sessionId']
                if not isinstance(sid, str):
                    continue
                registry[sid] = r
                row = self.row('claude', sid, r.get('cwd', ''), r.get('name', ''))
                row['source'] = r.get('entrypoint') or 'unknown'
                row['process_verified'] = self.process_alive(r, 'claude')
                if not row['process_verified']:
                    row['status'] = 'disconnected'
                elif not row.get('hook_seen'):
                    # Registry is a fallback when this session has not emitted hooks.
                    # It establishes activity, never response completion or a turn ID.
                    updated = r.get('updatedAt')
                    at = (updated/1000 if isinstance(updated, (int, float))
                          and not isinstance(updated, bool) and math.isfinite(updated)
                          and updated > 0 else 0)
                    if at > self.now()+60:
                        at = 0
                    row['observed_at'] = at
                    row.pop('reason', None)
                    row['status'] = ('idle' if r.get('status') == 'idle' else
                                     'running' if r.get('status') == 'busy' and at else 'unknown')
            except (OSError, ValueError, KeyError, TypeError):
                self.errors.append('claude_registry_invalid')
        paths = self.hook_paths(self.spool)
        for path in paths:
            if path.name in self.seen_hooks:
                continue
            try:
                data = json.loads(path.read_text())
                sid, kind, at = data['session_id'], data['event'], data['at']
                if not isinstance(sid, str) or not isinstance(at, (int, float)):
                    raise ValueError()
            except (OSError, ValueError, KeyError, TypeError):
                self.errors.append('claude_hook_invalid')
                self.seen_hooks.add(path.name)
                continue
            self.seen_hooks.add(path.name)
            r = registry.get(sid, {})
            row = self.row('claude', sid, data.get('cwd', ''))
            row.update(hook_seen=True, source=r.get('entrypoint') or 'hook-unclassified')
            turn = row.get('turn_id')
            state = None
            if kind == 'UserPromptSubmit':
                self.previews.setdefault('claude:' + sid, Preview()).clear()
                self.preview_since[sid] = at
                self.preview_refresh.add(sid)
                turn = data.get('turn_id') or path.stem
                state = 'running'
            elif kind == 'SessionStart':
                state = 'idle'
            elif kind == 'Stop':
                state = 'background' if data.get('background_active') else 'completed'
                if state == 'completed':
                    self.preview_refresh.add(sid)
            elif kind == 'StopFailure':
                state = 'failed'
            elif kind == 'SessionEnd':
                state = 'disconnected'
            elif kind == 'PermissionRequest' or (kind == 'Notification' and
                    data.get('notification_type') in ('permission_prompt', 'idle_prompt', 'elicitation_dialog')):
                state = 'waiting_input'
            elif kind in ('PreToolUse', 'PostToolUse'):
                state = 'running'
            if state:
                self.transition(row, state, at, turn, events,
                                self.ready and at >= self.started_at)
        for row in list(self.rows.values()):
            if row['provider'] != 'claude':
                continue
            sid = row['session_id']
            if not sid or not all(c.isascii() and (c.isalnum() or c in '-_') for c in sid):
                continue
            preview = self.previews.setdefault('claude:' + sid, Preview())
            project = ''.join(c if c.isascii() and c.isalnum() else '-' for c in row['cwd'])
            key = 'claude:' + sid
            now = self.now()
            recent_complete = row['status'] == 'completed' and 0 <= now-row.get('completed_at', 0) < 1800
            if sid in self.preview_refresh or (recent_complete and not preview.output() and now >= self.preview_retry_at.get(sid, 0)):
                self.tails.pop(key, None)
                self.preview_refresh.discard(sid)
                self.preview_retry_at[sid] = now + 30
            try:
                items, baseline = self.tails.setdefault('claude:' + sid, Tail()).read(self.claude_home/'projects'/project/(sid+'.jsonl'))
                if baseline:
                    preview.clear()
                for item in items:
                    if stamp(item.get('timestamp')) >= self.preview_since.get(sid, 0):
                        preview.claude(item)
                row.pop('preview_error', None)
                if not preview.output():
                    row['preview_error'] = 'no_message'
            except OSError as error:
                preview.clear()
                self.tails.pop(key, None)
                row['preview_error'] = 'missing' if isinstance(error, FileNotFoundError) else 'read_failed'
            row.pop('preview', None)
            if preview.output():
                row['preview'] = preview.output()
        # A dead/reused PID overrides old hook state, never creates completion.
        for sid, r in registry.items():
            row = self.rows.get('claude:' + sid)
            if row and not row.get('process_verified'):
                row.update(status='disconnected', process_verified=False)

    def antigravity(self, events):
        spool = self.spool.parent/'antigravity-hooks'
        for path in self.hook_paths(spool, 'antigravity:'):
            identity = 'antigravity:'+path.name
            if identity in self.seen_hooks:
                continue
            try:
                item = json.loads(path.read_text())
                sid, kind, at = item['session_id'], item['event'], item['at']
                if (not isinstance(sid, str) or not sid or not isinstance(at, (int, float))
                        or isinstance(at, bool) or not math.isfinite(at) or at <= 0 or at > self.now()+60):
                    raise ValueError()
            except (OSError, ValueError, KeyError, TypeError):
                self.errors.append('antigravity_hook_invalid')
                self.seen_hooks.add(identity)
                continue
            self.seen_hooks.add(identity)
            row = self.row('antigravity', sid, item.get('cwd', ''))
            row['source'] = 'antigravity-hook'
            if 'pid' in item and 'procStart' in item:
                row['process_record'] = {k:item[k] for k in ('pid','procStart')}
            turn = row.get('turn_id')
            state = None
            if kind == 'SessionStart':
                state = 'idle'
            elif kind in ('PreInvocation', 'PreToolUse', 'PostToolUse'):
                if row['status'] not in ('running','background','waiting_input') or not turn:
                    turn = path.stem
                state = 'running'
            elif kind == 'Stop':
                reason = item.get('termination_reason', '').removeprefix('EXECUTOR_TERMINATION_REASON_')
                if item.get('has_error') or reason in ('ERROR','error'):
                    state = 'failed'
                elif reason in ('USER_CANCELED','user_canceled'):
                    state = 'interrupted'
                elif reason in ('NO_TOOL_CALL','model_stop'):
                    state = 'completed' if item.get('fully_idle') else 'background'
                else:
                    state = 'unknown'
            if state:
                self.transition(row, state, at, turn, events, self.ready and at >= self.started_at)
        for row in self.rows.values():
            if row['provider'] != 'antigravity' or not row.get('process_record'):
                continue
            alive = self.process_alive(row['process_record'], 'antigravity')
            row['process_verified'] = alive
            if not alive:
                row['status'] = 'disconnected'

    def poll(self):
        self.process_table = None
        self.errors = []
        events = []
        self.codex(events)
        self.claude(events)
        self.antigravity(events)
        excluded, lifecycle_errors = self.lifecycle.scan([r['session_id'] for r in self.rows.values() if r['provider'] == 'antigravity'])
        self.errors.extend(lifecycle_errors)
        for row in self.rows.values():
            if row['provider'] == 'antigravity':
                row['title'] = self.lifecycle.titles.get(row['session_id']) or Path(row['cwd']).name or row['session_id'][:8]
        for event in events:
            if event['provider'] == 'antigravity':
                event['title'] = self.rows['antigravity:'+event['session_id']]['title']

        rows = copy.deepcopy([r for r in self.rows.values() if r['provider'] != 'antigravity' or r['session_id'] not in excluded])
        events = [e for e in events if e['provider'] != 'antigravity' or e['session_id'] not in excluded]
        for row in rows:
            if row['status'] in ('running', 'waiting_input', 'background') and (
                    self.now() - row['observed_at'] > self.stale_seconds):
                row.update(status='unknown', reason='no_recent_evidence')
        self.ready = True
        rows.sort(key=lambda r: r['observed_at'], reverse=True)
        return dict(schema=1, at=self.now(), sessions=rows, errors=sorted(set(self.errors))), events
