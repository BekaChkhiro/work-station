// T12.9 — Targeted tests for the PlanFlow client's notification surface.
//
// We avoid booting the full integration HTTP stack: a stub `fetch` records
// the path the client hits and replies with the JSON each endpoint should
// produce. Coverage is intentionally narrow — just the bits the
// NotificationsBell relies on (unread count, mark-read, list).

import { describe, expect, it, vi } from "vitest";

import { createPlanFlowClient } from "./client";

function makeFetch(
  handler: (input: Request | URL | string, init?: RequestInit) => Response | Promise<Response>,
): typeof fetch {
  return vi.fn(async (input: Request | URL | string, init?: RequestInit) =>
    handler(input, init),
  ) as unknown as typeof fetch;
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/** All PlanFlow success responses come wrapped in `{success: true, data}`.
 *  The helper keeps the test fixtures readable while matching the real
 *  envelope shape parsed by the client. */
function envelope(data: unknown, init?: ResponseInit): Response {
  return jsonResponse({ success: true, data }, init);
}

describe("PlanFlowClient.getUnreadNotificationCount", () => {
  it("returns the parsed count from /notifications/unread-count", async () => {
    const fetchImpl = makeFetch((input) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("https://api.planflow.tools/notifications/unread-count");
      return envelope({ unreadCount: 7 });
    });

    const client = createPlanFlowClient({
      getAuthToken: () => "token-abc",
      fetchImpl,
    });

    await expect(client.getUnreadNotificationCount()).resolves.toBe(7);
  });

  it("rejects when the payload is malformed (count missing)", async () => {
    const fetchImpl = makeFetch(() => envelope({ unread: 3 }));

    const client = createPlanFlowClient({
      getAuthToken: () => "token-abc",
      fetchImpl,
    });

    await expect(client.getUnreadNotificationCount()).rejects.toThrow();
  });
});

describe("PlanFlowClient.listNotifications", () => {
  it("returns the list and surfaces optional fields", async () => {
    const fetchImpl = makeFetch(() =>
      envelope({
        notifications: [
          {
            id: "n-1",
            type: "mention",
            title: "Alice mentioned you on T12.9",
            readAt: null,
            createdAt: "2026-05-11T12:00:00.000Z",
            projectId: "pf-1",
            taskId: "T12.9",
          },
          { id: "n-2", type: "system", title: "Welcome" },
        ],
        unreadCount: 1,
      }),
    );

    const client = createPlanFlowClient({
      getAuthToken: () => "token-abc",
      fetchImpl,
    });

    const list = await client.listNotifications();
    expect(list).toHaveLength(2);
    expect(list[0]?.taskId).toBe("T12.9");
    expect(list[1]?.readAt).toBeUndefined();
  });
});

describe("PlanFlowClient.markNotificationRead", () => {
  it("PATCHes /notifications/:id/read and resolves to void", async () => {
    const calls: { url: string; method: string }[] = [];
    const fetchImpl = makeFetch((input, init) => {
      const url = typeof input === "string" ? input : input.toString();
      calls.push({ url, method: init?.method ?? "GET" });
      return new Response(null, { status: 204 });
    });

    const client = createPlanFlowClient({
      getAuthToken: () => "token-abc",
      fetchImpl,
    });

    await client.markNotificationRead("n-123");
    expect(calls).toEqual([
      { url: "https://api.planflow.tools/notifications/n-123/read", method: "PATCH" },
    ]);
  });

  it("URL-encodes notification ids with slashes / spaces", async () => {
    let observedUrl = "";
    const fetchImpl = makeFetch((input) => {
      observedUrl = typeof input === "string" ? input : input.toString();
      return new Response(null, { status: 204 });
    });

    const client = createPlanFlowClient({
      getAuthToken: () => "token-abc",
      fetchImpl,
    });

    await client.markNotificationRead("a/b c");
    expect(observedUrl).toBe("https://api.planflow.tools/notifications/a%2Fb%20c/read");
  });
});
