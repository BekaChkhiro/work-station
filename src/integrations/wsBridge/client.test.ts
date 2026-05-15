// T18.8 — Unit tests for the reconnecting WebSocket bridge client.
//
// `MockWebSocket` is a deliberately bare-bones replacement: it captures
// sent frames so tests can read them back, exposes `emitMessage` /
// `emitClose` / `emitError` to drive the lifecycle deterministically, and
// transitions through `readyState` like a real browser implementation.
// `FakeClock` is a minimal setTimeout shim so reconnect tests don't have
// to wait wall-clock seconds.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  WsBridgeClient,
  WsBridgeClosedError,
  WsBridgeError,
  WsBridgeServerError,
  WsPlanflowError,
  type ConnectionState,
} from "./client";
import { encodeBase64 } from "./base64";

type Listener = (ev: unknown) => void;

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static reset(): void {
    MockWebSocket.instances = [];
  }
  /** Test helper: index-safe access for noUncheckedIndexedAccess. */
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

  // Test helpers
  emitOpen(): void {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.({});
  }
  emitMessage(data: string): void {
    this.onmessage?.({ data });
  }
  emitError(): void {
    this.onerror?.({});
  }
  emitClose(opts: { code?: number; reason?: string; wasClean?: boolean } = {}): void {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.({
      code: opts.code ?? 1006,
      reason: opts.reason ?? "",
      wasClean: opts.wasClean ?? false,
    });
  }

  /** Convenience: parse the n-th frame the client `send()`-ed on this socket. */
  parseSent<T = Record<string, unknown>>(index: number): T {
    const raw = this.sent[index];
    if (raw === undefined) {
      throw new Error(`socket has no sent frame #${index} (sent=${this.sent.length})`);
    }
    return JSON.parse(raw) as T;
  }

  /** Parse every captured frame in order. */
  parseAllSent<T = Record<string, unknown>>(): T[] {
    return this.sent.map((f) => JSON.parse(f) as T);
  }
}

beforeEach(() => {
  MockWebSocket.reset();
  (globalThis as { WebSocket?: unknown }).WebSocket = MockWebSocket;
});

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
  flush(): void {
    // Fire every currently-scheduled timer, in insertion order. We don't
    // re-enter to drain timers scheduled by fired handlers — tests call
    // `flush` again as needed so each transition is observable.
    const snapshot = Array.from(this.timers.entries());
    this.timers.clear();
    for (const [, t] of snapshot) t.fire();
  }
  pending(): number {
    return this.timers.size;
  }
}

interface FrameWithId {
  type: string;
  id?: string;
  session_id?: string;
  command?: string;
  cols?: number;
  data?: string;
}

function makeClient(overrides: Partial<ConstructorParameters<typeof WsBridgeClient>[0]> = {}) {
  const clock = new FakeClock();
  const stateLog: ConnectionState[] = [];
  const client = new WsBridgeClient({
    url: "ws://127.0.0.1:7420/ws",
    token: "secret",
    setTimeoutImpl: clock.setTimeout as never,
    clearTimeoutImpl: clock.clearTimeout as never,
    randomFn: () => 0.5,
    onStateChange: (s) => stateLog.push(s),
    ...overrides,
  });
  return { client, clock, stateLog };
}

describe("WsBridgeClient — connect / auth URL", () => {
  it("appends the bearer token to the URL as a query param", () => {
    const { client } = makeClient();
    client.connect();
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.at(0).url).toBe("ws://127.0.0.1:7420/ws?token=secret");
  });

  it("preserves existing query params when appending the token", () => {
    const { client } = makeClient({ url: "ws://host:1234/ws?foo=1" });
    client.connect();
    expect(MockWebSocket.at(0).url).toBe("ws://host:1234/ws?foo=1&token=secret");
  });

  it("URL-encodes tokens with special characters", () => {
    const { client } = makeClient({ token: "a b/c=" });
    client.connect();
    expect(MockWebSocket.at(0).url).toBe("ws://127.0.0.1:7420/ws?token=a%20b%2Fc%3D");
  });

  it("transitions through connecting -> open", () => {
    const { client, stateLog } = makeClient();
    client.connect();
    expect(stateLog).toContain("connecting");
    MockWebSocket.at(0).emitOpen();
    expect(client.state).toBe("open");
  });
});

