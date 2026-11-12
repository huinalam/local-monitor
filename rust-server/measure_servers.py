"""Read-only 60s server CPU/RSS sampler; includes sampled descendant RSS."""
import argparse
import json
from pathlib import Path
import subprocess
import time

p=argparse.ArgumentParser();p.add_argument('ports',nargs='+',type=int);p.add_argument('--seconds',type=int,default=60);p.add_argument('--output',type=Path,required=True);a=p.parse_args()
roots={}
for port in a.ports:
    pids={int(s[1:]) for s in subprocess.check_output(['lsof','-nP',f'-iTCP:{port}','-sTCP:LISTEN','-Fp'],text=True).splitlines() if s.startswith('p')}
    if len(pids)!=1:raise RuntimeError('Expected one server listener')
    roots[str(port)]=pids.pop()
def sample():
    processes={}
    for line in subprocess.check_output(['ps','-axo','pid=,ppid=,time=,rss='],text=True).splitlines():
        pid,parent,cpu,rss=line.split();parts=cpu.split(':');seconds=sum(float(v)*60**i for i,v in enumerate(reversed(parts)))
        processes[int(pid)]=(int(parent),seconds,int(rss)/1024)
    result={}
    for name,pid in roots.items():
        parent,cpu,rss=processes[pid];family={pid}
        while True:
            new={p for p,(pp,_,_) in processes.items() if pp in family};expanded=family|new
            if expanded==family:break
            family=expanded
        result[name]={'cpu_seconds':cpu,'rss_mib':rss,'family_rss_mib':sum(processes[p][2] for p in family),'descendants':len(family)-1}
    return result
start=time.monotonic();rows=[{'seconds':0,'processes':sample()}]
for n in range(1,a.seconds+1):
    time.sleep(max(0,start+n-time.monotonic()));rows.append({'seconds':time.monotonic()-start,'processes':sample()})
    if n%20==0:print(json.dumps({'measured_seconds':n}),flush=True)
summary={}
for name,pid in roots.items():
    points=[r['processes'][name] for r in rows];elapsed=rows[-1]['seconds'];summary[name]={'pid':pid,'seconds':round(elapsed,3),'cpu_one_core_percent':round((points[-1]['cpu_seconds']-points[0]['cpu_seconds'])/elapsed*100,4),'rss_mean_mib':round(sum(p['rss_mib'] for p in points)/len(points),3),'rss_peak_mib':round(max(p['rss_mib'] for p in points),3),'sampled_family_rss_mean_mib':round(sum(p['family_rss_mib'] for p in points)/len(points),3),'sampled_family_rss_peak_mib':round(max(p['family_rss_mib'] for p in points),3),'peak_descendant_count':max(p['descendants'] for p in points)}
a.output.parent.mkdir(parents=True,exist_ok=True);a.output.write_text(json.dumps({'summary':summary,'samples':rows,'notes':'parent CPU excludes child CPU; 1s descendant RSS samples may miss shorter processes'},indent=2));print(json.dumps(summary),flush=True)
