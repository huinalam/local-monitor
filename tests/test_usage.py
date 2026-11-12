import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from local_monitor.usage import UsageCache, normalize, collect, retry_after, claude_usage
from local_monitor.usage_setup import setup


class UsageTests(unittest.TestCase):
    def test_claude_expiration_prevents_request_and_retains_stale_values(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            cache = UsageCache()
            cache.update('claude', normalize('claude', {'seven_day': {'utilization': 4}}))
            for expiry in (0, 999999, 1000000):
                with self.subTest(expiry=expiry):
                    (home/'.credentials.json').write_text(json.dumps({'claudeAiOauth': {'accessToken': 'test-only', 'expiresAt': expiry}}))
                    with patch('local_monitor.usage.sys.platform', 'linux'), patch('local_monitor.usage.time.time', return_value=1000), patch('local_monitor.usage.build_opener') as opener:
                        self.assertEqual(collect(cache, 'claude', home), 15)
                        opener.assert_not_called()
                    row = cache.read()[1]
                    self.assertEqual(row['error'], 'auth_expired')
                    self.assertEqual(row['status'], 'stale')
                    self.assertTrue(row['windows'][0]['stale'])
                    self.assertEqual(row['windows'][0]['remaining_percent'], 96)
                    self.assertNotIn('test-only', json.dumps(row))

    def test_expired_local_poll_then_refreshed_token_and_http_backoff(self):
        from urllib.error import HTTPError
        with tempfile.TemporaryDirectory() as d:
            home=Path(d);credential=home/'.credentials.json';cache=UsageCache()
            def write(expiry):
                credential.write_text(json.dumps({'claudeAiOauth': {'accessToken':'test-only', 'expiresAt':expiry}}))
            with patch('local_monitor.usage.sys.platform','linux'), patch('local_monitor.usage.time.time',return_value=1000), patch('local_monitor.usage.build_opener') as opener:
                write(999000)
                for _ in range(3):self.assertEqual(collect(cache,'claude',home),15)
                opener.assert_not_called()
                self.assertEqual(cache.read(1000)[1]['next_retry_at'],1015)
                write(2000000)
                opener.return_value.open.return_value.__enter__.return_value.read.return_value=b'{"seven_day":{"utilization":4}}'
                self.assertEqual(collect(cache,'claude',home),300)
                self.assertIsNone(cache.read(1000)[1]['error'])
                self.assertEqual(opener.return_value.open.call_count,1)
                opener.return_value.open.side_effect=HTTPError('https://example.test',429,'limited',{'Retry-After':'719'},None)
                self.assertEqual(collect(cache,'claude',home),719)
                opener.return_value.open.side_effect=HTTPError('https://example.test',401,'auth',{},None)
                self.assertEqual(collect(cache,'claude',home),300)
                self.assertEqual(cache.read(1000)[1]['error'],'auth_required')

    def test_claude_header_and_valid_or_unknown_expiration(self):
        with tempfile.TemporaryDirectory() as d:
            home = Path(d)
            for expiry in (1000001, None, 'invalid', True):
                with self.subTest(expiry=expiry):
                    oauth = {'accessToken': 'test-only'}
                    if expiry is not None:
                        oauth['expiresAt'] = expiry
                    (home/'.credentials.json').write_text(json.dumps({'claudeAiOauth': oauth}))
                    with patch('local_monitor.usage.sys.platform', 'linux'), patch('local_monitor.usage.time.time', return_value=1000), patch('local_monitor.usage.build_opener') as opener:
                        opener.return_value.open.return_value.__enter__.return_value.read.return_value = b'{"seven_day":{"utilization":4}}'
                        self.assertEqual(claude_usage(home)[0]['remaining_percent'], 96)
                        request = opener.return_value.open.call_args.args[0]
                        self.assertEqual(request.get_header('User-agent'), 'claude-code/2.1.287')
                        self.assertEqual(request.get_header('Anthropic-beta'), 'oauth-2025-04-20')

    def test_codex_keeps_all_buckets_and_identifies_window_by_duration(self):
        raw={'rateLimitsByLimitId':{'core':{'primary':{'usedPercent':18,'windowDurationMins':10080,'resetsAt':2000000000},'secondary':{'usedPercent':10,'windowDurationMins':300}},'extra':{'secondary':{'usedPercent':100,'windowDurationMins':10080}}},'rateLimits':{'primary':{'usedPercent':0}}}
        rows=normalize('codex',raw)
        self.assertEqual(len(rows),3)
        self.assertEqual([r['remaining_percent'] for r in rows],[82,90,0])
        self.assertEqual([r['label'] for r in rows],['주간','5시간','주간'])
        self.assertEqual(len({r['id'] for r in rows}),3)

    def test_missing_invalid_zero_and_model_windows(self):
        rows=normalize('claude',{'seven_day':{'utilization':0},'seven_day_sonnet':{'utilization':3},'five_hour':None,'extra_usage':{'utilization':50}})
        self.assertEqual([r['remaining_percent'] for r in rows],[100,97])
        for bad in (None,True,'20',-1,101,float('nan'),float('inf')):
            self.assertEqual(normalize('claude',{'seven_day':{'utilization':bad}}),[])

    def test_ag_fraction_and_reset(self):
        rows=normalize('antigravity',{'quota':{'gemini-weekly':{'remaining_fraction':.9378,'reset_time':'2026-10-10T00:00:00Z'},'claude-5h':{'remaining_fraction':0},'bad':{'remaining_fraction':1.1}}})
        self.assertEqual(len(rows),2)
        self.assertEqual(rows[0]['remaining_percent'],93.78)
        self.assertIsInstance(rows[0]['resets_at'],float)
        self.assertEqual(rows[1]['remaining_percent'],0)

    def test_ag_family_groups_keep_model_buckets_together(self):
        quota={k:{'remaining_fraction':.5} for k in ('gemini-weekly','gemini-5h','gemini-argon-wtu-weekly','3p-5h')}
        quota['other-weekly']={'remaining_fraction':.5,'group_name':'Other\nCLI','name':'Model\x00 X'}
        quota['gemini-weekly'].update(group_name='Ignored',name='Ignored')
        rows={r['id']:r for r in normalize('antigravity',{'quota':quota})}
        self.assertEqual({k:(r['group'],r.get('name')) for k,r in rows.items()},{
            'gemini-weekly':('Gemini',None),'gemini-5h':('Gemini',None),
            'gemini-argon-wtu-weekly':('Gemini','Argon'),'3p-5h':('Claude · GPT',None),
            'other-weekly':('Other CLI','Model X')})
        self.assertEqual(rows['gemini-argon-wtu-weekly']['label'],'주간')

    def test_ag_statusline_subset_merges_and_ages_kept_windows(self):
        cache=UsageCache();now=time.time()
        cli={k:{'remaining_fraction':.9,'reset_time':now+9000} for k in ('gemini-weekly','gemini-argon-wtu-weekly')}
        cli['x-weekly']={'remaining_fraction':.9,'reset_time':now+9000,'group_name':'CLI 이름'}
        cache.update('antigravity',normalize('antigravity',{'quota':cli}),observed_at=now-700)
        line={k:{'remaining_fraction':.4,'reset_time':now+9000} for k in ('gemini-weekly','x-weekly')}
        cache.update('antigravity',normalize('antigravity',{'quota':line}),observed_at=now,merge=True)
        row=cache.read(now)[2]
        self.assertEqual([w['id'] for w in row['windows']],['gemini-weekly','gemini-argon-wtu-weekly','x-weekly'])
        self.assertEqual([w['remaining_percent'] for w in row['windows']],[40,90,40])
        self.assertEqual([w['stale'] for w in row['windows']],[False,True,False])
        self.assertEqual(row['windows'][2]['group'],'CLI 이름')
        cache.update('antigravity',normalize('antigravity',{'quota':cli}),observed_at=now+1)
        row=cache.read(now+1)[2]
        self.assertFalse(any(w['stale'] or 'observed_at' in w for w in row['windows']))

    def test_failure_retains_but_marks_previous_and_recovery_replaces(self):
        cache=UsageCache();now=time.time()
        cache.update('codex',normalize('codex',{'rateLimits':{'primary':{'usedPercent':20,'resetsAt':now+1000}}}))
        cache.update('codex',error='timeout')
        row=cache.read()[0];self.assertEqual(row['status'],'stale');self.assertTrue(row['windows'][0]['stale'])
        self.assertEqual(row['windows'][0]['remaining_percent'],80)
        cache.update('codex',[]);self.assertEqual(cache.read()[0]['windows'],[])

    def test_reset_or_age_marks_stale_without_inventing_reset(self):
        cache=UsageCache();now=time.time()
        cache.update('claude',normalize('claude',{'seven_day':{'utilization':30,'resets_at':now+50}}),observed_at=now)
        self.assertEqual(cache.read(now+51)[1]['status'],'stale')
        self.assertEqual(cache.read(now+51)[1]['windows'][0]['remaining_percent'],70)
        cache.update('claude',normalize('claude',{'seven_day':{'utilization':30}}),observed_at=now)
        self.assertEqual(cache.read(now+601)[1]['status'],'stale')

    def test_exception_does_not_leak_secrets(self):
        cache=UsageCache()
        with patch('local_monitor.usage.codex_usage',side_effect=ValueError('secret-token')):
            collect(cache,'codex',Path('/unused'))
        self.assertNotIn('secret-token',json.dumps(cache.read()))
        self.assertEqual(cache.read()[0]['error'],'read_failed')

    def test_worker_waits_and_backs_off_then_recovers(self):
        from local_monitor.usage import start_workers
        from urllib.error import HTTPError
        class Stop:
            waits = []
            def is_set(self): return len(self.waits) == 3
            def wait(self, delay): self.waits.append(delay)
        class Thread:
            def __init__(self, target, args=(), **kwargs): self.target,self.args=target,args
            def start(self): pass
        stop=Stop()
        errors=[HTTPError('https://example.test',429,'limited',{'Retry-After':'719'},None),
                HTTPError('https://example.test',429,'limited',{},None), []]
        with patch('local_monitor.usage.threading.Thread',Thread), patch('local_monitor.usage.claude_usage',side_effect=errors):
            workers=start_workers(UsageCache(),stop,Path('/unused'),Path('/unused'),Path('/unused'))
            workers[1].target(*workers[1].args)
        self.assertEqual(stop.waits,[719,1200,300])

    def test_retry_after_formats(self):
        self.assertEqual(retry_after('719', 0), 719)
        self.assertEqual(retry_after('Thu, 01 Jan 1970 00:20:00 GMT', 100), 1100)
        for value in (None, 'invalid', '-1'):
            self.assertEqual(retry_after(value, 0), 0)
        self.assertEqual(retry_after('Thu, 01 Jan 1970 00:00:00 GMT', 100), 0)

    def test_rate_limit_wait_and_recovery(self):
        from urllib.error import HTTPError
        cache = UsageCache()
        for header, fallback, expected in [('719',600,719), (None,1200,1200), ('invalid',3600,3600), ('7200',3600,7200)]:
            error = HTTPError('https://example.test',429,'limited',{'Retry-After':header},None)
            with patch('local_monitor.usage.claude_usage',side_effect=error), patch('local_monitor.usage.time.time',return_value=100):
                self.assertEqual(collect(cache,'claude',Path('/unused'),fallback),expected)
            self.assertEqual(cache.read()[1]['next_retry_at'],100+expected)
            self.assertEqual(cache.read()[1]['error'],'rate_limited')
        with patch('local_monitor.usage.claude_usage',return_value=[]):
            self.assertEqual(collect(cache,'claude',Path('/unused'),3600),300)
        self.assertIsNone(cache.read()[1]['error'])

    def test_bridge_whitelists_and_ignores_empty_payload(self):
        from local_monitor.usage_bridge import capture
        with tempfile.TemporaryDirectory() as d:
            root=Path(d)
            capture({'email':'secret@example.test','prompt':'private','quota':{'gemini-weekly':{'remaining_fraction':.8,'reset_time':2000000000,'secret':'token'}}},root)
            saved=(root/'usage-antigravity.json').read_text()
            self.assertNotIn('secret',saved);self.assertNotIn('private',saved)
            self.assertEqual(json.loads(saved)['quota']['gemini-weekly']['remaining_fraction'],.8)
            self.assertEqual((root/'usage-antigravity.json').stat().st_mode & 0o777,0o600)
            capture({'quota':{}},root)
            self.assertEqual((root/'usage-antigravity.json').read_text(),saved)

    def test_install_remove_preserves_other_settings_and_existing_command(self):
        with tempfile.TemporaryDirectory() as d:
            root=Path(d);settings=root/'settings.json';runtime=root/'runtime'
            original={'model':'example','statusLine':{'command':'','enabled':True}}
            settings.write_text(json.dumps(original))
            self.assertTrue(setup(runtime,settings));self.assertFalse(setup(runtime,settings))
            data=json.loads(settings.read_text());data['model']='changed';settings.write_text(json.dumps(data))
            self.assertTrue(setup(runtime,settings,True))
            self.assertEqual(json.loads(settings.read_text()),dict(original,model='changed'))
            settings.write_text(json.dumps({'statusLine':{'command':'my-script'}}))
            with self.assertRaises(ValueError):setup(runtime,settings)
            self.assertEqual(json.loads(settings.read_text())['statusLine']['command'],'my-script')

if __name__=='__main__':unittest.main()
