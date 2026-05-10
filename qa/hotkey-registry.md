# Hotkey registry (T8.1)

Manual verification that every globally-installed hotkey now reads its
binding from `src/hotkeys/registry.ts`. Refactor only — bindings are
unchanged from the pre-T8.1 behavior.

## What moved into the registry

Document-level handlers that previously hand-rolled `metaKey` / `ctrlKey`
checks now call `eventMatchesBinding(e, getBinding(actionId))`:

| Action id            | Binding (mac → other)        | Installed by                         |
| -------------------- | ---------------------------- | ------------------------------------ |
| `add-project`        | ⌘N → Ctrl+N                  | `paneHotkeys.ts`                     |
| `split-v`            | ⌘\\ → Ctrl+\\                | `paneHotkeys.ts`                     |
| `split-h`            | ⌘⇧\\ → Ctrl+Shift+\\         | `paneHotkeys.ts`                     |
| `close-pane`         | ⌘W → Ctrl+W                  | `paneHotkeys.ts`                     |
| `quick-switcher`     | ⌘K → Ctrl+K                  | `App.tsx`                            |
| `find-in-terminal`   | ⌘F → Ctrl+F                  | `Terminal.tsx`, `TerminalSearch.tsx` |
| `find-cross-session` | ⌘⇧F → Ctrl+Shift+F           | `App.tsx`                            |
| `project-1` … `9`    | ⌘1..9 → Ctrl+1..9            | `numericProjectHotkeys.ts`           |
| `pane-nav-{l,r,u,d}` | ⌘⌥← → Ctrl+Alt+← (and r/u/d) | `paneNavHotkeys.ts`                  |

`Terminal.tsx`'s `attachCustomKeyEventHandler` no longer hardcodes which
keys to suppress — it iterates `listActions()` and returns `false` from
xterm for any event that matches a registered binding. New global
hotkeys are auto-suppressed without further changes.

## What is intentionally NOT in the registry

These keep raw modifier checks; they are not user-perceivable global
hotkeys and are out of scope for T8.1:

- **`Pane.tsx` `CliLaunchMenu` ⌘1..9** — modal-internal accelerator that
  picks the Nth item in a dynamic CLI list. Not fixed and not
  user-customizable.
- **`Terminal.tsx` ⌘+click on a URL** — mouse interaction, not a hotkey.
- **`Terminal.tsx` `handleCopyPasteKey`** — ⌘C / ⌘V. OS clipboard
  convention tied to terminal selection state.
- **`LayoutTree.live.dev.tsx`** — dev harness, not shipped.

## Smoke test

1. `pnpm tauri dev`. Spawn ≥2 projects, ≥2 panes in the active project.
2. ⌘\\ → splits the focused pane vertically (side-by-side); ⌘⇧\\ →
   horizontally (stacked). The action ids name the visible divider; see
   `qa/default-keybindings.md` for the post-T8.2 reconcile note.
3. ⌘W → closes the focused pane.
4. ⌘N → opens the Add Project modal.
5. ⌘1, ⌘2, ⌘3 → switches between projects in sidebar order. Verify the
   keystroke is consumed when focus is in an xterm pane (no stray digit
   echoed at the prompt).
6. ⌘⌥← / → / ↑ / ↓ → focus moves to the geometric neighbor pane.
7. ⌘K → quick switcher opens. Type to filter, ↑/↓ to move, Enter to pick.
8. ⌘F inside a terminal → in-pane search overlay opens. ⌘F again with
   the search input focused → input contents re-selected.
9. ⌘⇧F → cross-session search modal opens. Doesn't echo `^F` to the
   shell.

## Rebinding (deferred)

`setBinding(id, binding)` is wired into the store but no UI surfaces it
yet — that's T8.7. Manual smoke: in the devtools console, run
`__hotkeys.setBinding("close-pane", { modifiers: ["mod","shift"], key: "w" })`
after exposing the registry; verify ⌘W stops closing and ⌘⇧W starts
closing. (Skip unless explicitly testing rebinding.)

## Cross-platform modifier

The registry resolves the logical `mod` modifier to ⌘ on macOS and
Ctrl elsewhere via `isMac` from `utils/platform.ts`. `eventMatchesBinding`
strictly rejects when the cross-platform modifier is held, so on macOS
`Ctrl+W` won't trigger the `close-pane` action and on Windows/Linux
`Cmd+W` won't either.
