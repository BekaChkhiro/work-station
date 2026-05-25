// T18.6 docs reference `PlanFlow` (CamelCase) and other bare proper
// nouns in prose; backticking each mention hurts readability. Allow
// doc_markdown for the module.
#![allow(clippy::doc_markdown)]

//! JSON message protocol for the WebSocket bridge (T18.3).
//!
//! Both directions speak text JSON frames discriminated by the `type`
//! tag. Binary payloads (PTY input/output bytes, scrollback slices) are
//! base64-encoded so the wire shape stays JSON end-to-end and the PWA
//! doesn't have to negotiate per-message binary frames.
//!
//! Each request from the client may include an optional `id` correlation
//! string; the matching ack/error/result frame echoes it back so the
//! PWA can resolve in-flight promises without keeping a side index.
//!
//! T19.20: moved out of `src-tauri` so `cloud-agent` can speak the same
//! wire format. Project payloads (`projects_list_result` / `project_result`)
//! carry `serde_json::Value` here — the desktop bridge serializes its
//! typed `db::projects::Project` before constructing the variant, which
//! keeps this crate Tauri-free without changing the JSON contract.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

/// Default scrollback request size when the client omits `limit`.
/// 64 KiB matches the upper bound used by the desktop xterm bridge.
const DEFAULT_SCROLLBACK_LIMIT: usize = 64 * 1024;

const fn default_scrollback_limit() -> usize {
    DEFAULT_SCROLLBACK_LIMIT
}

/// One row in `pty_list_result.sessions`. Snapshot of the agent's
/// session registry plus the metadata sidecar; enough for the
/// desktop to group sessions by project and decide which one to
/// resume on relaunch.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PtySessionView {
    pub session_id: Uuid,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    pub command: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    /// Unix-epoch seconds when the session was spawned.
    pub created_at: i64,
}

/// Wire-side args for `project_create`. Mirrors the desktop's
/// `commands::projects::CreateProjectArgs` field-by-field so the
/// frontend can send the same camelCase payload over either transport.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCreateArgs {
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub default_cli: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub startup_commands: Vec<String>,
}

/// Wire-side args for `project_update`. The id rides inside the args
/// payload (same shape as desktop's `UpdateProjectArgs`) rather than
/// as a top-level wire field so the camelCase JSON the renderer
/// builds for Tauri can be sent over WS verbatim.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectUpdateArgs {
    pub id: String,
    pub name: String,
    pub path: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub default_cli: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub startup_commands: Vec<String>,
}

/// Set of `type` discriminators the server understands. Used by the
/// dispatcher in `pty_bridge` to distinguish "unknown message type"
/// (reply with [`ServerMessage::Error`] kind `unsupported`) from
/// "malformed payload for a known type" (reply with `invalid_json`).
/// Keep in lockstep with the [`ClientMessage`] variants below.
pub const KNOWN_CLIENT_TYPES: &[&str] = &[
    "pty_spawn",
    "pty_write",
    "pty_resize",
    "pty_kill",
    "pty_scrollback",
    "pty_subscribe",
    "pty_unsubscribe",
    "projects_list",
    "project_get",
    "project_switch",
    "project_create",
    "project_update",
    "project_delete",
    "project_reorder",
    "project_update_workspace_tabs",
    "pty_list",
    "settings_get",
    // T18.6 — PlanFlow Tasks bridge variants.
    "planflow_get_me",
    "planflow_list_projects",
    "planflow_list_tasks",
    "planflow_list_active_work",
    "planflow_list_comments",
    "planflow_create_comment",
    "planflow_start_work",
    "planflow_stop_work",
    "planflow_update_task_status",
    // T19.34 — drop a per-project PlanFlow API token on the cloud-agent
    // so each linked Work Station project can use its own credentials.
    "planflow_token_set",
    // T18.16 — PlanFlow Chat on mobile.
    "planflow_chat_send",
    "planflow_chat_history",
    "planflow_chat_clear",
    // T19.27 — cloud-agent FS bridge. All paths are interpreted
    // relative to the requested project's root; the agent enforces a
    // canonical path-jail so a client can never escape it.
    "fs_list",
    "fs_read",
    "fs_write",
    "fs_delete",
    // T19.32 — cloud-agent project ↔ external-service links. Mirrors
    // the desktop's `project_link_*` Tauri commands so the renderer can
    // target either backend with one `routeIpc(...)` call.
    "project_link_list",
    "project_link_set",
    "project_link_delete",
    // T19.35 Phase B — auto-run queue control plane. Five operations:
    // seed a new queue, stop it (kills the current PTY + sets state=stopped),
    // pause/resume it, and query its current state. The server-side
    // orchestrator's own 20-second tick loop then drives the queue without
    // any further client interaction — Phase C wires the desktop thin client.
    "auto_run_start",
    "auto_run_stop",
    "auto_run_pause",
    "auto_run_resume",
    "auto_run_status",
    // T19.35 Phase D — drop a per-project GitHub API token on the cloud-agent
    // so the auto-run orchestrator's `verifying_merge` state can call the
    // GitHub Pulls API to confirm a PR was merged before dispatching the next
    // task. An empty `token` clears the file (falls back to unauthenticated,
    // which works for public repos). Mirrors the `planflow_token_set` frame.
    "github_token_set",
];

/// Client → server frame.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(clippy::enum_variant_names)] // the `Pty…` prefix mirrors the wire
                                     // type names — renaming variants
                                     // would drift the Rust API from
                                     // the JSON contract.
