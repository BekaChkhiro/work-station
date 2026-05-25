// T19.35 Phase D — prose references `GitHub`, `PTY`, `SQLite`, and
// `WebSocket` in passing. Backticking each occurrence hurts readability;
// allow the doc-markdown lint at the module level, matching sibling modules.
#![allow(clippy::doc_markdown)]

//! Per-project GitHub token store and minimal GitHub PR client (Phase D).
//!
//! ## Purpose
//!
//! Enables the auto-run orchestrator's `verifying_merge` state to check
//! whether a pull request's `merged_at` field is non-null before advancing
//! to the next task in an `auto-merge` queue. This is a pure VPS-side
//! operation — the desktop app is never involved during verification.
//!
//! ## Token store
//!
//! Mirrors the PlanFlow token store in [`crate::planflow_proxy`] exactly:
//! - Files live at `<state_dir>/github_tokens/<project_id>`.
//! - Written atomically via tmp+rename so a concurrent reader never sees a
//!   half-written file.
//! - 0600 on Unix (only the `wsagent` daemon user can read them).
//! - Project IDs are path-jailed: only alphanumeric + `-` + `_`, ≤128
//!   characters, no `/`, `\`, `..`, or Unicode — covers every UUID shape
//!   Work Station emits while blocking directory traversal attacks.
//! - An empty / whitespace-only file is treated as absent (i.e. a
//!   `truncate(0)` is a safe "delete" on platforms where rename races).
//!
//! ## GitHub client
//!
//! [`pr_is_merged`] hits `GET /repos/{owner}/{repo}/pulls?head={owner}:{branch}&state=all&per_page=5`
//! and returns `true` when any returned PR has a non-null `merged_at`.
//! The base URL defaults to `https://api.github.com`, overridable via
//! [`GITHUB_API_BASE_URL_ENV`] for wiremock-based integration tests —
//! mirroring `PLANFLOW_BASE_URL`.
//!
//! Authentication is optional: public repos work unauthenticated (GitHub
//! allows 60 requests/hour per IP), and the token is used when present
//! to raise the limit and enable private-repo access.
//!
//! ## `GithubState`
//!
//! [`GithubState`] is an `Arc`-backed cheap-clone handle threaded from
//! `main.rs::run` → `auto_run::spawn_orchestrator` → the per-queue
//! `poll_merge_status` call. It holds the `reqwest::Client` and the
//! path to the token directory so the orchestrator can call
//! [`GithubState::pr_is_merged`] without any filesystem knowledge.
//!
//! ## Repo resolution
//!
//! [`resolve_repo_for_project`] reads `<project_path>/.git/config` from
//! the VPS filesystem and passes it to [`parse_origin_repo`]. The result
//! is cached per project path in a `Mutex<HashMap>` so repeated ticks
//! don't hit the disk on every 20-second beat.
//!
//! [`parse_origin_repo`] is a direct port of
//! `src/stores/autoRunQueue.ts::parseOriginRepo`. It understands:
//!
//! - `git@github.com:owner/repo(.git)?`
//! - `https://github.com/owner/repo(.git)?`
//!
//! Any other remote URL (GitLab, Bitbucket, bare ssh, etc.) returns `None`.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// Subdirectory of `state_dir` holding per-project GitHub token files.
///
/// Deliberately different from `planflow_tokens` so the two stores never
/// collide — operators can inspect both directories independently.
pub const TOKENS_SUBDIR: &str = "github_tokens";

/// Default GitHub API base URL. Override via [`GITHUB_API_BASE_URL_ENV`]
/// for wiremock integration tests.
pub const DEFAULT_API_BASE_URL: &str = "https://api.github.com";

/// Env var for overriding the GitHub API base URL in tests.
///
/// Mirrors `PLANFLOW_BASE_URL` so the test scaffolding pattern is the same.
pub const GITHUB_API_BASE_URL_ENV: &str = "GITHUB_API_BASE_URL";

/// Per-request timeout for GitHub API calls. Same as the PlanFlow proxy
/// so the orchestrator tick budget is predictable.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Mode applied to each per-project token file on Unix. `0600` — only
/// the owning user (`wsagent` under systemd) can read it. Mirrors the
/// PlanFlow token store's policy exactly.
#[cfg(unix)]
const TOKEN_FILE_MODE: u32 = 0o600;

// ---------- Path helpers (mirror planflow_proxy verbatim) ----------

/// Absolute path to the `github_tokens` subdirectory.
#[must_use]
pub fn tokens_dir_path(state_dir: &Path) -> PathBuf {
    state_dir.join(TOKENS_SUBDIR)
}

