// T18.16 docs reference `PlanFlow` (CamelCase); backticking each
// mention hurts readability. Allow doc_markdown at the module level.
#![allow(clippy::doc_markdown)]

//! PlanFlow Chat handlers for the WebSocket bridge (T18.16).
//!
//! Sibling to [`super::pty_bridge`] / [`super::planflow_bridge`]. The
//! mobile PWA can:
//!   * POST a chat message (`planflow_chat_send`) — persisted to the
//!     `planflow_chats` table with `role = "user"` and forwarded to the
//!     desktop via a Tauri event so the live chat panel's active PTY
//!     receives the keystrokes.
//!   * Load the saved transcript (`planflow_chat_history`) — oldest-
//!     first; the UI uses this for first paint.
//!   * Wipe the transcript (`planflow_chat_clear`).
//!
//! The actual assistant reply lives in the desktop PTY's stdout stream
//! and isn't piped back through this bridge today — Phase 2's MVP is
//! "deliver the mobile keystroke; mobile keeps a local optimistic copy".
//! A later phase can mirror assistant turns back over the WS once the
//! desktop's chat integration writes them to `planflow_chats` itself.

use std::sync::Arc;

use sqlx::sqlite::SqlitePool;
use sqlx::Row;
use tokio::sync::mpsc;

use super::projects_bridge::AppEvents;
use super::protocol::{ChatMessageView, ServerMessage};

/// Default page size for `planflow_chat_history` when the client omits
/// `limit`. Matches the TS wrapper's default in
/// `src/db/planflowChats.ts`.
const DEFAULT_HISTORY_LIMIT: u32 = 200;

/// Upper bound on history responses so a misbehaving client can't pull
/// the entire table into a single WS frame.
const MAX_HISTORY_LIMIT: u32 = 1000;

pub async fn handle_chat_send(
    out_tx: &mpsc::Sender<String>,
    pool: &SqlitePool,
    events: &Arc<dyn AppEvents>,
    id: Option<String>,
    project_id: String,
    content: String,
) {
    if project_id.trim().is_empty() {
        send_error(out_tx, id, "invalid_args", "project_id must not be empty").await;
        return;
    }
    if content.trim().is_empty() {
        send_error(out_tx, id, "invalid_args", "content must not be empty").await;
        return;
    }
    // Cap at a reasonable size so a paste-bomb can't trash the DB or
    // overrun the PTY's stdin buffer. 32 KiB matches the desktop chat's
    // de-facto upper bound (claude code rejects above this on stdin).
    if content.len() > 32 * 1024 {
        send_error(
            out_tx,
            id,
            "invalid_args",
            "content exceeds 32KiB; shorten the message",
        )
        .await;
        return;
    }

    let created_at = i64::try_from(
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0),
    )
    .unwrap_or(0);

    // Persist first; emitting the Tauri event before the row lands could
    // race a desktop listener that reads from SQL on receipt.
    let insert = sqlx::query(
        "INSERT INTO planflow_chats (project_id, role, content, cli, tool_calls_json, created_at) \
         VALUES (?1, 'user', ?2, NULL, NULL, ?3)",
    )
    .bind(&project_id)
    .bind(&content)
    .bind(created_at)
    .execute(pool)
    .await;

    let message_id = match insert {
        Ok(result) => result.last_insert_rowid(),
        Err(error) => {
            send_error(
                out_tx,
                id,
                "internal",
                format!("persist chat message failed: {error}"),
            )
            .await;
            return;
        }
    };

    // Cross-runtime hop — the desktop frontend listens for this event
    // and writes the content into the active chat session's PTY. A
    // failed emit only logs (best-effort), since the row is already
    // saved and the mobile side will get an ack regardless.
    events.emit_planflow_chat_message(&project_id, &content);

    send(
        out_tx,
        &ServerMessage::PlanflowChatAck {
            id,
            message_id,
            created_at,
        },
    )
    .await;
}

pub async fn handle_chat_history(
    out_tx: &mpsc::Sender<String>,
    pool: &SqlitePool,
    id: Option<String>,
    project_id: String,
    limit: Option<u32>,
) {
    if project_id.trim().is_empty() {
        send_error(out_tx, id, "invalid_args", "project_id must not be empty").await;
        return;
    }
    let limit = limit
        .unwrap_or(DEFAULT_HISTORY_LIMIT)
        .min(MAX_HISTORY_LIMIT)
        .max(1);

    let rows = sqlx::query(
        "SELECT id, project_id, role, content, cli, created_at \
         FROM planflow_chats \
         WHERE project_id = ?1 \
         ORDER BY id DESC \
         LIMIT ?2",
    )
    .bind(&project_id)
    .bind(i64::from(limit))
    .fetch_all(pool)
    .await;

    let rows = match rows {
        Ok(rows) => rows,
        Err(error) => {
            send_error(
                out_tx,
                id,
                "internal",
                format!("load chat history failed: {error}"),
            )
            .await;
            return;
        }
    };

    // Oldest-first so the renderer can append straight into the message
    // list without a reverse step.
    let mut messages: Vec<ChatMessageView> = rows
        .into_iter()
        .map(|row| ChatMessageView {
            id: row.get::<i64, _>("id"),
            project_id: row.get::<String, _>("project_id"),
            role: row.get::<String, _>("role"),
            content: row.get::<String, _>("content"),
            cli: row.try_get::<Option<String>, _>("cli").unwrap_or(None),
            created_at: row.get::<i64, _>("created_at"),
        })
        .collect();
    messages.reverse();

    send(
        out_tx,
        &ServerMessage::PlanflowChatHistoryResult { id, messages },
    )
    .await;
}

