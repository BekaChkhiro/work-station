//! HTTP routes for the Web Push surface (T18.19).
//!
//! These are mounted under `ws::server::router` so they sit behind the
//! same bearer-token middleware as the `/ws` upgrade — the PWA reuses
//! its WebSocket auth token for the subscribe handshake.
//!
//! Endpoints:
//!   * `GET    /push/vapid`     → `{ publicKey: "<base64-url-no-pad>" }`
//!   * `POST   /push/subscribe` → upserts a `PushSubscription` payload
//!   * `DELETE /push/subscribe` → removes a subscription by `endpoint`
//!
//! The route group is generic over the parent Router's state type so it
//! can merge into the WS bridge's `Router<Arc<AppState>>` without
//! pinning a concrete state. The push service handle reaches the
//! handlers via `Extension` instead of typed `State`.

use std::time::{SystemTime, UNIX_EPOCH};

use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Extension, Json, Router};
use serde::{Deserialize, Serialize};

use super::{store, PushService};

#[derive(Debug, Serialize)]
struct VapidResponse {
    #[serde(rename = "publicKey")]
    public_key: String,
}

#[derive(Debug, Deserialize)]
pub struct SubscriptionPayload {
    pub endpoint: String,
    pub keys: SubscriptionKeys,
    #[serde(default, rename = "userAgent")]
    pub user_agent: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SubscriptionKeys {
    pub p256dh: String,
    pub auth: String,
}

#[derive(Debug, Deserialize)]
pub struct UnsubscribePayload {
    pub endpoint: String,
}

#[derive(Debug, Serialize)]
struct OkResponse {
    ok: bool,
}

/// Build the push HTTP route group. Generic over `S` so the caller can
/// merge it into any state-shaped parent router; the push service is
/// injected via an `Extension` layer rather than typed state.
pub fn routes<S>(service: PushService) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
{
    Router::new()
        .route("/push/vapid", get(get_vapid))
        .route("/push/subscribe", post(post_subscribe))
        .route("/push/subscribe", delete(delete_subscribe))
        .layer(Extension(service))
}

async fn get_vapid(Extension(service): Extension<PushService>) -> Json<VapidResponse> {
    Json(VapidResponse {
        public_key: service.public_key_b64().to_string(),
    })
}

async fn post_subscribe(
    Extension(service): Extension<PushService>,
    Json(payload): Json<SubscriptionPayload>,
) -> Response {
    if payload.endpoint.trim().is_empty()
        || payload.keys.p256dh.trim().is_empty()
        || payload.keys.auth.trim().is_empty()
    {
        return (StatusCode::BAD_REQUEST, "invalid_subscription").into_response();
    }
    let sub = store::Subscription {
        endpoint: payload.endpoint,
        p256dh: payload.keys.p256dh,
        auth: payload.keys.auth,
        user_agent: payload.user_agent,
        created_at: epoch_seconds(),
    };
    match store::upsert(service.pool(), &sub).await {
        Ok(()) => (StatusCode::CREATED, Json(OkResponse { ok: true })).into_response(),
        Err(error) => {
            tracing::error!(target: "push", %error, "subscription upsert failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "persist_failed").into_response()
        }
    }
}

async fn delete_subscribe(
    Extension(service): Extension<PushService>,
    Json(payload): Json<UnsubscribePayload>,
) -> Response {
    if payload.endpoint.trim().is_empty() {
        return (StatusCode::BAD_REQUEST, "invalid_endpoint").into_response();
    }
    match store::delete(service.pool(), &payload.endpoint).await {
        Ok(_) => (StatusCode::OK, Json(OkResponse { ok: true })).into_response(),
        Err(error) => {
            tracing::error!(target: "push", %error, "subscription delete failed");
            (StatusCode::INTERNAL_SERVER_ERROR, "persist_failed").into_response()
        }
    }
}

fn epoch_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| i64::try_from(d.as_secs()).ok())
        .unwrap_or(0)
}
