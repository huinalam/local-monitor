import json
import tempfile
import unittest
from pathlib import Path
from local_monitor.daily_usage import DailyUsage, day_bounds


class DailyTests(unittest.TestCase):
    start = 1791320400  # Compute actual boundary below; tests do not depend on host timezone.
    def setUp(self):
        self.start = day_bounds(self.start)[0]
        self.ledger = DailyUsage()
        self.w = dict(id='week', label='주간', remaining_percent=40, resets_at=self.start+90*3600)

    def observe(self, at, remaining, account='a'):
        self.w['remaining_percent'] = remaining
        self.ledger.observe('codex', account, [self.w], at, at)
        return self.ledger.read('codex', account, self.w, at)

    def test_budget_fixed_duplicate_and_correction(self):
        r=self.observe(self.start,40)
        self.assertAlmostEqual(r['recommended'],40*24/90)
        self.observe(self.start+300,36.8)
        self.observe(self.start+300,35)
        self.observe(self.start+600,38)
        r=self.observe(self.start+900,36.8)
        self.assertAlmostEqual(r['used'],3.2)
        self.assertAlmostEqual(r['recommended'],40*24/90)
        self.assertFalse(r['partial'])

    def test_gauge_baseline_uses_observed_start_then_new_cycle(self):
        self.w['resets_at'] = self.start+3600
        r = self.observe(self.start+30, 80)
        self.assertTrue(r['partial'])
        self.assertEqual(r['gauge_baseline'], 80)
        r = self.observe(self.start+300, 60)
        self.assertEqual(r['gauge_baseline'], 80)
        self.assertEqual(r['used'], 20)
        self.assertIsNone(self.ledger.read('codex', 'a', self.w, self.start+3601)['gauge_baseline'])
        self.w['resets_at'] = self.start+3600+7*86400
        r = self.observe(self.start+3700, 99)
        self.assertEqual(r['gauge_baseline'], 99)
        self.assertEqual(r['used'], 0)
        self.assertEqual(r['pre_reset'][0]['used'], 20)
        r = self.observe(self.start+4000, 98)
        self.assertEqual(r['gauge_baseline'], 99)
        self.assertEqual(r['used'], 1)
        self.w['resets_at'] = None
        self.assertIsNone(self.observe(self.start+4300, 97)['gauge_baseline'])
        self.w['resets_at'] = self.start+8*86400
        r = self.observe(self.start+86430, 50)
        self.assertEqual(r['gauge_baseline'], 50)
        self.assertEqual(r['used'], 0)
        self.assertNotIn('gauge_baseline', self.ledger.read('codex', None, self.w, self.start+86430))

    def test_day_boundary_partial_and_account_isolation(self):
        self.observe(self.start+1,40)
        self.assertEqual(self.ledger.read('codex','a',self.w,self.start+86400)['status'],'waiting')
        r=self.observe(self.start+86460,30)
        self.assertEqual(r['used'],0)
        self.assertTrue(r['partial'])
        self.assertEqual(self.observe(self.start+86760,20,'b')['used'],0)
        self.assertEqual(self.ledger.read('codex',None,self.w,self.start)['status'],'account_unknown')
        self.assertEqual(day_bounds(self.start-1)[1],self.start)

    def test_reset_gap_and_missing_reset(self):
        self.w['resets_at']=self.start+3600
        self.assertEqual(self.observe(self.start,40)['recommended'],40)
        self.observe(self.start+300,35)
        self.w['resets_at']=self.start+3600+7*86400
        r=self.observe(self.start+3700,99)
        self.assertEqual(r['used'],0)
        self.assertFalse(r['missing'])
        self.assertTrue(r['partial'])
        self.assertEqual(r['pre_reset'][0]['used'],5)
        self.assertAlmostEqual(r['recommended'],99*(86400-3700)/(7*86400-100))
        self.w['resets_at']=None
        self.assertIsNone(self.observe(self.start+4000,98)['recommended'])

    def test_restart_permissions_delay_old_observation(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'daily.json';self.ledger=DailyUsage(path)
            self.observe(self.start,40);self.observe(self.start+300,35)
            self.ledger=DailyUsage(path)
            self.assertEqual(self.observe(self.start+600,32)['used'],8)
            self.assertEqual(path.stat().st_mode&0o777,0o600)
            self.assertNotIn('token',path.read_text())
            self.assertEqual(self.ledger.read('codex','a',self.w,self.start+1300)['status'],'delayed')
            self.ledger.observe('codex','a',[self.w],self.start+500,self.start+2000)
            self.assertEqual(self.ledger.read('codex','a',self.w,self.start+2000)['used'],8)

    def test_zero_missing_and_expired(self):
        self.assertEqual(self.observe(self.start,0)['recommended'],0)
        self.w['resets_at']=self.start+600
        self.observe(self.start+300,0)
        self.assertIsNone(self.ledger.read('codex','a',self.w,self.start+601)['recommended'])
        self.w['resets_at']=None
        r=self.observe(self.start+700,0)
        self.assertIsNone(r['recommended'])

    def test_reset_timestamp_jitter_keeps_budget_and_usage(self):
        initial=self.observe(self.start,40)['recommended']
        reset=self.w['resets_at']
        for i,offset in enumerate([1,-.5,.25,0,1],1):
            self.w['resets_at']=reset+offset
            r=self.observe(self.start+i*300,40-i)
        self.assertEqual(len(r['segments']),1)
        self.assertAlmostEqual(r['recommended'],initial)
        self.assertEqual(r['used'],5)
        self.assertFalse(r['missing'])

    def test_schedule_correction_does_not_duplicate_budget(self):
        initial=self.observe(self.start,40)['recommended']
        self.w['resets_at']+=3600
        r=self.observe(self.start+300,37)
        self.assertEqual(len(r['segments']),1)
        self.assertAlmostEqual(r['recommended'],initial)
        self.assertEqual(r['used'],3)
        self.assertTrue(r['missing'])

    def test_early_reset_restarts_daily_figures_on_new_cycle(self):
        self.observe(self.start+300,73)
        r=self.observe(self.start+3600,52)
        self.assertEqual(r['used'],21)
        at=self.start+10*3600
        self.w['resets_at']=at+7*86400
        r=self.observe(at,100)
        self.assertEqual(len(r['segments']),1)
        self.assertEqual(r['used'],0)
        self.assertEqual(r['gauge_baseline'],100)
        self.assertAlmostEqual(r['recommended'],100*14/(7*24))
        self.assertAlmostEqual(r['available'],r['recommended'])
        self.assertTrue(r['partial'])
        self.assertFalse(r['missing'])
        self.assertNotIn('reset_adjusted',r)
        self.assertEqual(r['early_reset_at'],at)
        self.assertEqual([s['used'] for s in r['pre_reset']],[21])
        r=self.observe(at+300,97)
        self.assertEqual(r['used'],3)
        self.assertEqual(r['gauge_baseline'],100)
        self.assertEqual(len(r['pre_reset']),1)

    def test_full_refill_same_schedule_recalculates_without_duplicate_reset(self):
        self.observe(self.start,40)
        self.observe(self.start+300,30)
        at=self.start+3600
        r=self.observe(at,100)
        self.assertEqual(r['used'],0)
        self.assertEqual(r['pre_reset'][0]['used'],10)
        self.assertAlmostEqual(r['recommended'],100*23/89)
        self.assertEqual(r['available'],r['recommended'])
        budget=r['recommended']
        r=self.observe(at+300,100)
        self.assertEqual(len(r['pre_reset']),1)
        self.assertEqual(r['recommended'],budget)
        r=self.observe(at+600,98)
        self.assertEqual(r['used'],2)

    def test_extra_allocation_above_baseline_and_unknown_schedule(self):
        self.observe(self.start,40)
        self.observe(self.start+300,30)
        r=self.observe(self.start+600,60)
        self.assertEqual(r['gauge_baseline'],60)
        self.assertEqual(r['used'],0)
        self.assertAlmostEqual(r['recommended'],60*(86400-600)/(90*3600-600))
        self.w['resets_at']=None
        r=self.observe(self.start+900,100)
        self.assertIsNone(r['recommended'])
        self.assertEqual(len(r['pre_reset']),1)

    def test_early_reset_history_survives_restart(self):
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'daily.json';self.ledger=DailyUsage(path)
            self.observe(self.start,40);self.observe(self.start+300,30)
            self.w['resets_at']=self.start+600+7*86400
            self.observe(self.start+600,100)
            self.ledger=DailyUsage(path)
            self.assertFalse(self.ledger.storage_error)
            r=self.observe(self.start+900,99)
            self.assertEqual(r['used'],1)
            self.assertEqual(r['pre_reset'][0]['used'],10)

    def test_later_reset_without_restored_quota_stays_correction(self):
        self.observe(self.start,40)
        self.w['resets_at']+=86400
        r=self.observe(self.start+300,40.5)
        self.assertEqual(len(r['segments']),1)
        self.assertNotIn('pre_reset',r)
        self.assertTrue(r['reset_adjusted'])

    def test_missing_reset_recovery_keeps_consumption(self):
        self.w['resets_at']=None
        self.observe(self.start,40)
        self.w['resets_at']=self.start+90*3600
        r=self.observe(self.start+300,37)
        self.assertEqual(r['used'],3)
        self.assertAlmostEqual(r['recommended'],40*24/90)
        self.w['resets_at']=None
        r=self.observe(self.start+600,35)
        self.assertEqual(r['used'],5)
        self.assertIsNone(r['recommended'])

    def test_repair_preserves_first_budget_and_real_reset(self):
        self.w['resets_at']=self.start+3600
        self.observe(self.start,40)
        record=next(iter(self.ledger.records.values()))
        from copy import deepcopy
        first=record['segments'][0]
        jitter=deepcopy(first);jitter.update(started_at=self.start+300,reset_at=first['reset_at']+1,baseline=37,lowest=36,used=1,budget=37)
        actual=deepcopy(first);actual.update(started_at=self.start+3700,reset_at=self.start+7*86400+3600,baseline=99,lowest=98,used=1,budget=10)
        record['segments']=[first,jitter,actual];record['missing']=True
        self.assertEqual(self.ledger.repair_jitter(),1)
        self.assertEqual(len(record['segments']),2)
        self.assertEqual(record['segments'][0]['budget'],40)
        self.assertEqual(record['segments'][0]['used'],4)
        self.assertTrue(record['missing'])
        self.assertEqual(self.ledger.repair_jitter(),0)

    def test_repair_single_cycle_persists_and_accepts_next_observation(self):
        from copy import deepcopy
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'daily.json';self.ledger=DailyUsage(path)
            initial=self.observe(self.start,40)['recommended']
            record=next(iter(self.ledger.records.values()))
            jitter=deepcopy(record['segments'][0])
            jitter.update(started_at=self.start+300,reset_at=jitter['reset_at']+1,
                          baseline=37,lowest=36,used=1,budget=20)
            record['segments'].append(jitter);record['missing']=True
            self.assertEqual(self.ledger.repair_jitter(),1)
            self.ledger.save();self.ledger=DailyUsage(path)
            self.w['resets_at']+=1
            r=self.observe(self.start+600,35)
            self.assertEqual(len(r['segments']),1)
            self.assertEqual(r['used'],5)
            self.assertAlmostEqual(r['recommended'],initial)
            self.assertFalse(r['missing'])
            self.assertTrue(r['partial'] is False)
            self.assertEqual(self.ledger.repair_jitter(),0)

    def test_repair_does_not_chain_small_timestamp_drift(self):
        from copy import deepcopy
        self.observe(self.start,40)
        record=next(iter(self.ledger.records.values()))
        first=record['segments'][0]
        for offset in (4,8):
            segment=deepcopy(first);segment['reset_at']+=offset
            record['segments'].append(segment)
        self.assertEqual(self.ledger.repair_jitter(),1)
        self.assertEqual(len(record['segments']),2)

    def test_corrupt_file_and_failed_save(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'daily.json';path.write_text('{"version":1,"records":{"bad":{}}}')
            self.ledger=DailyUsage(path)
            self.assertTrue(self.ledger.storage_error)
            with patch('local_monitor.daily_usage.os.replace',side_effect=OSError):
                r=self.observe(self.start,40)
            self.assertTrue(r['storage_error'])
            self.assertFalse(list(Path(d).glob('.daily-*')))

    def test_cache_integration_does_not_expose_account(self):
        from unittest.mock import patch
        from local_monitor.usage import UsageCache
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'daily.json';cache=UsageCache(path)
            with patch('local_monitor.usage.time.time',return_value=self.start):
                cache.update('codex',[self.w],account='hashed-account')
            self.w['remaining_percent']=37
            cache=UsageCache(path)
            with patch('local_monitor.usage.time.time',return_value=self.start+300):
                cache.update('codex',[self.w],account='hashed-account')
                cache.update('codex',error='timeout')
            row=cache.read(self.start+300)[0]
            self.assertEqual(row['windows'][0]['daily']['used'],3)
            self.assertEqual(row['windows'][0]['daily']['status'],'delayed')
            self.assertNotIn('hashed-account',json.dumps(row))

if __name__=='__main__':unittest.main()
