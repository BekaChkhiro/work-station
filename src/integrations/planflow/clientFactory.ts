// T12.3 — Renderer-side factory for an authenticated PlanFlowClient.
//
// Every PlanFlow view (task list, active work panel, activity feed, …)
// needs a client whose `getAuthToken` lazily reads the stored token out
// of the OS keychain. Centralising it here means:
//   - There is one well-known place that wires the reauth guard so a
//     mid-session token revocation flips every PlanFlow view into
//     "Reconnect required" together (T11.8).
//   - Each consumer can pass its own `cacheStore` (or none) without
//     re-encoding the credential-reading dance.
//   - The factory enforces a typed `MissingPlanFlowTokenError` so views
//     can fall back to a "Connect in Settings" empty state instead of
//     surfacing a generic 401 the first time the user lands.

import {
  createPlanFlowClient,
  type IntegrationCacheStore,
  type PlanFlowClient,
  type RetryOptions,
} from "../index";
import { DEFAULT_ACCOUNT, getCredential, Integration } from "../credentials";

export class MissingPlanFlowTokenError extends Error {
  constructor() {
    super("No PlanFlow token saved. Connect via Settings → Integrations.");
    this.name = "MissingPlanFlowTokenError";
  }
}

export interface RendererPlanFlowClientOptions {
  /** Inject a custom token reader for tests / preview harnesses. Defaults
   *  to reading from the OS keychain via the credentials plugin. */
  getAuthToken?: () => string | null | Promise<string | null>;
  cacheStore?: IntegrationCacheStore;
  defaultTimeoutMs?: number;
  defaultRetry?: RetryOptions;
  fetchImpl?: typeof fetch;
  /** T19.35 — Work Station project UUID that scopes this client. The
   *  routed `planflow_*` WS calls (Start, Status, Comments, GetMe, …)
   *  ship this as `cloud_project_id` so the cloud-agent's per-project
   *  token resolver (T19.34) picks the right PlanFlow account for the
   *  linked project. Unscoped views (NotificationsBell, …) leave it
   *  unset and fall back to the agent's global token. */
  cloudProjectId?: string;
}

/** Create a PlanFlowClient wired to the renderer's credential store and the
 *  shared reauth guard. Throwing `MissingPlanFlowTokenError` from
 *  `getAuthToken` lets the HTTP layer surface a typed signal that the
 *  caller can convert into an empty state. */
export function createRendererPlanFlowClient(
  options: RendererPlanFlowClientOptions = {},
): PlanFlowClient {
  const tokenReader =
    options.getAuthToken ??
    (async (): Promise<string> => {
      const token = await getCredential(Integration.PlanFlow, DEFAULT_ACCOUNT);
      if (!token || token.length === 0) throw new MissingPlanFlowTokenError();
      return token;
    });
  return createPlanFlowClient({
    getAuthToken: tokenReader,
    reauthIntegration: Integration.PlanFlow,
    cacheStore: options.cacheStore,
    defaultTimeoutMs: options.defaultTimeoutMs,
    defaultRetry: options.defaultRetry,
    fetchImpl: options.fetchImpl,
    // T19.13 — every renderer-side PlanFlow Tasks call (task list, active
    // work, comments, status flips, work locks, getMe) routes through the
    // IPC transport so cloud mode lands on the cloud-agent's `planflow_*`
    // WS handlers. Methods without a cloud counterpart (notifications,
    // knowledge, list-changes, list-projects, get-branch-name) keep using
    // the desktop's HTTP path regardless.
    routeViaCloudAgent: true,
    cloudProjectId: options.cloudProjectId,
  });
}
