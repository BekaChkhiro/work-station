// T18.6 — PlanFlow uses CamelCase in prose; the `clippy::doc_markdown`
// lint demands backticks for any bare CamelCase identifier in docs.
// Wrapping every mention is illegible; allow at the module level.
#![allow(clippy::doc_markdown)]

//! PlanFlow Tasks bridge handlers (T18.6).
//!
//! Sibling module to [`super::pty_bridge`] in the architecture sketch
//! ("either add new variants to protocol.rs + handler arms in
//! pty_bridge.rs, or create sibling bridge modules wired into the same
//! router"). The dispatch lives in `pty_bridge` so all wire messages
//! flow through one `handle_text` switch, but the actual proxy work
//! lives here so the PTY hot path doesn't grow.
//!
//! Wire model:
//!   * Each `ClientMessage::Planflow*` is forwarded to
//!     `https://api.planflow.tools` using the desktop's
//!     [`crate::http::Client`] (retries + cache for free).
//!   * The PlanFlow API token comes from the OS-native credential store
//!     under `("planflow", "default")` — the mobile client never sees
//!     it. The token is fetched per-request so a token rotation in
//!     Settings → Integrations takes effect on the next call without
//!     restarting the bridge.
//!   * Success unwraps PlanFlow's `{success, data: ...}` envelope and
//!     ships the inner payload back as `planflow_result.data`.
//!   * Failure maps to a stable `kind` so the PWA can branch without
//!     parsing prose: `unauthorized` (401/403), `rate_limited` (429),
//!     `not_found` (404), `server` (5xx after retries),
//!     `network` / `timeout` (transport), `decode` (bad envelope),
//!     `no_credential` (no PlanFlow token configured), `invalid_args`.
//!
//! Side effects:
//!   * `planflow_update_task_status` with `status == "DONE"` triggers a
//!     Web Push broadcast (T18.19 — `push::notify`) so the user's
//!     phone wakes up even when the PWA tab isn't focused. Failure to
//!     send the push is logged, never returned — the API call already
//!     succeeded.

use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::credentials;
use crate::http::{self, HttpError};
use crate::push::{self, PushPayload};

use super::protocol::ServerMessage;

/// Default PlanFlow API base URL. Overridden by `PLANFLOW_BASE_URL` for
/// integration tests and for users running a self-hosted PlanFlow
/// instance.
pub const DEFAULT_BASE_URL: &str = "https://api.planflow.tools";

/// Env var for overriding the base URL (used by tests + power users).
pub const BASE_URL_ENV: &str = "PLANFLOW_BASE_URL";

/// Credential keychain coordinates.
pub const CREDENTIAL_INTEGRATION: &str = "planflow";
pub const CREDENTIAL_ACCOUNT: &str = "default";

/// Token loader used by the bridge. Boxed for test injection — the
/// real boot path uses [`load_token_from_keychain`].
pub type TokenLoader = Arc<dyn Fn() -> Result<Option<String>, String> + Send + Sync + 'static>;

/// Shared state for the PlanFlow bridge. One instance per bridge boot,
/// cheaply cloneable into per-connection state.
#[derive(Clone)]
pub struct PlanflowState {
    http: http::Client,
    base_url: String,
    token_loader: TokenLoader,
}

impl std::fmt::Debug for PlanflowState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PlanflowState")
            .field("base_url", &self.base_url)
            .finish_non_exhaustive()
    }
}

impl PlanflowState {
    pub fn new(http: http::Client) -> Self {
        let base_url = std::env::var(BASE_URL_ENV)
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
        Self {
            http,
            base_url: trim_trailing_slash(&base_url),
            token_loader: Arc::new(load_token_from_keychain),
        }
    }

    /// Test seam: build a bridge with a custom base URL + token loader.
    /// Not part of the public surface — the production path always
    /// resolves both from the environment / keychain at request time.
    #[cfg(test)]
    pub fn with_loader(
        http: http::Client,
        base_url: impl Into<String>,
        token_loader: TokenLoader,
    ) -> Self {
        Self {
            http,
            base_url: trim_trailing_slash(&base_url.into()),
            token_loader,
        }
    }
}

