use tauri::State;
use tauri_plugin_sql::DbInstances;

use crate::db::project::{
    create_project, delete_project, list_projects, update_project, CreateProjectInput,
    ProjectResponse, UpdateProjectInput,
};

async fn get_db_pool(db: &DbInstances) -> Result<sqlx::Pool<sqlx::Sqlite>, String> {
    let pools = db.0.read().await;
    let pool = pools
        .get("sqlite:workstation.db")
        .ok_or("Database not initialized")?;

    match pool {
        tauri_plugin_sql::DbPool::Sqlite(sqlite_pool) => Ok(sqlite_pool.clone()),
        #[allow(unreachable_patterns)]
        _ => Err("Expected SQLite database".to_string()),
    }
}

/// List all projects ordered by position, then creation time.
#[tauri::command]
pub async fn project_list(db: State<'_, DbInstances>) -> Result<Vec<ProjectResponse>, String> {
    let pool = get_db_pool(&db).await?;
    list_projects(&pool).await
}

/// Create a new project.
#[tauri::command]
pub async fn project_create(
    input: CreateProjectInput,
    db: State<'_, DbInstances>,
) -> Result<ProjectResponse, String> {
    let pool = get_db_pool(&db).await?;
    create_project(&pool, input).await
}

/// Update an existing project.
#[tauri::command]
pub async fn project_update(
    id: String,
    input: UpdateProjectInput,
    db: State<'_, DbInstances>,
) -> Result<ProjectResponse, String> {
    let id = id.parse::<i64>().map_err(|_| "Invalid project ID")?;
    let pool = get_db_pool(&db).await?;
    update_project(&pool, id, input).await
}

/// Delete a project by ID.
#[tauri::command]
pub async fn project_delete(
    id: String,
    db: State<'_, DbInstances>,
) -> Result<(), String> {
    let id = id.parse::<i64>().map_err(|_| "Invalid project ID")?;
    let pool = get_db_pool(&db).await?;
    delete_project(&pool, id).await
}
