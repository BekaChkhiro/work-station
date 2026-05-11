// T12.4 + T12.5 — orchestrate the "Start working" / "Progress" / "Done"
// flows for a PlanFlow task.
//
// T12.4 — Start (PROJECT_PLAN §T12.4):
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
// T12.5 — Progress + Done (PROJECT_PLAN §T12.5):
//   • markProgress: POST /:id/tasks/:taskId/work with `note` (and optional
//     `saveAsKnowledge`). Status is left alone — the task is already
//     IN_PROGRESS. The server posts the note as a task comment and, when
//     `saveAsKnowledge` is true, also persists a knowledge entry.
//   • finishTask: POST /:id/tasks/:taskId/work with `status: "DONE"` and
//     the user's summary as `note`. Then DELETE /:id/tasks/:taskId/work
//     to explicitly release the lock — the server treats the DELETE as
//     idempotent so a no-op release is fine if the DONE write already
//     released it. Finally, clear the project's active-task slot and
//     pre-type a Conventional Commits message into the focused terminal
//     pane (`git commit -m "feat(t12): T12.5 — …"`).
//
// Errors:
//   - PlanFlowConflictError — somebody else owns the lock. Caller toasts.
//   - PlanFlowAuthError — token rejected; T11.8 reauth banner takes over.
//   - Any other client error — caller surfaces the message.
//
// Side effects in startTask are sequenced so a failure rolls forward, not
// back: if the branch-name fetch fails after the /work POST succeeded we
// already hold the lock, so we still update the store / switch the tab
// and return the task with a null branchName. The caller can show a
// non-fatal toast and let the user run `git checkout -b` manually. The
// same forward-roll logic applies in finishTask: a failed lock release
// or terminal prefill after the status flip leaves the task DONE on the
// server — we still clear the local active-task entry and let the
// caller's toast describe the partial failure.

import { setActiveTab, getWorkspace } from "../../stores/workspace";
import { setActiveTaskId } from "../../stores/activeTask";
import { ptyWrite } from "../../ipc/pty";
import type { PlanFlowClient } from "./client";
import type { KnowledgeType, Task } from "./schemas";

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

export interface MarkProgressInput {
  client: PlanFlowClient;
  externalId: string;
  taskId: string;
  /** Comment body — posted as a task comment by the server. */
  note: string;
  /** When true, the server also persists the note as a knowledge entry. */
  saveAsKnowledge?: boolean;
  /** Optional knowledge title override. When omitted the server falls
   *  back to a derivation from the task id + first sentence. */
  knowledgeTitle?: string;
  /** Optional knowledge type. Defaults to "decision" server-side. */
  knowledgeType?: KnowledgeType;
}

export interface MarkProgressResult {
  task: Task;
}

export interface FinishTaskInput {
  client: PlanFlowClient;
  externalId: string;
  /** Workspace projectId — for clearing the active-task slot and finding
   *  the focused terminal pane to nudge. */
  workspaceProjectId: string;
  taskId: string;
  /** Summary to post as the closing comment on the task. */
  summary: string;
  /** Task display name. Used in the Conventional Commits message. */
  taskName: string;
}

export interface FinishTaskResult {
  task: Task;
  /** Suggested commit message (`feat(tN): TX.Y — name`). Always returned
   *  so the caller can copy-paste it as a fallback if the terminal
   *  prefill is skipped. */
  commitMessage: string;
  /** True when we wrote the `git commit -m "…"` line into a focused
   *  pane. False when no pane was focused. */
  prefilled: boolean;
  /** True when the DELETE /work release returned successfully. The
   *  server may have already released the lock as part of the DONE
   *  write — we still issue the explicit release and tolerate either
   *  outcome. False here means the explicit release threw; the lock
   *  may or may not actually be held. */
  released: boolean;
}

/** Build the command we pre-type into the focused pane. Exposed for tests
 *  so we lock the exact text. No trailing newline — user hits Enter. */
export function formatCheckoutCommand(branchName: string): string {
  return `git checkout -b ${branchName}`;
}

/** Derive the Conventional Commits scope from a task id (`T12.5` → `t12`).
 *  Repo convention (see `git log` from T8 onwards) puts the phase number
 *  in a lowercase `t<n>` scope; we match it so generated suggestions read
 *  the same as hand-written commits. Returns null when the id doesn't
 *  start with a `T<digits>.` prefix — caller falls back to scope-less. */
