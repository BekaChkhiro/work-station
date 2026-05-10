// T8.2 — Hotkey cheatsheet modal. Cmd+/ opens a centered panel listing
// every action in the registry with its current binding. Conflict groups
// (more than one action sharing a binding) render as a banner above the
// list so the user notices the clash. The cheatsheet is read-only; the
// rebinder UI ships in T8.7.

import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import { findConflicts, formatBinding, listActions } from "../../hotkeys";
import type { BindingConflict, HotkeyAction } from "../../hotkeys";

export interface HotkeyCheatsheetProps {
  open: boolean;
  onClose: () => void;
}

const labelLookup = (id: string, actions: readonly HotkeyAction[]): string =>
  actions.find((a) => a.id === id)?.label ?? id;

export function HotkeyCheatsheet(props: HotkeyCheatsheetProps): JSX.Element {
  let inputEl: HTMLInputElement | undefined;

  const [query, setQuery] = createSignal("");

  const allActions = createMemo<readonly HotkeyAction[]>(() => listActions());

  const filtered = createMemo<readonly HotkeyAction[]>(() => {
    const q = query().trim().toLowerCase();
    const all = allActions();
    if (!q) return all;
    return all.filter((a) => {
      if (a.label.toLowerCase().includes(q)) return true;
      if (a.id.toLowerCase().includes(q)) return true;
      if (formatBinding(a.binding).toLowerCase().includes(q)) return true;
      return false;
    });
  });

  const conflicts = createMemo<readonly BindingConflict[]>(() => findConflicts());

  // Reset the search input each time the modal opens so the user starts
  // fresh; mirrors the QuickSwitcher pattern.
  createEffect(() => {
    if (!props.open) return;
    setQuery("");
    queueMicrotask(() => inputEl?.focus());
  });

  // Document-level Esc handler in capture phase so we beat pane-level
  // listeners (xterm in particular).
  createEffect(() => {
    if (!props.open) return;
    const onDocKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.preventDefault();
        props.onClose();
      }
    };
    document.addEventListener("keydown", onDocKey, { capture: true });
    onCleanup(() => document.removeEventListener("keydown", onDocKey, { capture: true }));
  });

  return (
    <Show when={props.open}>
      <div
        class="ws-cheat__backdrop"
        onMouseDown={(e) => {
          if (e.currentTarget === e.target) props.onClose();
        }}
      >
        <div
          class="ws-cheat"
          role="dialog"
          aria-modal="true"
          aria-label="Keyboard shortcuts"
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div class="ws-cheat__head">
            <span class="ws-cheat__title">Keyboard shortcuts</span>
            <input
              ref={inputEl}
              class="ws-cheat__input"
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              placeholder="Filter shortcuts…"
              spellcheck={false}
              autocomplete="off"
              aria-label="Filter shortcuts"
            />
            <kbd class="ws-cheat__kbd">esc</kbd>
          </div>

          <Show when={conflicts().length > 0}>
            <div class="ws-cheat__conflicts" role="alert">
              <For each={conflicts()}>
                {(c) => (
                  <div class="ws-cheat__conflict">
                    <span class="ws-cheat__conflict-icon" aria-hidden="true">
                      ⚠
                    </span>
                    <span class="ws-cheat__conflict-key">{formatBinding(c.binding)}</span>
                    <span class="ws-cheat__conflict-text">
                      bound to {c.ids.map((id) => labelLookup(id, allActions())).join(" and ")}
                    </span>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <Show
            when={filtered().length > 0}
            fallback={<div class="ws-cheat__empty">No shortcuts match.</div>}
          >
            <ul class="ws-cheat__list" role="list">
              <For each={filtered()}>
                {(action) => (
                  <li class="ws-cheat__row">
                    <span class="ws-cheat__label">{action.label}</span>
                    <span class="ws-cheat__binding">
                      <kbd class="ws-cheat__chip">{formatBinding(action.binding)}</kbd>
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </Show>

          <div class="ws-cheat__foot">
            <span class="ws-cheat__hint">{allActions().length} shortcuts</span>
            <span class="ws-cheat__hint">
              Rebind in <span class="ws-cheat__muted">Settings → Keybindings</span>
            </span>
          </div>
        </div>
      </div>
    </Show>
  );
}

export default HotkeyCheatsheet;
