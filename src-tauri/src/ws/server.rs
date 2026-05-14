// T18.6 prose names PlanFlow / http_cache; backticking each mention hurts
// readability. Allow doc_markdown for the module.
#![allow(clippy::doc_markdown)]

//! axum HTTP + WebSocket server boot (T18.1 + T18.2).
//!
//! Runs on a Tauri-managed tokio task next to the GUI. The listener is
//! bound to `127.0.0.1` by default so the server isn't reachable from
//! the LAN without an explicit tunnel (T18.x Cloudflare Tunnel work);
//! `WS_HOST` env override is allowed for tests / dogfooding.
//!
//! Routes:
//!   * `GET /healthz` — unauthenticated liveness probe.
//!   * `GET /ws`      — bearer-authenticated WebSocket upgrade, handed
//!     off to [`pty_bridge::run_connection`].
//!
//! Auth is checked on the upgrade request itself (header or `?token=`),
//! NOT inside the WebSocket message stream. Failed auth returns plain
//! HTTP 401 so a misconfigured PWA gets a usable HTTP error instead of
//! a WebSocket close code the browser console doesn't surface.

use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Arc;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use sqlx::sqlite::SqlitePool;
use tokio::net::TcpListener;

use crate::pty::PtyManager;
use crate::push::{self, PushService};

use super::auth::{check_auth, AuthResult, AuthToken};
use super::planflow_bridge::PlanflowState;
use super::projects_bridge::AppEvents;
use super::pty_bridge;
use super::system_monitor::{self, SystemMonitorHandle};

/// Default port — matches `PROJECT_PLAN` T18.1 ("default 7420").
pub const DEFAULT_PORT: u16 = 7420;

/// Environment override for the bind port (`WS_PORT`).
pub const PORT_ENV: &str = "WS_PORT";

/// Environment override for the bind host (`WS_HOST`).
///
/// Defaults to `127.0.0.1`. Set to `0.0.0.0` only with an explicit
/// tunnel in front — never expose the bearer token endpoint on the
/// LAN.
pub const HOST_ENV: &str = "WS_HOST";

/// Shared state for axum handlers.
#[derive(Clone)]
struct AppState {
    token: AuthToken,
    manager: PtyManager,
    /// SQLite pool — cloned per WS upgrade so the projects/settings
    /// bridge handlers (T18.4) can read/write `app_settings` and the
    /// `projects` table without re-resolving the pool.
    pool: SqlitePool,
    /// Cross-runtime "active project changed" hop (T18.4). Boxed so
    /// tests can swap the Tauri-backed impl for a recorder without
    /// touching this layer.
    events: Arc<dyn AppEvents>,
    /// T18.5 — handle to the singleton system-stats broadcaster. Each
    /// `/ws` upgrade clones a subscriber off this so every connection
    /// receives the same poll tick.
    monitor: SystemMonitorHandle,
    /// T18.6 — `PlanFlow` Tasks bridge state. `None` when the HTTP
    /// client couldn't initialise at boot; handlers reply with
    /// `planflow_error{kind:"unavailable"}` so the mobile side gets a
    /// typed frame instead of a silent drop.
    planflow: Option<PlanflowState>,
}

/// Build the axum [`Router`] with all routes wired up.
///
/// Exposed (crate-internal) for tests that want to drive the server
/// against a real `TcpListener` without going through [`spawn`].
pub(crate) fn router(
    token: AuthToken,
    manager: PtyManager,
    push_service: Option<PushService>,
    pool: SqlitePool,
    events: Arc<dyn AppEvents>,
    planflow: Option<PlanflowState>,
) -> Router {
    let monitor = system_monitor::start(manager.clone());
    router_with_monitor(
        token,
        manager,
        push_service,
        pool,
        events,
        monitor,
        planflow,
    )
}

