//! T11.4: Generic HTTP client + cache layer for third-party integrations
//! (GitHub, Vercel, Neon, Railway, …).
//!
//! Acceptance criteria from `PROJECT_PLAN.md`:
//!   * 503 retried 3× with exponential backoff
//!   * 429 surfaces a typed [`HttpError::RateLimit`] (never auto-retried —
//!     the caller picks its own back-off)
//!   * same endpoint within a TTL returns the cached result
//!
//! ## Design choices
//!
//! * **Lives in Rust, not the renderer.** T11.2 stores integration tokens in
//!   the OS keychain via Rust; pulling them into JS just to do the request
//!   would round-trip secrets through the bundle. Frontend access lands as
//!   focused Tauri commands in T11.6+ — this module exposes the underlying
//!   library only.
//! * **`reqwest` over `tauri-plugin-http`.** We need an async client we can
//!   call from arbitrary Rust modules (e.g. an offline retry queue worker
//!   in T11.9), not one bound to a `tauri::AppHandle`.
//! * **Cache in `SQLite`** (`http_cache` table, migration 0005). Reuses the
//!   preloaded pool, gets `VACUUM INTO` backups for free (T3.10), and is
//!   trivially inspectable in dev. See `cache.rs`.
//! * **Retry policy** is a value type (`RetryPolicy`) so individual call
//!   sites can override the default if a service has different SLAs.
//! * **Cache key** = `METHOD|URL|auth-fingerprint`. The fingerprint is a
//!   stable hash of the auth header, so a token rotation invalidates the
//!   per-token cache without touching anyone else's entries.

pub mod cache;
pub mod error;
pub mod retry;

use std::collections::{BTreeMap, HashMap};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use reqwest::header::AUTHORIZATION;
use sqlx::sqlite::SqlitePool;

pub use cache::Cache;
pub use error::HttpError;
pub use retry::RetryPolicy;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
    Put,
    Patch,
    Delete,
}

impl Method {
    fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
            Self::Put => "PUT",
            Self::Patch => "PATCH",
            Self::Delete => "DELETE",
        }
    }

    fn to_reqwest(self) -> reqwest::Method {
        match self {
            Self::Get => reqwest::Method::GET,
            Self::Post => reqwest::Method::POST,
            Self::Put => reqwest::Method::PUT,
            Self::Patch => reqwest::Method::PATCH,
            Self::Delete => reqwest::Method::DELETE,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ClientConfig {
    pub timeout: Duration,
    pub retry: RetryPolicy,
    pub user_agent: String,
}

impl Default for ClientConfig {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(30),
            retry: RetryPolicy::default(),
            user_agent: format!("work-station/{}", env!("CARGO_PKG_VERSION")),
        }
    }
}

/// Cheaply cloneable — `reqwest::Client` and `SqlitePool` are both
/// internally `Arc`'d, so cloning is just a few ref-count bumps. Callers
/// store one instance per app and clone freely into command handlers.
#[derive(Clone)]
pub struct Client {
    inner: reqwest::Client,
    cache: Cache,
    config: ClientConfig,
}

impl Client {
    pub fn new(pool: SqlitePool, config: ClientConfig) -> Result<Self, HttpError> {
        let inner = reqwest::Client::builder()
            .timeout(config.timeout)
            .user_agent(&config.user_agent)
            .build()
            .map_err(|e| HttpError::Network(e.to_string()))?;
        Ok(Self {
            inner,
            cache: Cache::new(pool),
            config,
        })
    }

    pub fn cache(&self) -> &Cache {
        &self.cache
    }

    pub fn config(&self) -> &ClientConfig {
        &self.config
    }

    pub fn get(&self, url: impl Into<String>) -> RequestBuilder<'_> {
        self.request(Method::Get, url)
    }

    pub fn post(&self, url: impl Into<String>) -> RequestBuilder<'_> {
        self.request(Method::Post, url)
    }

    pub fn put(&self, url: impl Into<String>) -> RequestBuilder<'_> {
        self.request(Method::Put, url)
    }

    pub fn patch(&self, url: impl Into<String>) -> RequestBuilder<'_> {
        self.request(Method::Patch, url)
    }

    pub fn delete(&self, url: impl Into<String>) -> RequestBuilder<'_> {
        self.request(Method::Delete, url)
    }

    pub fn request(&self, method: Method, url: impl Into<String>) -> RequestBuilder<'_> {
        RequestBuilder {
            client: self,
            method,
            url: url.into(),
            service: String::from("default"),
            auth: None,
            headers: BTreeMap::new(),
            body: None,
            cache_ttl: None,
        }
    }
}

