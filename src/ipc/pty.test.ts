// T19.10 — Tests for the PTY IPC wrappers' cloud routing.
//
// The local Tauri side is exercised by `cargo test` on
// `src-tauri/src/commands/pty.rs`. These tests pin the choice each
// wrapper makes between the local `invoke` path and the cloud-agent's
// wsBridge methods, plus the quirks that don't fall out of routeIpc
// for free:
//
//   • `ptySpawn` replays `startupCommands` as sequential writes on the
//     cloud branch (the wsBridge protocol doesn't carry them).
//   • `ptyWrite` short-circuits zero-byte payloads before routing so
//     neither backend sees an empty frame.
//   • `ptySubscribe` doesn't go through `routeIpc` (it has its own
//     reactive shape) — the local branch uses a Tauri Channel, the
//     cloud branch attaches an `onPtyOutput` listener and issues
//     `pty_subscribe` over the WebSocket.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => {
  class FakeChannel<T> {
    public onmessage: ((payload: T) => void) | null = null;
    constructor(handler: (payload: T) => void) {
      this.onmessage = handler;
    }
  }
  return {
    invoke: vi.fn(),
    Channel: FakeChannel,
  };
});

import { Channel, invoke } from "@tauri-apps/api/core";
import { _resetCloudAgentManagerFactoryForTests, _setCloudAgentManagerForTests } from "./transport";
import type { CloudAgentManager } from "../integrations/cloudAgent";
import type { OutputHandler, PtyScrollbackChunk, WsBridgeClient } from "../integrations/wsBridge";
import { _resetCloudModeForTests, setCloudMode } from "../stores/cloudMode";
import { ptyGetScrollback, ptyKill, ptyResize, ptySpawn, ptySubscribe, ptyWrite } from "./pty";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

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

interface PtyClientStub {
  ptySpawn: ReturnType<typeof vi.fn>;
  ptyWrite: ReturnType<typeof vi.fn>;
  ptyKill: ReturnType<typeof vi.fn>;
  ptyResize: ReturnType<typeof vi.fn>;
  ptyScrollback: ReturnType<typeof vi.fn>;
  ptySubscribe: ReturnType<typeof vi.fn>;
  ptyUnsubscribe: ReturnType<typeof vi.fn>;
  onPtyOutput: ReturnType<typeof vi.fn>;
  /** Captured handler from the most recent `onPtyOutput` registration. */
  emitOutput: (data: Uint8Array, sessionId: string) => void;
  /** Number of times the latest `onPtyOutput` disposer was invoked. */
  detachCount: () => number;
}

function makeClientStub(): PtyClientStub {
  let lastHandler: OutputHandler | null = null;
  let detachCalls = 0;
  const stub: PtyClientStub = {
    ptySpawn: vi.fn(async () => ({ sessionId: "remote-1" })),
    ptyWrite: vi.fn(async () => undefined),
    ptyKill: vi.fn(async () => undefined),
    ptyResize: vi.fn(async () => undefined),
    ptyScrollback: vi.fn(
      async (): Promise<PtyScrollbackChunk> => ({
        data: new Uint8Array([1, 2, 3]),
        totalBytes: 3,
        nextOffset: 3,
      }),
    ),
    ptySubscribe: vi.fn(async () => undefined),
    ptyUnsubscribe: vi.fn(async () => undefined),
    onPtyOutput: vi.fn((handler: OutputHandler) => {
      lastHandler = handler;
      return () => {
        detachCalls += 1;
      };
    }),
    emitOutput: (data, sessionId) => {
      if (!lastHandler) throw new Error("no onPtyOutput handler registered");
      lastHandler(data, sessionId);
    },
    detachCount: () => detachCalls,
  };
  return stub;
}

function bindClient(stub: PtyClientStub): WsBridgeClient {
  return stub as unknown as WsBridgeClient;
}

const TAURI_FLAG = "__TAURI_INTERNALS__";

function installTauriRuntime(): void {
  // The pty wrappers detect the Tauri runtime via `__TAURI_INTERNALS__`.
  // Tests run under happy-dom so we have a real `window` but no Tauri
  // by default — flag it so the local branches actually call `invoke`.
  (window as unknown as Record<string, unknown>)[TAURI_FLAG] = {};
}

