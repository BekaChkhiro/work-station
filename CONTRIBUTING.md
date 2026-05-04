# Contributing to Work Station

This project is a personal-use Tauri 2.x desktop app. The build supports **macOS (arm64 + x64 universal)** and **Windows 10/11 (x64)**. Linux is not a target. Builds are unsigned — see [`PROJECT_PLAN.md`](./PROJECT_PLAN.md) Phase 9 for the build matrix and Phase 10 for validation.

## Quickstart

```bash
git clone <repo-url> work-station && cd work-station
git config core.hooksPath .githooks   # enable pre-commit + commit-msg gates
pnpm install
pnpm tauri dev
```

First `pnpm tauri dev` compiles the Tauri 2.x dependency graph (~2–4 min on a warm cache, longer cold). Subsequent runs are incremental.

**Smoke test:** a 1280×800 native window opens with the placeholder app and the Vite "ready in <ms>" line in the terminal. Editing `src/App.tsx` should hot-reload in place.

If you don't have the platform deps yet, jump to [Platform dependencies](#platform-dependencies) below before running `pnpm install`.

## Toolchain matrix

| Tool  | Version | Why                                       |
| ----- | ------- | ----------------------------------------- |
| Node  | 20 LTS+ | Vite 6 / Solid ecosystem                  |
| pnpm  | 10+     | Lockfile + workspace discipline           |
| Rust  | 1.77+   | Tauri 2.11 MSRV (stable channel)          |
| Tauri | 2.11.0  | Pinned in `Cargo.toml` and `package.json` |

Toolchain pins are intentional — Tauri-side bumps go through a manual PR.

## Platform dependencies

### macOS (arm64 + x64 universal)

1. **Xcode Command Line Tools** — provides `clang`, `ld`, system SDK headers:
   ```bash
   xcode-select --install
   ```
2. **Rust stable + both Apple targets** — universal binary requires both:
   ```bash
   rustup install stable
   rustup target add aarch64-apple-darwin x86_64-apple-darwin
   ```
3. **Node + pnpm**:
   ```bash
   brew install node pnpm
   ```

Build:

```bash
pnpm install
pnpm tauri build --target universal-apple-darwin
```

Artifacts land in `src-tauri/target/universal-apple-darwin/release/bundle/`:

- `macos/Work Station.app` — drag-installable bundle
- `dmg/Work Station_<version>_universal.dmg` — disk image installer

Because builds are unsigned, the first launch on a fresh machine requires:
**Finder → Applications → right-click the app → Open → Open Anyway** (one time per install).

### Windows 10 / 11 (x64)

