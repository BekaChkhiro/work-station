// T14.1 — Thin REST wrapper over GitHub's v3 API.
//
// Mirrors the PlanFlow client's structure (createIntegrationHttpClient
// inside, parse via zod schemas, mapHttpError → typed errors) but skips
// two things PlanFlow needs and GitHub doesn't:
//
//   - No success envelope. GitHub responses are raw payloads.
//   - No IPC routing. GitHub has no cloud-agent counterpart, so every
//     call is HTTP regardless of cloud mode.
//
// Spec'd methods (PROJECT_PLAN T14.1): getRepo, listCommits, listBranches,
// listPullRequests, listWorkflowRuns. The shared `IntegrationHttpClient`
// already handles auth, retries on 5xx, 429 surfacing, timeout, and the
// optional reauth hook — we layer GitHub-specific parsing on top.

import type { ZodType } from "zod";

import {
  createIntegrationHttpClient,
  IntegrationHttpClient,
  type IntegrationCacheStore,
  type RetryOptions,
} from "../httpClient";
import type { IntegrationId } from "../credentials";
import { markNeedsReauth, runWithReauthGuard } from "../reauth";
import { GitHubParseError, mapGitHubHttpError } from "./errors";
import {
  githubBranchListSchema,
  githubCommitListSchema,
  githubPullRequestListSchema,
  githubRepoSchema,
  githubWorkflowRunListSchema,
  type GitHubBranch,
  type GitHubCommit,
  type GitHubPullRequest,
  type GitHubPullRequestState,
  type GitHubRepo,
  type GitHubWorkflowRun,
} from "./schemas";

export const GITHUB_DEFAULT_BASE_URL = "https://api.github.com";

/** Headers GitHub's REST API expects on every request. The Accept and
 *  API-version pair lets the server route the request to the stable
 *  2022-11-28 schema even when the platform rolls a new default. */
const GITHUB_DEFAULT_HEADERS: Record<string, string> = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
};

export interface GitHubClientOptions {
  baseUrl?: string;
  getAuthToken: () => string | null | Promise<string | null>;
  fetchImpl?: typeof fetch;
  cacheStore?: IntegrationCacheStore;
  defaultTimeoutMs?: number;
  defaultRetry?: RetryOptions;
  /** T11.8 — wire the reauth guard so a 401/403 flips the GitHub
   *  integration into `needs_reauth` and surfaces the Reconnect banner.
   *  Verifier clients should leave this unset so a bad-token check
   *  doesn't trip the global state. */
  reauthIntegration?: IntegrationId;
}

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface ListCommitsOptions {
  /** Branch / tag / SHA to list commits from. Defaults to the repo's
   *  default branch on the server side. */
  branch?: string;
  path?: string;
  author?: string;
  since?: string;
  until?: string;
  perPage?: number;
  page?: number;
  cacheTtlMs?: number;
}

export interface ListBranchesOptions {
  perPage?: number;
  page?: number;
  cacheTtlMs?: number;
}

export interface ListPullRequestsOptions {
  state?: GitHubPullRequestState | "all";
  /** `head` filter is the GitHub-flavoured `user:branch` qualifier. */
  head?: string;
  base?: string;
  sort?: "created" | "updated" | "popularity" | "long-running";
  direction?: "asc" | "desc";
  perPage?: number;
  page?: number;
  cacheTtlMs?: number;
}

export interface ListWorkflowRunsOptions {
  /** Filter to a specific workflow (id or filename like `ci.yml`). When
   *  omitted, runs across all workflows are returned. */
  workflowId?: number | string;
  branch?: string;
  event?: string;
  status?: string;
  perPage?: number;
  page?: number;
  cacheTtlMs?: number;
}

export class GitHubClient {
  readonly #http: IntegrationHttpClient;
  readonly #reauthIntegration: IntegrationId | null;

