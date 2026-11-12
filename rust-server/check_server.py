"""Loopback integration checks against a running Rust QA server."""
import http.client
import json
import sys
import time
import uuid

PORT=int(sys.argv[1]) if len(sys.argv)>1 else 3011
checks=0

def request(path,method='GET',value=None,headers=None):
    conn=http.client.HTTPConnection('127.0.0.1',PORT,timeout=10)
    body=None if value is None else json.dumps(value).encode()
    h={'Content-Type':'application/json'} if body is not None else {}
    h.update(headers or {})
    conn.request(method,path,body,h);r=conn.getresponse();raw=r.read();status=r.status;response_headers={k.lower():v for k,v in r.getheaders()};conn.close()
    return status,raw,response_headers

def expect(condition):
    global checks
    assert condition
    checks+=1

def event(response):
    fields={}
    while True:
        raw=response.readline()
        if not raw:raise RuntimeError('SSE closed unexpectedly')
        line=raw.decode().strip()
        if not line:
            if fields:return fields
            continue
        if ':' in line:
            k,v=line.split(':',1);fields[k]=v.strip()

status,raw,headers=request('/health');expect(status==200 and json.loads(raw)['implementation']=='rust')
status,raw,headers=request('/');expect(status==200 and b'id="usage"' in raw and 'content-security-policy' in headers)
# Listener readiness precedes the first background history scan, as in Python.
deadline=time.monotonic()+15
while True:
    snapshot=json.loads(request('/api/state')[1])
    ready=snapshot['snapshot']['at']>time.time()-15 and not snapshot['collector_error'] and not snapshot['snapshot']['errors'] and snapshot['system']['status']=='ok'
    if ready or time.monotonic()>=deadline:break
    time.sleep(.2)
expect(ready);expect(not snapshot['snapshot']['errors'])
expect(set(['provider','session_id','status','cwd','title','observed_at'])<=set(snapshot['snapshot']['sessions'][0]))
for provider in ['codex','claude','antigravity']:
    row=json.loads(request('/api/usage/'+provider)[1]);expect(row['provider']==provider and isinstance(row['windows'],list))
expect(snapshot['system']['status']=='ok' and snapshot['system']['memory_total']>0)
expect(0<=snapshot['system']['memory_percent']<=100)
for path in ['/../.runtime/snapshot.json','/fonts/../../.runtime/snapshot.json','/%2e%2e/.runtime/auth.json','/api/usage/unknown']:
    expect(request(path)[0]==404)
expect(request('/health',headers={'Host':'evil.example'})[0]==403)
client=str(uuid.uuid4());entry=str(uuid.uuid4());payload={'version':1,'client_id':client,'records':[{'entry_id':entry,'event':'sample','at':time.time(),'prompt':'SECRET','url':'SECRET','online':True}]}
for _ in range(2):
    status,raw,_=request('/api/diagnostics','POST',payload);expect(status==200 and json.loads(raw)['ack']==[entry])
result=json.loads(request('/api/diagnostics?limit=1000')[1]);rows=[r for r in result['records'] if r['client_id']==client];expect(len(rows)==1 and 'SECRET' not in json.dumps(rows))
expect(request('/api/diagnostics','POST',payload,{'Origin':'https://evil.example'})[0]==403)
expect(request('/api/diagnostics','POST',payload,{'Content-Type':'text/plain'})[0]==415)
expect(request('/api/diagnostics','POST',{'version':2})[0]==400)
expect(request('/api/diagnostics','POST',{'x':'x'*66000})[0]==413)
expect(request('/api/diagnostics?limit=bad')[0]==400)
# Invalid/future cursor resets; valid cursor yields replay/heartbeat then fresh patch.
conn=http.client.HTTPConnection('127.0.0.1',PORT,timeout=10);conn.request('GET','/api/stream',headers={'Last-Event-ID':'invalid:999999'});r=conn.getresponse();expect(r.status==200);first=event(r);expect(first['event']=='reset' and 'server_time' in json.loads(first['data']));cursor=first['id'];r.close();conn.close()
conn=http.client.HTTPConnection('127.0.0.1',PORT,timeout=10);conn.request('GET','/api/stream',headers={'Last-Event-ID':cursor});r=conn.getresponse();received=[]
for _ in range(8):
    value=event(r);received.append(value['event']);expect('server_time' in json.loads(value['data']))
    if value['event']=='patch':break
expect('patch' in received and 'reset' not in received);r.close();conn.close()
print(json.dumps({'integration_checks_passed':checks,'providers':sorted({r['provider'] for r in snapshot['snapshot']['sessions']}),'sessions':len(snapshot['snapshot']['sessions']),'system_status':snapshot['system']['status']}))
