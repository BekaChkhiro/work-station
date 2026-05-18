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
  void tick();
}

export function _stopTickForTests(): void {
  if (tickInterval !== null) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

export function startAutoRun(input: StartAutoRunInput): AutoRunQueue {
  const now = Date.now();
  const queue: AutoRunQueue = {
    id: createAutoRunQueueId(),
    projectId: input.workspaceProjectId,
    externalId: input.externalId,
    targetCount: input.targetCount,
    completedCount: 0,
    currentTaskId: null,
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
  };
  mutate(input.workspaceProjectId, () => queue);
  ensureTickStarted();
  if (queue.state === "running") {
    void pickAndDispatch(queue.projectId);
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
    if (current.currentTaskId !== null && current.currentTaskStartedAt !== null) {
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

export function dismissAutoRun(projectId: string): void {
  mutate(projectId, (current) => {
    if (!current) return current;
    if (isAutoRunQueueActive(current)) return current;
    return null;
  });
}

async function tick(): Promise<void> {
  const all = queuesSignal();
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
}

async function pollRunning(projectId: string, queue: AutoRunQueue): Promise<void> {
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
        currentTaskStartedAt: null,
      };
    }

    const completedCount = status === "done" ? q.completedCount + 1 : q.completedCount + 1;
    const allDone = completedCount >= q.targetCount;

    if (allDone) {
      return {
        ...q,
        history,
        completedCount,
        state: "done",
        nextDispatchAt: null,
        currentTaskId: null,
        currentTaskStartedAt: null,
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
      currentTaskStartedAt: null,
    };
  });

  const updated = queuesSignal()[projectId];
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
