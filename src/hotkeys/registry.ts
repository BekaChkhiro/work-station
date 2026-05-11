// T8.1 / T8.2: Centralized hotkey registry.
//
// Every keyboard shortcut in the app is declared here once, with a stable
// action id, a human label, and a `Binding` describing the modifiers + key.
// Document-level handlers (split, close, project switch, pane nav…) consult
// the registry via `eventMatchesBinding(e, getBinding(id))` instead of
// hand-rolling their own `metaKey` / `ctrlKey` checks. This keeps the
// platform branch (Cmd vs Ctrl) in exactly one place and is the source of
// truth for the cheatsheet (T8.2) and the rebinding UI (T8.7).
//
// The registry is a Solid store so a rebinding setter (T8.7) can mutate
// bindings at runtime and document-level handlers will pick up the new
// value on the next keystroke without re-installation.
//
// Action id convention (user-facing, mirrors the prototype WS_HOTKEYS in
// DESIGN_PROMPT_PHASE2.md):
//   • `split-v` — vertical split: panes side-by-side (vertical divider).
//     Maps to `SplitPane` direction "h" (horizontal layout) when dispatched.
//   • `split-h` — horizontal split: panes stacked (horizontal divider).
//     Maps to `SplitPane` direction "v" (vertical layout) when dispatched.
// The id describes what the user sees; the SplitPane direction code names
// the layout axis. Consumers (paneHotkeys.ts) flip between the two.

import { createStore } from "solid-js/store";
import { isMac } from "../utils/platform";
import { getSetting, setSetting } from "../db/settings";

/** A logical modifier. `mod` resolves to Cmd on macOS, Ctrl elsewhere —
 *  binding authors never need to care about the host OS. */
export type Modifier = "mod" | "shift" | "alt";

/** Modifiers + key. `key` is matched against `KeyboardEvent.key`:
 *  - letters: lowercase, e.g. `"w"` (matched case-insensitively)
 *  - digits / symbols: literal, e.g. `"1"`, `"\\"`, `","`
 *  - special keys: literal `KeyboardEvent.key`, e.g. `"ArrowLeft"` */
export interface Binding {
  modifiers: Modifier[];
  key: string;
}

export interface HotkeyAction {
  id: string;
  label: string;
  binding: Binding;
}

// Default action set — every hotkey shipped with the app. T8.7 will let the
// user override individual bindings; until then the user-visible cheatsheet
// renders this list verbatim.
const DEFAULT_ACTIONS: HotkeyAction[] = [
  { id: "add-project", label: "New project", binding: { modifiers: ["mod"], key: "n" } },
  // T8.2 — `new-tab` is registered so it appears in the cheatsheet and is
  // suppressed by xterm's customKeyEventHandler. The actual tab-spawn flow
  // lands with the project workspace tab system in T11.1; until then the
  // binding is a no-op.
  { id: "new-tab", label: "New terminal tab", binding: { modifiers: ["mod"], key: "t" } },
  // T8.2 — vertical split (panes side-by-side) on Cmd+\, horizontal split
  // (stacked) on Cmd+Shift+\. Matches the prototype WS_HOTKEYS naming. The
  // SplitPane direction code is the inverse — paneHotkeys.ts handles the
  // mapping.
  {
    id: "split-v",
    label: "Split pane vertically",
    binding: { modifiers: ["mod"], key: "\\" },
  },
  {
    id: "split-h",
    label: "Split pane horizontally",
    binding: { modifiers: ["mod", "shift"], key: "\\" },
  },
  { id: "close-pane", label: "Close pane", binding: { modifiers: ["mod"], key: "w" } },
  // T13.4 — `save-file` is the editor save accelerator. On macOS the
  // native menu accelerator (Cmd+S) drives the menu event; on Windows
  // the WindowsAppMenu picks up the same registry binding. EditorWorkspace
  // listens for the dispatched menu action and only triggers a save when
  // the editor tab is the active workspace tab.
  { id: "save-file", label: "Save file", binding: { modifiers: ["mod"], key: "s" } },
  { id: "quick-switcher", label: "Quick switcher", binding: { modifiers: ["mod"], key: "k" } },
  {
    id: "find-in-terminal",
    label: "Find in terminal",
    binding: { modifiers: ["mod"], key: "f" },
  },
  {
    id: "find-cross-session",
    label: "Find across sessions",
    binding: { modifiers: ["mod", "shift"], key: "f" },
  },
  // T8.2 — registered for cheatsheet visibility; settings page (T8.7) and
  // sidebar toggle wiring land later. Pressing them today is a no-op other
  // than xterm suppressing the keystroke.
  { id: "open-settings", label: "Open settings", binding: { modifiers: ["mod"], key: "," } },
  { id: "toggle-sidebar", label: "Toggle sidebar", binding: { modifiers: ["mod"], key: "b" } },
  {
    id: "show-cheatsheet",
    label: "Show keyboard shortcuts",
    binding: { modifiers: ["mod"], key: "/" },
  },
  ...Array.from({ length: 9 }, (_, i): HotkeyAction => {
    const n = i + 1;
    return {
      id: `project-${n}`,
      label: `Switch to project ${n}`,
      binding: { modifiers: ["mod"], key: String(n) },
    };
  }),
  {
    id: "pane-nav-left",
    label: "Focus pane to the left",
    binding: { modifiers: ["mod", "alt"], key: "ArrowLeft" },
  },
  {
    id: "pane-nav-right",
    label: "Focus pane to the right",
    binding: { modifiers: ["mod", "alt"], key: "ArrowRight" },
  },
  {
    id: "pane-nav-up",
    label: "Focus pane above",
    binding: { modifiers: ["mod", "alt"], key: "ArrowUp" },
  },
  {
    id: "pane-nav-down",
    label: "Focus pane below",
    binding: { modifiers: ["mod", "alt"], key: "ArrowDown" },
  },
];

