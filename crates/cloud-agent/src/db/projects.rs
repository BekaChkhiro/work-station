// T19.25 prose mentions `SQLite`, `PWA` etc. in passing — allow the
// doc-markdown lint at the module level, matching the desktop bridge.
#![allow(clippy::doc_markdown)]

//! Cloud-agent project read + write paths.
//!
//! Mirrors `src-tauri/src/db/projects.rs` field-by-field so the
//! cloud-agent's SQLite row shape is byte-compatible with the
//! desktop's. Same camelCase wire serialization (PWA schemas reuse the
//! desktop's), same tolerance for corrupt JSON columns (a bad
//! `env_json` / `startup_commands_json` / `workspace_tabs_json` degrades
//! to a default rather than failing the whole list), and the same
//! validation rules on the write paths: name 1–80 chars after trim,
//! case-insensitive unique; path exists, is a directory, is readable.
//!
//! Path canonicalization runs against the **cloud-agent's** filesystem,
//! not the desktop's — that's the only point where the two bridges
//! diverge. A project's `path` on the cloud-agent must point at a
//! directory the agent process can stat + read; the picker that fed
//! it lives on a different machine, so the only safety net is
//! validate-on-save here.

use std::collections::HashMap;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use sqlx::sqlite::{SqlitePool, SqliteRow};
use sqlx::Row;
use uuid::Uuid;

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

#[derive(Debug, Clone)]
pub struct NewProject {
    pub name: String,
    pub path: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub default_cli: Option<String>,
    pub env: HashMap<String, String>,
    pub startup_commands: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct ProjectUpdate {
    pub id: String,
    pub name: String,
    pub path: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub default_cli: Option<String>,
    pub env: HashMap<String, String>,
    pub startup_commands: Vec<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum ProjectError {
    #[error("project name must not be empty")]
    EmptyName,
    #[error("project name must be at most {NAME_MAX_CHARS} characters (was {0})")]
    NameTooLong(usize),
    #[error("project name already exists: {0}")]
    NameAlreadyExists(String),
    #[error("project path must not be empty")]
    EmptyPath,
    #[error("project path does not exist")]
    PathDoesNotExist,
    #[error("project path is not a directory")]
    PathNotDirectory,
    #[error("project path is not readable")]
    PathNotReadable,
    #[error("project not found: {0}")]
    NotFound(String),
    #[error(
        "reorder list must contain every project exactly once (expected {expected}, got {got})"
    )]
    ReorderMismatch { expected: usize, got: usize },
    #[error("reorder list contains a duplicate id: {0}")]
    ReorderDuplicate(String),
    #[error("env serialization: {0}")]
    EnvSerialize(#[from] serde_json::Error),
    #[error("sqlx: {0}")]
    Sqlx(#[from] sqlx::Error),
}

/// Max name length, matching the desktop's `NAME_MAX_CHARS`.
pub const NAME_MAX_CHARS: usize = 80;

fn validate_name_length(name: &str) -> Result<(), ProjectError> {
    if name.is_empty() {
        return Err(ProjectError::EmptyName);
    }
    let chars = name.chars().count();
    if chars > NAME_MAX_CHARS {
        return Err(ProjectError::NameTooLong(chars));
    }
    Ok(())
}

async fn ensure_unique_name(
    pool: &SqlitePool,
    name: &str,
    exclude_id: Option<&str>,
) -> Result<(), ProjectError> {
    let exclude = exclude_id.unwrap_or("");
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM projects WHERE name = ? COLLATE NOCASE AND id != ?",
    )
    .bind(name)
    .bind(exclude)
    .fetch_one(pool)
    .await?;
    if count > 0 {
        return Err(ProjectError::NameAlreadyExists(name.to_string()));
    }
    Ok(())
}

/// Probe the cloud-agent's filesystem and canonicalize. Same shape as
/// the desktop helper — required so a `cwd does not exist` error never
/// reaches the PTY spawn path. The path the user typed on the desktop
/// has no meaning here; the cloud-agent's process needs a path that
/// resolves on its own host.
async fn validate_path_fs(path: &str) -> Result<String, ProjectError> {
    let path = path.to_string();
    tokio::task::spawn_blocking(move || {
        let p = std::path::Path::new(&path);
        let canonical = std::fs::canonicalize(p).map_err(|_| ProjectError::PathDoesNotExist)?;
        let meta = std::fs::metadata(&canonical).map_err(|_| ProjectError::PathDoesNotExist)?;
        if !meta.is_dir() {
            return Err(ProjectError::PathNotDirectory);
        }
        std::fs::read_dir(&canonical).map_err(|_| ProjectError::PathNotReadable)?;
        Ok(canonical.to_string_lossy().into_owned())
    })
    .await
    .expect("validate_path_fs blocking task panicked")
}

fn epoch_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_secs()).ok())
        .unwrap_or(0)
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
    fetch_one(pool, id).await
}

