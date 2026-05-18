// T14.1 — Renderer-side factory for an authenticated GitHubClient.
//
// Mirrors `createRendererPlanFlowClient`: lazily reads the PAT from the
// OS keychain on each `getAuthToken` invocation, wires the reauth guard
// so 401/403 flips the GitHub integration into `needs_reauth`, and
// surfaces a typed `MissingGitHubTokenError` so views can render
// "Connect in Settings" instead of bubbling a raw 401 the first time
// they load.

import {
  createGitHubClient,
  type GitHubClient,
  type IntegrationCacheStore,
  type RetryOptions,
} from "../index";
import { DEFAULT_ACCOUNT, getCredential, Integration } from "../credentials";

export class MissingGitHubTokenError extends Error {
  constructor() {
    super("No GitHub token saved. Connect via Settings → Integrations.");
    this.name = "MissingGitHubTokenError";
  }
}

export interface RendererGitHubClientOptions {
  /** Inject a custom token reader for tests / preview harnesses. */
  getAuthToken?: () => string | null | Promise<string | null>;
  cacheStore?: IntegrationCacheStore;
  defaultTimeoutMs?: number;
  defaultRetry?: RetryOptions;
  fetchImpl?: typeof fetch;
}

export function createRendererGitHubClient(
  options: RendererGitHubClientOptions = {},
): GitHubClient {
  const tokenReader =
    options.getAuthToken ??
    (async (): Promise<string> => {
      const token = await getCredential(Integration.GitHub, DEFAULT_ACCOUNT);
      if (!token || token.length === 0) throw new MissingGitHubTokenError();
      return token;
    });
  return createGitHubClient({
    getAuthToken: tokenReader,
    reauthIntegration: Integration.GitHub,
    cacheStore: options.cacheStore,
    defaultTimeoutMs: options.defaultTimeoutMs,
    defaultRetry: options.defaultRetry,
    fetchImpl: options.fetchImpl,
  });
}
