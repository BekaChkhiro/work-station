// T4.4: typed wrappers for the PTY IPC surface.
// T19.6: every call routes through [`routeIpc`] so cloud mode lands on
// the remote cloud-agent's wsBridge (T19.7) instead of the local
// Tauri backend.
//
// `pty_subscribe` is backed by a `tauri::ipc::Channel<InvokeResponseBody>` on
// the Rust side that pushes raw frames as `InvokeResponseBody::Raw(Vec<u8>)`.
// On the JS side those arrive as `ArrayBuffer` payloads delivered to the
// Channel's `onmessage` callback. The wrapper exposes a tiny callback API and
// returns a disposer so call sites don't have to know about the Channel
// plumbing or the cleanup contract. In cloud mode the same shape is fed by
// `pty_output` JSON frames from the WebSocket bridge instead.
//
// Subscriptions are short-circuited when the Tauri runtime is unavailable
// (vite preview, isolated component harnesses) so consumers can mount the
// Terminal component without a real backend behind it. Cloud-mode is always
// available regardless of Tauri so the same harness paths can dial a real
// agent for live-component previews.

import { Channel, invoke } from "@tauri-apps/api/core";

import { awaitCloudClient, routeIpc } from "./transport";
import { cloudMode } from "../stores/cloudMode";

const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface PtySpawnArgs {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /**
   * T4.14 — commands written to the freshly-spawned shell after subscribers
   * are attached. Each entry is treated like user input (terminating `\n`
   * appended on the Rust side); empty/whitespace lines are skipped.
   */
  startupCommands?: string[];
  cols: number;
  rows: number;
}

export interface PtySpawnResponse {
  sessionId: string;
}

export async function ptySpawn(args: PtySpawnArgs): Promise<PtySpawnResponse> {
  return routeIpc(
    () => invoke<PtySpawnResponse>("pty_spawn", { args }),
    async (client) => {
      // The cloud-agent does not yet honour `startupCommands` (it
      // proxies through the wsBridge protocol, T18.x); skipping
      // silently would lose user intent, so we replay them as
      // sequential writes after spawn completes — matching what the
      // local backend does internally.
      const reply = await client.ptySpawn({
        command: args.command,
        args: args.args,
        cwd: args.cwd,
        env: args.env,
        cols: args.cols,
        rows: args.rows,
      });
      if (args.startupCommands && args.startupCommands.length > 0) {
        for (const line of args.startupCommands) {
          if (!line || /^\s*$/.test(line)) continue;
          await client.ptyWrite(reply.sessionId, `${line}\n`);
        }
      }
      return { sessionId: reply.sessionId };
    },
  );
}

export interface PtyWriteArgs {
  sessionId: string;
  data: Uint8Array;
}

/**
 * Send raw bytes to a PTY's stdin. Tauri's JSON transport carries the bytes
 * as a number array, which Rust deserializes into `Vec<u8>` for
 * `pty_write`'s `WriteArgs::data` field. Cloud mode forwards the bytes as
 * base64 over wsBridge instead.
 *
 * No-op when the local backend is unavailable in local mode (vite preview,
 * isolated harnesses). Cloud mode always attempts the remote write.
 */
export async function ptyWrite(sessionId: string, data: Uint8Array): Promise<void> {
  if (data.byteLength === 0) return;
  return routeIpc(
    async () => {
      if (!isTauriRuntime()) return;
      await invoke("pty_write", {
        args: { sessionId, data: Array.from(data) },
      });
    },
    async (client) => {
      await client.ptyWrite(sessionId, data);
    },
  );
}

/**
 * Best-effort graceful shutdown of a PTY session: SIGTERM (or close-stdin
 * on Windows), wait briefly, then SIGKILL if still alive. Safe to call
 * outside the local Tauri runtime — it short-circuits there.
 */
export async function ptyKill(sessionId: string): Promise<void> {
  return routeIpc(
    async () => {
      if (!isTauriRuntime()) return;
      await invoke("pty_kill", { args: { sessionId } });
    },
    async (client) => {
      await client.ptyKill(sessionId);
    },
  );
}

export interface PtyResizeArgs {
  sessionId: string;
  cols: number;
  rows: number;
}

/**
 * Inform the backend that the PTY's window dimensions changed so the child
 * process receives SIGWINCH and re-renders to the new viewport.
 *
 * No-op outside the Tauri runtime in local mode so the Terminal component's
 * resize observer can fire unconditionally in vite preview / stress
 * harnesses. Cloud mode always issues the resize over wsBridge.
 */
