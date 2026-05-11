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
const activeKey = (projectId: string): string => `planflow_chat_active:${projectId}`;

const [cliByProject, setCliByProject] = createSignal<Record<string, string | null>>({});
const [panelByProject, setPanelByProject] = createSignal<Record<string, ChatPanelState>>({});
const [activeByProject, setActiveByProject] = createSignal<Record<string, string | null>>({});
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
  const activeRaw = readLocal(activeKey(projectId));
  batch(() => {
    setCliByProject((prev) => ({
      ...prev,
      [projectId]: cliRaw != null && cliRaw.length > 0 ? cliRaw : null,
    }));
    setPanelByProject((prev) => ({
      ...prev,
      [projectId]: isPanelState(panelRaw) ? panelRaw : DEFAULT_PANEL,
    }));
    setActiveByProject((prev) => ({
      ...prev,
      [projectId]: activeRaw != null && activeRaw.length > 0 ? activeRaw : null,
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

/** Reactive accessor: which chat session row is currently focused
 *  inside the panel for `projectId`. `null` when the user hasn't
 *  picked one yet (or after the active one was closed). */
export function chatActiveSessionId(projectId: string): string | null {
  return activeByProject()[projectId] ?? null;
}

export function setChatActiveSessionId(projectId: string, rowId: string | null): void {
  setActiveByProject((prev) => ({ ...prev, [projectId]: rowId }));
  writeLocal(activeKey(projectId), rowId ?? "");
}
