//! `SQLite` persistence: connection, migrations, queries.
//!
//! T3.1 wires the preloaded pool. T3.2 adds the `projects` table migration.
//! T3.3 adds the `sessions` table. T3.4 adds the `app_settings` key/value
//! table. Domain queries (project CRUD commands) land in T3.6.

use sqlx::Row;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_sql::{DbInstances, DbPool, Migration, MigrationKind};

pub const DB_URL: &str = "sqlite:work-station.db";

/// Schema migrations applied by `tauri-plugin-sql` on plugin init.
///
/// T3.5 will replace this with a backup-aware runner; the SQL files
/// themselves remain the source of truth.
pub fn migrations() -> Vec<Migration> {
    vec![
        Migration {
            version: 1,
            description: "create projects table",
            sql: include_str!("../../migrations/0001_projects.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 2,
            description: "create sessions table",
            sql: include_str!("../../migrations/0002_sessions.sql"),
            kind: MigrationKind::Up,
        },
        Migration {
            version: 3,
            description: "create app_settings table",
            sql: include_str!("../../migrations/0003_app_settings.sql"),
            kind: MigrationKind::Up,
        },
    ]
}

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("preloaded pool {DB_URL} not found")]
    PoolMissing,
    #[error("sqlx: {0}")]
    Sqlx(#[from] sqlx::Error),
}

