// T19.16 — Cloud-mode offline queue.
//
// Holds write-side operations that were issued while the cloud-agent's
// `WsBridgeClient` was in a non-open state, and replays them in FIFO
// order once the connection reaches `open`. The analog of T11.9's
// `writeQueue` but for cloud-agent RPC calls instead of integration HTTP:
//
//   - Local-only state (lives for the lifetime of the app process).
//     Cloud-routed mutations are best-effort; durable replay across
//     restarts isn't part of this task.
//   - Capped at MAX_ENTRIES (50). Beyond the cap the oldest entry is
//     evicted with a warning toast — the user sees that data was
//     dropped instead of accumulating a queue that gets larger every
//     keystroke during a long outage.
//   - Replay is driven by the manager's state signal flipping into
//     `open`. The signal already powers the routing layer and the
//     banner, so a single source of truth keeps everything in sync.
//
// The queue is intentionally type-agnostic about what an "operation"
// returns: callers wrap their cloud-routed call inside a thunk and
// handle the result/error themselves on completion. This matches the
// callsite shape used in T19.9 / T19.11 / T19.14 (each module owns its
// state mutation) and keeps this module free of per-RPC schemas.

import { createEffect, createSignal, type Accessor } from "solid-js";

import { showToast } from "../../components/Toast";
import type { CloudAgentConnectionState, CloudAgentManager } from "./client";

const MAX_ENTRIES = 50;

export interface CloudQueueEntry {
  readonly id: number;
  /** Short user-facing label; surfaced in toasts when an entry is dropped
   *  or its replay fails. Pick something the user can recognise (e.g.
   *  "Save project Foo", "Update settings"). */
  readonly label: string;
  /** When the entry was queued, in ms since epoch. */
  readonly enqueuedAt: number;
  /** Replay count (0 before the first attempt). */
  readonly attempts: number;
  /** Last replay error, or null when no replay has been attempted yet. */
  readonly lastError: string | null;
}

interface InternalEntry extends CloudQueueEntry {
  /** The op to run on replay. Resolves on success, rejects on failure.
   *  Re-thrown errors leave the entry in the queue (FIFO; retried on
   *  next replay). */
  readonly run: () => Promise<unknown>;
}

let nextId = 1;
const [entries, setEntries] = createSignal<InternalEntry[]>([]);

/** Reactive accessor: public snapshot of the queue (without the
 *  internal `run` thunks). Useful for diagnostics surfaces, settings
 *  panels, and tests. */
export const cloudQueueEntries: Accessor<
  readonly CloudQueueEntry[]
> = (): readonly CloudQueueEntry[] =>
  entries().map(
    (entry): CloudQueueEntry => ({
      id: entry.id,
      label: entry.label,
      enqueuedAt: entry.enqueuedAt,
      attempts: entry.attempts,
      lastError: entry.lastError,
    }),
  );

/** Push an operation onto the cloud-mode offline queue.
 *
 *  Returns the entry's id. Callers do NOT await the operation here —
 *  it runs later, during replay. If the queue is full, the oldest
 *  entry is evicted with a warning toast (T11.9 parity). */
export function enqueueCloudOperation(opts: {
  label: string;
  op: () => Promise<unknown>;
  now?: () => number;
}): number {
  const now = opts.now ?? Date.now;
  const entry: InternalEntry = {
    id: nextId++,
    label: opts.label,
    enqueuedAt: now(),
    attempts: 0,
    lastError: null,
    run: opts.op,
  };

  setEntries((prev) => {
    if (prev.length < MAX_ENTRIES) return [...prev, entry];
    const dropped = prev[0];
    if (dropped) {
      showToast({
        message: `Cloud queue full — dropped pending "${dropped.label}"`,
        variant: "warning",
      });
    }
    return [...prev.slice(1), entry];
  });

  return entry.id;
}

/** Drain the queue once in FIFO order.
 *
 *  Stops at the first entry that throws — leaves the rest in the
 *  queue, ordered. The next reconnect (or a manual `replayCloudQueue()`
 *  call) picks up where this run left off. Returns the count of
 *  entries successfully drained.
 *
 *  Errors are toasted with the entry's label so the user has a hint
 *  about what didn't go through. The entry's `lastError` and `attempts`
 *  fields are bumped so a diagnostics surface can show the history. */
export async function replayCloudQueue(opts?: { now?: () => number }): Promise<number> {
  const now = opts?.now ?? Date.now;
  let drained = 0;

  // Iterate against a live snapshot so a `pre.shift()` style mutation
  // can't lose ordering if `op()` synchronously enqueues another item.
  // We resolve each entry by id against the current array.
  while (true) {
    const current = entries();
    const head = current[0];
    if (!head) break;

    try {
      await head.run();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setEntries((prev) =>
        prev.map((e) =>
          e.id === head.id ? { ...e, attempts: e.attempts + 1, lastError: message } : e,
        ),
      );
      showToast({
        message: `Cloud queue: "${head.label}" failed — will retry on next reconnect`,
        variant: "warning",
      });
      // Bail out — leave the rest in the queue. Retrying immediately
      // would just hammer the same broken connection.
      void now;
      return drained;
    }

    // Success — pop the head. Guard against the entry being evicted
    // mid-replay (e.g. queue cap kicked in after another enqueue).
    setEntries((prev) => prev.filter((e) => e.id !== head.id));
    drained++;
  }

  return drained;
}

/** Test-only: drop every entry without running anything. */
export function _clearCloudQueueForTests(): void {
  setEntries([]);
  nextId = 1;
}

let autoReplayInstalled = false;

/** Hook the queue into the manager's state signal: every time the
 *  state transitions to `open`, call [`replayCloudQueue`]. Idempotent
 *  — calling more than once is a no-op so the bootstrap can call it
 *  alongside `installCloudAgentAutoConnect` without worrying about
 *  duplicate effects. Returns a disposer that unwires the effect. */
export function installCloudAutoReplay(
  manager: CloudAgentManager,
  options?: { onError?: (err: Error) => void },
): () => void {
  if (autoReplayInstalled) {
    return () => {
      // shared subscription — last caller must not tear it down
    };
  }
  autoReplayInstalled = true;

  const onError =
    options?.onError ??
    ((err: Error) => {
      console.warn("[cloudAgent/queue] replay failed", err);
    });

  let prev: CloudAgentConnectionState | null = null;
  let disposed = false;

  createEffect(() => {
    const next = manager.state();
    const wasOpen = prev === "open";
    prev = next;
    if (wasOpen) return; // already-open transitions don't trigger replay
    if (next !== "open") return;
    if (entries().length === 0) return;
    if (disposed) return;
    void replayCloudQueue().catch((err: unknown) => {
      const e = err instanceof Error ? err : new Error(String(err));
      onError(e);
    });
  });

  return () => {
    disposed = true;
    autoReplayInstalled = false;
  };
}

/** Test-only: reset the auto-replay install guard so multiple test
 *  cases can each call [`installCloudAutoReplay`] from a fresh state. */
export function _resetCloudAutoReplayForTests(): void {
  autoReplayInstalled = false;
}
