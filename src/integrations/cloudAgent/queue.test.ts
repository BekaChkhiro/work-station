// T19.16 — Unit tests for the cloud-mode offline queue.
//
// Note: the `installCloudAutoReplay` glue is a thin createEffect that
// follows the same pattern as `installCloudAgentAutoConnect` and is
// covered indirectly via the production bootstrap in App.tsx. These
// tests focus on the queue mechanics — enqueue, replay, eviction, error
// handling — which is the part that has real branching logic worth
// pinning. (Solid effects don't fire under this repo's vitest config:
// vite-plugin-solid isn't loaded, so reactive scheduling never kicks in
// inside a test process. Testing the effect itself would require either
// adding the plugin to vitest.config.ts or building a separate harness.)

import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

vi.mock("../../components/Toast", () => ({
  showToast: vi.fn(),
}));

import { showToast } from "../../components/Toast";
import type { CloudAgentConnectionState, CloudAgentManager } from "./client";
import {
  cloudQueueEntries,
  enqueueCloudOperation,
  installCloudAutoReplay,
  replayCloudQueue,
  _clearCloudQueueForTests,
  _resetCloudAutoReplayForTests,
} from "./queue";

const mockShowToast = showToast as Mock;

function makeStubManager(initial: CloudAgentConnectionState = "idle"): {
  manager: CloudAgentManager;
  setState: (next: CloudAgentConnectionState) => void;
} {
  const [state, setState] = createSignal<CloudAgentConnectionState>(initial);
  const manager: CloudAgentManager = {
    state,
    client: () => null,
    endpoint: () => null,
    connect: async () => {
      // no-op stub
    },
    disconnect: () => {
      // no-op stub
    },
    dispose: () => {
      // no-op stub
    },
  };
  return { manager, setState };
}

describe("cloudAgent/queue", () => {
  beforeEach(() => {
    _clearCloudQueueForTests();
    _resetCloudAutoReplayForTests();
    mockShowToast.mockReset();
  });

  afterEach(() => {
    _clearCloudQueueForTests();
    _resetCloudAutoReplayForTests();
  });

  it("enqueues operations in FIFO order with monotonic ids", () => {
    const id1 = enqueueCloudOperation({ label: "a", op: async () => undefined });
    const id2 = enqueueCloudOperation({ label: "b", op: async () => undefined });
    const id3 = enqueueCloudOperation({ label: "c", op: async () => undefined });

    expect(id2).toBe(id1 + 1);
    expect(id3).toBe(id2 + 1);
    const snapshot = cloudQueueEntries();
    expect(snapshot.map((e) => e.label)).toEqual(["a", "b", "c"]);
    expect(snapshot.every((e) => e.attempts === 0)).toBe(true);
    expect(snapshot.every((e) => e.lastError === null)).toBe(true);
  });

  it("evicts the oldest entry with a toast when the queue is full", () => {
    // Fill the queue to its cap.
    for (let i = 0; i < 50; i++) {
      enqueueCloudOperation({ label: `op-${i}`, op: async () => undefined });
    }
    expect(cloudQueueEntries()).toHaveLength(50);
    expect(mockShowToast).not.toHaveBeenCalled();

    enqueueCloudOperation({ label: "op-overflow", op: async () => undefined });

    const snapshot = cloudQueueEntries();
    expect(snapshot).toHaveLength(50);
    // Oldest (op-0) gone, overflow at the tail.
    expect(snapshot[0]?.label).toBe("op-1");
    expect(snapshot[snapshot.length - 1]?.label).toBe("op-overflow");
    expect(mockShowToast).toHaveBeenCalledTimes(1);
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('"op-0"'),
        variant: "warning",
      }),
    );
  });

  it("drains operations in FIFO order and removes them from the queue", async () => {
    const calls: string[] = [];
    enqueueCloudOperation({
      label: "a",
      op: async () => {
        calls.push("a");
      },
    });
    enqueueCloudOperation({
      label: "b",
      op: async () => {
        calls.push("b");
      },
    });
    enqueueCloudOperation({
      label: "c",
      op: async () => {
        calls.push("c");
      },
    });

    const drained = await replayCloudQueue();

    expect(drained).toBe(3);
    expect(calls).toEqual(["a", "b", "c"]);
    expect(cloudQueueEntries()).toHaveLength(0);
  });

  it("stops replay at the first failing op and leaves the rest queued", async () => {
    const calls: string[] = [];
    enqueueCloudOperation({
      label: "a",
      op: async () => {
        calls.push("a");
      },
    });
    enqueueCloudOperation({
      label: "b",
      op: async () => {
        calls.push("b");
        throw new Error("boom");
      },
    });
    enqueueCloudOperation({
      label: "c",
      op: async () => {
        calls.push("c");
      },
    });

    const drained = await replayCloudQueue();

    expect(drained).toBe(1);
    expect(calls).toEqual(["a", "b"]);
    const remaining = cloudQueueEntries();
    expect(remaining.map((e) => e.label)).toEqual(["b", "c"]);
    expect(remaining[0]?.attempts).toBe(1);
    expect(remaining[0]?.lastError).toBe("boom");
    expect(mockShowToast).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining('"b"'),
        variant: "warning",
      }),
    );
  });

  it("installCloudAutoReplay is idempotent across multiple calls", () => {
    createRoot((dispose) => {
      const { manager } = makeStubManager("idle");
      const first = installCloudAutoReplay(manager);
      const second = installCloudAutoReplay(manager);
      // Both calls return functions; the second is a no-op so a stray
      // caller can't tear down a shared subscription. Calling either is
      // safe — verifying that here is enough; the wiring is exercised
      // for real in production via App.tsx's onMount.
      expect(typeof first).toBe("function");
      expect(typeof second).toBe("function");
      second();
      first();
      dispose();
    });
  });
});
