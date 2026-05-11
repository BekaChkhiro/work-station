// T11.9 — Unit tests for writeQueue.ts
//
// Mocks `@tauri-apps/api/core` invoke and the Toast showToast helper so we
// never touch the real Tauri runtime or the DOM.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

// -- Module-level mocks -------------------------------------------------------

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("../components/Toast", () => ({
  showToast: vi.fn(),
}));

// Also mock offline.ts so installAutoReplay doesn't depend on real signals
vi.mock("./offline", () => ({
  onReconnect: vi.fn(() => vi.fn()),
}));

// -- Test helpers -------------------------------------------------------------

import { invoke } from "@tauri-apps/api/core";
import { showToast } from "../components/Toast";

const mockInvoke = invoke as Mock;
const mockShowToast = showToast as Mock;

// Base64 helper for assertions
function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// -- Tests --------------------------------------------------------------------

describe("writeQueue", () => {
  beforeEach(() => {
    vi.resetModules();
    mockInvoke.mockReset();
    mockShowToast.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // -----------------------------------------------------------------------
  // 1. enqueueWrite calls invoke with base64-encoded body
  // -----------------------------------------------------------------------
  it("enqueueWrite encodes body to base64 and calls integration_queue_enqueue", async () => {
    mockInvoke.mockResolvedValue({ id: 42, evicted: false });

    const { enqueueWrite } = await import("./writeQueue");

    const body = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
    const result = await enqueueWrite({
      service: "planflow",
      method: "POST",
      url: "https://api.planflow.dev/tasks",
      headers: { "content-type": "application/json" },
      body,
    });

    expect(mockInvoke).toHaveBeenCalledOnce();
    const [cmd, payload] = mockInvoke.mock.calls[0] as [string, { args: Record<string, unknown> }];
    expect(cmd).toBe("integration_queue_enqueue");
    expect(payload.args["service"]).toBe("planflow");
    expect(payload.args["method"]).toBe("POST");
    expect(payload.args["url"]).toBe("https://api.planflow.dev/tasks");
    // Verify base64 round-trips correctly
    const decoded = base64ToBytes(payload.args["bodyBase64"] as string);
    expect(decoded).toEqual(body);
    expect(result).toEqual({ id: 42, evicted: false });
  });

  // -----------------------------------------------------------------------
  // 2. enqueueWrite strips Authorization header
  // -----------------------------------------------------------------------
  it("enqueueWrite strips the Authorization header before enqueuing", async () => {
    mockInvoke.mockResolvedValue({ id: 1, evicted: false });

    const { enqueueWrite } = await import("./writeQueue");

    await enqueueWrite({
      service: "planflow",
      method: "PUT",
      url: "https://api.planflow.dev/tasks/1",
      headers: {
        Authorization: "Bearer stale-token",
        "content-type": "application/json",
      },
      body: null,
    });

    const [, payload] = mockInvoke.mock.calls[0] as [string, { args: Record<string, unknown> }];
    const headers = payload.args["headers"] as Record<string, string>;
    expect(headers["Authorization"]).toBeUndefined();
    expect(headers["content-type"]).toBe("application/json");
  });

  // -----------------------------------------------------------------------
  // 3. enqueueWrite toasts on evicted: true
  // -----------------------------------------------------------------------
  it("enqueueWrite shows a toast when evicted is true", async () => {
    mockInvoke.mockResolvedValue({ id: 50, evicted: true });

    const { enqueueWrite } = await import("./writeQueue");

    await enqueueWrite({
      service: "planflow",
      method: "POST",
      url: "https://api.planflow.dev/tasks",
      headers: {},
      body: null,
    });

    expect(mockShowToast).toHaveBeenCalledOnce();
    const [opts] = mockShowToast.mock.calls[0] as [{ message: string; variant: string }];
    expect(opts.message).toMatch(/offline queue full/i);
    expect(opts.variant).toBe("warning");
  });

  // -----------------------------------------------------------------------
  // 4. replayQueue drains in FIFO order
  // -----------------------------------------------------------------------
  it("replayQueue drains entries in FIFO order using the registered handler", async () => {
    const entries = [
      {
        id: 1,
        service: "planflow",
        method: "POST",
        url: "https://api.planflow.dev/tasks",
        headers: {},
        bodyBase64: null,
        enqueuedAt: 1000,
        attempts: 0,
        lastError: null,
        lastAttemptAt: null,
      },
      {
        id: 2,
        service: "planflow",
        method: "PUT",
        url: "https://api.planflow.dev/tasks/2",
        headers: {},
        bodyBase64: null,
        enqueuedAt: 2000,
        attempts: 0,
        lastError: null,
        lastAttemptAt: null,
      },
    ];

    const dequeuedIds: number[] = [];

    // invoke: list → entries, dequeue → true for each id
    mockInvoke.mockImplementation(
      async (cmd: string, payload: { args: Record<string, unknown> }) => {
        if (cmd === "integration_queue_list") return entries;
        if (cmd === "integration_queue_dequeue") {
          dequeuedIds.push(payload.args["id"] as number);
          return true;
        }
        return undefined;
      },
    );

    const { replayQueue, registerReplayHandler } = await import("./writeQueue");

    const handledIds: number[] = [];
    registerReplayHandler("planflow", async (entry) => {
      handledIds.push(entry.id);
      return { ok: true, status: 200, body: "" };
    });

    const context = {
      getAuthToken: async (): Promise<string> => "tok",
    };

    const count = await replayQueue(context);

    expect(count).toBe(2);
    // FIFO: id 1 before id 2
    expect(handledIds).toEqual([1, 2]);
    expect(dequeuedIds).toEqual([1, 2]);
  });

  // -----------------------------------------------------------------------
  // 5. replayQueue drops 4xx (non-401/403) writes after marking failed
  // -----------------------------------------------------------------------
  it("replayQueue drops non-auth 4xx writes with a warning toast", async () => {
    const entries = [
      {
        id: 10,
        service: "github",
        method: "POST",
        url: "https://api.github.com/repos/x/y/issues",
        headers: {},
        bodyBase64: null,
        enqueuedAt: 1000,
        attempts: 0,
        lastError: null,
        lastAttemptAt: null,
      },
    ];

    const markedFailed: number[] = [];
    const dequeued: number[] = [];

    mockInvoke.mockImplementation(
      async (cmd: string, payload: { args: Record<string, unknown> }) => {
        if (cmd === "integration_queue_list") return entries;
        if (cmd === "integration_queue_mark_failed") {
          markedFailed.push(payload.args["id"] as number);
          return undefined;
        }
        if (cmd === "integration_queue_dequeue") {
          dequeued.push(payload.args["id"] as number);
          return true;
        }
        return undefined;
      },
    );

    const { replayQueue, registerReplayHandler } = await import("./writeQueue");

    registerReplayHandler("github", async () => ({
      ok: false,
      status: 422,
      body: "Unprocessable Entity",
    }));

    const count = await replayQueue({ getAuthToken: async () => null });

    // Not counted as successfully drained
    expect(count).toBe(0);
    // Marked failed then dequeued (dropped)
    expect(markedFailed).toContain(10);
    expect(dequeued).toContain(10);
    // Toast warning shown
    expect(mockShowToast).toHaveBeenCalledOnce();
    const [opts] = mockShowToast.mock.calls[0] as [{ variant: string }];
    expect(opts.variant).toBe("warning");
  });

  // -----------------------------------------------------------------------
  // 6. replayQueue keeps 401 / 403 in queue (T11.8 owns recovery)
  // -----------------------------------------------------------------------
  it.each([401, 403])(
    "replayQueue keeps %i response in queue and does not dequeue",
    async (status) => {
      const entries = [
        {
          id: 20,
          service: "planflow",
          method: "DELETE",
          url: "https://api.planflow.dev/tasks/20",
          headers: {},
          bodyBase64: null,
          enqueuedAt: 1000,
          attempts: 0,
          lastError: null,
          lastAttemptAt: null,
        },
      ];

      const dequeued: number[] = [];
      const markedFailed: number[] = [];

      mockInvoke.mockImplementation(
        async (cmd: string, payload: { args: Record<string, unknown> }) => {
          if (cmd === "integration_queue_list") return entries;
          if (cmd === "integration_queue_dequeue") {
            dequeued.push(payload.args["id"] as number);
            return true;
          }
          if (cmd === "integration_queue_mark_failed") {
            markedFailed.push(payload.args["id"] as number);
            return undefined;
          }
          return undefined;
        },
      );

      const { replayQueue, registerReplayHandler } = await import("./writeQueue");

      registerReplayHandler("planflow", async () => ({
        ok: false,
        status,
        body: "Unauthorized",
      }));

      const count = await replayQueue({ getAuthToken: async () => "tok" });

      expect(count).toBe(0);
      // Entry must NOT be dequeued — kept for T11.8 to handle
      expect(dequeued).toHaveLength(0);
      // Also must NOT be mark_failed — the entry stays pristine for reauth
      expect(markedFailed).toHaveLength(0);
      // Warning toast fired
      expect(mockShowToast).toHaveBeenCalledOnce();
    },
  );

  // -----------------------------------------------------------------------
  // 7. replayQueue keeps 5xx with mark_failed + bumped attempts
  // -----------------------------------------------------------------------
  it("replayQueue marks 5xx entries failed and leaves them in queue", async () => {
    const entries = [
      {
        id: 30,
        service: "planflow",
        method: "PATCH",
        url: "https://api.planflow.dev/tasks/30",
        headers: {},
        bodyBase64: null,
        enqueuedAt: 1000,
        attempts: 1,
        lastError: "HTTP 503",
        lastAttemptAt: 1500,
      },
    ];

    const markedFailed: { id: number; error: string; at: number }[] = [];
    const dequeued: number[] = [];

    mockInvoke.mockImplementation(
      async (cmd: string, payload: { args: Record<string, unknown> }) => {
        if (cmd === "integration_queue_list") return entries;
        if (cmd === "integration_queue_mark_failed") {
          markedFailed.push({
            id: payload.args["id"] as number,
            error: payload.args["error"] as string,
            at: payload.args["at"] as number,
          });
          return undefined;
        }
        if (cmd === "integration_queue_dequeue") {
          dequeued.push(payload.args["id"] as number);
          return true;
        }
        return undefined;
      },
    );

    const { replayQueue, registerReplayHandler } = await import("./writeQueue");

    registerReplayHandler("planflow", async () => ({
      ok: false,
      status: 503,
      body: "Service Unavailable",
    }));

    const count = await replayQueue({ getAuthToken: async () => "tok" });

    expect(count).toBe(0);
    // mark_failed called with the id
    expect(markedFailed).toHaveLength(1);
    expect(markedFailed[0]?.id).toBe(30);
    expect(markedFailed[0]?.error).toMatch(/503/);
    // T11.9 bug regression: Rust requires `at`; missing it was silently
    // breaking the entire 5xx retry path before the fix.
    expect(typeof markedFailed[0]?.at).toBe("number");
    // NOT dequeued — stays for retry on next reconnect
    expect(dequeued).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // 8. replayQueue handles transport-level errors (no response)
  // -----------------------------------------------------------------------
  it("replayQueue marks transport-level errors as failed without dequeuing", async () => {
    const entries = [
      {
        id: 40,
        service: "github",
        method: "POST",
        url: "https://api.github.com/repos/x/y/issues",
        headers: {},
        bodyBase64: null,
        enqueuedAt: 1000,
        attempts: 0,
        lastError: null,
        lastAttemptAt: null,
      },
    ];

    const markedFailed: number[] = [];
    const dequeued: number[] = [];

    mockInvoke.mockImplementation(
      async (cmd: string, payload: { args: Record<string, unknown> }) => {
        if (cmd === "integration_queue_list") return entries;
        if (cmd === "integration_queue_mark_failed") {
          markedFailed.push(payload.args["id"] as number);
          return undefined;
        }
        if (cmd === "integration_queue_dequeue") {
          dequeued.push(payload.args["id"] as number);
          return true;
        }
        return undefined;
      },
    );

    const { replayQueue, registerReplayHandler } = await import("./writeQueue");

    registerReplayHandler("github", async () => {
      throw new Error("fetch failed");
    });

    const count = await replayQueue({ getAuthToken: async () => null });

    expect(count).toBe(0);
    expect(markedFailed).toContain(40);
    expect(dequeued).toHaveLength(0);
  });
});
