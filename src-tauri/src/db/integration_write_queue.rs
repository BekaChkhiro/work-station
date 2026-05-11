//! T11.9: queries for `integration_write_queue` — persistent FIFO write queue
//! for integration calls that landed while the user was offline.
//!
//! Pure async functions over `&SqlitePool`. The Tauri command layer in
//! `commands/integration_queue.rs` wraps these and maps `QueueError` onto the
//! standard `{ kind, message, userMessage, recovery }` shape.
//!
//! Hard cap: 50 rows. [`enqueue`] auto-evicts the oldest row when the count
//! would exceed the cap and reports `evicted = true` so the UI can surface a
//! toast. Body bytes travel as base64 strings across the Tauri boundary and
//! are stored as BLOB inside the DB; this layer owns the
//! decode-on-write / encode-on-read conversion.

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqlitePool, SqliteRow};
use sqlx::Row;

pub const QUEUE_CAP: i64 = 50;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntry {
    pub id: i64,
    pub service: String,
    pub method: String,
    pub url: String,
    /// JSON object — `Record<string, string>`. Stored as TEXT in the DB,
    /// surfaced as `serde_json::Value` here so the command layer doesn't
    /// reparse.
    pub headers: serde_json::Value,
    /// base64 of the raw body bytes; `None` when the request had no body.
    pub body_base64: Option<String>,
    pub enqueued_at: i64,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub last_attempt_at: Option<i64>,
}

#[derive(Debug, Clone)]
pub struct NewQueueEntry {
    pub service: String,
    pub method: String,
    pub url: String,
    pub headers: serde_json::Value,
    pub body_base64: Option<String>,
    pub enqueued_at: i64,
}

