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

Toolchain (macOS):

- Rust 1.77+ (stable) — `rustup install stable`
- Node 20+ and pnpm 10+
- Xcode Command Line Tools — `xcode-select --install`

```bash
pnpm install
pnpm tauri dev
```

The first `pnpm tauri dev` compiles the Tauri 2.x dependency tree (~2–4 min). Subsequent runs are incremental. Vite HMR is wired — edits to `src/**` reload in place.

Tauri and core frontend deps are pinned to exact versions (no `^` / no `~`). Bumps go through a manual PR.

## Layout

```
work-station/
├── PROJECT_PLAN.md           Plan, decisions, phase tasks
├── DESIGN_PROMPT.md          Phase 1 design brief
├── DESIGN_PROMPT_PHASE2.md   Phase 2 design brief
├── work-station-design/      Interactive React prototype (canonical UX reference)
├── index.html                Vite entry
├── vite.config.ts            Vite + Solid plugin config
├── tsconfig.json             TS strict mode (frontend)
├── src/                      Solid.js frontend
│   ├── index.tsx             Solid render bootstrap
│   ├── App.tsx, App.css      Placeholder app (replaced in later tasks)
│   └── assets/
└── src-tauri/                Rust backend
    ├── Cargo.toml            Pinned: tauri 2.11.0, tauri-build 2.6.0
    ├── tauri.conf.json       App config (1280×800, identifier com.workstation.dev)
    ├── capabilities/         Window permissions
    ├── icons/                Bundle icons
    └── src/{main,lib}.rs     Entry + greet command stub
```

## Conventions

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/) — enforced by `.githooks/commit-msg`.
- Branch protection on `master`: PR + linear history required.
