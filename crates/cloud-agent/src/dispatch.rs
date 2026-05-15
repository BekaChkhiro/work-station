// T19.25 prose mentions `SQLite`, `PlanFlow`, `WebSocket` in passing.
// Backticking each occurrence hurts readability; allow the doc-markdown
// lint at the module level, matching `workstation-core::ws::protocol`.
#![allow(clippy::doc_markdown)]

//! Per-connection WebSocket dispatch loop for the cloud-agent.
//!
//! T19.24 stood up the loop end-to-end with a stubbed `settings_get`
//! reply so the desktop WS client could prove the round-trip without
//! standing up SQLite on the VPS. T19.25 replaced the stub with the
//! real DB-backed handler and lit up the projects bridge
//! (`projects_list`, `project_get`, `project_switch`) against the
//! cloud-agent's own SQLite at `<state_dir>/cloud-agent.db`. T19.26
//! lights up the PTY bridge: `pty_spawn` / `pty_write` / `pty_resize`
//! / `pty_kill` / `pty_scrollback` / `pty_subscribe` / `pty_unsubscribe`
//! now run real shells in the cloud-agent's process, with the same
//! base64-on-the-wire shape and error taxonomy the desktop bridge uses
//! so a single PWA branch table covers both backends.
//!
//! The error taxonomy mirrors the desktop bridge so the PWA / desktop
//! client doesn't need a second branch table:
//!
//!   * `invalid_json`  — payload didn't parse, or `type` was missing.
//!   * `unsupported`   — `type` is a string we don't recognize at all.
//!   * `unimplemented` — `type` is known but the cloud-agent hasn't
//!     wired its handler yet (FS / PlanFlow land in follow-ups).
//!   * `invalid_frame` — client sent a binary frame on a text-only wire.
//!   * `not_found`     — project id in the request doesn't exist.
//!   * `internal`      — SQLite or serialization failure.
//!   * `invalid_args`  — PTY request had a malformed argument
//!     (empty command, zero dim, undecodable base64).
//!   * `spawn_failed` / `command_not_found` / `cwd_missing` /
//!     `write_failed` / `write_to_closed` / `resize_failed` /
//!     `reader_panic` — PTY-specific failures bubbled up from
//!     `workstation_core::pty`.

use std::collections::HashMap;
use std::path::PathBuf;

use axum::extract::ws::{Message, WebSocket};
use base64::Engine;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use sqlx::sqlite::SqlitePool;
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;
use uuid::Uuid;
use workstation_core::pty::{spawn_reader, PtyError, PtyManager, SpawnConfig};
use workstation_core::ws::protocol::{
    ClientMessage, ServerMessage, SettingsView, KNOWN_CLIENT_TYPES,
};

use crate::db::{app_settings, projects};

/// Capacity for the per-connection outbound mpsc.
///
/// One forwarder per session + the request-reply lane all push here;
/// 256 mirrors the desktop bridge so a `cat huge.log` burst doesn't
/// drop frames while still applying backpressure when the WS peer
/// stalls.
const OUTBOUND_CHANNEL_CAPACITY: usize = 256;

/// Cap on a single coalesced `pty_output` frame so a runaway producer
/// (e.g. `cat huge.bin`) can't pin the WebSocket pump on one giant
/// base64 payload. 64 KiB leaves headroom for natural bursts.
const PTY_COALESCE_CAP_BYTES: usize = 64 * 1024;

/// Per-connection state. Lives on the stack of [`run_connection`].
struct Connection {
    manager: PtyManager,
    /// Single sink for all outbound JSON frames.
    out_tx: mpsc::Sender<String>,
    /// Active per-session output forwarders. Dropping a handle aborts
    /// the underlying task so [`unsubscribe`] is a no-await teardown.
    forwarders: HashMap<Uuid, JoinHandle<()>>,
}

impl Connection {
    fn new(manager: PtyManager, out_tx: mpsc::Sender<String>) -> Self {
        Self {
            manager,
            out_tx,
            forwarders: HashMap::new(),
        }
    }

    fn subscribe_to(&mut self, session_id: Uuid) -> bool {
        if self.forwarders.contains_key(&session_id) {
            return true;
        }
        let Some(session) = self.manager.get(session_id) else {
            return false;
        };
        let rx = session.output_tx.subscribe();
        let out_tx = self.out_tx.clone();
        let handle = tokio::spawn(forward_output(session_id, rx, out_tx));
        self.forwarders.insert(session_id, handle);
        true
    }

    fn unsubscribe(&mut self, session_id: Uuid) {
        if let Some(handle) = self.forwarders.remove(&session_id) {
            handle.abort();
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        for (_, handle) in self.forwarders.drain() {
            handle.abort();
        }
    }
}

/// Drive a single authenticated WebSocket connection until the peer
/// closes or the socket errors. Returns when the read half drains and
/// the sink task has flushed.
///
/// `pool` and `manager` are cloned per call so the dispatcher holds its
/// own handles; both are internally `Arc`-shared and cheap to clone.
/// Dropping the per-connection copies on teardown doesn't affect other
/// concurrent connections.
pub async fn run_connection(socket: WebSocket, manager: PtyManager, pool: SqlitePool) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<String>(OUTBOUND_CHANNEL_CAPACITY);

    let sink_task = tokio::spawn(async move {
        while let Some(payload) = out_rx.recv().await {
            if ws_tx.send(Message::Text(payload)).await.is_err() {
                break;
            }
        }
        let _ = ws_tx.close().await;
    });