1. **Microsoft C++ Build Tools** — install "Desktop development with C++" workload from the [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) installer. Required components: MSVC v143 toolset, Windows 11 SDK.
2. **WebView2 Runtime** — preinstalled on Windows 11; on Windows 10 install the [Evergreen Standalone Installer](https://developer.microsoft.com/microsoft-edge/webview2/) if missing.
3. **Rust stable + MSVC target**:
   ```powershell
   rustup install stable
   rustup default stable-x86_64-pc-windows-msvc
   ```
4. **Node + pnpm** — install Node 20 LTS from [nodejs.org](https://nodejs.org/) or `winget install OpenJS.NodeJS.LTS`, then `npm install -g pnpm`.

Build:

```powershell
pnpm install
pnpm tauri build
```

Artifacts land in `src-tauri\target\release\bundle\`:

- `msi\Work Station_<version>_x64_en-US.msi`
- `nsis\Work Station_<version>_x64-setup.exe`

Unsigned `.msi` and `.exe` will trigger SmartScreen on first run:
**More info → Run anyway** (one time per build).

> Public CI matrix lives in `.github/workflows/` (see T9.1) — local Windows builds are only needed for one-off verification.

## Development scripts

| Command                                                                                                                                                  | What it does                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `pnpm dev`                                                                                                                                               | Vite-only dev server (no Tauri shell)                                                          |
| `pnpm tauri dev`                                                                                                                                         | Tauri shell + Vite HMR (the usual workflow)                                                    |
| `pnpm tauri build`                                                                                                                                       | Release bundle for the host platform                                                           |
| `pnpm typecheck`                                                                                                                                         | `tsc --noEmit` — strict TS (incl. `noUncheckedIndexedAccess`)                                  |
| `pnpm lint`                                                                                                                                              | ESLint v9 flat config (typescript-eslint strict + Solid + Prettier)                            |
| `pnpm lint:fix`                                                                                                                                          | ESLint with auto-fix                                                                           |
| `pnpm format:check`                                                                                                                                      | Prettier check across the repo                                                                 |
| `pnpm format`                                                                                                                                            | Prettier write                                                                                 |
| `cargo fmt --check`                                                                                                                                      | rustfmt gate (run inside `src-tauri/`)                                                         |
| `cargo clippy ... -D warnings`                                                                                                                           | clippy::all + clippy::pedantic, errors-as-failures                                             |
| `cargo llvm-cov --lib --ignore-filename-regex '(cli/\|commands/(log\|mod)\.rs\|db/\|ipc/\|lib\.rs\|logging\.rs\|main\.rs\|menu/)' --fail-under-lines 80` | T2.13 coverage gate — pty/ + commands/pty.rs ≥80% lines (CI: `.github/workflows/coverage.yml`) |

## Repository layout

```
work-station/
├── PROJECT_PLAN.md           Plan of record — phases, tasks, decisions
├── DESIGN_PROMPT.md          Phase 1 design brief
├── DESIGN_PROMPT_PHASE2.md   Phase 2 design brief
├── work-station-design/      Interactive React prototype (canonical UX reference)
├── AGENTS.md                 Contract for AI-assisted contributors
├── src/                      Solid.js frontend
│   └── {components,db,ipc,routes,stores,styles,types,utils}
└── src-tauri/
    └── src/{cli,commands,db,ipc,menu,pty}
```

The interactive design prototype in `work-station-design/` is the canonical visual + interaction reference for v0.1. When the implementation could go either way, match the prototype. See `PROJECT_PLAN.md` §1.5 for the task → component mapping.

## Git hooks

Hooks live in `.githooks/`. The Quickstart already wires `core.hooksPath` — if you cloned before adding it, run:

```bash
git config core.hooksPath .githooks
```

- `pre-commit` — Prettier + ESLint on staged frontend files; `cargo fmt --check` on staged Rust.
- `commit-msg` — Conventional Commits format check (max 72-char subject).

Bypass with `--no-verify` only when truly necessary (e.g. WIP commits on a personal branch).

## Troubleshooting

| Symptom                                                          | Fix                                                                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `error: linker 'cc' not found` (macOS)                           | Run `xcode-select --install`.                                                                                       |
| `error: toolchain 'stable-x86_64-apple-darwin' is not installed` | `rustup target add x86_64-apple-darwin` (needed for universal builds).                                              |
| `link.exe not found` (Windows)                                   | Install the Visual Studio Build Tools "Desktop development with C++" workload, restart shell.                       |
| `WebView2Loader.dll` errors at runtime (Windows)                 | Install the WebView2 Evergreen Runtime.                                                                             |
| `pnpm tauri build` succeeds but `.app` won't open ("damaged")    | macOS quarantines unsigned bundles. Right-click → Open → Open Anyway, or `xattr -dr com.apple.quarantine <app>`.    |
| Slow rebuilds                                                    | First build of any target is cold; the Rust cache lives in `src-tauri/target/`. Don't delete it between dev cycles. |

## Conventions

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/) — enforced by `.githooks/commit-msg`.
- Branch protection on `master`: PR + linear history required.
- Tauri / Solid / xterm dependencies are pinned exactly (no `^` / no `~`). Bumps go through a manual PR with a build verification on both platforms.
