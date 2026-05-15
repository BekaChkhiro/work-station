// T18.6 docs reference `PlanFlow` (CamelCase) and other bare proper
// nouns; backticking each mention hurts readability. Allow doc_markdown.
#![allow(clippy::doc_markdown)]

//! PTY-over-WebSocket bridge handler (T18.3).
//!
//! One [`run_connection`] task per authenticated WebSocket. The task
//! splits the socket into a read half (incoming `ClientMessage`s) and a
//! write half (outbound `ServerMessage` JSON frames), funnelling all
//! outbound writes through a single [`tokio::sync::mpsc`] so the
//! per-session output forwarders and the request/response replies can
//! produce frames concurrently without contending on the WebSocket
//! sink.
//!
//! Per attached session we hold a [`tokio::sync::broadcast::Receiver`]
//! that taps the same channel desktop subscribers use (see
//! `pty/session.rs` `output_tx`). The forwarder task base64-encodes
//! each output chunk into a `pty_output` frame and ships it on the
//! shared outbound mpsc. When the broadcast closes (child exited, or
//! the session was killed) we send `pty_exit` and tear down the
//! forwarder; if the WebSocket sink itself dies we cancel every
//! outstanding forwarder and exit the connection task.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket};
use base64::Engine;
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use sqlx::sqlite::SqlitePool;
use tokio::sync::{broadcast, mpsc};
use tokio::task::JoinHandle;
use uuid::Uuid;

use crate::pty::{spawn_reader, PtyError, PtyManager, SpawnConfig};

use super::chat_bridge;
use super::planflow_bridge::{self, PlanflowState};
use super::projects_bridge::{self, AppEvents};
use super::protocol::{ClientMessage, ServerMessage, KNOWN_CLIENT_TYPES};
use super::system_monitor::{StatsSnapshot, SystemMonitorHandle};

/// Capacity for the per-connection outbound mpsc.
///
/// One forwarder per session + the request-reply lane all push here;
/// 256 is wide enough to absorb a burst from `cat huge.log` without
/// dropping frames while still applying backpressure if the WebSocket
/// peer stalls.
const OUTBOUND_CHANNEL_CAPACITY: usize = 256;

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
            return true; // already streaming
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

/// Run a single authenticated WebSocket connection until the client
/// disconnects or the socket errors.
///
/// `manager` is the app-scoped [`PtyManager`] — cloning the wrapper is
/// cheap (it's an `Arc` internally) so each connection gets its own
/// handle. `pool` and `events` are passed through to the projects /
/// settings bridge (T18.4); pty handlers ignore them, so adding them
/// here doesn't bloat per-session PTY state. `monitor` is the
/// app-scoped system-stats broadcaster (T18.5); we subscribe once per
/// connection and a dedicated task forwards every snapshot through
/// the shared outbound mpsc.
pub async fn run_connection(
    socket: WebSocket,
    manager: PtyManager,
    pool: SqlitePool,
    events: Arc<dyn AppEvents>,
    monitor: SystemMonitorHandle,
    planflow: Option<PlanflowState>,
) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<String>(OUTBOUND_CHANNEL_CAPACITY);

    // Outbound pump: drains the mpsc into the WebSocket sink as text
    // frames. Exits cleanly when the mpsc closes (every Sender dropped)
    // or when a send to the sink errors.
    let sink_task = tokio::spawn(async move {
        while let Some(payload) = out_rx.recv().await {
            if ws_tx.send(Message::Text(payload)).await.is_err() {
                break;
            }
        }
        // Best-effort close — if the peer already hung up this errors,
        // which we ignore.
        let _ = ws_tx.close().await;
    });

    // T18.5 — subscribe to the shared system-stats broadcaster and run
    // a forwarder that ships each snapshot through the same outbound
    // mpsc as PTY frames. The handle is held in `_stats_forwarder` so
    // it's aborted when the connection task drops, mirroring how the
    // per-session forwarders are torn down via `Connection::drop`.
    let stats_forwarder = tokio::spawn(forward_stats(monitor.subscribe(), out_tx.clone()));

    let mut conn = Connection::new(manager, out_tx);

    while let Some(frame) = ws_rx.next().await {
        let Ok(msg) = frame else {
            // Underlying transport error — bail; sink_task will tear
            // down on the next pump iteration.
            break;
        };
        match msg {
            Message::Text(payload) => {
                handle_text(&mut conn, &payload, &pool, &events, planflow.as_ref()).await;
            }
            Message::Binary(_) => {
                // Binary frames aren't part of the protocol; reply with
                // a typed error so a misbehaving client gets a usable
                // diagnostic instead of a silent drop.
                let err = ServerMessage::error(
                    None,
                    "invalid_frame",
                    "binary frames are not supported on this connection",
                );
                send(&conn.out_tx, &err).await;
            }
            Message::Ping(_) | Message::Pong(_) => {
                // axum responds to pings automatically; pong frames are
                // ignored.
            }
            Message::Close(_) => break,
        }
    }

    drop(conn); // aborts per-session forwarders
                // Stop the system-stats forwarder before the mpsc senders
                // it holds get dropped — otherwise its next `send` would
                // hit a closed channel and log a noisy error.
    stats_forwarder.abort();
    // Closing the mpsc sender drains the sink_task; await it for a
    // clean WebSocket close.
    let _ = sink_task.await;
}

