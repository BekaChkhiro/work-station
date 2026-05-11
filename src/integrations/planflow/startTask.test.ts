// T12.4 — Unit tests for the Start task orchestrator.
//
// Mocks `ptyWrite`, the workspace store, and the active-task store so the
// test can assert the exact side-effect sequence without booting the
// Tauri runtime or the full Solid reactive graph.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";

vi.mock("../../ipc/pty", () => ({
  ptyWrite: vi.fn(async () => undefined),
}));

vi.mock("../../stores/workspace", () => ({
  setActiveTab: vi.fn(),
  getWorkspace: vi.fn(),
}));

vi.mock("../../stores/activeTask", () => ({
  setActiveTaskId: vi.fn(),
}));

import { ptyWrite } from "../../ipc/pty";
import { getWorkspace, setActiveTab } from "../../stores/workspace";
import { setActiveTaskId } from "../../stores/activeTask";
import { formatCheckoutCommand, startTask } from "./startTask";
import type { PlanFlowClient } from "./client";
import type { Task } from "./schemas";

const mockPtyWrite = ptyWrite as Mock;
const mockSetActiveTab = setActiveTab as Mock;
const mockGetWorkspace = getWorkspace as Mock;
const mockSetActiveTaskId = setActiveTaskId as Mock;

const baseTask: Task = {
  id: "T12.4",
  name: "Start task",
  status: "IN_PROGRESS",
};

function mockClient(overrides: {
  workOnTask?: PlanFlowClient["workOnTask"];
  getBranchName?: PlanFlowClient["getBranchName"];
}): PlanFlowClient {
  return {
    workOnTask: overrides.workOnTask ?? vi.fn(async () => baseTask),
    getBranchName:
      overrides.getBranchName ?? vi.fn(async () => ({ branchName: "task/T12.4-start-task" })),
  } as unknown as PlanFlowClient;
}

beforeEach(() => {
  mockPtyWrite.mockReset();
  mockPtyWrite.mockResolvedValue(undefined);
  mockSetActiveTab.mockReset();
  mockGetWorkspace.mockReset();
  mockSetActiveTaskId.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("formatCheckoutCommand", () => {
  it("locks the exact pre-typed text", () => {
    expect(formatCheckoutCommand("task/T12.4-foo")).toBe("git checkout -b task/T12.4-foo");
  });
});

describe("startTask — happy path", () => {
  it("acquires lock, fetches branch, switches tab, writes prefill, marks active", async () => {
    mockGetWorkspace.mockReturnValue({ focusedSessionId: "session-1" });
    const workOnTask = vi.fn(async () => baseTask);
    const getBranchName = vi.fn(async () => ({
      branchName: "task/T12.4-start-task-lock",
    }));
    const client = mockClient({ workOnTask, getBranchName });

    const result = await startTask({
      client,
      externalId: "ext-123",
      workspaceProjectId: "ws-1",
      taskId: "T12.4",
    });

    expect(workOnTask).toHaveBeenCalledWith("ext-123", "T12.4", { status: "IN_PROGRESS" });
    expect(getBranchName).toHaveBeenCalledWith("ext-123", "T12.4");
    expect(mockSetActiveTaskId).toHaveBeenCalledWith("ws-1", "T12.4");
    expect(mockSetActiveTab).toHaveBeenCalledWith("ws-1", "terminal");
    expect(mockPtyWrite).toHaveBeenCalledTimes(1);
    const [sessionId, bytes] = mockPtyWrite.mock.calls[0] as [string, Uint8Array];
    expect(sessionId).toBe("session-1");
    expect(new TextDecoder().decode(bytes)).toBe("git checkout -b task/T12.4-start-task-lock");
    expect(result).toEqual({
      task: baseTask,
      branchName: "task/T12.4-start-task-lock",
      prefilled: true,
    });
  });
});

describe("startTask — branch fetch failure", () => {
  it("keeps the lock, still marks active and switches tab, returns null branchName + prefilled=false", async () => {
    mockGetWorkspace.mockReturnValue({ focusedSessionId: "session-1" });
    const getBranchName = vi.fn(async () => {
      throw new Error("branch endpoint down");
    });
    const client = mockClient({ getBranchName });

    const result = await startTask({
      client,
      externalId: "ext-123",
      workspaceProjectId: "ws-1",
      taskId: "T12.4",
    });

    expect(mockSetActiveTaskId).toHaveBeenCalledWith("ws-1", "T12.4");
    expect(mockSetActiveTab).toHaveBeenCalledWith("ws-1", "terminal");
    expect(mockPtyWrite).not.toHaveBeenCalled();
    expect(result.branchName).toBe(null);
    expect(result.prefilled).toBe(false);
  });
});

describe("startTask — no focused pane", () => {
  it("skips ptyWrite when the workspace has no focused session", async () => {
    mockGetWorkspace.mockReturnValue({ focusedSessionId: null });
    const client = mockClient({});

    const result = await startTask({
      client,
      externalId: "ext-123",
      workspaceProjectId: "ws-1",
      taskId: "T12.4",
    });

    expect(mockPtyWrite).not.toHaveBeenCalled();
    expect(result.prefilled).toBe(false);
    expect(result.branchName).toBe("task/T12.4-start-task");
    expect(mockSetActiveTaskId).toHaveBeenCalledWith("ws-1", "T12.4");
    expect(mockSetActiveTab).toHaveBeenCalledWith("ws-1", "terminal");
  });

  it("treats a missing workspace the same as no focused pane", async () => {
    mockGetWorkspace.mockReturnValue(null);
    const client = mockClient({});

    const result = await startTask({
      client,
      externalId: "ext-123",
      workspaceProjectId: "ws-1",
      taskId: "T12.4",
    });

    expect(mockPtyWrite).not.toHaveBeenCalled();
    expect(result.prefilled).toBe(false);
  });
});

describe("startTask — workOnTask failure", () => {
  it("rethrows without touching local state when the lock acquisition fails", async () => {
    const conflict = new Error("locked");
    const workOnTask = vi.fn(async () => {
      throw conflict;
    });
    const client = mockClient({ workOnTask });

    await expect(
      startTask({
        client,
        externalId: "ext-123",
        workspaceProjectId: "ws-1",
        taskId: "T12.4",
      }),
    ).rejects.toBe(conflict);

    expect(mockSetActiveTaskId).not.toHaveBeenCalled();
    expect(mockSetActiveTab).not.toHaveBeenCalled();
    expect(mockPtyWrite).not.toHaveBeenCalled();
  });
});
