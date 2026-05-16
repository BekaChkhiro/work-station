// T19.13 — Tests for PlanFlow Tasks cloud routing.
//
// Pin the local-vs-cloud choice each PlanFlowClient method makes when
// `routeViaCloudAgent: true` (the renderer factory's default). Verifier
// and Settings-panel call sites use the bare `createPlanFlowClient` —
// that path is already covered by the existing client.test.ts and
// stays HTTP-only here too (no fetch / no cloud client involvement).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetCloudAgentManagerFactoryForTests,
  _setCloudAgentManagerForTests,
} from "../../ipc/transport";
import type { CloudAgentManager } from "../cloudAgent";
import type { WsBridgeClient } from "../wsBridge";
import { _resetCloudModeForTests, setCloudMode } from "../../stores/cloudMode";
import { createPlanFlowClient } from "./client";

type ManagerState = ReturnType<CloudAgentManager["state"]>;

interface StubManager extends CloudAgentManager {
  setState(next: ManagerState): void;
}

function makeStubManager(client: WsBridgeClient, state: ManagerState = "open"): StubManager {
  let currentState = state;
  let disposed = false;
  return {
    state: () => currentState,
    client: () => client,
    endpoint: () => null,
    connect: async () => {
      return;
    },
    disconnect: () => {
      currentState = "closed";
    },
    dispose: () => {
      disposed = true;
    },
    setState: (next) => {
      if (disposed) return;
      currentState = next;
    },
  };
}

/**
 * Build a PlanFlowClient with `routeViaCloudAgent: true` (mirrors what
 * `createRendererPlanFlowClient` does) and a fetch stub that flags any
 * accidental HTTP fall-through in cloud mode. The default fetch returns
 * a 500 so a missed cloud branch is impossible to mistake for success.
 */
function makeRoutedClient(
  fetchImpl: typeof fetch = vi.fn(
    async () => new Response("unexpected http call", { status: 500 }),
  ) as unknown as typeof fetch,
) {
  return createPlanFlowClient({
    getAuthToken: () => "tok",
    fetchImpl,
    routeViaCloudAgent: true,
    defaultRetry: { attempts: 0 },
  });
}

beforeEach(() => {
  _setCloudAgentManagerForTests(null);
  _resetCloudAgentManagerFactoryForTests();
  _resetCloudModeForTests();
});

afterEach(() => {
  _setCloudAgentManagerForTests(null);
  _resetCloudAgentManagerFactoryForTests();
  _resetCloudModeForTests();
});

describe("PlanFlow Tasks routing — local mode", () => {
  it("listTasks hits HTTP and never touches the cloud client", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, data: { tasks: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const planflowListTasks = vi.fn();
    _setCloudAgentManagerForTests(
      makeStubManager({ planflowListTasks } as unknown as WsBridgeClient),
    );

    const client = makeRoutedClient(fetchImpl);
    await expect(client.listTasks("p1")).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(planflowListTasks).not.toHaveBeenCalled();
  });
});

