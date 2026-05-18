// T14.1 — GitHub-specific error wrappers.
//
// `IntegrationHttpClient` raises generic transport / HTTP / rate-limit
// errors. We translate those into named GitHub variants so call sites can
// distinguish "token rejected → reauth" from "repo not found → empty
// state" without parsing status codes everywhere.

import { IntegrationHttpError } from "../httpClient";

export class GitHubAuthError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message?: string) {
    super(message ?? `GitHub authentication failed (HTTP ${status})`);
    this.name = "GitHubAuthError";
    this.status = status;
    this.body = body;
  }
}

export class GitHubNotFoundError extends Error {
  readonly status: 404;
  readonly body: string;

  constructor(body: string, message?: string) {
    super(message ?? "GitHub resource not found");
    this.name = "GitHubNotFoundError";
    this.status = 404;
    this.body = body;
  }
}

export class GitHubApiError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message?: string) {
    super(message ?? `GitHub API error (HTTP ${status})`);
    this.name = "GitHubApiError";
    this.status = status;
    this.body = body;
  }
}

export class GitHubParseError extends Error {
  readonly path: string;
  readonly causeValue: unknown;

  constructor(path: string, causeValue: unknown) {
    super(`GitHub response failed schema validation for ${path}`);
    this.name = "GitHubParseError";
    this.path = path;
    this.causeValue = causeValue;
  }
}

export function mapGitHubHttpError(error: unknown): never {
  if (error instanceof IntegrationHttpError) {
    if (error.status === 401) {
      throw new GitHubAuthError(error.status, error.body);
    }
    // 403 on GitHub can mean either missing scopes or rate limiting. The
    // rate-limit branch is already typed (`IntegrationRateLimitError` is a
    // 429-only signal here) so we pin 403 to auth — callers that need to
    // distinguish missing-scopes from rate-limit should inspect
    // `error.headers["x-ratelimit-remaining"]` themselves.
    if (error.status === 403) {
      throw new GitHubAuthError(error.status, error.body);
    }
    if (error.status === 404) {
      throw new GitHubNotFoundError(error.body, error.message);
    }
    throw new GitHubApiError(error.status, error.body, error.message);
  }
  throw error;
}
