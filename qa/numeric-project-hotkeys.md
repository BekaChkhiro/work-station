# Numeric project hotkeys (T6.3)

Manual verification for `Cmd/Ctrl+1..9` jumping to the project at sidebar
position N. Wired in `src/hotkeys/numericProjectHotkeys.ts`, installed by
`AppShell` on mount.

## How to run

1. Build the dev app: `pnpm tauri dev`.
2. In the Tauri window, navigate to `?wsdebug=appshell`. Three demo
   projects spawn: `argon-web` (1), `kepler-cli` (2), `borealis-api` (3).

## Acceptance — "hotkey works from anywhere except inside terminal/text input"

### Works

1. Click the **sidebar** (any project row) so focus leaves the terminal
   pane.
2. Press `Cmd+2` (macOS) or `Ctrl+2` (Windows/Linux). The active project
   should switch to `kepler-cli`.
3. Press `Cmd+1` / `Ctrl+1` → back to `argon-web`. Press `Cmd+3` /
   `Ctrl+3` → `borealis-api`. Press `Cmd+4` → no change (no project at
   index 4).

### Suppressed inside a terminal pane

1. Click into the active project's terminal so xterm has focus.
2. Press `Cmd+2` / `Ctrl+2`. The active project must NOT change. xterm
   handles the keystroke (no project switch is intentional — see
   `isEditableTarget` in `numericProjectHotkeys.ts`).
3. Click the sidebar; the same hotkey now switches projects.

### Suppressed inside text inputs

Once a future surface (settings page, add-project form, search box)
exposes a focusable text input, the hotkey must stay inert while the
caret is in that input. The hook tests for `INPUT`/`TEXTAREA`/`SELECT`
elements and `contenteditable` regions, so any standard editable
surface is covered automatically.

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
