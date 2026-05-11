//! T11.5: Tauri commands wrapping the `project_links` query module.
//!
//! Wire shape mirrors the projects commands (T3.6): each command resolves
//! the preloaded `SqlitePool` via [`crate::db::pool`], delegates to the
//! pure query layer in [`crate::db::project_links`], and maps the resulting
//! `ProjectLinkError` onto a serde-tagged error enum the frontend can
//! branch on by `kind`.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use thiserror::Error;

use crate::db::{
    self,
    project_links::{self, NewProjectLink, ProjectLink, ProjectLinkError},
};
use crate::pty::{Recovery, UserShape};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListProjectLinksArgs {
    pub project_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetProjectLinkArgs {
    pub project_id: String,
    pub service: String,
    pub external_id: String,
    #[serde(default = "default_metadata")]
    pub metadata: serde_json::Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteProjectLinkArgs {
    pub project_id: String,
    pub service: String,
    pub external_id: String,
}

fn default_metadata() -> serde_json::Value {
    serde_json::json!({})
}

#[derive(Debug, Error, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ProjectLinkCommandError {
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

impl ProjectLinkCommandError {
    fn invalid_args(message: impl Into<String>) -> Self {
        let m = message.into();
        Self::InvalidArgs {
            ui: UserShape::new(m.clone(), Recovery::Dismiss),
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
                "Something went wrong saving the link. Try again.",
                Recovery::Retry,
            ),
        }
    }
}

impl From<ProjectLinkError> for ProjectLinkCommandError {
    fn from(error: ProjectLinkError) -> Self {
        match error {
            ProjectLinkError::EmptyProjectId => Self::invalid_args("Project id must not be empty."),
            ProjectLinkError::EmptyService => Self::invalid_args("Service must not be empty."),
            ProjectLinkError::EmptyExternalId => {
                Self::invalid_args("External id must not be empty.")
            }
            ProjectLinkError::MetadataNotObject => {
                Self::invalid_args("Link metadata must be a JSON object.")
            }
            ProjectLinkError::ProjectNotFound(id) => Self::not_found(id),
            ProjectLinkError::MetadataSerialize(e) => {
                Self::invalid_args(format!("Link metadata is not serializable: {e}"))
            }
            ProjectLinkError::Sqlx(e) => Self::internal(format!("database error: {e}")),
        }
    }
}

impl From<db::DbError> for ProjectLinkCommandError {
    fn from(error: db::DbError) -> Self {
        Self::internal(format!("database error: {error}"))
    }
}

#[tauri::command]
pub async fn project_link_list<R: Runtime>(
    app: AppHandle<R>,
    args: ListProjectLinksArgs,
) -> Result<Vec<ProjectLink>, ProjectLinkCommandError> {
    let pool = db::pool(&app).await?;
    Ok(project_links::list(&pool, &args.project_id).await?)
}

#[tauri::command]
pub async fn project_link_set<R: Runtime>(
    app: AppHandle<R>,
    args: SetProjectLinkArgs,
) -> Result<ProjectLink, ProjectLinkCommandError> {
    let pool = db::pool(&app).await?;
    let input = NewProjectLink {
        project_id: args.project_id,
        service: args.service,
        external_id: args.external_id,
        metadata: args.metadata,
    };
    Ok(project_links::set(&pool, input).await?)
}

#[tauri::command]
pub async fn project_link_delete<R: Runtime>(
    app: AppHandle<R>,
    args: DeleteProjectLinkArgs,
) -> Result<bool, ProjectLinkCommandError> {
    let pool = db::pool(&app).await?;
    Ok(project_links::delete(&pool, &args.project_id, &args.service, &args.external_id).await?)
}
