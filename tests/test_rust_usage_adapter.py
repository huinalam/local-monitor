import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock,patch
from local_monitor.rust_usage_adapter import refresh
from local_monitor.__main__ import save

class RustUsageAdapterTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.now=time.time()
        self.windows=[{'id':'weekly','label':'주간','remaining_percent':95,'used_percent':5,'resets_at':self.now+86400,'group':'codex'}]
        self.rows=[dict(provider=p,status='ok',windows=self.windows,observed_at=self.now,checked_at=self.now,error=None,next_retry_at=self.now+300,source='account') for p in ['codex','claude','antigravity']]
        save(self.root/'rust/usage-state.json',{'version':1,'rows':self.rows,'accounts':{'codex':'hash','claude':'hash'},'backoff':{}})

    def test_cached_retry_times_skip_all_remote_queries(self):
        collector=Mock();agy=Mock()
        result=refresh(self.root,self.root/'codex',self.root/'claude',collector=collector,agy=agy)
        collector.assert_not_called();agy.collect.assert_not_called()
        self.assertEqual(len(result),3);self.assertEqual(result[0]['windows'][0]['remaining_percent'],95)
        self.assertEqual((self.root/'rust/usage-state.json').stat().st_mode&0o777,0o600)

    def test_rate_limit_preserves_values_and_persists_backoff(self):
        self.rows[0]['next_retry_at']=self.now-1
        save(self.root/'rust/usage-state.json',{'rows':self.rows,'accounts':{'codex':'hash','claude':'hash'},'backoff':{'codex':1200}})
        def collect(cache,provider,home,fallback):
            self.assertEqual(provider,'codex');self.assertEqual(fallback,1200)
            cache.update(provider,error='rate_limited');cache.rows[provider]['next_retry_at']=time.time()+fallback
            return fallback
        result=refresh(self.root,self.root/'codex',self.root/'claude',collector=collect,agy=Mock())
        codex=next(r for r in result if r['provider']=='codex');self.assertEqual(codex['windows'][0]['remaining_percent'],95);self.assertEqual(codex['error'],'rate_limited')
        saved=json.loads((self.root/'rust/usage-state.json').read_text());self.assertEqual(saved['backoff']['codex'],2400)

    def test_success_keeps_daily_ledger_across_adapter_restarts(self):
        self.rows[0]['next_retry_at']=0
        save(self.root/'rust/usage-state.json',{'rows':self.rows,'accounts':{'codex':'hash','claude':'hash'},'backoff':{}})
        def collect(cache,provider,home,fallback):
            cache.update(provider,self.windows,account='hash');cache.rows[provider]['next_retry_at']=time.time()+300
            return 300
        first=refresh(self.root,self.root/'codex',self.root/'claude',collector=collect,agy=Mock())
        initial=next(r for r in first if r['provider']=='codex')['windows'][0]['daily']['recommended']
        persisted=json.loads((self.root/'rust/usage-state.json').read_text())
        restored=next(r for r in persisted['rows'] if r['provider']=='codex')
        self.assertEqual(restored['windows'][0]['daily']['recommended'],initial)
        second=refresh(self.root,self.root/'codex',self.root/'claude',collector=Mock(),agy=Mock())
        self.assertEqual(next(r for r in second if r['provider']=='codex')['windows'][0]['daily']['recommended'],initial)
