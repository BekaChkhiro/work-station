//! TOML config for the cloud-agent daemon.
//!
//! The config file is the single source of truth for listen address,
//! state directory, and log filter. Fields are optional so a freshly
//! installed agent works with an almost-empty file; defaults come from
//! [`Config::default`] (or the per-field `Default` impls).
//!
//! Loaded via [`Config::load`]. Errors are typed (see [`ConfigError`])
//! so the binary can surface a precise message to systemd / journald
//! rather than a stringified `io::Error`.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use thiserror::Error;

/// Default listen address. The agent binds to loopback because
/// inbound traffic arrives via Cloudflare Tunnel (see
/// `docs/cloud-agent-vps.md` §3) — no public port is opened.
pub const DEFAULT_LISTEN_ADDR: &str = "127.0.0.1:7420";

/// Default on-disk state directory. Created and chowned to `wsagent`
/// by the bootstrap script (T19.0).
pub const DEFAULT_STATE_DIR: &str = "/var/lib/cloud-agent";

/// Default tracing filter. Matches the desktop binary's default so
/// log lines look familiar between surfaces.
pub const DEFAULT_LOG_FILTER: &str = "info";

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    /// `host:port` the WebSocket listener will bind to. Defaults to
    /// loopback because Cloudflare Tunnel terminates publicly and
    /// forwards locally.
    #[serde(default = "default_listen")]
    pub listen: SocketAddr,

    /// Directory the agent owns at runtime — pairing token, future
    /// `SQLite` project DB, scrollback overflow, etc.
    #[serde(default = "default_state_dir")]
    pub state_dir: PathBuf,

    /// Tracing filter applied when the binary boots. `--log-filter` on
    /// the CLI overrides this for a single run.
    #[serde(default = "default_log_filter")]
    pub log_filter: String,

    /// Bearer token the WebSocket listener accepts on the `/ws`
    /// upgrade (T19.21). Optional in TOML — when absent, the agent
    /// falls back to a persisted pairing token at
    /// `<state_dir>/pairing_token` (created on demand). Pin this in
    /// the config when an operator wants the token under root-only
    /// configuration management rather than the on-disk pairing file.
    #[serde(default)]
    pub auth_token: Option<String>,

    /// T19.22 — public URL the desktop / PWA uses to reach this agent
    /// (typically the Cloudflare Tunnel hostname). Optional: only the
    /// `pair` subcommand consumes it, so it can pre-print the
    /// "URL + token" block an operator pastes into Settings → Cloud.
    /// When omitted, `pair` prints a placeholder so the operator
    /// remembers to substitute their own URL.
    #[serde(default)]
    pub public_url: Option<String>,

    /// T19.29 — `PlanFlow` API token used to proxy `planflow_*`
    /// `WebSocket` requests to `api.planflow.tools`. The desktop bridge
    /// fetches this from the OS keychain, but a headless VPS daemon
    /// has no keychain — so the cloud-agent reads it from either this
    /// config field or the `PLANFLOW_API_TOKEN` environment variable
    /// (env wins, so an operator can rotate the token without a config
    /// edit). Loaded lazily per request, so a rotation takes effect on
    /// the next call. Absent → `planflow_error{kind:"no_credential"}`
    /// per request.
    #[serde(default)]
    pub planflow_api_token: Option<String>,

    /// Filesystem root the agent uses when a `project_create` request
    /// arrives with an empty or relative `path`. The desktop's cloud-
    /// mode "New Project" dialog only collects a name; the agent then
    /// `mkdir -p`s `<projects_root>/<slug-of-name>` so the user doesn't
    /// have to SSH in to lay down the directory first. Absolute paths
    /// in `project_create` keep the strict validate-must-exist
    /// semantics — only auto-creation under this root is opt-in.
    /// Default: `<state_dir>/projects`.
    #[serde(default)]
    pub projects_root: Option<PathBuf>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            listen: default_listen(),
            state_dir: default_state_dir(),
            log_filter: default_log_filter(),
            auth_token: None,
            public_url: None,
            planflow_api_token: None,
            projects_root: None,
        }
    }
}