fn trim_trailing_slash(s: &str) -> String {
    s.trim_end_matches('/').to_string()
}

/// Real keychain-backed token loader. Wrapped so we can return a String
/// error (the bridge never needs to differentiate credential-error
/// variants from the wire — it only cares whether a token exists).
fn load_token_from_keychain() -> Result<Option<String>, String> {
    credentials::get(CREDENTIAL_INTEGRATION, CREDENTIAL_ACCOUNT).map_err(|e| e.to_string())
}

// ---------- Public handler entry points ----------

pub async fn handle_get_me(
    state: &PlanflowState,
    out_tx: &mpsc::Sender<String>,
    id: Option<String>,
) {
    proxy_get(state, out_tx, id, "/auth/me", &[]).await;
}

pub async fn handle_list_projects(
    state: &PlanflowState,
    out_tx: &mpsc::Sender<String>,
    id: Option<String>,
    organization_id: Option<String>,
) {
    // PlanFlow's `/projects` requires `organizationId`. The desktop
    // client handles this by listing organizations first and using the
    // first one's id (see `src/integrations/planflow/client.ts`). The
    // mobile PWA has no UI to pick orgs, so we mirror that fallback
    // here: when the caller didn't pass one, resolve it on the fly.
    let resolved_org = match organization_id {
        Some(org) if !org.is_empty() => Some(org),
        _ => match resolve_first_org_id(state).await {
            Ok(Some(org)) => Some(org),
            Ok(None) => {
                send_error(
                    out_tx,
                    id,
                    "invalid_args",
                    "PlanFlow account has no organizations",
                    None,
                )
                .await;
                return;
            }
            Err(error) => {
                send_proxy_error(out_tx, id, error).await;
                return;
            }
        },
    };
    let query: Vec<(&str, String)> = match resolved_org {
        Some(org) => vec![("organizationId", org)],
        None => Vec::new(),
    };
    proxy_get(state, out_tx, id, "/projects", &query).await;
}

/// Hit `/organizations` and pick the first id, matching the desktop
/// client's auto-pick behaviour (see `src/integrations/planflow/client.ts`).
/// Returns `Ok(None)` for accounts with zero organizations so the
/// caller can surface a friendly error.
async fn resolve_first_org_id(state: &PlanflowState) -> Result<Option<String>, ProxyError> {
    let value = proxy_request(state, http::Method::Get, "/organizations", None).await?;
    let orgs = value
        .get("organizations")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(orgs
        .into_iter()
        .find_map(|o| o.get("id").and_then(|v| v.as_str()).map(str::to_owned)))
}

pub async fn handle_list_tasks(
    state: &PlanflowState,
    out_tx: &mpsc::Sender<String>,
    id: Option<String>,
    project_id: String,
    status: Option<String>,
) {
    if project_id.trim().is_empty() {
        send_error(
            out_tx,
            id,
            "invalid_args",
            "project_id must not be empty",
            None,
        )
        .await;
        return;
    }
    let path = format!("/projects/{}/tasks", urlencode(&project_id));
    let query: Vec<(&str, String)> = match status {
        Some(s) if !s.is_empty() => vec![("status", s)],
        _ => Vec::new(),
    };
    proxy_get(state, out_tx, id, &path, &query).await;
}

pub async fn handle_list_active_work(
    state: &PlanflowState,
    out_tx: &mpsc::Sender<String>,
    id: Option<String>,
    project_id: String,
) {
    if project_id.trim().is_empty() {
        send_error(
            out_tx,
            id,
            "invalid_args",
            "project_id must not be empty",
            None,
        )
        .await;
        return;
    }
    let path = format!("/projects/{}/active-work", urlencode(&project_id));
    proxy_get(state, out_tx, id, &path, &[]).await;
}

pub async fn handle_list_comments(
    state: &PlanflowState,
    out_tx: &mpsc::Sender<String>,
    id: Option<String>,
    project_id: String,
    task_id: String,
) {
    if project_id.trim().is_empty() || task_id.trim().is_empty() {
        send_error(
            out_tx,
            id,
            "invalid_args",
            "project_id and task_id must not be empty",
            None,
        )
        .await;
        return;
    }
    let path = format!(
        "/projects/{}/tasks/{}/comments",
        urlencode(&project_id),
        urlencode(&task_id)
    );
    proxy_get(state, out_tx, id, &path, &[]).await;
}

