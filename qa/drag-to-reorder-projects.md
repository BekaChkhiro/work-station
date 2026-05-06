# Drag-to-reorder projects (T6.7)

Manual verification for the sidebar drag-to-reorder behavior. The drag
handler lives on each row's grip span (left edge, hover-revealed); the
TS reorder math mirrors `TabStrip` (T5.3). Persistence is the
`project_reorder` Tauri command, which rewrites every project's
`position` column inside one SQLite transaction.

## How to run

1. Build the dev app: `pnpm tauri dev`.
2. In the Tauri window, navigate to `?wsdebug=appshell`. Three demo
   projects spawn in order: `argon-web` (1), `kepler-cli` (2),
   `borealis-api` (3).

## Acceptance — "Reorder survives restart"

1. Hover any sidebar row. A 6-dot grip handle should fade in at the
   left edge of the row (only visible while expanded).
2. Press and drag the **argon-web** grip down past **borealis-api**'s
   midpoint. While dragging:
   - The dragged row should lift ~2px and gain a popover-style shadow.
   - A 2px accent-colored insertion bar should appear between rows,
     snapping to the nearest gap as you move.
3. Release. The sidebar should reorder to: `kepler-cli`, `borealis-api`,
   `argon-web`. The active project highlight stays attached to the same
   project (no spurious activation on drop).
4. Quit the app (`Cmd+Q`) and relaunch via `pnpm tauri dev` →
   `?wsdebug=appshell`. The order from step 3 must persist exactly.

## Acceptance — "Numeric hotkeys map to new positions immediately"

1. After step 3 above, click the sidebar (so focus leaves the terminal).
2. Press `Cmd+1` (macOS) / `Ctrl+1` (Win/Linux). Active project should
   switch to **kepler-cli** (the new position-1 row).
3. `Cmd+2` → `borealis-api`. `Cmd+3` → `argon-web`.
4. Drag `borealis-api` to position 1. Without restarting, repeat the
   hotkey check — `Cmd+1` should now activate `borealis-api`.

## Acceptance — "Visual matches tab-drag pattern from T5.3"

- Slop threshold: clicking the grip without moving (or moving less than
  ~4px) does NOT trigger reorder. The row should not jump.
- Click suppression: releasing on the source slot, or on the gap
  immediately above/below the source, does not reorder and does not
  fire the row's `onActivate` (no project switch on drop).
- Drag indicator: only the insertion bar moves during drag — sibling
  rows stay still until release.
- Cancellation: pressing `Esc` mid-drag is NOT supported by design
  (matches TabStrip); releasing the pointer outside the sidebar still
  resolves to the nearest gap (or no-op if outside the rect entirely).

## Edge cases

- **Single project**: with only one project, the grip is still hover-
  revealed but releases immediately commit no change (insertion ==
  source).
- **Collapsed sidebar**: with the sidebar collapsed (chevron at the
  top), the grip and pencil are hidden; reorder is unavailable until
  the sidebar is re-expanded. (Drag is a fine-motor affordance — the
  collapsed rail is icon-only.)
- **DB drift**: if the backend list disagrees with the UI snapshot
  (e.g. a project was deleted in another window), `project_reorder`
  rejects with `ReorderMismatch` and the live harness rolls back the
  optimistic UI update + surfaces the message in the harness banner.

## Out of scope (deferred)

- Auto-scroll while dragging near the top/bottom of the list — list
  fits its rows comfortably for now; revisit when project count grows.
- Keyboard-driven reorder (e.g. `Cmd+Alt+↑/↓`) — wait for the hotkey
  registry in T8.1.
- Drag in the collapsed (rail) state — pencil + grip are both hidden
  there; reorder lives behind the explicit expand affordance.
