import base64
import json
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from local_monitor.agy_usage import account_identity
from local_monitor.rust_usage_adapter import refresh
from local_monitor.usage import UsageCache


class AgyAccountTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.env = patch.dict('os.environ', {}, clear=True)
        self.env.start()
        self.addCleanup(self.env.stop)

    def token(self, sub='account-a', expiry=1, issuer='https://accounts.google.com'):
        claims = base64.urlsafe_b64encode(json.dumps(dict(sub=sub, iss=issuer, exp=expiry)).encode()).decode().rstrip('=')
        (self.root/'jetski-standalone-oauth-token').write_text(json.dumps(dict(auth_method='consumer', id_token='header.'+claims+'.signature')))

    def test_stable_identity_and_separation(self):
        self.token(); first = account_identity(self.root)
        self.assertEqual(len(first), 64)
        self.token(expiry=999, issuer='accounts.google.com')
        self.assertEqual(first, account_identity(self.root))
        self.token(sub='account-b')
        self.assertNotEqual(first, account_identity(self.root))

    def test_unknown_and_overrides(self):
        self.assertIsNone(account_identity(self.root))
        self.token(issuer='untrusted')
        self.assertIsNone(account_identity(self.root))
        self.token()
        with patch.dict('os.environ', {'GEMINI_API_KEY':'not-a-real-key'}):
            self.assertIsNone(account_identity(self.root))
        (self.root/'jetski-standalone-oauth-token').write_text('x'*65537)
        self.assertIsNone(account_identity(self.root))

    def email_file(self, email, with_token=False, claim_email=None):
        payload = dict(auth_method='consumer', id_token_email=email)
        if with_token:
            claims = dict(sub='subject', iss='https://accounts.google.com', email=claim_email or email)
            encoded = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip('=')
            payload['id_token'] = 'header.'+encoded+'.signature'
        (self.root/'jetski-standalone-oauth-token').write_text(json.dumps(payload))

    def test_email_survives_token_removal_and_return(self):
        self.email_file('person@example.com', with_token=True)
        first = account_identity(self.root)
        self.assertEqual(len(first),64)
        self.email_file(' PERSON@EXAMPLE.COM ')
        self.assertEqual(account_identity(self.root),first)
        self.email_file('person@example.com', with_token=True)
        self.assertEqual(account_identity(self.root),first)
        payload=json.loads((self.root/'jetski-standalone-oauth-token').read_text())
        del payload['id_token_email']
        (self.root/'jetski-standalone-oauth-token').write_text(json.dumps(payload))
        self.assertEqual(account_identity(self.root),first)

    def test_email_switch_conflict_and_invalid_fail_closed(self):
        self.email_file('one@example.com');first=account_identity(self.root)
        self.email_file('two@example.com')
        self.assertNotEqual(first,account_identity(self.root))
        self.email_file('one@example.com',with_token=True,claim_email='two@example.com')
        self.assertIsNone(account_identity(self.root))
        for value in [None, '', 'bad', 'a b@example.com', 'x'*255+'@example.com']:
            self.email_file(value)
            self.assertIsNone(account_identity(self.root))

    def test_email_key_keeps_daily_history_after_refresh(self):
        self.email_file('person@example.com', with_token=True)
        key=account_identity(self.root)
        path=self.root/'daily.json'
        cache=UsageCache(path)
        now=time.time()
        w=dict(id='weekly',label='주간',remaining_percent=90,used_percent=10,resets_at=now+86400)
        cache.update('antigravity',[w],account=key,observed_at=now-10)
        self.email_file('person@example.com')
        cache=UsageCache(path)
        w.update(remaining_percent=87,used_percent=13)
        cache.update('antigravity',[w],account=account_identity(self.root),observed_at=now)
        row=next(r for r in cache.read() if r['provider']=='antigravity')
        self.assertEqual(row['windows'][0]['daily']['used'],3)
        self.assertNotIn('person@example.com',path.read_text())
        self.assertNotIn('person@example.com',json.dumps(row))

    def run_adapter(self, identities):
        now = time.time()
        windows = [dict(id='weekly',label='주간',remaining_percent=90,used_percent=10,resets_at=now+86400,group='gemini')]
        agy = Mock(); agy.collect.return_value = windows
        with patch('local_monitor.rust_usage_adapter.account_identity', side_effect=identities):
            rows = refresh(self.root,self.root/'codex',self.root/'claude',collector=Mock(return_value=300),agy=agy)
        return next(r for r in rows if r['provider']=='antigravity')

    def test_daily_persistence_and_passive_rejection(self):
        row = self.run_adapter(['fingerprint','fingerprint'])
        self.assertTrue(row['account_bound'])
        self.assertEqual(row['windows'][0]['daily']['status'],'ok')
        (self.root/'usage-antigravity.json').write_text(json.dumps(dict(observed_at=time.time()+1,quota={'weekly':dict(remaining_fraction=.01,reset_time=time.time()+86400)})))
        again = self.run_adapter([])
        self.assertEqual(row['windows'],again['windows'])
        self.assertNotIn('account-a',(self.root/'daily-usage.json').read_text())

    def test_switch_during_query_never_attributes(self):
        row = self.run_adapter(['first','second'])
        self.assertFalse(row['account_bound'])
        self.assertEqual(row['windows'][0]['daily']['status'],'account_unknown')

    def test_passive_cannot_clear_known_account_even_after_error(self):
        cache = UsageCache()
        cache.update('antigravity',[],account='known')
        cache.update('antigravity',error='read_failed')
        cache.update('antigravity',[],merge=True,observed_at=time.time()+1)
        self.assertEqual(cache.accounts['antigravity'],'known')
        self.assertEqual(cache.rows['antigravity']['error'],'read_failed')
