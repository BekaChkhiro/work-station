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
  return invoke<PtySpawnResponse>("pty_spawn", { args });
}

export interface PtyWriteArgs {
  sessionId: string;
  data: Uint8Array;
}

/**
 * Send raw bytes to a PTY's stdin. Tauri's JSON transport carries the bytes
 * as a number array, which Rust deserializes into `Vec<u8>` for
 * `pty_write`'s `WriteArgs::data` field.
 *
 * No-op when the Tauri runtime is unavailable (vite preview, isolated
 * harnesses) so the Terminal component's input handlers can be wired up
 * unconditionally.
 */
export async function ptyWrite(sessionId: string, data: Uint8Array): Promise<void> {
  if (!isTauriRuntime()) return;
  if (data.byteLength === 0) return;
  await invoke("pty_write", {
    args: { sessionId, data: Array.from(data) },
  });
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
 * No-op outside the Tauri runtime so the Terminal component's resize
 * observer can fire unconditionally in vite preview / stress harnesses.
 */
export async function ptyResize(sessionId: string, cols: number, rows: number): Promise<void> {
  if (!isTauriRuntime()) return;
  await invoke("pty_resize", {
    args: { sessionId, cols, rows },
  });
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
 * consistent view, not a tail of a mutating buffer.
 */
export async function ptyGetScrollback(sessionId: string): Promise<PtyScrollbackSnapshot> {
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
