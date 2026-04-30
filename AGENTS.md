# Agent Context — Work Station

> This file helps coding agents understand the project quickly. Keep it updated when architecture or conventions change.

## What is this?

A cross-platform desktop app for managing multiple Claude Code / Kimi / Codex terminal sessions across projects. Think of it as a project-aware terminal multiplexer with a native UI.

## Key Architectural Decisions

1. **PTY lives in Rust, frontend is dumb** — The Solid.js frontend only renders terminals and sends keystrokes. All session management, process lifecycle, and scrollback storage is in Rust.
2. **Sessions outlive the UI** — PTY processes survive WebView reloads. This is by design for dev workflow comfort.
3. **Project switching is instant** — Switching projects just swaps the layout tree; all PTYs keep running in the background.
4. **Binary IPC for terminal data** — PTY output flows via Tauri `Channel<Bytes>`, not JSON strings, for performance.
5. **SQLite for persistence** — Projects, sessions, layouts, and settings all live in a local SQLite DB.

## Stack (Agent Reference)

| Layer | Tech |
|-------|------|
| Shell | Tauri 2.0 |
| Frontend | Solid.js 1.9 + TypeScript |
| Styling | Tailwind CSS 4 + Kobalte primitives |
| Terminal | xterm.js 5 + WebGL addon |
| PTY | `portable-pty` crate (Rust) |
| Async | tokio |
| Storage | SQLite via `tauri-plugin-sql` |
| Build | Vite 6 |

## Folder Conventions

```
src/
  components/     # Reusable Solid components
  routes/         # Page/route-level components
  stores/         # Solid signals/stores (reactive state)
  ipc/            # Tauri invoke wrappers, typed IPC helpers
  styles/         # Tailwind entry + CSS tokens

src-tauri/src/
  pty/            # PtySession, PtyManager, reader tasks
  db/             # Schema, migrations, query helpers
  commands/       # #[tauri::command] handlers
  ipc/            # Binary channel setup, Bytes serialization
```

## Coding Conventions

- **TypeScript strict mode**, no implicit `any`
- Prefer `type` over `interface` for simple shapes
- **Rust**: `cargo fmt` + `cargo clippy` compliant
- Solid.js: fine-grained reactivity preferred (`createSignal`, `createMemo`)
- Tailwind: use design tokens, avoid arbitrary values like `w-[123px]`
- **Commits**: Conventional Commits enforced via `.githooks/commit-msg`

## Important Files

- `PROJECT_PLAN.md` — Full roadmap with 92 tasks across 10 phases
- `tauri.conf.json` — Window config, bundle settings, security CSP
- `Cargo.toml` — Rust deps (add PTY-related crates here)
- `package.json` — Frontend deps (add xterm.js addons here)

## Development Commands

```bash
pnpm tauri dev      # Full dev mode
pnpm dev            # Frontend only
pnpm lint           # ESLint
cargo test          # Rust tests (in src-tauri/)
```

## Notes for Agents

- When adding a new Tauri command, wire it in `src-tauri/src/lib.rs` in the `.invoke_handler()` builder.
- When adding IPC channels, define types in both Rust and `src/ipc/` for type safety.
- The project is early-stage (Phase 1). Many folders under `src-tauri/src/` are scaffolded but empty.
- Tests: Rust tests go in `src-tauri/src/` as inline `#[cfg(test)]` modules. Frontend tests are not yet set up.
