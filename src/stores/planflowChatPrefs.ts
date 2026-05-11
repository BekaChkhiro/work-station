// Per-project preferences for the PlanFlow chat widget. Tracks which CLI
// the user picked + what shape the panel is in (collapsed / expanded /
// pinned). Persisted to localStorage so the next launch lands on the
// same state.
//
// We use localStorage instead of `app_settings` because the keys are
// dynamically composed from projectId ("planflow_chat_cli_<uuid>")
// and the existing `getSetting/setSetting` API is strongly typed to a
// fixed union of known setting names. Chat prefs are UI shape, not
// state any other consumer needs to see — localStorage is the right
// scope and avoids a settings-key registry churn.

import { batch, createSignal } from "solid-js";

export type ChatPanelState = "collapsed" | "expanded" | "pinned";

const DEFAULT_PANEL: ChatPanelState = "collapsed";

const cliKey = (projectId: string): string => `planflow_chat_cli:${projectId}`;
const panelKey = (projectId: string): string => `planflow_chat_panel:${projectId}`;

const [cliByProject, setCliByProject] = createSignal<Record<string, string | null>>({});
const [panelByProject, setPanelByProject] = createSignal<Record<string, ChatPanelState>>({});
const [hydrated, setHydrated] = createSignal<Record<string, boolean>>({});

function isPanelState(value: unknown): value is ChatPanelState {
  return value === "collapsed" || value === "expanded" || value === "pinned";
}

function readLocal(key: string): string | null {
  if (typeof localStorage === "undefined") return null;
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage quota / private mode — UI state can fall back to RAM-only.
  }
}

/** Ensure `projectId`'s prefs are loaded into memory. Idempotent — safe
 *  to call on every render; the second call short-circuits on the
 *  hydrated flag. The widget calls this on mount so the first paint
 *  reflects the saved CLI + panel state. */
export function hydrateChatPrefs(projectId: string): void {
  if (hydrated()[projectId]) return;
  const cliRaw = readLocal(cliKey(projectId));
  const panelRaw = readLocal(panelKey(projectId));
  batch(() => {
    setCliByProject((prev) => ({
      ...prev,
      [projectId]: cliRaw != null && cliRaw.length > 0 ? cliRaw : null,
    }));
    setPanelByProject((prev) => ({
      ...prev,
      [projectId]: isPanelState(panelRaw) ? panelRaw : DEFAULT_PANEL,
    }));
    setHydrated((prev) => ({ ...prev, [projectId]: true }));
  });
}

/** Reactive accessor: selected CLI for the project, or `null` when none
 *  has been chosen yet (the widget defaults to the first available CLI
 *  in that case). */
export function chatCli(projectId: string): string | null {
  return cliByProject()[projectId] ?? null;
}

/** Reactive accessor: current panel state for the project. */
export function chatPanel(projectId: string): ChatPanelState {
  return panelByProject()[projectId] ?? DEFAULT_PANEL;
}

export function setChatCli(projectId: string, cli: string | null): void {
  setCliByProject((prev) => ({ ...prev, [projectId]: cli }));
  writeLocal(cliKey(projectId), cli ?? "");
}

export function setChatPanel(projectId: string, panel: ChatPanelState): void {
  setPanelByProject((prev) => ({ ...prev, [projectId]: panel }));
  writeLocal(panelKey(projectId), panel);
}
