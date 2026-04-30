/**
 * Hotkey registry — centralized Solid store.
 *
 * - Platform-aware modifiers (primary → Cmd on mac, Ctrl elsewhere)
 * - Global `keydown` listener that matches registered bindings
 * - Persistence via `app_settings` table (keys: `hotkey.${action}`)
 */

import { createStore, produce } from "solid-js/store";
import type { HotkeyAction, HotkeyBinding, PhysicalModifier } from "../types/hotkey";
import { resolveBindingModifiers, formatHotkey } from "../types/hotkey";
import { setSetting, deleteSetting } from "../db/settings";
import { DEFAULT_HOTKEY_BINDINGS } from "./hotkey-defaults";

/* ─── State ─── */

interface HotkeyState {
  /** action → binding */
  bindings: Record<string, HotkeyBinding>;
  /** action → handler (optional) */
  handlers: Record<string, (() => boolean | void) | undefined>;
  /** Whether the global listener is active. */
  enabled: boolean;
}

const [state, setState] = createStore<HotkeyState>({
  bindings: {},
  handlers: {},
  enabled: false,
});

/* ─── Read helpers ─── */

/** Get the current binding for an action, if any. */
export function getHotkeyBinding(action: HotkeyAction): HotkeyBinding | undefined {
  return state.bindings[action];
}

/** Get the current handler for an action, if any. */
export function getHotkeyHandler(action: HotkeyAction): (() => boolean | void) | undefined {
  return state.handlers[action];
}

/** Whether the global keydown listener is currently active. */
export function isHotkeyEnabled(): boolean {
  return state.enabled;
}

/** Format an action’s binding for display, e.g. "⌘T" or "Ctrl+T". */
export function formatHotkeyAction(action: HotkeyAction): string {
  const binding = state.bindings[action];
  return binding ? formatHotkey(binding) : "";
}

/* ─── Write helpers ─── */

/**
 * Register (or overwrite) a binding for an action.
 * If a handler already exists for this action it stays attached.
 */
export function registerHotkey(
  action: HotkeyAction,
  binding: HotkeyBinding,
  handler?: () => boolean | void,
): void {
  setState("bindings", action, binding);
  if (handler !== undefined) {
    setState("handlers", action, handler);
  }
}

/** Remove a binding and its handler. */
export function unregisterHotkey(action: HotkeyAction): void {
  setState(
    produce((s) => {
      delete s.bindings[action];
      delete s.handlers[action];
    }),
  );
}

/** Attach a handler to an existing binding. */
export function setHotkeyHandler(
  action: HotkeyAction,
  handler: (() => boolean | void) | undefined,
): void {
  setState("handlers", action, handler);
}

/** Remove only the handler, keeping the binding. */
export function removeHotkeyHandler(action: HotkeyAction): void {
  setState("handlers", action, undefined);
}

/** Replace the entire bindings map (useful when hydrating from DB). */
export function setHotkeyBindings(bindings: Record<string, HotkeyBinding>): void {
  setState("bindings", bindings);
}

/** Enable the global keydown listener. */
export function enableHotkeys(): void {
  setState("enabled", true);
  document.addEventListener("keydown", handleKeyDown, { capture: true });
}

/** Disable the global keydown listener. */
export function disableHotkeys(): void {
  setState("enabled", false);
  document.removeEventListener("keydown", handleKeyDown, true);
}

/* ─── Matching ─── */

function handleKeyDown(event: KeyboardEvent): void {
  if (!state.enabled) return;

  // Ignore when the user is typing in a form field.
  const target = event.target as HTMLElement | null;
  if (target) {
    const tag = target.tagName.toLowerCase();
    const isEditable =
      tag === "input" || tag === "textarea" || tag === "select" || target.isContentEditable;
    if (isEditable) return;
  }

  // App-level shortcuts (e.g. Cmd+T) should work even when a terminal is
  // focused. Unmodified keystrokes never match a binding, so they fall
  // through to xterm.js naturally.

  for (const [action, binding] of Object.entries(state.bindings)) {
    if (matchBinding(event, binding)) {
      const handler = state.handlers[action];
      if (handler) {
        const result = handler();
        if (result !== false) {
          event.preventDefault();
          event.stopPropagation();
        }
      }
      break; // first match wins
    }
  }
}

function matchBinding(event: KeyboardEvent, binding: HotkeyBinding): boolean {
  const required = resolveBindingModifiers(binding);
  if (event.key.toLowerCase() !== binding.key.toLowerCase()) return false;

  const modifiers: Array<{ eventKey: keyof KeyboardEvent; map: PhysicalModifier }> = [
    { eventKey: "metaKey", map: "meta" },
    { eventKey: "ctrlKey", map: "ctrl" },
    { eventKey: "altKey", map: "alt" },
    { eventKey: "shiftKey", map: "shift" },
  ];

  for (const { eventKey, map } of modifiers) {
    const isPressed = Boolean(event[eventKey]);
    const isRequired = required.includes(map);
    if (isPressed !== isRequired) return false;
  }

  return true;
}

/* ─── Persistence ─── */

const HOTKEY_SETTING_PREFIX = "hotkey.";

/** Hydrate bindings from the `app_settings` table. */
export async function loadHotkeysFromDb(): Promise<void> {
  const { listSettings } = await import("../db/settings");
  const settings = await listSettings();
  const loaded: Record<string, HotkeyBinding> = {};

  for (const [key, value] of Object.entries(settings)) {
    if (!key.startsWith(HOTKEY_SETTING_PREFIX)) continue;
    const action = key.slice(HOTKEY_SETTING_PREFIX.length);
    try {
      const parsed: HotkeyBinding = JSON.parse(value);
      if (Array.isArray(parsed.modifiers) && typeof parsed.key === "string") {
        loaded[action] = parsed;
      }
    } catch {
      // ignore malformed entries
    }
  }

  // Merge defaults for any actions not customised by the user.
  for (const [action, binding] of Object.entries(DEFAULT_HOTKEY_BINDINGS)) {
    if (!(action in loaded)) {
      loaded[action] = binding;
    }
  }

  setState("bindings", loaded);
}

/** Persist a single binding to the `app_settings` table. */
export async function saveHotkeyToDb(action: HotkeyAction): Promise<void> {
  const binding = state.bindings[action];
  const dbKey = `${HOTKEY_SETTING_PREFIX}${action}` as `hotkey.${string}`;
  if (!binding) {
    await deleteSetting(dbKey);
    return;
  }
  await setSetting(dbKey, JSON.stringify(binding));
}

/** Persist every in-memory binding to the DB. */
export async function saveAllHotkeysToDb(): Promise<void> {
  for (const action of Object.keys(state.bindings)) {
    await saveHotkeyToDb(action);
  }
}
