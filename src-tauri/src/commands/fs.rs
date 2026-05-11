//! T13.2: filesystem commands for the editor's file tree.
//!
//! `fs_list_dir` returns a single directory's immediate children — the
//! component does its own recursion via lazy expand, so a deep tree
//! never round-trips the whole subtree at once. Entries are sorted
//! folders-first then alphabetical (case-insensitive), matching every
//! popular editor sidebar so muscle memory transfers.
//!
//! `respect_gitignore: true` triggers a hardcoded noise filter (`.git`,
//! `node_modules`, `target`, `dist`, `build`, `.next`, `.svelte-kit`,
//! `.turbo`, `.cache`). Proper `.gitignore` parsing is deferred to T13.9
//! — it requires walking up the tree to find the nearest `.gitignore`
//! and composing patterns, which is overkill for "open a file" UX.
//!
//! Canonicalization mirrors `picker.rs` so symlink loops surface a typed
//! error instead of hanging the read.

use std::path::PathBuf;

use serde::Serialize;
use thiserror::Error;

use crate::pty::{Recovery, UserShape};

#[derive(Debug, Error, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FsError {
    #[error("{message}")]
    InvalidPath {
        message: String,
        #[serde(flatten)]
        ui: UserShape,
    },
    #[error("{message}")]
    NotADirectory {
        message: String,
        #[serde(flatten)]
        ui: UserShape,
    },
    #[error("{message}")]
    Io {
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

impl FsError {
    fn invalid_path(message: impl Into<String>) -> Self {
        let m = message.into();
        Self::InvalidPath {
            ui: UserShape::new(m.clone(), Recovery::Dismiss),
            message: m,
        }
    }

    fn not_a_directory(message: impl Into<String>) -> Self {
        let m = message.into();
        Self::NotADirectory {
            ui: UserShape::new(m.clone(), Recovery::Dismiss),
            message: m,
        }
    }

    fn io(message: impl Into<String>) -> Self {
        let m = message.into();
        Self::Io {
            ui: UserShape::new("Could not read folder. Try again.", Recovery::Retry),
            message: m,
        }
    }

    fn internal(message: impl Into<String>) -> Self {
        Self::Internal {
            message: message.into(),
            ui: UserShape::new("Could not read folder.", Recovery::Retry),
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsDirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

// Folders we skip when `respect_gitignore: true`. Chosen for high-noise
// directories that every project layers on top of source — they dominate
// any unfiltered listing and crowd out the entries the user actually
// wants to click on.
const NOISE_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".cache",
    ".parcel-cache",
    ".vite",
];

#[tauri::command]
pub async fn fs_list_dir(
    path: String,
    respect_gitignore: Option<bool>,
) -> Result<Vec<FsDirEntry>, FsError> {
    let filter_noise = respect_gitignore.unwrap_or(true);
    let input = PathBuf::from(&path);

    let abs = tokio::task::spawn_blocking({
        let input = input.clone();
        move || std::fs::canonicalize(&input)
    })
    .await
    .map_err(|e| FsError::internal(format!("canonicalize join: {e}")))?
    .map_err(|e| FsError::invalid_path(format!("Cannot resolve folder: {e}")))?;

    let meta = tokio::task::spawn_blocking({
        let abs = abs.clone();
        move || std::fs::metadata(&abs)
    })
    .await
    .map_err(|e| FsError::internal(format!("metadata join: {e}")))?
    .map_err(|e| FsError::io(format!("Cannot read folder metadata: {e}")))?;

    if !meta.is_dir() {
        return Err(FsError::not_a_directory(format!(
            "Not a directory: {}",
            abs.display()
        )));
    }

    let entries =
        tokio::task::spawn_blocking(move || -> Result<Vec<FsDirEntry>, std::io::Error> {
            let mut out = Vec::new();
            for entry in std::fs::read_dir(&abs)? {
                let entry = entry?;
                let name = entry.file_name().to_string_lossy().into_owned();
                // `file_type()` is one stat call; `metadata()` would follow
                // symlinks and double the syscalls per entry. The tree
                // treats symlinked-to-dir as files for now — they re-list
                // fine if the user clicks, but we don't recurse blindly.
                let file_type = entry.file_type().ok();
                let is_dir = file_type.as_ref().is_some_and(std::fs::FileType::is_dir);
                if filter_noise && is_dir && NOISE_DIRS.contains(&name.as_str()) {
                    continue;
                }
                let full = entry.path();
                out.push(FsDirEntry {
                    name,
                    path: full.to_string_lossy().into_owned(),
                    is_dir,
                });
            }
            out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            });
            Ok(out)
        })
        .await
        .map_err(|e| FsError::internal(format!("read_dir join: {e}")))?
        .map_err(|e| FsError::io(format!("Cannot read folder: {e}")))?;

    Ok(entries)
}
