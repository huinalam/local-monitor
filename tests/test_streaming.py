import copy
import unittest
import json
from unittest.mock import patch
from local_monitor.server import Store
from local_monitor.streaming import StreamHub,frame,summarize


class StreamingTests(unittest.TestCase):
    def test_frames_stamp_current_time_without_mutating_history(self):
        payload={'snapshot_at':100}
        for kind in ('patch','reset','heartbeat'):
            with patch('local_monitor.streaming.time.time',return_value=123.25):
                raw=frame(kind,payload,'example:1').decode()
            value=json.loads(next(line[6:] for line in raw.splitlines() if line.startswith('data: ')))
            self.assertEqual(value['server_time'],123.25)
            self.assertEqual(payload,{'snapshot_at':100})
    def setUp(self):
        self.store=Store();self.hub=StreamHub(self.store);self.hub.refresh()
    def test_domain_isolation_and_health(self):
        cursor=self.hub.identifier()
        self.store.system.value={'status':'loading','observed_at':None,'cpu_percent':12}
        self.hub.refresh()
        messages=self.hub.messages(cursor)
        self.assertEqual(set(messages[0][1]),{'system'})
        cursor=self.hub.identifier()
        self.store.publish({'at':10,'sessions':[],'errors':[]},[]);self.hub.refresh()
        self.assertEqual(self.hub.messages(cursor)[0][1]['snapshot_at'],10)
        self.assertIn('completion_window',self.hub.messages(cursor)[0][1])
        cursor=self.hub.identifier();self.hub.refresh();self.assertEqual(self.hub.messages(cursor),[])
    def test_replay_and_reset(self):
        cursor=self.hub.identifier()
        self.store.publish({'at':1,'sessions':[],'errors':[]},[{'title':'done'}]);self.hub.refresh()
        events=self.hub.messages(cursor);self.assertEqual(events[0][0],'patch')
        self.assertEqual(events[0][1]['seq'],1)
        self.assertEqual(self.hub.messages(events[-1][2]),[])
        self.assertEqual(self.hub.messages('old-instance:1')[0][0],'reset')
        for i in range(260):
            self.store.publish({'at':i+2,'sessions':[],'errors':[]},[]);self.hub.refresh()
        self.assertEqual(self.hub.messages(cursor)[0][0],'reset')
        self.assertLessEqual(len(self.hub.history),256)
    def test_summary_excludes_detail_without_mutation(self):
        state=self.store.read();state['usage'][0]['windows']=[{'daily':{'used':3,'segments':[{'baseline':40,'used':2}],'day_start':1,'status':'ok','gauge_baseline':40}}]
        result=summarize(state)
        self.assertEqual(result['usage'][0]['windows'][0]['daily'],{'used':3,'status':'ok','gauge_baseline':40,'gauge_used':2})
        self.assertIn('segments',state['usage'][0]['windows'][0]['daily'])
        self.assertIn(b'event: patch',frame('patch',{'system':{}},'abc:2'))

    def test_only_changed_sessions_are_sent(self):
        rows=[{'provider':'codex','session_id':str(i),'status':'running'} for i in range(60)]
        self.store.publish({'at':1,'sessions':rows,'errors':[]},[]);self.hub.refresh();cursor=self.hub.identifier()
        rows[3]['status']='completed'
        self.store.publish({'at':2,'sessions':rows,'errors':[]},[]);self.hub.refresh()
        patch=self.hub.messages(cursor)[0][1]
        self.assertEqual(len(patch['session_changes']['upsert']),1)
        self.assertNotIn('snapshot',patch)
        cursor=self.hub.identifier();rows.pop()
        self.store.publish({'at':3,'sessions':rows,'errors':[]},[]);self.hub.refresh()
        self.assertEqual(self.hub.messages(cursor)[0][1]['session_changes']['remove'],[['codex','59']])

    def test_history_delta_is_bounded_and_reset_contains_full_history(self):
        import time
        at=int(time.time()//10)*10
        point=lambda t:dict(at=t,cpu_percent=20,memory_percent=30,swap_used=0)
        self.store.system.history.extend(point(t) for t in range(at-1800,at,10))
        self.hub.refresh();cursor=self.hub.identifier()
        self.store.system.history.append(point(at))
        self.hub.refresh()
        patch=self.hub.messages(cursor)[0][1]
        self.assertNotIn('system_history',patch)
        self.assertEqual(patch['system_history_change']['upsert'],[point(at)])
        self.assertEqual(patch['system_history_change']['after'],at-1790)
        self.assertEqual(patch['system_history_change']['through'],at)
        reset=self.hub.messages('invalid')[0][1]
        self.assertEqual(len(reset['system_history']),180)
        self.assertLess(len(frame('patch',patch)),400)
        cursor=self.hub.identifier();self.store.system.history.clear();self.hub.refresh()
        self.assertIsNone(self.hub.messages(cursor)[0][1]['system_history_change']['after'])