const [actions, setActions] = createStore<HotkeyAction[]>(
  DEFAULT_ACTIONS.map((a) => ({
    ...a,
    binding: { ...a.binding, modifiers: [...a.binding.modifiers] },
  })),
);

// T8.7 — Persisted hotkey overrides. The on-disk format is a flat map of
// `actionId → serialized binding` (see `serializeBinding`); a missing entry
// falls back to the registry default. `setBinding` writes through to SQL,
// `loadPersistedBindings` rehydrates on app boot, and `resetBindingsToDefaults`
// wipes the override map back to the empty object.
//
// Suppress write-through during the initial hydrate so we don't echo the
// freshly-loaded value straight back to SQL.
let persistEnabled = false;

const MODIFIER_TOKENS: readonly Modifier[] = ["mod", "shift", "alt"];

function serializeBinding(b: Binding): string {
  const mods = MODIFIER_TOKENS.filter((m) => b.modifiers.includes(m));
  return [...mods, b.key].join("+");
}

function parseBinding(s: string): Binding | null {
  const parts = s.split("+");
  if (parts.length === 0) return null;
  const key = parts[parts.length - 1];
  if (!key) return null;
  const mods: Modifier[] = [];
  for (let i = 0; i < parts.length - 1; i += 1) {
    const tok = parts[i];
    if (tok === "mod" || tok === "shift" || tok === "alt") {
      if (!mods.includes(tok)) mods.push(tok);
    } else {
      return null;
    }
  }
  return { modifiers: mods, key };
}

/** Read the current binding for an action id. Handlers call this lazily
 *  inside their event listener so a rebinding (T8.7) takes effect on the
 *  next keystroke without re-installing the listener. */
export function getBinding(id: string): Binding | undefined {
  return actions.find((a) => a.id === id)?.binding;
}

/** Replace the binding for an existing action. No-op if `id` is unknown.
 *  Reactive — UI consumers (T8.2 cheatsheet, T8.7 rebinder) re-render.
 *  Writes through to `app_settings.hotkeys` once persistence is enabled. */
export function setBinding(id: string, binding: Binding): void {
  const idx = actions.findIndex((a) => a.id === id);
  if (idx === -1) return;
  const next: Binding = { ...binding, modifiers: [...binding.modifiers] };
  setActions(idx, "binding", next);
  if (!persistEnabled) return;
  void persistBinding(id, next).catch((err) =>
    console.warn("[hotkeys] persist binding failed", err),
  );
}

async function persistBinding(id: string, binding: Binding): Promise<void> {
  const existing = await getSetting("hotkeys");
  const def = DEFAULT_ACTIONS.find((a) => a.id === id);
  // If the new binding matches the default, drop the override so a future
  // default change can flow through automatically.
  if (def && bindingsEqual(def.binding, binding)) {
    if (id in existing) {
      const next = Object.fromEntries(
        Object.entries(existing).filter(([actionId]) => actionId !== id),
      );
      await setSetting("hotkeys", next);
    }
    return;
  }
  await setSetting("hotkeys", { ...existing, [id]: serializeBinding(binding) });
}

/** T8.7 — Load persisted overrides on app boot and enable write-through.
 *  Idempotent: a second call is a no-op. */
export async function loadPersistedBindings(): Promise<void> {
  if (persistEnabled) return;
  try {
    const overrides = await getSetting("hotkeys");
    for (const [id, serialized] of Object.entries(overrides)) {
      const parsed = parseBinding(serialized);
      if (!parsed) continue;
      const idx = actions.findIndex((a) => a.id === id);
      if (idx === -1) continue;
      setActions(idx, "binding", parsed);
    }
  } catch (err) {
    console.warn("[hotkeys] load persisted bindings failed", err);
  } finally {
    persistEnabled = true;
  }
}

