"""Install/remove the Antigravity quota bridge, preserving unrelated settings."""
import json
import shlex
import sys
from pathlib import Path
from .__main__ import ROOT, save


def setup(runtime, settings, remove=False):
    data = json.loads(settings.read_text()) if settings.exists() else {}
    command = shlex.join([sys.executable, str(ROOT/'local_monitor/usage_bridge.py'), str(runtime)])
    current = data.get('statusLine')
    backup = runtime/'antigravity-statusline-backup.json'
    ours = isinstance(current, dict) and current.get('command') == command
    if remove:
        if not ours:
            return False
        original = json.loads(backup.read_text())
        if original['present']:
            data['statusLine'] = original['value']
        else:
            data.pop('statusLine', None)
    else:
        if ours:
            return False
        if isinstance(current, dict) and current.get('command'):
            raise ValueError('An existing statusLine command must be integrated manually; preserved unchanged')
        save(backup, {'present': 'statusLine' in data, 'value': current})
        data['statusLine'] = dict(current or {}, type='command', command=command, enabled=True, stack_with_default=True)
    save(settings, data)
    return True


if __name__ == '__main__':
    import argparse
    p=argparse.ArgumentParser()
    p.add_argument('action',choices=['install','remove'])
    p.add_argument('--runtime',type=Path,default=ROOT/'.runtime')
    p.add_argument('--settings',type=Path,default=Path.home()/'.gemini/antigravity-cli/settings.json')
    a=p.parse_args()
    print(json.dumps({'changed':setup(a.runtime.resolve(),a.settings,a.action=='remove')}))
