# Work Station — Project Plan (v3, personal-use)

> Cross-platform desktop hub for managing multiple Claude Code / Kimi / Codex terminal sessions across projects. Built for **personal daily-driver use** — no public release, no signing, no telemetry, no support burden.

---

## 0. What this product is — and is not

### Is

- A **multi-project terminal hub** for AI-CLI heavy workflows.
- One window, sidebar of projects, per-project tab+split layout.
- Per-project default CLI, env vars, startup commands.
- Switch projects instantly without killing running PTYs.
- Native feel on macOS + Windows.

### Is not (v0.1)

- **Not a public release** — single-user, private repo, unsigned builds. First-launch OS warnings (Gatekeeper / SmartScreen) are accepted; no notarization, no Authenticode signing.
- **No telemetry, no crash reporter, no auto-updater** — manual rebuild when you want a new version.
- Not a Warp competitor on the AI/UX features (no AI command palette, blocks, command history search across machines).
- Not a tmux replacement — sessions **do not survive full app quit** in v0.1 (see §3).
- Not a Linux-first tool — Linux deferred to stretch (see §6).
- Not an SSH client — local PTYs only.

### Why build this

Personal productivity. The user runs Claude Code / Kimi / Codex across 5–20 projects daily and currently juggles 5–20 iTerm/Windows Terminal tabs. This collapses that into one workspace with persistent layouts and per-project CLI presets. Audience: **one person — the author**. Best motivator: dogfood from day 1; ship when it's better than the current setup.

---

## 1. Stack (locked decisions)

| Layer | Choice | Rationale |
|---|---|---|
| Shell | Tauri 2.0 (Rust + native WebView) | Smaller, faster than Electron; production-ready as of 2024 |
| Frontend | Solid.js + TypeScript + Vite | Smaller runtime than React; fine-grained reactivity helps with terminals |
| Styling | Tailwind CSS + Radix primitives | Speed of iteration; accessible primitives |
| Terminal | xterm.js 5 + WebGL renderer addon | Industry standard (VSCode uses it); WebGL for 60fps |
| PTY | `portable-pty` crate | ConPTY (Win), forkpty (mac); only mature cross-platform option |
| Async runtime | tokio | Standard |
| Storage | SQLite via `tauri-plugin-sql` | Single-file, durable, WAL mode for concurrent reads |
| Auto-update | — | **Dropped** for personal use; rebuild manually |
| CI/CD | GitHub Actions (private repo: 2000 free min/mo) | Used to produce Windows artifacts from a Mac dev machine |
| Crash reporter | — | **Dropped** for now; console.error + log files via `tracing` |

---

## 1.5. Design reference (canonical)

The visual + interaction design for v0.1 lives in `work-station-design/` as an interactive React prototype:

| File | Contents |
|---|---|
| `Work Station.html` | Entry — loads React UMD + Babel standalone + scripts |
| `app.jsx` | Root state, layout, keyboard shortcuts, modals wiring, tweaks panel |
| `components.jsx` | TitleBar, TabStrip, Pane, LayoutNode, Sidebar, QuickSwitcher, AddProjectModal, icons |
| `phase2.jsx` | Drag-resize, CliPopover, SettingsPage, Edit/Delete, TermSearch, error states, skeletons, Onboarding, WinMenu, Tip, Toast, ContextMenu |
| `styles.css` + `styles-phase2.css` | Design tokens (OKLCH dark/light), all component styles |
| `data.js` | Demo fixtures — `WS_PROJECTS`, `WS_CLIS`, `WS_HOTKEYS`, `WS_SETTINGS`, `WS_DEMO_ERRORS`, `WS_WIN_MENU` |
| `tweaks-panel.jsx` | Live preview controls (theme, OS chrome, accent, density, demo states) |

Design briefs that produced the prototype:
- `DESIGN_PROMPT.md` — Phase 1 brief (visual identity, layout, P0 components)
- `DESIGN_PROMPT_PHASE2.md` — Phase 2 brief (drag, settings, errors, onboarding, etc.)

**This prototype is the canonical visual + interaction reference for v0.1.** When the implementation in Tauri+Solid.js could go either way, match the prototype. When this plan's text and the prototype disagree on UX detail, **the prototype wins** — update the plan via PR.

### Task → component mapping

Use this when implementing — grep your task ID, open the listed file, copy the structure into Solid.js.

| Task | Component(s) / token(s) | Source file |
|---|---|---|
| T1.4 Design system | All `--bg-*`, `--text-*`, `--border-*`, `--accent-*` tokens, fonts (Geist, JetBrains Mono) | `styles.css` |
| T1.8 Error boundaries | `PaneError`, `Toast` rendering pattern | `phase2.jsx` |
| T4.2 Terminal component | `Pane` shell (head, status, term body); `Pane2` adds search highlight + error variant | `components.jsx`, `phase2.jsx` |
| T4.4 Output rendering reference | `renderLine` (line types: prompt/cmd/sys/tool/diff-add/diff-rm/etc.) | `components.jsx` |
| T4.8 Terminal theme | `--bg-terminal`, `--text-terminal` tokens (dark in both themes) | `styles.css` |
| T4.10 In-terminal search | `TermSearch` overlay with case + regex toggles | `phase2.jsx` |
| T5.1 LayoutNode type | `{ kind: 'split', dir, ratio, a, b }` \| `{ kind: 'pane', paneId }` | `data.js` (`WS_PROJECTS[].tabs[].layout`) |
| T5.2 SplitPane drag | `NodeView` drag handler (live preview, 200px min, double-click snap) | `phase2.jsx` |
| T5.3 TabStrip | `TabStrip` with cli badge, dirty dot, close button | `components.jsx` |
| T5.4 LayoutTree renderer | `ResizableLayout` + `NodeView` recursion | `phase2.jsx` |
| T5.5 Pane focus tracking | `Pane.focused` border ring style | `components.jsx`, `styles.css` |
| T5.6 Split actions / new pane | `CliPopover` (anchor on tab `+` or pane header `+`) | `phase2.jsx` |
| T6.1 Sidebar | `Sidebar` (right side, collapsible, project rows with color/glyph/sessions count) | `components.jsx` |
| T6.4 Quick switcher | `QuickSwitcher` modal, fuzzy match, ↑↓ + Enter | `components.jsx` |
| T6.5 Add project | `AddProjectModal` (name, folder picker, color, icon, default CLI) | `components.jsx` |
| T6.6 Edit / delete project | `EditProjectModal` + `DeleteConfirmModal` + `ContextMenu` (right-click sidebar row) | `phase2.jsx` |
| T6.8 Empty state | `ProjectEmptyState` (CLI launcher grid) | `app.jsx` |
| T7.3 Quick-launch dropdown | `CliPopover` (with `⌘1..9` shortcuts) | `phase2.jsx` |
| T7.7 CLI tab badge | `TabStrip` `.tab-icon` (CLI `badge` from `WS_CLIS`) | `components.jsx`, `data.js` |
| T7.8 CLI not found | `PaneError` card pattern with retry + alt-CLI buttons | `phase2.jsx` |
| T8.1 Hotkey registry | `{ id, label, binding: ['⌘','T'] }` shape | `data.js` (`WS_HOTKEYS`) |
| T8.2 Default keybindings | Full list of 12 actions | `data.js` (`WS_HOTKEYS`) |
| T8.3 Theme system | `[data-theme="dark"|"light"]` blocks, `[data-density]` blocks | `styles.css` |
| T8.4 Animations + tooltips | `--ease` token, all 150–200ms transitions, `Tip` primitive (600ms hover delay) | `styles.css`, `phase2.jsx` |
| T8.5 Native menu bar | macOS uses OS menu API; Windows uses `WinMenu` hamburger (data: `WS_WIN_MENU`) | `phase2.jsx`, `data.js` |
| T8.6 Window chrome | `MacTraffic` (mac inset), `WinControls` (win min/max/close) | `components.jsx` |
| T8.7 Settings page | `SettingsPage` + sub-sections: General / Appearance / Keys / CLIs / Privacy / About (Privacy toggles render disabled in personal-use build) | `phase2.jsx` |
| T8.9 Loading states | `SidebarSkeleton`, `WorkspaceSkeleton`, `PaneSpawnSkeleton` (braille spinner) | `phase2.jsx` |
| T9.3 App icon | `tauri icon` from 1024×1024 master | (asset, no prototype ref) |