/** T8.7 — Restore every action to its registered default and clear the
 *  on-disk override map. Used by the "Reset to defaults" affordance in the
 *  Keybindings settings section. */
export async function resetBindingsToDefaults(): Promise<void> {
  for (let i = 0; i < DEFAULT_ACTIONS.length; i += 1) {
    const def = DEFAULT_ACTIONS[i];
    if (!def) continue;
    setActions(i, "binding", {
      ...def.binding,
      modifiers: [...def.binding.modifiers],
    });
  }
  if (persistEnabled) {
    await setSetting("hotkeys", {});
  }
}

/** T8.7 — Default binding for an action id, for "is overridden?" checks
 *  in the rebinder UI and the reset affordance. */
export function getDefaultBinding(id: string): Binding | undefined {
  const def = DEFAULT_ACTIONS.find((a) => a.id === id);
  if (!def) return undefined;
  return { ...def.binding, modifiers: [...def.binding.modifiers] };
}

/** All registered actions, in declaration order. For T8.2 cheatsheet UI. */
export function listActions(): readonly HotkeyAction[] {
  return actions;
}

/** Two bindings are equal when they share the same key (case-insensitive
 *  for letters) and the same set of modifiers. Modifier order is ignored. */
export function bindingsEqual(a: Binding, b: Binding): boolean {
  if (normalizeKey(a.key) !== normalizeKey(b.key)) return false;
  if (a.modifiers.length !== b.modifiers.length) return false;
  for (const m of a.modifiers) {
    if (!b.modifiers.includes(m)) return false;
  }
  return true;
}

export interface BindingConflict {
  binding: Binding;
  ids: string[];
}

/** Find every binding that's claimed by more than one action. Returns one
 *  entry per conflicting binding, with the colliding action ids in
 *  registration order. Empty array when the registry is conflict-free. The
 *  cheatsheet renders this as a warning row; the rebinder (T8.7) uses it
 *  to block a save that would introduce a clash. */
export function findConflicts(): BindingConflict[] {
  const groups: BindingConflict[] = [];
  for (const action of actions) {
    const existing = groups.find((g) => bindingsEqual(g.binding, action.binding));
    if (existing) {
      existing.ids.push(action.id);
    } else {
      groups.push({
        binding: { ...action.binding, modifiers: [...action.binding.modifiers] },
        ids: [action.id],
      });
    }
  }
  return groups.filter((g) => g.ids.length > 1);
}

const isLetter = (k: string): boolean => k.length === 1 && /^[a-zA-Z]$/.test(k);

const normalizeKey = (k: string): string => (isLetter(k) ? k.toLowerCase() : k);

/** Strict event ↔ binding match. Rejects when extra modifiers are held
 *  (so `Cmd+Shift+W` won't trigger a binding declared as `Cmd+W`) and
 *  when the cross-platform modifier is held (so `Ctrl+W` on macOS
 *  doesn't fire a binding meant for `Cmd+W`). */
export function eventMatchesBinding(e: KeyboardEvent, b: Binding): boolean {
  const needMod = b.modifiers.includes("mod");
  const needShift = b.modifiers.includes("shift");
  const needAlt = b.modifiers.includes("alt");

  const hasMod = isMac ? e.metaKey : e.ctrlKey;
  const otherPlatformMod = isMac ? e.ctrlKey : e.metaKey;

  if (hasMod !== needMod) return false;
  if (e.shiftKey !== needShift) return false;
  if (e.altKey !== needAlt) return false;
  if (otherPlatformMod) return false;

  return normalizeKey(e.key) === normalizeKey(b.key);
}

const ARROW_GLYPHS: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
};

const formatKey = (k: string): string => {
  const glyph = ARROW_GLYPHS[k];
  if (glyph !== undefined) return glyph;
  if (k.length === 1) return k.toUpperCase();
  return k;
};

/** Humanize a binding for display. `⌘⇧W` on macOS, `Ctrl+Shift+W` on
 *  Windows/Linux. Modifier order matches platform conventions. */
export function formatBinding(b: Binding): string {
  if (isMac) {
    const sym: Record<Modifier, string> = { mod: "⌘", shift: "⇧", alt: "⌥" };
    // Apple HIG order: Ctrl, Option, Shift, Command — we have alt+shift+mod.
    const order: Modifier[] = ["alt", "shift", "mod"];
    const parts = order.filter((m) => b.modifiers.includes(m)).map((m) => sym[m]);
    return [...parts, formatKey(b.key)].join("");
  }
  const sym: Record<Modifier, string> = { mod: "Ctrl", shift: "Shift", alt: "Alt" };
  const order: Modifier[] = ["mod", "alt", "shift"];
  const parts = order.filter((m) => b.modifiers.includes(m)).map((m) => sym[m]);
  return [...parts, formatKey(b.key)].join("+");
}
