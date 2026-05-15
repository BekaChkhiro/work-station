// T13.2 / T19.11 — Frontend wrapper around the `fs_list_dir` IPC.
//
// The Rust handler is covered by `cargo test` on
// `src-tauri/src/commands/fs.rs`. These tests pin the wire shape of
// the local invoke call and the cloud-mode short-circuit: the
// cloud-agent has no filesystem RPC, so `fsListDir` raises
// `CloudTransportUnsupportedError` rather than listing the desktop's
// filesystem under remote project paths.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  CloudTransportUnsupportedError,
  _resetCloudAgentManagerFactoryForTests,
  _setCloudAgentManagerForTests,
} from "./transport";
import type { CloudAgentManager } from "../integrations/cloudAgent";
import type { WsBridgeClient } from "../integrations/wsBridge";
import { _resetCloudModeForTests, setCloudMode } from "../stores/cloudMode";
import { fsListDir } from "./fs";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

function makeStubManager(client: WsBridgeClient): CloudAgentManager {
  let state: ReturnType<CloudAgentManager["state"]> = "open";
  return {
    state: () => state,
    client: () => client,
    endpoint: () => null,
    connect: async () => {
      // Pre-seeded "open" — dial is a no-op.
    },
    disconnect: () => {
      state = "closed";
    },
    dispose: () => {
      // no-op
    },
  };
}

beforeEach(() => {
  invokeMock.mockReset();
  _setCloudAgentManagerForTests(null);
  _resetCloudAgentManagerFactoryForTests();
  _resetCloudModeForTests();
});

afterEach(() => {
  invokeMock.mockReset();
  _setCloudAgentManagerForTests(null);
  _resetCloudAgentManagerFactoryForTests();
  _resetCloudModeForTests();
});

describe("fsListDir", () => {
  it("invokes `fs_list_dir` with the path and a default respectGitignore=true", async () => {
    invokeMock.mockResolvedValueOnce([{ name: "a", path: "/p/a", isDir: false }]);

    const entries = await fsListDir("/p");

    expect(invokeMock).toHaveBeenCalledWith("fs_list_dir", {
      path: "/p",
      respectGitignore: true,
    });
    expect(entries).toEqual([{ name: "a", path: "/p/a", isDir: false }]);
  });

  it("passes through an explicit respectGitignore=false", async () => {
    invokeMock.mockResolvedValueOnce([]);

    await fsListDir("/p", { respectGitignore: false });

    expect(invokeMock).toHaveBeenCalledWith("fs_list_dir", {
      path: "/p",
      respectGitignore: false,
    });
  });

  it("rejects when the response is not the expected shape", async () => {
    invokeMock.mockResolvedValueOnce([{ name: 1 }]);
    await expect(fsListDir("/p")).rejects.toBeTruthy();
  });

  it("throws CloudTransportUnsupportedError in cloud mode without invoking the local backend", async () => {
    _setCloudAgentManagerForTests(makeStubManager({} as unknown as WsBridgeClient));
    await setCloudMode(true);

    await expect(fsListDir("/p")).rejects.toBeInstanceOf(CloudTransportUnsupportedError);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
