// T11.2: typed wrapper around the credential-store Tauri commands.
//
// Backend lives at `src-tauri/src/credentials/`. The Rust side stores
// secrets in the OS keychain (macOS Keychain / Windows Credential Manager
// / Linux Secret Service) — they never round-trip through SQLite.
//
// All four commands run on Tokio's blocking pool so a slow keychain
// prompt does not stall the IPC reactor. The first macOS access for an
// account will pop a system dialog; subsequent reads of the same key
// from the same signed binary are silent.
//
// Errors arrive as
//   { kind, message, userMessage, recovery }
// matching every other typed command in this app (T2.15 shape).

import { invoke } from "@tauri-apps/api/core";
import { z } from "zod";

export type CredentialsErrorKind =
  | "invalidArgs"
  | "backendUnavailable"
  | "locked"
  | "accessDenied"
  | "internal";

export type CredentialsRecovery = "retry" | "editProject" | "dismiss";

export interface CredentialsErrorPayload {
  kind: CredentialsErrorKind;
  message: string;
  userMessage: string;
  recovery: CredentialsRecovery;
}

export const credentialsErrorSchema: z.ZodType<CredentialsErrorPayload> = z.object({
  kind: z.enum(["invalidArgs", "backendUnavailable", "locked", "accessDenied", "internal"]),
  message: z.string(),
  userMessage: z.string(),
  recovery: z.enum(["retry", "editProject", "dismiss"]),
});

/** Typed wrapper for an error thrown by a credentials command. Lets call
 *  sites pattern-match on `.payload.kind` instead of parsing the raw
 *  invoke rejection. */
export class CredentialsError extends Error {
  readonly payload: CredentialsErrorPayload;

  constructor(payload: CredentialsErrorPayload) {
    super(payload.message);
    this.name = "CredentialsError";
    this.payload = payload;
  }

  get kind(): CredentialsErrorKind {
    return this.payload.kind;
  }

  get userMessage(): string {
    return this.payload.userMessage;
  }

  get recovery(): CredentialsRecovery {
    return this.payload.recovery;
  }
}

function wrapInvokeError(raw: unknown): never {
  const parsed = credentialsErrorSchema.safeParse(raw);
  if (parsed.success) {
    throw new CredentialsError(parsed.data);
  }
  // Tauri's invoke can also reject with a plain string when the command
  // panics — surface it as Internal so consumers can branch uniformly.
  throw new CredentialsError({
    kind: "internal",
    message: typeof raw === "string" ? raw : JSON.stringify(raw),
    userMessage: "The system keychain returned an unexpected error.",
    recovery: "retry",
  });
}

/** Process-lifetime in-memory cache for secrets read from the OS keychain.
 *  macOS shows an authorisation prompt for every Keychain item access in
 *  unsigned / ad-hoc-signed builds (i.e. `pnpm tauri dev` and any local
 *  debug bundle that isn't part of the user's "Always Allow" set). Without
 *  this cache, every PlanFlow HTTP request — including the 30s
 *  unread-count poll and the 10s active-work / activity polls — would
 *  trigger a dialog. The cache turns "many prompts per minute" into "one
 *  prompt per app launch". Writes and deletes invalidate the entry so a
 *  user updating their token in Settings doesn't keep seeing the old one.
 *
 *  This is deliberately not a persistent cache — the OS keychain remains
 *  the durable store. We only hold the secret in JS memory for the life
 *  of the renderer process; on every restart the read happens again. */
const secretCache = new Map<string, string | null>();

function cacheKey(integration: string, account: string): string {
  return `${integration}:${account}`;
}

/** Drop a cached value. Used after a write/delete so the next read sees
 *  the freshly-stored secret rather than a stale one. Exported for tests
 *  + the SettingsPanel "I just pasted a new token" flow if it ever needs
 *  to force a re-read explicitly. */
export function invalidateCredentialCache(integration: string, account: string): void {
  secretCache.delete(cacheKey(integration, account));
}

/** Store (or replace) the secret for `(integration, account)`. */
export async function setCredential(
  integration: string,
  account: string,
  secret: string,
): Promise<void> {
  try {
    await invoke("credentials_set", { args: { integration, account, secret } });
    // Prime the cache with the value the user just saved so the very
    // next read (likely the Verify call) doesn't go back to Keychain.
    secretCache.set(cacheKey(integration, account), secret);
  } catch (err) {
    wrapInvokeError(err);
  }
}

/** Read the secret for `(integration, account)`, or `null` if absent. */
export async function getCredential(integration: string, account: string): Promise<string | null> {
  const key = cacheKey(integration, account);
  if (secretCache.has(key)) {
    return secretCache.get(key) ?? null;
  }
  try {
    const raw = await invoke<string | null>("credentials_get", {
      args: { integration, account },
    });
    const value = raw ?? null;
    secretCache.set(key, value);
    return value;
  } catch (err) {
    wrapInvokeError(err);
  }
}

/** Remove the secret for `(integration, account)`. Returns `true` if an
 *  entry was deleted, `false` if no entry existed (idempotent). */
export async function deleteCredential(integration: string, account: string): Promise<boolean> {
  try {
    const result = await invoke<boolean>("credentials_delete", {
      args: { integration, account },
    });
    secretCache.delete(cacheKey(integration, account));
    return result;
  } catch (err) {
    wrapInvokeError(err);
  }
}

/** Presence check. Useful for "is this integration connected?" UI
 *  without ever pulling the secret into the renderer. */
export async function hasCredential(integration: string, account: string): Promise<boolean> {
  try {
    return await invoke<boolean>("credentials_has", {
      args: { integration, account },
    });
  } catch (err) {
    wrapInvokeError(err);
  }
}

/** Stable account identifier used when an integration has a single
 *  "the user's token" (no per-account UI yet). Centralised so all
 *  call sites agree. */
export const DEFAULT_ACCOUNT = "default";

/** Canonical integration ids. The Rust side accepts any UTF-8 string,
 *  but pinning the names here prevents typos across the frontend. */
export const Integration = {
  PlanFlow: "planflow",
  GitHub: "github",
  Vercel: "vercel",
  Neon: "neon",
  Railway: "railway",
} as const;
export type IntegrationId = (typeof Integration)[keyof typeof Integration];
