// T13.3 / T13.4 — Frontend wrappers around the files IPC.
//
// These tests don't drive the Rust handler — that's covered by
// `cargo test` on `src-tauri/src/commands/files.rs`. They pin the shape
// of the invoke call (command name + argument keys) so a future
// rename on either side fails loudly here instead of at runtime in the
// editor.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { readTextFile, writeTextFile } from "./files";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  invokeMock.mockReset();
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
});
