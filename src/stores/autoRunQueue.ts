// Auto-run queue store.
//
// Manages one persisted AutoRunQueue per workspace projectId. The
// tick loop drives state transitions independently from any UI
// component — the dialog only seeds a queue, the bar only renders
// it, and even with both unmounted the loop keeps dispatching tasks
// until the queue is done / stopped.
//
// Tick algorithm (every AUTO_RUN_POLL_INTERVAL_MS):
//   1. For each persisted queue whose state is active, advance one
//      step at most. We never recursively chain dispatches in a
//      single tick — that would risk dispatching past a failure
//      before the next poll could see it.
//   2. Scheduled → if Date.now() >= startAt, dispatch task #cursor.
//   3. Running   → call PlanFlowClient.getTask; if DONE move to
//      waiting (with pacing nextDispatchAt). If still in flight but
//      elapsed > AUTO_RUN_TASK_TIMEOUT_MS, record a timeout entry.
//   4. Waiting   → if Date.now() >= nextDispatchAt, check the
//      deadline; either dispatch the next task or mark the queue
//      done with remaining tasks skipped.
//
// All transitions go through `mutate(projectId, fn)` so the persisted
// settings record stays in lockstep with the in-memory signal.

import { createMemo, createSignal } from "solid-js";

import { getSetting, setSetting } from "../db/settings";
import { createRendererPlanFlowClient } from "../integrations/planflow";
import { startTask } from "../integrations/planflow/startTask";
import type { Task } from "../integrations/planflow/schemas";
import {
  AUTO_RUN_POLL_INTERVAL_MS,
  AUTO_RUN_TASK_TIMEOUT_MS,
  createAutoRunQueueId,
  isAutoRunQueueActive,
  type AutoRunFailureMode,
  type AutoRunHistoryEntry,
  type AutoRunQueue,
  type AutoRunQueuesByProject,
} from "../types/autoRunQueue";
import type { PlanFlowStartMode } from "../types/planflowStartMode";

const [queuesSignal, setQueuesSignal] = createSignal<AutoRunQueuesByProject>({});

let hydrated = false;
let tickInterval: ReturnType<typeof setInterval> | null = null;

