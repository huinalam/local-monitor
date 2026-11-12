"""Cached macOS host metrics; no per-process data."""
import ctypes
import math
import json
import logging
from collections import deque
import re
import subprocess
import threading
import time

logger=logging.getLogger(__name__)
if not logger.handlers:
    handler=logging.StreamHandler()
    formatter=logging.Formatter('%(asctime)sZ %(levelname)s %(message)s')
    formatter.converter=time.gmtime
    handler.setFormatter(formatter)
    logger.addHandler(handler)
logger.setLevel(logging.INFO)
logger.propagate=False


def command(*args):
    return subprocess.check_output(args, text=True, timeout=1, stderr=subprocess.DEVNULL)


def cpu_percent(previous, current):
    if previous is None:
        return None
    delta = [(b-a) % (2**32) for a,b in zip(previous,current)]
    return round(100*(sum(delta)-delta[2])/sum(delta),1) if sum(delta) else None


def memory_stats(text, total):
    size=int(re.search(r'page size of (\d+) bytes',text)[1])
    pages={k:int(v) for k,v in re.findall(r'^([^:\n]+):\s+(\d+)\.',text,re.M)}
    used=sum(pages[k] for k in ['Pages active','Pages inactive','Pages wired down','Pages occupied by compressor'])
    used-=pages['File-backed pages']+pages['Pages purgeable']
    used=max(0,min(total,used*size))
    return dict(memory_used=used,memory_total=total,memory_percent=round(used/total*100,1))


def swap_stats(text):
    def size(label):
        match=re.search(r'\b'+label+r'\s*=\s*([\d.]+)([KMG])\b',text)
        return float(match[1])*{'K':1024,'M':1024**2,'G':1024**3}[match[2]] if match else None
    return dict(swap_used=size('used'),swap_total=size('total'))


class SystemStats:
    def __init__(self):
        self.lock=threading.Lock()
        self.value=dict(status='loading',observed_at=None,cpu_percent=None)
        self.previous=None
        self.high_since=None
        self.history=deque(maxlen=180)
        self.bucket=None
        self.samples=[]
        self.last_error=None
        self.failures=0
        self.last_log=None

    def failed(self, stage, error):
        now=time.time()
        reason=('timeout' if isinstance(error,subprocess.TimeoutExpired) else
                'command_failed' if isinstance(error,subprocess.CalledProcessError) else
                'unavailable' if isinstance(error,(OSError,RuntimeError)) else 'invalid_data')
        diagnostic=dict(at=now,stage=stage,reason=reason,type=type(error).__name__)
        with self.lock:
            previous=self.last_error
            self.last_error=diagnostic
            self.failures+=1
            self.value=dict(self.value,status='unavailable',last_error=dict(diagnostic),consecutive_failures=self.failures)
            changed=previous is None or any(previous[k]!=diagnostic[k] for k in ('stage','reason','type'))
            log=self.failures==1 or changed or self.last_log is None or now-self.last_log>=60 or now<self.last_log
            if log:self.last_log=now
            count=self.failures
        if log:logger.warning('system_stats %s',json.dumps(dict(event='failure',**diagnostic,consecutive_failures=count)))

    def succeeded(self, value):
        with self.lock:
            failures=self.failures
            self.failures=0
            self.value=dict(value,last_error=dict(self.last_error) if self.last_error else None,consecutive_failures=0)
            self.record(value)
        if failures:logger.info('system_stats %s',json.dumps(dict(event='recovery',at=value['observed_at'],previous_failures=failures)))

    def record(self, value):
        """Called under lock; closed 10-second averages, bounded to 30 minutes."""
        at=int(value['observed_at']//10)*10
        if self.bucket is not None and at<self.bucket:
            self.history.clear();self.samples=[];self.bucket=None
        if self.bucket is not None and at!=self.bucket:
            point={'at':self.bucket}
            for key in ('cpu_percent','memory_percent','swap_used'):
                values=[s[key] for s in self.samples if isinstance(s.get(key),(int,float)) and math.isfinite(s[key])]
                point[key]=sum(values)/len(values) if values else None
            self.history.append(point);self.samples=[]
        self.bucket=at
        self.samples.append(value)
        while self.history and self.history[0]['at']<at-1800:self.history.popleft()

    def sample(self):
        stage='cpu'
        try:
            lib=ctypes.CDLL('/usr/lib/libSystem.B.dylib')
            lib.mach_host_self.restype=ctypes.c_uint
            ticks=(ctypes.c_uint*4)();count=ctypes.c_uint(4)
            host=lib.mach_host_self()
            try:
                if lib.host_statistics(host,3,ctypes.byref(ticks),ctypes.byref(count))!=0:
                    raise RuntimeError('cpu unavailable')
            finally:
                task=ctypes.c_uint.in_dll(lib,'mach_task_self_').value
                lib.mach_port_deallocate(task,host)
            cpu=cpu_percent(self.previous,list(ticks));self.previous=list(ticks)
            stage='memory_total'
            total=int(command('/usr/sbin/sysctl','-n','hw.memsize'))
            stage='memory'
            mem=memory_stats(command('/usr/bin/vm_stat'),total)
            stage='memory_pressure'
            pressure=int(command('/usr/sbin/sysctl','-n','kern.memorystatus_vm_pressure_level'))
            stage='swap'
            swap=swap_stats(command('/usr/sbin/sysctl','-n','vm.swapusage'))
            if swap['swap_used'] is None or swap['swap_total'] is None:raise ValueError('invalid swap data')
            now=time.time()
            self.high_since=(self.high_since or now) if cpu is not None and cpu>=85 else None
            value=dict(status='ok',observed_at=now,cpu_percent=cpu,cpu_high=self.high_since is not None and now-self.high_since>=10,
                       memory_pressure={1:'normal',2:'warning',4:'critical'}.get(pressure,'unknown'),**swap,**mem)
            self.succeeded(value)
        except Exception as error:
            self.failed(stage,error)

    def read(self):
        with self.lock:result=dict(self.value)
        if result.get('last_error'):result['last_error']=dict(result['last_error'])
        if result['observed_at'] and time.time()-result['observed_at']>30:result['status']='unavailable'
        return result

    def read_history(self):
        with self.lock:
            cutoff=int(time.time()//10)*10-1800
            return [dict(p) for p in self.history if p['at']>=cutoff]

    def start(self, stop):
        def run():
            while not stop.is_set():
                self.sample();stop.wait(10)
        thread=threading.Thread(target=run,daemon=True);thread.start();return thread
