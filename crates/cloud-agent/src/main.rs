//! Cloud-agent binary entry point.
//!
//! Boots the daemon scaffold: loads config, sets up tracing, ensures
//! the state directory exists, brings up the axum HTTP + WebSocket
//! listener (T19.21), and parks on a shutdown signal. PTY and project
//! dispatchers slot into the WebSocket handler in follow-up tasks.
//!
//! T19.22 added the `pair` subcommand which manages the persisted
//! pairing token at `<state_dir>/pairing_token`. The daemon path now
//! prefers that file over an ephemeral token when no `auth_token` is
//! pinned in the config, so the agent's bearer survives restarts.

use std::io::{self, Write};
use std::path::Path;
use std::process::ExitCode;

use clap::Parser;
use workstation_core::ws::auth::AuthToken;

mod auto_run;
mod cli;
mod config;
mod db;
mod dispatch;
mod fs;
mod github;
mod logging;
mod pair;
mod planflow_proxy;
mod server;

use cli::{Cli, Command, PairAction};
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

    if let Some(command) = args.command {
        // Subcommands print to stdout and exit — no tracing subscriber
        // needed, the operator is reading the terminal output directly.
        return run_subcommand(command, &config);
    }

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
    let token = match resolve_auth_token(&config) {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(
                state_dir = %config.state_dir.display(),
                error = %e,
                "failed to load or create pairing token",
            );
            return ExitCode::from(1);
        }
    };

    // T19.25 — open the cloud-agent's SQLite database and apply
    // migrations before binding the listener. A migration failure here
    // is a hard error (refuse to boot rather than serve handlers
    // against a schema-incomplete database).
    let pool = match db::open(&config.state_dir).await {
        Ok(p) => p,
        Err(e) => {
            tracing::error!(
                state_dir = %config.state_dir.display(),
                error = %e,
                "failed to open cloud-agent database",
            );
            return ExitCode::from(1);
        }
    };

    // T19.29 — build the PlanFlow proxy state once at boot so the
    // `cached_org_id` survives across PWA reconnects. Cloned per
    // WebSocket connection via the axum `Extension` layer (cheap; the
    // reqwest client + caches are all Arc-shared internally).
    // T19.34 — passes `state_dir` so the proxy can resolve per-project
    // tokens from `<state_dir>/planflow_tokens/<cloud_project_id>`.
    let planflow = planflow_proxy::PlanflowState::new(
        config.planflow_api_token.clone(),
        config.state_dir.clone(),
    );

    // T19.35 Phase D — build the GitHub state once at boot. The token
    // directory lives at `<state_dir>/github_tokens/`. Cloned cheaply
    // (Arc) per WebSocket connection and into the orchestrator. The
    // reqwest::Client is re-used across all GitHub API calls made by the
    // verifying_merge poller so connection pooling benefits apply.
    let github = github::GithubState::new(&config.state_dir);

    // Workspace root for cloud-mode "New Project" flows. Auto-created
    // here so the first create-with-empty-path request doesn't race a
    // bare-filesystem state_dir.
    let projects_root_path = config.resolve_projects_root();
    if let Err(error) = std::fs::create_dir_all(&projects_root_path) {
        tracing::error!(
            projects_root = %projects_root_path.display(),
            error = %error,
            "failed to ensure cloud-agent projects root",
        );
        return ExitCode::from(1);
    }
    let projects_root = dispatch::ProjectsRoot::new(projects_root_path);

    // One PtyManager per daemon. Both the WebSocket dispatch layer and the
    // auto-run orchestrator share this handle so PTYs spawned by the
    // orchestrator are visible to the desktop's `pty_list` request when
    // it reconnects. `PtyManager::clone` is an `Arc` bump — cheap.
    let manager = workstation_core::pty::PtyManager::new();
    let monitor = workstation_core::ws::system_monitor::start(manager.clone());
    let sessions_meta = dispatch::new_session_metadata_store();

    let mut handle = match server::spawn_with_components(
        token,
        pool.clone(),
        manager.clone(),
        monitor,
        planflow.clone(),
        github.clone(),
        projects_root.clone(),
        sessions_meta,
        config.listen,
    )
    .await
    {
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

    // Phase A (T19.35) — spawn the server-side auto-run orchestration
    // loop. The loop ticks every 20 seconds, picks up active queues from
    // the DB, and drives the state machine independently of any desktop
    // connection. The orchestrator shares the same `PtyManager` as the
    // WebSocket layer so the desktop's `pty_list` can surface sessions
    // the orchestrator spawned. The JoinHandle is stored on the server
    // handle so it is aborted cleanly on SIGTERM / SIGINT.
    //
    // Phase D (T19.35) — `github` is also passed so the orchestrator's
    // `verifying_merge` poller can load per-project GitHub tokens and
    // call the GitHub Pulls API directly without any WS round-trip.
    let orch_handle = auto_run::spawn_orchestrator(pool, manager, planflow, github, projects_root);
    server::attach_orchestrator(&mut handle, orch_handle);

    tracing::info!(
        listen = %handle.local_addr,
        "cloud-agent listener ready (auto-run orchestrator active)",
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

/// Dispatch a subcommand. Subcommands run synchronously, print their
/// result to stdout, and exit — they intentionally bypass the tokio
/// runtime and the tracing subscriber so the operator sees clean
/// output suitable for copy/paste.
fn run_subcommand(command: Command, config: &Config) -> ExitCode {
    match command {
        Command::Pair { action } => run_pair(action, config),
    }
}

fn run_pair(action: PairAction, config: &Config) -> ExitCode {
    if let Err(e) = ensure_state_dir(&config.state_dir) {
        eprintln!(
            "[cloud-agent] failed to prepare state dir {}: {}",
            config.state_dir.display(),
            e
        );
        return ExitCode::from(1);
    }

    let token = match action {
        PairAction::Show => match pair::load_or_create_pairing_token(&config.state_dir) {
            Ok(t) => t,
            Err(e) => {
                eprintln!(
                    "[cloud-agent] failed to read pairing token at {}: {}",
                    pair::pairing_token_path(&config.state_dir).display(),
                    e
                );
                return ExitCode::from(1);
            }
        },
        PairAction::Rotate => match pair::rotate_pairing_token(&config.state_dir) {
            Ok(t) => t,
            Err(e) => {
                eprintln!(
                    "[cloud-agent] failed to write pairing token at {}: {}",
                    pair::pairing_token_path(&config.state_dir).display(),
                    e
                );
                return ExitCode::from(1);
            }
        },
    };

    if let Err(e) = print_pair_block(&mut io::stdout(), config, &token, &action) {
        eprintln!("[cloud-agent] failed to print pair block: {e}");
        return ExitCode::from(1);
    }
    ExitCode::SUCCESS
}

/// Render the "URL + token" block the operator pastes into the
/// desktop's Settings → Cloud → Pair form. When `public_url` is unset
/// in the config we print a placeholder so the operator remembers to
/// substitute their own Cloudflare Tunnel hostname.
///
/// Output shape is intentionally line-oriented + free of decoration so
/// `cloud-agent pair show | grep ^Token:` is a sane scripting move.
fn print_pair_block<W: Write>(
    w: &mut W,
    config: &Config,
    token: &str,
    action: &PairAction,
) -> io::Result<()> {
    let action_word = match action {
        PairAction::Show => "current",
        PairAction::Rotate => "rotated",
    };
    let url = config
        .public_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("<set `public_url` in config.toml, or use your Cloudflare Tunnel URL>");

    writeln!(w, "# cloud-agent pairing token ({action_word})")?;
    writeln!(w, "URL:   {url}")?;
    writeln!(w, "Token: {token}")?;
    if matches!(action, PairAction::Rotate) {
        writeln!(w)?;
        writeln!(w, "# Restart the agent to start serving the new token:")?;
        writeln!(w, "#   sudo systemctl restart cloud-agent")?;
    }
    Ok(())
}

/// Resolve the bearer token the WebSocket listener will accept.
///
/// Priority:
///   1. `auth_token` pinned in the TOML config — operator chose to
///      manage the secret via root-owned configuration.
///   2. `<state_dir>/pairing_token` — created on first boot and
///      preserved across restarts so the bearer is stable without
///      requiring a config edit.
///
/// Errors only when the pairing-token file can't be read or written
/// (e.g. wrong ownership on `state_dir`). The daemon refuses to boot
/// in that case rather than silently falling back to an ephemeral
/// value the operator can't reproduce.
fn resolve_auth_token(config: &Config) -> io::Result<AuthToken> {
    if let Some(pinned) = config
        .auth_token
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        tracing::info!("ws auth token: loaded from config");
        return Ok(AuthToken::new(pinned));
    }

    let token = pair::load_or_create_pairing_token(&config.state_dir)?;
    tracing::info!(
        path = %pair::pairing_token_path(&config.state_dir).display(),
        "ws auth token: loaded from pairing-token file",
    );
    Ok(AuthToken::new(token))
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
    use super::{ensure_state_dir, load_or_default, print_pair_block, resolve_auth_token};
    use crate::cli::PairAction;
    use crate::config::{Config, DEFAULT_LISTEN_ADDR, DEFAULT_LOG_FILTER};
    use std::io::Write;
    use std::path::PathBuf;

    fn cfg_with_state_dir(dir: PathBuf) -> Config {
        Config {
            state_dir: dir,
            ..Config::default()
        }
    }

    #[test]
    fn load_or_default_returns_defaults_when_file_missing() {
        let p = PathBuf::from("/nonexistent/cloud-agent.toml");
        let cfg = load_or_default(&p).unwrap();
        assert_eq!(cfg.listen.to_string(), DEFAULT_LISTEN_ADDR);
        assert_eq!(cfg.log_filter, DEFAULT_LOG_FILTER);
        assert!(cfg.auth_token.is_none());
        assert!(cfg.public_url.is_none());
    }

    #[test]
    fn resolve_auth_token_uses_pinned_value() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = Config {
            auth_token: Some("pinned-value".to_string()),
            state_dir: tmp.path().to_path_buf(),
            ..Config::default()
        };
        let token = resolve_auth_token(&cfg).unwrap();
        assert!(token.matches("pinned-value"));
        // Pinned-in-config path must NOT touch the pairing-token file.
        assert!(!crate::pair::pairing_token_path(tmp.path()).exists());
    }

    #[test]
    fn resolve_auth_token_falls_through_blank_pin_to_file() {
        // Empty or whitespace-only strings must NOT be treated as a
        // valid pinned token — otherwise an operator who comments out
        // the value but leaves `auth_token = ""` would accept the empty
        // string as the bearer.
        let tmp = tempfile::tempdir().unwrap();
        let cfg = Config {
            auth_token: Some("   ".to_string()),
            state_dir: tmp.path().to_path_buf(),
            ..Config::default()
        };
        let token = resolve_auth_token(&cfg).unwrap();
        assert!(!token.matches(""));
        assert!(!token.matches("   "));
        // A pairing-token file should have been created instead.
        assert!(crate::pair::pairing_token_path(tmp.path()).exists());
    }

    #[test]
    fn resolve_auth_token_uses_pairing_file_when_unpinned() {
        let tmp = tempfile::tempdir().unwrap();
        let cfg = cfg_with_state_dir(tmp.path().to_path_buf());
        // First call mints + persists.
        let first = resolve_auth_token(&cfg).unwrap();
        // Second call must read back the same value — proves the
        // daemon's bearer is stable across restarts.
        let second = resolve_auth_token(&cfg).unwrap();
        // We can't read the inner string from outside auth, so probe
        // via `matches` against a sentinel and against each other.
        assert!(!first.matches(""));
        // Use the pair module directly to confirm both runs saw the
        // same on-disk value.
        let on_disk = crate::pair::read_pairing_token(tmp.path())
            .unwrap()
            .unwrap();
        assert!(first.matches(&on_disk));
        assert!(second.matches(&on_disk));
    }

    #[test]
    fn ensure_state_dir_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let nested = tmp.path().join("a/b/c");
        ensure_state_dir(&nested).unwrap();
        ensure_state_dir(&nested).unwrap();
        assert!(nested.is_dir());
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
    fn print_pair_block_includes_url_and_token_for_show() {
        let cfg = Config {
            public_url: Some("wss://agent.example.com".to_string()),
            ..Config::default()
        };
        let mut buf = Vec::new();
        print_pair_block(&mut buf, &cfg, "abc-token", &PairAction::Show).unwrap();
        let out = String::from_utf8(buf).unwrap();
        assert!(out.contains("current"), "expected (current) header: {out}");
        assert!(
            out.contains("wss://agent.example.com"),
            "missing url: {out}"
        );
        assert!(out.contains("Token: abc-token"), "missing token: {out}");
        assert!(!out.contains("rotated"));
        assert!(!out.contains("systemctl restart"));
    }

    #[test]
    fn print_pair_block_includes_restart_hint_for_rotate() {
        let cfg = Config {
            public_url: Some("wss://agent.example.com".to_string()),
            ..Config::default()
        };
        let mut buf = Vec::new();
        print_pair_block(&mut buf, &cfg, "fresh-token", &PairAction::Rotate).unwrap();
        let out = String::from_utf8(buf).unwrap();
        assert!(out.contains("rotated"), "missing (rotated) header: {out}");
        assert!(
            out.contains("systemctl restart cloud-agent"),
            "missing restart hint: {out}"
        );
    }

    #[test]
    fn print_pair_block_falls_back_to_placeholder_url() {
        let cfg = cfg_with_state_dir(PathBuf::from("/tmp/_unused"));
        let mut buf = Vec::new();
        print_pair_block(&mut buf, &cfg, "t", &PairAction::Show).unwrap();
        let out = String::from_utf8(buf).unwrap();
        assert!(
            out.contains("<set `public_url`"),
            "missing placeholder: {out}"
        );
    }

    #[test]
    fn print_pair_block_treats_blank_public_url_as_missing() {
        let cfg = Config {
            public_url: Some("   ".to_string()),
            ..Config::default()
        };
        let mut buf = Vec::new();
        print_pair_block(&mut buf, &cfg, "t", &PairAction::Show).unwrap();
        let out = String::from_utf8(buf).unwrap();
        assert!(
            out.contains("<set `public_url`"),
            "blank public_url must fall through to placeholder: {out}"
        );
    }
}