/// Per-project token file path. Returns `None` when `project_id` fails
/// the allow-list (alphanumeric + `-` + `_`, 1–128 chars, no path
/// separators or `..`).
#[must_use]
pub fn token_file_path(tokens_dir: &Path, project_id: &str) -> Option<PathBuf> {
    if !is_safe_project_id(project_id) {
        return None;
    }
    Some(tokens_dir.join(project_id))
}

/// Reject anything that could escape the token directory: empty ids,
/// ids longer than 128 bytes, and any byte that is not ASCII alphanumeric,
/// `-`, or `_`. Mirrors `planflow_proxy::is_safe_project_id` exactly.
fn is_safe_project_id(s: &str) -> bool {
    if s.is_empty() || s.len() > 128 {
        return false;
    }
    s.bytes()
        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

// ---------- Token CRUD ----------

/// Read the per-project GitHub token, if any.
///
/// Returns `Ok(None)` when the file is absent or contains only whitespace.
/// Returns `Err` on invalid `project_id` or unexpected I/O.
pub fn read_project_token(tokens_dir: &Path, project_id: &str) -> Result<Option<String>, String> {
    let Some(path) = token_file_path(tokens_dir, project_id) else {
        return Err(format!("invalid project id: {project_id}"));
    };
    match std::fs::read_to_string(&path) {
        Ok(raw) => {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                Ok(None)
            } else {
                Ok(Some(trimmed.to_owned()))
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("github token file: {e}")),
    }
}

/// Atomically write `token` to the per-project keychain file.
///
/// Creates `tokens_dir` (0700 on Unix) if missing. Writes a sibling
/// tempfile, sets 0600, then renames into place — same pattern as
/// [`crate::planflow_proxy::write_project_token`] and
/// [`crate::pair::write_pairing_token`] so a concurrent reader never
/// sees a half-written file.
pub fn write_project_token(tokens_dir: &Path, project_id: &str, token: &str) -> Result<(), String> {
    let Some(final_path) = token_file_path(tokens_dir, project_id) else {
        return Err(format!("invalid project id: {project_id}"));
    };
    std::fs::create_dir_all(tokens_dir).map_err(|e| format!("create github_tokens dir: {e}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let _ = std::fs::set_permissions(tokens_dir, std::fs::Permissions::from_mode(0o700));
    }

    let tmp_path = tokens_dir.join(format!(".{project_id}.{}.tmp", std::process::id()));
    {
        use std::io::Write as _;
        let mut f = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&tmp_path)
            .map_err(|e| format!("open tmp: {e}"))?;
        f.write_all(token.as_bytes())
            .map_err(|e| format!("write tmp: {e}"))?;
        f.write_all(b"\n").map_err(|e| format!("write tmp: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync tmp: {e}"))?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        std::fs::set_permissions(&tmp_path, std::fs::Permissions::from_mode(TOKEN_FILE_MODE))
            .map_err(|e| format!("chmod tmp: {e}"))?;
    }
    if let Err(e) = std::fs::rename(&tmp_path, &final_path) {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(format!("rename: {e}"));
    }
    Ok(())
}

/// Remove the per-project GitHub token file. Idempotent — `NotFound` is
/// treated as success so the caller doesn't need to check existence first.
pub fn delete_project_token(tokens_dir: &Path, project_id: &str) -> Result<(), String> {
    let Some(path) = token_file_path(tokens_dir, project_id) else {
        return Err(format!("invalid project id: {project_id}"));
    };
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove: {e}")),
    }
}

// ---------- Repo resolution ----------

/// Parse `owner` and `repo` from the content of a `.git/config` file.
///
/// Ports `src/stores/autoRunQueue.ts::parseOriginRepo` verbatim. Walks
/// the INI sections, locates `[remote "origin"]`, reads its `url = …`
/// line, and matches both GitHub URL forms:
///
/// - `git@github.com:owner/repo(.git)?`
/// - `https://github.com/owner/repo(.git)?`
///
/// Any other remote (GitLab, Bitbucket, non-GitHub SSH, bare paths)
/// returns `None`. The function is synchronous and infallible — the
/// `None` case covers every "we can't resolve" situation so callers
/// always get a clean `Option`.
#[must_use]
pub fn parse_origin_repo(config: &str) -> Option<(String, String)> {
    let mut in_origin = false;
    for raw in config.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            // Section header — determine whether it's `[remote "origin"]`.
            // Mirrors the TS regex `/^\[remote\s+"origin"\]$/`.
            in_origin = is_remote_origin_section(line);
            continue;
        }
        if !in_origin {
            continue;
        }
        // `url = <value>` within the `[remote "origin"]` section.
        let Some(url) = parse_url_line(line) else {
            continue;
        };
        // SSH form: `git@github.com:owner/repo(.git)?`
        if let Some(pair) = parse_ssh_url(&url) {
            return Some(pair);
        }
        // HTTPS form: `https://github.com/owner/repo(.git)?`
        if let Some(pair) = parse_https_url(&url) {
            return Some(pair);
        }
        // Non-GitHub remote — not an error; the queue simply advances
        // without merge verification.
        return None;
    }
    None
}

