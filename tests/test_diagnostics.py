import http.client
import json
import os
import sqlite3
import tempfile
import threading
import time
import unittest
import uuid
from http.server import ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from local_monitor.diagnostics import Diagnostics
from local_monitor.server import Store, handler


def batch():
    return dict(version=1,client_id=str(uuid.uuid4()),records=[dict(entry_id=str(uuid.uuid4()),at=time.time()*1000,event='warning',reason='stale',snapshot_age_s=21,stream='open',prompt='private',email='private',cookie='private')])


class DiagnosticsTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.path=Path(self.tmp.name)/'client-diagnostics.sqlite';self.store=Diagnostics(self.path)

    def test_dedup_whitelist_restart_permissions(self):
        raw=batch();self.store.ingest(raw);self.store.ingest(raw)
        result=Diagnostics(self.path).read()
        self.assertEqual(result['total'],1)
        self.assertEqual(result['records'][0]['client_id'],raw['client_id'])
        self.assertEqual(result['records'][0]['snapshot_age_s'],21)
        self.assertIn('received_at',result['records'][0])
        self.assertNotIn('private',json.dumps(result))
        self.assertEqual(self.path.stat().st_mode&0o777,0o600)

    def test_bound_retention_client_clock_and_rate(self):
        raw=batch();raw['records'][0]['at']=1
        self.store.ingest(raw)
        db=self.store.connect()
        with db:
            db.execute('UPDATE records SET received=?',(time.time()-8*86400,))
            db.executemany('INSERT INTO records VALUES (?,?,?,?)',((str(i),str(i),time.time(),json.dumps(raw['records'][0])) for i in range(10005)))
        db.close()
        self.assertEqual(self.store.read()['total'],10000)
        self.store.requests.extend([time.time()]*120)
        self.assertIsNone(self.store.ingest(raw))

    def test_invalid_atomic_batch_and_concurrent_dedup(self):
        raw=batch();bad=json.loads(json.dumps(raw));bad['records'].append({'event':'warning'})
        with self.assertRaises(ValueError):self.store.ingest(bad)
        self.assertEqual(self.store.read()['total'],0)
        threads=[threading.Thread(target=self.store.ingest,args=(raw,)) for _ in range(5)]
        for t in threads:t.start()
        for t in threads:t.join()
        self.assertEqual(self.store.read()['total'],1)

    def test_http_ingest_origin_size_schema_read(self):
        store=Store();store.diagnostics=self.store
        server=ThreadingHTTPServer(('127.0.0.1',0),handler(store))
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        def req(body,headers=None,path='/api/diagnostics',method='POST'):
            c=http.client.HTTPConnection('127.0.0.1',server.server_port,timeout=5)
            c.request(method,path,body,dict({'Content-Type':'application/json'},**(headers or {})))
            r=c.getresponse();result=(r.status,r.read());c.close();return result
        try:
            raw=json.dumps(batch())
            self.assertEqual(req(raw,{'Origin':'https://foreign.invalid'})[0],403)
            with patch.dict(os.environ,{'LM_PUBLIC_ORIGIN':'https://monitor.example.invalid'}):
                self.assertEqual(req(raw,{'Origin':'https://monitor.example.invalid'})[0],200)
            with patch.dict(os.environ,{'LM_PUBLIC_ORIGIN':''}),patch('local_monitor.server.SHARE_CONFIG',Path('/nonexistent/config.json')):
                self.assertEqual(req(raw,{'Origin':'https://monitor.example.invalid'})[0],403)
            self.assertEqual(req(raw)[0],200)
            self.assertEqual(req('{}')[0],400)
            self.assertEqual(req('x'*65537)[0],413)
            self.assertEqual(req(raw,{'Content-Type':'text/plain'})[0],415)
            self.assertEqual(req(raw,{'Host':'foreign.invalid'})[0],403)
            status,body=req(None,method='GET');self.assertEqual(status,200)
            self.assertEqual(json.loads(body)['total'],1)
            self.assertEqual(req(None,path='/api/diagnostics?limit=bad',method='GET')[0],400)
        finally:server.shutdown();server.server_close();thread.join()
