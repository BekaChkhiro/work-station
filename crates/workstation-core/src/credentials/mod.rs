//! T11.2: OS-native credential store.
//!
//! Wraps the `keyring` crate so each supported OS uses its native vault:
//!   * macOS  — Keychain Services (via `apple-native` / `security-framework`)
//!   * Windows — Credential Manager (via `windows-native` / `windows-sys`)
//!   * Linux  — Secret Service (via `sync-secret-service` / `DBus`)
//!
//! Why not `SQLite`? T11.2's acceptance forbids tokens being readable in
//! the `SQLite` browser, which means the secret cannot live in our app DB
//! at all. The metadata index (which integrations have a stored token)
//! is a separate concern handled at the call site — this module only
//! exposes the secret-storage primitive.
//!
//! Why not stronghold? The plan called out the trade — Stronghold is a
//! cross-platform single-file vault but adds a master-password ceremony
//! at boot. For a personal-use tool the native keychain prompts are the
//! lighter UX, and the OS-managed secret is well-known to backup tools
//! (Time Machine excludes the keychain by design, for instance).
//!
//! ## Threading
//!
//! The `keyring` crate exposes a blocking API. The Tauri command surface
//! (see `crate::commands::credentials`) runs each call inside
//! `tokio::task::spawn_blocking` so a slow keychain prompt never stalls
//! the IPC reactor.

pub mod error;

pub use error::CredentialsError;

/// Application prefix for every keychain service string the app touches.
///
/// Full service string is `work-station.<integration>` so that uninstalls
/// (or a future "Reset Work Station" debug button) can wipe just our
/// entries by enumerating the prefix on each platform.
pub const APP_PREFIX: &str = "work-station";

/// Maximum identifier length the underlying backends will accept without
/// truncation. macOS Keychain Services has its own limits, but 256 bytes
/// is well below all three platforms' ceilings and is plenty for
/// `<integration>` / `<account>` strings (which are typically short
/// constants like "planflow" / "default").
const MAX_ID_LEN: usize = 256;

fn make_service(integration: &str) -> String {
    format!("{APP_PREFIX}.{integration}")
}

/// Reject obviously bad identifiers before we hand them to the OS.
///
/// NUL bytes specifically — `keyring` proxies through C strings on
/// every platform, and a NUL would either truncate silently or surface
/// as a useless `Invalid` error far from the source. Catching it here
/// gives the caller a precise message.
fn validate_id(name: &str, kind: &'static str) -> Result<(), CredentialsError> {
    if name.is_empty() {
        return Err(CredentialsError::invalid(format!(
            "{kind} must not be empty"
        )));
    }
    if name.len() > MAX_ID_LEN {
        return Err(CredentialsError::invalid(format!(
            "{kind} must be at most {MAX_ID_LEN} bytes (was {})",
            name.len()
        )));
    }
    if name.contains('\0') {
        return Err(CredentialsError::invalid(format!(
            "{kind} must not contain NUL bytes"
        )));
    }
    Ok(())
}

fn entry(integration: &str, account: &str) -> Result<keyring::Entry, CredentialsError> {
    let service = make_service(integration);
    keyring::Entry::new(&service, account).map_err(CredentialsError::from_keyring)
}

/// Store (or replace) a secret for `(integration, account)`.
///
/// Replacement is the keyring default — `set_password` on an existing
/// entry overwrites without raising. Callers rotating a token therefore
/// don't need a separate "delete + set" dance.
pub fn set(integration: &str, account: &str, secret: &str) -> Result<(), CredentialsError> {
    validate_id(integration, "integration")?;
    validate_id(account, "account")?;
    if secret.is_empty() {
        return Err(CredentialsError::invalid("secret must not be empty"));
    }
    entry(integration, account)?
        .set_password(secret)
        .map_err(CredentialsError::from_keyring)
}

