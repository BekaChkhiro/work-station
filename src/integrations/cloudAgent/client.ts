// T19.7 — Cloud-agent WebSocket RPC client (desktop → cloud-agent).
//
// Cloud-mode counterpart to the embedded wsBridge client (T18.8). When
// `cloud_mode` is on, the desktop sources its workspace data from a
// user-owned VPS running `cloud-agent` (T19.2) over a Cloudflare
// Tunnel instead of the local axum server. This module owns the
// remote connection's lifecycle:
//
//   - Builds a `WsBridgeClient` configured from `cloud_agent_url` and
//     the pairing token stored in the OS keychain
//     (`Integration.CloudAgent`).
//   - Exposes a manual `connect()` / `disconnect()` surface plus an
//     optional `installCloudAgentAutoConnect()` helper that ties the
//     lifecycle to the `cloudMode` signal (off → close, on → connect).
//   - Stamps `cloud_agent_status.lastHandshakeAt` on every successful
//     open; flips `needsRepairAt` when the agent rejects the handshake.
//
// Why a manager (not just `new WsBridgeClient(...)` at each call site):
// the desktop's connection is bound to an app-wide signal, not a
// component tree, and the same connection has to feed every cloud-mode
// consumer (terminals, PlanFlow bridge, project list). One singleton
// keeps the URL/token reads, the status mutations, and the auto-mode
// glue in a single place that tests can drive deterministically.

import { createEffect, createSignal, on, type Accessor } from "solid-js";

import { DEFAULT_ACCOUNT, getCredential, Integration } from "../credentials";
import { WsBridgeClient, type ConnectionState, type ReconnectOptions } from "../wsBridge";
import {
  cloudAgentStatus,
  cloudAgentUrl,
  cloudMode,
  setCloudAgentStatus,
  type CloudAgentStatus,
} from "../../stores/cloudMode";

/// Suffix appended to `cloud_agent_url` when dialing. The cloud-agent's
/// axum router will serve the bridge under the same path the embedded
/// server uses (T18.1) so the protocol layer stays identical.
export const CLOUD_AGENT_WS_PATH = "/ws";

/// Custom WebSocket close code the cloud-agent uses to signal "this
/// pairing token is no longer valid". Mirrors the conventional 4xxx
/// reserved range for application-defined codes; matched on the client
/// to flip `needsRepairAt` without depending on close-reason prose.
export const CLOUD_AGENT_AUTH_FAILED_CODE = 4401;

/// Heuristic: any close that arrives within this many milliseconds of
/// the upgrade succeeding is treated as an auth-shaped failure. The
/// agent terminates the upgrade with HTTP 401 (browsers swallow the
/// status), so a near-immediate close without a server hello is the
/// only signal a browser client can observe in that path.
const HANDSHAKE_GRACE_MS = 2_000;

/// Aggregate state: the embedded bridge's [`ConnectionState`] plus
/// extra cloud-only verdicts so consumers can render an explicit
/// "disabled" or "unconfigured" UI without inspecting the URL/token
/// themselves.
export type CloudAgentConnectionState = ConnectionState | "disabled" | "unconfigured" | "no_token";

export type CloudAgentStatusPatch = Partial<NonNullable<CloudAgentStatus>>;

type TimerHandle = unknown;
type SetTimeoutImpl = (handler: () => void, ms: number) => TimerHandle;
type ClearTimeoutImpl = (handle: TimerHandle) => void;

export interface CloudAgentManagerOptions {
  /** Override the cloud-mode signal. Defaults to the global [`cloudMode`]. */
  modeSource?: Accessor<boolean>;
  /** Override the URL signal. Defaults to the global [`cloudAgentUrl`]. */
  urlSource?: Accessor<string | null>;
  /** Override the current status accessor (used when patching). */
  statusSource?: Accessor<CloudAgentStatus>;
  /** How to fetch the pairing token. Defaults to the OS keychain. */
  tokenLoader?: () => Promise<string | null>;
  /** How to persist a status patch. Defaults to [`setCloudAgentStatus`]. */
  statusSink?: (next: CloudAgentStatus) => Promise<void>;