export function commitScopeFromTaskId(taskId: string): string | null {
  const match = taskId.match(/^T(\d+)\./);
  return match ? `t${match[1]}` : null;
}

/** Build the Conventional Commits message for a finished task. Mirrors
 *  the repo's own commit style: `feat(tN): TX.Y — task name`. Strips
 *  outer whitespace from the name; everything else passes through (em
 *  dash, parentheses, slashes — all valid in subject lines). */
export function formatCommitMessage(taskId: string, taskName: string): string {
  const scope = commitScopeFromTaskId(taskId);
  const prefix = scope ? `feat(${scope})` : "feat";
  const name = taskName.trim();
  return `${prefix}: ${taskId} — ${name}`;
}

/** The shell command we pre-type into the focused pane on Done. Uses
 *  double-quotes so the user can run it as-is; embedded double quotes in
 *  the task name are backslash-escaped to keep the literal valid. No
 *  trailing newline — user hits Enter to confirm. */
export function formatCommitCommand(taskId: string, taskName: string): string {
  const message = formatCommitMessage(taskId, taskName);
  const escaped = message.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `git commit -m "${escaped}"`;
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
    const sessionId = focusedSessionFor(input.workspaceProjectId);
    if (sessionId !== null) {
      const command = formatCheckoutCommand(branchName);
      await writeBytes(sessionId, command);
      prefilled = true;
    }
  }

  return { task, branchName, prefilled };
}

export async function markProgress(input: MarkProgressInput): Promise<MarkProgressResult> {
  // workOnTask without `status` keeps the task in IN_PROGRESS — the
  // server treats the request as a note-only update. `saveAsKnowledge`
  // and the title/type fields are passed straight through; the server
  // applies its own defaults (knowledgeType=decision, title derived from
  // the task id + first sentence) when those are omitted.
  const task = await input.client.workOnTask(input.externalId, input.taskId, {
    note: input.note,
    saveAsKnowledge: input.saveAsKnowledge,
    knowledgeTitle: input.knowledgeTitle,
    knowledgeType: input.knowledgeType,
  });
  return { task };
}

export async function finishTask(input: FinishTaskInput): Promise<FinishTaskResult> {
  // Step 1 — flip the status to DONE with the summary as the closing
  // comment. Server posts the note as a task comment and, depending on
  // its policy, may release the lock as part of the DONE transition.
  // We still issue an explicit DELETE below to be unambiguous.
  const task = await input.client.workOnTask(input.externalId, input.taskId, {
    status: "DONE",
    note: input.summary,
  });

  // Step 2 — explicit lock release. The DELETE endpoint is idempotent on
  // the server side, so calling it after the DONE write is harmless. We
  // forward-roll on failure: a failed release here leaves the task DONE
  // and the local active-task slot still cleared below — the user gets
  // an "unlock failed" toast and can retry from the row.
  let released = false;
  try {
    await input.client.releaseTaskLock(input.externalId, input.taskId);
    released = true;
  } catch {
    released = false;
  }

  // Step 3 — clear the project's active-task slot so the tab badge and
  // "Resume" labels disappear. We do this even when the release call
  // above failed: the server-side source of truth is the DONE status,
  // and the local store should reflect that the user is no longer
  // working on the task.
  setActiveTaskId(input.workspaceProjectId, null);

  // Step 4 — focus the terminal tab so the user sees the staged commit
  // line. Matches the Start flow's "land on the next-step pane" UX.
  setActiveTab(input.workspaceProjectId, "terminal");

  // Step 5 — pre-fill the commit command. As with Start, no trailing
  // newline: the user hits Enter to actually run the commit.
  const commitMessage = formatCommitMessage(input.taskId, input.taskName);
  let prefilled = false;
  const sessionId = focusedSessionFor(input.workspaceProjectId);
  if (sessionId !== null) {
    const command = formatCommitCommand(input.taskId, input.taskName);
    await writeBytes(sessionId, command);
    prefilled = true;
  }

  return { task, commitMessage, prefilled, released };
}

function focusedSessionFor(workspaceProjectId: string): string | null {
  const ws = getWorkspace(workspaceProjectId);
  return ws?.focusedSessionId ?? null;
}

async function writeBytes(sessionId: string, command: string): Promise<void> {
  const bytes = new TextEncoder().encode(command);
  await ptyWrite(sessionId, bytes);
}
