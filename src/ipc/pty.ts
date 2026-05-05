// T4.4: typed wrappers for the PTY IPC surface.
//
// `pty_subscribe` is backed by a `tauri::ipc::Channel<InvokeResponseBody>` on
// the Rust side that pushes raw frames as `InvokeResponseBody::Raw(Vec<u8>)`.
// On the JS side those arrive as `ArrayBuffer` payloads delivered to the
// Channel's `onmessage` callback. The wrapper exposes a tiny callback API and
// returns a disposer so call sites don't have to know about the Channel
// plumbing or the cleanup contract.
//
// Subscriptions are short-circuited when the Tauri runtime is unavailable
// (vite preview, isolated component harnesses) so consumers can mount the
// Terminal component without a real backend behind it.

import { Channel, invoke } from "@tauri-apps/api/core";

const isTauriRuntime = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export interface PtySpawnArgs {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols: number;
  rows: number;
}

export interface PtySpawnResponse {
  sessionId: string;
}

export async function ptySpawn(args: PtySpawnArgs): Promise<PtySpawnResponse> {
  return invoke<PtySpawnResponse>("pty_spawn", { args });
}

export type PtyChunkHandler = (chunk: Uint8Array) => void;

export interface PtySubscription {
  /** Stop forwarding frames to the handler. The backend forwarder also
   *  exits the next time it tries to send (channel send fails). */
  unsubscribe: () => void;
}

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
 * view. Call `unsubscribe()` to drop the handler — the spawned forwarder on
 * the Rust side exits naturally when the channel is no longer reachable.
 */
export async function ptySubscribe(
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
  const channel = new Channel<unknown>((payload) => {
    if (!active) return;
    const bytes = toUint8Array(payload);
    if (bytes && bytes.byteLength > 0) onChunk(bytes);
  });

  await invoke("pty_subscribe", {
    args: { sessionId },
    onData: channel,
  });

  return {
    unsubscribe: () => {
      active = false;
    },
  };
}
