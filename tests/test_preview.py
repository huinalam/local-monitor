import json
import unittest
from local_monitor.preview import Preview
import test_detector


class PreviewTests(unittest.TestCase):
    def test_assistant_only_bounded_reset(self):
        p=Preview()
        p.codex({'type':'response_item','payload':{'type':'message','role':'user','content':[{'type':'text','text':'SECRET'}]}})
        self.assertIsNone(p.output())
        p.codex({'type':'event_msg','payload':{'type':'agent_message','message':'가'*9000}})
        self.assertEqual(len(p.output()['text']),8000)
        self.assertTrue(p.output()['truncated'])
        p.codex({'type':'event_msg','payload':{'type':'task_started'}})
        self.assertIsNone(p.output())

    def test_question_matching_result_and_malformed(self):
        p=Preview()
        item={'type':'response_item','payload':{'type':'function_call','name':'functions.request_user_input','call_id':'q','arguments':json.dumps({'questions':[{'question':'Which?', 'options':[{'label':'A'}]}]})}}
        self.assertEqual(p.codex(item),'waiting_input')
        self.assertEqual(p.output()['questions'][0]['options'][0]['label'],'A')
        self.assertIsNone(p.codex({'type':'response_item','payload':{'type':'function_call_output','call_id':'other','output':'SECRET'}}))
        self.assertEqual(p.codex({'type':'response_item','payload':{'type':'function_call_output','call_id':'q','output':'SECRET'}}),'running')
        self.assertIsNone(p.output())
        for args in ('{','null','42','{"questions":[null,3]}'):
            item['payload']['arguments']=args
            p.codex(item)
        p.claude({'type':'user','message':{'content':42}})

    def test_claude_text_question_and_answer(self):
        p=Preview()
        p.claude({'type':'assistant','message':{'content':[{'type':'thinking','thinking':'SECRET'},{'type':'text','text':'Ready'},{'type':'tool_use','name':'AskUserQuestion','input':{'questions':[{'question':'Next?', 'options':[{'label':'Review'}]}]}}]}})
        self.assertEqual(p.output()['text'],'Ready')
        self.assertEqual(p.output()['questions'][0]['question'],'Next?')
        p.claude({'type':'user','message':{'content':[{'type':'tool_result','content':'SECRET'}]}})
        self.assertIsNone(p.output())


class PreviewIntegrationTests(unittest.TestCase):
    setUp = test_detector.DetectorTests.setUp
    event = test_detector.DetectorTests.event
    hook = test_detector.DetectorTests.hook
    registry = test_detector.DetectorTests.registry
    def test_preview_completion_and_new_turn(self):
        self.event('task_started')
        self.d.poll()
        with self.log.open('a') as f:
            f.write(json.dumps({'timestamp':'1970-01-01T00:16:41Z','type':'event_msg','payload':{'type':'task_complete','turn_id':'t1','last_agent_message':'Finished'}})+'\n')
        snapshot,_=self.d.poll()
        self.assertEqual(snapshot['sessions'][0]['preview']['text'],'Finished')
        self.event('task_started','t2',1002)
        snapshot,_=self.d.poll()
        self.assertNotIn('preview',snapshot['sessions'][0])

    def test_claude_transcript_and_missing_source(self):
        self.registry();self.hook('Stop')
        # Registry fixture uses /project and session c1.
        registry=json.loads(next((self.claude/'sessions').glob('*.json')).read_text())
        sid=registry['sessionId'];cwd=registry['cwd']
        project=''.join(c if c.isascii() and c.isalnum() else '-' for c in cwd)
        path=self.claude/'projects'/project/(sid+'.jsonl');path.parent.mkdir(parents=True)
        path.write_text(json.dumps({'type':'assistant','message':{'content':[{'type':'text','text':'Claude result'}]}})+'\n')
        snapshot,_=self.d.poll()
        row=next(r for r in snapshot['sessions'] if r['provider']=='claude')
        self.assertEqual(row['preview']['text'],'Claude result')
        path.unlink();snapshot,_=self.d.poll()
        self.assertNotIn('preview',next(r for r in snapshot['sessions'] if r['provider']=='claude'))

    def test_new_claude_prompt_does_not_rehydrate_previous_answer(self):
        self.registry();self.hook('UserPromptSubmit')
        path=self.claude/'projects/-project/c1.jsonl';path.parent.mkdir(parents=True)
        path.write_text(json.dumps({'timestamp':'1970-01-01T00:16:39Z','type':'assistant','message':{'content':[{'type':'text','text':'Old result'}]}})+'\n')
        snapshot,_=self.d.poll()
        self.assertNotIn('preview',next(r for r in snapshot['sessions'] if r['provider']=='claude'))
        with path.open('a') as f:
            f.write(json.dumps({'timestamp':'1970-01-01T00:16:41Z','type':'assistant','message':{'content':[{'type':'text','text':'New result'}]}})+'\n')
        snapshot,_=self.d.poll()
        self.assertEqual(next(r for r in snapshot['sessions'] if r['provider']=='claude')['preview']['text'],'New result')

    def test_transient_missing_same_inode_recovers_without_new_bytes(self):
        self.registry();self.hook('Stop')
        path=self.claude/'projects/-project/c1.jsonl';path.parent.mkdir(parents=True)
        path.write_text(json.dumps({'type':'assistant','message':{'content':[{'type':'text','text':'Recovered'}]}})+'\n')
        self.d.poll()
        parked=path.with_suffix('.parked');path.rename(parked)
        snapshot,_=self.d.poll()
        self.assertNotIn('preview',next(r for r in snapshot['sessions'] if r['provider']=='claude'))
        parked.rename(path)
        snapshot,_=self.d.poll()
        self.assertEqual(next(r for r in snapshot['sessions'] if r['provider']=='claude')['preview']['text'],'Recovered')

    def test_stop_rereads_consumed_transcript(self):
        self.registry()
        path=self.claude/'projects/-project/c1.jsonl';path.parent.mkdir(parents=True)
        path.write_text(json.dumps({'type':'assistant','message':{'content':[{'type':'text','text':'Final'}]}})+'\n')
        self.d.poll();self.d.previews['claude:c1'].clear()
        self.hook('Stop');snapshot,_=self.d.poll()
        self.assertEqual(next(r for r in snapshot['sessions'] if r['provider']=='claude')['preview']['text'],'Final')

    def test_empty_completion_retries_same_length_rewrite_after_interval(self):
        self.registry();self.hook('Stop')
        path=self.claude/'projects/-project/c1.jsonl';path.parent.mkdir(parents=True)
        original=json.dumps({'type':'ignoredxx','message':{'content':[{'type':'text','text':'Delayed'}]}})+'\n'
        path.write_text(original);self.d.poll()
        path.write_text(original.replace('ignoredxx','assistant'))
        self.clock+=5;snapshot,_=self.d.poll()
        self.assertNotIn('preview',next(r for r in snapshot['sessions'] if r['provider']=='claude'))
        self.clock+=30;snapshot,_=self.d.poll()
        self.assertEqual(next(r for r in snapshot['sessions'] if r['provider']=='claude')['preview']['text'],'Delayed')
