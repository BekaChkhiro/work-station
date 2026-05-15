// T19.14 — typed wrapper around live system stats subscriptions.
//
// The desktop's embedded WebSocket server broadcasts `system_stats`
// frames every ~4 s to every authenticated client (T18.5). The mobile
// PWA consumes those frames directly (`mobile/src/routes/monitor.tsx`);
// the desktop frontend itself does not surface them today, but adding
// the wrapper now keeps the cloud-routing seam in place so a future
// desktop Monitor view picks the correct producer with a one-line
// subscribe call.
//
// Local mode: there is no Tauri-side `system_stats` IPC — the desktop
// is the producer for its own embedded WS server, not a consumer. The
// wrapper returns a no-op subscription so call sites can mount
// unconditionally and only update state once a frame arrives (which it
// won't, in local mode).
//
// Cloud mode: the cloud-agent runs the same monitor task and emits
// `system_stats` frames over its `/ws` endpoint. The wrapper attaches
// an `onSystemStats` listener to the active wsBridge client so the
// frames flow into the caller's handler without leaking the wsBridge
// type through the IPC surface.

import { awaitCloudClient } from "./transport";
import { cloudMode } from "../stores/cloudMode";
import type { SystemStatsSnapshot } from "../integrations/wsBridge";

export type SystemStatsHandler = (snapshot: SystemStatsSnapshot) => void;

export interface SystemStatsSubscription {
  /** Drop the handler. Idempotent — calling twice is safe. */
  unsubscribe: () => void;
}

/**
 * Subscribe to live host stats. Returns immediately with a
 * subscription whose `unsubscribe()` drops the handler.
 *
 * In local mode the subscription is a stub — there is no local IPC
 * channel producing `system_stats` for the desktop's own frontend, so
 * the handler is never invoked. In cloud mode the subscription
 * attaches to the cloud-agent's broadcast over the active wsBridge.
 */
export async function subscribeSystemStats(
  handler: SystemStatsHandler,
): Promise<SystemStatsSubscription> {
  if (!cloudMode()) {
    return {
      unsubscribe: () => {
        /* no-op: nothing was subscribed in local mode */
      },
    };
  }

  const client = await awaitCloudClient();
  let alive = true;
  let active: SystemStatsHandler | null = handler;

  const detach = client.onSystemStats((snapshot) => {
    if (!alive || !active) return;
    active(snapshot);
  });

  return {
    unsubscribe: () => {
      alive = false;
      active = null;
      detach();
    },
  };
}
