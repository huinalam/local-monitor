import argparse
import fcntl
import json
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path
from .detector import Detector
from .hook import EVENTS

ROOT = Path(__file__).resolve().parent.parent


def save(path, data):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temp = path.with_suffix('.tmp')
    with temp.open('w') as f:
        os.chmod(temp, 0o600)
        json.dump(data, f, ensure_ascii=False, indent=2)
    temp.replace(path)


def hooks(settings, runtime, remove=False):
    before = settings.read_bytes() if settings.exists() else b'{}'
    data = json.loads(before)
    command = shlex.join([sys.executable, str(ROOT / 'local_monitor/hook.py'), str(runtime / 'hooks')])
    hook_map = data.setdefault('hooks', {})
    for event in EVENTS:
        groups = hook_map.get(event, [])
        kept = []
        for group in groups:
            group = dict(group)
            group['hooks'] = [h for h in group.get('hooks', []) if h.get('command') != command]
            if group['hooks']:
                kept.append(group)
        if not remove:
            kept.append({'hooks': [{'type': 'command', 'command': command, 'timeout': 3}]})
        if kept:
            hook_map[event] = kept
        else:
            hook_map.pop(event, None)
    if not hook_map:
        data.pop('hooks', None)
    if data == json.loads(before):
        return None
    backup = runtime / ('claude-settings-' + str(time.time_ns()) + '.json')
    backup.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    backup.write_bytes(before)
    backup.chmod(0o600)
    save(settings, data)
    return backup


def notify(event):
    # Values are argv, never interpolated as AppleScript or shell code.
    script = ('on run argv\n display notification (item 2 of argv) '
              'with title (item 1 of argv)\nend run')
    subprocess.run(['osascript', '-e', script, event['provider'] + ' 응답 완료', event['title']],
                   capture_output=True, timeout=5)


def main():
    p = argparse.ArgumentParser(description='Read-only Codex + Claude Code session detector')
    p.add_argument('command', choices=('serve', 'status', 'snapshot', 'watch', 'install-hooks', 'remove-hooks'))
    p.add_argument('--codex-home', type=Path, default=Path.home()/'.codex')
    p.add_argument('--claude-home', type=Path, default=Path.home()/'.claude')
    p.add_argument('--runtime', type=Path, default=ROOT/'.runtime')
    p.add_argument('--interval', type=float, default=5)
    p.add_argument('--seconds', type=float, default=0, help='0 watches until Ctrl-C')
    p.add_argument('--limit', type=int, default=100)
    p.add_argument('--port', type=int, default=3010)
    p.add_argument('--notify', action='store_true', help='Request macOS notifications for new completions')
    a = p.parse_args()
    if a.interval < 0.2 or a.limit < 1 or a.seconds < 0 or not 1024 <= a.port <= 65535:
        p.error('interval >= 0.2, limit >= 1, seconds >= 0, port 1024..65535 required')
    a.runtime = a.runtime.resolve()
    if a.command in ('install-hooks', 'remove-hooks'):
        backup = hooks(a.claude_home/'settings.json', a.runtime, a.command == 'remove-hooks')
        print(json.dumps({'changed': bool(backup), 'backup': str(backup) if backup else None}))
        return
    a.runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Prevent concurrent collectors from emitting duplicate events into the same runtime.
    lock = (a.runtime/'monitor.lock').open('w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        p.error('another detector is already using this runtime')
    d = Detector(a.codex_home, a.claude_home, a.runtime/'hooks', limit=a.limit)
    if a.command == 'serve':
        from .server import serve
        try:
            serve(d, a.runtime, port=a.port, interval=a.interval)
        finally:
            lock.close()
        return
    start = time.monotonic()
    first = True
    try:
        while True:
            snapshot, events = d.poll()
            save(a.runtime/'snapshot.json', snapshot)
            if first and a.command != 'status':
                print(json.dumps({'event': 'ready', 'sessions': len(snapshot['sessions']),
                                  'errors': snapshot['errors']}, ensure_ascii=False), flush=True)
                first = False
            for event in events:
                with (a.runtime/'events.jsonl').open('a') as f:
                    os.chmod(f.name, 0o600)
                    f.write(json.dumps(event, ensure_ascii=False)+'\n')
                print(json.dumps(event, ensure_ascii=False), flush=True)
                if a.notify:
                    try:
                        notify(event)
                    except (OSError, subprocess.SubprocessError):
                        print('{"event":"notification_delivery_failed"}', flush=True)
            if a.command == 'status':
                labels = {'running':'작업 중','completed':'응답 완료','idle':'대기','waiting_input':'입력 대기',
                          'background':'백그라운드 작업','failed':'실패','interrupted':'중단',
                          'unknown':'확인 불가','disconnected':'연결 종료'}
                for row in snapshot['sessions'][:20]:
                    print(f"{row['provider']:7} {labels.get(row['status'],row['status']):12} "
                          f"{row['title'][:55]} [{row['session_id'][:8]}]")
                if snapshot['errors']:
                    print('조회 오류: ' + ', '.join(snapshot['errors']))
                break
            if a.command == 'snapshot':
                print(json.dumps(snapshot, ensure_ascii=False, indent=2))
                break
            if a.seconds and time.monotonic()-start >= a.seconds:
                break
            time.sleep(a.interval)
    except KeyboardInterrupt:
        pass
    finally:
        lock.close()


if __name__ == '__main__':
    main()
