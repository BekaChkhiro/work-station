// T18.9 — Mobile auth state + credentials probe.
//
// The PWA needs a bearer token (minted on first launch of the desktop
// app — see src-tauri/src/ws/auth.rs) to talk to the embedded
// WebSocket server. We hold the host + token here, persist them to
// localStorage so a returning tab skips the auth form, and expose a
// one-shot probe that distinguishes "wrong token" from "host
// unreachable" so the user gets a useful error instead of "connection
// failed".
//
// The full long-lived WebSocket lives in src/integrations/wsBridge/
// (T18.8) and is consumed by T18.12 onwards — this module owns only
// credentials + a quick yes/no validation.

import { createSignal } from "solid-js";
import { isServer } from "solid-js/web";

export type ConnectionStatus =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: "connected" }
  | { kind: "error"; reason: ConnectionError; message: string };

export type ConnectionError =
  | "missing-credentials"
  | "invalid-host"
  | "wrong-token"
  | "unreachable";

/** localStorage key — shared with anything else that needs to hydrate creds. */
export const CREDENTIALS_STORAGE_KEY = "ws.credentials.v1";

interface StoredCredentials {
  host: string;
  token: string;
}

const DEFAULT_HOST = "http://localhost:7420";

function loadStoredCredentials(): StoredCredentials | null {
  if (isServer || typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(CREDENTIALS_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
    if (
      parsed &&
      typeof parsed.host === "string" &&
      typeof parsed.token === "string" &&
      parsed.host.length > 0 &&
      parsed.token.length > 0
    ) {
      return { host: parsed.host, token: parsed.token };
    }
  } catch {
    // Corrupt JSON — drop it so the user re-enters credentials instead
    // of being stuck on a screen that auto-reloads broken data.
    localStorage.removeItem(CREDENTIALS_STORAGE_KEY);
  }
  return null;
}

const stored = loadStoredCredentials();

const [host, setHost] = createSignal<string>(stored?.host ?? DEFAULT_HOST);
const [token, setToken] = createSignal<string>(stored?.token ?? "");
const [status, setStatus] = createSignal<ConnectionStatus>({ kind: "idle" });

export const authStore = {
  host,
  token,
  status,
  /** True only after a successful probe this session. */
  isAuthenticated: () => status().kind === "connected",
  /** True if persisted credentials existed at boot — drives first-launch routing. */
  hasStoredCredentials: () => stored !== null,
};

/** Wipe stored credentials + reset signals — used by "Sign out". */
export function signOut(): void {
  if (!isServer && typeof localStorage !== "undefined") {
    localStorage.removeItem(CREDENTIALS_STORAGE_KEY);
  }
  setHost(DEFAULT_HOST);
  setToken("");
  setStatus({ kind: "idle" });
}

/**
 * Coerce whatever the user typed into an `http(s)://host:port` base URL.
 *
 * Accepts:
 *   - `http://host:port` / `https://host:port`           (kept as-is)
 *   - `ws://host:port`   / `wss://host:port`             (translated to http/https)
 *   - `host:port` / `host`                               (defaulted to http://)
 *
 * Returns null if the input doesn't parse as a URL we can probe.
 */
export function normaliseHost(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  // Reject a bare scheme like "http://" — the URL parser is lenient
  // enough to accept it on some runtimes and we'd rather show
  // "invalid host" than auto-correct nonsense.
  if (/^(?:https?|wss?):\/\/$/i.test(trimmed)) return null;

  let candidate = trimmed;
  if (candidate.startsWith("ws://")) candidate = "http://" + candidate.slice(5);
  else if (candidate.startsWith("wss://")) candidate = "https://" + candidate.slice(6);
  else if (!/^https?:\/\//i.test(candidate)) candidate = "http://" + candidate;

  try {
    const url = new URL(candidate);
    if (!url.hostname) return null;
    // `URL.origin` already drops any pasted path / trailing slash.
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Probe `host` + `token` against the embedded server and update `status`.
 *
 * Strategy:
 *   1. `GET <host>/healthz` — unauth liveness probe (see ws/server.rs).
 *      A network failure here means "host is wrong / not running" so we
 *      report `unreachable` instead of blaming the token.
 *   2. `GET <host>/ws?token=…` — the WebSocket upgrade endpoint. Without
 *      the `Upgrade` header axum returns 400 when the token is right
 *      and 401 when it's wrong (auth runs before the upgrade extractor;
 *      see require_bearer in ws/server.rs). 401 → wrong-token; anything
 *      else (200/400/426/…) means the bearer was accepted.
 *
 * This does NOT open a long-lived WebSocket — that's T18.12's job via
 * the WsBridgeClient. We only verify credentials so the user gets a
 * deterministic "Connected" / "Wrong token" verdict.
 */
export async function connect(
  rawHost: string,
  rawToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectionStatus> {
  const trimmedToken = rawToken.trim();
  if (trimmedToken.length === 0) {
    return finalise({
      kind: "error",
      reason: "missing-credentials",
      message: "Enter the token from Work Station → Settings.",
    });
  }

  const origin = normaliseHost(rawHost);
  if (origin === null) {
    return finalise({
      kind: "error",
      reason: "invalid-host",
      message: "Host URL is not valid. Try something like http://localhost:7420.",
    });
  }

  setStatus({ kind: "connecting" });

  // Step 1 — liveness.
  let healthOk = false;
  try {
    const res = await fetchImpl(`${origin}/healthz`, { method: "GET" });
    healthOk = res.ok;
  } catch {
    return finalise({
      kind: "error",
      reason: "unreachable",
      message: `Couldn't reach ${origin}. Is Work Station running on that port?`,
    });
  }
  if (!healthOk) {
    return finalise({
      kind: "error",
      reason: "unreachable",
      message: `${origin} responded, but not as a Work Station server.`,
    });
  }

  // Step 2 — bearer validation.
  let authRes: Response;
  try {
    authRes = await fetchImpl(`${origin}/ws?token=${encodeURIComponent(trimmedToken)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${trimmedToken}` },
    });
  } catch {
    return finalise({
      kind: "error",
      reason: "unreachable",
      message: `Lost connection to ${origin} while validating the token.`,
    });
  }

  if (authRes.status === 401) {
    return finalise({
      kind: "error",
      reason: "wrong-token",
      message: "Token rejected. Open Work Station → Settings to copy a fresh one.",
    });
  }

  persist({ host: origin, token: trimmedToken });
  setHost(origin);
  setToken(trimmedToken);
  return finalise({ kind: "connected" });
}

function persist(creds: StoredCredentials): void {
  if (isServer || typeof localStorage === "undefined") return;
  localStorage.setItem(CREDENTIALS_STORAGE_KEY, JSON.stringify(creds));
}

function finalise(next: ConnectionStatus): ConnectionStatus {
  setStatus(next);
  return next;
}

// Test-only seam — reset the store between cases without exposing setters.
export const __testing__ = {
  reset(): void {
    setHost(DEFAULT_HOST);
    setToken("");
    setStatus({ kind: "idle" });
  },
};