describe("PlanFlow Tasks routing — cloud mode", () => {
  beforeEach(async () => {
    await setCloudMode(true);
  });

  it("listTasks routes to cloud client and re-validates through taskListSchema", async () => {
    const planflowListTasks = vi.fn(async () => ({
      tasks: [
        {
          id: "u-1",
          taskId: "T1.1",
          name: "hi",
          status: "TODO",
        },
      ],
    }));
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    _setCloudAgentManagerForTests(
      makeStubManager({ planflowListTasks } as unknown as WsBridgeClient),
    );

    const client = makeRoutedClient(fetchImpl);
    const result = await client.listTasks("p1", { status: "TODO" });

    expect(planflowListTasks).toHaveBeenCalledWith("p1", "TODO", undefined);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result).toHaveLength(1);
    expect(result[0]?.taskId).toBe("T1.1");
  });

  it("listTasks joins an array status filter with commas", async () => {
    const planflowListTasks = vi.fn(async () => ({ tasks: [] }));
    _setCloudAgentManagerForTests(
      makeStubManager({ planflowListTasks } as unknown as WsBridgeClient),
    );

    const client = makeRoutedClient();
    await client.listTasks("p1", { status: ["TODO", "IN_PROGRESS"] });
    expect(planflowListTasks).toHaveBeenCalledWith("p1", "TODO,IN_PROGRESS", undefined);
  });

  it("getMe routes to planflowGetMe and unwraps the user", async () => {
    const planflowGetMe = vi.fn(async () => ({
      user: { id: "u1", email: "a@b.c", name: "Alice" },
    }));
    _setCloudAgentManagerForTests(makeStubManager({ planflowGetMe } as unknown as WsBridgeClient));

    const client = makeRoutedClient();
    await expect(client.getMe()).resolves.toEqual({
      id: "u1",
      email: "a@b.c",
      name: "Alice",
    });
  });

  it("listActiveWork routes and adapts the wire entry shape to ActiveWorkUser", async () => {
    const planflowListActiveWork = vi.fn(async () => ({
      projectId: "p1",
      activeWork: [
        {
          taskId: "T1.1",
          userId: "u-1",
          userEmail: "a@b.c",
          userName: "Alice",
          startedAt: "2026-05-15T00:00:00Z",
        },
      ],
    }));
    _setCloudAgentManagerForTests(
      makeStubManager({ planflowListActiveWork } as unknown as WsBridgeClient),
    );

    const client = makeRoutedClient();
    const result = await client.listActiveWork("p1");
    expect(planflowListActiveWork).toHaveBeenCalledWith("p1", undefined);
    expect(result).toEqual([
      {
        user: { id: "u-1", email: "a@b.c", name: "Alice" },
        taskId: "T1.1",
        startedAt: "2026-05-15T00:00:00Z",
      },
    ]);
  });

  it("listComments routes and returns the parsed comments array", async () => {
    const planflowListComments = vi.fn(async () => ({
      comments: [{ id: "c1", body: "hi" }],
    }));
    _setCloudAgentManagerForTests(
      makeStubManager({ planflowListComments } as unknown as WsBridgeClient),
    );

    const client = makeRoutedClient();
    const result = await client.listComments("p1", "T1.1");
    expect(planflowListComments).toHaveBeenCalledWith("p1", "T1.1", undefined);
    expect(result[0]?.body).toBe("hi");
  });

  it("createComment forwards body verbatim and returns the parsed comment", async () => {
    const planflowCreateComment = vi.fn(async () => ({
      comment: { id: "c1", body: "hello" },
    }));
    _setCloudAgentManagerForTests(
      makeStubManager({ planflowCreateComment } as unknown as WsBridgeClient),
    );

    const client = makeRoutedClient();
    const result = await client.createComment("p1", "T1.1", { body: "hello" });
    expect(planflowCreateComment).toHaveBeenCalledWith("p1", "T1.1", "hello", undefined);
    expect(result.body).toBe("hello");
  });

  it("startWorking routes to planflowStartWork", async () => {
    const planflowStartWork = vi.fn(async () => undefined);
    _setCloudAgentManagerForTests(
      makeStubManager({ planflowStartWork } as unknown as WsBridgeClient),
    );

    const client = makeRoutedClient();
    await client.startWorking("p1", "T1.1");
    expect(planflowStartWork).toHaveBeenCalledWith("p1", "T1.1", undefined);
  });

  it("stopWorking routes to planflowStopWork", async () => {
    const planflowStopWork = vi.fn(async () => undefined);
    _setCloudAgentManagerForTests(
      makeStubManager({ planflowStopWork } as unknown as WsBridgeClient),
    );

    const client = makeRoutedClient();
    await client.stopWorking("p1");
    expect(planflowStopWork).toHaveBeenCalledWith("p1", undefined);
  });

  it("updateTaskStatus forwards the human-readable taskId to the cloud-agent (which resolves to UUID server-side)", async () => {
    const planflowUpdateTaskStatus = vi.fn(async () => ({
      tasks: [{ id: "uuid-abc", taskId: "T1.1", name: "hi", status: "IN_PROGRESS" }],
    }));
    const planflowListTasks = vi.fn();
    _setCloudAgentManagerForTests(
      makeStubManager({
        planflowUpdateTaskStatus,
        planflowListTasks,
      } as unknown as WsBridgeClient),
    );

    const client = makeRoutedClient();
    const result = await client.updateTaskStatus("p1", "T1.1", "IN_PROGRESS");
    expect(planflowUpdateTaskStatus).toHaveBeenCalledWith("p1", "T1.1", "IN_PROGRESS", undefined);
    expect(planflowListTasks).not.toHaveBeenCalled();
    expect(result?.status).toBe("IN_PROGRESS");
  });
});

