"""Persist observed weekly consumption in KST 06:00 days, never infer missing use."""
import copy
import json
import math
import os
import tempfile
from datetime import datetime, timedelta, timezone

RESET_TOLERANCE = 5
# Remaining only rises when the quota is restored; small rises are API rounding noise.
EARLY_RESET_RISE = 1.0

KST = timezone(timedelta(hours=9))


def day_bounds(at):
    day = (datetime.fromtimestamp(at, KST)-timedelta(hours=6)).date()
    start = datetime(day.year, day.month, day.day, 6, tzinfo=KST).timestamp()
    return start, start+86400


def finite(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def same_reset(a, b):
    return finite(a) and finite(b) and abs(a-b) <= RESET_TOLERANCE


class DailyUsage:
    def __init__(self, path=None):
        self.path = path
        self.records = {}
        self.storage_error = False
        if path and path.exists():
            try:
                saved = json.loads(path.read_text())
                if not isinstance(saved, dict) or saved.get('version') != 1 or not isinstance(saved.get('records'), dict):
                    raise ValueError('invalid daily history')
                for record in saved['records'].values():
                    if not isinstance(record, dict) or not all(finite(record.get(k)) for k in ('day_start', 'day_end', 'started_at', 'last_at')):
                        raise ValueError('invalid record')
                    if not isinstance(record.get('segments'), list) or not record['segments']:
                        raise ValueError('invalid segments')
                    if not all(isinstance(record.get(k), bool) for k in ('partial', 'missing')):
                        raise ValueError('invalid coverage')
                    for segment in record['segments']:
                        if not isinstance(segment, dict) or not all(finite(segment.get(k)) for k in ('started_at', 'baseline', 'lowest', 'used')):
                            raise ValueError('invalid segment')
                        if not all(k in segment and (segment[k] is None or finite(segment[k])) for k in ('reset_at', 'budget', 'allocation_seconds', 'reset_seconds')):
                            raise ValueError('invalid budget')
                    if not isinstance(record.get('pre_reset', []), list):
                        raise ValueError('invalid pre-reset history')
                self.records = saved['records']
            except (ValueError, KeyError, OSError):
                self.storage_error = True

    def save(self):
        if not self.path:
            return
        name = None
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd, name = tempfile.mkstemp(prefix='.daily-', dir=self.path.parent)
            with os.fdopen(fd, 'w') as f:
                json.dump({'version': 1, 'records': self.records}, f)
                f.flush()
                os.fsync(f.fileno())
            os.replace(name, self.path)
            self.storage_error = False
        except OSError:
            self.storage_error = True
        finally:
            if name and os.path.exists(name):
                os.unlink(name)

    @staticmethod
    def key(provider, account, window):
        return json.dumps([provider, account, window], separators=(',', ':'))

    def observe(self, provider, account, windows, at, now):
        if not account or not finite(at) or at > now+60 or now-at > 600:
            return
        changed = False
        for w in windows:
            if w['label'] != '주간':
                continue
            remaining, reset = w['remaining_percent'], w.get('resets_at')
            if not finite(remaining) or not 0 <= remaining <= 100:
                continue
            reset = reset if finite(reset) and reset > at else None
            start, end = day_bounds(at)
            key = self.key(provider, account, w['id'])
            record = self.records.get(key)
            if record and at <= record['last_at']:
                continue
            if not record or record['day_start'] != start:
                record = dict(day_start=start, day_end=end, started_at=at, last_at=at,
                              segments=[], partial=at > start, missing=False)
                self.records[key] = record
            segments = record['segments']
            previous = segments[-1] if segments else None
            old_reset = previous['reset_at'] if previous else None
            # Sub-second API estimates do not identify a new quota cycle.
            rolled = (previous is not None and reset is not None and old_reset is not None
                      and at >= old_reset-RESET_TOLERANCE
                      and reset > old_reset+RESET_TOLERANCE)
            # Quota restored before the scheduled reset: restart today's figures on the new cycle.
            early = (previous is not None and not rolled and reset is not None and old_reset is not None
                     and at < old_reset-RESET_TOLERANCE
                     and reset > old_reset+RESET_TOLERANCE
                     and remaining >= previous['lowest']+EARLY_RESET_RISE)
            # A refill can retain its schedule. Ignore ordinary upward corrections
            # below the observed baseline, unless the quota is fully restored.
            restored = (previous is not None and reset is not None
                        and remaining >= previous['lowest']+EARLY_RESET_RISE
                        and (remaining == 100 or remaining >= previous['baseline']+EARLY_RESET_RISE))
            if early or rolled or restored:
                record['pre_reset'] = record.get('pre_reset', [])+segments
                record['segments'] = segments = []
                record.update(partial=True, missing=False, quota_reset_at=at)
                record['reset_at' if rolled else 'early_reset_at'] = at
                record.pop('reset_adjusted', None)
                previous = None
            new_segment = previous is None or rolled
            record['reset_pending'] = reset is None
            if new_segment:
                if previous:
                    record['missing'] = True
                allocation = min(end, reset)-at if reset else None
                budget = remaining*allocation/(reset-at) if reset else None
                segments.append(dict(started_at=at, reset_at=reset, baseline=remaining,
                                     lowest=remaining, used=0.0, budget=budget,
                                     allocation_seconds=allocation, reset_seconds=reset-at if reset else None))
            else:
                previous['lowest'] = min(previous['lowest'], remaining)
                previous['used'] = previous['baseline']-previous['lowest']
                if reset is not None and old_reset is None:
                    # The first known schedule belongs to the existing observed interval.
                    started = previous['started_at']
                    previous.update(reset_at=reset, allocation_seconds=min(end, reset)-started,
                                    reset_seconds=reset-started)
                    previous['budget'] = previous['baseline']*previous['allocation_seconds']/previous['reset_seconds']
                elif reset is not None and not same_reset(old_reset, reset):
                    # Schedule correction before expiry: retain the frozen allocation.
                    previous['reset_at'] = reset
                    record['missing'] = True
                    record['reset_adjusted'] = True
            record['last_at'] = at
            changed = True
        if changed:
            # Retain current/recent daily records only; never credentials or raw payloads.
            self.records = {k:r for k,r in self.records.items() if now-r['last_at'] < 32*86400}
            self.save()

    def repair_jitter(self):
        """Merge only adjacent matching cycle anchors, retaining the original budget."""
        merged_count = 0
        for record in self.records.values():
            original = record['segments']
            merged = []
            for segment in original:
                if merged and same_reset(merged[-1]['reset_at'], segment['reset_at']):
                    first = merged[-1]
                    first['lowest'] = min(first['lowest'], segment['baseline'], segment['lowest'])
                    first['used'] = max(0.0, first['baseline']-first['lowest'])
                    merged_count += 1
                else:
                    merged.append(copy.deepcopy(segment))
            if len(merged) != len(original):
                record['segments'] = merged
                if len(merged) == 1 and merged[0]['reset_at'] is not None and not record.get('reset_adjusted'):
                    record['missing'] = False
        return merged_count

    def read(self, provider, account, w, now):
        if not account:
            return dict(status='account_unknown')
        record = self.records.get(self.key(provider, account, w['id']))
        if not record or record['day_start'] != day_bounds(now)[0]:
            return dict(status='waiting')
        result = copy.deepcopy(record)
        segments = result['segments']
        latest = segments[-1]
        result['gauge_baseline'] = (latest['baseline'] if not record.get('reset_pending')
                                   and latest['reset_at'] is not None and latest['reset_at'] > now
                                   else None)
        result['used'] = sum(s['used'] for s in segments)
        valid = (not record.get('reset_pending') and all(s['budget'] is not None for s in segments)
                 and segments[-1]['reset_at'] is not None and segments[-1]['reset_at'] > now)
        result['recommended'] = sum(s['budget'] for s in segments) if valid else None
        result['available'] = result['recommended']-result['used'] if valid else None
        result['status'] = 'delayed' if w.get('stale') or now-record['last_at'] > 600 else 'ok'
        result['storage_error'] = self.storage_error
        return result
