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
//! so a single PWA branch table covers both backends. T19.27 wires
//! `fs_list` / `fs_read` / `fs_write` / `fs_delete` against the
//! cloud-agent's project-root allow-list — every path is canonicalised
//! against the project's `path` from SQLite, so a client can never
//! escape into the rest of the VPS filesystem. T19.28 attaches the
//! shared `system_monitor` broadcaster: every connected client receives
//! `system_stats` frames (cpu / ram / pty session count) on the same
//! cadence the desktop bridge already emits, so the PWA Monitor view
//! is backend-agnostic. T19.29 lights up the `planflow_*` proxy
//! variants — `planflow_get_me` / `list_projects` / `list_tasks` /
//! `list_active_work` / `list_comments` / `create_comment` /
//! `start_work` / `stop_work` / `update_task_status` — by forwarding
//! each call to PlanFlow's REST API through [`crate::planflow_proxy`].
//! The wire contract (`planflow_result` / `planflow_error` with a
//! stable `kind`) matches the desktop bridge so the PWA's client
//! branches solely on response type, never on which backend is
//! serving the request. `planflow_chat_*` stays desktop-only — those
//! route into a live PTY on the desktop side and have no analog here.
//!
//! The error taxonomy mirrors the desktop bridge so the PWA / desktop
//! client doesn't need a second branch table:
//!
//!   * `invalid_json`  — payload didn't parse, or `type` was missing.
//!   * `unsupported`   — `type` is a string we don't recognize at all.
//!   * `unimplemented` — `type` is known but the cloud-agent hasn't
//!     wired its handler yet (currently `planflow_chat_*` only).
//!   * `invalid_frame` — client sent a binary frame on a text-only wire.
//!   * `not_found`     — project id in the request doesn't exist.
//!   * `internal`      — SQLite or serialization failure.
//!   * `invalid_args`  — PTY request had a malformed argument
//!     (empty command, zero dim, undecodable base64).
//!   * `spawn_failed` / `command_not_found` / `cwd_missing` /
//!     `write_failed` / `write_to_closed` / `resize_failed` /
//!     `reader_panic` — PTY-specific failures bubbled up from
//!     `workstation_core::pty`.
//!   * `out_of_scope` / `not_a_directory` / `too_large` — FS-specific
//!     failures from the path-jail or size limits in [`crate::fs`].
//!   * `unauthorized` / `rate_limited` / `client` / `server` /
//!     `network` / `timeout` / `decode` / `no_credential` /
//!     `credential` — PlanFlow proxy failures from
//!     [`crate::planflow_proxy`].

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

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
    ClientMessage, ProjectCreateArgs, ProjectUpdateArgs, ServerMessage, SettingsView,
    KNOWN_CLIENT_TYPES,
};
use workstation_core::ws::system_monitor::{StatsSnapshot, SystemMonitorHandle};

use crate::db::{app_settings, projects};
use crate::fs::{self as cfs, FsError};
use crate::planflow_proxy::{self, PlanflowState};

/// Newtype around the cloud-agent's projects root path so axum's
/// `Extension` extractor can resolve it by type. Cloning is an Arc
/// bump, so the per-connection clone in `ws_handler` is cheap.
#[derive(Debug, Clone)]
pub struct ProjectsRoot(pub Arc<PathBuf>);

impl ProjectsRoot {
    #[must_use]
    pub fn new(path: PathBuf) -> Self {
        Self(Arc::new(path))
    }

