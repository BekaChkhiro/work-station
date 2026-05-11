// T11.9 — Offline write queue: thin TS wrapper around the Tauri
// `integration_queue_*` commands plus a FIFO replay loop.
//
// Design notes:
//   - The queue itself lives in Rust/SQLite (durable across crashes and
//     app restarts). This module is only the TS adapter + replay logic.
//   - Authorization headers are intentionally stripped at enqueue time
//     and re-resolved at replay time via `ReplayContext.getAuthToken()`.
//     Token rotation between enqueue and replay is common (hourly OAuth
//     cycles, Tauri keychain refresh), so stale Bearer values must never
//     be baked in.
//   - `replayQueue` is deliberately not recursive — it drains the current
//     snapshot once. `installAutoReplay` wires it into the offline →
//     online reconnect signal so it fires automatically on reconnect.

import { invoke } from "@tauri-apps/api/core";
import { showToast } from "../components/Toast";
import { onReconnect } from "./offline";

// -- Types (mirror the Rust contract) ----------------------------------------

export interface QueueEntry {
  id: number;
  service: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyBase64: string | null;
  enqueuedAt: number;
  attempts: number;
  lastError: string | null;
  lastAttemptAt: number | null;
}

export interface QueuedWrite {
  service: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  /** Headers WITHOUT the Authorization header — replay re-resolves the
   *  token via the registered auth resolver. */
  headers: Record<string, string>;
  /** Raw body bytes; will be base64-encoded for the wire. null if no body. */
  body: Uint8Array | null;
}

export interface ReplayContext {
  /** Re-resolve the auth token at replay time so token rotation between
   *  enqueue and replay doesn't replay a stale Authorization header. */
  getAuthToken(service: string): Promise<string | null>;
}

// -- Replay handler registry -------------------------------------------------

type ReplayHandler = (
  entry: QueueEntry,
  authHeader: string | null,
) => Promise<{ ok: boolean; status: number; body: string }>;

const replayHandlers = new Map<string, ReplayHandler>();

/** Register a per-service replay function. The replay loop calls this with a
 *  freshly resolved Authorization header value (or null) and expects a
 *  fetch-style `{ ok, status, body }` response object. */
export function registerReplayHandler(service: string, handler: ReplayHandler): void {
  replayHandlers.set(service, handler);
}

// -- Base64 encoding ---------------------------------------------------------

/** Encode bytes to base64. Using the classic fromCharCode approach — valid
 *  for the small-body payloads that flow through this queue (large uploads
 *  should use a direct upload path, not the write queue). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

// -- Public API --------------------------------------------------------------

/** Push a write operation into the durable queue. Strips the Authorization
 *  header (callers must not include it — it's re-resolved at replay time).
 *  Returns the assigned id and whether an older row was evicted to make
 *  space (cap is 50, enforced server-side). Fires a toast when eviction
 *  occurs so the user knows data was dropped. */
export async function enqueueWrite(write: QueuedWrite): Promise<{ id: number; evicted: boolean }> {
  // Strip auth header defensively — callers should not include it, but
  // we enforce the invariant here so a mis-wired caller can't bake a
  // stale token into the queue.
  const safeHeaders: Record<string, string> = {};
  for (const [key, value] of Object.entries(write.headers)) {
    if (key.toLowerCase() !== "authorization") {
      safeHeaders[key] = value;
    }
  }

  const bodyBase64 = write.body != null ? bytesToBase64(write.body) : null;

  const result = await invoke<{ id: number; evicted: boolean }>("integration_queue_enqueue", {
    args: {
      service: write.service,
      method: write.method,
      url: write.url,
      headers: safeHeaders,
      bodyBase64,
      enqueuedAt: Date.now(),
    },
  });

  if (result.evicted) {
    showToast({
      message: "Offline queue full — dropped oldest pending write",
      variant: "warning",
    });
  }

  return result;
}

/** List entries in the durable queue, optionally filtered to one service.
 *  Returned in FIFO order (oldest first). */
export async function listQueue(service?: string): Promise<QueueEntry[]> {
  return invoke<QueueEntry[]>("integration_queue_list", {
    args: { service },
  });
}