pub async fn handle_create_comment(
    state: &PlanflowState,
    out_tx: &mpsc::Sender<String>,
    id: Option<String>,
    project_id: String,
    task_id: String,
    body: String,
) {
    if project_id.trim().is_empty() || task_id.trim().is_empty() {
        send_error(
            out_tx,
            id,
            "invalid_args",
            "project_id and task_id must not be empty",
            None,
        )
        .await;
        return;
    }
    if body.trim().is_empty() {
        send_error(
            out_tx,
            id,
            "invalid_args",
            "comment body must not be empty",
            None,
        )
        .await;
        return;
    }
    let path = format!(
        "/projects/{}/tasks/{}/comments",
        urlencode(&project_id),
        urlencode(&task_id)
    );
    // PlanFlow expects `content`, not `body` — matches the desktop
    // client's translation in `src/integrations/planflow/client.ts`.
    let payload = json!({ "content": body });
    proxy_json(state, out_tx, id, http::Method::Post, &path, &payload).await;
}

pub async fn handle_start_work(
    state: &PlanflowState,
    out_tx: &mpsc::Sender<String>,
    id: Option<String>,
    project_id: String,
    task_id: String,
) {
    if project_id.trim().is_empty() || task_id.trim().is_empty() {
        send_error(
            out_tx,
            id,
            "invalid_args",
            "project_id and task_id must not be empty",
            None,
        )
        .await;
        return;
    }
    let path = format!(
        "/projects/{}/tasks/{}/work",
        urlencode(&project_id),
        urlencode(&task_id)
    );
    let payload = json!({ "action": "start" });
    proxy_json(state, out_tx, id, http::Method::Post, &path, &payload).await;
}

pub async fn handle_stop_work(
    state: &PlanflowState,
    out_tx: &mpsc::Sender<String>,
    id: Option<String>,
    project_id: String,
) {
    if project_id.trim().is_empty() {
        send_error(
            out_tx,
            id,
            "invalid_args",
            "project_id must not be empty",
            None,
        )
        .await;
        return;
    }
    // PlanFlow's stop-work endpoint takes `_` as the path task id —
    // mirrors the desktop client.
    let path = format!("/projects/{}/tasks/_/work", urlencode(&project_id));
    let payload = json!({ "action": "stop" });
    proxy_json(state, out_tx, id, http::Method::Post, &path, &payload).await;
}

pub async fn handle_update_task_status(
    state: &PlanflowState,
    out_tx: &mpsc::Sender<String>,
    id: Option<String>,
    project_id: String,
    task_id: String,
    status: String,
) {
    if project_id.trim().is_empty() || task_id.trim().is_empty() {
        send_error(
            out_tx,
            id,
            "invalid_args",
            "project_id and task_id must not be empty",
            None,
        )
        .await;
        return;
    }
    if status.trim().is_empty() {
        send_error(out_tx, id, "invalid_args", "status must not be empty", None).await;
        return;
    }
    // PlanFlow's bulk-status route takes task UUIDs in the body. The
    // mobile client may pass either the UUID or the human-readable
    // taskId (`T1.1`). When it's the latter we resolve it via a
    // list-tasks round-trip — matches the desktop client.
    let task_uuid = if looks_like_uuid(&task_id) {
        task_id.clone()
    } else {
        match resolve_task_uuid(state, &project_id, &task_id).await {
            Ok(uuid) => uuid,
            Err(err) => {
                send_proxy_error(out_tx, id, err).await;
                return;
            }
        }
    };

    let path = format!("/projects/{}/tasks/bulk-status", urlencode(&project_id));
    let payload = json!({ "taskIds": [task_uuid], "status": status });
    let response = proxy_request(state, http::Method::Post, &path, Some(&payload)).await;

    match response {
        Ok(value) => {
            // Best-effort push on DONE. We use the patched task's name
            // when the server echoes it back; otherwise fall back to the
            // caller-supplied taskId so the notification still has
            // something readable.
            if status.eq_ignore_ascii_case("DONE") {
                let task_name = extract_first_task_name(&value).unwrap_or_else(|| task_id.clone());
                push::notify(PushPayload::task_done(task_name));
            }
            send(out_tx, &ServerMessage::planflow_result(id, value)).await;
        }
        Err(err) => send_proxy_error(out_tx, id, err).await,
    }
}