pub enum ClientMessage {
    PtySpawn {
        #[serde(default)]
        id: Option<String>,
        command: String,
        #[serde(default)]
        args: Vec<String>,
        #[serde(default)]
        cwd: Option<String>,
        #[serde(default)]
        env: HashMap<String, String>,
        cols: u16,
        rows: u16,
    },
    PtyWrite {
        #[serde(default)]
        id: Option<String>,
        session_id: Uuid,
        /// Base64 (standard alphabet) of the bytes to feed the pty.
        data: String,
    },
    PtyResize {
        #[serde(default)]
        id: Option<String>,
        session_id: Uuid,
        cols: u16,
        rows: u16,
    },
    PtyKill {
        #[serde(default)]
        id: Option<String>,
        session_id: Uuid,
    },
    PtyScrollback {
        #[serde(default)]
        id: Option<String>,
        session_id: Uuid,
        #[serde(default)]
        offset: usize,
        #[serde(default = "default_scrollback_limit")]
        limit: usize,
    },
    /// Attach the connection to a session's output stream (e.g. when a
    /// reconnecting PWA wants to resume an existing pty without
    /// re-spawning). `pty_spawn` auto-subscribes the spawning client so
    /// this is only needed for re-attach.
    PtySubscribe {
        #[serde(default)]
        id: Option<String>,
        session_id: Uuid,
    },
    /// Stop forwarding output for a session to this connection.
    PtyUnsubscribe {
        #[serde(default)]
        id: Option<String>,
        session_id: Uuid,
    },
    /// List PTY sessions the agent has alive. Optional `project_id`
    /// filter scopes the reply to one project; omit it to see
    /// everything (useful for an admin / orphan cleanup view).
    PtyList {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        project_id: Option<String>,
    },
    /// T18.4: list every project (mirrors `db::projects::list`).
    ProjectsList {
        #[serde(default)]
        id: Option<String>,
    },
    /// T18.4: fetch a single project by id.
    ProjectGet {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
    },
    /// T18.4: switch the active project. Verifies the project exists,
    /// persists `app_settings.last_active_project`, and emits an
    /// `active-project-changed` Tauri event so the desktop frontend
    /// mirrors the PWA without a separate IPC round-trip.
    ProjectSwitch {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
    },
    /// Cloud-agent project CRUD. Mirrors the desktop's
    /// `commands/projects.rs` shape so the same client args payload
    /// (camelCase fields) can target either backend.
    ProjectCreate {
        #[serde(default)]
        id: Option<String>,
        args: ProjectCreateArgs,
    },
    ProjectUpdate {
        #[serde(default)]
        id: Option<String>,
        args: ProjectUpdateArgs,
    },
    ProjectDelete {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
    },
    ProjectReorder {
        #[serde(default)]
        id: Option<String>,
        ids: Vec<String>,
    },
    ProjectUpdateWorkspaceTabs {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
        visible: Vec<String>,
        active: String,
    },
    /// T18.4: read the small subset of `app_settings` the PWA needs
    /// (theme + last-active project). Other settings stay desktop-only
    /// to keep the wire surface tight.
    SettingsGet {
        #[serde(default)]
        id: Option<String>,
    },

    // ---- T18.6: PlanFlow Tasks bridge ----
    //
    // Each variant maps 1:1 to a method on the PlanFlow REST client;
    // the server proxies the call through `http::Client` using the
    // desktop's OS-keychain-stored PlanFlow API token. Success comes
    // back as `planflow_result { id, data }` whose `data` is the
    // upstream payload (envelope stripped); failures use
    // `planflow_error` with a stable `kind`. The mobile side never
    // sees the user's PlanFlow token directly — auth is the WS bearer.
    //
    // T19.34: each variant carries an optional `cloud_project_id` —
    // the Work Station project UUID the call is scoped to. When set,
    // the cloud-agent resolves the PlanFlow API token from the
    // per-project keychain file (`<state_dir>/planflow_tokens/<id>`);
    // when absent or no such file, the global token (config / env)
    // applies. This is what lets two linked PlanFlow accounts coexist
    // on one cloud-agent. Names the cloud (Work Station) project id
    // explicitly so it doesn't collide with the PlanFlow `project_id`
    // PlanflowListTasks etc. already use as the upstream identifier.
    PlanflowGetMe {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        cloud_project_id: Option<String>,
    },
    PlanflowListProjects {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        organization_id: Option<String>,
        #[serde(default)]
        cloud_project_id: Option<String>,
    },
    PlanflowListTasks {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
        #[serde(default)]
        status: Option<String>,
        #[serde(default)]
        cloud_project_id: Option<String>,
    },
    PlanflowListActiveWork {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
        #[serde(default)]
        cloud_project_id: Option<String>,
    },
    PlanflowListComments {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
        task_id: String,
        #[serde(default)]
        cloud_project_id: Option<String>,
    },
    PlanflowCreateComment {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
        task_id: String,
        body: String,
        #[serde(default)]
        cloud_project_id: Option<String>,
    },
    PlanflowStartWork {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
        task_id: String,
        #[serde(default)]
        cloud_project_id: Option<String>,
    },
    PlanflowStopWork {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
        #[serde(default)]
        cloud_project_id: Option<String>,
    },
    PlanflowUpdateTaskStatus {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
        task_id: String,
        /// `TODO` / `IN_PROGRESS` / `BLOCKED` / `DONE` / `DROPPED`.
        /// The bridge forwards the string as-is; the PlanFlow API
        /// enforces the enum.
        status: String,
        #[serde(default)]
        cloud_project_id: Option<String>,
    },
    // T19.34: write (or clear) a per-project PlanFlow API token in the
    // cloud-agent's keychain dir. An empty `token` removes the file so
    // the next planflow_* call for this project falls back to the
    // global config/env credential.
    PlanflowTokenSet {
        #[serde(default)]
        id: Option<String>,
        cloud_project_id: String,
        token: String,
    },

    // ---- T18.16: PlanFlow Chat on mobile ----
    //
    // The mobile client posts a chat message intended for the desktop's
    // active PlanFlow Chat session for a project. The server persists
    // the row to `planflow_chats` and emits a Tauri event so the
    // desktop frontend can route the content into the live PTY
    // (where the assistant sees it just like a keystroke).
    PlanflowChatSend {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
        content: String,
    },
    PlanflowChatHistory {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
        #[serde(default)]
        limit: Option<u32>,
    },
    PlanflowChatClear {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
    },