/// Read the secret for `(integration, account)`.
///
/// Returns `Ok(None)` when no entry exists — that's the common case for
/// "is this integration connected?" checks and should not surface as an
/// error. Any other failure (backend missing, keychain locked, …) maps
/// to a typed `CredentialsError`.
pub fn get(integration: &str, account: &str) -> Result<Option<String>, CredentialsError> {
    validate_id(integration, "integration")?;
    validate_id(account, "account")?;
    match entry(integration, account)?.get_password() {
        Ok(secret) => Ok(Some(secret)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(other) => Err(CredentialsError::from_keyring(other)),
    }
}

/// Delete the secret for `(integration, account)`.
///
/// Returns `Ok(false)` when no entry existed (idempotent disconnect),
/// `Ok(true)` when one was removed.
pub fn delete(integration: &str, account: &str) -> Result<bool, CredentialsError> {
    validate_id(integration, "integration")?;
    validate_id(account, "account")?;
    match entry(integration, account)?.delete_credential() {
        Ok(()) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(other) => Err(CredentialsError::from_keyring(other)),
    }
}

/// Quick "does a secret exist?" check.
///
/// Implemented as `get(...).is_some()` so it inherits the same
/// `BackendUnavailable` / `Locked` errors when the backend can't answer
/// — letting the caller distinguish "no secret" from "couldn't ask".
pub fn has(integration: &str, account: &str) -> Result<bool, CredentialsError> {
    Ok(get(integration, account)?.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn err_kind(err: &CredentialsError) -> String {
        serde_json::to_value(err).expect("serialize")["kind"]
            .as_str()
            .expect("kind string")
            .to_string()
    }

    fn err_message(err: &CredentialsError) -> String {
        match serde_json::to_value(err).expect("serialize") {
            Value::Object(map) => map["message"].as_str().expect("message").to_string(),
            _ => panic!("error must serialize as object"),
        }
    }

    #[test]
    fn service_string_is_namespaced() {
        assert_eq!(make_service("planflow"), "work-station.planflow");
    }

    #[test]
    fn validate_id_rejects_empty() {
        let err = validate_id("", "integration").unwrap_err();
        assert_eq!(err_kind(&err), "invalidArgs");
        assert!(err_message(&err).contains("must not be empty"));
    }

    #[test]
    fn validate_id_rejects_nul_byte() {
        let err = validate_id("plan\0flow", "integration").unwrap_err();
        assert_eq!(err_kind(&err), "invalidArgs");
        assert!(err_message(&err).contains("NUL"));
    }

    #[test]
    fn validate_id_rejects_too_long() {
        let long = "a".repeat(MAX_ID_LEN + 1);
        let err = validate_id(&long, "account").unwrap_err();
        assert_eq!(err_kind(&err), "invalidArgs");
    }

    #[test]
    fn validate_id_accepts_typical_id() {
        assert!(validate_id("planflow", "integration").is_ok());
        assert!(validate_id("default", "account").is_ok());
    }

    #[test]
    fn set_rejects_empty_secret() {
        let err = set("planflow", "default", "").unwrap_err();
        assert_eq!(err_kind(&err), "invalidArgs");
        assert!(err_message(&err).contains("secret"));
    }

    #[test]
    fn set_rejects_empty_integration() {
        let err = set("", "default", "secret").unwrap_err();
        assert_eq!(err_kind(&err), "invalidArgs");
    }

    /// Round-trips against the real OS keychain. Gated behind
    /// `#[ignore]` because:
    ///   * macOS pops a Keychain prompt on first access for an unsigned
    ///     dev build,
    ///   * CI runners frequently have no `DBus` / keychain,
    ///   * Linux setups without libsecret would fail with a backend
    ///     error here that's unrelated to the code under test.
    ///
    /// Run locally with `cargo test -- --ignored credentials::tests::round_trip`.
    #[test]
    #[ignore = "needs real OS keychain access"]
    fn round_trip_against_real_keychain() {
        let integration = "ws-test-integration";
        let account = format!("test-account-{}", uuid::Uuid::new_v4());
        let secret = "ya29.test-token-value";

        let _ = delete(integration, &account);
        assert!(!has(integration, &account).unwrap());

        set(integration, &account, secret).expect("set");
        assert!(has(integration, &account).unwrap());
        assert_eq!(get(integration, &account).unwrap().as_deref(), Some(secret));

        // Replacement overwrites cleanly.
        set(integration, &account, "rotated").expect("set rotated");
        assert_eq!(
            get(integration, &account).unwrap().as_deref(),
            Some("rotated")
        );

        assert!(delete(integration, &account).unwrap());
        assert!(!has(integration, &account).unwrap());
        // Second delete is a no-op.
        assert!(!delete(integration, &account).unwrap());
    }
}