/// Same as [`router`] but lets the caller inject a pre-built monitor.
/// Test code uses this to swap in a fast-tick monitor without spawning
/// the production 2-second sampler.
pub(crate) fn router_with_monitor(
    token: AuthToken,
    manager: PtyManager,
    push_service: Option<PushService>,
    pool: SqlitePool,
    events: Arc<dyn AppEvents>,
    monitor: SystemMonitorHandle,
    planflow: Option<PlanflowState>,
) -> Router {
    let state = Arc::new(AppState {
        token,
        manager,
        pool,
        events,
        monitor,
        planflow,
    });
    // Auth lives in a route-scoped middleware so it runs *before*
    // axum's `WebSocketUpgrade` extractor — the latter rejects any
    // non-upgrade GET with 400, which would otherwise mask our 401.
    let ws_routes =
        Router::new()
            .route("/ws", get(ws_handler))
            .route_layer(middleware::from_fn_with_state(
                state.clone(),
                require_bearer,
            ));

    let mut router = Router::new()
        .route("/healthz", get(healthz))
        .merge(ws_routes);

    // T18.19: mount the Web Push HTTP surface under the same bearer-
    // token middleware. Push routes need their own typed state
    // (PushService), so we attach them as a nested router with
    // `route_layer(require_bearer)` instead of merging into the WS state.
    if let Some(service) = push_service {
        let push_routes = push::http::routes(service).route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_bearer,
        ));
        router = router.merge(push_routes);
    }

    router
        .with_state(state)
        // PWA dev server runs on a different origin (e.g. http://localhost:3000)
        // than the bridge (e.g. http://127.0.0.1:7420). Browsers block the
        // auth probe's cross-origin fetch unless we advertise CORS. Permissive
        // policy is fine here because the bridge is loopback-bound by default
        // and gates every authenticated route behind a bearer token.
        .layer(middleware::from_fn(cors_middleware))
}

/// Permissive CORS middleware: short-circuits `OPTIONS` preflights with a 204
/// + the standard `Access-Control-*` headers, and stamps the same allow
/// headers on every other response so the PWA's `fetch(/healthz)` and
/// `fetch(/ws, { Authorization })` calls aren't blocked by the browser.
async fn cors_middleware(req: Request, next: Next) -> Response {
    if req.method() == Method::OPTIONS {
        let mut response = StatusCode::NO_CONTENT.into_response();
        apply_cors_headers(response.headers_mut());
        return response;
    }
    let mut response = next.run(req).await;
    apply_cors_headers(response.headers_mut());
    response
}

fn apply_cors_headers(headers: &mut HeaderMap) {
    headers.insert("access-control-allow-origin", HeaderValue::from_static("*"));
    headers.insert(
        "access-control-allow-methods",
        HeaderValue::from_static("GET, POST, DELETE, OPTIONS"),
    );
    headers.insert(
        "access-control-allow-headers",
        HeaderValue::from_static("Authorization, Content-Type"),
    );
    headers.insert("access-control-max-age", HeaderValue::from_static("600"));
}

/// Bearer-token middleware. Runs before extractors so a missing /
/// invalid token surfaces as a clean 401 with `WWW-Authenticate:
/// Bearer` instead of axum's generic 400 from the `WebSocketUpgrade`
/// extractor.
async fn require_bearer(State(state): State<Arc<AppState>>, req: Request, next: Next) -> Response {
    let header_value = req
        .headers()
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .map(str::to_owned);
    // Cheap manual query-string parse — we only care about `token=…`
    // and don't want to pull a routing extractor in here.
    let query_token = req.uri().query().and_then(|q| {
        q.split('&').find_map(|pair| {
            let mut it = pair.splitn(2, '=');
            match (it.next(), it.next()) {
                (Some("token"), Some(val)) => Some(val.to_owned()),
                _ => None,
            }
        })
    });

    match check_auth(
        &state.token,
        header_value.as_deref(),
        query_token.as_deref(),
    ) {
        AuthResult::Ok => next.run(req).await,
        AuthResult::Missing => unauthorized("missing bearer token"),
        AuthResult::Mismatch => unauthorized("invalid bearer token"),
    }
}

