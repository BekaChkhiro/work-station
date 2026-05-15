//! Typed errors for the credential store (T11.2).
//!
//! Variants map onto the cross-platform error matrix called out in the
//! T11.2 plan: backend missing (Linux without libsecret/DBus), keychain
//! locked (macOS), user refused the prompt, invalid arguments. Every
//! variant carries a `UserShape` so the eventual Settings → Integrations
//! UI (T11.3) can render an actionable toast straight from the wire
//! payload — same pattern as `ProjectCommandError`.

use serde::Serialize;

use crate::pty::{Recovery, UserShape};

/// Tauri-serializable credential-store error.
///
/// Serialized as
/// `{ kind: "invalidArgs" | ..., message, userMessage, recovery }`.
#[derive(Debug, thiserror::Error, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CredentialsError {
    /// Caller-side validation failure (empty / too long / NUL bytes).
    #[error("{message}")]
    InvalidArgs {
        message: String,
        #[serde(flatten)]
        ui: UserShape,
    },
    /// No system keychain available. On Linux this means libsecret /
    /// `SecretService` isn't running; on macOS / Windows the OS would
    /// normally provide one, so seeing this here implies a deeper
    /// platform issue (e.g. a headless CI sandbox).
    #[error("{message}")]
    BackendUnavailable {
        message: String,
        #[serde(flatten)]
        ui: UserShape,
    },
    /// macOS Keychain is locked. User needs to unlock before retrying.
    #[error("{message}")]
    Locked {
        message: String,
        #[serde(flatten)]
        ui: UserShape,
    },
    /// User dismissed the keychain prompt or the OS refused access.
    #[error("{message}")]
    AccessDenied {
        message: String,
        #[serde(flatten)]
        ui: UserShape,
    },
    /// Anything else from the `keyring` crate. The raw message is logged
    /// but never surfaced verbatim in the UI.
    #[error("{message}")]
    Internal {
        message: String,
        #[serde(flatten)]
        ui: UserShape,
    },
}

impl CredentialsError {
    pub fn invalid(message: impl Into<String>) -> Self {
        let m = message.into();
        Self::InvalidArgs {
            ui: UserShape::new(m.clone(), Recovery::Retry),
            message: m,
        }
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal {
            message: message.into(),
            ui: UserShape::new(
                "Could not access the system keychain. Try again.",
                Recovery::Retry,
            ),
        }
    }

    /// Classify a `keyring::Error` into our typed variant.
    ///
    /// The match is intentionally non-exhaustive on the inner platform
    /// errors — `keyring::Error::PlatformFailure` / `NoStorageAccess` wrap
    /// `Box<dyn Error>` so we can only sniff the `Display` string. We err
    /// on the side of `Locked` / `BackendUnavailable` when the substring
    /// is unambiguous and fall back to `Internal` otherwise.
    pub fn from_keyring(err: keyring::Error) -> Self {
        use keyring::Error as K;
        match err {
            K::NoEntry => Self::internal("credential not found"),
            K::BadEncoding(_) => Self::invalid("stored credential is not valid UTF-8"),
            K::TooLong(field, max) => Self::invalid(format!("{field} exceeds {max} bytes")),
            K::Invalid(field, reason) => Self::invalid(format!("{field}: {reason}")),
            K::Ambiguous(_) => Self::Internal {
                message: "multiple matching credentials".into(),
                ui: UserShape::new(
                    "More than one matching credential exists. Open the system keychain and remove the duplicates, then try again.",
                    Recovery::Dismiss,
                ),
            },
            K::NoStorageAccess(inner) => classify_access(&inner.to_string()),
            K::PlatformFailure(inner) => classify_platform(&inner.to_string()),
            other => Self::Internal {
                message: format!("keychain error: {other}"),
                ui: UserShape::new(
                    "The system keychain returned an unexpected error.",
                    Recovery::Retry,
                ),
            },
        }
    }
}

/// `NoStorageAccess` is the keyring crate's "the OS refused us"
/// catch-all. macOS uses it for both locked-keychain and user-cancelled-
/// prompt, distinguished only by the inner Display string.
fn classify_access(message: &str) -> CredentialsError {
    let lower = message.to_lowercase();
    if lower.contains("lock") {
        return CredentialsError::Locked {
            message: format!("keychain locked: {message}"),
            ui: UserShape::new(
                "Your system keychain is locked. Unlock it and try again.",
                Recovery::Retry,
            ),
        };
    }
    CredentialsError::AccessDenied {
        message: format!("keychain refused access: {message}"),
        ui: UserShape::new(
            "The system keychain refused access. Approve the prompt or check keychain permissions, then try again.",
            Recovery::Retry,
        ),
    }
}

/// `PlatformFailure` typically wraps the lower-level platform crate's
/// error (security-framework / windows-sys / dbus-secret-service). On
/// Linux this is where a missing libsecret / `DBus` surfaces.
fn classify_platform(message: &str) -> CredentialsError {
    let lower = message.to_lowercase();
    let unavailable = [
        "service not available",
        "not provided by any .service",
        "no such service",
        "connection refused",
        "dbus",
        "d-bus",
        "no session bus",
    ]
    .iter()
    .any(|needle| lower.contains(needle));

    if unavailable {
        return CredentialsError::BackendUnavailable {
            message: format!("keychain backend unavailable: {message}"),
            ui: UserShape::new(
                "No system keychain is available. On Linux, install libsecret and start gnome-keyring or kwallet.",
                Recovery::Dismiss,
            ),
        };
    }

    CredentialsError::Internal {
        message: format!("keychain platform error: {message}"),
        ui: UserShape::new(
            "The system keychain returned a platform error. Try again.",
            Recovery::Retry,
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn invalid_sets_user_message_and_recovery() {
        let err = CredentialsError::invalid("empty integration");
        let json = serde_json::to_value(&err).expect("serialize");
        assert_eq!(json["kind"], "invalidArgs");
        assert_eq!(json["message"], "empty integration");
        assert_eq!(json["userMessage"], "empty integration");
        assert_eq!(json["recovery"], "retry");
    }

    #[test]
    fn classify_access_locked_substring_routes_to_locked() {
        let err = classify_access("Keychain is locked");
        let json = serde_json::to_value(&err).expect("serialize");
        assert_eq!(json["kind"], "locked");
        assert_eq!(json["recovery"], "retry");
    }

    #[test]
    fn classify_access_other_routes_to_access_denied() {
        let err = classify_access("User cancelled prompt");
        let json = serde_json::to_value(&err).expect("serialize");
        assert_eq!(json["kind"], "accessDenied");
    }

    #[test]
    fn classify_platform_dbus_routes_to_backend_unavailable() {
        let err = classify_platform("D-Bus service not provided by any .service file");
        let json = serde_json::to_value(&err).expect("serialize");
        assert_eq!(json["kind"], "backendUnavailable");
        assert_eq!(json["recovery"], "dismiss");
    }

    #[test]
    fn classify_platform_unknown_routes_to_internal() {
        let err = classify_platform("Unexpected platform error");
        let json = serde_json::to_value(&err).expect("serialize");
        assert_eq!(json["kind"], "internal");
        assert_eq!(json["recovery"], "retry");
    }
}
