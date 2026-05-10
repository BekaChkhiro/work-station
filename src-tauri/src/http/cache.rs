//! T11.4: SQLite-backed HTTP response cache with per-entry TTL.
//!
//! Schema lives in `migrations/0005_http_cache.sql`. Only successful GETs
//! land here; the [`crate::http::Client`] never reads or writes the cache
//! for non-idempotent methods or non-2xx responses regardless of the TTL
//! the caller passes.

use std::collections::HashMap;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use sqlx::sqlite::SqlitePool;
use sqlx::Row;

use super::error::HttpError;

#[derive(Debug, Clone)]
pub struct CachedResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
    /// Seconds-since-epoch when the cached entry was first stored. Useful
    /// for downstream telemetry / age-of-cache UI; not used by the read path.
    pub fetched_at: i64,
}

#[derive(Clone)]
pub struct Cache {
    pool: SqlitePool,
}

impl Cache {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    /// Fetch a non-expired entry. Returns `Ok(None)` for both cache miss and
    /// expired-entry-still-on-disk; the caller cannot distinguish, by design.
    pub async fn get(&self, key: &str) -> Result<Option<CachedResponse>, HttpError> {
        let now = epoch_seconds();
        let row = sqlx::query(
            "SELECT status, headers_json, body, fetched_at \
             FROM http_cache \
             WHERE key = ? AND expires_at > ?",
        )
        .bind(key)
        .bind(now)
        .fetch_optional(&self.pool)
        .await?;

        let Some(row) = row else {
            return Ok(None);
        };

        let status: i64 = row.try_get("status")?;
        let headers_json: String = row.try_get("headers_json")?;
        let body: Vec<u8> = row.try_get("body")?;
        let fetched_at: i64 = row.try_get("fetched_at")?;

        let headers: HashMap<String, String> = serde_json::from_str(&headers_json)
            .map_err(|e| HttpError::Decode(format!("cached headers json: {e}")))?;

        Ok(Some(CachedResponse {
            status: u16::try_from(status).unwrap_or(0),
            headers,
            body,
            fetched_at,
        }))
    }

    /// Upsert a cache entry. `ttl` is added to the current epoch seconds to
    /// produce `expires_at`; calling `put` with a TTL of zero is a deliberate
    /// no-op-style cache poisoning prevention (the row is written but
    /// immediately considered expired by [`Cache::get`]).
    pub async fn put(
        &self,
        key: &str,
        service: &str,
        ttl: Duration,
        status: u16,
        headers: &HashMap<String, String>,
        body: &[u8],
    ) -> Result<(), HttpError> {
        let now = epoch_seconds();
        let ttl_secs = i64::try_from(ttl.as_secs()).unwrap_or(i64::MAX);
        let expires_at = now.saturating_add(ttl_secs);
        let headers_json = serde_json::to_string(headers)
            .map_err(|e| HttpError::Decode(format!("encode headers json: {e}")))?;

        sqlx::query(
            "INSERT INTO http_cache \
                 (key, service, status, headers_json, body, fetched_at, expires_at) \
             VALUES (?, ?, ?, ?, ?, ?, ?) \
             ON CONFLICT(key) DO UPDATE SET \
                 service      = excluded.service, \
                 status       = excluded.status, \
                 headers_json = excluded.headers_json, \
                 body         = excluded.body, \
                 fetched_at   = excluded.fetched_at, \
                 expires_at   = excluded.expires_at",
        )
        .bind(key)
        .bind(service)
        .bind(i64::from(status))
        .bind(headers_json)
        .bind(body)
        .bind(now)
        .bind(expires_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    /// Remove every expired row. Returns the number deleted. Callers
    /// invoke this on a cadence of their choice — there is no background
    /// sweep — so expired entries can be served stale by a future
    /// stale-on-error path without a schema change.
    pub async fn purge_expired(&self) -> Result<u64, HttpError> {
        let now = epoch_seconds();
        let result = sqlx::query("DELETE FROM http_cache WHERE expires_at <= ?")
            .bind(now)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected())
    }

    /// Drop every entry for a given service — invoked when a token rotates
    /// or an integration is disconnected so stale data can't leak across
    /// auth boundaries.
    pub async fn purge_service(&self, service: &str) -> Result<u64, HttpError> {
        let result = sqlx::query("DELETE FROM http_cache WHERE service = ?")
            .bind(service)
            .execute(&self.pool)
            .await?;
        Ok(result.rows_affected())
    }
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
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::Executor;

    async fn fresh_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        // T11.4 cache uses migration 0005. Apply it directly here so the
        // cache tests don't depend on the full migration runner.
        pool.execute(include_str!("../../migrations/0005_http_cache.sql"))
            .await
            .expect("apply 0005");
        pool
    }

