// T14.1 — Targeted tests for the GitHub REST client.
//
// Stubs `fetch` directly so we never hit github.com. Each test pins the
// request shape (URL, method, headers) and asserts the response is parsed
// into the right typed value. Coverage is intentionally narrow — we don't
// exercise IntegrationHttpClient's retry / timeout / cache code paths
// (covered by its own suite) — just the GitHub-specific surface.

import { describe, expect, it, vi } from "vitest";

import { createGitHubClient, GITHUB_DEFAULT_BASE_URL } from "./client";
import { GitHubAuthError, GitHubNotFoundError } from "./errors";

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
}

function makeFetch(
  handler: (call: CapturedCall) => Response | Promise<Response>,
  capture?: CapturedCall[],
): typeof fetch {
  return vi.fn(async (input: Request | URL | string, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const headers: Record<string, string> = {};
    const h = new Headers(init?.headers ?? undefined);
    h.forEach((value, key) => {
      headers[key] = value;
    });
    const call: CapturedCall = { url, method: init?.method ?? "GET", headers };
    capture?.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

const REF = { owner: "BekaChkhiro", repo: "work-station" };

describe("GitHubClient.getRepo", () => {
  it("GETs /repos/:owner/:repo with GitHub headers and parses the payload", async () => {
    const calls: CapturedCall[] = [];
    const fetchImpl = makeFetch(
      () =>
        jsonResponse({
          id: 123,
          name: "work-station",
          full_name: "BekaChkhiro/work-station",
          owner: { login: "BekaChkhiro" },
          html_url: "https://github.com/BekaChkhiro/work-station",
          default_branch: "main",
          stargazers_count: 12,
        }),
      calls,
    );

    const client = createGitHubClient({
      getAuthToken: () => "ghp_test",
      fetchImpl,
      defaultRetry: { attempts: 0 },
    });

    const repo = await client.getRepo(REF);
    expect(repo.name).toBe("work-station");
    expect(repo.default_branch).toBe("main");
    expect(repo.stargazers_count).toBe(12);
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(`${GITHUB_DEFAULT_BASE_URL}/repos/BekaChkhiro/work-station`);
    expect(call?.method).toBe("GET");
    expect(call?.headers["accept"]).toBe("application/vnd.github+json");
    expect(call?.headers["x-github-api-version"]).toBe("2022-11-28");
    expect(call?.headers["authorization"]).toBe("Bearer ghp_test");
  });

  it("URL-encodes owner / repo segments", async () => {
    let observed = "";
    const fetchImpl = makeFetch((call) => {
      observed = call.url;
      return jsonResponse({
        id: 1,
        name: "repo with space",
        full_name: "user/x",
        owner: { login: "user" },
        html_url: "https://github.com/user/repo%20with%20space",
        default_branch: "main",
      });
    });

    const client = createGitHubClient({
      getAuthToken: () => "ghp_test",
      fetchImpl,
      defaultRetry: { attempts: 0 },
    });

    await client.getRepo({ owner: "user/x", repo: "repo with space" });
    expect(observed).toBe(`${GITHUB_DEFAULT_BASE_URL}/repos/user%2Fx/repo%20with%20space`);
  });
});

describe("GitHubClient.listCommits", () => {
  it("returns the parsed array of commits and translates options into query params", async () => {
    let observedUrl = "";
    const fetchImpl = makeFetch((call) => {
      observedUrl = call.url;
      return jsonResponse([
        {
          sha: "abc123",
          commit: {
            message: "feat: thing",
            author: { name: "Beka", email: "b@example.com", date: "2026-05-01T00:00:00Z" },
          },
        },
        {
          sha: "def456",
          commit: { message: "fix: bug" },
        },
      ]);
    });

    const client = createGitHubClient({
      getAuthToken: () => "ghp_test",
      fetchImpl,
      defaultRetry: { attempts: 0 },
    });

    const commits = await client.listCommits(REF, {
      branch: "main",
      perPage: 30,
      page: 2,
    });
    expect(commits).toHaveLength(2);
    expect(commits[0]?.sha).toBe("abc123");
    expect(commits[0]?.commit.message).toBe("feat: thing");
    const url = new URL(observedUrl);
    expect(url.pathname).toBe("/repos/BekaChkhiro/work-station/commits");
    expect(url.searchParams.get("sha")).toBe("main");
    expect(url.searchParams.get("per_page")).toBe("30");
    expect(url.searchParams.get("page")).toBe("2");
  });
});

describe("GitHubClient.listBranches", () => {
  it("GETs /branches and parses the array", async () => {
    const fetchImpl = makeFetch(() =>
      jsonResponse([
        { name: "main", commit: { sha: "aaa" }, protected: true },
        { name: "dev", commit: { sha: "bbb" } },
      ]),
    );
    const client = createGitHubClient({
      getAuthToken: () => "ghp_test",
      fetchImpl,
      defaultRetry: { attempts: 0 },
    });
    const branches = await client.listBranches(REF);
    expect(branches.map((b) => b.name)).toEqual(["main", "dev"]);
    expect(branches[0]?.protected).toBe(true);
  });
});

describe("GitHubClient.listPullRequests", () => {
  it("passes state + sort options as query params and parses the array", async () => {
    let observedUrl = "";
    const fetchImpl = makeFetch((call) => {
      observedUrl = call.url;
      return jsonResponse([
        {
          id: 1,
          number: 42,
          state: "open",
          title: "Add T14.1",
          html_url: "https://github.com/BekaChkhiro/work-station/pull/42",
          created_at: "2026-05-10T10:00:00Z",
          head: { ref: "task/T14.1", sha: "head-sha" },
          base: { ref: "master", sha: "base-sha" },
        },
      ]);
    });
    const client = createGitHubClient({
      getAuthToken: () => "ghp_test",
      fetchImpl,
      defaultRetry: { attempts: 0 },
    });
    const prs = await client.listPullRequests(REF, {
      state: "all",
      sort: "updated",
      direction: "desc",
    });
    expect(prs).toHaveLength(1);
    expect(prs[0]?.number).toBe(42);
    expect(prs[0]?.head.ref).toBe("task/T14.1");
    const url = new URL(observedUrl);
    expect(url.searchParams.get("state")).toBe("all");
    expect(url.searchParams.get("sort")).toBe("updated");
    expect(url.searchParams.get("direction")).toBe("desc");
  });
});

describe("GitHubClient.listWorkflowRuns", () => {
  it("hits /actions/runs and unwraps the {workflow_runs} envelope", async () => {
    let observedPath = "";
    const fetchImpl = makeFetch((call) => {
      observedPath = new URL(call.url).pathname;
      return jsonResponse({
        total_count: 2,
        workflow_runs: [
          {
            id: 1,
            name: "CI",
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/BekaChkhiro/work-station/actions/runs/1",
            created_at: "2026-05-10T10:00:00Z",
          },
          {
            id: 2,
            name: "CI",
            status: "in_progress",
            conclusion: null,
            html_url: "https://github.com/BekaChkhiro/work-station/actions/runs/2",
            created_at: "2026-05-11T10:00:00Z",
          },
        ],
      });
    });
    const client = createGitHubClient({
      getAuthToken: () => "ghp_test",
      fetchImpl,
      defaultRetry: { attempts: 0 },
    });
    const runs = await client.listWorkflowRuns(REF);
    expect(observedPath).toBe("/repos/BekaChkhiro/work-station/actions/runs");
    expect(runs).toHaveLength(2);
    expect(runs[0]?.conclusion).toBe("success");
    expect(runs[1]?.status).toBe("in_progress");
  });

  it("targets a specific workflow when workflowId is provided", async () => {
    let observedPath = "";
    const fetchImpl = makeFetch((call) => {
      observedPath = new URL(call.url).pathname;
      return jsonResponse({ workflow_runs: [] });
    });
    const client = createGitHubClient({
      getAuthToken: () => "ghp_test",
      fetchImpl,
      defaultRetry: { attempts: 0 },
    });
    await client.listWorkflowRuns(REF, { workflowId: "ci.yml" });
    expect(observedPath).toBe("/repos/BekaChkhiro/work-station/actions/workflows/ci.yml/runs");
  });
});

describe("GitHubClient error mapping", () => {
  it("translates 401 into GitHubAuthError", async () => {
    const fetchImpl = makeFetch(
      () => new Response(JSON.stringify({ message: "Bad credentials" }), { status: 401 }),
    );
    const client = createGitHubClient({
      getAuthToken: () => "bad-token",
      fetchImpl,
      defaultRetry: { attempts: 0 },
    });
    await expect(client.getRepo(REF)).rejects.toBeInstanceOf(GitHubAuthError);
  });

  it("translates 404 into GitHubNotFoundError", async () => {
    const fetchImpl = makeFetch(
      () => new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
    );
    const client = createGitHubClient({
      getAuthToken: () => "ghp_test",
      fetchImpl,
      defaultRetry: { attempts: 0 },
    });
    await expect(client.getRepo({ owner: "ghost", repo: "no-such" })).rejects.toBeInstanceOf(
      GitHubNotFoundError,
    );
  });

  it("rejects when the payload does not match the schema", async () => {
    const fetchImpl = makeFetch(() => jsonResponse({ totally: "wrong" }));
    const client = createGitHubClient({
      getAuthToken: () => "ghp_test",
      fetchImpl,
      defaultRetry: { attempts: 0 },
    });
    await expect(client.getRepo(REF)).rejects.toThrow(/schema validation/i);
  });
});
