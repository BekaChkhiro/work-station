// T12.4 + T12.5 — Unit tests for the task lifecycle orchestrators
// (Start / Progress / Done).
//
// PlanFlow's REST surface changed in T-fix: locks are claimed via a
// dedicated `POST /work {action: "start"}` call and status flips ride a
// separate `POST /tasks/bulk-status` request. These tests pin the
// orchestration order around those two calls and the side-effects on
// the workspace store + terminal.

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
  id: "uuid-12.4",
  taskId: "T12.4",
  name: "Start task lock",
  status: "IN_PROGRESS",
};

interface ClientOverrides {
  startWorking?: PlanFlowClient["startWorking"];
  stopWorking?: PlanFlowClient["stopWorking"];
  updateTaskStatus?: PlanFlowClient["updateTaskStatus"];
  getTask?: PlanFlowClient["getTask"];
  getBranchName?: PlanFlowClient["getBranchName"];
  createComment?: PlanFlowClient["createComment"];
  createKnowledge?: PlanFlowClient["createKnowledge"];
}

function mockClient(overrides: ClientOverrides = {}): PlanFlowClient {
  return {
    startWorking: overrides.startWorking ?? vi.fn(async () => undefined),
    stopWorking: overrides.stopWorking ?? vi.fn(async () => undefined),
    updateTaskStatus: overrides.updateTaskStatus ?? vi.fn(async () => baseTask),
    getTask: overrides.getTask ?? vi.fn(async () => baseTask),
    getBranchName:
      overrides.getBranchName ??
      vi.fn(async () => ({ branchName: "feature/t12.4-start-task-lock" })),
    createComment:
      overrides.createComment ?? vi.fn(async () => ({ id: "c1", body: "note", taskId: "T12.4" })),
    createKnowledge:
      overrides.createKnowledge ?? vi.fn(async () => ({ id: "k1", title: "", body: "" })),
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
    expect(formatCheckoutCommand("feature/t12.4-foo")).toBe("git checkout -b feature/t12.4-foo");
  });
});

describe("commitScopeFromTaskId", () => {
  it("derives the lowercase phase scope from a task id", () => {
    expect(commitScopeFromTaskId("T12.4")).toBe("t12");
    expect(commitScopeFromTaskId("T1.10")).toBe("t1");
    expect(commitScopeFromTaskId("nope")).toBeNull();
  });
});

describe("formatCommitMessage / formatCommitCommand", () => {
  it("builds the Conventional Commits subject", () => {
    expect(formatCommitMessage("T12.5", "Progress + Done flows")).toBe(
      "feat(t12): T12.5 — Progress + Done flows",
    );
  });

  it("escapes double quotes in the command form", () => {
    const cmd = formatCommitCommand("T12.5", 'Quotes "inside"');
    expect(cmd).toBe('git commit -m "feat(t12): T12.5 — Quotes \\"inside\\""');
  });
});

describe("startTask — happy path", () => {
  it("claims lock, flips status, fetches branch, switches tab, prefills", async () => {
    mockGetWorkspace.mockReturnValue({ focusedSessionId: "session-1" });
    const startWorking = vi.fn(async () => undefined);
    const updateTaskStatus = vi.fn(async () => baseTask);
    const getBranchName = vi.fn(async () => ({
      branchName: "feature/t12.4-start-task-lock",
    }));
    const client = mockClient({ startWorking, updateTaskStatus, getBranchName });

    const result = await startTask({
      client,
      externalId: "ext-123",
      workspaceProjectId: "ws-1",
      taskId: "T12.4",
    });

    expect(startWorking).toHaveBeenCalledWith("ext-123", "T12.4");
    expect(updateTaskStatus).toHaveBeenCalledWith("ext-123", "T12.4", "IN_PROGRESS");
    expect(getBranchName).toHaveBeenCalledWith("ext-123", "T12.4");
    expect(mockSetActiveTaskId).toHaveBeenCalledWith("ws-1", "T12.4");
    expect(mockSetActiveTab).toHaveBeenCalledWith("ws-1", "terminal");
    expect(mockPtyWrite).toHaveBeenCalledTimes(1);
    expect(result.task).toEqual(baseTask);
    expect(result.branchName).toBe("feature/t12.4-start-task-lock");
    expect(result.prefilled).toBe(true);
  });

  it("forward-rolls when getBranchName throws after the lock is held", async () => {
    mockGetWorkspace.mockReturnValue({ focusedSessionId: "session-1" });
    const client = mockClient({
      getBranchName: vi.fn(async () => {
        throw new Error("branch endpoint down");
      }),
    });

    const result = await startTask({
      client,
      externalId: "ext-123",
      workspaceProjectId: "ws-1",
      taskId: "T12.4",
    });

    expect(mockSetActiveTaskId).toHaveBeenCalledWith("ws-1", "T12.4");
    expect(result.branchName).toBeNull();
    expect(result.prefilled).toBe(false);
  });
});

