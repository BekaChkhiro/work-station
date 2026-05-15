//! Web Push delivery (T18.19).
//!
//! Builds and dispatches a `WebPushMessage` to every stored subscription
//! via the `web-push` crate. The `web-push` 0.10+ surface exposes:
//!
//!   * `SubscriptionInfo` — the `(endpoint, p256dh, auth)` triple from
//!     the browser's `pushManager.subscribe(...)` result
//!   * `VapidSignatureBuilder::from_pem` — parses a PKCS#8 PEM private
//!     key and produces a JWT signature bound to the target endpoint's
//!     audience
//!   * `WebPushMessageBuilder` — assembles the encrypted payload (AES-
//!     128-GCM under the hood for `ContentEncoding::Aes128Gcm`) and
//!     attaches the VAPID signature
//!   * `IsahcWebPushClient` (default feature) — performs the actual HTTP
//!     POST against the push service
//!
//! 404 / 410 responses prune the corresponding row — those mean the
//! user revoked the subscription on the device.

use serde::{Deserialize, Serialize};
use web_push::{
    ContentEncoding, IsahcWebPushClient, SubscriptionInfo, SubscriptionKeys, VapidSignatureBuilder,
    WebPushClient, WebPushError, WebPushMessageBuilder,
};

use super::{store, PushService};

/// High-level notification taxonomy. Maps to a stable string discriminator
/// the service worker can branch on to choose icon / sound / interaction.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PushKind {
    TaskDone,
    TaskError,
    SessionExit,
    Info,
}

impl PushKind {
    pub fn as_str(self) -> &'static str {
        match self {
            PushKind::TaskDone => "task_done",
            PushKind::TaskError => "task_error",
            PushKind::SessionExit => "session_exit",
            PushKind::Info => "info",
        }
    }
}

/// What the service worker receives. Matches the desktop notification
/// shape so the PWA can render task name + status without bespoke
/// per-kind parsing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PushPayload {
    pub title: String,
    pub body: String,
    pub kind: PushKind,
    /// Free-form key/value for the SW to attach as `data` on the
    /// Notification — e.g. `task_id` so a tap can deep-link to the task.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

impl PushPayload {
    pub fn task_done(name: impl Into<String>) -> Self {
        let name = name.into();
        Self {
            title: "Task done".to_string(),
            body: name,
            kind: PushKind::TaskDone,
            task_id: None,
        }
    }

    pub fn task_error(name: impl Into<String>, message: impl Into<String>) -> Self {
        Self {
            title: format!("Task failed: {}", name.into()),
            body: message.into(),
            kind: PushKind::TaskError,
            task_id: None,
        }
    }

    pub fn session_exit(label: impl Into<String>) -> Self {
        Self {
            title: "Session ended".to_string(),
            body: label.into(),
            kind: PushKind::SessionExit,
            task_id: None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum NotifyError {
    #[error("sqlx: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("encode push payload: {0}")]
    Encode(String),
    #[error("vapid signature: {0}")]
    Vapid(String),
    #[error("build push client: {0}")]
    Client(String),
}

/// Broadcast `payload` to every stored subscription. Returns the number
/// of subscriptions that were attempted (including pruned ones).
pub async fn broadcast(service: &PushService, payload: PushPayload) -> Result<usize, NotifyError> {
    let subs = store::list_all(service.pool()).await?;
    if subs.is_empty() {
        tracing::debug!(target: "push", "broadcast skipped: no subscriptions");
        return Ok(0);
    }
    let body = serde_json::to_vec(&payload)
        .map_err(|e| NotifyError::Encode(format!("serialize payload: {e}")))?;

    let client =
        IsahcWebPushClient::new().map_err(|e| NotifyError::Client(format!("isahc client: {e}")))?;

    let mut attempted = 0;
    for sub in &subs {
        attempted += 1;
        match send_one(service, &client, sub, &body).await {
            Ok(()) => {
                tracing::debug!(
                    target: "push",
                    endpoint = %short(&sub.endpoint),
                    "push delivered",
                );
            }
            Err(SendError::Gone) => {
                tracing::info!(
                    target: "push",
                    endpoint = %short(&sub.endpoint),
                    "subscription gone; pruning",
                );
                if let Err(error) = store::delete(service.pool(), &sub.endpoint).await {
                    tracing::warn!(
                        target: "push",
                        %error,
                        endpoint = %short(&sub.endpoint),
                        "prune failed",
                    );
                }
            }
            Err(SendError::Transient(error)) => {
                tracing::warn!(
                    target: "push",
                    endpoint = %short(&sub.endpoint),
                    %error,
                    "push send failed",
                );
            }
        }
    }
    Ok(attempted)
}

enum SendError {
    Gone,
    Transient(String),
}

async fn send_one(
    service: &PushService,
    client: &IsahcWebPushClient,
    sub: &store::Subscription,
    body: &[u8],
) -> Result<(), SendError> {
    let info = SubscriptionInfo {
        endpoint: sub.endpoint.clone(),
        keys: SubscriptionKeys {
            p256dh: sub.p256dh.clone(),
            auth: sub.auth.clone(),
        },
    };

    let signature =
        VapidSignatureBuilder::from_pem(std::io::Cursor::new(service.keys().private_pem()), &info)
            .and_then(|mut b| {
                b.add_claim("sub", service_contact(service));
                b.build()
            })
            .map_err(|e| SendError::Transient(format!("vapid: {e}")))?;

    let mut builder = WebPushMessageBuilder::new(&info);
    builder.set_vapid_signature(signature);
    builder.set_payload(ContentEncoding::Aes128Gcm, body);
    let message = builder
        .build()
        .map_err(|e| SendError::Transient(format!("build message: {e}")))?;

    match client.send(message).await {
        Ok(()) => Ok(()),
        Err(WebPushError::EndpointNotValid | WebPushError::EndpointNotFound) => {
            Err(SendError::Gone)
        }
        Err(error) => Err(SendError::Transient(error.to_string())),
    }
}

fn service_contact(service: &PushService) -> String {
    // PushService.contact is a private field; expose through a helper so
    // the notifier doesn't need a pub getter.
    service_contact_inner(service).to_string()
}

#[inline]
fn service_contact_inner(service: &PushService) -> &str {
    // Reach into the struct via a small accessor pattern: PushService has
    // pub(crate)-visible field access in `super`.
    super::push_service_contact(service)
}

/// Truncate long URLs for log lines — push endpoints embed opaque IDs we
/// don't want to dump in full to the file appender.
fn short(s: &str) -> String {
    if s.len() <= 64 {
        s.to_string()
    } else {
        format!("{}…", &s[..63])
    }
}