    let mut conn = Connection::new(manager, out_tx);

    while let Some(frame) = ws_rx.next().await {
        let Ok(msg) = frame else {
            break;
        };
        match msg {
            Message::Text(payload) => {
                handle_text(&mut conn, &pool, &payload).await;
            }
            Message::Binary(_) => {
                send_error(
                    &conn.out_tx,
                    None,
                    "invalid_frame",
                    "binary frames are not supported on this connection",
                )
                .await;
            }
            Message::Ping(_) | Message::Pong(_) => {}
            Message::Close(_) => break,
        }
    }

    drop(conn); // aborts per-session forwarders
    let _ = sink_task.await;
}

/// Two-phase parse so we can echo `id` on every failure path and
/// distinguish "unknown message type" (`unsupported`) from "malformed
/// payload for a known type" (`invalid_json`). Mirrors the desktop
/// bridge's `super::ws::pty_bridge::handle_text` flow.
async fn handle_text(conn: &mut Connection, pool: &SqlitePool, payload: &str) {
    let value: serde_json::Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(error) => {
            send_error(
                &conn.out_tx,
                None,
                "invalid_json",
                format!("failed to parse client message: {error}"),
            )
            .await;
            return;
        }
    };

    let echo_id = value.get("id").and_then(|v| v.as_str()).map(str::to_owned);
    let Some(type_str) = value
        .get("type")
        .and_then(|v| v.as_str())
        .map(str::to_owned)
    else {
        send_error(
            &conn.out_tx,
            echo_id,
            "invalid_json",
            "missing required field `type`",
        )
        .await;
        return;
    };

    if !KNOWN_CLIENT_TYPES.contains(&type_str.as_str()) {
        send_error(
            &conn.out_tx,
            echo_id,
            "unsupported",
            format!("unknown message type: {type_str}"),
        )
        .await;
        return;
    }

    // Wired handlers re-parse into the typed enum so a malformed payload
    // (e.g. wrong field type) surfaces as `invalid_json` with the
    // original `id` echoed. Unimplemented branches short-circuit before
    // a typed parse — the Phase-1 client doesn't depend on cloud-side
    // payload validation for handlers that haven't run yet.
    let typed = match type_str.as_str() {
        "settings_get" | "projects_list" | "project_get" | "project_switch" | "pty_spawn"
        | "pty_write" | "pty_resize" | "pty_kill" | "pty_scrollback" | "pty_subscribe"
        | "pty_unsubscribe" => match serde_json::from_value::<ClientMessage>(value) {
            Ok(msg) => msg,
            Err(error) => {
                send_error(
                    &conn.out_tx,
                    echo_id,
                    "invalid_json",
                    format!("failed to parse client message: {error}"),
                )
                .await;
                return;
            }
        },
        other => {
            send_error(
                &conn.out_tx,
                echo_id,
                "unimplemented",
                format!("'{other}' is not yet implemented on the cloud-agent"),
            )
            .await;
            return;
        }
    };

    dispatch_typed(conn, pool, typed).await;
}

/// Route a parsed [`ClientMessage`] to its handler. Split out of
/// [`handle_text`] so the two-phase parse + typed dispatch don't
/// balloon a single function past clippy's `too_many_lines` cap, and
/// so unit tests can drive a handler from a synthetic typed message
/// without re-serialising it through `handle_text`.
async fn dispatch_typed(conn: &mut Connection, pool: &SqlitePool, typed: ClientMessage) {
    match typed {
        ClientMessage::SettingsGet { id } => {
            handle_settings_get(&conn.out_tx, pool, id).await;
        }
        ClientMessage::ProjectsList { id } => {
            handle_projects_list(&conn.out_tx, pool, id).await;
        }
        ClientMessage::ProjectGet { id, project_id } => {
            handle_project_get(&conn.out_tx, pool, id, project_id).await;
        }
        ClientMessage::ProjectSwitch { id, project_id } => {
            handle_project_switch(&conn.out_tx, pool, id, project_id).await;
        }
        ClientMessage::PtySpawn {
            id,
            command,
            args,
            cwd,
            env,
            cols,
            rows,
        } => {
            // When the client omits cwd (the mobile PWA never sends one)
            // fall back to the cloud-agent's active project path so the
            // shell opens where the user expects.
            let resolved = match cwd {
                Some(value) => Some(PathBuf::from(value)),
                None => active_project_cwd(pool).await,
            };
            handle_spawn(conn, id, command, args, resolved, env, cols, rows).await;
        }
        ClientMessage::PtyWrite {
            id,
            session_id,
            data,
        } => {
            handle_write(conn, id, session_id, &data).await;
        }
        ClientMessage::PtyResize {
            id,
            session_id,
            cols,
            rows,
        } => {
            handle_resize(conn, id, session_id, cols, rows).await;
        }
        ClientMessage::PtyKill { id, session_id } => {
            handle_kill(conn, id, session_id).await;
        }
        ClientMessage::PtyScrollback {
            id,
            session_id,
            offset,
            limit,
        } => {
            handle_scrollback(conn, id, session_id, offset, limit).await;
        }
        ClientMessage::PtySubscribe { id, session_id } => {
            handle_subscribe(conn, id, session_id).await;
        }
        ClientMessage::PtyUnsubscribe { id, session_id } => {
            conn.unsubscribe(session_id);
            send(&conn.out_tx, &ServerMessage::PtyAck { id }).await;
        }
        // Variants not in the typed-allowlist filter inside
        // [`handle_text`] are routed to `unimplemented` before reaching
        // this match, so the remaining arms are unreachable in practice.
        // Logging keeps us safe if `protocol.rs` ever grows a variant
        // without the allowlist catching up.
        other => {
            tracing::error!(
                target: "cloud_agent::dispatch",
                variant = ?std::mem::discriminant(&other),
                "unexpected ClientMessage variant reached handler match",
            );
        }
    }
}