describe("markProgress", () => {
  it("posts a comment and returns the resolved task", async () => {
    const createComment = vi.fn(async () => ({ id: "c1", body: "note", taskId: "T12.4" }));
    const getTask = vi.fn(async () => baseTask);
    const client = mockClient({ createComment, getTask });

    const result = await markProgress({
      client,
      externalId: "ext-123",
      taskId: "T12.4",
      note: "checkpoint",
    });

    expect(createComment).toHaveBeenCalledWith("ext-123", "T12.4", { body: "checkpoint" });
    expect(result.task).toEqual(baseTask);
  });

  it("also creates a knowledge entry when saveAsKnowledge is true", async () => {
    const createKnowledge = vi.fn(async () => ({ id: "k1", title: "x", body: "y" }));
    const client = mockClient({ createKnowledge });

    await markProgress({
      client,
      externalId: "ext-123",
      taskId: "T12.4",
      note: "Decided to refactor X. Y was the alternative.",
      saveAsKnowledge: true,
    });

    expect(createKnowledge).toHaveBeenCalled();
  });
});

describe("finishTask", () => {
  it("flips status, posts the summary, releases the lock, prefills commit", async () => {
    mockGetWorkspace.mockReturnValue({ focusedSessionId: "session-1" });
    const doneTask: Task = { ...baseTask, status: "DONE" };
    const updateTaskStatus = vi.fn(async () => doneTask);
    const stopWorking = vi.fn(async () => undefined);
    const createComment = vi.fn(async () => ({
      id: "c2",
      body: "summary",
      taskId: "T12.4",
    }));
    const client = mockClient({ updateTaskStatus, stopWorking, createComment });

    const result = await finishTask({
      client,
      externalId: "ext-123",
      workspaceProjectId: "ws-1",
      taskId: "T12.4",
      summary: "summary",
      taskName: "Start task lock",
    });

    expect(updateTaskStatus).toHaveBeenCalledWith("ext-123", "T12.4", "DONE");
    expect(createComment).toHaveBeenCalledWith("ext-123", "T12.4", { body: "summary" });
    expect(stopWorking).toHaveBeenCalledWith("ext-123");
    expect(result.task).toEqual(doneTask);
    expect(result.commitMessage).toBe("feat(t12): T12.4 — Start task lock");
    expect(result.released).toBe(true);
    expect(result.prefilled).toBe(true);
  });

  it("tolerates a failed release after the DONE flip succeeded", async () => {
    mockGetWorkspace.mockReturnValue({ focusedSessionId: "session-1" });
    const stopWorking = vi.fn(async () => {
      throw new Error("release failed");
    });
    const client = mockClient({ stopWorking });

    const result = await finishTask({
      client,
      externalId: "ext-123",
      workspaceProjectId: "ws-1",
      taskId: "T12.5",
      summary: "summary",
      taskName: "Done",
    });

    expect(result.released).toBe(false);
  });
});