function uninstallTauriRuntime(): void {
  Reflect.deleteProperty(window as unknown as Record<string, unknown>, TAURI_FLAG);
}

beforeEach(() => {
  invokeMock.mockReset();
  _setCloudAgentManagerForTests(null);
  _resetCloudAgentManagerFactoryForTests();
  _resetCloudModeForTests();
});

afterEach(() => {
  uninstallTauriRuntime();
  _setCloudAgentManagerForTests(null);
  _resetCloudAgentManagerFactoryForTests();
  _resetCloudModeForTests();
});

describe("ptySpawn()", () => {
  it("invokes `pty_spawn` with the full args payload in local mode", async () => {
    installTauriRuntime();
    invokeMock.mockResolvedValueOnce({ sessionId: "local-1" });

    const result = await ptySpawn({
      command: "/bin/bash",
      args: ["-l"],
      cwd: "/tmp",
      env: { FOO: "bar" },
      cols: 80,
      rows: 24,
    });

    expect(invokeMock).toHaveBeenCalledWith("pty_spawn", {
      args: {
        command: "/bin/bash",
        args: ["-l"],
        cwd: "/tmp",
        env: { FOO: "bar" },
        cols: 80,
        rows: 24,
      },
    });
    expect(result.sessionId).toBe("local-1");
  });

  it("routes through the cloud client without `startupCommands`", async () => {
    const stub = makeClientStub();
    _setCloudAgentManagerForTests(makeStubManager(bindClient(stub)));
    await setCloudMode(true);

    const result = await ptySpawn({
      command: "/bin/bash",
      args: ["-l"],
      cwd: "/tmp",
      env: { FOO: "bar" },
      cols: 80,
      rows: 24,
    });

    expect(stub.ptySpawn).toHaveBeenCalledWith({
      command: "/bin/bash",
      args: ["-l"],
      cwd: "/tmp",
      env: { FOO: "bar" },
      cols: 80,
      rows: 24,
    });
    expect(stub.ptyWrite).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.sessionId).toBe("remote-1");
  });

  it("replays non-empty `startupCommands` as cloud writes after spawn", async () => {
    const stub = makeClientStub();
    _setCloudAgentManagerForTests(makeStubManager(bindClient(stub)));
    await setCloudMode(true);

    await ptySpawn({
      command: "/bin/bash",
      cols: 80,
      rows: 24,
      startupCommands: ["echo hi", "  ", "", "ls -la"],
    });

    // Empty / whitespace-only lines are skipped; the others are sent
    // verbatim with a trailing newline so the shell evaluates them.
    expect(stub.ptyWrite).toHaveBeenCalledTimes(2);
    expect(stub.ptyWrite).toHaveBeenNthCalledWith(1, "remote-1", "echo hi\n");
    expect(stub.ptyWrite).toHaveBeenNthCalledWith(2, "remote-1", "ls -la\n");
  });

  it("doesn't run the cloud branch when cloud mode is off", async () => {
    installTauriRuntime();
    invokeMock.mockResolvedValueOnce({ sessionId: "local-2" });
    const stub = makeClientStub();
    _setCloudAgentManagerForTests(makeStubManager(bindClient(stub)));

    await ptySpawn({ command: "sh", cols: 80, rows: 24 });

    expect(stub.ptySpawn).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledTimes(1);
  });
});