/** Cloud-only: ask the cloud-agent for its live PTY registry. Returns
 *  an empty list in local mode (the desktop's Tauri PTY layer has no
 *  metadata sidecar today, so reattach UI is a cloud-mode-only flow). */
export async function ptyListCloud(
  projectId?: string | null,
): Promise<import("../integrations/wsBridge/client").WsBridgePtySession[]> {
  return routeIpc(
    async () => [],
    async (client) => client.ptyList(projectId),
  );
}

export async function ptyResize(sessionId: string, cols: number, rows: number): Promise<void> {
  return routeIpc(
    async () => {
      if (!isTauriRuntime()) return;
      await invoke("pty_resize", {
        args: { sessionId, cols, rows },
      });
    },
    async (client) => {
      await client.ptyResize(sessionId, cols, rows);
    },
  );
}

export interface PtyScrollbackSnapshot {
  /** Snapshot bytes [0, totalBytes) at read time. Empty when the session has
   *  produced no output yet, or when called outside the Tauri runtime. */
  data: Uint8Array;
  /** Size of the scrollback at read time — the full snapshot length. */
  totalBytes: number;
}

interface RawScrollbackResponse {
  data: number[];
  totalBytes: number;
  nextOffset: number;
}

/**
 * Read the full scrollback snapshot for `sessionId`. Used at mount / tab
 * switch to replay prior session output before attaching a live subscription
 * (T4.7). Returns an empty snapshot in non-Tauri contexts so callers don't
 * have to branch.
 *
 * The single-shot full read avoids the pagination's "racing the live writer"
 * caveat documented on `pty_get_scrollback` — for stable replay we want one
 * consistent view, not a tail of a mutating buffer. Cloud mode requests
 * `offset=0, limit=MAX_SAFE_INTEGER` from the cloud-agent for the same
 * single-shot semantics.
 */
export async function ptyGetScrollback(sessionId: string): Promise<PtyScrollbackSnapshot> {
  return routeIpc(
    async () => {
      if (!isTauriRuntime()) {
        return { data: new Uint8Array(), totalBytes: 0 };
      }
      const raw = await invoke<RawScrollbackResponse>("pty_get_scrollback", {
        args: { sessionId, offsetBytes: 0, limitBytes: Number.MAX_SAFE_INTEGER },
      });
      return {
        data: Uint8Array.from(raw.data),
        totalBytes: raw.totalBytes,
      };
    },
    async (client) => {
      const chunk = await client.ptyScrollback(sessionId, 0, Number.MAX_SAFE_INTEGER);
      return { data: chunk.data, totalBytes: chunk.totalBytes };
    },
  );
}

export type PtyChunkHandler = (chunk: Uint8Array) => void;

export interface PtySubscription {
  /** Stop forwarding frames to the handler. The backend forwarder also
   *  exits the next time it tries to send (channel send fails). */
  unsubscribe: () => void;
}

// Used to detach a Channel from its original closure on unsubscribe so the
// terminal becomes GC-eligible without waiting for the backend forwarder to
// fail. Argument is intentionally accepted but discarded.
const noopChannelHandler = (): void => undefined;

