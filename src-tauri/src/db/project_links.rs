//! T11.5: queries for `project_links` — the project ↔ external-service map.
//!
//! One row per (`project_id`, `service`, `external_id`) triple. A project can
//! link to several services (`PlanFlow` / `GitHub` / Vercel / Neon / Railway) and
//! can also keep multiple resources under the same service when needed.
//!
//! Pure async functions over `&SqlitePool` mirroring `db/projects.rs`, so a
//! fresh in-memory pool is all the tests need. The Tauri command layer in
//! `commands/project_links.rs` wraps these and maps `ProjectLinkError` onto
//! the standard `{ kind, message, userMessage, recovery }` shape (T2.15).

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqlitePool, SqliteRow};
use sqlx::Row;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectLink {
    pub project_id: String,
    pub service: String,
    pub external_id: String,
    /// Free-form JSON the UI uses to render the link without re-fetching the
    /// remote resource (e.g. `{"name":"acme/web","htmlUrl":"…"}`). Stored as
    /// a serialized JSON object string in `metadata_json`; deserialized into
    /// a `serde_json::Value` here so the wire shape matches what the
    /// frontend posts back when updating an existing row.
    pub metadata: serde_json::Value,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub struct NewProjectLink {
    pub project_id: String,
    pub service: String,
    pub external_id: String,
    pub metadata: serde_json::Value,
}

#[derive(Debug, thiserror::Error)]
pub enum ProjectLinkError {
    #[error("project id must not be empty")]
    EmptyProjectId,
    #[error("service must not be empty")]
    EmptyService,
    #[error("external id must not be empty")]
    EmptyExternalId,
    #[error("metadata must be a JSON object")]
    MetadataNotObject,
    #[error("project not found: {0}")]
    ProjectNotFound(String),
    #[error("metadata serialization: {0}")]
    MetadataSerialize(#[from] serde_json::Error),
    #[error("sqlx: {0}")]
    Sqlx(#[from] sqlx::Error),
}

/// List every link for one project, ordered `(service, external_id)` so the UI
/// renders groups deterministically.
pub async fn list(
    pool: &SqlitePool,
    project_id: &str,
) -> Result<Vec<ProjectLink>, ProjectLinkError> {
    if project_id.is_empty() {
        return Err(ProjectLinkError::EmptyProjectId);
    }
    let rows = sqlx::query(
        "SELECT project_id, service, external_id, metadata_json, created_at
         FROM project_links
         WHERE project_id = ?
         ORDER BY service ASC, external_id ASC",
    )
    .bind(project_id)
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(row_to_link).collect()
}

/// Upsert a single (`project_id`, `service`, `external_id`) link. When the
/// triple already exists, `metadata_json` is replaced and `created_at` is
/// preserved — relinking is a metadata refresh, not a re-creation event the
/// UI should treat as new.
pub async fn set(
    pool: &SqlitePool,
    input: NewProjectLink,
) -> Result<ProjectLink, ProjectLinkError> {
    let NewProjectLink {
        project_id,
        service,
        external_id,
        metadata,
    } = input;

    if project_id.is_empty() {
        return Err(ProjectLinkError::EmptyProjectId);
    }
    if service.trim().is_empty() {
        return Err(ProjectLinkError::EmptyService);
    }
    if external_id.trim().is_empty() {
        return Err(ProjectLinkError::EmptyExternalId);
    }
    if !metadata.is_object() {
        return Err(ProjectLinkError::MetadataNotObject);
    }

    let service = service.trim().to_string();
    let external_id = external_id.trim().to_string();
    let metadata_json = serde_json::to_string(&metadata)?;
    let created_at = epoch_seconds();

    // ON CONFLICT preserves the original `created_at` and only refreshes the
    // metadata blob — see fn-doc above.
    let result = sqlx::query(
        "INSERT INTO project_links (project_id, service, external_id, metadata_json, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, service, external_id) DO UPDATE SET
             metadata_json = excluded.metadata_json",
    )
    .bind(&project_id)
    .bind(&service)
    .bind(&external_id)
    .bind(&metadata_json)
    .bind(created_at)
    .execute(pool)
    .await;

    match result {
        Ok(_) => fetch_one(pool, &project_id, &service, &external_id).await,
        Err(sqlx::Error::Database(db_err)) if is_fk_violation(db_err.as_ref()) => {
            Err(ProjectLinkError::ProjectNotFound(project_id))
        }
        Err(other) => Err(other.into()),
    }
}

/// Remove one specific link. Returns `true` when a row was deleted, `false`
/// when the triple was already gone — the UI treats both as "ok, unlinked".
pub async fn delete(
    pool: &SqlitePool,
    project_id: &str,
    service: &str,
    external_id: &str,
) -> Result<bool, ProjectLinkError> {
    if project_id.is_empty() {
        return Err(ProjectLinkError::EmptyProjectId);
    }
    if service.trim().is_empty() {
        return Err(ProjectLinkError::EmptyService);
    }
    if external_id.trim().is_empty() {
        return Err(ProjectLinkError::EmptyExternalId);
    }

    let result = sqlx::query(
        "DELETE FROM project_links
         WHERE project_id = ? AND service = ? AND external_id = ?",
    )
    .bind(project_id)
    .bind(service.trim())
    .bind(external_id.trim())
    .execute(pool)
    .await?;

    Ok(result.rows_affected() > 0)
}

async fn fetch_one(
    pool: &SqlitePool,
    project_id: &str,
    service: &str,
    external_id: &str,
) -> Result<ProjectLink, ProjectLinkError> {
    let row = sqlx::query(
        "SELECT project_id, service, external_id, metadata_json, created_at
         FROM project_links
         WHERE project_id = ? AND service = ? AND external_id = ?",
    )
    .bind(project_id)
    .bind(service)
    .bind(external_id)
    .fetch_one(pool)
    .await?;
    row_to_link(row)
}

fn row_to_link(row: SqliteRow) -> Result<ProjectLink, ProjectLinkError> {
    let project_id: String = row.try_get("project_id")?;
    let service: String = row.try_get("service")?;
    let external_id: String = row.try_get("external_id")?;
    let metadata_json: String = row.try_get("metadata_json")?;
    let created_at: i64 = row.try_get("created_at")?;
    // Corrupt rows degrade to `{}` rather than failing the list query — same
    // resilience stance `db/projects.rs` takes for workspace_tabs_json.
    let metadata = serde_json::from_str::<serde_json::Value>(&metadata_json)
        .unwrap_or_else(|_| serde_json::json!({}));
    Ok(ProjectLink {
        project_id,
        service,
        external_id,
        metadata,
        created_at,
    })
}

fn is_fk_violation(err: &dyn sqlx::error::DatabaseError) -> bool {
    err.code().as_deref() == Some("787")
        || err
            .message()
            .to_ascii_lowercase()
            .contains("foreign key constraint")
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
        super::super::apply_pragmas(&pool)
            .await
            .expect("apply pragmas");
        pool.execute(include_str!("../../migrations/0001_projects.sql"))
            .await
            .expect("apply 0001");
        // T11.1 adds workspace tab columns but only 0001 is needed for the
        // FK target — 0006 is harmless to skip in tests that don't touch it.
        pool.execute(include_str!("../../migrations/0007_project_links.sql"))
            .await
            .expect("apply 0007");
        pool
    }

    async fn seed_project(pool: &SqlitePool, id: &str) {
        sqlx::query(
            "INSERT INTO projects (id, name, path, env_json, position, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind(id)
        .bind(format!("project-{id}"))
        .bind("/tmp")
        .bind("{}")
        .bind(0_i64)
        .bind(1_700_000_000_i64)
        .execute(pool)
        .await
        .expect("seed project");
    }

    #[tokio::test]
    async fn set_inserts_then_lists_ordered() {
        let pool = fresh_pool().await;
        seed_project(&pool, "p1").await;

        set(
            &pool,
            NewProjectLink {
                project_id: "p1".into(),
                service: "github".into(),
                external_id: "acme/web".into(),
                metadata: serde_json::json!({"htmlUrl": "https://github.com/acme/web"}),
            },
        )
        .await
        .expect("link github");

        set(
            &pool,
            NewProjectLink {
                project_id: "p1".into(),
                service: "planflow".into(),
                external_id: "00000000-0000-0000-0000-000000000001".into(),
                metadata: serde_json::json!({"name": "Demo"}),
            },
        )
        .await
        .expect("link planflow");

        let links = list(&pool, "p1").await.expect("list links");
        assert_eq!(links.len(), 2);
        // Service order: github < planflow alphabetically.
        assert_eq!(links[0].service, "github");
        assert_eq!(links[0].external_id, "acme/web");
        assert_eq!(
            links[0].metadata["htmlUrl"],
            serde_json::Value::String("https://github.com/acme/web".into())
        );
        assert_eq!(links[1].service, "planflow");
    }

    #[tokio::test]
    async fn set_upserts_metadata_and_preserves_created_at() {
        let pool = fresh_pool().await;
        seed_project(&pool, "p1").await;

        let first = set(
            &pool,
            NewProjectLink {
                project_id: "p1".into(),
                service: "vercel".into(),
                external_id: "prj_abc".into(),
                metadata: serde_json::json!({"slug": "old"}),
            },
        )
        .await
        .expect("first set");

        // Sleep one second so a naive "created_at = now" implementation
        // would change the timestamp and the assert below would fail.
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;

        let second = set(
            &pool,
            NewProjectLink {
                project_id: "p1".into(),
                service: "vercel".into(),
                external_id: "prj_abc".into(),
                metadata: serde_json::json!({"slug": "new"}),
            },
        )
        .await
        .expect("second set");

        assert_eq!(second.created_at, first.created_at, "created_at preserved");
        assert_eq!(
            second.metadata["slug"],
            serde_json::Value::String("new".into())
        );

        let links = list(&pool, "p1").await.expect("list");
        assert_eq!(links.len(), 1, "upsert, not insert");
    }

    #[tokio::test]
    async fn multiple_external_ids_per_service_allowed() {
        let pool = fresh_pool().await;
        seed_project(&pool, "p1").await;

        for repo in ["acme/web", "acme/api"] {
            set(
                &pool,
                NewProjectLink {
                    project_id: "p1".into(),
                    service: "github".into(),
                    external_id: repo.into(),
                    metadata: serde_json::json!({}),
                },
            )
            .await
            .expect("link repo");
        }

        let links = list(&pool, "p1").await.expect("list");
        assert_eq!(links.len(), 2);
        let ids: Vec<&str> = links.iter().map(|l| l.external_id.as_str()).collect();
        assert_eq!(ids, vec!["acme/api", "acme/web"]);
    }

    #[tokio::test]
    async fn delete_removes_one_link_and_is_idempotent() {
        let pool = fresh_pool().await;
        seed_project(&pool, "p1").await;
        set(
            &pool,
            NewProjectLink {
                project_id: "p1".into(),
                service: "neon".into(),
                external_id: "br_main".into(),
                metadata: serde_json::json!({}),
            },
        )
        .await
        .unwrap();

        let removed = delete(&pool, "p1", "neon", "br_main").await.unwrap();
        assert!(removed);
        assert!(list(&pool, "p1").await.unwrap().is_empty());

        // Idempotent second call.
        let removed_again = delete(&pool, "p1", "neon", "br_main").await.unwrap();
        assert!(!removed_again);
    }

    #[tokio::test]
    async fn set_rejects_unknown_project_id() {
        let pool = fresh_pool().await;
        let err = set(
            &pool,
            NewProjectLink {
                project_id: "ghost".into(),
                service: "github".into(),
                external_id: "x/y".into(),
                metadata: serde_json::json!({}),
            },
        )
        .await
        .expect_err("unknown project should fail");
        assert!(matches!(err, ProjectLinkError::ProjectNotFound(_)));
    }

    #[tokio::test]
    async fn set_rejects_non_object_metadata() {
        let pool = fresh_pool().await;
        seed_project(&pool, "p1").await;
        let err = set(
            &pool,
            NewProjectLink {
                project_id: "p1".into(),
                service: "github".into(),
                external_id: "x/y".into(),
                metadata: serde_json::json!("not-an-object"),
            },
        )
        .await
        .expect_err("string metadata should reject");
        assert!(matches!(err, ProjectLinkError::MetadataNotObject));
    }

    #[tokio::test]
    async fn deleting_project_cascades_links() {
        let pool = fresh_pool().await;
        seed_project(&pool, "p1").await;
        set(
            &pool,
            NewProjectLink {
                project_id: "p1".into(),
                service: "railway".into(),
                external_id: "svc_1".into(),
                metadata: serde_json::json!({}),
            },
        )
        .await
        .unwrap();

        sqlx::query("DELETE FROM projects WHERE id = ?")
            .bind("p1")
            .execute(&pool)
            .await
            .expect("delete project");

        // Links table is now empty — CASCADE fired.
        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM project_links")
            .fetch_one(&pool)
            .await
            .expect("count");
        assert_eq!(remaining, 0);
    }
}