    fn sample_headers() -> HashMap<String, String> {
        let mut h = HashMap::new();
        h.insert("content-type".into(), "application/json".into());
        h.insert("x-ratelimit-remaining".into(), "42".into());
        h
    }

    #[tokio::test]
    async fn get_returns_none_on_miss() {
        let cache = Cache::new(fresh_pool().await);
        let result = cache.get("missing").await.expect("get");
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn put_then_get_round_trips_within_ttl() {
        let cache = Cache::new(fresh_pool().await);
        let headers = sample_headers();
        cache
            .put(
                "k1",
                "github",
                Duration::from_secs(60),
                200,
                &headers,
                b"hello",
            )
            .await
            .expect("put");

        let got = cache.get("k1").await.expect("get").expect("hit");
        assert_eq!(got.status, 200);
        assert_eq!(got.body, b"hello");
        assert_eq!(
            got.headers.get("content-type").map(String::as_str),
            Some("application/json")
        );
    }

    #[tokio::test]
    async fn get_returns_none_after_ttl_expiry() {
        let cache = Cache::new(fresh_pool().await);
        let headers = sample_headers();
        cache
            .put(
                "k1",
                "github",
                Duration::from_secs(0),
                200,
                &headers,
                b"hello",
            )
            .await
            .expect("put with zero ttl");

        // expires_at = now + 0; the read query uses `expires_at > now`, so
        // a zero TTL is immediately considered expired.
        let got = cache.get("k1").await.expect("get");
        assert!(got.is_none(), "zero-TTL entry must read as a miss");
    }

    #[tokio::test]
    async fn put_upserts_on_conflicting_key() {
        let cache = Cache::new(fresh_pool().await);
        let headers = sample_headers();
        cache
            .put(
                "k1",
                "github",
                Duration::from_secs(60),
                200,
                &headers,
                b"v1",
            )
            .await
            .expect("put v1");
        cache
            .put(
                "k1",
                "github",
                Duration::from_secs(60),
                200,
                &headers,
                b"v2",
            )
            .await
            .expect("put v2");

        let got = cache.get("k1").await.expect("get").expect("hit");
        assert_eq!(got.body, b"v2", "upsert should replace the body");
    }

    #[tokio::test]
    async fn purge_expired_deletes_only_expired_rows() {
        let cache = Cache::new(fresh_pool().await);
        let headers = sample_headers();
        cache
            .put(
                "fresh",
                "github",
                Duration::from_secs(3600),
                200,
                &headers,
                b"f",
            )
            .await
            .expect("put fresh");
        cache
            .put(
                "stale",
                "github",
                Duration::from_secs(0),
                200,
                &headers,
                b"s",
            )
            .await
            .expect("put stale");

        let removed = cache.purge_expired().await.expect("purge");
        assert_eq!(removed, 1, "only the stale row should be deleted");

        assert!(cache.get("fresh").await.expect("get").is_some());
        assert!(cache.get("stale").await.expect("get").is_none());
    }

    #[tokio::test]
    async fn purge_service_scopes_to_that_service() {
        let cache = Cache::new(fresh_pool().await);
        let headers = sample_headers();
        cache
            .put("a", "github", Duration::from_secs(60), 200, &headers, b"a")
            .await
            .unwrap();
        cache
            .put("b", "vercel", Duration::from_secs(60), 200, &headers, b"b")
            .await
            .unwrap();

        let removed = cache.purge_service("github").await.expect("purge");
        assert_eq!(removed, 1);
        assert!(cache.get("a").await.unwrap().is_none());
        assert!(cache.get("b").await.unwrap().is_some());
    }
}