/** Remove all queued writes for `service`. Returns the count deleted. */
export async function clearServiceQueue(service: string): Promise<number> {
  return invoke<number>("integration_queue_clear_service", { args: { service } });
}

/** Drain the queue in FIFO order using registered replay handlers.
 *
 * Per-entry outcome rules:
 *   - 2xx (ok)        → dequeue. Counts toward the returned total.
 *   - 4xx non-401/403 → drop with a warning toast (permanent client error;
 *                        retrying would produce the same result). Mark failed
 *                        then dequeue.
 *   - 401 / 403       → leave in queue + warn. T11.8's reauth module owns
 *                        recovery; replaying a 401 with the same token is
 *                        pointless and would loop forever.
 *   - 5xx / transport → bump attempts via mark_failed, leave in queue, retry
 *                        on next reconnect.
 *
 * Returns the count of entries successfully drained this run. */
export async function replayQueue(context: ReplayContext): Promise<number> {
  const entries = await listQueue();
  let drained = 0;

  for (const entry of entries) {
    const handler = replayHandlers.get(entry.service);
    if (handler == null) {
      // No handler registered — skip silently. The entry stays in the queue
      // and will be retried when a handler is registered (or on next reconnect).
      continue;
    }

    const token = await context.getAuthToken(entry.service);
    const authHeader = token != null ? `Bearer ${token}` : null;

    let result: { ok: boolean; status: number; body: string };
    try {
      result = await handler(entry, authHeader);
    } catch (err) {
      // Transport-level failure (network down, timeout, etc.)
      const errorMsg = err instanceof Error ? err.message : String(err);
      await invoke<undefined>("integration_queue_mark_failed", {
        args: { id: entry.id, error: errorMsg, at: Date.now() },
      });
      continue;
    }

    if (result.ok) {
      await invoke<boolean>("integration_queue_dequeue", { args: { id: entry.id } });
      drained++;
      continue;
    }

    const status = result.status;

    if (status === 401 || status === 403) {
      // Auth failure — T11.8 owns recovery. Leave in queue, warn.
      showToast({
        message: `Queued write to ${entry.service} failed (${status}) — reconnect to retry`,
        variant: "warning",
      });
      continue;
    }

    if (status >= 400 && status < 500) {
      // Permanent client error — drop with warning.
      showToast({
        message: `Queued write to ${entry.service} dropped (${status} ${entry.url})`,
        variant: "warning",
      });
      await invoke<undefined>("integration_queue_mark_failed", {
        args: {
          id: entry.id,
          error: `HTTP ${status}: ${result.body.slice(0, 200)}`,
          at: Date.now(),
        },
      });
      await invoke<boolean>("integration_queue_dequeue", { args: { id: entry.id } });
      continue;
    }

    // 5xx or anything else unexpected — keep in queue for next attempt.
    await invoke<undefined>("integration_queue_mark_failed", {
      args: {
        id: entry.id,
        error: `HTTP ${status}: ${result.body.slice(0, 200)}`,
        at: Date.now(),
      },
    });
  }

  return drained;
}

// -- Auto-replay via offline signal ------------------------------------------

let autoReplayInstalled = false;

/** Hook the replay loop into the offline→online reconnect signal. When the
 *  overall network comes back online (or a per-service soft-offline clears),
 *  `replayQueue` is called automatically. Idempotent — safe to call from
 *  multiple roots. Returns a dispose fn that removes the subscription. */
export function installAutoReplay(context: ReplayContext): () => void {
  if (autoReplayInstalled) {
    return () => {
      // no-op — shared subscription; caller should not remove it
    };
  }
  autoReplayInstalled = true;

  const dispose = onReconnect(() => {
    // Fire-and-forget. Errors are handled inside replayQueue (they either
    // toast or silently skip) so we don't need to propagate here.
    replayQueue(context).catch((err: unknown) => {
      console.warn("[integrations/writeQueue] replayQueue error during auto-replay", err);
    });
  });

  return () => {
    dispose();
    autoReplayInstalled = false;
  };
}
