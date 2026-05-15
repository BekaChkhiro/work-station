//! VAPID keypair persistence + accessors (T18.19).
//!
//! The keypair lives in `app_settings.value` under
//! [`super::VAPID_SETTING_KEY`] as a JSON object:
//!
//! ```json
//! {
//!   "private_pem": "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n",
//!   "public_b64":  "BLpd...43 base64-url-no-pad chars..."
//! }
//! ```
//!
//! The private side is PKCS#8 PEM so it can be fed straight into
//! `web_push::VapidSignatureBuilder::from_pem`. The public side is the
//! uncompressed SEC1 encoding (65 bytes, leading `0x04`) of the curve
//! point, base64-url-no-pad encoded — the shape the browser's
//! `pushManager.subscribe({ applicationServerKey })` parameter expects.

use std::sync::Arc;

use base64::Engine;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::pkcs8::{DecodePrivateKey, EncodePrivateKey, LineEnding};
use p256::SecretKey;
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqlitePool;
use sqlx::Row;

use super::VAPID_SETTING_KEY;

#[derive(Debug, thiserror::Error)]
pub enum VapidError {
    #[error("sqlx: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("encode keypair: {0}")]
    Encode(String),
    #[error("decode persisted keypair: {0}")]
    Decode(String),
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredKeys {
    private_pem: String,
    public_b64: String,
}

/// Cheaply-cloneable VAPID keypair. `Arc<str>` avoids repeatedly cloning
/// the PEM string and base64 public key on every push send.
#[derive(Clone)]
pub struct VapidKeys {
    private_pem: Arc<str>,
    public_b64: Arc<str>,
}

impl VapidKeys {
    pub fn private_pem(&self) -> &str {
        &self.private_pem
    }

    pub fn public_b64(&self) -> &str {
        &self.public_b64
    }
}

impl std::fmt::Debug for VapidKeys {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Don't leak the private PEM into logs. Public key is fine —
        // it's literally meant to be shared.
        f.debug_struct("VapidKeys")
            .field("public_b64", &self.public_b64)
            .finish_non_exhaustive()
    }
}

/// Load the persisted VAPID keypair, generating + storing a fresh one
/// on first boot. Idempotent.
pub async fn load_or_create(pool: &SqlitePool) -> Result<VapidKeys, VapidError> {
    if let Some(stored) = read(pool).await? {
        return Ok(VapidKeys {
            private_pem: Arc::from(stored.private_pem),
            public_b64: Arc::from(stored.public_b64),
        });
    }

    let fresh = generate()?;
    let stored = StoredKeys {
        private_pem: fresh.private_pem.to_string(),
        public_b64: fresh.public_b64.to_string(),
    };
    let encoded = serde_json::to_string(&stored)
        .map_err(|e| VapidError::Encode(format!("serialize StoredKeys: {e}")))?;

    let inserted = sqlx::query("INSERT OR IGNORE INTO app_settings (key, value) VALUES (?, ?)")
        .bind(VAPID_SETTING_KEY)
        .bind(&encoded)
        .execute(pool)
        .await?;

    if inserted.rows_affected() == 0 {
        // Lost the race — read the winner.
        if let Some(existing) = read(pool).await? {
            return Ok(VapidKeys {
                private_pem: Arc::from(existing.private_pem),
                public_b64: Arc::from(existing.public_b64),
            });
        }
    }

    Ok(fresh)
}

async fn read(pool: &SqlitePool) -> Result<Option<StoredKeys>, VapidError> {
    let row = sqlx::query("SELECT value FROM app_settings WHERE key = ?")
        .bind(VAPID_SETTING_KEY)
        .fetch_optional(pool)
        .await?;
    let Some(row) = row else { return Ok(None) };
    let raw: String = row.try_get("value")?;
    // The row is JSON TEXT per the `app_settings` convention (migration
    // 0003). Parse it; a malformed row is treated as missing so the
    // caller mints a fresh pair rather than panicking the bridge boot.
    match serde_json::from_str::<StoredKeys>(&raw) {
        Ok(stored) if !stored.private_pem.is_empty() && !stored.public_b64.is_empty() => {
            Ok(Some(stored))
        }
        _ => Ok(None),
    }
}

/// Generate a fresh P-256 keypair and encode it into the stored shape.
pub fn generate() -> Result<VapidKeys, VapidError> {
    let secret = SecretKey::random(&mut OsRng);

    let private_pem = secret
        .to_pkcs8_pem(LineEnding::LF)
        .map_err(|e| VapidError::Encode(format!("pkcs8 pem: {e}")))?;
    // `to_pkcs8_pem` returns a `Zeroizing<String>` — pull the inner
    // string out so we can put it under Arc<str>. The on-disk row in
    // app_settings keeps the key at rest, so the zeroize wrapper buys
    // us nothing here.
    let private_pem: String = private_pem.to_string();

    let public_point = secret.public_key().to_encoded_point(false);
    let public_b64 =
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(public_point.as_bytes());

    Ok(VapidKeys {
        private_pem: Arc::from(private_pem),
        public_b64: Arc::from(public_b64),
    })
}

/// Sanity-check at construction time: round-trip the PEM through
/// `SecretKey::from_pkcs8_pem` so a malformed PEM surfaces here rather
/// than at the first push send.
pub fn parse_pem(pem: &str) -> Result<SecretKey, VapidError> {
    SecretKey::from_pkcs8_pem(pem).map_err(|e| VapidError::Decode(format!("parse pkcs8 pem: {e}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    async fn fresh_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .expect("pool");
        sqlx::query(include_str!(
            "../../../../src-tauri/migrations/0003_app_settings.sql"
        ))
            .execute(&pool)
            .await
            .expect("apply migration");
        pool
    }

    #[test]
    fn generate_produces_valid_pem_and_43_char_public_key() {
        let keys = generate().expect("generate");
        assert!(keys
            .private_pem()
            .starts_with("-----BEGIN PRIVATE KEY-----"));
        // Uncompressed P-256 point = 65 bytes; base64-url-no-pad of 65
        // bytes = ceil(65 * 4 / 3) = 87 chars.
        assert_eq!(keys.public_b64().len(), 87);
        parse_pem(keys.private_pem()).expect("round-trip pem");
    }

    #[tokio::test]
    async fn load_or_create_persists_and_reads_back() {
        let pool = fresh_pool().await;
        let first = load_or_create(&pool).await.expect("create");
        let second = load_or_create(&pool).await.expect("read");
        assert_eq!(first.public_b64(), second.public_b64());
        assert_eq!(first.private_pem(), second.private_pem());
    }
}