describe("ptyWrite()", () => {
  it("invokes `pty_write` with the bytes serialised as a number array in local mode", async () => {
    installTauriRuntime();
    invokeMock.mockResolvedValueOnce(undefined);

    await ptyWrite("sess-1", new Uint8Array([65, 66, 67]));

    expect(invokeMock).toHaveBeenCalledWith("pty_write", {
      args: { sessionId: "sess-1", data: [65, 66, 67] },
    });
  });

  it("forwards the bytes to the cloud client in cloud mode", async () => {
    const stub = makeClientStub();
    _setCloudAgentManagerForTests(makeStubManager(bindClient(stub)));
    await setCloudMode(true);

    const payload = new Uint8Array([1, 2, 3]);
    await ptyWrite("sess-1", payload);

    expect(stub.ptyWrite).toHaveBeenCalledWith("sess-1", payload);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("short-circuits empty payloads in both modes", async () => {
    installTauriRuntime();
    await ptyWrite("sess-1", new Uint8Array());
    expect(invokeMock).not.toHaveBeenCalled();

    const stub = makeClientStub();
    _setCloudAgentManagerForTests(makeStubManager(bindClient(stub)));
    await setCloudMode(true);
    await ptyWrite("sess-1", new Uint8Array());
    expect(stub.ptyWrite).not.toHaveBeenCalled();
  });

  it("is a no-op in local mode when the Tauri runtime is unavailable", async () => {
    // happy-dom has no `__TAURI_INTERNALS__` by default; the wrapper
    // should silently swallow the write rather than crash on the
    // missing invoke surface.
    await ptyWrite("sess-1", new Uint8Array([1]));
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("ptyKill()", () => {
  it("invokes `pty_kill` in local mode", async () => {
    installTauriRuntime();
    invokeMock.mockResolvedValueOnce(undefined);
    await ptyKill("sess-1");
    expect(invokeMock).toHaveBeenCalledWith("pty_kill", { args: { sessionId: "sess-1" } });
  });

  it("routes through the cloud client in cloud mode", async () => {
    const stub = makeClientStub();
    _setCloudAgentManagerForTests(makeStubManager(bindClient(stub)));
    await setCloudMode(true);
    await ptyKill("sess-1");
    expect(stub.ptyKill).toHaveBeenCalledWith("sess-1");
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("ptyResize()", () => {
  it("invokes `pty_resize` with cols + rows in local mode", async () => {
    installTauriRuntime();
    invokeMock.mockResolvedValueOnce(undefined);
    await ptyResize("sess-1", 132, 50);
    expect(invokeMock).toHaveBeenCalledWith("pty_resize", {
      args: { sessionId: "sess-1", cols: 132, rows: 50 },
    });
  });

  it("forwards the resize over the cloud client", async () => {
    const stub = makeClientStub();
    _setCloudAgentManagerForTests(makeStubManager(bindClient(stub)));
    await setCloudMode(true);
    await ptyResize("sess-1", 100, 30);
    expect(stub.ptyResize).toHaveBeenCalledWith("sess-1", 100, 30);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("ptyGetScrollback()", () => {
  it("returns the full snapshot from `pty_get_scrollback` in local mode", async () => {
    installTauriRuntime();
    invokeMock.mockResolvedValueOnce({
      data: [10, 20, 30],
      totalBytes: 3,
      nextOffset: 3,
    });

    const result = await ptyGetScrollback("sess-1");

    expect(invokeMock).toHaveBeenCalledWith("pty_get_scrollback", {
      args: {
        sessionId: "sess-1",
        offsetBytes: 0,
        limitBytes: Number.MAX_SAFE_INTEGER,
      },
    });
    expect(Array.from(result.data)).toEqual([10, 20, 30]);
    expect(result.totalBytes).toBe(3);
  });

  it("returns an empty snapshot when the Tauri runtime is unavailable in local mode", async () => {
    const result = await ptyGetScrollback("sess-1");
    expect(result.totalBytes).toBe(0);
    expect(result.data.byteLength).toBe(0);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("requests the full buffer from the cloud client", async () => {
    const stub = makeClientStub();
    _setCloudAgentManagerForTests(makeStubManager(bindClient(stub)));
    await setCloudMode(true);

    const result = await ptyGetScrollback("sess-1");

    expect(stub.ptyScrollback).toHaveBeenCalledWith("sess-1", 0, Number.MAX_SAFE_INTEGER);
    expect(Array.from(result.data)).toEqual([1, 2, 3]);
    expect(result.totalBytes).toBe(3);
  });
});

describe("ptySubscribe() — local", () => {
  it("returns a no-op subscription when the Tauri runtime is unavailable", async () => {
    const onChunk = vi.fn();
    const sub = await ptySubscribe("sess-1", onChunk);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(() => sub.unsubscribe()).not.toThrow();
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("attaches a Tauri Channel that forwards binary frames to the handler", async () => {
    installTauriRuntime();
    invokeMock.mockResolvedValueOnce(undefined);
    const onChunk = vi.fn();

    const sub = await ptySubscribe("sess-1", onChunk);

    expect(invokeMock).toHaveBeenCalledWith(
      "pty_subscribe",
      expect.objectContaining({
        args: { sessionId: "sess-1" },
        onData: expect.any(Channel),
      }),
    );

    const channel = invokeMock.mock.calls[0]?.[1] as { onData: Channel<unknown> };
    const onmessage = (channel.onData as unknown as { onmessage: (p: unknown) => void }).onmessage;

    const payload = new ArrayBuffer(3);
    new Uint8Array(payload).set([7, 8, 9]);
    onmessage(payload);

    expect(onChunk).toHaveBeenCalledTimes(1);
    const delivered = onChunk.mock.calls[0]?.[0] as Uint8Array;
    expect(Array.from(delivered)).toEqual([7, 8, 9]);

    // Empty frames are filtered so consumers never see a zero-length view.
    onmessage(new ArrayBuffer(0));
    expect(onChunk).toHaveBeenCalledTimes(1);

    // After unsubscribe the Channel callback drops frames silently.
    sub.unsubscribe();
    onmessage(new ArrayBuffer(2));
    expect(onChunk).toHaveBeenCalledTimes(1);
  });
});

describe("ptySubscribe() — cloud", () => {
  it("attaches an onPtyOutput handler and issues `pty_subscribe` over the bridge", async () => {
    const stub = makeClientStub();
    _setCloudAgentManagerForTests(makeStubManager(bindClient(stub)));
    await setCloudMode(true);
    const onChunk = vi.fn();

    const sub = await ptySubscribe("sess-1", onChunk);

    expect(stub.onPtyOutput).toHaveBeenCalledTimes(1);
    expect(stub.ptySubscribe).toHaveBeenCalledWith("sess-1");

    // Frames for the subscribed session flow through.
    stub.emitOutput(new Uint8Array([1, 2, 3]), "sess-1");
    expect(onChunk).toHaveBeenCalledTimes(1);
    expect(Array.from(onChunk.mock.calls[0]?.[0] as Uint8Array)).toEqual([1, 2, 3]);

    // Frames for other sessions are ignored.
    stub.emitOutput(new Uint8Array([9, 9]), "other");
    expect(onChunk).toHaveBeenCalledTimes(1);

    // Empty frames are filtered.
    stub.emitOutput(new Uint8Array(), "sess-1");
    expect(onChunk).toHaveBeenCalledTimes(1);

    // Unsubscribe drops the handler, detaches the listener, and posts
    // an unsubscribe RPC.
    sub.unsubscribe();
    expect(stub.detachCount()).toBe(1);
    expect(stub.ptyUnsubscribe).toHaveBeenCalledWith("sess-1");

    stub.emitOutput(new Uint8Array([4, 5]), "sess-1");
    expect(onChunk).toHaveBeenCalledTimes(1);
  });

  it("cleans up the listener if `pty_subscribe` fails", async () => {
    const stub = makeClientStub();
    stub.ptySubscribe.mockRejectedValueOnce(new Error("RPC failed"));
    _setCloudAgentManagerForTests(makeStubManager(bindClient(stub)));
    await setCloudMode(true);
    const onChunk = vi.fn();

    await expect(ptySubscribe("sess-1", onChunk)).rejects.toThrow("RPC failed");

    expect(stub.detachCount()).toBe(1);
    // The handler is detached, so even if the bridge somehow still
    // emits a frame it must not reach the caller.
    stub.emitOutput(new Uint8Array([1]), "sess-1");
    expect(onChunk).not.toHaveBeenCalled();
  });

  it("swallows errors from the unsubscribe RPC so disposers don't throw", async () => {
    const stub = makeClientStub();
    stub.ptyUnsubscribe.mockRejectedValueOnce(new Error("ws closed"));
    _setCloudAgentManagerForTests(makeStubManager(bindClient(stub)));
    await setCloudMode(true);

    const sub = await ptySubscribe("sess-1", vi.fn());

    expect(() => sub.unsubscribe()).not.toThrow();
    // Let the swallowed rejection settle so it doesn't leak into the
    // next test's unhandled-rejection bucket.
    await Promise.resolve();
  });
});
