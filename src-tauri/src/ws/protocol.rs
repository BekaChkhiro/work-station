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
use uuid::Uuid;

/// Default scrollback request size when the client omits `limit`.
/// 64 KiB matches the upper bound used by the desktop xterm bridge.
const DEFAULT_SCROLLBACK_LIMIT: usize = 64 * 1024;

const fn default_scrollback_limit() -> usize {
    DEFAULT_SCROLLBACK_LIMIT
}

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
