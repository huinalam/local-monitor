"""Neutral Antigravity lifecycle adapter; retain only task metadata."""
import argparse
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys
import time
import uuid

EVENTS=('SessionStart','PreInvocation','PostInvocation','PreToolUse','PostToolUse','Stop')
HOOK_NAME='local-monitor-task-detection'
ROOT=Path(__file__).resolve().parents[1]


def ancestor():
    """Find this hook's CLI owner without reading its command-line arguments."""
    pid=os.getppid()
    for _ in range(8):
        if pid<=1:break
        try:
            row=subprocess.check_output(['ps','-p',str(pid),'-o','ppid=,comm='],text=True,timeout=.5).strip().split(None,1)
            if len(row)!=2:break
            if Path(row[1]).name in ('agy','antigravity'):
                started=subprocess.check_output(['ps','-p',str(pid),'-o','lstart='],text=True,
                    env=dict(os.environ,TZ='UTC',LC_ALL='C'),timeout=.5).strip()
                return dict(pid=pid,procStart=started)
            pid=int(row[0])
        except (OSError,ValueError,subprocess.SubprocessError):break
    return {}


def capture(event,data,spool,owner=None):
    if os.environ.get('LOCAL_MONITOR_AGY_USAGE')=='1' or event not in EVENTS or not isinstance(data,dict):return None
    sid=data.get('conversationId')
    if not isinstance(sid,str) or not sid or len(sid)>200:return None
    paths=data.get('workspacePaths',[])
    cwd=paths[0][:4096] if isinstance(paths,list) and paths and isinstance(paths[0],str) else ''
    clean=dict(event=event,session_id=sid,cwd=cwd,at=time.time())
    for key in ('invocationNum','executionNum'):
        value=data.get(key)
        if isinstance(value,int) and not isinstance(value,bool) and value>=0:clean[key]=value
    if event=='Stop':
        reason=data.get('terminationReason')
        known={'NO_TOOL_CALL','MAX_INVOCATIONS','MAX_FORCED_INVOCATIONS','MAX_TOKEN_BUDGET_EXCEEDED',
               'ERROR','USER_CANCELED','TERMINAL_STEP_TYPE','TERMINAL_CUSTOM_HOOK','INJECTED_RESPONSE',
               'model_stop','error','user_canceled'}
        normalized=reason.removeprefix('EXECUTOR_TERMINATION_REASON_') if isinstance(reason,str) else ''
        clean['termination_reason']=normalized if normalized in known else 'UNKNOWN'
        clean['fully_idle']=data.get('fullyIdle') is True
        clean['has_error']=bool(data.get('error'))
    if owner:clean.update({k:owner[k] for k in ('pid','procStart') if k in owner})
    spool=Path(spool);spool.mkdir(parents=True,exist_ok=True,mode=0o700)
    path=spool/(str(time.time_ns()).zfill(20)+'-'+uuid.uuid4().hex+'.json');temp=path.with_suffix('.tmp')
    fd=os.open(temp,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f:json.dump(clean,f)
    temp.replace(path);return path


def definition(runtime):
    result={}
    for event in EVENTS:
        command=shlex.join([sys.executable,str(ROOT/'local_monitor/antigravity_hook.py'),
                           'capture','--event',event,'--runtime',str(runtime)])
        handler=dict(type='command',command=command,timeout=3)
        result[event]=([dict(matcher='*',hooks=[handler])] if event in ('PreToolUse','PostToolUse')
                       else [handler])
    return result


def install(settings,runtime,remove=False):
    from .__main__ import save
    before=settings.read_bytes() if settings.exists() else b'{}';data=json.loads(before)
    if not isinstance(data,dict):raise ValueError('Hooks configuration must be an object')
    expected=definition(runtime);current=data.get(HOOK_NAME)
    if current is not None and current!=expected:raise ValueError('Existing named hook differs; preserved')
    if remove:
        if current is None:return False
        del data[HOOK_NAME]
    else:
        if current==expected:return False
        data[HOOK_NAME]=expected
    backup=runtime/('antigravity-hooks-backup-'+str(time.time_ns())+'.json')
    save(backup,json.loads(before));save(settings,data);return True


def main():
    p=argparse.ArgumentParser();p.add_argument('action',choices=['capture','install','remove'])
    p.add_argument('--event',choices=EVENTS);p.add_argument('--runtime',type=Path,default=ROOT/'.runtime')
    p.add_argument('--settings',type=Path,default=Path.home()/'.gemini/config/hooks.json');a=p.parse_args()
    if a.action=='capture':
        try:
            if os.environ.get('LOCAL_MONITOR_AGY_USAGE')!='1':
                capture(a.event,json.loads(sys.stdin.read(2*1024*1024)),a.runtime/'antigravity-hooks',ancestor())
        except Exception:pass
        # This hook observes activity; PreToolUse requires an explicit decision.
        print(json.dumps({'decision':'allow'} if a.event=='PreToolUse' else {}))
    else:print(json.dumps({'changed':install(a.settings,a.runtime.resolve(),a.action=='remove')}))


if __name__=='__main__':main()
