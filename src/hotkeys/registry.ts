// T8.1: Centralized hotkey registry.
//
// Every keyboard shortcut in the app is declared here once, with a stable
// action id, a human label, and a `Binding` describing the modifiers + key.
// Document-level handlers (split, close, project switch, pane nav…) consult
// the registry via `eventMatchesBinding(e, getBinding(id))` instead of
// hand-rolling their own `metaKey` / `ctrlKey` checks. This keeps the
// platform branch (Cmd vs Ctrl) in exactly one place and is the source of
// truth for the future cheatsheet (T8.2) and rebinding UI (T8.7).
//
// The registry is a Solid store so a rebinding setter (T8.7) can mutate
// bindings at runtime and document-level handlers will pick up the new
// value on the next keystroke without re-installation.

import { createStore } from "solid-js/store";
import { isMac } from "../utils/platform";

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

// Default action set — every hotkey currently wired in the app. T8.2 will
// extend this list (cheatsheet, conflict detection); T8.7 will let the user
// override individual bindings.
const DEFAULT_ACTIONS: HotkeyAction[] = [
  { id: "add-project", label: "New project", binding: { modifiers: ["mod"], key: "n" } },
  // NB: current behavior is Cmd+\ → "h" (horizontal split) and Cmd+Shift+\
  // → "v" (vertical). Labels match the in-code semantics; the prototype
  // WS_HOTKEYS in DESIGN_PROMPT_PHASE2.md flips them, which T8.2 will
  // reconcile.
  { id: "split-h", label: "Split pane horizontally", binding: { modifiers: ["mod"], key: "\\" } },
  {
    id: "split-v",
    label: "Split pane vertically",
    binding: { modifiers: ["mod", "shift"], key: "\\" },
  },
  { id: "close-pane", label: "Close pane", binding: { modifiers: ["mod"], key: "w" } },
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

/** Read the current binding for an action id. Handlers call this lazily
 *  inside their event listener so a rebinding (T8.7) takes effect on the
 *  next keystroke without re-installing the listener. */
export function getBinding(id: string): Binding | undefined {
  return actions.find((a) => a.id === id)?.binding;
}

/** Replace the binding for an existing action. No-op if `id` is unknown.
 *  Reactive — UI consumers (T8.2 cheatsheet, T8.7 rebinder) re-render. */
export function setBinding(id: string, binding: Binding): void {
  const idx = actions.findIndex((a) => a.id === id);
  if (idx === -1) return;
  setActions(idx, "binding", { ...binding, modifiers: [...binding.modifiers] });
}

/** All registered actions, in declaration order. For T8.2 cheatsheet UI. */
export function listActions(): readonly HotkeyAction[] {
  return actions;
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
