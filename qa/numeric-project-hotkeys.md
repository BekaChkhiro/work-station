# Numeric project hotkeys (T6.3)

Manual verification for `Cmd/Ctrl+1..9` jumping to the project at sidebar
position N. Wired in `src/hotkeys/numericProjectHotkeys.ts`, installed by
`AppShell` on mount.

## How to run

1. Build the dev app: `pnpm tauri dev`.
2. In the Tauri window, navigate to `?wsdebug=appshell`. Three demo
   projects spawn: `argon-web` (1), `kepler-cli` (2), `borealis-api` (3).

## Acceptance — "hotkey works everywhere except plain text inputs"

### Works from the sidebar / empty workspace

1. Click the **sidebar** (any project row) so focus leaves the terminal
   pane.
2. Press `Cmd+2` (macOS) or `Ctrl+2` (Windows/Linux). The active project
   should switch to `kepler-cli`.
3. Press `Cmd+1` / `Ctrl+1` → back to `argon-web`. Press `Cmd+3` /
   `Ctrl+3` → `borealis-api`. Press `Cmd+4` → no change (no project at
   index 4).

### Works from inside a terminal pane

1. Click into the active project's terminal so xterm has focus.
2. Press `Cmd+2` / `Ctrl+2`. The active project should switch to
   `kepler-cli` and the keystroke must NOT reach the shell (no stray
   `^B` / digit echo in the prompt). xterm's
   `attachCustomKeyEventHandler` returns false for `Cmd+1..9` so the
   document-level handler in `numericProjectHotkeys.ts` owns the event.
3. Switching back to the prior project should immediately restore
   focus to the last-active terminal — start typing without clicking.

### Suppressed inside plain text inputs

Once a surface (settings page, add-project form, search box) exposes a
focusable text input, the hotkey must stay inert while the caret is in
that input. The hook tests for `INPUT`/`TEXTAREA`/`SELECT` elements and
`contenteditable` regions; xterm panes are explicitly NOT treated as
plain text inputs for this hotkey.

## Modifier rules

- `Cmd` on macOS, `Ctrl` elsewhere — detected via `navigator.platform`.
- `Alt`/`Option` and `Shift` modifiers cancel the match; `Cmd+Shift+1`
  is reserved for future bindings (e.g. `Cmd+Shift+F` cross-search,
  T4.13).
- `0`, letters, and `Cmd` alone are ignored.

## Out of scope (deferred)

- Centralized hotkey registry with rebinding UI — T8.1 / T8.2.
- `Cmd+K` quick switcher modal — T6.4.
- `Cmd+N` new-project shortcut wiring — T6.5.
