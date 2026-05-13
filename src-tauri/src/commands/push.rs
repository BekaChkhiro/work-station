//! Tauri commands for the Web Push surface (T18.19).
//!
//! These give the desktop UI (and, transitively, the future T18.6 task
//! bridge) a way to fire push notifications without depending on the
//! HTTP/WebSocket layer. The actual delivery happens on a background
//! tokio task — the command returns as soon as the broadcast is queued.
//!
//! Each command returns `true` if the push service has booted (so the
//! broadcast was queued) and `false` if push is not currently available
//! — useful for the UI to surface "push not configured yet" without
//! plumbing a separate `push_status` query.

use crate::push::{self, PushKind, PushPayload};

#[tauri::command]
pub fn push_notify(title: String, body: String, kind: Option<String>) -> bool {
    let kind = kind.as_deref().map_or(PushKind::Info, parse_kind);
    let payload = PushPayload {
        title,
        body,
        kind,
        task_id: None,
    };
    queue(payload)
}

#[tauri::command]
pub fn push_notify_task_done(name: String, task_id: Option<String>) -> bool {
    let payload = PushPayload {
        task_id,
        ..PushPayload::task_done(name)
    };
    queue(payload)
}

#[tauri::command]
pub fn push_notify_task_error(name: String, message: String, task_id: Option<String>) -> bool {
    let payload = PushPayload {
        task_id,
        ..PushPayload::task_error(name, message)
    };
    queue(payload)
}

/// `true` when the push service has booted and a public VAPID key is
/// available for the PWA to subscribe with. The UI uses this to
/// gate the "Enable notifications" button.
#[tauri::command]
pub fn push_status() -> Option<String> {
    push::service().map(|s| s.public_key_b64().to_string())
}

fn queue(payload: PushPayload) -> bool {
    if push::service().is_none() {
        return false;
    }
    push::notify(payload);
    true
}

fn parse_kind(s: &str) -> PushKind {
    match s {
        "task_done" => PushKind::TaskDone,
        "task_error" => PushKind::TaskError,
        "session_exit" => PushKind::SessionExit,
        _ => PushKind::Info,
    }
}
