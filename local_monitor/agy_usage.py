"""Bounded, quota-only Antigravity CLI queries. Never retain raw CLI output."""
import base64
import hashlib
from pathlib import Path
import fcntl
import json
import os
import re
import selectors
import signal
import subprocess
import tempfile
import threading
import time

from .usage import UsageError, display_text, normalize, number, timestamp

MAX_OUTPUT = 1024 * 1024


def account_identity(home=None):
    """Fingerprint local consumer identity, never authentication or token material."""
    overrides = ('ANTIGRAVITY_GEMINI_DIR', 'ANTIGRAVITY_CONFIG_REL_DIR',
                 'ANTIGRAVITY_CREDENTIAL_SCOPE', 'ANTIGRAVITY_APP_DATA_DIR',
                 'ANTIGRAVITY_LS_ADDRESS', 'GEMINI_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS')
    if any(os.environ.get(key) for key in overrides):
        return None
    try:
        path = (home or Path.home()/'.gemini')/'jetski-standalone-oauth-token'
        with path.open('rb') as f:
            raw = f.read(65537)
        if len(raw) > 65536:
            return None
        payload = json.loads(raw)
        if payload.get('auth_method') != 'consumer':
            return None
        claims = {}
        subject = None
        if payload.get('id_token'):
            parts = payload['id_token'].split('.')
            if len(parts) != 3:
                return None
            claims = json.loads(base64.b64decode(parts[1] + '=' * (-len(parts[1]) % 4), altchars=b'-_', validate=True))
            subject = claims.get('sub')
            if claims.get('iss') not in ('https://accounts.google.com', 'accounts.google.com'):
                return None
            if not isinstance(subject, str) or not subject.strip() or len(subject) > 255:
                return None
        # The CLI can retain only id_token_email after refreshing credentials.
        # Prefer the same email key on both sides of that transition. Do not merge
        # old subject-only records without evidence linking the two identities.
        emails = []
        for source, key in ((payload, 'id_token_email'), (claims, 'email')):
            if key not in source:
                continue
            value = source[key]
            if not isinstance(value, str):
                return None
            value = value.strip().lower()
            if len(value) > 254 or not re.fullmatch(r'[^\s@]+@[^\s@]+\.[^\s@]+', value):
                return None
            emails.append(value)
        if emails:
            if len(set(emails)) != 1:
                return None
            identity = ['antigravity', 'google-email-v1', emails[0]]
        elif subject:
            identity = ['antigravity', 'accounts.google.com', subject]
        else:
            return None
        return hashlib.sha256(json.dumps(identity).encode()).hexdigest()
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return None


def parse_usage(raw):
    try:
        payload = json.loads(raw)
        command = payload['command']
        if payload.get('status') != 'SUCCESS' or command['name'] not in ('usage', '/usage'):
            raise ValueError('invalid command')
        quota = {}
        for group in command['data']['groups']:
            group_name = display_text(group.get('display_name', group.get('displayName')))
            for bucket in group['buckets']:
                key, fraction = bucket['id'], bucket['remaining_fraction']
                reset = timestamp(bucket['reset_time'])
                if (not isinstance(key, str) or not re.fullmatch(r'[a-z0-9][a-z0-9_-]{0,39}', key)
                        or key in quota or not number(fraction) or not 0 <= fraction <= 1
                        or not number(reset) or reset <= 0):
                    raise ValueError('invalid bucket')
                quota[key] = dict(remaining_fraction=fraction, reset_time=reset, group_name=group_name,
                                  name=display_text(bucket.get('display_name', bucket.get('displayName'))))
        windows = normalize('antigravity', {'quota': quota})
        if not windows:
            raise ValueError('empty quota')
        return windows
    except (ValueError, TypeError, KeyError, AttributeError):
        raise UsageError('read_failed') from None


def query_usage(stop, timeout=45, *, own_process_group=True):
    with tempfile.TemporaryDirectory(prefix='lm-agy-usage-') as cwd:
        proc = subprocess.Popen(
            ['agy', '-p', '/usage', '--output-format', 'json', '--print-timeout', '30s'],
            cwd=cwd, env=dict(os.environ,LOCAL_MONITOR_AGY_USAGE="1"), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, start_new_session=own_process_group)
        try:
            data = bytearray()
            deadline = time.monotonic() + timeout
            with selectors.DefaultSelector() as reader:
                reader.register(proc.stdout, selectors.EVENT_READ)
                while True:
                    if stop.is_set():
                        raise UsageError('stopped')
                    if time.monotonic() >= deadline:
                        raise UsageError('timeout')
                    if not reader.select(timeout=min(.2, max(0, deadline-time.monotonic()))):
                        continue
                    chunk = os.read(proc.stdout.fileno(), 65536)
                    if not chunk:
                        break
                    data.extend(chunk)
                    if len(data) > MAX_OUTPUT:
                        raise UsageError('read_failed')
            while proc.poll() is None:
                if stop.wait(.1):
                    raise UsageError('stopped')
                if time.monotonic() >= deadline:
                    raise UsageError('timeout')
            if proc.returncode:
                raise UsageError('read_failed')
            return parse_usage(data)
        finally:
            # A CLI may leave children holding its output pipe or working directory.
            try:
                if own_process_group:
                    os.killpg(proc.pid, signal.SIGKILL)
                else:
                    proc.kill()
            except ProcessLookupError:
                pass
            proc.wait()
            proc.stdout.close()


class AgyUsage:
    def __init__(self, runtime, *, own_process_group=True):
        self.runtime = runtime
        self.own_process_group = own_process_group
        self.lock = threading.Lock()

    def collect(self, stop):
        """None means another server/thread owns the query, not a failed sample."""
        if not self.lock.acquire(blocking=False):
            return None
        try:
            self.runtime.mkdir(parents=True, exist_ok=True, mode=0o700)
            fd = os.open(self.runtime/'agy-usage.lock', os.O_CREAT | os.O_RDWR, 0o600)
            with os.fdopen(fd, 'a') as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError:
                    return None
                return query_usage(stop, own_process_group=self.own_process_group)
        finally:
            self.lock.release()


def run_worker(cache, stop, runtime):
    collector = AgyUsage(runtime)
    fallback = 600
    while not stop.is_set():
        delay = 300
        try:
            account = account_identity()
            windows = collector.collect(stop)
            after = account_identity()
            if windows is not None:
                cache.update('antigravity', windows, account=account if account == after else None)
                fallback = 600
        except UsageError as error:
            if str(error) == 'stopped':
                break
            cache.update('antigravity', error='timeout' if str(error) == 'timeout' else 'read_failed')
            delay, fallback = fallback, min(3600, fallback*2)
        except Exception:
            # Exception messages can contain paths, auth material or CLI content.
            cache.update('antigravity', error='read_failed')
            delay, fallback = fallback, min(3600, fallback*2)
        with cache.lock:
            cache.rows['antigravity']['next_retry_at'] = time.time() + delay
        stop.wait(delay)
