import copy
import fcntl
import json
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from local_monitor.agy_usage import AgyUsage, parse_usage, query_usage, run_worker
from local_monitor.usage import UsageCache, UsageError, start_workers


def response(fraction=.75):
    return {'status': 'SUCCESS', 'command': {'name': 'usage', 'data': {'groups': [
        {'buckets': [{'id': 'gemini-weekly', 'remaining_fraction': fraction,
                      'reset_time': '2030-10-18T22:55:15Z'}]}]}}}


class Stop:
    def __init__(self, count):
        self.count, self.waits = count, []
    def is_set(self):
        return len(self.waits) >= self.count
    def wait(self, delay):
        self.waits.append(delay)


class AgyTests(unittest.TestCase):
    def test_real_shape_zero_fraction_and_whitelist(self):
        raw = response(0)
        raw['response'] = 'private session data'
        row = parse_usage(json.dumps(raw))[0]
        self.assertEqual(row['remaining_percent'], 0)
        self.assertEqual(row['label'], '주간')
        self.assertNotIn('private', json.dumps(row))

    def test_display_names_are_kept_for_unknown_families(self):
        raw = response()
        groups = raw['command']['data']['groups']
        groups[0]['display_name'] = 'Gemini models'
        groups.append({'displayName': 'New family', 'buckets': [
            {'id': 'nf-weekly', 'remaining_fraction': .5, 'reset_time': '2030-10-18T22:55:15Z', 'display_name': 'Model\tZ'},
            {'id': 'gemini-argon-wtu-weekly', 'remaining_fraction': 0, 'reset_time': '2030-10-18T22:55:15Z'}]})
        rows = {r['id']: r for r in parse_usage(json.dumps(raw))}
        self.assertEqual((rows['gemini-weekly']['group'], rows['gemini-weekly'].get('name')), ('Gemini', None))
        self.assertEqual((rows['nf-weekly']['group'], rows['nf-weekly']['name']), ('New family', 'Model Z'))
        self.assertEqual((rows['gemini-argon-wtu-weekly']['group'], rows['gemini-argon-wtu-weekly']['name']), ('Gemini', 'Argon'))

    def test_invalid_envelopes_and_buckets_never_produce_partial_success(self):
        base = response()
        bucket = base['command']['data']['groups'][0]['buckets'][0]
        invalid = [None, [], {}, {'status': 'ERROR'}, {'status': 'SUCCESS', 'command': []}]
        for key, value in [('id', '../bad'), ('id', None), ('remaining_fraction', True),
                           ('remaining_fraction', float('nan')), ('remaining_fraction', -1),
                           ('remaining_fraction', 1.1), ('reset_time', None),
                           ('reset_time', 0), ('reset_time', float('inf'))]:
            raw = copy.deepcopy(base)
            raw['command']['data']['groups'][0]['buckets'] = [dict(bucket, **{key: value})]
            invalid.append(raw)
        raw = copy.deepcopy(base)
        raw['command']['data']['groups'][0]['buckets'].append(bucket)
        invalid += [raw, {'status':'SUCCESS', 'command':{'name':'usage','data':{'groups':[]}}}]
        for raw in invalid:
            with self.subTest(raw=raw), self.assertRaisesRegex(UsageError, '^read_failed$'):
                parse_usage(json.dumps(raw))

    def run_fake(self, script, stop=None, timeout=2, own_process_group=True):
        real_popen = subprocess.Popen
        children = []
        def launch(args, **kwargs):
            self.assertEqual(args, ['agy','-p','/usage','--output-format','json','--print-timeout','30s'])
            self.assertEqual(Path(kwargs['cwd']).stat().st_mode & 0o777, 0o700)
            self.assertEqual(kwargs['env']['LOCAL_MONITOR_AGY_USAGE'], '1')
            proc = real_popen([sys.executable, '-c', script], **kwargs)
            children.append(proc)
            return proc
        try:
            with patch('local_monitor.agy_usage.subprocess.Popen', side_effect=launch):
                return query_usage(stop or threading.Event(), timeout=timeout, own_process_group=own_process_group)
        finally:
            self.assertIsNotNone(children[0].poll())
            self.assertTrue(children[0].stdout.closed)

    def test_process_success_timeout_nonzero_output_bound_and_stop(self):
        script = 'print('+repr(json.dumps(response()))+')'
        self.assertEqual(self.run_fake(script)[0]['remaining_percent'], 75)
        for code, expected, timeout, stop in [
            ('import time;time.sleep(10)', 'timeout', .15, None),
            ('import os,time;os.close(1);time.sleep(10)', 'timeout', .15, None),
            ('raise SystemExit(3)', 'read_failed', 2, None),
            ('print("x"*1100000)', 'read_failed', 2, None),
            ('import time;time.sleep(10)', 'stopped', 2, self.set_stop())]:
            with self.subTest(expected=expected), self.assertRaisesRegex(UsageError, '^'+expected+'$'):
                self.run_fake(code, stop, timeout)

    def set_stop(self):
        stop = threading.Event(); stop.set(); return stop

    def test_inherited_adapter_group_does_not_kill_test_parent(self):
        script = 'print('+repr(json.dumps(response()))+')'
        self.assertEqual(self.run_fake(script,own_process_group=False)[0]['remaining_percent'],75)

    def test_lock_contention_skips_query(self):
        with tempfile.TemporaryDirectory() as d:
            collector = AgyUsage(Path(d))
            with patch('local_monitor.agy_usage.query_usage') as query:
                collector.lock.acquire()
                self.assertIsNone(collector.collect(threading.Event()))
                collector.lock.release()
                with (Path(d)/'agy-usage.lock').open('a') as other:
                    fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self.assertIsNone(collector.collect(threading.Event()))
                query.assert_not_called()
                query.return_value = ['window']
                self.assertEqual(collector.collect(threading.Event()), ['window'])

    def test_worker_backoff_recovery_preserves_data_and_sanitizes(self):
        cache = UsageCache()
        windows = parse_usage(json.dumps(response()))
        cache.update('antigravity', windows, observed_at=100)
        stop = Stop(6)
        failures = [UsageError('timeout'), OSError('secret'), UsageError('read_failed'),
                    UsageError('read_failed'), UsageError('read_failed'), windows]
        with patch('local_monitor.agy_usage.AgyUsage.collect', side_effect=failures), \
                patch('local_monitor.agy_usage.time.time', return_value=200):
            run_worker(cache, stop, Path('/unused'))
        self.assertEqual(stop.waits, [600, 1200, 2400, 3600, 3600, 300])
        row = cache.read(200)[2]
        self.assertEqual(row['windows'][0]['remaining_percent'], 75)
        self.assertIsNone(row['error'])
        self.assertEqual(row['next_retry_at'], 500)
        self.assertNotIn('secret', json.dumps(row))
        stop = Stop(1)
        with patch('local_monitor.agy_usage.AgyUsage.collect', side_effect=OSError('secret')):
            run_worker(cache, stop, Path('/unused'))
        row = cache.read(200)[2]
        self.assertEqual(row['status'], 'stale')
        self.assertEqual(row['observed_at'], 200)
        self.assertEqual(row['windows'][0]['remaining_percent'], 75)

    def test_unchanged_bridge_does_not_undo_auto_success_or_failure(self):
        cache = UsageCache()
        windows = parse_usage(json.dumps(response()))
        cache.update('antigravity', windows, observed_at=200)
        cache.update('antigravity', error='timeout')
        for at in (100, 200):
            cache.update('antigravity', [], observed_at=at)
            self.assertEqual(cache.read(200)[2]['error'], 'timeout')
            self.assertEqual(cache.read(200)[2]['observed_at'], 200)
        cache.update('antigravity', windows, observed_at=201)
        self.assertIsNone(cache.read(201)[2]['error'])

    def test_missing_and_broken_passive_bridge_preserve_auto_data(self):
        class Thread:
            def __init__(self, target, args=(), **kwargs): self.target,self.args=target,args
            def start(self): pass
        with tempfile.TemporaryDirectory() as d:
            cache = UsageCache()
            cache.update('antigravity', parse_usage(json.dumps(response())), observed_at=200)
            cache.update('antigravity', error='timeout')
            with patch('local_monitor.usage.threading.Thread', Thread):
                for content in (None, 'broken', '{"observed_at":300,"quota":{}}'):
                    if content is not None: (Path(d)/'usage-antigravity.json').write_text(content)
                    workers = start_workers(cache, Stop(1), Path(d), Path(d), Path(d))
                    workers[2].target(*workers[2].args)
                    self.assertEqual(cache.read(200)[2]['error'], 'timeout')
                    self.assertEqual(cache.read(200)[2]['observed_at'], 200)

    def test_busy_query_keeps_data_and_stop_does_not_publish_failure(self):
        cache = UsageCache()
        cache.update('antigravity', parse_usage(json.dumps(response())), observed_at=200)
        stop = Stop(1)
        with patch('local_monitor.agy_usage.AgyUsage.collect', return_value=None):
            run_worker(cache, stop, Path('/unused'))
        self.assertEqual(stop.waits, [300])
        self.assertEqual(cache.read(200)[2]['observed_at'], 200)
        with patch('local_monitor.agy_usage.AgyUsage.collect', side_effect=UsageError('stopped')):
            run_worker(cache, Stop(1), Path('/unused'))
        self.assertIsNone(cache.read(200)[2]['error'])


if __name__ == '__main__':
    unittest.main()
