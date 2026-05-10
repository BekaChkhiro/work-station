//! T11.4: typed errors for the generic HTTP client.
//!
//! Callers branch on these variants to drive UX (e.g. show a "rate limited,
//! try again at HH:MM" banner for [`HttpError::RateLimit`]) rather than
//! parsing free-form strings. The shape mirrors the project-wide convention
//! used by [`crate::commands::projects::ProjectError`] — a serde-tagged enum
//! is layered on top in the command boundary, but the core library type
//! stays plain `thiserror`.

use std::time::Duration;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum HttpError {
    /// DNS / TCP / TLS / connection-reset etc. — the request never produced
    /// a complete response.
    #[error("network error: {0}")]
    Network(String),

    /// The configured per-request timeout elapsed before a complete response.
    #[error("request timed out after {0:?}")]
    Timeout(Duration),

    /// HTTP 429 — never retried automatically. `retry_after` is parsed from
    /// the `Retry-After` response header when present (delta-seconds form;
    /// HTTP-date form is intentionally not parsed yet — every integration
    /// we ship for v0.2 returns delta-seconds).
    #[error("rate limited (HTTP 429); retry after {retry_after:?}")]
    RateLimit { retry_after: Option<Duration> },

    /// HTTP 5xx after exhausting the retry budget. `retries` reports how
    /// many retry attempts ran in addition to the initial request.
    #[error("server error {status} after {retries} retries")]
    Server { status: u16, retries: u32 },

    /// `SQLite` cache read/write failure — surfaced rather than swallowed so
    /// disk corruption is loud, not silently bypassed.
    #[error("cache: {0}")]
    Cache(#[from] sqlx::Error),

    /// Response body / headers could not be decoded into the expected shape.
    #[error("decode: {0}")]
    Decode(String),

    /// URL failed `reqwest::Url::parse`.
    #[error("invalid url: {0}")]
    InvalidUrl(String),
}
