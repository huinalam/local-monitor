import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch
from local_monitor.detector import Detector, Tail, process_matches
from local_monitor.hook import capture, EVENTS
from local_monitor.__main__ import hooks


class DetectorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.codex = self.root/'codex'; self.codex.mkdir()
        self.claude = self.root/'claude'; (self.claude/'sessions').mkdir(parents=True)
        self.spool = self.root/'runtime/hooks'; self.spool.mkdir(parents=True)
        self.log = self.codex/'rollout.jsonl'; self.log.touch()
        self.clock = 1000.0
        with sqlite3.connect(self.codex/'state_5.sqlite') as c:
            c.execute('create table threads (id text,cwd text,title text,rollout_path text,source text,archived int,updated_at int)')
            c.execute('insert into threads values (?,?,?,?,?,?,?)',
                      ('one','/project','Example',str(self.log),'vscode',0,1000))
        self.d = Detector(self.codex,self.claude,self.spool,alive=lambda r: r.get('valid',False),now=lambda:self.clock)

    def event(self, kind, turn='t1', at=None):
        value={'timestamp':datetime.fromtimestamp(at or self.clock,timezone.utc).isoformat(),
               'type':'event_msg','payload':{'type':kind,'turn_id':turn}}
        with self.log.open('a') as f: f.write(json.dumps(value)+'\n')

    def hook(self, kind, **extra):
        with patch('local_monitor.hook.time.time',return_value=self.clock):
            return capture(dict(hook_event_name=kind,session_id='c1',cwd='/project',**extra),self.spool)

    def registry(self,entrypoint='cli',valid=True):
        (self.claude/'sessions/a.json').write_text(json.dumps(dict(sessionId='c1',cwd='/project',
            entrypoint=entrypoint,status='idle',pid=42,valid=valid)))

    def row(self,snapshot,provider='codex'):
        return next(r for r in snapshot['sessions'] if r['provider']==provider)

    def test_completion_time_stays_fixed_and_new_turn_clears_it(self):
        self.d.poll()
        self.event('task_started', at=1001)
        self.event('task_complete', at=1002)
        self.clock = 1010
        snap, _ = self.d.poll()
        self.assertEqual(self.row(snap)['completed_at'], 1010)
        self.clock = 1100
        self.event('task_complete', at=1002)
        snap, events = self.d.poll()
        self.assertEqual(self.row(snap)['completed_at'], 1010)
        self.assertEqual(events, [])
        self.event('task_started', turn='t2')
        snap, _ = self.d.poll()
        self.assertEqual(self.row(snap)['status'], 'running')
        self.assertNotIn('completed_at', self.row(snap))

    def test_initial_history_never_alerts(self):
        self.event('task_started',at=900);self.event('task_complete',at=901)
        snap,events=self.d.poll()
        self.assertEqual(events,[]);self.assertEqual(self.row(snap)['status'],'completed')
        self.assertEqual(self.row(snap)['completed_at'], 901)
        restarted=Detector(self.codex,self.claude,self.spool,now=lambda:self.clock)
        self.assertEqual(restarted.poll()[1],[])

    def test_compressed_only_excluded_and_original_restored(self):
        compressed = self.log.with_suffix('.jsonl.zst')
        compressed.write_bytes(b'not read or decompressed')
        self.log.unlink()
        snap, events = self.d.poll()
        self.assertEqual((snap['sessions'], snap['errors'], events), ([], [], []))
        self.event('task_started', at=900)
        self.event('task_complete', at=901)
        snap, events = self.d.poll()
        self.assertEqual(self.row(snap)['status'], 'completed')
        self.assertEqual((snap['errors'], events), ([], []))
        self.log.unlink()
        snap, events = self.d.poll()
        self.assertEqual((snap['sessions'], snap['errors'], events), ([], [], []))
        self.assertNotIn('one', self.d.tails)
        compressed.unlink()
        snap, events = self.d.poll()
        self.assertEqual(self.row(snap)['reason'], 'rollout_unavailable')
        self.assertEqual(self.row(snap)['status'], 'unknown')

    def test_compressed_database_path_excluded(self):
        compressed = self.log.with_suffix('.jsonl.zst')
        compressed.write_bytes(b'not read')
        with sqlite3.connect(self.codex/'state_5.sqlite') as c:
            c.execute('update threads set rollout_path=?', (str(compressed),))
        snap, events = self.d.poll()
        self.assertEqual((snap['sessions'], snap['errors'], events), ([], [], []))

    def test_live_completion_once_and_new_turn(self):
        self.d.poll();self.event('task_started');self.clock+=1;self.event('task_complete')
        self.assertEqual(len(self.d.poll()[1]),1)
        self.event('task_complete');self.assertEqual(self.d.poll()[1],[])
        self.event('task_started','t2');self.event('task_complete','t2')
        self.assertEqual(len(self.d.poll()[1]),1)

    def test_partial_line_deferred(self):
        self.d.poll();self.event('task_started')
        text=json.dumps({'timestamp':datetime.fromtimestamp(self.clock,timezone.utc).isoformat(),
                        'type':'event_msg','payload':{'type':'task_complete','turn_id':'t1'}})
        with self.log.open('a') as f:f.write(text[:30])
        self.assertEqual(self.d.poll()[1],[])
        with self.log.open('a') as f:f.write(text[30:]+'\n')
        self.assertEqual(len(self.d.poll()[1]),1)

    def test_abort_and_late_completion(self):
        self.d.poll();self.event('task_started','t2');self.event('task_complete','t1')
        snap,events=self.d.poll();self.assertEqual(events,[]);self.assertEqual(self.row(snap)['status'],'running')
        self.event('turn_aborted','t2');snap,events=self.d.poll()
        self.assertEqual(self.row(snap)['status'],'interrupted');self.assertEqual(events,[])

    def test_old_running_is_unknown(self):
        self.event('task_started',at=1)
        snap,_=self.d.poll();self.assertEqual(self.row(snap)['status'],'unknown')

    def test_rotation_and_malformed_records(self):
        self.event('task_started',at=900);self.d.poll()
        self.log.unlink();self.log.write_text('not json\n')
        self.event('task_complete',at=950)
        self.assertEqual(self.d.poll()[1],[])

    def test_cli_sources_follow_turn_lifecycle(self):
        for source in ('cli', 'exec'):
            with self.subTest(source=source):
                self.log.write_text('')
                with sqlite3.connect(self.codex/'state_5.sqlite') as c:
                    c.execute('update threads set source=?', (source,))
                self.d = Detector(self.codex,self.claude,self.spool,now=lambda:self.clock)
                self.event('task_complete', turn='old', at=900)
                self.assertEqual(self.d.poll()[1], [])
                self.event('task_started', at=1001)
                snap,_ = self.d.poll()
                self.assertEqual(self.row(snap)['status'], 'running')
                self.assertEqual(self.row(snap)['source'], source)
                self.event('task_complete', at=1002)
                snap,events = self.d.poll()
                self.assertEqual(self.row(snap)['status'], 'completed')
                self.assertEqual(len(events), 1)
                self.assertEqual(self.d.poll()[1], [])
                self.event('task_started', turn='next', at=1003)
                self.event('turn_aborted', turn='next', at=1004)
                self.assertEqual(self.row(self.d.poll()[0])['status'], 'interrupted')
                with sqlite3.connect(self.codex/'state_5.sqlite') as c:
                    c.execute('update threads set archived=1')
                fresh = Detector(self.codex,self.claude,self.spool,now=lambda:self.clock)
                self.assertEqual(fresh.poll()[0]['sessions'], [])
                with sqlite3.connect(self.codex/'state_5.sqlite') as c:
                    c.execute('update threads set archived=0')

    def test_subagent_and_unknown_sessions_are_excluded(self):
        with sqlite3.connect(self.codex/'state_5.sqlite') as c:
            for source in ('unknown', '{"subagent":{}}'):
                c.execute('insert into threads values (?,?,?,?,?,?,?)',
                          (source,'/project','Hidden',str(self.log),source,0,1000))
        self.assertEqual(len(self.d.poll()[0]['sessions']),1)

    def test_removed_registry_clears_old_verification_without_ending_session(self):
        self.registry();self.hook('UserPromptSubmit')
        snap,_=self.d.poll();self.assertTrue(self.row(snap,'claude')['process_verified'])
        path=self.claude/'sessions/a.json';path.unlink()
        snap,events=self.d.poll()
        self.assertNotIn('process_verified',self.row(snap,'claude'))
        self.assertEqual(self.row(snap,'claude')['status'],'running');self.assertEqual(events,[])
        self.clock+=601;snap,_=self.d.poll()
        self.assertEqual(self.row(snap,'claude')['reason'],'no_recent_evidence')
        self.registry();snap,_=self.d.poll();self.assertTrue(self.row(snap,'claude')['process_verified'])
        path.write_text('invalid');snap,_=self.d.poll()
        self.assertNotIn('process_verified',self.row(snap,'claude'))
        self.assertIn('claude_registry_invalid',snap['errors'])

    def test_registry_busy_fallback_and_idle_without_completion(self):
        self.registry()
        path=self.claude/'sessions/a.json'
        record=json.loads(path.read_text());record.update(status='busy',updatedAt=self.clock*1000)
        path.write_text(json.dumps(record))
        snap,events=self.d.poll()
        self.assertEqual(self.row(snap,'claude')['status'],'running')
        self.assertEqual(self.row(snap,'claude')['observed_at'],self.clock)
        self.assertEqual(events,[])
        record.update(status='idle',updatedAt=(self.clock+1)*1000);path.write_text(json.dumps(record));self.clock+=1
        snap,events=self.d.poll()
        self.assertEqual(self.row(snap,'claude')['status'],'idle');self.assertEqual(events,[])
        self.assertNotIn('completed_at',self.row(snap,'claude'))

    def test_registry_busy_requires_recent_valid_timestamp_and_live_process(self):
        self.registry();path=self.claude/'sessions/a.json';record=json.loads(path.read_text())
        for timestamp in [None,True,'invalid',float('nan'),(self.clock+120)*1000,(self.clock-601)*1000]:
            record.update(status='busy',updatedAt=timestamp);path.write_text(json.dumps(record))
            snap,events=self.d.poll();self.assertEqual(self.row(snap,'claude')['status'],'unknown');self.assertEqual(events,[])
        record.update(valid=False,updatedAt=self.clock*1000);path.write_text(json.dumps(record))
        self.assertEqual(self.row(self.d.poll()[0],'claude')['status'],'disconnected')

    def test_registry_busy_does_not_override_permission_hook(self):
        self.registry();self.hook('UserPromptSubmit');self.hook('PermissionRequest');self.d.poll()
        path=self.claude/'sessions/a.json';record=json.loads(path.read_text());record.update(status='busy',updatedAt=self.clock*1000);path.write_text(json.dumps(record))
        self.assertEqual(self.row(self.d.poll()[0],'claude')['status'],'waiting_input')

    def test_stop_without_observed_turn_does_not_alert(self):
        self.d.poll();self.hook('Stop')
        self.assertEqual(self.d.poll()[1],[])

    def test_ended_process_does_not_create_completion(self):
        self.registry();self.d.poll();self.hook('UserPromptSubmit');self.d.poll()
        self.registry(valid=False);snap,events=self.d.poll()
        self.assertEqual(events,[])
        self.assertEqual(self.row(snap,'claude')['status'],'disconnected')

    def test_missing_database_is_reported(self):
        (self.codex/'state_5.sqlite').unlink()
        snap,_=self.d.poll();self.assertIn('codex_database_missing',snap['errors'])

    def test_claude_turn_wait_complete(self):
        self.registry();self.d.poll();self.hook('UserPromptSubmit',prompt_id='p1')
        self.hook('PermissionRequest');snap,events=self.d.poll()
        self.assertEqual(self.row(snap,'claude')['status'],'waiting_input')
        self.hook('PostToolUse');self.hook('Stop');snap,events=self.d.poll()
        self.assertEqual(self.row(snap,'claude')['status'],'completed');self.assertEqual(len(events),1)
        self.hook('Stop');self.assertEqual(self.d.poll()[1],[])

    def test_claude_error_background_and_exit_not_completion(self):
        self.registry();self.d.poll();self.hook('UserPromptSubmit')
        self.hook('Stop',background_tasks=[{'status':'running'}])
        snap,events=self.d.poll();self.assertEqual(self.row(snap,'claude')['status'],'background');self.assertEqual(events,[])
        self.hook('StopFailure');snap,events=self.d.poll()
        self.assertEqual(self.row(snap,'claude')['status'],'failed');self.assertEqual(events,[])
        self.hook('SessionEnd');self.assertEqual(self.row(self.d.poll()[0],'claude')['status'],'disconnected')

    def test_desktop_included_completion_once_and_reused_pid_disconnected(self):
        self.registry('claude-desktop');self.hook('UserPromptSubmit');snap,initial=self.d.poll()
        self.assertEqual(initial,[])
        self.assertEqual(self.row(snap,'claude')['status'],'running')
        self.hook('Stop');snap,events=self.d.poll()
        self.assertEqual(self.row(snap,'claude')['status'],'completed')
        self.assertEqual(len(events),1)
        self.hook('Stop');self.assertEqual(self.d.poll()[1],[])
        self.registry(valid=False);snap,_=self.d.poll()
        self.assertEqual(self.row(snap,'claude')['status'],'disconnected')

    def test_hook_never_persists_content(self):
        p=self.hook('Stop',last_assistant_message='SECRET',prompt='SECRET',api_key='SECRET')
        self.assertNotIn('SECRET',p.read_text());self.assertEqual(p.stat().st_mode&0o777,0o600)
        self.assertIsNone(capture({'hook_event_name':'Unknown','session_id':'x'},self.spool))

    def test_real_hook_process_pipeline(self):
        self.d.poll()
        for kind in ('UserPromptSubmit','Stop'):
            run=subprocess.run([sys.executable,'local_monitor/hook.py',str(self.spool)],
                input=json.dumps({'hook_event_name':kind,'session_id':'pipeline','cwd':'/test'}),
                capture_output=True,text=True)
            self.assertEqual(run.returncode,0);self.assertEqual(run.stdout,'')
        _,events=self.d.poll();self.assertEqual(len(events),1)
        self.assertEqual(events[0]['session_id'],'pipeline')

    def test_install_idempotent_and_remove_preserves_existing(self):
        settings=self.claude/'settings.json';original={'model':'keep','hooks':{'Stop':[{'hooks':[{'type':'command','command':'echo existing'}]}]}}
        settings.write_text(json.dumps(original));runtime=self.root/'runtime'
        backup=hooks(settings,runtime);self.assertEqual(json.loads(backup.read_text()),original)
        self.assertIsNone(hooks(settings,runtime))
        hooks(settings,runtime,remove=True);self.assertEqual(json.loads(settings.read_text()),original)

    def test_process_start_mismatch(self):
        def run(args,**kwargs):
            return subprocess.CompletedProcess(args,0,'Sun Oct 4 00:00:00 2026' if 'lstart=' in args else '/bin/claude','')
        with patch('local_monitor.detector.subprocess.run',side_effect=run):
            self.assertFalse(process_matches({'pid':5,'procStart':'different'}))
            self.assertTrue(process_matches({'pid':5,'procStart':'Sun Oct 4 00:00:00 2026'}))


if __name__=='__main__':unittest.main()
