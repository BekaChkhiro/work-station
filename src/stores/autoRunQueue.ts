// Auto-run queue store.
//
// Manages one persisted AutoRunQueue per workspace projectId. The
// tick loop drives state transitions independently from any UI
// component — the dialog only seeds a queue, the bar only renders
// it, and even with both unmounted the loop keeps dispatching tasks
// until the queue is done / stopped.
//
// Dispatch picks the next task DYNAMICALLY by re-querying PlanFlow
// at every boundary: sort TODO tasks by canonical id ("T1.5", "T1.6",
// "T1.7", …) and take the first one whose dependencies are all DONE
// and that no other user holds. That way a chain T1.5 → T1.6 → T1.7
// actually walks forward as each predecessor flips to DONE, instead
// of being frozen to a snapshot of "what was ready at t=0".
//
// Phase C — cloud-mode split:
//
// In cloud mode the orchestration loop lives on the agent VPS. The
// desktop's role is limited to:
//   1. Issuing `auto_run_*` WS frames (start/stop/pause/resume).
//   2. Polling `auto_run_status` every AUTO_RUN_POLL_INTERVAL_MS and
//      writing the agent's reply into the same signal that the bar
//      reads, so the UI reflects agent progress even when the app was
//      closed mid-run.
//   3. NOT running `advance()` / `pickAndDispatch()` for cloud queues.
//
// The two modes are kept strictly separate by the `origin` field on
// the in-memory queue object. Local queues have `origin: "local"`;
// cloud queues have `origin: "cloud"`. The local tick loop skips any
// queue whose origin is "cloud", so a mode-toggle mid-run cannot
// accidentally double-drive a queue. The field is optional in the
// persisted Zod schema so old local-only saves continue to parse.

import { createMemo, createSignal } from "solid-js";

import { listProjects } from "../db/projects";
import { getSetting, setSetting } from "../db/settings";
import { createRendererGitHubClient } from "../integrations/github";
import { createRendererPlanFlowClient } from "../integrations/planflow";
import { startTask } from "../integrations/planflow/startTask";
import type { Task } from "../integrations/planflow/schemas";
import { readTextFile } from "../ipc/files";
import { ptyKill } from "../ipc/pty";
import { awaitCloudClient } from "../ipc/transport";
import { cloudMode } from "../stores/cloudMode";
import {
  AUTO_RUN_POLL_INTERVAL_MS,
  AUTO_RUN_TASK_TIMEOUT_MS,
  AUTO_RUN_VERIFY_MERGE_TIMEOUT_MS,
  autoRunQueueSchema,
  createAutoRunQueueId,
  isAutoRunQueueActive,
  type AutoRunFailureMode,
  type AutoRunHistoryEntry,
  type AutoRunQueue,
  type AutoRunQueuesByProject,
} from "../types/autoRunQueue";
import type { PlanFlowStartMode } from "../types/planflowStartMode";

// ──────────────────────────────────────────────────────────────────────────
// In-memory queue type extended with an `origin` discriminator so the
// local tick loop can skip cloud-owned queues. The field is stripped
// before persistence so existing local saves still parse.

type AutoRunOrigin = "local" | "cloud";

/** In-memory queue object. `origin` is NOT persisted (always "local" on
 *  load from storage; cloud queues are never written to local storage). */
interface AutoRunQueueMem extends AutoRunQueue {
  origin: AutoRunOrigin;
}

// Re-export the public signal type without the internal `origin` field.
// Components consume `AutoRunQueue` (from types/), not `AutoRunQueueMem`.
type AutoRunQueuesByProjectMem = Record<string, AutoRunQueueMem>;

const [queuesSignal, setQueuesSignal] = createSignal<AutoRunQueuesByProjectMem>({});

let hydrated = false;
let tickInterval: ReturnType<typeof setInterval> | null = null;

/** Map of `projectId → polling interval handle` for cloud queues. */
const cloudPollIntervals = new Map<string, ReturnType<typeof setInterval>>();

export interface StartAutoRunInput {
  workspaceProjectId: string;
  externalId: string;
  targetCount: number;
  mode: PlanFlowStartMode;
  startAt: number | null;
  pacingMinutes: number;
  deadlineAt: number | null;
  onFailure: AutoRunFailureMode;
}

