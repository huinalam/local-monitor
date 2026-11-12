import json
from pathlib import Path
import unittest
from unittest.mock import patch
from local_monitor.completion_window import CompletionWindow
from local_monitor.server import Store
from local_monitor.streaming import StreamHub


def event(i, at=1000):
    return dict(id=f'x:{i}', provider='codex', session_id='same', turn_id=str(i), at=at)


class CompletionTests(unittest.TestCase):
    def test_shared_contract(self):
        w = CompletionWindow()
        for step in json.loads((Path(__file__).parent/'fixtures/completion-window.json').read_text()):
            result = w.update(step['now'], step['mono'], step.get('events', []), healthy=step.get('healthy', True))
            self.assertEqual(len(result['entries']), step['count'])
            self.assertEqual(result['partial'], step['partial'])
            if 'reason' in step: self.assertIn(step['reason'], result['reasons'])
            if 'coverage' in step: self.assertEqual(result['coverage_since'], step['coverage'])

    def test_full_coverage_and_exact_expiry(self):
        w=CompletionWindow()
        for t in range(1000,2801,5): r=w.update(t,t,[event(1,1001)] if t==1005 else [])
        self.assertFalse(r['partial'])
        self.assertEqual(len(r['entries']),1)
        self.assertEqual(len(w.update(2801,2801)['entries']),0)
        self.assertEqual(len(w.update(2802,2802,[event(1,1001)])['entries']),0)

    def test_bounds_and_quality(self):
        w=CompletionWindow()
        r=w.update(1000,0,[event(i) for i in range(10001)])
        self.assertEqual(len(r['entries']),10000)
        self.assertIn('capacity',r['reasons'])
        self.assertEqual(r['entries'][0]['id'],'x:1')
        r=w.update(1005,5,[event(1,1003),event('invalid',float('nan'))],source_error=True)
        self.assertEqual(r['entries'][0]['at'],1000)
        self.assertIn('invalid_event',r['reasons'])
        self.assertIn('source_error',r['reasons'])
        self.assertIsNone(r['coverage_since'])

    def test_store_and_sse_independent_of_notification_cap(self):
        store=Store();hub=StreamHub(store);hub.refresh();cursor=hub.identifier()
        with patch('local_monitor.server.time.time',return_value=1000), patch('local_monitor.server.time.monotonic',return_value=0):
            store.publish(dict(at=1000,sessions=[],errors=[]),[event(i) for i in range(201)])
        hub.refresh();r=store.read()
        self.assertEqual(len(r['events']),200)
        self.assertEqual(len(r['completion_window']['entries']),201)
        self.assertIn('completion_window',hub.messages(cursor)[0][1])
        r['completion_window']['entries'].clear()
        self.assertEqual(len(store.read()['completion_window']['entries']),201)
        with patch('local_monitor.server.time.time',return_value=2800), patch('local_monitor.server.time.monotonic',return_value=1800):
            store.publish(dict(at=2800,sessions=[],errors=[]),[])
        hub.refresh()
        self.assertEqual(hub.snapshot()['completion_window']['entries'],[])