    // ---- T19.27: cloud-agent filesystem bridge ----
    //
    // Every variant carries `project_id` so the agent can look up the
    // project root from its SQLite and use it as the allow-list anchor.
    // `relative_path` is resolved + canonicalised against that root;
    // anything that escapes (via `..`, symlinks, or an absolute path)
    // is rejected with `Error { kind: "out_of_scope" }`. Mirrors the
    // path-jail logic the desktop's `commands::files::resolve_in_root`
    // applies, just behind the WS contract instead of a Tauri command.
    /// List the immediate children of a directory inside a project. An
    /// empty / omitted `relative_path` lists the project root itself.
    FsList {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
        #[serde(default)]
        relative_path: Option<String>,
        /// When `true` (default), skip noise directories (`.git`,
        /// `node_modules`, build outputs). Mirrors the desktop's
        /// `fs_list_dir` flag.
        #[serde(default)]
        respect_gitignore: Option<bool>,
    },
    /// Read a regular file as UTF-8 text (or report it as binary if
    /// the bytes don't decode). Mirrors `read_text_file`'s semantics.
    FsRead {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
        relative_path: String,
    },
    /// Atomically overwrite a regular file with new UTF-8 content.
    /// `encoding` round-trips the UTF-8 BOM the reader stripped; when
    /// absent (or unrecognized) the writer defaults to `utf-8`. Unlike
    /// the desktop write path the target may be created if missing,
    /// since the PWA's mobile editor may not have called `fs_read`
    /// first (e.g. quick-note flows).
    FsWrite {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
        relative_path: String,
        content: String,
        #[serde(default)]
        encoding: Option<String>,
    },
    /// Delete a regular file inside the project root. Directories are
    /// rejected with `invalid_path` to keep the surface tight — the
    /// PWA never needs to remove whole trees, and accidental tree
    /// deletes from a typo would be catastrophic.
    FsDelete {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
        relative_path: String,
    },

    // ---- T19.32: cloud-agent project_links bridge ----
    //
    // Mirrors the desktop's `project_link_list` / `project_link_set` /
    // `project_link_delete` Tauri commands so the same camelCase
    // payload the renderer builds for Tauri can target the cloud
    // backend verbatim. The metadata payload is free-form JSON; the
    // server only enforces "must be a JSON object" (rejected with
    // `invalid_args` otherwise). Default of `{}` matches the desktop
    // `default_metadata` helper.
    /// List every link for one project.
    ProjectLinkList {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
    },
    /// Upsert a (`project_id`, `service`, `external_id`) link.
    /// `metadata` defaults to `{}` when omitted.
    ProjectLinkSet {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
        service: String,
        external_id: String,
        #[serde(default = "default_link_metadata")]
        metadata: Value,
    },
    /// Remove one specific link. Idempotent — re-deleting a gone row
    /// replies `removed: false` rather than erroring.
    ProjectLinkDelete {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
        service: String,
        external_id: String,
    },

    // ---- T19.35 Phase D: per-project GitHub token store ----
    //
    // Write (or clear) the GitHub API token the cloud-agent uses when
    // polling `GET /repos/{owner}/{repo}/pulls` during `verifying_merge`.
    // An empty `token` removes the file — the agent falls back to
    // unauthenticated requests (60 req/hr per IP, sufficient for public
    // repos). Private repos need a PAT with `repo` read scope.
    //
    // Replies: `github_result { id, data: null }` on success;
    // `github_error { id, kind, message }` on failure.
    //
    // Mirrors `planflow_token_set` in wire shape and server handling.
    GithubTokenSet {
        #[serde(default)]
        id: Option<String>,
        cloud_project_id: String,
        /// GitHub Personal Access Token (PAT). An empty string clears the
        /// stored token so the project falls back to unauthenticated calls.
        token: String,
    },

    // ---- T19.35 Phase B: auto-run queue control plane ----
    //
    // Five frames let the desktop seed and drive a server-side auto-run
    // queue. `external_id` (the PlanFlow project UUID) is NOT sent by the
    // client — the agent resolves it from `project_links WHERE service='planflow'`
    // to prevent a client from impersonating an arbitrary PlanFlow project.
    //
    // Success replies: `auto_run_result { id, data: <queue-json> }`.
    // Failure replies: `auto_run_error { id, kind, message }`.
    //
    // Note: the agent's orchestrator tick loop (Phase A) picks up the
    // seeded queue on its next 20-second beat — no synchronous dispatch
    // is triggered from the WS handler itself. Phase C (desktop) polls
    // `auto_run_status` for UI updates; a future Phase B.2 may add a
    // server-push `auto_run_event` broadcast (noted in dispatch.rs).
    /// Seed a new auto-run queue for a project. The agent resolves the
    /// PlanFlow `external_id` from `project_links WHERE service='planflow'`;
    /// if none exists the reply is `auto_run_error { kind: "not_found" }`.
    ///
    /// `mode` must be one of: `manual`, `auto-merge`, `pr`, `merge-master`, `none`.
    /// `on_failure` must be one of: `stop`, `continue`.
    /// `start_at`: optional epoch-ms; omit (or null) to start immediately.
    /// `deadline_at`: optional epoch-ms hard stop; omit for no deadline.
    /// `pacing_minutes`: minutes between task completions (0 = back-to-back).
    AutoRunStart {
        #[serde(default)]
        id: Option<String>,
        /// Cloud-agent project UUID (the `projects.id` column).
        project_id: String,
        /// Number of task completions requested.
        target_count: i64,
        /// Start mode — `manual`, `auto-merge`, `pr`, `merge-master`, `none`.
        mode: String,
        /// Epoch-ms to begin dispatching; `null` / absent means "start now".
        #[serde(default)]
        start_at: Option<i64>,
        /// Minutes between task completions (`0` = back-to-back).
        #[serde(default)]
        pacing_minutes: Option<f64>,
        /// Epoch-ms hard deadline; `null` / absent means no deadline.
        #[serde(default)]
        deadline_at: Option<i64>,
        /// Failure policy — `stop` | `continue`.
        #[serde(default = "default_on_failure")]
        on_failure: String,
    },
    /// Stop the auto-run queue for a project. The current PTY session
    /// (if any) is killed immediately; the queue row is set to `stopped`
    /// so history is preserved. Idempotent — stopping an already-stopped
    /// or absent queue is not an error.
    AutoRunStop {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
    },
    /// Pause the auto-run queue. The current task (if any) keeps running
    /// in its PTY; no new tasks are dispatched until `auto_run_resume`.
    /// Mirrors `pauseAutoRun` in `src/stores/autoRunQueue.ts`.
    AutoRunPause {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
    },
    /// Resume a paused auto-run queue. Sets state to `running` (if a
    /// task is currently mid-flight) or `waiting` with
    /// `next_dispatch_at = now` so the orchestrator picks up immediately
    /// on its next tick. Mirrors `resumeAutoRun`.
    AutoRunResume {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
    },
    /// Fetch the current auto-run queue state for a project.
    /// Replies with `auto_run_result { data: null }` when no queue exists.
    AutoRunStatus {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
    },
}