#[derive(Debug)]
pub struct EnqueueResult {
    pub id: i64,
    /// `true` when we dropped the oldest row to make space.
    pub evicted: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum QueueError {
    #[error("service must not be empty")]
    EmptyService,
    #[error("method must not be empty")]
    EmptyMethod,
    #[error("url must not be empty")]
    EmptyUrl,
    #[error("headers must be a JSON object")]
    HeadersNotObject,
    #[error("invalid base64 body: {0}")]
    InvalidBody(String),
    #[error(transparent)]
    Sqlx(#[from] sqlx::Error),
}

/// Enqueue a new write in a single transaction.
///
/// Steps:
/// 1. Validate inputs.
/// 2. Count rows; if `>= QUEUE_CAP` delete the oldest by `(enqueued_at, id)`.
/// 3. INSERT and return the new `id`.
/// 4. Commit.
pub async fn enqueue(pool: &SqlitePool, input: NewQueueEntry) -> Result<EnqueueResult, QueueError> {
    let NewQueueEntry {
        service,
        method,
        url,
        headers,
        body_base64,
        enqueued_at,
    } = input;

    if service.trim().is_empty() {
        return Err(QueueError::EmptyService);
    }
    if method.trim().is_empty() {
        return Err(QueueError::EmptyMethod);
    }
    if url.trim().is_empty() {
        return Err(QueueError::EmptyUrl);
    }
    if !headers.is_object() {
        return Err(QueueError::HeadersNotObject);
    }

    // Decode body once for validation; store the decoded bytes as BLOB.
    let body_bytes: Option<Vec<u8>> = match &body_base64 {
        None => None,
        Some(b64) => {
            let bytes = B64
                .decode(b64)
                .map_err(|e| QueueError::InvalidBody(e.to_string()))?;
            Some(bytes)
        }
    };

    let service = service.trim().to_string();
    let method = method.trim().to_string();
    let url = url.trim().to_string();
    // Corrupt headers degrade to `{}` on read; serialise the validated object
    // for storage.
    let headers_json = serde_json::to_string(&headers).unwrap_or_else(|_| "{}".to_string());

    let mut tx = pool.begin().await?;

    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM integration_write_queue")
        .fetch_one(&mut *tx)
        .await?;

    let evicted = if count >= QUEUE_CAP {
        // Delete the oldest row (smallest enqueued_at; break ties by id).
        sqlx::query(
            "DELETE FROM integration_write_queue
             WHERE id = (
                 SELECT id FROM integration_write_queue
                 ORDER BY enqueued_at ASC, id ASC
                 LIMIT 1
             )",
        )
        .execute(&mut *tx)
        .await?;
        true
    } else {
        false
    };

    let id: i64 = sqlx::query_scalar(
        "INSERT INTO integration_write_queue
             (service, method, url, headers_json, body, enqueued_at)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING id",
    )
    .bind(&service)
    .bind(&method)
    .bind(&url)
    .bind(&headers_json)
    .bind(body_bytes.as_deref())
    .bind(enqueued_at)
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(EnqueueResult { id, evicted })
}

/// List all queued entries, optionally filtered to a single service.
/// Results are ordered `(enqueued_at ASC, id ASC)` — FIFO drain order.
pub async fn list(pool: &SqlitePool, service: Option<&str>) -> Result<Vec<QueueEntry>, QueueError> {
    let rows = match service {
        None => {
            sqlx::query(
                "SELECT id, service, method, url, headers_json, body,
                        enqueued_at, attempts, last_error, last_attempt_at
                 FROM integration_write_queue
                 ORDER BY enqueued_at ASC, id ASC",
            )
            .fetch_all(pool)
            .await?
        }
        Some(svc) => {
            sqlx::query(
                "SELECT id, service, method, url, headers_json, body,
                        enqueued_at, attempts, last_error, last_attempt_at
                 FROM integration_write_queue
                 WHERE service = ?
                 ORDER BY enqueued_at ASC, id ASC",
            )
            .bind(svc)
            .fetch_all(pool)
            .await?
        }
    };
    rows.into_iter().map(row_to_entry).collect()
}

/// Return the single oldest queued entry, optionally scoped to a service.
// Used by the TypeScript replay worker via the command layer (T11.9 frontend)
// and by in-module tests; the command is not wired yet but the query is part
// of the stable public surface.
#[allow(dead_code)]
pub async fn peek_oldest(
    pool: &SqlitePool,
    service: Option<&str>,
) -> Result<Option<QueueEntry>, QueueError> {
    let row = match service {
        None => {
            sqlx::query(
                "SELECT id, service, method, url, headers_json, body,
                        enqueued_at, attempts, last_error, last_attempt_at
                 FROM integration_write_queue
                 ORDER BY enqueued_at ASC, id ASC
                 LIMIT 1",
            )
            .fetch_optional(pool)
            .await?
        }
        Some(svc) => {
            sqlx::query(
                "SELECT id, service, method, url, headers_json, body,
                        enqueued_at, attempts, last_error, last_attempt_at
                 FROM integration_write_queue
                 WHERE service = ?
                 ORDER BY enqueued_at ASC, id ASC
                 LIMIT 1",
            )
            .bind(svc)
            .fetch_optional(pool)
            .await?
        }
    };
    row.map(row_to_entry).transpose()
}

/// Remove a queued entry by `id`. Returns `true` when a row was deleted,
/// `false` when the id was not found (idempotent).
pub async fn dequeue(pool: &SqlitePool, id: i64) -> Result<bool, QueueError> {
    let result = sqlx::query("DELETE FROM integration_write_queue WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(result.rows_affected() > 0)
}

/// Record a failed delivery attempt: increment `attempts`, set `last_error`
/// and `last_attempt_at`. Returns `true` if the row exists, `false` if not.
pub async fn mark_failed(
    pool: &SqlitePool,
    id: i64,
    error: &str,
    at: i64,
) -> Result<bool, QueueError> {
    let result = sqlx::query(
        "UPDATE integration_write_queue
         SET attempts = attempts + 1,
             last_error = ?,
             last_attempt_at = ?
         WHERE id = ?",
    )
    .bind(error)
    .bind(at)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() > 0)
}

/// Delete all entries for the given service. Returns the number of rows
/// removed.
pub async fn clear_service(pool: &SqlitePool, service: &str) -> Result<u64, QueueError> {
    let result = sqlx::query("DELETE FROM integration_write_queue WHERE service = ?")
        .bind(service)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

fn row_to_entry(row: SqliteRow) -> Result<QueueEntry, QueueError> {
    let id: i64 = row.try_get("id")?;
    let service: String = row.try_get("service")?;
    let method: String = row.try_get("method")?;
    let url: String = row.try_get("url")?;
    let headers_json: String = row.try_get("headers_json")?;
    let body_blob: Option<Vec<u8>> = row.try_get("body")?;
    let enqueued_at: i64 = row.try_get("enqueued_at")?;
    let attempts: i64 = row.try_get("attempts")?;
    let last_error: Option<String> = row.try_get("last_error")?;
    let last_attempt_at: Option<i64> = row.try_get("last_attempt_at")?;

    // Corrupt header rows degrade to `{}` — same resilience stance as project_links.
    let headers = serde_json::from_str::<serde_json::Value>(&headers_json)
        .unwrap_or_else(|_| serde_json::json!({}));

    let body_base64 = body_blob.map(|bytes| B64.encode(&bytes));

    Ok(QueueEntry {
        id,
        service,
        method,
        url,
        headers,
        body_base64,
        enqueued_at,
        attempts,
        last_error,
        last_attempt_at,
    })
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
        super::super::apply_pragmas(&pool)
            .await
            .expect("apply pragmas");
        pool.execute(include_str!(
            "../../migrations/0008_integration_write_queue.sql"
        ))
        .await
        .expect("apply 0008");
        pool
    }

    fn entry(service: &str, at: i64) -> NewQueueEntry {
        NewQueueEntry {
            service: service.to_string(),
            method: "POST".to_string(),
            url: "https://example.com/api".to_string(),
            headers: serde_json::json!({"Content-Type": "application/json"}),
            body_base64: None,
            enqueued_at: at,
        }
    }

    #[tokio::test]
    async fn enqueue_returns_id_and_increments_count() {
        let pool = fresh_pool().await;
        let r = enqueue(&pool, entry("github", 1_000))
            .await
            .expect("enqueue");
        assert!(r.id > 0);
        assert!(!r.evicted);

        let r2 = enqueue(&pool, entry("github", 2_000))
            .await
            .expect("enqueue 2");
        assert!(r2.id > r.id);
        assert!(!r2.evicted);

        let rows = list(&pool, None).await.expect("list");
        assert_eq!(rows.len(), 2);
    }

    #[tokio::test]
    async fn enqueue_evicts_oldest_when_at_cap() {
        let pool = fresh_pool().await;

        // Insert exactly QUEUE_CAP entries.
        let mut first_id: Option<i64> = None;
        for i in 0..QUEUE_CAP {
            let r = enqueue(&pool, entry("github", i)).await.expect("seed");
            if first_id.is_none() {
                first_id = Some(r.id);
            }
            assert!(!r.evicted, "should not evict before cap");
        }

        // The (CAP+1)-th insert must evict the oldest.
        let overflow = enqueue(&pool, entry("github", QUEUE_CAP))
            .await
            .expect("overflow");
        assert!(overflow.evicted, "must evict when over cap");

        let rows = list(&pool, None).await.expect("list after overflow");
        assert_eq!(rows.len() as i64, QUEUE_CAP, "count must stay at cap");

        // The oldest row (first_id) must be gone.
        let first_still_present = rows.iter().any(|e| Some(e.id) == first_id);
        assert!(!first_still_present, "oldest row must have been evicted");
    }

    #[tokio::test]
    async fn list_returns_fifo_order() {
        let pool = fresh_pool().await;

        // Enqueue out-of-timestamp-order to verify SQL ordering, not insert order.
        enqueue(&pool, entry("svc", 3_000)).await.unwrap();
        enqueue(&pool, entry("svc", 1_000)).await.unwrap();
        enqueue(&pool, entry("svc", 2_000)).await.unwrap();

        let rows = list(&pool, None).await.unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].enqueued_at, 1_000);
        assert_eq!(rows[1].enqueued_at, 2_000);
        assert_eq!(rows[2].enqueued_at, 3_000);
    }

