//! Push-subscription persistence (T18.19, migration 0011).
//!
//! Each row is a single `(endpoint, p256dh, auth)` tuple as defined by
//! RFC 8030 / RFC 8291. `endpoint` is the natural key — the push
//! service issues a unique URL per subscription, and re-subscribing the
//! same service worker replaces the prior row via the upsert path.

use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqlitePool;
use sqlx::Row;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Subscription {
    pub endpoint: String,
    pub p256dh: String,
    pub auth: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_agent: Option<String>,
    pub created_at: i64,
}

/// Insert a new subscription or refresh keys for an existing endpoint.
pub async fn upsert(pool: &SqlitePool, sub: &Subscription) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
             p256dh     = excluded.p256dh,
             auth       = excluded.auth,
             user_agent = excluded.user_agent",
    )
    .bind(&sub.endpoint)
    .bind(&sub.p256dh)
    .bind(&sub.auth)
    .bind(&sub.user_agent)
    .bind(sub.created_at)
    .execute(pool)
    .await?;
    Ok(())
}

/// Remove a subscription by endpoint. Returns the number of rows
/// removed (0 if the endpoint wasn't registered — not an error).
pub async fn delete(pool: &SqlitePool, endpoint: &str) -> Result<u64, sqlx::Error> {
    let result = sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = ?")
        .bind(endpoint)
        .execute(pool)
        .await?;
    Ok(result.rows_affected())
}

/// Load every active subscription.
pub async fn list_all(pool: &SqlitePool) -> Result<Vec<Subscription>, sqlx::Error> {
    let rows = sqlx::query(
        "SELECT endpoint, p256dh, auth, user_agent, created_at
         FROM push_subscriptions
         ORDER BY created_at ASC",
    )
    .fetch_all(pool)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for row in rows {
        out.push(Subscription {
            endpoint: row.try_get("endpoint")?,
            p256dh: row.try_get("p256dh")?,
            auth: row.try_get("auth")?,
            user_agent: row.try_get("user_agent")?,
            created_at: row.try_get("created_at")?,
        });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn fresh_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("pool");
        sqlx::query(include_str!("../../migrations/0011_push_subscriptions.sql"))
            .execute(&pool)
            .await
            .expect("apply migration");
        pool
    }

    fn sample(endpoint: &str) -> Subscription {
        Subscription {
            endpoint: endpoint.to_string(),
            p256dh: "BLpd...p256dh-base64-url-no-pad...".to_string(),
            auth: "auth-secret-base64-url-no-pad".to_string(),
            user_agent: Some("test-agent".to_string()),
            created_at: 1_700_000_000,
        }
    }

    #[tokio::test]
    async fn upsert_inserts_then_replaces() {
        let pool = fresh_pool().await;
        upsert(&pool, &sample("https://fcm.example/abc"))
            .await
            .expect("insert");
        let again = Subscription {
            p256dh: "REFRESHED".into(),
            ..sample("https://fcm.example/abc")
        };
        upsert(&pool, &again).await.expect("upsert");

        let all = list_all(&pool).await.expect("list");
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].p256dh, "REFRESHED");
    }

    #[tokio::test]
    async fn delete_removes_only_target_row() {
        let pool = fresh_pool().await;
        upsert(&pool, &sample("https://fcm.example/a"))
            .await
            .expect("a");
        upsert(&pool, &sample("https://fcm.example/b"))
            .await
            .expect("b");
        assert_eq!(delete(&pool, "https://fcm.example/a").await.unwrap(), 1);
        assert_eq!(delete(&pool, "https://missing.example/x").await.unwrap(), 0);
        let remaining = list_all(&pool).await.expect("list");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].endpoint, "https://fcm.example/b");
    }
}
