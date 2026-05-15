//! Projects + settings handlers for the WebSocket bridge (T18.4).
//!
//! Sibling to [`super::pty_bridge`] — that module owns the PTY-stream
//! handlers; this one owns the typed request/response handlers the
//! mobile PWA uses to render its sidebar (project list, active project)
//! and its appearance state (theme).
//!
//! Each handler is a free function over the shared outbound mpsc and
//! the read/write resources it needs (`SqlitePool` for the data,
//! [`AppEvents`] for the cross-runtime event hop). They don't take
//! [`pty_bridge::Connection`] because the projects/settings surface has
//! no per-session state — sharing that struct would just couple two
//! orthogonal feature areas without buying anything.
//!
//! The `AppEvents` indirection is a unit-testing seam: the production
//! impl ([`TauriAppEvents`]) emits a Tauri event so the desktop frontend
//! mirrors a PWA-driven project switch without polling; the test impl
//! ([`tests::RecordingEvents`]) records calls so handler tests can run
//! without spinning up a real Tauri app.

use std::sync::Arc;

use serde::Serialize;
use sqlx::sqlite::SqlitePool;
use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;

use crate::db::app_settings;
use crate::db::projects::{self, ProjectError};

use super::protocol::{ServerMessage, SettingsView};

/// Cross-runtime "active project changed" hop. The WS handler doesn't
/// know (or need to know) whether the desktop frontend exists — it
/// just calls [`AppEvents::emit_active_project_changed`] and the impl
/// dispatches via Tauri (in production) or records (in tests).
pub trait AppEvents: Send + Sync + 'static {
    /// Notify any non-WS subscribers that the active project just
    /// changed. `project_id` is `None` when the active project was
    /// explicitly cleared (reserved for a future "deselect" path —
    /// today every successful switch carries an id).
    fn emit_active_project_changed(&self, project_id: Option<&str>);

    /// T18.16 — a chat message arrived from the mobile PWA. The desktop
    /// frontend listens for this event and routes the content into the
    /// active PlanFlow chat session's PTY so the message appears in
    /// the live chat panel. Default impl is a no-op so callers that
    /// only stub `emit_active_project_changed` (e.g. tests) don't have
    /// to implement this until they exercise the chat path.
    fn emit_planflow_chat_message(&self, _project_id: &str, _content: &str) {}
}

/// Wire name of the Tauri event the desktop frontend listens on.
///
/// Kebab-case matches the rest of the project's app-level events
/// (`file:external-change`, `menu:*`). Bumping this string is a
/// breaking change for the desktop listener.
pub const ACTIVE_PROJECT_CHANGED_EVENT: &str = "active-project-changed";

/// T18.16 — Tauri event name the desktop frontend listens on to route
/// a mobile-originated chat message into the active PlanFlow chat
/// session's PTY. Kebab-case matches the rest of the app-level events.
pub const PLANFLOW_CHAT_MESSAGE_EVENT: &str = "planflow-chat-mobile-message";

/// Production [`AppEvents`] impl backed by a Tauri [`AppHandle`].
pub struct TauriAppEvents {
    app: AppHandle,
}

impl TauriAppEvents {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ActiveProjectChangedPayload<'a> {
    /// `None` round-trips as JSON `null` so a desktop listener can tell
    /// "explicitly cleared" from "field missing entirely".
    project_id: Option<&'a str>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PlanflowChatMessagePayload<'a> {
    project_id: &'a str,
    content: &'a str,
}

impl AppEvents for TauriAppEvents {
    fn emit_active_project_changed(&self, project_id: Option<&str>) {
        let payload = ActiveProjectChangedPayload { project_id };
        if let Err(error) = self.app.emit(ACTIVE_PROJECT_CHANGED_EVENT, payload) {
            tracing::warn!(
                target: "ws",
                %error,
                "failed to emit active-project-changed Tauri event",
            );
        }
    }