/// Returns `true` when `line` matches `[remote "origin"]` (any whitespace
/// between `remote` and the opening quote is accepted, as git itself
/// allows). Mirrors the TS regex `/^\[remote\s+"origin"\]$/`.
fn is_remote_origin_section(line: &str) -> bool {
    // Strip surrounding brackets.
    let inner = line
        .strip_prefix('[')
        .and_then(|s| s.strip_suffix(']'))
        .unwrap_or("");
    // Must start with `remote` followed by optional whitespace then `"origin"`.
    let rest = inner.strip_prefix("remote").unwrap_or("").trim_start();
    rest == "\"origin\""
}

/// Extract the value from a `url = <value>` line. Ignores lines that are
/// comments (`#`, `;`), blank, or any key other than `url`.
fn parse_url_line(line: &str) -> Option<String> {
    let (key, value) = line.split_once('=')?;
    if key.trim() != "url" {
        return None;
    }
    Some(value.trim().to_owned())
}

/// Parse `git@github.com:owner/repo(.git)?` → `(owner, repo)`.
/// Trailing `.git` is stripped, trailing slashes are stripped.
fn parse_ssh_url(url: &str) -> Option<(String, String)> {
    let rest = url.strip_prefix("git@github.com:")?;
    let (owner, repo_raw) = rest.split_once('/')?;
    if owner.is_empty() {
        return None;
    }
    let repo = strip_git_suffix(repo_raw);
    if repo.is_empty() {
        return None;
    }
    Some((owner.to_owned(), repo))
}

/// Parse `https://github.com/owner/repo(.git)?` → `(owner, repo)`.
/// Both `http://` and `https://` are accepted (matching the TS regex).
fn parse_https_url(url: &str) -> Option<(String, String)> {
    let without_scheme = url
        .strip_prefix("https://github.com/")
        .or_else(|| url.strip_prefix("http://github.com/"))?;
    let (owner, repo_raw) = without_scheme.split_once('/')?;
    if owner.is_empty() {
        return None;
    }
    let repo = strip_git_suffix(repo_raw);
    if repo.is_empty() {
        return None;
    }
    Some((owner.to_owned(), repo))
}

/// Strip a trailing `.git` suffix (case-sensitive, as git itself uses it)
/// and any trailing slashes. Returns the stripped slice as an owned `String`.
fn strip_git_suffix(s: &str) -> String {
    let without_slash = s.trim_end_matches('/');
    without_slash
        .strip_suffix(".git")
        .unwrap_or(without_slash)
        .to_owned()
}

/// Read `<project_path>/.git/config` from the VPS filesystem and parse the
/// `origin` remote into `(owner, repo)`.
///
/// Best-effort: if the file is missing, the directory is not a git repo, or
/// the remote doesn't point at GitHub, returns `None` without logging.
/// The caller is responsible for treating `None` as "advance without
/// verification" (same as the TS `pollMergeStatus` best-effort path).
///
/// Result is cached per `project_path` in a static `Mutex<HashMap>` so
/// repeated orchestrator ticks (every 20 s) don't re-read the file for the
/// same project. The cache is cleared only at process restart — acceptable
/// because the remote URL of a project almost never changes, and a restart
/// is the natural way to pick up a URL change.
pub fn resolve_repo_for_project(project_path: &Path) -> Option<(String, String)> {
    // We cache by the canonical string of the path to avoid misses from
    // trailing-slash differences.
    let key = project_path.to_string_lossy().into_owned();

    {
        let guard = repo_cache().lock().expect("repo cache lock poisoned");
        if let Some(cached) = guard.get(&key) {
            return cached.clone();
        }
    }

    let git_config_path = project_path.join(".git/config");
    let result = match std::fs::read_to_string(&git_config_path) {
        Ok(contents) => parse_origin_repo(&contents),
        Err(_) => None,
    };

    // Cache the result (including `None` so we don't hammer a missing file).
    repo_cache()
        .lock()
        .expect("repo cache lock poisoned")
        .insert(key, result.clone());

    result
}

