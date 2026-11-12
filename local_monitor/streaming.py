"""Shared summary cache and bounded SSE replay. Never collect upstream per client."""
import copy
import json
import threading
import time
from collections import deque


def summarize(state, *, copy_state=True):
    if copy_state:
        state=copy.deepcopy(state)
    for row in state['usage']:
        row.pop('checked_at',None)
        for w in row['windows']:
            if 'daily' in w:
                daily=w['daily']
                segments=daily.get('segments',[])
                if segments:
                    daily['gauge_used']=segments[-1].get('used')
                w['daily']={k:v for k,v in w['daily'].items() if k in ('status','used','recommended','available','partial','missing','storage_error','gauge_baseline','gauge_used')}
    return state


def frame(kind, payload, identifier=None):
    if kind in ('reset','patch','heartbeat'):
        payload=dict(payload,server_time=time.time())
    prefix=('id: '+identifier+'\n') if identifier else ''
    return (prefix+'event: '+kind+'\ndata: '+json.dumps(payload,ensure_ascii=False,separators=(',',':'))+'\n\n').encode()


class StreamHub:
    def __init__(self, store):
        self.store=store
        self.condition=threading.Condition()
        self.state=None
        self.revision=0
        self.history=deque(maxlen=256)
        self.stopped=False

    def refresh(self):
        new=summarize(self.store.read(copy_snapshot=False),copy_state=False)
        with self.condition:
            old=self.state
            patch={}
            if old is None:
                patch=new
            else:
                for key in ('usage','system','events','seq','collector_error','completion_window'):
                    if old[key]!=new[key]:patch[key]=new[key]
                if old.get('system_history')!=new.get('system_history'):
                    before={p['at']:p for p in old.get('system_history',[])}
                    points=new.get('system_history',[])
                    patch['system_history_change']={'upsert':[p for p in points if before.get(p['at'])!=p],
                                                    'after':points[0]['at'] if points else None,
                                                    'through':points[-1]['at'] if points else None}
                a=dict(old['snapshot']);b=dict(new['snapshot']);a.pop('at',None);b.pop('at',None)
                if a!=b:
                    key=lambda r:(r['provider'],r['session_id'])
                    previous={key(r):r for r in a['sessions']}
                    current={key(r):r for r in b['sessions']}
                    patch['session_changes']={
                        'upsert':[r for k,r in current.items() if previous.get(k)!=r],
                        'remove':[list(k) for k in previous if k not in current],
                        'at':new['snapshot']['at'],'errors':new['snapshot'].get('errors',[])}
                elif old['snapshot']['at']!=new['snapshot']['at']:patch['snapshot_at']=new['snapshot']['at']
            if patch:
                self.revision+=1
                self.state=new
                self.history.append((self.revision,patch))
                self.condition.notify_all()

    def identifier(self, revision=None):
        return self.store.instance+':'+str(self.revision if revision is None else revision)

    def snapshot(self):
        with self.condition:
            return dict(copy.deepcopy(self.state),stream_id=self.identifier())

    def messages(self, cursor):
        with self.condition:
            try:
                instance,revision=cursor.rsplit(':',1);revision=int(revision)
                valid=instance==self.store.instance and 0<=revision<=self.revision and (not self.history or revision>=self.history[0][0]-1)
            except (ValueError,AttributeError):valid=False
            if not valid:return [('reset',self.snapshot(),self.identifier())]
            return [('patch',copy.deepcopy(p),self.identifier(r)) for r,p in self.history if r>revision]

    def start(self, stop):
        self.refresh()
        def run():
            while not stop.wait(1):self.refresh()
            with self.condition:self.stopped=True;self.condition.notify_all()
        thread=threading.Thread(target=run,daemon=True);thread.start();return thread
