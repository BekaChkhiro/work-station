//! Bearer-token auth for the embedded WebSocket server (T18.2).
//!
//! On first launch we mint a 256-bit random token (two concatenated
//! v4 UUID payloads → 32 bytes, base64-url encoded) and persist it as
//! a JSON string under `app_settings.key = 'ws_auth_token'`. The
//! `app_settings` row is the single source of truth — boot rereads it
//! every time so a user can regenerate the token from the Settings UI
//! and the server will pick up the new value on next restart.
//!
//! Browsers can't set arbitrary headers on the WebSocket handshake, so
//! we accept the token via either:
//!
//!   * `Authorization: Bearer <token>` (native clients, fetch-style)
//!   * `?token=<token>` query parameter (browser WebSocket constructor)
//!
//! Both compare with [`subtle::constant_time_eq`]-equivalent semantics
//! (manual byte-length-checked compare; we don't want to pull a crypto
//! crate just for one compare) so a wrong-length token doesn't leak
//! timing.

use std::sync::Arc;

use base64::Engine;
use sqlx::sqlite::SqlitePool;
use sqlx::Row;
use uuid::Uuid;

/// `app_settings.key` under which the WS auth token lives.
pub const WS_AUTH_TOKEN_KEY: &str = "ws_auth_token";

/// Shared, cheaply-cloneable copy of the active token for handlers.
///
/// Wrapping in `Arc<str>` avoids cloning the string on every middleware
/// hit; pointer equality is fine since auth comparisons go through
/// [`AuthToken::matches`].
#[derive(Clone, Debug)]
pub struct AuthToken(Arc<str>);

impl AuthToken {
    pub fn new(value: impl Into<Arc<str>>) -> Self {
        Self(value.into())
    }

    /// Constant-time-ish equality check against a candidate. Returns
    /// false fast on length mismatch (no information leak — wrong
    /// length is already public info via "did you guess right size?")
    /// then walks all bytes regardless of mismatch position.
    pub fn matches(&self, candidate: &str) -> bool {
        let expected = self.0.as_bytes();
        let got = candidate.as_bytes();
        if expected.len() != got.len() {
            return false;
        }
        let mut diff: u8 = 0;
        for (a, b) in expected.iter().zip(got.iter()) {
            diff |= a ^ b;
        }
        diff == 0
    }

    #[cfg(test)]
    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }

    /// Public read accessor used by the QR-pairing command to render the
    /// bearer the PWA must present. Not const-time — callers don't
    /// compare strings, they encode them.
    pub fn as_str_public(&self) -> &str {
        &self.0
    }
}

/// Load the token from `app_settings`, generating + persisting a fresh
/// one if no row exists. Idempotent — the second concurrent caller will
/// either lose the INSERT race and read the winner's value, or win and
/// install their own; both arms return a token the server can serve.
pub async fn load_or_create_token(pool: &SqlitePool) -> Result<AuthToken, sqlx::Error> {
    if let Some(existing) = read_token(pool).await? {
        return Ok(AuthToken::new(existing));
    }

    let fresh = generate_token();
    // JSON-encoded TEXT per the `app_settings` convention from migration
    // 0003 — the desktop frontend assumes every value parses through
    // `JSON.parse`, so we wrap the bare string in JSON quotes.
    let encoded = serde_json::to_string(&fresh).expect("encoding a String to JSON cannot fail");

    let inserted = sqlx::query("INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)")
        .bind(WS_AUTH_TOKEN_KEY)
        .bind(&encoded)
        .execute(pool)
        .await?;

    if inserted.rows_affected() == 0 {
        // Lost the race — read the winner.
        if let Some(existing) = read_token(pool).await? {
            return Ok(AuthToken::new(existing));
        }
    }

    Ok(AuthToken::new(fresh))
}

async fn read_token(pool: &SqlitePool) -> Result<Option<String>, sqlx::Error> {
    let row = sqlx::query("SELECT value FROM app_settings WHERE key = ?")
        .bind(WS_AUTH_TOKEN_KEY)
        .fetch_optional(pool)
        .await?;
    let Some(row) = row else { return Ok(None) };
    let raw: String = row.try_get("value")?;
    // The row is JSON-encoded TEXT (`"<token>"`). Strip the JSON quoting
    // — if the row is malformed (e.g. user hand-edited the DB), treat
    // it as missing so the caller mints a fresh one rather than
    // panicking the server boot.
    match serde_json::from_str::<String>(&raw) {
        Ok(token) if !token.is_empty() => Ok(Some(token)),
        _ => Ok(None),
    }
}