  /** Override `Date.now()` for deterministic status timestamps. */
  now?: () => number;
  /** Override the reconnect schedule used by the underlying bridge. */
  reconnect?: ReconnectOptions;

  // Forwarded to the underlying WsBridgeClient.
  webSocketImpl?: typeof WebSocket;
  setTimeoutImpl?: SetTimeoutImpl;
  clearTimeoutImpl?: ClearTimeoutImpl;
  randomFn?: () => number;

  /** Surface unexpected errors (token load, status persist). Defaults to
   *  `console.warn`. Test seam — production code can pass a richer logger. */
  onError?: (err: Error, context: string) => void;
}

export interface CloudAgentManager {
  /** Aggregate connection state — reactive. */
  state: Accessor<CloudAgentConnectionState>;
  /** Underlying bridge client when connected; `null` otherwise. */
  client: Accessor<WsBridgeClient | null>;
  /** Resolved URL the manager is currently dialing (after path suffix). */
  endpoint: Accessor<string | null>;
  /**
   * Open a new connection. Idempotent — calling while already
   * `connecting`/`open` is a no-op. Returns once the dial has been
   * initiated (or after a token load failure).
   */
  connect: () => Promise<void>;
  /** Close the active connection. Idempotent. */
  disconnect: () => void;
  /** Release internal listeners. Closes any open socket. */
  dispose: () => void;
}

export function createCloudAgentManager(options: CloudAgentManagerOptions = {}): CloudAgentManager {
  const modeSource = options.modeSource ?? cloudMode;
  const urlSource = options.urlSource ?? cloudAgentUrl;
  const statusSource = options.statusSource ?? cloudAgentStatus;
  const tokenLoader =
    options.tokenLoader ?? (() => getCredential(Integration.CloudAgent, DEFAULT_ACCOUNT));
  const statusSink = options.statusSink ?? setCloudAgentStatus;
  const now = options.now ?? (() => Date.now());
  const onError =
    options.onError ??
    ((err, context) => {
      console.warn(`[cloudAgent] ${context}`, err);
    });

  const [state, setState] = createSignal<CloudAgentConnectionState>("disabled");
  const [client, setClient] = createSignal<WsBridgeClient | null>(null);
  const [endpoint, setEndpoint] = createSignal<string | null>(null);

  let openedAt: number | null = null;
  let disposed = false;
  // Monotonic generation so a stale async tokenLoader resolution from a
  // previous connect() can't clobber the current attempt.
  let generation = 0;

  function updateStatus(patch: CloudAgentStatusPatch): void {
    const current = statusSource();
    const base: NonNullable<CloudAgentStatus> = current ?? { pairedAt: now() };
    const next: NonNullable<CloudAgentStatus> = { ...base, ...patch };
    void statusSink(next).catch((err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      onError(e, "status persist failed");
    });
  }

  function disconnectInternal(): void {
    const existing = client();
    if (existing) {
      try {
        existing.close();
      } catch (err) {
        const e = err instanceof Error ? err : new Error(String(err));
        onError(e, "close failed");
      }
    }
    setClient(null);
    setEndpoint(null);
    openedAt = null;
  }

  function buildEndpoint(rawUrl: string): string {
    // Allow callers to pass either the bare origin (`wss://agent.example`)
    // or the fully-qualified bridge path. Trim a trailing slash so we
    // don't double-up before the suffix.
    const trimmed = rawUrl.replace(/\/+$/, "");
    if (trimmed.endsWith(CLOUD_AGENT_WS_PATH)) return trimmed;
    return `${trimmed}${CLOUD_AGENT_WS_PATH}`;
  }

  async function connect(): Promise<void> {
    if (disposed) return;
    if (!modeSource()) {
      setState("disabled");
      disconnectInternal();
      return;
    }
    const rawUrl = urlSource();
    if (!rawUrl) {
      setState("unconfigured");
      disconnectInternal();
      return;
    }
    if (client()) {
      // Already connecting / open — nothing to do.
      return;
    }

    const myGen = ++generation;
    setState("connecting");
    let token: string | null;
    try {
      token = await tokenLoader();
    } catch (err) {
      if (myGen !== generation || disposed) return;
      const e = err instanceof Error ? err : new Error(String(err));
      onError(e, "pairing token load failed");
      setState("no_token");
      return;
    }
    if (myGen !== generation || disposed) return;
    if (!token) {
      setState("no_token");
      return;
    }

    const url = buildEndpoint(rawUrl);
    setEndpoint(url);
    openedAt = null;

    const bridge = new WsBridgeClient({
      url,
      token,
      autoReconnect: true,
      reconnect: options.reconnect,
      webSocketImpl: options.webSocketImpl,
      setTimeoutImpl: options.setTimeoutImpl,
      clearTimeoutImpl: options.clearTimeoutImpl,
      randomFn: options.randomFn,
      onStateChange: (next) => {
        // Once the manager owns the bridge, mirror its state verbatim.
        // The aggregate "disabled" / "unconfigured" / "no_token"
        // verdicts only apply when we don't have a live bridge.
        if (client() === bridge) setState(next);
      },
      onOpen: () => {
        const ts = now();
        openedAt = ts;
        updateStatus({ lastHandshakeAt: ts, needsRepairAt: null });
      },
      onClose: ({ code, reason }) => {
        if (looksLikeAuthFailure(code, reason, openedAt, now())) {
          updateStatus({ needsRepairAt: now() });
        }
        openedAt = null;
      },
      onError: (err) => onError(err, "bridge error"),
    });

    setClient(bridge);
    try {
      bridge.connect();
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      onError(e, "bridge connect failed");
      disconnectInternal();
    }
  }

  function disconnect(): void {
    generation++;
    disconnectInternal();
    setState(modeSource() ? (urlSource() ? "closed" : "unconfigured") : "disabled");
  }

  function dispose(): void {
    disposed = true;
    disconnectInternal();
  }

  // Seed the initial verdict so first read is meaningful even before a
  // consumer triggers connect().
  if (!modeSource()) setState("disabled");
  else if (!urlSource()) setState("unconfigured");
  else setState("idle");

  return { state, client, endpoint, connect, disconnect, dispose };
}

