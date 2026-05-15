//! axum HTTP + WebSocket server scaffold for the cloud-agent (T19.21).
//!
//! Mirrors the shape of `src-tauri/src/ws/server.rs` (T18.1) but keeps
//! the surface intentionally narrow:
//!
//!   * `GET /healthz` — unauthenticated liveness probe.
//!   * `GET /ws`      — bearer-authenticated WebSocket upgrade. The
//!     upgrade handler is a placeholder that accepts the connection and
//!     closes it cleanly with a typed `error{kind:"unimplemented"}`
//!     frame; later tasks (PTY bridge, project state) replace it with
//!     the full dispatcher.
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
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use workstation_core::ws::auth::{check_auth, AuthResult, AuthToken};

/// Shared state injected into every axum handler.
#[derive(Clone)]
struct AppState {
    token: AuthToken,
}

/// Handle to a running cloud-agent server. Dropping it triggers a
/// graceful shutdown and joins the background task.
pub struct ServerHandle {
    /// The address the listener bound to. May differ from the requested
    /// address when port `0` was used (tests) — callers log this.
    pub local_addr: SocketAddr,
    shutdown: watch::Sender<bool>,
    task: Option<JoinHandle<()>>,
}

impl ServerHandle {
    /// Trigger a graceful shutdown and await the server task. Returns
    /// the task's join result so the caller can surface panics.
    pub async fn shutdown(mut self) -> Result<(), tokio::task::JoinError> {
        let _ = self.shutdown.send(true);
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
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

/// Build the axum [`Router`] with the cloud-agent's routes wired up.
///
/// Exposed (crate-internal) for tests that want to drive the server
/// against a real `TcpListener` without going through [`spawn`].
pub(crate) fn router(token: AuthToken) -> Router {
    let state = Arc::new(AppState { token });

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

    Router::new()
        .route("/healthz", get(healthz))
        .merge(ws_routes)
        .with_state(state)
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
pub async fn spawn(token: AuthToken, addr: SocketAddr) -> std::io::Result<ServerHandle> {
    let app = router(token);
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

/// Bearer-token middleware. Runs before extractors so a missing or
/// invalid token surfaces as a clean 401 with `WWW-Authenticate: Bearer`
/// instead of axum's generic 400 from the `WebSocketUpgrade` extractor.
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

/// `GET /ws` — placeholder upgrade handler.
///
/// Auth has already passed at the middleware. The PTY / project bridges
/// land in follow-up tasks; for now we accept the upgrade, emit a
/// typed `error{kind:"unimplemented"}` frame so clients see a
/// deterministic shape, and close cleanly.
async fn ws_handler(
    State(_state): State<Arc<AppState>>,
    Query(_query): Query<WsQuery>,
    upgrade: WebSocketUpgrade,
) -> Response {
    upgrade.on_upgrade(ws_placeholder)
}

async fn ws_placeholder(mut socket: WebSocket) {
    let frame = serde_json::json!({
        "type": "error",
        "kind": "unimplemented",
        "message": "cloud-agent ws bridge is scaffold-only (T19.21); PTY and project dispatchers land in follow-up tasks",
    });
    // Best-effort: a write failure here just means the client hung up
    // first. The placeholder doesn't need retry / backoff.
    let _ = socket.send(Message::Text(frame.to_string())).await;
    let _ = socket.close().await;
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
    use std::net::{IpAddr, Ipv4Addr};
    use std::time::Duration;

    async fn spawn_test_server() -> (ServerHandle, SocketAddr) {
        let token = AuthToken::new("secret");
        let handle = spawn(token, SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 0))
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

    #[tokio::test]
    async fn ws_upgrade_accepts_valid_token_and_sends_unimplemented() {
        use futures_util::StreamExt;
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;

        let (handle, addr) = spawn_test_server().await;

        let url = format!("ws://{addr}/ws");
        let mut req = url.into_client_request().expect("client req");
        req.headers_mut()
            .insert("Authorization", "Bearer secret".parse().unwrap());
        let (mut socket, response) = tokio_tungstenite::connect_async(req)
            .await
            .expect("connect");
        assert_eq!(response.status().as_u16(), 101);

        // First (and only) frame should be the unimplemented error,
        // followed by a close. Bound the wait so a misrouted handler
        // surfaces as a test failure rather than a hang.
        let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
        let mut payload_for_assert = String::new();
        while tokio::time::Instant::now() < deadline && payload_for_assert.is_empty() {
            let next = tokio::time::timeout(Duration::from_millis(500), socket.next()).await;
            if let Ok(Some(Ok(tokio_tungstenite::tungstenite::Message::Text(payload)))) = next {
                payload_for_assert = payload;
            }
        }
        assert!(
            payload_for_assert.contains(r#""type":"error""#)
                && payload_for_assert.contains(r#""kind":"unimplemented""#),
            "missing unimplemented frame: {payload_for_assert:?}",
        );

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
}