// ---------- HTTP plumbing ----------

#[derive(Debug)]
enum ProxyError {
    NoCredential,
    Credential(String),
    Http(HttpError),
    /// Non-2xx response — body is captured for the error frame so the
    /// PWA can show the upstream message verbatim if it wants.
    Upstream {
        status: u16,
        body: String,
    },
    /// PlanFlow's envelope didn't parse — almost always a server-side
    /// breaking change; surfacing it loudly is the right call.
    Decode(String),
}

async fn proxy_get(
    state: &PlanflowState,
    out_tx: &mpsc::Sender<String>,
    id: Option<String>,
    path: &str,
    query: &[(&str, String)],
) {
    let url = build_url(&state.base_url, path, query);
    match proxy_request_url(state, http::Method::Get, &url, None).await {
        Ok(value) => send(out_tx, &ServerMessage::planflow_result(id, value)).await,
        Err(err) => send_proxy_error(out_tx, id, err).await,
    }
}

async fn proxy_json(
    state: &PlanflowState,
    out_tx: &mpsc::Sender<String>,
    id: Option<String>,
    method: http::Method,
    path: &str,
    body: &Value,
) {
    match proxy_request(state, method, path, Some(body)).await {
        Ok(value) => send(out_tx, &ServerMessage::planflow_result(id, value)).await,
        Err(err) => send_proxy_error(out_tx, id, err).await,
    }
}

async fn proxy_request(
    state: &PlanflowState,
    method: http::Method,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, ProxyError> {
    let url = build_url(&state.base_url, path, &[]);
    proxy_request_url(state, method, &url, body).await
}

async fn proxy_request_url(
    state: &PlanflowState,
    method: http::Method,
    url: &str,
    body: Option<&Value>,
) -> Result<Value, ProxyError> {
    let token = match (state.token_loader)() {
        Ok(Some(t)) => t,
        Ok(None) => return Err(ProxyError::NoCredential),
        Err(e) => return Err(ProxyError::Credential(e)),
    };

    let mut builder = state
        .http
        .request(method, url.to_string())
        .service("planflow")
        .bearer(token)
        .header("accept", "application/json");
    if let Some(body) = body {
        let bytes = serde_json::to_vec(body).map_err(|e| ProxyError::Decode(e.to_string()))?;
        builder = builder
            .header("content-type", "application/json")
            .body_bytes(bytes);
    }
    let response = builder.send().await.map_err(ProxyError::Http)?;

    if !(200..300).contains(&response.status) {
        let body_text = String::from_utf8_lossy(&response.body).to_string();
        return Err(ProxyError::Upstream {
            status: response.status,
            body: body_text,
        });
    }

    // 204 No Content is normal for start_work / stop_work / mark-read.
    // Surface as `data: null` so the mobile side gets a stable shape.
    if response.body.is_empty() {
        return Ok(Value::Null);
    }
    let parsed: Value =
        serde_json::from_slice(&response.body).map_err(|e| ProxyError::Decode(e.to_string()))?;
    Ok(unwrap_envelope(parsed))
}

/// PlanFlow wraps successful responses in `{ success: true, data: ... }`.
/// Strip the wrapper when present so the mobile client sees the inner
/// payload regardless of which endpoint it called — matches the
/// `parseEnvelope` behaviour in the desktop TS client.
fn unwrap_envelope(value: Value) -> Value {
    match value {
        Value::Object(ref map) if map.contains_key("data") => {
            if let Value::Object(map) = value {
                let mut owned = map;
                owned.remove("data").unwrap_or(Value::Null)
            } else {
                unreachable!("matched Object above")
            }
        }
        other => other,
    }
}

async fn resolve_task_uuid(
    state: &PlanflowState,
    project_id: &str,
    task_id: &str,
) -> Result<String, ProxyError> {
    let path = format!("/projects/{}/tasks", urlencode(project_id));
    let url = build_url(&state.base_url, &path, &[]);
    let value = proxy_request_url(state, http::Method::Get, &url, None).await?;
    let tasks = value
        .get("tasks")
        .and_then(|v| v.as_array())
        .ok_or_else(|| ProxyError::Decode("missing `tasks` array".to_string()))?;
    for task in tasks {
        if task.get("taskId").and_then(|v| v.as_str()) == Some(task_id) {
            if let Some(uuid) = task.get("id").and_then(|v| v.as_str()) {
                return Ok(uuid.to_string());
            }
        }
    }
    Err(ProxyError::Upstream {
        status: 404,
        body: format!("task {task_id} not found in project"),
    })
}

fn extract_first_task_name(value: &Value) -> Option<String> {
    value
        .get("tasks")
        .and_then(|v| v.as_array())
        .and_then(|arr| arr.first())
        .and_then(|task| task.get("name"))
        .and_then(|v| v.as_str())
        .map(str::to_string)
}

fn looks_like_uuid(s: &str) -> bool {
    // 8-4-4-4-12 hex with dashes. We match the desktop client's regex
    // verbatim so the bridge accepts the same inputs.
    let bytes = s.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (i, b) in bytes.iter().enumerate() {
        let valid = if matches!(i, 8 | 13 | 18 | 23) {
            *b == b'-'
        } else {
            b.is_ascii_hexdigit()
        };
        if !valid {
            return false;
        }
    }
    true
}

fn urlencode(value: &str) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(value.len());
    for ch in value.chars() {
        match ch {
            'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => out.push(ch),
            _ => {
                let mut buf = [0u8; 4];
                let encoded = ch.encode_utf8(&mut buf);
                for byte in encoded.bytes() {
                    // write! into the String is the clippy-blessed form of
                    // "push a small formatted slice"; avoids the
                    // format_push_string lint.
                    let _ = write!(out, "%{byte:02X}");
                }
            }
        }
    }
    out
}