    #[tokio::test]
    async fn list_filtered_by_service() {
        let pool = fresh_pool().await;

        enqueue(&pool, entry("github", 1_000)).await.unwrap();
        enqueue(&pool, entry("vercel", 2_000)).await.unwrap();
        enqueue(&pool, entry("github", 3_000)).await.unwrap();

        let github_rows = list(&pool, Some("github")).await.unwrap();
        assert_eq!(github_rows.len(), 2);
        assert!(github_rows.iter().all(|e| e.service == "github"));

        let vercel_rows = list(&pool, Some("vercel")).await.unwrap();
        assert_eq!(vercel_rows.len(), 1);
        assert_eq!(vercel_rows[0].service, "vercel");

        let all_rows = list(&pool, None).await.unwrap();
        assert_eq!(all_rows.len(), 3);
    }

    #[tokio::test]
    async fn dequeue_returns_false_for_unknown_id() {
        let pool = fresh_pool().await;
        let removed = dequeue(&pool, 99_999).await.unwrap();
        assert!(!removed, "unknown id must return false");
    }

    #[tokio::test]
    async fn dequeue_removes_known_id() {
        let pool = fresh_pool().await;
        let r = enqueue(&pool, entry("svc", 1_000)).await.unwrap();
        let removed = dequeue(&pool, r.id).await.unwrap();
        assert!(removed);
        assert!(list(&pool, None).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn mark_failed_bumps_attempts_and_writes_error() {
        let pool = fresh_pool().await;
        let r = enqueue(&pool, entry("svc", 1_000)).await.unwrap();

        let updated = mark_failed(&pool, r.id, "connection refused", 1_001)
            .await
            .unwrap();
        assert!(updated);

        let rows = list(&pool, None).await.unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].attempts, 1);
        assert_eq!(rows[0].last_error.as_deref(), Some("connection refused"));
        assert_eq!(rows[0].last_attempt_at, Some(1_001));

        // Second failure stacks.
        mark_failed(&pool, r.id, "timeout", 1_002).await.unwrap();
        let rows = list(&pool, None).await.unwrap();
        assert_eq!(rows[0].attempts, 2);
        assert_eq!(rows[0].last_error.as_deref(), Some("timeout"));
    }

