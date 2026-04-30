# Work Station — Project Plan

> Cross-platform desktop hub for managing multiple Claude Code / Kimi / Codex terminal sessions across projects. Built for raw performance and daily-driver comfort.

## Stack

- **Shell:** Tauri 2.0 (Rust core + native WebView)
- **Frontend:** Solid.js + TypeScript + Vite + Tailwind CSS
- **Terminal:** xterm.js 5 + WebGL renderer addon
- **PTY:** `portable-pty` crate (Rust, ConPTY on Windows / forkpty on macOS)
- **Async runtime:** tokio
- **Storage:** SQLite via `tauri-plugin-sql`
- **Auto-update:** `tauri-plugin-updater`
- **CI/CD:** GitHub Actions → signed `.dmg` (mac) + `.msi` (Windows)

## Targets

- macOS 12+ (Apple Silicon + Intel universal binary)
- Windows 10 1809+ / Windows 11 (x64 + ARM64)
- Cold start: < 500ms
- RAM with 10 active terminals: < 300MB
- 60fps terminal rendering under heavy output

---

## Tasks & Implementation Plan

### Phase 1 — Foundation & Scaffolding

Bootstrap the repo, dev environment, and bare Tauri+Solid app that opens an empty window cross-platform.

#### T1.1: Initialize repository

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: None
- **Description**:
  - Initialize git repo, `.gitignore`, MIT license, README skeleton
  - Branch protection on `main`, conventional-commits hook

#### T1.2: Scaffold Tauri 2.0 + Solid.js

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T1.1
- **Description**:
  - Run `pnpm create tauri-app` with Solid + TypeScript template
  - Verify dev mode runs on macOS

#### T1.3: Tooling — TypeScript, ESLint, Prettier

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T1.2
- **Description**:
  - TS strict mode, no implicit any
  - ESLint + Prettier with shared config, husky pre-commit

#### T1.4: Design system foundation

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T1.2
- **Description**:
  - Add Tailwind CSS, Radix primitives
  - Define design tokens: colors, spacing, typography, motion

#### T1.5: Folder structure

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T1.2
- **Description**:
  - `src-tauri/src/{pty,db,commands,ipc}`
  - `src/{components,stores,ipc,routes}`

#### T1.6: Cross-platform build verification

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T1.2
- **Description**:
  - Build runs on macOS (arm64 + x64)
  - Build runs on Windows 10/11 VM (x64)

#### T1.7: Developer documentation

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T1.6
- **Description**:
  - `CONTRIBUTING.md` with Rust toolchain, pnpm, platform deps
  - Quickstart for first-time contributors

---

### Phase 2 — PTY Core (Rust Backend)

Build the persistent session manager. PTYs live in Rust, frontend just attaches/detaches.

#### T2.1: Add PTY dependencies

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T1.5
- **Description**:
  - Add `portable-pty`, `tokio`, `bytes`, `uuid`, `serde` to `Cargo.toml`

#### T2.2: PtySession struct

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T2.1
- **Description**:
  - Fields: PID, master PTY handle, stdin writer, output channel
  - Drop impl for graceful cleanup

#### T2.3: PtyManager registry

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T2.2
- **Description**:
  - `HashMap<Uuid, PtySession>` behind tokio async lock
  - Lifetime tied to app, not window

#### T2.4: PTY reader task with output coalescing

- [ ] **Status**: TODO
- **Complexity**: High
- **Dependencies**: T2.3
- **Description**:
  - Spawn dedicated tokio task per session
  - Read PTY into buffer, flush every 8–16ms
  - Emit batched bytes via Tauri Channel

#### T2.5: pty_spawn command

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T2.3
- **Description**:
  - Args: cwd, command, env, cols, rows
  - Returns session UUID

#### T2.6: pty_write command

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T2.5
- **Description**:
  - Forwards raw bytes to PTY stdin

#### T2.7: pty_resize command

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T2.5
- **Description**:
  - Args: session_id, cols, rows
  - Calls `master.resize()`

#### T2.8: pty_kill with graceful shutdown

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T2.5
- **Description**:
  - SIGTERM → wait 2s → SIGKILL
  - Removes session from registry

#### T2.9: Persistent scrollback buffer

- [ ] **Status**: TODO
- **Complexity**: High
- **Dependencies**: T2.4
- **Description**:
  - `VecDeque<Bytes>` per session
  - Capped at configurable MB, ring-buffer eviction

#### T2.10: pty_get_scrollback command

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T2.9
- **Description**:
  - Args: session_id, offset, limit
  - Used on terminal mount to replay history

#### T2.11: Binary IPC for PTY data

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T2.4
- **Description**:
  - Use Tauri `Channel<Bytes>` instead of base64 strings
  - Benchmark vs JSON to confirm speedup

#### T2.12: Detached PTY survival

