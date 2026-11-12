"""Concurrent parent CPU/RSS samples. Benchmark workers are read-only."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

HERE=Path(__file__).resolve().parent

def measure(binary,destination):
    home=Path.home();root=HERE.parents[1];runtime=root/'.runtime'
    args=[str(home/'.claude'),str(runtime),'--seconds','135','--interval','5']
    workers={}
    try:
        for name,command in [('rust',[str(Path(binary).resolve())]),('python_subset',[sys.executable,str(HERE/'python_probe.py')])]:
            proc=subprocess.Popen(['/usr/bin/time','-l',*command,*args],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
            ready=json.loads(proc.stdout.readline());workers[name]=(proc,ready['pid'])
        server=next(int(x[1:]) for x in subprocess.check_output(['lsof','-nP','-iTCP:3010','-sTCP:LISTEN','-Fp'],text=True).splitlines() if x.startswith('p'))
        pids={name:pid for name,(_,pid) in workers.items()};pids['python_full_server']=server
        def sample():
            result={}
            for line in subprocess.check_output(['ps','-p',','.join(map(str,pids.values())),'-o','pid=,time=,rss='],text=True).splitlines():
                pid,cpu,rss=line.split();parts=cpu.split(':');seconds=sum(float(x)*60**i for i,x in enumerate(reversed(parts)))
                result[int(pid)]={'cpu_seconds':seconds,'rss_mib':int(rss)/1024}
            return {name:result[pid] for name,pid in pids.items()}
        time.sleep(10);start=time.monotonic();samples=[{'seconds':0.,'processes':sample()}]
        for i in range(1,25):
            time.sleep(max(0,start+i*5-time.monotonic()));samples.append({'seconds':time.monotonic()-start,'processes':sample()})
            if i%4==0:print(json.dumps({'measured_seconds':round(time.monotonic()-start),'pids':pids}),flush=True)
        summary={}
        for name in pids:
            windows=[]
            for first,last in [(0,12),(12,24)]:
                seconds=samples[last]['seconds']-samples[first]['seconds'];a=samples[first]['processes'][name];b=samples[last]['processes'][name]
                rss=[s['processes'][name]['rss_mib'] for s in samples[first:last+1]]
                windows.append({'seconds':round(seconds,3),'cpu_one_core_percent':round((b['cpu_seconds']-a['cpu_seconds'])/seconds*100,4),'rss_mean_mib':round(sum(rss)/len(rss),3),'rss_peak_mib':round(max(rss),3)})
            summary[name]=windows
        worker_stats={}
        for name,(proc,pid) in workers.items():
            stdout,stderr=proc.communicate(timeout=15)
            if proc.returncode:raise RuntimeError(f'{name} exit {proc.returncode}')
            worker_stats[name]={'result':json.loads(stdout.strip()),'time_l':stderr.strip()}
        result={'interval_seconds':5,'warmup_seconds':10,'scope':'parent CPU excludes external ps; RSS sampled every5s; full server is different functionality','summary':summary,'worker_stats':worker_stats,'samples':samples}
        out=Path(destination);out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(result,indent=2));print(json.dumps({'summary':summary,'worker_results':{k:v['result'] for k,v in worker_stats.items()},'artifact':str(out.resolve())}),flush=True)
    finally:
        for proc,pid in workers.values():
            if proc.poll() is None:
                # Only terminate workers created by this script; never the server.
                try:os.kill(pid,15)
                except ProcessLookupError:pass
                proc.terminate();proc.wait(timeout=5)

if __name__=='__main__':measure(sys.argv[1],sys.argv[2])
