//! Versioned SQL migrations for the application database.
//!
//! # Rollback Strategy
//!
//! Each migration includes a corresponding Down script. Rollbacks are not
//! executed automatically on app boot — they must be triggered intentionally.
//!
//! ## How to Roll Back
//!
//! 1. **Via Code (Debug Builds)**  
//!    Call `db::migrations::rollback_to_v0()` from Rust. This executes all
//!    Down migrations in reverse order and drops the `_sqlx_migrations` table
//!    so the app will re-run Up migrations on next boot.
//!
//! 2. **Via SQLite CLI**  
//!    Open the database file directly and run the Down SQL manually.
//!    Database location:
//!    - **macOS**: `~/Library/Application Support/com.beqolozi.work-station/workstation.db`
//!    - **Windows**: `%APPDATA%\com.beqolozi.work-station\workstation.db`
//!
//! 3. **Nuclear Option**  
//!    Delete the database file entirely. The app recreates an empty DB and
//!    applies all Up migrations on the next launch. **All data is lost.**
//!
//! ## Migration State
//!
//! `tauri-plugin-sql` uses `sqlx` under the hood. Applied versions are
//! tracked in the `_sqlx_migrations` table automatically.

use tauri_plugin_sql::{Migration, MigrationKind};

/// All Up migrations, ordered by version.
///
/// These are applied automatically by `tauri-plugin-sql` when the database
/// is preloaded during app startup.
pub fn up_migrations() -> Vec<Migration> {
    vec![v1_initial_schema()]
}

/// All Down migrations, ordered by version.
///
/// These are **not** run automatically. They exist for manual rollback
/// operations only.
pub fn down_migrations() -> Vec<Migration> {
    vec![v1_initial_schema_down()]
}

// ------------------------------------------------------------------
// V1 — Initial schema (projects, sessions, app_settings)
// ------------------------------------------------------------------

fn v1_initial_schema() -> Migration {
    Migration {
        version: 1,
        description: "initial_schema",
        sql: V1_UP_SQL,
        kind: MigrationKind::Up,
    }
}

fn v1_initial_schema_down() -> Migration {
    Migration {
        version: 1,
        description: "initial_schema_rollback",
        sql: V1_DOWN_SQL,
        kind: MigrationKind::Down,
    }
}

const V1_UP_SQL: &str = r#"
-- Projects table (T3.2)
-- Stores every project the user has added to the sidebar.
CREATE TABLE IF NOT EXISTS projects (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    path        TEXT NOT NULL,
    color       TEXT,
    icon        TEXT,
    default_cli TEXT,
    env_json    TEXT,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
CREATE INDEX IF NOT EXISTS idx_projects_position ON projects(position);

-- Sessions table (T3.3)
-- Represents a terminal session inside a project.
-- layout_json stores the recursive split/pane tree.
CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id  INTEGER NOT NULL,
    title       TEXT,
    cli         TEXT,
    cwd         TEXT,
    layout_json TEXT,
    created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sessions_project_id ON sessions(project_id);

-- App settings table (T3.4)
-- Simple key/value store for user preferences (theme, hotkeys, etc.).
CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"#;

const V1_DOWN_SQL: &str = r#"
-- V1 rollback — drops all application tables.
-- NOTE: The _sqlx_migrations table is left untouched so sqlx can
-- still track state if needed. To force a full re-migration, delete
-- the _sqlx_migrations rows for version 1 manually.
DROP TABLE IF EXISTS app_settings;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS projects;
"#;
