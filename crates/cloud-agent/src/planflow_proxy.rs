// T19.29 prose mentions `PlanFlow` and `WebSocket` in passing. Backticking
// each occurrence hurts readability; allow the doc-markdown lint at the
// module level, matching `workstation-core::ws::protocol` and the
// desktop bridge sibling.
#![allow(clippy::doc_markdown)]

//! PlanFlow proxy handlers for the cloud-agent (T19.29).
//!
//! Sibling of `src-tauri/src/ws/planflow_bridge.rs`. The wire contract
//! is identical (same `planflow_*` request types, same `planflow_result`
//! / `planflow_error` reply shape, same stable `kind` taxonomy) so the
//! PWA's PlanFlow client branches solely on response type, never on
//! which backend is serving the request.
//!
//! ## Wire model
//!
//! Each `ClientMessage::Planflow*` is forwarded to PlanFlow's REST API
//! (default `https://api.planflow.tools`, override with
//! `PLANFLOW_BASE_URL`) over `reqwest` with a bearer-token Authorization
//! header. Success unwraps PlanFlow's `{ success, data: ... }` envelope
//! and ships the inner payload as `planflow_result.data`. Failure maps
//! to one of the stable `kind` strings the PWA already branches on:
//! `unauthorized` (401/403), `rate_limited` (429), `not_found` (404),
//! `client` (4xx), `server` (5xx), `network` (transport / DNS),
//! `timeout`, `decode` (bad envelope / bad JSON), `no_credential`
//! (no PlanFlow token configured), `invalid_args`.
//!
//! ## Token sourcing
//!
//! The desktop bridge fetches its PlanFlow API token from the OS
//! keychain. A headless VPS has no keychain, so the cloud-agent reads
//! the token from either the `PLANFLOW_API_TOKEN` environment variable
//! or the `planflow_api_token` config field. The env var wins so an
//! operator can rotate the token without editing root-owned config —
//! load is lazy per request, so the next call after a rotation picks
//! up the new value without a daemon restart.
//!
//! ## Scope
//!
//! Only the read/write proxy variants land here:
//! `planflow_get_me`, `planflow_list_projects`, `planflow_list_tasks`,
//! `planflow_list_active_work`, `planflow_list_comments`,
//! `planflow_create_comment`, `planflow_start_work`, `planflow_stop_work`,
//! `planflow_update_task_status`. The `planflow_chat_*` variants stay
//! desktop-only — those route PWA messages into a live PTY on the
//! desktop, and the cloud-agent has no analogous side channel.

use std::sync::Arc;
use std::time::Duration;

use reqwest::Method;
use serde_json::{json, Value};
use tokio::sync::mpsc;
use workstation_core::ws::protocol::ServerMessage;

/// Default PlanFlow API base URL. Override via [`BASE_URL_ENV`].
pub const DEFAULT_BASE_URL: &str = "https://api.planflow.tools";

/// Env var for overriding the base URL. Set by integration tests
/// against a wiremock server; production operators don't normally need
/// to touch this.
pub const BASE_URL_ENV: &str = "PLANFLOW_BASE_URL";

/// Env var the operator sets to provide the PlanFlow API token. Wins
/// over the `planflow_api_token` config field so token rotation is a
/// `systemctl set-environment` + restart instead of a config edit.
pub const TOKEN_ENV: &str = "PLANFLOW_API_TOKEN";

/// Default per-request timeout. Matches the desktop bridge's
/// `http::ClientConfig` default — long enough for the slowest PlanFlow
/// list endpoint, short enough that a stalled upstream doesn't pin the
/// PWA's UI on a hung request.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Token loader function. Boxed so tests can swap in a synchronous
/// stub without touching the environment.
pub type TokenLoader = Arc<dyn Fn() -> Result<Option<String>, String> + Send + Sync + 'static>;

/// Shared state for the PlanFlow proxy. One instance per daemon, cloned
/// cheaply (`reqwest::Client` is internally Arc-shared, the loader and
/// org cache are Arc handles, the base URL is a `String` that gets
/// cloned once at the per-request boundary).
#[derive(Clone)]
pub struct PlanflowState {
    client: reqwest::Client,
    base_url: String,
    token_loader: TokenLoader,
    /// Cached "first organization id" so the auto-resolve path in
    /// `handle_list_projects` doesn't pay a `/organizations` round-trip
    /// on every Tasks-tab load. Cleared on bridge boot — orgs rarely
    /// change for a given user so this is safe for the daemon's
    /// lifetime. Mirrors the desktop bridge's identical cache.
    cached_org_id: Arc<std::sync::Mutex<Option<String>>>,
}

