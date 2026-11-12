"""Loopback-only dashboard. HTTP reads cached data; only one collector owns polling."""
import copy
import json
import threading
import time
import uuid
from .preview_summary import apply_summaries
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, parse_qs

WEB = Path(__file__).parent / 'web'
SHARE_CONFIG = Path(__file__).resolve().parents[1] / 'deploy/cloudflare/config.json'


def public_origin(config=SHARE_CONFIG):
    """Shared HTTPS origin from LM_PUBLIC_ORIGIN or the untracked local share config."""
    import os
    value = os.environ.get('LM_PUBLIC_ORIGIN')
    if value:
        return value
    try:
        host = json.loads(config.read_text()).get('hostname')
    except (OSError, ValueError, AttributeError):
        return None
    return f'https://{host}' if isinstance(host, str) and host else None


class SnapshotPersistence:
    """Persist content changes immediately and refresh idle timestamps once a minute."""
    def __init__(self, path, writer, heartbeat=60):
        self.path, self.writer, self.heartbeat = path, writer, heartbeat
        self.content = None
        self.saved_at = None

    def save(self, snapshot, *, events=False, now=None):
        now = time.monotonic() if now is None else now
        content = {k:v for k,v in snapshot.items() if k != 'at'}
        if (events or self.saved_at is None or content != self.content
                or now-self.saved_at >= self.heartbeat):
            self.writer(self.path, snapshot)
            self.content = copy.deepcopy(content)
            self.saved_at = now


class Store:
    def __init__(self, daily_path=None):
        self.lock = threading.Lock()
        self.instance = uuid.uuid4().hex
        self.seq = 0
        self.events = []
        from .completion_window import CompletionWindow
        self.completions = CompletionWindow()
        self.completion_window = self.completions.update(time.time(), time.monotonic(), healthy=False)
        from .usage import UsageCache
        self.usage = UsageCache(daily_path)
        from .system_stats import SystemStats
        self.system = SystemStats()
        self.snapshot = dict(at=0, sessions=[], errors=[])
        self.collector_error = False
        self.stream = None
        from .diagnostics import Diagnostics
        self.diagnostics = Diagnostics(daily_path.parent/'client-diagnostics.sqlite' if daily_path else None)

    def publish(self, snapshot, events):
        with self.lock:
            # Published objects are immutable; unchanged session data can be shared.
            sessions = snapshot.get('sessions', [])
            if sessions != self.snapshot.get('sessions'):
                sessions = copy.deepcopy(sessions)
            else:
                sessions = self.snapshot['sessions']
            self.snapshot = copy.deepcopy({k:v for k,v in snapshot.items() if k != 'sessions'})
            self.snapshot['sessions'] = sessions
            self.collector_error = False
            if events:
                self.events = list(self.events)
            assigned = []
            for event in events:
                self.seq += 1
                item = dict(event, seq=self.seq, id=f'{self.instance}:{self.seq}')
                self.events.append(item)
                assigned.append(item)
            self.completion_window = self.completions.update(time.time(), time.monotonic(), assigned, source_error=bool(snapshot.get('errors')))
            if len(self.events) > 200:
                self.events = self.events[-200:]

    def failed(self):
        with self.lock:
            self.collector_error = True
            self.completion_window = self.completions.update(time.time(), time.monotonic(), healthy=False)

    def read(self, *, copy_snapshot=True):
        with self.lock:
            return dict(completion_window=copy.deepcopy(self.completion_window) if copy_snapshot else self.completion_window, instance=self.instance, seq=self.seq, events=copy.deepcopy(self.events) if copy_snapshot else self.events,
                        snapshot=copy.deepcopy(self.snapshot) if copy_snapshot else self.snapshot, collector_error=self.collector_error, usage=self.usage.read(), system=self.system.read(), system_history=self.system.read_history())