describe("WsBridgeClient — request/response correlation", () => {
  it("pty_spawn resolves with the session id from the matching reply", async () => {
    const { client } = makeClient();
    client.connect();
    MockWebSocket.at(0).emitOpen();

    const pending = client.ptySpawn({ command: "bash", cols: 80, rows: 24 });

    const sent = MockWebSocket.at(0).parseSent<FrameWithId>(0);
    expect(sent.type).toBe("pty_spawn");
    expect(typeof sent.id).toBe("string");
    expect(sent.command).toBe("bash");
    expect(sent.cols).toBe(80);

    MockWebSocket.at(0).emitMessage(
      JSON.stringify({
        type: "pty_spawned",
        id: sent.id,
        session_id: "00000000-0000-0000-0000-000000000001",
      }),
    );

    await expect(pending).resolves.toEqual({
      sessionId: "00000000-0000-0000-0000-000000000001",
    });
  });

  it("rejects with WsBridgeServerError when the server returns pty_error", async () => {
    const { client } = makeClient();
    client.connect();
    MockWebSocket.at(0).emitOpen();

    const pending = client.ptyKill("session-1");
    const sent = MockWebSocket.at(0).parseSent<FrameWithId>(0);
    MockWebSocket.at(0).emitMessage(
      JSON.stringify({
        type: "pty_error",
        id: sent.id,
        kind: "no_such_session",
        message: "unknown session-1",
      }),
    );

    await expect(pending).rejects.toBeInstanceOf(WsBridgeServerError);
    await expect(pending).rejects.toMatchObject({ kind: "no_such_session" });
  });

  it("rejects all pending requests with WsBridgeClosedError when the socket drops", async () => {
    const { client } = makeClient({ autoReconnect: false });
    client.connect();
    MockWebSocket.at(0).emitOpen();
    const pending = client.ptyKill("s1");
    MockWebSocket.at(0).emitClose({});
    await expect(pending).rejects.toBeInstanceOf(WsBridgeClosedError);
  });

  it("rejects a request issued before connect() with WsBridgeClosedError", async () => {
    const { client } = makeClient();
    await expect(client.ptyKill("s1")).rejects.toBeInstanceOf(WsBridgeClosedError);
  });
});

describe("WsBridgeClient — output / exit listeners", () => {
  it("decodes base64 pty_output frames and fans them out", () => {
    const { client } = makeClient();
    client.connect();
    MockWebSocket.at(0).emitOpen();

    const calls: { data: Uint8Array; sessionId: string }[] = [];
    client.onPtyOutput((data, sessionId) => calls.push({ data, sessionId }));

    const payload = encodeBase64(new Uint8Array([0x68, 0x69])); // "hi"
    MockWebSocket.at(0).emitMessage(
      JSON.stringify({ type: "pty_output", session_id: "s1", data: payload }),
    );

    expect(calls).toHaveLength(1);
    const first = calls[0];
    expect(first).toBeDefined();
    if (!first) return;
    expect(Array.from(first.data)).toEqual([0x68, 0x69]);
    expect(first.sessionId).toBe("s1");
  });

  it("delivers pty_exit frames to subscribers", () => {
    const { client } = makeClient();
    client.connect();
    MockWebSocket.at(0).emitOpen();
    const exits: string[] = [];
    client.onPtyExit((sid) => exits.push(sid));
    MockWebSocket.at(0).emitMessage(JSON.stringify({ type: "pty_exit", session_id: "s2" }));
    expect(exits).toEqual(["s2"]);
  });

  it("disposers stop the handler from firing on subsequent frames", () => {
    const { client } = makeClient();
    client.connect();
    MockWebSocket.at(0).emitOpen();
    const seen: number[] = [];
    const dispose = client.onPtyOutput((data) => seen.push(data.byteLength));
    MockWebSocket.at(0).emitMessage(
      JSON.stringify({
        type: "pty_output",
        session_id: "s1",
        data: encodeBase64(new Uint8Array([1, 2, 3])),
      }),
    );
    dispose();
    MockWebSocket.at(0).emitMessage(
      JSON.stringify({
        type: "pty_output",
        session_id: "s1",
        data: encodeBase64(new Uint8Array([4])),
      }),
    );
    expect(seen).toEqual([3]);
  });
});

