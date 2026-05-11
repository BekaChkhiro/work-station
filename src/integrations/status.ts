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
//
// T11.8 adds an optional `needsReauthAt` timestamp set by the reauth module
// (see `reauth.ts`) when a long-running integration call sees 401/403. The
// next successful Verify clears it and replays any in-flight requests that
// were queued while the integration was unauthenticated.

import { getSetting, setSetting } from "../db/settings";
import type { IntegrationId } from "./credentials";

export interface IntegrationStatusEntry {
  verifiedAt: number;
  accountLabel: string;
  /** T12.2 — optional structured details PlanFlow surfaces in the card.
   *  Other integrations leave these undefined and rely on `accountLabel`. */
  accountName?: string | null;
  accountEmail?: string | null;
  needsReauthAt?: number | null;
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

/** T11.8 — stamp `needsReauthAt` on the existing entry without dropping
 *  the verified label. If the integration was never verified we create a
 *  minimal entry so the banner can still render. */
export async function markIntegrationNeedsReauth(
  integration: IntegrationId | string,
  at: number = Date.now(),
): Promise<IntegrationStatusEntry> {
  const map = await getIntegrationStatusMap();
  const existing = map[integration];
  const next: IntegrationStatusEntry = existing
    ? { ...existing, needsReauthAt: at }
    : { verifiedAt: 0, accountLabel: "", needsReauthAt: at };
  await setSetting("integration_status", { ...map, [integration]: next });
  return next;
}

/** T11.8 — drop the reauth flag, preserving the verified label so the UI
 *  flips back to "Connected as …" without an extra round-trip. */
export async function clearIntegrationNeedsReauthFlag(
  integration: IntegrationId | string,
): Promise<void> {
  const map = await getIntegrationStatusMap();
  const existing = map[integration];
  if (!existing || existing.needsReauthAt == null) return;
  const next: IntegrationStatusEntry = { ...existing, needsReauthAt: null };
  await setSetting("integration_status", { ...map, [integration]: next });
}
