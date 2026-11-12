# Rust detector probe

Read-only experiment comparing Claude/Antigravity task detection against the current Python detector. This is **not a replacement server**: Codex, HTTP/SSE, quota polling, system metrics, notifications, and persistence are excluded. Production hooks/configuration and runtime files are never modified.

The Rust probe reads the same Claude registry and hook metadata as Python, checks PID/start/executable using one `ps` snapshot per poll, skips unchanged spool scans, maintains task states/turn boundaries/completion timestamps, and applies the same 600s stale rule. It retains only metadata, not conversation contents. Python baseline uses the production `Detector` with Codex collection disabled; its existing module imports (including SQLite) remain part of its memory cost. These are implementation measurements, not a pure language-runtime benchmark.

Build on macOS with an installed Rust toolchain:

```sh
cargo build --release --manifest-path experiments/rust-detector/Cargo.toml
cargo test --release --manifest-path experiments/rust-detector/Cargo.toml
python3 experiments/rust-detector/check_parity.py experiments/rust-detector/target/release/monitor-detector-probe
```

This workspace's toolchain and target are isolated in ignored `.runtime/rust-comparison`, with no shell profile changes. To use that installation instead:

```sh
export RUSTUP_HOME="$PWD/.runtime/rust-comparison/rustup"
export CARGO_HOME="$PWD/.runtime/rust-comparison/cargo"
export CARGO_TARGET_DIR="$PWD/.runtime/rust-comparison/target"
"$CARGO_HOME/bin/cargo" build --release --manifest-path experiments/rust-detector/Cargo.toml
python3 experiments/rust-detector/check_parity.py "$CARGO_TARGET_DIR/release/monitor-detector-probe"
```

Do not commit build artifacts. If using Cargo's default target location, add `experiments/rust-detector/target/` to local Git excludes or set `CARGO_TARGET_DIR` outside tracked source.

Reproduce concurrent measurement while the production server listens on 3010:

```sh
python3 experiments/rust-detector/measure.py \
  .runtime/rust-comparison/target/release/monitor-detector-probe \
  .agent-logs/rust-comparison-results.json
```

`measure.py` starts only benchmark workers, waits 10s for history loading, samples parent CPU-time and RSS every 5s over two consecutive 60s windows, then lets workers exit. It also samples the existing full Python server separately. CPU percentages use one core as 100%; parent samples exclude `ps` child CPU. `/usr/bin/time -l` worker totals are retained as a supplementary whole-run resource measurement; do not confuse their start-to-exit interval with steady-window samples. Workers poll every 5s plus processing time, just like the production collector.

`--once` emits normalized state for deterministic fixture comparisons. `--processes FILE` and `--now EPOCH` are test fixture options only. Tests use temporary directories and do not fabricate events in production spools. Normal live benchmark output contains counts/timing only; no titles or prompts are copied into measurement artifacts.

Limitations: prototype skips malformed files, lacks production diagnostic reporting/notification dedup and bounded-I/O hardening, and has no UI integration. Existing completed sessions remain represented; no runtime eviction was added. Passing state fixtures does not establish full production equivalence. Follow-up migration would need complete Codex/server parity and workload benchmarks first.

## Observed result (2026-10-14, Apple Silicon macOS)

Two consecutive 60s steady windows, after 10s warmup, both probes 28 polls/86 final sessions:

| Implementation | Mean parent CPU (one core=100%) | Mean RSS |
| --- | ---: | ---: |
| Rust same-subset probe | 0.1583% | 6.764MiB |
| Python same-subset production detector | 0.2000% | 17.844MiB |
| Full Python server (reference, different scope) | 0.6500% | 33.695MiB |

Same-subset RSS was ~62% lower. Whole-run `/usr/bin/time -l` CPU including subprocesses and startup: Rust1.5030% vs Python1.5757% over137.72s; this smaller difference shows shared external process-query overhead remains. These short live samples do not establish full-server Rust resource usage or long-term peaks. A migration cannot claim the whole server would use6.8MiB.

Source, parity fixtures and measurement scripts are in this directory; detailed logs and raw samples are in `.agent-logs/2026-10-14--rust-detector-comparison/`. Rust3 incremental/process tests and21 normalized Python/Rust parity cases passed. Benchmarks exit automatically; production server remains unchanged.
