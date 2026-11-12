"""Quota reads with bounded, separate Claude CLI authentication recovery."""
import copy
import hashlib
import json
import math
import os
import queue
import subprocess
import sys
import threading
import time
import unicodedata
from datetime import datetime
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.error import HTTPError
from urllib.request import Request, build_opener, HTTPRedirectHandler

PROVIDERS = ('codex', 'claude', 'antigravity')


class UsageError(Exception):
    pass


def number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def timestamp(value):
    if number(value):
        return value if value > 0 else None
    try:
        return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()
    except (AttributeError, ValueError, TypeError):
        return None


def window(key, used, reset, minutes=None):
    if not number(used) or not 0 <= used <= 100:
        return None
    label = '주간' if minutes == 10080 else '5시간' if minutes == 300 else '한도'
    return dict(id=str(key)[:120], label=label, used_percent=used,
                remaining_percent=round(100-used, 2), resets_at=timestamp(reset))


def normalize(provider, payload):
    out = []
    if provider == 'codex':
        groups = payload.get('rateLimitsByLimitId')
        if not isinstance(groups, dict) or not groups:
            groups = {'codex': payload.get('rateLimits') or {}}
        for key, group in groups.items():
            if not isinstance(group, dict):
                continue
            for slot in ('primary', 'secondary'):
                raw = group.get(slot)
                if isinstance(raw, dict):
                    w = window(f'{key}/{slot}', raw.get('usedPercent'), raw.get('resetsAt'), raw.get('windowDurationMins'))
                    if w:
                        w['group'] = str(group.get('limitName') or key)[:100]
                        out.append(w)
    elif provider == 'claude':
        for key, raw in payload.items():
            if not isinstance(raw, dict) or not (key == 'five_hour' or key.startswith('seven_day')):
                continue
            w = window(key, raw.get('utilization'), raw.get('resets_at'), 300 if key == 'five_hour' else 10080)
            if w:
                w['group'] = {'five_hour': '전체', 'seven_day': '전체'}.get(key, key.removeprefix('seven_day_'))
                out.append(w)
    else:
        for key, raw in (payload.get('quota') or {}).items():
            if not isinstance(raw, dict):
                continue
            fraction = raw.get('remaining_fraction')
            if not number(fraction) or not 0 <= fraction <= 1:
                continue
            w = window(key, round((1-fraction)*100, 2), raw.get('reset_time'),
                       10080 if 'weekly' in key else 300 if '5h' in key else None)
            w['group'], name = antigravity_names(str(key), raw.get('group_name'), raw.get('name'))
            if name:
                w['name'] = name
            out.append(w)
    return out


# Bucket id prefix decides the family so model buckets (e.g. Argon) sit with it.
AG_FAMILIES = (('gemini-', 'Gemini'), ('3p-', 'Claude · GPT'))
AG_WINDOW_TOKENS = ('weekly', '5h')


def display_text(value):
    """Single-line, bounded CLI label; None when absent or unusable."""
    if not isinstance(value, str):
        return None
    text = ' '.join(''.join(' ' if c.isspace() else c for c in value
                            if c.isspace() or unicodedata.category(c)[0] != 'C').split())[:40]
    return text or None


def merge_windows(current, fresh, current_at):
    """Update matching ids in place order; keep the rest with their own observation time."""
    by_id = {w['id']: w for w in fresh}
    out = []
    for w in current:
        new = by_id.pop(w['id'], None)
        if new is None:
            out.append(dict(w, observed_at=w.get('observed_at', current_at)))
        else:
            # statusLine has no CLI display names; keep the ones /usage supplied.
            out.append({**new, **{k: w[k] for k in ('group', 'name') if k in w}})
    return out + list(by_id.values())


def antigravity_names(key, group_name=None, name=None):
    """(group, model name). CLI display names apply only to unknown families."""
    for prefix, family in AG_FAMILIES:
        if key.startswith(prefix):
            model = key[len(prefix):].split('-')[0]
            return family, None if model in AG_WINDOW_TOKENS or not model else model.title()
    return display_text(group_name) or key[:100], display_text(name)


