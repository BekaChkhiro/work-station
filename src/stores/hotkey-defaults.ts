/**
 * Default keybindings — T8.2.
 *
 * Defines the out-of-the-box shortcuts for every action. These are merged
 * into the hotkey registry on first boot (or whenever a specific action has
 * no user-customised binding in the DB).
 */

import type { HotkeyBinding } from "../types/hotkey";

/** Default bindings shipped with the app. */
export const DEFAULT_HOTKEY_BINDINGS: Record<string, HotkeyBinding> = {
  "new-terminal": { modifiers: ["primary"], key: "t" },
  "split-vertical": { modifiers: ["primary"], key: "\\" },
  "split-horizontal": { modifiers: ["primary", "shift"], key: "|" },
  "close-pane": { modifiers: ["primary"], key: "w" },
  "focus-project-1": { modifiers: ["primary"], key: "1" },
  "focus-project-2": { modifiers: ["primary"], key: "2" },
  "focus-project-3": { modifiers: ["primary"], key: "3" },
  "focus-project-4": { modifiers: ["primary"], key: "4" },
  "focus-project-5": { modifiers: ["primary"], key: "5" },
  "focus-project-6": { modifiers: ["primary"], key: "6" },
  "focus-project-7": { modifiers: ["primary"], key: "7" },
  "focus-project-8": { modifiers: ["primary"], key: "8" },
  "focus-project-9": { modifiers: ["primary"], key: "9" },
  "open-switcher": { modifiers: ["primary"], key: "k" },
  "open-settings": { modifiers: ["primary"], key: "," },
  find: { modifiers: ["primary"], key: "f" },
};
