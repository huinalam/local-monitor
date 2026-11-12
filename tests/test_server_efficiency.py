import unittest
from pathlib import Path
from unittest.mock import Mock
from local_monitor.server import Store, SnapshotPersistence
from local_monitor.streaming import StreamHub

class ServerEfficiencyTests(unittest.TestCase):
    def test_internal_reuse_external_isolation_and_history_stability(self):
        store=Store();snap={'at':1,'sessions':[{'provider':'codex','session_id':'one','status':'running'}],'errors':[]}
        store.publish(snap,[{'event':'test'}]);internal=store.read(copy_snapshot=False);old_sessions=internal['snapshot']['sessions']
        snap['sessions'][0]['status']='completed'
        self.assertEqual(old_sessions[0]['status'],'running')
        store.publish(dict(at=2,sessions=[dict(old_sessions[0])],errors=[]),[])
        self.assertIs(store.read(copy_snapshot=False)['snapshot']['sessions'],old_sessions)
        store.publish(snap,[{'event':'next'}])
        self.assertEqual(len(internal['events']),1);self.assertEqual(old_sessions[0]['status'],'running')
        external=store.read();external['snapshot']['sessions'].clear();external['events'].clear()
        self.assertEqual(len(store.read()['snapshot']['sessions']),1);self.assertEqual(len(store.read()['events']),2)

    def test_stream_old_snapshot_not_mutated_by_next_publish(self):
        store=Store();hub=StreamHub(store);store.publish({'at':1,'sessions':[],'errors':[]},[]);hub.refresh()
        old=hub.snapshot();store.publish({'at':2,'sessions':[{'provider':'claude','session_id':'a'}],'errors':[]},[{'event':'done'}]);hub.refresh()
        self.assertEqual(old['snapshot']['sessions'],[]);self.assertEqual(old['events'],[])

    def test_persistence_change_heartbeat_and_failed_write_retry(self):
        write=Mock();p=SnapshotPersistence(Path('unused'),write)
        snap={'at':1,'sessions':[],'errors':[]}
        p.save(snap,now=0);self.assertEqual(write.call_count,1)
        p.save(dict(snap,at=2),now=5);self.assertEqual(write.call_count,1)
        p.save(dict(snap,at=3),now=60);self.assertEqual(write.call_count,2)
        changed=dict(snap,sessions=[{'status':'running'}]);write.side_effect=OSError('failure')
        with self.assertRaises(OSError):p.save(changed,now=61)
        write.side_effect=None;p.save(changed,now=62);self.assertEqual(write.call_count,4)
        p.save(dict(changed,at=4),events=True,now=63);self.assertEqual(write.call_count,5)
