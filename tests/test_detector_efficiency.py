import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import subprocess
from local_monitor.detector import Detector


class EfficiencyTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name);self.spool=self.root/'hooks';self.spool.mkdir()
        self.d=Detector(self.root/'codex',self.root/'claude',self.spool)

    def test_unchanged_directory_skips_scan_and_new_atomic_event_is_found(self):
        (self.spool/'001.json').write_text('{}')
        real=os.scandir
        with patch('local_monitor.detector.os.scandir',wraps=real) as scan:
            self.assertEqual([p.name for p in self.d.hook_paths(self.spool)],['001.json'])
            self.d.seen_hooks.add('001.json')
            self.assertEqual(self.d.hook_paths(self.spool),[])
            self.assertEqual(scan.call_count,1)
            tmp=self.spool/'002.tmp';tmp.write_text('{}');tmp.rename(self.spool/'002.json')
            self.assertEqual([p.name for p in self.d.hook_paths(self.spool)],['002.json'])
            self.assertEqual(scan.call_count,2)

    def test_missing_then_created_directory_and_namespaced_spool(self):
        spool=self.root/'agy'
        self.assertEqual(self.d.hook_paths(spool,'antigravity:'),[])
        spool.mkdir();(spool/'001.json').write_text('{}')
        self.d.seen_hooks.add('001.json')
        self.assertEqual([p.name for p in self.d.hook_paths(spool,'antigravity:')],['001.json'])

    def test_process_snapshot_shared_and_refreshed_between_polls(self):
        record={'pid':42,'procStart':'Wed Oct 14 06:28:49 2026'}
        result=subprocess.CompletedProcess([],0,'42 Wed Oct 14 06:28:49 2026 /bin/claude\n43 Wed Oct 14 06:30:00 2026 /bin/agy\n','')
        with patch('local_monitor.detector.subprocess.run',return_value=result) as run:
            self.assertTrue(self.d.process_alive(record,'claude'))
            self.assertTrue(self.d.process_alive({'pid':43,'procStart':'Wed Oct 14 06:30:00 2026'},'antigravity'))
            self.assertFalse(self.d.process_alive(dict(record,procStart='different'),'claude'))
            self.assertEqual(run.call_count,1)
            self.d.poll()
            self.assertTrue(self.d.process_alive(record,'claude'))
            self.assertEqual(run.call_count,2)
            result.stdout='42 Wed Oct 14 07:28:49 2026 /bin/claude\n'
            self.d.poll()
            self.assertFalse(self.d.process_alive(record,'claude'))

    def test_process_snapshot_failure_and_wrong_executable_are_conservative(self):
        r={'pid':42,'procStart':'Wed Oct 14 06:28:49 2026'}
        with patch('local_monitor.detector.subprocess.run',side_effect=OSError()):
            self.assertFalse(self.d.process_alive(r,'claude'))
        self.d.poll()
        with patch('local_monitor.detector.subprocess.run',return_value=subprocess.CompletedProcess([],0,'42 Wed Oct 14 06:28:49 2026 /bin/bash\n','')):
            self.assertFalse(self.d.process_alive(r,'claude'))
