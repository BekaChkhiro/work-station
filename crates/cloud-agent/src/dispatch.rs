//! Per-connection WebSocket dispatch loop for the cloud-agent (T19.24).
//!
//! Replaces the T19.21 placeholder that closed every authenticated socket
//! with a single `error{kind:"unimplemented"}` frame. The loop now:
//!
//!   * splits the WebSocket into a read half + an outbound mpsc pump so
//!     handler tasks can produce frames concurrently without contending
//!     on the sink (same shape as `src-tauri/src/ws/pty_bridge.rs`);
//!   * decodes each text frame as a [`ClientMessage`] using the shared
//!     `workstation-core::ws::protocol` types so the cloud-agent and
//!     the desktop bridge speak the exact same JSON contract;
//!   * dispatches `settings_get` to a stubbed handler that returns a
//!     hardcoded [`SettingsView`] — enough to prove the loop end-to-end
//!     against the desktop's WS client without standing up `SQLite` on
//!     the VPS yet (real settings storage lands in a follow-up task);
//!   * replies to every other known message type with a typed
//!     `error{kind:"unimplemented"}` frame so the desktop sees a stable
//!     shape during Phase-1 instead of a silent drop.
//!
//! Error taxonomy mirrors the desktop bridge so a PWA / desktop client
//! doesn't need a second branch table:
//!   * `invalid_json`  — payload didn't parse, or `type` was missing.
//!   * `unsupported`   — `type` is a string we don't recognize at all.
//!   * `unimplemented` — `type` is known but the cloud-agent hasn't
//!     wired its handler yet.
//!   * `invalid_frame` — client sent a binary frame on a text-only wire.

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use workstation_core::ws::protocol::{
    ClientMessage, ServerMessage, SettingsView, KNOWN_CLIENT_TYPES,
};

/// Capacity for the per-connection outbound mpsc.
///
/// Phase-1 has only one writer (the request/response lane) so this
/// could be tiny; we keep 64 to leave headroom for the PTY / project
/// forwarders that follow-up tasks slot in.
const OUTBOUND_CHANNEL_CAPACITY: usize = 64;

/// Drive a single authenticated WebSocket connection until the peer
/// closes or the socket errors. Returns when the read half drains and
/// the sink task has flushed.
pub async fn run_connection(socket: WebSocket) {
    let (mut ws_tx, mut ws_rx) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<String>(OUTBOUND_CHANNEL_CAPACITY);

    // Outbound pump: drains the mpsc into the WebSocket sink as text
    // frames. Exits cleanly when the mpsc closes (every sender dropped)
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

    while let Some(frame) = ws_rx.next().await {
        let Ok(msg) = frame else {
            // Underlying transport error — bail; the sink_task will
            // tear down on the next pump iteration.
            break;
        };
        match msg {
            Message::Text(payload) => {
                handle_text(&out_tx, &payload).await;
            }
            Message::Binary(_) => {
                send_error(
                    &out_tx,
                    None,
                    "invalid_frame",
                    "binary frames are not supported on this connection",
                )
                .await;
            }
            Message::Ping(_) | Message::Pong(_) => {
                // axum responds to pings automatically; pong frames are
                // ignored.
            }
            Message::Close(_) => break,
        }
    }

    // Closing the mpsc sender drains the sink_task; await it for a
    // clean WebSocket close.
    drop(out_tx);
    let _ = sink_task.await;
}