def handler(store):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def end_headers(self):
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
            self.send_header('Access-Control-Allow-Headers', '*, Authorization')
            super().end_headers()

        def allowed_host(self):
            # Keep DNS rebinding protection independent of the open CORS policy.
            allowed = {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}
            if self.headers.get('Host') not in allowed:
                self.send_error(403)
                return False
            return True

        def do_OPTIONS(self):
            if not self.allowed_host():return
            self.send_response(204)
            self.send_header('Content-Length', '0')
            self.end_headers()

        def do_GET(self):
            if not self.allowed_host():return
            path = urlsplit(self.path).path
            assets = {'/': ('index.html', 'text/html; charset=utf-8'),
                      '/app.js': ('app.js', 'text/javascript; charset=utf-8'),
                      '/workshop.js': ('workshop.js', 'text/javascript; charset=utf-8'),
                      '/folder-board.js': ('folder-board.js', 'text/javascript; charset=utf-8'),
                      '/workshop.css': ('workshop.css', 'text/css; charset=utf-8'),
                      '/weather.js': ('weather.js', 'text/javascript; charset=utf-8'),
                      '/weather.css': ('weather.css', 'text/css; charset=utf-8'),
                      '/theme.js': ('theme.js', 'text/javascript; charset=utf-8'),
                      '/diagnostics.js': ('diagnostics.js', 'text/javascript; charset=utf-8'),
                      '/clock.js': ('clock.js', 'text/javascript; charset=utf-8'),
                      '/style.css': ('style.css', 'text/css; charset=utf-8'),
                      '/fonts/neodgm.woff2': ('fonts/neodgm.woff2', 'font/woff2'),
                      '/fonts/OFL.txt': ('fonts/OFL.txt', 'text/plain; charset=utf-8')}
            if path == '/api/diagnostics':
                try:
                    limit=int(parse_qs(urlsplit(self.path).query).get('limit',['200'])[0])
                    result=store.diagnostics.read(limit)
                except ValueError: self.send_error(400);return
                except Exception: self.send_error(503);return
                self.send_json(200,result);return
            if path == '/api/stream':
                if not store.stream:
                    self.send_error(503);return
                from .streaming import frame
                self.send_response(200)
                self.send_header('Content-Type','text/event-stream; charset=utf-8')
                self.send_header('Cache-Control','no-store, no-transform')
                self.send_header('X-Accel-Buffering','no')
                self.end_headers()
                self.connection.settimeout(5)
                cursor=self.headers.get('Last-Event-ID') or parse_qs(urlsplit(self.path).query).get('cursor',[None])[0]
                try:
                    self.wfile.write(b'retry: 3000\n\n');self.wfile.flush()
                    while not store.stream.stopped:
                        messages=store.stream.messages(cursor)
                        for kind,payload,identifier in messages:
                            self.wfile.write(frame(kind,payload,identifier));cursor=identifier
                        if not messages:self.wfile.write(frame('heartbeat',{'at':time.time()}))
                        self.wfile.flush()
                        with store.stream.condition:
                            if cursor==store.stream.identifier():store.stream.condition.wait(10)
                except (OSError,TimeoutError):pass
                self.close_connection=True
                return
            if path.startswith('/api/usage/'):
                provider=path.removeprefix('/api/usage/')
                row=next((r for r in store.usage.read() if r['provider']==provider),None)
                if row is None:self.send_error(404);return
                body=json.dumps(row,ensure_ascii=False).encode()
                mime='application/json; charset=utf-8'
            elif path == '/api/state':
                from .streaming import summarize
                state=store.stream.snapshot() if store.stream else summarize(store.read())
                body = json.dumps(dict(state,server_time=time.time()), ensure_ascii=False).encode()
                mime = 'application/json; charset=utf-8'
            elif path == '/health':
                body, mime = b'{"status":"ok"}', 'application/json'
            elif path in assets:
                name, mime = assets[path]
                body = (WEB / name).read_bytes()
            elif path == '/favicon.ico':
                self.send_response(204)
                self.end_headers()
                return
            else:
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header('Content-Type', mime)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; "
                             "connect-src 'self' https://api.open-meteo.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'")
            self.end_headers()
            self.wfile.write(body)

        def send_json(self, status, value):
            body=json.dumps(value,separators=(',',':')).encode()
            self.send_response(status)
            self.send_header('Content-Type','application/json')
            self.send_header('Cache-Control','no-store')
            self.send_header('Content-Length',str(len(body)))
            self.end_headers();self.wfile.write(body)

        def do_POST(self):
            self.close_connection=True
            if not self.allowed_host():return
            if urlsplit(self.path).path!='/api/diagnostics':self.send_error(404);return
            origins={f'http://127.0.0.1:{self.server.server_port}',f'http://localhost:{self.server.server_port}'}
            if (shared:=public_origin()):origins.add(shared)
            if self.headers.get('Origin') and self.headers['Origin'] not in origins:self.send_error(403);return
            if self.headers.get('Content-Type','').split(';')[0]!='application/json':self.send_error(415);return
            try: length=int(self.headers.get('Content-Length','0'))
            except ValueError:self.send_error(400);return
            if not 0<length<=65536:self.send_error(413);return
            if self.headers.get('Transfer-Encoding'):self.send_error(400);return
            try:
                self.connection.settimeout(3)
                raw=self.rfile.read(length)
                if len(raw)!=length:raise ValueError('incomplete')
                ack=store.diagnostics.ingest(json.loads(raw))
            except (ValueError,TypeError,AttributeError):self.send_error(400);return
            except TimeoutError:self.send_error(408);return
            except Exception:self.send_error(503);return
            if ack is None:self.send_json(429,{'error':'rate_limited'});return
            self.send_json(200,{'ack':ack})
    return Handler


def serve(detector, runtime, *, port=3010, interval=5):
    from .__main__ import save
    store = Store(runtime/'daily-usage.json')
    persistence = SnapshotPersistence(runtime/'snapshot.json', save)
    stop = threading.Event()
    server = ThreadingHTTPServer(('127.0.0.1', port), handler(store))
    server.daemon_threads = True

    def diagnostic_retention():
        while not stop.is_set():
            try: store.diagnostics.read(1)
            except Exception: pass  # Upload/read endpoints report storage failures.
            stop.wait(3600)
    diagnostic_worker=threading.Thread(target=diagnostic_retention,daemon=True)
    diagnostic_worker.start()

    def poll():
        while not stop.is_set():
            try:
                snapshot, events = detector.poll()
                apply_summaries(snapshot, runtime/'preview-summaries.json', time.time())
                persistence.save(snapshot, events=bool(events))
                for event in events:
                    with (runtime/'events.jsonl').open('a') as f:
                        import os
                        os.chmod(f.name, 0o600)
                        f.write(json.dumps(event, ensure_ascii=False)+'\n')
                store.publish(snapshot, events)
            except Exception:
                # Keep last data but explicitly mark it stale. Never leak raw exceptions.
                store.failed()
                print('collector_error: retained previous snapshot', flush=True)
            stop.wait(interval)

    from .usage import start_workers
    from .streaming import StreamHub
    store.stream = StreamHub(store)
    store.stream.start(stop)
    store.system.start(stop)
    usage_workers = start_workers(store.usage, stop, detector.codex_home, detector.claude_home, runtime)
    worker = threading.Thread(target=poll, daemon=True)
    worker.start()
    print(f'Local Monitor: http://127.0.0.1:{port}', flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        stop.set()
        # Let quota subprocess workers observe stop and reap their child processes.
        for usage_worker in usage_workers:
            usage_worker.join(timeout=1)
        server.server_close()
        worker.join(timeout=3)
