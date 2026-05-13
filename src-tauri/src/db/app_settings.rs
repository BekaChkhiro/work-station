//! Shared helpers for the `app_settings` key/value table (T18.4).
//!
//! Values are JSON-encoded TEXT — the same convention the desktop
//! frontend uses through `src/db/settings.ts` (`getSetting`/`setSetting`),
//! anchored by migration `0003_app_settings.sql`. Helpers here let
//! Rust-side code (the WS bridge in particular) read and write the same
//! rows without diverging on wire format.
//!
//! Decode tolerance mirrors the TS wrapper: a missing row, malformed
//! JSON, or a shape that doesn't fit `T` all surface as `Ok(None)` so
//! callers can apply their own default (matching the "corrupt values
//! never crash callers" acceptance from T3.4).

use serde::de::DeserializeOwned;
use serde::Serialize;
use sqlx::sqlite::SqlitePool;
use sqlx::Row;

/// `app_settings.key` for the last-active project id (mirrors
/// `SETTINGS.last_active_project` in `src/db/settings.ts`).
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

/// Read a setting and JSON-decode it into `T`.
///
/// Returns `Ok(None)` when the row is missing, the stored TEXT is not
/// valid JSON, or the parsed value doesn't fit `T`. Genuine SQLite
/// failures still bubble up as `Err`.
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

/// Upsert `value` as JSON-encoded TEXT under `key`. Matches the
/// `INSERT … ON CONFLICT(key) DO UPDATE` pattern used by the TS
/// wrapper so concurrent writers from either side converge on the
/// last-write-wins semantic without surprising the other.
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
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::Executor;

    async fn migrated_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        pool.execute(include_str!("../../migrations/0003_app_settings.sql"))
            .await
            .expect("apply 0003");
        pool
    }

    #[tokio::test]
    async fn get_returns_none_when_row_missing() {
        let pool = migrated_pool().await;
        let value: Option<String> = get_json(&pool, "absent").await.expect("get");
        assert!(value.is_none());
    }

    #[tokio::test]
    async fn set_then_get_round_trips_string() {
        let pool = migrated_pool().await;
        set_json(&pool, THEME_KEY, &"dark").await.expect("set");
        let value: Option<String> = get_json(&pool, THEME_KEY).await.expect("get");
        assert_eq!(value.as_deref(), Some("dark"));
    }

    #[tokio::test]
    async fn set_overwrites_existing_value() {
        let pool = migrated_pool().await;
        set_json(&pool, THEME_KEY, &"dark").await.expect("set 1");
        set_json(&pool, THEME_KEY, &"light").await.expect("set 2");
        let value: Option<String> = get_json(&pool, THEME_KEY).await.expect("get");
        assert_eq!(value.as_deref(), Some("light"));
    }

    #[tokio::test]
    async fn get_returns_none_when_value_is_not_valid_json() {
        let pool = migrated_pool().await;
        sqlx::query("INSERT INTO app_settings (key, value) VALUES (?, ?)")
            .bind("garbage")
            .bind("{not json")
            .execute(&pool)
            .await
            .expect("seed garbage");
        let value: Option<String> = get_json(&pool, "garbage").await.expect("get");
        assert!(value.is_none(), "corrupt JSON degrades to None");
    }

    #[tokio::test]
    async fn get_returns_none_when_value_shape_mismatches() {
        let pool = migrated_pool().await;
        // Stored as JSON number; reading as String should degrade to None
        // rather than bubble a deserialization error.
        sqlx::query("INSERT INTO app_settings (key, value) VALUES (?, ?)")
            .bind("k")
            .bind("42")
            .execute(&pool)
            .await
            .expect("seed");
        let as_string: Option<String> = get_json(&pool, "k").await.expect("get");
        assert!(as_string.is_none());
        // Same row reads fine as the matching numeric type.
        let as_int: Option<i64> = get_json(&pool, "k").await.expect("get int");
        assert_eq!(as_int, Some(42));
    }

    /// Wire-format compatibility with `src/db/settings.ts`: stored values
    /// are JSON-encoded — a string lands as `"abc"` (with quotes), a null
    /// lands as the literal `null`. Mirroring the TS wrapper means the
    /// same row is round-trippable from either side without conversion.
    #[tokio::test]
    async fn writes_match_ts_json_encoded_text_format() {
        let pool = migrated_pool().await;
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

    /// Nullable string field per the TS schema (`ProjectIdSchema`). A
    /// JSON `null` row decodes back into `Some(None)` so callers can
    /// distinguish "explicitly cleared" from "row missing".
    #[tokio::test]
    async fn nullable_string_round_trips_through_option() {
        let pool = migrated_pool().await;
        set_json(&pool, LAST_ACTIVE_PROJECT_KEY, &Option::<String>::None)
            .await
            .expect("set null");
        let value: Option<Option<String>> =
            get_json(&pool, LAST_ACTIVE_PROJECT_KEY).await.expect("get");
        assert_eq!(value, Some(None));
    }
}
