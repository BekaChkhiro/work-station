// Auto-run queue model for the PlanFlow tab.
//
// Lets the user pick the first N "ready" tasks (TODO + deps satisfied
// + not locked-by-other) and dispatch them autonomously, one at a
// time, with optional pacing between them and an optional deadline.
//
// State machine (see `state`):
//   idle      — not active. Persisted only after a queue has ever run
//               (history retained); otherwise the slot is null.
//   scheduled — startAt is in the future; tick loop will move us to
//               `running` when it elapses.
//   running   — task #cursor is dispatched, we're polling PlanFlow
//               for its status to flip to DONE.
//   waiting   — task #cursor finished (DONE or failed-but-continue),
//               nextDispatchAt is set in the pacing window.
//   paused    — user pressed pause OR a failure triggered onFailure=stop.
//               No more dispatches until resumed.
//   stopped   — user pressed stop; no more dispatches, queue archived.
//   done      — cursor === taskIds.length, all finished successfully.
//   failed    — onFailure=stop tripped; queue archived.
//
// All time fields are epoch milliseconds (Date.now()). They survive
// app restarts because the store rehydrates from app_settings and
// re-arms the timers from `nextDispatchAt` / `startAt`.

import { z } from "zod";

import type { PlanFlowStartMode } from "./planflowStartMode";

export type AutoRunState =
  | "idle"
  | "scheduled"
  | "running"
  | "waiting"
  | "paused"
  | "stopped"
  | "done"
  | "failed";

export type AutoRunFailureMode = "stop" | "continue";

export type AutoRunHistoryStatus = "done" | "failed" | "skipped" | "timeout";

export interface AutoRunHistoryEntry {
  taskId: string;
  status: AutoRunHistoryStatus;
  startedAt: number;
  finishedAt: number | null;
}

export interface AutoRunQueue {
  /** Stable id so the bar can React-key reliably across remounts. */
  id: string;
  /** Workspace projectId — keyed in the persisted record. */
  projectId: string;
  /** PlanFlow externalId — passed to startTask + getTask polling. */
  externalId: string;
  /** Ordered task ids ("T1.3", "T1.4", …). Frozen at queue-create
   *  time so a mid-run change in the PlanFlow list doesn't reshuffle
   *  what's already dispatched. */
  taskIds: string[];
  /** Shared mode for every task in this queue. */
  mode: PlanFlowStartMode;
  /** Epoch ms to begin the first dispatch. Null = start immediately. */
  startAt: number | null;
  /** Minutes to wait between a task's DONE and the next dispatch.
   *  0 = back-to-back. */
  pacingMinutes: number;
  /** Epoch ms hard stop — if Date.now() > deadlineAt at the moment of
   *  the next dispatch, we mark the queue done with remaining tasks
   *  skipped. Null = no deadline. */
  deadlineAt: number | null;
  /** stop: pause queue + notify; continue: log + keep going. */
  onFailure: AutoRunFailureMode;
  /** Index of the next task to dispatch. After all dispatches it
   *  equals taskIds.length and state flips to "done". */
  cursor: number;
  state: AutoRunState;
  /** When the *currently-running* task was dispatched. Lets us detect
   *  a stuck task (no DONE flip after 60 min → timeout). */
  currentTaskStartedAt: number | null;
  /** Set during `waiting` (pacing) and `scheduled` (initial delay).
   *  The tick loop wakes up when now >= this. */
  nextDispatchAt: number | null;
  history: AutoRunHistoryEntry[];
  /** Epoch ms when the user pressed Run — useful for the bar label
   *  and for sorting multiple historical runs. */
  createdAt: number;
}

export const autoRunHistoryEntrySchema = z.object({
  taskId: z.string(),
  status: z.enum(["done", "failed", "skipped", "timeout"]),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
});

export const autoRunQueueSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  externalId: z.string(),
  taskIds: z.array(z.string()),
  mode: z.enum(["manual", "pr", "merge-master", "none"]),
  startAt: z.number().nullable(),
  pacingMinutes: z
    .number()
    .min(0)
    .max(24 * 60),
  deadlineAt: z.number().nullable(),
  onFailure: z.enum(["stop", "continue"]),
  cursor: z.number().int().min(0),
  state: z.enum(["idle", "scheduled", "running", "waiting", "paused", "stopped", "done", "failed"]),
  currentTaskStartedAt: z.number().nullable(),
  nextDispatchAt: z.number().nullable(),
  history: z.array(autoRunHistoryEntrySchema),
  createdAt: z.number(),
});

/** Persisted shape — one queue per workspace projectId. Missing keys
 *  mean "no queue ever ran here". A finished queue (state=done/failed/
 *  stopped) stays in the record so the UI can show "Last run: …"; the
 *  user can dismiss it explicitly. */
export const autoRunQueuesByProjectSchema = z.record(z.string(), autoRunQueueSchema);
export type AutoRunQueuesByProject = z.infer<typeof autoRunQueuesByProjectSchema>;

/** Stale-task timeout: if a task stays IN_PROGRESS for longer than
 *  this without flipping to DONE, the tick loop counts it as a
 *  timeout and applies onFailure. Headless agents on a fresh repo
 *  + slow `pnpm install` can easily hit 30 min, so we err generous. */
export const AUTO_RUN_TASK_TIMEOUT_MS = 90 * 60 * 1000;

/** Polling cadence for task status. PlanFlow API is light, but the
 *  agent ticks at a much slower beat — 20s is responsive enough for
 *  the bar without hammering the server. */
export const AUTO_RUN_POLL_INTERVAL_MS = 20 * 1000;

/** Make a typed empty queue for `idle` slots — used by the store when
 *  it needs a baseline before the user opens the dialog. */
export function createAutoRunQueueId(): string {
  return `arq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function isAutoRunQueueActive(queue: AutoRunQueue | null | undefined): boolean {
  if (!queue) return false;
  return (
    queue.state === "scheduled" ||
    queue.state === "running" ||
    queue.state === "waiting" ||
    queue.state === "paused"
  );
}

export function autoRunQueueProgressLabel(queue: AutoRunQueue): string {
  const total = queue.taskIds.length;
  const done = queue.history.filter((h) => h.status === "done").length;
  return `${done}/${total}`;
}