- [ ] **Status**: TODO
- **Complexity**: High
- **Dependencies**: T2.3
- **Description**:
  - Proof of concept: PTY survives app reload (dev refresh)
  - Document limitations on Windows

#### T2.13: PTY unit tests

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T2.8, T2.10
- **Description**:
  - Spawn, write, resize, kill, scrollback eviction
  - Cross-platform (cargo test on mac + win)

#### T2.14: PTY smoke tests

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T2.13
- **Description**:
  - Run `htop`, `vim`, `claude`, `pwsh`
  - Verify ANSI colors, alt-buffer, resize behavior

---

### Phase 3 — Database & Project Management

SQLite schema for projects, sessions, layouts. CRUD commands.

#### T3.1: SQLite plugins

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T1.5
- **Description**:
  - Add `tauri-plugin-sql` (SQLite feature) and `tauri-plugin-store`

#### T3.2: Projects table schema

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T3.1
- **Description**:
  - `projects(id, name, path, color, icon, default_cli, env_json, position, created_at)`

#### T3.3: Sessions table schema

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T3.2
- **Description**:
  - `sessions(id, project_id, title, cli, cwd, layout_json, created_at)`
  - Layout JSON stores tree of splits + pane → session_id mapping

#### T3.4: App settings schema

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T3.1
- **Description**:
  - `app_settings(key, value)` for theme, hotkeys, last-active project

#### T3.5: Migration runner

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T3.2, T3.3, T3.4
- **Description**:
  - Versioned SQL migrations executed on app boot
  - Rollback strategy documented

#### T3.6: Project CRUD commands

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T3.5
- **Description**:
  - `project_list`, `project_create`, `project_update`, `project_delete`
  - All input validated

#### T3.7: Folder picker integration

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T3.6
- **Description**:
  - `tauri-plugin-dialog` for native folder picker
  - Returns absolute path

#### T3.8: Project validation rules

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T3.6
- **Description**:
  - Name 1–80 chars, no duplicates
  - Path exists and is a directory

---

### Phase 4 — Terminal UI (Solid + xterm.js)

Solid wrapper around xterm.js with WebGL renderer. Connect to backend via IPC.

#### T4.1: Install xterm.js + addons

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T1.4
- **Description**:
  - `@xterm/xterm`, `@xterm/addon-webgl`, `@xterm/addon-fit`, `@xterm/addon-search`, `@xterm/addon-web-links`

#### T4.2: Terminal Solid component

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T4.1
- **Description**:
  - Mount xterm.js on `<div ref>`, dispose on unmount
  - Pass session ID prop

#### T4.3: WebGL renderer with canvas fallback

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T4.2
- **Description**:
  - WebGL addon as default
  - Detect context loss, swap to canvas, log warning

#### T4.4: Subscribe to PTY output

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T4.2, T2.11
- **Description**:
  - Subscribe to backend Channel
  - Streaming-safe UTF-8 decode (handle split codepoints)

#### T4.5: Forward keystrokes to PTY

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T4.2, T2.6
- **Description**:
  - xterm.js `onData` → `pty_write` IPC

#### T4.6: Auto-resize via ResizeObserver

- [x] **Status**: DONE
- **Complexity**: Medium
- **Dependencies**: T4.2, T2.7
- **Description**:
  - ResizeObserver on container
  - `fit.fit()` then `pty_resize` (debounced)

#### T4.7: Scrollback replay on mount

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T4.4, T2.10
- **Description**:
  - Pull scrollback from backend before subscribing to live stream
  - Avoid duplicate rendering

#### T4.8: Theme integration

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T4.2, T1.4
- **Description**:
  - xterm theme follows app dark/light tokens
  - Reactive on theme change

#### T4.9: Copy / paste

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T4.2
- **Description**:
  - Cmd/Ctrl+C on selection, Cmd/Ctrl+V paste
  - Bracketed paste mode honored

#### T4.10: In-terminal search

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T4.1
- **Description**:
  - Cmd/Ctrl+F triggers search overlay
  - Uses search addon

#### T4.11: Clickable web links

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T4.1
- **Description**:
  - web-links addon
  - Cmd/Ctrl+click opens in default browser via Tauri shell

#### T4.12: Pause render when hidden

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T4.3
- **Description**:
  - Suspend WebGL render loop when terminal DOM is disconnected
  - PTY keeps running in backend

---

### Phase 5 — Layout Engine (Tabs + Splits)

Per-project tiling layout. Tabs at top, splits inside, drag-to-resize.

#### T5.1: LayoutNode type design

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T1.5
- **Description**:
  - Recursive: `{ type: 'split', direction, ratio, children }` or `{ type: 'pane', sessionId }`
  - Zod schema for validation

#### T5.2: SplitPane component

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T5.1
- **Description**:
  - Drag handle, controlled ratio, min/max constraints
  - Smooth resize without re-mounting children