describe("WsBridgeClient — reconnect", () => {
  it("schedules reconnect attempts with exponential backoff", () => {
    const onReconnecting = vi.fn();
    const { client, clock } = makeClient({
      reconnect: { initialDelayMs: 100, factor: 2, jitter: 0, maxDelayMs: 10_000 },
      onReconnecting,
    });
    client.connect();
    MockWebSocket.at(0).emitOpen();

    // First drop -> 100ms.
    MockWebSocket.at(0).emitClose({});
    expect(onReconnecting).toHaveBeenLastCalledWith(1, 100);
    clock.flush();
    expect(MockWebSocket.instances).toHaveLength(2);

    // Second drop without an intervening open -> 200ms.
    MockWebSocket.at(1).emitClose({});
    expect(onReconnecting).toHaveBeenLastCalledWith(2, 200);
    clock.flush();

    // Third -> 400ms.
    MockWebSocket.at(2).emitClose({});
    expect(onReconnecting).toHaveBeenLastCalledWith(3, 400);
  });

  it("caps the delay at maxDelayMs", () => {
    const onReconnecting = vi.fn();
    const { client, clock } = makeClient({
      reconnect: { initialDelayMs: 1000, factor: 10, jitter: 0, maxDelayMs: 5_000 },
      onReconnecting,
    });
    client.connect();
    MockWebSocket.at(0).emitOpen();
    MockWebSocket.at(0).emitClose({});
    clock.flush();
    MockWebSocket.at(1).emitClose({}); // would be 10s, capped to 5s
    expect(onReconnecting).toHaveBeenLastCalledWith(2, 5_000);
  });

  it("resets attempt counter after a successful reconnect", () => {
    const onReconnecting = vi.fn();
    const { client, clock } = makeClient({
      reconnect: { initialDelayMs: 100, factor: 2, jitter: 0, maxDelayMs: 10_000 },
      onReconnecting,
    });
    client.connect();
    MockWebSocket.at(0).emitOpen();
    MockWebSocket.at(0).emitClose({});
    clock.flush();
    MockWebSocket.at(1).emitOpen();
    MockWebSocket.at(1).emitClose({});
    // After a successful open, the counter should reset, so the next delay
    // is 100ms again — not the 200ms that would follow if state persisted.
    expect(onReconnecting).toHaveBeenLastCalledWith(1, 100);
  });

  it("stops attempting after maxAttempts is exhausted", () => {
    const onReconnecting = vi.fn();
    const { client, clock } = makeClient({
      reconnect: { initialDelayMs: 1, factor: 1, jitter: 0, maxDelayMs: 10, maxAttempts: 2 },
      onReconnecting,
    });
    client.connect();
    MockWebSocket.at(0).emitOpen();
    MockWebSocket.at(0).emitClose({});
    clock.flush();
    MockWebSocket.at(1).emitClose({});
    clock.flush();
    // Third drop should NOT schedule another attempt.
    MockWebSocket.at(2).emitClose({});
    expect(onReconnecting).toHaveBeenCalledTimes(2);
    expect(client.state).toBe("closed");
  });

  it("does not reconnect when autoReconnect is false", () => {
    const { client, clock } = makeClient({ autoReconnect: false });
    client.connect();
    MockWebSocket.at(0).emitOpen();
    MockWebSocket.at(0).emitClose({});
    expect(clock.pending()).toBe(0);
    expect(client.state).toBe("closed");
  });

  it("does not reconnect after manual close()", () => {
    const { client, clock } = makeClient();
    client.connect();
    MockWebSocket.at(0).emitOpen();
    client.close();
    MockWebSocket.at(0).emitClose({ wasClean: true });
    expect(clock.pending()).toBe(0);
    expect(client.state).toBe("closed");
  });

  it("re-subscribes to active sessions after reconnect", async () => {
    const { client, clock } = makeClient({
      reconnect: { initialDelayMs: 10, factor: 1, jitter: 0, maxDelayMs: 10 },
    });
    client.connect();
    MockWebSocket.at(0).emitOpen();

    // Subscribe to two sessions on the original socket. Ack each one so
    // the request promise resolves and the session is committed to the
    // tracked-subscribers set.
    const sub1 = client.ptySubscribe("sess-a");
    const sub2 = client.ptySubscribe("sess-b");
    const sentA = MockWebSocket.at(0).parseSent<FrameWithId>(0);
    const sentB = MockWebSocket.at(0).parseSent<FrameWithId>(1);
    MockWebSocket.at(0).emitMessage(JSON.stringify({ type: "pty_ack", id: sentA.id }));
    MockWebSocket.at(0).emitMessage(JSON.stringify({ type: "pty_ack", id: sentB.id }));
    await sub1;
    await sub2;

    // Drop and reconnect.
    MockWebSocket.at(0).emitClose({});
    clock.flush();
    MockWebSocket.at(1).emitOpen();

    // The new socket should have received two pty_subscribe frames for the
    // previously-attached sessions, with no correlation id (these are
    // fire-and-forget re-attach frames — the server doesn't track ids).
    const replayed = MockWebSocket.at(1).parseAllSent<FrameWithId>();
    expect(replayed).toHaveLength(2);
    expect(replayed.map((f) => f.session_id).sort()).toEqual(["sess-a", "sess-b"]);
    expect(replayed.every((f) => f.type === "pty_subscribe")).toBe(true);
    expect(replayed.every((f) => f.id === undefined)).toBe(true);
  });

  it("removes a session from the resubscribe set after ptyUnsubscribe", async () => {
    const { client, clock } = makeClient({
      reconnect: { initialDelayMs: 10, factor: 1, jitter: 0, maxDelayMs: 10 },
    });
    client.connect();
    MockWebSocket.at(0).emitOpen();

    const sub = client.ptySubscribe("sess-a");
    const subscribeFrame = MockWebSocket.at(0).parseSent<FrameWithId>(0);
    MockWebSocket.at(0).emitMessage(JSON.stringify({ type: "pty_ack", id: subscribeFrame.id }));
    await sub;

    const unsub = client.ptyUnsubscribe("sess-a");
    const unsubscribeFrame = MockWebSocket.at(0).parseSent<FrameWithId>(1);
    MockWebSocket.at(0).emitMessage(JSON.stringify({ type: "pty_ack", id: unsubscribeFrame.id }));
    await unsub;

    MockWebSocket.at(0).emitClose({});
    clock.flush();
    MockWebSocket.at(1).emitOpen();
    expect(MockWebSocket.at(1).sent).toHaveLength(0);
  });
});