/// DB-backed `settings_get` reply (T19.25).
async fn handle_settings_get(
    out_tx: &mpsc::Sender<String>,
    pool: &SqlitePool,
    id: Option<String>,
) {
    let theme = app_settings::get_json::<String>(pool, app_settings::THEME_KEY)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "dark".to_string());

    let last_active =
        app_settings::get_json::<Option<String>>(pool, app_settings::LAST_ACTIVE_PROJECT_KEY)
            .await
            .ok()
            .flatten()
            .flatten();

    let settings = SettingsView {
        theme,
        last_active_project: last_active,
    };
    send(out_tx, &ServerMessage::SettingsResult { id, settings }).await;
}

async fn handle_projects_list(
    out_tx: &mpsc::Sender<String>,
    pool: &SqlitePool,
    id: Option<String>,
) {
    match projects::list(pool).await {
        Ok(rows) => {
            let projects = serde_json::to_value(rows)
                .expect("Project list always serializes to JSON");
            send(out_tx, &ServerMessage::ProjectsListResult { id, projects }).await;
        }
        Err(error) => send(out_tx, &project_error_to_frame(id, &error)).await,
    }
}

async fn handle_project_get(
    out_tx: &mpsc::Sender<String>,
    pool: &SqlitePool,
    id: Option<String>,
    project_id: String,
) {
    match projects::get(pool, &project_id).await {
        Ok(project) => {
            let project =
                serde_json::to_value(project).expect("Project always serializes to JSON");
            send(out_tx, &ServerMessage::ProjectResult { id, project }).await;
        }
        Err(error) => send(out_tx, &project_error_to_frame(id, &error)).await,
    }
}

async fn handle_project_switch(
    out_tx: &mpsc::Sender<String>,
    pool: &SqlitePool,
    id: Option<String>,
    project_id: String,
) {
    if let Err(error) = projects::get(pool, &project_id).await {
        send(out_tx, &project_error_to_frame(id, &error)).await;
        return;
    }

    if let Err(error) =
        app_settings::set_json(pool, app_settings::LAST_ACTIVE_PROJECT_KEY, &project_id).await
    {
        send(
            out_tx,
            &ServerMessage::Error {
                id,
                kind: "internal".into(),
                message: format!("persist last_active_project failed: {error}"),
            },
        )
        .await;
        return;
    }

    send(out_tx, &ServerMessage::ProjectSwitched { id, project_id }).await;
}

fn project_error_to_frame(id: Option<String>, error: &projects::ProjectError) -> ServerMessage {
    let kind = match error {
        projects::ProjectError::NotFound(_) => "not_found",
        projects::ProjectError::Sqlx(_) => "internal",
    };
    ServerMessage::Error {
        id,
        kind: kind.into(),
        message: error.to_string(),
    }
}

/// Resolve the active project's filesystem path so a `pty_spawn` with
/// no explicit `cwd` lands in the project root the user picked from
/// the PWA. Returns `None` when no project is active or the lookup
/// fails — the caller treats that as "use PtyManager's default"
/// (the daemon's working directory at boot).
async fn active_project_cwd(pool: &SqlitePool) -> Option<PathBuf> {
    let project_id: String = app_settings::get_json(pool, app_settings::LAST_ACTIVE_PROJECT_KEY)
        .await
        .ok()
        .flatten()?;
    let project = projects::get(pool, &project_id).await.ok()?;
    Some(PathBuf::from(project.path))
}

#[allow(clippy::too_many_arguments)]
async fn handle_spawn(
    conn: &mut Connection,
    id: Option<String>,
    command: String,
    args: Vec<String>,
    cwd: Option<PathBuf>,
    env: HashMap<String, String>,
    cols: u16,
    rows: u16,
) {
    if command.trim().is_empty() {
        send(
            &conn.out_tx,
            &ServerMessage::error(id, "invalid_args", "command must not be empty"),
        )
        .await;
        return;
    }
    if cols == 0 || rows == 0 {
        send(
            &conn.out_tx,
            &ServerMessage::error(
                id,
                "invalid_args",
                "cols and rows must be greater than zero",
            ),
        )
        .await;
        return;
    }

    let manager = conn.manager.clone();
    let config = SpawnConfig {
        command,
        args,
        cwd,
        env,
        cols,
        rows,
    };

    // Off-load the blocking spawn / reader-wire-up onto the blocking
    // pool — `manager.spawn` can stat the filesystem (`is_executable`)
    // and call native pty openpty.
    let spawn_result = tokio::task::spawn_blocking({
        let manager = manager.clone();
        move || -> Result<Uuid, PtyError> {
            let session_id = manager.spawn(config)?;
            if let Some(session) = manager.get(session_id) {
                spawn_reader(manager.clone(), &session);
            }
            Ok(session_id)
        }
    })
    .await;

    match spawn_result {
        Ok(Ok(session_id)) => {
            // Auto-subscribe the spawning client so the first frames
            // (shell banner, prompt) reach it without a round-trip.
            conn.subscribe_to(session_id);
            send(&conn.out_tx, &ServerMessage::PtySpawned { id, session_id }).await;
        }
        Ok(Err(error)) => {
            let (kind, message) = pty_error_to_kind(&error);
            send(&conn.out_tx, &ServerMessage::error(id, kind, message)).await;
        }
        Err(join_err) => {
            send(
                &conn.out_tx,
                &ServerMessage::error(id, "internal", format!("spawn task failed: {join_err}")),
            )
            .await;
        }
    }
}

