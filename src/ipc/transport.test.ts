// T19.6 — Tests for the IPC transport routing layer.
//
// The routing layer's only job is to pick between two backends and
// hand the right one back. We exercise that choice plus the
// edge cases around the cloud branch: settled-but-unavailable
// manager states, timeout while waiting for `open`, and the
// per-call test seams that bypass the global singleton.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setCloudMode, _resetCloudModeForTests } from "../stores/cloudMode";
import type { CloudAgentManager } from "../integrations/cloudAgent";
import type { WsBridgeClient } from "../integrations/wsBridge";
import {
  awaitCloudClient,
  CloudTransportUnavailableError,
  CloudTransportUnsupportedError,
  currentTransport,
  getCloudAgentManager,
  routeIpc,
  routeIpcLocalOnly,
  _resetCloudAgentManagerFactoryForTests,
  _setCloudAgentManagerFactoryForTests,
  _setCloudAgentManagerForTests,
} from "./transport";

type ManagerState = ReturnType<CloudAgentManager["state"]>;

interface StubManager extends CloudAgentManager {
  setState: (next: ManagerState) => void;
  setClient: (client: WsBridgeClient | null) => void;
  connectCount: number;
  disposeCount: number;
}

function makeStubManager(initial?: {
  state?: ManagerState;
  client?: WsBridgeClient | null;
}): StubManager {
  let state: ManagerState = initial?.state ?? "idle";
  let client: WsBridgeClient | null = initial?.client ?? null;
  const mgr: StubManager = {
    state: () => state,
    client: () => client,
    endpoint: () => null,
    connect: async () => {
      mgr.connectCount += 1;
    },
    disconnect: () => {
      state = "closed";
    },
    dispose: () => {
      mgr.disposeCount += 1;
    },
    setState: (next) => {
      state = next;
    },
    setClient: (next) => {
      client = next;
    },
    connectCount: 0,
    disposeCount: 0,
  };
  return mgr;
}

