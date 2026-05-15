// T19.6 — IPC transport routing layer.
//
// Sits between the typed IPC wrappers (this folder) and their two
// possible backends:
//
//   • Local — Tauri `invoke` into the desktop's embedded backend (the
//     default; everything the app has shipped with up to Phase 18).
//   • Cloud — WebSocket RPC into a user-owned `cloud-agent` VPS
//     (Phase 19) via the [`WsBridgeClient`] reused from T18.8 and
//     wrapped by the cloud-mode manager from T19.7.
//
// The choice is driven by the app-wide [`cloudMode`] signal (T19.5).
// One toggle decides where every IPC call lands. Each IPC wrapper
// composes its local-vs-cloud impls via [`routeIpc`] / [`routedInvoke`]
// so call sites stay backend-agnostic.
//
// Why a routing layer (not branching inside every IPC wrapper):
// cloud-mode adds three concerns — `cloudMode` signal read, the
// agent's connection lifecycle, and the wsBridge handshake/awaiting —
// that have nothing to do with the per-call typed wrapper. Keeping
// them here means a wrapper's `cloud` branch is a one-liner that
// reads as "what does the cloud-agent call look like?" and nothing
// else.
//
// The cloud-agent manager (T19.7) is owned here as a lazy singleton.
// The bootstrap that ties it to the cloud-mode signal
// (`installCloudAgentAutoConnect`) reaches in via
// [`getCloudAgentManager`] so the same instance powers both the
// autoreconnect effect and the routing layer.

import { cloudMode } from "../stores/cloudMode";
import {
  createCloudAgentManager,
  type CloudAgentManager,
  type CloudAgentManagerOptions,
} from "../integrations/cloudAgent";
import type { WsBridgeClient } from "../integrations/wsBridge";

export type TransportKind = "local" | "cloud";

/// Default ceiling on how long a routed call waits for the cloud
/// client to become `open`. Picked to be longer than the wsBridge
/// reconnect's initial backoff (500 ms × jitter) so transient drops
/// don't surface as routing failures, but short enough that a
/// genuinely-offline VPS produces a fast, actionable error.
export const DEFAULT_CLOUD_WAIT_MS = 5_000;

/// How often [`awaitCloudClient`] re-checks the manager state while
/// waiting for `open`. Cheap polling — the manager doesn't expose a
/// state-change subscription that's safe to await on (its accessor is
/// a SolidJS signal, and the routing layer must work outside a
/// reactive root such as a Channel callback or an awaited test step).
const CLOUD_WAIT_POLL_MS = 25;

/**
 * Surfaced when a cloud-routed call is made but the agent isn't
 * reachable (cloud mode off, no URL/token, or connection never opens
 * within the configured timeout). The wrapper translates this into a
 * call-site-specific UX in higher layers (Settings toast,
 * disabled-feature affordance, …).
 */
export class CloudTransportUnavailableError extends Error {
  constructor(
    message: string,
    /** Why the routing layer gave up — useful for diagnostics. */
    public readonly reason:
      | "mode_off"
      | "unconfigured"
      | "no_token"
      | "timeout"
      | "closed"
      | "disposed",
  ) {
    super(message);
    this.name = "CloudTransportUnavailableError";
  }
}

/**
 * Hint that an operation has no cloud-agent counterpart yet. Lets a
 * caller (or its caller) decide whether to disable a feature in cloud
 * mode or fall back to local — the routing layer doesn't silently
 * swap because that would mask data-source confusion (local fs vs
 * remote fs, etc.).
 */
export class CloudTransportUnsupportedError extends Error {
  constructor(operation: string) {
    super(`IPC operation '${operation}' is not supported by the cloud-agent yet`);
    this.name = "CloudTransportUnsupportedError";
  }
}

export interface RouteOptions {
  /** Override the cloud-mode source (tests). Defaults to [`cloudMode`]. */
  mode?: () => boolean;
  /** Override how the cloud client is fetched (tests). Bypasses the
   *  manager singleton entirely when provided. */
  clientLoader?: () => Promise<WsBridgeClient>;
  /** Cap on how long [`awaitCloudClient`] polls before giving up.
   *  Defaults to [`DEFAULT_CLOUD_WAIT_MS`]. */
  timeoutMs?: number;
}

let managerSingleton: CloudAgentManager | null = null;
let managerFactory: (options?: CloudAgentManagerOptions) => CloudAgentManager =
  createCloudAgentManager;

/**
 * Returns the shared cloud-agent manager, creating it on first call.
 * The Tauri shell wires this same instance into
 * `installCloudAgentAutoConnect` so the routing layer and the
 * cloud-mode effect share state.
 */
export function getCloudAgentManager(): CloudAgentManager {
  if (!managerSingleton) {
    managerSingleton = managerFactory();
  }
  return managerSingleton;
}

/**
 * What does the next routed call resolve to? Pure read — does not
 * touch the manager. Mostly useful for telemetry and UI badges.
 */
export function currentTransport(): TransportKind {
  return cloudMode() ? "cloud" : "local";
}

/**
 * Resolve a connected cloud client, kicking [`connect`] if the
 * manager hasn't been started yet. Rejects with
 * [`CloudTransportUnavailableError`] when the manager settles in a
 * non-open verdict (`unconfigured`, `no_token`, `closed`) or when the
 * `open` state isn't reached before `timeoutMs`.
 *
 * Test seam: pass `manager` to supply a stub instead of the
 * singleton. The polling cadence is fixed at
 * [`CLOUD_WAIT_POLL_MS`].
 */
