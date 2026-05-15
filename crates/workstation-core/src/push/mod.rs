//! Web Push notifications (T18.19).
//!
//! Boot path (`init`) loads/creates a P-256 VAPID keypair from
//! `app_settings`, hands it to a [`PushService`], and stows the service
//! in a process-global `OnceLock` so any subsystem can call
//! [`notify`] without threading state through every call site.
//!
//! Surface:
//!   * `init(pool)` — boot the service; idempotent
//!   * `service()` — borrow the live service handle
//!   * `notify(payload)` — fire-and-forget broadcast to every stored
//!     subscription
//!   * HTTP endpoints under `/push/...` mounted by `ws::server::router`
//!
//! Subscriptions are stored in `SQLite` (migration 0011). Sends that
//! observe HTTP 404/410 from the push service prune the corresponding
//! row — those status codes mean the user revoked the subscription on
//! the device.

#![allow(dead_code)] // T18.6 / future PWA fill in the remaining callers.

use std::sync::OnceLock;

use sqlx::sqlite::SqlitePool;

pub mod http;
mod notifier;
mod store;
mod vapid;

pub use notifier::{PushKind, PushPayload};
#[allow(unused_imports)]
pub use store::Subscription;
pub use vapid::VapidKeys;

/// `app_settings.key` under which the VAPID keypair lives.
pub const VAPID_SETTING_KEY: &str = "vapid_keys";

/// Shared service handle.
///
/// `Clone` is cheap (the inner state is `Arc`-wrapped) so handlers and
/// commands can take an owned copy without contention.
#[derive(Clone)]
pub struct PushService {
    pool: SqlitePool,
    keys: VapidKeys,
    /// HTTP client for outbound push requests. Reused across sends so we
    /// don't pay TLS handshake cost per notification.
    http: reqwest::Client,
    /// Contact line embedded in the VAPID `sub` claim. Most push services
    /// (FCM, autopush) demand a `mailto:` or `https:` value; the bridge
    /// has no real email so we ship a stable `mailto:` derived from the
    /// app name. Configurable via `WS_PUSH_VAPID_SUB`.
    contact: String,
}

impl std::fmt::Debug for PushService {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PushService")
            .field("contact", &self.contact)
            .finish_non_exhaustive()
    }
}

impl PushService {
    pub fn pool(&self) -> &SqlitePool {
        &self.pool
    }

    pub fn keys(&self) -> &VapidKeys {
        &self.keys
    }

    /// Base64-url-no-pad encoding of the VAPID public key — exactly the
    /// shape the browser's `pushManager.subscribe({ applicationServerKey })`
    /// expects.
    pub fn public_key_b64(&self) -> &str {
        self.keys.public_b64()
    }
}

/// Errors surfaced during `push::init`.
#[derive(Debug, thiserror::Error)]
pub enum InitError {
    #[error("load/persist vapid keys: {0}")]
    Vapid(#[from] vapid::VapidError),
    #[error("build http client: {0}")]
    Http(#[from] reqwest::Error),
}

static PUSH_SERVICE: OnceLock<PushService> = OnceLock::new();

/// Boot the push service. Safe to call once at startup; later calls are
/// no-ops (the first install wins, matching the `OnceLock` contract).
pub async fn init(pool: SqlitePool) -> Result<PushService, InitError> {
    let keys = vapid::load_or_create(&pool).await?;
    let http = reqwest::Client::builder()
        .user_agent(concat!(
            "work-station/",
            env!("CARGO_PKG_VERSION"),
            " (+webpush)"
        ))
        .build()?;
    let contact = std::env::var("WS_PUSH_VAPID_SUB")
        .unwrap_or_else(|_| "mailto:noreply@work-station.local".to_string());
    let service = PushService {
        pool,
        keys,
        http,
        contact,
    };
    let _ = PUSH_SERVICE.set(service.clone());
    Ok(service)
}

/// Returns the live service handle if `init` has run.
pub fn service() -> Option<PushService> {
    PUSH_SERVICE.get().cloned()
}

/// `pub(super)` accessor for the contact line so `notifier` can read
/// it without exposing the raw field publicly.
pub(super) fn push_service_contact(service: &PushService) -> &str {
    &service.contact
}

/// Fire-and-forget push notification to every stored subscription.
///
/// Sends run on a background tokio task — callers don't await delivery.
/// Failed sends are logged; 404/410 responses prune the subscription
/// from `SQLite` so the next broadcast doesn't waste a network round trip
/// on a dead endpoint.
///
/// No-op if `init` hasn't been called (e.g. boot failed before the push
/// service came up).
pub fn notify(payload: PushPayload) {
    let Some(service) = PUSH_SERVICE.get().cloned() else {
        tracing::debug!(target: "push", "notify dropped: service not initialised");
        return;
    };
    tokio::spawn(async move {
        if let Err(error) = notifier::broadcast(&service, payload).await {
            tracing::error!(target: "push", %error, "broadcast failed");
        }
    });
}
