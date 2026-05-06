//! T7.2: `cli_list_available` IPC command.
//!
//! Returns the boot-detected CLI list (T7.1) with a best-effort
//! `--version` banner attached to each entry. The probe is cached on
//! the registry, so repeated calls (e.g. opening the quick-launch menu
//! many times) collapse to a single fork+exec per CLI per session.

use tauri::State;

use crate::cli::{CliInfo, CliRegistry};

/// Returns `[{ name, path, version }]` for every CLI we found on PATH.
/// Probe failures and CLIs without a `--version` flag (e.g. `cmd.exe`)
/// surface as `version: None`; the frontend renders that as a blank
/// label per the T7.2 acceptance criterion.
#[tauri::command]
pub async fn cli_list_available(registry: State<'_, CliRegistry>) -> Result<Vec<CliInfo>, String> {
    Ok(registry.binaries_with_versions().await.to_vec())
}