fn default_link_metadata() -> Value {
    serde_json::json!({})
}

fn default_on_failure() -> String {
    "stop".to_string()
}

/// Server → client frame.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
#[allow(clippy::enum_variant_names)] // see note on `ClientMessage`.
pub enum ServerMessage {
    /// `pty_spawn` succeeded; carries the new session id.
    PtySpawned {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        session_id: Uuid,
    },
    /// Generic "request accepted" ack for write / resize / kill /
    /// subscribe / unsubscribe.
    PtyAck {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    /// Typed failure. `kind` is a stable `snake_case` discriminator the
    /// PWA can branch on; `message` is a free-form human-readable note.
    PtyError {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        session_id: Option<Uuid>,
        kind: String,
        message: String,
    },
    /// Live pty output frame. `data` is base64-encoded bytes.
    PtyOutput { session_id: Uuid, data: String },
    /// Response to `pty_scrollback`. Layout mirrors the Tauri
    /// command return shape (`data`, `totalBytes`, `nextOffset`) so the
    /// PWA can reuse pagination logic from the desktop client.
    PtyScrollbackChunk {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        session_id: Uuid,
        data: String,
        total_bytes: usize,
        next_offset: usize,
    },
    /// Server-initiated event: the PTY's output broadcast closed
    /// (child exited or session was killed). Subscribers can drop
    /// their xterm.js instance.
    PtyExit { session_id: Uuid },
    /// Response to `pty_list`. Each entry is the minimum the desktop
    /// needs to decide whether to reattach (session_id, project_id,
    /// command + cwd snapshots, terminal geometry, created_at).
    PtyListResult {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        sessions: Vec<PtySessionView>,
    },
    /// T18.4: generic, non-PTY error envelope used by the projects /
    /// settings handlers and by the unknown-type dispatch path.
    ///
    /// Distinct from [`ServerMessage::PtyError`] so the `kind` discriminator
    /// space stays scoped to one feature area at a time. The PWA
    /// branches on `type` first; a generic `error` frame here means
    /// "the request you sent failed" without implying anything about
    /// PTY session state.
    Error {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        kind: String,
        message: String,
    },
    /// T18.4: response to `projects_list`.
    ///
    /// `projects` is the typed `Project` list serialized to JSON by the
    /// desktop bridge before frame construction (T19.20). Holding the
    /// payload as [`Value`] keeps this crate independent of the
    /// `db::projects::Project` type that lives in `src-tauri`.
    ProjectsListResult {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        projects: Value,
    },
    /// T18.4: response to `project_get`. See note on
    /// [`ServerMessage::ProjectsListResult`] for the `Value` shape.
    ProjectResult {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        project: Value,
    },
    /// T18.4: response to `project_switch` after the row was persisted
    /// and the Tauri event fired.
    ProjectSwitched {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        project_id: String,
    },
    /// Generic "void" ack for project mutations whose handler has no
    /// payload to return (delete / reorder / update_workspace_tabs).
    /// `project_create` / `project_update` reuse [`ProjectResult`].
    ProjectVoidResult {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },
    /// T18.4: response to `settings_get`.
    SettingsResult {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        settings: SettingsView,
    },
    /// T18.4: server-initiated event broadcast when the active project
    /// changes (omits `id` per the events-have-no-correlation-id rule).
    /// Currently emitted only as a Tauri event; reserved here so a
    /// future cross-WS broadcast can land without a wire-format break.
    ActiveProjectChanged {
        #[serde(skip_serializing_if = "Option::is_none")]
        project_id: Option<String>,
    },
    /// Server-initiated event (T18.5): live host stats. Emitted on a
    /// fixed cadence (currently every 2 seconds) to every authenticated
    /// WebSocket — the PWA's Monitor tab plots the stream, other tabs
    /// can ignore it. Fields are flat so the PWA can render them
    /// without a nested deserialiser.
    SystemStats {
        /// Global CPU usage as a percentage in `[0, 100]`. Computed by
        /// sysinfo as the average across all logical cores since the
        /// previous refresh tick.
        cpu_percent: f32,
        /// Currently-used RAM in bytes. Matches sysinfo's `used_memory`
        /// (active + wired on macOS, `MemTotal` - `MemAvailable` on Linux).
        ram_used_bytes: u64,
        /// Total physical RAM in bytes.
        ram_total_bytes: u64,
        /// Number of live PTY sessions tracked by `PtyManager`. Includes
        /// sessions spawned from the desktop GUI as well as the PWA so
        /// the user can see "what's running" across both surfaces.
        pty_session_count: usize,
    },

    // ---- T18.6: PlanFlow Tasks bridge ----
    //
    // The wire is intentionally `data: Value`: PlanFlow's response
    // shapes are already version-stable enough that the mobile client
    // parses them with zod, and a discriminated Rust variant per
    // response shape would force every API tweak through this module.
    // Errors carry the upstream HTTP status when available so the PWA
    // can branch on 401/403 to re-prompt for a token without parsing
    // prose. Kept as a dedicated variant (not the generic `Error`
    // above) precisely so it can carry `status`.
    PlanflowResult {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        data: Value,
    },
    PlanflowError {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        kind: String,
        message: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        status: Option<u16>,
    },

    // ---- T18.16: PlanFlow Chat replies ----
    //
    // `planflow_chat_ack` confirms the row was persisted and the Tauri
    // event was emitted (best effort — emit failures still ack).
    // `planflow_chat_history_result` ships oldest-first messages.
    // `planflow_chat_cleared` confirms a clear and reports the row count.
    PlanflowChatAck {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        message_id: i64,
        created_at: i64,
    },
    PlanflowChatHistoryResult {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        messages: Vec<ChatMessageView>,
    },
    PlanflowChatCleared {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        rows_deleted: i64,
    },

    // ---- T19.27: cloud-agent FS bridge replies ----
    //
    // Failures share the generic `Error` envelope (kinds: `not_found`,
    // `out_of_scope`, `invalid_path`, `not_a_directory`, `too_large`,
    // `internal`) so the PWA branches on `type` first and `kind`
    // second — same pattern projects + settings use.
    /// Response to `fs_list`. `entries` is folder-first then
    /// case-insensitive alphabetical, matching the desktop's
    /// `fs_list_dir` ordering so muscle memory transfers.
    FsListResult {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        entries: Vec<FsEntry>,
    },
    /// Response to `fs_read`. The discriminated `result` distinguishes
    /// text from binary so the PWA can render Monaco vs. a "not text"
    /// placeholder without re-sniffing the bytes.
    FsReadResult {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        result: FsReadOutcome,
    },
    /// Acknowledgement for `fs_write` / `fs_delete` (no payload).
    FsAck {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
    },

    // ---- T19.35 Phase B: auto-run queue replies ----
    //
    // `auto_run_result` carries the full queue JSON on success (or
    // `data: null` for `auto_run_status` when no queue exists).  It
    // mirrors the `planflow_result` shape so the Phase C desktop client
    // can parse both with the same branch. `auto_run_error` mirrors
    // `planflow_error` — `kind` is a stable `snake_case` discriminator
    // (`not_found`, `invalid_args`, `internal`) the desktop can branch on.
    //
    // Note: server-push `auto_run_event` (for live UI updates without
    // polling) is out of scope for Phase B — the client polls
    // `auto_run_status`. The natural plug-in point would mirror the
    // `forward_stats` broadcaster in `dispatch.rs`.
    /// Response to all five `auto_run_*` requests on success.
    /// `data` is the full `AutoRunQueue` serialized to JSON, or `null`
    /// for `auto_run_status` when no queue exists for the project.
    AutoRunResult {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        data: Value,
    },
    /// Failure reply for any `auto_run_*` request.
    /// `kind` is a stable `snake_case` discriminator the desktop can
    /// branch on without parsing `message`.
    AutoRunError {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        kind: String,
        message: String,
    },

    // ---- T19.35 Phase D: GitHub token store replies ----
    //
    // Mirrors the PlanFlow token-set reply shape (`planflow_result` /
    // `planflow_error`) so the desktop client can handle both with the
    // same branch. `data` is always `null` (the operation produces no
    // payload). `kind` uses the same stable taxonomy:
    // `invalid_args` (bad project id), `credential` (I/O failure).
    /// Success reply for `github_token_set`.
    GithubResult {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        data: Value,
    },
    /// Failure reply for `github_token_set`.
    GithubError {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        kind: String,
        message: String,
    },

    // ---- T19.32: cloud-agent project_links replies ----
    //
    // Failures share the generic `Error` envelope (kinds: `not_found`
    // for an unknown `project_id`, `invalid_args` for empty fields or
    // non-object metadata, `internal` for SQLite failures) — same
    // pattern projects + settings use.
    /// Response to `project_link_list`. `links` is the typed list
    /// serialized to JSON by the cloud-agent before frame construction
    /// (mirrors the [`ServerMessage::ProjectsListResult`] pattern that
    /// keeps this crate Tauri-free).
    ProjectLinksResult {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        links: Value,
    },
    /// Response to `project_link_set`. The full upserted row, including
    /// `createdAt` (preserved on conflict).
    ProjectLinkResult {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        link: Value,
    },
    /// Response to `project_link_delete`. `removed` is `true` when a
    /// row was deleted, `false` when the triple was already gone.
    ProjectLinkDeleted {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        removed: bool,
    },
}

/// Wire shape for a chat message row (T18.16). Mirrors the TypeScript
/// `ChatMessage` schema in `src/db/planflowChats.ts` with camelCase
/// fields so the mobile zod parser can use it directly.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessageView {
    pub id: i64,
    pub project_id: String,
    pub role: String,
    pub content: String,
    pub cli: Option<String>,
    pub created_at: i64,
}