def codex_usage(home):
    env = dict(os.environ, CODEX_HOME=str(home))
    for key in ('OPENAI_API_KEY', 'CODEX_API_KEY'):
        env.pop(key, None)
    proc = subprocess.Popen(['codex', 'app-server'], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, env=env)
    replies = queue.Queue()
    def read():
        for line in proc.stdout:
            try:
                replies.put(json.loads(line))
            except ValueError:
                pass
        replies.put(None)
    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    def send(message):
        proc.stdin.write(json.dumps(message)+'\n'); proc.stdin.flush()
    def call(identifier, method, params):
        send(dict(id=identifier, method=method, params=params))
        end = time.monotonic()+20
        while True:
            try:
                value = replies.get(timeout=max(0, end-time.monotonic()))
            except queue.Empty:
                raise UsageError('timeout') from None
            if value is None:
                raise UsageError('cli_unavailable')
            if value.get('id') == identifier:
                if 'error' in value:
                    raise UsageError('auth_or_rpc_error')
                return value.get('result') or {}
            if 'id' in value and 'method' in value:
                send(dict(id=value['id'], error=dict(code=-32601, message='Unsupported')))
    try:
        call(1, 'initialize', {'clientInfo': {'name': 'local_monitor', 'version': '0.1.0'}})
        send({'method': 'initialized', 'params': {}})
        return normalize('codex', call(2, 'account/rateLimits/read', {}))
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            proc.kill(); proc.wait()
        reader.join(timeout=1)
        proc.stdin.close(); proc.stdout.close()


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def claude_usage(home):
    credential = home/'.credentials.json'
    secret = None
    if sys.platform == 'darwin':
        suffix = hashlib.sha256(unicodedata.normalize('NFC', str(home)).encode()).hexdigest()[:8]
        services = ['Claude Code-credentials-'+suffix]
        if home == Path.home()/'.claude':
            services.append('Claude Code-credentials')
        secret = None
        for service in services:
            result = subprocess.run(['security', 'find-generic-password', '-s', service, '-w'],
                                    capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                secret = json.loads(result.stdout)
                break
    if secret is None and credential.exists():
        secret = json.loads(credential.read_text())
    if secret is None:
        raise UsageError('auth_required')
    oauth = secret.get('claudeAiOauth') or {}
    token = oauth.get('accessToken')
    if not isinstance(token, str) or not token:
        raise UsageError('auth_required')
    # Claude Code stores OAuth expiration as Unix milliseconds.
    expires_at = oauth.get('expiresAt')
    if number(expires_at) and expires_at <= time.time()*1000:
        raise UsageError('auth_expired')
    request = Request('https://api.anthropic.com/api/oauth/usage', headers={
        'Authorization': 'Bearer '+token, 'Accept': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'claude-code/2.1.287'})
    with build_opener(NoRedirect).open(request, timeout=20) as response:
        return normalize('claude', json.loads(response.read(1024*1024)))


class UsageCache:
    def __init__(self, daily_path=None):
        from .daily_usage import DailyUsage
        self.daily = DailyUsage(daily_path)
        self.accounts = {}
        self.lock = threading.Lock()
        self.rows = {p: dict(provider=p, status='loading', windows=[], observed_at=None,
                             checked_at=None, error=None, source='cli + statusLine' if p == 'antigravity' else 'account') for p in PROVIDERS}

    def update(self, provider, windows=None, error=None, observed_at=None, account=None, merge=False):
        """merge=True keeps windows the source omits (statusLine carries a subset of /usage)."""
        now = time.time()
        with self.lock:
            row = self.rows[provider]
            # Unattributed statusLine samples must not replace account-bound history.
            if provider == 'antigravity' and merge and row.get('account_bound'):
                return
            if (provider == 'antigravity' and not error and observed_at is not None
                    and row['observed_at'] is not None and observed_at <= row['observed_at']):
                return
            row['checked_at'] = now
            row['error'] = error
            if error:
                row['status'] = 'stale' if row['windows'] else 'unavailable'
            else:
                self.accounts[provider] = account
                if provider == 'antigravity' and not merge:
                    row['account_bound'] = bool(account)
                self.daily.observe(provider, account, windows or [], observed_at or now, now)
                if merge:
                    windows = merge_windows(row['windows'], windows or [], row['observed_at'])
                row.update(windows=windows or [], observed_at=observed_at or now,
                           status='ok' if windows else 'unavailable')

    def read(self, now=None):
        now = time.time() if now is None else now
        with self.lock:
            rows = copy.deepcopy(list(self.rows.values()))
            for row in rows:
                for w in row['windows']:
                    if w['label'] == '주간':
                        w['daily'] = self.daily.read(row['provider'], self.accounts.get(row['provider']), w, now)
        for row in rows:
            old = row['observed_at'] is not None and now-row['observed_at'] > 600
            for w in row['windows']:
                # Windows kept by a partial merge carry their own observation time.
                kept_old = number(w.get('observed_at')) and now-w['observed_at'] > 600
                w['stale'] = (old or kept_old or bool(row['error'])
                              or (w['resets_at'] is not None and w['resets_at'] <= now))
                if w.get('daily', {}).get('status') == 'ok' and w['stale']:
                    w['daily']['status'] = 'delayed'
            if any(w['stale'] for w in row['windows']):
                row['status'] = 'stale'
        return rows


def retry_after(value, now=None):
    """Support both Retry-After formats without exposing response content."""
    now = time.time() if now is None else now
    try:
        if value and value.strip().isdigit():
            return max(0, int(value.strip()))
        return max(0, parsedate_to_datetime(value).timestamp()-now)
    except (ValueError, TypeError, AttributeError, OverflowError):
        return 0


def account_fingerprint(provider, home):
    """Local stable identity only; never expose raw identifiers in the API or history."""
    try:
        if provider == 'codex':
            identity = json.loads((home/'auth.json').read_text()).get('tokens', {}).get('account_id')
        else:
            config = home.parent/(home.name+'.json')
            account = json.loads(config.read_text()).get('oauthAccount', {})
            identity = [account.get('accountUuid'), account.get('organizationUuid')]
            if not all(identity):
                return None
        if not identity:
            return None
        return hashlib.sha256(json.dumps([provider, identity]).encode()).hexdigest()
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def collect(cache, provider, home, rate_limit_delay=600):
    delay = 300
    try:
        account = account_fingerprint(provider, home)
        windows = (codex_usage if provider == 'codex' else claude_usage)(home)
        after = account_fingerprint(provider, home)
        cache.update(provider, windows, account=account if account == after else None)
    except HTTPError as e:
        if e.code == 429:
            delay = max(rate_limit_delay, retry_after(e.headers.get('Retry-After') if e.headers else None))
        cache.update(provider, error='auth_required' if e.code in (401,403) else 'rate_limited' if e.code == 429 else 'http_error')
    except UsageError as e:
        # Expired tokens fail locally before HTTP. Re-read the credential store soon;
        # only a usable token proceeds to the API. HTTP errors retain normal backoff.
        if provider == 'claude' and str(e) == 'auth_expired':
            delay = 15
        cache.update(provider, error=str(e))
    except Exception:
        # Do not leak exception text: it may include auth data or file contents.
        cache.update(provider, error='read_failed')
    with cache.lock:
        cache.rows[provider]['next_retry_at'] = time.time()+delay
    return delay


def start_workers(cache, stop, codex_home, claude_home, runtime):
    from .claude_refresh import ClaudeRefresh
    from .agy_usage import run_worker
    refresher = ClaudeRefresh(runtime, claude_home)
    workers = []
    def refresh_state(state):
        with cache.lock:
            cache.rows['claude']['auth_refresh'] = state
    def remote(provider, home):
        fallback = 600
        while not stop.is_set():
            delay = collect(cache, provider, home, fallback)
            if provider == 'claude':
                with cache.lock:
                    expired = cache.rows[provider]['error'] == 'auth_expired'
                if expired and not stop.is_set() and refresher.attempt(refresh_state):
                    delay = collect(cache, provider, home, fallback)
            fallback = min(3600, fallback*2) if delay > 300 else 600
            stop.wait(delay)
    def bridge():
        while not stop.is_set():
            try:
                payload = json.loads((runtime/'usage-antigravity.json').read_text())
                at = payload.get('observed_at')
                if not number(at) or at <= 0 or at > time.time()+60:
                    raise ValueError('invalid time')
                windows = normalize('antigravity', payload)
                if not windows:
                    raise ValueError('empty quota')
                cache.update('antigravity', windows, observed_at=at, merge=True)
            except FileNotFoundError:
                pass  # Independent auto query also works without a statusLine hook.
            except Exception:
                pass  # A broken passive file must not invalidate auto query data.
            stop.wait(2)
    for target, args in [(remote, ('codex', codex_home)), (remote, ('claude', claude_home)),
                         (bridge, ()), (run_worker, (cache, stop, runtime))]:
        t = threading.Thread(target=target, args=args, daemon=True)
        t.start(); workers.append(t)
    return workers
