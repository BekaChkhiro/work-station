//! T3.7: native folder picker command.
//!
//! Wraps `tauri-plugin-dialog`'s `pick_folder` so the frontend gets back a
//! canonicalized absolute path string (or `None` on cancellation) instead
//! of the raw `FilePath` enum. Canonicalization runs on a blocking pool —
//! it touches the filesystem and on a symlink loop the OS returns `ELOOP` /
//! `ERROR_CANT_RESOLVE_FILENAME`, which we surface as `InvalidPath`.

use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use tauri_plugin_dialog::{DialogExt, FilePath};
use thiserror::Error;
use tokio::sync::oneshot;

use crate::pty::{Recovery, UserShape};

#[derive(Debug, Error, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum PickerError {
    #[error("{message}")]
    InvalidPath {
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

impl PickerError {
    fn invalid_path(message: impl Into<String>) -> Self {
        let m = message.into();
        Self::InvalidPath {
            ui: UserShape::new(m.clone(), Recovery::Dismiss),
            message: m,
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::Internal {
            message: message.into(),
            ui: UserShape::new("Could not open folder picker. Try again.", Recovery::Retry),
        }
    }
}

#[tauri::command]
pub async fn pick_project_folder<R: Runtime>(
    app: AppHandle<R>,
) -> Result<Option<String>, PickerError> {
    let (tx, rx) = oneshot::channel::<Option<FilePath>>();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });

    let picked = rx
        .await
        .map_err(|e| PickerError::internal(format!("dialog channel closed: {e}")))?;

    let Some(file_path) = picked else {
        return Ok(None);
    };

    let raw: PathBuf = file_path
        .into_path()
        .map_err(|e| PickerError::invalid_path(format!("expected file path: {e}")))?;

    let abs = tokio::task::spawn_blocking({
        let raw = raw.clone();
        move || std::fs::canonicalize(&raw)
    })
    .await
    .map_err(|e| PickerError::internal(format!("canonicalize join: {e}")))?
    .map_err(|e| {
        PickerError::invalid_path(format!(
            "Cannot resolve folder (possible symlink loop): {e}"
        ))
    })?;

    let meta = tokio::task::spawn_blocking({
        let abs = abs.clone();
        move || std::fs::metadata(&abs)
    })
    .await
    .map_err(|e| PickerError::internal(format!("metadata join: {e}")))?
    .map_err(|e| PickerError::invalid_path(format!("Cannot read folder metadata: {e}")))?;

    if !meta.is_dir() {
        return Err(PickerError::invalid_path(
            "Selected path is not a directory.",
        ));
    }

    Ok(Some(abs.to_string_lossy().into_owned()))
}
