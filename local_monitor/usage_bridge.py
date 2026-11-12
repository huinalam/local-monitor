"""Antigravity statusLine sink: retain only quota metadata, never raw input."""
import json
import os
import sys
import tempfile
import time
from pathlib import Path


def capture(payload, runtime):
    if __package__:
        from .usage import normalize
    else:
        from usage import normalize
    windows = normalize('antigravity', payload)
    if not windows:
        return
    # Whitelist fields and remove session/account/prompt metadata.
    quota = {w['id']: {'remaining_fraction': w['remaining_percent']/100,
                        'reset_time': w['resets_at']} for w in windows}
    runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, name = tempfile.mkstemp(prefix='.quota-', dir=runtime)
    try:
        with os.fdopen(fd, 'w') as f:
            json.dump({'observed_at': time.time(), 'quota': quota}, f)
        os.replace(name, runtime/'usage-antigravity.json')
    finally:
        if os.path.exists(name):
            os.unlink(name)


if __name__ == '__main__':
    try:
        capture(json.loads(sys.stdin.read(1024*1024)), Path(sys.argv[1]))
    except Exception:
        pass
    # stack_with_default preserves the native status line.
