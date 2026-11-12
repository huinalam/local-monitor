"""Merge optional source-bound summaries; never block collection on worker failure."""
import json
import math


def apply_summaries(snapshot, path, now):
    try:
        with path.open('rb') as f:
            data = f.read(4 * 1024 * 1024 + 1)
        if len(data) > 4 * 1024 * 1024:
            return
        cache = json.loads(data)
        if cache.get('schema') != 1 or cache.get('version') != 3 or cache.get('model') != 'gpt-6-luna':
            return
        entries = cache.get('entries')
        if not isinstance(entries, list):
            return
        for row in snapshot.get('sessions', []):
            if row.get('status') not in ('completed', 'waiting_input') or not isinstance(row.get('preview'), dict):
                continue
            for e in reversed(entries[-128:]):
                if not isinstance(e, dict) or e.get('provider') != row.get('provider') or e.get('session_id') != row.get('session_id') or e.get('source') != dict(status=row['status'], preview=row['preview']):
                    continue
                created, lines = e.get('created_at'), e.get('lines')
                if not isinstance(created, (int, float)) or not math.isfinite(created) or created > now + 60 or now - created >= 86400:
                    continue
                if e.get('failed') is True:
                    row['preview_summary'] = dict(status='failed', model='gpt-6-luna')
                    break
                if not isinstance(lines, list) or len(lines) != 2 or not all(isinstance(s, str) and 0 < len(s) <= 40 and s.strip() == s and not any(ord(c) < 32 or 127 <= ord(c) <= 159 for c in s) for s in lines):
                    continue
                row['preview_summary'] = dict(lines=lines, model='gpt-6-luna')
                break
    except (OSError, ValueError, TypeError, AttributeError):
        return