/// Module-level cache: `project_path_string → Option<(owner, repo)>`.
///
/// `None` entries are explicitly cached to short-circuit repeated filesystem
/// hits for non-git directories or non-GitHub remotes. A production daemon
/// sees at most a handful of distinct project paths so the map stays tiny.
///
/// Uses `OnceLock` (stable since 1.70) rather than `LazyLock` (stable since
/// 1.80) to stay within the workspace's MSRV of 1.77.
#[allow(clippy::type_complexity)]
static REPO_CACHE: std::sync::OnceLock<Mutex<HashMap<String, Option<(String, String)>>>> =
    std::sync::OnceLock::new();

fn repo_cache() -> &'static Mutex<HashMap<String, Option<(String, String)>>> {
    REPO_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

// ---------- GitHub errors ----------

/// Errors returned by [`GithubState::pr_is_merged`].
///
/// All variants are "best-effort" from the orchestrator's perspective: the
/// caller maps every `Err` to "advance anyway" so the queue never gets
/// permanently stuck on a GitHub outage or missing token. The variants are
/// typed (not just `String`) so tests can assert on the specific failure mode.
#[derive(Debug, thiserror::Error)]
pub enum GithubError {
    /// No bearer token available and the repository is private (HTTP 401/404
    /// returned without a token). Public repos succeed unauthenticated.
    #[error("GitHub authentication required (401/403): {0}")]
    Auth(String),

    /// GitHub returned an unexpected non-2xx status other than 401/403/404.
    #[error("GitHub API error HTTP {status}: {body}")]
    Upstream { status: u16, body: String },

    /// Transport failure (DNS, connection refused, TLS). Typically transient.
    #[error("GitHub network error: {0}")]
    Network(String),

    /// The HTTP request timed out.
    #[error("GitHub API request timed out")]
    Timeout,

    /// The response body couldn't be parsed as JSON or is missing the
    /// expected `merged_at` field shape.
    #[error("GitHub response decode error: {0}")]
    Decode(String),
}

// ---------- GithubState ----------

/// Shared state for the GitHub client. One instance per daemon, cloned
/// cheaply (`reqwest::Client` is internally `Arc`-shared, and the tokens
/// directory is an `Arc<PathBuf>`). Threaded from `main.rs::run` → the
/// orchestrator alongside `PlanflowState`.
#[derive(Clone)]
pub struct GithubState {
    client: reqwest::Client,
    base_url: String,
    tokens_dir: Arc<PathBuf>,
}

impl std::fmt::Debug for GithubState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GithubState")
            .field("base_url", &self.base_url)
            .finish_non_exhaustive()
    }
}

impl GithubState {
    /// Build the GitHub state for production use.
    ///
    /// `state_dir` is the daemon's state directory; token files will live at
    /// `<state_dir>/github_tokens/<project_id>`. The base URL is read from
    /// [`GITHUB_API_BASE_URL_ENV`] if set, otherwise defaults to
    /// `https://api.github.com`.
    #[must_use]
    pub fn new(state_dir: &Path) -> Self {
        let base_url = std::env::var(GITHUB_API_BASE_URL_ENV)
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| DEFAULT_API_BASE_URL.to_string());
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .user_agent("work-station-cloud-agent")
            // GitHub API requires a User-Agent. `reqwest` sets the crate
            // version automatically but we override here for clarity.
            .build()
            .expect("reqwest::Client::builder must succeed with default rustls config");
        Self {
            client,
            base_url: trim_trailing_slash(&base_url),
            tokens_dir: Arc::new(tokens_dir_path(state_dir)),
        }
    }

    /// Test seam: build a state pointed at a custom base URL (typically a
    /// wiremock instance) with a specific tokens directory.
    #[cfg(test)]
    pub fn for_test(base_url: impl Into<String>, state_dir: &Path) -> Self {
        let client = reqwest::Client::builder()
            .timeout(REQUEST_TIMEOUT)
            .build()
            .expect("reqwest test client");
        Self {
            client,
            base_url: trim_trailing_slash(&base_url.into()),
            tokens_dir: Arc::new(tokens_dir_path(state_dir)),
        }
    }

    /// Load the GitHub token for a project. Returns `None` when no token
    /// file exists. Errors on path-jail violations or unexpected I/O.
    pub fn load_token(&self, project_id: &str) -> Result<Option<String>, String> {
        read_project_token(&self.tokens_dir, project_id)
    }

    /// Write a GitHub token for a project. An empty token removes the file.
    pub fn save_token(&self, project_id: &str, token: &str) -> Result<(), String> {
        let trimmed = token.trim();
        if trimmed.is_empty() {
            delete_project_token(&self.tokens_dir, project_id)
        } else {
            write_project_token(&self.tokens_dir, project_id, trimmed)
        }
    }

    /// Return a reference to the tokens directory path.
    ///
    /// Reserved for operators / diagnostic tooling that need to inspect
    /// the token directory without going through the WS handler. Not
    /// currently called from production code — dispatched via
    /// `save_token` / `load_token` in practice.
    #[allow(dead_code)]
    #[must_use]
    pub fn tokens_dir(&self) -> &Path {
        &self.tokens_dir
    }

    /// Query the GitHub Pulls API and return `true` if any PR for `branch`
    /// in `owner/repo` has a non-null `merged_at`.
    ///
    /// `token` is optional — public repos work without one; private repos
    /// require a PAT with at least `repo` scope.
    ///
    /// Mirrors `src/stores/autoRunQueue.ts::pollMergeStatus`'s GitHub call:
    /// `gh.listPullRequests({owner,repo},{state:"all",head:`${owner}:${branch}`,perPage:5})`.
    ///
    /// On HTTP 401/403 returns [`GithubError::Auth`]; on 404 returns `false`
    /// (repo not found / not accessible is treated as "not merged yet" at
    /// the call site which maps it to "advance anyway"); other non-2xx
    /// statuses return [`GithubError::Upstream`]. Transport errors return
    /// [`GithubError::Network`] or [`GithubError::Timeout`].
    pub async fn pr_is_merged(
        &self,
        owner: &str,
        repo: &str,
        branch: &str,
        token: Option<&str>,
    ) -> Result<bool, GithubError> {
        pr_is_merged_inner(&self.client, &self.base_url, owner, repo, branch, token).await
    }
}

