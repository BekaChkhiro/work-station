use serde::{Deserialize, Serialize};
use sqlx::FromRow;

/// A project as stored in the database.
#[derive(Debug, FromRow)]
pub struct Project {
    pub id: i64,
    pub name: String,
    pub path: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub default_cli: Option<String>,
    pub env_json: Option<String>,
    pub position: i32,
    pub created_at: String,
}

/// Serializable project response for the frontend.
#[derive(Debug, Serialize)]
pub struct ProjectResponse {
    pub id: String,
    pub name: String,
    pub path: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub default_cli: Option<String>,
    pub env_json: Option<String>,
    pub position: i32,
    pub created_at: String,
}

impl From<Project> for ProjectResponse {
    fn from(p: Project) -> Self {
        Self {
            id: p.id.to_string(),
            name: p.name,
            path: p.path,
            color: p.color,
            icon: p.icon,
            default_cli: p.default_cli,
            env_json: p.env_json,
            position: p.position,
            created_at: p.created_at,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct CreateProjectInput {
    pub name: String,
    pub path: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub env_json: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProjectInput {
    pub name: Option<String>,
    pub path: Option<String>,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub default_cli: Option<String>,
    pub env_json: Option<String>,
    pub position: Option<i32>,
}

fn validate_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Project name is required".to_string());
    }
    if trimmed.len() > 80 {
        return Err("Project name must be 80 characters or fewer".to_string());
    }
    Ok(())
}

async fn validate_path(path: &str) -> Result<(), String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Project path is required".to_string());
    }
    match tokio::fs::metadata(trimmed).await {
        Ok(meta) if meta.is_dir() => Ok(()),
        Ok(_) => Err("Project path must be a directory".to_string()),
        Err(_) => Err("Project path does not exist".to_string()),
    }
}

/// List all projects ordered by position, then creation time.
pub async fn list_projects(pool: &sqlx::Pool<sqlx::Sqlite>) -> Result<Vec<ProjectResponse>, String> {
    let projects: Vec<Project> = sqlx::query_as::<_, Project>(
        "SELECT id, name, path, color, icon, default_cli, env_json, position, created_at
         FROM projects
         ORDER BY position ASC, created_at ASC",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(projects.into_iter().map(Into::into).collect())
}

/// Create a new project.
pub async fn create_project(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    input: CreateProjectInput,
) -> Result<ProjectResponse, String> {
    let name = input.name.trim().to_string();
    let path = input.path.trim().to_string();

    validate_name(&name)?;
    validate_path(&path).await?;

    let existing: Option<(i64,)> = sqlx::query_as("SELECT id FROM projects WHERE name = ?")
        .bind(&name)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;

    if existing.is_some() {
        return Err("A project with this name already exists".to_string());
    }

    let result = sqlx::query(
        "INSERT INTO projects (name, path, color, icon, env_json, position)
         VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM projects))",
    )
    .bind(&name)
    .bind(&path)
    .bind(&input.color)
    .bind(&input.icon)
    .bind(&input.env_json)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    let id = result.last_insert_rowid();

    let project: Project = sqlx::query_as(
        "SELECT id, name, path, color, icon, default_cli, env_json, position, created_at
         FROM projects WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(project.into())
}

/// Update an existing project.
pub async fn update_project(
    pool: &sqlx::Pool<sqlx::Sqlite>,
    id: i64,
    input: UpdateProjectInput,
) -> Result<ProjectResponse, String> {
    let existing: Option<Project> = sqlx::query_as(
        "SELECT id, name, path, color, icon, default_cli, env_json, position, created_at
         FROM projects WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    let existing = existing.ok_or("Project not found")?;

    let name = input.name.as_ref().map(|n| n.trim().to_string());
    let path = input.path.as_ref().map(|p| p.trim().to_string());

    let name_for_validation = name.as_ref().unwrap_or(&existing.name);
    validate_name(name_for_validation)?;

    if let Some(ref new_name) = name {
        if new_name != &existing.name {
            let duplicate: Option<(i64,)> =
                sqlx::query_as("SELECT id FROM projects WHERE name = ? AND id != ?")
                    .bind(new_name)
                    .bind(id)
                    .fetch_optional(pool)
                    .await
                    .map_err(|e| e.to_string())?;

            if duplicate.is_some() {
                return Err("A project with this name already exists".to_string());
            }
        }
    }

    if let Some(ref new_path) = path {
        validate_path(new_path).await?;
    }

    let name = name.unwrap_or(existing.name);
    let path = path.unwrap_or(existing.path);
    let color = input.color.or(existing.color);
    let icon = input.icon.or(existing.icon);
    let default_cli = input.default_cli.or(existing.default_cli);
    let env_json = input.env_json.or(existing.env_json);
    let position = input.position.unwrap_or(existing.position);

    sqlx::query(
        "UPDATE projects
         SET name = ?, path = ?, color = ?, icon = ?, default_cli = ?, env_json = ?, position = ?
         WHERE id = ?",
    )
    .bind(&name)
    .bind(&path)
    .bind(&color)
    .bind(&icon)
    .bind(&default_cli)
    .bind(&env_json)
    .bind(position)
    .bind(id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    let project: Project = sqlx::query_as(
        "SELECT id, name, path, color, icon, default_cli, env_json, position, created_at
         FROM projects WHERE id = ?",
    )
    .bind(id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(project.into())
}

/// Delete a project by ID.
pub async fn delete_project(pool: &sqlx::Pool<sqlx::Sqlite>, id: i64) -> Result<(), String> {
    let result = sqlx::query("DELETE FROM projects WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    if result.rows_affected() == 0 {
        return Err("Project not found".to_string());
    }

    Ok(())
}
