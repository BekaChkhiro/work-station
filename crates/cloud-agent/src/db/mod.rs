// T19.25 prose mentions `SQLite` and `WebSocket` in passing. Backticking
// each occurrence hurts readability; allow the doc-markdown lint at the
// module level same as `workstation-core::ws::protocol`.
#![allow(clippy::doc_markdown)]

//! SQLite persistence for the cloud-agent (T19.25).
//!
//! The cloud-agent keeps its own `cloud-agent.db` under `state_dir` —
//! distinct from the desktop's `work-station.db`. Phase-1 only needs the
//! read paths the WebSocket bridge exercises (`projects_list`,
//! `project_get`, `project_switch`, `settings_get`); CRUD over the wire
//! lands in a follow-up task. The schema mirrors the desktop's so a
//! future CRUD path can write rows that satisfy these readers without
//! diverging.
//!
//! The migration runner here is a hand-rolled minimum: a
//! `schema_migrations(version, applied_at)` ledger plus a fixed list of
//! embedded SQL files applied in order inside a transaction. We don't
//! need `sqlx::migrate!` — the cloud-agent's migration count stays
//! small, and the embedded list keeps the binary self-contained on the
//! VPS without an offline-prep step.

use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use sqlx::sqlite::{SqliteConnectOptions, SqlitePool, SqlitePoolOptions};
use sqlx::{Executor, Row};

pub mod app_settings;
pub mod project_links;
pub mod projects;

/// Filename for the cloud-agent's SQLite database, placed under
/// `Config::state_dir`. Sidecars (`-wal`, `-shm`) live next to it.
pub const DB_FILENAME: &str = "cloud-agent.db";

/// Pragmas applied at boot before migrations run. Same shape as the
/// desktop's [`src-tauri/src/db/mod.rs`] list — WAL for concurrent
/// reader-writer access, FK enforcement so cascades work as written,
/// and a 5s busy timeout that absorbs short contention spikes from the
/// per-connection writers `axum::serve` hands out.
const PRAGMAS: &[&str] = &[
    "PRAGMA journal_mode = WAL;",
    "PRAGMA foreign_keys = ON;",
    "PRAGMA busy_timeout = 5000;",
];

/// Ordered list of `(version, sql)` migrations. Append-only — never
/// renumber or edit a row that has shipped, the ledger doesn't carry
/// checksums.
const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("../../migrations/0001_projects.sql")),
    (2, include_str!("../../migrations/0002_app_settings.sql")),
    (3, include_str!("../../migrations/0003_project_links.sql")),
];

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("sqlx: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("migration {version} failed: {source}")]
    Migration {
        version: i64,
        #[source]
        source: sqlx::Error,
    },
}

/// Open the cloud-agent's SQLite pool, apply pragmas, and run any
/// pending migrations.
///
/// `state_dir` is created by the daemon's `ensure_state_dir` step before
/// this is called, so we expect the directory to exist; the database
/// file is created on demand (`create_if_missing`). Returns the pool
/// so the dispatcher can keep its own clone — `SqlitePool` is internally
/// Arc-shared.
pub async fn open(state_dir: &Path) -> Result<SqlitePool, DbError> {
    let db_path = state_dir.join(DB_FILENAME);
    let options = SqliteConnectOptions::new()
        .filename(&db_path)
        .create_if_missing(true);

    let pool = SqlitePoolOptions::new().connect_with(options).await?;
    apply_pragmas(&pool).await?;
    run_migrations(&pool).await?;
    Ok(pool)
}

/// Apply WAL + concurrency pragmas to `pool`. Re-issued on every boot
/// so a future regression in sqlx's defaults surfaces here rather than
/// silently corrupting durability.
async fn apply_pragmas(pool: &SqlitePool) -> Result<(), DbError> {
    for pragma in PRAGMAS {
        pool.execute(*pragma).await?;
    }
    Ok(())
}

/// Apply any migrations whose version is not yet recorded in the
/// `schema_migrations` ledger. Each migration runs in its own
/// transaction so a failure mid-list rolls back cleanly and the next
/// boot retries from the last-good version.
async fn run_migrations(pool: &SqlitePool) -> Result<(), DbError> {
    pool.execute(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version    INTEGER PRIMARY KEY NOT NULL,
            applied_at INTEGER NOT NULL
        )",
    )
    .await?;

    for (version, sql) in MIGRATIONS {
        let already: Option<i64> =
            sqlx::query("SELECT version FROM schema_migrations WHERE version = ?")
                .bind(version)
                .fetch_optional(pool)
                .await?
                .map(|row| row.get(0));
        if already.is_some() {
            continue;
        }

        let mut tx = pool.begin().await.map_err(|e| DbError::Migration {
            version: *version,
            source: e,
        })?;
        tx.execute(*sql).await.map_err(|e| DbError::Migration {
            version: *version,
            source: e,
        })?;
        sqlx::query("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
            .bind(version)
            .bind(epoch_seconds())
            .execute(&mut *tx)
            .await
            .map_err(|e| DbError::Migration {
                version: *version,
                source: e,
            })?;
        tx.commit().await.map_err(|e| DbError::Migration {
            version: *version,
            source: e,
        })?;

        tracing::info!(
            target: "cloud_agent::db",
            version,
            "applied migration",
        );
    }

    Ok(())
}

fn epoch_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_secs()).ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[tokio::test]
    async fn open_creates_db_and_applies_migrations() {
        let dir = tempdir().expect("tempdir");
        let pool = open(dir.path()).await.expect("open pool");

        // Both tables exist after open.
        for table in [
            "projects",
            "app_settings",
            "project_links",
            "schema_migrations",
        ] {
            let exists: Option<String> = sqlx::query_scalar(
                "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
            )
            .bind(table)
            .fetch_optional(&pool)
            .await
            .expect("query master");
            assert_eq!(exists.as_deref(), Some(table), "missing table {table}");
        }

        // Both migrations recorded.
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM schema_migrations")
            .fetch_one(&pool)
            .await
            .expect("count");
        let expected = i64::try_from(MIGRATIONS.len()).expect("migration count fits in i64");
        assert_eq!(count, expected);
    }

    #[tokio::test]
    async fn open_is_idempotent_across_restarts() {
        let dir = tempdir().expect("tempdir");
        let first = open(dir.path()).await.expect("first open");
        drop(first);

        // Second open against the same on-disk db must not re-apply.
        let second = open(dir.path()).await.expect("second open");
        let applied: Vec<i64> =
            sqlx::query_scalar("SELECT version FROM schema_migrations ORDER BY version")
                .fetch_all(&second)
                .await
                .expect("versions");
        let expected: Vec<i64> = MIGRATIONS.iter().map(|(v, _)| *v).collect();
        assert_eq!(applied, expected);
    }

    #[tokio::test]
    async fn open_applies_expected_pragmas() {
        let dir = tempdir().expect("tempdir");
        let pool = open(dir.path()).await.expect("open");

        let mode: String = sqlx::query("PRAGMA journal_mode;")
            .fetch_one(&pool)
            .await
            .expect("journal_mode")
            .get(0);
        assert_eq!(mode.to_lowercase(), "wal");

        let fk: i64 = sqlx::query("PRAGMA foreign_keys;")
            .fetch_one(&pool)
            .await
            .expect("foreign_keys")
            .get(0);
        assert_eq!(fk, 1);
    }
}