/// Hello-world `SELECT 1` against the preloaded pool — boot-time smoke check
/// that satisfies T3.1's acceptance ("can run a hello-world query from Rust").
pub async fn hello<R: Runtime>(app: &AppHandle<R>) -> Result<i64, DbError> {
    let instances = app.state::<DbInstances>();
    let map = instances.0.read().await;
    let pool = map.get(DB_URL).ok_or(DbError::PoolMissing)?;
    // Only the `sqlite` feature is enabled, so the other DbPool variants are
    // cfg-gated out — the let-else is irrefutable in this build but kept for
    // forward compatibility if we ever flip on another driver.
    #[allow(irrefutable_let_patterns)]
    let DbPool::Sqlite(pool) = pool
    else {
        unreachable!("only the sqlite feature is enabled");
    };
    let row = sqlx::query("SELECT 1 AS one").fetch_one(pool).await?;
    Ok(row.try_get::<i64, _>("one")?)
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::{Executor, Row};

    /// T3.2 acceptance: applying the migration creates the table and an
    /// insert/select round-trips with no data loss.
    #[tokio::test]
    async fn projects_migration_round_trips() {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");

        let migration = include_str!("../../migrations/0001_projects.sql");
        pool.execute(migration).await.expect("apply migration");

        sqlx::query(
            "INSERT INTO projects (id, name, path, color, icon, default_cli, env_json, position, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind("p1")
        .bind("Demo")
        .bind("/tmp/demo")
        .bind("#fa0")
        .bind("rocket")
        .bind("zsh")
        .bind(r#"{"FOO":"bar"}"#)
        .bind(0_i64)
        .bind(1_700_000_000_i64)
        .execute(&pool)
        .await
        .expect("insert project");

        let row =
            sqlx::query("SELECT id, name, path, env_json, position FROM projects WHERE id = ?")
                .bind("p1")
                .fetch_one(&pool)
                .await
                .expect("select project");

        assert_eq!(row.get::<String, _>("id"), "p1");
        assert_eq!(row.get::<String, _>("name"), "Demo");
        assert_eq!(row.get::<String, _>("path"), "/tmp/demo");
        assert_eq!(row.get::<String, _>("env_json"), r#"{"FOO":"bar"}"#);
        assert_eq!(row.get::<i64, _>("position"), 0);

        let index = sqlx::query(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_projects_position'",
        )
        .fetch_optional(&pool)
        .await
        .expect("query index");
        assert!(index.is_some(), "position index should be created");
    }

    /// T3.3 acceptance: applying both migrations creates the sessions table,
    /// an insert/select round-trips, the project FK is enforced, and
    /// `ON DELETE CASCADE` removes orphaned sessions.
    #[tokio::test]
    async fn sessions_migration_round_trips() {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");

        // FKs are off by default in SQLite; T3.9 will enable them globally,
        // but the cascade assertion below needs them on for this test.
        pool.execute("PRAGMA foreign_keys = ON;")
            .await
            .expect("enable fk");
        pool.execute(include_str!("../../migrations/0001_projects.sql"))
            .await
            .expect("apply 0001");
        pool.execute(include_str!("../../migrations/0002_sessions.sql"))
            .await
            .expect("apply 0002");

        sqlx::query(
            "INSERT INTO projects (id, name, path, env_json, position, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind("p1")
        .bind("Demo")
        .bind("/tmp/demo")
        .bind("{}")
        .bind(0_i64)
        .bind(1_700_000_000_i64)
        .execute(&pool)
        .await
        .expect("insert project");

        sqlx::query(
            "INSERT INTO sessions (id, project_id, title, cli, cwd, layout_json, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind("s1")
        .bind("p1")
        .bind("main")
        .bind("zsh")
        .bind("/tmp/demo")
        .bind(r#"{"type":"pane","sessionId":"s1"}"#)
        .bind(1_700_000_001_i64)
        .execute(&pool)
        .await
        .expect("insert session");

        let row = sqlx::query(
            "SELECT id, project_id, title, cli, layout_json FROM sessions WHERE id = ?",
        )
        .bind("s1")
        .fetch_one(&pool)
        .await
        .expect("select session");
        assert_eq!(row.get::<String, _>("id"), "s1");
        assert_eq!(row.get::<String, _>("project_id"), "p1");
        assert_eq!(row.get::<String, _>("title"), "main");
        assert_eq!(row.get::<String, _>("cli"), "zsh");
        assert_eq!(
            row.get::<String, _>("layout_json"),
            r#"{"type":"pane","sessionId":"s1"}"#
        );

        let index = sqlx::query(
            "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sessions_project'",
        )
        .fetch_optional(&pool)
        .await
        .expect("query index");
        assert!(index.is_some(), "project index should be created");

        // FK rejects a session pointing at a non-existent project.
        let orphan = sqlx::query(
            "INSERT INTO sessions (id, project_id, title, layout_json, created_at)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind("s2")
        .bind("does-not-exist")
        .bind("ghost")
        .bind("{}")
        .bind(1_700_000_002_i64)
        .execute(&pool)
        .await;
        assert!(orphan.is_err(), "FK violation should be rejected");

        // ON DELETE CASCADE: removing the project removes its sessions.
        sqlx::query("DELETE FROM projects WHERE id = ?")
            .bind("p1")
            .execute(&pool)
            .await
            .expect("delete project");
        let remaining: i64 = sqlx::query("SELECT COUNT(*) AS n FROM sessions")
            .fetch_one(&pool)
            .await
            .expect("count sessions")
            .get("n");
        assert_eq!(remaining, 0, "sessions should cascade-delete with project");
    }

    /// T3.4 acceptance: applying the migration creates the `app_settings`
    /// key/value table; insert/select round-trips, the PRIMARY KEY rejects
    /// duplicates, and `INSERT ... ON CONFLICT(key) DO UPDATE` upserts cleanly
    /// (the upsert path is what the frontend wrapper relies on).
    #[tokio::test]
    async fn app_settings_migration_round_trips() {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");

        pool.execute(include_str!("../../migrations/0003_app_settings.sql"))
            .await
            .expect("apply 0003");

        sqlx::query("INSERT INTO app_settings (key, value) VALUES (?, ?)")
            .bind("theme")
            .bind(r#""dark""#)
            .execute(&pool)
            .await
            .expect("insert setting");

        let row = sqlx::query("SELECT value FROM app_settings WHERE key = ?")
            .bind("theme")
            .fetch_one(&pool)
            .await
            .expect("select setting");
        assert_eq!(row.get::<String, _>("value"), r#""dark""#);

        // Upsert: same key replaces the value.
        sqlx::query(
            "INSERT INTO app_settings (key, value) VALUES (?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        )
        .bind("theme")
        .bind(r#""light""#)
        .execute(&pool)
        .await
        .expect("upsert setting");

        let row = sqlx::query("SELECT value FROM app_settings WHERE key = ?")
            .bind("theme")
            .fetch_one(&pool)
            .await
            .expect("select setting after upsert");
        assert_eq!(row.get::<String, _>("value"), r#""light""#);

        // PK rejects a naive duplicate insert (no ON CONFLICT clause).
        let dup = sqlx::query("INSERT INTO app_settings (key, value) VALUES (?, ?)")
            .bind("theme")
            .bind(r#""system""#)
            .execute(&pool)
            .await;
        assert!(dup.is_err(), "duplicate key should be rejected");
    }
}
