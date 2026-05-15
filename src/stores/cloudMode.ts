// T19.5 — Cloud mode store. Reactive front for the T19.4 cloud_mode /
// cloud_agent_url / cloud_agent_status settings.
//
// Why a dedicated store and not a field on the per-project workspace
// store (src/stores/workspace.ts): cloud mode is an app-wide switch.
// One toggle decides whether the whole desktop sources its workspace
// data from the local SQLite + local PTYs (default) or from the
// user-owned VPS over WebSocket (T19.2 cloud-agent). Per-project state
// has no opinion on it.
//
// Signals seed synchronously from the schema defaults so first paint
// is stable, then `hydrateCloudMode()` (run once at boot in the Tauri
// shell) replaces them with the persisted values. Setters persist
// inline so the call site can `await` the write when ordering matters
// (Settings UI → toggle off → kick the WS client).

import { batch, createSignal } from "solid-js";

import { getSetting, setSetting, SETTINGS, type SettingValue } from "../db/settings";

export type CloudAgentStatus = SettingValue<"cloud_agent_status">;

const [cloudModeSignal, setCloudModeSignal] = createSignal<boolean>(SETTINGS.cloud_mode.default);
const [cloudAgentUrlSignal, setCloudAgentUrlSignal] = createSignal<string | null>(
  SETTINGS.cloud_agent_url.default,
);
const [cloudAgentStatusSignal, setCloudAgentStatusSignal] = createSignal<CloudAgentStatus>(
  SETTINGS.cloud_agent_status.default,
);

/** Reactive accessor: app-wide cloud mode toggle. */
export const cloudMode = cloudModeSignal;

/** Reactive accessor: paired agent's wss:// URL, or null when unpaired. */
export const cloudAgentUrl = cloudAgentUrlSignal;

/** Reactive accessor: paired agent's status metadata, or null when unpaired. */
export const cloudAgentStatus = cloudAgentStatusSignal;

/** Flip the cloud mode toggle. Persisted to `app_settings.cloud_mode`. The
 *  signal updates immediately; the returned promise resolves once the row is
 *  written so callers that need write-then-act ordering can await it. */
export async function setCloudMode(value: boolean): Promise<void> {
  setCloudModeSignal(value);
  try {
    await setSetting("cloud_mode", value);
  } catch (err) {
    console.warn("[cloudMode] persist cloud_mode failed", err);
  }
}

/** Update the paired agent URL. Persisted to `app_settings.cloud_agent_url`. */
export async function setCloudAgentUrl(value: string | null): Promise<void> {
  setCloudAgentUrlSignal(value);
  try {
    await setSetting("cloud_agent_url", value);
  } catch (err) {
    console.warn("[cloudMode] persist cloud_agent_url failed", err);
  }
}

/** Replace the agent status block. Persisted to `app_settings.cloud_agent_status`. */
export async function setCloudAgentStatus(value: CloudAgentStatus): Promise<void> {
  setCloudAgentStatusSignal(value);
  try {
    await setSetting("cloud_agent_status", value);
  } catch (err) {
    console.warn("[cloudMode] persist cloud_agent_status failed", err);
  }
}

/** Load persisted values into the signals. Called once at boot in the
 *  Tauri shell. Safe to call again — re-running just re-reads from SQLite. */
export async function hydrateCloudMode(): Promise<void> {
  try {
    const [mode, url, status] = await Promise.all([
      getSetting("cloud_mode"),
      getSetting("cloud_agent_url"),
      getSetting("cloud_agent_status"),
    ]);
    batch(() => {
      setCloudModeSignal(mode);
      setCloudAgentUrlSignal(url);
      setCloudAgentStatusSignal(status);
    });
  } catch (err) {
    console.warn("[cloudMode] hydrate failed", err);
  }
}

if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
  void hydrateCloudMode();
}

/** Test-only — restore defaults without touching SQLite. */
export function _resetCloudModeForTests(): void {
  batch(() => {
    setCloudModeSignal(SETTINGS.cloud_mode.default);
    setCloudAgentUrlSignal(SETTINGS.cloud_agent_url.default);
    setCloudAgentStatusSignal(SETTINGS.cloud_agent_status.default);
  });
}
