"""Deterministic state parity fixtures; nothing written into production runtime."""
import json
from pathlib import Path
import subprocess
import sys
import tempfile

HERE=Path(__file__).resolve().parent
NOW=2000000000
START='Wed Oct 14 06:28:49 2026'

def main():
    binary=Path(sys.argv[1]).resolve();checks=0
    with tempfile.TemporaryDirectory(prefix='lm-rust-parity-') as temp:
        root=Path(temp);claude=root/'claude';runtime=root/'runtime'
        (claude/'sessions').mkdir(parents=True);(runtime/'hooks').mkdir(parents=True);(runtime/'antigravity-hooks').mkdir()
        processes=root/'processes.txt';processes.write_text(f'42 {START} /bin/claude\n43 {START} /bin/agy\n')
        def run():
            args=[str(claude),str(runtime),'--once','--now',str(NOW),'--processes',str(processes)]
            py=json.loads(subprocess.check_output([sys.executable,str(HERE/'python_probe.py'),*args],text=True))
            rust=json.loads(subprocess.check_output([str(binary),*args],text=True))
            assert py==rust,(py,rust)
        def clear():
            for folder in [claude/'sessions',runtime/'hooks',runtime/'antigravity-hooks']:
                for p in folder.glob('*.json'):p.unlink()
        def registry(**extra):
            r=dict(sessionId='claude-one',pid=42,procStart=START,cwd='/fixture/project',status='busy',updatedAt=NOW*1000);r.update(extra)
            (claude/'sessions/a.json').write_text(json.dumps(r))
        def hook(provider,index,event,**extra):
            r=dict(session_id=provider+'-one',cwd='/fixture/project',event=event,at=NOW-10+index);r.update(extra)
            (runtime/('hooks' if provider=='claude' else 'antigravity-hooks')/f'{index:03}.json').write_text(json.dumps(r))
        for record in [{},{'status':'idle'},{'pid':999999},{'procStart':'reused'},{'updatedAt':(NOW-601)*1000},{'updatedAt':(NOW+120)*1000}]:
            clear();registry(**record);run();checks+=1
        for stop,extra in [('Stop',{}),('Stop',{'background_active':True}),('StopFailure',{}),('PermissionRequest',{}),('SessionEnd',{}),('PostToolUse',{})]:
            clear();registry();hook('claude',1,'UserPromptSubmit');hook('claude',2,stop,**extra);run();checks+=1
        for reason,idle in [('NO_TOOL_CALL',True),('NO_TOOL_CALL',False),('ERROR',True),('USER_CANCELED',True),('MAX_INVOCATIONS',True),('UNKNOWN',True)]:
            clear();hook('antigravity',1,'PreInvocation');hook('antigravity',2,'Stop',termination_reason=reason,fully_idle=idle,has_error=False);run();checks+=1
        clear();hook('antigravity',1,'PreInvocation',pid=43,procStart=START);hook('antigravity',2,'Stop',termination_reason='NO_TOOL_CALL',fully_idle=True);hook('antigravity',3,'PreInvocation',pid=43,procStart=START);run();checks+=1
        clear();hook('antigravity',1,'PreInvocation',pid=999999,procStart=START);run();checks+=1
        clear();hook('antigravity',1,'PreInvocation',at=NOW-601);run();checks+=1
        print(json.dumps({'parity_cases_passed':checks}))

if __name__=='__main__':main()
