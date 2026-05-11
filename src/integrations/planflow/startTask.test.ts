// T12.4 + T12.5 — Unit tests for the task lifecycle orchestrators
// (Start / Progress / Done).
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
import {
  commitScopeFromTaskId,
  finishTask,
  formatCheckoutCommand,
  formatCommitCommand,
  formatCommitMessage,
  markProgress,
  startTask,
} from "./startTask";
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

// T12.5 — Conventional Commits formatting + Progress + Done orchestration.

describe("commitScopeFromTaskId", () => {
  it("derives a lowercase phase scope from a T<N>.<M> id", () => {
    expect(commitScopeFromTaskId("T12.5")).toBe("t12");
    expect(commitScopeFromTaskId("T7.10")).toBe("t7");
  });

  it("returns null for ids that don't match the pattern", () => {
    expect(commitScopeFromTaskId("X1.2")).toBe(null);
    expect(commitScopeFromTaskId("T12")).toBe(null);
    expect(commitScopeFromTaskId("")).toBe(null);
  });
});

describe("formatCommitMessage", () => {
  it("formats `feat(tN): TX.Y — name` and trims the name", () => {
    expect(formatCommitMessage("T12.5", "Progress + Done flows")).toBe(
      "feat(t12): T12.5 — Progress + Done flows",
    );
    expect(formatCommitMessage("T12.5", "  trimmed  ")).toBe("feat(t12): T12.5 — trimmed");
  });

  it("drops the scope when the task id doesn't match the pattern", () => {
    expect(formatCommitMessage("X9", "loose name")).toBe("feat: X9 — loose name");
  });
});

describe("formatCommitCommand", () => {
  it("wraps the message in double quotes for the focused pane", () => {
    expect(formatCommitCommand("T12.5", "Progress + Done flows")).toBe(
      'git commit -m "feat(t12): T12.5 — Progress + Done flows"',
    );
  });

  it("escapes embedded double quotes and backslashes so the shell sees the literal", () => {
    expect(formatCommitCommand("T12.5", 'name with "quoted" word')).toBe(
      'git commit -m "feat(t12): T12.5 — name with \\"quoted\\" word"',
    );
    expect(formatCommitCommand("T12.5", "back\\slash")).toBe(
      'git commit -m "feat(t12): T12.5 — back\\\\slash"',
    );
  });
});

const progressTask: Task = {
  id: "T12.5",
  name: "Progress + Done flows",
  status: "IN_PROGRESS",
};

function progressMockClient(overrides: {
  workOnTask?: PlanFlowClient["workOnTask"];
  releaseTaskLock?: PlanFlowClient["releaseTaskLock"];
}): PlanFlowClient {
  return {
    workOnTask: overrides.workOnTask ?? vi.fn(async () => progressTask),
    releaseTaskLock: overrides.releaseTaskLock ?? vi.fn(async () => undefined),
  } as unknown as PlanFlowClient;
}

describe("markProgress", () => {
  it("posts the note via /work without changing status, forwards saveAsKnowledge", async () => {
    const workOnTask = vi.fn(async () => progressTask);
    const client = progressMockClient({ workOnTask });

    const result = await markProgress({
      client,
      externalId: "ext-123",
      taskId: "T12.5",
      note: "Working through the dialog",
      saveAsKnowledge: true,
      knowledgeType: "decision",
    });

    expect(workOnTask).toHaveBeenCalledWith("ext-123", "T12.5", {
      note: "Working through the dialog",
      saveAsKnowledge: true,
      knowledgeTitle: undefined,
      knowledgeType: "decision",
    });
    expect(result.task).toBe(progressTask);
    expect(mockSetActiveTaskId).not.toHaveBeenCalled();
    expect(mockSetActiveTab).not.toHaveBeenCalled();
    expect(mockPtyWrite).not.toHaveBeenCalled();
  });

  it("omits saveAsKnowledge when not passed", async () => {
    const workOnTask = vi.fn(async () => progressTask);
    const client = progressMockClient({ workOnTask });

    await markProgress({
      client,
      externalId: "ext-123",
      taskId: "T12.5",
      note: "Quick note",
    });

    expect(workOnTask).toHaveBeenCalledWith("ext-123", "T12.5", {
      note: "Quick note",
      saveAsKnowledge: undefined,
      knowledgeTitle: undefined,
      knowledgeType: undefined,
    });
  });

  it("rethrows when the server rejects the comment", async () => {
    const boom = new Error("nope");
    const workOnTask = vi.fn(async () => {
      throw boom;
    });
    const client = progressMockClient({ workOnTask });

    await expect(
      markProgress({
        client,
        externalId: "ext-123",
        taskId: "T12.5",
        note: "Will fail",
      }),
    ).rejects.toBe(boom);
  });
});

