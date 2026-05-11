// T11.6 — Connection test flow.
//
// Each integration's "Verify" button runs a minimal authenticated GET against
// the real API. Success returns the account label the UI renders next to the
// green check; failure normalizes the underlying transport error into a
// `VerifyFailureReason` so the panel can show actionable copy ("Invalid
// credentials", "Missing scopes", "Network error", "Rate limited") instead of
// raw HTTP noise.
//
// Each verifier owns its own short-lived `IntegrationHttpClient` (no cache, no
// retries) so a misconfigured token can't poison subsequent reads from the
// real integration tabs.

import {
  createIntegrationHttpClient,
  IntegrationHttpError,
  IntegrationNetworkError,
  IntegrationRateLimitError,
  IntegrationTimeoutError,
} from "../httpClient";
import { Integration, type IntegrationId } from "../credentials";
import {
  PlanFlowAuthError,
  PlanFlowApiError,
  PlanFlowParseError,
  createPlanFlowClient,
} from "../planflow";

export type VerifyFailureReason =
  | "invalidCredentials"
  | "missingScopes"
  | "rateLimited"
  | "network"
  | "unexpected";

export class IntegrationVerifyError extends Error {
  readonly reason: VerifyFailureReason;
  readonly status: number | null;
  readonly userMessage: string;

  constructor(reason: VerifyFailureReason, userMessage: string, status: number | null = null) {
    super(userMessage);
    this.name = "IntegrationVerifyError";
    this.reason = reason;
    this.userMessage = userMessage;
    this.status = status;
  }
}

export interface VerifyResult {
  accountLabel: string;
  /** T12.2 — PlanFlow returns both fields from `/me`; the Settings card
   *  renders "Connected as <name> (<email>)" when both are present. Other
   *  integrations may leave one or both unset. */
  accountName?: string | null;
  accountEmail?: string | null;
}

export interface VerifyOptions {
  fetchImpl?: typeof fetch;
}

const TIMEOUT_MS = 10_000;

export async function verifyIntegration(
  integration: IntegrationId,
  token: string,
  options: VerifyOptions = {},
): Promise<VerifyResult> {
  switch (integration) {
    case Integration.PlanFlow:
      return verifyPlanFlow(token, options);
    case Integration.GitHub:
      return verifyGitHub(token, options);
    case Integration.Vercel:
      return verifyVercel(token, options);
    case Integration.Neon:
      return verifyNeon(token, options);
    case Integration.Railway:
      return verifyRailway(token, options);
    default:
      throw new IntegrationVerifyError(
        "unexpected",
        `Verification isn't implemented for "${integration}" yet.`,
      );
  }
}

async function verifyPlanFlow(token: string, options: VerifyOptions): Promise<VerifyResult> {
  const client = createPlanFlowClient({
    getAuthToken: () => token,
    fetchImpl: options.fetchImpl,
    defaultTimeoutMs: TIMEOUT_MS,
    defaultRetry: { attempts: 0 },
  });
  try {
    const me = await client.getMe();
    const name = me.name?.trim() || null;
    const email = me.email?.trim() || null;
    const label = name || email || me.id;
    return { accountLabel: label, accountName: name, accountEmail: email };
  } catch (error) {
    if (error instanceof PlanFlowAuthError) {
      throw new IntegrationVerifyError(
        "invalidCredentials",
        "Invalid credentials — PlanFlow rejected this token.",
        error.status,
      );
    }
    if (error instanceof PlanFlowApiError) {
      throw new IntegrationVerifyError(
        "unexpected",
        `PlanFlow responded with HTTP ${error.status}. Try again or check the service status.`,
        error.status,
      );
    }
    if (error instanceof PlanFlowParseError) {
      throw new IntegrationVerifyError(
        "unexpected",
        "PlanFlow returned an unexpected response shape.",
      );
    }
    throw mapTransportError(error, "PlanFlow");
  }
}