pub struct RequestBuilder<'a> {
    client: &'a Client,
    method: Method,
    url: String,
    service: String,
    auth: Option<String>,
    headers: BTreeMap<String, String>,
    body: Option<Vec<u8>>,
    cache_ttl: Option<Duration>,
}

impl RequestBuilder<'_> {
    /// Tag the request with the service name (e.g. `"github"`). Used as the
    /// cache row's `service` column so [`Cache::purge_service`] can wipe a
    /// single integration's entries without touching the rest.
    pub fn service(mut self, service: impl Into<String>) -> Self {
        self.service = service.into();
        self
    }

    /// `Authorization: Bearer <token>`. Used by the cache key so different
    /// tokens hitting the same URL don't share entries.
    pub fn bearer(mut self, token: impl Into<String>) -> Self {
        self.auth = Some(format!("Bearer {}", token.into()));
        self
    }

    pub fn header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.insert(name.into(), value.into());
        self
    }

    pub fn body_bytes(mut self, bytes: Vec<u8>) -> Self {
        self.body = Some(bytes);
        self
    }

    /// Opt the request into the response cache. Only applies to GETs and only
    /// caches 2xx responses; setting a TTL on a non-GET is silently ignored.
    pub fn cache_ttl(mut self, ttl: Duration) -> Self {
        self.cache_ttl = Some(ttl);
        self
    }

    pub async fn send(self) -> Result<Response, HttpError> {
        let cacheable = matches!(self.method, Method::Get) && self.cache_ttl.is_some();
        let key = if cacheable {
            Some(cache_key(self.method, &self.url, self.auth.as_deref()))
        } else {
            None
        };

        if let Some(key) = key.as_deref() {
            if let Some(cached) = self.client.cache.get(key).await? {
                tracing::debug!(
                    target: "http",
                    service = self.service,
                    url = self.url,
                    "cache hit"
                );
                return Ok(Response {
                    status: cached.status,
                    headers: cached.headers,
                    body: cached.body,
                    cache_hit: true,
                });
            }
        }

        let response = send_with_retry(self.client, &self).await?;

        if let (Some(key), Some(ttl)) = (key.as_deref(), self.cache_ttl) {
            if (200..300).contains(&response.status) {
                self.client
                    .cache
                    .put(
                        key,
                        &self.service,
                        ttl,
                        response.status,
                        &response.headers,
                        &response.body,
                    )
                    .await?;
            }
        }

        Ok(response)
    }
}

#[derive(Debug, Clone)]
pub struct Response {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
    /// `true` when this response came from the local cache rather than the
    /// network. Cached responses skip retry, header injection, and the
    /// `cache_ttl` write step.
    pub cache_hit: bool,
}

impl Response {
    /// Convenience: parse `body` as JSON. Returns [`HttpError::Decode`] on
    /// malformed bytes so callers don't have to wrap a separate error type.
    pub fn json<T: serde::de::DeserializeOwned>(&self) -> Result<T, HttpError> {
        serde_json::from_slice(&self.body)
            .map_err(|e| HttpError::Decode(format!("response body json: {e}")))
    }
}

async fn send_with_retry(
    client: &Client,
    builder: &RequestBuilder<'_>,
) -> Result<Response, HttpError> {
    let policy = client.config.retry;
    let mut attempt: u32 = 0;
    loop {
        let outcome = send_once(client, builder).await;
        match outcome {
            Ok(resp) => {
                if resp.status == 429 {
                    let retry_after = parse_retry_after(&resp.headers);
                    tracing::warn!(
                        target: "http",
                        service = builder.service,
                        url = builder.url,
                        ?retry_after,
                        "rate limited"
                    );
                    return Err(HttpError::RateLimit { retry_after });
                }
                if (500..600).contains(&resp.status) {
                    if attempt >= policy.max_attempts {
                        return Err(HttpError::Server {
                            status: resp.status,
                            retries: attempt,
                        });
                    }
                    let delay = policy.delay(attempt, jitter_nanos());
                    tracing::warn!(
                        target: "http",
                        service = builder.service,
                        url = builder.url,
                        attempt = attempt + 1,
                        status = resp.status,
                        delay_ms = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
                        "5xx retry"
                    );
                    tokio::time::sleep(delay).await;
                    attempt += 1;
                    continue;
                }
                return Ok(resp);
            }
            Err(err @ (HttpError::Network(_) | HttpError::Timeout(_)))
                if attempt < policy.max_attempts =>
            {
                let delay = policy.delay(attempt, jitter_nanos());
                tracing::warn!(
                    target: "http",
                    service = builder.service,
                    url = builder.url,
                    attempt = attempt + 1,
                    error = %err,
                    delay_ms = u64::try_from(delay.as_millis()).unwrap_or(u64::MAX),
                    "transport retry"
                );
                tokio::time::sleep(delay).await;
                attempt += 1;
            }
            Err(err) => return Err(err),
        }
    }
}

