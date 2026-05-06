// Shared platform detection. `navigator.platform` is deprecated but still
// the most reliable signal inside the Tauri webview (userAgentData is gated
// behind secure contexts that the Tauri scheme doesn't always satisfy).
// Centralised so a future move to userAgentData.platform is a single edit.

export const isMac: boolean =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export const isWindows: boolean =
  typeof navigator !== "undefined" && /Win/.test(navigator.platform);

/** True when the keystroke target is an editable surface — text inputs,
 *  textareas, contenteditable, or an xterm pane. Used by document-level
 *  hotkey handlers to avoid stealing keys from typing contexts. */
export function isEditableTarget(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.closest(".xterm")) return true;
  return false;
}