#### T5.3: TabStrip per project

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T5.1
- **Description**:
  - Tabs list, active state, close button
  - Drag-to-reorder

#### T5.4: LayoutTree recursive renderer

- [ ] **Status**: TODO
- **Complexity**: High
- **Dependencies**: T5.2
- **Description**:
  - Walks LayoutNode tree, renders Splits/Panes
  - Stable keys to prevent terminal remount on resize

#### T5.5: Pane focus tracking

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T5.4
- **Description**:
  - Clicked pane = active
  - Focus ring border, captures hotkeys

#### T5.6: Split actions

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T5.5, T2.5
- **Description**:
  - Split active pane horizontally / vertically
  - New pane spawns PTY in same cwd, default CLI

#### T5.7: Close pane action

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T5.6, T2.8
- **Description**:
  - Kill PTY
  - Collapse split if 1 child remains, refocus sibling

#### T5.8: Layout persistence

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T5.4, T3.3
- **Description**:
  - Persist `layout_json` on every change (debounced 500ms)
  - Atomic write via SQLite transaction

#### T5.9: Layout restore on switch

- [ ] **Status**: TODO
- **Complexity**: High
- **Dependencies**: T5.8
- **Description**:
  - Recreate panes, attach to existing PTYs by session ID
  - Spawn missing sessions if PTY died

---

### Phase 6 — Sidebar & Navigation

Project list, quick-switcher, instant project switching without killing sessions.

#### T6.1: Sidebar component

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T3.6, T1.4
- **Description**:
  - Right-side panel per user request
  - List projects with active highlight, color/icon

#### T6.2: State-only project switching

- [ ] **Status**: TODO
- **Complexity**: High
- **Dependencies**: T6.1, T5.9
- **Description**:
  - Switching just swaps layout tree
  - All PTYs of all projects stay alive in backend

#### T6.3: Numeric hotkeys

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T6.2
- **Description**:
  - Cmd/Ctrl+1..9 jumps to project N

#### T6.4: Quick switcher modal

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T6.1
- **Description**:
  - Cmd/Ctrl+K opens fuzzy-search modal
  - Keyboard nav, Enter to select

#### T6.5: Add project flow

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T6.1, T3.7
- **Description**:
  - Form: name, folder picker, color, icon, default CLI
  - Validation + creates first session

#### T6.6: Edit / delete project

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T6.5
- **Description**:
  - Edit modal mirrors Add
  - Delete confirms + asks "kill running sessions?"

#### T6.7: Drag-to-reorder projects

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T6.1
- **Description**:
  - Drag handle in sidebar
  - Persist `position` column to SQLite

#### T6.8: Empty state

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T6.5
- **Description**:
  - Onboarding card when no projects exist
  - Direct CTA to "Add your first project"

---

### Phase 7 — CLI Integration (Claude Code / Kimi / Codex)

Detect CLIs, quick-launch presets, per-project defaults.

#### T7.1: Detect CLIs in PATH

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T2.5
- **Description**:
  - On boot scan for `claude`, `kimi`, `codex`, `bash`, `zsh`, `pwsh`
  - Resolve absolute paths

#### T7.2: cli_list_available command

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T7.1
- **Description**:
  - Returns array of `{ name, path, version }`

#### T7.3: Quick-launch dropdown per pane

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T7.2, T5.6
- **Description**:
  - "+ New terminal" button shows submenu of detected CLIs
  - Click spawns selected CLI in pane

#### T7.4: Per-project default CLI

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T7.3, T3.6
- **Description**:
  - Project setting `default_cli`
  - New panes auto-launch with this CLI

#### T7.5: Per-project env vars

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T3.6
- **Description**:
  - Editor for key/value pairs
  - Saved to SQLite, injected on spawn

#### T7.6: Per-project startup commands

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T7.5
- **Description**:
  - Optional pre-CLI commands (e.g. `nvm use 20`)
  - Run before main CLI in same shell

#### T7.7: CLI badge on tabs

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T7.4, T5.3
- **Description**:
  - Icon next to tab title indicating which CLI is running

---

### Phase 8 — Hotkeys, Theme & Polish

Make it feel native and fast on both platforms.

#### T8.1: Hotkey registry

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T1.5
- **Description**:
  - Centralized Solid store
  - Platform-aware modifier (Cmd vs Ctrl)

#### T8.2: Default keybindings

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T8.1
- **Description**:
  - Cmd+T new terminal, Cmd+\\ v-split, Cmd+Shift+\\ h-split
  - Cmd+W close pane, Cmd+1..9 project, Cmd+K switcher
  - Cmd+, settings, Cmd+F search

#### T8.3: Theme system

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T1.4
- **Description**:
  - Dark (default), light, system-follow
  - Reactive across all components incl. xterm.js

