import http.client
import threading
import unittest
from http.server import ThreadingHTTPServer
from local_monitor.server import Store, handler


class ServerTests(unittest.TestCase):
    def setUp(self):
        self.store=Store()
        self.server=ThreadingHTTPServer(('127.0.0.1',0),handler(self.store))
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.addCleanup(self.cleanup)

    def cleanup(self):
        self.server.shutdown();self.server.server_close();self.thread.join()

    def request(self,path,headers=None,method="GET"):
        c=http.client.HTTPConnection('127.0.0.1',self.server.server_port)
        c.request(method,path,headers=headers or {})
        r=c.getresponse();result=(r.status,dict(r.getheaders()),r.read());c.close();return result

    def test_assets_and_private_paths(self):
        for path in ('/','/app.js','/theme.js','/style.css','/weather.js','/weather.css','/workshop.js','/workshop.css','/api/state','/health'):
            status,headers,body=self.request(path)
            self.assertEqual(status,200);self.assertGreater(len(body),0)
            self.assertEqual(headers['Cache-Control'],'no-store')
            self.assertIn("connect-src 'self' https://api.open-meteo.com;",headers['Content-Security-Policy'])
        self.assertEqual(self.request('/../.runtime/snapshot.json')[0],404)
        self.assertEqual(self.request('/.runtime/claude-settings.json')[0],404)

    def test_state_server_clock_is_current_even_with_old_snapshot(self):
        import json,time
        self.store.publish({'at':1,'sessions':[],'errors':[]},[])
        before=time.time()
        status,headers,body=self.request('/api/state')
        data=json.loads(body)
        self.assertEqual(status,200)
        self.assertGreaterEqual(data['server_time'],before)
        self.assertLessEqual(data['server_time'],time.time())
        self.assertEqual(data['snapshot']['at'],1)
        self.assertEqual(self.request('/clock.js')[0],200)

    def test_bundled_font_and_license(self):
        status,headers,body=self.request('/fonts/neodgm.woff2')
        self.assertEqual(status,200)
        self.assertEqual(headers['Content-Type'],'font/woff2')
        self.assertEqual(body[:4],b'wOF2')
        self.assertIn(b'SIL OPEN FONT LICENSE',self.request('/fonts/OFL.txt')[2])
        self.assertEqual(self.request('/fonts/../../.runtime/snapshot.json')[0],404)

    def test_rejects_foreign_host(self):
        self.assertEqual(self.request('/api/state',{'Host':'attacker.invalid'})[0],403)

    def test_all_origins_and_preflight(self):
        for origin in ('https://monitor.example.invalid','https://other.invalid','null'):
            for path in ('/fonts/neodgm.woff2','/api/state'):
                status,headers,body=self.request(path,{'Origin':origin})
                self.assertEqual(status,200)
                self.assertEqual(headers['Access-Control-Allow-Origin'],'*')
                self.assertNotIn('Access-Control-Allow-Credentials',headers)
        status,headers,body=self.request('/fonts/neodgm.woff2',{'Origin':'https://other.invalid','Access-Control-Request-Method':'GET','Access-Control-Request-Headers':'authorization,last-event-id,x-custom'},method='OPTIONS')
        self.assertEqual(status,204);self.assertEqual(body,b'')
        self.assertEqual(headers['Access-Control-Allow-Origin'],'*')
        self.assertIn('GET',headers['Access-Control-Allow-Methods'])
        self.assertIn('*',headers['Access-Control-Allow-Headers'])
        self.assertEqual(self.request('/api/state',{'Host':'other.invalid'},method='OPTIONS')[0],403)

    def test_stream_and_lazy_details(self):
        from local_monitor.streaming import StreamHub
        self.store.stream=StreamHub(self.store);self.store.stream.refresh()
        c=http.client.HTTPConnection('127.0.0.1',self.server.server_port,timeout=2)
        c.request('GET','/api/stream',headers={'Origin':'https://other.invalid'});r=c.getresponse()
        self.assertEqual(r.status,200)
        self.assertIn('text/event-stream',r.getheader('Content-Type'))
        self.assertEqual(r.getheader('Access-Control-Allow-Origin'),'*')
        lines=[]
        while len(lines)<5:lines.append(r.fp.readline())
        self.assertTrue(any(b'event: reset' in line for line in lines))
        r.close();c.close()
        with self.store.stream.condition:
            self.store.stream.stopped=True;self.store.stream.condition.notify_all()
        self.assertEqual(self.request('/api/usage/claude')[0],200)
        self.assertEqual(self.request('/api/usage/invalid')[0],404)

    def test_cursor_bounded_history_and_failed_state(self):
        for i in range(205):self.store.publish({'at':i,'sessions':[],'errors':[]},[{'title':str(i)}])
        state=self.store.read();self.assertEqual(state['seq'],205);self.assertEqual(len(state['events']),200)
        self.assertEqual(state['events'][0]['seq'],6)
        self.store.failed();self.assertTrue(self.store.read()['collector_error'])
        self.store.publish({'at':206,'sessions':[],'errors':[]},[])
        self.assertFalse(self.store.read()['collector_error'])
        state['events'].clear();self.assertEqual(len(self.store.read()['events']),200)

if __name__=='__main__':unittest.main()
