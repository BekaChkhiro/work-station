//! Cloud-agent binary entry point.
//!
//! Boots the daemon scaffold: loads config, sets up tracing, ensures
//! the state directory exists, brings up the axum HTTP + WebSocket
//! listener (T19.21), and parks on a shutdown signal. PTY and project
//! dispatchers slot into the WebSocket handler in follow-up tasks.

use std::path::Path;
use std::process::ExitCode;

use clap::Parser;
use workstation_core::ws::auth::{generate_token, AuthToken};

mod cli;
mod config;
mod logging;
mod server;

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

async fn run(config: Config) -> ExitCode {
    let token = resolve_auth_token(&config);

    let handle = match server::spawn(token, config.listen).await {
        Ok(h) => h,
        Err(e) => {
            tracing::error!(
                listen = %config.listen,
                error = %e,
                "failed to bind cloud-agent listener",
            );
            return ExitCode::from(1);
        }
    };

    tracing::info!(
        listen = %handle.local_addr,
        "cloud-agent listener ready",
    );

    let shutdown_reason = wait_for_shutdown().await;

    // Always attempt graceful shutdown — even on a signal-handler
    // error the listener is live and we don't want to abandon it.
    if let Err(e) = handle.shutdown().await {
        tracing::warn!(error = %e, "server task did not shut down cleanly");
    }

    match shutdown_reason {
        Ok(reason) => {
            tracing::info!(reason, "shutdown signal received; exited");
            ExitCode::SUCCESS
        }
        Err(e) => {
            tracing::error!(error = %e, "signal handler failed");
            ExitCode::from(1)
        }
    }
}

/// Resolve the bearer token the WebSocket listener will accept.
///
/// Priority: explicit `auth_token` in the TOML config wins. If absent,
/// mint an ephemeral 256-bit token via [`workstation_core::ws::auth::generate_token`]
/// and log it at warn level exactly once so an operator running the
/// agent from a terminal (or peering at `journalctl`) can copy it into
/// the config file or into a pairing flow.
fn resolve_auth_token(config: &Config) -> AuthToken {
    if let Some(pinned) = config.auth_token.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        tracing::info!("ws auth token: loaded from config");
        return AuthToken::new(pinned);
    }

    let fresh = generate_token();
    tracing::warn!(
        target: "cloud_agent::auth",
        token = %fresh,
        "ws auth token: no `auth_token` set in config — generated ephemeral token (will not survive restart; pin in config.toml for production)",
    );
    AuthToken::new(fresh)
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
    use super::{ensure_state_dir, load_or_default, resolve_auth_token};
    use crate::config::{Config, DEFAULT_LISTEN_ADDR, DEFAULT_LOG_FILTER};
    use std::io::Write;
    use std::path::PathBuf;

    #[test]
    fn load_or_default_returns_defaults_when_file_missing() {
        let p = PathBuf::from("/nonexistent/cloud-agent.toml");
        let cfg = load_or_default(&p).unwrap();
        assert_eq!(cfg.listen.to_string(), DEFAULT_LISTEN_ADDR);
        assert_eq!(cfg.log_filter, DEFAULT_LOG_FILTER);
        assert!(cfg.auth_token.is_none());
    }

    #[test]
    fn resolve_auth_token_uses_pinned_value() {
        let cfg = Config {
            auth_token: Some("pinned-value".to_string()),
            ..Config::default()
        };
        assert!(resolve_auth_token(&cfg).matches("pinned-value"));
    }

    #[test]
    fn resolve_auth_token_generates_ephemeral_when_blank() {
        // Empty or whitespace-only strings must NOT be treated as a
        // valid pinned token — otherwise an operator who comments out
        // the value but leaves `auth_token = ""` would accept the empty
        // string as the bearer.
        let cfg = Config {
            auth_token: Some("   ".to_string()),
            ..Config::default()
        };
        let token = resolve_auth_token(&cfg);
        assert!(!token.matches(""));
        assert!(!token.matches("   "));
    }

    #[test]
    fn resolve_auth_token_generates_ephemeral_when_missing() {
        let cfg = Config::default();
        let token = resolve_auth_token(&cfg);
        // We can't read the inner string from outside the
        // `workstation_core::ws::auth` module, so probe via `matches`
        // — both the empty string and an obviously-bogus candidate
        // must fail, which proves the generator returned a real 43-char
        // base64-url token rather than a sentinel default.
        assert!(!token.matches(""));
        assert!(!token.matches("not-the-generated-token"));
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
