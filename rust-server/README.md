# Local Monitor Rust server

Native macOS server: Codex SQLite/JSONL, Claude/Antigravity hooks and process checks, static dashboard, HTTP/SSE replay, Mach/sysctl metrics, diagnostic SQLite storage. Uses the existing UI and same loopback/Origin protections. Task polling5s, metrics10s, replay256, completion events200, metrics history180.

Quota collection intentionally still uses a **short-lived Python adapter**, `python3 -m local_monitor.rust_usage_adapter`. It preserves tested credentials/keychain access, provider normalizers, Retry-After/backoff, Claude bounded auth refresh/cooldown and the existing daily ledger. No long-lived Python web server is needed. Python and the provider CLIs remain runtime dependencies; memory/CPU temporarily rise during collection. No tokens are sent to or logged by Rust.

Build/test:

```bash
bash scripts/build-rust-server.sh --test
python3 -m unittest discover -s tests
node --test tests/*.cjs
```

The script uses the isolated `.runtime/rust-comparison` toolchain when available, otherwise Cargo on PATH, and builds to `.runtime/rust-server-target`. Toolchain and builds are ignored; Cargo.lock is tracked. macOS/Apple Silicon is the validated platform.

QA alongside Python (read-only sharing of already collected quotas):

```bash
.runtime/rust-server-target/release/local-monitor-rust \
  --port 3011 --runtime .runtime/rust-qa --hooks-runtime .runtime \
  --usage-source http://127.0.0.1:3010
python3 rust-server/check_server.py 3011
```

Independent operation (after stopping the Python server and seeding quota state):

```bash
.runtime/rust-server-target/release/local-monitor-rust \
  --port 3010 --runtime .runtime --hooks-runtime .runtime
```

Restarting from an SSH session: tmux copies `SSH_CONNECTION` into the new server. Antigravity CLI then switches to file-based token storage ("SSH session detected"), so `/usage` fails with `read_failed` and backs off up to an hour. Start it with `env -u SSH_CONNECTION -u SSH_CLIENT -u SSH_TTY -u SSH_AUTH_SOCK` in front of the binary (verified 2026-10-22).

Run from repository root. `--python`, `--codex-home`, `--claude-home` accept explicit paths. Default port/runtime are QA3011/`.runtime/rust-qa` to avoid accidentally replacing the operating server. Runtime lock prevents concurrent collectors sharing a runtime. The dedicated Cloudflare tunnel remains unchanged; it routes to127.0.0.1:3010.

Before migration, privately back up `daily-usage.json` and the diagnostic DB (SQLite backup API). Seed `.runtime/rust/usage-state.json` with current full rows, account fingerprints (hash only), backoff and original next_retry_at values, so no duplicate upstream query is needed. The adapter rewrites that private cache atomically. Independent mode never fetches the Python server.

Rollback: stop Rust's tmux session, then restore the previous Python session command:

```bash
bash ~/.codex/skills/dev-server-tmux/scripts/tmux-dev-server.sh stop \
  --session 2026-10-14--local-monitor-rust-web-3010
# Rust handles tmux SIGHUP gracefully; wait for its listener/lock to close.
for attempt in {1..25}; do
  if ! lsof -nP -iTCP:3010 -sTCP:LISTEN >/dev/null 2>&1; then break; fi
  sleep .2
done
bash ~/.codex/skills/dev-server-tmux/scripts/tmux-dev-server.sh start \
  --session 2026-10-14--local-monitor-web-3010 \
  --workdir "$PWD" --cmd 'python3 -m local_monitor serve --port 3010 --interval 5' \
  --port 3010 --health-url http://127.0.0.1:3010/health
```

Keep current valid daily/diagnostic records on rollback; do not restore an older backup unless corruption was verified. Rust SIGINT shutdown terminates its adapter process group; original hooks, CLI sessions, DNS/Access and tunnel are untouched. The server still needs manual restart after reboot, as before.

Verification: `check_server.py` uses random synthetic diagnostic metadata only and checks schema, privacy/idempotency, request boundaries, traversal, SSE reset/replay/current timestamps and native metrics. Rust tests cover Codex rotation/partial/large records, late completion/abort, hook transitions, PID reuse, replay bounds and whitelist. The Python adapter has isolated no-network cache/backoff/ledger tests. Actual authenticated Cloudflare login is a separate browser check; do not equate a302 Access redirect with authenticated dashboard success.

Measure:

```bash
python3 rust-server/measure_servers.py 3010 3011 --seconds 60 \
  --output .agent-logs/rust-server-comparison.json
```

Parent CPU excludes subprocess CPU; sampled descendant RSS can miss processes shorter than the1s sampling interval. QA sharing Python quotas is a functional test, not proof of independent provider collection. Post-cutover measurements must identify adapter bursts separately.

Startup `/health` identifies a live listener; `check_server.py` waits up to15s for the first background history/metrics scan. Quota cache includes hydrated daily fields so immediate post-restart cards retain budget markers before the next scheduled upstream query. Expired windows mark the parent provider stale and hide daily budget markers until refresh.