function makeStubClient(): WsBridgeClient {
  // Only the identity matters in the routing tests; never invoked.
  return { kind: "stub" } as unknown as WsBridgeClient;
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

describe("currentTransport()", () => {
  it("reads as 'local' when cloud mode is off", () => {
    expect(currentTransport()).toBe("local");
  });

  it("flips to 'cloud' when cloud mode is on", async () => {
    await setCloudMode(true);
    expect(currentTransport()).toBe("cloud");
  });
});

describe("routeIpc()", () => {
  it("invokes the local branch when cloud mode is off (default signal)", async () => {
    const local = vi.fn(async () => "local-result");
    const cloud = vi.fn(async () => "cloud-result");

    const result = await routeIpc(local, cloud);

    expect(result).toBe("local-result");
    expect(local).toHaveBeenCalledTimes(1);
    expect(cloud).not.toHaveBeenCalled();
  });

  it("invokes the cloud branch with the resolved client when cloud mode is on", async () => {
    const client = makeStubClient();
    const cloud = vi.fn(async (c: WsBridgeClient) => {
      expect(c).toBe(client);
      return "cloud-result";
    });

    const result = await routeIpc(
      async () => {
        throw new Error("local branch should not run when cloud mode is on");
      },
      cloud,
      {
        mode: () => true,
        clientLoader: async () => client,
      },
    );

    expect(result).toBe("cloud-result");
    expect(cloud).toHaveBeenCalledTimes(1);
  });

  it("propagates errors thrown by the cloud branch", async () => {
    const client = makeStubClient();
    const failure = new Error("RPC failed");

    await expect(
      routeIpc(
        async () => "unused",
        async () => {
          throw failure;
        },
        { mode: () => true, clientLoader: async () => client },
      ),
    ).rejects.toBe(failure);
  });

  it("does not call clientLoader in local mode (lazy)", async () => {
    const clientLoader = vi.fn(async () => makeStubClient());
    await routeIpc(
      async () => "local",
      async () => "cloud",
      { mode: () => false, clientLoader },
    );
    expect(clientLoader).not.toHaveBeenCalled();
  });

  it("falls back to the global cloudMode signal when no override is given", async () => {
    const mgr = makeStubManager({ state: "open", client: makeStubClient() });
    _setCloudAgentManagerForTests(mgr);
    await setCloudMode(true);

    const result = await routeIpc(
      async () => "local",
      async () => "cloud",
    );
    expect(result).toBe("cloud");
  });
});

describe("routeIpcLocalOnly()", () => {
  it("calls through in local mode", async () => {
    const result = await routeIpcLocalOnly("fs_list_dir", async () => "ok");
    expect(result).toBe("ok");
  });

  it("throws CloudTransportUnsupportedError in cloud mode", async () => {
    await expect(
      routeIpcLocalOnly("fs_list_dir", async () => "ok", { mode: () => true }),
    ).rejects.toBeInstanceOf(CloudTransportUnsupportedError);
  });

  it("includes the operation name in the error message", async () => {
    let caught: unknown;
    try {
      await routeIpcLocalOnly("read_text_file", async () => "ok", { mode: () => true });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CloudTransportUnsupportedError);
    expect((caught as Error).message).toContain("read_text_file");
  });
});

describe("awaitCloudClient() — settled verdicts", () => {
  it("rejects immediately when the manager reports `disabled`", async () => {
    const mgr = makeStubManager({ state: "disabled" });
    await expect(awaitCloudClient({ manager: mgr })).rejects.toMatchObject({
      name: "CloudTransportUnavailableError",
      reason: "mode_off",
    });
    expect(mgr.connectCount).toBe(0);
  });

  it("rejects immediately when the manager reports `unconfigured`", async () => {
    const mgr = makeStubManager({ state: "unconfigured" });
    await expect(awaitCloudClient({ manager: mgr })).rejects.toMatchObject({
      reason: "unconfigured",
    });
  });

  it("rejects immediately when the manager reports `no_token`", async () => {
    const mgr = makeStubManager({ state: "no_token" });
    await expect(awaitCloudClient({ manager: mgr })).rejects.toMatchObject({
      reason: "no_token",
    });
  });

  it("rejects immediately when the manager reports `closed`", async () => {
    const mgr = makeStubManager({ state: "closed" });
    await expect(awaitCloudClient({ manager: mgr })).rejects.toMatchObject({
      reason: "closed",
    });
  });

  it("returns the client directly when state is already `open`", async () => {
    const client = makeStubClient();
    const mgr = makeStubManager({ state: "open", client });
    await expect(awaitCloudClient({ manager: mgr })).resolves.toBe(client);
    expect(mgr.connectCount).toBe(0);
  });
});

describe("awaitCloudClient() — pending state", () => {
  it("dials the manager when state is `idle`", async () => {
    const client = makeStubClient();
    const mgr = makeStubManager({ state: "idle" });

    const setTimeoutImpl = vi.fn((handler: () => void) => {
      // Drive the poll synchronously: flip the manager open before the
      // next tick fires.
      mgr.setState("open");
      mgr.setClient(client);
      handler();
      return 0;
    });
    const clearTimeoutImpl = vi.fn();
    const result = await awaitCloudClient({
      manager: mgr,
      timeoutMs: 1_000,
      setTimeoutImpl,
      clearTimeoutImpl,
      nowFn: () => 0,
    });

    expect(result).toBe(client);
    expect(mgr.connectCount).toBe(1);
  });

  it("times out when the manager never opens", async () => {
    const mgr = makeStubManager({ state: "connecting" });
    let scheduled = 0;
    let nowValue = 0;
    const setTimeoutImpl = (handler: () => void) => {
      scheduled += 1;
      // Advance the simulated clock past the timeout before firing.
      nowValue = 2_000;
      handler();
      return scheduled;
    };
    const clearTimeoutImpl = vi.fn();

    await expect(
      awaitCloudClient({
        manager: mgr,
        timeoutMs: 1_000,
        setTimeoutImpl,
        clearTimeoutImpl,
        nowFn: () => nowValue,
      }),
    ).rejects.toMatchObject({ reason: "timeout" });
  });

  it("rejects with the appropriate verdict if the manager settles mid-wait", async () => {
    const mgr = makeStubManager({ state: "connecting" });
    const setTimeoutImpl = (handler: () => void) => {
      mgr.setState("no_token");
      handler();
      return 0;
    };
    const clearTimeoutImpl = vi.fn();
    await expect(
      awaitCloudClient({
        manager: mgr,
        timeoutMs: 1_000,
        setTimeoutImpl,
        clearTimeoutImpl,
        nowFn: () => 0,
      }),
    ).rejects.toMatchObject({ reason: "no_token" });
  });
});

describe("getCloudAgentManager()", () => {
  it("returns the same instance on repeat calls (singleton)", () => {
    const stub = makeStubManager();
    _setCloudAgentManagerFactoryForTests(() => stub);
    const first = getCloudAgentManager();
    const second = getCloudAgentManager();
    expect(first).toBe(second);
    expect(first).toBe(stub);
  });

  it("uses the test override when supplied", () => {
    const stub = makeStubManager();
    _setCloudAgentManagerForTests(stub);
    expect(getCloudAgentManager()).toBe(stub);
  });
});

describe("CloudTransportUnavailableError", () => {
  it("carries a structured reason for diagnostics", () => {
    const err = new CloudTransportUnavailableError("boom", "timeout");
    expect(err.name).toBe("CloudTransportUnavailableError");
    expect(err.reason).toBe("timeout");
    expect(err.message).toBe("boom");
  });
});
