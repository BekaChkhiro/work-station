// T19.5 — Unit tests for the cloud mode store.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getSetting = vi.fn();
const setSetting = vi.fn();

vi.mock("../db/settings", async () => {
  const actual = await vi.importActual<typeof import("../db/settings")>("../db/settings");
  return {
    ...actual,
    getSetting: (...args: unknown[]) => getSetting(...args),
    setSetting: (...args: unknown[]) => setSetting(...args),
  };
});

import {
  _resetCloudModeForTests,
  cloudAgentStatus,
  cloudAgentUrl,
  cloudMode,
  hydrateCloudMode,
  setCloudAgentStatus,
  setCloudAgentUrl,
  setCloudMode,
} from "./cloudMode";

beforeEach(() => {
  getSetting.mockReset();
  setSetting.mockReset();
  setSetting.mockResolvedValue(undefined);
});

afterEach(() => {
  _resetCloudModeForTests();
});

describe("cloud mode store — defaults", () => {
  it("seeds from the registered defaults", () => {
    expect(cloudMode()).toBe(false);
    expect(cloudAgentUrl()).toBe(null);
    expect(cloudAgentStatus()).toBe(null);
  });
});

describe("cloud mode store — setters", () => {
  it("updates the signal and persists cloud_mode", async () => {
    await setCloudMode(true);
    expect(cloudMode()).toBe(true);
    expect(setSetting).toHaveBeenCalledWith("cloud_mode", true);
  });

  it("updates the signal and persists cloud_agent_url", async () => {
    await setCloudAgentUrl("wss://agent.example.com");
    expect(cloudAgentUrl()).toBe("wss://agent.example.com");
    expect(setSetting).toHaveBeenCalledWith("cloud_agent_url", "wss://agent.example.com");
  });

  it("updates the signal and persists cloud_agent_status", async () => {
    const status = {
      pairedAt: 1_700_000_000,
      agentVersion: "0.1.0",
      lastHandshakeAt: 1_700_000_500,
      needsRepairAt: null,
    };
    await setCloudAgentStatus(status);
    expect(cloudAgentStatus()).toEqual(status);
    expect(setSetting).toHaveBeenCalledWith("cloud_agent_status", status);
  });

  it("still updates the signal when the persist write rejects", async () => {
    setSetting.mockRejectedValueOnce(new Error("disk full"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await setCloudMode(true);

    expect(cloudMode()).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("cloud mode store — hydrate", () => {
  it("replaces signals with persisted values without re-persisting", async () => {
    getSetting.mockImplementation((key: string) => {
      switch (key) {
        case "cloud_mode":
          return Promise.resolve(true);
        case "cloud_agent_url":
          return Promise.resolve("wss://stored.example");
        case "cloud_agent_status":
          return Promise.resolve({ pairedAt: 42, agentVersion: null });
        default:
          throw new Error(`unexpected key ${key}`);
      }
    });

    await hydrateCloudMode();

    expect(cloudMode()).toBe(true);
    expect(cloudAgentUrl()).toBe("wss://stored.example");
    expect(cloudAgentStatus()).toEqual({ pairedAt: 42, agentVersion: null });
    expect(setSetting).not.toHaveBeenCalled();
  });

  it("leaves signals at defaults when hydrate throws", async () => {
    getSetting.mockRejectedValue(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await hydrateCloudMode();

    expect(cloudMode()).toBe(false);
    expect(cloudAgentUrl()).toBe(null);
    expect(cloudAgentStatus()).toBe(null);
    expect(setSetting).not.toHaveBeenCalled();

    warn.mockRestore();
  });

  it("post-hydrate setter still persists", async () => {
    getSetting.mockResolvedValueOnce(false); // cloud_mode
    getSetting.mockResolvedValueOnce(null); // cloud_agent_url
    getSetting.mockResolvedValueOnce(null); // cloud_agent_status

    await hydrateCloudMode();
    setSetting.mockClear();

    await setCloudMode(true);
    expect(setSetting).toHaveBeenCalledWith("cloud_mode", true);
  });
});
