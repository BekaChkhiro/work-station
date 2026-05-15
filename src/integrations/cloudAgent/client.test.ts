// T19.7 — Unit tests for the cloud-agent client manager.
//
// The manager wraps a WsBridgeClient with cloud-mode glue, so the
// tests reuse the same `MockWebSocket` shape as the wsBridge tests
// rather than going through `vi.fn()` for every method. State sources
// are passed as plain accessor closures (no SolidJS reactivity in the
// hot path) so the lifecycle can be driven deterministically.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { createCloudAgentManager, CLOUD_AGENT_AUTH_FAILED_CODE } from "./client";
import type { CloudAgentStatus } from "../../stores/cloudMode";

type Listener = (ev: unknown) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static reset(): void {
    MockWebSocket.instances = [];
  }
  static at(index: number): MockWebSocket {
    const inst = MockWebSocket.instances[index];
    if (!inst) {
      throw new Error(
        `expected MockWebSocket instance #${index}, have ${MockWebSocket.instances.length}`,
      );
    }
    return inst;
  }

  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  sent: string[] = [];

  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onerror: Listener | null = null;
  onclose: Listener | null = null;

  constructor(public readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    if (this.readyState !== MockWebSocket.OPEN) {
      throw new Error(`send on socket in state ${this.readyState}`);
    }
    this.sent.push(data);
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState === MockWebSocket.CLOSED || this.readyState === MockWebSocket.CLOSING) {
      return;
    }
    this.readyState = MockWebSocket.CLOSING;
    queueMicrotask(() => {
      this.readyState = MockWebSocket.CLOSED;
      this.onclose?.({ code, reason, wasClean: true });
    });
  }

  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }
  emitClose(opts: { code?: number; reason?: string; wasClean?: boolean } = {}): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({
      code: opts.code ?? 1006,
      reason: opts.reason ?? "",
      wasClean: opts.wasClean ?? false,
    });
  }
}

class FakeClock {
  private nextId = 1;
  private readonly timers = new Map<number, { fire: () => void; delay: number }>();

  setTimeout = (handler: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { fire: handler, delay: ms });
    return id;
  };
  clearTimeout = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };
}

interface ManagerHarness {
  mode: () => boolean;
  setMode: (v: boolean) => void;
  url: () => string | null;
  setUrl: (v: string | null) => void;
  status: () => CloudAgentStatus;
  setStatus: (v: CloudAgentStatus) => void;
  statusWrites: CloudAgentStatus[];
  tokenLoader: ReturnType<typeof vi.fn<() => Promise<string | null>>>;
  now: () => number;
  advance: (ms: number) => void;
  errors: { context: string; error: Error }[];
  clock: FakeClock;
}

function makeHarness(
  init: {
    mode?: boolean;
    url?: string | null;
    status?: CloudAgentStatus;
    token?: string | null;
  } = {},
): ManagerHarness {
  let mode = init.mode ?? true;
  // Distinguish "field omitted" (use default) from "field explicitly
  // null" (no URL / no token). The nullish-coalescing operator would
  // collapse the second case into the default.
  let url: string | null = "url" in init ? (init.url ?? null) : "wss://agent.example";
  let status: CloudAgentStatus = init.status ?? null;
  let nowValue = 1_000_000;
  const statusWrites: CloudAgentStatus[] = [];
  const tokenResolved: string | null = "token" in init ? (init.token ?? null) : "pair-token";
  const tokenLoader = vi.fn<() => Promise<string | null>>(async () => tokenResolved);
  const errors: { context: string; error: Error }[] = [];
  const clock = new FakeClock();

  return {
    mode: () => mode,
    setMode: (v) => (mode = v),
    url: () => url,
    setUrl: (v) => (url = v),
    status: () => status,
    setStatus: (v) => (status = v),
    statusWrites,
    tokenLoader,
    now: () => nowValue,
    advance: (ms) => (nowValue += ms),
    errors,
    clock,
  };
}

function makeManager(h: ManagerHarness) {
  return createCloudAgentManager({
    modeSource: h.mode,
    urlSource: h.url,
    statusSource: h.status,
    tokenLoader: h.tokenLoader,
    statusSink: async (next) => {
      h.statusWrites.push(next);
      h.setStatus(next);
    },
    now: h.now,
    webSocketImpl: MockWebSocket as unknown as typeof WebSocket,
    setTimeoutImpl: h.clock.setTimeout as never,
    clearTimeoutImpl: h.clock.clearTimeout as never,
    randomFn: () => 0.5,
    onError: (error, context) => h.errors.push({ context, error }),
  });
}

