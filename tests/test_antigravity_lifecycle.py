import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from local_monitor.antigravity_lifecycle import Lifecycle, archived, annotation
from local_monitor.detector import Detector


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        tmp=tempfile.TemporaryDirectory();self.addCleanup(tmp.cleanup)
        self.base=Path(tmp.name);self.root=self.base/'antigravity'
        self.cli=self.base/'antigravity-cli';self.ledger=self.base/'runtime/antigravity-lifecycle.json'
        self.db=self.root/'conversations/task.db';self.ann=self.root/'annotations/task.pbtxt'
        self.db.parent.mkdir(parents=True);self.ann.parent.mkdir()
        self.life=Lifecycle(self.root,self.cli,self.ledger)

    def files(self, text='title:"Test"'):
        self.db.write_bytes(b'fixture');self.ann.write_text(text)

    def scan(self):
        return self.life.scan(['task'])[0]

    def test_title_metadata_rename_and_fallback(self):
        raw = 'title:' + json.dumps('한글 "제목" archived:true', ensure_ascii=False) + ' archived:false nested:{title:"ignore"}'
        self.assertEqual(annotation(raw), (False, '한글 "제목" archived:true'))
        self.files(raw);self.scan();self.assertEqual(self.life.titles['task'], '한글 "제목" archived:true')
        self.ann.write_text('title:"변경된 제목"');self.scan();self.assertEqual(self.life.titles['task'], '변경된 제목')
        for raw in ['title:"  "', 'archived:false', 'title:123', r'title:"bad\q"']:
            self.ann.write_text(raw);self.scan();self.assertNotIn('task', self.life.titles)
        self.ann.unlink();self.scan();self.assertNotIn('task',self.life.titles)

    def test_archive_restore_delete_restart(self):
        self.files();self.assertEqual(self.scan(),set())
        self.ann.write_text('title:"Test" archived:true');self.assertEqual(self.scan(),{'task'})
        self.ann.write_text('title:"Test" archived:false');self.assertEqual(self.scan(),set())
        self.db.unlink();self.ann.unlink()
        self.assertEqual(self.scan(),set());self.assertEqual(self.scan(),{'task'})
        self.life=Lifecycle(self.root,self.cli,self.ledger)
        self.assertEqual(self.scan(),{'task'})
        self.files();self.assertEqual(self.scan(),set())

    def test_initial_missing_partial_missing_and_replaced_directory(self):
        self.assertEqual(self.scan(),set());self.assertEqual(self.scan(),set())
        self.files();self.scan();self.ann.unlink()
        self.assertEqual(self.scan(),set());self.assertEqual(self.scan(),set())
        self.db.parent.rename(self.root/'old-conversations');self.db.parent.mkdir()
        self.assertEqual(self.scan(),set());self.assertEqual(self.scan(),set())

    def test_restart_preserves_presence_evidence(self):
        self.files();self.scan();self.db.unlink();self.ann.unlink()
        self.life=Lifecycle(self.root,self.cli,self.ledger)
        self.assertEqual(self.scan(),set());self.assertEqual(self.scan(),{'task'})

    def test_read_failure_preserves_last_confirmed_state(self):
        self.files('title:"x" archived:true');self.scan()
        with patch('local_monitor.antigravity_lifecycle.os.listdir',side_effect=PermissionError):
            excluded,errors=self.life.scan(['task'])
        self.assertEqual(excluded,{'task'});self.assertIn('antigravity_lifecycle_unavailable',errors)
        self.ann.write_text('archived:banana')
        excluded,errors=self.life.scan(['task'])
        self.assertEqual(excluded,{'task'});self.assertIn('antigravity_lifecycle_annotation_invalid',errors)

    def test_collision_never_excludes_cli_session(self):
        self.files('archived:true');(self.cli/'conversations').mkdir(parents=True)
        (self.cli/'conversations/task.db').write_bytes(b'')
        excluded,errors=self.life.scan(['task'])
        self.assertEqual(excluded,set());self.assertIn('antigravity_lifecycle_ambiguous',errors)

    def test_cli_only_is_normal_and_does_not_report_ambiguity(self):
        (self.cli/'conversations').mkdir(parents=True)
        (self.cli/'conversations/task.db').write_bytes(b'')
        self.assertEqual(self.life.scan(['task']),(set(),[]))

    def test_parser_quoted_nested_and_invalid_flags(self):
        for raw,flag in [('title:"archived:true"',False),('nested:{ archived:true }',False),('archived : true',True),('archived:false',False),('title:"escaped \\" archived:true"',False)]:
            self.assertEqual(archived(raw),flag,raw)
        for raw in ['', 'garbage', 'archived:no','archived:true archived:false','title:"unterminated','nested:{','}']:
            with self.assertRaises(ValueError,msg=raw):archived(raw)
        self.files('archived:true')
        self.assertEqual(self.life.scan(['../task'])[0],set())

    def test_failed_save_retries_without_a_state_change(self):
        self.files('archived:true')
        with patch('pathlib.Path.replace',side_effect=OSError):
            excluded,errors=self.life.scan(['task'])
        self.assertEqual(excluded,{'task'})
        self.assertIn('antigravity_lifecycle_save_failed',errors)
        self.scan();self.assertTrue(self.ledger.exists())

    def test_missing_observations_must_be_consecutive_successes(self):
        self.files();self.scan();self.db.unlink();self.ann.unlink();self.scan()
        with patch('local_monitor.antigravity_lifecycle.os.listdir',side_effect=PermissionError):self.scan()
        self.assertEqual(self.scan(),set());self.assertEqual(self.scan(),{'task'})

    def test_corrupt_ledger_does_not_prove_deletion(self):
        self.ledger.parent.mkdir();self.ledger.write_text('{')
        self.life=Lifecycle(self.root,self.cli,self.ledger)
        self.assertEqual(self.scan(),set())
        self.assertIn('antigravity_lifecycle_ledger_invalid',self.life.scan(['task'])[1])

    def test_detector_output_and_notification_filter_restores_original_completion(self):
        spool=self.base/'runtime/hooks';hooks=self.base/'runtime/antigravity-hooks';hooks.mkdir(parents=True)
        d=Detector(self.base/'codex',self.base/'claude',spool,now=lambda:1000,antigravity_home=self.root)
        d.poll();self.files()
        def event(n,kind,**kw):
            (hooks/f'{n}.json').write_text(json.dumps(dict(session_id='task',event=kind,at=1000,**kw)))
        event(1,'PreInvocation');d.poll()
        event(2,'Stop',termination_reason='NO_TOOL_CALL',fully_idle=True)
        snap,events=d.poll();self.assertEqual(snap['sessions'][0]['completed_at'],1000);self.assertEqual(len(events),1)
        self.assertEqual(snap['sessions'][0]['title'],'Test');self.assertEqual(events[0]['title'],'Test')
        self.assertEqual(snap['sessions'][0]['cwd'],'')
        self.ann.write_text('archived:true');self.assertEqual(d.poll()[0]['sessions'],[])
        event(3,'Stop',termination_reason='NO_TOOL_CALL',fully_idle=True);self.assertEqual(d.poll()[1],[])
        self.ann.write_text('archived:false');snap,events=d.poll()
        self.assertEqual(snap['sessions'][0]['completed_at'],1000);self.assertEqual(events,[])
        self.db.unlink();self.ann.unlink();d.poll();self.assertEqual(d.poll()[0]['sessions'],[])
