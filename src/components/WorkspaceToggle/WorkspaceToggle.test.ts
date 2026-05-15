// T19.8 — Unit tests for the WorkspaceToggle pairing-state helper. The
// component itself is exercised manually via the Sidebar harness; the
// derivation that drives the status dot is the part that needs to be
// locked against regressions because every cloud_agent_status shape
// flows through it.

import { describe, expect, it } from "vitest";

import { cloudPairingState } from "./WorkspaceToggle";

describe("cloudPairingState", () => {
  it("returns 'unpaired' when no agent URL is set", () => {
    expect(cloudPairingState(null, null)).toBe("unpaired");
    expect(cloudPairingState(null, { pairedAt: 1 })).toBe("unpaired");
  });

  it("returns 'paired' when an agent URL is set and the status has no needsRepairAt", () => {
    expect(cloudPairingState("wss://agent.example.com", null)).toBe("paired");
    expect(cloudPairingState("wss://agent.example.com", { pairedAt: 1 })).toBe("paired");
    expect(cloudPairingState("wss://agent.example.com", { pairedAt: 1, needsRepairAt: null })).toBe(
      "paired",
    );
  });

  it("returns 'needs-repair' when needsRepairAt is set", () => {
    expect(
      cloudPairingState("wss://agent.example.com", { pairedAt: 1, needsRepairAt: 1_700_000_000 }),
    ).toBe("needs-repair");
  });

  it("treats an undefined needsRepairAt the same as null — both mean healthy", () => {
    expect(cloudPairingState("wss://agent.example.com", { pairedAt: 1 })).toBe("paired");
  });
});
