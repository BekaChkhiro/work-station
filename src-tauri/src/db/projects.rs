//! T3.6: project CRUD queries.
//! T3.8: validation rules — name 1–80 chars after trim, unique
//! case-insensitive; path exists, is a directory, is readable.
//!
//! Path canonicalization: stored paths are always the canonical absolute form
//! (resolved symlinks, no `..`, no `.`). The picker (T3.7) already returns a
//! canonical path, but `project_create`/`project_update` may receive
//! hand-typed paths from the UI; we canonicalize at the validation step so
//! `/Users/x/foo` and `/Users/x/sub/../foo` cannot both end up as separate
//! rows that point at the same directory.
//!
//! Pure async functions over `&SqlitePool` so tests can hit a fresh in-memory
//! pool without a Tauri `AppHandle`. The Tauri command layer in
//! `commands/projects.rs` wraps these and maps `ProjectError` onto the
//! Serializable error shape the UI consumes.
//!
//! Hard delete by design — soft delete is explicitly deferred to v0.2 in
//! `PROJECT_PLAN.md` T3.6.

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
    #[error("env serialization: {0}")]
    EnvSerialize(#[from] serde_json::Error),
    #[error("sqlx: {0}")]
    Sqlx(#[from] sqlx::Error),
}

/// Max name length per `PROJECT_PLAN.md` T3.8. Counted in Unicode scalar
/// values so byte-fat characters (emoji, CJK) don't get a smaller budget
/// than the user expects from the UI character count.
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

/// Case-insensitive name uniqueness check using `SQLite`'s NOCASE collation.
/// Pass `exclude_id` on update so a project can keep its own name (or change
/// only its case). NOCASE is ASCII-only — adequate for personal-use names
/// per AGENTS.md §3 ("personal-use single-developer app").
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

/// Probe the filesystem and canonicalize. The path must exist, be a directory,
/// and be readable; the returned `String` is the canonical absolute form
/// (`canonicalize` resolves symlinks and removes `..`/`.` segments, and on
/// macOS/Linux returns `ELOOP` on symlink cycles which surfaces here as
/// `PathDoesNotExist`). Readability is verified by opening a directory
/// iterator — same approach `commands/picker.rs` takes.
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

/// Return all projects, ordered by `position` then `created_at` for stability
/// when two rows share the same position.
pub async fn list(pool: &SqlitePool) -> Result<Vec<Project>, ProjectError> {
    let rows = sqlx::query(
        "SELECT id, name, path, color, icon, default_cli, env_json, position, created_at
         FROM projects
         ORDER BY position ASC, created_at ASC",
    )
    .fetch_all(pool)
    .await?;
    rows.into_iter().map(row_to_project).collect()
}

/// Insert a new project. Generates a UUID v4 id, assigns the next position
/// (max + 1, or 0 for the first row), and stamps `created_at` with the
/// current Unix epoch in seconds.
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
    let id = Uuid::new_v4().to_string();
    let created_at = epoch_seconds();

    // Position lookup + insert in one transaction so two concurrent creates
    // can't collide on the same `MAX(position) + 1`.
    let mut tx = pool.begin().await?;
    let max_position: Option<i64> = sqlx::query_scalar("SELECT MAX(position) FROM projects")
        .fetch_one(&mut *tx)
        .await?;
    let position = max_position.map_or(0, |p| p + 1);

    sqlx::query(
        "INSERT INTO projects (id, name, path, color, icon, default_cli, env_json, position, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(&id)
    .bind(&name)
    .bind(&path)
    .bind(input.color.as_deref())
    .bind(input.icon.as_deref())
    .bind(input.default_cli.as_deref())
    .bind(&env_json)
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
        position,
        created_at,
    })
}

/// Update the editable fields on an existing project. `position` and
/// `created_at` are not editable here (reordering lands in a separate
/// command planned for the sidebar drag work).
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

    let result = sqlx::query(
        "UPDATE projects
         SET name = ?, path = ?, color = ?, icon = ?, default_cli = ?, env_json = ?
         WHERE id = ?",
    )
    .bind(&name)
    .bind(&path)
    .bind(input.color.as_deref())
    .bind(input.icon.as_deref())
    .bind(input.default_cli.as_deref())
    .bind(&env_json)
    .bind(&input.id)
    .execute(pool)
    .await?;

    if result.rows_affected() == 0 {
        return Err(ProjectError::NotFound(input.id));
    }

    fetch_one(pool, &input.id).await
}

