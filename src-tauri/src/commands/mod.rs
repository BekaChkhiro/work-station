//! Tauri command handlers.
//!
//! Exposes backend capabilities to the frontend via IPC.

use std::collections::HashMap;
use tauri::State;

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
