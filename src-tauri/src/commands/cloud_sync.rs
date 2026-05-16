//! `cloud_sync_files` — one-shot rsync from the desktop's local project
//! directory to the paired cloud-agent's filesystem.
//!
//! The metadata-clone path (`projectCreate` over WS) is the "fast" half
//! of the local→cloud feature; this command is the "files" half. We
//! shell out to the system `rsync` because re-implementing a robust
//! file-sync protocol over the WS bridge is a much larger feature than
//! the one-click promise warrants — and every macOS / Linux box that
//! pairs with a cloud-agent already has `rsync` on PATH.
//!
//! The Mac side reuses the SSH key the user already has loaded for the
//! VPS (`ssh root@<ip>` works in their terminal → rsync inherits the
//! same agent). When the agent isn't reachable, the command returns a
//! typed error rather than blocking the renderer forever; rsync's own
//! exit code lands in `code` so the UI can branch on permission denied
//! vs. host unreachable vs. partial transfer.

use std::process::Stdio;
use std::time::Instant;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tokio::process::Command;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncArgs {
    /// Absolute path on the user's Mac (`projects.path`).
    pub local_path: String,
    /// `user@host` for SSH — saved per-agent in app_settings under
    /// `cloud_ssh_endpoint`. The renderer fetches it before calling.
    pub ssh_endpoint: String,
    /// Absolute path inside the cloud-agent's filesystem
    /// (`projects.path` on the cloud side).
    pub remote_path: String,
    /// When true, pass `--delete` so files removed locally also go away
    /// on the remote. Defaults to false for safety.
    #[serde(default)]
    pub delete: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloudSyncResult {
    /// rsync's exit code. 0 on success; non-zero values map to typed
    /// failure modes the renderer surfaces in the toast.
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    /// Wall-clock duration in milliseconds — handy for "synced in 12s"
    /// telemetry in the toast.
    pub duration_ms: u128,
}

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum CloudSyncError {
    #[error("rsync binary not found: {message}")]
    RsyncMissing { message: String },
    #[error("ssh endpoint is empty")]
    EmptyEndpoint,
    #[error("local project path is empty")]
    EmptyLocalPath,
    #[error("remote project path is empty")]
    EmptyRemotePath,
    #[error("rsync exec failed: {message}")]
    Exec { message: String },
}

#[tauri::command]
pub async fn cloud_sync_files(args: CloudSyncArgs) -> Result<CloudSyncResult, CloudSyncError> {
    let local = args.local_path.trim();
    let endpoint = args.ssh_endpoint.trim();
    let remote = args.remote_path.trim();
    if local.is_empty() {
        return Err(CloudSyncError::EmptyLocalPath);
    }
    if endpoint.is_empty() {
        return Err(CloudSyncError::EmptyEndpoint);
    }
    if remote.is_empty() {
        return Err(CloudSyncError::EmptyRemotePath);
    }

    // Trailing slash on the source matters in rsync — `dir/` copies the
    // contents into `remote/`, `dir` copies the dir itself nested
    // inside `remote/`. We always want the contents-into form so the
    // remote layout mirrors the local layout 1:1.
    let source = if local.ends_with('/') {
        local.to_string()
    } else {
        format!("{local}/")
    };
    let target = format!("{endpoint}:{remote}/");

    // Light exclude list. Heavy / generated dirs that almost always
    // belong on the .gitignore: skip them by default so the first sync
    // doesn't drag 2 GB of node_modules through Cloudflare.
    let excludes = [
        ".git",
        ".hg",
        ".svn",
        "node_modules",
        ".next",
        "dist",
        "build",
        "target",
        "venv",
        ".venv",
        "__pycache__",
        ".DS_Store",
    ];

    let mut cmd = Command::new("rsync");
    cmd.arg("-az")
        .arg("--human-readable")
        .arg("-e")
        .arg("ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10");
    if args.delete {
        cmd.arg("--delete");
    }
    for ex in excludes {
        cmd.arg("--exclude").arg(ex);
    }
    cmd.arg(&source).arg(&target);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let started = Instant::now();
    let output = match cmd.output().await {
        Ok(o) => o,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(CloudSyncError::RsyncMissing {
                message: "install rsync (it ships with macOS by default) and retry".into(),
            });
        }
        Err(e) => {
            return Err(CloudSyncError::Exec {
                message: e.to_string(),
            });
        }
    };
    let duration_ms = started.elapsed().as_millis();

    Ok(CloudSyncResult {
        code: output.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        duration_ms,
    })
}