describe("WsBridgeClient — wire encoding", () => {
  it("ptyWrite base64-encodes the payload", async () => {
    const { client } = makeClient();
    client.connect();
    MockWebSocket.at(0).emitOpen();
    const pending = client.ptyWrite("s1", new Uint8Array([0x68, 0x69]));
    const frame = MockWebSocket.at(0).parseSent<FrameWithId>(0);
    expect(frame.type).toBe("pty_write");
    expect(frame.session_id).toBe("s1");
    expect(frame.data).toBe("aGk=");
    MockWebSocket.at(0).emitMessage(JSON.stringify({ type: "pty_ack", id: frame.id }));
    await pending;
  });

  it("ptyScrollback decodes the chunk and returns metadata", async () => {
    const { client } = makeClient();
    client.connect();
    MockWebSocket.at(0).emitOpen();
    const pending = client.ptyScrollback("s1", 0, 1024);
    const frame = MockWebSocket.at(0).parseSent<FrameWithId>(0);
    MockWebSocket.at(0).emitMessage(
      JSON.stringify({
        type: "pty_scrollback_chunk",
        id: frame.id,
        session_id: "s1",
        data: encodeBase64(new Uint8Array([0x41, 0x42])),
        total_bytes: 2,
        next_offset: 2,
      }),
    );
    const result = await pending;
    expect(Array.from(result.data)).toEqual([0x41, 0x42]);
    expect(result.totalBytes).toBe(2);
    expect(result.nextOffset).toBe(2);
  });

  it("ptyWrite is a no-op for an empty Uint8Array", async () => {
    const { client } = makeClient();
    client.connect();
    MockWebSocket.at(0).emitOpen();
    await client.ptyWrite("s1", new Uint8Array());
    expect(MockWebSocket.at(0).sent).toHaveLength(0);
  });
});

