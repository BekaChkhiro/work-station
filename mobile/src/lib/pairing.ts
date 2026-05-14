// Pairing payload helpers — shared between the URL auto-pair flow and
// the in-app QR scanner. The desktop renders a QR encoding a deep link
// of the form
//
//   https://<pwa-origin>/?h=<host>&t=<token>
//
// where <host> is the LAN-reachable origin (e.g. http://192.168.1.5:7420).
// Phone camera apps open the URL natively — the PWA then strips the
// params from the URL bar and auto-connects. The scanner inside the
// AuthScreen accepts the same format, plus a JSON blob `{h, t}` for
// future extensibility.

export interface PairingPayload {
  host: string;
  token: string;
}

/** Parse a pairing payload from a raw string (URL, JSON blob, or bare
 *  `host|token`). Returns null if the input doesn't carry both values. */
export function parsePairingPayload(input: string): PairingPayload | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Try URL: pull `h`/`host` and `t`/`token` from search or hash. Hash
  // params keep the secrets out of server logs / Referer; the desktop
  // QR uses search params because mobile browsers don't open custom
  // schemes reliably, and search params are universally supported.
  try {
    const url = new URL(trimmed);
    const fromParams = (params: URLSearchParams) => {
      const host = params.get("h") ?? params.get("host");
      const token = params.get("t") ?? params.get("token");
      return host && token ? { host, token } : null;
    };
    const search = fromParams(url.searchParams);
    if (search) return search;
    if (url.hash.length > 1) {
      const hashParams = new URLSearchParams(url.hash.slice(1));
      const hash = fromParams(hashParams);
      if (hash) return hash;
    }
  } catch {
    // Not a URL — fall through to JSON / pipe parsing.
  }

  // Try JSON `{h, t}` or `{host, token}`.
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      const host = pickString(obj, "h", "host");
      const token = pickString(obj, "t", "token");
      if (host && token) return { host, token };
    } catch {
      // Malformed JSON — fall through.
    }
  }

  // Last resort: `host|token` for ultra-compact QRs.
  const pipeIdx = trimmed.indexOf("|");
  if (pipeIdx > 0) {
    const host = trimmed.slice(0, pipeIdx).trim();
    const token = trimmed.slice(pipeIdx + 1).trim();
    if (host && token) return { host, token };
  }

  return null;
}

function pickString(obj: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

/** Drop pairing params from `location` without a reload so credentials
 *  don't linger in the address bar after auto-pair. */
export function stripPairingParamsFromUrl(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  let changed = false;
  for (const key of ["h", "host", "t", "token"]) {
    if (url.searchParams.has(key)) {
      url.searchParams.delete(key);
      changed = true;
    }
  }
  if (url.hash.length > 1) {
    const hashParams = new URLSearchParams(url.hash.slice(1));
    for (const key of ["h", "host", "t", "token"]) {
      if (hashParams.has(key)) {
        hashParams.delete(key);
        changed = true;
      }
    }
    const newHash = hashParams.toString();
    url.hash = newHash.length > 0 ? `#${newHash}` : "";
  }
  if (!changed) return;
  window.history.replaceState(null, "", url.toString());
}
