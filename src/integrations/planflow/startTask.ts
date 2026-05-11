// T12.4 — orchestrate the "Start working" flow for a PlanFlow task.
//
// Acceptance for the spec (PROJECT_PLAN §T12.4):
//   1. POST /:id/tasks/:taskId/work — acquire the lock + flip to IN_PROGRESS.
//      Two users hitting the same task at once → only the first one wins;
//      the second receives a 409 surfaced as PlanFlowConflictError so the
//      caller can render a "locked by …" toast.
//   2. GET /:id/tasks/:taskId/branch-name — PlanFlow generates the
//      conventional branch (e.g. `task/T12.4-start-task-lock-…`). We do
//      not derive it client-side; the server keeps the canonical recipe.
//   3. Switch the workspace's active tab to "terminal" so the user lands
//      directly on the pane where the next step happens.
//   4. Pre-type `git checkout -b <name>` (no trailing newline) into the
//      focused pane via ptyWrite. The user hits Enter to confirm — we
//      never run the command for them.
//   5. Mark the project's active-task slot with `taskId` so the PlanFlow
//      tab can render an "in progress" badge.
//
// Errors:
//   - PlanFlowConflictError — somebody else owns the lock. Caller toasts.
//   - PlanFlowAuthError — token rejected; T11.8 reauth banner takes over.
//   - Any other client error — caller surfaces the message.
//
// Side effects are sequenced so a failure rolls forward, not back: if the
// branch-name fetch fails after the /work POST succeeded we already hold
// the lock, so we still update the store / switch the tab and return the
// task with a null branchName. The caller can show a non-fatal toast and
// let the user run `git checkout -b` manually.

import { setActiveTab, getWorkspace } from "../../stores/workspace";
import { setActiveTaskId } from "../../stores/activeTask";
import { ptyWrite } from "../../ipc/pty";
import type { PlanFlowClient } from "./client";
import type { Task } from "./schemas";

export interface StartTaskInput {
  client: PlanFlowClient;
  /** PlanFlow project UUID (the external id from `project_links`). */
  externalId: string;
  /** Workspace projectId — the local row the user is operating inside.
   *  Used for store keys (active-task + active workspace tab). */
  workspaceProjectId: string;
  /** Task to start (`T12.4`-style id). */
  taskId: string;
}

export interface StartTaskResult {
  task: Task;
  /** The branch suggestion returned by `/branch-name`. `null` when the
   *  endpoint failed after the lock was acquired — the lock is still held
   *  but the terminal nudge was skipped. */
  branchName: string | null;
  /** True when we wrote the pre-fill command into a focused pane. False
   *  when no pane was focused (project has no panes yet, or the workspace
   *  is on the editor / integration tab). The caller can surface this so
   *  the user knows to open a terminal. */
  prefilled: boolean;
}

/** Build the command we pre-type into the focused pane. Exposed for tests
 *  so we lock the exact text. No trailing newline — user hits Enter. */
export function formatCheckoutCommand(branchName: string): string {
  return `git checkout -b ${branchName}`;
}

export async function startTask(input: StartTaskInput): Promise<StartTaskResult> {
  // Step 1 — acquire the lock + flip to IN_PROGRESS. A 409 here means
  // another user holds the lock; we re-throw so the caller can toast and
  // refetch the list (their copy of `lockedBy` is stale).
  const task = await input.client.workOnTask(input.externalId, input.taskId, {
    status: "IN_PROGRESS",
  });

  // Step 2 — branch suggestion. The lock is now ours; the branch fetch is
  // a soft dependency. If it throws we keep the lock and let the caller
  // decide how to surface it.
  let branchName: string | null = null;
  try {
    const response = await input.client.getBranchName(input.externalId, input.taskId);
    branchName = response.branchName;
  } catch {
    branchName = null;
  }

  // Step 3 — record the in-progress task so the tab badge lights up
  // regardless of which tab the user is currently looking at.
  setActiveTaskId(input.workspaceProjectId, input.taskId);

  // Step 4 — flip to the terminal tab. No-op if the project doesn't have
  // a "terminal" tab visible (terminal is always present per the schema,
  // but `setActiveTab` no-ops defensively for missing kinds).
  setActiveTab(input.workspaceProjectId, "terminal");

  // Step 5 — pre-fill the checkout command into the focused pane. We do
  // *not* append a newline: the spec wants the user to hit Enter
  // themselves so the action is consented to, not auto-run.
  let prefilled = false;
  if (branchName !== null) {
    const ws = getWorkspace(input.workspaceProjectId);
    const sessionId = ws?.focusedSessionId ?? null;
    if (sessionId !== null) {
      const command = formatCheckoutCommand(branchName);
      const bytes = new TextEncoder().encode(command);
      await ptyWrite(sessionId, bytes);
      prefilled = true;
    }
  }

  return { task, branchName, prefilled };
}