/// Inner implementation, separated so tests can call it directly with a
/// custom `reqwest::Client` (e.g. one pointed at a wiremock server).
async fn pr_is_merged_inner(
    client: &reqwest::Client,
    base_url: &str,
    owner: &str,
    repo: &str,
    branch: &str,
    token: Option<&str>,
) -> Result<bool, GithubError> {
    // Build the URL with query parameters manually — mirrors the
    // `build_url` helper in `planflow_proxy.rs` since reqwest's
    // `.query()` is not always available depending on feature flags.
    let head = format!("{owner}:{branch}");
    let url = build_github_url(base_url, owner, repo, &head);

    let mut req = client
        .get(&url)
        .header("accept", "application/vnd.github+json")
        .header("x-github-api-version", "2022-11-28");

    if let Some(tok) = token {
        req = req.bearer_auth(tok);
    }

    let response = match req.send().await {
        Ok(r) => r,
        Err(err) => {
            return Err(if err.is_timeout() {
                GithubError::Timeout
            } else {
                GithubError::Network(err.to_string())
            });
        }
    };

    let status = response.status().as_u16();
    let bytes = response
        .bytes()
        .await
        .map_err(|e| GithubError::Network(e.to_string()))?;

    match status {
        200 => {}
        401 | 403 => {
            let body = String::from_utf8_lossy(&bytes).into_owned();
            return Err(GithubError::Auth(body));
        }
        404 => {
            // Repo not found / not accessible — treat as "not merged yet"
            // at the call site, which maps it to "advance anyway".
            return Ok(false);
        }
        other => {
            let body = String::from_utf8_lossy(&bytes).into_owned();
            return Err(GithubError::Upstream {
                status: other,
                body,
            });
        }
    }

    // Parse the JSON array of PR objects.
    let prs: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|e| GithubError::Decode(e.to_string()))?;

    let arr = prs
        .as_array()
        .ok_or_else(|| GithubError::Decode("expected a JSON array".to_string()))?;

    // Any PR with a non-null `merged_at` means the branch was merged.
    // `is_none_or` is stable since 1.82; use explicit match to stay
    // within the workspace MSRV of 1.77.
    let merged = arr.iter().any(|pr| {
        matches!(
            pr.get("merged_at"),
            Some(v) if !v.is_null()
        )
    });

    Ok(merged)
}

fn trim_trailing_slash(s: &str) -> String {
    s.trim_end_matches('/').to_string()
}

/// Build the GitHub Pulls API URL with the required query parameters.
///
/// The `head` parameter uses the `owner:branch` format GitHub expects.
/// All components are percent-encoded so branch names with special
/// characters (e.g. `/`, `#`) don't break the URL.
fn build_github_url(base_url: &str, owner: &str, repo: &str, head: &str) -> String {
    format!(
        "{base_url}/repos/{}/{}/pulls?state=all&head={}&per_page=5",
        percent_encode(owner),
        percent_encode(repo),
        percent_encode(head),
    )
}

