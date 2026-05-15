// T19.16 — Unit tests for the CloudConnectionBanner state mapper.
//
// The component itself is a thin reactive wrapper around `describeBanner`;
// the mapping decides visibility, tone, copy, and whether a Settings
// action shows up — so locking that mapping covers the interesting
// regressions without pulling in a DOM testing library this repo doesn't
// otherwise use.

import { describe, expect, it } from "vitest";

import { describeBanner } from "./CloudConnectionBanner";
import type { CloudAgentConnectionState } from "../../integrations/cloudAgent";

describe("describeBanner()", () => {
  it("returns null when cloud mode is off, regardless of state", () => {
    const states: CloudAgentConnectionState[] = [
      "idle",
      "connecting",
      "open",
      "closed",
      "reconnecting",
      "closing",
      "disabled",
      "unconfigured",
      "no_token",
    ];
    for (const state of states) {
      expect(describeBanner(state, false)).toBeNull();
    }
  });

  it("hides for idle / open / disabled when cloud mode is on", () => {
    expect(describeBanner("idle", true)).toBeNull();
    expect(describeBanner("open", true)).toBeNull();
    expect(describeBanner("disabled", true)).toBeNull();
  });

  it("renders info tone for connecting", () => {
    const view = describeBanner("connecting", true);
    expect(view).not.toBeNull();
    expect(view?.tone).toBe("info");
    expect(view?.title.toLowerCase()).toContain("connecting");
    expect(view?.action).toBeUndefined();
  });

  it("renders warning tone for reconnecting / closed / closing", () => {
    for (const state of ["reconnecting", "closed", "closing"] as const) {
      const view = describeBanner(state, true);
      expect(view).not.toBeNull();
      expect(view?.tone).toBe("warning");
      expect(view?.action).toBeUndefined();
    }
  });

  it("renders warning tone + Settings action for unconfigured / no_token", () => {
    for (const state of ["unconfigured", "no_token"] as const) {
      const view = describeBanner(state, true);
      expect(view).not.toBeNull();
      expect(view?.tone).toBe("warning");
      expect(view?.action?.label.toLowerCase()).toContain("settings");
    }
  });
});