async fn send_once(client: &Client, builder: &RequestBuilder<'_>) -> Result<Response, HttpError> {
    let url = reqwest::Url::parse(&builder.url)
        .map_err(|e| HttpError::InvalidUrl(format!("{}: {e}", builder.url)))?;
    let mut req = client.inner.request(builder.method.to_reqwest(), url);
    if let Some(auth) = &builder.auth {
        req = req.header(AUTHORIZATION, auth);
    }
    for (k, v) in &builder.headers {
        req = req.header(k, v);
    }
    if let Some(body) = &builder.body {
        req = req.body(body.clone());
    }
    let resp = req.send().await.map_err(|e| {
        if e.is_timeout() {
            HttpError::Timeout(client.config.timeout)
        } else {
            HttpError::Network(e.to_string())
        }
    })?;
    let status = resp.status().as_u16();
    let mut headers: HashMap<String, String> = HashMap::with_capacity(resp.headers().len());
    for (k, v) in resp.headers() {
        if let Ok(s) = v.to_str() {
            // HTTP header names are case-insensitive; `reqwest` already
            // returns them lowercased but we normalise defensively so the
            // cache layer sees a stable shape regardless of upstream impls.
            headers.insert(k.as_str().to_ascii_lowercase(), s.to_string());
        }
    }
    let body = resp
        .bytes()
        .await
        .map_err(|e| HttpError::Network(e.to_string()))?
        .to_vec();
    Ok(Response {
        status,
        headers,
        body,
        cache_hit: false,
    })
}

/// `METHOD|URL|<auth-fp>` — `auth-fp` is a 16-hex-char `DefaultHasher`
/// digest of the auth header (or the empty string when unauthenticated).
/// Not a security primitive — just a stable shard key so a token rotation
/// gets a fresh cache namespace without colliding with the prior token.
fn cache_key(method: Method, url: &str, auth: Option<&str>) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    auth.unwrap_or("").hash(&mut hasher);
    let auth_fp = format!("{:016x}", hasher.finish());
    format!("{}|{}|{}", method.as_str(), url, auth_fp)
}

/// Parse the `Retry-After` response header in delta-seconds form
/// (`Retry-After: 30`). HTTP-date form (`Retry-After: Wed, 21 Oct 2026 …`)
/// is intentionally not parsed — none of the integrations we ship for v0.2
/// emit it, and pulling in `httpdate` for an unused branch would be churn.
fn parse_retry_after(headers: &HashMap<String, String>) -> Option<Duration> {
    let raw = headers.get("retry-after")?;
    raw.trim().parse::<u64>().ok().map(Duration::from_secs)
}

