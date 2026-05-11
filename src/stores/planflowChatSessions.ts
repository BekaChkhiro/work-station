// Module-level registry of PlanFlow chat PTY sessions, keyed by chat
// session row id (NOT projectId — each project can have many chat
// tabs running concurrently). Lifts the live PTY out of the
// PlanFlowChat component so it survives:
//   * tab switches inside the panel (other tabs' PTYs keep running)
//   * panel collapse / expand
//   * project switches
//   * component remounts (HMR, route changes, etc.)
//
// The PTY is torn down when:
//   * the user hits ⏹ on the active tab — kills that one session
//   * the user closes the tab — kills + removes the session row
//   * the user changes the tab's CLI in the dropdown — old PTY killed
//   * the app shuts down — AppRoot's cleanup hook
//
// Each entry holds the PTY sessionId + the CLI it was spawned with so
// the panel's "this tab is running claude vs kimi" state is canonical
// from one place rather than scattered across component signals.

import { createSignal } from "solid-js";

import { ptyKill } from "../ipc/pty";

export interface PlanflowChatRuntime {
  sessionId: string;
  cliId: string;
  /** Which project this PTY belongs to. Persisted alongside the
   *  session row in the DB; cached here so AppRoot's cleanup can group
   *  reports per project if it ever wants to. */
  projectId: string;
}

const [runtimes, setRuntimes] = createSignal<Record<string, PlanflowChatRuntime>>({});

/** Reactive: PTY runtime for the chat session row. Returns `null`
 *  when the tab hasn't been spawned yet (cold state after app
 *  restart) or after the user closed the session. */
export function planflowChatRuntime(rowId: string): PlanflowChatRuntime | null {
  return runtimes()[rowId] ?? null;
}

export function setPlanflowChatRuntime(rowId: string, runtime: PlanflowChatRuntime): void {
  setRuntimes((prev) => ({ ...prev, [rowId]: runtime }));
}

/** Best-effort tear-down: kills the PTY for `rowId` if one is tracked,
 *  removes the registry entry. Safe to call when nothing is tracked. */
export async function closePlanflowChatRuntime(rowId: string): Promise<void> {
  const runtime = runtimes()[rowId];
  setRuntimes((prev) => {
    if (!(rowId in prev)) return prev;
    const { [rowId]: _removed, ...rest } = prev;
    void _removed;
    return rest;
  });
  if (runtime) {
    try {
      await ptyKill(runtime.sessionId);
    } catch {
      // Backend logs the failure; nothing for the UI to surface.
    }
  }
}

/** Tear down every tracked runtime. Called from AppRoot's cleanup so
 *  the window closing leaves no orphaned CLI processes. */
export async function closeAllPlanflowChatRuntimes(): Promise<void> {
  const map = runtimes();
  setRuntimes({});
  await Promise.allSettled(Object.values(map).map((runtime) => ptyKill(runtime.sessionId)));
}
