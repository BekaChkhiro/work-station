// T19.25 prose mentions `SQLite`, `PlanFlow`, `WebSocket` in passing.
// Backticking each occurrence hurts readability; allow the doc-markdown
// lint at the module level, matching `workstation-core::ws::protocol`.
#![allow(clippy::doc_markdown)]

//! Per-connection WebSocket dispatch loop for the cloud-agent.
//!
//! T19.24 stood up the loop end-to-end with a stubbed `settings_get`
//! reply so the desktop WS client could prove the round-trip without
//! standing up SQLite on the VPS. T19.25 replaces the stub with the
//! real DB-backed handler and lights up the projects bridge
//! (`projects_list`, `project_get`, `project_switch`) against the
//! cloud-agent's own SQLite at `<state_dir>/cloud-agent.db`. The error
//! taxonomy mirrors the desktop bridge so the PWA / desktop client
//! doesn't need a second branch table:
//!
//!   * `invalid_json`  — payload didn't parse, or `type` was missing.
//!   * `unsupported`   — `type` is a string we don't recognize at all.
//!   * `unimplemented` — `type` is known but the cloud-agent hasn't
//!     wired its handler yet (PTY / FS / PlanFlow land in follow-ups).
//!   * `invalid_frame` — client sent a binary frame on a text-only wire.
//!   * `not_found`     — project id in the request doesn't exist.
//!   * `internal`      — SQLite or serialization failure.

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use sqlx::sqlite::SqlitePool;
use tokio::sync::mpsc;
use workstation_core::ws::protocol::{
    ClientMessage, ServerMessage, SettingsView, KNOWN_CLIENT_TYPES,
};

use crate::db::{app_settings, projects};

/// Capacity for the per-connection outbound mpsc. Phase-1 has only the
/// request/response lane; the headroom is for PTY / project forwarders
/// in follow-up tasks.
const OUTBOUND_CHANNEL_CAPACITY: usize = 64;

