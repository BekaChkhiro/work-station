// Mobile-side singleton wrapping the shared WsBridgeClient.
//
// The PWA needs exactly one socket per tab even when several routes
// (Terminal, Tasks, Monitor) consume the bridge concurrently. This module
// exposes a lazy getter and a Solid signal mirroring the connection
// state so UI can react to drops without each consumer wiring its own
// listener.
//
// Config (url + token) is read from localStorage:
//   ws.mobile.config = { "url": "ws://127.0.0.1:7420/ws", "token": "…" }
// T18.9's Auth screen will populate this; until then the Terminal route
// renders an inline config card.

import { createSignal } from "solid-js";
import { WsBridgeClient, type ConnectionState } from "../lib/wsBridge";

const STORAGE_KEY = "ws.mobile.config";

export interface BridgeConfig {
  url: string;
  token: string;
}

export function readBridgeConfig(): BridgeConfig | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BridgeConfig>;
    if (
      typeof parsed.url === "string" &&
      typeof parsed.token === "string" &&
      parsed.url &&
      parsed.token
    ) {
      return { url: parsed.url, token: parsed.token };
    }
  } catch {
    // ignore — fall through to null
  }
  return null;
}

export function writeBridgeConfig(config: BridgeConfig): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function clearBridgeConfig(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

let client: WsBridgeClient | null = null;
const [state, setState] = createSignal<ConnectionState>("idle");
const [lastError, setLastError] = createSignal<string | null>(null);

export function bridgeState() {
  return state();
}

export function bridgeLastError() {
  return lastError();
}

/** Returns the singleton client, lazily constructing it from stored config. */
export function getBridge(): WsBridgeClient | null {
  if (client) return client;
  const config = readBridgeConfig();
  if (!config) return null;
  client = new WsBridgeClient({
    url: config.url,
    token: config.token,
    onStateChange: (s) => setState(s),
    onError: (err) => setLastError(err.message),
  });
  client.connect();
  return client;
}

/** Tear down the cached client (e.g. on config change). */
export function resetBridge(): void {
  if (client) {
    client.close();
    client = null;
  }
  setState("idle");
  setLastError(null);
}