/**
 * Tie the manager's lifecycle to the cloud-mode signal: connect when
 * the toggle flips on (and a URL exists), disconnect when it flips off.
 * Returns a disposer that unwires the effect.
 *
 * Call from the Tauri shell's bootstrap (alongside `hydrateCloudMode`).
 * Tests skip this and drive `connect()` / `disconnect()` directly so
 * SolidJS's reactivity doesn't have to be active.
 */
export function installCloudAgentAutoConnect(
  manager: CloudAgentManager,
  sources?: { modeSource?: Accessor<boolean>; urlSource?: Accessor<string | null> },
): () => void {
  const modeSource = sources?.modeSource ?? cloudMode;
  const urlSource = sources?.urlSource ?? cloudAgentUrl;
  let disposed = false;

  createEffect(
    on([modeSource, urlSource], ([on_, url]) => {
      if (disposed) return;
      if (!on_) {
        manager.disconnect();
        return;
      }
      if (!url) {
        // Drop any stale connection — the manager will publish the
        // `unconfigured` verdict so the Settings UI can prompt the user.
        manager.disconnect();
        return;
      }
      void manager.connect();
    }),
  );

  return () => {
    disposed = true;
    manager.dispose();
  };
}

function looksLikeAuthFailure(
  code: number,
  reason: string,
  openedAt: number | null,
  closedAt: number,
): boolean {
  if (code === CLOUD_AGENT_AUTH_FAILED_CODE) return true;
  if (/unauth|invalid token|forbidden/i.test(reason)) return true;
  // HTTP 401 during upgrade is invisible to the browser WebSocket; if
  // the socket closed before — or just barely after — a server hello,
  // assume the handshake was rejected.
  if (openedAt == null) return true;
  return closedAt - openedAt <= HANDSHAKE_GRACE_MS;
}
