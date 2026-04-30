/**
 * App settings query helpers.
 *
 * Provides typed CRUD operations over the `app_settings` key/value table.
 */

import { getDb } from "./index";

/** Known setting keys used by the app. */
export type SettingKey =
  | "theme"
  | "last_active_project_id"
  | `hotkey.${string}`;

/** Retrieve a single setting value by key. */
export async function getSetting(key: SettingKey): Promise<string | null> {
  const db = await getDb();
  const result = await db.select<{ value: string }[]>(
    "SELECT value FROM app_settings WHERE key = ?",
    [key]
  );
  return result[0]?.value ?? null;
}

/** Set or overwrite a setting value. */
export async function setSetting(key: SettingKey, value: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    "INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    [key, value]
  );
}

/** Remove a setting by key. */
export async function deleteSetting(key: SettingKey): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM app_settings WHERE key = ?", [key]);
}

/** List all stored settings. */
export async function listSettings(): Promise<Record<string, string>> {
  const db = await getDb();
  const rows = await db.select<{ key: string; value: string }[]>(
    "SELECT key, value FROM app_settings"
  );
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}
