# Work Station

Cross-platform desktop hub for managing multiple Claude Code / Kimi / Codex terminal sessions across projects.

> Personal-use, single-user tool. Private repo, unsigned builds, no telemetry, no auto-updater. See [`PROJECT_PLAN.md`](./PROJECT_PLAN.md) for the full scope and roadmap.

## Stack

- **Shell:** Tauri 2.0 (Rust + native WebView)
- **Frontend:** Solid.js + TypeScript + Vite
- **Terminal:** xterm.js 5 + WebGL renderer
- **PTY:** `portable-pty` (ConPTY on Windows, forkpty on macOS)
- **Storage:** SQLite via `tauri-plugin-sql`

## Status

v0.1 in progress — see Phase tracker in `PROJECT_PLAN.md`.

## Develop

> Tauri toolchain (Rust 1.77+, pnpm, platform deps) is set up in T1.2.

```bash
pnpm install
pnpm tauri dev
```

## Layout

```
work-station/
├── PROJECT_PLAN.md           Plan, decisions, phase tasks
├── DESIGN_PROMPT.md          Phase 1 design brief
├── DESIGN_PROMPT_PHASE2.md   Phase 2 design brief
├── work-station-design/      Interactive React prototype (canonical UX reference)
├── src/                      Solid.js frontend (added in T1.2)
└── src-tauri/                Rust backend (added in T1.2)
```

## Conventions

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/) — enforced by `.githooks/commit-msg`.
- Branch protection on `master`: PR + linear history required.
