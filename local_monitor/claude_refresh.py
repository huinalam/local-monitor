"""Bounded Claude CLI OAuth refresh; no credential values are read or logged."""
import fcntl
import json
import math
import os
import subprocess
import tempfile
import threading
import time
from pathlib import Path

COOLDOWN = 3600


class ClaudeRefresh:
    def __init__(self, runtime, home):
        self.runtime, self.home = Path(runtime), Path(home)
        self.path = self.runtime/'claude-refresh.json'
        self.lock = threading.Lock()
        self.storage_failed = False
        self.state = self.load()

    def load(self):
        try:
            value=json.loads(self.path.read_text())
            if (not isinstance(value,dict) or not isinstance(value.get('next_at'),(int,float))
                    or isinstance(value['next_at'],bool) or not math.isfinite(value['next_at'])):
                raise ValueError('invalid state')
            if value.get('status')=='running':value['status']='interrupted'
            return value
        except FileNotFoundError:
            return dict(status='waiting',next_at=0)
        except (OSError,ValueError):
            return dict(status='storage_error',next_at=None)

    def save(self):
        name=None
        try:
            fd,name=tempfile.mkstemp(prefix='.refresh-',dir=self.runtime)
            with os.fdopen(fd,'w') as f:
                json.dump(self.state,f);f.flush();os.fsync(f.fileno())
            os.replace(name,self.path)
        finally:
            if name and os.path.exists(name):os.unlink(name)

    def attempt(self, publish):
        if self.storage_failed:
            publish(dict(status='storage_error',next_at=None));return False
        if os.environ.get('LM_CLAUDE_AUTO_REFRESH')=='0':
            publish(dict(status='disabled',next_at=None));return False
        if not self.lock.acquire(blocking=False):return False
        try:
            self.runtime.mkdir(parents=True,exist_ok=True,mode=0o700)
            with (self.runtime/'claude-refresh.lock').open('a') as lock:
                try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
                except BlockingIOError:return False
                self.state=self.load()
                if self.state['next_at'] is None or time.time()<self.state['next_at']:
                    publish(dict(self.state));return False
                self.state=dict(status='running',attempted_at=time.time(),next_at=time.time()+COOLDOWN)
                # Persist before execution: restart cannot bypass the cooldown.
                try:self.save()
                except OSError:
                    self.storage_failed=True
                    self.state=dict(status='storage_error',next_at=None);publish(dict(self.state));return False
                publish(dict(self.state))
                env={k:v for k,v in os.environ.items() if not k.startswith(('ANTHROPIC_','CLAUDE_CODE_','CLAUDE_CONFIG_DIR','CLAUDECODE'))}
                if self.home != Path.home()/'.claude':
                    env['CLAUDE_CONFIG_DIR']=str(self.home)
                cmd=['claude','--safe-mode','-p','Reply with exactly OK. Do not use tools.',
                     '--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}',
                     '--no-session-persistence','--output-format','json','--model','haiku',
                     '--effort','low','--system-prompt','Reply only to the user message.']
                try:
                    with tempfile.TemporaryDirectory(prefix='lm-auth-refresh-') as cwd:
                        result=subprocess.run(cmd,cwd=cwd,env=env,stdin=subprocess.DEVNULL,
                                              stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=55)
                    self.state['status']='completed' if result.returncode==0 else 'failed'
                except subprocess.TimeoutExpired:self.state['status']='timeout'
                except OSError:self.state['status']='unavailable'
                try:self.save()
                except OSError:self.state['status']='storage_error'
                publish(dict(self.state));return True
        except OSError:
            self.storage_failed=True
            publish(dict(status='storage_error',next_at=None));return False
        finally:self.lock.release()
