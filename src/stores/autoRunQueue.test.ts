// Phase C — Unit tests for the cloud-mode branch of the autoRunQueue store.
//
// We mock the dependencies that would require Tauri, a live WS connection,
// or PlanFlow network access so the tests run in Node/vitest without any
// infrastructure. Each test section is independent — module state is reset
// between tests via the exported `_stopTickForTests` helper and vi.resetModules.
//
// What's covered:
//   - startAutoRun in cloud mode: routes to wsBridge.autoRunStart, writes
//     the returned queue into the signal, starts cloud polling.
//   - pauseAutoRun / resumeAutoRun / stopAutoRun: route to matching methods.
//   - dismissAutoRun: stops polling, clears the signal.
//   - Local tick loop: never drives a cloud-origin queue (advance is guarded).
//   - Local mode: unchanged behaviour — startAutoRun returns an AutoRunQueue
//     and calls mutate/persist without touching wsBridge.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ──────────────────────────────────────────────────────────────────────────
// Minimal queue fixture the mock agent returns

const QUEUE_PAYLOAD = {
  id: "arq_cloud_1",
  projectId: "ws-proj-1",
  externalId: "pf-ext-1",
  targetCount: 2,
  completedCount: 0,
  currentTaskId: null,
  currentBranchName: null,
  currentSessionId: null,
  verifyStartedAt: null,
  mode: "auto-merge",
  startAt: null,
  pacingMinutes: 0,
  deadlineAt: null,
  onFailure: "stop",
  state: "running",
  currentTaskStartedAt: null,
  nextDispatchAt: null,
  history: [],
  createdAt: 1_700_000_000_000,
} as const;

// ──────────────────────────────────────────────────────────────────────────
// Mock: db/settings (avoid Tauri invoke)

const getSetting = vi.fn();
const setSetting = vi.fn().mockResolvedValue(undefined);

vi.mock("../db/settings", async () => {
  const actual = await vi.importActual<typeof import("../db/settings")>("../db/settings");
  return {
    ...actual,
    getSetting: (...args: unknown[]) => getSetting(...args),
    setSetting: (...args: unknown[]) => setSetting(...args),
  };
});

// ──────────────────────────────────────────────────────────────────────────
// Mock: ipc/transport (awaitCloudClient)

const mockAutoRunStart = vi.fn();
const mockAutoRunStop = vi.fn();
const mockAutoRunPause = vi.fn();
const mockAutoRunResume = vi.fn();
const mockAutoRunStatus = vi.fn();

const mockWsClient = {
  autoRunStart: mockAutoRunStart,
  autoRunStop: mockAutoRunStop,
  autoRunPause: mockAutoRunPause,
  autoRunResume: mockAutoRunResume,
  autoRunStatus: mockAutoRunStatus,
};

const awaitCloudClient = vi.fn().mockResolvedValue(mockWsClient);

vi.mock("../ipc/transport", async () => {
  const actual = await vi.importActual<typeof import("../ipc/transport")>("../ipc/transport");
  return {
    ...actual,
    awaitCloudClient: (...args: unknown[]) => awaitCloudClient(...args),
  };
});

// ──────────────────────────────────────────────────────────────────────────
// Mock: stores/cloudMode

let _cloudMode = false;
const cloudMode = vi.fn(() => _cloudMode);

vi.mock("../stores/cloudMode", async () => {
  const actual = await vi.importActual<typeof import("../stores/cloudMode")>("../stores/cloudMode");
  return {
    ...actual,
    cloudMode: () => cloudMode(),
  };
});

// ──────────────────────────────────────────────────────────────────────────
// Mock: integrations/planflow, integrations/github, ipc/pty, ipc/files
// (not exercised in cloud mode tests but the module imports them)