/// Wire shape for a single entry in `fs_list_result` (T19.27). All
/// paths are relative to the project root the request named — the
/// agent never leaks absolute VPS paths over the wire, so the PWA
/// can safely echo them back as `relative_path` on subsequent
/// `fs_read` / `fs_write` calls without re-deriving a project anchor.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub relative_path: String,
    pub is_dir: bool,
}

/// Discriminated read response (T19.27). Mirrors the desktop's
/// `commands::files::ReadResult` shape so a PWA / desktop parser can
/// be shared. `encoding` and `reason` use kebab-case values
/// (`utf-8` / `utf-8-bom` / `nul-byte` / `not-utf-8`) for the same
/// reason.
#[derive(Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum FsReadOutcome {
    Text { content: String, encoding: String },
    Binary { reason: String },
}

/// PWA-facing view of the small subset of `app_settings` we surface
/// over the bridge. CamelCase on the wire matches the rest of the
/// project's JSON contracts (see `db::projects::Project` and the TS
/// settings wrapper) so the mobile client doesn't need a per-field
/// renamer.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    /// `"light" | "dark" | "system"` — falls back to `"dark"` (the TS
    /// default) when the row is missing or corrupt.
    pub theme: String,
    /// `null` when no project has been activated yet, or when the
    /// stored row has been explicitly cleared.
    pub last_active_project: Option<String>,
}