/// Hard-delete a project. Sessions cascade via the FK on
/// `sessions.project_id` (see `migrations/0002_sessions.sql`).
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

async fn fetch_one(pool: &SqlitePool, id: &str) -> Result<Project, ProjectError> {
    let row = sqlx::query(
        "SELECT id, name, path, color, icon, default_cli, env_json, position, created_at
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
    // Corrupt env_json shouldn't crash the list command. Mirror the layout_json
    // tolerance from T3.3: parse failure → empty map.
    let env: HashMap<String, String> = serde_json::from_str(&env_json).unwrap_or_default();
    Ok(Project {
        id: row.try_get("id")?,
        name: row.try_get("name")?,
        path: row.try_get("path")?,
        color: row.try_get("color")?,
        icon: row.try_get("icon")?,
        default_cli: row.try_get("default_cli")?,
        env,
        position: row.try_get("position")?,
        created_at: row.try_get("created_at")?,
    })
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

    async fn migrated_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        pool.execute("PRAGMA foreign_keys = ON;")
            .await
            .expect("enable fk");
        pool.execute(include_str!("../../migrations/0001_projects.sql"))
            .await
            .expect("apply 0001");
        pool.execute(include_str!("../../migrations/0002_sessions.sql"))
            .await
            .expect("apply 0002");
        pool
    }

    /// Each test gets a fresh real directory under the OS temp root — T3.8
    /// requires the path to exist, be a directory, and be readable.
    /// Returned in canonical form (matches what `validate_path_fs` stores)
    /// so equality assertions don't tip over symlink-heavy temp roots like
    /// macOS's `/var/folders → /private/var/folders`.
    fn make_dir() -> String {
        let id = Uuid::new_v4();
        let p = std::env::temp_dir().join(format!("ws-test-{id}"));
        std::fs::create_dir_all(&p).expect("create test dir");
        std::fs::canonicalize(&p)
            .expect("canonicalize test dir")
            .to_string_lossy()
            .into_owned()
    }

    fn sample(name: &str, path: &str) -> NewProject {
        NewProject {
            name: name.to_string(),
            path: path.to_string(),
            color: Some("#fa0".to_string()),
            icon: Some("rocket".to_string()),
            default_cli: Some("zsh".to_string()),
            env: HashMap::from([("FOO".to_string(), "bar".to_string())]),
        }
    }

    #[tokio::test]
    async fn create_assigns_uuid_position_and_round_trips() {
        let pool = migrated_pool().await;
        let dir = make_dir();
        let project = create(&pool, sample("alpha", &dir)).await.expect("create");

        assert!(Uuid::parse_str(&project.id).is_ok(), "id should be a uuid");
        assert_eq!(project.name, "alpha");
        assert_eq!(project.path, dir);
        assert_eq!(project.position, 0);
        assert_eq!(project.env.get("FOO"), Some(&"bar".to_string()));

        let listed = list(&pool).await.expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, project.id);
    }

    #[tokio::test]
    async fn create_assigns_increasing_position() {
        let pool = migrated_pool().await;
        let a = create(&pool, sample("a", &make_dir())).await.expect("a");
        let b = create(&pool, sample("b", &make_dir())).await.expect("b");
        let c = create(&pool, sample("c", &make_dir())).await.expect("c");
        assert_eq!(a.position, 0);
        assert_eq!(b.position, 1);
        assert_eq!(c.position, 2);
    }

    #[tokio::test]
    async fn create_trims_and_rejects_empty_name_or_path() {
        let pool = migrated_pool().await;
        let dir = make_dir();
        let padded = format!("  {dir}  ");

        let trimmed = create(
            &pool,
            NewProject {
                name: "  spaced  ".to_string(),
                path: padded,
                color: None,
                icon: None,
                default_cli: None,
                env: HashMap::new(),
            },
        )
        .await
        .expect("create trimmed");
        assert_eq!(trimmed.name, "spaced");
        assert_eq!(trimmed.path, dir);

        let empty_name = create(&pool, sample("   ", &make_dir())).await;
        assert!(matches!(empty_name, Err(ProjectError::EmptyName)));
        let empty_path = create(&pool, sample("ok", "")).await;
        assert!(matches!(empty_path, Err(ProjectError::EmptyPath)));
    }

    #[tokio::test]
    async fn create_rejects_name_over_80_chars() {
        let pool = migrated_pool().await;
        let dir = make_dir();
        let long = "x".repeat(NAME_MAX_CHARS + 1);

        let err = create(&pool, sample(&long, &dir))
            .await
            .expect_err("too long");
        assert!(matches!(err, ProjectError::NameTooLong(n) if n == NAME_MAX_CHARS + 1));

        // Boundary: exactly NAME_MAX_CHARS is allowed.
        let exact = "y".repeat(NAME_MAX_CHARS);
        create(&pool, sample(&exact, &make_dir()))
            .await
            .expect("max-length name accepted");
    }

    #[tokio::test]
    async fn create_rejects_duplicate_name_case_insensitive() {
        let pool = migrated_pool().await;
        create(&pool, sample("Foo", &make_dir()))
            .await
            .expect("first");

        let err = create(&pool, sample("foo", &make_dir()))
            .await
            .expect_err("dup");
        assert!(matches!(err, ProjectError::NameAlreadyExists(ref n) if n == "foo"));

        // Trim is applied before uniqueness — "  FOO  " also collides.
        let err2 = create(&pool, sample("  FOO  ", &make_dir()))
            .await
            .expect_err("dup trimmed");
        assert!(matches!(err2, ProjectError::NameAlreadyExists(_)));
    }

    #[tokio::test]
    async fn create_rejects_missing_or_non_directory_path() {
        let pool = migrated_pool().await;

        let missing = create(
            &pool,
            sample("a", "/definitely/not/a/real/path/ws-test-missing"),
        )
        .await
        .expect_err("missing");
        assert!(matches!(missing, ProjectError::PathDoesNotExist));

        // A regular file is not a directory.
        let dir = make_dir();
        let file_path = std::path::Path::new(&dir).join("file.txt");
        std::fs::write(&file_path, b"hi").expect("write file");
        let not_dir = create(&pool, sample("b", &file_path.to_string_lossy()))
            .await
            .expect_err("not a dir");
        assert!(matches!(not_dir, ProjectError::PathNotDirectory));
    }

    #[tokio::test]
    async fn update_changes_fields_and_returns_fresh_row() {
        let pool = migrated_pool().await;
        let orig_dir = make_dir();
        let renamed_dir = make_dir();
        let created = create(&pool, sample("orig", &orig_dir)).await.expect("c");

        let updated = update(
            &pool,
            ProjectUpdate {
                id: created.id.clone(),
                name: "renamed".to_string(),
                path: renamed_dir.clone(),
                color: None,
                icon: Some("flame".to_string()),
                default_cli: None,
                env: HashMap::from([("BAZ".to_string(), "qux".to_string())]),
            },
        )
        .await
        .expect("update");

        assert_eq!(updated.id, created.id);
        assert_eq!(updated.name, "renamed");
        assert_eq!(updated.path, renamed_dir);
        assert_eq!(updated.color, None);
        assert_eq!(updated.icon.as_deref(), Some("flame"));
        assert_eq!(updated.env.get("BAZ"), Some(&"qux".to_string()));
        assert!(!updated.env.contains_key("FOO"));
        assert_eq!(updated.position, created.position);
        assert_eq!(updated.created_at, created.created_at);
    }

    #[tokio::test]
    async fn update_keeps_own_name_but_rejects_other_duplicate() {
        let pool = migrated_pool().await;
        let a = create(&pool, sample("Alpha", &make_dir()))
            .await
            .expect("a");
        let b = create(&pool, sample("Beta", &make_dir())).await.expect("b");

        // Re-saving with the same name (and case-only changes) is fine.
        let same = update(
            &pool,
            ProjectUpdate {
                id: a.id.clone(),
                name: "alpha".to_string(),
                path: a.path.clone(),
                color: a.color.clone(),
                icon: a.icon.clone(),
                default_cli: a.default_cli.clone(),
                env: a.env.clone(),
            },
        )
        .await
        .expect("same-name update");
        assert_eq!(same.name, "alpha");

        // But b can't take a's name.
        let err = update(
            &pool,
            ProjectUpdate {
                id: b.id,
                name: "ALPHA".to_string(),
                path: b.path,
                color: None,
                icon: None,
                default_cli: None,
                env: HashMap::new(),
            },
        )
        .await
        .expect_err("collision");
        assert!(matches!(err, ProjectError::NameAlreadyExists(_)));
    }

    #[tokio::test]
    async fn update_missing_id_returns_not_found() {
        let pool = migrated_pool().await;
        let err = update(
            &pool,
            ProjectUpdate {
                id: "ghost".to_string(),
                name: "x".to_string(),
                path: make_dir(),
                color: None,
                icon: None,
                default_cli: None,
                env: HashMap::new(),
            },
        )
        .await
        .expect_err("missing id");
        assert!(matches!(err, ProjectError::NotFound(id) if id == "ghost"));
    }

    #[tokio::test]
    async fn delete_removes_row_and_cascades_sessions() {
        let pool = migrated_pool().await;
        let created = create(&pool, sample("p", &make_dir())).await.expect("c");

        sqlx::query(
            "INSERT INTO sessions (id, project_id, title, layout_json, created_at)
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind("s1")
        .bind(&created.id)
        .bind("main")
        .bind("{}")
        .bind(1_700_000_000_i64)
        .execute(&pool)
        .await
        .expect("seed session");

        delete(&pool, &created.id).await.expect("delete");
        assert!(list(&pool).await.expect("list").is_empty());

        let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sessions")
            .fetch_one(&pool)
            .await
            .expect("count sessions");
        assert_eq!(remaining, 0, "sessions should cascade-delete");
    }

    #[tokio::test]
    async fn delete_missing_id_returns_not_found() {
        let pool = migrated_pool().await;
        let err = delete(&pool, "ghost").await.expect_err("missing");
        assert!(matches!(err, ProjectError::NotFound(id) if id == "ghost"));
    }

    /// Parameterization smoke test: a name containing classic SQL injection
    /// punctuation must be stored verbatim, not interpreted.
    #[tokio::test]
    async fn create_is_sql_injection_safe() {
        let pool = migrated_pool().await;
        let nasty = "'); DROP TABLE projects; --";
        let project = create(&pool, sample(nasty, &make_dir())).await.expect("c");
        assert_eq!(project.name, nasty);

        // Table still exists and the row round-trips.
        let listed = list(&pool).await.expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, nasty);
    }

    /// Path canonicalization: a hand-typed path with `..` segments must be
    /// stored in resolved form so two semantically-identical paths cannot
    /// land as separate rows pointing at the same directory.
    #[tokio::test]
    async fn create_canonicalizes_path_with_dot_dot_segments() {
        let pool = migrated_pool().await;
        let dir = make_dir(); // already canonical
        let parent = std::path::Path::new(&dir)
            .parent()
            .expect("temp dir has a parent");
        let leaf = std::path::Path::new(&dir)
            .file_name()
            .expect("temp dir has a name");

        // Build an indirect form: <parent>/<leaf>/./../<leaf>
        // canonicalize collapses this back to <dir>.
        let indirect = parent.join(leaf).join(".").join("..").join(leaf);
        let project = create(&pool, sample("indirect", &indirect.to_string_lossy()))
            .await
            .expect("create with indirect path");
        assert_eq!(project.path, dir, "stored path must be canonical");
    }

    /// Path canonicalization defends against "different strings, same
    /// directory" rows: a canonical path and an indirect form pointing at
    /// the same directory must not coexist as distinct projects with
    /// different `path` values.
    #[tokio::test]
    async fn create_then_indirect_path_resolves_to_same_stored_path() {
        let pool = migrated_pool().await;
        let dir = make_dir();
        let a = create(&pool, sample("a", &dir)).await.expect("a");

        let indirect = format!("{dir}/.");
        let b = create(&pool, sample("b", &indirect)).await.expect("b");
        assert_eq!(
            a.path, b.path,
            "both rows resolve to the same canonical path"
        );
    }

    #[tokio::test]
    async fn list_tolerates_corrupt_env_json() {
        let pool = migrated_pool().await;
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

        let listed = list(&pool).await.expect("list tolerates corrupt env");
        assert_eq!(listed.len(), 1);
        assert!(listed[0].env.is_empty());
    }
}
