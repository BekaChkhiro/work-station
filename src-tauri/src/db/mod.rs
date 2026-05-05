//! `SQLite` persistence: connection, migrations, queries.
//!
//! T3.1 ships only the boot-time hello-world query that proves
//! `tauri-plugin-sql` opened the preloaded pool. Schema, migrations, and
//! domain queries land in T3.2+.

use sqlx::Row;
use tauri::{AppHandle, Manager, Runtime};
use tauri_plugin_sql::{DbInstances, DbPool};

pub const DB_URL: &str = "sqlite:work-station.db";

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
