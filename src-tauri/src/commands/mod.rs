//! Tauri command handlers — the `#[tauri::command]` surface bridging UI → core.

pub mod agent;
pub mod cli;
pub mod clipboard;
pub mod cloud_sync;
pub mod credentials;
pub mod files;
pub mod fs;
pub mod git;
pub mod integration_queue;
pub mod log;
pub mod pairing;
pub mod picker;
pub mod project_links;
pub mod projects;
pub mod pty;
pub mod push;
pub mod watch;
