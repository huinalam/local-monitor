#!/usr/bin/env python3
"""Back up and repair adjacent reset-jitter segments with the collector stopped."""
import argparse
import fcntl
import json
import os
import sys
import time
import uuid
from pathlib import Path

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from local_monitor.daily_usage import DailyUsage


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--runtime',type=Path,default=Path(__file__).resolve().parents[1]/'.runtime')
    parser.add_argument('--apply',action='store_true')
    args=parser.parse_args()
    path=args.runtime/'daily-usage.json'
    if not path.exists():parser.error('daily ledger not found')
    # Do not race a running collector, even when invoked outside the documented flow.
    with (args.runtime/'monitor.lock').open('a') as lock:
        try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:parser.error('stop the monitor collector before repair')
        ledger=DailyUsage(path)
        if ledger.storage_error:parser.error('ledger validation failed; original retained')
        count=ledger.repair_jitter()
        result={'merged_segments':count,'applied':False}
        if args.apply and count:
            folder=args.runtime/'backups';folder.mkdir(mode=0o700,exist_ok=True)
            backup=folder/('daily-usage-'+time.strftime('%Y%m%d-%H%M%S')+'-'+uuid.uuid4().hex[:8]+'.json')
            with os.fdopen(os.open(backup,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as f:
                f.write(path.read_bytes());f.flush();os.fsync(f.fileno())
            ledger.save()
            if ledger.storage_error:raise RuntimeError('repair save failed; backup preserved')
            result.update(applied=True,backup=str(backup.resolve()))
        # Report service totals, without account identifiers.
        result['records']=[{'provider':json.loads(key)[0],'window':json.loads(key)[2],
                            'segments':len(r['segments']),
                            'used':sum(s['used'] for s in r['segments']),
                            'budget':sum(s['budget'] for s in r['segments']) if all(s['budget'] is not None for s in r['segments']) else None}
                           for key,r in ledger.records.items()]
        print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__=='__main__':main()