/// Generate a fresh 256-bit token, base64-url-no-pad encoded.
///
/// Two v4 UUIDs concatenated = 32 cryptographically-random bytes
/// (uuid's `v4` feature is backed by `getrandom`), avoiding a separate
/// `rand` dependency.
pub fn generate_token() -> String {
    let mut buf = [0u8; 32];
    buf[..16].copy_from_slice(Uuid::new_v4().as_bytes());
    buf[16..].copy_from_slice(Uuid::new_v4().as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(buf)
}

/// Outcome of inspecting a handshake's auth material.
#[derive(Debug, PartialEq, Eq)]
pub enum AuthResult {
    Ok,
    Missing,
    Mismatch,
}

/// Extract a candidate token from the `Authorization` header or the
/// `?token=` query string and compare it against the expected value.
///
/// Returns the typed verdict; the caller decides how to surface it
/// (axum middleware → 401 close; tests → assertion).
pub fn check_auth(
    expected: &AuthToken,
    auth_header: Option<&str>,
    query_token: Option<&str>,
) -> AuthResult {
    let candidate = auth_header.and_then(parse_bearer).or(query_token);
    match candidate {
        None => AuthResult::Missing,
        Some(token) if expected.matches(token) => AuthResult::Ok,
        Some(_) => AuthResult::Mismatch,
    }
}

fn parse_bearer(header_value: &str) -> Option<&str> {
    let trimmed = header_value.trim();
    let rest = trimmed
        .strip_prefix("Bearer ")
        .or_else(|| trimmed.strip_prefix("bearer "))?;
    let token = rest.trim();
    if token.is_empty() {
        None
    } else {
        Some(token)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_matches_only_with_identical_bytes() {
        let token = AuthToken::new("abc-123");
        assert!(token.matches("abc-123"));
        assert!(!token.matches("abc-124"));
        assert!(!token.matches("abc"));
        assert!(!token.matches(""));
    }

    #[test]
    fn bearer_header_extracts_token() {
        assert_eq!(parse_bearer("Bearer xyz"), Some("xyz"));
        assert_eq!(parse_bearer("bearer xyz"), Some("xyz"));
        assert_eq!(parse_bearer("  Bearer   xyz  "), Some("xyz"));
        assert_eq!(parse_bearer("Token xyz"), None);
        assert_eq!(parse_bearer("Bearer "), None);
        assert_eq!(parse_bearer(""), None);
    }

    #[test]
    fn check_auth_ok_via_header() {
        let token = AuthToken::new("secret");
        assert_eq!(
            check_auth(&token, Some("Bearer secret"), None),
            AuthResult::Ok
        );
    }

    #[test]
    fn check_auth_ok_via_query_param() {
        let token = AuthToken::new("secret");
        assert_eq!(check_auth(&token, None, Some("secret")), AuthResult::Ok);
    }

    #[test]
    fn check_auth_header_takes_precedence_over_query() {
        let token = AuthToken::new("secret");
        // Even a bogus header beats a valid query — explicit is better
        // than implicit. The mismatch surfaces so misconfigured clients
        // get a deterministic 401 instead of an accidental success.
        assert_eq!(
            check_auth(&token, Some("Bearer wrong"), Some("secret")),
            AuthResult::Mismatch
        );
    }

    #[test]
    fn check_auth_missing_when_neither_provided() {
        let token = AuthToken::new("secret");
        assert_eq!(check_auth(&token, None, None), AuthResult::Missing);
    }

    #[test]
    fn check_auth_mismatch_when_token_differs() {
        let token = AuthToken::new("secret");
        assert_eq!(
            check_auth(&token, Some("Bearer wrong"), None),
            AuthResult::Mismatch
        );
    }

    #[test]
    fn generated_tokens_are_unique_and_long_enough() {
        let a = generate_token();
        let b = generate_token();
        assert_ne!(a, b);
        // base64-url-no-pad of 32 bytes = ceil(32 * 4 / 3) = 43 chars.
        assert_eq!(a.len(), 43);
        assert_eq!(b.len(), 43);
    }

    #[tokio::test]
    async fn load_or_create_token_persists_and_reads_back() {
        let pool = sqlx::sqlite::SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("pool");
        sqlx::query(include_str!("../../migrations/0003_app_settings.sql"))
            .execute(&pool)
            .await
            .expect("apply migration");

        let first = load_or_create_token(&pool).await.expect("create");
        let second = load_or_create_token(&pool).await.expect("read");
        assert_eq!(first.as_str(), second.as_str());
        assert_eq!(first.as_str().len(), 43);
    }
}
