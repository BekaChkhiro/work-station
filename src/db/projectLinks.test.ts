// T19.33 — Tests for the project_link data layer's cloud routing.
//
// The Tauri side is exercised by `cargo test` on
// `src-tauri/src/commands/project_links.rs`; the cloud-agent's matching
// `project_link_*` handlers are exercised by `cargo test -p cloud-agent`.
// These tests pin the transport choice each wrapper makes:
//
//   • `listProjectLinks` reads from Tauri in local mode and from the
//     cloud-agent's `projectLinkList` in cloud mode.
//   • Write paths (set / delete) route to the matching WS handler in
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
import { deleteProjectLink, listProjectLinks, setProjectLink } from "./projectLinks";

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

function linkFixture(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    projectId: "p1",
    service: "github",
    externalId: "acme/web",
    metadata: { htmlUrl: "https://github.com/acme/web" },
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

describe("listProjectLinks()", () => {
  it("invokes `project_link_list` and parses the response in local mode", async () => {
    invokeMock.mockResolvedValueOnce([linkFixture()]);

    const result = await listProjectLinks("p1");

    expect(invokeMock).toHaveBeenCalledWith("project_link_list", { args: { projectId: "p1" } });
    expect(result).toHaveLength(1);
    expect(result[0]?.externalId).toBe("acme/web");
  });

  it("routes through the cloud client and re-validates with the Zod schema", async () => {
    const projectLinkList = vi.fn(async () => [linkFixture({ externalId: "remote/repo" })]);
    const stubClient = { projectLinkList } as unknown as WsBridgeClient;
    _setCloudAgentManagerForTests(makeStubManager(stubClient));
    await setCloudMode(true);

    const result = await listProjectLinks("p1");

    expect(projectLinkList).toHaveBeenCalledWith("p1");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result[0]?.externalId).toBe("remote/repo");
  });
});

describe("project_link mutations in cloud mode", () => {
  it("setProjectLink routes to projectLinkSet over WS and parses the reply", async () => {
    const projectLinkSet = vi.fn(async () => linkFixture({ externalId: "acme/web" }));
    const stubClient = { projectLinkSet } as unknown as WsBridgeClient;
    _setCloudAgentManagerForTests(makeStubManager(stubClient));
    await setCloudMode(true);

    const result = await setProjectLink({
      projectId: "p1",
      service: "github",
      externalId: "acme/web",
      metadata: { htmlUrl: "https://github.com/acme/web" },
    });

    expect(projectLinkSet).toHaveBeenCalledWith({
      projectId: "p1",
      service: "github",
      externalId: "acme/web",
      metadata: { htmlUrl: "https://github.com/acme/web" },
    });
    expect(invokeMock).not.toHaveBeenCalled();
    expect(result.externalId).toBe("acme/web");
  });

  it("setProjectLink defaults metadata to {} when omitted", async () => {
    const projectLinkSet = vi.fn(async () => linkFixture({ metadata: {} }));
    const stubClient = { projectLinkSet } as unknown as WsBridgeClient;
    _setCloudAgentManagerForTests(makeStubManager(stubClient));
    await setCloudMode(true);

    await setProjectLink({ projectId: "p1", service: "github", externalId: "acme/web" });

    expect(projectLinkSet).toHaveBeenCalledWith({
      projectId: "p1",
      service: "github",
      externalId: "acme/web",
      metadata: {},
    });
  });

  it("deleteProjectLink routes to projectLinkDelete over WS", async () => {
    const projectLinkDelete = vi.fn(async () => true);
    const stubClient = { projectLinkDelete } as unknown as WsBridgeClient;
    _setCloudAgentManagerForTests(makeStubManager(stubClient));
    await setCloudMode(true);

    const removed = await deleteProjectLink("p1", "github", "acme/web");

    expect(projectLinkDelete).toHaveBeenCalledWith("p1", "github", "acme/web");
    expect(invokeMock).not.toHaveBeenCalled();
    expect(removed).toBe(true);
  });
});

describe("project_link mutations in local mode", () => {
  it("setProjectLink normalises optional metadata before invoking `project_link_set`", async () => {
    invokeMock.mockResolvedValueOnce(linkFixture({ metadata: {} }));

    await setProjectLink({ projectId: "p1", service: "github", externalId: "acme/web" });

    expect(invokeMock).toHaveBeenCalledWith("project_link_set", {
      args: {
        projectId: "p1",
        service: "github",
        externalId: "acme/web",
        metadata: {},
      },
    });
  });

  it("setProjectLink forwards a provided metadata payload verbatim", async () => {
    invokeMock.mockResolvedValueOnce(linkFixture());

    await setProjectLink({
      projectId: "p1",
      service: "github",
      externalId: "acme/web",
      metadata: { htmlUrl: "https://github.com/acme/web" },
    });

    expect(invokeMock).toHaveBeenCalledWith("project_link_set", {
      args: {
        projectId: "p1",
        service: "github",
        externalId: "acme/web",
        metadata: { htmlUrl: "https://github.com/acme/web" },
      },
    });
  });

  it("deleteProjectLink invokes `project_link_delete` with the triple", async () => {
    invokeMock.mockResolvedValueOnce(true);

    const removed = await deleteProjectLink("p1", "github", "acme/web");

    expect(invokeMock).toHaveBeenCalledWith("project_link_delete", {
      args: { projectId: "p1", service: "github", externalId: "acme/web" },
    });
    expect(removed).toBe(true);
  });
});
