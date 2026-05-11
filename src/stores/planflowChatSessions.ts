// Module-level registry of PlanFlow chat PTY sessions, keyed by
// workspace projectId. Lifts the session out of the PlanFlowChat
// component so it survives:
//   * panel collapse / expand (the xterm renderer unmounts but the
//     underlying PTY stays running so the assistant can keep working)
//   * project switches (the chat panel for project A keeps its
//     session alive while the user looks at project B)
//   * component remounts (HMR, route changes, etc.)
//
// The session is only torn down when:
//   * the user explicitly hits "Close session" in the chat header
//   * the user picks a different CLI in the dropdown (we kill the old
//     one before spawning the new one)
//   * the app shuts down — handled by AppRoot's cleanup hook
//
// Each entry holds the PTY sessionId + the CLI it was spawned with so
// we can tell "session belongs to claude" from "session belongs to
// kimi" without re-querying the backend.

import { createSignal } from "solid-js";

import { ptyKill } from "../ipc/pty";

export interface PlanflowChatSession {
  sessionId: string;
  cliId: string;
}

const [sessionsByProject, setSessionsByProject] = createSignal<Record<string, PlanflowChatSession>>(
  {},
);

/** Reactive accessor for a project's active chat session. Returns
 *  `null` when no session has been spawned yet (or after the user
 *  closed it). The reactive read lets the chat panel re-render the
 *  Terminal pane the instant a fresh sessionId lands. */
export function planflowChatSession(projectId: string): PlanflowChatSession | null {
  return sessionsByProject()[projectId] ?? null;
}

/** Replace a project's session record. Use this from the spawn flow
 *  in PlanFlowChat once `ptySpawn` returns. */
export function setPlanflowChatSession(projectId: string, session: PlanflowChatSession): void {
  setSessionsByProject((prev) => ({ ...prev, [projectId]: session }));
}

/** Tear down the project's PTY (best-effort) and forget the entry.
 *  Used by the user-facing "Close session" action and by the CLI-swap
 *  flow. Safe to call when no session exists. */
export async function closePlanflowChatSession(projectId: string): Promise<void> {
  const session = sessionsByProject()[projectId];
  setSessionsByProject((prev) => {
    if (!(projectId in prev)) return prev;
    // Build the next record without the removed key — explicit
    // destructure avoids the no-dynamic-delete lint without changing
    // semantics.
    const { [projectId]: _removed, ...rest } = prev;
    void _removed;
    return rest;
  });
  if (session) {
    try {
      await ptyKill(session.sessionId);
    } catch {
      // Backend already logs the failed kill; nothing the UI can do.
    }
  }
}

/** Tear down EVERY tracked session. Called from AppRoot's cleanup so
 *  closing the window leaves no orphaned CLI processes. */
export async function closeAllPlanflowChatSessions(): Promise<void> {
  const map = sessionsByProject();
  setSessionsByProject({});
  await Promise.allSettled(Object.values(map).map((session) => ptyKill(session.sessionId)));
}