// T19.35 — When the renderer scopes a client to a workspace projectId,
// every routed planflow_* call must ship it as `cloud_project_id` so the
// cloud-agent's per-project token resolver (T19.34) picks the right
// PlanFlow account.
describe("PlanFlow Tasks routing — cloud_project_id passthrough (T19.35)", () => {
  beforeEach(async () => {
    await setCloudMode(true);
  });

  function makeScopedClient(bridge: Partial<WsBridgeClient>, cloudProjectId = "ws-proj-1") {
    _setCloudAgentManagerForTests(makeStubManager(bridge as unknown as WsBridgeClient));
    return createPlanFlowClient({
      getAuthToken: () => "tok",
      fetchImpl: vi.fn(
        async () => new Response("nope", { status: 500 }),
      ) as unknown as typeof fetch,
      routeViaCloudAgent: true,
      cloudProjectId,
      defaultRetry: { attempts: 0 },
    });
  }

  it("listTasks forwards cloud_project_id", async () => {
    const planflowListTasks = vi.fn(async () => ({ tasks: [] }));
    const client = makeScopedClient({ planflowListTasks });
    await client.listTasks("plan-proj-1", { status: "TODO" });
    expect(planflowListTasks).toHaveBeenCalledWith("plan-proj-1", "TODO", "ws-proj-1");
  });

  it("startWorking forwards cloud_project_id", async () => {
    const planflowStartWork = vi.fn(async () => undefined);
    const client = makeScopedClient({ planflowStartWork });
    await client.startWorking("plan-proj-1", "T1.1");
    expect(planflowStartWork).toHaveBeenCalledWith("plan-proj-1", "T1.1", "ws-proj-1");
  });

  it("updateTaskStatus forwards cloud_project_id", async () => {
    const planflowUpdateTaskStatus = vi.fn(async () => ({
      tasks: [{ id: "u-1", taskId: "T1.1", name: "x", status: "IN_PROGRESS" }],
    }));
    const client = makeScopedClient({ planflowUpdateTaskStatus });
    await client.updateTaskStatus("plan-proj-1", "T1.1", "IN_PROGRESS");
    expect(planflowUpdateTaskStatus).toHaveBeenCalledWith(
      "plan-proj-1",
      "T1.1",
      "IN_PROGRESS",
      "ws-proj-1",
    );
  });

  it("getMe forwards cloud_project_id", async () => {
    const planflowGetMe = vi.fn(async () => ({
      user: { id: "u1", email: "a@b.c", name: "Alice" },
    }));
    const client = makeScopedClient({ planflowGetMe });
    await client.getMe();
    expect(planflowGetMe).toHaveBeenCalledWith("ws-proj-1");
  });
});

describe("PlanFlow Tasks routing — non-routed methods stay HTTP", () => {
  it("listChanges always uses fetch even when routeViaCloudAgent is true", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, data: { changes: [] } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    await setCloudMode(true);
    // Stub a cloud client that would throw if used — it shouldn't be
    // touched by `listChanges` because there is no cloud-agent
    // counterpart for the changes feed.
    const stubClient = new Proxy(
      {},
      {
        get() {
          throw new Error("cloud client should not be invoked for listChanges");
        },
      },
    ) as unknown as WsBridgeClient;
    _setCloudAgentManagerForTests(makeStubManager(stubClient));

    const client = makeRoutedClient(fetchImpl);
    await expect(client.listChanges("p1")).resolves.toMatchObject({ changes: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
