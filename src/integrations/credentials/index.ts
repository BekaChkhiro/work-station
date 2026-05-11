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

/** Store (or replace) the secret for `(integration, account)`. */
export async function setCredential(
  integration: string,
  account: string,
  secret: string,
): Promise<void> {
  try {
    await invoke("credentials_set", { args: { integration, account, secret } });
  } catch (err) {
    wrapInvokeError(err);
  }
}

/** Read the secret for `(integration, account)`, or `null` if absent. */
export async function getCredential(integration: string, account: string): Promise<string | null> {
  try {
    const raw = await invoke<string | null>("credentials_get", {
      args: { integration, account },
    });
    return raw ?? null;
  } catch (err) {
    wrapInvokeError(err);
  }
}

/** Remove the secret for `(integration, account)`. Returns `true` if an
 *  entry was deleted, `false` if no entry existed (idempotent). */
export async function deleteCredential(integration: string, account: string): Promise<boolean> {
  try {
    return await invoke<boolean>("credentials_delete", {
      args: { integration, account },
    });
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