impl ServerMessage {
    /// Convenience: build a `PtyError` without a `session_id` slot.
    ///
    /// `pub` (not `pub(crate)`) since T19.20 moved this crate out of
    /// `src-tauri`; the desktop bridge consumes it from the other side
    /// of the crate boundary.
    pub fn error(id: Option<String>, kind: impl Into<String>, message: impl Into<String>) -> Self {
        Self::PtyError {
            id,
            session_id: None,
            kind: kind.into(),
            message: message.into(),
        }
    }

    pub fn session_error(
        id: Option<String>,
        session_id: Uuid,
        kind: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self::PtyError {
            id,
            session_id: Some(session_id),
            kind: kind.into(),
            message: message.into(),
        }
    }

    /// Convenience: PlanFlow bridge success reply (T18.6).
    pub fn planflow_result(id: Option<String>, data: Value) -> Self {
        Self::PlanflowResult { id, data }
    }

    /// Convenience: PlanFlow bridge error reply (T18.6).
    pub fn planflow_error(
        id: Option<String>,
        kind: impl Into<String>,
        message: impl Into<String>,
        status: Option<u16>,
    ) -> Self {
        Self::PlanflowError {
            id,
            kind: kind.into(),
            message: message.into(),
            status,
        }
    }

    /// Convenience: auto-run control-plane success reply (T19.35 Phase B).
    ///
    /// `data` is the full `AutoRunQueue` serialised to JSON, or
    /// `Value::Null` for `auto_run_status` when no queue exists.
    pub fn auto_run_result(id: Option<String>, data: Value) -> Self {
        Self::AutoRunResult { id, data }
    }

    /// Convenience: auto-run control-plane error reply (T19.35 Phase B).
    pub fn auto_run_error(
        id: Option<String>,
        kind: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self::AutoRunError {
            id,
            kind: kind.into(),
            message: message.into(),
        }
    }

    /// Convenience: GitHub token-store success reply (T19.35 Phase D).
    ///
    /// `data` is always `Value::Null` for `github_token_set` — the
    /// operation produces no payload.
    pub fn github_result(id: Option<String>, data: Value) -> Self {
        Self::GithubResult { id, data }
    }