beforeEach(() => {
  MockWebSocket.reset();
});

describe("createCloudAgentManager — initial state", () => {
  it("reports `disabled` when cloud mode is off", () => {
    const h = makeHarness({ mode: false });
    const mgr = makeManager(h);
    expect(mgr.state()).toBe("disabled");
  });

  it("reports `unconfigured` when no URL is set", () => {
    const h = makeHarness({ url: null });
    const mgr = makeManager(h);
    expect(mgr.state()).toBe("unconfigured");
  });

  it("reports `idle` when mode is on and URL is configured", () => {
    const h = makeHarness();
    const mgr = makeManager(h);
    expect(mgr.state()).toBe("idle");
  });
});

describe("createCloudAgentManager — connect()", () => {
  it("appends /ws to a bare origin and dials with the pairing token", async () => {
    const h = makeHarness({ url: "wss://agent.example" });
    const mgr = makeManager(h);
    await mgr.connect();
    expect(MockWebSocket.at(0).url).toBe("wss://agent.example/ws?token=pair-token");
    expect(mgr.endpoint()).toBe("wss://agent.example/ws");
  });

  it("does not double-append /ws when the URL already ends in /ws", async () => {
    const h = makeHarness({ url: "wss://agent.example/ws" });
    const mgr = makeManager(h);
    await mgr.connect();
    expect(MockWebSocket.at(0).url).toBe("wss://agent.example/ws?token=pair-token");
  });

  it("transitions disabled → connecting → open on a clean handshake", async () => {
    const h = makeHarness();
    const mgr = makeManager(h);
    expect(mgr.state()).toBe("idle");
    await mgr.connect();
    expect(mgr.state()).toBe("connecting");
    MockWebSocket.at(0).emitOpen();
    expect(mgr.state()).toBe("open");
  });

  it("publishes `no_token` when the keychain returns null", async () => {
    const h = makeHarness({ token: null });
    const mgr = makeManager(h);
    await mgr.connect();
    expect(mgr.state()).toBe("no_token");
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("publishes `no_token` and surfaces the error when token load throws", async () => {
    const h = makeHarness();
    h.tokenLoader.mockRejectedValueOnce(new Error("keychain locked"));
    const mgr = makeManager(h);
    await mgr.connect();
    expect(mgr.state()).toBe("no_token");
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.context).toBe("pairing token load failed");
  });

  it("is a no-op when cloud mode is off", async () => {
    const h = makeHarness({ mode: false });
    const mgr = makeManager(h);
    await mgr.connect();
    expect(mgr.state()).toBe("disabled");
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(h.tokenLoader).not.toHaveBeenCalled();
  });

  it("is a no-op when URL is missing", async () => {
    const h = makeHarness({ url: null });
    const mgr = makeManager(h);
    await mgr.connect();
    expect(mgr.state()).toBe("unconfigured");
    expect(MockWebSocket.instances).toHaveLength(0);
  });

  it("a second connect() while open does not open a new socket", async () => {
    const h = makeHarness();
    const mgr = makeManager(h);
    await mgr.connect();
    MockWebSocket.at(0).emitOpen();
    await mgr.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  it("a slow token loader from a stale attempt does not clobber a fresh connect", async () => {
    const h = makeHarness();
    let resolveSlow!: (v: string | null) => void;
    h.tokenLoader.mockImplementationOnce(
      () =>
        new Promise<string | null>((r) => {
          resolveSlow = r;
        }),
    );
    const mgr = makeManager(h);
    const first = mgr.connect();
    mgr.disconnect();
    // Now seed a fresh, fast-resolving attempt.
    h.tokenLoader.mockResolvedValueOnce("fresh");
    await mgr.connect();
    // Late resolution from the abandoned attempt must not open a socket.
    resolveSlow("stale");
    await first;
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.at(0).url).toContain("token=fresh");
  });
});

describe("createCloudAgentManager — status updates", () => {
  it("stamps lastHandshakeAt and clears needsRepairAt on a clean open", async () => {
    const h = makeHarness({
      status: { pairedAt: 500_000, needsRepairAt: 600_000 },
    });
    const mgr = makeManager(h);
    await mgr.connect();
    MockWebSocket.at(0).emitOpen();
    expect(h.statusWrites).toHaveLength(1);
    expect(h.statusWrites[0]).toEqual({
      pairedAt: 500_000,
      lastHandshakeAt: 1_000_000,
      needsRepairAt: null,
    });
  });

  it("creates an initial status row when none exists (pairedAt = now())", async () => {
    const h = makeHarness({ status: null });
    const mgr = makeManager(h);
    await mgr.connect();
    MockWebSocket.at(0).emitOpen();
    expect(h.statusWrites[0]).toMatchObject({
      pairedAt: 1_000_000,
      lastHandshakeAt: 1_000_000,
      needsRepairAt: null,
    });
  });

  it("flips needsRepairAt when the agent closes with CLOUD_AGENT_AUTH_FAILED_CODE", async () => {
    const h = makeHarness({ status: { pairedAt: 500_000 } });
    const mgr = makeManager(h);
    await mgr.connect();
    MockWebSocket.at(0).emitOpen();
    h.statusWrites.length = 0;
    h.advance(10_000); // well past the grace window
    MockWebSocket.at(0).emitClose({ code: CLOUD_AGENT_AUTH_FAILED_CODE, reason: "" });
    expect(h.statusWrites).toHaveLength(1);
    expect(h.statusWrites[0]?.needsRepairAt).toBe(1_010_000);
  });

  it("flips needsRepairAt when the close reason mentions auth", async () => {
    const h = makeHarness({ status: { pairedAt: 500_000 } });
    const mgr = makeManager(h);
    await mgr.connect();
    MockWebSocket.at(0).emitOpen();
    h.statusWrites.length = 0;
    h.advance(10_000);
    MockWebSocket.at(0).emitClose({ code: 1008, reason: "invalid token" });
    expect(h.statusWrites[0]?.needsRepairAt).toBe(1_010_000);
  });

  it("treats a close before any open as an auth-shaped failure", async () => {
    const h = makeHarness();
    const mgr = makeManager(h);
    await mgr.connect();
    MockWebSocket.at(0).emitClose({ code: 1006, reason: "" });
    expect(h.statusWrites[0]?.needsRepairAt).toBe(1_000_000);
  });

  it("does not flip needsRepairAt on a long-lived close (normal disconnect)", async () => {
    const h = makeHarness({ status: { pairedAt: 500_000 } });
    const mgr = makeManager(h);
    await mgr.connect();
    MockWebSocket.at(0).emitOpen();
    h.statusWrites.length = 0;
    h.advance(60_000);
    MockWebSocket.at(0).emitClose({ code: 1006, reason: "" });
    // Only the lastHandshakeAt write from the earlier emitOpen() should
    // have happened; close that arrives well after the grace window
    // looks like a transient drop, not auth.
    expect(h.statusWrites).toHaveLength(0);
  });
});

describe("createCloudAgentManager — disconnect()", () => {
  it("closes the active socket and resets to idle when still configured", async () => {
    const h = makeHarness();
    const mgr = makeManager(h);
    await mgr.connect();
    MockWebSocket.at(0).emitOpen();
    mgr.disconnect();
    expect(mgr.client()).toBeNull();
    // Either `closed` (if the socket already fired its close listener
    // synchronously) or `closing` is acceptable; the test only cares
    // that the socket was closed and the manager dropped the handle.
    expect(["closed", "closing"]).toContain(mgr.state());
  });

  it("re-publishes `disabled` when mode flips off via disconnect()", async () => {
    const h = makeHarness();
    const mgr = makeManager(h);
    await mgr.connect();
    h.setMode(false);
    mgr.disconnect();
    expect(mgr.state()).toBe("disabled");
  });

  it("re-publishes `unconfigured` when URL is cleared", async () => {
    const h = makeHarness();
    const mgr = makeManager(h);
    await mgr.connect();
    h.setUrl(null);
    mgr.disconnect();
    expect(mgr.state()).toBe("unconfigured");
  });
});

describe("createCloudAgentManager — dispose()", () => {
  it("stops a connect() that resolves after dispose", async () => {
    const h = makeHarness();
    let resolveToken!: (v: string | null) => void;
    h.tokenLoader.mockImplementationOnce(
      () =>
        new Promise<string | null>((r) => {
          resolveToken = r;
        }),
    );
    const mgr = makeManager(h);
    const pending = mgr.connect();
    mgr.dispose();
    resolveToken("late");
    await pending;
    expect(MockWebSocket.instances).toHaveLength(0);
  });
});