export async function awaitCloudClient(opts?: {
  manager?: CloudAgentManager;
  timeoutMs?: number;
  setTimeoutImpl?: (handler: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  nowFn?: () => number;
}): Promise<WsBridgeClient> {
  const manager = opts?.manager ?? getCloudAgentManager();
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_CLOUD_WAIT_MS;
  const now = opts?.nowFn ?? Date.now;
  const setTimeoutImpl =
    opts?.setTimeoutImpl ?? ((h, ms) => setTimeout(h, ms) as unknown as unknown);
  const clearTimeoutImpl =
    opts?.clearTimeoutImpl ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const settled = settledVerdict(manager);
  if (settled) throw settled;

  const existing = manager.client();
  if (existing && manager.state() === "open") return existing;

  // Trigger a dial if the manager is idle (e.g. tests, or pre-bootstrap
  // call). connect() is idempotent so calling on `connecting`/`open` is
  // a no-op.
  void manager.connect();

  return new Promise<WsBridgeClient>((resolve, reject) => {
    const started = now();
    let timer: unknown = null;

    const tick = (): void => {
      const client = manager.client();
      const state = manager.state();
      if (client && state === "open") {
        resolve(client);
        return;
      }
      const verdict = settledVerdict(manager);
      if (verdict) {
        reject(verdict);
        return;
      }
      if (now() - started >= timeoutMs) {
        reject(
          new CloudTransportUnavailableError(
            `cloud-agent did not open within ${timeoutMs}ms (state=${state})`,
            "timeout",
          ),
        );
        return;
      }
      timer = setTimeoutImpl(tick, CLOUD_WAIT_POLL_MS);
    };

    timer = setTimeoutImpl(tick, CLOUD_WAIT_POLL_MS);

    // No external cancellation — the timeout above bounds the wait.
    // The local `timer` reference exists so the scheduler doesn't GC
    // the interval shape under test runtimes that polyfill timers.
    void timer;
    void clearTimeoutImpl;
  });
}

/**
 * Route a call between the local Tauri backend and the remote
 * cloud-agent based on [`cloudMode`].
 *
 * The branches are evaluated lazily — the unused side never
 * constructs any resources. The cloud branch receives the connected
 * [`WsBridgeClient`] so callers don't need to know about the
 * manager.
 */
export async function routeIpc<T>(
  local: () => Promise<T>,
  cloud: (client: WsBridgeClient) => Promise<T>,
  opts?: RouteOptions,
): Promise<T> {
  const mode = opts?.mode ?? cloudMode;
  if (!mode()) return local();

  const client = opts?.clientLoader
    ? await opts.clientLoader()
    : await awaitCloudClient({ timeoutMs: opts?.timeoutMs });
  return cloud(client);
}

/**
 * Variant of [`routeIpc`] for ops the cloud-agent doesn't (yet)
 * support. In cloud mode the wrapper throws
 * [`CloudTransportUnsupportedError`] so the call site can render an
 * affordance rather than silently dialing the local backend.
 */
export async function routeIpcLocalOnly<T>(
  operation: string,
  local: () => Promise<T>,
  opts?: Pick<RouteOptions, "mode">,
): Promise<T> {
  const mode = opts?.mode ?? cloudMode;
  if (mode()) {
    throw new CloudTransportUnsupportedError(operation);
  }
  return local();
}

/**
 * Translate a non-open manager state into the appropriate
 * unavailable error, or return `null` if the manager is still in a
 * potentially-resolvable state (`idle`, `connecting`, `reconnecting`,
 * `open`).
 */
function settledVerdict(manager: CloudAgentManager): CloudTransportUnavailableError | null {
  const state = manager.state();
  switch (state) {
    case "disabled":
      return new CloudTransportUnavailableError(
        "cloud mode is disabled — cannot route to cloud-agent",
        "mode_off",
      );
    case "unconfigured":
      return new CloudTransportUnavailableError(
        "cloud-agent URL is not configured",
        "unconfigured",
      );
    case "no_token":
      return new CloudTransportUnavailableError(
        "cloud-agent pairing token is missing from the OS keychain",
        "no_token",
      );
    case "closed":
    case "closing":
      return new CloudTransportUnavailableError(`cloud-agent connection is ${state}`, "closed");
    case "idle":
    case "connecting":
    case "reconnecting":
    case "open":
      return null;
  }
}

/**
 * Test-only: replace the manager singleton (with a stub, typically).
 * The next [`getCloudAgentManager`] call returns the supplied
 * instance. Pass `null` to drop the override so the singleton
 * lazy-recreates on next access.
 */
export function _setCloudAgentManagerForTests(manager: CloudAgentManager | null): void {
  if (managerSingleton && managerSingleton !== manager) {
    try {
      managerSingleton.dispose();
    } catch {
      // Best-effort cleanup; a stub's dispose may throw.
    }
  }
  managerSingleton = manager;
}

/**
 * Test-only: swap the factory used when [`getCloudAgentManager`]
 * lazy-creates an instance. Restoring is done with
 * [`_resetCloudAgentManagerFactoryForTests`].
 */
export function _setCloudAgentManagerFactoryForTests(
  factory: (options?: CloudAgentManagerOptions) => CloudAgentManager,
): void {
  managerFactory = factory;
}

export function _resetCloudAgentManagerFactoryForTests(): void {
  managerFactory = createCloudAgentManager;
}