/** Plan-id ordering — "T<phase>.<index>". Mirrors compareTaskIds in
 *  PlanFlowTaskList so the queue picks the same order the row list
 *  renders. Keep this in sync if the format ever changes. */
function compareTaskIds(a: string, b: string): number {
  const parse = (id: string): { phase: number; index: number } | null => {
    const match = /^T(\d+)\.(\d+)$/.exec(id);
    if (!match) return null;
    const phase = Number.parseInt(match[1] ?? "", 10);
    const index = Number.parseInt(match[2] ?? "", 10);
    if (!Number.isFinite(phase) || !Number.isFinite(index)) return null;
    return { phase, index };
  };
  const pa = parse(a);
  const pb = parse(b);
  if (pa && pb) {
    if (pa.phase !== pb.phase) return pa.phase - pb.phase;
    return pa.index - pb.index;
  }
  if (pa) return -1;
  if (pb) return 1;
  return a.localeCompare(b);
}

/** Pick the next task to dispatch from a freshly-fetched task list.
 *  Returns null when nothing is dispatchable yet (a queue in this
 *  state finalises as `done`). */
function pickNextTaskId(
  tasks: readonly Task[],
  history: readonly AutoRunHistoryEntry[],
): string | null {
  const done = new Set<string>();
  for (const task of tasks) {
    if (task.status === "DONE" || task.status === "DROPPED") {
      done.add(task.taskId);
    }
  }
  // Tasks already attempted in this run are excluded — a failed task
  // shouldn't be picked again on the next tick if the user chose
  // onFailure=continue, and a "done" task we already credited
  // shouldn't slip back in if the listing lags behind the WS update.
  const attempted = new Set<string>(history.map((h) => h.taskId));

  const candidates: Task[] = [];
  for (const task of tasks) {
    if (attempted.has(task.taskId)) continue;
    if (task.status !== "TODO") continue;
    const deps = task.dependencies ?? [];
    if (deps.length > 0 && !deps.every((d) => done.has(d))) continue;
    const lockerId = task.lockedBy?.id ?? null;
    // Locked by anybody at all blocks the pick — auto-run doesn't try
    // to muscle through somebody else's session, and even our own
    // lock means the dispatcher is racing the previous turn.
    if (lockerId !== null) continue;
    candidates.push(task);
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => compareTaskIds(a.taskId, b.taskId));
  return candidates[0]?.taskId ?? null;
}

/** Read the queue for a workspace project (reactive). Returns null
 *  when no queue exists yet for this project. */
export function autoRunQueue(projectId: string): AutoRunQueue | null {
  const all = queuesSignal();
  return all[projectId] ?? null;
}

/** Memo so consumers can filter on "is there an active queue I care
 *  about" without re-rendering whenever an unrelated queue ticks. */
export function isAutoRunActive(projectId: string): boolean {
  const queue = queuesSignal()[projectId];
  return isAutoRunQueueActive(queue);
}

export const allAutoRunQueues = createMemo<AutoRunQueuesByProject>(() => queuesSignal());

/** Replace one project's slot. In local mode: persists asynchronously;
 *  the signal is updated synchronously. In cloud mode: only the signal
 *  is updated (the agent DB is the source of truth). */
function mutate(
  projectId: string,
  fn: (current: AutoRunQueueMem | null) => AutoRunQueueMem | null,
  { persist = true }: { persist?: boolean } = {},
): AutoRunQueueMem | null {
  const all = queuesSignal();
  const current = all[projectId] ?? null;
  const next = fn(current);
  const merged: AutoRunQueuesByProjectMem = {};
  for (const [key, value] of Object.entries(all)) {
    if (key === projectId && next === null) continue;
    merged[key] = value;
  }
  if (next !== null) {
    merged[projectId] = next;
  }
  setQueuesSignal(merged);

  // Cloud-mode queues are never written to local app_settings — the
  // agent DB is authoritative.  Also skip persisting if the caller
  // explicitly opted out (e.g. cloud poll write-back).
  const isCloud = next?.origin === "cloud" || current?.origin === "cloud";
  if (persist && !isCloud) {
    // Strip the runtime-only `origin` field before persisting by
    // running each queue through the Zod schema, which doesn't include it.
    const persistable: AutoRunQueuesByProject = {};
    for (const [k, v] of Object.entries(merged)) {
      if (v.origin === "cloud") continue;
      persistable[k] = autoRunQueueSchema.parse(v);
    }
    void setSetting("planflow_auto_run_queues", persistable).catch((err: unknown) => {
      console.warn("[autoRun] persist failed:", err);
    });
  }
  return next;
}

