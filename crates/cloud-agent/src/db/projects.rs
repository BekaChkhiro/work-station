// T19.25 prose mentions `SQLite`, `PWA` etc. in passing — allow the
// doc-markdown lint at the module level, matching the desktop bridge.
#![allow(clippy::doc_markdown)]

//! Cloud-agent project read paths (T19.25).
//!
//! Mirrors the read surface of `src-tauri/src/db/projects.rs`: a
//! `Project` row shape (camelCase on the wire so the PWA's typed
//! schemas parse without renaming), plus `list` and `get` functions
//! the WS dispatcher hands a [`SqlitePool`]. Tolerance for corrupt
//! JSON columns matches the desktop's — a bad `env_json` /
//! `startup_commands_json` / `workspace_tabs_json` degrades to a
//! default rather than failing the whole list, since a single
//! malformed row would otherwise blank the PWA sidebar.
//!
//! Write paths (`create`/`update`/`delete`/`reorder`) are intentionally
//! omitted in T19.25 — the cloud-agent's WS protocol doesn't expose
//! project mutations yet (`src/db/projects.ts` routes those as
//! `routeIpcLocalOnly`). A follow-up task adds them when the wire
//! contract grows the corresponding `*_create` / `*_update` /
//! `*_delete` variants.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqlitePool, SqliteRow};
use sqlx::Row;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub default_cli: Option<String>,
    pub env: HashMap<String, String>,
    pub startup_commands: Vec<String>,
    pub workspace_tabs: Vec<String>,
    pub active_workspace_tab: String,
    pub position: i64,
    pub created_at: i64,
}

#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    #[error("project not found: {0}")]
    NotFound(String),
    #[error("sqlx: {0}")]
    Sqlx(#[from] sqlx::Error),
}

/// Return all projects, ordered by `position` then `created_at` for
/// stability when two rows share the same position.
pub async fn list(pool: &SqlitePool) -> Result<Vec<Project>, ProjectError> {
    let rows = sqlx::query(
        "SELECT id, name, path, color, icon, default_cli, env_json,
                startup_commands_json, workspace_tabs_json, active_workspace_tab,
                position, created_at
         FROM projects
         ORDER BY position ASC, created_at ASC",
    )
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(row_to_project).collect()
}

/// Fetch a single project by id. Returns [`ProjectError::NotFound`] if
/// the row is gone (raced with a delete on the desktop side, or a stale
/// PWA cache).
pub async fn get(pool: &SqlitePool, id: &str) -> Result<Project, ProjectError> {
    let row = sqlx::query(
        "SELECT id, name, path, color, icon, default_cli, env_json,
                startup_commands_json, workspace_tabs_json, active_workspace_tab,
                position, created_at
         FROM projects WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| ProjectError::NotFound(id.to_string()))?;
    row_to_project(row)
}

fn row_to_project(row: SqliteRow) -> Result<Project, ProjectError> {
    let env_json: String = row.try_get("env_json")?;
    let env: HashMap<String, String> = serde_json::from_str(&env_json).unwrap_or_default();
    let startup_commands_json: String = row.try_get("startup_commands_json")?;
    let startup_commands: Vec<String> =
        serde_json::from_str(&startup_commands_json).unwrap_or_default();
    let workspace_tabs_json: String = row.try_get("workspace_tabs_json")?;
    let workspace_tabs: Vec<String> =
        serde_json::from_str(&workspace_tabs_json).unwrap_or_else(|_| vec!["terminal".to_string()]);
    let active_workspace_tab: String = row.try_get("active_workspace_tab")?;
    Ok(Project {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        path: row.try_get("path")?,
        color: row.try_get("color")?,
        icon: row.try_get("icon")?,
        default_cli: row.try_get("default_cli")?,
        env,
        startup_commands,
        workspace_tabs,
        active_workspace_tab,
        position: row.try_get("position")?,
        created_at: row.try_get("created_at")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// Seed a single project row with non-default JSON columns so the
    /// row_to_project decoder is exercised end-to-end. Returns the id
    /// so callers can re-fetch with `get`.
    async fn seed(pool: &SqlitePool, name: &str, position: i64) -> String {
        let id = format!("p-{name}");
        sqlx::query(
            "INSERT INTO projects (id, name, path, color, icon, default_cli, env_json,
                startup_commands_json, workspace_tabs_json, active_workspace_tab,
                position, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(&id)
        .bind(name)
        .bind(format!("/srv/projects/{name}"))
        .bind("#fa0")
        .bind("rocket")
        .bind("zsh")
        .bind(r#"{"FOO":"bar"}"#)
        .bind(r#"["echo hi"]"#)
        .bind(r#"["terminal","planflow"]"#)
        .bind("planflow")
        .bind(position)
        .bind(1_700_000_000_i64 + position)
        .execute(pool)
        .await
        .expect("seed row");
        id
    }

    async fn pool() -> SqlitePool {
        let dir = tempdir().expect("tempdir");
        let dir = Box::leak(Box::new(dir));
        crate::db::open(dir.path()).await.expect("open")
    }

    #[tokio::test]
    async fn list_returns_rows_in_position_order() {
        let pool = pool().await;
        seed(&pool, "alpha", 0).await;
        seed(&pool, "beta", 1).await;
        let rows = list(&pool).await.expect("list");
        let names: Vec<_> = rows.iter().map(|p| p.name.as_str()).collect();
        assert_eq!(names, vec!["alpha", "beta"]);
        assert_eq!(rows[0].env.get("FOO"), Some(&"bar".to_string()));
        assert_eq!(rows[0].startup_commands, vec!["echo hi"]);
        assert_eq!(rows[0].workspace_tabs, vec!["terminal", "planflow"]);
        assert_eq!(rows[0].active_workspace_tab, "planflow");
    }

    #[tokio::test]
    async fn list_returns_empty_for_fresh_pool() {
        let pool = pool().await;
        let rows = list(&pool).await.expect("list");
        assert!(rows.is_empty());
    }

    #[tokio::test]
    async fn get_returns_row_by_id() {
        let pool = pool().await;
        let id = seed(&pool, "alpha", 0).await;
        let project = get(&pool, &id).await.expect("get");
        assert_eq!(project.name, "alpha");
        assert_eq!(project.position, 0);
    }

    #[tokio::test]
    async fn get_missing_id_returns_not_found() {
        let pool = pool().await;
        let err = get(&pool, "ghost").await.expect_err("missing");
        assert!(matches!(err, ProjectError::NotFound(id) if id == "ghost"));
    }

    /// Corrupt env_json should degrade to an empty map rather than fail
    /// the row — same tolerance the desktop's `src-tauri/src/db/projects.rs`
    /// applies so a single bad row never blanks the PWA sidebar.
    #[tokio::test]
    async fn list_tolerates_corrupt_env_json() {
        let pool = pool().await;
        sqlx::query(
            "INSERT INTO projects (id, name, path, env_json, position, created_at)
             VALUES (?, ?, ?, ?, ?, ?)",
        )
        .bind("corrupt")
        .bind("c")
        .bind("/tmp/c")
        .bind("{not json")
        .bind(0_i64)
        .bind(1_700_000_000_i64)
        .execute(&pool)
        .await
        .expect("seed corrupt row");
        let rows = list(&pool).await.expect("list tolerates corrupt env");
        assert_eq!(rows.len(), 1);
        assert!(rows[0].env.is_empty());
        assert_eq!(rows[0].workspace_tabs, vec!["terminal"]);
    }
}