async fn handle_write(conn: &Connection, id: Option<String>, session_id: Uuid, data_b64: &str) {
    let data = match decode_b64(data_b64) {
        Ok(bytes) => bytes,
        Err(error) => {
            send(
                &conn.out_tx,
                &ServerMessage::session_error(id, session_id, "invalid_args", error),
            )
            .await;
            return;
        }
    };

    let manager = conn.manager.clone();
    let result = tokio::task::spawn_blocking(move || manager.write(session_id, &data)).await;
    match result {
        Ok(Ok(())) => send(&conn.out_tx, &ServerMessage::PtyAck { id }).await,
        Ok(Err(error)) => {
            let (kind, message) = pty_error_to_kind(&error);
            send(
                &conn.out_tx,
                &ServerMessage::session_error(id, session_id, kind, message),
            )
            .await;
        }
        Err(join_err) => {
            send(
                &conn.out_tx,
                &ServerMessage::session_error(
                    id,
                    session_id,
                    "internal",
                    format!("write task failed: {join_err}"),
                ),
            )
            .await;
        }
    }
}

async fn handle_resize(
    conn: &Connection,
    id: Option<String>,
    session_id: Uuid,
    cols: u16,
    rows: u16,
) {
    if cols == 0 || rows == 0 {
        send(
            &conn.out_tx,
            &ServerMessage::session_error(
                id,
                session_id,
                "invalid_args",
                "cols and rows must be greater than zero",
            ),
        )
        .await;
        return;
    }
    let manager = conn.manager.clone();
    let result =
        tokio::task::spawn_blocking(move || manager.resize(session_id, cols, rows)).await;
    match result {
        Ok(Ok(())) => send(&conn.out_tx, &ServerMessage::PtyAck { id }).await,
        Ok(Err(error)) => {
            let (kind, message) = pty_error_to_kind(&error);
            send(
                &conn.out_tx,
                &ServerMessage::session_error(id, session_id, kind, message),
            )
            .await;
        }
        Err(join_err) => {
            send(
                &conn.out_tx,
                &ServerMessage::session_error(
                    id,
                    session_id,
                    "internal",
                    format!("resize task failed: {join_err}"),
                ),
            )
            .await;
        }
    }
}

async fn handle_kill(conn: &mut Connection, id: Option<String>, session_id: Uuid) {
    // Drop our forwarder ahead of the kill so the per-session broadcast
    // can close cleanly without racing the abort.
    conn.unsubscribe(session_id);
    let manager = conn.manager.clone();
    let result = tokio::task::spawn_blocking(move || manager.kill(session_id)).await;
    match result {
        Ok(Ok(())) => send(&conn.out_tx, &ServerMessage::PtyAck { id }).await,
        Ok(Err(error)) => {
            let (kind, message) = pty_error_to_kind(&error);
            send(
                &conn.out_tx,
                &ServerMessage::session_error(id, session_id, kind, message),
            )
            .await;
        }
        Err(join_err) => {
            send(
                &conn.out_tx,
                &ServerMessage::session_error(
                    id,
                    session_id,
                    "internal",
                    format!("kill task failed: {join_err}"),
                ),
            )
            .await;
        }
    }
}

async fn handle_scrollback(
    conn: &Connection,
    id: Option<String>,
    session_id: Uuid,
    offset: usize,
    limit: usize,
) {
    let manager = conn.manager.clone();
    let result =
        tokio::task::spawn_blocking(move || manager.read_scrollback(session_id, offset, limit))
            .await;
    match result {
        Ok(Ok(chunk)) => {
            let encoded = base64::engine::general_purpose::STANDARD.encode(&chunk.data);
            send(
                &conn.out_tx,
                &ServerMessage::PtyScrollbackChunk {
                    id,
                    session_id,
                    data: encoded,
                    total_bytes: chunk.total_bytes,
                    next_offset: chunk.next_offset,
                },
            )
            .await;
        }
        Ok(Err(error)) => {
            let (kind, message) = pty_error_to_kind(&error);
            send(
                &conn.out_tx,
                &ServerMessage::session_error(id, session_id, kind, message),
            )
            .await;
        }
        Err(join_err) => {
            send(
                &conn.out_tx,
                &ServerMessage::session_error(
                    id,
                    session_id,
                    "internal",
                    format!("scrollback task failed: {join_err}"),
                ),
            )
            .await;
        }
    }
}

async fn handle_subscribe(conn: &mut Connection, id: Option<String>, session_id: Uuid) {
    if conn.subscribe_to(session_id) {
        send(&conn.out_tx, &ServerMessage::PtyAck { id }).await;
    } else {
        send(
            &conn.out_tx,
            &ServerMessage::session_error(id, session_id, "not_found", "session not found"),
        )
        .await;
    }
}

