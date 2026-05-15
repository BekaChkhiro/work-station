//! Command-line surface for the cloud-agent daemon.
//!
//! Kept minimal on purpose — the daemon is configured through the TOML
//! file (see [`crate::config`]). Flags exist only to point at a
//! non-default config path and to override the on-disk log filter for
//! one-off debugging without editing the file.

use std::path::PathBuf;

use clap::Parser;

/// Default path probed when `--config` is not supplied and
/// `CLOUD_AGENT_CONFIG` is unset. Matches the systemd unit installed
/// by T19.3 (`scripts/cloud-agent-install.sh`).
pub const DEFAULT_CONFIG_PATH: &str = "/etc/cloud-agent/config.toml";

/// Env var that overrides [`DEFAULT_CONFIG_PATH`] when `--config` is
/// not passed. Useful in development where the binary runs out of a
/// `cargo run` instead of systemd.
pub const CONFIG_PATH_ENV: &str = "CLOUD_AGENT_CONFIG";

#[derive(Debug, Parser)]
#[command(
    name = "cloud-agent",
    version,
    about = "Work Station cloud-agent — headless daemon for remote PTY + project state.",
    long_about = None,
)]
pub struct Cli {
    /// Path to the TOML config file. Falls back to `$CLOUD_AGENT_CONFIG`,
    /// then `/etc/cloud-agent/config.toml`.
    #[arg(short, long, value_name = "PATH")]
    pub config: Option<PathBuf>,

    /// Override the tracing filter for this run. Same syntax as
    /// `RUST_LOG` (`info`, `cloud_agent=debug,workstation_core=info`).
    /// Falls through to the value in the config file when omitted.
    #[arg(long, value_name = "FILTER")]
    pub log_filter: Option<String>,

    /// Parse + validate the config and exit without starting the
    /// daemon. Used by the install script and CI smoke tests.
    #[arg(long)]
    pub check_config: bool,
}

impl Cli {
    /// Resolve the config path the user wants, in this priority order:
    /// 1. `--config <path>` on the CLI.
    /// 2. `$CLOUD_AGENT_CONFIG`.
    /// 3. [`DEFAULT_CONFIG_PATH`].
    #[must_use]
    pub fn resolve_config_path(&self) -> PathBuf {
        if let Some(p) = &self.config {
            return p.clone();
        }
        if let Ok(env_path) = std::env::var(CONFIG_PATH_ENV) {
            if !env_path.is_empty() {
                return PathBuf::from(env_path);
            }
        }
        PathBuf::from(DEFAULT_CONFIG_PATH)
    }
}

#[cfg(test)]
mod tests {
    use super::{Cli, CONFIG_PATH_ENV, DEFAULT_CONFIG_PATH};
    use clap::Parser;
    use std::path::PathBuf;

    #[test]
    fn flag_wins_over_env_and_default() {
        let cli = Cli::parse_from(["cloud-agent", "--config", "/tmp/explicit.toml"]);
        assert_eq!(cli.resolve_config_path(), PathBuf::from("/tmp/explicit.toml"));
    }

    #[test]
    fn falls_back_to_default_without_env() {
        let cli = Cli::parse_from(["cloud-agent"]);
        // Scrub the env var so this test is hermetic regardless of the
        // host environment (CI runners sometimes export it).
        // SAFETY: tests run single-threaded per-process via `cargo test`
        // unless `--test-threads` overrides it; the env mutation is
        // confined to this scope.
        let prev = std::env::var(CONFIG_PATH_ENV).ok();
        std::env::remove_var(CONFIG_PATH_ENV);
        assert_eq!(cli.resolve_config_path(), PathBuf::from(DEFAULT_CONFIG_PATH));
        if let Some(v) = prev {
            std::env::set_var(CONFIG_PATH_ENV, v);
        }
    }
}
