//! Embedded HTTP + WebSocket server for the mobile PWA bridge.
//!
//!   * T18.1 — axum HTTP/WebSocket server on port 7420 (default),
//!     spawned alongside the Tauri GUI as a tokio task.
//!   * T18.2 — bearer-token auth: a 256-bit random token persisted in
//!     `app_settings` is required on the `/ws` upgrade (either as an
//!     `Authorization: Bearer <token>` header or as a `?token=` query
//!     parameter so browser `WebSocket` constructors can authenticate).
//!   * T18.3 — JSON message protocol that bridges WebSocket clients to
//!     the existing `PtyManager` (spawn / write / resize / kill /
//!     scrollback) and streams PTY output back as live frames.
//!   * T18.5 — system-stats bridge: a single background task polls
//!     CPU / RAM / active PTY count every 2s and broadcasts
//!     `system_stats` frames to every authenticated WebSocket.
//!
//! The boot path lives in [`init`]: it loads (or creates) the auth
//! token from the `SQLite` pool, then calls [`server::spawn`] to bind
//! the listener and hand off to a background task. Returns the bound
//! [`std::net::SocketAddr`] so the caller can log it / propagate it
//! through to UI for the Settings panel.

#![allow(dead_code)] // T18.4+ wire the public re-exports.

use std::net::SocketAddr;
use std::sync::Arc;

use sqlx::sqlite::SqlitePool;
use tauri::AppHandle;

use crate::pty::PtyManager;
use crate::push::PushService;

mod auth;
mod planflow_bridge;
mod projects_bridge;
mod protocol;
mod pty_bridge;
mod server;
mod system_monitor;

// Public surface — T18.4+ consumers (other bridges) and Tauri commands
// that expose / regenerate the token will reach in via these re-exports.
#[allow(unused_imports)]
pub use auth::{AuthToken, WS_AUTH_TOKEN_KEY};
#[allow(unused_imports)]
pub use planflow_bridge::PlanflowState;
#[allow(unused_imports)]
pub use server::{DEFAULT_PORT, HOST_ENV, PORT_ENV};

/// Errors surfaced during WebSocket-server boot.
#[derive(Debug, thiserror::Error)]
pub enum InitError {
    #[error("load/persist ws auth token: {0}")]
    Token(#[from] sqlx::Error),
    #[error("bind ws server: {0}")]
    Bind(#[from] std::io::Error),
}

/// Boot the embedded HTTP + WebSocket server.
///
/// Returns the actual bound [`SocketAddr`] (port may differ from
/// [`DEFAULT_PORT`] if `WS_PORT` was set or `0` was requested for an
/// ephemeral port in tests).
///
/// `push` is optional: when present, the `/push/*` HTTP routes are
/// mounted behind the same bearer-token middleware. Boot failures in
/// the push subsystem must not take down the WebSocket bridge, so
/// callers pass `None` to skip wiring.
///
/// `app` is the Tauri [`AppHandle`] used by the projects/settings
/// bridge (T18.4) to emit `active-project-changed` so the desktop
/// frontend mirrors a PWA-driven project switch.
pub async fn init(
    pool: &SqlitePool,
    manager: PtyManager,
    push: Option<PushService>,
    app: AppHandle,
    planflow: Option<PlanflowState>,
) -> Result<SocketAddr, InitError> {
    let token = auth::load_or_create_token(pool).await?;
    let events: Arc<dyn projects_bridge::AppEvents> =
        Arc::new(projects_bridge::TauriAppEvents::new(app));
    let addr = server::spawn(token, manager, push, pool.clone(), events, planflow).await?;
    Ok(addr)
}