/// Spawn the server in the background and return its bound address.
///
/// Binding happens synchronously (await on `TcpListener::bind`) so a
/// port collision surfaces immediately at boot instead of being lost
/// inside a fire-and-forget task. After `bind` succeeds the `serve`
/// future runs on a background tokio task; cancelling that task (or
/// dropping its handle) gracefully shuts the server down with the
/// rest of the app.
pub async fn spawn(
    token: AuthToken,
    manager: PtyManager,
    push_service: Option<PushService>,
    pool: SqlitePool,
    events: Arc<dyn AppEvents>,
    planflow: Option<PlanflowState>,
) -> std::io::Result<SocketAddr> {
    let host = std::env::var(HOST_ENV)
        .ok()
        .and_then(|s| s.parse::<IpAddr>().ok())
        .unwrap_or(IpAddr::V4(Ipv4Addr::LOCALHOST));
    let port = std::env::var(PORT_ENV)
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .unwrap_or(DEFAULT_PORT);

    let app = router(token, manager, push_service, pool, events, planflow);
    let addr = SocketAddr::new(host, port);
    let listener = TcpListener::bind(addr).await?;
    let bound = listener.local_addr()?;

    tokio::spawn(async move {
        if let Err(error) = axum::serve(listener, app).await {
            tracing::error!(target: "ws", %error, "axum server exited with error");
        }
    });
    Ok(bound)
}

/// `GET /healthz` — unauthenticated liveness probe.
///
/// Used by the PWA's "is the desktop reachable?" check and by the
/// dogfooding curl-from-shell flow.
async fn healthz() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

#[derive(Debug, Deserialize)]
struct WsQuery {
    #[allow(dead_code)] // consumed by `require_bearer`; left here so axum
    // still rejects unknown query layouts via Query.
    token: Option<String>,
}

/// `GET /ws` — WebSocket upgrade. Auth has already passed before this
/// handler runs (see `require_bearer` middleware).
async fn ws_handler(
    State(state): State<Arc<AppState>>,
    Query(_query): Query<WsQuery>,
    upgrade: WebSocketUpgrade,
) -> Response {
    let manager = state.manager.clone();
    let pool = state.pool.clone();
    let events = state.events.clone();
    let monitor = state.monitor.clone();
    let planflow = state.planflow.clone();
    upgrade.on_upgrade(move |socket| {
        pty_bridge::run_connection(socket, manager, pool, events, monitor, planflow)
    })
}

