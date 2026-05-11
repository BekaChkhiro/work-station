// T11.9 — bridge that wires the offline detector + write queue into the
// generic HTTP client. Kept in a separate module so the http client itself
// has zero compile-time dependency on `offline.ts` / `writeQueue.ts` —
// callers that don't need offline behavior (verifiers, the bare PlanFlow
// client used by Settings) pay nothing for it.
//
// Use this in place of `createIntegrationHttpClient` from per-tab integration
// modules in phases 13–17 (GitHub, Vercel, Neon, Railway, PlanFlow tab).

import {
  createIntegrationHttpClient,
  type IntegrationHttpClient,
  type IntegrationHttpClientOptions,
  type OfflineHooks,
} from "./httpClient";
import { isOffline, reportNetworkError, reportNetworkSuccess } from "./offline";
import { enqueueWrite } from "./writeQueue";

/** Build a client whose GETs fall back to stale cache on transport
 *  failure and whose non-GETs are queued for replay on reconnect. The
 *  returned instance is otherwise identical to one built via
 *  `createIntegrationHttpClient` — both `request` and `requestWithMeta`
 *  remain available, the latter exposes the offline branches. */
export function createOfflineAwareIntegrationClient(
  options: IntegrationHttpClientOptions,
): IntegrationHttpClient {
  const offline: OfflineHooks = {
    isOnline: () => !isOffline(options.service),
    reportError: () => reportNetworkError(options.service),
    reportSuccess: () => reportNetworkSuccess(options.service),
    enqueueWrite: (write) => enqueueWrite(write),
  };
  return createIntegrationHttpClient({ ...options, offline });
}
