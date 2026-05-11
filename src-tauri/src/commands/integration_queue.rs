//! T11.9: Tauri commands wrapping the `integration_write_queue` query module.
//!
//! Wire shape mirrors the project_links commands: each command resolves
//! the preloaded `SqlitePool` via [`crate::db::pool`], delegates to the pure
//! query layer in [`crate::db::integration_write_queue`], and maps
//! `QueueError` onto a serde-tagged error enum the frontend can branch on by
//! `kind`.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime};
use thiserror::Error;

use crate::db::{
    self,
    integration_write_queue::{self, NewQueueEntry, QueueEntry, QueueError},
};
use crate::pty::{Recovery, UserShape};

// ---------------------------------------------------------------------------
// Argument structs
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueArgs {
    pub service: String,
    pub method: String,
    pub url: String,
    #[serde(default = "default_headers")]
    pub headers: serde_json::Value,
    pub body_base64: Option<String>,
    pub enqueued_at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListArgs {
    pub service: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DequeueArgs {
    pub id: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkFailedArgs {
    pub id: i64,
    pub error: String,
    pub at: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearServiceArgs {
    pub service: String,
}

fn default_headers() -> serde_json::Value {
    serde_json::json!({})
}

// ---------------------------------------------------------------------------
// Enqueue return type
// ---------------------------------------------------------------------------

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnqueueResult {
    pub id: i64,
    pub evicted: bool,
}

// ---------------------------------------------------------------------------
// Command-layer error
// ---------------------------------------------------------------------------

#[derive(Debug, Error, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum QueueCommandError {
    #[error("{message}")]
    InvalidArgs {
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

impl QueueCommandError {
    fn invalid_args(message: impl Into<String>) -> Self {
        let m = message.into();
        Self::InvalidArgs {
            ui: UserShape::new(m.clone(), Recovery::Dismiss),
            message: m,
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::Internal {
            message: message.into(),
            ui: UserShape::new(
                "Something went wrong with the offline queue. Try again.",
                Recovery::Retry,
            ),
        }
    }
}

impl From<QueueError> for QueueCommandError {
    fn from(error: QueueError) -> Self {
        match error {
            QueueError::EmptyService => Self::invalid_args("Service must not be empty."),
            QueueError::EmptyMethod => Self::invalid_args("Method must not be empty."),
            QueueError::EmptyUrl => Self::invalid_args("URL must not be empty."),
            QueueError::HeadersNotObject => Self::invalid_args("Headers must be a JSON object."),
            QueueError::InvalidBody(msg) => {
                Self::invalid_args(format!("Body is not valid base64: {msg}"))
            }
            QueueError::Sqlx(e) => Self::internal(format!("database error: {e}")),
        }
    }
}

impl From<db::DbError> for QueueCommandError {
    fn from(error: db::DbError) -> Self {
        Self::internal(format!("database error: {error}"))
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn integration_queue_enqueue<R: Runtime>(
    app: AppHandle<R>,
    args: EnqueueArgs,
) -> Result<EnqueueResult, QueueCommandError> {
    let pool = db::pool(&app).await?;
    let input = NewQueueEntry {
        service: args.service,
        method: args.method,
        url: args.url,
        headers: args.headers,
        body_base64: args.body_base64,
        enqueued_at: args.enqueued_at,
    };
    let result = integration_write_queue::enqueue(&pool, input).await?;
    Ok(EnqueueResult {
        id: result.id,
        evicted: result.evicted,
    })
}

#[tauri::command]
pub async fn integration_queue_list<R: Runtime>(
    app: AppHandle<R>,
    args: ListArgs,
) -> Result<Vec<QueueEntry>, QueueCommandError> {
    let pool = db::pool(&app).await?;
    Ok(integration_write_queue::list(&pool, args.service.as_deref()).await?)
}

#[tauri::command]
pub async fn integration_queue_dequeue<R: Runtime>(
    app: AppHandle<R>,
    args: DequeueArgs,
) -> Result<bool, QueueCommandError> {
    let pool = db::pool(&app).await?;
    Ok(integration_write_queue::dequeue(&pool, args.id).await?)
}

#[tauri::command]
pub async fn integration_queue_mark_failed<R: Runtime>(
    app: AppHandle<R>,
    args: MarkFailedArgs,
) -> Result<bool, QueueCommandError> {
    let pool = db::pool(&app).await?;
    Ok(integration_write_queue::mark_failed(&pool, args.id, &args.error, args.at).await?)
}

#[tauri::command]
pub async fn integration_queue_clear_service<R: Runtime>(
    app: AppHandle<R>,
    args: ClearServiceArgs,
) -> Result<u64, QueueCommandError> {
    let pool = db::pool(&app).await?;
    Ok(integration_write_queue::clear_service(&pool, &args.service).await?)
}
