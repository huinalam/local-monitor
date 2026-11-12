"""Bounded assistant-only excerpts. Never retain raw tool results or user input."""
import json


def questions(value):
    if not isinstance(value, list):
        return []
    result = []
    for q in value[:3]:
        if not isinstance(q, dict):
            continue
        title = q.get('question', q.get('title', ''))
        if not isinstance(title, str) or not title.strip():
            continue
        options = []
        for o in (q.get('options') if isinstance(q.get('options'), list) else [])[:6]:
            if isinstance(o, str):
                o = {'label': o}
            if isinstance(o, dict) and isinstance(o.get('label'), str):
                options.append({'label': o['label'][:200], 'description': (o.get('description', '') if isinstance(o.get('description', ''), str) else '')[:500]})
        result.append({'question': title[:1000], 'options': options})
    return result


class Preview:
    def __init__(self):
        self.clear()

    def clear(self):
        self.text, self.questions, self.pending, self.truncated = '', [], None, False

    def message(self, value):
        if isinstance(value, str) and value.strip():
            self.text = value.strip()[:8000]
            self.truncated = len(value.strip()) > 8000
            self.questions, self.pending = [], None

    def output(self):
        if not self.text and not self.questions:
            return None
        return {'text': self.text, 'questions': self.questions, 'truncated': self.truncated}

    def codex(self, item):
        p = item.get('payload')
        if not isinstance(p, dict):
            return None
        kind = p.get('type')
        if item.get('type') == 'event_msg':
            if kind == 'task_started':
                self.clear()
            elif kind == 'agent_message':
                self.message(p.get('message'))
            elif kind == 'task_complete':
                self.message(p.get('last_agent_message'))
        elif item.get('type') == 'response_item':
            if kind == 'message' and p.get('role') == 'assistant':
                self.message('\n'.join(c['text'] for c in (p.get('content') if isinstance(p.get('content'), list) else [])
                                       if isinstance(c, dict) and c.get('type') in ('output_text', 'text') and isinstance(c.get('text'), str)))
            elif kind == 'function_call' and str(p.get('name', '')).split('.')[-1] in ('request_user_input', 'request_user_input_async'):
                try:
                    args = json.loads(p.get('arguments', '{}'))
                except (ValueError, TypeError):
                    return None
                qs = questions(args.get('questions')) if isinstance(args, dict) else []
                if qs:
                    self.clear(); self.questions = qs
                    if str(p.get('name')).split('.')[-1] == 'request_user_input' and isinstance(p.get('call_id'), str):
                        self.pending = p['call_id']
                        return 'waiting_input'
            elif kind == 'function_call_output' and self.pending and p.get('call_id') == self.pending:
                self.clear()
                return 'running'
        return None

    def claude(self, item):
        msg = item.get('message')
        if not isinstance(msg, dict):
            return
        content = msg.get('content', [])
        if item.get('type') == 'user':
            # New prompts or answers invalidate the previous assistant excerpt.
            if isinstance(content, str) or (isinstance(content, list) and any(isinstance(c, dict) and c.get('type') in ('text', 'tool_result') for c in content)):
                self.clear()
        elif item.get('type') == 'assistant' and isinstance(content, list):
            self.message('\n'.join(c['text'] for c in content if isinstance(c, dict) and c.get('type') == 'text' and isinstance(c.get('text'), str)))
            for c in content:
                if isinstance(c, dict) and c.get('type') == 'tool_use' and c.get('name') == 'AskUserQuestion' and isinstance(c.get('input'), dict):
                    qs = questions(c['input'].get('questions'))
                    if qs:
                        self.questions = qs
