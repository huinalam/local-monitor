import json
import io
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from local_monitor.antigravity_hook import EVENTS, capture, install, main
from local_monitor.detector import Detector


class AntigravityTasksTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.spool=self.root/'runtime/antigravity-hooks'
        self.clock=1000
        self.detector=Detector(self.root/'codex',self.root/'claude',self.root/'runtime/hooks',now=lambda:self.clock)

    def event(self,event,**extra):
        with patch('local_monitor.antigravity_hook.time.time',return_value=self.clock):
            return capture(event,dict({'conversationId':'agy-one','workspacePaths':['/project']},**extra),self.spool)

    def row(self,snap):
        return next(r for r in snap['sessions'] if r['provider']=='antigravity')

    def hook_response(self,event,payload='{}',capture_error=None,skip=False):
        output=io.StringIO()
        with patch('sys.argv',['hook','capture','--event',event]), \
                patch('sys.stdin',io.StringIO(payload)), patch('sys.stdout',output), \
                patch('local_monitor.antigravity_hook.ancestor',return_value={}), \
                patch('local_monitor.antigravity_hook.capture',side_effect=capture_error), \
                patch.dict(os.environ,{'LOCAL_MONITOR_AGY_USAGE':'1' if skip else '0'}):
            main()
        return json.loads(output.getvalue())

    def test_monitoring_hook_allows_pre_tool_and_keeps_other_event_contracts(self):
        for event in EVENTS:
            with self.subTest(event=event):
                expected={'decision':'allow'} if event=='PreToolUse' else {}
                self.assertEqual(self.hook_response(event),expected)

    def test_monitoring_failure_or_skip_does_not_block_tools(self):
        for kwargs in ({'payload':'invalid-json'},{'capture_error':OSError('spool unavailable')},{'skip':True}):
            with self.subTest(kwargs=kwargs):
                self.assertEqual(self.hook_response('PreToolUse',**kwargs),{'decision':'allow'})

    def test_running_completion_once_and_new_turn(self):
        self.detector.poll();self.event('PreInvocation',invocationNum=0)
        snap,events=self.detector.poll();self.assertEqual(self.row(snap)['status'],'running');self.assertEqual(events,[])
        self.event('PostInvocation');self.assertEqual(self.row(self.detector.poll()[0])['status'],'running')
        self.clock+=1;self.event('Stop',terminationReason='NO_TOOL_CALL',fullyIdle=True)
        snap,events=self.detector.poll();self.assertEqual(self.row(snap)['status'],'completed');self.assertEqual(len(events),1)
        completed=self.row(snap)['completed_at']
        self.event('Stop',terminationReason='NO_TOOL_CALL',fullyIdle=True)
        snap,events=self.detector.poll();self.assertEqual(events,[]);self.assertEqual(self.row(snap)['completed_at'],completed)
        self.event('PreInvocation');snap,_=self.detector.poll();self.assertEqual(self.row(snap)['status'],'running');self.assertNotIn('completed_at',self.row(snap))

    def test_stop_reasons_and_background(self):
        self.detector.poll()
        for reason,idle,expected in [('NO_TOOL_CALL',False,'background'),('ERROR',True,'failed'),('USER_CANCELED',True,'interrupted'),('MAX_INVOCATIONS',True,'unknown'),('NEW_REASON',True,'unknown')]:
            self.event('PreInvocation');self.detector.poll();self.event('Stop',terminationReason=reason,fullyIdle=idle)
            snap,events=self.detector.poll();self.assertEqual(self.row(snap)['status'],expected);self.assertEqual(events,[])

    def test_history_and_orphan_stop_never_notify(self):
        self.event('PreInvocation');self.event('Stop',terminationReason='NO_TOOL_CALL',fullyIdle=True)
        snap,events=self.detector.poll();self.assertEqual(events,[]);self.assertEqual(self.row(snap)['status'],'completed')
        other=Detector(self.root/'codex',self.root/'claude',self.root/'runtime/hooks',now=lambda:self.clock)
        self.assertEqual(other.poll()[1],[])
        self.event('Stop',terminationReason='NO_TOOL_CALL',fullyIdle=True,conversationId='orphan');self.assertEqual(self.detector.poll()[1],[])

    def test_privacy_skip_and_permissions(self):
        p=self.event('PreToolUse',toolCall={'args':'SECRET'},error='SECRET',prompt='SECRET')
        self.assertNotIn('SECRET',p.read_text());self.assertEqual(p.stat().st_mode&0o777,0o600)
        p=self.event('Stop',terminationReason='SECRET',error='SECRET')
        self.assertNotIn('SECRET',p.read_text())
        with patch.dict(os.environ,{'LOCAL_MONITOR_AGY_USAGE':'1'}):self.assertIsNone(self.event('PreInvocation'))
        self.assertIsNone(self.event('BadEvent'));self.assertIsNone(self.event('Stop',conversationId=''))

    def test_stale_and_dead_process_never_complete(self):
        self.detector.poll();self.event('PreInvocation');self.detector.poll();self.clock+=601
        snap,events=self.detector.poll();self.assertEqual(self.row(snap)['status'],'unknown');self.assertEqual(events,[])
        with patch('local_monitor.antigravity_hook.time.time',return_value=self.clock):
            capture('PreInvocation',{'conversationId':'agy-one','workspacePaths':['/project']},self.spool,
                    owner={'pid':99999999,'procStart':'not a real process'})
        snap,events=self.detector.poll();self.assertEqual(self.row(snap)['status'],'disconnected');self.assertEqual(events,[])

    def test_future_or_malformed_event_is_rejected(self):
        self.spool.mkdir(parents=True)
        (self.spool/'bad.json').write_text(json.dumps({'session_id':'x','event':'PreInvocation','at':self.clock+120}))
        snap,events=self.detector.poll();self.assertFalse(any(r['provider']=='antigravity' for r in snap['sessions']))
        self.assertIn('antigravity_hook_invalid',snap['errors']);self.assertEqual(events,[])

    def test_installer_conflict_preserves_existing(self):
        settings=self.root/'hooks.json';raw=json.dumps({'local-monitor-task-detection':{'enabled':False}});settings.write_text(raw)
        with self.assertRaises(ValueError):install(settings,self.root/'runtime')
        self.assertEqual(settings.read_text(),raw)

    def test_installer_idempotent_and_preserves_other_settings(self):
        settings=self.root/'hooks.json';settings.write_text(json.dumps({'other':{'enabled':False}}))
        self.assertTrue(install(settings,self.root/'runtime'))
        self.assertFalse(install(settings,self.root/'runtime'))
        self.assertTrue(install(settings,self.root/'runtime',remove=True))
        self.assertEqual(json.loads(settings.read_text()),{'other':{'enabled':False}})
