// Frontend-side DB query helpers — thin wrappers over IPC commands that hit SQLite.
// T3.1: just exposes the preloaded handle; CRUD wrappers land in T3.6+.

import Database from "@tauri-apps/plugin-sql";

export const DB_URL = "sqlite:work-station.db" as const;

let connection: Promise<Database> | null = null;

/** Resolve the singleton Database handle (preloaded by tauri-plugin-sql at boot). */
export function db(): Promise<Database> {
  connection ??= Database.load(DB_URL);
  return connection;
}
