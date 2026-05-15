// T19.17 — Tests for the per-mode scoping in `getOrCreateProjectSession`.
//
// The SQL the helper sends is the contract between the renderer and the
// `sessions` table after migration 0012. These tests pin:
//
//   • The lookup query filters by both `project_id` AND `mode`, so a row
//     created in Local mode is invisible to a Cloud-mode lookup (and vice
//     versa).
//   • The insert path writes the `mode` column, so the row created on
//     first launch in either mode lands in its own bucket.
//   • The default `mode` is `'local'` — pre-T19.17 callers (none in the
//     repo today, but the public type signature still admits them) keep
//     pointing at the same row migration 0012 left in place.
//
// We don't exercise a live SQLite handle — the migration runner has its
// own Rust-side coverage. Here we mock `@tauri-apps/plugin-sql` and
// assert on the arguments the helper passes through.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const selectMock = vi.fn<(sql: string, args: unknown[]) => Promise<unknown[]>>();
const executeMock = vi.fn<(sql: string, args: unknown[]) => Promise<unknown>>();

vi.mock("@tauri-apps/plugin-sql", () => ({
  default: {
    load: vi.fn(async () => ({
      select: selectMock,
      execute: executeMock,
    })),
  },
}));

import { getOrCreateProjectSession } from "./sessions";

describe("getOrCreateProjectSession (T19.17)", () => {
  beforeEach(() => {
    selectMock.mockReset();
    executeMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("filters the lookup by (project_id, mode)", async () => {
    selectMock.mockResolvedValueOnce([{ id: "row-1", layout_json: "{}" }]);

    await getOrCreateProjectSession("p1", null, null, "cloud");

    expect(selectMock).toHaveBeenCalledTimes(1);
    const call = selectMock.mock.calls[0];
    if (!call) throw new Error("expected select to be called");
    const [sql, args] = call;
    expect(sql).toContain("project_id = ?");
    expect(sql).toContain("mode = ?");
    expect(args).toEqual(["p1", "cloud"]);
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("inserts a new row tagged with the requested mode when none exists", async () => {
    selectMock.mockResolvedValueOnce([]);

    const result = await getOrCreateProjectSession("p1", "claude", "/tmp/p1", "cloud");

    expect(executeMock).toHaveBeenCalledTimes(1);
    const call = executeMock.mock.calls[0];
    if (!call) throw new Error("expected execute to be called");
    const [sql, args] = call;
    expect(sql).toContain("INSERT INTO sessions");
    expect(sql).toContain("mode");
    // Order matches the column list in the INSERT: id, project_id, title,
    // cli, cwd, layout_json, created_at, mode.
    expect(args[1]).toBe("p1");
    expect(args[3]).toBe("claude");
    expect(args[4]).toBe("/tmp/p1");
    expect(args[7]).toBe("cloud");
    expect(typeof result.id).toBe("string");
    expect(result.id).not.toHaveLength(0);
  });

  it("defaults to local mode when no mode is supplied", async () => {
    selectMock.mockResolvedValueOnce([]);

    await getOrCreateProjectSession("p2", null, null);

    expect(selectMock.mock.calls[0]?.[1]).toEqual(["p2", "local"]);
    expect(executeMock.mock.calls[0]?.[1]?.[7]).toBe("local");
  });

  it("isolates Local and Cloud rows for the same project", async () => {
    // First call (local) finds nothing → inserts.
    selectMock.mockResolvedValueOnce([]);
    const local = await getOrCreateProjectSession("p3", null, null, "local");

    // Second call (cloud) also finds nothing — even though Local exists,
    // the (project_id, mode) filter must scope it out.
    selectMock.mockResolvedValueOnce([]);
    const cloud = await getOrCreateProjectSession("p3", null, null, "cloud");

    expect(local.id).not.toBe(cloud.id);
    expect(executeMock).toHaveBeenCalledTimes(2);
    expect(executeMock.mock.calls[0]?.[1]?.[7]).toBe("local");
    expect(executeMock.mock.calls[1]?.[1]?.[7]).toBe("cloud");
  });
});
