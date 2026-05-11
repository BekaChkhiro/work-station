//! T11.2: Tauri command surface for the OS-native credential store.
//!
//! The four commands (`credentials_set`, `credentials_get`,
//! `credentials_delete`, `credentials_has`) all dispatch the blocking
//! keyring operation onto `spawn_blocking` so a slow keychain prompt
//! (macOS first-access dialog, locked keychain, …) does not stall the
//! Tauri IPC reactor.
//!
//! Frontend wrapper lives at `src/integrations/credentials/index.ts`.
//! The wire shape mirrors every other typed command in this crate:
//! `{ kind, message, userMessage, recovery }` for errors (T2.15 pattern).

use serde::Deserialize;

use crate::credentials::{self, CredentialsError};
use crate::pty::{Recovery, UserShape};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CredentialsKey {
    pub integration: String,
    pub account: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetCredentialsArgs {
    pub integration: String,
    pub account: String,
    pub secret: String,
}

#[tauri::command]
pub async fn credentials_set(args: SetCredentialsArgs) -> Result<(), CredentialsError> {
    run_blocking(move || credentials::set(&args.integration, &args.account, &args.secret)).await
}

#[tauri::command]
pub async fn credentials_get(args: CredentialsKey) -> Result<Option<String>, CredentialsError> {
    run_blocking(move || credentials::get(&args.integration, &args.account)).await
}

#[tauri::command]
pub async fn credentials_delete(args: CredentialsKey) -> Result<bool, CredentialsError> {
    run_blocking(move || credentials::delete(&args.integration, &args.account)).await
}

#[tauri::command]
pub async fn credentials_has(args: CredentialsKey) -> Result<bool, CredentialsError> {
    run_blocking(move || credentials::has(&args.integration, &args.account)).await
}

/// Dispatch a blocking keyring call onto Tokio's blocking pool.
///
/// A `JoinError` here is almost always a panic in the closure — that's
/// already a serious bug, but we still surface it as a structured
/// `Internal` so the frontend gets a toast instead of a hung promise.
async fn run_blocking<T, F>(f: F) -> Result<T, CredentialsError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, CredentialsError> + Send + 'static,
{
    match tokio::task::spawn_blocking(f).await {
        Ok(result) => result,
        Err(join_error) => Err(CredentialsError::Internal {
            message: format!("keychain task panicked: {join_error}"),
            ui: UserShape::new(
                "The system keychain call failed unexpectedly. Try again.",
                Recovery::Retry,
            ),
        }),
    }
}