fn build_url(base: &str, path: &str, query: &[(&str, String)]) -> String {
    let mut url = format!("{base}{path}");
    if !query.is_empty() {
        url.push('?');
        for (i, (k, v)) in query.iter().enumerate() {
            if i > 0 {
                url.push('&');
            }
            url.push_str(k);
            url.push('=');
            url.push_str(&urlencode(v));
        }
    }
    url
}

// ---------- Error mapping + send helpers ----------

async fn send_proxy_error(out_tx: &mpsc::Sender<String>, id: Option<String>, err: ProxyError) {
    let (kind, message, status) = match err {
        ProxyError::NoCredential => (
            "no_credential",
            "PlanFlow API token is not configured on the desktop client".to_string(),
            None,
        ),
        ProxyError::Credential(msg) => ("credential", format!("credential store: {msg}"), None),
        ProxyError::Http(http_err) => map_http_error(http_err),
        ProxyError::Upstream { status, body } => {
            let kind = match status {
                401 | 403 => "unauthorized",
                404 => "not_found",
                429 => "rate_limited",
                400..=499 => "client",
                500..=599 => "server",
                _ => "unknown",
            };
            let message = if body.is_empty() {
                format!("upstream returned HTTP {status}")
            } else {
                body
            };
            (kind, message, Some(status))
        }
        ProxyError::Decode(msg) => ("decode", msg, None),
    };
    send_error(out_tx, id, kind, message, status).await;
}

fn map_http_error(err: HttpError) -> (&'static str, String, Option<u16>) {
    match err {
        HttpError::Network(msg) => ("network", msg, None),
        HttpError::Timeout(d) => ("timeout", format!("request timed out after {d:?}"), None),
        HttpError::RateLimit { .. } => (
            "rate_limited",
            "rate limited (HTTP 429)".to_string(),
            Some(429),
        ),
        HttpError::Server { status, retries } => (
            "server",
            format!("server error {status} after {retries} retries"),
            Some(status),
        ),
        HttpError::Cache(e) => ("cache", e.to_string(), None),
        HttpError::Decode(msg) => ("decode", msg, None),
        HttpError::InvalidUrl(msg) => ("invalid_url", msg, None),
    }
}