    /// Convenience: GitHub token-store error reply (T19.35 Phase D).
    pub fn github_error(
        id: Option<String>,
        kind: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self::GithubError {
            id,
            kind: kind.into(),
            message: message.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pty_spawn_with_defaults() {
        let raw = r#"{"type":"pty_spawn","command":"bash","cols":80,"rows":24}"#;
        let msg: ClientMessage = serde_json::from_str(raw).expect("parse");
        match msg {
            ClientMessage::PtySpawn {
                command,
                args,
                cwd,
                env,
                cols,
                rows,
                id,
            } => {
                assert_eq!(command, "bash");
                assert!(args.is_empty());
                assert!(cwd.is_none());
                assert!(env.is_empty());
                assert_eq!((cols, rows), (80, 24));
                assert!(id.is_none());
            }
            other => panic!("expected PtySpawn, got {other:?}"),
        }
    }

    #[test]
    fn parses_pty_write_with_correlation_id() {
        let raw = r#"{"type":"pty_write","id":"req-1","session_id":"00000000-0000-0000-0000-000000000000","data":"aGk="}"#;
        let msg: ClientMessage = serde_json::from_str(raw).expect("parse");
        match msg {
            ClientMessage::PtyWrite {
                id,
                session_id,
                data,
            } => {
                assert_eq!(id.as_deref(), Some("req-1"));
                assert_eq!(session_id, Uuid::nil());
                assert_eq!(data, "aGk=");
            }
            other => panic!("expected PtyWrite, got {other:?}"),
        }
    }

    #[test]
    fn parses_scrollback_request_with_default_limit() {
        let raw =
            r#"{"type":"pty_scrollback","session_id":"00000000-0000-0000-0000-000000000000"}"#;
        let msg: ClientMessage = serde_json::from_str(raw).expect("parse");
        match msg {
            ClientMessage::PtyScrollback { offset, limit, .. } => {
                assert_eq!(offset, 0);
                assert_eq!(limit, DEFAULT_SCROLLBACK_LIMIT);
            }
            other => panic!("expected PtyScrollback, got {other:?}"),
        }
    }

    #[test]
    fn pty_output_serializes_with_snake_case_type() {
        let msg = ServerMessage::PtyOutput {
            session_id: Uuid::nil(),
            data: "aGk=".to_string(),
        };
        let json = serde_json::to_string(&msg).expect("serialize");
        assert!(json.contains(r#""type":"pty_output""#), "got {json}");
        assert!(json.contains(r#""session_id":"00000000-0000-0000-0000-000000000000""#));
    }

    #[test]
    fn pty_error_omits_session_id_when_absent() {
        let msg = ServerMessage::error(Some("req-7".into()), "invalid_args", "bad payload");
        let json = serde_json::to_string(&msg).expect("serialize");
        assert!(json.contains(r#""kind":"invalid_args""#));
        assert!(
            !json.contains("session_id"),
            "did not expect session_id in {json}"
        );
    }

    #[test]
    fn pty_ack_omits_id_when_absent() {
        let msg = ServerMessage::PtyAck { id: None };
        let json = serde_json::to_string(&msg).expect("serialize");
        assert_eq!(json, r#"{"type":"pty_ack"}"#);
    }

    #[test]
    fn parses_projects_list_with_optional_id() {
        let raw = r#"{"type":"projects_list","id":"req-1"}"#;
        let msg: ClientMessage = serde_json::from_str(raw).expect("parse");
        match msg {
            ClientMessage::ProjectsList { id } => assert_eq!(id.as_deref(), Some("req-1")),
            other => panic!("expected ProjectsList, got {other:?}"),
        }
    }

    #[test]
    fn parses_project_switch_payload() {
        let raw = r#"{"type":"project_switch","id":"r","project_id":"abc"}"#;
        let msg: ClientMessage = serde_json::from_str(raw).expect("parse");
        match msg {
            ClientMessage::ProjectSwitch { id, project_id } => {
                assert_eq!(id.as_deref(), Some("r"));
                assert_eq!(project_id, "abc");
            }
            other => panic!("expected ProjectSwitch, got {other:?}"),
        }
    }

    #[test]
    fn parses_settings_get() {
        let raw = r#"{"type":"settings_get"}"#;
        let msg: ClientMessage = serde_json::from_str(raw).expect("parse");
        assert!(matches!(msg, ClientMessage::SettingsGet { id: None }));
    }

    #[test]
    fn settings_view_serializes_with_camel_case() {
        let view = SettingsView {
            theme: "dark".into(),
            last_active_project: Some("p1".into()),
        };
        let json = serde_json::to_string(&view).expect("serialize");
        assert!(json.contains(r#""theme":"dark""#), "got {json}");
        assert!(
            json.contains(r#""lastActiveProject":"p1""#),
            "expected camelCase, got {json}"
        );
    }

    #[test]
    fn settings_view_serializes_null_active_project() {
        let view = SettingsView {
            theme: "dark".into(),
            last_active_project: None,
        };
        let json = serde_json::to_string(&view).expect("serialize");
        assert!(
            json.contains(r#""lastActiveProject":null"#),
            "explicit null required, got {json}"
        );
    }

    #[test]
    fn settings_result_round_trips_id() {
        let msg = ServerMessage::SettingsResult {
            id: Some("req-1".into()),
            settings: SettingsView {
                theme: "light".into(),
                last_active_project: None,
            },
        };
        let json = serde_json::to_string(&msg).expect("serialize");
        assert!(json.contains(r#""type":"settings_result""#), "got {json}");
        assert!(json.contains(r#""id":"req-1""#), "got {json}");
    }

    #[test]
    fn project_switched_serializes_with_snake_case_type_and_project_id() {
        let msg = ServerMessage::ProjectSwitched {
            id: None,
            project_id: "abc".into(),
        };
        let json = serde_json::to_string(&msg).expect("serialize");
        assert!(json.contains(r#""type":"project_switched""#), "got {json}");
        assert!(json.contains(r#""project_id":"abc""#), "got {json}");
        assert!(!json.contains(r#""id""#), "id must be omitted, got {json}");
    }

    #[test]
    fn active_project_changed_event_omits_id_field() {
        let msg = ServerMessage::ActiveProjectChanged {
            project_id: Some("p1".into()),
        };
        let json = serde_json::to_string(&msg).expect("serialize");
        assert!(
            json.contains(r#""type":"active_project_changed""#),
            "got {json}"
        );
        assert!(json.contains(r#""project_id":"p1""#), "got {json}");
    }

    #[test]
    fn generic_error_uses_distinct_type_from_pty_error() {
        let msg = ServerMessage::Error {
            id: Some("r".into()),
            kind: "unsupported".into(),
            message: "unknown message type: foo".into(),
        };
        let json = serde_json::to_string(&msg).expect("serialize");
        assert!(json.contains(r#""type":"error""#), "got {json}");
        assert!(json.contains(r#""kind":"unsupported""#), "got {json}");
        assert!(
            !json.contains("session_id"),
            "generic error must not carry session_id, got {json}"
        );
    }

    // ---- T19.35 Phase B: auto-run protocol tests ----

    #[test]
    fn parses_auto_run_start_minimal() {
        let raw =
            r#"{"type":"auto_run_start","id":"r","project_id":"p1","target_count":3,"mode":"pr"}"#;
        let msg: ClientMessage = serde_json::from_str(raw).expect("parse");
        match msg {
            ClientMessage::AutoRunStart {
                id,
                project_id,
                target_count,
                mode,
                start_at,
                pacing_minutes,
                deadline_at,
                on_failure,
            } => {
                assert_eq!(id.as_deref(), Some("r"));
                assert_eq!(project_id, "p1");
                assert_eq!(target_count, 3);
                assert_eq!(mode, "pr");
                assert!(start_at.is_none());
                assert!(pacing_minutes.is_none());
                assert!(deadline_at.is_none());
                // default on_failure = "stop"
                assert_eq!(on_failure, "stop");
            }
            other => panic!("expected AutoRunStart, got {other:?}"),
        }
    }

    #[test]
    fn parses_auto_run_start_full() {
        let raw = r#"{"type":"auto_run_start","project_id":"p1","target_count":5,"mode":"auto-merge","start_at":1700000000000,"pacing_minutes":2.5,"deadline_at":1700003600000,"on_failure":"continue"}"#;
        let msg: ClientMessage = serde_json::from_str(raw).expect("parse");
        match msg {
            ClientMessage::AutoRunStart {
                target_count,
                mode,
                start_at,
                pacing_minutes,
                deadline_at,
                on_failure,
                ..
            } => {
                assert_eq!(target_count, 5);
                assert_eq!(mode, "auto-merge");
                assert_eq!(start_at, Some(1_700_000_000_000));
                assert!((pacing_minutes.unwrap() - 2.5).abs() < f64::EPSILON);
                assert_eq!(deadline_at, Some(1_700_003_600_000));
                assert_eq!(on_failure, "continue");
            }
            other => panic!("expected AutoRunStart, got {other:?}"),
        }
    }

    #[test]
    fn parses_auto_run_stop() {
        let raw = r#"{"type":"auto_run_stop","id":"s","project_id":"p2"}"#;
        let msg: ClientMessage = serde_json::from_str(raw).expect("parse");
        assert!(matches!(
            msg,
            ClientMessage::AutoRunStop {
                id: Some(_),
                project_id,
            } if project_id == "p2"
        ));
    }

    #[test]
    fn parses_auto_run_pause_and_resume() {
        for type_str in ["auto_run_pause", "auto_run_resume"] {
            let raw = format!(r#"{{"type":"{type_str}","project_id":"p3"}}"#);
            let msg: ClientMessage = serde_json::from_str(&raw).expect("parse");
            match msg {
                ClientMessage::AutoRunPause { project_id, .. }
                | ClientMessage::AutoRunResume { project_id, .. } => {
                    assert_eq!(project_id, "p3");
                }
                other => panic!("expected Pause/Resume, got {other:?}"),
            }
        }
    }

    #[test]
    fn parses_auto_run_status() {
        let raw = r#"{"type":"auto_run_status","id":"q","project_id":"p4"}"#;
        let msg: ClientMessage = serde_json::from_str(raw).expect("parse");
        assert!(matches!(
            msg,
            ClientMessage::AutoRunStatus {
                id: Some(_),
                project_id,
            } if project_id == "p4"
        ));
    }

    #[test]
    fn auto_run_result_serializes_with_data() {
        let msg = ServerMessage::auto_run_result(
            Some("req-1".into()),
            serde_json::json!({"state": "running"}),
        );
        let json = serde_json::to_string(&msg).expect("serialize");
        assert!(json.contains(r#""type":"auto_run_result""#), "got {json}");
        assert!(json.contains(r#""id":"req-1""#), "got {json}");
        assert!(json.contains(r#""state":"running""#), "got {json}");
    }

    #[test]
    fn auto_run_result_with_null_data() {
        let msg = ServerMessage::auto_run_result(None, serde_json::Value::Null);
        let json = serde_json::to_string(&msg).expect("serialize");
        assert!(json.contains(r#""type":"auto_run_result""#), "got {json}");
        assert!(json.contains(r#""data":null"#), "got {json}");
    }

    #[test]
    fn auto_run_error_serializes_kind_and_message() {
        let msg = ServerMessage::auto_run_error(Some("r".into()), "not_found", "no planflow link");
        let json = serde_json::to_string(&msg).expect("serialize");
        assert!(json.contains(r#""type":"auto_run_error""#), "got {json}");
        assert!(json.contains(r#""kind":"not_found""#), "got {json}");
        assert!(
            json.contains(r#""message":"no planflow link""#),
            "got {json}"
        );
    }

    #[test]
    fn known_client_types_match_variants() {
        // Soft contract: the dispatcher reads `KNOWN_CLIENT_TYPES` to
        // distinguish "unsupported" from "invalid_json". A drift here
        // would silently push valid client messages onto the
        // unsupported branch, so smoke-test that every entry parses.
        for raw_type in KNOWN_CLIENT_TYPES {
            // A bare `{"type":"X"}` payload is enough to exercise the
            // tag dispatch; missing required fields return Err but
            // serde still recognises the variant — which is what we
            // care about here.
            let payload = format!(r#"{{"type":"{raw_type}"}}"#);
            let result = serde_json::from_str::<ClientMessage>(&payload);
            // Either it parsed (variants without required fields) or
            // it failed for "missing field" — both prove the type is
            // known. An "unknown variant" failure would mean the
            // constant array is out of sync.
            if let Err(error) = result {
                let msg = error.to_string();
                assert!(
                    !msg.contains("unknown variant"),
                    "{raw_type}: variant missing — KNOWN_CLIENT_TYPES drifted ({msg})"
                );
            }
        }
    }

    #[test]
    fn system_stats_serializes_with_flat_snake_case_fields() {
        let msg = ServerMessage::SystemStats {
            cpu_percent: 12.5,
            ram_used_bytes: 1_073_741_824,
            ram_total_bytes: 17_179_869_184,
            pty_session_count: 3,
        };
        let json = serde_json::to_string(&msg).expect("serialize");
        assert!(json.contains(r#""type":"system_stats""#), "got {json}");
        assert!(json.contains(r#""cpu_percent":12.5"#), "got {json}");
        assert!(
            json.contains(r#""ram_used_bytes":1073741824"#),
            "got {json}"
        );
        assert!(
            json.contains(r#""ram_total_bytes":17179869184"#),
            "got {json}"
        );
        assert!(json.contains(r#""pty_session_count":3"#), "got {json}");
    }

    #[test]
    fn projects_list_result_carries_value_payload() {
        // T19.20: the project payload moved from a typed Vec<Project>
        // to a serde_json::Value so this crate stays Tauri-free.
        // Serialization should treat the Value as a transparent
        // pass-through — the desktop bridge serializes its typed
        // Project list before construction.
        let projects = serde_json::json!([
            { "id": "p1", "name": "alpha", "workspaceTabs": ["terminal"] },
        ]);
        let msg = ServerMessage::ProjectsListResult {
            id: Some("req-1".into()),
            projects,
        };
        let json = serde_json::to_string(&msg).expect("serialize");
        assert!(
            json.contains(r#""type":"projects_list_result""#),
            "got {json}"
        );
        assert!(json.contains(r#""id":"req-1""#), "got {json}");
        assert!(
            json.contains(r#""workspaceTabs":["terminal"]"#),
            "got {json}"
        );
    }
}
