//! Tauri command handlers — the `#[tauri::command]` surface bridging UI → core.

pub mod cli;
pub mod clipboard;
pub mod credentials;
pub mod files;
pub mod integration_queue;
pub mod log;
pub mod picker;
pub mod project_links;
pub mod projects;
pub mod pty;
