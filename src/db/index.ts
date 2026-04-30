/**
 * Database layer — SQLite via tauri-plugin-sql.
 *
 * Manages connection lifecycle and idempotent schema initialisation.
 */

import Database from "@tauri-apps/plugin-sql";
import { SCHEMA_STATEMENTS } from "./schema";

const DB_PATH = "sqlite:workstation.db";

let dbInstance: Database | null = null;

/** Get the singleton database instance (initialises on first call). */
export async function getDb(): Promise<Database> {
  if (!dbInstance) {
    dbInstance = await Database.load(DB_PATH);
    await initSchema(dbInstance);
  }
  return dbInstance;
}

/** Close the database connection. */
export async function closeDb(): Promise<void> {
  if (dbInstance) {
    await dbInstance.close();
    dbInstance = null;
  }
}

/** Execute all schema statements idempotently. */
async function initSchema(db: Database): Promise<void> {
  for (const sql of SCHEMA_STATEMENTS) {
    await db.execute(sql);
  }
}
