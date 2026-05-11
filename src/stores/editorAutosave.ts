// T13.4 — Editor autosave preference store.
//
// `editor_autosave_ms` is the debounce window (in ms) between the last
// keystroke and an auto-save. `0` disables auto-save entirely. The value
// hydrates from SQL on boot and writes through on every change so a
// future Settings panel toggle (T13.4+) doesn't need bespoke wiring.
//
// Pattern mirrors `appearance.ts`: a synchronous default for first paint,
// async hydrate when running inside Tauri, suppression flag to avoid
// echoing the hydrated value back to disk on the same tick.

import { createSignal } from "solid-js";
import { getSetting, setSetting, SETTINGS } from "../db/settings";

const [autosaveMs, setAutosaveMsSignal] = createSignal<number>(SETTINGS.editor_autosave_ms.default);

let hydrating = false;

export const editorAutosaveMs = autosaveMs;

export function setEditorAutosaveMs(ms: number): void {
  setAutosaveMsSignal(ms);
  if (hydrating) return;
  void setSetting("editor_autosave_ms", ms).catch((err) =>
    console.warn("[editorAutosave] persist failed", err),
  );
}

async function hydrate(): Promise<void> {
  try {
    const value = await getSetting("editor_autosave_ms");
    hydrating = true;
    setAutosaveMsSignal(value);
    hydrating = false;
  } catch (err) {
    console.warn("[editorAutosave] hydrate failed", err);
  }
}

if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
  void hydrate();
}
