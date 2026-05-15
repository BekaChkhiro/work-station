// T19.14 — Tests for the system-stats IPC wrapper's cloud routing.
//
// The wire-level broadcast is covered by `cargo test` on
// `src-tauri/src/ws/system_monitor.rs`. These tests pin the frontend
// wrapper's choice between the local no-op subscription and the
// cloud-agent's `onSystemStats` listener:
//
//   • Local mode is a stub — the desktop frontend has no local
//     producer to attach to (the desktop is the producer for its
//     embedded WS, not a consumer). The handler must never fire and
//     the wsBridge client must not be touched.
//   • Cloud mode attaches an `onSystemStats` listener and surfaces the
//     camelCased snapshot to the handler. The disposer returned by the
//     bridge must run on `unsubscribe()` so a tab close doesn't leak.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { _resetCloudAgentManagerFactoryForTests, _setCloudAgentManagerForTests } from "./transport";
import type { CloudAgentManager } from "../integrations/cloudAgent";
import type {
  SystemStatsHandler as ClientSystemStatsHandler,
  WsBridgeClient,
} from "../integrations/wsBridge";
import { _resetCloudModeForTests, setCloudMode } from "../stores/cloudMode";
import { subscribeSystemStats } from "./systemStats";

type ManagerState = ReturnType<CloudAgentManager["state"]>;

function makeStubManager(client: WsBridgeClient, state: ManagerState = "open"): CloudAgentManager {
  let currentState = state;
  return {
    state: () => currentState,
    client: () => client,
    endpoint: () => null,
    connect: async () => {
      // Tests pre-seed `open`; a dial is a no-op.
    },
    disconnect: () => {
      currentState = "closed";
    },
    dispose: () => {
      // no-op for the stub
    },
  };
}

interface SystemStatsClientStub {
  onSystemStats: ReturnType<typeof vi.fn>;
  /** Push a frame to the most recently attached handler. */
  emit: (snapshot: Parameters<ClientSystemStatsHandler>[0]) => void;
  detachCount: () => number;
}

function makeClientStub(): SystemStatsClientStub {
  let lastHandler: ClientSystemStatsHandler | null = null;
  let detachCalls = 0;
  const stub: SystemStatsClientStub = {
    onSystemStats: vi.fn((handler: ClientSystemStatsHandler) => {
      lastHandler = handler;
      return () => {
        detachCalls += 1;
      };
    }),
    emit: (snapshot) => {
      if (!lastHandler) throw new Error("no onSystemStats handler registered");
      lastHandler(snapshot);
    },
    detachCount: () => detachCalls,
  };
  return stub;
}

function bindClient(stub: SystemStatsClientStub): WsBridgeClient {
  return stub as unknown as WsBridgeClient;
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

describe("subscribeSystemStats()", () => {
  it("returns a no-op subscription in local mode without touching the cloud client", async () => {
    const stub = makeClientStub();
    _setCloudAgentManagerForTests(makeStubManager(bindClient(stub)));

    const handler = vi.fn();
    const sub = await subscribeSystemStats(handler);

    expect(stub.onSystemStats).not.toHaveBeenCalled();
    // Unsubscribing the local stub is a no-op — must not throw and
    // must not detach a non-existent listener.
    sub.unsubscribe();
    expect(stub.detachCount()).toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it("attaches an onSystemStats listener in cloud mode and forwards snapshots", async () => {
    const stub = makeClientStub();
    _setCloudAgentManagerForTests(makeStubManager(bindClient(stub)));
    await setCloudMode(true);

    const handler = vi.fn();
    await subscribeSystemStats(handler);

    expect(stub.onSystemStats).toHaveBeenCalledTimes(1);

    stub.emit({
      cpuPercent: 12.5,
      ramUsedBytes: 4_000_000,
      ramTotalBytes: 16_000_000,
      ptySessionCount: 3,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({
      cpuPercent: 12.5,
      ramUsedBytes: 4_000_000,
      ramTotalBytes: 16_000_000,
      ptySessionCount: 3,
    });
  });

  it("detaches the bridge listener and ignores late frames after unsubscribe", async () => {
    const stub = makeClientStub();
    _setCloudAgentManagerForTests(makeStubManager(bindClient(stub)));
    await setCloudMode(true);

    const handler = vi.fn();
    const sub = await subscribeSystemStats(handler);

    sub.unsubscribe();
    expect(stub.detachCount()).toBe(1);

    // Even if the bridge re-emits before its detach has propagated, the
    // wrapper's `alive` guard must drop the frame so the consumer never
    // sees post-disposal callbacks.
    stub.emit({
      cpuPercent: 0,
      ramUsedBytes: 0,
      ramTotalBytes: 0,
      ptySessionCount: 0,
    });

    expect(handler).not.toHaveBeenCalled();

    // unsubscribe must be idempotent — a double call from a defensive
    // caller (e.g. effect cleanup + manual teardown) shouldn't blow up.
    expect(() => sub.unsubscribe()).not.toThrow();
  });
});
