// T19.9 — Tests for the projects data layer's cloud routing.
//
// The Tauri side is exercised by `cargo test` on
// `src-tauri/src/commands/projects.rs`. These tests pin the transport
// choice each wrapper makes:
//
//   • `listProjects` reads from Tauri in local mode and from the
//     cloud-agent's `projectsList` in cloud mode.
//   • All write paths short-circuit via `routeIpcLocalOnly` so cloud
//     mode raises `CloudTransportUnsupportedError` instead of writing
//     to the desktop's local SQLite while the user is browsing a
//     remote workspace.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  CloudTransportUnsupportedError,
  _resetCloudAgentManagerFactoryForTests,
  _setCloudAgentManagerForTests,
} from "../ipc/transport";
import type { CloudAgentManager } from "../integrations/cloudAgent";
import type { WsBridgeClient } from "../integrations/wsBridge";
import { _resetCloudModeForTests, setCloudMode } from "../stores/cloudMode";
import {
  createProject,
  deleteProject,
  listProjects,
  reorderProjects,
  updateProject,
  updateProjectWorkspaceTabs,
} from "./projects";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

type ManagerState = ReturnType<CloudAgentManager["state"]>;

interface StubManager extends CloudAgentManager {
  setState(next: ManagerState): void;
}

function makeStubManager(client: WsBridgeClient, state: ManagerState = "open"): StubManager {
  let currentState = state;
  let disposed = false;
  return {
    state: () => currentState,
    client: () => client,
    endpoint: () => null,
    connect: async () => {
      // Stub: the routing tests pre-seed the state to "open", so a
      // dial is a no-op rather than an actual connect.
      return;
    },
    disconnect: () => {
      currentState = "closed";
    },
    dispose: () => {
      disposed = true;
    },
    setState: (next) => {
      if (disposed) return;
      currentState = next;
    },
  };
}

function projectFixture(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    id: "p1",
    name: "alpha",
    path: "/tmp/alpha",
    color: null,
    icon: null,
    defaultCli: null,
    env: {},
    startupCommands: [],
    workspaceTabs: ["terminal", "editor"],
    activeWorkspaceTab: "terminal",
    position: 0,
    createdAt: 1_700_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  _setCloudAgentManagerForTests(null);
  _resetCloudAgentManagerFactoryForTests();
  _resetCloudModeForTests();
});

afterEach(() => {
  _setCloudAgentManagerForTests(null);
  _resetCloudAgentManagerFactoryForTests();
  _resetCloudModeForTests();
});

describe("listProjects()", () => {
  it("invokes `project_list` and parses the response in local mode", async () => {
    invokeMock.mockResolvedValueOnce([projectFixture()]);

    const result = await listProjects();

    expect(invokeMock).toHaveBeenCalledWith("project_list");
    expect(result).toHaveLength(1);
    expect(result[0]?.id).toBe("p1");
  });

  it("routes through the cloud client and re-validates with the Zod schema", async () => {
    const projectsList = vi.fn(async () => [projectFixture({ id: "remote-1" })]);
    const stubClient = { projectsList } as unknown as WsBridgeClient;
    _setCloudAgentManagerForTests(makeStubManager(stubClient));
    await setCloudMode(true);

    const result = await listProjects();

    expect(projectsList).toHaveBeenCalledTimes(1);
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result[0]?.id).toBe("remote-1");
  });
});

describe("project mutations in cloud mode", () => {
  beforeEach(async () => {
    const stubClient = {} as unknown as WsBridgeClient;
    _setCloudAgentManagerForTests(makeStubManager(stubClient));
    await setCloudMode(true);
  });

  it("createProject throws CloudTransportUnsupportedError naming the operation", async () => {
    await expect(createProject({ name: "n", path: "/p" })).rejects.toBeInstanceOf(
      CloudTransportUnsupportedError,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("updateProject throws CloudTransportUnsupportedError", async () => {
    await expect(updateProject({ id: "p1", name: "n", path: "/p" })).rejects.toBeInstanceOf(
      CloudTransportUnsupportedError,
    );
  });

  it("deleteProject throws CloudTransportUnsupportedError", async () => {
    await expect(deleteProject("p1")).rejects.toBeInstanceOf(CloudTransportUnsupportedError);
  });

  it("reorderProjects throws CloudTransportUnsupportedError", async () => {
    await expect(reorderProjects(["p1", "p2"])).rejects.toBeInstanceOf(
      CloudTransportUnsupportedError,
    );
  });

  it("updateProjectWorkspaceTabs throws CloudTransportUnsupportedError", async () => {
    await expect(updateProjectWorkspaceTabs("p1", ["terminal"], "terminal")).rejects.toBeInstanceOf(
      CloudTransportUnsupportedError,
    );
  });
});

describe("project mutations in local mode", () => {
  it("createProject normalises optional fields before invoking `project_create`", async () => {
    invokeMock.mockResolvedValueOnce(projectFixture());

    await createProject({ name: "alpha", path: "/tmp/alpha" });

    expect(invokeMock).toHaveBeenCalledWith("project_create", {
      args: {
        name: "alpha",
        path: "/tmp/alpha",
        color: null,
        icon: null,
        defaultCli: null,
        env: {},
        startupCommands: [],
      },
    });
  });

  it("deleteProject invokes `project_delete` with the id", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await deleteProject("p1");
    expect(invokeMock).toHaveBeenCalledWith("project_delete", { args: { id: "p1" } });
  });

  it("reorderProjects passes the id array verbatim", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await reorderProjects(["p1", "p2"]);
    expect(invokeMock).toHaveBeenCalledWith("project_reorder", { args: { ids: ["p1", "p2"] } });
  });

  it("updateProjectWorkspaceTabs passes visible + active tabs", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await updateProjectWorkspaceTabs("p1", ["terminal", "editor"], "editor");
    expect(invokeMock).toHaveBeenCalledWith("project_update_workspace_tabs", {
      args: { id: "p1", visible: ["terminal", "editor"], active: "editor" },
    });
  });
});
