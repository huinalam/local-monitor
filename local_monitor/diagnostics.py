"""Bounded, whitelisted browser telemetry; never accept raw session content."""
import json
import math
import os
import sqlite3
import threading
import time
import uuid
from collections import deque

EVENTS = set('start sample warning recovery sse_open sse_error sse_reset sse_parse_error sse_watchdog http_ok http_error online offline visibility pagehide'.split())
NUMERIC = 'snapshot_at snapshot_age_s raw_snapshot_age_s message_age_s failure_count session_error_count duration_ms clock_delta_ms server_clock_offset_ms'.split()
ENUMS = dict(reason=set('none collector stale sessions auth disconnected unknown timeout network invalid_json unavailable'.split()),
             visibility={'visible','hidden','prerender'}, stream={'none','connecting','open','closed'}, endpoint={'state','usage'}, clock_source={'server','http_date','unknown'})


def identifier(value):
    if not isinstance(value, str) or str(uuid.UUID(value)) != value:
        raise ValueError('invalid identifier')
    return value


def clean(value):
    if not isinstance(value, dict) or value.get('event') not in EVENTS:
        raise ValueError('invalid record')
    row = dict(entry_id=identifier(value.get('entry_id')), event=value['event'])
    for key in ['at']+NUMERIC:
        v = value.get(key)
        if isinstance(v, (int,float)) and not isinstance(v,bool) and abs(v) <= 1e16 and math.isfinite(v):
            row[key] = v
    if 'at' not in row:
        raise ValueError('invalid timestamp')
    for key in ('collector_error','fallback','warning','online'):
        if isinstance(value.get(key),bool): row[key] = value[key]
    for key, options in ENUMS.items():
        if isinstance(value.get(key),str) and value[key] in options: row[key] = value[key]
    status = value.get('http_status')
    if type(status) is int and 0 <= status <= 599: row['http_status'] = status
    return row


class Diagnostics:
    def __init__(self, path=None):
        self.path = path
        self.lock = threading.Lock()
        self.requests = deque(maxlen=120)

    def connect(self):
        if self.path is None: raise OSError('storage unavailable')
        self.path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
        fd=os.open(self.path,os.O_CREAT|os.O_RDWR,0o600);os.close(fd);os.chmod(self.path,0o600)
        db=sqlite3.connect(self.path,timeout=2)
        db.execute('CREATE TABLE IF NOT EXISTS records (client TEXT, entry TEXT, received REAL, payload TEXT, PRIMARY KEY(client,entry))')
        return db

    def prune(self, db, now):
        db.execute('DELETE FROM records WHERE received < ?', (now-7*86400,))
        db.execute('DELETE FROM records WHERE rowid NOT IN (SELECT rowid FROM records ORDER BY received DESC,rowid DESC LIMIT 10000)')

    def ingest(self, payload):
        if not isinstance(payload,dict) or type(payload.get('version')) is not int or payload['version'] != 1: raise ValueError('invalid schema')
        client=identifier(payload.get('client_id'));raw=payload.get('records')
        if not isinstance(raw,list) or not 1 <= len(raw) <= 50: raise ValueError('invalid batch')
        rows=[clean(row) for row in raw]
        with self.lock:
            now=time.time()
            while self.requests and self.requests[0] < now-60: self.requests.popleft()
            if len(self.requests)>=120: return None
            self.requests.append(now)
            db=self.connect()
            try:
                with db:
                    for row in rows:
                        db.execute('INSERT OR IGNORE INTO records VALUES (?,?,?,?)',(client,row['entry_id'],now,json.dumps(row,separators=(',',':'))))
                    self.prune(db,now)
            finally: db.close()
        return [row['entry_id'] for row in rows]

    def read(self, limit=200):
        with self.lock:
            db=self.connect()
            try:
                with db: self.prune(db,time.time())
                count=db.execute('SELECT COUNT(*) FROM records').fetchone()[0]
                rows=db.execute('SELECT client,received,payload FROM records ORDER BY received DESC,rowid DESC LIMIT ?', (max(1,min(1000,limit)),)).fetchall()
                return dict(total=count,records=[dict(json.loads(raw),client_id=client,received_at=received) for client,received,raw in rows])
            finally: db.close()