export interface StartAutoRunInput {
  workspaceProjectId: string;
  externalId: string;
  taskIds: string[];
  mode: PlanFlowStartMode;
  startAt: number | null;
  pacingMinutes: number;
  deadlineAt: number | null;
  onFailure: AutoRunFailureMode;
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

/** Replace one project's slot. Persists asynchronously; the signal
 *  is updated synchronously so reactive UI stays in lockstep. */
function mutate(
  projectId: string,
  fn: (current: AutoRunQueue | null) => AutoRunQueue | null,
): AutoRunQueue | null {
  const all = queuesSignal();
  const current = all[projectId] ?? null;
  const next = fn(current);
  const merged: AutoRunQueuesByProject = {};
  for (const [key, value] of Object.entries(all)) {
    if (key === projectId && next === null) continue;
    merged[key] = value;
  }
  if (next !== null) {
    merged[projectId] = next;
  }
  setQueuesSignal(merged);
  void setSetting("planflow_auto_run_queues", merged).catch((err: unknown) => {
    console.warn("[autoRun] persist failed:", err);
  });
  return next;
}

export async function hydrateAutoRunQueues(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const stored = await getSetting("planflow_auto_run_queues");
    // On boot we re-arm `scheduled` queues whose start time has
    // already elapsed — they'll be picked up by the next tick.
    setQueuesSignal(stored ?? {});
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
  // Fire a tick immediately on boot so a `scheduled` queue whose
  // start time has already elapsed doesn't wait the full poll
  // interval before its first dispatch.
  void tick();
}

/** Test-only — stop the interval so tests don't leak timers. */
export function _stopTickForTests(): void {
  if (tickInterval !== null) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

/** Construct a queue and persist it. Returns the seeded queue so the
 *  caller can show "started" feedback immediately. */
export function startAutoRun(input: StartAutoRunInput): AutoRunQueue {
  const now = Date.now();
  const queue: AutoRunQueue = {
    id: createAutoRunQueueId(),
    projectId: input.workspaceProjectId,
    externalId: input.externalId,
    taskIds: [...input.taskIds],
    mode: input.mode,
    startAt: input.startAt,
    pacingMinutes: input.pacingMinutes,
    deadlineAt: input.deadlineAt,
    onFailure: input.onFailure,
    cursor: 0,
    state: input.startAt && input.startAt > now ? "scheduled" : "running",
    currentTaskStartedAt: null,
    nextDispatchAt: input.startAt && input.startAt > now ? input.startAt : null,
    history: [],
    createdAt: now,
  };
  mutate(input.workspaceProjectId, () => queue);
  ensureTickStarted();
  // If we land directly in "running", dispatch task #0 right away
  // rather than waiting for the next tick — keeps the bar's
  // "current: …" label honest from t=0.
  if (queue.state === "running") {
    void dispatchCursor(queue.projectId);
  }
  return queue;
}

export function pauseAutoRun(projectId: string): void {
  mutate(projectId, (current) => {
    if (!current) return current;
    if (!isAutoRunQueueActive(current)) return current;
    return { ...current, state: "paused", nextDispatchAt: null };
  });
}

export function resumeAutoRun(projectId: string): void {
  mutate(projectId, (current) => {
    if (!current) return current;
    if (current.state !== "paused") return current;
    // If a task was in flight when we paused, leave the cursor on it
    // and resume polling. Otherwise we resume from the pacing window
    // (treat as if we just finished — next dispatch ASAP).
    if (current.currentTaskStartedAt !== null) {
      return { ...current, state: "running" };
    }
    return { ...current, state: "waiting", nextDispatchAt: Date.now() };
  });
}

export function stopAutoRun(projectId: string): void {
  mutate(projectId, (current) => {
    if (!current) return current;
    return {
      ...current,
      state: "stopped",
      nextDispatchAt: null,
    };
  });
}

/** Clear an inactive queue from the persisted record (after the user
 *  dismisses the "Last run: …" badge). No-op if a queue is still
 *  active — the UI should hide Dismiss while running. */
export function dismissAutoRun(projectId: string): void {
  mutate(projectId, (current) => {
    if (!current) return current;
    if (isAutoRunQueueActive(current)) return current;
    return null;
  });
}

async function tick(): Promise<void> {
  const all = queuesSignal();
  // Snapshot entries so a mutation mid-loop doesn't reshuffle the
  // iteration order. Each per-project handler awaits its own work.
  const entries = Object.entries(all);
  for (const [projectId, queue] of entries) {
    if (!isAutoRunQueueActive(queue)) continue;
    try {
      await advance(projectId, queue);
    } catch (err) {
      console.warn(`[autoRun:${projectId}] advance failed:`, err);
    }
  }
}

async function advance(projectId: string, queue: AutoRunQueue): Promise<void> {
  const now = Date.now();

  if (queue.state === "scheduled") {
    if (queue.startAt !== null && now >= queue.startAt) {
      mutate(projectId, (q) => {
        if (!q || q.state !== "scheduled") return q;
        return { ...q, state: "running", nextDispatchAt: null };
      });
      await dispatchCursor(projectId);
    }
    return;
  }

  if (queue.state === "waiting") {
    if (queue.nextDispatchAt === null || now >= queue.nextDispatchAt) {
      // Deadline gate — check before dispatching the next task.
      if (queue.deadlineAt !== null && now >= queue.deadlineAt) {
        finalizeOnDeadline(projectId);
        return;
      }
      mutate(projectId, (q) => {
        if (!q || q.state !== "waiting") return q;
        return { ...q, state: "running", nextDispatchAt: null };
      });
      await dispatchCursor(projectId);
    }
    return;
  }

  if (queue.state === "running") {
    await pollRunning(projectId, queue);
    return;
  }
}

async function pollRunning(projectId: string, queue: AutoRunQueue): Promise<void> {
  const taskId = queue.taskIds[queue.cursor];
  if (taskId === undefined) {
    // Defensive — cursor out of range means we finished but didn't
    // flip state. Repair it.
    mutate(projectId, (q) => {
      if (!q) return q;
      return { ...q, state: "done", nextDispatchAt: null, currentTaskStartedAt: null };
    });
    return;
  }

  let task: Task | null = null;
  try {
    const client = createRendererPlanFlowClient({ cloudProjectId: queue.projectId });
    task = await client.getTask(queue.externalId, taskId);
  } catch (err) {
    // Transient network failures shouldn't abort the queue — they'll
    // retry on the next tick. The bar still says "running".
    console.warn(`[autoRun:${projectId}] poll failed for ${taskId}:`, err);
    return;
  }

  const startedAt = queue.currentTaskStartedAt ?? Date.now();
  const elapsed = Date.now() - startedAt;

  if (task?.status === "DONE") {
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
  mutate(projectId, (q) => {
    if (!q) return q;
    const entry: AutoRunHistoryEntry = { taskId, status, startedAt, finishedAt };
    const history = [...q.history, entry];
    const nextCursor = q.cursor + 1;
    const allDone = nextCursor >= q.taskIds.length;

    // Failure-mode gate. `done` is always benign; `failed` / `timeout`
    // pause the queue when onFailure=stop. The user resumes via
    // resumeAutoRun, or stops entirely.
    if ((status === "failed" || status === "timeout") && q.onFailure === "stop") {
      return {
        ...q,
        history,
        state: "paused",
        nextDispatchAt: null,
        currentTaskStartedAt: null,
      };
    }

    if (allDone) {
      return {
        ...q,
        history,
        cursor: nextCursor,
        state: "done",
        nextDispatchAt: null,
        currentTaskStartedAt: null,
      };
    }

    const pacingMs = q.pacingMinutes * 60 * 1000;
    return {
      ...q,
      history,
      cursor: nextCursor,
      state: pacingMs > 0 ? "waiting" : "running",
      nextDispatchAt: pacingMs > 0 ? finishedAt + pacingMs : null,
      currentTaskStartedAt: null,
    };
  });

  // Back-to-back pacing: dispatch the next task immediately rather
  // than waiting the poll interval. With pacing > 0 the tick loop
  // picks it up when nextDispatchAt elapses.
  const updated = queuesSignal()[projectId];
  if (updated && updated.state === "running") {
    void dispatchCursor(projectId);
  }
}

function finalizeOnDeadline(projectId: string): void {
  mutate(projectId, (q) => {
    if (!q) return q;
    const finishedAt = Date.now();
    // Mark every remaining task as skipped so history shows what was
    // queued but never dispatched. cursor jumps to the end.
    const remaining = q.taskIds.slice(q.cursor).map((taskId) => ({
      taskId,
      status: "skipped" as const,
      startedAt: finishedAt,
      finishedAt,
    }));
    return {
      ...q,
      history: [...q.history, ...remaining],
      cursor: q.taskIds.length,
      state: "done",
      nextDispatchAt: null,
      currentTaskStartedAt: null,
    };
  });
}

async function dispatchCursor(projectId: string): Promise<void> {
  const queue = queuesSignal()[projectId];
  if (!queue || queue.state !== "running") return;
  const taskId = queue.taskIds[queue.cursor];
  if (taskId === undefined) {
    mutate(projectId, (q) => {
      if (!q) return q;
      return { ...q, state: "done" };
    });
    return;
  }

  // Stamp currentTaskStartedAt before we kick off startTask so the
  // timeout calculation has a reference even if the dispatch itself
  // is slow to resolve.
  mutate(projectId, (q) => {
    if (!q || q.state !== "running") return q;
    return { ...q, currentTaskStartedAt: Date.now() };
  });

  try {
    const client = createRendererPlanFlowClient({ cloudProjectId: queue.projectId });
    await startTask({
      client,
      externalId: queue.externalId,
      workspaceProjectId: queue.projectId,
      taskId,
      cliName: "claude",
      mode: queue.mode,
    });
  } catch (err) {
    console.warn(`[autoRun:${projectId}] dispatch failed for ${taskId}:`, err);
    completeCurrent(projectId, taskId, "failed", Date.now());
  }
}

if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
  void hydrateAutoRunQueues();
}