    #[tokio::test]
    async fn mark_failed_returns_false_for_unknown_id() {
        let pool = fresh_pool().await;
        let updated = mark_failed(&pool, 99_999, "oops", 0).await.unwrap();
        assert!(!updated);
    }

    #[tokio::test]
    async fn clear_service_only_drops_matching_rows() {
        let pool = fresh_pool().await;

        enqueue(&pool, entry("github", 1_000)).await.unwrap();
        enqueue(&pool, entry("vercel", 2_000)).await.unwrap();
        enqueue(&pool, entry("github", 3_000)).await.unwrap();

        let removed = clear_service(&pool, "github").await.unwrap();
        assert_eq!(removed, 2);

        let remaining = list(&pool, None).await.unwrap();
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].service, "vercel");
    }

    #[tokio::test]
    async fn enqueue_rejects_empty_service() {
        let pool = fresh_pool().await;
        let err = enqueue(
            &pool,
            NewQueueEntry {
                service: "  ".to_string(),
                method: "POST".to_string(),
                url: "https://x.com".to_string(),
                headers: serde_json::json!({}),
                body_base64: None,
                enqueued_at: 0,
            },
        )
        .await
        .expect_err("empty service should fail");
        assert!(matches!(err, QueueError::EmptyService));
    }

    #[tokio::test]
    async fn enqueue_rejects_empty_method() {
        let pool = fresh_pool().await;
        let err = enqueue(
            &pool,
            NewQueueEntry {
                service: "svc".to_string(),
                method: "".to_string(),
                url: "https://x.com".to_string(),
                headers: serde_json::json!({}),
                body_base64: None,
                enqueued_at: 0,
            },
        )
        .await
        .expect_err("empty method should fail");
        assert!(matches!(err, QueueError::EmptyMethod));
    }

    #[tokio::test]
    async fn enqueue_rejects_empty_url() {
        let pool = fresh_pool().await;
        let err = enqueue(
            &pool,
            NewQueueEntry {
                service: "svc".to_string(),
                method: "POST".to_string(),
                url: "   ".to_string(),
                headers: serde_json::json!({}),
                body_base64: None,
                enqueued_at: 0,
            },
        )
        .await
        .expect_err("empty url should fail");
        assert!(matches!(err, QueueError::EmptyUrl));
    }

    #[tokio::test]
    async fn enqueue_rejects_non_object_headers() {
        let pool = fresh_pool().await;
        let err = enqueue(
            &pool,
            NewQueueEntry {
                service: "svc".to_string(),
                method: "POST".to_string(),
                url: "https://x.com".to_string(),
                headers: serde_json::json!(["not", "an", "object"]),
                body_base64: None,
                enqueued_at: 0,
            },
        )
        .await
        .expect_err("array headers should fail");
        assert!(matches!(err, QueueError::HeadersNotObject));
    }

    #[tokio::test]
    async fn enqueue_rejects_invalid_base64_body() {
        let pool = fresh_pool().await;
        let err = enqueue(
            &pool,
            NewQueueEntry {
                service: "svc".to_string(),
                method: "POST".to_string(),
                url: "https://x.com".to_string(),
                headers: serde_json::json!({}),
                body_base64: Some("!!!not_valid_base64!!!".to_string()),
                enqueued_at: 0,
            },
        )
        .await
        .expect_err("bad base64 should fail");
        assert!(matches!(err, QueueError::InvalidBody(_)));
    }

    #[tokio::test]
    async fn body_blob_round_trips_through_base64() {
        let pool = fresh_pool().await;
        let original_bytes = b"\x00\x01\x02\xff\xfe\xfd hello world";
        let b64 = B64.encode(original_bytes);

        let r = enqueue(
            &pool,
            NewQueueEntry {
                service: "svc".to_string(),
                method: "PUT".to_string(),
                url: "https://x.com/data".to_string(),
                headers: serde_json::json!({}),
                body_base64: Some(b64.clone()),
                enqueued_at: 1_000,
            },
        )
        .await
        .unwrap();

        let rows = list(&pool, None).await.unwrap();
        assert_eq!(rows.len(), 1);
        let returned_b64 = rows[0]
            .body_base64
            .as_ref()
            .expect("body should round-trip");
        let returned_bytes = B64.decode(returned_b64).expect("valid base64");
        assert_eq!(returned_bytes, original_bytes);

        // peek_oldest should also carry the body.
        let peeked = peek_oldest(&pool, None).await.unwrap().expect("peek");
        assert_eq!(peeked.id, r.id);
        let peeked_bytes = B64
            .decode(peeked.body_base64.as_ref().unwrap())
            .expect("valid base64");
        assert_eq!(peeked_bytes, original_bytes);
    }

    #[tokio::test]
    async fn peek_oldest_returns_none_on_empty_queue() {
        let pool = fresh_pool().await;
        let result = peek_oldest(&pool, None).await.unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn peek_oldest_returns_fifo_head() {
        let pool = fresh_pool().await;
        enqueue(&pool, entry("svc", 5_000)).await.unwrap();
        let first = enqueue(&pool, entry("svc", 1_000)).await.unwrap();

        let peeked = peek_oldest(&pool, None)
            .await
            .unwrap()
            .expect("should peek");
        assert_eq!(peeked.id, first.id);
        assert_eq!(peeked.enqueued_at, 1_000);
    }
}
