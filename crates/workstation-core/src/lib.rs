//! Work Station core — Tauri-independent runtime modules.
//!
//! Modules in this crate must NOT depend on the `tauri` runtime so
//! they can be linked from any surface (the desktop binary, a future
//! CLI, integration tests, headless daemons). Anything that needs
//! `tauri::AppHandle`, `tauri::State`, plugin handles, or the webview
//! belongs in `src-tauri` instead.
//!
//! Extracted in T19.1:
//!   * [`cli`]         — PATH scan + version probe for known CLI agents.
//!   * [`shell_path`]  — login-shell PATH hydration for macOS GUI launches.

pub mod cli;
pub mod shell_path;
