#!/usr/bin/env bash
# T10.2: cold-start benchmark on macOS via hyperfine.
# Requires `hyperfine` (brew install hyperfine) and a release build in
# src-tauri/target/release/work-station. Builds it if missing.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BIN="$REPO_ROOT/src-tauri/target/release/work-station"

if ! command -v hyperfine >/dev/null 2>&1; then
  echo "hyperfine not found. Install: brew install hyperfine" >&2
  exit 1
fi

if [[ ! -x "$BIN" ]]; then
  echo "release binary missing; running 'pnpm tauri build'..." >&2
  (cd "$REPO_ROOT" && pnpm tauri build)
fi

export WS_BENCH_EXIT=1
hyperfine --warmup 3 -r 10 --shell=none "$BIN"