export async function hydrateAutoRunQueues(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const stored = await getSetting("planflow_auto_run_queues");
    // Attach `origin: "local"` to every rehydrated queue.
    const withOrigin: AutoRunQueuesByProjectMem = {};
    if (stored) {
      for (const [k, v] of Object.entries(stored)) {
        withOrigin[k] = { ...v, origin: "local" };
      }
    }
    setQueuesSignal(withOrigin);
  } catch (err) {
    console.warn("[autoRun] hydrate failed:", err);
  }
  ensureTickStarted();
}

export function ensureTickStarted(): void {
  if (tickInterval !== null) return;
  if (typeof window === "undefined") return;
  tickInterval = setInterval(() => {
    void tick();
  }, AUTO_RUN_POLL_INTERVAL_MS);
  void tick();
}

export function _stopTickForTests(): void {
  if (tickInterval !== null) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
  // Also stop any cloud poll intervals.
  for (const handle of cloudPollIntervals.values()) {
    clearInterval(handle);
  }
  cloudPollIntervals.clear();
}

/** Test-only: clear all in-memory queues, stop timers, and reset the
 *  hydration latch so each test starts from a blank store. */
export function _resetForTests(): void {
  _stopTickForTests();
  setQueuesSignal({});
  hydrated = false;
}

// ──────────────────────────────────────────────────────────────────────────
// Cloud-mode helpers

/** Parse the raw agent response into a validated AutoRunQueue. The agent
 *  returns camelCase keys matching the TS interface exactly. Returns null
 *  when `data` is null (no queue found). Throws on invalid shape. */
function parseAgentQueue(data: unknown): AutoRunQueueMem | null {
  if (data === null || data === undefined) return null;
  const parsed = autoRunQueueSchema.parse(data);
  return { ...parsed, origin: "cloud" as const };
}

/** Write an agent-returned queue into the signal without persisting to
 *  local storage (cloud queues live in the agent DB). */
function mutateFromAgent(projectId: string, queue: AutoRunQueueMem | null): void {
  mutate(projectId, () => queue, { persist: false });
}

/** Start the status-polling loop for a cloud queue. Idempotent — calling
 *  while a loop is already running is a no-op. Stops automatically when
 *  the queue reaches a terminal state (done/stopped/failed/idle). */
function startCloudPoll(projectId: string): void {
  if (cloudPollIntervals.has(projectId)) return;
  const handle = setInterval(() => {
    void pollCloudQueue(projectId);
  }, AUTO_RUN_POLL_INTERVAL_MS);
  cloudPollIntervals.set(projectId, handle);
}

function stopCloudPoll(projectId: string): void {
  const handle = cloudPollIntervals.get(projectId);
  if (handle !== undefined) {
    clearInterval(handle);
    cloudPollIntervals.delete(projectId);
  }
}

async function pollCloudQueue(projectId: string): Promise<void> {
  try {
    const client = await awaitCloudClient();
    const raw = await client.autoRunStatus(projectId);
    const queue = parseAgentQueue(raw);
    mutateFromAgent(projectId, queue);
    // Stop polling once the queue is in a terminal / inactive state.
    if (!queue || !isAutoRunQueueActive(queue)) {
      stopCloudPoll(projectId);
    }
  } catch (err) {
    console.warn(`[autoRun:${projectId}] cloud poll failed:`, err);
  }
}

