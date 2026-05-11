// T12.4 — Unit tests for the workspace → active task id store.

import { afterEach, describe, expect, it } from "vitest";

import { _resetActiveTaskForTests, activeTaskId, setActiveTaskId } from "./activeTask";

afterEach(() => {
  _resetActiveTaskForTests();
});

describe("activeTaskId / setActiveTaskId", () => {
  it("returns null when no task has been set", () => {
    expect(activeTaskId("project-a")).toBe(null);
  });

  it("stores per-project entries independently", () => {
    setActiveTaskId("project-a", "T12.4");
    setActiveTaskId("project-b", "T1.1");
    expect(activeTaskId("project-a")).toBe("T12.4");
    expect(activeTaskId("project-b")).toBe("T1.1");
  });

  it("overwrites the entry for the same project", () => {
    setActiveTaskId("project-a", "T12.4");
    setActiveTaskId("project-a", "T12.5");
    expect(activeTaskId("project-a")).toBe("T12.5");
  });

  it("clears the entry when set to null without disturbing other projects", () => {
    setActiveTaskId("project-a", "T12.4");
    setActiveTaskId("project-b", "T1.1");
    setActiveTaskId("project-a", null);
    expect(activeTaskId("project-a")).toBe(null);
    expect(activeTaskId("project-b")).toBe("T1.1");
  });

  it("is a no-op when clearing a project that has no entry", () => {
    setActiveTaskId("project-b", "T1.1");
    setActiveTaskId("project-a", null);
    expect(activeTaskId("project-b")).toBe("T1.1");
  });
});
