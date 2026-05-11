// T12.8 — Unit tests for the mention helpers used by the task-detail
// composer. These two pure functions decide which member shows up under
// an @query and how their handle is rendered into the textarea, so they
// need to be locked against regressions even though the surrounding
// component itself is exercised manually.

import { describe, expect, it } from "vitest";

import { mentionHandleFor, mentionMatches } from "./TaskDetailPanel";
import type { UserSummary } from "../../integrations";

describe("mentionHandleFor", () => {
  it("prefers the email local-part — names contain spaces and would need quoting", () => {
    const user: UserSummary = { id: "1", email: "alex@example.com", name: "Alex Example" };
    expect(mentionHandleFor(user)).toBe("alex");
  });

  it("falls back to a slugged name when no email is set", () => {
    const user: UserSummary = { id: "1", name: "Alex Example" };
    expect(mentionHandleFor(user)).toBe("alex-example");
  });

  it("falls back to the id when neither email nor name is present", () => {
    const user: UserSummary = { id: "user-42" };
    expect(mentionHandleFor(user)).toBe("user-42");
  });

  it("treats an empty email as missing and slugs the name instead", () => {
    const user: UserSummary = { id: "1", email: "", name: "Alex Example" };
    expect(mentionHandleFor(user)).toBe("alex-example");
  });
});

describe("mentionMatches", () => {
  const user: UserSummary = { id: "1", email: "alex@example.com", name: "Alex Example" };

  it("returns true for any user when the query is empty", () => {
    expect(mentionMatches(user, "")).toBe(true);
  });

  it("matches case-insensitively against the name", () => {
    expect(mentionMatches(user, "alex")).toBe(true);
    expect(mentionMatches(user, "EXAMPLE")).toBe(true);
  });

  it("matches against the email", () => {
    expect(mentionMatches(user, "alex@")).toBe(true);
  });

  it("matches against the derived handle", () => {
    const nameOnly: UserSummary = { id: "1", name: "Alex Example" };
    expect(mentionMatches(nameOnly, "alex-ex")).toBe(true);
  });

  it("returns false when nothing on the user mentions the query", () => {
    expect(mentionMatches(user, "zelda")).toBe(false);
  });

  it("handles users without name or email — falls back to id matching", () => {
    const idOnly: UserSummary = { id: "user-42" };
    expect(mentionMatches(idOnly, "user")).toBe(true);
    expect(mentionMatches(idOnly, "nope")).toBe(false);
  });
});
