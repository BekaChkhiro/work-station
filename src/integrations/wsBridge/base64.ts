// Browser-safe base64 helpers for the WebSocket PTY bridge wire format.
//
// Pty input / output bytes are base64-encoded in JSON frames (see
// `src-tauri/src/ws/protocol.rs`) so the whole protocol stays text. The
// happy-dom / browser runtime exposes `atob` / `btoa`; node-only fallbacks
// route through `Buffer` so this module is also usable from server-side
// tooling without a polyfill.

export function encodeBase64(bytes: Uint8Array): string {
  // String.fromCharCode(...bytes) blows the JS stack around 100k bytes.
  // Chunk through the array to keep peak stack usage bounded.
  if (typeof btoa === "function") {
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, Array.from(chunk));
    }
    return btoa(binary);
  }
  // Node fallback.
  const buf = (
    globalThis as { Buffer?: { from: (b: Uint8Array) => { toString: (enc: string) => string } } }
  ).Buffer;
  if (!buf) throw new Error("no base64 encoder available");
  return buf.from(bytes).toString("base64");
}

export function decodeBase64(b64: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(b64);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  const buf = (globalThis as { Buffer?: { from: (s: string, enc: string) => Uint8Array } }).Buffer;
  if (!buf) throw new Error("no base64 decoder available");
  return Uint8Array.from(buf.from(b64, "base64"));
}