**Known prototype discrepancies** (fix during port):
- About page mentions Electron/Node — replace with Tauri/Rust versions during T8.7 port.
- Search overlay's `Aa` and `.*` toggles are visual-only in the prototype; wire to actual matching during T4.10.
- Settings → Appearance → Theme `system` option falls back to `dark` in prototype; honor `prefers-color-scheme` in real implementation per T8.3.
- Settings → Privacy section: in personal-use build, render the section but **disable** the toggles (greyed with "v0.2" badge). The whole section can also be hidden via a build flag.
- `CrashBanner` and `Toast` components stay in the prototype but their wiring (Sentry / actual crash detection) is dropped in personal-use scope. Toasts are still useful for transient UI feedback (e.g. "Project created", "Failed to save layout"); keep that wiring.

---

## 2. Targets (audited — honest numbers)

| Metric | v0.1 baseline | v0.1 stretch | Notes |
|---|---|---|---|
| Cold start (signed binary, warm disk cache) | < 800ms | < 500ms | 500ms is tight; 800ms is achievable |
| RSS, app idle (no terminals) | < 200MB | < 150MB | Tauri webview alone is 80–120MB |
| RSS, 10 idle PTYs (shells, no work) | < 500MB | < 400MB | Realistic; the original 300MB target was wrong |
| RSS, 10 active terminals (light workload) | < 800MB | < 600MB | Real workload pushes shells to 10–30MB each |
| Frame rate, heavy output (1GB cat) | 60fps, no main-thread freeze > 16ms | – | WebGL + 8–16ms output coalescing |
| ANR / hang under backpressure | Zero | – | See T2.16 |

### Platform support (v0.1)

- **macOS 12+ (Monterey)**, Apple Silicon + Intel universal binary
- **Windows 10 1809+ / Windows 11**, x64 only (ARM64 deferred — low-volume, separate signing)
- **Linux** — deferred to Phase 11 (stretch)

---

## 3. PTY lifetime model — explicit decision

This was a critical ambiguity in v1 of the plan. **v0.1 adopts the "session restore" model, not the "daemon survival" model.**

| Model | What survives | Cost | v0.1? |
|---|---|---|---|
| **Session restore** (chosen) | Layout tree + project state. PTYs are re-spawned on next launch with same cwd + CLI; scrollback is fresh. | Low — built-in to T5.8 + T5.9 | ✅ |
| **WebView reload survival** | PTYs survive Cmd+R / dev refresh (Rust process stays up). | Free — Rust process owns PTYs across webview reloads | ✅ Bonus |
| **App restart survival** (tmux-style daemon) | PTYs survive full app quit. Requires separate long-running daemon process. | High — separate binary, IPC protocol, lifecycle, install | ❌ Phase 11 |

**Marketing copy must say:** "Layouts persist across launches; sessions are reborn fresh in the same cwd with the same CLI." Anything stronger is a lie.

---

## 4. Differentiation — what we actually compete on

| Feature | Us | Warp | Tabby | iTerm2 | Windows Terminal |
|---|---|---|---|---|---|
| Multi-project sidebar | ✅ | ⚠️ workspaces (paid) | ❌ | ❌ | ❌ |
| Per-project default CLI | ✅ | ⚠️ launch configs | ⚠️ profiles (manual) | ⚠️ profiles | ⚠️ profiles |
| Per-project env vars + startup | ✅ | ❌ | ⚠️ | ⚠️ | ⚠️ |
| Instant project switch with PTYs alive | ✅ | ❌ | ❌ | ❌ | ❌ |
| AI command palette / blocks | ❌ | ✅ | ❌ | ❌ | ❌ |
| Native renderer (Rust) | ❌ (WebGL/JS) | ✅ | ❌ (Electron) | ✅ | ✅ |
| Cross-platform (mac+win) | ✅ | ✅ | ✅ | ❌ mac only | ❌ win only |
| Free, OSS | ✅ | ❌ | ✅ | ✅ | ✅ |

**Our wedge:** project-first organization. **Their wedge:** AI features (Warp), maturity (iTerm2), platform integration (Windows Terminal). Don't compete head-on with Warp's AI features in v0.1.

---

## 5. Budget — time and money

### Time (solo developer)

| Scenario | Calendar weeks | Working hours |
|---|---|---|
| Optimistic (full-time, no blockers) | 11 | ~440h |
| **Realistic (full-time, normal blockers)** | **13–15** | **~520–600h** |
| Pessimistic (full-time, hard problems) | 18 | ~720h |
| Part-time, 20h/week | 26–30 | ~520–600h |

Add **20% buffer** for unknown unknowns. Personal-use scope removes ~4 weeks of build/sign/QA/launch effort vs. a public release.

### Money (ongoing per year)

| Item | Cost |
|---|---|
| GitHub Actions (private repo) | **$0** (2000 free min/month is plenty) |
| Apple Developer Program | dropped — accepting Gatekeeper warning |
| Windows code-signing cert | dropped — accepting SmartScreen warning |
| Sentry / telemetry | dropped |
| **Total ongoing** | **$0/yr** |