fn unauthorized(message: &'static str) -> Response {
    let mut response = (StatusCode::UNAUTHORIZED, message).into_response();
    response
        .headers_mut()
        .insert("WWW-Authenticate", "Bearer".parse().unwrap());
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    /// Test stub for [`AppEvents`] — the server-level integration
    /// tests don't drive `project_switch`, so a no-op is enough.
    struct NoopEvents;
    impl AppEvents for NoopEvents {
        fn emit_active_project_changed(&self, _: Option<&str>) {}
    }

    async fn test_pool() -> SqlitePool {
        sqlx::sqlite::SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite")
    }

    /// Helper: spawn the server bound to an ephemeral port and return
    /// the bound socket address. Skipped on hosts without IPv4
    /// loopback (none we ship to, but cargo test on weird sandboxes).
    async fn spawn_test_server(token: AuthToken) -> SocketAddr {
        let manager = PtyManager::new();
        let pool = test_pool().await;
        let events: Arc<dyn AppEvents> = Arc::new(NoopEvents);
        let app = router(token, manager, None, pool, events, None);
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local_addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        // Give axum a beat to start accepting.
        tokio::time::sleep(Duration::from_millis(20)).await;
        addr
    }

    #[tokio::test]
    async fn healthz_is_unauthenticated() {
        let addr = spawn_test_server(AuthToken::new("secret")).await;
        let body = reqwest::get(format!("http://{addr}/healthz"))
            .await
            .expect("get")
            .text()
            .await
            .expect("body");
        assert_eq!(body, "ok");
    }

    #[tokio::test]
    async fn ws_upgrade_rejects_missing_token() {
        let addr = spawn_test_server(AuthToken::new("secret")).await;
        // Plain HTTP GET against /ws without auth — should be 401.
        let status = reqwest::Client::new()
            .get(format!("http://{addr}/ws"))
            .send()
            .await
            .expect("send")
            .status();
        assert_eq!(status, reqwest::StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn ws_upgrade_rejects_wrong_token() {
        let addr = spawn_test_server(AuthToken::new("secret")).await;
        let status = reqwest::Client::new()
            .get(format!("http://{addr}/ws"))
            .header("Authorization", "Bearer wrong")
            .send()
            .await
            .expect("send")
            .status();
        assert_eq!(status, reqwest::StatusCode::UNAUTHORIZED);
    }

    /// Drive a real WebSocket upgrade end-to-end with a valid token,
    /// then send a single `pty_spawn` and assert we get a
    /// `pty_spawned` reply. Exercises router → middleware → bridge
    /// → `PtyManager`. Unix-only since spawn calls into portable-pty.
    #[cfg(unix)]
    #[tokio::test]
    async fn valid_token_upgrades_and_routes_to_bridge() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;

        let addr = spawn_test_server(AuthToken::new("secret")).await;

        let url = format!("ws://{addr}/ws");
        let mut req = url.into_client_request().expect("client req");
        req.headers_mut()
            .insert("Authorization", "Bearer secret".parse().unwrap());
        let (mut socket, response) = tokio_tungstenite::connect_async(req)
            .await
            .expect("connect");
        assert_eq!(response.status().as_u16(), 101);

        let spawn_payload = serde_json::json!({
            "type": "pty_spawn",
            "id": "spawn-1",
            "command": "/bin/sh",
            "args": ["-c", "echo HELLO; sleep 30"],
            "cols": 80,
            "rows": 24,
        });
        socket
            .send(tokio_tungstenite::tungstenite::Message::Text(
                spawn_payload.to_string(),
            ))
            .await
            .expect("send spawn");

        // First frame should be pty_spawned, then output frames will
        // follow. Bound the wait so a portable-pty failure surfaces.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        let mut saw_spawned = false;
        let mut saw_output = false;
        while tokio::time::Instant::now() < deadline && !(saw_spawned && saw_output) {
            let next = tokio::time::timeout(Duration::from_millis(500), socket.next()).await;
            if let Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(payload)))) = next {
                if payload.contains(r#""type":"pty_spawned""#) {
                    saw_spawned = true;
                } else if payload.contains(r#""type":"pty_output""#) {
                    saw_output = true;
                }
            }
        }
        assert!(saw_spawned, "never received pty_spawned frame");
        assert!(saw_output, "never received pty_output frame");

        // Best-effort close.
        let _ = socket.close(None).await;
    }

    /// T18.5 acceptance: a connected client receives `system_stats`
    /// frames automatically. Uses `router_with_monitor` to inject a
    /// fast-tick monitor so the test doesn't have to wait the 2-second
    /// production cadence.
    #[tokio::test]
    async fn ws_connection_receives_system_stats() {
        use futures_util::StreamExt;
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;

        let manager = PtyManager::new();
        let pool = test_pool().await;
        let events: Arc<dyn AppEvents> = Arc::new(NoopEvents);
        let monitor =
            system_monitor::start_with_interval(manager.clone(), Duration::from_millis(50));
        let app = router_with_monitor(
            AuthToken::new("secret"),
            manager,
            None,
            pool,
            events,
            monitor,
            None,
        );
        let listener = TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local_addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        tokio::time::sleep(Duration::from_millis(20)).await;

        let url = format!("ws://{addr}/ws");
        let mut req = url.into_client_request().expect("client req");
        req.headers_mut()
            .insert("Authorization", "Bearer secret".parse().unwrap());
        let (mut socket, response) = tokio_tungstenite::connect_async(req)
            .await
            .expect("connect");
        assert_eq!(response.status().as_u16(), 101);

        // The monitor primes for MINIMUM_CPU_UPDATE_INTERVAL (~200ms)
        // before the first publish. Give it 3 seconds total so a noisy
        // CI host doesn't flake.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        let mut saw_stats = false;
        let mut payload_for_assert = String::new();
        while tokio::time::Instant::now() < deadline && !saw_stats {
            let next = tokio::time::timeout(Duration::from_millis(500), socket.next()).await;
            if let Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(payload)))) = next {
                if payload.contains(r#""type":"system_stats""#) {
                    saw_stats = true;
                    payload_for_assert = payload;
                }
            }
        }
        assert!(saw_stats, "never received system_stats frame");
        assert!(
            payload_for_assert.contains("cpu_percent")
                && payload_for_assert.contains("ram_used_bytes")
                && payload_for_assert.contains("ram_total_bytes")
                && payload_for_assert.contains("pty_session_count"),
            "system_stats frame missing fields: {payload_for_assert}",
        );

        let _ = socket.close(None).await;
    }
}
