import json
import tempfile
import unittest
from pathlib import Path
from local_monitor.preview_summary import apply_summaries

class SummaryTest(unittest.TestCase):
    def test_source_and_status_bound_cache(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)/'cache.json'
            row = dict(provider='codex', session_id='one', status='completed', preview=dict(text='result'))
            entry = dict(provider='codex', session_id='one', source=dict(status='completed', preview=dict(text='result')), created_at=1000, lines=['핵심 완료', '원문 확인'])
            cache = dict(schema=1, version=3, model='gpt-6-luna', entries=[entry])
            p.write_text(json.dumps(cache))
            snapshot = dict(sessions=[dict(row)])
            apply_summaries(snapshot, p, 1001)
            self.assertEqual(snapshot['sessions'][0]['preview_summary']['lines'], entry['lines'])
            for r in [dict(row, status='running'), dict(row, preview=dict(text='new'))]:
                snapshot = dict(sessions=[r]); apply_summaries(snapshot, p, 1001)
                self.assertNotIn('preview_summary', r)
            snapshot = dict(sessions=[dict(row)]); apply_summaries(snapshot, p, 90000)
            self.assertNotIn('preview_summary', snapshot['sessions'][0])
            entry['lines']=['bad\nline', 'okay']; p.write_text(json.dumps(cache))
            apply_summaries(snapshot, p, 1001)
            self.assertNotIn('preview_summary', snapshot['sessions'][0])
            entry['failed']=True; p.write_text(json.dumps(cache)); apply_summaries(snapshot, p, 1001)
            self.assertEqual(snapshot['sessions'][0].pop('preview_summary')['status'], 'failed')
            snapshot['sessions'][0]['preview']={'text':'changed'}; apply_summaries(snapshot,p,1001)
            self.assertNotIn('preview_summary',snapshot['sessions'][0])
            p.write_text('broken'); apply_summaries(snapshot, p, 1001)
            self.assertNotIn('preview_summary', snapshot['sessions'][0])