describe("finishTask — happy path", () => {
  it("flips to DONE, releases lock, clears active task, switches tab, pre-types commit", async () => {
    mockGetWorkspace.mockReturnValue({ focusedSessionId: "session-1" });
    const workOnTask = vi.fn(async (): Promise<Task> => ({ ...progressTask, status: "DONE" }));
    const releaseTaskLock = vi.fn(async () => undefined);
    const client = progressMockClient({ workOnTask, releaseTaskLock });

    const result = await finishTask({
      client,
      externalId: "ext-123",
      workspaceProjectId: "ws-1",
      taskId: "T12.5",
      summary: "Landed all four steps",
      taskName: "Progress + Done flows",
    });

    expect(workOnTask).toHaveBeenCalledWith("ext-123", "T12.5", {
      status: "DONE",
      note: "Landed all four steps",
    });
    expect(releaseTaskLock).toHaveBeenCalledWith("ext-123", "T12.5");
    expect(mockSetActiveTaskId).toHaveBeenCalledWith("ws-1", null);
    expect(mockSetActiveTab).toHaveBeenCalledWith("ws-1", "terminal");
    expect(mockPtyWrite).toHaveBeenCalledTimes(1);
    const [sessionId, bytes] = mockPtyWrite.mock.calls[0] as [string, Uint8Array];
    expect(sessionId).toBe("session-1");
    expect(new TextDecoder().decode(bytes)).toBe(
      'git commit -m "feat(t12): T12.5 — Progress + Done flows"',
    );
    expect(result.commitMessage).toBe("feat(t12): T12.5 — Progress + Done flows");
    expect(result.prefilled).toBe(true);
    expect(result.released).toBe(true);
  });
});

describe("finishTask — release failure", () => {
  it("forward-rolls: keeps DONE, clears active task, still pre-types commit, reports released=false", async () => {
    mockGetWorkspace.mockReturnValue({ focusedSessionId: "session-1" });
    const releaseTaskLock = vi.fn(async () => {
      throw new Error("release exploded");
    });
    const client = progressMockClient({ releaseTaskLock });

    const result = await finishTask({
      client,
      externalId: "ext-123",
      workspaceProjectId: "ws-1",
      taskId: "T12.5",
      summary: "Done anyway",
      taskName: "Progress + Done flows",
    });

    expect(mockSetActiveTaskId).toHaveBeenCalledWith("ws-1", null);
    expect(mockSetActiveTab).toHaveBeenCalledWith("ws-1", "terminal");
    expect(mockPtyWrite).toHaveBeenCalledTimes(1);
    expect(result.released).toBe(false);
    expect(result.prefilled).toBe(true);
  });
});

describe("finishTask — no focused pane", () => {
  it("skips the terminal prefill but still flips DONE and clears the active task", async () => {
    mockGetWorkspace.mockReturnValue({ focusedSessionId: null });
    const client = progressMockClient({});

    const result = await finishTask({
      client,
      externalId: "ext-123",
      workspaceProjectId: "ws-1",
      taskId: "T12.5",
      summary: "Done",
      taskName: "Progress + Done flows",
    });

    expect(mockPtyWrite).not.toHaveBeenCalled();
    expect(result.prefilled).toBe(false);
    expect(result.released).toBe(true);
    expect(mockSetActiveTaskId).toHaveBeenCalledWith("ws-1", null);
  });
});

describe("finishTask — workOnTask failure", () => {
  it("rethrows without releasing or touching local state when the DONE write fails", async () => {
    const boom = new Error("done failed");
    const workOnTask = vi.fn(async () => {
      throw boom;
    });
    const releaseTaskLock = vi.fn(async () => undefined);
    const client = progressMockClient({ workOnTask, releaseTaskLock });

    await expect(
      finishTask({
        client,
        externalId: "ext-123",
        workspaceProjectId: "ws-1",
        taskId: "T12.5",
        summary: "won't land",
        taskName: "Progress + Done flows",
      }),
    ).rejects.toBe(boom);

    expect(releaseTaskLock).not.toHaveBeenCalled();
    expect(mockSetActiveTaskId).not.toHaveBeenCalled();
    expect(mockSetActiveTab).not.toHaveBeenCalled();
    expect(mockPtyWrite).not.toHaveBeenCalled();
  });
});
