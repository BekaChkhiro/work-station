//! T3.6: project CRUD commands (`project_list`, `project_create`,
//! `project_update`, `project_delete`).
//!
//! Each command resolves the preloaded `SqlitePool` via [`crate::db::pool`],
//! delegates to the pure query layer in [`crate::db::projects`], and maps the
//! resulting `ProjectError` onto a serde-tagged enum so the frontend can
//! branch on `kind` rather than parse free-form strings — same shape used by
//! the PTY commands (T2.15).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use thiserror::Error;

use crate::db::{
    self,
    projects::{self, NewProject, Project, ProjectError, ProjectUpdate},
};
use crate::pty::{Recovery, UserShape};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProjectArgs {
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub default_cli: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub startup_commands: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProjectArgs {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub default_cli: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub startup_commands: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProjectArgs {
    pub id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderProjectsArgs {
    pub ids: Vec<String>,
}

#[derive(Debug, Error, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProjectCommandError {
    #[error("{message}")]
    InvalidArgs {
        message: String,
        #[serde(flatten)]
        ui: UserShape,
    },
    #[error("{message}")]
    NotFound {
        id: String,
        message: String,
        #[serde(flatten)]
        ui: UserShape,
    },
    #[error("{message}")]
    Internal {
        message: String,
        #[serde(flatten)]
        ui: UserShape,
    },
}

impl ProjectCommandError {
    fn invalid_args(message: impl Into<String>) -> Self {
        let m = message.into();
        Self::InvalidArgs {
            ui: UserShape::new(m.clone(), Recovery::EditProject),
            message: m,
        }
    }

    fn not_found(id: impl Into<String>) -> Self {
        let id = id.into();
        Self::NotFound {
            message: format!("project not found: {id}"),
            ui: UserShape::new(
                "This project no longer exists. Refresh the project list.",
                Recovery::Dismiss,
            ),
            id,
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::Internal {
            message: message.into(),
            ui: UserShape::new(
                "Something went wrong saving your project. Try again.",
                Recovery::Retry,
            ),
        }
    }
}

impl From<ProjectError> for ProjectCommandError {
    fn from(error: ProjectError) -> Self {
        match error {
            ProjectError::EmptyName => Self::invalid_args("Project name must not be empty."),
            ProjectError::NameTooLong(n) => Self::invalid_args(format!(
                "Project name must be at most {max} characters (was {n}).",
                max = projects::NAME_MAX_CHARS,
            )),
            ProjectError::NameAlreadyExists(name) => {
                Self::invalid_args(format!("A project named \"{name}\" already exists."))
            }
            ProjectError::EmptyPath => Self::invalid_args("Project path must not be empty."),
            ProjectError::PathDoesNotExist => Self::invalid_args("Project path does not exist."),
            ProjectError::PathNotDirectory => {
                Self::invalid_args("Project path must be a directory.")
            }
            ProjectError::PathNotReadable => Self::invalid_args("Project path is not readable."),
            ProjectError::NotFound(id) => Self::not_found(id),
            ProjectError::ReorderMismatch { expected, got } => Self::invalid_args(format!(
                "Reorder list size mismatch (expected {expected}, got {got}). Refresh and try again."
            )),
            ProjectError::ReorderDuplicate(id) => {
                Self::invalid_args(format!("Reorder list contains a duplicate id: {id}"))
            }
            ProjectError::EnvSerialize(e) => {
                Self::invalid_args(format!("Project environment is not serializable: {e}"))
            }
            ProjectError::Sqlx(e) => Self::internal(format!("database error: {e}")),
        }
    }
}

impl From<db::DbError> for ProjectCommandError {
    fn from(error: db::DbError) -> Self {
        Self::internal(format!("database error: {error}"))
    }
}

#[tauri::command]
pub async fn project_list<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Vec<Project>, ProjectCommandError> {
    let pool = db::pool(&app).await?;
    Ok(projects::list(&pool).await?)
}

#[tauri::command]
pub async fn project_create<R: Runtime>(
    app: AppHandle<R>,
    args: CreateProjectArgs,
) -> Result<Project, ProjectCommandError> {
    let pool = db::pool(&app).await?;
    let input = NewProject {
        name: args.name,
        path: args.path,
        color: args.color,
        icon: args.icon,
        default_cli: args.default_cli,
        env: args.env,
        startup_commands: args.startup_commands,
    };
    Ok(projects::create(&pool, input).await?)
}

#[tauri::command]
pub async fn project_update<R: Runtime>(
    app: AppHandle<R>,
    args: UpdateProjectArgs,
) -> Result<Project, ProjectCommandError> {
    let pool = db::pool(&app).await?;
    let input = ProjectUpdate {
        id: args.id,
        name: args.name,
        path: args.path,
        color: args.color,
        icon: args.icon,
        default_cli: args.default_cli,
        env: args.env,
        startup_commands: args.startup_commands,
    };
    Ok(projects::update(&pool, input).await?)
}

#[tauri::command]
pub async fn project_delete<R: Runtime>(
    app: AppHandle<R>,
    args: DeleteProjectArgs,
) -> Result<(), ProjectCommandError> {
    let pool = db::pool(&app).await?;
    projects::delete(&pool, &args.id).await?;
    Ok(())
}

#[tauri::command]
pub async fn project_reorder<R: Runtime>(
    app: AppHandle<R>,
    args: ReorderProjectsArgs,
) -> Result<(), ProjectCommandError> {
    let pool = db::pool(&app).await?;
    projects::reorder(&pool, &args.ids).await?;
    Ok(())
}