const toUint8Array = (payload: unknown): Uint8Array | null => {
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (payload instanceof Uint8Array) return payload;
  // Tauri 2 also delivers ArrayBuffer-shaped views in some configurations;
  // fall back to a Uint8Array view when the payload looks byte-buffer-ish.
  if (
    payload !== null &&
    typeof payload === "object" &&
    "byteLength" in (payload as object) &&
    "buffer" in (payload as object)
  ) {
    const view = payload as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
};

/**
 * Subscribe to raw PTY output for `sessionId`.
 *
 * The handler is invoked once per backend frame with a fresh `Uint8Array`
 * view. Call `unsubscribe()` to drop the handler. Local mode uses a
 * Tauri Channel; the spawned forwarder on the Rust side exits naturally
 * when the channel is no longer reachable. Cloud mode attaches an
 * `onPtyOutput` listener on the active wsBridge client and issues
 * `pty_subscribe` over the WebSocket.
 *
 * Note on transport stability: a session lives on whichever backend
 * spawned it; flipping `cloudMode` mid-session does not migrate
 * subscriptions, since the session itself is not portable across
 * backends. Future spawns land on the new transport.
 */
export async function ptySubscribe(
  sessionId: string,
  onChunk: PtyChunkHandler,
): Promise<PtySubscription> {
  if (cloudMode()) {
    return cloudPtySubscribe(sessionId, onChunk);
  }
  return localPtySubscribe(sessionId, onChunk);
}

async function localPtySubscribe(
  sessionId: string,
  onChunk: PtyChunkHandler,
): Promise<PtySubscription> {
  if (!isTauriRuntime()) {
    return {
      unsubscribe: () => {
        /* no-op: nothing was subscribed in non-Tauri contexts */
      },
    };
  }

  let active = true;
  // Boxed handler reference so unsubscribe can null it out and let the
  // user's `onChunk` (and everything it closes over — xterm instance, the
  // streaming TextDecoder, etc.) become GC-eligible. Without this, the
  // Channel below keeps a transitive reference to the entire terminal
  // through `onChunk`, even after `active` is false — the channel itself
  // stays alive until the Rust forwarder's next send fails.
  let handler: PtyChunkHandler | null = onChunk;
  const channel = new Channel<unknown>((payload) => {
    if (!active || !handler) return;
    const bytes = toUint8Array(payload);
    if (bytes && bytes.byteLength > 0) handler(bytes);
  });

  await invoke("pty_subscribe", {
    args: { sessionId },
    onData: channel,
  });

  return {
    unsubscribe: () => {
      active = false;
      handler = null;
      // Replace the Channel's onmessage with a no-op so the Tauri runtime
      // doesn't keep our original closure (and therefore the terminal)
      // alive until the backend forwarder eventually fails to send.
      try {
        channel.onmessage = noopChannelHandler;
      } catch {
        /* older @tauri-apps/api shapes may not expose the setter — the
         * `active` / `handler` nulling above already prevents user code
         * from running, so this is best-effort cleanup only. */
      }
    },
  };
}

/// Per-session reference count of local subscribers. The cloud-agent's
/// `pty_subscribe` is connection-scoped — sending `pty_unsubscribe`
/// drops the agent's per-connection forwarder for the session, killing
/// frames for every local subscriber, not just the one that asked to
/// stop. PlanFlow Start writes a Terminal subscription *and* a private
/// idle-detection subscription against the same session; without
/// refcounting, the launcher's cleanup would yank the wire out from
/// under xterm and the user would see a blank pane until a remount.
const cloudSubscribeRefs = new Map<string, number>();

async function cloudPtySubscribe(
  sessionId: string,
  onChunk: PtyChunkHandler,
): Promise<PtySubscription> {
  // Resolve the client via the same await/connect path the
  // request-shaped wrappers use through routeIpc(). The subscription
  // primitive is different enough that we can't reuse routeIpc()
  // directly here (no per-call return value to thread through).
  const client = await awaitCloudClient();

  let alive = true;
  let handler: PtyChunkHandler | null = onChunk;
  let counted = false;

  const detach = client.onPtyOutput((bytes, frameSessionId) => {
    if (!alive || !handler) return;
    if (frameSessionId !== sessionId) return;
    if (bytes.byteLength === 0) return;
    // Hand the caller a fresh view backed by the same buffer — the
    // bridge already allocated a Uint8Array per frame.
    handler(bytes);
  });

  try {
    await client.ptySubscribe(sessionId);
    cloudSubscribeRefs.set(sessionId, (cloudSubscribeRefs.get(sessionId) ?? 0) + 1);
    counted = true;
  } catch (err) {
    alive = false;
    handler = null;
    detach();
    throw err;
  }

  return {
    unsubscribe: () => {
      if (!alive) return;
      alive = false;
      handler = null;
      detach();
      if (!counted) return;
      counted = false;
      const next = (cloudSubscribeRefs.get(sessionId) ?? 1) - 1;
      if (next <= 0) {
        cloudSubscribeRefs.delete(sessionId);
        // Last local subscriber for this session — safe to ask the
        // cloud-agent to drop its forwarder. Best-effort: failures
        // log via the bridge's onError hook but must not throw
        // from a disposer.
        void client.ptyUnsubscribe(sessionId).catch(() => {
          /* swallowed — see comment above */
        });
      } else {
        cloudSubscribeRefs.set(sessionId, next);
      }
    },
  };
}
