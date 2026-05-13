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

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

use crate::db::projects::Project;

/// Default scrollback request size when the client omits `limit`.
/// 64 KiB matches the upper bound used by the desktop xterm bridge.
const DEFAULT_SCROLLBACK_LIMIT: usize = 64 * 1024;

const fn default_scrollback_limit() -> usize {
    DEFAULT_SCROLLBACK_LIMIT
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
    PlanflowGetMe {
        #[serde(default)]
        id: Option<String>,
    },
    PlanflowListProjects {
        #[serde(default)]
        id: Option<String>,
        #[serde(default)]
        organization_id: Option<String>,
    },
    PlanflowListTasks {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
        #[serde(default)]
        status: Option<String>,
    },
    PlanflowListActiveWork {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
    },
    PlanflowListComments {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
        task_id: String,
    },
    PlanflowCreateComment {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
        task_id: String,
        body: String,
    },
    PlanflowStartWork {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
        task_id: String,
    },
    PlanflowStopWork {
        #[serde(default)]
        id: Option<String>,
        project_id: String,
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
    },
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
    ProjectsListResult {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        projects: Vec<Project>,
    },
    /// T18.4: response to `project_get`.
    ProjectResult {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        project: Project,
    },
    /// T18.4: response to `project_switch` after the row was persisted
    /// and the Tauri event fired.
    ProjectSwitched {
        #[serde(skip_serializing_if = "Option::is_none")]
        id: Option<String>,
        project_id: String,
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
}

/// PWA-facing view of the small subset of `app_settings` we surface
/// over the bridge. CamelCase on the wire matches the rest of the
/// project's JSON contracts (see [`Project`] and the TS settings
/// wrapper) so the mobile client doesn't need a per-field renamer.
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
    pub(crate) fn error(
        id: Option<String>,
        kind: impl Into<String>,
        message: impl Into<String>,
    ) -> Self {
        Self::PtyError {
            id,
            session_id: None,
            kind: kind.into(),
            message: message.into(),
        }
    }

    pub(crate) fn session_error(
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
    pub(crate) fn planflow_result(id: Option<String>, data: Value) -> Self {
        Self::PlanflowResult { id, data }
    }

    /// Convenience: PlanFlow bridge error reply (T18.6).
    pub(crate) fn planflow_error(
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
}
