"""Claude command hook: accept stdin, persist minimal metadata, never block Claude."""
import json
import os
import sys
import time
import uuid
from pathlib import Path

EVENTS = ('SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd',
          'Notification', 'PermissionRequest', 'PreToolUse', 'PostToolUse')


def capture(data, spool):
    event = data.get('hook_event_name')
    sid = data.get('session_id')
    if event not in EVENTS or not isinstance(sid, str) or not sid or len(sid) > 200:
        return None
    clean = dict(event=event, session_id=sid, cwd=str(data.get('cwd', ''))[:4096], at=time.time())
    if isinstance(data.get('prompt_id'), str):
        clean['turn_id'] = data['prompt_id'][:200]
    if event == 'Notification':
        clean['notification_type'] = str(data.get('notification_type', ''))[:100]
    if event == 'Stop':
        clean['background_active'] = any(t.get('status') in ('running', 'pending')
                                        for t in data.get('background_tasks', []) if isinstance(t, dict))
        clean['stop_hook_active'] = data.get('stop_hook_active') is True
    spool = Path(spool)
    spool.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = spool / (str(time.time_ns()).zfill(20) + '-' + uuid.uuid4().hex + '.json')
    temp = path.with_suffix('.tmp')
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'w') as f:
        json.dump(clean, f)
    temp.replace(path)
    return path


if __name__ == '__main__':
    try:
        # Avoid unbounded input. No messages or credentials are persisted.
        capture(json.loads(sys.stdin.read(2 * 1024 * 1024)), sys.argv[1])
    except Exception:
        pass
    # No stdout or decisions: all configured hooks leave agent behavior unchanged.
