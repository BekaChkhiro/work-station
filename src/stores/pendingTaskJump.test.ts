// T12.9 — Pending cross-project task jump store tests.

import { afterEach, describe, expect, it } from "vitest";

import {
  _resetPendingTaskJumpsForTests,
  consumeTaskJump,
  pendingTaskJump,
  requestTaskJump,
} from "./pendingTaskJump";

afterEach(() => {
  _resetPendingTaskJumpsForTests();
});

describe("pendingTaskJump store", () => {
  it("returns null when nothing has been requested", () => {
    expect(pendingTaskJump("ws-1")).toBeNull();
    expect(consumeTaskJump("ws-1")).toBeNull();
  });

  it("requestTaskJump then pendingTaskJump returns the taskId", () => {
    requestTaskJump("ws-1", "T12.9");
    expect(pendingTaskJump("ws-1")).toBe("T12.9");
  });

  it("consumeTaskJump returns and clears the pending taskId", () => {
    requestTaskJump("ws-1", "T12.9");
    expect(consumeTaskJump("ws-1")).toBe("T12.9");
    expect(pendingTaskJump("ws-1")).toBeNull();
    expect(consumeTaskJump("ws-1")).toBeNull();
  });

  it("scopes pending jumps per workspace project", () => {
    requestTaskJump("ws-a", "T1.1");
    requestTaskJump("ws-b", "T2.2");
    expect(pendingTaskJump("ws-a")).toBe("T1.1");
    expect(pendingTaskJump("ws-b")).toBe("T2.2");
    consumeTaskJump("ws-a");
    expect(pendingTaskJump("ws-a")).toBeNull();
    expect(pendingTaskJump("ws-b")).toBe("T2.2");
  });

  it("a later requestTaskJump replaces the prior pending target", () => {
    requestTaskJump("ws-1", "T1.1");
    requestTaskJump("ws-1", "T2.2");
    expect(consumeTaskJump("ws-1")).toBe("T2.2");
  });
});
