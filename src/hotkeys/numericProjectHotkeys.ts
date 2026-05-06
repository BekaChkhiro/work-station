// T6.3: Cmd/Ctrl+1..9 jumps to the project at sidebar position N.
//
// Listens at the document level so any pane (including xterm, which
// captures keystrokes via a hidden textarea) can still bubble the
// keystroke up. The hotkey is intentionally suppressed when focus is
// inside an editable surface — text inputs, textareas, contenteditable
// regions, or an xterm pane — so a user typing `Cmd+1` in a shell or
// form field gets the host's native behavior, not a project switch.
//
// Centralized here (rather than inside AppShell) so future surfaces
// — e.g. a hotkey-registry settings page (T8.1) or a standalone window
// — can reuse the same install/cleanup pair without depending on the
// AppShell render tree. The store-aware behavior (read `projects()`,
// call `setActiveProject`) is the only coupling: anywhere the workspace
// store is loaded, this module is wirable.

import { onCleanup, onMount } from "solid-js";
import { projects, setActiveProject } from "../stores/workspace";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

/** True when the keystroke should belong to the user's typing context
 *  (input, textarea, contenteditable, or an xterm pane) rather than
 *  the project switcher. */
function isEditableTarget(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  // xterm.js puts focus on `.xterm-helper-textarea` inside the `.xterm`
  // root; the textarea check above already catches it, but the closest()
  // probe also covers any future xterm versions that swap the focus
  // target — and any custom child element a pane might render.
  if (el.closest(".xterm")) return true;
  return false;
}

/** Install document-level Cmd/Ctrl+1..9 → switch active project by
 *  sidebar position. Returns a cleanup that removes the listener. */
export function installNumericProjectHotkeys(): () => void {
  const onKey = (e: KeyboardEvent): void => {
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if (!mod || e.altKey || e.shiftKey) return;
    if (e.key < "1" || e.key > "9") return;
    if (isEditableTarget(document.activeElement)) return;
    const idx = Number.parseInt(e.key, 10) - 1;
    const target = projects()[idx];
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
