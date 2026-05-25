// T19.25 prose mentions `SQLite` and `WebSocket` in passing. Backticking
// each occurrence hurts readability; allow the doc-markdown lint at the
// module level, matching `workstation-core::ws::protocol`.
#![allow(clippy::doc_markdown)]

//! axum HTTP + WebSocket server scaffold for the cloud-agent (T19.21).
//!
//! Mirrors the shape of `src-tauri/src/ws/server.rs` (T18.1) but keeps
//! the surface intentionally narrow:
//!
//!   * `GET /healthz` — unauthenticated liveness probe.
//!   * `GET /ws`      — bearer-authenticated WebSocket upgrade, handed
//!     off to [`crate::dispatch::run_connection`] (T19.24). Phase-1
//!     supports `settings_get` against a stubbed in-memory view; every
//!     other known `ClientMessage` type replies with a typed
//!     `error{kind:"unimplemented"}` frame.
//!
//! Auth re-uses [`workstation_core::ws::auth`] so the cloud-agent and
//! the desktop bridge speak the same handshake.
//!
//! The listener binds synchronously inside [`spawn`] so a port collision
//! surfaces immediately at boot rather than disappearing inside a
//! fire-and-forget task. `axum::serve` then runs on a background tokio
//! task with graceful shutdown wired to a tokio watch channel — the
//! daemon signals shutdown on SIGTERM / SIGINT and the server drains.

use std::net::SocketAddr;

use axum::extract::ws::WebSocketUpgrade;
use axum::extract::{Extension, Query, Request};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use sqlx::sqlite::SqlitePool;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use workstation_core::pty::PtyManager;
use workstation_core::ws::auth::{require_bearer, AuthToken};
use workstation_core::ws::system_monitor::{self, SystemMonitorHandle};

use crate::dispatch;
use crate::planflow_proxy::PlanflowState;

/// Handle to a running cloud-agent server. Dropping it triggers a
/// graceful shutdown and joins the background task.
pub struct ServerHandle {
    /// The address the listener bound to. May differ from the requested
    /// address when port `0` was used (tests) — callers log this.
    pub local_addr: SocketAddr,
    shutdown: watch::Sender<bool>,
    task: Option<JoinHandle<()>>,
    /// Long-lived auto-run orchestrator loop. Aborted on server shutdown
    /// so it doesn't outlive the DB pool it holds a reference to.
    orchestrator: Option<JoinHandle<()>>,
}

impl ServerHandle {
    /// Trigger a graceful shutdown and await the server task. Returns
    /// the task's join result so the caller can surface panics.
    pub async fn shutdown(mut self) -> Result<(), tokio::task::JoinError> {
        let _ = self.shutdown.send(true);
        // Abort the orchestrator first — it holds a clone of the DB pool
        // and must not outlive the server's lifetime.
        if let Some(orch) = self.orchestrator.take() {
            orch.abort();
        }
        if let Some(task) = self.task.take() {
            task.await?;
        }
        Ok(())
    }
}