### One-time / hardware

| Item | Cost | Notes |
|---|---|---|
| Windows VM (Parallels / UTM / Boot Camp) | $0 if free options used | Only needed for Windows local builds; can also build via GitHub Actions Windows runner |

---

## 6. Out of scope for v0.1 (explicit, not "we'll see")

### Personal-use scope drops (dropped vs. public-release plan)

- Code signing (macOS notarization, Windows Authenticode) — accepting first-launch OS warnings
- Auto-updater + update server — manual rebuild
- Telemetry foundation
- Crash reporter (Sentry, etc.)
- Public GitHub release / changelog automation / versioning automation
- Landing page / download page
- QA matrix beyond personal machines
- Accessibility pass (out of scope for personal-use; revisit if ever public)
- Post-launch on-call window

### Standard scope drops

- Linux desktop (Phase 11)
- ARM64 Windows build (Mac+Win x64 only)
- Tmux-style daemon (PTY survives app quit) (Phase 11)
- SSH / remote PTYs (Phase 11)
- Cloud sync of projects (Phase 11)
- AI command palette / suggestions panel (out of scope entirely — Warp's wedge)
- Plugin system (Phase 11)
- Multi-window (one window only in v0.1)
- Session recording / playback
- Workspace export/import file format
- Mobile / tablet companion

---

## 7. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | RAM target exceeded under real workloads | Medium | Medium | Targets revised in §2; benchmark continuously (T10.3) |
| R2 | xterm.js WebGL context loss / GPU driver bug on Windows | Medium | High | Canvas fallback (T4.3); detect + report to Sentry |
| R3 | PTY backpressure causes app hang when output exceeds frontend rendering speed | Medium | High | Backpressure handling (T2.16); drop-with-warning policy |
| R4 | Gatekeeper / SmartScreen warning on first launch (unsigned build) | High | Low | Accepted — Right-click → Open on macOS, "More info → Run anyway" on Windows. One-time per machine. |
| R5 | SQLite corruption from concurrent writes in dev mode | Low | High | WAL mode (T3.9); auto-backup before migration (T3.10) |
| R6 | UTF-8 codepoint split across PTY reads breaks rendering | High | Medium | Streaming-safe decoder (T4.4); covered in plan |
| R7 | xterm.js performance degrades with 20+ active terminals | Medium | Medium | Pause-when-hidden (T4.12); investigate render pooling later |
| R8 | Solid.js ecosystem gap (less mature than React) costs us time | Medium | Low | Acceptable; willing to write primitives ourselves where needed |
| R9 | Tauri 2.0 breaking changes between minor versions | Low | Medium | Pin Tauri version; upgrade only on documented stable releases |
| R10 | "Just like tmux but…" feature creep delays v0.1 | High | High | This document. Phase 11 is the parking lot; do not pull in mid-flight |
| R11 | Cross-OS regressions found late (Mac works, Win doesn't) | Medium | Medium | Run Windows build via GHA matrix from Phase 1, not just at end (T9.1) |

---

## 8. Decisions (locked for personal use)

All resolved. No `DECISIONS.md` file needed.

| # | Decision | Resolution |
|---|---|---|
| D1 | Apple Developer Program | **Skipped** — accepting Gatekeeper warning on first launch |
| D2 | Windows signing cert | **Skipped** — accepting SmartScreen warning on first launch |
| D3 | Telemetry | **Dropped** — single-user, no metrics collection |
| D4 | License | **Skipped** — private repo, no public license needed; can add MIT later if ever shared |
| D5 | Repository visibility | **Private** |
| D6 | Crash reporter | **Skipped** — relying on `tracing` log files; Sentry can be added later if desired |
| D7 | Project name | **Work Station** (placeholder, can rename anytime — no public branding lock-in) |
| D8 | Domain / landing page | **Skipped** — no public presence needed |

---

## 9. Phases & tasks

Each task: status, complexity (S/M/L/XL — work hours roughly 2/8/24/40+), dependencies, description, acceptance criteria.

---

### Phase 1 — Foundation & Scaffolding

**Goal:** Empty Tauri+Solid app opens cross-platform, dev tooling green, decisions locked.
**Estimate:** 1 week (40h).

#### T1.1: Initialize repository

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: None
- **Description**:
  - Init git, `.gitignore` (Rust + Node + macOS + Windows), MIT `LICENSE`, `README.md` skeleton, `DECISIONS.md` skeleton (see §8).
  - Conventional-commits commit-msg hook (husky or `.githooks/`).
  - GitHub branch protection on `master`: require PR, require linear history, dismiss stale reviews.
- **Acceptance**: `git log` shows initial commit; PR cannot be merged without review.

#### T1.2: Scaffold Tauri 2.0 + Solid.js

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T1.1
- **Description**:
  - `pnpm create tauri-app` with Solid + TypeScript template.
  - Pin Tauri version (`tauri = "2.x.y"`) — no auto-bump.
  - Verify `pnpm tauri dev` launches blank window on macOS.
- **Acceptance**: Dev mode runs locally; HMR works.

#### T1.3: Tooling — TypeScript, ESLint, Prettier, Rust lints

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T1.2
- **Description**:
  - TS `strict: true`, `noImplicitAny`, `noUncheckedIndexedAccess`.
  - ESLint + Prettier with shared config.
  - Rust: `clippy::all` + `clippy::pedantic` in CI; `rustfmt` enforced.
  - Husky pre-commit: lint + format both sides.
- **Acceptance**: `pnpm lint` and `cargo clippy` both green.

#### T1.4: Design system foundation

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T1.2
- **Description**:
  - Tailwind CSS, Radix primitives.
  - Design tokens file: colors (light + dark), spacing scale, typography (mono + UI), motion durations/easings.
  - `prefers-reduced-motion` respected at the token level.
- **Acceptance**: Demo page renders all tokens; switching theme updates everything reactively.

#### T1.5: Folder structure

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T1.2
- **Description**:
  - `src-tauri/src/{pty,db,commands,ipc,cli,menu}` modules.
  - `src/{components,stores,ipc,routes,styles,types,utils,db}`.
- **Acceptance**: Empty modules present, build green.

#### T1.6: Cross-platform build verification

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T1.2
- **Description**:
  - `pnpm tauri build` succeeds on macOS (arm64 + x64) and Windows 10/11 VM (x64).
  - Document all platform deps in `CONTRIBUTING.md` (Xcode CLT, MSVC build tools, WebView2).
- **Acceptance**: Unsigned binaries open on each target OS.

#### T1.7: Developer documentation

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T1.6
- **Description**:
  - `CONTRIBUTING.md` quickstart; toolchain matrix; troubleshooting table.
  - `AGENTS.md` for AI-assisted contributors (this repo's contract).
- **Acceptance**: A teammate clones and runs in <30 minutes following the docs.

#### T1.8: Error boundary architecture

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T1.4
- **Description**:
  - Solid `ErrorBoundary` at app root + at each major panel (sidebar, terminal pane, layout tree).
  - Boundaries log full error + stack to `tracing` (T1.9) and show recoverable UI fallback.
- **Acceptance**: Throwing in a child component shows fallback UI without killing the app.

#### T1.9: Logging infrastructure

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T1.5
- **Description**:
  - Rust: `tracing` + `tracing-subscriber` with file rotation (daily, capped MB).
  - Frontend: thin logger that mirrors levels to backend in production.
  - Logs go to platform standard locations (macOS: `~/Library/Logs/work-station`, Windows: `%LOCALAPPDATA%\work-station\logs`).
- **Acceptance**: Logs visible at platform location after first run; crash includes last N lines.

---

### Phase 2 — PTY Core (Rust Backend)

**Goal:** Persistent session manager. PTYs live in Rust; frontend attaches/detaches via UUID.
**Estimate:** 3 weeks (120h). Hardest backend phase.

#### T2.1: Add PTY dependencies

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T1.5
- **Description**:
  - Add `portable-pty`, `tokio` (full features), `bytes`, `uuid`, `serde`, `serde_json` to `Cargo.toml`.
  - Also: `tracing`, `thiserror` for typed errors.
- **Acceptance**: `cargo build` green.

#### T2.2: PtySession struct

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T2.1
- **Description**:
  - Fields: `id: Uuid`, `pid: u32`, `master: Box<dyn MasterPty>`, `writer: Box<dyn Write>`, `output_tx: tokio::sync::broadcast::Sender<Bytes>`, `created_at`.
  - `Drop` impl: kill child, log if it didn't exit cleanly.
- **Acceptance**: Unit test creates and drops a session; no zombie processes (verified via OS).

#### T2.3: PtyManager registry

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T2.2
- **Description**:
  - `Arc<RwLock<HashMap<Uuid, Arc<PtySession>>>>`.
  - Lifetime tied to app `State`, not window.
  - Methods: `spawn`, `get`, `kill`, `list`, `count`.
- **Acceptance**: Manager survives webview reload (T2.12 verifies).

#### T2.4: PTY reader task with output coalescing

- [ ] **Status**: TODO
- **Complexity**: L
- **Dependencies**: T2.3
- **Description**:
  - Per-session tokio task: read PTY into 64KB buffer, flush every 8–16ms OR when buffer >= 4KB, whichever first.
  - Emits `Bytes` via session's broadcast channel.
  - On EOF: log + remove from registry.
- **Acceptance**: `cat huge.log` doesn't flood IPC; flush cadence visible in trace logs.

#### T2.5: pty_spawn command

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T2.3
- **Description**:
  - Args: `cwd`, `command`, `args`, `env: HashMap`, `cols`, `rows`.
  - Validates cwd exists; merges env with platform defaults; returns `{ session_id }`.
- **Acceptance**: Tauri command callable from frontend; bad args return typed errors.

#### T2.6: pty_write command

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T2.5
- **Description**:
  - Args: `session_id`, `data: Vec<u8>`.
  - Forwards raw bytes to PTY stdin. No encoding translation.
- **Acceptance**: Smoke test with `echo` round-trips ASCII + UTF-8 input.

#### T2.7: pty_resize command

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T2.5
- **Description**:
  - Args: `session_id`, `cols`, `rows`.
  - Calls `master.resize()`; sends SIGWINCH (handled by portable-pty).
- **Acceptance**: `tput cols` reports new value after resize.

#### T2.8: pty_kill with graceful shutdown

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T2.5
- **Description**:
  - Send SIGTERM (or close stdin on Windows), wait 2s, SIGKILL if alive.
  - Remove from registry; close broadcast channel.
- **Acceptance**: After kill, no zombie process; manager count decrements.

#### T2.9: Persistent scrollback buffer

- [ ] **Status**: TODO
- **Complexity**: L
- **Dependencies**: T2.4
- **Description**:
  - `VecDeque<Bytes>` per session, capped at configurable MB (default 4MB).
  - Ring-buffer eviction (drop oldest chunk).
  - Tap into reader task — same bytes go to broadcast and scrollback.
- **Acceptance**: Memory bounded; old output is evicted predictably.

#### T2.10: pty_get_scrollback command

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T2.9
- **Description**:
  - Args: `session_id`, `offset_bytes`, `limit_bytes`.
  - Returns chunk of stored scrollback.
- **Acceptance**: Frontend can replay full buffer on mount.

#### T2.11: Binary IPC for PTY data

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T2.4
- **Description**:
  - Use Tauri 2.0 `Channel<Bytes>` (zero-copy where possible) instead of base64.
  - Benchmark: 1GB stream, expect 5–10× speedup vs base64-JSON.
- **Acceptance**: Benchmark numbers committed to repo (`benches/ipc_throughput.rs`).

#### T2.12: Layout/session restore on launch

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T2.5, T5.8
- **Description**:
  - **Replaces v1's "Detached PTY survival".** PTYs do NOT survive app quit.
  - On launch: read last layout JSON, spawn fresh PTYs in same cwd with same CLI, mount in same panes.
  - Bonus: PTYs survive webview reload (Cmd+R) because Rust process owns them.
- **Acceptance**: Quit → reopen → layout identical, sessions are new but in correct cwd/CLI.

#### T2.13: PTY unit tests

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T2.8, T2.10
- **Description**:
  - Spawn / write / resize / kill / scrollback eviction.
  - Cross-platform: `cargo test` green on macOS + Windows CI.
- **Acceptance**: ≥80% line coverage on `pty/` module.

#### T2.14: PTY smoke tests

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T2.13
- **Description**:
  - Manually run `htop`, `vim`, `claude`, `pwsh`, `nvim`.
  - Verify ANSI colors, alt-buffer enter/exit, resize while running.
  - QA matrix entries committed.
- **Acceptance**: Each command listed shows correct rendering on each OS.

#### T2.15: PTY error handling matrix

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T2.5
- **Description**:
  - Define typed errors: `SpawnFailed`, `CommandNotFound`, `CwdMissing`, `WriteToClosed`, `ReaderPanic`.
  - Each maps to a user-visible message + recovery action (retry, edit project, dismiss).
- **Acceptance**: Each error reproducible in test; UI shows matching recovery hint.

#### T2.16: Backpressure handling

- [ ] **Status**: TODO
- **Complexity**: L
- **Dependencies**: T2.4, T2.11
- **Description**:
  - If broadcast channel lags (frontend slow): drop oldest, log warning, increment counter.
  - Hard cap: if scrollback buffer fills + frontend stalls, prefer dropping live output over crashing.
  - Surface backpressure stats to a debug panel.
- **Acceptance**: 1GB cat does not OOM or freeze app; observable drops counted.

---

### Phase 3 — Database & Project Management

**Goal:** SQLite schema for projects, sessions, layouts. CRUD commands.
**Estimate:** 1 week (40h).

#### T3.1: SQLite plugins

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T1.5
- **Description**:
  - Add `tauri-plugin-sql` (sqlite feature) and `tauri-plugin-store`.
  - DB file at platform app-data dir.
- **Acceptance**: Plugin loads; can run a hello-world query from Rust.

#### T3.2: Projects table schema

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T3.1
- **Description**:
  - `projects(id TEXT PK, name TEXT, path TEXT, color TEXT, icon TEXT, default_cli TEXT, env_json TEXT, position INTEGER, created_at INTEGER)`.
  - Indexed on `position`.
- **Acceptance**: Migration creates table; insert/select round-trip works.

#### T3.3: Sessions table schema

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T3.2
- **Description**:
  - `sessions(id TEXT PK, project_id TEXT FK, title TEXT, cli TEXT, cwd TEXT, layout_json TEXT, created_at INTEGER)`.
  - Layout JSON: tree of splits + pane → session_id mapping.
- **Acceptance**: Schema validated by Zod on read; corrupt JSON falls back to empty layout.

#### T3.4: App settings schema

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T3.1
- **Description**:
  - `app_settings(key TEXT PK, value TEXT)` for theme, hotkeys, last-active project, scrollback size, default fallback CLI.
- **Acceptance**: Get/set wrapper handles type coercion safely.

#### T3.5: Migration runner

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T3.2, T3.3, T3.4
- **Description**:
  - Versioned migrations in `migrations/NNNN_name.sql`.
  - On boot: check `schema_version`, apply pending in transaction.
  - Rollback: restore from auto-backup (T3.10).
- **Acceptance**: Adding a migration applies on next launch; failure rolls back cleanly.

#### T3.6: Project CRUD commands

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T3.5
- **Description**:
  - `project_list`, `project_create`, `project_update`, `project_delete`.
  - All inputs validated; deletion is soft (recoverable for 7 days) — optional, can defer to v0.2.
- **Acceptance**: Commands callable from frontend; SQL injection-safe (parameterized).

#### T3.7: Folder picker integration

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T3.6
- **Description**:
  - `tauri-plugin-dialog` for native folder picker.
  - Returns absolute path; rejects symlink loops.
- **Acceptance**: Picker opens native UI on each OS; cancellation handled.

#### T3.8: Project validation rules

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T3.6
- **Description**:
  - Name 1–80 chars, trimmed, unique (case-insensitive).
  - Path exists, is a directory, is readable.
- **Acceptance**: Invalid input returns typed error; UI shows inline message.

#### T3.9: SQLite WAL mode + pragmas

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T3.1
- **Description**:
  - `PRAGMA journal_mode=WAL; synchronous=NORMAL; foreign_keys=ON; busy_timeout=5000`.
  - Better concurrency, slightly faster, durable enough.
- **Acceptance**: WAL files created; concurrent read/write doesn't deadlock.

#### T3.10: DB auto-backup before migrations

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T3.5, T3.9
- **Description**:
  - Before each migration: copy DB to `backups/db-vN-TIMESTAMP.sqlite`.
  - Keep last 5 backups; older auto-pruned.
- **Acceptance**: Backups present after migration; manual restore steps documented.

---

### Phase 4 — Terminal UI (Solid + xterm.js)

**Goal:** Solid wrapper around xterm.js with WebGL renderer, connected to backend.
**Estimate:** 2 weeks (80h).

#### T4.1: Install xterm.js + addons

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T1.4
- **Description**:
  - `@xterm/xterm`, `@xterm/addon-webgl`, `@xterm/addon-fit`, `@xterm/addon-search`, `@xterm/addon-web-links`, `@xterm/addon-unicode11`.
  - Pin major versions.
- **Acceptance**: All addons import without errors.

#### T4.2: Terminal Solid component

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T4.1
- **Description**:
  - Mount xterm on `<div ref>`; dispose on unmount; handle props change correctly.
  - Wraps session ID, theme, font preferences.
- **Acceptance**: Mount/unmount in 100-cycle stress test leaks no memory.

#### T4.3: WebGL renderer with canvas fallback

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T4.2
- **Description**:
  - WebGL addon as default.
  - On `webglcontextlost` event: dispose WebGL addon, swap to canvas, log to Sentry.
  - Single attempt to recover WebGL on `webglcontextrestored`.
- **Acceptance**: Forced context loss (devtools) triggers fallback without UI breakage.

#### T4.4: Subscribe to PTY output

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T4.2, T2.11
- **Description**:
  - Subscribe to backend Channel for session_id.
  - Streaming-safe UTF-8 decode using `TextDecoder({ fatal: false, stream: true })` to handle split codepoints.
- **Acceptance**: Multibyte CJK output across artificial chunk splits renders correctly.

#### T4.5: Forward keystrokes to PTY

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T4.2, T2.6
- **Description**:
  - xterm `onData` → `pty_write`.
  - `onBinary` for binary data (rare — paste of binary, etc).
- **Acceptance**: All ASCII + arrow keys + Ctrl chords reach the shell.

#### T4.6: Auto-resize via ResizeObserver

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T4.2, T2.7
- **Description**:
  - ResizeObserver on container.
  - `fit.fit()` then `pty_resize` (debounced 50ms).
- **Acceptance**: Drag window edge — terminal reflows without flicker; PID receives SIGWINCH.

#### T4.7: Scrollback replay on mount

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T4.4, T2.10
- **Description**:
  - Pull scrollback from backend before subscribing to live stream.
  - Sequence number guard prevents duplicate rendering.
- **Acceptance**: Switch tabs → output is preserved; no double-rendered lines.

#### T4.8: Theme integration

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T4.2, T1.4
- **Description**:
  - xterm theme follows app design tokens.
  - Reactive on theme change without remount.
- **Acceptance**: Light↔dark toggle updates xterm colors instantly.

#### T4.9: Copy / paste

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T4.2
- **Description**:
  - Cmd/Ctrl+C on selection (don't override SIGINT when no selection).
  - Cmd/Ctrl+V paste; bracketed paste mode honored.
- **Acceptance**: Selection→copy→paste round-trips identical text.

#### T4.10: In-terminal search

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T4.1
- **Description**:
  - Cmd/Ctrl+F triggers search overlay (search-bar component).
  - Uses xterm search addon; case-sensitivity + regex toggles.
- **Acceptance**: Search highlights matches; F3/Shift+F3 navigates.

#### T4.11: Clickable web links

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T4.1
- **Description**:
  - web-links addon registered.
  - Cmd/Ctrl+click → open in default browser via `tauri-plugin-shell`.
- **Acceptance**: URLs in `claude` output are clickable on both OSes.

#### T4.12: Pause render when hidden

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T4.3
- **Description**:
  - `IntersectionObserver` or DOM-disconnect detection.
  - Suspend WebGL render loop; PTY keeps streaming into scrollback in backend.
- **Acceptance**: Hidden tabs use ~0% GPU; switching back resumes immediately.

#### T4.13: Cross-session search (defer to v0.2)

- [ ] **Status**: STRETCH
- **Complexity**: L
- **Dependencies**: T2.9, T4.10
- **Description**:
  - Cmd/Ctrl+Shift+F: search across all open scrollback buffers in current project.
  - Useful for "where did I see that error?"
- **Acceptance**: Defer unless v0.1 timeline allows.

#### T4.14: Configurable shell init

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T2.5
- **Description**:
  - Per-project: extra env vars (T7.5), startup commands (T7.6).
  - Documented: shell rc files (`.zshrc`, etc) load normally as login/non-login per platform default.
- **Acceptance**: Project with `NODE_ENV=development` has it set; user's `.zshrc` aliases work.

---

### Phase 5 — Layout Engine (Tabs + Splits)

**Goal:** Per-project tiling layout. Tabs at top, splits inside, drag-to-resize.
**Estimate:** 3 weeks (120h). Most complex frontend phase.

#### T5.1: LayoutNode type design

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T1.5
- **Description**:
  - Recursive: `{ type: 'split', direction: 'h'|'v', ratio: number, children: LayoutNode[] }` or `{ type: 'pane', sessionId: string }`.
  - Zod schema for validation; round-trip test from JSON.
- **Acceptance**: Invalid layout rejected; valid layout parses clean.

#### T5.2: SplitPane component

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T5.1
- **Description**:
  - Drag handle, controlled ratio, min size 100px, snap if released near 50%.
  - **Crucially:** resize via CSS only (transform/grid), not re-mount.
- **Acceptance**: Drag handle: terminal does NOT remount; PTY does not resize until drag end.

#### T5.3: TabStrip per project

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T5.1
- **Description**:
  - Tabs list with active state, close button, dirty/running indicator.
  - Drag-to-reorder via `dnd-kit` or similar Solid DnD lib.
- **Acceptance**: Reorder persists to DB; close confirms if process is running.

#### T5.4: LayoutTree recursive renderer

- [ ] **Status**: TODO
- **Complexity**: L
- **Dependencies**: T5.2
- **Description**:
  - Walks LayoutNode tree, renders Splits/Panes.
  - **Stable keys** — pane key === sessionId; split key === stable path string.
  - Critically: never remount Terminal during ratio change.
- **Acceptance**: Drag split handle 100 times — Terminal mount counter stays at 1.

#### T5.5: Pane focus tracking

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T5.4
- **Description**:
  - Click pane = active.
  - Focus ring border (1px tinted).
  - Active pane captures hotkeys (T8.x).
- **Acceptance**: Tab focus indicator follows clicks; keyboard shortcuts target active pane.

#### T5.6: Split actions

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T5.5, T2.5
- **Description**:
  - Split horizontally / vertically.
  - New pane spawns PTY in same cwd with project's default CLI.
- **Acceptance**: `Cmd+\` v-split; new pane has prompt at same path.

#### T5.7: Close pane action

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T5.6, T2.8
- **Description**:
  - Kill PTY (T2.8 graceful).
  - Collapse split if 1 child remains; refocus sibling.
- **Acceptance**: Close last pane in tab → tab closes; close last tab in project → empty state.

#### T5.8: Layout persistence

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T5.4, T3.3
- **Description**:
  - Persist `layout_json` on every change (debounced 500ms).
  - SQLite transaction; never write partial state.
- **Acceptance**: Mid-resize crash leaves valid (older) layout in DB.

#### T5.9: Layout restore on switch / launch

- [ ] **Status**: TODO
- **Complexity**: L
- **Dependencies**: T5.8, T2.12
- **Description**:
  - Switch project: re-render layout tree, reattach to existing PTYs by session ID.
  - Launch: re-render layout tree, spawn fresh PTYs (T2.12).
- **Acceptance**: Project switch is <100ms; PTYs that survived in-memory reattach instantly.

---

### Phase 6 — Sidebar & Navigation

**Goal:** Project list, quick-switcher, instant project switching without killing sessions.
**Estimate:** 1 week (40h).

#### T6.1: Sidebar component

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T3.6, T1.4
- **Description**:
  - Right-side panel (per request); collapsible.
  - List projects: color/icon, name, active highlight, running session count badge.
- **Acceptance**: Sidebar collapses cleanly; active project highlighted distinctly.

#### T6.2: State-only project switching

- [ ] **Status**: TODO
- **Complexity**: L
- **Dependencies**: T6.1, T5.9
- **Description**:
  - Switching swaps layout tree only; all PTYs of all projects stay alive in backend.
  - PTYs in inactive projects: pause render (T4.12), keep streaming into scrollback.
- **Acceptance**: Switch A→B→A: project A terminals show output that arrived while B was active.

#### T6.3: Numeric hotkeys

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T6.2
- **Description**:
  - Cmd/Ctrl+1..9 jumps to project N (by sidebar position).
  - Disabled when typing in input/terminal — must check focus.
- **Acceptance**: Hotkey works from anywhere except inside terminal/text input.

#### T6.4: Quick switcher modal

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T6.1
- **Description**:
  - Cmd/Ctrl+K opens fuzzy-search modal.
  - Keyboard nav (↑↓), Enter selects, Esc closes.
- **Acceptance**: Type 2 chars → ranked match list; Enter switches.

#### T6.5: Add project flow

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T6.1, T3.7
- **Description**:
  - Form: name, folder picker, color, icon, default CLI.
  - Validation (T3.8); on submit creates project + first session.
- **Acceptance**: New project appears in sidebar with one tab + one pane open.

#### T6.6: Edit / delete project

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T6.5
- **Description**:
  - Edit modal mirrors Add; "Save changes" only enabled when dirty.
  - Sidebar row: right-click context menu (Switch, Edit…, Reveal in Finder, Delete) AND inline pencil-icon button visible on hover.
  - Delete confirm modal: smaller (420px), centered. If sessions running: "This project has N running session(s). They will be killed."
  - Delete button has 500ms safety delay with visible progress fill before becoming clickable (prevents accidental confirmation).
- **Acceptance**: Right-click + edit pencil both open Edit modal. Delete with running sessions kills them gracefully. Enter within first 500ms of confirm modal does not delete.

#### T6.7: Drag-to-reorder projects

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T6.1
- **Description**:
  - Drag handle in sidebar.
  - Persist `position` column atomically.
- **Acceptance**: Reorder survives restart; numeric hotkeys map to new positions.

#### T6.8: Empty state

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T6.5
- **Description**:
  - Onboarding card when no projects exist.
  - Direct CTA to "Add your first project".
- **Acceptance**: Fresh install → empty state visible; CTA opens add flow.

---

### Phase 7 — CLI Integration

**Goal:** Detect CLIs, quick-launch presets, per-project defaults.
**Estimate:** 1 week (40h).

#### T7.1: Detect CLIs in PATH

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T2.5
- **Description**:
  - On boot scan PATH for `claude`, `kimi`, `codex`, `bash`, `zsh`, `fish`, `pwsh`, `cmd`.
  - Resolve absolute paths; cache results for session.
- **Acceptance**: List populated within 200ms of boot.

#### T7.2: cli_list_available command

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T7.1
- **Description**:
  - Returns `[{ name, path, version }]`.
  - Version detection: best-effort parse of `--version`; tolerate failures.
- **Acceptance**: Frontend can render CLI list; missing version shows blank.

#### T7.3: Quick-launch dropdown per pane

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T7.2, T5.6
- **Description**:
  - "+ New terminal" button shows submenu of detected CLIs.
  - Click spawns selected CLI in current pane (replaces) or new pane (with modifier).
- **Acceptance**: All detected CLIs launchable from menu.

#### T7.4: Per-project default CLI

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T7.3, T3.6
- **Description**:
  - Project `default_cli` setting.
  - New panes auto-launch with this CLI; user can override per-pane.
- **Acceptance**: Add project with `default_cli=claude` → first pane launches claude.

#### T7.5: Per-project env vars

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T3.6
- **Description**:
  - Editor for key/value pairs (string-only).
  - Saved to SQLite; injected on spawn (merged with platform defaults).
- **Acceptance**: `printenv NODE_ENV` shows project value.

#### T7.6: Per-project startup commands

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T7.5
- **Description**:
  - Optional list of commands run before main CLI in same shell (e.g. `nvm use 20`).
  - Run via shell wrapper; failures are logged but don't block CLI launch.
- **Acceptance**: `nvm use` works; failure shows warning, CLI still launches.

#### T7.7: CLI badge on tabs

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T7.4, T5.3
- **Description**:
  - Icon next to tab title indicating CLI.
  - Heuristic: derived from spawn command, not parse of running process.
- **Acceptance**: Badges render distinct icons for claude/kimi/codex/shell.

#### T7.8: CLI not found graceful handling

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T7.4, T2.15
- **Description**:
  - If project's default CLI is not in PATH on launch: show inline warning in pane, fallback to user shell.
  - Link to "Install instructions" doc.
- **Acceptance**: Project with deleted `claude` binary shows warning, falls back to zsh/pwsh.

---

### Phase 8 — Polish & Settings

**Goal:** Feel native and fast on both platforms.
**Estimate:** 1.5 weeks (60h). Telemetry + crash reporter dropped per personal-use scope.

#### T8.1: Hotkey registry

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T1.5
- **Description**:
  - Centralized Solid store: `Map<actionId, Binding>`.
  - Platform-aware modifier (Cmd vs Ctrl); humanize labels.
- **Acceptance**: All hotkeys come from one source; no hardcoded `event.metaKey` checks.

#### T8.2: Default keybindings

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T8.1
- **Description**:
  - Cmd+T new terminal, Cmd+\\ v-split, Cmd+Shift+\\ h-split.
  - Cmd+W close pane, Cmd+1..9 project, Cmd+K switcher.
  - Cmd+, settings, Cmd+F search, Cmd+Shift+F cross-search.
- **Acceptance**: Cheatsheet panel renders all bindings; conflicts detected.

#### T8.3: Theme system

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T1.4
- **Description**:
  - Dark (default), light, system-follow.
  - Reactive across all components incl. xterm.
  - Read system preference via `prefers-color-scheme`.
- **Acceptance**: System dark/light flip updates app instantly when set to follow.

#### T8.4: Animations + tooltip primitive

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T1.4
- **Description**:
  - Tab switch, sidebar collapse, pane focus ring (200ms ease-out via `--ease`).
  - Tooltip primitive (`Tip` in prototype): 600ms hover delay, position above by default with auto-flip, optional shortcut keycap chips on the right.
  - Apply tooltips to: titlebar icon buttons, sidebar settings cog, pane header buttons, search overlay icons, "+ New project" affordances.
  - Respect `prefers-reduced-motion` — full disable, not just dampen.
- **Acceptance**: Reduced-motion users see instant transitions; others see polish. Tooltip appears after 600ms hover and disappears on `mousedown`.

#### T8.5: Native menu bar (macOS) + Windows menu

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T8.2
- **Description**:
  - Tauri menu API.
  - macOS: top menu bar with all commands.
  - Windows: in-window menu (hamburger) since hidden title bar.
- **Acceptance**: Every keyboard shortcut also reachable from menu.

#### T8.6: Window chrome

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T1.6
- **Description**:
  - macOS: traffic-light inset, hidden title bar.
  - Windows: custom title bar with min/max/close (using webview).
- **Acceptance**: Both look native; drag region works for window move.

#### T8.7: Settings page

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T8.1, T8.3
- **Description**:
  - Hotkey rebinding (with conflict detection).
  - Theme, default CLI, scrollback size, font, telemetry toggle.
  - Backed by `app_settings` table.
- **Acceptance**: All settings persist; rebound hotkeys apply without restart.

#### ~~T8.8: App icon~~ — moved to T9.3 (build-time concern)

#### T8.9: Loading & empty states

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T6.8
- **Description**:
  - Skeleton loaders, friendly empty states everywhere (no projects, no panes, no detected CLIs).
- **Acceptance**: Every "could be empty" surface has intentional UI.

#### ~~T8.10: Telemetry foundation~~ — DROPPED (personal use, no metrics collection)

#### ~~T8.11: Crash reporter~~ — DROPPED (relying on `tracing` log files; Sentry can be added later if desired)

> Settings → Privacy section in the prototype still renders for design coherence (telemetry/crash toggles visible but disabled with "v0.2" badge). Implementation skips wiring.

---

### Phase 9 — Build for personal use

**Goal:** Produce working `.app` (macOS) and `.msi` / `.exe` (Windows) installers, **unsigned**, for the author's two machines. No public release, no notarization, no auto-updater.
**Estimate:** 2–3 days (16–24h).

#### T9.1: GitHub Actions matrix build (private repo)

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T1.6
- **Description**:
  - Matrix: macOS-14 (universal — arm64+x64), windows-2022 (x64).
  - Cache Rust target dir + pnpm store.
  - Artifacts: unsigned `.dmg` + `.app.tar.gz` (mac), unsigned `.msi` + `.exe` (win).
  - Triggered manually (`workflow_dispatch`) or on `release/*` tag.
  - Private repo: 2000 free GHA minutes/month is enough for a personal cadence.
- **Acceptance**: Run workflow → artifacts downloadable from Actions page; both Mac and Windows builds succeed.

#### T9.2: Local build documentation

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T9.1
- **Description**:
  - `BUILD.md` with: how to run `pnpm tauri build` on macOS; how to retrieve Windows artifact from GHA; how to install the unsigned build on each OS.
  - macOS install: open Finder → Applications → Right-click app → Open → Open Anyway (one time per build).
  - Windows install: run `.msi`, "More info" → "Run anyway" on SmartScreen warning (one time per build).
- **Acceptance**: Docs reproducible in 5 minutes by following them on a fresh machine.

#### T9.3: App icon

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T1.6
- **Description**:
  - 1024×1024 master, generate iconset for both platforms via `tauri icon`.
  - Tauri config wires icons.
- **Acceptance**: Dock/taskbar shows the icon; install bundles include all sizes. (Moved here from T8.8 since it's a build-bundling concern.)

---

### Phase 10 — Personal validation & v0.1 ready

**Goal:** Validate it's stable enough to be your daily driver. No public release, no QA matrix.
**Estimate:** 3–5 days (24–40h).

#### ~~T10.1: QA matrix~~ — DROPPED (only your two machines matter; cross-OS verified by GHA matrix in T9.1)

#### T10.2: Cold start benchmark

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T9.1
- **Description**:
  - `hyperfine --warmup 3 -r 10` on built binaries on your Mac and Windows machines.
  - Target: < 800ms (baseline), < 500ms (stretch).
- **Acceptance**: Numbers recorded in `benches/cold_start.md`. If over 800ms, profile and fix before declaring v0.1 ready.

#### T10.3: RAM benchmark

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T9.1
- **Description**:
  - 10 idle PTYs: target < 500MB RSS.
  - 10 active (light load): target < 800MB RSS.
  - Use `ps`/`Get-Process` sampler script on each machine.
- **Acceptance**: Results in `benches/ram.md`. If over 800MB active, investigate before v0.1.

#### T10.4: Output stress test

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T9.1, T2.16
- **Description**:
  - `cat 1gb-random.bin` in active terminal.
  - Verify: 60fps maintained, no main-thread frame > 16ms, no crash, drops counted.
- **Acceptance**: Test passes on both OSes; metrics committed.

#### T10.5: Long-running leak test

- [ ] **Status**: TODO
- **Complexity**: M
- **Dependencies**: T9.1
- **Description**:
  - 5 sessions open for 24h with periodic small output.
  - Track RSS growth, file handles (`lsof` / `handle.exe`), GPU memory.
- **Acceptance**: RSS growth < 10% over 24h; no FD/handle leaks.

#### T10.6: Crash recovery

- [ ] **Status**: TODO
- **Complexity**: L
- **Dependencies**: T9.1, T2.12
- **Description**:
  - Force-kill mid-session.
  - Relaunch: layout restored, sessions re-spawn in same cwd/CLI (per §3 model).
- **Acceptance**: After hard kill, relaunch shows same panes within 1s.

#### ~~T10.7: Accessibility pass~~ — DROPPED (personal-use; revisit only if ever public)

#### T10.8: Continuous dogfooding

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T6.1 (sidebar usable)
- **Description**:
  - Use Work Station as your daily-driver from the moment it's barely usable (~end of Phase 6).
  - Keep a `FRICTION.md` (or GitHub issue list in private repo) for every paper-cut.
  - Triage the list before declaring v0.1 ready.
- **Acceptance**: At least 14 consecutive days of dogfood use; FRICTION.md drained of "must fix" entries.

#### T10.9: v0.1 ready milestone

- [ ] **Status**: TODO
- **Complexity**: S
- **Dependencies**: T10.8
- **Description**:
  - Tag `v0.1` in git (private repo).
  - Build artifacts from GHA + install on both machines.
  - Quit your old terminal app for a week and verify Work Station holds up.
- **Acceptance**: Old terminal app uninstalled (or at least undocked) for 7 consecutive days.

#### ~~T10.10, T10.11~~ — DROPPED

> T10.10 (post-launch on-call), T10.11 (Linux release) are not personal-use concerns. Linux is parked in Phase 11 stretch.

---

## 10. Stretch / Phase 11 — Post-v0.1.0

Explicitly out of v0.1 scope. Reconsider after dogfood data + user feedback.

- **Linux desktop release** — AppImage + .deb (T10.11 promoted).
- **Tmux-style daemon** — PTYs survive app quit; separate long-running process.
- **Cloud sync** — project list sync across machines (encrypted).
- **SSH host support** — remote PTY sessions.
- **AI command suggestions panel** — hard pass (Warp's wedge).
- **Workspace export/import** — `.workstation` file format.
- **Plugin system** — custom CLI integrations.
- **Tmux-like session sharing / pair coding**.
- **Cross-session search** (T4.13 promoted).
- **Multi-window** — pop-out terminals into separate windows.
- **ARM64 Windows build**.
- **Mobile companion / read-only viewer** — hard no for now.

---

## 11. Definition of Done — v0.1 (personal-use)

You declare v0.1 when **all** of these are true on **both** of your machines (Mac + Windows):

- [ ] All non-DROPPED Phase 1–10 tasks marked DONE.
- [ ] Cold start < 800ms (T10.2).
- [ ] RAM < 500MB with 10 idle PTYs (T10.3).
- [ ] 1GB output stress passes — no freeze, no crash (T10.4).
- [ ] 24h leak test passes — RSS growth < 10% (T10.5).
- [ ] Crash recovery works — quit, kill, or panic → relaunch restores layout (T10.6).
- [ ] 14 consecutive days of dogfood use with no must-fix items in `FRICTION.md` (T10.8).
- [ ] Old terminal app undocked / uninstalled for 7 consecutive days (T10.9).
- [ ] Visual + interaction parity with `work-station-design/` prototype (§1.5) — every implemented component matches the prototype, except where the plan explicitly says otherwise (e.g. Privacy toggles disabled).
