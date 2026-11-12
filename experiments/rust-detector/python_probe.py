"""Same-subset baseline using production detector code; no server or model calls."""
import argparse
import json
import os
from pathlib import Path
import sys
import time

sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from local_monitor.detector import Detector


def main():
    p=argparse.ArgumentParser();p.add_argument('claude_home',type=Path);p.add_argument('runtime',type=Path)
    p.add_argument('--once',action='store_true');p.add_argument('--seconds',type=float,default=0)
    p.add_argument('--interval',type=float,default=5);p.add_argument('--now',type=float)
    p.add_argument('--processes',type=Path);a=p.parse_args()
    class Subset(Detector):
        def codex(self,events):
            pass
        def process_alive(self,record,provider):
            if a.processes and self.process_table is None:
                self.process_table={}
                for line in a.processes.read_text().splitlines():
                    f=line.split(None,6)
                    if len(f)==7:self.process_table[int(f[0])]=(' '.join(f[1:6]),f[6])
            return super().process_alive(record,provider)
    d=Subset(Path('/nonexistent-codex-excluded'),a.claude_home,a.runtime/'hooks',
             now=(lambda:a.now) if a.now is not None else time.time)
    if not a.once:print(json.dumps({'pid':os.getpid()}),flush=True)
    start=time.monotonic();polls=0
    while True:
        snapshot,events=d.poll();polls+=1
        if a.once:
            keys=['provider','session_id','status','observed_at','turn_id','completed_at']
            rows=[{k:r[k] for k in keys if k in r} for r in snapshot['sessions']]
            rows.sort(key=lambda r:(r['provider'],r['session_id']))
            print(json.dumps(rows));return
        if time.monotonic()-start>=a.seconds:
            print(json.dumps({'polls':polls,'rows':len(snapshot['sessions']),'elapsed':time.monotonic()-start}));return
        time.sleep(a.interval)


if __name__=='__main__':main()