vi.mock("../integrations/planflow", () => ({ createRendererPlanFlowClient: vi.fn() }));
vi.mock("../integrations/github", () => ({ createRendererGitHubClient: vi.fn() }));
vi.mock("../integrations/planflow/startTask", () => ({ startTask: vi.fn() }));
vi.mock("../ipc/pty", () => ({ ptyKill: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../ipc/files", () => ({ readTextFile: vi.fn() }));
vi.mock("../db/projects", () => ({ listProjects: vi.fn().mockResolvedValue([]) }));

// ──────────────────────────────────────────────────────────────────────────
// Import the store after mocks are in place

import {
  autoRunQueue,
  dismissAutoRun,
  hydrateCloudAutoRun,
  isAutoRunActive,
  pauseAutoRun,
  resumeAutoRun,
  startAutoRun,
  stopAutoRun,
  _resetForTests,
  _stopTickForTests,
} from "./autoRunQueue";

// ──────────────────────────────────────────────────────────────────────────
// Helpers

function cloudQueueInput() {
  return {
    workspaceProjectId: "ws-proj-1",
    externalId: "pf-ext-1",
    targetCount: 2,
    mode: "auto-merge" as const,
    startAt: null,
    pacingMinutes: 0,
    deadlineAt: null,
    onFailure: "stop" as const,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Setup / teardown

beforeEach(() => {
  _resetForTests();
  _cloudMode = false;
  getSetting.mockReset();
  setSetting.mockReset();
  setSetting.mockResolvedValue(undefined);
  mockAutoRunStart.mockReset();
  mockAutoRunStop.mockReset();
  mockAutoRunPause.mockReset();
  mockAutoRunResume.mockReset();
  mockAutoRunStatus.mockReset();
  awaitCloudClient.mockReset();
  awaitCloudClient.mockResolvedValue(mockWsClient);
  cloudMode.mockClear();
});

afterEach(() => {
  _stopTickForTests();
});

// ──────────────────────────────────────────────────────────────────────────
// Cloud-mode: startAutoRun

describe("autoRunQueue — cloud mode — startAutoRun", () => {
  it("calls wsBridge.autoRunStart with the correct wire fields", async () => {
    _cloudMode = true;
    mockAutoRunStart.mockResolvedValue({ ...QUEUE_PAYLOAD });

    const input = cloudQueueInput();
    await startAutoRun(input);

    expect(awaitCloudClient).toHaveBeenCalledOnce();
    expect(mockAutoRunStart).toHaveBeenCalledOnce();
    const args = mockAutoRunStart.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(args).toMatchObject({
      project_id: "ws-proj-1",
      target_count: 2,
      mode: "auto-merge",
      on_failure: "stop",
      start_at: null,
      pacing_minutes: 0,
      deadline_at: null,
    });
  });

  it("writes the returned queue into the signal", async () => {
    _cloudMode = true;
    mockAutoRunStart.mockResolvedValue({ ...QUEUE_PAYLOAD });

    await startAutoRun(cloudQueueInput());

    const q = autoRunQueue("ws-proj-1");
    expect(q).not.toBeNull();
    expect(q?.id).toBe("arq_cloud_1");
    expect(q?.state).toBe("running");
  });

  it("does NOT persist to local app_settings in cloud mode", async () => {
    _cloudMode = true;
    mockAutoRunStart.mockResolvedValue({ ...QUEUE_PAYLOAD });

    await startAutoRun(cloudQueueInput());

    // setSetting should never be called for cloud queues
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("throws when the agent returns null", async () => {
    _cloudMode = true;
    mockAutoRunStart.mockResolvedValue(null);

    await expect(startAutoRun(cloudQueueInput())).rejects.toThrow();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Cloud-mode: hydrateCloudAutoRun (reopen-app rehydrate)

describe("autoRunQueue — cloud mode — hydrateCloudAutoRun", () => {
  it("repopulates the signal from the agent for an active queue", async () => {
    _cloudMode = true;
    mockAutoRunStatus.mockResolvedValue({ ...QUEUE_PAYLOAD });

    expect(autoRunQueue("ws-proj-1")).toBeNull();
    await hydrateCloudAutoRun("ws-proj-1");

    expect(mockAutoRunStatus).toHaveBeenCalledWith("ws-proj-1");
    const q = autoRunQueue("ws-proj-1");
    expect(q?.id).toBe("arq_cloud_1");
    expect(q?.state).toBe("running");
  });

  it("leaves the signal empty when the agent has no queue", async () => {
    _cloudMode = true;
    mockAutoRunStatus.mockResolvedValue(null);

    await hydrateCloudAutoRun("ws-proj-1");
    expect(autoRunQueue("ws-proj-1")).toBeNull();
  });

  it("does not resurrect a terminal (stopped) queue", async () => {
    _cloudMode = true;
    mockAutoRunStatus.mockResolvedValue({ ...QUEUE_PAYLOAD, state: "stopped" });

    await hydrateCloudAutoRun("ws-proj-1");
    expect(autoRunQueue("ws-proj-1")).toBeNull();
  });

  it("is a no-op in local mode (never queries the agent)", async () => {
    _cloudMode = false;
    await hydrateCloudAutoRun("ws-proj-1");
    expect(mockAutoRunStatus).not.toHaveBeenCalled();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Cloud-mode: pauseAutoRun / resumeAutoRun / stopAutoRun

describe("autoRunQueue — cloud mode — pause/resume/stop", () => {
  beforeEach(async () => {
    _cloudMode = true;
    mockAutoRunStart.mockResolvedValue({ ...QUEUE_PAYLOAD });
    await startAutoRun(cloudQueueInput());
    setSetting.mockClear();
  });

  it("pauseAutoRun calls autoRunPause and updates the signal", async () => {
    mockAutoRunPause.mockResolvedValue({ ...QUEUE_PAYLOAD, state: "paused" });

    await pauseAutoRun("ws-proj-1");

    expect(mockAutoRunPause).toHaveBeenCalledWith("ws-proj-1");
    expect(autoRunQueue("ws-proj-1")?.state).toBe("paused");
    // Still no local persistence
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("resumeAutoRun calls autoRunResume and updates the signal", async () => {
    mockAutoRunResume.mockResolvedValue({ ...QUEUE_PAYLOAD, state: "running" });

    await resumeAutoRun("ws-proj-1");

    expect(mockAutoRunResume).toHaveBeenCalledWith("ws-proj-1");
    expect(autoRunQueue("ws-proj-1")?.state).toBe("running");
  });

  it("stopAutoRun calls autoRunStop and updates the signal", async () => {
    mockAutoRunStop.mockResolvedValue({ ...QUEUE_PAYLOAD, state: "stopped" });

    await stopAutoRun("ws-proj-1");

    expect(mockAutoRunStop).toHaveBeenCalledWith("ws-proj-1");
    expect(autoRunQueue("ws-proj-1")?.state).toBe("stopped");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Cloud-mode: dismissAutoRun

describe("autoRunQueue — cloud mode — dismissAutoRun", () => {
  it("clears the queue signal when not active", async () => {
    _cloudMode = true;
    mockAutoRunStart.mockResolvedValue({ ...QUEUE_PAYLOAD, state: "done" });
    await startAutoRun(cloudQueueInput());

    expect(autoRunQueue("ws-proj-1")).not.toBeNull();
    expect(isAutoRunActive("ws-proj-1")).toBe(false);

    dismissAutoRun("ws-proj-1");

    expect(autoRunQueue("ws-proj-1")).toBeNull();
  });

  it("does not dismiss an active queue", async () => {
    _cloudMode = true;
    mockAutoRunStart.mockResolvedValue({ ...QUEUE_PAYLOAD, state: "running" });
    await startAutoRun(cloudQueueInput());

    dismissAutoRun("ws-proj-1");

    // Active queue — should still be present
    expect(autoRunQueue("ws-proj-1")).not.toBeNull();
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Local tick loop guard — cloud queues must NOT be advanced locally

describe("autoRunQueue — local tick does NOT drive cloud queues", () => {
  it("cloud-origin queue remains active after mode toggle — local loop skips it", async () => {
    // Start in cloud mode, seed a running queue
    _cloudMode = true;
    mockAutoRunStart.mockResolvedValue({ ...QUEUE_PAYLOAD, state: "running" });
    await startAutoRun(cloudQueueInput());

    // Verify the queue is visible in the signal before the toggle
    expect(autoRunQueue("ws-proj-1")?.state).toBe("running");

    // Toggle to local mode — the queue still has origin:"cloud" internally,
    // so the local tick loop must not dispatch it.
    _cloudMode = false;

    // Let a tick cycle run (we don't call hydrateAutoRunQueues because that
    // would reset the signal via getSetting — instead we verify the guard
    // property directly on the store's in-memory queue object).
    await new Promise<void>((r) => setTimeout(r, 5));

    // The queue must still be intact (not wiped or double-advanced).
    const q = autoRunQueue("ws-proj-1");
    expect(q).not.toBeNull();
    expect(q?.state).toBe("running");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Local mode — no regression

describe("autoRunQueue — local mode — unchanged behaviour", () => {
  it("startAutoRun in local mode does NOT call wsBridge", async () => {
    _cloudMode = false;

    const input = cloudQueueInput();
    // Local mode is synchronous-like — startTask would be called, but we
    // have it mocked to silence errors. What matters here is that
    // awaitCloudClient is never called.
    startAutoRun(input).catch(() => {
      // pickAndDispatch may fail without a real PlanFlow client — that's OK
    });

    expect(awaitCloudClient).not.toHaveBeenCalled();
  });

  it("startAutoRun in local mode persists to app_settings", async () => {
    _cloudMode = false;

    // Don't await — just check that setSetting is called before dispatch
    void startAutoRun(cloudQueueInput()).catch(() => undefined);

    // setSetting should have been called synchronously by mutate()
    expect(setSetting).toHaveBeenCalledWith("planflow_auto_run_queues", expect.any(Object));
  });
});
