// T13.5 — Frontend wrappers around the file-watch IPC + event channel.
//
// Same approach as files.test.ts: mock the Tauri primitives and assert
// the wire shape (command name + argument keys, event name). The Rust
// handler itself is covered by `cargo test` on `src-tauri/src/commands/watch.rs`.

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  onExternalChange,
  startFileWatch,
  stopFileWatch,
  type ExternalChangeEvent,
} from "./fileWatch";

const invokeMock = invoke as unknown as ReturnType<typeof vi.fn>;
const listenMock = listen as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  invokeMock.mockReset();
  listenMock.mockReset();
});

describe("startFileWatch", () => {
  it("invokes `start_file_watch` and returns the numeric watch id", async () => {
    invokeMock.mockResolvedValueOnce(42);

    const id = await startFileWatch("/root", "src/foo.ts");

    expect(invokeMock).toHaveBeenCalledWith("start_file_watch", {
      projectRoot: "/root",
      relativePath: "src/foo.ts",
    });
    expect(id).toBe(42);
  });

  it("rejects when the backend returns something that is not a number", async () => {
    invokeMock.mockResolvedValueOnce("not-a-number");
    await expect(startFileWatch("/root", "x.ts")).rejects.toThrow(/non-numeric/);
  });
});

describe("stopFileWatch", () => {
  it("invokes `stop_file_watch` with the camel-cased watchId", async () => {
    invokeMock.mockResolvedValueOnce(undefined);
    await stopFileWatch(7);
    expect(invokeMock).toHaveBeenCalledWith("stop_file_watch", { watchId: 7 });
  });
});

const noop = (): void => undefined;

describe("onExternalChange", () => {
  it("subscribes to `file:external-change` and parses well-formed payloads", async () => {
    let captured: ((event: { payload: unknown }) => void) | null = null;
    listenMock.mockImplementation(
      (_name: string, handler: (event: { payload: unknown }) => void) => {
        captured = handler;
        return Promise.resolve(noop);
      },
    );

    const events: ExternalChangeEvent[] = [];
    await onExternalChange((e) => events.push(e));

    expect(listenMock).toHaveBeenCalledWith("file:external-change", expect.any(Function));
    if (captured === null) throw new Error("listen handler was never captured");
    const handler = captured as (event: { payload: unknown }) => void;

    handler({
      payload: {
        watchId: 5,
        content: "abc",
        encoding: "utf-8",
        hash: "deadbeef",
      },
    });

    expect(events).toEqual([{ watchId: 5, content: "abc", encoding: "utf-8", hash: "deadbeef" }]);
  });

  it("ignores payloads that don't match the schema", async () => {
    let captured: ((event: { payload: unknown }) => void) | null = null;
    listenMock.mockImplementation(
      (_name: string, handler: (event: { payload: unknown }) => void) => {
        captured = handler;
        return Promise.resolve(noop);
      },
    );
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(noop);

    const events: ExternalChangeEvent[] = [];
    await onExternalChange((e) => events.push(e));

    if (captured === null) throw new Error("listen handler was never captured");
    const handler = captured as (event: { payload: unknown }) => void;

    handler({ payload: { watchId: "five" } });
    handler({ payload: null });

    expect(events).toEqual([]);
    expect(consoleWarn).toHaveBeenCalled();
    consoleWarn.mockRestore();
  });
});