/** Rehydrate a cloud queue from the agent on app launch / project open.
 *  Cloud queues are NOT persisted to local app_settings (the agent DB is
 *  the source of truth), so after an app restart the in-memory signal is
 *  empty and the bar wouldn't show an already-running queue. Call this
 *  when a cloud project's task view mounts: it asks the agent for the
 *  current queue and, if one is active, seeds the signal + resumes
 *  polling so the bar reappears. No-op in local mode. Idempotent —
 *  `startCloudPoll` guards against duplicate loops. */
export async function hydrateCloudAutoRun(projectId: string): Promise<void> {
  if (!cloudMode()) return;
  try {
    const client = await awaitCloudClient();
    const raw = await client.autoRunStatus(projectId);
    const queue = parseAgentQueue(raw);
    if (queue && isAutoRunQueueActive(queue)) {
      mutateFromAgent(projectId, queue);
      startCloudPoll(projectId);
    }
  } catch (err) {
    console.warn(`[autoRun:${projectId}] cloud hydrate failed:`, err);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Public action API

export async function startAutoRun(input: StartAutoRunInput): Promise<AutoRunQueue> {
  if (cloudMode()) {
    // Cloud branch — delegate everything to the agent orchestrator.
    const client = await awaitCloudClient();
    const raw = await client.autoRunStart({
      project_id: input.workspaceProjectId,
      target_count: input.targetCount,
      mode: input.mode,
      start_at: input.startAt,
      pacing_minutes: input.pacingMinutes,
      deadline_at: input.deadlineAt,
      on_failure: input.onFailure,
    });
    const queue = parseAgentQueue(raw);
    if (!queue) {
      throw new Error("[autoRun] cloud agent returned null for auto_run_start");
    }
    mutateFromAgent(input.workspaceProjectId, queue);
    startCloudPoll(input.workspaceProjectId);
    return queue;
  }

  // Local branch — unchanged from original.
  const now = Date.now();
  const queue: AutoRunQueueMem = {
    id: createAutoRunQueueId(),
    projectId: input.workspaceProjectId,
    externalId: input.externalId,
    targetCount: input.targetCount,
    completedCount: 0,
    currentTaskId: null,
    currentBranchName: null,
    currentSessionId: null,
    verifyStartedAt: null,
    mode: input.mode,
    startAt: input.startAt,
    pacingMinutes: input.pacingMinutes,
    deadlineAt: input.deadlineAt,
    onFailure: input.onFailure,
    state: input.startAt && input.startAt > now ? "scheduled" : "running",
    currentTaskStartedAt: null,
    nextDispatchAt: input.startAt && input.startAt > now ? input.startAt : null,
    history: [],
    createdAt: now,
    origin: "local",
  };
  mutate(input.workspaceProjectId, () => queue);
  ensureTickStarted();
  if (queue.state === "running") {
    void pickAndDispatch(queue.projectId);
  }
  return queue;
}

export async function pauseAutoRun(projectId: string): Promise<void> {
  if (cloudMode()) {
    try {
      const client = await awaitCloudClient();
      const raw = await client.autoRunPause(projectId);
      const queue = parseAgentQueue(raw);
      mutateFromAgent(projectId, queue);
    } catch (err) {
      console.warn(`[autoRun:${projectId}] cloud pause failed:`, err);
    }
    return;
  }

  // Local branch — unchanged.
  mutate(projectId, (current) => {
    if (!current) return current;
    if (!isAutoRunQueueActive(current)) return current;
    return { ...current, state: "paused", nextDispatchAt: null };
  });
}

export async function resumeAutoRun(projectId: string): Promise<void> {
  if (cloudMode()) {
    try {
      const client = await awaitCloudClient();
      const raw = await client.autoRunResume(projectId);
      const queue = parseAgentQueue(raw);
      mutateFromAgent(projectId, queue);
      if (queue && isAutoRunQueueActive(queue)) {
        startCloudPoll(projectId);
      }
    } catch (err) {
      console.warn(`[autoRun:${projectId}] cloud resume failed:`, err);
    }
    return;
  }

  // Local branch — unchanged.
  mutate(projectId, (current) => {
    if (!current) return current;
    if (current.state !== "paused") return current;
    if (current.currentTaskId !== null && current.currentTaskStartedAt !== null) {
      return { ...current, state: "running" };
    }
    return { ...current, state: "waiting", nextDispatchAt: Date.now() };
  });
}

export async function stopAutoRun(projectId: string): Promise<void> {
  if (cloudMode()) {
    try {
      const client = await awaitCloudClient();
      const raw = await client.autoRunStop(projectId);
      const queue = parseAgentQueue(raw);
      mutateFromAgent(projectId, queue);
      stopCloudPoll(projectId);
    } catch (err) {
      console.warn(`[autoRun:${projectId}] cloud stop failed:`, err);
    }
    return;
  }

  // Local branch — unchanged.
  mutate(projectId, (current) => {
    if (!current) return current;
    return {
      ...current,
      state: "stopped",
      nextDispatchAt: null,
    };
  });
}

export function dismissAutoRun(projectId: string): void {
  // Dismiss is UI-only — stop cloud polling and clear signal, no WS frame
  // needed (the agent keeps its history row regardless).
  stopCloudPoll(projectId);
  mutate(
    projectId,
    (current) => {
      if (!current) return current;
      if (isAutoRunQueueActive(current)) return current;
      return null;
    },
    { persist: !cloudMode() },
  );
}

async function tick(): Promise<void> {
  const all = queuesSignal();
  const entries = Object.entries(all);
  for (const [projectId, queue] of entries) {
    if (!isAutoRunQueueActive(queue)) continue;
    // Cloud queues are driven by the agent — never advance them locally.
    if (queue.origin === "cloud") continue;
    try {
      await advance(projectId, queue);
    } catch (err) {
      console.warn(`[autoRun:${projectId}] advance failed:`, err);
    }
  }
}

async function advance(projectId: string, queue: AutoRunQueueMem): Promise<void> {
  // Double-check: never dispatch a cloud-origin queue from the local loop,
  // even if called directly (e.g. from resumeAutoRun's local branch).
  if (queue.origin === "cloud") return;

  const now = Date.now();

  if (queue.state === "scheduled") {
    if (queue.startAt !== null && now >= queue.startAt) {
      mutate(projectId, (q) => {
        if (!q || q.state !== "scheduled") return q;
        return { ...q, state: "running", nextDispatchAt: null };
      });
      await pickAndDispatch(projectId);
    }
    return;
  }

  if (queue.state === "waiting") {
    if (queue.nextDispatchAt === null || now >= queue.nextDispatchAt) {
      if (queue.deadlineAt !== null && now >= queue.deadlineAt) {
        finalizeOnDeadline(projectId);
        return;
      }
      mutate(projectId, (q) => {
        if (!q || q.state !== "waiting") return q;
        return { ...q, state: "running", nextDispatchAt: null };
      });
      await pickAndDispatch(projectId);
    }
    return;
  }

  if (queue.state === "running") {
    await pollRunning(projectId, queue);
    return;
  }

  if (queue.state === "verifying_merge") {
    await pollMergeStatus(projectId, queue);
    return;
  }
}

async function pollRunning(projectId: string, queue: AutoRunQueueMem): Promise<void> {
  const taskId = queue.currentTaskId;
  if (!taskId) {
    // No task in flight — re-trigger the picker. Happens when the
    // dispatcher couldn't find a task on its first attempt but the
    // queue stayed in `running` for a moment.
    await pickAndDispatch(projectId);
    return;
  }

  let task: Task | null = null;
  try {
    const client = createRendererPlanFlowClient({ cloudProjectId: queue.projectId });
    task = await client.getTask(queue.externalId, taskId);
  } catch (err) {
    console.warn(`[autoRun:${projectId}] poll failed for ${taskId}:`, err);
    return;
  }

  const startedAt = queue.currentTaskStartedAt ?? Date.now();
  const elapsed = Date.now() - startedAt;

  if (task?.status === "DONE" || task?.status === "DROPPED") {
    completeCurrent(projectId, taskId, "done", startedAt);
    return;
  }

  if (elapsed > AUTO_RUN_TASK_TIMEOUT_MS) {
    completeCurrent(projectId, taskId, "timeout", startedAt);
  }
}

function completeCurrent(
  projectId: string,
  taskId: string,
  status: AutoRunHistoryEntry["status"],
  startedAt: number,
): void {
  const finishedAt = Date.now();
  // Capture the just-finished task's headless PTY id BEFORE the mutate
  // clears it. Every branch except `verifying_merge` drops the session
  // id from the queue; the kill below tears down the matching PTY on
  // the backend so we don't leak a claude process per task. Without
  // this, long auto-run runs piled up dozens of orphan claudes on the
  // cloud-agent VPS, exhausted its RAM, and made subsequent dispatches
  // silently fail to spawn.
  const previousSessionId = queuesSignal()[projectId]?.currentSessionId ?? null;
  mutate(projectId, (q) => {
    if (!q) return q;
    const entry: AutoRunHistoryEntry = { taskId, status, startedAt, finishedAt };
    const history = [...q.history, entry];

    if ((status === "failed" || status === "timeout") && q.onFailure === "stop") {
      return {
        ...q,
        history,
        state: "paused",
        nextDispatchAt: null,
        currentTaskId: null,
        currentBranchName: null,
        currentSessionId: null,
        currentTaskStartedAt: null,
        verifyStartedAt: null,
      };
    }

    // For auto-merge mode: PlanFlow flipped DONE the moment the agent
    // enabled GitHub auto-merge, but the PR itself hasn't merged yet
    // (CI is still running). Hold here in `verifying_merge` until the
    // PR's `merged_at` shows up — the next task's agent needs an
    // updated master to checkout from.
    if (
      status === "done" &&
      q.mode === "auto-merge" &&
      q.currentBranchName !== null &&
      // No point verifying when we're already at the target — last task
      // just count it done.
      q.completedCount + 1 < q.targetCount
    ) {
      return {
        ...q,
        history,
        // Don't bump completedCount until the merge is confirmed; the
        // history entry stands either way so the bar shows "X done + 1 verifying".
        state: "verifying_merge",
        verifyStartedAt: finishedAt,
        nextDispatchAt: null,
        currentTaskStartedAt: null,
      };
    }

    const completedCount = q.completedCount + 1;
    const allDone = completedCount >= q.targetCount;

    if (allDone) {
      return {
        ...q,
        history,
        completedCount,
        state: "done",
        nextDispatchAt: null,
        currentTaskId: null,
        currentBranchName: null,
        currentSessionId: null,
        currentTaskStartedAt: null,
        verifyStartedAt: null,
      };
    }

    const pacingMs = q.pacingMinutes * 60 * 1000;
    return {
      ...q,
      history,
      completedCount,
      state: pacingMs > 0 ? "waiting" : "running",
      nextDispatchAt: pacingMs > 0 ? finishedAt + pacingMs : null,
      currentTaskId: null,
      currentBranchName: null,
      currentSessionId: null,
      currentTaskStartedAt: null,
      verifyStartedAt: null,
    };
  });

  const updated = queuesSignal()[projectId];

  // Reap the just-finished task's PTY when the mutate cleared its
  // session id. verifying_merge keeps the id intact (the PR check
  // may still want to inspect the agent's last words), so we only
  // kill when the queue actually moved past this task.
  if (previousSessionId !== null && updated?.currentSessionId !== previousSessionId) {
    void ptyKill(previousSessionId).catch((err) => {
      console.warn(`[autoRun:${projectId}] ptyKill ${previousSessionId.slice(0, 8)} failed:`, err);
    });
  }

  if (updated && updated.state === "running") {
    void pickAndDispatch(projectId);
  }
}

function finalizeOnDeadline(projectId: string): void {
  mutate(projectId, (q) => {
    if (!q) return q;
    return {
      ...q,
      state: "done",
      nextDispatchAt: null,
      currentTaskId: null,
      currentTaskStartedAt: null,
    };
  });
}

async function pickAndDispatch(projectId: string): Promise<void> {
  const queue = queuesSignal()[projectId];
  if (!queue || queue.state !== "running") return;
  // Guard: local dispatch must never run for cloud queues.
  if (queue.origin === "cloud") return;

  // Re-query the task list at the dispatch boundary so we honor the
  // *current* dependency graph. A predecessor that just flipped to
  // DONE makes its successor pickable in the same tick — no stale
  // snapshot from queue-create time.
  let tasks: Task[] = [];
  try {
    const client = createRendererPlanFlowClient({ cloudProjectId: queue.projectId });
    tasks = await client.listTasks(queue.externalId);
  } catch (err) {
    console.warn(`[autoRun:${projectId}] listTasks failed:`, err);
    // Defer to the next tick — likely a transient network blip.
    return;
  }

  const taskId = pickNextTaskId(tasks, queue.history);
  if (taskId === null) {
    // Nothing else to dispatch. We've either run PlanFlow dry or the
    // graph is stuck behind a non-ready task. Either way the user
    // gets a tidy `done` and can dismiss when they're satisfied.
    mutate(projectId, (q) => {
      if (!q) return q;
      return {
        ...q,
        state: "done",
        nextDispatchAt: null,
        currentTaskId: null,
        currentTaskStartedAt: null,
      };
    });
    return;
  }

  mutate(projectId, (q) => {
    if (!q || q.state !== "running") return q;
    return {
      ...q,
      currentTaskId: taskId,
      currentTaskStartedAt: Date.now(),
    };
  });

  console.warn(`[autoRun:${projectId}] dispatch START taskId=${taskId}`);
  try {
    const client = createRendererPlanFlowClient({ cloudProjectId: queue.projectId });
    const result = await startTask({
      client,
      externalId: queue.externalId,
      workspaceProjectId: queue.projectId,
      taskId,
      cliName: "claude",
      mode: queue.mode,
      // Auto-run owns the dispatch. Spawn the CLI off-layout so a
      // queue of 5+ tasks doesn't pile pane after pane into the
      // visible grid; the Auto-run bar's "Open" button surfaces a
      // running task's PTY when the user wants to peek.
      headless: true,
    });
    console.warn(
      `[autoRun:${projectId}] dispatch OK taskId=${taskId} sessionId=${result.sessionId} branch=${result.branchName}`,
    );
    // Stash the branch name + headless session id. `null` for either
    // field is fine — verify_merge just skips its PR check, and the
    // bar hides the "Open" button when there's no session to attach.
    mutate(projectId, (q) => {
      if (!q) return q;
      return {
        ...q,
        currentBranchName: result.branchName,
        currentSessionId: result.sessionId,
      };
    });
  } catch (err) {
    console.warn(`[autoRun:${projectId}] dispatch FAILED for ${taskId}:`, err);
    completeCurrent(projectId, taskId, "failed", Date.now());
  }
}

// ──────────────────────────────────────────────────────────────────────
// verifying_merge — wait for the auto-merge PR to actually merge before
// dispatching the next task, so the follow-up agent works against a
// master that includes the just-finished work.

/** Cache project root → "owner/repo" so we don't re-read `.git/config`
 *  on every poll tick. Cleared on app restart (module-level Map). */
const repoCache = new Map<string, string | null>();

async function resolveRepoForProject(workspaceProjectId: string): Promise<string | null> {
  if (repoCache.has(workspaceProjectId)) {
    return repoCache.get(workspaceProjectId) ?? null;
  }
  let repo: string | null = null;
  try {
    const all = await listProjects();
    const project = all.find((p) => p.id === workspaceProjectId);
    if (!project) {
      repoCache.set(workspaceProjectId, null);
      return null;
    }
    const config = await readTextFile(project.path, ".git/config");
    if (config.kind === "text") {
      repo = parseOriginRepo(config.content);
    }
  } catch (err) {
    // No git repo, no permission, or cloud mode — fall back to skipping.
    console.warn(`[autoRun:${workspaceProjectId}] repo detect failed:`, err);
  }
  repoCache.set(workspaceProjectId, repo);
  return repo;
}

/** Parse `url = ...` from a `.git/config` and return "owner/repo" for
 *  the GitHub `origin` remote. Handles both SSH and HTTPS forms. */
function parseOriginRepo(config: string): string | null {
  // Walk sections; pick the `[remote "origin"]` block's `url = ...`.
  const lines = config.split(/\r?\n/);
  let inOrigin = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    if (!inOrigin) continue;
    const match = /^url\s*=\s*(.+)$/.exec(line);
    if (!match) continue;
    const url = match[1]?.trim() ?? "";
    // git@github.com:owner/repo.git
    const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
    if (ssh) return `${ssh[1]}/${ssh[2]}`;
    // https://github.com/owner/repo(.git)?
    const https = /^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/.exec(url);
    if (https) return `${https[1]}/${https[2]}`;
  }
  return null;
}

async function pollMergeStatus(projectId: string, queue: AutoRunQueueMem): Promise<void> {
  const verifyStartedAt = queue.verifyStartedAt ?? Date.now();
  const branch = queue.currentBranchName;
  // Without a branch name we can't look the PR up at all — short-circuit
  // to "merged" so the queue keeps moving. Same when the project doesn't
  // resolve to a GitHub repo. Verification is best-effort.
  if (!branch) {
    finishVerifyAdvance(projectId);
    return;
  }
  if (Date.now() - verifyStartedAt > AUTO_RUN_VERIFY_MERGE_TIMEOUT_MS) {
    // Don't pin the queue forever — let the next task try, and the
    // user can pause/stop if it goes sideways.
    console.warn(`[autoRun:${projectId}] verify_merge timed out for ${branch}`);
    finishVerifyAdvance(projectId);
    return;
  }

  const repo = await resolveRepoForProject(queue.projectId);
  if (!repo) {
    // No way to query — advance optimistically.
    finishVerifyAdvance(projectId);
    return;
  }
  const [owner, name] = repo.split("/");
  if (!owner || !name) {
    finishVerifyAdvance(projectId);
    return;
  }

  try {
    const gh = createRendererGitHubClient();
    const prs = await gh.listPullRequests(
      { owner, repo: name },
      { state: "all", head: `${owner}:${branch}`, perPage: 5 },
    );
    // Most recent PR for this head branch wins. auto-merge --squash
    // leaves merged_at non-null after the merge completes.
    const merged = prs.find((pr) => pr.merged_at != null);
    if (merged) {
      finishVerifyAdvance(projectId);
    }
    // else: keep polling, next tick will retry.
  } catch (err) {
    // GitHub token missing / 401 / 403 / network blip — skip verification
    // rather than pin the queue.
    console.warn(`[autoRun:${projectId}] verify_merge poll failed:`, err);
    finishVerifyAdvance(projectId);
  }
}

/** Move out of verifying_merge: bump completedCount, decide whether
 *  to enter pacing or dispatch the next task immediately. */
function finishVerifyAdvance(projectId: string): void {
  // Same PTY-reap dance as `completeCurrent` — the verifying_merge
  // state keeps the headless session id alive across the PR check;
  // now that we've decided the task is truly done, kill the agent
  // process so it doesn't camp on cloud-agent RAM forever.
  const previousSessionId = queuesSignal()[projectId]?.currentSessionId ?? null;
  mutate(projectId, (q) => {
    if (!q || q.state !== "verifying_merge") return q;
    const completedCount = q.completedCount + 1;
    const allDone = completedCount >= q.targetCount;
    if (allDone) {
      return {
        ...q,
        completedCount,
        state: "done",
        nextDispatchAt: null,
        currentTaskId: null,
        currentBranchName: null,
        currentSessionId: null,
        currentTaskStartedAt: null,
        verifyStartedAt: null,
      };
    }
    const pacingMs = q.pacingMinutes * 60 * 1000;
    return {
      ...q,
      completedCount,
      state: pacingMs > 0 ? "waiting" : "running",
      nextDispatchAt: pacingMs > 0 ? Date.now() + pacingMs : null,
      currentTaskId: null,
      currentBranchName: null,
      currentSessionId: null,
      currentTaskStartedAt: null,
      verifyStartedAt: null,
    };
  });
  const updated = queuesSignal()[projectId];

  if (previousSessionId !== null && updated?.currentSessionId !== previousSessionId) {
    void ptyKill(previousSessionId).catch((err) => {
      console.warn(
        `[autoRun:${projectId}] ptyKill (verify-advance) ${previousSessionId.slice(0, 8)} failed:`,
        err,
      );
    });
  }

  if (updated && updated.state === "running") {
    void pickAndDispatch(projectId);
  }
}

if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
  void hydrateAutoRunQueues();
}