async function verifyGitHub(token: string, options: VerifyOptions): Promise<VerifyResult> {
  const http = createIntegrationHttpClient({
    service: "github-verify",
    baseUrl: "https://api.github.com",
    fetchImpl: options.fetchImpl,
    getAuthToken: () => token,
    defaultHeaders: {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    defaultTimeoutMs: TIMEOUT_MS,
    defaultRetry: { attempts: 0 },
  });
  try {
    const user = await http.get<{ login?: string; name?: string | null }>("/user", {
      responseType: "json",
    });
    if (!user || typeof user.login !== "string" || user.login.length === 0) {
      throw new IntegrationVerifyError(
        "unexpected",
        "GitHub returned a response without a login field.",
      );
    }
    const label = user.name?.trim() ? `${user.name.trim()} (@${user.login})` : `@${user.login}`;
    return { accountLabel: label };
  } catch (error) {
    if (error instanceof IntegrationVerifyError) throw error;
    if (error instanceof IntegrationHttpError) {
      if (error.status === 401) {
        throw new IntegrationVerifyError(
          "invalidCredentials",
          "Invalid credentials — GitHub rejected this token.",
          error.status,
        );
      }
      if (error.status === 403) {
        if (looksLikeRateLimit(error)) {
          throw new IntegrationVerifyError(
            "rateLimited",
            "GitHub rate limit hit. Wait a minute and try again.",
            error.status,
          );
        }
        throw new IntegrationVerifyError(
          "missingScopes",
          "Token is missing required scopes. Re-issue it with at least `read:user` and `repo`.",
          error.status,
        );
      }
      throw new IntegrationVerifyError(
        "unexpected",
        `GitHub responded with HTTP ${error.status}.`,
        error.status,
      );
    }
    throw mapTransportError(error, "GitHub");
  }
}

async function verifyVercel(token: string, options: VerifyOptions): Promise<VerifyResult> {
  const http = createIntegrationHttpClient({
    service: "vercel-verify",
    baseUrl: "https://api.vercel.com",
    fetchImpl: options.fetchImpl,
    getAuthToken: () => token,
    defaultHeaders: { accept: "application/json" },
    defaultTimeoutMs: TIMEOUT_MS,
    defaultRetry: { attempts: 0 },
  });
  try {
    const payload = await http.get<{
      user?: { username?: string; name?: string | null; email?: string };
    }>("/v2/user", { responseType: "json" });
    const user = payload?.user;
    if (!user) {
      throw new IntegrationVerifyError(
        "unexpected",
        "Vercel returned a response without a user field.",
      );
    }
    const username = user.username?.trim();
    const name = user.name?.trim();
    const email = user.email?.trim();
    const label = username
      ? name
        ? `${name} (${username})`
        : username
      : (name ?? email ?? "Vercel user");
    return { accountLabel: label };
  } catch (error) {
    if (error instanceof IntegrationVerifyError) throw error;
    if (error instanceof IntegrationHttpError) {
      if (error.status === 401 || error.status === 403) {
        throw new IntegrationVerifyError(
          "invalidCredentials",
          "Invalid credentials — Vercel rejected this token.",
          error.status,
        );
      }
      throw new IntegrationVerifyError(
        "unexpected",
        `Vercel responded with HTTP ${error.status}.`,
        error.status,
      );
    }
    throw mapTransportError(error, "Vercel");
  }
}

async function verifyNeon(token: string, options: VerifyOptions): Promise<VerifyResult> {
  const http = createIntegrationHttpClient({
    service: "neon-verify",
    baseUrl: "https://console.neon.tech",
    fetchImpl: options.fetchImpl,
    getAuthToken: () => token,
    defaultHeaders: { accept: "application/json" },
    defaultTimeoutMs: TIMEOUT_MS,
    defaultRetry: { attempts: 0 },
  });
  try {
    const me = await http.get<{ email?: string; name?: string | null; login?: string }>(
      "/api/v2/users/me",
      { responseType: "json" },
    );
    const email = me?.email?.trim();
    const name = me?.name?.trim();
    const login = me?.login?.trim();
    const label = email ?? name ?? login;
    if (!label) {
      throw new IntegrationVerifyError(
        "unexpected",
        "Neon returned a response without an email or name.",
      );
    }
    return { accountLabel: label };
  } catch (error) {
    if (error instanceof IntegrationVerifyError) throw error;
    if (error instanceof IntegrationHttpError) {
      if (error.status === 401 || error.status === 403) {
        throw new IntegrationVerifyError(
          "invalidCredentials",
          "Invalid credentials — Neon rejected this token.",
          error.status,
        );
      }
      throw new IntegrationVerifyError(
        "unexpected",
        `Neon responded with HTTP ${error.status}.`,
        error.status,
      );
    }
    throw mapTransportError(error, "Neon");
  }
}

async function verifyRailway(token: string, options: VerifyOptions): Promise<VerifyResult> {
  const http = createIntegrationHttpClient({
    service: "railway-verify",
    baseUrl: "https://backboard.railway.app",
    fetchImpl: options.fetchImpl,
    getAuthToken: () => token,
    defaultHeaders: { accept: "application/json" },
    defaultTimeoutMs: TIMEOUT_MS,
    defaultRetry: { attempts: 0 },
  });
  try {
    const response = await http.post<{
      data?: { me?: { email?: string; name?: string | null; id?: string } } | null;
      errors?: readonly { message?: string }[];
    }>("/graphql/v2", {
      json: { query: "query Me { me { id email name } }" },
      responseType: "json",
    });
    const errors = response?.errors;
    if (Array.isArray(errors) && errors.length > 0) {
      const message = errors[0]?.message ?? "Railway rejected the request.";
      if (/unauthor|unauthent|invalid token|not logged in/i.test(message)) {
        throw new IntegrationVerifyError(
          "invalidCredentials",
          "Invalid credentials — Railway rejected this token.",
        );
      }
      throw new IntegrationVerifyError("unexpected", `Railway error: ${message}`);
    }
    const me = response?.data?.me;
    if (!me) {
      throw new IntegrationVerifyError(
        "unexpected",
        "Railway returned a response without account data.",
      );
    }
    const email = me.email?.trim();
    const name = me.name?.trim();
    const id = me.id?.trim();
    const label = email ?? name ?? id;
    if (!label) {
      throw new IntegrationVerifyError("unexpected", "Railway returned an empty account record.");
    }
    return { accountLabel: label };
  } catch (error) {
    if (error instanceof IntegrationVerifyError) throw error;
    if (error instanceof IntegrationHttpError) {
      if (error.status === 401 || error.status === 403) {
        throw new IntegrationVerifyError(
          "invalidCredentials",
          "Invalid credentials — Railway rejected this token.",
          error.status,
        );
      }
      throw new IntegrationVerifyError(
        "unexpected",
        `Railway responded with HTTP ${error.status}.`,
        error.status,
      );
    }
    throw mapTransportError(error, "Railway");
  }
}

function looksLikeRateLimit(error: IntegrationHttpError): boolean {
  const remaining = error.headers["x-ratelimit-remaining"];
  if (remaining === "0") return true;
  return /rate limit|abuse detection/i.test(error.body);
}

function mapTransportError(error: unknown, service: string): IntegrationVerifyError {
  if (error instanceof IntegrationRateLimitError) {
    return new IntegrationVerifyError(
      "rateLimited",
      `${service} rate limit hit. Wait a minute and try again.`,
      error.status,
    );
  }
  if (error instanceof IntegrationTimeoutError) {
    return new IntegrationVerifyError(
      "network",
      `Couldn't reach ${service} — the request timed out.`,
    );
  }
  if (error instanceof IntegrationNetworkError) {
    return new IntegrationVerifyError(
      "network",
      `Couldn't reach ${service} — check your internet connection.`,
    );
  }
  if (error instanceof Error) {
    return new IntegrationVerifyError("unexpected", error.message);
  }
  return new IntegrationVerifyError("unexpected", `Unexpected error contacting ${service}.`);
}
