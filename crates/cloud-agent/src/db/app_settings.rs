//! Cloud-agent shim around the shared `app_settings` key/value table
//! (T19.25). Mirrors `src-tauri/src/db/app_settings.rs` so a row written
//! by either side round-trips through the other without conversion —
//! values are JSON-encoded TEXT, missing/corrupt rows degrade to
//! `Ok(None)` so handlers can apply their own default.

use serde::de::DeserializeOwned;
use serde::Serialize;
use sqlx::sqlite::SqlitePool;
use sqlx::Row;

/// `app_settings.key` for the last-active project id.
pub const LAST_ACTIVE_PROJECT_KEY: &str = "last_active_project";

/// `app_settings.key` for the active theme (`"light" | "dark" | "system"`).
pub const THEME_KEY: &str = "theme";

#[derive(Debug, thiserror::Error)]
pub enum AppSettingsError {
    #[error("sqlx: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("json encode: {0}")]
    Encode(#[from] serde_json::Error),
}

/// Read a setting and JSON-decode it into `T`. Returns `Ok(None)` when
/// the row is missing, the stored TEXT is not valid JSON, or the parsed
/// value doesn't fit `T`.
pub async fn get_json<T: DeserializeOwned>(
    pool: &SqlitePool,
    key: &str,
) -> Result<Option<T>, AppSettingsError> {
    let row = sqlx::query("SELECT value FROM app_settings WHERE key = ?")
        .bind(key)
        .fetch_optional(pool)
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    let raw: String = row.try_get("value")?;
    Ok(serde_json::from_str::<T>(&raw).ok())
}

/// Upsert `value` as JSON-encoded TEXT under `key`. Same `INSERT … ON
/// CONFLICT(key) DO UPDATE` shape the desktop wrapper uses so concurrent
/// writers from either side converge on last-write-wins.
pub async fn set_json<T: Serialize>(
    pool: &SqlitePool,
    key: &str,
    value: &T,
) -> Result<(), AppSettingsError> {
    let encoded = serde_json::to_string(value)?;
    sqlx::query(
        "INSERT INTO app_settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .bind(key)
    .bind(&encoded)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    async fn pool() -> SqlitePool {
        let dir = tempdir().expect("tempdir");
        // Leak the tempdir for the test's lifetime — sqlite needs the
        // file to stay alive until the pool drops.
        let dir = Box::leak(Box::new(dir));
        crate::db::open(dir.path()).await.expect("open")
    }

    #[tokio::test]
    async fn get_returns_none_when_row_missing() {
        let pool = pool().await;
        let value: Option<String> = get_json(&pool, "absent").await.expect("get");
        assert!(value.is_none());
    }

    #[tokio::test]
    async fn set_then_get_round_trips_string() {
        let pool = pool().await;
        set_json(&pool, THEME_KEY, &"dark").await.expect("set");
        let value: Option<String> = get_json(&pool, THEME_KEY).await.expect("get");
        assert_eq!(value.as_deref(), Some("dark"));
    }

    #[tokio::test]
    async fn set_overwrites_existing_value() {
        let pool = pool().await;
        set_json(&pool, THEME_KEY, &"dark").await.expect("set 1");
        set_json(&pool, THEME_KEY, &"light").await.expect("set 2");
        let value: Option<String> = get_json(&pool, THEME_KEY).await.expect("get");
        assert_eq!(value.as_deref(), Some("light"));
    }

    #[tokio::test]
    async fn corrupt_json_degrades_to_none() {
        let pool = pool().await;
        sqlx::query("INSERT INTO app_settings (key, value) VALUES (?, ?)")
            .bind("garbage")
            .bind("{not json")
            .execute(&pool)
            .await
            .expect("seed garbage");
        let value: Option<String> = get_json(&pool, "garbage").await.expect("get");
        assert!(value.is_none());
    }

    /// Cross-bridge compatibility: a row written here matches the
    /// JSON-encoded TEXT shape the desktop's TS wrapper produces.
    #[tokio::test]
    async fn writes_match_json_encoded_text_format() {
        let pool = pool().await;
        set_json(&pool, "s", &"hello").await.expect("set string");
        set_json(&pool, "n", &Option::<String>::None)
            .await
            .expect("set null");
        let raw_s: String = sqlx::query_scalar("SELECT value FROM app_settings WHERE key = ?")
            .bind("s")
            .fetch_one(&pool)
            .await
            .expect("read s");
        assert_eq!(raw_s, r#""hello""#);
        let raw_n: String = sqlx::query_scalar("SELECT value FROM app_settings WHERE key = ?")
            .bind("n")
            .fetch_one(&pool)
            .await
            .expect("read n");
        assert_eq!(raw_n, "null");
    }
}