impl Drop for ServerHandle {
    fn drop(&mut self) {
        // Best-effort: if the caller forgot to `await shutdown()`, at
        // least signal the server task so it doesn't outlive the
        // handle's lifetime.
        let _ = self.shutdown.send(true);
        if let Some(orch) = self.orchestrator.take() {
            orch.abort();
        }
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// Build the axum [`Router`] with the cloud-agent's routes wired up.
///
/// Exposed (crate-internal) for tests that want to drive the server
/// against a real `TcpListener` without going through [`spawn`].
pub(crate) fn router(
    token: AuthToken,
    pool: SqlitePool,
    manager: PtyManager,
    monitor: SystemMonitorHandle,
    planflow: PlanflowState,
    projects_root: dispatch::ProjectsRoot,
    sessions_meta: dispatch::SessionMetadataStore,
) -> Router {
    // Auth lives in a route-scoped middleware so it runs *before*
    // axum's `WebSocketUpgrade` extractor — the latter rejects any
    // non-upgrade GET with 400, which would otherwise mask our 401.
    // T19.23: the middleware itself lives in `workstation-core::ws::auth`
    // so the desktop bridge and the cloud-agent share one implementation
    // of the header + query parsing / 401 response shape.
    //
    // T19.25: the pool is layered as an axum `Extension` rather than
    // `Router::with_state` so the existing `with_state(token)` for the
    // auth middleware stays uncomplicated. `SqlitePool` is internally
    // Arc-shared so the per-request `Extension` extractor clones cheap.
    //
    // T19.26 adds the `PtyManager` as a second `Extension`. The manager
    // is created once at boot inside [`spawn`] (one registry per
    // daemon) and cloned per-connection by the dispatcher; `Clone` is
    // an Arc bump so the per-request extractor stays cheap.
    //
    // T19.28 adds the `SystemMonitorHandle` as a third `Extension`. One
    // sampler runs per daemon (started in [`spawn`]); each WebSocket
    // upgrade clones the handle and the dispatcher subscribes a fresh
    // broadcast receiver so every connection sees the same poll tick.
    // T19.29 layers a fourth `Extension` for the PlanFlow proxy state.
    // One [`PlanflowState`] is created at daemon boot inside [`spawn`]
    // (so the cached `cached_org_id` survives across reconnects) and
    // cloned per connection via the extractor — the underlying
    // `reqwest::Client` and the loader / cache handles are Arc-shared,
    // so the per-request clone is cheap.
    let ws_routes = Router::new()
        .route("/ws", get(ws_handler))
        .route_layer(middleware::from_fn_with_state(token, require_bearer))
        .layer(Extension(pool))
        .layer(Extension(manager))
        .layer(Extension(monitor))
        .layer(Extension(planflow))
        .layer(Extension(projects_root))
        .layer(Extension(sessions_meta));

    Router::new()
        .route("/healthz", get(healthz))
        .merge(ws_routes)
        // PWA dev / mobile origins differ from the agent host; advertise
        // a permissive CORS policy so the browser's pre-flight
        // doesn't block the bearer-token fetch. Safe here because every
        // sensitive route is still bearer-gated and the listener is
        // loopback-bound by default.
        .layer(middleware::from_fn(cors_middleware))
}

/// Bind the listener and start serving on a background tokio task.
///
/// Returns a [`ServerHandle`] carrying the bound address and a
/// graceful-shutdown signal. The caller drives shutdown explicitly
/// (`handle.shutdown().await`) — `Drop` is a fallback that aborts the
/// task if the handle is dropped without an awaited shutdown.
// Integration tests that don't need a shared PtyManager use this
// convenience wrapper. The binary entry-point uses spawn_with_components.
#[allow(dead_code)]
pub async fn spawn(
    token: AuthToken,
    pool: SqlitePool,
    planflow: PlanflowState,
    projects_root: dispatch::ProjectsRoot,
    addr: SocketAddr,
) -> std::io::Result<ServerHandle> {
    // T19.26 — one `PtyManager` per daemon, shared across every
    // WebSocket connection via the `Extension` layer. Cloning the
    // manager is an Arc bump, so the per-connection clone in
    // `ws_handler` is cheap.
    let manager = PtyManager::new();
    // T19.28 — start the system-stats sampler. The handle is cloned
    // per WebSocket upgrade via the `Extension` layer; the underlying
    // broadcast sender keeps the publisher task alive even when no
    // receivers are connected (idle daemon between PWA sessions).
    let monitor = system_monitor::start(manager.clone());
    let sessions_meta = dispatch::new_session_metadata_store();
    spawn_with_components(
        token,
        pool,
        manager,
        monitor,
        planflow,
        projects_root,
        sessions_meta,
        addr,
    )
    .await
}

/// Variant of [`spawn`] that also accepts an explicit `orchestrator`
/// handle so callers can optionally suppress the auto-run loop (tests
/// that don't need it pass `None`).
///
/// The handle is stored on [`ServerHandle`] and aborted on shutdown so
/// the orchestrator doesn't outlive the DB pool it holds a reference to.
pub(crate) fn attach_orchestrator(handle: &mut ServerHandle, orch: JoinHandle<()>) {
    handle.orchestrator = Some(orch);
}

/// Same as [`spawn`] but with caller-supplied `PtyManager` and
/// `SystemMonitorHandle`. Tests use this to inject a fast-tick monitor
/// so `system_stats` smoke tests don't wait the production 4-second
/// cadence.
// Each argument is a distinct injectable component; no cohesive grouping
// exists that wouldn't just be a grab-bag struct.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn spawn_with_components(
    token: AuthToken,
    pool: SqlitePool,
    manager: PtyManager,
    monitor: SystemMonitorHandle,
    planflow: PlanflowState,
    projects_root: dispatch::ProjectsRoot,
    sessions_meta: dispatch::SessionMetadataStore,
    addr: SocketAddr,
) -> std::io::Result<ServerHandle> {
    let app = router(
        token,
        pool,
        manager,
        monitor,
        planflow,
        projects_root,
        sessions_meta,
    );
    let listener = TcpListener::bind(addr).await?;
    let local_addr = listener.local_addr()?;

    let (shutdown_tx, mut shutdown_rx) = watch::channel(false);
    let task = tokio::spawn(async move {
        let serve = axum::serve(listener, app).with_graceful_shutdown(async move {
            // Wait until shutdown is requested. `changed()` resolves on
            // any send, so this future completes the moment
            // `handle.shutdown()` (or a Drop) flips the watch value.
            let _ = shutdown_rx.changed().await;
        });
        if let Err(error) = serve.await {
            tracing::error!(target: "cloud_agent::server", %error, "axum serve exited with error");
        }
    });

    Ok(ServerHandle {
        local_addr,
        shutdown: shutdown_tx,
        task: Some(task),
        orchestrator: None,
    })
}

/// Permissive CORS middleware. Short-circuits `OPTIONS` preflights with
/// a 204 + the standard `Access-Control-*` headers and stamps the same
/// headers on every other response so cross-origin browser clients can
/// reach `/healthz` and `/ws`.
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

/// `GET /healthz` — unauthenticated liveness probe.
async fn healthz() -> impl IntoResponse {
    (StatusCode::OK, "ok")
}

#[derive(Debug, Deserialize)]
struct WsQuery {
    // Consumed by `require_bearer`; declared here so axum still rejects
    // requests with malformed query layouts before reaching the handler.
    #[allow(dead_code)]
    token: Option<String>,
}

/// `GET /ws` — WebSocket upgrade. Auth has already passed at the
/// middleware; we hand the live socket off to the dispatch loop which
/// owns per-connection state until the peer closes (T19.24). T19.25
/// threads the SQLite pool through here so the dispatcher can serve
/// DB-backed `settings_get` / projects handlers.
// Axum extracts each Extension as a separate argument; no refactoring
// without replacing Extensions with a single wrapper type (out of scope).
#[allow(clippy::too_many_arguments)]
async fn ws_handler(
    Query(_query): Query<WsQuery>,
    Extension(pool): Extension<SqlitePool>,
    Extension(manager): Extension<PtyManager>,
    Extension(monitor): Extension<SystemMonitorHandle>,
    Extension(planflow): Extension<PlanflowState>,
    Extension(projects_root): Extension<dispatch::ProjectsRoot>,
    Extension(sessions_meta): Extension<dispatch::SessionMetadataStore>,
    upgrade: WebSocketUpgrade,
) -> Response {
    upgrade.on_upgrade(move |socket| {
        dispatch::run_connection(
            socket,
            manager,
            pool,
            monitor,
            planflow,
            projects_root,
            sessions_meta,
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};
    use std::time::Duration;

    /// Spin up a real server backed by a fresh on-disk SQLite (the
    /// pool is opened by `crate::db::open` against a tempdir). The dir
    /// is leaked for the test's lifetime — sqlite needs the file alive
    /// until the pool drops, and these tests don't tear down the
    /// server cleanly enough to use a guard with a clearly-bounded
    /// lifetime.
    async fn spawn_test_server() -> (ServerHandle, SocketAddr) {
        let token = AuthToken::new("secret");
        let dir = tempfile::tempdir().expect("tempdir");
        let dir = Box::leak(Box::new(dir));
        let pool = crate::db::open(dir.path()).await.expect("open db");
        // T19.29 — these tests exercise the auth / healthz / dispatch
        // routing paths; none of them speak PlanFlow. Hand the server a
        // PlanflowState with no token so any stray `planflow_*` frame
        // would short-circuit on `no_credential` instead of hitting the
        // network. The real proxy behaviour is covered by the
        // `planflow_proxy::tests` suite against a wiremock server.
        let planflow =
            PlanflowState::for_test("http://127.0.0.1:1", std::sync::Arc::new(|_pid| Ok(None)));
        let projects_root = dispatch::ProjectsRoot::new(dir.path().join("projects"));
        std::fs::create_dir_all(projects_root.as_path()).expect("mkdir projects root");
        let handle = spawn(
            token,
            pool,
            planflow,
            projects_root,
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        )
        .await
        .expect("bind ephemeral");
        let addr = handle.local_addr;
        // Give axum a beat to start accepting before tests connect.
        tokio::time::sleep(Duration::from_millis(20)).await;
        (handle, addr)
    }

    #[tokio::test]
    async fn healthz_is_unauthenticated() {
        let (handle, addr) = spawn_test_server().await;
        let body = reqwest::get(format!("http://{addr}/healthz"))
            .await
            .expect("get")
            .text()
            .await
            .expect("body");
        assert_eq!(body, "ok");
        handle.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn ws_upgrade_rejects_missing_token() {
        let (handle, addr) = spawn_test_server().await;
        let status = reqwest::Client::new()
            .get(format!("http://{addr}/ws"))
            .send()
            .await
            .expect("send")
            .status();
        assert_eq!(status, reqwest::StatusCode::UNAUTHORIZED);
        handle.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn ws_upgrade_rejects_wrong_token() {
        let (handle, addr) = spawn_test_server().await;
        let status = reqwest::Client::new()
            .get(format!("http://{addr}/ws"))
            .header("Authorization", "Bearer wrong")
            .send()
            .await
            .expect("send")
            .status();
        assert_eq!(status, reqwest::StatusCode::UNAUTHORIZED);
        handle.shutdown().await.expect("shutdown");
    }

    /// End-to-end smoke test for the dispatch loop: a valid upgrade
    /// keeps the socket open, and a real `settings_get` request
    /// resolves with the DB-backed `SettingsResult` frame. With a
    /// fresh database the values fall back to the same defaults the
    /// T19.24 stub returned (`theme=dark`, `lastActiveProject=null`),
    /// so the regression coverage is unchanged after T19.25.
    /// Together with the dispatcher unit tests in `dispatch.rs` this
    /// proves the full path: axum upgrade → auth middleware → dispatch
    /// loop → SQLite → reply.
    #[tokio::test]
    async fn ws_settings_get_returns_db_backed_view() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        use tokio_tungstenite::tungstenite::Message;

        let (handle, addr) = spawn_test_server().await;

        let url = format!("ws://{addr}/ws");
        let mut req = url.into_client_request().expect("client req");
        req.headers_mut()
            .insert("Authorization", "Bearer secret".parse().unwrap());
        let (mut socket, response) = tokio_tungstenite::connect_async(req)
            .await
            .expect("connect");
        assert_eq!(response.status().as_u16(), 101);

        socket
            .send(Message::Text(
                r#"{"type":"settings_get","id":"smoke-1"}"#.to_string(),
            ))
            .await
            .expect("send settings_get");

        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        let mut payload_for_assert = String::new();
        while tokio::time::Instant::now() < deadline && payload_for_assert.is_empty() {
            let next = tokio::time::timeout(Duration::from_millis(500), socket.next()).await;
            if let Ok(Some(Ok(Message::Text(payload)))) = next {
                payload_for_assert = payload;
            }
        }
        assert!(
            payload_for_assert.contains(r#""type":"settings_result""#)
                && payload_for_assert.contains(r#""id":"smoke-1""#)
                && payload_for_assert.contains(r#""theme":"dark""#)
                && payload_for_assert.contains(r#""lastActiveProject":null"#),
            "expected settings_result frame, got {payload_for_assert:?}",
        );

        let _ = socket.close(None).await;
        handle.shutdown().await.expect("shutdown");
    }

    /// Known-but-unimplemented type goes through the dispatch loop and
    /// produces the typed `error{kind:"unimplemented"}` frame end-to-end.
    /// Catches a regression where the upgrade handler accidentally
    /// short-circuits before the dispatcher runs.
    #[tokio::test]
    async fn ws_unimplemented_known_type_returns_typed_error() {
        use futures_util::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        use tokio_tungstenite::tungstenite::Message;

        let (handle, addr) = spawn_test_server().await;

        let url = format!("ws://{addr}/ws");
        let mut req = url.into_client_request().expect("client req");
        req.headers_mut()
            .insert("Authorization", "Bearer secret".parse().unwrap());
        let (mut socket, response) = tokio_tungstenite::connect_async(req)
            .await
            .expect("connect");
        assert_eq!(response.status().as_u16(), 101);

        // T19.29 wired the `planflow_*` proxy variants — the only
        // remaining known-but-unimplemented family is `planflow_chat_*`.
        // Those route to a live desktop PTY and have no cloud-side
        // analog. `planflow_chat_clear` is the smallest payload that
        // stays on the fallback arm.
        socket
            .send(Message::Text(
                r#"{"type":"planflow_chat_clear","id":"smoke-2","project_id":"p"}"#.to_string(),
            ))
            .await
            .expect("send planflow_chat_clear");

        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        let mut payload_for_assert = String::new();
        while tokio::time::Instant::now() < deadline && payload_for_assert.is_empty() {
            let next = tokio::time::timeout(Duration::from_millis(500), socket.next()).await;
            if let Ok(Some(Ok(Message::Text(payload)))) = next {
                payload_for_assert = payload;
            }
        }
        assert!(
            payload_for_assert.contains(r#""type":"error""#)
                && payload_for_assert.contains(r#""kind":"unimplemented""#)
                && payload_for_assert.contains(r#""id":"smoke-2""#),
            "expected unimplemented frame, got {payload_for_assert:?}",
        );

        let _ = socket.close(None).await;
        handle.shutdown().await.expect("shutdown");
    }

    #[tokio::test]
    async fn ws_upgrade_accepts_token_in_query() {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;

        let (handle, addr) = spawn_test_server().await;
        let url = format!("ws://{addr}/ws?token=secret");
        let req = url.into_client_request().expect("client req");
        let (mut socket, response) = tokio_tungstenite::connect_async(req)
            .await
            .expect("connect");
        assert_eq!(response.status().as_u16(), 101);
        let _ = socket.close(None).await;

        handle.shutdown().await.expect("shutdown");
    }

    /// Boot a server with a fast-tick system_monitor so the smoke test
    /// doesn't wait the production 4-second cadence. Same shape as
    /// `spawn_test_server` otherwise — fresh tempdir / pool, ephemeral
    /// port, short post-bind sleep so axum is accepting before the
    /// caller dials.
    async fn spawn_test_server_with_fast_monitor() -> (ServerHandle, SocketAddr) {
        let token = AuthToken::new("secret");
        let dir = tempfile::tempdir().expect("tempdir");
        let dir = Box::leak(Box::new(dir));
        let pool = crate::db::open(dir.path()).await.expect("open db");
        let manager = PtyManager::new();
        let monitor =
            system_monitor::start_with_interval(manager.clone(), Duration::from_millis(50));
        let planflow =
            PlanflowState::for_test("http://127.0.0.1:1", std::sync::Arc::new(|_pid| Ok(None)));
        let projects_root = dispatch::ProjectsRoot::new(dir.path().join("projects"));
        std::fs::create_dir_all(projects_root.as_path()).expect("mkdir projects root");
        let sessions_meta = dispatch::new_session_metadata_store();
        let handle = spawn_with_components(
            token,
            pool,
            manager,
            monitor,
            planflow,
            projects_root,
            sessions_meta,
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0),
        )
        .await
        .expect("bind ephemeral");
        let addr = handle.local_addr;
        tokio::time::sleep(Duration::from_millis(20)).await;
        (handle, addr)
    }

    /// T19.28 acceptance: a connected client receives `system_stats`
    /// frames from the cloud-agent's broadcaster without sending any
    /// request — the dispatch loop subscribes on upgrade and forwards
    /// every snapshot through the shared outbound mpsc.
    #[tokio::test]
    async fn ws_connection_receives_system_stats() {
        use futures_util::StreamExt;
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        use tokio_tungstenite::tungstenite::Message;

        let (handle, addr) = spawn_test_server_with_fast_monitor().await;

        let url = format!("ws://{addr}/ws");
        let mut req = url.into_client_request().expect("client req");
        req.headers_mut()
            .insert("Authorization", "Bearer secret".parse().unwrap());
        let (mut socket, response) = tokio_tungstenite::connect_async(req)
            .await
            .expect("connect");
        assert_eq!(response.status().as_u16(), 101);

        // Wait up to 3s for a system_stats frame. The monitor primes
        // for ~200ms (MINIMUM_CPU_UPDATE_INTERVAL) then ticks every
        // 50ms, so the first frame should land well inside the budget.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
        let mut payload_for_assert = String::new();
        let mut saw_stats = false;
        while tokio::time::Instant::now() < deadline && !saw_stats {
            let next = tokio::time::timeout(Duration::from_millis(500), socket.next()).await;
            if let Ok(Some(Ok(Message::Text(payload)))) = next {
                if payload.contains(r#""type":"system_stats""#) {
                    payload_for_assert = payload;
                    saw_stats = true;
                }
            }
        }
        assert!(saw_stats, "never received system_stats frame");
        assert!(
            payload_for_assert.contains(r#""cpu_percent""#)
                && payload_for_assert.contains(r#""ram_used_bytes""#)
                && payload_for_assert.contains(r#""ram_total_bytes""#)
                && payload_for_assert.contains(r#""pty_session_count""#),
            "system_stats frame missing fields: {payload_for_assert}",
        );

        // Verify the publisher keeps ticking — a second frame within
        // ~2 ticks proves the broadcaster wasn't a one-shot.
        let mut saw_second = false;
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        while tokio::time::Instant::now() < deadline && !saw_second {
            let next = tokio::time::timeout(Duration::from_millis(500), socket.next()).await;
            if let Ok(Some(Ok(Message::Text(payload)))) = next {
                if payload.contains(r#""type":"system_stats""#) {
                    saw_second = true;
                }
            }
        }
        assert!(saw_second, "second system_stats frame never arrived");

        let _ = socket.close(None).await;
        handle.shutdown().await.expect("shutdown");
    }
}
