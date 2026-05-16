// T19.9 — Tests for the projects data layer's cloud routing.
//
// The Tauri side is exercised by `cargo test` on
// `src-tauri/src/commands/projects.rs`; the cloud-agent's matching
// `project_*` handlers are exercised by `cargo test -p cloud-agent`.
// These tests pin the transport choice each wrapper makes:
//
//   • `listProjects` reads from Tauri in local mode and from the
//     cloud-agent's `projectsList` in cloud mode.
//   • Every write path (create / update / delete / reorder /
//     update_workspace_tabs) routes to the matching WS handler in
//     cloud mode and to Tauri in local mode.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
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
  it("createProject routes to projectCreate over WS and parses the reply", async () => {
    const projectCreate = vi.fn(async () => projectFixture({ id: "remote-1" }));
    const stubClient = { projectCreate } as unknown as WsBridgeClient;
    _setCloudAgentManagerForTests(makeStubManager(stubClient));
    await setCloudMode(true);

    const result = await createProject({ name: "alpha", path: "/srv/alpha" });

    expect(projectCreate).toHaveBeenCalledWith({
      name: "alpha",
      path: "/srv/alpha",
      color: null,
      icon: null,
      defaultCli: null,
      env: {},
      startupCommands: [],
    });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.id).toBe("remote-1");
  });

  it("updateProject routes to projectUpdate over WS", async () => {
    const projectUpdate = vi.fn(async () => projectFixture({ id: "p1" }));
    const stubClient = { projectUpdate } as unknown as WsBridgeClient;
    _setCloudAgentManagerForTests(makeStubManager(stubClient));
    await setCloudMode(true);

    await updateProject({ id: "p1", name: "renamed", path: "/srv/p" });

    expect(projectUpdate).toHaveBeenCalledWith({
      id: "p1",
      name: "renamed",
      path: "/srv/p",
      color: null,
      icon: null,
      defaultCli: null,
      env: {},
      startupCommands: [],
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("deleteProject routes to projectDelete over WS", async () => {
    const projectDelete = vi.fn(async () => undefined);
    const stubClient = { projectDelete } as unknown as WsBridgeClient;
    _setCloudAgentManagerForTests(makeStubManager(stubClient));
    await setCloudMode(true);

    await deleteProject("p1");

    expect(projectDelete).toHaveBeenCalledWith("p1");
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("reorderProjects routes to projectReorder over WS", async () => {
    const projectReorder = vi.fn(async () => undefined);
    const stubClient = { projectReorder } as unknown as WsBridgeClient;
    _setCloudAgentManagerForTests(makeStubManager(stubClient));
    await setCloudMode(true);

    await reorderProjects(["p2", "p1"]);

    expect(projectReorder).toHaveBeenCalledWith(["p2", "p1"]);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("updateProjectWorkspaceTabs routes to projectUpdateWorkspaceTabs over WS", async () => {
    const projectUpdateWorkspaceTabs = vi.fn(async () => undefined);
    const stubClient = { projectUpdateWorkspaceTabs } as unknown as WsBridgeClient;
    _setCloudAgentManagerForTests(makeStubManager(stubClient));
    await setCloudMode(true);

    await updateProjectWorkspaceTabs("p1", ["terminal", "editor"], "editor");

    expect(projectUpdateWorkspaceTabs).toHaveBeenCalledWith("p1", ["terminal", "editor"], "editor");
    expect(invokeMock).not.toHaveBeenCalled();
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
