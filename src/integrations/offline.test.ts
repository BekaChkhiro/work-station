// T11.9 — Unit tests for offline.ts
//
// Each test re-imports a fresh module state via vi.resetModules(). We can't
// use ESM live-bindings for that, so we use the dynamic import pattern
// inside each test group.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// We control navigator.onLine via Object.defineProperty in beforeEach.
// The happy-dom environment provides window.addEventListener / dispatchEvent.

describe("offline module", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    // Restore navigator.onLine to its default true state.
    Object.defineProperty(globalThis.navigator, "onLine", {
      configurable: true,
      writable: true,
      value: true,
    });
  });

  // ------------------------------------------------------------------
  // 1. Starts in `online` when navigator.onLine is true
  // ------------------------------------------------------------------
  it("starts in online when navigator.onLine is true", async () => {
    Object.defineProperty(globalThis.navigator, "onLine", {
      configurable: true,
      writable: true,
      value: true,
    });

    const { offlineSnapshot } = await import("./offline");
    const snap = offlineSnapshot();
    expect(snap.overall()).toBe("online");
    expect(snap.perService()).toEqual({});
  });

  // ------------------------------------------------------------------
  // 2. Starts in `offline` when navigator.onLine is false
  // ------------------------------------------------------------------
  it("starts in offline when navigator.onLine is false", async () => {
    Object.defineProperty(globalThis.navigator, "onLine", {
      configurable: true,
      writable: true,
      value: false,
    });

    const { offlineSnapshot } = await import("./offline");
    const snap = offlineSnapshot();
    expect(snap.overall()).toBe("offline");
  });

  // ------------------------------------------------------------------
  // 3. 3 consecutive errors flip per-service to offline; success resets
  // ------------------------------------------------------------------
  it("3 consecutive errors flip a service to offline; success resets", async () => {
    const { offlineSnapshot, reportNetworkError, reportNetworkSuccess, isOffline } =
      await import("./offline");

    const snap = offlineSnapshot();

    // 1 and 2 errors: still online
    reportNetworkError("planflow");
    reportNetworkError("planflow");
    expect(snap.perService()["planflow"]).toBeUndefined();
    expect(isOffline("planflow")).toBe(false);

    // 3rd error: flip to offline
    reportNetworkError("planflow");
    expect(snap.perService()["planflow"]).toBe("offline");
    expect(isOffline("planflow")).toBe(true);

    // Success: reset
    reportNetworkSuccess("planflow");
    expect(snap.perService()["planflow"]).toBeUndefined();
    expect(isOffline("planflow")).toBe(false);
  });

  // ------------------------------------------------------------------
  // 4. An intervening success resets the error counter
  // ------------------------------------------------------------------
  it("success resets the consecutive error counter before threshold", async () => {
    const { offlineSnapshot, reportNetworkError, reportNetworkSuccess } = await import("./offline");

    const snap = offlineSnapshot();

    reportNetworkError("github");
    reportNetworkError("github");
    // Success in between resets counter to 0
    reportNetworkSuccess("github");
    // Two more errors — counter is now 2, not 4 → still online
    reportNetworkError("github");
    reportNetworkError("github");
    expect(snap.perService()["github"]).toBeUndefined();
  });

  // ------------------------------------------------------------------
  // 5. window `offline` event flips overall to offline
  // ------------------------------------------------------------------
  it("window offline event flips overall to offline", async () => {
    const { offlineSnapshot, installOfflineListeners } = await import("./offline");

    const dispose = installOfflineListeners();
    const snap = offlineSnapshot();

    expect(snap.overall()).toBe("online");
    window.dispatchEvent(new Event("offline"));
    expect(snap.overall()).toBe("offline");

    dispose();
  });

  // ------------------------------------------------------------------
  // 6. window `online` event resets per-service states + fires onReconnect
  // ------------------------------------------------------------------
  it("window online event resets all per-service states and fires onReconnect handlers", async () => {
    const { offlineSnapshot, installOfflineListeners, reportNetworkError, onReconnect } =
      await import("./offline");

    const dispose = installOfflineListeners();
    const snap = offlineSnapshot();

    // Simulate overall going offline
    window.dispatchEvent(new Event("offline"));
    expect(snap.overall()).toBe("offline");

    // And two services in soft-offline (needs 3 errors each)
    reportNetworkError("planflow");
    reportNetworkError("planflow");
    reportNetworkError("planflow");
    reportNetworkError("github");
    reportNetworkError("github");
    reportNetworkError("github");
    expect(snap.perService()["planflow"]).toBe("offline");
    expect(snap.perService()["github"]).toBe("offline");

    // Register a reconnect listener
    const reconnectCalls: (string | undefined)[] = [];
    const disposeReconnect = onReconnect((svc) => reconnectCalls.push(svc));

    // Trigger overall online
    window.dispatchEvent(new Event("online"));

    expect(snap.overall()).toBe("online");
    expect(snap.perService()).toEqual({});

    // Handler fired once with no service arg (overall reconnect)
    expect(reconnectCalls).toHaveLength(1);
    expect(reconnectCalls[0]).toBeUndefined();

    disposeReconnect();
    dispose();
  });

  // ------------------------------------------------------------------
  // 7. onReconnect fires per-service when a soft-offline service recovers
  // ------------------------------------------------------------------
  it("onReconnect fires with service name when a soft-offline service recovers via success", async () => {
    const { reportNetworkError, reportNetworkSuccess, onReconnect } = await import("./offline");

    const calls: (string | undefined)[] = [];
    const dispose = onReconnect((svc) => calls.push(svc));

    reportNetworkError("jira");
    reportNetworkError("jira");
    reportNetworkError("jira"); // now soft-offline
    reportNetworkSuccess("jira"); // flip back online → should fire with "jira"

    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe("jira");

    dispose();
  });

  // ------------------------------------------------------------------
  // 8. installOfflineListeners is idempotent
  // ------------------------------------------------------------------
  it("installOfflineListeners is idempotent — calling twice only attaches listeners once", async () => {
    const { offlineSnapshot, installOfflineListeners } = await import("./offline");

    const dispose1 = installOfflineListeners();
    const dispose2 = installOfflineListeners(); // second call returns no-op dispose

    const snap = offlineSnapshot();
    window.dispatchEvent(new Event("offline"));
    expect(snap.overall()).toBe("offline");

    dispose2(); // no-op — should not remove listeners
    window.dispatchEvent(new Event("online"));
    expect(snap.overall()).toBe("online"); // listeners still active

    dispose1(); // real dispose
  });
});
