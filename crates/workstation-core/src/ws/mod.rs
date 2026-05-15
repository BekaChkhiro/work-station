//! WebSocket bridge primitives shared between the Tauri desktop binary
//! and the headless `cloud-agent` (T19.20).
//!
//! Only the Tauri-free pieces live here:
//!
//!   * [`protocol`] — JSON wire format (`ClientMessage` / `ServerMessage`),
//!     helper constructors, and the `KNOWN_CLIENT_TYPES` set the
//!     dispatcher uses to distinguish "unsupported" from "invalid payload".
//!   * [`auth`] — bearer-token type (`AuthToken`), `app_settings`
//!     load-or-create, and the header-or-query `check_auth` helper.
//!   * [`system_monitor`] — sysinfo-backed CPU/RAM/PTY-count sampler
//!     plus a tokio broadcast channel both backends fan out to their
//!     per-connection forwarders.
//!
//! Per-request handlers, axum routing, and Tauri event emission stay in
//! `src-tauri/src/ws/` so this crate has no dependency on the `tauri`
//! runtime.

pub mod auth;
pub mod protocol;
pub mod system_monitor;