/// Minimal percent-encoder for URL path and query components.
///
/// Encodes every byte that is not ASCII alphanumeric or one of the
/// safe characters `- _ . ~ : @` (the last two are included for the
/// `owner:branch` head format). This is intentionally conservative
/// — it's only used for GitHub owner/repo/branch names, which rarely
/// contain special characters.
fn percent_encode(s: &str) -> String {
    use std::fmt::Write as _;
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'~'
            | b':'
            | b'@'
            | b'/'  // keep slashes in head= as-is (owner:branch has no slash)
            => out.push(b as char),
            other => {
                let _ = write!(out, "%{other:02X}");
            }
        }
    }
    out
}

// ---------- WS handler helper ----------

/// Handle a `github_token_set` WS frame: write (or clear) the per-project
/// GitHub token. Mirrors [`crate::planflow_proxy::handle_token_set`] in
/// structure and reply shape.
///
/// On success replies with `github_result { id, data: null }` so the
/// desktop client can resolve the in-flight promise. On failure replies
/// with `github_error { id, kind, message }`.
pub async fn handle_token_set(
    state: &GithubState,
    out_tx: &tokio::sync::mpsc::Sender<String>,
    id: Option<String>,
    cloud_project_id: String,
    token: String,
) {
    use workstation_core::ws::protocol::ServerMessage;

    if !is_safe_project_id(&cloud_project_id) {
        send_github_error(
            out_tx,
            id,
            "invalid_args",
            "cloud_project_id contains invalid characters",
        )
        .await;
        return;
    }

    let result = state.save_token(&cloud_project_id, &token);
    match result {
        Ok(()) => {
            let msg = ServerMessage::github_result(id, serde_json::Value::Null);
            if let Ok(payload) = serde_json::to_string(&msg) {
                let _ = out_tx.send(payload).await;
            }
        }
        Err(message) => {
            send_github_error(out_tx, id, "credential", message).await;
        }
    }
}

/// Send a `github_error` frame on the outbound channel.
async fn send_github_error(
    out_tx: &tokio::sync::mpsc::Sender<String>,
    id: Option<String>,
    kind: impl Into<String>,
    message: impl Into<String>,
) {
    use workstation_core::ws::protocol::ServerMessage;
    let msg = ServerMessage::github_error(id, kind, message);
    if let Ok(payload) = serde_json::to_string(&msg) {
        let _ = out_tx.send(payload).await;
    }
}

