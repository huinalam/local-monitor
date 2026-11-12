"""Bounded, observation-only response completions. Owned by the server store lock."""
import math


class CompletionWindow:
    def __init__(self):
        self.entries = {}
        self.coverage_since = None
        self.last = None
        self.warnings = {}

    def update(self, now, mono, events=(), *, healthy=True, source_error=False):
        if self.last is not None:
            wall, tick = self.last
            if abs((now-wall)-(mono-tick)) > 5:
                self.entries.clear()
                self.warnings.clear()
                self.coverage_since = None
                self.warnings['clock_jump'] = now+1800
            if mono-tick > 15:
                self.coverage_since = None
                self.warnings['collector_gap'] = now+1800
        self.last = (now, mono)
        if not healthy or source_error:
            self.coverage_since = None
            self.warnings['source_error' if source_error else 'collector_gap'] = now+1800
        elif self.coverage_since is None:
            self.coverage_since = now
        self.entries = {k: e for k, e in self.entries.items() if now-1800 < e['at'] <= now}
        for event in events:
            at = event.get('at')
            valid = (isinstance(at, (int, float)) and not isinstance(at, bool) and math.isfinite(at)
                     and at <= now and event.get('provider') in ('codex', 'claude', 'antigravity')
                     and all(isinstance(event.get(k), str) and event[k] for k in ('session_id', 'turn_id', 'id')))
            if not valid:
                self.warnings['invalid_event'] = now+1800
                continue
            if at <= now-1800:
                continue
            key = (event['provider'], event['session_id'], event['turn_id'])
            previous = self.entries.get(key)
            if previous:
                if previous['at'] != at:
                    self.warnings['invalid_event'] = now+1800
                continue
            self.entries[key] = {k: event[k] for k in ('id', 'provider', 'session_id', 'turn_id', 'at')}
            self.entries[key].update({k: event.get(k, '') if isinstance(event.get(k, ''), str) else '' for k in ('title', 'cwd')})
        ordered = sorted(self.entries.values(), key=lambda e: (e['at'], int(e['id'].rsplit(':', 1)[-1]) if e['id'].rsplit(':', 1)[-1].isdigit() else 0, e['id']))
        if len(ordered) > 10000:
            removed = ordered[:-10000]
            self.warnings['capacity'] = max(self.warnings.get('capacity', 0), removed[-1]['at']+1800)
            ordered = ordered[-10000:]
            self.entries = {(e['provider'], e['session_id'], e['turn_id']): e for e in ordered}
        self.warnings = {k: t for k, t in self.warnings.items() if t > now}
        reasons = sorted(self.warnings)
        if self.coverage_since is None or now-self.coverage_since < 1800:
            reasons.append('warming_up')
        return dict(schema=1, seconds=1800, as_of=now, coverage_since=self.coverage_since,
                    partial=bool(reasons), reasons=sorted(reasons), entries=ordered)
