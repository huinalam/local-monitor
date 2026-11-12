import json
import fcntl
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from local_monitor.claude_refresh import ClaudeRefresh


class RefreshTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.runtime=Path(self.tmp.name);self.home=self.runtime/'claude-home'
        self.refresh=ClaudeRefresh(self.runtime,self.home);self.states=[]

    def test_success_persisted_cooldown_and_safe_command(self):
        def run(cmd,**kw):
            persisted=json.loads(self.refresh.path.read_text())
            self.assertEqual(persisted['status'],'running')
            self.assertIn('--safe-mode',cmd);self.assertIn('--no-session-persistence',cmd)
            self.assertEqual(cmd[cmd.index('--tools')+1],'')
            self.assertEqual(kw['env']['CLAUDE_CONFIG_DIR'],str(self.home))
            self.assertNotIn('ANTHROPIC_API_KEY',kw['env'])
            self.assertEqual(kw['timeout'],55)
            self.assertEqual(kw['stdout'],subprocess.DEVNULL)
            return subprocess.CompletedProcess(cmd,0)
        with patch.dict('os.environ',{'ANTHROPIC_API_KEY':'do-not-use'}),patch('local_monitor.claude_refresh.subprocess.run',side_effect=run) as cli:
            self.assertTrue(self.refresh.attempt(self.states.append))
            self.assertEqual(self.states[-1]['status'],'completed')
            self.assertFalse(ClaudeRefresh(self.runtime,self.home).attempt(self.states.append))
            self.assertEqual(cli.call_count,1)
        self.assertEqual(self.refresh.path.stat().st_mode&0o777,0o600)

    def test_default_home_does_not_override_cli_credential_scope(self):
        refresh=ClaudeRefresh(self.runtime,Path.home()/'.claude')
        with patch.dict('os.environ',{'CLAUDE_CONFIG_DIR':'/wrong-home'}),patch('local_monitor.claude_refresh.subprocess.run',return_value=subprocess.CompletedProcess([],0)) as cli:
            refresh.attempt(self.states.append)
            self.assertNotIn('CLAUDE_CONFIG_DIR',cli.call_args.kwargs['env'])

    def test_timeout_missing_and_failure_backoff(self):
        for outcome,status in [(subprocess.TimeoutExpired('claude',55),'timeout'),(FileNotFoundError(),'unavailable'),(subprocess.CompletedProcess([],1),'failed')]:
            with self.subTest(status=status):
                self.refresh.path.unlink(missing_ok=True)
                with patch('local_monitor.claude_refresh.subprocess.run',side_effect=outcome if isinstance(outcome,Exception) else None,return_value=outcome) as cli:
                    self.assertTrue(self.refresh.attempt(self.states.append))
                    self.assertEqual(self.states[-1]['status'],status)
                    self.assertFalse(self.refresh.attempt(self.states.append))
                    self.assertEqual(cli.call_count,1)

    def test_disabled_singleflight_and_corrupt_state(self):
        with patch('local_monitor.claude_refresh.subprocess.run') as cli:
            with patch.dict('os.environ',{'LM_CLAUDE_AUTO_REFRESH':'0'}):
                self.assertFalse(self.refresh.attempt(self.states.append))
            self.refresh.lock.acquire()
            self.assertFalse(self.refresh.attempt(self.states.append));self.refresh.lock.release()
            self.refresh.path.write_text('broken')
            self.assertFalse(self.refresh.attempt(self.states.append))
            self.assertEqual(self.states[-1]['status'],'storage_error');cli.assert_not_called()

    def test_failed_persistence_never_executes(self):
        with patch.object(self.refresh,'save',side_effect=OSError),patch('local_monitor.claude_refresh.subprocess.run') as cli:
            self.assertFalse(self.refresh.attempt(self.states.append))
            self.assertFalse(self.refresh.attempt(self.states.append));cli.assert_not_called()

    def test_process_lock_and_retry_after_hour(self):
        with (self.runtime/'claude-refresh.lock').open('a') as lock:
            fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
            with patch('local_monitor.claude_refresh.subprocess.run') as cli:
                self.assertFalse(self.refresh.attempt(self.states.append));cli.assert_not_called()
        with patch('local_monitor.claude_refresh.time.time',return_value=100),patch('local_monitor.claude_refresh.subprocess.run',return_value=subprocess.CompletedProcess([],1)) as cli:
            self.assertTrue(self.refresh.attempt(self.states.append))
            with patch('local_monitor.claude_refresh.time.time',return_value=3699):
                self.assertFalse(self.refresh.attempt(self.states.append))
            with patch('local_monitor.claude_refresh.time.time',return_value=3700):
                self.assertTrue(self.refresh.attempt(self.states.append))
            self.assertEqual(cli.call_count,2)

    def test_only_expired_worker_triggers_and_rechecks(self):
        from local_monitor.usage import UsageCache,start_workers
        for error,expected in [('auth_expired',1),('auth_required',0),('rate_limited',0),(None,0)]:
            with self.subTest(error=error):
                cache=UsageCache();targets=[]
                class Stop:
                    def is_set(self):return False
                    def wait(self,delay):raise RuntimeError('iteration complete')
                class Thread:
                    def __init__(self,target,args=(),**kwargs):targets.append((target,args))
                    def start(self):pass
                def collect(cache,provider,home,*args):
                    cache.rows[provider]['error']=error;return 15
                with patch('local_monitor.usage.threading.Thread',Thread),patch('local_monitor.usage.collect',side_effect=collect) as read,patch('local_monitor.claude_refresh.ClaudeRefresh.attempt',return_value=True) as attempt:
                    start_workers(cache,Stop(),self.home,self.home,self.runtime)
                    target,args=targets[1]
                    with self.assertRaisesRegex(RuntimeError,'iteration complete'):target(*args)
                    self.assertEqual(attempt.call_count,expected)
                    self.assertEqual(read.call_count,1+expected)