/// Forward every broadcast snapshot to the per-connection outbound
/// mpsc as a `system_stats` JSON frame. Exits when the broadcast
/// closes (monitor task panicked) or the mpsc receiver is dropped.
///
/// On `Lagged` we deliberately drop the missed snapshots and keep
/// going — stats are time-series, replaying old samples would just
/// stall the UI with stale data. The PWA will see a fresh snapshot on
/// the next live tick.
async fn forward_stats(mut rx: broadcast::Receiver<StatsSnapshot>, out_tx: mpsc::Sender<String>) {
    loop {
        match rx.recv().await {
            Ok(snapshot) => {
                let frame = snapshot.into_message();
                if let Ok(payload) = serde_json::to_string(&frame) {
                    if out_tx.send(payload).await.is_err() {
                        return; // peer gone — connection task is tearing down
                    }
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => {
                // Skip stale frames; the next `recv` lands on the freshest one.
            }
            Err(broadcast::error::RecvError::Closed) => {
                return;
            }
        }
    }
}

async fn handle_text(
    conn: &mut Connection,
    payload: &str,
    pool: &SqlitePool,
    events: &Arc<dyn AppEvents>,
    planflow: Option<&PlanflowState>,
) {
    // Two-phase parse so we can distinguish "unknown message type"
    // (T18.4: reply `error{kind: "unsupported"}`) from "malformed
    // payload for a known type" (`invalid_json`). Routing on the raw
    // `type` string also lets us forward the request's `id` back on
    // either failure path so PWA promises resolve cleanly.
    let value: serde_json::Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(error) => {
            let err = ServerMessage::Error {
                id: None,
                kind: "invalid_json".into(),
                message: format!("failed to parse client message: {error}"),
            };
            send_value(&conn.out_tx, &err).await;
            return;
        }
    };

    let echo_id = value.get("id").and_then(|v| v.as_str()).map(str::to_owned);
    let type_str = match value.get("type").and_then(|v| v.as_str()) {
        Some(t) => t,
        None => {
            let err = ServerMessage::Error {
                id: echo_id,
                kind: "invalid_json".into(),
                message: "missing required field `type`".into(),
            };
            send_value(&conn.out_tx, &err).await;
            return;
        }
    };

    if !KNOWN_CLIENT_TYPES.contains(&type_str) {
        let err = ServerMessage::Error {
            id: echo_id,
            kind: "unsupported".into(),
            message: format!("unknown message type: {type_str}"),
        };
        send_value(&conn.out_tx, &err).await;
        return;
    }

    let msg = match serde_json::from_value::<ClientMessage>(value) {
        Ok(msg) => msg,
        Err(error) => {
            let err = ServerMessage::Error {
                id: echo_id,
                kind: "invalid_json".into(),
                message: format!("failed to parse client message: {error}"),
            };
            send_value(&conn.out_tx, &err).await;
            return;
        }
    };

    match msg {
        ClientMessage::PtySpawn {
            id,
            command,
            args,
            cwd,
            env,
            cols,
            rows,
        } => {
            // When the client doesn't provide a cwd (the mobile PWA
            // never does), fall back to the desktop's active project
            // path so the shell opens where the user expects.
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
        ClientMessage::ProjectsList { id } => {
            projects_bridge::handle_projects_list(&conn.out_tx, pool, id).await;
        }
        ClientMessage::ProjectGet { id, project_id } => {
            projects_bridge::handle_project_get(&conn.out_tx, pool, id, project_id).await;
        }
        ClientMessage::ProjectSwitch { id, project_id } => {
            projects_bridge::handle_project_switch(&conn.out_tx, pool, events, id, project_id)
                .await;
        }
        ClientMessage::SettingsGet { id } => {
            projects_bridge::handle_settings_get(&conn.out_tx, pool, id).await;
        }
        // T18.6 — PlanFlow Tasks bridge dispatch. Each arm forwards to
        // a sibling-module handler which proxies the REST call through
        // `http::Client` (retries + cache) using the OS-keychain-stored
        // PlanFlow API token.
        ClientMessage::PlanflowGetMe { id } => {
            dispatch_planflow(&conn.out_tx, planflow, id, |state, tx, id| async move {
                planflow_bridge::handle_get_me(&state, &tx, id).await;
            })
            .await;
        }
        ClientMessage::PlanflowListProjects {
            id,
            organization_id,
        } => {
            dispatch_planflow(
                &conn.out_tx,
                planflow,
                id,
                move |state, tx, id| async move {
                    planflow_bridge::handle_list_projects(&state, &tx, id, organization_id).await;
                },
            )
            .await;
        }
        ClientMessage::PlanflowListTasks {
            id,
            project_id,
            status,
        } => {
            dispatch_planflow(
                &conn.out_tx,
                planflow,
                id,
                move |state, tx, id| async move {
                    planflow_bridge::handle_list_tasks(&state, &tx, id, project_id, status).await;
                },
            )
            .await;
        }
        ClientMessage::PlanflowListActiveWork { id, project_id } => {
            dispatch_planflow(
                &conn.out_tx,
                planflow,
                id,
                move |state, tx, id| async move {
                    planflow_bridge::handle_list_active_work(&state, &tx, id, project_id).await;
                },
            )
            .await;
        }
        ClientMessage::PlanflowListComments {
            id,
            project_id,
            task_id,
        } => {
            dispatch_planflow(
                &conn.out_tx,
                planflow,
                id,
                move |state, tx, id| async move {
                    planflow_bridge::handle_list_comments(&state, &tx, id, project_id, task_id)
                        .await;
                },
            )
            .await;
        }
        ClientMessage::PlanflowCreateComment {
            id,
            project_id,
            task_id,
            body,
        } => {
            dispatch_planflow(
                &conn.out_tx,
                planflow,
                id,
                move |state, tx, id| async move {
                    planflow_bridge::handle_create_comment(
                        &state, &tx, id, project_id, task_id, body,
                    )
                    .await;
                },
            )
            .await;
        }
        ClientMessage::PlanflowStartWork {
            id,
            project_id,
            task_id,
        } => {
            dispatch_planflow(
                &conn.out_tx,
                planflow,
                id,
                move |state, tx, id| async move {
                    planflow_bridge::handle_start_work(&state, &tx, id, project_id, task_id).await;
                },
            )
            .await;
        }
        ClientMessage::PlanflowStopWork { id, project_id } => {
            dispatch_planflow(
                &conn.out_tx,
                planflow,
                id,
                move |state, tx, id| async move {
                    planflow_bridge::handle_stop_work(&state, &tx, id, project_id).await;
                },
            )
            .await;
        }
        ClientMessage::PlanflowUpdateTaskStatus {
            id,
            project_id,
            task_id,
            status,
        } => {
            dispatch_planflow(
                &conn.out_tx,
                planflow,
                id,
                move |state, tx, id| async move {
                    planflow_bridge::handle_update_task_status(
                        &state, &tx, id, project_id, task_id, status,
                    )
                    .await;
                },
            )
            .await;
        }
        ClientMessage::PlanflowChatSend {
            id,
            project_id,
            content,
        } => {
            chat_bridge::handle_chat_send(&conn.out_tx, pool, events, id, project_id, content)
                .await;
        }
        ClientMessage::PlanflowChatHistory {
            id,
            project_id,
            limit,
        } => {
            chat_bridge::handle_chat_history(&conn.out_tx, pool, id, project_id, limit).await;
        }
        ClientMessage::PlanflowChatClear { id, project_id } => {
            chat_bridge::handle_chat_clear(&conn.out_tx, pool, id, project_id).await;
        }
        // T19.27 — `fs_*` are served by the cloud-agent's path-jailed
        // handler. The desktop's WS bridge intentionally stays out of
        // FS land: the PWA's `routeIpcLocalOnly` policy (T19.11)
        // already pins editor reads/writes to Tauri commands when the
        // user is on a desktop project, so a request arriving here
        // would be a routing bug. Reply with `unimplemented` so the
        // PWA surfaces a typed error instead of silently dropping.
        ClientMessage::FsList { id, .. }
        | ClientMessage::FsRead { id, .. }
        | ClientMessage::FsWrite { id, .. }
        | ClientMessage::FsDelete { id, .. } => {
            let err = ServerMessage::Error {
                id,
                kind: "unimplemented".into(),
                message: "fs_* is only available on the cloud-agent bridge".into(),
            };
            send_value(&conn.out_tx, &err).await;
        }
    }
}

/// Dispatch a PlanFlow client message to its handler, replying with a
/// stable `planflow_error{kind:"unavailable"}` when the bridge state
/// isn't available (boot-time HTTP-client failure). Keeping this in
/// one helper means every PlanFlow arm gets the same fallback without
/// duplicating the `Option` match.
async fn dispatch_planflow<F, Fut>(
    out_tx: &mpsc::Sender<String>,
    planflow: Option<&PlanflowState>,
    id: Option<String>,
    run: F,
) where
    F: FnOnce(PlanflowState, mpsc::Sender<String>, Option<String>) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    match planflow {
        Some(state) => run(state.clone(), out_tx.clone(), id).await,
        None => {
            let msg = ServerMessage::planflow_error(
                id,
                "unavailable",
                "planflow bridge is not configured on this server",
                None,
            );
            send_value(out_tx, &msg).await;
        }
    }
}

/// Like [`send`] but accepts any [`ServerMessage`] (including the new
/// generic `Error` variant) — the helper at the bottom of the module
/// is kept as an alias so the pty-side call sites don't need to change.
async fn send_value(out_tx: &mpsc::Sender<String>, msg: &ServerMessage) {
    if let Ok(payload) = serde_json::to_string(msg) {
        let _ = out_tx.send(payload).await;
    }
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
            let id = manager.spawn(config)?;
            if let Some(session) = manager.get(id) {
                spawn_reader(manager.clone(), &session);
            }
            Ok(id)
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

/// Resolve the active project's filesystem path so a `pty_spawn` with
/// no explicit `cwd` lands in the same folder a desktop terminal would.
/// Returns `None` when no project is active or the lookup fails — the
/// caller treats that as "use PtyManager's default" (the user's home).
async fn active_project_cwd(pool: &SqlitePool) -> Option<PathBuf> {
    let project_id: String =
        crate::db::app_settings::get_json(pool, crate::db::app_settings::LAST_ACTIVE_PROJECT_KEY)
            .await
            .ok()
            .flatten()?;
    let project = crate::db::projects::get(pool, &project_id).await.ok()?;
    Some(PathBuf::from(project.path))
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
    let result = tokio::task::spawn_blocking(move || manager.resize(session_id, cols, rows)).await;
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
    // Drop our forwarder ahead of the kill so the per-session
    // broadcast can close cleanly without racing the abort.
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
/// WebSocket outbound mpsc, exiting on `Closed` (child gone). On a
/// lag event the broadcast skips frames and reports the count; we
/// forward the next live frame as normal — desktop subscribers handle
/// the same case via the backpressure counters, and the PWA replays
/// scrollback to recover.
/// Cap on a single coalesced `pty_output` frame so a runaway producer
/// (e.g. `cat huge.bin`) can't pin the WebSocket pump on one giant
/// base64 payload. 64 KiB leaves plenty of room for natural bursts
/// (most prompt repaints + ANSI clears fit in <4 KiB) without letting
/// pathological cases monopolise a frame.
const PTY_COALESCE_CAP_BYTES: usize = 64 * 1024;

async fn forward_output(
    session_id: Uuid,
    mut rx: broadcast::Receiver<Bytes>,
    out_tx: mpsc::Sender<String>,
) {
    loop {
        match rx.recv().await {
            Ok(first) => {
                // Opportunistic batching: if the producer has already
                // emitted more chunks before the WebSocket pump woke
                // up, drain them into one frame. This is the common
                // case for interactive CLIs (Claude, codex) which emit
                // many small chunks per visible "line" — without
                // coalescing every chunk became a separate base64+JSON
                // WS frame, and over a Cloudflare quick tunnel each
                // extra round-trip turned scrollback into a slideshow.
                let mut combined: Vec<u8> = Vec::with_capacity(first.len());
                combined.extend_from_slice(&first);
                while combined.len() < PTY_COALESCE_CAP_BYTES {
                    match rx.try_recv() {
                        Ok(more) => combined.extend_from_slice(&more),
                        Err(broadcast::error::TryRecvError::Empty) => break,
                        Err(broadcast::error::TryRecvError::Lagged(_)) => {
                            // Burned chunks; the *next* `try_recv` will
                            // either return a real frame or Empty. The
                            // PWA replays scrollback if it cares.
                            continue;
                        }
                        Err(broadcast::error::TryRecvError::Closed) => {
                            // Will be observed by the next blocking
                            // `rx.recv().await` at the top of the loop.
                            break;
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
                // Drop continues — the next `recv` gives us the freshest
                // frame. PWA recovers via scrollback if needed.
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

async fn send(out_tx: &mpsc::Sender<String>, msg: &ServerMessage) {
    if let Ok(payload) = serde_json::to_string(msg) {
        // If the receiver was dropped the connection is already going
        // away — swallow the error and let the parent task tear down.
        let _ = out_tx.send(payload).await;
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

#[cfg(test)]
mod tests {
    use super::*;

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

    /// End-to-end-ish: spawn a real shell that prints a known string,
    /// drive it through the bridge handler, and assert the output
    /// frame round-trips with the same bytes.
    #[cfg(unix)]
    #[tokio::test]
    async fn spawn_write_and_receive_output() {
        use std::time::Duration;

        let manager = PtyManager::new();
        let (out_tx, mut out_rx) = mpsc::channel::<String>(64);
        let mut conn = Connection::new(manager, out_tx);

        // Spawn a real shell — we use /bin/sh -c 'echo hi; sleep 30' so
        // the session stays alive long enough to read the output.
        handle_spawn(
            &mut conn,
            Some("spawn-1".into()),
            "/bin/sh".into(),
            vec!["-c".into(), "echo HELLO_FROM_PTY; sleep 30".into()],
            None,
            HashMap::new(),
            80,
            24,
        )
        .await;

        // First frame must be PtySpawned.
        let first = tokio::time::timeout(Duration::from_secs(3), out_rx.recv())
            .await
            .expect("timed out waiting for pty_spawned")
            .expect("channel closed");
        assert!(first.contains(r#""type":"pty_spawned""#), "got {first}");

        // Drain pty_output frames, base64-decode their `data`, and look
        // for HELLO_FROM_PTY in the concatenated bytes. A substring
        // search on the raw base64 is unreliable — base64 boundaries
        // depend on alignment, so the same plaintext can encode to
        // different ASCII when split across chunks.
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
                                .windows(b"HELLO_FROM_PTY".len())
                                .any(|w| w == b"HELLO_FROM_PTY")
                            {
                                break;
                            }
                        }
                    }
                }
                Ok(None) => break,
                Err(_) => {} // timer tick, keep waiting
            }
        }
        assert!(
            decoded_stream
                .windows(b"HELLO_FROM_PTY".len())
                .any(|w| w == b"HELLO_FROM_PTY"),
            "never saw HELLO_FROM_PTY in output stream ({} bytes received)",
            decoded_stream.len()
        );

        // Clean up: pull the session id out of the spawned frame so we
        // can kill it.
        let parsed: serde_json::Value = serde_json::from_str(&first).unwrap();
        let session_id: Uuid = serde_json::from_value(parsed["session_id"].clone()).unwrap();
        handle_kill(&mut conn, None, session_id).await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn handle_write_with_invalid_base64_returns_error() {
        let manager = PtyManager::new();
        let (out_tx, mut out_rx) = mpsc::channel::<String>(8);
        let conn = Connection::new(manager, out_tx);

        handle_write(&conn, Some("w-1".into()), Uuid::nil(), "$$not-base64$$").await;

        let frame = out_rx.recv().await.expect("frame");
        assert!(frame.contains(r#""type":"pty_error""#), "got {frame}");
        assert!(frame.contains(r#""kind":"invalid_args""#), "got {frame}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn handle_resize_zero_dims_returns_error() {
        let manager = PtyManager::new();
        let (out_tx, mut out_rx) = mpsc::channel::<String>(8);
        let conn = Connection::new(manager, out_tx);

        handle_resize(&conn, Some("r-1".into()), Uuid::nil(), 0, 24).await;
        let frame = out_rx.recv().await.expect("frame");
        assert!(frame.contains(r#""kind":"invalid_args""#), "got {frame}");
    }

    /// Test stub for `AppEvents` — the pty-bridge dispatch tests below
    /// don't exercise project-switch, but `handle_text` requires an
    /// `Arc<dyn AppEvents>` to compile, so we hand it a no-op.
    struct NoopEvents;
    impl AppEvents for NoopEvents {
        fn emit_active_project_changed(&self, _: Option<&str>) {}
    }

    async fn empty_pool() -> SqlitePool {
        sqlx::sqlite::SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite")
    }

    #[tokio::test]
    async fn handle_text_unknown_type_replies_with_unsupported() {
        let manager = PtyManager::new();
        let (out_tx, mut out_rx) = mpsc::channel::<String>(8);
        let mut conn = Connection::new(manager, out_tx);
        let pool = empty_pool().await;
        let events: Arc<dyn AppEvents> = Arc::new(NoopEvents);

        handle_text(
            &mut conn,
            r#"{"type":"definitely_not_a_real_type","id":"r1"}"#,
            &pool,
            &events,
            None,
        )
        .await;
        let frame = out_rx.recv().await.expect("frame");
        assert!(frame.contains(r#""type":"error""#), "got {frame}");
        assert!(frame.contains(r#""kind":"unsupported""#), "got {frame}");
        assert!(frame.contains(r#""id":"r1""#), "id must echo, got {frame}");
    }

    #[tokio::test]
    async fn handle_text_missing_type_replies_with_invalid_json() {
        let manager = PtyManager::new();
        let (out_tx, mut out_rx) = mpsc::channel::<String>(8);
        let mut conn = Connection::new(manager, out_tx);
        let pool = empty_pool().await;
        let events: Arc<dyn AppEvents> = Arc::new(NoopEvents);

        handle_text(&mut conn, r#"{"id":"r2"}"#, &pool, &events, None).await;
        let frame = out_rx.recv().await.expect("frame");
        assert!(frame.contains(r#""type":"error""#), "got {frame}");
        assert!(frame.contains(r#""kind":"invalid_json""#), "got {frame}");
        assert!(frame.contains(r#""id":"r2""#), "id must echo, got {frame}");
    }

    #[tokio::test]
    async fn handle_text_malformed_json_replies_with_invalid_json_no_id() {
        let manager = PtyManager::new();
        let (out_tx, mut out_rx) = mpsc::channel::<String>(8);
        let mut conn = Connection::new(manager, out_tx);
        let pool = empty_pool().await;
        let events: Arc<dyn AppEvents> = Arc::new(NoopEvents);

        handle_text(&mut conn, r#"{"type": broken"#, &pool, &events, None).await;
        let frame = out_rx.recv().await.expect("frame");
        assert!(frame.contains(r#""type":"error""#), "got {frame}");
        assert!(frame.contains(r#""kind":"invalid_json""#), "got {frame}");
    }
}
