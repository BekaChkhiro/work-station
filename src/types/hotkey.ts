/**
 * Hotkey type system — Phase 8.
 *
 * Defines actions, binding shapes, and platform-aware modifiers.
 */

/* ─── Action IDs ─── */

export type HotkeyAction =
  | "new-terminal"
  | "split-vertical"
  | "split-horizontal"
  | "close-pane"
  | "focus-previous-project"
  | "focus-next-project"
  | "open-switcher"
  | "open-settings"
  | "find"
  | `focus-project-${1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9}`
  | (string & Record<never, never>); // extensible

/* ─── Modifiers ─── */

/** Physical modifier keys as reported by KeyboardEvent. */
export type PhysicalModifier = "meta" | "ctrl" | "alt" | "shift";

/**
 * Logical modifiers that may be used in bindings.
 * `primary` resolves to `meta` on macOS and `ctrl` elsewhere,
 * so cross-platform defaults feel native (Cmd vs Ctrl).
 */
export type LogicalModifier = PhysicalModifier | "primary";

/* ─── Binding shape ─── */

export interface HotkeyBinding {
  /** Logical modifiers required to trigger this binding. */
  modifiers: LogicalModifier[];
  /**
   * The key to match, lower-case.
   * Uses `event.key` values: "t", "1", "escape", "enter", "backslash", etc.
   */
  key: string;
}

/* ─── Registry entry ─── */

export interface HotkeyEntry {
  action: HotkeyAction;
  binding: HotkeyBinding;
}

/* ─── Platform helpers ─── */

/** Platform detection. */
export const isMac = navigator.platform.toLowerCase().includes("mac");

/** Resolve a logical modifier to its physical equivalent for the current platform. */
export function resolveModifier(mod: LogicalModifier): PhysicalModifier {
  if (mod === "primary") return isMac ? "meta" : "ctrl";
  return mod;
}

/** Resolve all logical modifiers in a binding. */
export function resolveBindingModifiers(binding: HotkeyBinding): PhysicalModifier[] {
  return binding.modifiers.map(resolveModifier);
}

/** Display label for a modifier on the current platform. */
export function modifierLabel(mod: PhysicalModifier): string {
  switch (mod) {
    case "meta":
      return isMac ? "⌘" : "Win";
    case "ctrl":
      return "Ctrl";
    case "alt":
      return isMac ? "⌥" : "Alt";
    case "shift":
      return isMac ? "⇧" : "Shift";
  }
}

/** Format a binding as a human-readable string, e.g. "⌘T" or "Ctrl+T". */
export function formatHotkey(binding: HotkeyBinding): string {
  const physical = resolveBindingModifiers(binding);
  const parts = physical.map(modifierLabel);
  const keyLabel = binding.key.length === 1 ? binding.key.toUpperCase() : binding.key;
  return [...parts, keyLabel].join(isMac ? "" : "+");
}