pub async fn handle_chat_clear(
    out_tx: &mpsc::Sender<String>,
    pool: &SqlitePool,
    id: Option<String>,
    project_id: String,
) {
    if project_id.trim().is_empty() {
        send_error(out_tx, id, "invalid_args", "project_id must not be empty").await;
        return;
    }
    let result = sqlx::query("DELETE FROM planflow_chats WHERE project_id = ?1")
        .bind(&project_id)
        .execute(pool)
        .await;
    match result {
        Ok(r) => {
            send(
                out_tx,
                &ServerMessage::PlanflowChatCleared {
                    id,
                    rows_deleted: i64::try_from(r.rows_affected()).unwrap_or(0),
                },
            )
            .await;
        }
        Err(error) => {
            send_error(
                out_tx,
                id,
                "internal",
                format!("clear chat history failed: {error}"),
            )
            .await;
        }
    }
}

async fn send_error(
    out_tx: &mpsc::Sender<String>,
    id: Option<String>,
    kind: impl Into<String>,
    message: impl Into<String>,
) {
    let frame = ServerMessage::Error {
        id,
        kind: kind.into(),
        message: message.into(),
    };
    send(out_tx, &frame).await;
}

async fn send(out_tx: &mpsc::Sender<String>, msg: &ServerMessage) {
    if let Ok(payload) = serde_json::to_string(msg) {
        let _ = out_tx.send(payload).await;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::Executor;

    use super::*;

    #[derive(Default)]
    struct RecordingEvents {
        chat_messages: Mutex<Vec<(String, String)>>,
    }
    impl AppEvents for RecordingEvents {
        fn emit_active_project_changed(&self, _: Option<&str>) {}
        fn emit_planflow_chat_message(&self, project_id: &str, content: &str) {
            self.chat_messages
                .lock()
                .unwrap()
                .push((project_id.to_string(), content.to_string()));
        }
    }

    async fn pool_with_chats() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        pool.execute(include_str!("../../migrations/0009_planflow_chats.sql"))
            .await
            .expect("apply 0009");
        pool
    }

    fn channel() -> (mpsc::Sender<String>, mpsc::Receiver<String>) {
        mpsc::channel::<String>(8)
    }

    async fn drain(rx: &mut mpsc::Receiver<String>) -> serde_json::Value {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
            .await
            .expect("frame timeout")
            .expect("channel closed");
        serde_json::from_str(&frame).expect("parse frame")
    }

    #[tokio::test]
    async fn send_persists_and_emits_event() {
        let pool = pool_with_chats().await;
        let events = Arc::new(RecordingEvents::default());
        let events_dyn: Arc<dyn AppEvents> = events.clone();
        let (tx, mut rx) = channel();
        handle_chat_send(
            &tx,
            &pool,
            &events_dyn,
            Some("r-1".into()),
            "proj-1".into(),
            "hello".into(),
        )
        .await;
        let frame = drain(&mut rx).await;
        assert_eq!(frame["type"], "planflow_chat_ack");
        assert_eq!(frame["id"], "r-1");
        assert!(frame["message_id"].as_i64().unwrap() > 0);

        let calls = events.chat_messages.lock().unwrap().clone();
        assert_eq!(calls, vec![("proj-1".to_string(), "hello".to_string())]);
    }

    #[tokio::test]
    async fn send_rejects_empty_content() {
        let pool = pool_with_chats().await;
        let events: Arc<dyn AppEvents> = Arc::new(RecordingEvents::default());
        let (tx, mut rx) = channel();
        handle_chat_send(
            &tx,
            &pool,
            &events,
            Some("r-2".into()),
            "proj-1".into(),
            "   ".into(),
        )
        .await;
        let frame = drain(&mut rx).await;
        assert_eq!(frame["type"], "error");
        assert_eq!(frame["kind"], "invalid_args");
    }

    #[tokio::test]
    async fn history_returns_oldest_first() {
        let pool = pool_with_chats().await;
        let events: Arc<dyn AppEvents> = Arc::new(RecordingEvents::default());
        // Seed three rows; the handler returns them in chronological order.
        for (i, text) in ["one", "two", "three"].iter().enumerate() {
            let (tx, mut rx) = channel();
            handle_chat_send(
                &tx,
                &pool,
                &events,
                Some(format!("seed-{i}")),
                "proj-x".into(),
                (*text).into(),
            )
            .await;
            let _ = drain(&mut rx).await;
        }
        let (tx, mut rx) = channel();
        handle_chat_history(&tx, &pool, Some("r-h".into()), "proj-x".into(), Some(10)).await;
        let frame = drain(&mut rx).await;
        assert_eq!(frame["type"], "planflow_chat_history_result");
        let arr = frame["messages"].as_array().expect("messages array");
        assert_eq!(arr.len(), 3);
        assert_eq!(arr[0]["content"], "one");
        assert_eq!(arr[2]["content"], "three");
    }

    #[tokio::test]
    async fn clear_removes_all_rows_for_project() {
        let pool = pool_with_chats().await;
        let events: Arc<dyn AppEvents> = Arc::new(RecordingEvents::default());
        let (tx, mut rx) = channel();
        handle_chat_send(&tx, &pool, &events, None, "proj-z".into(), "doomed".into()).await;
        let _ = drain(&mut rx).await;
        let (tx, mut rx) = channel();
        handle_chat_clear(&tx, &pool, Some("r-c".into()), "proj-z".into()).await;
        let frame = drain(&mut rx).await;
        assert_eq!(frame["type"], "planflow_chat_cleared");
        assert_eq!(frame["rows_deleted"], 1);
    }
}