describe("WsBridgeClient — projects + settings (T19.9)", () => {
  it("projectsList sends the request and resolves with the project array", async () => {
    const { client } = makeClient();
    client.connect();
    MockWebSocket.at(0).emitOpen();

    const pending = client.projectsList();
    const frame = MockWebSocket.at(0).parseSent<FrameWithId>(0);
    expect(frame.type).toBe("projects_list");

    const projects = [
      {
        id: "p1",
        name: "alpha",
        path: "/p",
        position: 0,
        createdAt: 0,
      },
    ];
    MockWebSocket.at(0).emitMessage(
      JSON.stringify({ type: "projects_list_result", id: frame.id, projects }),
    );

    await expect(pending).resolves.toEqual(projects);
  });

  it("projectSwitch rejects with WsBridgeError when the server returns `error`", async () => {
    const { client } = makeClient();
    client.connect();
    MockWebSocket.at(0).emitOpen();

    const pending = client.projectSwitch("ghost");
    const frame = MockWebSocket.at(0).parseSent<FrameWithId>(0);
    expect(frame.type).toBe("project_switch");

    MockWebSocket.at(0).emitMessage(
      JSON.stringify({
        type: "error",
        id: frame.id,
        kind: "not_found",
        message: "project not found: ghost",
      }),
    );

    await expect(pending).rejects.toBeInstanceOf(WsBridgeError);
    await expect(pending).rejects.toMatchObject({ kind: "not_found" });
  });

  it("settingsGet resolves with the settings view", async () => {
    const { client } = makeClient();
    client.connect();
    MockWebSocket.at(0).emitOpen();

    const pending = client.settingsGet();
    const frame = MockWebSocket.at(0).parseSent<FrameWithId>(0);

    MockWebSocket.at(0).emitMessage(
      JSON.stringify({
        type: "settings_result",
        id: frame.id,
        settings: { theme: "dark", lastActiveProject: "p1" },
      }),
    );

    await expect(pending).resolves.toEqual({ theme: "dark", lastActiveProject: "p1" });
  });

  it("onActiveProjectChanged fires on server-initiated events without a correlation id", () => {
    const { client } = makeClient();
    client.connect();
    MockWebSocket.at(0).emitOpen();

    const seen: (string | null)[] = [];
    const dispose = client.onActiveProjectChanged((id) => seen.push(id));

    MockWebSocket.at(0).emitMessage(
      JSON.stringify({ type: "active_project_changed", project_id: "p7" }),
    );
    MockWebSocket.at(0).emitMessage(
      JSON.stringify({ type: "active_project_changed", project_id: null }),
    );
    dispose();
    MockWebSocket.at(0).emitMessage(
      JSON.stringify({ type: "active_project_changed", project_id: "p8" }),
    );

    expect(seen).toEqual(["p7", null]);
  });

  it("projectsList rejects with a protocol error when the server replies with a wrong frame", async () => {
    const { client } = makeClient();
    client.connect();
    MockWebSocket.at(0).emitOpen();
    const pending = client.projectsList();
    const frame = MockWebSocket.at(0).parseSent<FrameWithId>(0);
    // The server should never resolve a `projects_list` request with
    // `pty_ack`, but the client guards against the case anyway so a
    // protocol drift surfaces with a clear error instead of a hung
    // promise.
    MockWebSocket.at(0).emitMessage(JSON.stringify({ type: "pty_ack", id: frame.id }));
    await expect(pending).rejects.toBeInstanceOf(WsBridgeError);
  });
});