#### T8.4: Animations

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T1.4
- **Description**:
  - Tab switch, sidebar collapse, pane focus ring (200ms ease-out)
  - Respect `prefers-reduced-motion`

#### T8.5: Native menu bar (macOS)

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T8.2
- **Description**:
  - Tauri menu API
  - All commands + shortcuts mirrored in menu

#### T8.6: Window chrome

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T1.6
- **Description**:
  - macOS: traffic-light inset, hidden title bar
  - Windows: custom title bar with min/max/close

#### T8.7: Settings page

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T8.1, T8.3
- **Description**:
  - Hotkey rebinding, theme, default CLI, scrollback size
  - Backed by `app_settings` table

#### T8.8: App icon

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T1.6
- **Description**:
  - 1024×1024 master, generate iconset for both platforms
  - Tauri config wires icons

#### T8.9: Loading & empty states

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T6.8
- **Description**:
  - Skeleton loaders, friendly empty states everywhere

---

### Phase 9 — Build, Sign, Distribute

Cross-compile, sign, ship to both platforms.

#### T9.1: GitHub Actions matrix build

- [ ] **Status**: TODO
- **Complexity**: High
- **Dependencies**: T1.6
- **Description**:
  - Matrix: macOS (universal) + Windows (x64)
  - Cache Rust + pnpm

#### T9.2: macOS code signing + notarization

- [ ] **Status**: TODO
- **Complexity**: High
- **Dependencies**: T9.1
- **Description**:
  - Apple Developer ID cert
  - Notarize `.app`, staple to `.dmg`

#### T9.3: Windows Authenticode signing

- [ ] **Status**: TODO
- **Complexity**: High
- **Dependencies**: T9.1
- **Description**:
  - EV cert preferred for SmartScreen reputation
  - Sign `.exe` and `.msi`

#### T9.4: Auto-updater configuration

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T9.2, T9.3
- **Description**:
  - `tauri-plugin-updater` with signed manifest
  - Pubkey embedded in app

#### T9.5: Update server

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T9.4
- **Description**:
  - GitHub Releases as update source
  - Or self-hosted JSON manifest behind CDN

#### T9.6: Versioning automation

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T9.1
- **Description**:
  - Semver, script keeps Cargo.toml + package.json + tauri.conf.json in lockstep

#### T9.7: Changelog generation

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T9.6
- **Description**:
  - git-cliff or release-please
  - Auto-PR on tag

#### T9.8: Download / landing page

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T9.5
- **Description**:
  - Simple page with download buttons + SHA256 checksums
  - Optional, can defer to README links

---

### Phase 10 — QA, Performance Benchmarks & Launch

Validate targets, fix regressions, dogfood, release v0.1.0.

#### T10.1: QA matrix

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T9.5
- **Description**:
  - macOS 14/15 (Apple Silicon + Intel)
  - Windows 10/11 (x64 + ARM64)

#### T10.2: Cold start benchmark

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T10.1
- **Description**:
  - `hyperfine` on signed binaries
  - Target < 500ms

#### T10.3: RAM benchmark

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T10.1
- **Description**:
  - 10 active terminals
  - Target < 300MB RSS

#### T10.4: Output stress test

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T10.1
- **Description**:
  - Dump 1GB output via `cat large.log`
  - Verify 60fps, no main-thread freezes

#### T10.5: Long-running leak test

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T10.1
- **Description**:
  - 5 sessions open for 24h
  - Track RSS growth, file handles, GPU memory

#### T10.6: Crash recovery

- [ ] **Status**: TODO
- **Complexity**: High
- **Dependencies**: T10.1
- **Description**:
  - Force-kill mid-session
  - Relaunch: layout restored, sessions reattached if possible

#### T10.7: Accessibility pass

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T8.7
- **Description**:
  - Keyboard-only nav for every feature
  - Screen reader sanity check on key screens

#### T10.8: Dogfood week

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T10.1
- **Description**:
  - Use as daily driver for 1 week
  - Log all friction in GitHub Issues

#### T10.9: v0.1.0 release

- [ ] **Status**: TODO
- **Complexity**: Low
- **Dependencies**: T10.8
- **Description**:
  - Tag, publish GitHub Release with signed installers
  - Announce

#### T10.10: Telemetry foundation

- [ ] **Status**: TODO
- **Complexity**: Medium
- **Dependencies**: T10.9
- **Description**:
  - Opt-in anonymous crash + perf telemetry
  - Privacy-first: no command/output content

---

## Stretch / Post-v0.1.0

Ideas that are explicitly out of scope for the first release.

- Cloud sync of project list across machines
- SSH host support (remote PTY sessions)
- AI command suggestions in a side panel
- Workspace export/import (`.workstation` file)
- Plugin system for custom CLI integrations
- Tmux-like session sharing / pair coding
