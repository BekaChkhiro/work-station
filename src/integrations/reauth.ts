// T11.8 — Token expiry / re-auth flow.
//
// Long-running integration calls (PlanFlow polling, GitHub repo reads, etc.)
// can race a token revocation: the server starts returning 401/403 even
// though the keychain still has a (now-stale) token. This module is the
// single point where that signal lands.
//
// Three responsibilities:
//   1. Track which integrations are currently in `needs_reauth` (reactive
//      Solid signal so the banner + Settings UI react automatically).
//   2. Persist the flag to the `integration_status` row so the banner
//      survives a restart (you don't want users to lose context after
//      reopening the app).
//   3. Hold an in-flight retry queue per integration. When a request
//      fires while the integration is unauthenticated — or itself
//      triggers the reauth — its promise stays pending; the next
//      successful Verify drains the queue and the awaiters see the
//      result of the retried call.
//
// Note on scope: Verify clients (see verifiers/index.ts) intentionally
// do NOT route through this module. A bad token entered into the
// Settings panel should produce a one-shot "invalid credentials" toast,
// not flip the whole integration into the reauth banner.

import { createSignal, type Accessor } from "solid-js";

import { IntegrationHttpError } from "./httpClient";
import { PlanFlowAuthError } from "./planflow/errors";
import {
  clearIntegrationNeedsReauthFlag,
  getIntegrationStatusMap,
  markIntegrationNeedsReauth,
} from "./status";
import type { IntegrationId } from "./credentials";

interface QueuedCall<T = unknown> {
  run: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

const [needsReauthMap, setNeedsReauthMap] = createSignal<Record<string, boolean>>({});
const queues = new Map<string, QueuedCall[]>();
const inFlight = new Map<string, Promise<void>>();
let hydrated = false;
let hydrationPromise: Promise<void> | null = null;

export interface ReauthSnapshot {
  readonly map: Accessor<Record<string, boolean>>;
}

export function reauthSnapshot(): ReauthSnapshot {
  return { map: needsReauthMap };
}

/** Sync check — true once the in-memory map has the flag set. Returns
 *  false until hydration completes for an integration whose flag only
 *  exists in SQLite; callers that need the persisted value should await
 *  `hydrateReauthState()` first (the SettingsPanel does this on mount). */
export function isNeedsReauth(integration: IntegrationId | string): boolean {
  return needsReauthMap()[integration] === true;
}

export async function hydrateReauthState(): Promise<void> {
  if (hydrated) return;
  if (hydrationPromise) {
    await hydrationPromise;
    return;
  }
  hydrationPromise = (async (): Promise<void> => {
    try {
      const map = await getIntegrationStatusMap();
      const next: Record<string, boolean> = {};
      for (const [id, entry] of Object.entries(map)) {
        if (entry.needsReauthAt != null) next[id] = true;
      }
      setNeedsReauthMap(next);
      hydrated = true;
    } finally {
      hydrationPromise = null;
    }
  })();
  await hydrationPromise;
}

/** Mark `integration` as needing reauth and persist the timestamp. Safe
 *  to call repeatedly — duplicate calls coalesce so a burst of failing
 *  requests only writes once. */
export async function markNeedsReauth(integration: IntegrationId | string): Promise<void> {
  if (needsReauthMap()[integration]) return;
  setNeedsReauthMap({ ...needsReauthMap(), [integration]: true });
  try {
    await markIntegrationNeedsReauth(integration);
  } catch (err) {
    console.warn("[integrations/reauth] failed to persist needs_reauth flag", integration, err);
  }
}

/** Clear the reauth flag, persist the change, then drain any queued
 *  retries. Invoked from the Settings panel after a successful Verify. */
export async function clearNeedsReauthAndReplay(
  integration: IntegrationId | string,
): Promise<void> {
  const wasSet = needsReauthMap()[integration] === true;
  if (wasSet) {
    const next = Object.fromEntries(
      Object.entries(needsReauthMap()).filter(([key]) => key !== integration),
    );
    setNeedsReauthMap(next);
  }
  try {
    await clearIntegrationNeedsReauthFlag(integration);
  } catch (err) {
    console.warn("[integrations/reauth] failed to clear needs_reauth flag", integration, err);
  }
  await drainQueue(integration);
}

/** Wrap an integration HTTP call so 401/403 is converted into a queued
 *  retry. Behaviour:
 *    - If the integration is currently flagged needs-reauth, the call
 *      is queued immediately (no network round-trip).
 *    - Otherwise the call runs; if it throws an auth error, the
 *      integration is flagged and the call is queued.
 *    - The returned promise resolves with the result of the eventually
 *      replayed call (or rejects if the user disconnects instead).
 *
 *  Non-auth errors are not queued — they propagate normally so the
 *  caller's existing error UI keeps working. */
export async function runWithReauthGuard<T>(
  integration: IntegrationId | string,
  fn: () => Promise<T>,
): Promise<T> {
  if (isNeedsReauth(integration)) {
    return enqueueForReplay(integration, fn);
  }
  try {
    return await fn();
  } catch (error) {
    if (isAuthFailure(error)) {
      await markNeedsReauth(integration);
      return enqueueForReplay(integration, fn);
    }
    throw error;
  }
}

/** Cancel every queued retry for an integration — e.g. when the user
 *  hits Disconnect instead of Reconnect. Awaiters see a `ReauthCancelled`
 *  rejection so they can surface a friendlier message. */
export function cancelQueuedForReauth(integration: IntegrationId | string): void {
  const queue = queues.get(integration);
  if (!queue || queue.length === 0) return;
  queues.set(integration, []);
  for (const call of queue) {
    call.reject(new ReauthCancelledError(integration));
  }
}

export class ReauthCancelledError extends Error {
  readonly integration: string;
  constructor(integration: string) {
    super(`Queued request for "${integration}" was cancelled before re-authentication.`);
    this.name = "ReauthCancelledError";
    this.integration = integration;
  }
}

function enqueueForReplay<T>(
  integration: IntegrationId | string,
  fn: () => Promise<T>,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const queue = queues.get(integration) ?? [];
    queue.push({
      run: fn,
      resolve: resolve as (value: unknown) => void,
      reject,
    });
    queues.set(integration, queue);
  });
}

async function drainQueue(integration: IntegrationId | string): Promise<void> {
  const existing = inFlight.get(integration);
  if (existing != null) {
    await existing;
    return;
  }
  const queue = queues.get(integration);
  if (!queue || queue.length === 0) return;
  queues.set(integration, []);
  const work = (async (): Promise<void> => {
    for (const call of queue) {
      try {
        const value = await call.run();
        call.resolve(value);
      } catch (error) {
        if (isAuthFailure(error)) {
          // The fresh token still failed — flip the flag back on, push
          // this call (and the rest) back into the queue, and bail.
          await markNeedsReauth(integration);
          const remaining = queue.slice(queue.indexOf(call));
          queues.set(integration, [...remaining, ...(queues.get(integration) ?? [])]);
          return;
        }
        call.reject(error);
      }
    }
  })().finally(() => {
    inFlight.delete(integration);
  });
  inFlight.set(integration, work);
  await work;
}

function isAuthFailure(error: unknown): boolean {
  if (error instanceof PlanFlowAuthError) return true;
  if (error instanceof IntegrationHttpError) {
    return error.status === 401 || error.status === 403;
  }
  return false;
}