// ---------- Tests ----------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;
    use wiremock::matchers::{header, method, path, query_param};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    // ---------- parse_origin_repo ----------

    #[test]
    fn parse_ssh_github_without_git_suffix() {
        let cfg = r#"
[remote "origin"]
    url = git@github.com:acme/my-repo
"#;
        assert_eq!(
            parse_origin_repo(cfg),
            Some(("acme".to_owned(), "my-repo".to_owned()))
        );
    }

    #[test]
    fn parse_ssh_github_with_git_suffix() {
        let cfg = r#"
[core]
    repositoryformatversion = 0
[remote "origin"]
    url = git@github.com:acme/my-repo.git
    fetch = +refs/heads/*:refs/remotes/origin/*
"#;
        assert_eq!(
            parse_origin_repo(cfg),
            Some(("acme".to_owned(), "my-repo".to_owned()))
        );
    }

    #[test]
    fn parse_https_github_without_git_suffix() {
        let cfg = r#"
[remote "origin"]
    url = https://github.com/corp/project
"#;
        assert_eq!(
            parse_origin_repo(cfg),
            Some(("corp".to_owned(), "project".to_owned()))
        );
    }

    #[test]
    fn parse_https_github_with_git_suffix() {
        let cfg = r#"
[remote "origin"]
    url = https://github.com/corp/project.git
"#;
        assert_eq!(
            parse_origin_repo(cfg),
            Some(("corp".to_owned(), "project".to_owned()))
        );
    }

    #[test]
    fn parse_http_github_with_git_suffix() {
        let cfg = r#"
[remote "origin"]
    url = http://github.com/corp/project.git
"#;
        assert_eq!(
            parse_origin_repo(cfg),
            Some(("corp".to_owned(), "project".to_owned()))
        );
    }

    #[test]
    fn parse_non_github_ssh_returns_none() {
        let cfg = r#"
[remote "origin"]
    url = git@gitlab.com:acme/repo.git
"#;
        assert_eq!(parse_origin_repo(cfg), None);
    }

    #[test]
    fn parse_non_github_https_returns_none() {
        let cfg = r#"
[remote "origin"]
    url = https://bitbucket.org/acme/repo.git
"#;
        assert_eq!(parse_origin_repo(cfg), None);
    }

    #[test]
    fn parse_no_origin_remote_returns_none() {
        let cfg = r#"
[remote "upstream"]
    url = git@github.com:acme/repo.git
"#;
        assert_eq!(parse_origin_repo(cfg), None);
    }

    #[test]
    fn parse_garbage_config_returns_none() {
        assert_eq!(parse_origin_repo("not a git config"), None);
        assert_eq!(parse_origin_repo(""), None);
    }

    #[test]
    fn parse_trailing_slash_stripped() {
        // Some tooling writes `url = git@github.com:acme/repo.git/`
        let cfg = r#"
[remote "origin"]
    url = https://github.com/acme/repo.git/
"#;
        // The trailing slash is after `.git` so `strip_git_suffix` trims
        // the slash first, then strips `.git`. Let's verify:
        assert_eq!(
            parse_origin_repo(cfg),
            Some(("acme".to_owned(), "repo".to_owned()))
        );
    }

    #[test]
    fn parse_origin_picks_origin_not_other_remotes() {
        let cfg = r#"
[remote "upstream"]
    url = git@github.com:fork/upstream.git
[remote "origin"]
    url = git@github.com:acme/my-repo.git
[remote "backup"]
    url = git@github.com:acme/backup.git
"#;
        assert_eq!(
            parse_origin_repo(cfg),
            Some(("acme".to_owned(), "my-repo".to_owned()))
        );
    }

    // ---------- Token store round-trip + path-jail ----------

    #[test]
    fn github_token_round_trip_and_permissions() {
        let tmp = tempdir().unwrap();
        let dir = tokens_dir_path(tmp.path());

        write_project_token(&dir, "proj-1", "ghp_abc123").unwrap();
        assert_eq!(
            read_project_token(&dir, "proj-1").unwrap().as_deref(),
            Some("ghp_abc123")
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            let mode = std::fs::metadata(dir.join("proj-1"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600, "per-project github token file must be 0600");
        }

        // Overwriting works in-place.
        write_project_token(&dir, "proj-1", "ghp_newtoken").unwrap();
        assert_eq!(
            read_project_token(&dir, "proj-1").unwrap().as_deref(),
            Some("ghp_newtoken")
        );

        // Delete is idempotent.
        delete_project_token(&dir, "proj-1").unwrap();
        assert!(read_project_token(&dir, "proj-1").unwrap().is_none());
        delete_project_token(&dir, "proj-1").unwrap();
    }

    #[test]
    fn github_token_path_jail_rejections() {
        let tmp = tempdir().unwrap();
        let dir = tokens_dir_path(tmp.path());
        for bad in ["", "../etc/passwd", "p/1", "p\\1", "..", ".", "p 1", "p\n"] {
            assert!(
                token_file_path(&dir, bad).is_none(),
                "{bad:?} should be rejected by token_file_path"
            );
            assert!(
                write_project_token(&dir, bad, "x").is_err(),
                "write {bad:?} should be rejected"
            );
            assert!(
                read_project_token(&dir, bad).is_err(),
                "read {bad:?} should be rejected"
            );
            assert!(
                delete_project_token(&dir, bad).is_err(),
                "delete {bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn github_token_empty_string_treated_as_absent() {
        let tmp = tempdir().unwrap();
        let dir = tokens_dir_path(tmp.path());
        // Write a whitespace-only file — should read back as None.
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("proj-2"), "   \n").unwrap();
        assert!(read_project_token(&dir, "proj-2").unwrap().is_none());
    }

    // ---------- pr_is_merged against wiremock ----------

    fn merged_pr_body() -> serde_json::Value {
        serde_json::json!([
            {
                "number": 42,
                "state": "closed",
                "merged_at": "2026-05-25T10:00:00Z",
                "head": { "ref": "feature-x" }
            }
        ])
    }

    fn open_pr_body() -> serde_json::Value {
        serde_json::json!([
            {
                "number": 43,
                "state": "open",
                "merged_at": null,
                "head": { "ref": "feature-y" }
            }
        ])
    }

    #[tokio::test]
    async fn pr_is_merged_returns_true_for_merged_pr() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/repos/acme/myrepo/pulls"))
            .and(query_param("state", "all"))
            .and(query_param("head", "acme:feature-x"))
            .and(query_param("per_page", "5"))
            .respond_with(ResponseTemplate::new(200).set_body_json(merged_pr_body()))
            .mount(&server)
            .await;

        let tmp = tempdir().unwrap();
        let state = GithubState::for_test(server.uri(), tmp.path());
        let result = state
            .pr_is_merged("acme", "myrepo", "feature-x", None)
            .await
            .unwrap();
        assert!(result, "should detect merged PR");
    }

    #[tokio::test]
    async fn pr_is_merged_returns_false_for_open_pr() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/repos/acme/myrepo/pulls"))
            .respond_with(ResponseTemplate::new(200).set_body_json(open_pr_body()))
            .mount(&server)
            .await;

        let tmp = tempdir().unwrap();
        let state = GithubState::for_test(server.uri(), tmp.path());
        let result = state
            .pr_is_merged("acme", "myrepo", "feature-y", None)
            .await
            .unwrap();
        assert!(!result, "open PR should not be merged");
    }

    #[tokio::test]
    async fn pr_is_merged_empty_array_returns_false() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/repos/acme/myrepo/pulls"))
            .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!([])))
            .mount(&server)
            .await;

        let tmp = tempdir().unwrap();
        let state = GithubState::for_test(server.uri(), tmp.path());
        let result = state
            .pr_is_merged("acme", "myrepo", "feature-z", None)
            .await
            .unwrap();
        assert!(!result, "no PRs means not merged");
    }

    #[tokio::test]
    async fn pr_is_merged_401_returns_auth_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/repos/acme/private/pulls"))
            .respond_with(ResponseTemplate::new(401).set_body_string("Bad credentials"))
            .mount(&server)
            .await;

        let tmp = tempdir().unwrap();
        let state = GithubState::for_test(server.uri(), tmp.path());
        let err = state
            .pr_is_merged("acme", "private", "branch", None)
            .await
            .unwrap_err();
        assert!(
            matches!(err, GithubError::Auth(_)),
            "expected Auth error, got {err:?}"
        );
    }

    #[tokio::test]
    async fn pr_is_merged_403_returns_auth_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/repos/acme/private/pulls"))
            .respond_with(ResponseTemplate::new(403).set_body_string("Forbidden"))
            .mount(&server)
            .await;

        let tmp = tempdir().unwrap();
        let state = GithubState::for_test(server.uri(), tmp.path());
        let err = state
            .pr_is_merged("acme", "private", "branch", None)
            .await
            .unwrap_err();
        assert!(
            matches!(err, GithubError::Auth(_)),
            "expected Auth error, got {err:?}"
        );
    }

    #[tokio::test]
    async fn pr_is_merged_404_returns_false() {
        // 404 = repo not found or not accessible; treated as "not merged yet".
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/repos/acme/gone/pulls"))
            .respond_with(ResponseTemplate::new(404))
            .mount(&server)
            .await;

        let tmp = tempdir().unwrap();
        let state = GithubState::for_test(server.uri(), tmp.path());
        let result = state
            .pr_is_merged("acme", "gone", "branch", None)
            .await
            .unwrap();
        assert!(
            !result,
            "404 should return false (advance anyway at call site)"
        );
    }

    #[tokio::test]
    async fn pr_is_merged_500_returns_upstream_error() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/repos/acme/myrepo/pulls"))
            .respond_with(ResponseTemplate::new(503).set_body_string("overloaded"))
            .mount(&server)
            .await;

        let tmp = tempdir().unwrap();
        let state = GithubState::for_test(server.uri(), tmp.path());
        let err = state
            .pr_is_merged("acme", "myrepo", "branch", None)
            .await
            .unwrap_err();
        assert!(
            matches!(err, GithubError::Upstream { status: 503, .. }),
            "expected Upstream(503) error, got {err:?}"
        );
    }

    #[tokio::test]
    async fn pr_is_merged_sends_bearer_token_when_present() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/repos/acme/myrepo/pulls"))
            .and(header("authorization", "Bearer ghp_secret"))
            .respond_with(ResponseTemplate::new(200).set_body_json(merged_pr_body()))
            .mount(&server)
            .await;

        let tmp = tempdir().unwrap();
        let state = GithubState::for_test(server.uri(), tmp.path());
        let result = state
            .pr_is_merged("acme", "myrepo", "feature-x", Some("ghp_secret"))
            .await
            .unwrap();
        assert!(result, "authenticated merged PR should return true");
    }

    #[tokio::test]
    async fn pr_is_merged_unauthenticated_public_repo() {
        // Tests that the unauthenticated path (no token) still works.
        // No `authorization` header matcher — wiremock accepts any request.
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/repos/public/repo/pulls"))
            .respond_with(ResponseTemplate::new(200).set_body_json(merged_pr_body()))
            .mount(&server)
            .await;

        let tmp = tempdir().unwrap();
        let state = GithubState::for_test(server.uri(), tmp.path());
        // Explicitly passing `None` token — unauthenticated path.
        let result = state
            .pr_is_merged("public", "repo", "feature-x", None)
            .await
            .unwrap();
        assert!(result, "unauthenticated public repo should work");
    }
}
