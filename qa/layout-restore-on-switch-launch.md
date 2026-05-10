# Layout restore on switch / launch (T5.9)

Manual verification for T5.9: the layout tree of every project survives
a project switch instantly (no remount, no PTY churn) and is restored
from SQLite on a fresh app launch with a new set of PTYs.

T5.9 is implemented as a side-effect of two earlier tasks plus one new
piece in this task:

| Concern                                 | Lives in                                      |
| --------------------------------------- | --------------------------------------------- |
| Switch is non-destructive (no remount)  | T6.2 — `AppShell` keeps every layout mounted. |
| Layout JSON persisted on every change   | T5.8 — debounced `LayoutPersister` (500 ms).  |
| Fresh PTYs spawned for the saved layout | T2.12 — `restoreProjectLayout` in `AppRoot`.  |
| Last active project survives restart    | T5.9 — `last_active_project` setting.         |

## Prerequisites

- Run the real Tauri shell (`pnpm tauri dev`); SQLite + PTY bridges are
  not available in plain `pnpm dev`.
- At least two projects with valid folder paths and at least one CLI
  on `PATH` (claude / codex / kimi / a system shell).

## Acceptance 1 — switch is <100 ms with no PTY churn

1. Open project A, spawn one terminal, run `for i in 1 2 3 4 5 6 7 8 9 10; do echo "A $i"; sleep 1; done`.
2. Switch to project B (sidebar click, `Cmd/Ctrl+K` switcher, or
   `Cmd/Ctrl+2`). Wait 4–5 seconds.
3. Switch back to A (`Cmd/Ctrl+1`).

**Pass:**

- Switch feels instant (no spinner, no flash). The xterm in A redraws
  once and shows every `A N` line that printed during the absence.
- No new PTY rows in `sessions` (the layout tree A had before is the
  same one shown after).

**Fail modes:**

- Lines missing → switch tore down the layout / re-spawned PTYs.
  Check that `setActiveProject` in `src/stores/workspace.ts` is still a
  single store write and `AppShell` still uses `display: none` toggling
  (not conditional render).
- Switch is laggy (>100 ms) → likely a regression in `AppShell`'s
  per-project mount loop or a Terminal `onMount` doing work on every
  visibility flip rather than first mount.

## Acceptance 2 — split layout survives a relaunch

1. In project A, open one terminal, then split it horizontally
   (`Cmd/Ctrl+\`) and vertically (`Cmd/Ctrl+Shift+\`). You now have
   three panes.
2. Drag the split handles to non-default ratios. Wait at least 600 ms
   so the debounced persister (500 ms) has flushed at least once.
3. Quit the app fully (Cmd+Q on macOS, close on others).
4. Relaunch.

**Pass:**

- Project A reopens with the same three-pane layout and the same
  ratios. Each pane has a fresh shell prompt (PTYs are new — original
  scrollback is gone).
- The pane that was focused before the relaunch is focused again.

**Fail modes:**

- Empty workspace on relaunch → `getOrCreateProjectSession` returned
  `EMPTY_LAYOUT`. Check `sessions.layout_json` in
  `~/Library/Application Support/.../app.db`; if it's `{}` the
  persister didn't flush. If it has a tree but the workspace is still
  empty, `restoreProjectLayout` failed silently — look for
  `[T2.12] layout persist failed` in the console.
- Layout restored but ratios are 0.5 → debounce flushed mid-drag
  (unlikely — `LAYOUT_PERSIST_DEBOUNCE_MS` is 500 ms; the most recent
  ratio should win).
- A pane shows a missing-CLI warning banner → the project's configured
  CLI isn't on `PATH`; the fallback shell launched. Reset by changing
  the CLI in the project edit modal.

## Acceptance 3 — last active project survives a relaunch

1. With at least two projects registered, switch to the second one
   (so the first-registered default isn't what's active).
2. Quit and relaunch.

**Pass:** the second project is active again. Sidebar highlight,
visible layout, and `Cmd/Ctrl+N` numeric mapping all reflect that.

**Fail modes:**

- First project active on relaunch → `last_active_project` was not
  written. Inspect `app_settings` in the DB; the row should hold the
  JSON-encoded id string.
- Active id is a deleted project → the workspace store ignores
  unregistered ids in `setActiveProject`, so the addProject default
  (first registered) takes over. This is the intended fallback.

## Secondary checks

- **No remount on switch:** With Solid devtools, confirm Terminals in
  the inactive project remain mounted across switches.
- **Layout-only is in-memory:** While in project A, run a long-lived
  command. Switch to B, kill A's PTY from the OS process tree (e.g.
  `kill -9 <pid>`). Switch back: the pane shows the dead-shell exit
  message. The _layout_ tree is unaffected — T5.9 does not promise PTY
  resurrection mid-session.

## Out of scope (deferred)

- Cross-session search across closed PTYs — T4.13 (separate task).
- Restoring xterm scrollback content from disk — explicitly not in the
  v0.1 plan; relaunch always starts panes with empty scrollback.
- Restoring per-pane focus _across_ a relaunch — current behaviour
  refocuses the first pane in the restored tree, not the previously
  focused one. Promote to a follow-up if users ask for it.