/// Per-session output forwarder: bridges the broadcast channel to the
/// WebSocket outbound mpsc, exiting on `Closed` (child gone). Mirrors
/// the desktop bridge's `forward_output`: opportunistic batching keeps
/// chatty CLIs (claude, codex) from turning every chunk into a separate
/// WS frame, which over Cloudflare quick-tunnel latency would make
/// scrollback feel like a slideshow.
async fn forward_output(
    session_id: Uuid,
    mut rx: broadcast::Receiver<Bytes>,
    out_tx: mpsc::Sender<String>,
) {
    loop {
        match rx.recv().await {
            Ok(first) => {
                let mut combined: Vec<u8> = Vec::with_capacity(first.len());
                combined.extend_from_slice(&first);
                while combined.len() < PTY_COALESCE_CAP_BYTES {
                    match rx.try_recv() {
                        Ok(more) => combined.extend_from_slice(&more),
                        // Empty: no more buffered chunks right now. Closed:
                        // session is gone — the next blocking `recv` at the
                        // top of the loop observes it and emits `pty_exit`.
                        // Both stop the inner drain.
                        Err(broadcast::error::TryRecvError::Empty
                        | broadcast::error::TryRecvError::Closed) => break,
                        Err(broadcast::error::TryRecvError::Lagged(_)) => {
                            // Burned chunks; the next `try_recv` either
                            // returns a real frame or Empty. The PWA
                            // replays scrollback if it cares.
                        }
                    }
                }
                let encoded = base64::engine::general_purpose::STANDARD.encode(&combined);
                let frame = ServerMessage::PtyOutput {
                    session_id,
                    data: encoded,
                };
                if let Ok(payload) = serde_json::to_string(&frame) {
                    if out_tx.send(payload).await.is_err() {
                        return; // peer gone
                    }
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => {
                // Drop and continue — next recv returns the freshest frame.
            }
            Err(broadcast::error::RecvError::Closed) => {
                let frame = ServerMessage::PtyExit { session_id };
                if let Ok(payload) = serde_json::to_string(&frame) {
                    let _ = out_tx.send(payload).await;
                }
                return;
            }
        }
    }
}

fn decode_b64(data: &str) -> Result<Vec<u8>, String> {
    base64::engine::general_purpose::STANDARD
        .decode(data)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(data))
        .map_err(|e| format!("invalid base64 payload: {e}"))
}

fn pty_error_to_kind(error: &PtyError) -> (&'static str, String) {
    let kind = match error {
        PtyError::CwdMissing(_) => "cwd_missing",
        PtyError::CommandNotFound(_) => "command_not_found",
        PtyError::OpenPty(_) | PtyError::Spawn(_) | PtyError::Writer(_) => "spawn_failed",
        PtyError::WriteIo(_) => "write_failed",
        PtyError::WriteToClosed(_) => "write_to_closed",
        PtyError::ResizeIo(_) => "resize_failed",
        PtyError::NotFound(_) => "not_found",
        PtyError::LockPoisoned => "internal",
        PtyError::ReaderPanic(_) => "reader_panic",
    };
    (kind, error.to_string())
}

async fn send(out_tx: &mpsc::Sender<String>, msg: &ServerMessage) {
    match serde_json::to_string(msg) {
        Ok(payload) => {
            let _ = out_tx.send(payload).await;
        }
        Err(error) => {
            tracing::error!(
                target: "cloud_agent::dispatch",
                %error,
                "failed to serialize outbound ServerMessage",
            );
        }
    }
}

async fn send_error(
    out_tx: &mpsc::Sender<String>,
    id: Option<String>,
    kind: &str,
    message: impl Into<String>,
) {
    send(
        out_tx,
        &ServerMessage::Error {
            id,
            kind: kind.to_string(),
            message: message.into(),
        },
    )
    .await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    use std::time::Duration;
    use tempfile::tempdir;

    async fn fresh_pool() -> SqlitePool {
        let dir = tempdir().expect("tempdir");
        let dir = Box::leak(Box::new(dir));
        crate::db::open(dir.path()).await.expect("open")
    }

    fn fresh_conn(out_tx: mpsc::Sender<String>) -> Connection {
        Connection::new(PtyManager::new(), out_tx)
    }

    /// Drain everything the dispatcher emitted into a Vec<Value> for
    /// easy assertions. Closes the channel first so the loop terminates.
    async fn drive(pool: &SqlitePool, payload: &str) -> Vec<Value> {
        let (out_tx, mut out_rx) = mpsc::channel::<String>(8);
        let mut conn = fresh_conn(out_tx);
        handle_text(&mut conn, pool, payload).await;
        drop(conn);
        let mut frames = Vec::new();
        while let Some(raw) = out_rx.recv().await {
            frames.push(serde_json::from_str(&raw).expect("dispatcher emitted invalid JSON"));
        }
        frames
    }

    async fn seed_project(pool: &SqlitePool, id: &str, name: &str) {
        sqlx::query(
            "INSERT INTO projects (id, name, path, env_json, position, created_at)
             VALUES (?, ?, ?, '{}', 0, ?)",
        )
        .bind(id)
        .bind(name)
        .bind(format!("/srv/projects/{name}"))
        .bind(1_700_000_000_i64)
        .execute(pool)
        .await
        .expect("seed project");
    }

    #[tokio::test]
    async fn settings_get_returns_defaults_on_fresh_db() {
        let pool = fresh_pool().await;
        let frames = drive(&pool, r#"{"type":"settings_get","id":"req-1"}"#).await;
        assert_eq!(frames.len(), 1, "expected one reply, got {frames:?}");
        let frame = &frames[0];
        assert_eq!(frame["type"], "settings_result");
        assert_eq!(frame["id"], "req-1");
        assert_eq!(frame["settings"]["theme"], "dark");
        assert!(
            frame["settings"]["lastActiveProject"].is_null(),
            "lastActiveProject must be explicit null on fresh db, got {frame}",
        );
    }

    #[tokio::test]
    async fn settings_get_returns_persisted_values() {
        let pool = fresh_pool().await;
        app_settings::set_json(&pool, app_settings::THEME_KEY, &"light")
            .await
            .expect("set theme");
        app_settings::set_json(&pool, app_settings::LAST_ACTIVE_PROJECT_KEY, &"p-abc")
            .await
            .expect("set active");

        let frames = drive(&pool, r#"{"type":"settings_get"}"#).await;
        let frame = &frames[0];
        assert_eq!(frame["settings"]["theme"], "light");
        assert_eq!(frame["settings"]["lastActiveProject"], "p-abc");
    }

    #[tokio::test]
    async fn settings_get_tolerates_corrupt_theme_row() {
        let pool = fresh_pool().await;
        sqlx::query("INSERT INTO app_settings (key, value) VALUES (?, ?)")
            .bind(app_settings::THEME_KEY)
            .bind("not json")
            .execute(&pool)
            .await
            .expect("seed garbage");
        let frames = drive(&pool, r#"{"type":"settings_get"}"#).await;
        assert_eq!(frames[0]["settings"]["theme"], "dark");
    }

    #[tokio::test]
    async fn projects_list_returns_rows_in_position_order() {
        let pool = fresh_pool().await;
        seed_project(&pool, "p-alpha", "alpha").await;
        sqlx::query(
            "INSERT INTO projects (id, name, path, env_json, position, created_at)
             VALUES ('p-beta', 'beta', '/srv/projects/beta', '{}', 1, ?)",
        )
        .bind(1_700_000_001_i64)
        .execute(&pool)
        .await
        .expect("seed beta");

        let frames = drive(&pool, r#"{"type":"projects_list","id":"req-1"}"#).await;
        assert_eq!(frames.len(), 1);
        let frame = &frames[0];
        assert_eq!(frame["type"], "projects_list_result");
        assert_eq!(frame["id"], "req-1");
        let names: Vec<_> = frame["projects"]
            .as_array()
            .expect("array")
            .iter()
            .map(|p| p["name"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(names, vec!["alpha".to_string(), "beta".to_string()]);
    }

    #[tokio::test]
    async fn projects_list_returns_empty_array_when_no_rows() {
        let pool = fresh_pool().await;
        let frames = drive(&pool, r#"{"type":"projects_list"}"#).await;
        let frame = &frames[0];
        assert_eq!(frame["type"], "projects_list_result");
        assert!(frame["projects"].as_array().unwrap().is_empty());
    }

    #[tokio::test]
    async fn project_get_returns_camel_cased_project() {
        let pool = fresh_pool().await;
        seed_project(&pool, "p-alpha", "alpha").await;
        let frames = drive(
            &pool,
            r#"{"type":"project_get","id":"r","project_id":"p-alpha"}"#,
        )
        .await;
        let frame = &frames[0];
        assert_eq!(frame["type"], "project_result");
        assert_eq!(frame["project"]["id"], "p-alpha");
        assert!(
            frame["project"]["workspaceTabs"].is_array(),
            "expected camelCase workspaceTabs, got {frame}",
        );
    }

    #[tokio::test]
    async fn project_get_unknown_id_replies_not_found() {
        let pool = fresh_pool().await;
        let frames = drive(
            &pool,
            r#"{"type":"project_get","id":"r","project_id":"ghost"}"#,
        )
        .await;
        let frame = &frames[0];
        assert_eq!(frame["type"], "error");
        assert_eq!(frame["kind"], "not_found");
        assert_eq!(frame["id"], "r");
    }

    #[tokio::test]
    async fn project_switch_persists_setting_and_acks() {
        let pool = fresh_pool().await;
        seed_project(&pool, "p-alpha", "alpha").await;
        let frames = drive(
            &pool,
            r#"{"type":"project_switch","id":"req-1","project_id":"p-alpha"}"#,
        )
        .await;
        let frame = &frames[0];
        assert_eq!(frame["type"], "project_switched");
        assert_eq!(frame["project_id"], "p-alpha");
        assert_eq!(frame["id"], "req-1");

        let stored: Option<String> =
            app_settings::get_json(&pool, app_settings::LAST_ACTIVE_PROJECT_KEY)
                .await
                .expect("get setting");
        assert_eq!(stored.as_deref(), Some("p-alpha"));
    }

    #[tokio::test]
    async fn project_switch_unknown_id_rejects_without_persisting() {
        let pool = fresh_pool().await;
        let frames = drive(
            &pool,
            r#"{"type":"project_switch","id":"r","project_id":"ghost"}"#,
        )
        .await;
        let frame = &frames[0];
        assert_eq!(frame["type"], "error");
        assert_eq!(frame["kind"], "not_found");
        let stored: Option<String> =
            app_settings::get_json(&pool, app_settings::LAST_ACTIVE_PROJECT_KEY)
                .await
                .expect("get setting");
        assert!(
            stored.is_none(),
            "setting must not be touched on failed switch"
        );
    }

    #[tokio::test]
    async fn unknown_type_replies_with_unsupported() {
        let pool = fresh_pool().await;
        let frames = drive(&pool, r#"{"type":"nonsense","id":"req-2"}"#).await;
        let frame = &frames[0];
        assert_eq!(frame["type"], "error");
        assert_eq!(frame["kind"], "unsupported");
        assert_eq!(frame["id"], "req-2");
    }

    #[tokio::test]
    async fn known_but_unimplemented_type_replies_with_unimplemented() {
        // PlanFlow handlers are still unimplemented after T19.26; pick a
        // representative `planflow_*` variant for the probe so it stays
        // green until those land. `pty_spawn` no longer qualifies — it
        // routes to the real handler now.
        let pool = fresh_pool().await;
        let frames = drive(
            &pool,
            r#"{"type":"planflow_get_me","id":"req-3"}"#,
        )
        .await;
        let frame = &frames[0];
        assert_eq!(frame["type"], "error");
        assert_eq!(frame["kind"], "unimplemented");
        assert_eq!(frame["id"], "req-3");
    }

    #[tokio::test]
    async fn malformed_json_replies_with_invalid_json_and_no_id() {
        let pool = fresh_pool().await;
        let frames = drive(&pool, r#"{"type": broken"#).await;
        let frame = &frames[0];
        assert_eq!(frame["type"], "error");
        assert_eq!(frame["kind"], "invalid_json");
        assert!(frame.get("id").is_none());
    }

    #[tokio::test]
    async fn missing_type_replies_with_invalid_json_and_echoes_id() {
        let pool = fresh_pool().await;
        let frames = drive(&pool, r#"{"id":"req-4"}"#).await;
        let frame = &frames[0];
        assert_eq!(frame["type"], "error");
        assert_eq!(frame["kind"], "invalid_json");
        assert_eq!(frame["id"], "req-4");
    }

    #[tokio::test]
    async fn settings_get_with_bad_payload_replies_invalid_json() {
        let pool = fresh_pool().await;
        let frames = drive(&pool, r#"{"type":"settings_get","id":123}"#).await;
        let frame = &frames[0];
        assert_eq!(frame["type"], "error");
        assert_eq!(frame["kind"], "invalid_json");
        // The first parse only echoes string `id`s; a numeric id is
        // dropped on the way to the typed parse — mirrors the desktop
        // bridge behaviour.
        assert!(frame.get("id").is_none());
    }

    #[tokio::test]
    async fn project_get_with_missing_project_id_replies_invalid_json() {
        let pool = fresh_pool().await;
        let frames = drive(&pool, r#"{"type":"project_get","id":"r"}"#).await;
        let frame = &frames[0];
        assert_eq!(frame["type"], "error");
        assert_eq!(frame["kind"], "invalid_json");
        assert_eq!(frame["id"], "r");
    }

    // ---- T19.26 unit tests (mirroring src-tauri/src/ws/pty_bridge.rs) ----

    #[test]
    fn decode_b64_handles_padded_and_unpadded() {
        assert_eq!(decode_b64("aGk=").unwrap(), b"hi");
        assert_eq!(decode_b64("aGk").unwrap(), b"hi");
    }

    #[test]
    fn decode_b64_rejects_garbage() {
        assert!(decode_b64("!!!not-base64!!!").is_err());
    }

    #[test]
    fn pty_error_to_kind_maps_all_variants() {
        let pairs: Vec<(PtyError, &str)> = vec![
            (PtyError::CwdMissing(PathBuf::from("/x")), "cwd_missing"),
            (PtyError::CommandNotFound("x".into()), "command_not_found"),
            (PtyError::OpenPty("x".into()), "spawn_failed"),
            (PtyError::Spawn("x".into()), "spawn_failed"),
            (PtyError::Writer("x".into()), "spawn_failed"),
            (PtyError::WriteIo("x".into()), "write_failed"),
            (PtyError::WriteToClosed(Uuid::nil()), "write_to_closed"),
            (PtyError::ResizeIo("x".into()), "resize_failed"),
            (PtyError::NotFound(Uuid::nil()), "not_found"),
            (PtyError::LockPoisoned, "internal"),
            (PtyError::ReaderPanic(Uuid::nil()), "reader_panic"),
        ];
        for (error, expected) in pairs {
            let (kind, _) = pty_error_to_kind(&error);
            assert_eq!(kind, expected, "{error:?}");
        }
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pty_spawn_write_and_receive_output() {
        let pool = fresh_pool().await;
        let (out_tx, mut out_rx) = mpsc::channel::<String>(64);
        let mut conn = fresh_conn(out_tx);

        // Drive through handle_text so the dispatcher's routing is
        // exercised end-to-end (typed parse + spawn arm).
        handle_text(
            &mut conn,
            &pool,
            r#"{"type":"pty_spawn","id":"spawn-1","command":"/bin/sh","args":["-c","echo HELLO_FROM_CLOUD; sleep 30"],"cols":80,"rows":24}"#,
        )
        .await;

        let first = tokio::time::timeout(Duration::from_secs(3), out_rx.recv())
            .await
            .expect("timed out waiting for pty_spawned")
            .expect("channel closed");
        assert!(first.contains(r#""type":"pty_spawned""#), "got {first}");

        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let mut decoded_stream: Vec<u8> = Vec::new();
        while tokio::time::Instant::now() < deadline {
            let recv = tokio::time::timeout(Duration::from_millis(500), out_rx.recv()).await;
            match recv {
                Ok(Some(frame)) => {
                    let parsed: serde_json::Value = match serde_json::from_str(&frame) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    if parsed.get("type").and_then(|v| v.as_str()) != Some("pty_output") {
                        continue;
                    }
                    if let Some(b64) = parsed.get("data").and_then(|v| v.as_str()) {
                        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) {
                            decoded_stream.extend_from_slice(&bytes);
                            if decoded_stream
                                .windows(b"HELLO_FROM_CLOUD".len())
                                .any(|w| w == b"HELLO_FROM_CLOUD")
                            {
                                break;
                            }
                        }
                    }
                }
                Ok(None) => break,
                Err(_) => {}
            }
        }
        assert!(
            decoded_stream
                .windows(b"HELLO_FROM_CLOUD".len())
                .any(|w| w == b"HELLO_FROM_CLOUD"),
            "never saw HELLO_FROM_CLOUD in output stream ({} bytes received)",
            decoded_stream.len()
        );

        // Tear the session down so the test doesn't leave a 30s sleep
        // child orphaned.
        let parsed: serde_json::Value = serde_json::from_str(&first).unwrap();
        let session_id: Uuid =
            serde_json::from_value(parsed["session_id"].clone()).expect("session_id");
        handle_kill(&mut conn, None, session_id).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pty_spawn_with_empty_command_replies_invalid_args() {
        let pool = fresh_pool().await;
        let (out_tx, mut out_rx) = mpsc::channel::<String>(8);
        let mut conn = fresh_conn(out_tx);

        handle_text(
            &mut conn,
            &pool,
            r#"{"type":"pty_spawn","id":"x","command":"   ","cols":80,"rows":24}"#,
        )
        .await;

        let frame = out_rx.recv().await.expect("frame");
        assert!(frame.contains(r#""type":"pty_error""#), "got {frame}");
        assert!(frame.contains(r#""kind":"invalid_args""#), "got {frame}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pty_spawn_with_zero_dims_replies_invalid_args() {
        let pool = fresh_pool().await;
        let (out_tx, mut out_rx) = mpsc::channel::<String>(8);
        let mut conn = fresh_conn(out_tx);

        handle_text(
            &mut conn,
            &pool,
            r#"{"type":"pty_spawn","id":"x","command":"/bin/sh","cols":0,"rows":24}"#,
        )
        .await;

        let frame = out_rx.recv().await.expect("frame");
        assert!(frame.contains(r#""kind":"invalid_args""#), "got {frame}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pty_write_with_invalid_base64_returns_error() {
        let (out_tx, mut out_rx) = mpsc::channel::<String>(8);
        let conn = fresh_conn(out_tx);

        handle_write(&conn, Some("w-1".into()), Uuid::nil(), "$$not-base64$$").await;

        let frame = out_rx.recv().await.expect("frame");
        assert!(frame.contains(r#""type":"pty_error""#), "got {frame}");
        assert!(frame.contains(r#""kind":"invalid_args""#), "got {frame}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pty_resize_zero_dims_returns_error() {
        let (out_tx, mut out_rx) = mpsc::channel::<String>(8);
        let conn = fresh_conn(out_tx);

        handle_resize(&conn, Some("r-1".into()), Uuid::nil(), 0, 24).await;
        let frame = out_rx.recv().await.expect("frame");
        assert!(frame.contains(r#""kind":"invalid_args""#), "got {frame}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pty_subscribe_unknown_session_returns_not_found() {
        let (out_tx, mut out_rx) = mpsc::channel::<String>(8);
        let mut conn = fresh_conn(out_tx);

        handle_subscribe(&mut conn, Some("s-1".into()), Uuid::nil()).await;
        let frame = out_rx.recv().await.expect("frame");
        assert!(frame.contains(r#""kind":"not_found""#), "got {frame}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pty_unsubscribe_unknown_session_acks() {
        let pool = fresh_pool().await;
        let (out_tx, mut out_rx) = mpsc::channel::<String>(8);
        let mut conn = fresh_conn(out_tx);

        // unsubscribe is fire-and-forget — even for an unknown session
        // we ack so the PWA doesn't have to special-case races between
        // its own session teardown and the agent's session removal.
        handle_text(
            &mut conn,
            &pool,
            r#"{"type":"pty_unsubscribe","id":"u-1","session_id":"00000000-0000-0000-0000-000000000000"}"#,
        )
        .await;
        let frame = out_rx.recv().await.expect("frame");
        assert!(frame.contains(r#""type":"pty_ack""#), "got {frame}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn pty_kill_unknown_session_returns_not_found() {
        let (out_tx, mut out_rx) = mpsc::channel::<String>(8);
        let mut conn = fresh_conn(out_tx);

        handle_kill(&mut conn, Some("k-1".into()), Uuid::nil()).await;
        let frame = out_rx.recv().await.expect("frame");
        assert!(frame.contains(r#""type":"pty_error""#), "got {frame}");
        assert!(frame.contains(r#""kind":"not_found""#), "got {frame}");
    }
}