  constructor(options: GitHubClientOptions) {
    this.#reauthIntegration = options.reauthIntegration ?? null;
    const reauthIntegration = this.#reauthIntegration;
    this.#http = createIntegrationHttpClient({
      service: "github",
      baseUrl: options.baseUrl ?? GITHUB_DEFAULT_BASE_URL,
      getAuthToken: options.getAuthToken,
      fetchImpl: options.fetchImpl,
      cacheStore: options.cacheStore,
      defaultHeaders: GITHUB_DEFAULT_HEADERS,
      defaultTimeoutMs: options.defaultTimeoutMs,
      defaultRetry: options.defaultRetry,
      onAuthFailure:
        reauthIntegration == null
          ? undefined
          : async () => {
              await markNeedsReauth(reauthIntegration);
            },
    });
  }

  async getRepo(ref: RepoRef, cacheTtlMs?: number): Promise<GitHubRepo> {
    return this.#get(repoPath(ref), githubRepoSchema, { cacheTtlMs });
  }

  async listCommits(ref: RepoRef, options: ListCommitsOptions = {}): Promise<GitHubCommit[]> {
    const query: Record<string, string | number> = {};
    if (options.branch != null) query["sha"] = options.branch;
    if (options.path != null) query["path"] = options.path;
    if (options.author != null) query["author"] = options.author;
    if (options.since != null) query["since"] = options.since;
    if (options.until != null) query["until"] = options.until;
    if (options.perPage != null) query["per_page"] = options.perPage;
    if (options.page != null) query["page"] = options.page;
    return this.#get(`${repoPath(ref)}/commits`, githubCommitListSchema, {
      query,
      cacheTtlMs: options.cacheTtlMs,
    });
  }

  async listBranches(ref: RepoRef, options: ListBranchesOptions = {}): Promise<GitHubBranch[]> {
    const query: Record<string, string | number> = {};
    if (options.perPage != null) query["per_page"] = options.perPage;
    if (options.page != null) query["page"] = options.page;
    return this.#get(`${repoPath(ref)}/branches`, githubBranchListSchema, {
      query,
      cacheTtlMs: options.cacheTtlMs,
    });
  }

  async listPullRequests(
    ref: RepoRef,
    options: ListPullRequestsOptions = {},
  ): Promise<GitHubPullRequest[]> {
    const query: Record<string, string | number> = {};
    if (options.state != null) query["state"] = options.state;
    if (options.head != null) query["head"] = options.head;
    if (options.base != null) query["base"] = options.base;
    if (options.sort != null) query["sort"] = options.sort;
    if (options.direction != null) query["direction"] = options.direction;
    if (options.perPage != null) query["per_page"] = options.perPage;
    if (options.page != null) query["page"] = options.page;
    return this.#get(`${repoPath(ref)}/pulls`, githubPullRequestListSchema, {
      query,
      cacheTtlMs: options.cacheTtlMs,
    });
  }

  async listWorkflowRuns(
    ref: RepoRef,
    options: ListWorkflowRunsOptions = {},
  ): Promise<GitHubWorkflowRun[]> {
    const query: Record<string, string | number> = {};
    if (options.branch != null) query["branch"] = options.branch;
    if (options.event != null) query["event"] = options.event;
    if (options.status != null) query["status"] = options.status;
    if (options.perPage != null) query["per_page"] = options.perPage;
    if (options.page != null) query["page"] = options.page;
    const base = repoPath(ref);
    const path =
      options.workflowId != null
        ? `${base}/actions/workflows/${encodeURIComponent(String(options.workflowId))}/runs`
        : `${base}/actions/runs`;
    const payload = await this.#get(path, githubWorkflowRunListSchema, {
      query,
      cacheTtlMs: options.cacheTtlMs,
    });
    return payload.workflow_runs;
  }

  async #get<T>(
    path: string,
    schema: ZodType<T>,
    options: { query?: Record<string, string | number>; cacheTtlMs?: number } = {},
  ): Promise<T> {
    return this.#request(path, schema, {
      method: "GET",
      query: options.query,
      cacheTtlMs: options.cacheTtlMs,
    });
  }

  async #request<T>(
    path: string,
    schema: ZodType<T>,
    options: {
      method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
      query?: Record<string, string | number>;
      json?: unknown;
      cacheTtlMs?: number;
      responseType?: "json" | "void";
    },
  ): Promise<T> {
    const responseType = options.responseType ?? "json";
    const exec = async (): Promise<T> => {
      try {
        return await this.#http.request<T>(path, {
          method: options.method,
          query: options.query,
          json: options.json,
          cacheTtlMs: options.cacheTtlMs,
          responseType,
          parse:
            responseType === "json" ? (value) => parseWithSchema(schema, path, value) : undefined,
        });
      } catch (error) {
        mapGitHubHttpError(error);
      }
    };
    if (this.#reauthIntegration == null) return exec();
    return runWithReauthGuard(this.#reauthIntegration, exec);
  }
}

export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  return new GitHubClient(options);
}

function repoPath(ref: RepoRef): string {
  return `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
}

function parseWithSchema<T>(schema: ZodType<T>, path: string, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new GitHubParseError(path, parsed.error);
}