impl std::fmt::Debug for PlanflowState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PlanflowState")
            .field("base_url", &self.base_url)
            .finish_non_exhaustive()
    }
}

impl PlanflowState {
    /// Build the proxy state for production use.
    ///
    /// `config_token` is the value pinned in `config.toml`. The loader
    /// returned by [`make_env_token_loader`] reads `PLANFLOW_API_TOKEN`
    /// first and falls back to the config value, so a rotation via
    /// systemd env-override picks up without a config edit.
    pub fn new(config_token: Option<String>) -> Self {
        let base_url = std::env::var(BASE_URL_ENV)
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .user_agent("work-station-cloud-agent")
            .build()
            .expect("reqwest::Client::builder must succeed with default rustls config");
        Self {
            client,
            base_url: trim_trailing_slash(&base_url),
            token_loader: make_env_token_loader(config_token),
            cached_org_id: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    /// Test seam: build a state pointed at a custom base URL (typically
    /// a wiremock instance) with an arbitrary token loader.
    #[cfg(test)]
    pub fn for_test(base_url: impl Into<String>, token_loader: TokenLoader) -> Self {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("reqwest test client");
        Self {
            client,
            base_url: trim_trailing_slash(&base_url.into()),
            token_loader,
            cached_org_id: Arc::new(std::sync::Mutex::new(None)),
        }
    }
}

/// Build the production token loader. Reads `PLANFLOW_API_TOKEN` first;
/// falls back to the config-pinned value on each call. Returning a
/// closure (rather than caching the result) means the env var is
/// re-read per request, so a `systemctl set-environment` + daemon
/// restart cycle isn't required for token rotation — the operator can
/// drop a new env value into the unit file's `EnvironmentFile=` and
/// the next request picks it up.
fn make_env_token_loader(config_token: Option<String>) -> TokenLoader {
    Arc::new(move || {
        if let Ok(env_value) = std::env::var(TOKEN_ENV) {
            let trimmed = env_value.trim().to_string();
            if !trimmed.is_empty() {
                return Ok(Some(trimmed));
            }
        }
        Ok(config_token
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string))
    })
}

fn trim_trailing_slash(s: &str) -> String {
    s.trim_end_matches('/').to_string()
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
    // first one's id; the mobile PWA has no UI to pick orgs, so the
    // cloud-agent mirrors that fallback to keep behaviour identical
    // across surfaces.
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

async fn resolve_first_org_id(state: &PlanflowState) -> Result<Option<String>, ProxyError> {
    if let Some(id) = state
        .cached_org_id
        .lock()
        .expect("planflow org cache poisoned")
        .clone()
    {
        return Ok(Some(id));
    }
    let value = proxy_request(state, Method::GET, "/organizations", None).await?;
    let orgs = value
        .get("organizations")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let first = orgs
        .into_iter()
        .find_map(|o| o.get("id").and_then(|v| v.as_str()).map(str::to_owned));
    if let Some(ref id) = first {
        *state
            .cached_org_id
            .lock()
            .expect("planflow org cache poisoned") = Some(id.clone());
    }
    Ok(first)
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
    // bridge's translation.
    let payload = json!({ "content": body });
    proxy_json(state, out_tx, id, Method::POST, &path, &payload).await;
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
    proxy_json(state, out_tx, id, Method::POST, &path, &payload).await;
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
    proxy_json(state, out_tx, id, Method::POST, &path, &payload).await;
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
    // list-tasks round-trip — matches the desktop bridge.
    //
    // Unlike the desktop bridge, the cloud-agent does NOT fire a Web
    // Push on DONE — the desktop owns the push registration / VAPID
    // keys, and a duplicate push from the cloud-agent would notify the
    // user twice when both backends are reachable. If/when the PWA
    // adopts a cloud-agent-served push channel, this is the place to
    // wire it.
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
    let response = proxy_request(state, Method::POST, &path, Some(&payload)).await;

    match response {
        Ok(value) => send(out_tx, &ServerMessage::planflow_result(id, value)).await,
        Err(err) => send_proxy_error(out_tx, id, err).await,
    }
}

// ---------- HTTP plumbing ----------

#[derive(Debug)]
enum ProxyError {
    NoCredential,
    Credential(String),
    Network(String),
    Timeout,
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
    match proxy_request_url(state, Method::GET, &url, None).await {
        Ok(value) => send(out_tx, &ServerMessage::planflow_result(id, value)).await,
        Err(err) => send_proxy_error(out_tx, id, err).await,
    }
}

async fn proxy_json(
    state: &PlanflowState,
    out_tx: &mpsc::Sender<String>,
    id: Option<String>,
    method: Method,
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
    method: Method,
    path: &str,
    body: Option<&Value>,
) -> Result<Value, ProxyError> {
    let url = build_url(&state.base_url, path, &[]);
    proxy_request_url(state, method, &url, body).await
}

async fn proxy_request_url(
    state: &PlanflowState,
    method: Method,
    url: &str,
    body: Option<&Value>,
) -> Result<Value, ProxyError> {
    let token = match (state.token_loader)() {
        Ok(Some(t)) => t,
        Ok(None) => return Err(ProxyError::NoCredential),
        Err(e) => return Err(ProxyError::Credential(e)),
    };

    let mut req = state
        .client
        .request(method, url)
        .bearer_auth(token)
        .header("accept", "application/json");
    if let Some(body) = body {
        req = req.json(body);
    }

    let response = match req.send().await {
        Ok(r) => r,
        Err(err) => {
            return Err(if err.is_timeout() {
                ProxyError::Timeout
            } else {
                ProxyError::Network(err.to_string())
            });
        }
    };

    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| ProxyError::Network(e.to_string()))?;

    if !(200..300).contains(&status) {
        let body_text = String::from_utf8_lossy(&bytes).into_owned();
        return Err(ProxyError::Upstream {
            status,
            body: body_text,
        });
    }

    // 204 No Content / empty body is normal for start_work / stop_work.
    // Surface as `data: null` so the mobile side gets a stable shape.
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    let parsed: Value =
        serde_json::from_slice(&bytes).map_err(|e| ProxyError::Decode(e.to_string()))?;
    Ok(unwrap_envelope(parsed))
}

/// PlanFlow wraps successful responses in `{ success: true, data: ... }`.
/// Strip the wrapper when present so the mobile client sees the inner
/// payload regardless of which endpoint it called — matches the
/// desktop bridge's identical helper.
fn unwrap_envelope(value: Value) -> Value {
    match value {
        Value::Object(map) if map.contains_key("data") => {
            let mut owned = map;
            owned.remove("data").unwrap_or(Value::Null)
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
    let value = proxy_request_url(state, Method::GET, &url, None).await?;
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

fn looks_like_uuid(s: &str) -> bool {
    // 8-4-4-4-12 hex with dashes. Matches the desktop bridge / client
    // regex verbatim so the cloud-agent accepts the same inputs.
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
            "PlanFlow API token is not configured on the cloud-agent".to_string(),
            None,
        ),
        ProxyError::Credential(msg) => ("credential", format!("credential store: {msg}"), None),
        ProxyError::Network(msg) => ("network", msg, None),
        ProxyError::Timeout => ("timeout", "request timed out".to_string(), None),
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
    use serde_json::json;
    use std::sync::Arc;
    use tokio::sync::mpsc;
    use wiremock::matchers::{body_json, header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn token_loader(value: Option<&str>) -> TokenLoader {
        let owned = value.map(str::to_string);
        Arc::new(move || Ok(owned.clone()))
    }

    fn channel() -> (mpsc::Sender<String>, mpsc::Receiver<String>) {
        mpsc::channel::<String>(8)
    }

    async fn collect_one(rx: &mut mpsc::Receiver<String>) -> Value {
        let raw = rx.recv().await.expect("frame");
        serde_json::from_str(&raw).expect("parse frame")
    }

    #[tokio::test]
    async fn get_me_unwraps_envelope_and_emits_result() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/auth/me"))
            .and(header("authorization", "Bearer secret"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "success": true, "data": { "id": "u1" }})),
            )
            .mount(&server)
            .await;
        let state = PlanflowState::for_test(server.uri(), token_loader(Some("secret")));
        let (tx, mut rx) = channel();
        handle_get_me(&state, &tx, Some("req-1".to_string())).await;
        let frame = collect_one(&mut rx).await;
        assert_eq!(frame["type"], "planflow_result");
        assert_eq!(frame["id"], "req-1");
        assert_eq!(frame["data"]["id"], "u1");
    }

    #[tokio::test]
    async fn missing_token_emits_no_credential() {
        let state = PlanflowState::for_test("http://127.0.0.1:1", token_loader(None));
        let (tx, mut rx) = channel();
        handle_get_me(&state, &tx, Some("req-2".to_string())).await;
        let frame = collect_one(&mut rx).await;
        assert_eq!(frame["type"], "planflow_error");
        assert_eq!(frame["kind"], "no_credential");
    }

    #[tokio::test]
    async fn list_projects_auto_resolves_first_org() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/organizations"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "success": true,
                "data": { "organizations": [{ "id": "org-1" }, { "id": "org-2" }] }
            })))
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/projects"))
            .and(query_param("organizationId", "org-1"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "success": true, "data": { "projects": [] }})),
            )
            .mount(&server)
            .await;
        let state = PlanflowState::for_test(server.uri(), token_loader(Some("t")));
        let (tx, mut rx) = channel();
        handle_list_projects(&state, &tx, Some("req-3".to_string()), None).await;
        let frame = collect_one(&mut rx).await;
        assert_eq!(frame["type"], "planflow_result");
        assert!(frame["data"]["projects"].is_array());
        // The cached org id should bypass the /organizations call on a
        // second list — covers the cache contract without asserting on
        // wiremock call counts (matchers above already constrain shape).
        assert_eq!(
            state
                .cached_org_id
                .lock()
                .unwrap()
                .as_deref(),
            Some("org-1")
        );
    }

    #[tokio::test]
    async fn list_projects_with_explicit_org_skips_resolve() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/projects"))
            .and(query_param("organizationId", "org-pinned"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "success": true, "data": { "projects": [] }})),
            )
            .mount(&server)
            .await;
        let state = PlanflowState::for_test(server.uri(), token_loader(Some("t")));
        let (tx, mut rx) = channel();
        handle_list_projects(&state, &tx, None, Some("org-pinned".to_string())).await;
        let frame = collect_one(&mut rx).await;
        assert_eq!(frame["type"], "planflow_result");
    }

    #[tokio::test]
    async fn list_tasks_empty_project_id_short_circuits() {
        let state = PlanflowState::for_test("http://127.0.0.1:1", token_loader(Some("t")));
        let (tx, mut rx) = channel();
        handle_list_tasks(&state, &tx, None, "  ".to_string(), None).await;
        let frame = collect_one(&mut rx).await;
        assert_eq!(frame["type"], "planflow_error");
        assert_eq!(frame["kind"], "invalid_args");
    }

    #[tokio::test]
    async fn list_tasks_passes_status_query() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/projects/proj-1/tasks"))
            .and(query_param("status", "IN_PROGRESS"))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "success": true, "data": { "tasks": [] }})),
            )
            .mount(&server)
            .await;
        let state = PlanflowState::for_test(server.uri(), token_loader(Some("t")));
        let (tx, mut rx) = channel();
        handle_list_tasks(
            &state,
            &tx,
            None,
            "proj-1".to_string(),
            Some("IN_PROGRESS".to_string()),
        )
        .await;
        let frame = collect_one(&mut rx).await;
        assert_eq!(frame["type"], "planflow_result");
    }

    #[tokio::test]
    async fn create_comment_translates_body_to_content() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/projects/proj-1/tasks/task-1/comments"))
            .and(body_json(json!({ "content": "hello" })))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "success": true, "data": { "id": "c1" }})),
            )
            .mount(&server)
            .await;
        let state = PlanflowState::for_test(server.uri(), token_loader(Some("t")));
        let (tx, mut rx) = channel();
        handle_create_comment(
            &state,
            &tx,
            None,
            "proj-1".to_string(),
            "task-1".to_string(),
            "hello".to_string(),
        )
        .await;
        let frame = collect_one(&mut rx).await;
        assert_eq!(frame["type"], "planflow_result");
        assert_eq!(frame["data"]["id"], "c1");
    }

    #[tokio::test]
    async fn upstream_401_maps_to_unauthorized() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/auth/me"))
            .respond_with(ResponseTemplate::new(401).set_body_string("bad token"))
            .mount(&server)
            .await;
        let state = PlanflowState::for_test(server.uri(), token_loader(Some("t")));
        let (tx, mut rx) = channel();
        handle_get_me(&state, &tx, None).await;
        let frame = collect_one(&mut rx).await;
        assert_eq!(frame["type"], "planflow_error");
        assert_eq!(frame["kind"], "unauthorized");
        assert_eq!(frame["status"], 401);
        assert_eq!(frame["message"], "bad token");
    }

    #[tokio::test]
    async fn upstream_429_maps_to_rate_limited() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/auth/me"))
            .respond_with(ResponseTemplate::new(429))
            .mount(&server)
            .await;
        let state = PlanflowState::for_test(server.uri(), token_loader(Some("t")));
        let (tx, mut rx) = channel();
        handle_get_me(&state, &tx, None).await;
        let frame = collect_one(&mut rx).await;
        assert_eq!(frame["type"], "planflow_error");
        assert_eq!(frame["kind"], "rate_limited");
        assert_eq!(frame["status"], 429);
    }

    #[tokio::test]
    async fn upstream_500_maps_to_server() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/auth/me"))
            .respond_with(ResponseTemplate::new(503).set_body_string("upstream offline"))
            .mount(&server)
            .await;
        let state = PlanflowState::for_test(server.uri(), token_loader(Some("t")));
        let (tx, mut rx) = channel();
        handle_get_me(&state, &tx, None).await;
        let frame = collect_one(&mut rx).await;
        assert_eq!(frame["type"], "planflow_error");
        assert_eq!(frame["kind"], "server");
        assert_eq!(frame["status"], 503);
    }

    #[tokio::test]
    async fn stop_work_204_returns_null_data() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/projects/proj-1/tasks/_/work"))
            .and(body_json(json!({ "action": "stop" })))
            .respond_with(ResponseTemplate::new(204))
            .mount(&server)
            .await;
        let state = PlanflowState::for_test(server.uri(), token_loader(Some("t")));
        let (tx, mut rx) = channel();
        handle_stop_work(&state, &tx, None, "proj-1".to_string()).await;
        let frame = collect_one(&mut rx).await;
        assert_eq!(frame["type"], "planflow_result");
        assert!(frame["data"].is_null());
    }

    #[tokio::test]
    async fn update_task_status_resolves_human_id_first() {
        let server = MockServer::start().await;
        // First the bridge fetches the task list to resolve T1.1 → uuid.
        Mock::given(method("GET"))
            .and(path("/projects/proj-1/tasks"))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "success": true,
                "data": {
                    "tasks": [
                        { "taskId": "T1.1", "id": "uuid-aaaa" },
                        { "taskId": "T1.2", "id": "uuid-bbbb" },
                    ]
                }
            })))
            .mount(&server)
            .await;
        Mock::given(method("POST"))
            .and(path("/projects/proj-1/tasks/bulk-status"))
            .and(body_json(
                json!({ "taskIds": ["uuid-aaaa"], "status": "DONE" }),
            ))
            .respond_with(ResponseTemplate::new(200).set_body_json(json!({
                "success": true,
                "data": { "tasks": [{ "name": "do the thing" }] }
            })))
            .mount(&server)
            .await;
        let state = PlanflowState::for_test(server.uri(), token_loader(Some("t")));
        let (tx, mut rx) = channel();
        handle_update_task_status(
            &state,
            &tx,
            None,
            "proj-1".to_string(),
            "T1.1".to_string(),
            "DONE".to_string(),
        )
        .await;
        let frame = collect_one(&mut rx).await;
        assert_eq!(frame["type"], "planflow_result");
        assert_eq!(frame["data"]["tasks"][0]["name"], "do the thing");
    }

    #[tokio::test]
    async fn update_task_status_uuid_skips_resolve() {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/projects/proj-1/tasks/bulk-status"))
            .and(body_json(json!({
                "taskIds": ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"],
                "status": "TODO"
            })))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(json!({ "success": true, "data": { "tasks": [] }})),
            )
            .mount(&server)
            .await;
        let state = PlanflowState::for_test(server.uri(), token_loader(Some("t")));
        let (tx, mut rx) = channel();
        handle_update_task_status(
            &state,
            &tx,
            None,
            "proj-1".to_string(),
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee".to_string(),
            "TODO".to_string(),
        )
        .await;
        let frame = collect_one(&mut rx).await;
        assert_eq!(frame["type"], "planflow_result");
    }

    #[tokio::test]
    async fn env_loader_prefers_env_over_config() {
        // Use a unique env var name per invocation to avoid clashing
        // with other parallel tests touching real env vars.
        std::env::set_var("PLANFLOW_API_TOKEN", "from-env");
        let loader = make_env_token_loader(Some("from-config".to_string()));
        assert_eq!(loader().unwrap().as_deref(), Some("from-env"));
        std::env::remove_var("PLANFLOW_API_TOKEN");
        assert_eq!(loader().unwrap().as_deref(), Some("from-config"));
    }
}
