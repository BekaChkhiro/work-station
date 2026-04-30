/**
 * SQLite schema definitions for Work Station.
 *
 * These SQL statements create the tables used by the app.
 * Migrations are applied idempotently via `CREATE TABLE IF NOT EXISTS`.
 */

/** Projects table — each project maps to a directory on disk. */
export const CREATE_PROJECTS_TABLE = `
  CREATE TABLE IF NOT EXISTS projects (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    path        TEXT NOT NULL UNIQUE,
    color       TEXT,
    icon        TEXT,
    default_cli TEXT,
    env_json    TEXT,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL
  );
`;

/** Index for fast ordering by position. */
export const CREATE_PROJECTS_POSITION_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_projects_position ON projects(position);
`;

/** Sessions table — persisted terminal sessions linked to a project. */
export const CREATE_SESSIONS_TABLE = `
  CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL,
    title       TEXT,
    cli         TEXT,
    cwd         TEXT,
    layout_json TEXT,
    created_at  INTEGER NOT NULL,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
  );
`;

/** Index for fast session lookups by project. */
export const CREATE_SESSIONS_PROJECT_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);
`;

/** App settings table — key/value store for user preferences and hotkeys. */
export const CREATE_APP_SETTINGS_TABLE = `
  CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`;

/** Ordered list of all schema statements to run on init. */
export const SCHEMA_STATEMENTS = [
  CREATE_PROJECTS_TABLE,
  CREATE_PROJECTS_POSITION_INDEX,
  CREATE_SESSIONS_TABLE,
  CREATE_SESSIONS_PROJECT_INDEX,
  CREATE_APP_SETTINGS_TABLE,
];
