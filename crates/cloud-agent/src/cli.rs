//! Command-line surface for the cloud-agent daemon.
//!
//! The default invocation (no subcommand) runs the daemon — flags on
//! the top-level `Cli` point at a non-default config path and override
//! the on-disk log filter for one-off debugging.
//!
//! T19.22 added the `pair` subcommand which manages the persisted
//! pairing token at `<state_dir>/pairing_token`. Operators run it on
//! the VPS (`sudo -u wsagent cloud-agent pair show|rotate`) to obtain
//! or refresh the bearer they paste into Settings → Cloud → Pair.

use std::path::PathBuf;

use clap::{Parser, Subcommand};

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
    #[arg(short, long, value_name = "PATH", global = true)]
    pub config: Option<PathBuf>,

    /// Override the tracing filter for this run. Same syntax as
    /// `RUST_LOG` (`info`, `cloud_agent=debug,workstation_core=info`).
    /// Falls through to the value in the config file when omitted.
    #[arg(long, value_name = "FILTER", global = true)]
    pub log_filter: Option<String>,

    /// Parse + validate the config and exit without starting the
    /// daemon. Used by the install script and CI smoke tests.
    /// Ignored when a subcommand is supplied.
    #[arg(long)]
    pub check_config: bool,

    /// Subcommand to dispatch. When omitted, the binary boots the
    /// daemon (the production path).
    #[command(subcommand)]
    pub command: Option<Command>,
}

/// Top-level subcommands. The default (`None`) path runs the daemon.
#[derive(Debug, Subcommand)]
pub enum Command {
    /// Inspect or rotate the persisted pairing token used to
    /// authenticate desktop / PWA clients on the `/ws` upgrade.
    Pair {
        #[command(subcommand)]
        action: PairAction,
    },
}

/// Actions accepted under `cloud-agent pair`.
#[derive(Debug, Subcommand)]
pub enum PairAction {
    /// Print the current pairing token, creating one if no token has
    /// been persisted yet. Safe to run repeatedly — the value is
    /// stable across calls until `rotate` overwrites it.
    Show,
    /// Generate a fresh pairing token and overwrite the persisted
    /// value. After this returns, the running agent still serves the
    /// previous token until it is restarted (`systemctl restart
    /// cloud-agent`); the printed value is what the desktop should
    /// paste into Settings → Cloud → Pair.
    Rotate,
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
    use super::{Cli, Command, PairAction, CONFIG_PATH_ENV, DEFAULT_CONFIG_PATH};
    use clap::Parser;
    use std::path::PathBuf;

    #[test]
    fn flag_wins_over_env_and_default() {
        let cli = Cli::parse_from(["cloud-agent", "--config", "/tmp/explicit.toml"]);
        assert_eq!(
            cli.resolve_config_path(),
            PathBuf::from("/tmp/explicit.toml")
        );
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
        assert_eq!(
            cli.resolve_config_path(),
            PathBuf::from(DEFAULT_CONFIG_PATH)
        );
        if let Some(v) = prev {
            std::env::set_var(CONFIG_PATH_ENV, v);
        }
    }

    #[test]
    fn bare_invocation_has_no_subcommand() {
        let cli = Cli::parse_from(["cloud-agent"]);
        assert!(cli.command.is_none());
    }

    #[test]
    fn pair_show_parses() {
        let cli = Cli::parse_from(["cloud-agent", "pair", "show"]);
        assert!(matches!(
            cli.command,
            Some(Command::Pair {
                action: PairAction::Show
            })
        ));
    }

    #[test]
    fn pair_rotate_parses() {
        let cli = Cli::parse_from(["cloud-agent", "pair", "rotate"]);
        assert!(matches!(
            cli.command,
            Some(Command::Pair {
                action: PairAction::Rotate
            })
        ));
    }

    #[test]
    fn pair_requires_action() {
        // `cloud-agent pair` with no action must fail parsing — we
        // don't want to silently default to either Show or Rotate.
        let err = Cli::try_parse_from(["cloud-agent", "pair"]).unwrap_err();
        // Clap surfaces a "subcommand required" error; just assert that
        // parsing failed so the exact message can evolve.
        assert!(err.kind() != clap::error::ErrorKind::DisplayHelp);
    }

    #[test]
    fn global_config_flag_works_after_subcommand() {
        // `global = true` means `--config` is accepted both before and
        // after the subcommand. Important for muscle-memory invocations
        // like `cloud-agent pair show --config /path`.
        let cli = Cli::parse_from(["cloud-agent", "pair", "show", "--config", "/tmp/cfg.toml"]);
        assert_eq!(cli.resolve_config_path(), PathBuf::from("/tmp/cfg.toml"));
    }
}
