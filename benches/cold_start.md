# Cold start benchmark (T10.2)

`hyperfine --warmup 3 -r 10` against the release binary, with the
`WS_BENCH_EXIT=1` env var set so the app tears down on first paint
(see `src-tauri/src/lib.rs`).

## Targets

| Metric                                      | Baseline | Stretch |
| ------------------------------------------- | -------- | ------- |
| Cold start (signed binary, warm disk cache) | < 800ms  | < 500ms |

Source: `PROJECT_PLAN.md` §2 and T10.2 acceptance.

If a run is over 800ms we profile (`tracing` spans for `cli_handle`
populate + `db::run_migrations`) and fix before declaring v0.1 ready.

## How "cold start" is measured

`hyperfine` measures process spawn → exit. A GUI app doesn't exit on
its own, so we wired a one-line bench hook into the Tauri builder:

In `src-tauri/src/lib.rs`, `Builder::on_page_load` checks
`WS_BENCH_EXIT` once and, when set, calls `app_handle().exit(0)` on
the main webview's `PageLoadEvent::Finished`. That event fires after
the webview's `load` — i.e. once `index.html`, `index-*.css`, and the
Solid bundle have been parsed and the top-level `render()` has run.

So each `hyperfine` sample covers: process spawn → Tauri init →
webview spin-up → JS/CSS bundle parse → first Solid render →
webview `load` → process exit.

The PTY scan and DB migrations run in background `async_runtime`
tasks and do **not** gate the exit; that's intentional — cold-start
UX is "when the window is usable", not "when every async finishes".

> `WS_BENCH_EXIT` is unset in shipped builds. The `on_page_load`
> callback then reads the env var once at startup, finds it absent,
> and the per-load closure is a single boolean check + branch.

## How to run

### macOS

```sh
brew install hyperfine
./scripts/bench/cold_start.sh
```

The script runs `hyperfine --warmup 3 -r 10` on the release binary
under `src-tauri/target/release/work-station` with
`WS_BENCH_EXIT=1`. Build it first via `pnpm tauri build --no-bundle`
if it isn't present.

### Windows

```pwsh
scoop install hyperfine
./scripts/bench/cold_start.ps1
```

Same idea against `src-tauri\target\release\work-station.exe`.

## Results

Each entry: machine, OS, app version, hyperfine `mean ± σ` and
`min..max` in ms.

| Date       | Machine                        | OS         | App   | min    | mean ± σ    | max    | Verdict    |
| ---------- | ------------------------------ | ---------- | ----- | ------ | ----------- | ------ | ---------- |
| 2026-05-11 | MacBook (Apple Silicon, arm64) | macOS 26.3 | 0.3.1 | 388 ms | 416 ± 16 ms | 443 ms | ✅ stretch |
| _pending_  | Windows dev box                | Windows 11 | 0.3.1 | –      | –           | –      | –          |

### Run log

```
# 2026-05-11, MacBook (arm64), macOS 26.3, work-station 0.3.1
$ ./scripts/bench/cold_start.sh
Benchmark 1: /Users/beqolozi/Desktop/work-station/src-tauri/target/release/work-station
  Time (mean ± σ):     416.4 ms ±  16.1 ms    [User: 213.4 ms, System: 143.4 ms]
  Range (min … max):   388.4 ms … 443.0 ms    10 runs
```