    #[must_use]
    pub fn as_path(&self) -> &Path {
        self.0.as_path()
    }
}

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
pub async fn run_connection(
    socket: WebSocket,
    manager: PtyManager,
    pool: SqlitePool,
    monitor: SystemMonitorHandle,
    planflow: PlanflowState,
    projects_root: ProjectsRoot,
) {
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

    // T19.28 — subscribe to the shared system-stats broadcaster and run
    // a forwarder that ships each snapshot through the same outbound
    // mpsc as PTY frames. Mirrors the desktop bridge's per-connection
    // hook so the PWA sees `system_stats` frames over the cloud-agent's
    // socket without any client-side branching.
    let stats_forwarder = tokio::spawn(forward_stats(monitor.subscribe(), out_tx.clone()));

    let mut conn = Connection::new(manager, out_tx);

    while let Some(frame) = ws_rx.next().await {
        let Ok(msg) = frame else {
            break;
        };
        match msg {
            Message::Text(payload) => {
                handle_text(&mut conn, &pool, &planflow, &projects_root, &payload).await;
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
                // Stop the system-stats forwarder before its mpsc Sender
                // gets dropped — otherwise its next `send` would race
                // with sink_task tearing the channel down.
    stats_forwarder.abort();
    let _ = sink_task.await;
}

/// Forward every broadcast snapshot to the per-connection outbound
/// mpsc as a `system_stats` JSON frame. Exits when the broadcast
/// closes (monitor task panicked — should never happen in practice)
/// or the mpsc receiver is dropped (peer gone).
///
/// On `Lagged` we deliberately drop the missed snapshots and keep
/// going — stats are time-series, replaying old samples would just
/// stall the UI with stale data. The next live tick fills the gap.
async fn forward_stats(mut rx: broadcast::Receiver<StatsSnapshot>, out_tx: mpsc::Sender<String>) {
    loop {
        match rx.recv().await {
            Ok(snapshot) => {
                let frame = snapshot.into_message();
                if let Ok(payload) = serde_json::to_string(&frame) {
                    if out_tx.send(payload).await.is_err() {
                        return;
                    }
                }
            }
            Err(broadcast::error::RecvError::Lagged(_)) => {}
            Err(broadcast::error::RecvError::Closed) => return,
        }
    }
}

/// Two-phase parse so we can echo `id` on every failure path and
/// distinguish "unknown message type" (`unsupported`) from "malformed
/// payload for a known type" (`invalid_json`). Mirrors the desktop
/// bridge's `super::ws::pty_bridge::handle_text` flow.
async fn handle_text(
    conn: &mut Connection,
    pool: &SqlitePool,
    planflow: &PlanflowState,
    projects_root: &ProjectsRoot,
    payload: &str,
) {
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
        "settings_get" | "projects_list" | "project_get" | "project_switch" | "project_create"
        | "project_update" | "project_delete" | "project_reorder"
        | "project_update_workspace_tabs" | "pty_spawn" | "pty_write" | "pty_resize"
        | "pty_kill" | "pty_scrollback" | "pty_subscribe" | "pty_unsubscribe" | "fs_list"
        | "fs_read" | "fs_write" | "fs_delete" | "planflow_get_me" | "planflow_list_projects"
        | "planflow_list_tasks" | "planflow_list_active_work" | "planflow_list_comments"
        | "planflow_create_comment" | "planflow_start_work" | "planflow_stop_work"
        | "planflow_update_task_status" => {
            match serde_json::from_value::<ClientMessage>(value) {
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
            }
        }
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

    dispatch_typed(conn, pool, planflow, projects_root, typed).await;
}

/// Route a parsed [`ClientMessage`] to its handler. Split out of
/// [`handle_text`] so the two-phase parse + typed dispatch don't
/// balloon a single function past clippy's `too_many_lines` cap, and
/// so unit tests can drive a handler from a synthetic typed message
/// without re-serialising it through `handle_text`.
///
/// Each per-variant arm is intentionally a one-line forward to a
/// dedicated handler, so growing past the default lint cap is the
/// expected shape — splitting further would add ceremony without
/// shrinking any individual arm.
#[allow(clippy::too_many_lines)]
async fn dispatch_typed(
    conn: &mut Connection,
    pool: &SqlitePool,
    planflow: &PlanflowState,
    projects_root: &ProjectsRoot,
    typed: ClientMessage,
) {
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
        ClientMessage::ProjectCreate { id, args } => {
            handle_project_create(&conn.out_tx, pool, projects_root, id, args).await;
        }
        ClientMessage::ProjectUpdate { id, args } => {
            handle_project_update(&conn.out_tx, pool, id, args).await;
        }
        ClientMessage::ProjectDelete { id, project_id } => {
            handle_project_delete(&conn.out_tx, pool, id, project_id).await;
        }
        ClientMessage::ProjectReorder { id, ids } => {
            handle_project_reorder(&conn.out_tx, pool, id, ids).await;
        }
        ClientMessage::ProjectUpdateWorkspaceTabs {
            id,
            project_id,
            visible,
            active,
        } => {
            handle_project_update_workspace_tabs(
                &conn.out_tx,
                pool,
                id,
                project_id,
                visible,
                active,
            )
            .await;
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
        ClientMessage::FsList {
            id,
            project_id,
            relative_path,
            respect_gitignore,
        } => {
            handle_fs_list(
                &conn.out_tx,
                pool,
                id,
                project_id,
                relative_path.unwrap_or_default(),
                respect_gitignore.unwrap_or(true),
            )
            .await;
        }
        ClientMessage::FsRead {
            id,
            project_id,
            relative_path,
        } => {
            handle_fs_read(&conn.out_tx, pool, id, project_id, relative_path).await;
        }
        ClientMessage::FsWrite {
            id,
            project_id,
            relative_path,
            content,
            encoding,
        } => {
            handle_fs_write(
                &conn.out_tx,
                pool,
                id,
                project_id,
                relative_path,
                content,
                encoding.unwrap_or_else(|| "utf-8".to_string()),
            )
            .await;
        }
        ClientMessage::FsDelete {
            id,
            project_id,
            relative_path,
        } => {
            handle_fs_delete(&conn.out_tx, pool, id, project_id, relative_path).await;
        }
        // T19.29 — PlanFlow proxy. Each handler forwards to PlanFlow's
        // REST API and ships back a `planflow_result` / `planflow_error`
        // frame with the same kind taxonomy the desktop bridge uses, so
        // the PWA client doesn't need a per-backend branch.
        ClientMessage::PlanflowGetMe { id } => {
            planflow_proxy::handle_get_me(planflow, &conn.out_tx, id).await;
        }
        ClientMessage::PlanflowListProjects {
            id,
            organization_id,
        } => {
            planflow_proxy::handle_list_projects(planflow, &conn.out_tx, id, organization_id).await;
        }
        ClientMessage::PlanflowListTasks {
            id,
            project_id,
            status,
        } => {
            planflow_proxy::handle_list_tasks(planflow, &conn.out_tx, id, project_id, status).await;
        }
        ClientMessage::PlanflowListActiveWork { id, project_id } => {
            planflow_proxy::handle_list_active_work(planflow, &conn.out_tx, id, project_id).await;
        }
        ClientMessage::PlanflowListComments {
            id,
            project_id,
            task_id,
        } => {
            planflow_proxy::handle_list_comments(planflow, &conn.out_tx, id, project_id, task_id)
                .await;
        }
        ClientMessage::PlanflowCreateComment {
            id,
            project_id,
            task_id,
            body,
        } => {
            planflow_proxy::handle_create_comment(
                planflow,
                &conn.out_tx,
                id,
                project_id,
                task_id,
                body,
            )
            .await;
        }
        ClientMessage::PlanflowStartWork {
            id,
            project_id,
            task_id,
        } => {
            planflow_proxy::handle_start_work(planflow, &conn.out_tx, id, project_id, task_id)
                .await;
        }
        ClientMessage::PlanflowStopWork { id, project_id } => {
            planflow_proxy::handle_stop_work(planflow, &conn.out_tx, id, project_id).await;
        }
        ClientMessage::PlanflowUpdateTaskStatus {
            id,
            project_id,
            task_id,
            status,
        } => {
            planflow_proxy::handle_update_task_status(
                planflow,
                &conn.out_tx,
                id,
                project_id,
                task_id,
                status,
            )
            .await;
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
async fn handle_settings_get(out_tx: &mpsc::Sender<String>, pool: &SqlitePool, id: Option<String>) {
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
            let projects =
                serde_json::to_value(rows).expect("Project list always serializes to JSON");
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
            let project = serde_json::to_value(project).expect("Project always serializes to JSON");
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

async fn handle_project_create(
    out_tx: &mpsc::Sender<String>,
    pool: &SqlitePool,
    projects_root: &ProjectsRoot,
    id: Option<String>,
    args: ProjectCreateArgs,
) {
    // Cloud-mode "New Project" only collects a name in the most common
    // flow — the dialog leaves the path empty so the agent decides
    // where the project lives on its own filesystem. We resolve here
    // (rather than inside `projects::create`) so the existing
    // strict-validation semantics for absolute paths keep working
    // unchanged.
    let path = match resolve_create_path(&args.name, &args.path, projects_root) {
        Ok(p) => p,
        Err(error) => {
            send(out_tx, &project_error_to_frame(id, &error)).await;
            return;
        }
    };

    let input = projects::NewProject {
        name: args.name,
        path,
        color: args.color,
        icon: args.icon,
        default_cli: args.default_cli,
        env: args.env,
        startup_commands: args.startup_commands,
    };
    match projects::create(pool, input).await {
        Ok(project) => {
            let project = serde_json::to_value(project).expect("Project always serializes to JSON");
            send(out_tx, &ServerMessage::ProjectResult { id, project }).await;
        }
        Err(error) => send(out_tx, &project_error_to_frame(id, &error)).await,
    }
}

/// Decide where a `project_create` request lands on the cloud-agent's
/// filesystem.
///
/// Rules:
///   • Empty path → `<projects_root>/<slug-of-name>`, auto-created.
///   • Relative path → joined with `<projects_root>`, auto-created.
///   • Absolute path → returned verbatim. `projects::create` then runs
///     its strict canonicalize-must-exist validation; we never auto-
///     create absolute paths, since that would let a malformed
///     request silently lay down directories anywhere on the host.
fn resolve_create_path(
    name: &str,
    path: &str,
    projects_root: &ProjectsRoot,
) -> Result<String, projects::ProjectError> {
    let trimmed = path.trim();
    if !trimmed.is_empty() && Path::new(trimmed).is_absolute() {
        return Ok(trimmed.to_string());
    }

    let leaf = if trimmed.is_empty() {
        slugify_project_name(name)
    } else {
        trimmed.to_string()
    };
    if leaf.is_empty() {
        return Err(projects::ProjectError::EmptyPath);
    }

    let candidate = projects_root.as_path().join(&leaf);
    std::fs::create_dir_all(&candidate).map_err(|_| projects::ProjectError::PathNotReadable)?;
    Ok(candidate.to_string_lossy().into_owned())
}

/// Lowercase + ASCII-friendly version of a name suitable for a
/// directory leaf. Mirrors the lightweight slug shape the desktop
/// applies elsewhere — keeps `[a-z0-9_-]`, collapses whitespace into
/// `-`, drops everything else.
fn slugify_project_name(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut last_was_dash = false;
    for ch in name.trim().chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            last_was_dash = false;
        } else if ch == '-' || ch == '_' {
            out.push(ch);
            last_was_dash = ch == '-';
        } else if ch.is_whitespace() {
            if !last_was_dash {
                out.push('-');
                last_was_dash = true;
            }
        }
    }
    while out.ends_with('-') {
        out.pop();
    }
    if out.is_empty() {
        "project".to_string()
    } else {
        out
    }
}

async fn handle_project_update(
    out_tx: &mpsc::Sender<String>,
    pool: &SqlitePool,
    id: Option<String>,
    args: ProjectUpdateArgs,
) {
    let input = projects::ProjectUpdate {
        id: args.id,
        name: args.name,
        path: args.path,
        color: args.color,
        icon: args.icon,
        default_cli: args.default_cli,
        env: args.env,
        startup_commands: args.startup_commands,
    };
    match projects::update(pool, input).await {
        Ok(project) => {
            let project = serde_json::to_value(project).expect("Project always serializes to JSON");
            send(out_tx, &ServerMessage::ProjectResult { id, project }).await;
        }
        Err(error) => send(out_tx, &project_error_to_frame(id, &error)).await,
    }
}

async fn handle_project_delete(
    out_tx: &mpsc::Sender<String>,
    pool: &SqlitePool,
    id: Option<String>,
    project_id: String,
) {
    match projects::delete(pool, &project_id).await {
        Ok(()) => send(out_tx, &ServerMessage::ProjectVoidResult { id }).await,
        Err(error) => send(out_tx, &project_error_to_frame(id, &error)).await,
    }
}

async fn handle_project_reorder(
    out_tx: &mpsc::Sender<String>,
    pool: &SqlitePool,
    id: Option<String>,
    ids: Vec<String>,
) {
    match projects::reorder(pool, &ids).await {
        Ok(()) => send(out_tx, &ServerMessage::ProjectVoidResult { id }).await,
        Err(error) => send(out_tx, &project_error_to_frame(id, &error)).await,
    }
}

async fn handle_project_update_workspace_tabs(
    out_tx: &mpsc::Sender<String>,
    pool: &SqlitePool,
    id: Option<String>,
    project_id: String,
    visible: Vec<String>,
    active: String,
) {
    match projects::update_workspace_tabs(pool, &project_id, &visible, &active).await {
        Ok(()) => send(out_tx, &ServerMessage::ProjectVoidResult { id }).await,
        Err(error) => send(out_tx, &project_error_to_frame(id, &error)).await,
    }
}

fn project_error_to_frame(id: Option<String>, error: &projects::ProjectError) -> ServerMessage {
    let kind = match error {
        projects::ProjectError::NotFound(_) => "not_found",
        projects::ProjectError::EmptyName
        | projects::ProjectError::NameTooLong(_)
        | projects::ProjectError::NameAlreadyExists(_)
        | projects::ProjectError::EmptyPath
        | projects::ProjectError::PathDoesNotExist
        | projects::ProjectError::PathNotDirectory
        | projects::ProjectError::PathNotReadable
        | projects::ProjectError::ReorderMismatch { .. }
        | projects::ProjectError::ReorderDuplicate(_) => "invalid_args",
        projects::ProjectError::EnvSerialize(_) | projects::ProjectError::Sqlx(_) => "internal",
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

/// Resolve a project's root path for an FS request. Returns the
/// generic `Error` frame the dispatcher should send back when the
/// project lookup fails, so the four FS handlers below share one
/// error path. Bundling the error construction here keeps the
/// project-lookup → path-jail wiring tight: a single mistake in any
/// handler can't accidentally bypass the allow-list.
async fn resolve_project_root(
    pool: &SqlitePool,
    id: Option<&str>,
    project_id: &str,
) -> Result<PathBuf, ServerMessage> {
    match projects::get(pool, project_id).await {
        Ok(p) => Ok(PathBuf::from(p.path)),
        Err(error) => Err(project_error_to_frame(id.map(str::to_owned), &error)),
    }
}

fn fs_error_to_frame(id: Option<String>, error: &FsError) -> ServerMessage {
    ServerMessage::Error {
        id,
        kind: error.kind().to_string(),
        message: error.to_string(),
    }
}

async fn handle_fs_list(
    out_tx: &mpsc::Sender<String>,
    pool: &SqlitePool,
    id: Option<String>,
    project_id: String,
    relative_path: String,
    respect_gitignore: bool,
) {
    let root = match resolve_project_root(pool, id.as_deref(), &project_id).await {
        Ok(p) => p,
        Err(frame) => {
            send(out_tx, &frame).await;
            return;
        }
    };
    let result = tokio::task::spawn_blocking(move || {
        cfs::list_dir(&root, &relative_path, respect_gitignore)
    })
    .await;
    match result {
        Ok(Ok(entries)) => send(out_tx, &ServerMessage::FsListResult { id, entries }).await,
        Ok(Err(error)) => send(out_tx, &fs_error_to_frame(id, &error)).await,
        Err(join_err) => {
            send(
                out_tx,
                &ServerMessage::Error {
                    id,
                    kind: "internal".into(),
                    message: format!("fs_list task failed: {join_err}"),
                },
            )
            .await;
        }
    }
}

async fn handle_fs_read(
    out_tx: &mpsc::Sender<String>,
    pool: &SqlitePool,
    id: Option<String>,
    project_id: String,
    relative_path: String,
) {
    let root = match resolve_project_root(pool, id.as_deref(), &project_id).await {
        Ok(p) => p,
        Err(frame) => {
            send(out_tx, &frame).await;
            return;
        }
    };
    let result = tokio::task::spawn_blocking(move || cfs::read_file(&root, &relative_path)).await;
    match result {
        Ok(Ok(outcome)) => {
            send(
                out_tx,
                &ServerMessage::FsReadResult {
                    id,
                    result: outcome,
                },
            )
            .await;
        }
        Ok(Err(error)) => send(out_tx, &fs_error_to_frame(id, &error)).await,
        Err(join_err) => {
            send(
                out_tx,
                &ServerMessage::Error {
                    id,
                    kind: "internal".into(),
                    message: format!("fs_read task failed: {join_err}"),
                },
            )
            .await;
        }
    }
}

async fn handle_fs_write(
    out_tx: &mpsc::Sender<String>,
    pool: &SqlitePool,
    id: Option<String>,
    project_id: String,
    relative_path: String,
    content: String,
    encoding: String,
) {
    let root = match resolve_project_root(pool, id.as_deref(), &project_id).await {
        Ok(p) => p,
        Err(frame) => {
            send(out_tx, &frame).await;
            return;
        }
    };
    let result = tokio::task::spawn_blocking(move || {
        cfs::write_file(&root, &relative_path, &content, &encoding)
    })
    .await;
    match result {
        Ok(Ok(())) => send(out_tx, &ServerMessage::FsAck { id }).await,
        Ok(Err(error)) => send(out_tx, &fs_error_to_frame(id, &error)).await,
        Err(join_err) => {
            send(
                out_tx,
                &ServerMessage::Error {
                    id,
                    kind: "internal".into(),
                    message: format!("fs_write task failed: {join_err}"),
                },
            )
            .await;
        }
    }
}

async fn handle_fs_delete(
    out_tx: &mpsc::Sender<String>,
    pool: &SqlitePool,
    id: Option<String>,
    project_id: String,
    relative_path: String,
) {
    let root = match resolve_project_root(pool, id.as_deref(), &project_id).await {
        Ok(p) => p,
        Err(frame) => {
            send(out_tx, &frame).await;
            return;
        }
    };
    let result = tokio::task::spawn_blocking(move || cfs::delete_file(&root, &relative_path)).await;
    match result {
        Ok(Ok(())) => send(out_tx, &ServerMessage::FsAck { id }).await,
        Ok(Err(error)) => send(out_tx, &fs_error_to_frame(id, &error)).await,
        Err(join_err) => {
            send(
                out_tx,
                &ServerMessage::Error {
                    id,
                    kind: "internal".into(),
                    message: format!("fs_delete task failed: {join_err}"),
                },
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
                        Err(
                            broadcast::error::TryRecvError::Empty
                            | broadcast::error::TryRecvError::Closed,
                        ) => break,
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

    /// Build a [`PlanflowState`] suitable for dispatch tests that
    /// shouldn't reach the network. Points the proxy at a closed
    /// loopback port and returns no token — any `planflow_*` message
    /// short-circuits with `no_credential` instead of hanging on a
    /// real DNS lookup. Tests that actually exercise the proxy live in
    /// `planflow_proxy::tests` against a `wiremock` server.
    fn offline_planflow_state() -> PlanflowState {
        PlanflowState::for_test("http://127.0.0.1:1", std::sync::Arc::new(|| Ok(None)))
    }

    /// Materialize a fresh `ProjectsRoot` under a tempdir. Tests that
    /// don't care about the path can ignore the returned `TempDir` —
    /// the dir is dropped at scope exit which is fine because no
    /// background task is using it.
    fn fresh_projects_root() -> (ProjectsRoot, tempfile::TempDir) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("projects");
        std::fs::create_dir_all(&path).expect("mkdir projects root");
        (ProjectsRoot::new(path), dir)
    }

    /// Drain everything the dispatcher emitted into a Vec<Value> for
    /// easy assertions. Closes the channel first so the loop terminates.
    async fn drive(pool: &SqlitePool, payload: &str) -> Vec<Value> {
        let (out_tx, mut out_rx) = mpsc::channel::<String>(8);
        let mut conn = fresh_conn(out_tx);
        let planflow = offline_planflow_state();
        let (projects_root, _guard) = fresh_projects_root();
        handle_text(&mut conn, pool, &planflow, &projects_root, payload).await;
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
        // After T19.29 the only known-but-unimplemented variants are
        // the `planflow_chat_*` family — those route into a desktop PTY
        // and have no cloud-side analog. Pick one as the probe so this
        // test stays green when the rest of the unimplemented list
        // continues to shrink.
        let pool = fresh_pool().await;
        let frames = drive(
            &pool,
            r#"{"type":"planflow_chat_send","id":"req-3","project_id":"p","content":"hi"}"#,
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
        let planflow = offline_planflow_state();
        let (projects_root, _guard) = fresh_projects_root();
        handle_text(
            &mut conn,
            &pool,
            &planflow,
            &projects_root,
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

        let planflow = offline_planflow_state();
        let (projects_root, _guard) = fresh_projects_root();
        handle_text(
            &mut conn,
            &pool,
            &planflow,
            &projects_root,
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

        let planflow = offline_planflow_state();
        let (projects_root, _guard) = fresh_projects_root();
        handle_text(
            &mut conn,
            &pool,
            &planflow,
            &projects_root,
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
        let planflow = offline_planflow_state();
        let (projects_root, _guard) = fresh_projects_root();
        handle_text(
            &mut conn,
            &pool,
            &planflow,
            &projects_root,
            r#"{"type":"pty_unsubscribe","id":"u-1","session_id":"00000000-0000-0000-0000-000000000000"}"#,
        )
        .await;
        let frame = out_rx.recv().await.expect("frame");
        assert!(frame.contains(r#""type":"pty_ack""#), "got {frame}");
    }

    #[test]
    fn slugify_project_name_handles_common_cases() {
        assert_eq!(slugify_project_name("Test Project"), "test-project");
        assert_eq!(slugify_project_name("  spaced  "), "spaced");
        assert_eq!(slugify_project_name("a/b\\c?d"), "abcd");
        assert_eq!(slugify_project_name("ka-bo_om"), "ka-bo_om");
        assert_eq!(slugify_project_name("   "), "project");
        // Trailing dashes collapsed away.
        assert_eq!(slugify_project_name("trail--"), "trail");
    }

    #[test]
    fn resolve_create_path_returns_absolute_paths_verbatim() {
        let (root, _guard) = fresh_projects_root();
        let resolved = resolve_create_path("ignored", "/srv/projects/explicit", &root)
            .expect("absolute keeps semantics");
        assert_eq!(resolved, "/srv/projects/explicit");
    }

    #[test]
    fn resolve_create_path_creates_under_root_when_empty() {
        let (root, _guard) = fresh_projects_root();
        let resolved =
            resolve_create_path("Cool App", "", &root).expect("auto-create under root");
        let prefix = root.as_path().to_string_lossy();
        assert!(
            resolved.starts_with(prefix.as_ref()),
            "expected {resolved} to start with {prefix}",
        );
        assert!(
            std::path::Path::new(&resolved).is_dir(),
            "expected {resolved} to exist as a directory",
        );
    }

    #[test]
    fn resolve_create_path_uses_relative_segment_under_root() {
        let (root, _guard) = fresh_projects_root();
        let resolved = resolve_create_path("ignored", "client-frontends", &root)
            .expect("relative resolved under root");
        let expected = root.as_path().join("client-frontends");
        assert_eq!(
            std::path::PathBuf::from(&resolved).canonicalize().unwrap(),
            expected.canonicalize().unwrap(),
        );
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

    // ---- T19.27 dispatch wiring tests ----
    //
    // The fs:: module already has thorough path-jail and behaviour
    // coverage; these tests verify the dispatch layer routes correctly
    // (project lookup → handler → wire frame). We seed a project that
    // points at a tempdir so the path-jail anchor is a real directory
    // for the duration of the test.

    async fn seed_project_with_path(pool: &SqlitePool, id: &str, path: &std::path::Path) {
        sqlx::query(
            "INSERT INTO projects (id, name, path, env_json, position, created_at)
             VALUES (?, ?, ?, '{}', 0, ?)",
        )
        .bind(id)
        .bind(id)
        .bind(path.to_string_lossy().into_owned())
        .bind(1_700_000_000_i64)
        .execute(pool)
        .await
        .expect("seed project");
    }

    #[tokio::test]
    async fn fs_list_returns_entries_from_project_root() {
        let pool = fresh_pool().await;
        let dir = tempdir().unwrap();
        std::fs::create_dir(dir.path().join("src")).unwrap();
        std::fs::write(dir.path().join("README.md"), b"r").unwrap();
        seed_project_with_path(&pool, "p-1", dir.path()).await;

        let frames = drive(&pool, r#"{"type":"fs_list","id":"r1","project_id":"p-1"}"#).await;
        let frame = &frames[0];
        assert_eq!(frame["type"], "fs_list_result");
        assert_eq!(frame["id"], "r1");
        let names: Vec<_> = frame["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["name"].as_str().unwrap().to_string())
            .collect();
        assert_eq!(names, vec!["src", "README.md"]);
    }

    #[tokio::test]
    async fn fs_list_unknown_project_replies_not_found() {
        let pool = fresh_pool().await;
        let frames = drive(&pool, r#"{"type":"fs_list","id":"r","project_id":"ghost"}"#).await;
        let frame = &frames[0];
        assert_eq!(frame["type"], "error");
        assert_eq!(frame["kind"], "not_found");
        assert_eq!(frame["id"], "r");
    }

    #[tokio::test]
    async fn fs_read_returns_text_outcome() {
        let pool = fresh_pool().await;
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("hello.txt"), "hi\n").unwrap();
        seed_project_with_path(&pool, "p-r", dir.path()).await;

        let frames = drive(
            &pool,
            r#"{"type":"fs_read","id":"r","project_id":"p-r","relative_path":"hello.txt"}"#,
        )
        .await;
        let frame = &frames[0];
        assert_eq!(frame["type"], "fs_read_result");
        assert_eq!(frame["result"]["kind"], "text");
        assert_eq!(frame["result"]["content"], "hi\n");
        assert_eq!(frame["result"]["encoding"], "utf-8");
    }

    #[tokio::test]
    async fn fs_read_path_jail_rejects_escape() {
        let pool = fresh_pool().await;
        let outer = tempdir().unwrap();
        let inner = tempdir().unwrap();
        std::fs::write(outer.path().join("secret.txt"), "shhh").unwrap();
        seed_project_with_path(&pool, "p-j", inner.path()).await;
        // Relative path that walks out of `inner` into `outer`.
        let escape = format!(
            "../{}/secret.txt",
            outer.path().file_name().unwrap().to_string_lossy()
        );

        let payload = format!(
            r#"{{"type":"fs_read","id":"j","project_id":"p-j","relative_path":"{escape}"}}"#
        );
        let frames = drive(&pool, &payload).await;
        let frame = &frames[0];
        assert_eq!(frame["type"], "error");
        assert_eq!(frame["kind"], "out_of_scope");
        // The victim file must remain untouched.
        let still_there = std::fs::read_to_string(outer.path().join("secret.txt")).unwrap();
        assert_eq!(still_there, "shhh");
    }

    #[tokio::test]
    async fn fs_write_creates_file_and_acks() {
        let pool = fresh_pool().await;
        let dir = tempdir().unwrap();
        seed_project_with_path(&pool, "p-w", dir.path()).await;

        let frames = drive(
            &pool,
            r#"{"type":"fs_write","id":"w","project_id":"p-w","relative_path":"new.txt","content":"hello\n"}"#,
        )
        .await;
        let frame = &frames[0];
        assert_eq!(frame["type"], "fs_ack");
        assert_eq!(frame["id"], "w");
        let on_disk = std::fs::read_to_string(dir.path().join("new.txt")).unwrap();
        assert_eq!(on_disk, "hello\n");
    }

    #[tokio::test]
    async fn fs_write_path_jail_rejects_escape() {
        let pool = fresh_pool().await;
        let outer = tempdir().unwrap();
        let inner = tempdir().unwrap();
        std::fs::write(outer.path().join("victim.txt"), b"orig").unwrap();
        seed_project_with_path(&pool, "p-wj", inner.path()).await;
        let escape = format!(
            "../{}/victim.txt",
            outer.path().file_name().unwrap().to_string_lossy()
        );

        let payload = format!(
            r#"{{"type":"fs_write","id":"wj","project_id":"p-wj","relative_path":"{escape}","content":"pwned"}}"#
        );
        let frames = drive(&pool, &payload).await;
        let frame = &frames[0];
        assert_eq!(frame["type"], "error");
        assert_eq!(frame["kind"], "out_of_scope");
        // Victim must be untouched — the path-jail intercepts before
        // any rename can land.
        assert_eq!(
            std::fs::read(outer.path().join("victim.txt")).unwrap(),
            b"orig"
        );
    }

    #[tokio::test]
    async fn fs_delete_removes_file_and_acks() {
        let pool = fresh_pool().await;
        let dir = tempdir().unwrap();
        std::fs::write(dir.path().join("rm.txt"), b"x").unwrap();
        seed_project_with_path(&pool, "p-d", dir.path()).await;

        let frames = drive(
            &pool,
            r#"{"type":"fs_delete","id":"d","project_id":"p-d","relative_path":"rm.txt"}"#,
        )
        .await;
        let frame = &frames[0];
        assert_eq!(frame["type"], "fs_ack");
        assert!(!dir.path().join("rm.txt").exists());
    }

    #[tokio::test]
    async fn fs_delete_path_jail_rejects_escape() {
        let pool = fresh_pool().await;
        let outer = tempdir().unwrap();
        let inner = tempdir().unwrap();
        let victim = outer.path().join("victim.txt");
        std::fs::write(&victim, b"orig").unwrap();
        seed_project_with_path(&pool, "p-dj", inner.path()).await;
        let escape = format!(
            "../{}/victim.txt",
            outer.path().file_name().unwrap().to_string_lossy()
        );

        let payload = format!(
            r#"{{"type":"fs_delete","id":"dj","project_id":"p-dj","relative_path":"{escape}"}}"#
        );
        let frames = drive(&pool, &payload).await;
        let frame = &frames[0];
        assert_eq!(frame["type"], "error");
        assert_eq!(frame["kind"], "out_of_scope");
        assert!(victim.exists(), "victim must not be deleted");
    }

    #[tokio::test]
    async fn fs_write_missing_relative_path_replies_invalid_json() {
        let pool = fresh_pool().await;
        let frames = drive(
            &pool,
            r#"{"type":"fs_write","id":"x","project_id":"p","content":"x"}"#,
        )
        .await;
        let frame = &frames[0];
        assert_eq!(frame["type"], "error");
        assert_eq!(frame["kind"], "invalid_json");
    }
}
