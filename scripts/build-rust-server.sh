#!/usr/bin/env bash
set -euo pipefail
monitor_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -x "$monitor_root/.runtime/rust-comparison/cargo/bin/cargo" ]]; then
  export CARGO_HOME="$monitor_root/.runtime/rust-comparison/cargo"
  export RUSTUP_HOME="$monitor_root/.runtime/rust-comparison/rustup"
  monitor_cargo="$CARGO_HOME/bin/cargo"
else
  monitor_cargo="$(command -v cargo || true)"
fi
if [[ -z "$monitor_cargo" ]]; then
  echo 'Install Rust using https://rust-lang.org/tools/install/ first.' >&2
  exit 1
fi
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$monitor_root/.runtime/rust-server-target}"
if [[ "${1:-}" == '--test' ]]; then
  "$monitor_cargo" test --release --locked --manifest-path "$monitor_root/rust-server/Cargo.toml"
fi
"$monitor_cargo" build --release --locked --manifest-path "$monitor_root/rust-server/Cargo.toml"
printf 'Binary: %s\n' "$CARGO_TARGET_DIR/release/local-monitor-rust"