    fn emit_planflow_chat_message(&self, project_id: &str, content: &str) {
        let payload = PlanflowChatMessagePayload {
            project_id,
            content,
        };
        if let Err(error) = self.app.emit(PLANFLOW_CHAT_MESSAGE_EVENT, payload) {
            tracing::warn!(
                target: "ws",
                %error,
                "failed to emit planflow-chat-mobile-message Tauri event",
            );
        }
    }
}

/// Handle a `projects_list` request: reads the full project list and
/// replies with [`ServerMessage::ProjectsListResult`]. Sqlx errors
/// surface as a generic `error` frame with kind `internal` rather than
/// tearing down the connection.
pub async fn handle_projects_list(
    out_tx: &mpsc::Sender<String>,
    pool: &SqlitePool,
    id: Option<String>,
) {
    match projects::list(pool).await {
        Ok(projects) => {
            // T19.20: the protocol crate is Tauri-free, so the typed
            // `Vec<Project>` payload is serialized to JSON here at the
            // bridge boundary. `Project: Serialize` so `to_value` cannot
            // fail; the panic is documentation, not a real branch.
            let projects =
                serde_json::to_value(projects).expect("Project list always serializes to JSON");
            send(out_tx, &ServerMessage::ProjectsListResult { id, projects }).await;
        }
        Err(error) => send(out_tx, &project_error_to_frame(id, error)).await,
    }
}

/// Handle a `project_get` request. `not_found` surfaces when the
/// project id has no row (raced delete or stale client cache).
pub async fn handle_project_get(
    out_tx: &mpsc::Sender<String>,
    pool: &SqlitePool,
    id: Option<String>,
    project_id: String,
) {
    match projects::get(pool, &project_id).await {
        Ok(project) => {
            // T19.20: see `handle_projects_list` for why this serializes
            // the typed `Project` at the bridge boundary.
            let project = serde_json::to_value(project).expect("Project always serializes to JSON");
            send(out_tx, &ServerMessage::ProjectResult { id, project }).await;
        }
        Err(error) => send(out_tx, &project_error_to_frame(id, error)).await,
    }
}

/// Handle a `project_switch` request: verifies the project exists,
/// persists `app_settings.last_active_project`, fires the Tauri event
/// for desktop mirroring, and acks with [`ServerMessage::ProjectSwitched`].
///
/// Verification happens before the write so a typo'd id can't blank
/// out the active project; persistence happens before the event so a
/// desktop listener that immediately re-reads the row sees the new
/// value, not a brief flicker.
pub async fn handle_project_switch(
    out_tx: &mpsc::Sender<String>,
    pool: &SqlitePool,
    events: &Arc<dyn AppEvents>,
    id: Option<String>,
    project_id: String,
) {
    if let Err(error) = projects::get(pool, &project_id).await {
        send(out_tx, &project_error_to_frame(id, error)).await;
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

    events.emit_active_project_changed(Some(&project_id));

    send(out_tx, &ServerMessage::ProjectSwitched { id, project_id }).await;
}

/// Handle a `settings_get` request: reads `theme` + `last_active_project`
/// from `app_settings`, applying the same defaults the TS wrapper uses
/// when a row is missing or corrupt (`theme = "dark"`, `last_active_project = null`).
pub async fn handle_settings_get(
    out_tx: &mpsc::Sender<String>,
    pool: &SqlitePool,
    id: Option<String>,
) {
    let theme = app_settings::get_json::<String>(pool, app_settings::THEME_KEY)
        .await
        .ok()
        .flatten()
        .unwrap_or_else(|| "dark".to_string());

    // `Option<String>` matches the TS `ProjectIdSchema` (nullable string).
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

/// Map a [`ProjectError`] onto the wire `error` frame. Mirrors the
/// kind taxonomy `commands/projects.rs` uses for the desktop IPC path
/// so the PWA doesn't have to learn a second error shape.
fn project_error_to_frame(id: Option<String>, error: ProjectError) -> ServerMessage {
    let kind = match &error {
        ProjectError::NotFound(_) => "not_found",
        ProjectError::EmptyName
        | ProjectError::EmptyPath
        | ProjectError::NameTooLong(_)
        | ProjectError::ReorderMismatch { .. }
        | ProjectError::ReorderDuplicate(_) => "invalid_args",
        ProjectError::NameAlreadyExists(_) => "name_already_exists",
        ProjectError::PathDoesNotExist
        | ProjectError::PathNotDirectory
        | ProjectError::PathNotReadable => "invalid_path",
        ProjectError::EnvSerialize(_) | ProjectError::Sqlx(_) => "internal",
    };
    ServerMessage::Error {
        id,
        kind: kind.into(),
        message: error.to_string(),
    }
}

async fn send(out_tx: &mpsc::Sender<String>, msg: &ServerMessage) {
    if let Ok(payload) = serde_json::to_string(msg) {
        // If the receiver was dropped the connection is already going
        // away — swallow the error and let the parent task tear down.
        let _ = out_tx.send(payload).await;
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::sync::Mutex;

    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::Executor;

    use super::*;
    use crate::db::projects::NewProject;

    /// Stub events recorder used in tests — captures the project_id of
    /// every `emit_active_project_changed` call so handler tests can
    /// assert the cross-runtime hop fired exactly once with the right
    /// payload.
    #[derive(Default)]
    struct RecordingEvents {
        active_project_calls: Mutex<Vec<Option<String>>>,
    }

    impl RecordingEvents {
        fn new() -> Arc<Self> {
            Arc::new(Self::default())
        }

        fn snapshot(&self) -> Vec<Option<String>> {
            self.active_project_calls.lock().unwrap().clone()
        }
    }

    impl AppEvents for RecordingEvents {
        fn emit_active_project_changed(&self, project_id: Option<&str>) {
            self.active_project_calls
                .lock()
                .unwrap()
                .push(project_id.map(str::to_owned));
        }
    }

    async fn migrated_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        pool.execute("PRAGMA foreign_keys = ON;")
            .await
            .expect("enable fk");
        pool.execute(include_str!("../../migrations/0001_projects.sql"))
            .await
            .expect("apply 0001");
        pool.execute(include_str!("../../migrations/0002_sessions.sql"))
            .await
            .expect("apply 0002");
        pool.execute(include_str!("../../migrations/0003_app_settings.sql"))
            .await
            .expect("apply 0003");
        pool.execute(include_str!(
            "../../migrations/0004_project_startup_commands.sql"
        ))
        .await
        .expect("apply 0004");
        pool.execute(include_str!(
            "../../migrations/0006_project_workspace_tabs.sql"
        ))
        .await
        .expect("apply 0006");
        pool
    }

    /// Each handler test gets a fresh real directory so path validation
    /// passes — the projects table requires every row's path to exist
    /// and be a readable directory.
    fn make_dir() -> String {
        let id = uuid::Uuid::new_v4();
        let p = std::env::temp_dir().join(format!("ws-t184-{id}"));
        std::fs::create_dir_all(&p).expect("create test dir");
        std::fs::canonicalize(&p)
            .expect("canonicalize")
            .to_string_lossy()
            .into_owned()
    }

    fn sample_project(name: &str) -> NewProject {
        NewProject {
            name: name.into(),
            path: make_dir(),
            color: None,
            icon: None,
            default_cli: None,
            env: HashMap::new(),
            startup_commands: Vec::new(),
        }
    }

    fn parse_frame(payload: &str) -> serde_json::Value {
        serde_json::from_str(payload).expect("parse server frame")
    }

    #[tokio::test]
    async fn projects_list_returns_all_rows_in_order() {
        let pool = migrated_pool().await;
        projects::create(&pool, sample_project("alpha"))
            .await
            .expect("a");
        projects::create(&pool, sample_project("beta"))
            .await
            .expect("b");

        let (tx, mut rx) = mpsc::channel::<String>(8);
        handle_projects_list(&tx, &pool, Some("req-1".into())).await;

        let frame = rx.recv().await.expect("frame");
        let parsed = parse_frame(&frame);
        assert_eq!(parsed["type"], "projects_list_result");
        assert_eq!(parsed["id"], "req-1");
        let names: Vec<_> = parsed["projects"]
            .as_array()
            .expect("array")
            .iter()
            .map(|p| p["name"].as_str().unwrap().to_owned())
            .collect();
        assert_eq!(names, vec!["alpha".to_string(), "beta".to_string()]);
    }

    #[tokio::test]
    async fn project_get_returns_camel_cased_project() {
        let pool = migrated_pool().await;
        let created = projects::create(&pool, sample_project("alpha"))
            .await
            .expect("create");

        let (tx, mut rx) = mpsc::channel::<String>(8);
        handle_project_get(&tx, &pool, Some("r".into()), created.id.clone()).await;
        let frame = rx.recv().await.expect("frame");
        let parsed = parse_frame(&frame);
        assert_eq!(parsed["type"], "project_result");
        assert_eq!(parsed["project"]["id"], created.id);
        // CamelCase fields come from the Project struct's serde rename.
        assert!(
            parsed["project"]["workspaceTabs"].is_array(),
            "expected camelCase workspaceTabs, got {parsed}"
        );
    }

    #[tokio::test]
    async fn project_get_unknown_id_returns_not_found_error() {
        let pool = migrated_pool().await;
        let (tx, mut rx) = mpsc::channel::<String>(8);
        handle_project_get(&tx, &pool, Some("r".into()), "ghost".into()).await;
        let parsed = parse_frame(&rx.recv().await.expect("frame"));
        assert_eq!(parsed["type"], "error");
        assert_eq!(parsed["kind"], "not_found");
        assert_eq!(parsed["id"], "r");
    }

    #[tokio::test]
    async fn project_switch_persists_setting_and_emits_event() {
        let pool = migrated_pool().await;
        let created = projects::create(&pool, sample_project("alpha"))
            .await
            .expect("create");
        let events = RecordingEvents::new();
        let events_dyn: Arc<dyn AppEvents> = events.clone();

        let (tx, mut rx) = mpsc::channel::<String>(8);
        handle_project_switch(
            &tx,
            &pool,
            &events_dyn,
            Some("req-1".into()),
            created.id.clone(),
        )
        .await;

        let parsed = parse_frame(&rx.recv().await.expect("frame"));
        assert_eq!(parsed["type"], "project_switched");
        assert_eq!(parsed["project_id"], created.id);
        assert_eq!(parsed["id"], "req-1");

        // Persisted as JSON-encoded TEXT (`"<id>"`) per the TS wrapper.
        let stored: Option<String> =
            app_settings::get_json(&pool, app_settings::LAST_ACTIVE_PROJECT_KEY)
                .await
                .expect("get setting");
        assert_eq!(stored.as_deref(), Some(created.id.as_str()));

        // Tauri event fired exactly once with the new id.
        let calls = events.snapshot();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0].as_deref(), Some(created.id.as_str()));
    }

    #[tokio::test]
    async fn project_switch_rejects_unknown_id_without_persisting() {
        let pool = migrated_pool().await;
        let events = RecordingEvents::new();
        let events_dyn: Arc<dyn AppEvents> = events.clone();

        let (tx, mut rx) = mpsc::channel::<String>(8);
        handle_project_switch(&tx, &pool, &events_dyn, Some("r".into()), "ghost".into()).await;
        let parsed = parse_frame(&rx.recv().await.expect("frame"));
        assert_eq!(parsed["type"], "error");
        assert_eq!(parsed["kind"], "not_found");

        // No row written, no event fired.
        let stored: Option<String> =
            app_settings::get_json(&pool, app_settings::LAST_ACTIVE_PROJECT_KEY)
                .await
                .expect("get setting");
        assert!(stored.is_none(), "setting must not be touched on failure");
        assert!(events.snapshot().is_empty(), "no event on failure");
    }

    #[tokio::test]
    async fn settings_get_returns_defaults_when_rows_absent() {
        let pool = migrated_pool().await;
        let (tx, mut rx) = mpsc::channel::<String>(8);
        handle_settings_get(&tx, &pool, None).await;
        let parsed = parse_frame(&rx.recv().await.expect("frame"));
        assert_eq!(parsed["type"], "settings_result");
        assert_eq!(parsed["settings"]["theme"], "dark");
        assert!(parsed["settings"]["lastActiveProject"].is_null());
    }

    #[tokio::test]
    async fn settings_get_returns_persisted_values() {
        let pool = migrated_pool().await;
        app_settings::set_json(&pool, app_settings::THEME_KEY, &"light")
            .await
            .expect("set theme");
        app_settings::set_json(&pool, app_settings::LAST_ACTIVE_PROJECT_KEY, &"abc")
            .await
            .expect("set active");

        let (tx, mut rx) = mpsc::channel::<String>(8);
        handle_settings_get(&tx, &pool, Some("req-1".into())).await;
        let parsed = parse_frame(&rx.recv().await.expect("frame"));
        assert_eq!(parsed["settings"]["theme"], "light");
        assert_eq!(parsed["settings"]["lastActiveProject"], "abc");
        assert_eq!(parsed["id"], "req-1");
    }

    #[tokio::test]
    async fn settings_get_tolerates_corrupt_rows() {
        let pool = migrated_pool().await;
        // Stored as plain text, not valid JSON — should fall back to default.
        sqlx::query("INSERT INTO app_settings (key, value) VALUES (?, ?)")
            .bind(app_settings::THEME_KEY)
            .bind("not json")
            .execute(&pool)
            .await
            .expect("seed garbage");

        let (tx, mut rx) = mpsc::channel::<String>(8);
        handle_settings_get(&tx, &pool, None).await;
        let parsed = parse_frame(&rx.recv().await.expect("frame"));
        assert_eq!(parsed["settings"]["theme"], "dark");
    }
}
