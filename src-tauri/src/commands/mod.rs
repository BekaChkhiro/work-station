//! Tauri command handlers.
//!
//! Exposes backend capabilities to the frontend via IPC.

pub mod project;

use std::collections::HashMap;
use tauri::ipc::InvokeResponseBody;
use tauri::State;
use uuid::Uuid;

use crate::pty::PtyManager;

/// Spawn a new PTY session.
///
/// Args:
/// - `cwd`   – working directory for the spawned process
/// - `command` – shell/command to execute
/// - `env`   – environment variables map
/// - `cols`  – terminal width in columns
/// - `rows`  – terminal height in rows
///
/// Returns the session UUID as a string.
#[tauri::command]
pub async fn pty_spawn(
    cwd: String,
    command: String,
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
    manager: State<'_, PtyManager>,
) -> Result<String, String> {
    let id = manager
        .spawn(&cwd, &command, env, cols, rows)
        .await
        .map_err(|e| e.to_string())?;
    Ok(id.to_string())
}

/// Subscribe to a PTY session's output via a Tauri Channel.
///
/// Args:
/// - `id`      – session UUID returned by `pty_spawn`
/// - `channel` – Tauri Channel that receives batched `Vec<u8>` output
///
/// The channel receives coalesced output flushed every ~16 ms.
#[tauri::command]
pub async fn pty_subscribe(
    id: String,
    channel: tauri::ipc::Channel<InvokeResponseBody>,
    manager: State<'_, PtyManager>,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    manager
        .add_frontend_channel(&uuid, channel)
        .await
        .ok_or_else(|| "Session not found".to_string())
}

/// Write raw bytes to a PTY session's stdin.
///
/// Args:
/// - `id`   – session UUID returned by `pty_spawn`
/// - `data` – raw bytes to forward
#[tauri::command]
pub async fn pty_write(
    id: String,
    data: Vec<u8>,
    manager: State<'_, PtyManager>,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    match manager.write(&uuid, &data).await {
        Some(result) => result.map_err(|e| e.to_string()),
        None => Err("Session not found".to_string()),
    }
}

/// Resize a PTY session's terminal dimensions.
///
/// Args:
/// - `id`   – session UUID returned by `pty_spawn`
/// - `cols` – new terminal width in columns
/// - `rows` – new terminal height in rows
#[tauri::command]
pub async fn pty_resize(
    id: String,
    cols: u16,
    rows: u16,
    manager: State<'_, PtyManager>,
) -> Result<(), String> {
    let uuid = Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    match manager.resize(&uuid, cols, rows).await {
        Some(result) => result.map_err(|e| e.to_string()),
        None => Err("Session not found".to_string()),
    }
}

/// Retrieve scrollback buffer data for a PTY session.
///
/// Args:
/// - `id`     – session UUID returned by `pty_spawn`
/// - `offset` – byte offset from the start of the scrollback buffer
/// - `limit`  – maximum number of bytes to return
///
/// Returns an array of byte chunks that can be replayed into xterm.js.
#[tauri::command]
pub async fn pty_get_scrollback(
    id: String,
    offset: usize,
    limit: usize,
    manager: State<'_, PtyManager>,
) -> Result<Vec<bytes::Bytes>, String> {
    let uuid = Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    match manager.get_scrollback(&uuid, offset, limit).await {
        Some(chunks) => Ok(chunks),
        None => Err("Session not found".to_string()),
    }
}

/// Kill a PTY session with graceful shutdown.
///
/// Args:
/// - `id` – session UUID returned by `pty_spawn`
///
/// Sends SIGTERM (Unix) and waits up to 2s before force-killing.
/// The session is removed from the registry regardless of outcome.
#[tauri::command]
pub async fn pty_kill(id: String, manager: State<'_, PtyManager>) -> Result<(), String> {
    let uuid = Uuid::parse_str(&id).map_err(|e| e.to_string())?;
    match manager.kill(&uuid).await {
        Some(result) => result.map_err(|e| e.to_string()),
        None => Err("Session not found".to_string()),
    }
}

/// Open a native folder picker dialog.
///
/// Returns the absolute path of the selected folder, or `None` if the user cancelled.
#[tauri::command]
pub fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let folder_path = app.dialog().file().blocking_pick_folder();
    Ok(folder_path.map(|p| p.to_string()))
}
