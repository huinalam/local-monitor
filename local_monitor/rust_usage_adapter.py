"""Ephemeral quota collector for Rust host. No long-lived Python server."""
import argparse
import copy
import json
import os
from pathlib import Path
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from .usage import UsageCache, collect, account_fingerprint, number, normalize
from .agy_usage import AgyUsage, account_identity
from .claude_refresh import ClaudeRefresh
from .__main__ import save


def refresh(runtime,codex_home,claude_home,now=None,collector=collect,agy=None):
    now=time.time() if now is None else now
    state_path=runtime/'rust/usage-state.json'
    state=json.loads(state_path.read_text()) if state_path.exists() else {}
    cache=UsageCache(runtime/'daily-usage.json')
    saved_rows=state.get('rows',[])
    if isinstance(saved_rows,dict):saved_rows=list(saved_rows.values())
    for row in saved_rows:
        if isinstance(row,dict) and row.get('provider') in cache.rows:
            cache.rows[row['provider']]=row
    cache.accounts=state.get('accounts',{})
    for provider,home in [('codex',codex_home),('claude',claude_home)]:
        if provider not in cache.accounts:cache.accounts[provider]=account_fingerprint(provider,home)
    backoff=state.get('backoff',{})
    def remote(provider,home):
        due=cache.rows[provider].get('next_retry_at')
        if number(due) and due>now:return
        fallback=backoff.get(provider,600)
        if not number(fallback) or not 600<=fallback<=3600:fallback=600
        delay=collector(cache,provider,home,fallback)
        if provider=='claude' and cache.rows[provider].get('error')=='auth_expired':
            refresher=ClaudeRefresh(runtime,claude_home)
            def publish(value):
                with cache.lock:cache.rows[provider]['auth_refresh']=value
            if refresher.attempt(publish):delay=collector(cache,provider,home,fallback)
        backoff[provider]=min(3600,fallback*2) if delay>300 else 600
    def antigravity():
        due=cache.rows['antigravity'].get('next_retry_at')
        if number(due) and due>now:return
        stop=threading.Event();collector=agy or AgyUsage(runtime,own_process_group=False)
        fallback=backoff.get('antigravity',600)
        try:
            account=account_identity()
            windows=collector.collect(stop)
            after=account_identity()
            if windows is None:
                cache.rows['antigravity']['next_retry_at']=time.time()+30
                return
            cache.update('antigravity',windows,observed_at=time.time(),account=account if account == after else None)
            delay=300;backoff['antigravity']=600
        except Exception:
            cache.update('antigravity',error='read_failed')
            delay=fallback;backoff['antigravity']=min(3600,fallback*2)
        cache.rows['antigravity']['next_retry_at']=time.time()+delay
    with ThreadPoolExecutor(max_workers=3) as workers:
        jobs=[workers.submit(remote,p,h) for p,h in [('codex',codex_home),('claude',claude_home)]]+[workers.submit(antigravity)]
        for job in jobs:job.result()
    # Existing passive bridge may carry a newer observation than automatic polling.
    try:
        payload=json.loads((runtime/'usage-antigravity.json').read_text());at=payload.get('observed_at')
        if number(at) and 0<at<=now+60:
            windows=normalize('antigravity',payload)
            if windows:cache.update('antigravity',windows,observed_at=at,merge=True)
    except (OSError,ValueError,TypeError):pass
    # Persist hydrated daily fields so Rust can restore the display without a new query.
    rows=cache.read()
    with cache.lock:
        save(state_path,{'version':1,'rows':rows,'accounts':cache.accounts,'backoff':backoff})
    return rows


def main():
    p=argparse.ArgumentParser();p.add_argument('--runtime',type=Path,required=True)
    p.add_argument('--codex-home',type=Path,default=Path.home()/'.codex');p.add_argument('--claude-home',type=Path,default=Path.home()/'.claude');a=p.parse_args()
    try:
        print(json.dumps(refresh(a.runtime,a.codex_home,a.claude_home),ensure_ascii=False))
    except Exception:
        # Never output exception details or credential-containing upstream responses.
        print(json.dumps({'error':'usage_adapter_failed'}));raise SystemExit(1)

if __name__=='__main__':main()
