// IPC channel types and helpers

import { Channel } from "@tauri-apps/api/core";

/**
 * Create a binary channel for receiving PTY output.
 *
 * Tauri v2 sends `InvokeResponseBody::Raw` as either:
 * - A `Uint8Array` for small payloads (< 1024 bytes, via eval)
 * - An `ArrayBuffer` for large payloads (via fetch API)
 *
 * This normalises both to a `Uint8Array`.
 */
export function createPtyChannel(
  onData: (data: Uint8Array) => void,
): Channel<Uint8Array> {
  return new Channel<Uint8Array>((response) => {
    // Response arrives as either ArrayBuffer (fetch path) or Uint8Array (eval path)
    if (response instanceof ArrayBuffer) {
      onData(new Uint8Array(response));
    } else if (response instanceof Uint8Array) {
      onData(response);
    } else if (
      typeof response === "object" &&
      response !== null &&
      "message" in response
    ) {
      // Handle possible wrapper shape from Tauri internals
      const msg = (response as { message: unknown }).message;
      if (msg instanceof ArrayBuffer) {
        onData(new Uint8Array(msg));
      } else if (msg instanceof Uint8Array) {
        onData(msg);
      }
    }
  });
}