/// Drive a single authenticated WebSocket connection until the peer
/// closes or the socket errors. Returns when the read half drains and
/// the sink task has flushed.
///
/// `pool` is cloned per call so the dispatcher holds its own handle;
/// `SqlitePool` is internally Arc-shared, so cloning is cheap and
/// dropping our copy on connection teardown doesn't affect other
/// concurrent connections.
pub async fn run_connection(socket: WebSocket, pool: SqlitePool) {
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

    while let Some(frame) = ws_rx.next().await {
        let Ok(msg) = frame else {
            break;
        };
        match msg {
            Message::Text(payload) => {
                handle_text(&out_tx, &pool, &payload).await;
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
            Message::Ping(_) | Message::Pong(_) => {}
            Message::Close(_) => break,
        }
    }

    drop(out_tx);
    let _ = sink_task.await;
}

/// Two-phase parse so we can echo `id` on every failure path and
/// distinguish "unknown message type" (`unsupported`) from "malformed
/// payload for a known type" (`invalid_json`). Mirrors the desktop
/// bridge's `super::ws::pty_bridge::handle_text` flow.
async fn handle_text(out_tx: &mpsc::Sender<String>, pool: &SqlitePool, payload: &str) {
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

    // Wired handlers re-parse into the typed enum so a malformed payload
    // (e.g. wrong field type) surfaces as `invalid_json` with the
    // original `id` echoed. Unimplemented branches short-circuit before
    // a typed parse — the Phase-1 client doesn't depend on cloud-side
    // payload validation for handlers that haven't run yet.
    match type_str.as_str() {
        "settings_get" => {
            handle_typed::<_, _>(out_tx, value, echo_id, |out_tx, msg, id| async move {
                if let ClientMessage::SettingsGet { id } = msg {
                    handle_settings_get(&out_tx, pool, id).await;
                } else {
                    send_variant_mismatch(&out_tx, id).await;
                }
            })
            .await;
        }
        "projects_list" => {
            handle_typed::<_, _>(out_tx, value, echo_id, |out_tx, msg, id| async move {
                if let ClientMessage::ProjectsList { id } = msg {
                    handle_projects_list(&out_tx, pool, id).await;
                } else {
                    send_variant_mismatch(&out_tx, id).await;
                }
            })
            .await;
        }
        "project_get" => {
            handle_typed::<_, _>(out_tx, value, echo_id, |out_tx, msg, id| async move {
                if let ClientMessage::ProjectGet { id, project_id } = msg {
                    handle_project_get(&out_tx, pool, id, project_id).await;
                } else {
                    send_variant_mismatch(&out_tx, id).await;
                }
            })
            .await;
        }
        "project_switch" => {
            handle_typed::<_, _>(out_tx, value, echo_id, |out_tx, msg, id| async move {
                if let ClientMessage::ProjectSwitch { id, project_id } = msg {
                    handle_project_switch(&out_tx, pool, id, project_id).await;
                } else {
                    send_variant_mismatch(&out_tx, id).await;
                }
            })
            .await;
        }
        other => {
            send_error(
                out_tx,
                echo_id,
                "unimplemented",
                format!("'{other}' is not yet implemented on the cloud-agent"),
            )
            .await;
        }
    }
}

/// Shared typed-parse helper: re-parse the inspected payload as a
/// [`ClientMessage`] and dispatch via `f`, mapping a parse failure to
/// `invalid_json` with the original `id` echoed.
async fn handle_typed<F, Fut>(
    out_tx: &mpsc::Sender<String>,
    value: serde_json::Value,
    echo_id: Option<String>,
    f: F,
) where
    F: FnOnce(mpsc::Sender<String>, ClientMessage, Option<String>) -> Fut,
    Fut: std::future::Future<Output = ()>,
{
    match serde_json::from_value::<ClientMessage>(value) {
        Ok(msg) => {
            f(out_tx.clone(), msg, echo_id).await;
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
}

/// Defensive log + error reply when serde matches a different variant
/// than the inspected `type` tag — this shouldn't happen in practice
/// since the tag-driven enum is bijective, but treating it as a
/// bug-class `invalid_json` keeps the daemon up if `protocol.rs` ever
/// drifts.
async fn send_variant_mismatch(out_tx: &mpsc::Sender<String>, id: Option<String>) {
    tracing::error!(
        target: "cloud_agent::dispatch",
        "type tag did not match deserialized variant",
    );
    send_error(
        out_tx,
        id,
        "invalid_json",
        "type tag did not match deserialized variant",
    )
    .await;
}

/// DB-backed `settings_get` reply (T19.25).
///
/// Reads `theme` + `last_active_project` from the cloud-agent's
/// `app_settings` table, applying the same defaults the TS wrapper uses
/// when a row is missing or corrupt (`theme = "dark"`,
/// `last_active_project = null`). Mirrors the desktop bridge's
/// `src-tauri/src/ws/projects_bridge.rs::handle_settings_get` so a PWA
/// pointed at either backend sees the same shape.
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

    // Outer flatten turns `Ok(None)` into `None`; inner turns a stored
    // JSON `null` (`Some(None)`) into `None` too, so callers always see
    // a flat `Option<String>` no matter which "missing" shape produced it.
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

/// `projects_list` (T19.25): full project list ordered by position.
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

/// `project_get` (T19.25): single project by id, or `not_found`.
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

/// `project_switch` (T19.25): verify the project exists, persist
/// `app_settings.last_active_project`, ack. Desktop emits a Tauri event
/// on its side for cross-runtime mirroring (see
/// `projects_bridge::handle_project_switch`); the cloud-agent has no
/// equivalent listener so the cross-WS broadcast variant
/// [`ServerMessage::ActiveProjectChanged`] stays reserved — Phase-1
/// clients re-fetch on next `settings_get` to learn about the change.
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
    use tempfile::tempdir;

    async fn fresh_pool() -> SqlitePool {
        let dir = tempdir().expect("tempdir");
        let dir = Box::leak(Box::new(dir));
        crate::db::open(dir.path()).await.expect("open")
    }

    /// Drain everything the dispatcher emitted into a Vec<Value> for
    /// easy assertions. Closes the channel first so the loop terminates.
    async fn drive(pool: &SqlitePool, payload: &str) -> Vec<Value> {
        let (out_tx, mut out_rx) = mpsc::channel::<String>(8);
        handle_text(&out_tx, pool, payload).await;
        drop(out_tx);
        let mut frames = Vec::new();
        while let Some(raw) = out_rx.recv().await {
            frames.push(serde_json::from_str(&raw).expect("dispatcher emitted invalid JSON"));
        }
        frames
    }

    /// Seed a single project row for handler tests.
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
        // `pty_spawn` is still unimplemented after T19.25.
        let pool = fresh_pool().await;
        let frames = drive(
            &pool,
            r#"{"type":"pty_spawn","id":"req-3","command":"bash","cols":80,"rows":24}"#,
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
}
