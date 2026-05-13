// T18.13 — Multi-session tracking for the PWA Terminal.
//
// The WebSocket protocol has no `pty_list` frame: the server-side
// `PtyManager` doesn't enumerate sessions, and the only sessions this
// device can act on are the ones it spawned. So tracking is purely
// client-side — we cache session metadata in localStorage so a page
// reload (PWA SW update, iOS swipe-out, etc.) can re-attach to the
// still-live PTYs on the desktop side rather than orphaning them.
//
// On boot we attempt `ptySubscribe` for each cached id; sessions the
// server has reaped get dropped silently. New spawns and kills mutate
// the same store the Terminal route and SessionsSheet both read from.
//
// Active-session bookkeeping: `activeSessionId` is the one the Terminal
// component renders. Switching is done by setting it — the Terminal is
// keyed on the id so Solid unmounts/remounts the xterm cleanly.

import { createStore, produce } from "solid-js/store";
import { getBridge } from "./wsBridge";
import { settingsStore } from "../lib/settingsStore";
import { WsBridgeServerError } from "../lib/wsBridge";

export interface SessionMeta {
  sessionId: string;
  /** Display label — usually the active PlanFlow project id or "default". */
  label: string;
  /** Short CLI name for the badge (e.g. "bash", "claude"). */
  cli: string;
  /** PTY command actually spawned, kept so we can show it on long-press / debug. */
  command: string;
  /** Working directory, when supplied at spawn time. */
  cwd?: string;
  /** Wall-clock spawn time so the list can sort newest-first. */
  createdAt: number;
}

interface SessionsState {
  sessions: SessionMeta[];
  activeSessionId: string | null;
  /** True while the initial localStorage hydration is being re-subscribed. */
  hydrating: boolean;
}

const STORAGE_KEY = "ws.mobile.sessions";

const [state, setState] = createStore<SessionsState>({
  sessions: [],
  activeSessionId: null,
  hydrating: false,
});

let exitUnsub: (() => void) | null = null;
let hydrated = false;

function persist(): void {
  try {
    const payload = {
      sessions: state.sessions,
      activeSessionId: state.activeSessionId,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // ignore — Safari private mode, quota errors
  }
}

function clearPersisted(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

function readPersisted(): { sessions: SessionMeta[]; activeSessionId: string | null } | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<{
      sessions: SessionMeta[];
      activeSessionId: string | null;
    }>;
    if (!Array.isArray(parsed.sessions)) return null;
    return {
      sessions: parsed.sessions.filter(isSessionMeta),
      activeSessionId: typeof parsed.activeSessionId === "string" ? parsed.activeSessionId : null,
    };
  } catch {
    return null;
  }
}

function isSessionMeta(value: unknown): value is SessionMeta {
  if (!value || typeof value !== "object") return false;
  const m = value as Partial<SessionMeta>;
  return (
    typeof m.sessionId === "string" &&
    typeof m.label === "string" &&
    typeof m.cli === "string" &&
    typeof m.command === "string" &&
    typeof m.createdAt === "number"
  );
}

function inferCli(command: string): string {
  // Strip any path so "/bin/bash" → "bash"; "claude" → "claude".
  const tail = command.split(/[/\\]/).pop() ?? command;
  return tail || "shell";
}

function defaultLabel(): string {
  return settingsStore.getActiveProjectId() ?? "default";
}

function ensureExitListener(): void {
  if (exitUnsub) return;
  const bridge = getBridge();
  if (!bridge) return;
  exitUnsub = bridge.onPtyExit((sid) => {
    removeSessionLocal(sid);
  });
}

function removeSessionLocal(sessionId: string): void {
  setState(
    produce((s) => {
      const idx = s.sessions.findIndex((sess) => sess.sessionId === sessionId);
      if (idx === -1) return;
      s.sessions.splice(idx, 1);
      if (s.activeSessionId === sessionId) {
        s.activeSessionId = s.sessions[0]?.sessionId ?? null;
      }
    }),
  );
  persist();
}

export function sessions(): readonly SessionMeta[] {
  return state.sessions;
}

export function activeSessionId(): string | null {
  return state.activeSessionId;
}

export function activeSession(): SessionMeta | null {
  const id = state.activeSessionId;
  if (!id) return null;
  return state.sessions.find((s) => s.sessionId === id) ?? null;
}

export function isHydrating(): boolean {
  return state.hydrating;
}

export function setActiveSession(sessionId: string | null): void {
  setState("activeSessionId", sessionId);
  persist();
}

export interface SpawnOptions {
  command?: string;
  args?: string[];
  cwd?: string;
  label?: string;
  cli?: string;
  cols?: number;
  rows?: number;
}

export async function spawnSession(opts: SpawnOptions = {}): Promise<SessionMeta> {
  const bridge = getBridge();
  if (!bridge) {
    throw new Error("WebSocket bridge not configured");
  }
  ensureExitListener();
  const command = opts.command ?? "/bin/bash";
  const { sessionId } = await bridge.ptySpawn({
    command,
    args: opts.args ?? [],
    cwd: opts.cwd,
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
  });
  const meta: SessionMeta = {
    sessionId,
    label: opts.label ?? defaultLabel(),
    cli: opts.cli ?? inferCli(command),
    command,
    cwd: opts.cwd,
    createdAt: Date.now(),
  };
  setState(
    produce((s) => {
      s.sessions.unshift(meta);
      s.activeSessionId = sessionId;
    }),
  );
  persist();
  return meta;
}

export async function killSession(sessionId: string): Promise<void> {
  const bridge = getBridge();
  // Optimistically drop from the UI — if the kill RPC fails the server
  // will eventually GC the PTY and an out-of-band exit handler would be
  // a no-op anyway. Surfacing the row stuck-but-dead is worse UX than
  // dropping a tombstone we can't address.
  removeSessionLocal(sessionId);
  if (!bridge) return;
  try {
    await bridge.ptyKill(sessionId);
  } catch (err) {
    if (err instanceof WsBridgeServerError && err.kind === "session_not_found") {
      // Server already reaped — local drop is correct.
      return;
    }
    throw err;
  }
}

/** Re-subscribe to cached sessions on app boot. Drops ids the server has reaped. */
export async function hydrateSessions(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  const persisted = readPersisted();
  if (!persisted || persisted.sessions.length === 0) return;
  const bridge = getBridge();
  if (!bridge) return;

  setState(
    produce((s) => {
      s.sessions = persisted.sessions;
      s.activeSessionId = persisted.activeSessionId;
      s.hydrating = true;
    }),
  );
  ensureExitListener();

  const alive: SessionMeta[] = [];
  for (const session of persisted.sessions) {
    try {
      await bridge.ptySubscribe(session.sessionId);
      alive.push(session);
    } catch {
      // Session gone server-side — silently drop.
    }
  }

  setState(
    produce((s) => {
      s.sessions = alive;
      if (s.activeSessionId && !alive.some((sess) => sess.sessionId === s.activeSessionId)) {
        s.activeSessionId = alive[0]?.sessionId ?? null;
      }
      s.hydrating = false;
    }),
  );
  if (alive.length === 0) {
    clearPersisted();
  } else {
    persist();
  }
}

/** Test/dev helper — wipes local state and unsubscribes listeners. */
export function _resetSessionsForTest(): void {
  if (exitUnsub) {
    exitUnsub();
    exitUnsub = null;
  }
  hydrated = false;
  setState({ sessions: [], activeSessionId: null, hydrating: false });
  clearPersisted();
}
