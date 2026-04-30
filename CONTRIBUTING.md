# Contributing to Work Station

Thanks for your interest in contributing! This guide covers everything you need to get the project running locally.

## Prerequisites

### Required

| Tool | Version | Purpose |
|------|---------|---------|
| [Rust](https://rustup.rs/) | 1.80+ | Tauri backend, PTY core |
| [Node.js](https://nodejs.org/) | 20.x LTS | Frontend build tooling |
| [pnpm](https://pnpm.io/installation) | 9.x | Package manager (required) |

### Platform Dependencies

**macOS** (12+, Apple Silicon or Intel)

```bash
# Xcode Command Line Tools
xcode-select --install
```

**Windows** (10 1809+ / 11, x64 or ARM64)

- [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) with **Desktop development with C++** workload
- WebView2 runtime (pre-installed on Windows 11, [download for Windows 10](https://developer.microsoft.com/en-us/microsoft-edge/webview2/))

**Linux** (community-supported)

```bash
# Debian/Ubuntu
sudo apt update
sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev
```

## Quickstart

```bash
# 1. Clone the repo
git clone https://github.com/beqolozi/work-station.git
cd work-station

# 2. Configure git hooks
git config core.hooksPath .githooks

# 3. Install frontend dependencies
pnpm install

# 4. Run in dev mode (hot-reload frontend, Rust rebuilds automatically)
pnpm tauri dev
```

The app window should appear within 10–30 seconds. The first build compiles Rust dependencies which takes a while; subsequent starts are much faster.

## Project Structure

```
work-station/
├── src/                    # Frontend (Solid.js + TypeScript)
│   ├── components/         # Reusable UI components
│   ├── routes/             # Page-level route components
│   ├── stores/             # Solid.js reactive stores
│   ├── ipc/                # Tauri IPC wrappers
│   ├── styles/             # Global CSS, Tailwind imports
│   ├── App.tsx             # Root component
│   └── index.tsx           # Entry point
├── src-tauri/              # Backend (Rust)
│   ├── src/
│   │   ├── pty/            # PTY session manager
│   │   ├── db/             # SQLite schema & migrations
│   │   ├── commands/       # Tauri command handlers
│   │   ├── ipc/            # Binary IPC channels
│   │   ├── lib.rs          # Tauri builder & plugin init
│   │   └── main.rs         # Entry point
│   ├── Cargo.toml          # Rust dependencies
│   └── tauri.conf.json     # Tauri config
├── src-tauri/icons/        # App icons
├── public/                 # Static assets
├── dist/                   # Build output (gitignored)
├── .githooks/              # Git hooks (conventional commits)
├── PROJECT_PLAN.md         # Full roadmap & task breakdown
└── CONTRIBUTING.md         # This file
```

## Development Workflow

### Scripts

```bash
# Frontend dev server only (no Tauri window)
pnpm dev

# Full Tauri dev mode (recommended)
pnpm tauri dev

# Production build
pnpm tauri build

# Lint & format
pnpm lint          # ESLint check
pnpm lint:fix      # ESLint auto-fix
pnpm format        # Prettier format all files
pnpm format:check  # Prettier check (CI)
```

### Rust commands

```bash
# Run from src-tauri/
cd src-tauri

cargo check              # Fast compile check
cargo clippy             # Lint
cargo test               # Run Rust tests
cargo build --release    # Release build
```

### Conventional Commits

This repo enforces [Conventional Commits](https://www.conventionalcommits.org/) via a git hook. Commit messages must follow:

```
type(scope)?: subject
```

Valid types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`

Examples:

```bash
git commit -m "feat(pty): add scrollback buffer eviction"
git commit -m "fix(ui): prevent terminal remount on resize"
git commit -m "docs: update macOS build instructions"
```

If you see `❌ Invalid commit message format.`, amend your message:

```bash
git commit --amend
```

## Technology Overview

| Layer | Technology | Notes |
|-------|-----------|-------|
| **Desktop shell** | Tauri 2.0 | Rust core + native WebView |
| **Frontend framework** | Solid.js 1.9 | Reactive, no VDOM, fast |
| **Styling** | Tailwind CSS 4 | Utility-first |
| **UI primitives** | Kobalte | Accessible headless components |
| **Terminal** | xterm.js 5 + WebGL addon | Canvas-based rendering |
| **PTY backend** | `portable-pty` | ConPTY on Windows, forkpty on macOS |
| **Async runtime** | tokio | For PTY I/O and IPC channels |
| **Storage** | SQLite | `tauri-plugin-sql` |
| **Build tool** | Vite 6 | Fast HMR for frontend |

## Common Issues

### `pnpm tauri dev` hangs on first run

The initial Rust compilation can take 2–5 minutes. No output is normal — Cargo is downloading and compiling dependencies. Be patient.

### macOS: "cannot be opened because the developer cannot be verified"

Right-click the built `.app` → Open, or run:

```bash
xattr -dr com.apple.quarantine src-tauri/target/debug/bundle/macos/Work\ Station.app
```

### Windows: WebView2 not found

Install the [WebView2 Evergreen Bootstrapper](https://developer.microsoft.com/en-us/microsoft-edge/webview2/).

### Frontend changes not reflecting

Tauri dev mode proxies the Vite dev server. If HMR breaks, restart `pnpm tauri dev`.

### Rust code changes not reflecting

Tauri's CLI watches `src-tauri/src/` and rebuilds automatically. If it doesn't trigger, save any file in that directory or restart the dev command.

## Architecture Notes

- **PTY sessions live in Rust**, not the frontend. The frontend only attaches/detaches to existing sessions via IPC.
- **Sessions survive app reloads** in dev mode (intentional — PTY processes outlive the WebView).
- **Project switching is state-only** — all PTYs stay alive in the backend; only the layout tree changes.
- **Scrollback is capped** per session (configurable, default ~10MB) with ring-buffer eviction.

See [PROJECT_PLAN.md](./PROJECT_PLAN.md) for the full task breakdown and design decisions.

## Code Style

- **TypeScript**: Strict mode, no implicit `any`. Prefer `type` over `interface` for simple shapes.
- **Rust**: Follow `cargo fmt` + `cargo clippy`. Prefer `?` over `match` for error propagation.
- **Solid.js**: Use fine-grained reactivity (`createSignal`, `createMemo`) over derived stores where possible.
- **Tailwind**: Use design tokens from `src/styles/`; avoid arbitrary values.

## Release Setup (maintainers only)

The [Release workflow](.github/workflows/release.yml) builds signed binaries and publishes them to GitHub Releases. It requires these repository secrets:

| Secret | Purpose |
|--------|---------|
| `TAURI_SIGNING_PRIVATE_KEY` | Updater signing private key (contents of `.tauri-updater.key`) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for the signing key (if set) |
| `WINDOWS_CERTIFICATE` | Base64-encoded Windows Authenticode cert (optional) |
| `WINDOWS_CERTIFICATE_PASSWORD` | Password for the Windows cert (optional) |

To extract the signing key for GitHub Secrets:

```bash
cat src-tauri/.tauri-updater.key | pbcopy   # macOS
# Paste into Settings → Secrets and variables → Actions → New repository secret
```

## Before Submitting

```bash
# Run the full check suite
pnpm lint && pnpm format:check
cd src-tauri && cargo clippy && cargo test
```

## Questions?

Open a [GitHub Discussion](https://github.com/beqolozi/work-station/discussions) or check [PROJECT_PLAN.md](./PROJECT_PLAN.md) for context on current work.
