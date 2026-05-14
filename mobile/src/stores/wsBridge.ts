// Singleton WsBridgeClient driven by the auth store.
//
// Credentials live in `lib/auth.ts` — the single source of truth — and
// this module derives the WS url from the stored `host` (http → ws,
// https → wss) on demand. One client per tab even when several routes
// (Terminal, Tasks, Monitor) consume the bridge concurrently.
//
// Lifecycle:
//   - `configureBridge(host, token)` is invoked by `auth.ts` whenever
//     the connect probe succeeds. It tears down any existing client and
//     builds a fresh one bound to the new credentials.
//   - `tearDownBridge()` is invoked on sign-out; routes see the state
//     drop back to "idle" and render an empty state.
//   - Auto-reconnect inside `WsBridgeClient` handles transient drops;
//     this layer only flips the client when credentials actually change.

import { createSignal } from "solid-js";
import { isServer } from "solid-js/web";
import { WsBridgeClient, type ConnectionState } from "../lib/wsBridge";

let client: WsBridgeClient | null = null;
let currentUrl: string | null = null;
let currentToken: string | null = null;
const [state, setState] = createSignal<ConnectionState>("idle");
const [lastError, setLastError] = createSignal<string | null>(null);
const [reconnectInfo, setReconnectInfo] = createSignal<{
  attempt: number;
  delayMs: number;
  retryAt: number;
} | null>(null);
const [reauthRequired, setReauthRequired] = createSignal(false);

export function bridgeState() {
  return state();
}

export function bridgeLastError() {
  return lastError();
}

/** Attempt counter + scheduled delay, surfaced by ConnectionPill while
 * the bridge is in `reconnecting` state. Null when not retrying. */
export function bridgeReconnectInfo() {
  return reconnectInfo();
}

/** True when the server closed the socket with a code that means the
 * bearer token was rejected (1008 / reason contains "unauthorized" or
 * "token"). UI should prompt the user to re-enter credentials instead
 * of retrying forever. */
export function bridgeReauthRequired() {
  return reauthRequired();
}

const REAUTH_CLOSE_CODES = new Set([1008, 4401, 4403]);
function isReauthClose(code: number, reason: string): boolean {
  if (REAUTH_CLOSE_CODES.has(code)) return true;
  const r = reason.toLowerCase();
  return r.includes("unauthorized") || r.includes("token") || r.includes("forbidden");
}

/**
 * Convert an http(s) origin (`https://example.com`) into the bridge's
 * WebSocket URL (`wss://example.com/ws`). Idempotent for inputs that
 * already use `ws`/`wss` or end with `/ws`.
 */
export function deriveBridgeUrl(origin: string): string {
  let url = origin.trim();
  if (!url) return url;
  if (url.startsWith("http://")) url = "ws://" + url.slice(7);
  else if (url.startsWith("https://")) url = "wss://" + url.slice(8);
  url = url.replace(/\/+$/, "");
  if (!url.endsWith("/ws")) url += "/ws";
  return url;
}

/** Returns the singleton client if one has been configured. */
export function getBridge(): WsBridgeClient | null {
  return client;
}

/**
 * Build (or rebuild) the bridge with the supplied credentials.
 *
 * Idempotent: re-uses the running client when host/token match, so
 * routes don't see the connection blink on every auth-store read.
 */
export function configureBridge(host: string, token: string): WsBridgeClient | null {
  if (isServer) return null;
  const url = deriveBridgeUrl(host);
  if (!url || !token) {
    tearDownBridge();
    return null;
  }
  if (client && currentUrl === url && currentToken === token) {
    return client;
  }
  if (client) {
    client.close();
    client = null;
  }
  setLastError(null);
  setReconnectInfo(null);
  setReauthRequired(false);
  currentUrl = url;
  currentToken = token;
  client = new WsBridgeClient({
    url,
    token,
    onStateChange: (next) => {
      setState(next);
      if (next === "open" || next === "connecting" || next === "idle") {
        setReconnectInfo(null);
      }
    },
    onError: (err) => setLastError(err.message),
    onReconnecting: (attempt, delayMs) => {
      setReconnectInfo({ attempt, delayMs, retryAt: Date.now() + delayMs });
    },
    onClose: ({ code, reason }) => {
      if (isReauthClose(code, reason)) {
        setReauthRequired(true);
        setLastError("Token rejected by the server. Re-enter the token from Settings.");
        // Stop the retry loop — re-auth is required, not a transient drop.
        client?.close();
      }
    },
  });
  client.connect();
  return client;
}

/** Tear down the cached client. Routes drop to "idle". */
export function tearDownBridge(): void {
  if (client) {
    client.close();
    client = null;
  }
  currentUrl = null;
  currentToken = null;
  setState("idle");
  setLastError(null);
  setReconnectInfo(null);
  setReauthRequired(false);
}

// --- visibility-aware lifecycle -------------------------------------
//
// Background tabs on mobile drain battery if the socket keeps churning.
// When the tab has been hidden for HIDE_GRACE_MS we proactively close
// the bridge; the moment the user returns we re-open it with the same
// credentials. The grace period avoids tearing the connection down on
// brief app switches (Notification Center, replying to a message).

const HIDE_GRACE_MS = 30_000;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let suspendedForHidden = false;

function handleVisibilityChange() {
  if (typeof document === "undefined") return;
  if (document.visibilityState === "hidden") {
    if (hideTimer || !client) return;
    hideTimer = setTimeout(() => {
      hideTimer = null;
      if (document.visibilityState !== "hidden") return;
      if (!client) return;
      suspendedForHidden = true;
      client.close();
      client = null;
      // Keep currentUrl/currentToken so we can re-arm on resume.
      setState("idle");
    }, HIDE_GRACE_MS);
    return;
  }
  // visible (or "prerender" — treat as visible)
  if (hideTimer) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
  if (suspendedForHidden && currentUrl && currentToken && !reauthRequired()) {
    suspendedForHidden = false;
    // Re-use the same credentials path that auth.ts would have taken.
    const url = currentUrl;
    const token = currentToken;
    currentUrl = null; // force configureBridge to treat this as fresh
    currentToken = null;
    configureBridge(deriveOriginFromBridgeUrl(url), token);
  }
}

function deriveOriginFromBridgeUrl(bridgeUrl: string): string {
  // Mirror of deriveBridgeUrl, in reverse: ws://x/ws → http://x.
  let url = bridgeUrl;
  if (url.endsWith("/ws")) url = url.slice(0, -3);
  if (url.startsWith("ws://")) url = "http://" + url.slice(5);
  else if (url.startsWith("wss://")) url = "https://" + url.slice(6);
  return url;
}

if (!isServer && typeof document !== "undefined") {
  document.addEventListener("visibilitychange", handleVisibilityChange);
}

// Backwards-compat alias — older callers (sessions.ts, terminal route)
// expect a `resetBridge` export. Tear-down + auto-rebuild on the next
// `configureBridge` call is the same effect.
export const resetBridge = tearDownBridge;