/// Insert a new project. Generates a UUID v4 id, assigns the next
/// position (max + 1, or 0 for the first row), and stamps `created_at`
/// with the current Unix epoch in seconds. Path canonicalization runs
/// against the cloud-agent's filesystem (see `validate_path_fs`).
pub async fn create(pool: &SqlitePool, input: NewProject) -> Result<Project, ProjectError> {
    let name = input.name.trim().to_string();
    let path_input = input.path.trim().to_string();
    validate_name_length(&name)?;
    if path_input.is_empty() {
        return Err(ProjectError::EmptyPath);
    }
    let path = validate_path_fs(&path_input).await?;
    ensure_unique_name(pool, &name, None).await?;

    let env_json = serde_json::to_string(&input.env)?;
    let startup_commands_json = serde_json::to_string(&input.startup_commands)?;
    let id = Uuid::new_v4().to_string();
    let created_at = epoch_seconds();

    let mut tx = pool.begin().await?;
    let max_position: Option<i64> = sqlx::query_scalar("SELECT MAX(position) FROM projects")
        .fetch_one(&mut *tx)
        .await?;
    let position = max_position.map_or(0, |p| p + 1);

    sqlx::query(
        "INSERT INTO projects (id, name, path, color, icon, default_cli, env_json,
                startup_commands_json, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&name)
    .bind(&path)
    .bind(input.color.as_deref())
    .bind(input.icon.as_deref())
    .bind(input.default_cli.as_deref())
    .bind(&env_json)
    .bind(&startup_commands_json)
    .bind(position)
    .bind(created_at)
    .execute(&mut *tx)
    .await?;

    tx.commit().await?;

    Ok(Project {
        id,
        name,
        path,
        color: input.color,
        icon: input.icon,
        default_cli: input.default_cli,
        env: input.env,
        startup_commands: input.startup_commands,
        workspace_tabs: vec!["terminal".to_string()],
        active_workspace_tab: "terminal".to_string(),
        position,
        created_at,
    })
}

/// Update editable fields on an existing project. `position` and
/// `created_at` are not editable here.
pub async fn update(pool: &SqlitePool, input: ProjectUpdate) -> Result<Project, ProjectError> {
    let name = input.name.trim().to_string();
    let path_input = input.path.trim().to_string();
    validate_name_length(&name)?;
    if path_input.is_empty() {
        return Err(ProjectError::EmptyPath);
    }
    let path = validate_path_fs(&path_input).await?;
    ensure_unique_name(pool, &name, Some(&input.id)).await?;

    let env_json = serde_json::to_string(&input.env)?;
    let startup_commands_json = serde_json::to_string(&input.startup_commands)?;

    let result = sqlx::query(
        "UPDATE projects
         SET name = ?, path = ?, color = ?, icon = ?, default_cli = ?, env_json = ?, startup_commands_json = ?
         WHERE id = ?",
    )
    .bind(&name)
    .bind(&path)
    .bind(input.color.as_deref())
    .bind(input.icon.as_deref())
    .bind(input.default_cli.as_deref())
    .bind(&env_json)
    .bind(&startup_commands_json)
    .bind(&input.id)
    .execute(pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(ProjectError::NotFound(input.id));
    }

    fetch_one(pool, &input.id).await
}

/// Hard-delete a project. Sessions cascade via the FK on
/// `sessions.project_id` (mirrors the desktop migration).
pub async fn delete(pool: &SqlitePool, id: &str) -> Result<(), ProjectError> {
    let result = sqlx::query("DELETE FROM projects WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    if result.rows_affected() == 0 {
        return Err(ProjectError::NotFound(id.to_string()));
    }
    Ok(())
}

/// Persist a new sidebar ordering atomically. `ids` must be a
/// permutation of every row id — see desktop's `db::projects::reorder`
/// for the rationale.
pub async fn reorder(pool: &SqlitePool, ids: &[String]) -> Result<(), ProjectError> {
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for id in ids {
        if !seen.insert(id.as_str()) {
            return Err(ProjectError::ReorderDuplicate(id.clone()));
        }
    }

    let mut tx = pool.begin().await?;
    let total: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM projects")
        .fetch_one(&mut *tx)
        .await?;
    debug_assert!(total >= 0, "COUNT(*) returned a negative value: {total}");
    let total_usize = usize::try_from(total).map_err(|_| ProjectError::ReorderMismatch {
        expected: 0,
        got: ids.len(),
    })?;
    if total_usize != ids.len() {
        return Err(ProjectError::ReorderMismatch {
            expected: total_usize,
            got: ids.len(),
        });
    }

    for (idx, id) in ids.iter().enumerate() {
        let position = i64::try_from(idx).map_err(|_| ProjectError::ReorderMismatch {
            expected: total_usize,
            got: ids.len(),
        })?;
        let result = sqlx::query("UPDATE projects SET position = ? WHERE id = ?")
            .bind(position)
            .bind(id)
            .execute(&mut *tx)
            .await?;
        if result.rows_affected() == 0 {
            return Err(ProjectError::NotFound(id.clone()));
        }
    }

    tx.commit().await?;
    Ok(())
}

/// Persist a project's workspace tab state (visible-tab list +
/// currently-active tab).
pub async fn update_workspace_tabs(
    pool: &SqlitePool,
    id: &str,
    visible: &[String],
    active: &str,
) -> Result<(), ProjectError> {
    let tabs_json = serde_json::to_string(visible)?;
    let result = sqlx::query(
        "UPDATE projects SET workspace_tabs_json = ?, active_workspace_tab = ? WHERE id = ?",
    )
    .bind(&tabs_json)
    .bind(active)
    .bind(id)
    .execute(pool)
    .await?;
    if result.rows_affected() == 0 {
        return Err(ProjectError::NotFound(id.to_string()));
    }
    Ok(())
}

async fn fetch_one(pool: &SqlitePool, id: &str) -> Result<Project, ProjectError> {
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
