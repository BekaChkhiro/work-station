// T11.9 — Offline mode detection + per-service "soft offline" tracking.
//
// Two layers of offline state:
//   1. `overall` — mirrors navigator.onLine / window online|offline events.
//      True by default (or when the API is unavailable, e.g. in tests).
//   2. `perService` — per-integration soft-offline flag. Flips a service
//      to "offline" after 3 consecutive reportNetworkError() calls without
//      an intervening reportNetworkSuccess() call.
//
// Why 3 consecutive errors for the soft-offline threshold?
// The httpClient (httpClient.ts) already retries 5xx responses up to 3 times
// with backoff before propagating the error. So a *single* reportNetworkError
// call means 3 transport-level retries have already failed. Three consecutive
// `reportNetworkError` signals therefore mean 9 underlying network failures —
// enough evidence that the service is genuinely unreachable rather than just
// transiently slow. Keeping the threshold low (not 5 or 10) ensures the UI
// surfaces the problem while there's still something useful the user can do
// (e.g. reconnect, check their VPN). Resetting on any success keeps false
// positives brief.

import { createSignal, type Accessor } from "solid-js";

export type ServiceState = "online" | "offline";

export interface OfflineSnapshot {
  readonly overall: Accessor<ServiceState>;
  readonly perService: Accessor<Record<string, ServiceState>>;
}

// -- Module-level signals (singleton) ----------------------------------------

const [overall, setOverall] = createSignal<ServiceState>(
  typeof navigator !== "undefined" && navigator.onLine === false ? "offline" : "online",
);
const [perService, setPerService] = createSignal<Record<string, ServiceState>>({});

// Consecutive-error counters per service. Not a signal — no need to
// reactively read raw counts; only the derived ServiceState matters.
const errorCounts = new Map<string, number>();

// Reconnect listeners — fire when overall or a per-service state transitions
// from offline → online.
type ReconnectHandler = (service?: string) => void;
const reconnectHandlers = new Set<ReconnectHandler>();

// Guard so installOfflineListeners() is idempotent.
let listenersInstalled = false;

// -- Public surface -----------------------------------------------------------

/** Returns reactive Accessors for the overall and per-service offline state.
 *  Multiple calls return the same singleton signals — safe to call from
 *  multiple component roots. */
export function offlineSnapshot(): OfflineSnapshot {
  return { overall, perService };
}

/** Synchronous snapshot — true when the service (or overall network) is
 *  currently considered offline. */
export function isOffline(service?: string): boolean {
  if (overall() === "offline") return true;
  if (service == null) return false;
  return perService()[service] === "offline";
}

/** Called by integration HTTP adapters when a request fails with a network
 *  or transport error. After 3 consecutive failures the service is marked
 *  soft-offline and all onReconnect handlers for that service are eligible
 *  to fire on the next success. */
export function reportNetworkError(service: string): void {
  const count = (errorCounts.get(service) ?? 0) + 1;
  errorCounts.set(service, count);

  const THRESHOLD = 3; // see module-level comment for rationale
  if (count >= THRESHOLD && perService()[service] !== "offline") {
    setPerService({ ...perService(), [service]: "offline" });
  }
}

/** Called by integration HTTP adapters when a request succeeds. Resets
 *  the consecutive-error counter and, if the service was soft-offline,
 *  flips it back to online and fires reconnect listeners. */
export function reportNetworkSuccess(service: string): void {
  const wasOffline = perService()[service] === "offline";
  errorCounts.set(service, 0);

  if (wasOffline) {
    const next = Object.fromEntries(
      Object.entries(perService()).filter(([key]) => key !== service),
    );
    setPerService(next);
    fireReconnect(service);
  }
}

/** Subscribe to reconnect events. The handler is called with `service` when
 *  a specific service transitions from soft-offline → online, or with no
 *  argument when the overall network comes back online (which also resets
 *  all per-service states). Returns a dispose function — call it to
 *  unsubscribe (e.g. from onCleanup). */
export function onReconnect(handler: ReconnectHandler): () => void {
  reconnectHandlers.add(handler);
  return () => {
    reconnectHandlers.delete(handler);
  };
}

/** Attach window `online` / `offline` event listeners. Safe to call from
 *  multiple component roots — only installs once. Returns a dispose fn
 *  (removes the listeners and resets the installed flag) for use in tests. */
export function installOfflineListeners(): () => void {
  if (listenersInstalled) {
    // Already installed — return a no-op dispose so callers always get a
    // dispose function back.
    return () => {
      // intentional no-op: listeners are shared; the last caller must not
      // remove them unexpectedly.
    };
  }

  listenersInstalled = true;

  const onOnline = (): void => {
    if (overall() === "offline") {
      // Reset all per-service states first so listeners see a clean slate.
      setPerService({});
      errorCounts.clear();
      setOverall("online");
      fireReconnect(undefined); // no service arg = overall reconnect
    }
  };

  const onOffline = (): void => {
    setOverall("offline");
  };

  window.addEventListener("online", onOnline);
  window.addEventListener("offline", onOffline);

  return () => {
    window.removeEventListener("online", onOnline);
    window.removeEventListener("offline", onOffline);
    listenersInstalled = false;
  };
}

// -- Private helpers ----------------------------------------------------------

function fireReconnect(service: string | undefined): void {
  for (const handler of reconnectHandlers) {
    try {
      handler(service);
    } catch (err) {
      console.warn("[integrations/offline] onReconnect handler threw", err);
    }
  }
}