/// Two-phase parse so we can echo `id` on every failure path and
/// distinguish "unknown message type" (`unsupported`) from "malformed
/// payload for a known type" (`invalid_json`). Mirrors the desktop
/// bridge's [`super::ws::pty_bridge::handle_text`] flow.
async fn handle_text(out_tx: &mpsc::Sender<String>, payload: &str) {
    let value: serde_json::Value = match serde_json::from_str(payload) {
        Ok(v) => v,
        Err(error) => {
            send_error(
                out_tx,
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
            out_tx,
            echo_id,
            "invalid_json",
            "missing required field `type`",
        )
        .await;
        return;
    };

    if !KNOWN_CLIENT_TYPES.contains(&type_str.as_str()) {
        send_error(
            out_tx,
            echo_id,
            "unsupported",
            format!("unknown message type: {type_str}"),
        )
        .await;
        return;
    }

    // Phase-1: only `settings_get` is wired. Re-parse into the typed
    // enum on that arm so a malformed payload (e.g. wrong field type)
    // still surfaces as `invalid_json` with the original `id` echoed.
    // Every other known type short-circuits to `unimplemented` without
    // a second parse — there is no per-variant payload to validate yet.
    if type_str == "settings_get" {
        match serde_json::from_value::<ClientMessage>(value) {
            Ok(ClientMessage::SettingsGet { id }) => {
                handle_settings_get(out_tx, id).await;
            }
            Ok(_) => {
                // Defensive: serde matched a different variant despite
                // the `type` tag we just inspected. Treat as a bug-class
                // error rather than panic so production stays up.
                tracing::error!(
                    target: "cloud_agent::dispatch",
                    %type_str,
                    "type tag did not match deserialized variant",
                );
                send_error(
                    out_tx,
                    echo_id,
                    "invalid_json",
                    "type tag did not match deserialized variant",
                )
                .await;
            }
            Err(error) => {
                send_error(
                    out_tx,
                    echo_id,
                    "invalid_json",
                    format!("failed to parse client message: {error}"),
                )
                .await;
            }
        }
        return;
    }

    send_error(
        out_tx,
        echo_id,
        "unimplemented",
        format!("'{type_str}' is not yet implemented on the cloud-agent"),
    )
    .await;
}

/// Stubbed `settings_get` reply (T19.24).
///
/// Returns a fixed [`SettingsView`] so the desktop WS client can prove
/// the dispatch loop is alive without the cloud-agent having to host a
/// `SQLite` copy of `app_settings` yet. Values mirror the TS defaults
/// (`theme = "dark"`, `lastActiveProject = null`) so the PWA reads the
/// same shape regardless of which backend answered.
async fn handle_settings_get(out_tx: &mpsc::Sender<String>, id: Option<String>) {
    let settings = SettingsView {
        theme: "dark".to_string(),
        last_active_project: None,
    };
    send(out_tx, &ServerMessage::SettingsResult { id, settings }).await;
}

async fn send(out_tx: &mpsc::Sender<String>, msg: &ServerMessage) {
    match serde_json::to_string(msg) {
        Ok(payload) => {
            // A closed channel means the connection is tearing down; the
            // sink_task has already exited so a dropped frame is the
            // right outcome.
            let _ = out_tx.send(payload).await;
        }
        Err(error) => {
            // Serialization of our own ServerMessage shouldn't fail —
            // log loudly so a regression in protocol.rs is visible.
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

    /// Drain everything the dispatcher emitted into a Vec<Value> for
    /// easy assertions. Closes the channel first so the loop terminates.
    async fn drive(payload: &str) -> Vec<Value> {
        let (out_tx, mut out_rx) = mpsc::channel::<String>(8);
        handle_text(&out_tx, payload).await;
        drop(out_tx);
        let mut frames = Vec::new();
        while let Some(raw) = out_rx.recv().await {
            frames.push(serde_json::from_str(&raw).expect("dispatcher emitted invalid JSON"));
        }
        frames
    }

    #[tokio::test]
    async fn settings_get_returns_stubbed_view() {
        let frames = drive(r#"{"type":"settings_get","id":"req-1"}"#).await;
        assert_eq!(frames.len(), 1, "expected one reply, got {frames:?}");
        let frame = &frames[0];
        assert_eq!(frame["type"], "settings_result");
        assert_eq!(frame["id"], "req-1");
        assert_eq!(frame["settings"]["theme"], "dark");
        assert!(
            frame["settings"]["lastActiveProject"].is_null(),
            "lastActiveProject must be explicit null, got {frame}",
        );
    }

    #[tokio::test]
    async fn settings_get_without_id_omits_id_field() {
        let frames = drive(r#"{"type":"settings_get"}"#).await;
        assert_eq!(frames.len(), 1);
        let frame = &frames[0];
        assert_eq!(frame["type"], "settings_result");
        assert!(
            frame.get("id").is_none(),
            "id must be omitted when client didn't supply one: {frame}",
        );
    }

    #[tokio::test]
    async fn unknown_type_replies_with_unsupported() {
        let frames = drive(r#"{"type":"nonsense","id":"req-2"}"#).await;
        assert_eq!(frames.len(), 1);
        let frame = &frames[0];
        assert_eq!(frame["type"], "error");
        assert_eq!(frame["kind"], "unsupported");
        assert_eq!(frame["id"], "req-2");
        assert!(
            frame["message"]
                .as_str()
                .unwrap_or_default()
                .contains("nonsense"),
            "message should mention the offending type: {frame}",
        );
    }

    #[tokio::test]
    async fn known_but_unimplemented_type_replies_with_unimplemented() {
        // `pty_spawn` is a real ClientMessage variant — it just has no
        // handler on the cloud-agent yet. The dispatcher must echo `id`
        // so the desktop client's promise resolves with the typed error
        // instead of timing out.
        let frames = drive(
            r#"{"type":"pty_spawn","id":"req-3","command":"bash","cols":80,"rows":24}"#,
        )
        .await;
        assert_eq!(frames.len(), 1);
        let frame = &frames[0];
        assert_eq!(frame["type"], "error");
        assert_eq!(frame["kind"], "unimplemented");
        assert_eq!(frame["id"], "req-3");
        assert!(
            frame["message"]
                .as_str()
                .unwrap_or_default()
                .contains("pty_spawn"),
            "message should mention the unimplemented type: {frame}",
        );
    }

    #[tokio::test]
    async fn malformed_json_replies_with_invalid_json_and_no_id() {
        // No `id` can be recovered before serde gives up; the reply has
        // to omit `id` entirely (not echo `null`) so the desktop client
        // doesn't try to resolve a promise on the wrong correlation slot.
        let frames = drive(r#"{"type": broken"#).await;
        assert_eq!(frames.len(), 1);
        let frame = &frames[0];
        assert_eq!(frame["type"], "error");
        assert_eq!(frame["kind"], "invalid_json");
        assert!(
            frame.get("id").is_none(),
            "id must be omitted when payload didn't parse: {frame}",
        );
    }

    #[tokio::test]
    async fn missing_type_replies_with_invalid_json_and_echoes_id() {
        // A well-formed JSON object with no `type` is the most common
        // shape of a bad client request — the `id` is recoverable so we
        // echo it.
        let frames = drive(r#"{"id":"req-4"}"#).await;
        assert_eq!(frames.len(), 1);
        let frame = &frames[0];
        assert_eq!(frame["type"], "error");
        assert_eq!(frame["kind"], "invalid_json");
        assert_eq!(frame["id"], "req-4");
    }

    #[tokio::test]
    async fn known_type_with_bad_payload_replies_invalid_json() {
        // `pty_write` is known, but `session_id` must be a UUID string.
        // Phase-1 short-circuits known-but-unimplemented to `unimplemented`
        // BEFORE attempting a typed parse — so a bogus payload still
        // surfaces as unimplemented, which is the desired Phase-1 shape
        // (the desktop client doesn't care about Cloud-side payload
        // validation for handlers that don't run). Encoded as a test so
        // we notice if Phase-2 ever wires the handler and the contract
        // tightens.
        let frames = drive(r#"{"type":"pty_write","id":"r","session_id":"nope","data":"aGk="}"#).await;
        assert_eq!(frames.len(), 1);
        let frame = &frames[0];
        assert_eq!(frame["type"], "error");
        assert_eq!(frame["kind"], "unimplemented");
        assert_eq!(frame["id"], "r");
    }

    #[tokio::test]
    async fn settings_get_with_bad_payload_replies_invalid_json() {
        // `settings_get`'s only field is the optional `id` (a string).
        // Passing the wrong type forces serde to fail; the dispatcher
        // must surface that as `invalid_json` rather than swallowing it
        // and replying with a default SettingsView.
        let frames = drive(r#"{"type":"settings_get","id":123}"#).await;
        assert_eq!(frames.len(), 1);
        let frame = &frames[0];
        assert_eq!(frame["type"], "error");
        assert_eq!(frame["kind"], "invalid_json");
        // `id` came in as a number; the dispatcher's two-phase parse
        // only echoes it when it's a string, so this frame should omit
        // it — same behavior the desktop bridge uses.
        assert!(
            frame.get("id").is_none(),
            "non-string id must not be echoed: {frame}",
        );
    }
}
