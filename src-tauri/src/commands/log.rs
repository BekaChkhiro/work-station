//! `log_from_frontend` command (T1.9).
//!
//! Receives structured log entries from the webview and re-emits them through
//! the Rust `tracing` subscriber under the `frontend` target so they land in
//! the same rotating log file as backend logs.

use serde::Deserialize;
use tracing::Level;

use crate::logging;

#[derive(Debug, Deserialize)]
pub struct LogPayload {
    pub level: String,
    pub message: String,
    #[serde(default)]
    pub error: Option<serde_json::Value>,
    #[serde(default)]
    pub context: Option<serde_json::Value>,
}

#[tauri::command]
pub fn log_from_frontend(payload: LogPayload) {
    let LogPayload {
        level,
        message,
        error,
        context,
    } = payload;

    let level = logging::level_from_str(&level);
    let error_repr = error.as_ref().map_or_else(String::new, ToString::to_string);
    let context_repr = context
        .as_ref()
        .map_or_else(String::new, ToString::to_string);

    // tracing macros require a static target string, so we hardcode "frontend"
    // and branch on level rather than constructing the event dynamically.
    match level {
        Level::ERROR => tracing::error!(
            target: "frontend",
            error = %error_repr,
            context = %context_repr,
            "{message}"
        ),
        Level::WARN => tracing::warn!(
            target: "frontend",
            context = %context_repr,
            "{message}"
        ),
        Level::DEBUG => tracing::debug!(
            target: "frontend",
            context = %context_repr,
            "{message}"
        ),
        _ => tracing::info!(
            target: "frontend",
            context = %context_repr,
            "{message}"
        ),
    }
}