fn jitter_nanos() -> u32 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::Executor;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Arc;
    use wiremock::matchers::{header, method, path};
    use wiremock::{Mock, MockServer, Respond, ResponseTemplate};

    async fn fresh_client(retry: RetryPolicy) -> Client {
        let pool = SqlitePoolOptions::new()
            .connect("sqlite::memory:")
            .await
            .expect("open in-memory sqlite");
        pool.execute(include_str!("../../migrations/0005_http_cache.sql"))
            .await
            .expect("apply 0005");
        let config = ClientConfig {
            timeout: Duration::from_secs(2),
            retry,
            user_agent: "work-station-test".into(),
        };
        Client::new(pool, config).expect("build client")
    }

    fn fast_retry() -> RetryPolicy {
        // Tiny base_delay keeps the test suite fast — the schedule we care
        // about (3 retries on 5xx) is unaffected by the absolute timing.
        RetryPolicy {
            max_attempts: 3,
            base_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(20),
        }
    }

    /// Counts hits across attempts. wiremock's built-in `up_to_n_times`
    /// chaining is more verbose than this for the "first N return X, rest
    /// return Y" pattern.
    struct ScriptedResponder {
        responses: Vec<ResponseTemplate>,
        hits: Arc<AtomicU32>,
    }

    impl Respond for ScriptedResponder {
        fn respond(&self, _: &wiremock::Request) -> ResponseTemplate {
            let n = self.hits.fetch_add(1, Ordering::SeqCst) as usize;
            self.responses
                .get(n)
                .cloned()
                .unwrap_or_else(|| self.responses.last().cloned().expect("non-empty script"))
        }
    }

    /// T11.4 acceptance: 503 retried 3× with backoff. We script four 503s
    /// followed by 200, expect the client to make 4 attempts (1 + 3) and
    /// surface `Server { status: 503, retries: 3 }`.
    #[tokio::test]
    async fn five_hundred_three_retries_then_surfaces_server_error() {
        let server = MockServer::start().await;
        let hits = Arc::new(AtomicU32::new(0));
        Mock::given(method("GET"))
            .and(path("/data"))
            .respond_with(ScriptedResponder {
                responses: vec![ResponseTemplate::new(503); 5],
                hits: hits.clone(),
            })
            .mount(&server)
            .await;

        let client = fresh_client(fast_retry()).await;
        let url = format!("{}/data", server.uri());
        let err = client.get(url).send().await.expect_err("must fail");
        match err {
            HttpError::Server { status, retries } => {
                assert_eq!(status, 503);
                assert_eq!(retries, 3, "policy is 3 retries on top of the initial");
            }
            other => panic!("expected Server, got {other:?}"),
        }
        assert_eq!(
            hits.load(Ordering::SeqCst),
            4,
            "1 initial attempt + 3 retries = 4 hits"
        );
    }

    /// 5xx that recovers within the retry budget should return the success
    /// body without surfacing an error.
    #[tokio::test]
    async fn five_xx_recovers_within_retry_budget() {
        let server = MockServer::start().await;
        let hits = Arc::new(AtomicU32::new(0));
        Mock::given(method("GET"))
            .and(path("/data"))
            .respond_with(ScriptedResponder {
                responses: vec![
                    ResponseTemplate::new(503),
                    ResponseTemplate::new(503),
                    ResponseTemplate::new(200).set_body_bytes(b"ok".to_vec()),
                ],
                hits: hits.clone(),
            })
            .mount(&server)
            .await;

        let client = fresh_client(fast_retry()).await;
        let url = format!("{}/data", server.uri());
        let resp = client.get(url).send().await.expect("recovers");
        assert_eq!(resp.status, 200);
        assert_eq!(resp.body, b"ok");
        assert!(!resp.cache_hit);
        assert_eq!(hits.load(Ordering::SeqCst), 3);
    }

    /// T11.4 acceptance: 429 surfaces as a typed `RateLimit` error with the
    /// `Retry-After` value parsed in delta-seconds form. Crucially, 429 is
    /// NEVER auto-retried.
    #[tokio::test]
    async fn four_twenty_nine_surfaces_typed_rate_limit() {
        let server = MockServer::start().await;
        let hits = Arc::new(AtomicU32::new(0));
        Mock::given(method("GET"))
            .and(path("/limited"))
            .respond_with(ScriptedResponder {
                responses: vec![ResponseTemplate::new(429).insert_header("retry-after", "30")],
                hits: hits.clone(),
            })
            .mount(&server)
            .await;

        let client = fresh_client(fast_retry()).await;
        let url = format!("{}/limited", server.uri());
        let err = client.get(url).send().await.expect_err("rate limited");
        match err {
            HttpError::RateLimit { retry_after } => {
                assert_eq!(retry_after, Some(Duration::from_secs(30)));
            }
            other => panic!("expected RateLimit, got {other:?}"),
        }
        assert_eq!(hits.load(Ordering::SeqCst), 1, "429 must NOT auto-retry");
    }

    /// 429 without a `Retry-After` header still surfaces a typed error —
    /// the field is just `None`.
    #[tokio::test]
    async fn four_twenty_nine_without_retry_after_header() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/limited"))
            .respond_with(ResponseTemplate::new(429))
            .mount(&server)
            .await;

        let client = fresh_client(fast_retry()).await;
        let url = format!("{}/limited", server.uri());
        let err = client.get(url).send().await.expect_err("rate limited");
        assert!(matches!(err, HttpError::RateLimit { retry_after: None }));
    }

    /// T11.4 acceptance: same endpoint within TTL returns the cached
    /// result. Verified by hit counter on the upstream — second send must
    /// not reach the server.
    #[tokio::test]
    async fn cache_hit_within_ttl_skips_network() {
        let server = MockServer::start().await;
        let hits = Arc::new(AtomicU32::new(0));
        Mock::given(method("GET"))
            .and(path("/cached"))
            .respond_with(ScriptedResponder {
                responses: vec![ResponseTemplate::new(200).set_body_bytes(b"v1".to_vec())],
                hits: hits.clone(),
            })
            .mount(&server)
            .await;

        let client = fresh_client(fast_retry()).await;
        let url = format!("{}/cached", server.uri());

        let first = client
            .get(url.clone())
            .service("github")
            .cache_ttl(Duration::from_secs(60))
            .send()
            .await
            .expect("first send");
        assert!(!first.cache_hit);
        assert_eq!(first.body, b"v1");

        let second = client
            .get(url.clone())
            .service("github")
            .cache_ttl(Duration::from_secs(60))
            .send()
            .await
            .expect("second send");
        assert!(second.cache_hit, "second call must hit the local cache");
        assert_eq!(second.body, b"v1");

        assert_eq!(
            hits.load(Ordering::SeqCst),
            1,
            "upstream should see exactly one request"
        );
    }

    /// Auth header injection: the bearer token reaches the upstream
    /// untouched, and different tokens hitting the same URL get
    /// independent cache entries (no leak across users / token rotations).
    #[tokio::test]
    async fn bearer_header_is_injected_and_cache_isolates_per_token() {
        let server = MockServer::start().await;
        let hits = Arc::new(AtomicU32::new(0));

        Mock::given(method("GET"))
            .and(path("/me"))
            .and(header("authorization", "Bearer alpha"))
            .respond_with(ScriptedResponder {
                responses: vec![ResponseTemplate::new(200).set_body_bytes(b"alpha".to_vec())],
                hits: hits.clone(),
            })
            .mount(&server)
            .await;

        Mock::given(method("GET"))
            .and(path("/me"))
            .and(header("authorization", "Bearer beta"))
            .respond_with(ScriptedResponder {
                responses: vec![ResponseTemplate::new(200).set_body_bytes(b"beta".to_vec())],
                hits: hits.clone(),
            })
            .mount(&server)
            .await;

        let client = fresh_client(fast_retry()).await;
        let url = format!("{}/me", server.uri());

        let a = client
            .get(url.clone())
            .bearer("alpha")
            .cache_ttl(Duration::from_secs(60))
            .send()
            .await
            .expect("alpha");
        assert_eq!(a.body, b"alpha");

        // Different token → must not see alpha's cached body.
        let b = client
            .get(url.clone())
            .bearer("beta")
            .cache_ttl(Duration::from_secs(60))
            .send()
            .await
            .expect("beta");
        assert!(!b.cache_hit, "different token must not share cache entry");
        assert_eq!(b.body, b"beta");

        // Re-issue alpha — must come from cache, no new upstream hit.
        let a2 = client
            .get(url)
            .bearer("alpha")
            .cache_ttl(Duration::from_secs(60))
            .send()
            .await
            .expect("alpha repeat");
        assert!(a2.cache_hit);
        assert_eq!(a2.body, b"alpha");

        assert_eq!(
            hits.load(Ordering::SeqCst),
            2,
            "exactly one upstream hit per distinct token"
        );
    }

    /// Non-2xx responses must not be cached even when a TTL is set —
    /// otherwise a transient 500 could poison the cache for a full TTL.
    #[tokio::test]
    async fn non_2xx_responses_are_not_cached() {
        let server = MockServer::start().await;
        let hits = Arc::new(AtomicU32::new(0));
        // 4 × 500, then 200 — first send sees Server error after 3 retries.
        // Second send must re-fetch (no cache poisoning) and ride retries
        // again until it reaches the 200.
        Mock::given(method("GET"))
            .and(path("/flaky"))
            .respond_with(ScriptedResponder {
                responses: vec![
                    ResponseTemplate::new(500),
                    ResponseTemplate::new(500),
                    ResponseTemplate::new(500),
                    ResponseTemplate::new(500),
                    ResponseTemplate::new(200).set_body_bytes(b"ok".to_vec()),
                    ResponseTemplate::new(200).set_body_bytes(b"ok".to_vec()),
                ],
                hits: hits.clone(),
            })
            .mount(&server)
            .await;

        let client = fresh_client(fast_retry()).await;
        let url = format!("{}/flaky", server.uri());

        let first = client
            .get(url.clone())
            .cache_ttl(Duration::from_secs(60))
            .send()
            .await;
        assert!(matches!(first, Err(HttpError::Server { status: 500, .. })));

        let second = client
            .get(url)
            .cache_ttl(Duration::from_secs(60))
            .send()
            .await
            .expect("second succeeds");
        assert_eq!(second.status, 200);
        assert!(!second.cache_hit, "no cache poisoning from prior 5xx");
    }
}
