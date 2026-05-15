//! User-facing error matrix for PTY operations (T2.15).
//!
//! Every PTY command returns a typed error enum whose variants carry,
//! in addition to the raw `message` used in logs:
//!   * a `userMessage` rendered in the UI toast, and
//!   * a `recovery` hint (`retry` / `editProject` / `dismiss`) that the
//!     UI maps to its action button.
//!
//! The mapping is encoded in the per-variant constructor helpers on each
//! command-layer error type (see `commands/pty.rs`). This module hosts
//! the small primitives those constructors share.

use serde::Serialize;

/// Recovery hint the frontend renders alongside the error message.
///
/// * `Retry` — transient or operation-level; reissuing may succeed.
/// * `EditProject` — config issue (cwd, command); user must fix project
///   metadata before retrying.
/// * `Dismiss` — terminal-for-this-session; user acknowledges and the
///   session is treated as gone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Recovery {
    Retry,
    EditProject,
    Dismiss,
}

/// Flattened payload every error variant carries.
///
/// Serialized via `#[serde(flatten)]` next to the variant tag so the
/// frontend sees a flat object:
/// `{ kind, message, userMessage, recovery, ...context }`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserShape {
    pub user_message: String,
    pub recovery: Recovery,
}

impl UserShape {
    pub fn new(user_message: impl Into<String>, recovery: Recovery) -> Self {
        Self {
            user_message: user_message.into(),
            recovery,
        }
    }
}