async fn send_error(
    out_tx: &mpsc::Sender<String>,
    id: Option<String>,
    kind: impl Into<String>,
    message: impl Into<String>,
    status: Option<u16>,
) {
    let msg = ServerMessage::planflow_error(id, kind, message, status);
    send(out_tx, &msg).await;
}

async fn send(out_tx: &mpsc::Sender<String>, msg: &ServerMessage) {
    if let Ok(payload) = serde_json::to_string(msg) {
        let _ = out_tx.send(payload).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::Executor;
    use std::sync::Arc;
    use std::time::Duration;
    use wiremock::matchers::{body_json, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    async fn build_state(token: Option<&str>, mock_uri: String) -> PlanflowState {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        pool.execute(include_str!("../../migrations/0005_http_cache.sql"))
            .await
            .expect("apply 0005");
        let client = http::Client::new(
            pool,
            http::ClientConfig {
                timeout: Duration::from_secs(5),
                retry: http::retry::RetryPolicy {
                    max_attempts: 1,
                    base_delay: Duration::from_millis(1),
                    max_delay: Duration::from_millis(5),
                },
                user_agent: "work-station-test".into(),
            },
        )
        .expect("build client");
        let stored = token.map(str::to_string);
        let loader: TokenLoader = Arc::new(move || Ok(stored.clone()));
        PlanflowState::with_loader(client, mock_uri, loader)
    }

    fn channel() -> (mpsc::Sender<String>, mpsc::Receiver<String>) {
        mpsc::channel::<String>(8)
    }

    async fn drain_one(rx: &mut mpsc::Receiver<String>) -> serde_json::Value {
        let frame = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("frame timeout")
            .expect("channel closed");
        serde_json::from_str(&frame).expect("parse frame")
    }

    #[tokio::test]
    async fn list_tasks_unwraps_envelope_and_passes_bearer() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/projects/abc/tasks"))
            .and(header("authorization", "Bearer test-token"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "data": { "tasks": [{ "id": "u-1", "taskId": "T1.1", "name": "hi", "status": "TODO" }] }
            })))
            .mount(&server)
            .await;

        let state = build_state(Some("test-token"), server.uri()).await;
        let (tx, mut rx) = channel();
        handle_list_tasks(&state, &tx, Some("r-1".into()), "abc".into(), None).await;
        let frame = drain_one(&mut rx).await;
        assert_eq!(frame["type"], "planflow_result");
        assert_eq!(frame["id"], "r-1");
        assert_eq!(frame["data"]["tasks"][0]["taskId"], "T1.1");
    }

    #[tokio::test]
    async fn list_tasks_status_filter_is_forwarded_as_query_param() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/projects/abc/tasks"))
            .and(query_param("status", "TODO"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"success": true, "data": {"tasks": []}})),
            )
            .mount(&server)
            .await;

        let state = build_state(Some("test-token"), server.uri()).await;
        let (tx, mut rx) = channel();
        handle_list_tasks(
            &state,
            &tx,
            Some("r-2".into()),
            "abc".into(),
            Some("TODO".into()),
        )
        .await;
        let frame = drain_one(&mut rx).await;
        assert_eq!(frame["type"], "planflow_result");
    }

    #[tokio::test]
    async fn missing_credential_returns_no_credential_error() {
        let server = MockServer::start().await;
        let state = build_state(None, server.uri()).await;
        let (tx, mut rx) = channel();
        handle_get_me(&state, &tx, Some("r-3".into())).await;
        let frame = drain_one(&mut rx).await;
        assert_eq!(frame["type"], "planflow_error");
        assert_eq!(frame["kind"], "no_credential");
        assert_eq!(frame["id"], "r-3");
    }

    #[tokio::test]
    async fn upstream_401_maps_to_unauthorized() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/auth/me"))
            .respond_with(ResponseTemplate::new(401).set_body_string("nope"))
            .mount(&server)
            .await;

        let state = build_state(Some("bad-token"), server.uri()).await;
        let (tx, mut rx) = channel();
        handle_get_me(&state, &tx, Some("r-4".into())).await;
        let frame = drain_one(&mut rx).await;
        assert_eq!(frame["type"], "planflow_error");
        assert_eq!(frame["kind"], "unauthorized");
        assert_eq!(frame["status"], 401);
    }

    #[tokio::test]
    async fn upstream_404_maps_to_not_found() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/projects/missing/tasks"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;
        let state = build_state(Some("tok"), server.uri()).await;
        let (tx, mut rx) = channel();
        handle_list_tasks(&state, &tx, None, "missing".into(), None).await;
        let frame = drain_one(&mut rx).await;
        assert_eq!(frame["type"], "planflow_error");
        assert_eq!(frame["kind"], "not_found");
    }

    #[tokio::test]
    async fn create_comment_posts_content_field() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/projects/p/tasks/T1.1/comments"))
            .and(body_json(serde_json::json!({"content": "hello"})))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "data": { "comment": { "id": "c1", "body": "hello" }}
            })))
            .mount(&server)
            .await;
        let state = build_state(Some("tok"), server.uri()).await;
        let (tx, mut rx) = channel();
        handle_create_comment(
            &state,
            &tx,
            Some("r-5".into()),
            "p".into(),
            "T1.1".into(),
            "hello".into(),
        )
        .await;
        let frame = drain_one(&mut rx).await;
        assert_eq!(frame["type"], "planflow_result");
        assert_eq!(frame["data"]["comment"]["body"], "hello");
    }

    #[tokio::test]
    async fn update_status_resolves_human_task_id_to_uuid() {
        let server = MockServer::start().await;
        // First call: list tasks so the bridge can resolve T1.1 → uuid.
        Mock::given(method("GET"))
            .and(path("/projects/p/tasks"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "data": {"tasks": [{"id": "uuid-abc", "taskId": "T1.1", "name": "hi", "status": "TODO"}]}
            })))
            .mount(&server)
            .await;
        // Then: bulk-status with the resolved uuid.
        Mock::given(method("POST"))
            .and(path("/projects/p/tasks/bulk-status"))
            .and(body_json(
                serde_json::json!({"taskIds": ["uuid-abc"], "status": "IN_PROGRESS"}),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
                "success": true,
                "data": {"tasks": [{"id": "uuid-abc", "taskId": "T1.1", "status": "IN_PROGRESS", "name": "hi"}]}
            })))
            .mount(&server)
            .await;
        let state = build_state(Some("tok"), server.uri()).await;
        let (tx, mut rx) = channel();
        handle_update_task_status(
            &state,
            &tx,
            Some("r-6".into()),
            "p".into(),
            "T1.1".into(),
            "IN_PROGRESS".into(),
        )
        .await;
        let frame = drain_one(&mut rx).await;
        assert_eq!(frame["type"], "planflow_result");
        assert_eq!(frame["data"]["tasks"][0]["status"], "IN_PROGRESS");
    }

    #[test]
    fn looks_like_uuid_accepts_canonical_form_only() {
        assert!(looks_like_uuid("00000000-0000-0000-0000-000000000000"));
        assert!(!looks_like_uuid("ff-ff"));
        assert!(!looks_like_uuid("notauuid"));
        assert!(!looks_like_uuid("T1.1"));
    }

    #[test]
    fn urlencode_percent_encodes_reserved_characters() {
        assert_eq!(urlencode("hello"), "hello");
        assert_eq!(urlencode("a b"), "a%20b");
        assert_eq!(urlencode("T/1"), "T%2F1");
    }

    #[test]
    fn unwrap_envelope_strips_data_when_present() {
        let v = serde_json::json!({"success": true, "data": {"tasks": []}});
        let unwrapped = unwrap_envelope(v);
        assert_eq!(unwrapped, serde_json::json!({"tasks": []}));
    }

    #[test]
    fn unwrap_envelope_passes_through_when_absent() {
        let v = serde_json::json!({"tasks": []});
        assert_eq!(unwrap_envelope(v.clone()), v);
    }
}