impl Config {
    /// Resolve the projects-root path, falling back to
    /// `<state_dir>/projects` when the operator hasn't pinned one in
    /// the config file. Centralized here so every call site picks up
    /// the same default.
    #[must_use]
    pub fn resolve_projects_root(&self) -> PathBuf {
        self.projects_root
            .clone()
            .unwrap_or_else(|| self.state_dir.join("projects"))
    }
}

fn default_listen() -> SocketAddr {
    DEFAULT_LISTEN_ADDR
        .parse()
        .expect("DEFAULT_LISTEN_ADDR must be a valid SocketAddr")
}

fn default_state_dir() -> PathBuf {
    PathBuf::from(DEFAULT_STATE_DIR)
}

fn default_log_filter() -> String {
    DEFAULT_LOG_FILTER.to_string()
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("config file {path} not found")]
    NotFound { path: PathBuf },

    #[error("failed to read config file {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },

    #[error("invalid TOML in {path}: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: toml::de::Error,
    },
}

impl Config {
    /// Read and parse a TOML config file. Missing files are reported
    /// as [`ConfigError::NotFound`] so the caller can decide whether
    /// to fall back to defaults (dev) or refuse to boot (prod).
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let raw = match std::fs::read_to_string(path) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Err(ConfigError::NotFound {
                    path: path.to_path_buf(),
                });
            }
            Err(source) => {
                return Err(ConfigError::Read {
                    path: path.to_path_buf(),
                    source,
                });
            }
        };
        toml::from_str::<Config>(&raw).map_err(|source| ConfigError::Parse {
            path: path.to_path_buf(),
            source,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{Config, ConfigError, DEFAULT_LISTEN_ADDR, DEFAULT_LOG_FILTER, DEFAULT_STATE_DIR};
    use std::io::Write;
    use std::path::PathBuf;

    #[test]
    fn defaults_round_trip_when_file_is_empty() {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(b"").unwrap();
        let cfg = Config::load(f.path()).unwrap();
        assert_eq!(cfg.listen.to_string(), DEFAULT_LISTEN_ADDR);
        assert_eq!(cfg.state_dir, PathBuf::from(DEFAULT_STATE_DIR));
        assert_eq!(cfg.log_filter, DEFAULT_LOG_FILTER);
    }

    #[test]
    fn parses_full_config() {
        let toml = r#"
            listen = "0.0.0.0:9000"
            state_dir = "/srv/cloud-agent"
            log_filter = "cloud_agent=debug,info"
            auth_token = "pinned-token-abc"
            public_url = "wss://agent.example.com"
            planflow_api_token = "pf-xyz"
        "#;
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(toml.as_bytes()).unwrap();
        let cfg = Config::load(f.path()).unwrap();
        assert_eq!(cfg.listen.to_string(), "0.0.0.0:9000");
        assert_eq!(cfg.state_dir, PathBuf::from("/srv/cloud-agent"));
        assert_eq!(cfg.log_filter, "cloud_agent=debug,info");
        assert_eq!(cfg.auth_token.as_deref(), Some("pinned-token-abc"));
        assert_eq!(cfg.public_url.as_deref(), Some("wss://agent.example.com"));
        assert_eq!(cfg.planflow_api_token.as_deref(), Some("pf-xyz"));
    }

    #[test]
    fn auth_token_defaults_to_none() {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(b"").unwrap();
        let cfg = Config::load(f.path()).unwrap();
        assert!(cfg.auth_token.is_none());
    }

    #[test]
    fn rejects_unknown_fields() {
        let toml = r#"
            listen = "127.0.0.1:7420"
            something_extra = true
        "#;
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(toml.as_bytes()).unwrap();
        let err = Config::load(f.path()).unwrap_err();
        assert!(matches!(err, ConfigError::Parse { .. }), "got {err:?}");
    }

    #[test]
    fn missing_file_reports_not_found() {
        let p = std::path::PathBuf::from("/nonexistent/cloud-agent.toml");
        let err = Config::load(&p).unwrap_err();
        assert!(matches!(err, ConfigError::NotFound { .. }), "got {err:?}");
    }
}
