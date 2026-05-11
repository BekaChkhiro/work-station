// T11.3: per-integration verified-state cache.
//
// The keychain (T11.2) holds tokens; this module remembers what a successful
// verification looked like (account label + timestamp) so subsequent app
// launches can render "Connected as …" without re-issuing the network call.
// Cleared automatically on Disconnect.
//
// Storage is the `integration_status` row in app_settings — a JSON object
// keyed by integration id. Unknown keys are tolerated so we don't crash if a
// future integration ships before the schema is bumped.

import { getSetting, setSetting } from "../db/settings";
import type { IntegrationId } from "./credentials";

export interface IntegrationStatusEntry {
  verifiedAt: number;
  accountLabel: string;
}

export type IntegrationStatusMap = Record<string, IntegrationStatusEntry>;

export async function getIntegrationStatusMap(): Promise<IntegrationStatusMap> {
  return getSetting("integration_status");
}

export async function getIntegrationStatus(
  integration: IntegrationId | string,
): Promise<IntegrationStatusEntry | null> {
  const map = await getIntegrationStatusMap();
  return map[integration] ?? null;
}

export async function setIntegrationStatus(
  integration: IntegrationId | string,
  entry: IntegrationStatusEntry,
): Promise<void> {
  const map = await getIntegrationStatusMap();
  await setSetting("integration_status", { ...map, [integration]: entry });
}

export async function clearIntegrationStatus(integration: IntegrationId | string): Promise<void> {
  const map = await getIntegrationStatusMap();
  if (!(integration in map)) return;
  const next: IntegrationStatusMap = Object.fromEntries(
    Object.entries(map).filter(([key]) => key !== integration),
  );
  await setSetting("integration_status", next);
}
