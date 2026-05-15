// T13.3 / T13.4 — Frontend wrappers around the files IPC.
// T19.11 — Cloud routing: the cloud-agent has no `read_text_file` /
//          `write_text_file` RPC, so both wrappers raise
//          `CloudTransportUnsupportedError` in cloud mode rather than
//          silently reading/writing the desktop's filesystem under
//          remote project paths.
//
// These tests don't drive the Rust handler — that's covered by
// `cargo test` on `src-tauri/src/commands/files.rs`. They pin the shape
// of the invoke call (command name + argument keys) and the cloud-mode
// short-circuit.

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
import { readTextFile, writeTextFile } from "./files";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

function makeStubManager(client: WsBridgeClient): CloudAgentManager {
  let state: ReturnType<CloudAgentManager["state"]> = "open";
  return {
    state: () => state,
    client: () => client,
    endpoint: () => null,
    connect: async () => {
      // Pre-seeded "open" — dial is a no-op in tests.
    },
    disconnect: () => {
      state = "closed";
    },
    dispose: () => {
      // no-op for the stub
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

describe("readTextFile", () => {
  it("invokes `read_text_file` and parses the text response", async () => {
    invokeMock.mockResolvedValueOnce({
      kind: "text",
      content: "hello\n",
      encoding: "utf-8",
    });

    const result = await readTextFile("/root", "rel/path.txt");

    expect(invokeMock).toHaveBeenCalledWith("read_text_file", {
      projectRoot: "/root",
      relativePath: "rel/path.txt",
    });
    expect(result).toEqual({
      kind: "text",
      content: "hello\n",
      encoding: "utf-8",
    });
  });

  it("rejects when the response shape is unknown", async () => {
    invokeMock.mockResolvedValueOnce({ kind: "wibble" });
    await expect(readTextFile("/root", "x.txt")).rejects.toBeTruthy();
  });

  it("throws CloudTransportUnsupportedError in cloud mode without invoking the local backend", async () => {
    _setCloudAgentManagerForTests(makeStubManager({} as unknown as WsBridgeClient));
    await setCloudMode(true);

    await expect(readTextFile("/root", "x.txt")).rejects.toBeInstanceOf(
      CloudTransportUnsupportedError,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

describe("writeTextFile", () => {
  it("invokes `write_text_file` with the full payload, defaulting encoding to utf-8", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await writeTextFile("/root", "rel/path.txt", "hello\n");

    expect(invokeMock).toHaveBeenCalledWith("write_text_file", {
      projectRoot: "/root",
      relativePath: "rel/path.txt",
      content: "hello\n",
      encoding: "utf-8",
    });
  });

  it("round-trips a UTF-8 BOM encoding tag when explicitly passed", async () => {
    invokeMock.mockResolvedValueOnce(undefined);

    await writeTextFile("/root", "bom.txt", "hi\n", "utf-8-bom");

    expect(invokeMock).toHaveBeenCalledWith("write_text_file", {
      projectRoot: "/root",
      relativePath: "bom.txt",
      content: "hi\n",
      encoding: "utf-8-bom",
    });
  });

  it("propagates errors from invoke", async () => {
    invokeMock.mockRejectedValueOnce(new Error("nope"));
    await expect(writeTextFile("/root", "x.txt", "")).rejects.toThrow("nope");
  });

  it("throws CloudTransportUnsupportedError in cloud mode without invoking the local backend", async () => {
    _setCloudAgentManagerForTests(makeStubManager({} as unknown as WsBridgeClient));
    await setCloudMode(true);

    await expect(writeTextFile("/root", "x.txt", "hi")).rejects.toBeInstanceOf(
      CloudTransportUnsupportedError,
    );
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
