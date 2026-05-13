import { listen } from "@tauri-apps/api/event";
import { formatBinding, getBinding } from "../hotkeys";

export const MENU_ACTION_EVENT = "ws-menu-action";
export const NATIVE_MENU_EVENT = "ws://menu-action";

export type MenuActionId =
  | "new-project"
  | "new-terminal"
  | "close-pane"
  | "close-editor-tab"
  | "save-file"
  | "open-settings"
  | "copy"
  | "paste"
  | "find-in-pane"
  | "toggle-sidebar"
  | "quick-switcher"
  | "switch-project-1"
  | "switch-project-2"
  | "switch-project-3"
  | "switch-project-4"
  | "switch-project-5"
  | "switch-project-6"
  | "switch-project-7"
  | "switch-project-8"
  | "switch-project-9"
  | "about"
  | "documentation"
  | "report-issue";

export interface MenuEntry {
  id: MenuActionId;
  label: string;
  hotkeyId?: string;
  shortcut?: string;
}

export interface MenuSection {
  label: string;
  items: readonly (MenuEntry | "separator")[];
}

export const APP_MENU: readonly MenuSection[] = [
  {
    label: "File",
    items: [
      { id: "new-project", label: "New project", hotkeyId: "add-project" },
      { id: "new-terminal", label: "New terminal", hotkeyId: "new-tab" },
      { id: "close-pane", label: "Close pane", hotkeyId: "close-pane" },
      "separator",
      { id: "save-file", label: "Save file", hotkeyId: "save-file" },
      "separator",
      { id: "open-settings", label: "Settings", hotkeyId: "open-settings" },
      "separator",
      { id: "about", label: "About" },
    ],
  },
  {
    label: "Edit",
    items: [
      { id: "copy", label: "Copy", shortcut: "⌘C" },
      { id: "paste", label: "Paste", shortcut: "⌘V" },
      { id: "find-in-pane", label: "Find in pane", hotkeyId: "find-in-terminal" },
    ],
  },
  {
    label: "View",
    items: [
      { id: "toggle-sidebar", label: "Toggle sidebar", hotkeyId: "toggle-sidebar" },
      { id: "quick-switcher", label: "Quick switcher", hotkeyId: "quick-switcher" },
      { id: "switch-project-1", label: "Switch project 1", hotkeyId: "project-1" },
      { id: "switch-project-2", label: "Switch project 2", hotkeyId: "project-2" },
      { id: "switch-project-3", label: "Switch project 3", hotkeyId: "project-3" },
      { id: "switch-project-4", label: "Switch project 4", hotkeyId: "project-4" },
      { id: "switch-project-5", label: "Switch project 5", hotkeyId: "project-5" },
      { id: "switch-project-6", label: "Switch project 6", hotkeyId: "project-6" },
      { id: "switch-project-7", label: "Switch project 7", hotkeyId: "project-7" },
      { id: "switch-project-8", label: "Switch project 8", hotkeyId: "project-8" },
      { id: "switch-project-9", label: "Switch project 9", hotkeyId: "project-9" },
    ],
  },
  {
    label: "Help",
    items: [
      { id: "documentation", label: "Documentation" },
      { id: "report-issue", label: "Report issue" },
    ],
  },
];

export function menuShortcut(entry: MenuEntry): string | null {
  if (entry.hotkeyId) {
    const binding = getBinding(entry.hotkeyId);
    if (binding) return formatBinding(binding);
  }
  return entry.shortcut ?? null;
}

export function dispatchMenuAction(id: MenuActionId): void {
  window.dispatchEvent(new CustomEvent<MenuActionId>(MENU_ACTION_EVENT, { detail: id }));
}

export function addMenuActionListener(handler: (id: MenuActionId) => void): () => void {
  const onAction = (event: Event): void => {
    handler((event as CustomEvent<MenuActionId>).detail);
  };
  window.addEventListener(MENU_ACTION_EVENT, onAction);
  return () => window.removeEventListener(MENU_ACTION_EVENT, onAction);
}

export async function bridgeNativeMenuActions(): Promise<() => void> {
  return listen<MenuActionId>(NATIVE_MENU_EVENT, (event) => dispatchMenuAction(event.payload));
}
