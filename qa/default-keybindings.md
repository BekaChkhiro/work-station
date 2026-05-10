# Default keybindings + cheatsheet (T8.2)

Manual verification that the production registry ships the full default
keybinding set from the project plan and that the Cmd+/ cheatsheet renders
every binding (and surfaces conflicts when they appear).

## Default action set

Every binding is declared in `src/hotkeys/registry.ts`. `mod` resolves to
⌘ on macOS and Ctrl elsewhere.

| Action id            | Binding (mac → other)        | Wired today via                      |
| -------------------- | ---------------------------- | ------------------------------------ |
| `add-project`        | ⌘N → Ctrl+N                  | `paneHotkeys.ts`                     |
| `new-tab`            | ⌘T → Ctrl+T                  | _registered only — wires in T11.1_   |
| `split-v`            | ⌘\\ → Ctrl+\\                | `paneHotkeys.ts` (→ direction "h")   |
| `split-h`            | ⌘⇧\\ → Ctrl+Shift+\\         | `paneHotkeys.ts` (→ direction "v")   |
| `close-pane`         | ⌘W → Ctrl+W                  | `paneHotkeys.ts`                     |
| `quick-switcher`     | ⌘K → Ctrl+K                  | `App.tsx`                            |
| `find-in-terminal`   | ⌘F → Ctrl+F                  | `Terminal.tsx`, `TerminalSearch.tsx` |
| `find-cross-session` | ⌘⇧F → Ctrl+Shift+F           | `App.tsx`                            |
| `open-settings`      | ⌘, → Ctrl+,                  | _registered only — wires in T8.7_    |
| `toggle-sidebar`     | ⌘B → Ctrl+B                  | _registered only_                    |
| `show-cheatsheet`    | ⌘/ → Ctrl+/                  | `App.tsx`                            |
| `project-1` … `9`    | ⌘1..9 → Ctrl+1..9            | `numericProjectHotkeys.ts`           |
| `pane-nav-{l,r,u,d}` | ⌘⌥← → Ctrl+Alt+← (and r/u/d) | `paneNavHotkeys.ts`                  |

### Naming reconcile

Pre-T8.2 the action ids `split-h` and `split-v` mirrored `SplitPane`'s
`direction` codes. The prototype `WS_HOTKEYS` (DESIGN*PROMPT_PHASE2.md:462)
and the project plan (T8.2 spec) name them by the \_visual* split — `split-v`
= side-by-side panes (vertical divider), `split-h` = stacked (horizontal
divider). The registry now uses the prototype convention; `paneHotkeys.ts`
flips the id to the SplitPane direction code when dispatching.

## Cheatsheet (Cmd+/)

`src/components/HotkeyCheatsheet/HotkeyCheatsheet.tsx` is a centered modal
that renders every action in `listActions()` with its `formatBinding()`
output. A live filter input matches against label, id, or formatted
binding. `findConflicts()` runs reactively — any binding shared by two or
more actions surfaces in a warning banner above the list.

## Smoke test

1. `pnpm tauri dev`. Open ≥1 project with a focused pane.
2. ⌘/ — cheatsheet modal opens. Verify the list contains every row from
   the table above. Each row shows a label and a formatted binding chip
   (⌘⇧\\ on macOS, Ctrl+Shift+\\ otherwise). No conflict banner is shown.
3. Type `split` in the filter — only `Split pane vertically` and `Split
pane horizontally` remain. Type `cmd` (mac) / `ctrl` (other) — most
   rows match. Clear filter → full list returns.
4. Esc / backdrop click closes the modal. ⌘/ again toggles it open.
5. ⌘\\ in a focused pane → side-by-side split (vertical divider). ⌘⇧\\ →
   stacked split (horizontal divider). Behavior is unchanged from before
   T8.2; only the ids/labels were reconciled.
6. ⌘W, ⌘N, ⌘K, ⌘F, ⌘⇧F, ⌘1..9, ⌘⌥← / → / ↑ / ↓ all behave as before.

## Conflict detection — manual

To verify the conflict path, in the devtools console after exposing the
registry (or temporarily importing `setBinding` in a dev harness):

```js
import { setBinding } from "./hotkeys";
setBinding("toggle-sidebar", { modifiers: ["mod"], key: "k" });
```

Then ⌘/ — the conflicts banner should list "⌘K bound to Quick switcher
and Toggle sidebar". Reload to revert (bindings reset to defaults).

## Out of scope (deferred)

- `new-tab`, `open-settings`, `toggle-sidebar` are registered so they
  appear in the cheatsheet and so xterm suppresses the keystroke (via
  `Terminal.tsx`'s `customKeyEventHandler` iterating `listActions()`).
  Their handlers ship later: T11.1 (workspace tabs), T8.7 (settings),
  and a sidebar toggle pass.
- Rebinding UI (`setBinding` exists; no surface). Lands with T8.7.
