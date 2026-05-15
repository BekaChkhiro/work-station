//! Cloud-agent binary entry point (T19.2).
//!
//! This is the scaffold: it loads config, sets up tracing, ensures the
//! state directory exists, and parks on a shutdown signal. The
//! WebSocket listener (T19.7) and PTY plumbing land in follow-up
//! tasks — they slot into [`run`] once the surface is wired.

use std::path::Path;
use std::process::ExitCode;

use clap::Parser;

mod cli;
mod config;
mod logging;

use cli::Cli;
use config::{Config, ConfigError};

fn main() -> ExitCode {
    let args = Cli::parse();
    let config_path = args.resolve_config_path();

    let config = match load_or_default(&config_path) {
        Ok(c) => c,
        Err(e) => {
            // Logging isn't up yet; the config error itself is the
            // signal to operators, so plain stderr is fine.
            eprintln!("[cloud-agent] {e}");
            return ExitCode::from(2);
        }
    };

    let filter = args.log_filter.as_deref().unwrap_or(&config.log_filter);
    logging::init(filter);

    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        config = %config_path.display(),
        listen = %config.listen,
        state_dir = %config.state_dir.display(),
        "cloud-agent starting"
    );

    if args.check_config {
        tracing::info!("--check-config passed; config OK, exiting before runtime start");
        return ExitCode::SUCCESS;
    }

    if let Err(e) = ensure_state_dir(&config.state_dir) {
        tracing::error!(
            state_dir = %config.state_dir.display(),
            error = %e,
            "failed to prepare state directory"
        );
        return ExitCode::from(1);
    }

    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            tracing::error!(error = %e, "failed to build tokio runtime");
            return ExitCode::from(1);
        }
    };

    runtime.block_on(run(config))
}

async fn run(_config: Config) -> ExitCode {
    // T19.7 will replace this stub with the WebSocket RPC listener
    // (auth, PTY bridge, project state). For now the daemon parks on
    // shutdown signals so it can be installed and exercised by the
    // bootstrap script without claiming to do more than it does.
    match wait_for_shutdown().await {
        Ok(reason) => {
            tracing::info!(reason, "shutdown signal received; exiting");
            ExitCode::SUCCESS
        }
        Err(e) => {
            tracing::error!(error = %e, "signal handler failed");
            ExitCode::from(1)
        }
    }
}

#[cfg(unix)]
async fn wait_for_shutdown() -> std::io::Result<&'static str> {
    use tokio::signal::unix::{signal, SignalKind};
    let mut term = signal(SignalKind::terminate())?;
    let mut int = signal(SignalKind::interrupt())?;
    tokio::select! {
        _ = term.recv() => Ok("SIGTERM"),
        _ = int.recv() => Ok("SIGINT"),
    }
}

#[cfg(not(unix))]
async fn wait_for_shutdown() -> std::io::Result<&'static str> {
    tokio::signal::ctrl_c().await?;
    Ok("ctrl_c")
}

/// Load the config file, falling back to [`Config::default`] when the
/// file is missing. Other I/O / parse errors are returned verbatim —
/// the operator should see the precise reason, not a silent default.
fn load_or_default(path: &Path) -> Result<Config, ConfigError> {
    match Config::load(path) {
        Ok(cfg) => Ok(cfg),
        Err(ConfigError::NotFound { path }) => {
            eprintln!(
                "[cloud-agent] config file {} not found; using built-in defaults",
                path.display()
            );
            Ok(Config::default())
        }
        Err(other) => Err(other),
    }
}

fn ensure_state_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)
}

#[cfg(test)]
mod tests {
    use super::{ensure_state_dir, load_or_default};
    use crate::config::{DEFAULT_LISTEN_ADDR, DEFAULT_LOG_FILTER};
    use std::io::Write;
    use std::path::PathBuf;

    #[test]
    fn load_or_default_returns_defaults_when_file_missing() {
        let p = PathBuf::from("/nonexistent/cloud-agent.toml");
        let cfg = load_or_default(&p).unwrap();
        assert_eq!(cfg.listen.to_string(), DEFAULT_LISTEN_ADDR);
        assert_eq!(cfg.log_filter, DEFAULT_LOG_FILTER);
    }

    #[test]
    fn load_or_default_propagates_parse_errors() {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        f.write_all(b"this is = not [valid toml").unwrap();
        let err = load_or_default(f.path()).unwrap_err();
        assert!(
            matches!(err, crate::config::ConfigError::Parse { .. }),
            "got {err:?}"
        );
    }

    #[test]
    fn ensure_state_dir_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let nested = tmp.path().join("a/b/c");
        ensure_state_dir(&nested).unwrap();
        ensure_state_dir(&nested).unwrap();
        assert!(nested.is_dir());
    }
}