describe("WsBridgeClient — PlanFlow Tasks bridge (T19.13)", () => {
  it("planflowListTasks sends `planflow_list_tasks` and returns the unwrapped data payload", async () => {
    const { client } = makeClient();
    client.connect();
    MockWebSocket.at(0).emitOpen();

    const pending = client.planflowListTasks("p1");
    const frame = MockWebSocket.at(0).parseSent<FrameWithId & { project_id?: string }>(0);
    expect(frame.type).toBe("planflow_list_tasks");
    expect(frame.project_id).toBe("p1");
    expect(frame).not.toHaveProperty("status");

    const data = { tasks: [{ id: "u-1", taskId: "T1.1", name: "hi", status: "TODO" }] };
    MockWebSocket.at(0).emitMessage(
      JSON.stringify({ type: "planflow_result", id: frame.id, data }),
    );
    await expect(pending).resolves.toEqual(data);
  });

  it("planflowListTasks forwards the optional status filter", async () => {
    const { client } = makeClient();
    client.connect();
    MockWebSocket.at(0).emitOpen();

    void client.planflowListTasks("p1", "TODO");
    const frame = MockWebSocket.at(0).parseSent<
      FrameWithId & { project_id?: string; status?: string }
    >(0);
    expect(frame.status).toBe("TODO");
  });

  it("planflowStartWork resolves with void on a planflow_result frame", async () => {
    const { client } = makeClient();
    client.connect();
    MockWebSocket.at(0).emitOpen();

    const pending = client.planflowStartWork("p1", "T1.1");
    const frame = MockWebSocket.at(0).parseSent<FrameWithId>(0);
    expect(frame.type).toBe("planflow_start_work");

    MockWebSocket.at(0).emitMessage(
      JSON.stringify({ type: "planflow_result", id: frame.id, data: null }),
    );
    await expect(pending).resolves.toBeUndefined();
  });

  it("planflow_error rejects with WsPlanflowError carrying kind and status", async () => {
    const { client } = makeClient();
    client.connect();
    MockWebSocket.at(0).emitOpen();

    const pending = client.planflowGetMe();
    const frame = MockWebSocket.at(0).parseSent<FrameWithId>(0);
    MockWebSocket.at(0).emitMessage(
      JSON.stringify({
        type: "planflow_error",
        id: frame.id,
        kind: "unauthorized",
        message: "bad token",
        status: 401,
      }),
    );

    await expect(pending).rejects.toBeInstanceOf(WsPlanflowError);
    await expect(pending).rejects.toMatchObject({ kind: "unauthorized", status: 401 });
  });

  it("planflowCreateComment forwards body verbatim (server adapts to `content`)", async () => {
    const { client } = makeClient();
    client.connect();
    MockWebSocket.at(0).emitOpen();

    void client.planflowCreateComment("p1", "T1.1", "hello");
    const frame = MockWebSocket.at(0).parseSent<
      FrameWithId & { project_id?: string; task_id?: string; body?: string }
    >(0);
    expect(frame.type).toBe("planflow_create_comment");
    expect(frame.body).toBe("hello");
    expect(frame).not.toHaveProperty("content");
  });
});
