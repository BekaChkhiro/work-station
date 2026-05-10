// T6.3: Cmd/Ctrl+1..9 jumps to the project at sidebar position N.
//
// Listens at the document level so any pane (including xterm, which
// captures keystrokes via a hidden textarea) can still bubble the
// keystroke up. The hotkey deliberately fires even when focus is
// inside an xterm pane — switching projects is a global navigation
// action that must beat the shell's native Cmd+digit behavior.
// Plain text inputs / textareas / contenteditable surfaces still
// suppress it so typing `Cmd+1` inside a form field doesn't yank
// the user away from what they're filling in.
//
// Centralized here (rather than inside AppShell) so future surfaces
// — e.g. a hotkey-registry settings page (T8.1) or a standalone window
// — can reuse the same install/cleanup pair without depending on the
// AppShell render tree. The store-aware behavior (read `projects()`,
// call `setActiveProject`) is the only coupling: anywhere the workspace
// store is loaded, this module is wirable.

import { onCleanup, onMount } from "solid-js";
import { projects, setActiveProject } from "../stores/workspace";
import { eventMatchesBinding, getBinding } from "./registry";

const isPlainTextEditable = (el: Element | null): boolean => {
  if (!el) return false;
  // xterm's input surface is a real <textarea> nested under `.xterm`. We
  // explicitly want the hotkey to fire there, so let it through before
  // the generic input/textarea check below.
  if (el.closest(".xterm")) return false;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
};

/** Install document-level Cmd/Ctrl+1..9 → switch active project by
 *  sidebar position. Returns a cleanup that removes the listener. */
export function installNumericProjectHotkeys(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    let matchedIdx = -1;
    for (let n = 1; n <= 9; n++) {
      const binding = getBinding(`project-${n}`);
      if (binding && eventMatchesBinding(e, binding)) {
        matchedIdx = n - 1;
        break;
      }
    }
    if (matchedIdx === -1) return;
    // Skip plain text-editing surfaces but DO fire when focus is in an
    // xterm pane — Cmd+digit must navigate projects from the terminal.
    if (isPlainTextEditable(document.activeElement)) return;
    const target = projects()[matchedIdx];
    if (!target) return;
    e.preventDefault();
    setActiveProject(target.id);
  };
  document.addEventListener("keydown", onKey);
  return () => document.removeEventListener("keydown", onKey);
}

/** Solid-lifecycle wrapper: installs on mount, removes on cleanup. */
export function useNumericProjectHotkeys(): void {
  onMount(() => {
    const dispose = installNumericProjectHotkeys();
    onCleanup(dispose);
  });
}
