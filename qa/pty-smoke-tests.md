# PTY smoke tests (T2.14)

Living matrix of **manual** smoke tests that drive a real PTY through Work Station's full pipeline (Rust `pty/` → IPC → `xterm.js` renderer) and verify each canonical TUI renders correctly on each supported OS.

> **Personal-use scope.** Acceptance for T2.14 is "each command listed shows correct rendering on each OS." Two machines (one macOS, one Windows) — that's the entire QA universe per `PROJECT_PLAN.md` §10 (T10.1 was DROPPED). Linux is out (per `AGENTS.md` §3, hard rule 3).
>
> **Renderer dependency.** Manual rendering verification depends on the xterm.js render layer (T4.1+). Until that lands, leave matrix cells empty. Backfill once the renderer is live and you've actually driven each TUI in the app.

## Prerequisites

### Build

Run a fresh dev build from the branch under test:

```bash
pnpm install            # if deps changed
pnpm tauri dev          # the build whose output you smoke-test
```

Record the commit SHA (`git rev-parse --short HEAD`) and the app build mode (`dev` / `release`) in the matrix row's **SHA** column.

### Commands to install

Each row in the matrix needs the command available on the host. Skip any that aren't installable on the OS you're testing — record `N/A (not installed)` in the matrix row.

| Command  | macOS install                         | Windows install                                                                                                                            |
| -------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `htop`   | `brew install htop`                   | `winget install htop` (third-party port; quality varies — if absent, leave the row empty rather than substituting `top`)                   |
| `vim`    | preinstalled (`/usr/bin/vim`)         | `winget install vim.vim` or use the [official Vim installer](https://www.vim.org/download.php#pc)                                          |
| `claude` | `npm install -g @anthropic-ai/claude` | same                                                                                                                                       |
| `pwsh`   | `brew install --cask powershell`      | preinstalled on Windows 11; on Windows 10 install via [Microsoft Store](https://aka.ms/PSWindows) or `winget install Microsoft.PowerShell` |
| `nvim`   | `brew install neovim`                 | `winget install Neovim.Neovim`                                                                                                             |

## How to run

1. Launch Work Station via `pnpm tauri dev` (or a release bundle).
2. Open a fresh terminal pane (per `PROJECT_PLAN.md` §3, fresh PTY in current project's cwd).
3. Run the command listed in the matrix row.
4. Walk through the **Checks** below.
5. Quit the command (per the **Quit key** column).
6. Fill in the matrix row with `pass` / `fail` (`fail` requires a paired `Notes` entry naming the symptom; if `fail`, also open a tracking issue and reference it).

Repeat per OS. Run each row at least once per release candidate, and any time `src-tauri/src/pty/` or `src/components/Terminal/*` (xterm wiring) changes.

## Checks expanded

### ANSI colors

The TUI's default colors render correctly: foreground/background match the terminal app's other apps (e.g. green strings in `vim`, the `htop` CPU bars, `nvim` syntax highlights).

**Pass criteria:** colors appear distinct, not garbled into raw escape sequences (no visible `^[[31m` text in the pane). Bold/italic render where the TUI uses them.

### Alt-buffer enter / exit

A "full-screen" TUI (`htop`, `vim`, `nvim`) should swap to the **alternate screen buffer** on launch and restore the prior screen contents on exit — i.e. the shell prompt and previous output reappear unchanged after `:q!` / `q`.

**Pass criteria:** prior pane contents return after quitting the TUI. The TUI does not leave residual frame artifacts in the scrollback.

`claude` and `pwsh` typically render inline in the primary buffer; mark **Alt-buffer** as `N/A` for those rows unless the version under test has switched to alt-buffer behavior.

### Resize while running

Drag the app window or split / merge a pane while the TUI is running. The PTY must receive a resize (verified by the kernel re-flowing the child's output) and the TUI must redraw at the new dimensions without scrambling.

**Pass criteria:** TUI redraws cleanly within ~one frame; no stuck cursor, no half-rendered rows, no crash. The app does not hang.

## Quit keys (reference)

| Command  | Quit                                    |
| -------- | --------------------------------------- |
| `htop`   | `q`                                     |
| `vim`    | `Esc` then `:q!` then `Enter`           |
| `nvim`   | `Esc` then `:q!` then `Enter`           |
| `claude` | `Ctrl+C` twice, or `/exit` then `Enter` |
| `pwsh`   | `exit` then `Enter`                     |

## Matrix

Per-command results. Each row is one (command × OS) cell. Columns:

- **Date** — UTC date of the run (`YYYY-MM-DD`).
- **SHA** — `git rev-parse --short HEAD` of the build under test.
- **Build** — `dev` (`pnpm tauri dev`) or `release` (`pnpm tauri build`).
- **ANSI colors** — `pass` / `fail` / `N/A`.
- **Alt-buffer** — `pass` / `fail` / `N/A`.
- **Resize** — `pass` / `fail` / `N/A`.
- **Notes** — required when any column is `fail`; name the symptom and link the tracking issue.

### `htop`

| OS      | Date | SHA | Build | ANSI colors | Alt-buffer | Resize | Notes |
| ------- | ---- | --- | ----- | ----------- | ---------- | ------ | ----- |
| macOS   |      |     |       |             |            |        |       |
| Windows |      |     |       |             |            |        |       |

### `vim`

| OS      | Date | SHA | Build | ANSI colors | Alt-buffer | Resize | Notes |
| ------- | ---- | --- | ----- | ----------- | ---------- | ------ | ----- |
| macOS   |      |     |       |             |            |        |       |
| Windows |      |     |       |             |            |        |       |

### `claude`

| OS      | Date | SHA | Build | ANSI colors | Alt-buffer | Resize | Notes |
| ------- | ---- | --- | ----- | ----------- | ---------- | ------ | ----- |
| macOS   |      |     |       |             | N/A        |        |       |
| Windows |      |     |       |             | N/A        |        |       |

### `pwsh`

| OS      | Date | SHA | Build | ANSI colors | Alt-buffer | Resize | Notes |
| ------- | ---- | --- | ----- | ----------- | ---------- | ------ | ----- |
| macOS   |      |     |       |             | N/A        |        |       |
| Windows |      |     |       |             | N/A        |        |       |

### `nvim`

| OS      | Date | SHA | Build | ANSI colors | Alt-buffer | Resize | Notes |
| ------- | ---- | --- | ----- | ----------- | ---------- | ------ | ----- |
| macOS   |      |     |       |             |            |        |       |
| Windows |      |     |       |             |            |        |       |

## When to re-run

- Before each `v0.x` tag (`PROJECT_PLAN.md` Phase 10).
- After any change touching `src-tauri/src/pty/`, `src/components/Terminal/*`, or the xterm.js dependency pin.
- After bumping `portable-pty` (it gates ConPTY vs. forkpty behavior).
- After OS upgrades on the dev machines (e.g. major macOS / Windows feature update).

Older results stay in the matrix as audit trail until the next full re-run overwrites them. Don't delete a `fail` row without linking the fix's PR or commit SHA in the new row's `Notes`.
