//! `pty_spawn` Tauri command (T2.5).
//!
//! Validates input from the frontend, spawns a child via `PtyManager`,
//! kicks off the per-session reader pipeline (T2.4), and returns the new
//! session id. Errors are mapped to a Serialize-able enum so the webview
//! can branch on `kind` rather than parse free-form strings.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::State;
use thiserror::Error;
use uuid::Uuid;

use crate::pty::{spawn_reader, PtyError, PtyManager, SpawnConfig};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnArgs {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnResponse {
    pub session_id: Uuid,
}

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum SpawnError {
    #[error("invalid arguments: {0}")]
    InvalidArgs(String),
    #[error("cwd does not exist: {0}")]
    CwdMissing(String),
    #[error("spawn failed: {0}")]
    SpawnFailed(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl From<PtyError> for SpawnError {
    fn from(error: PtyError) -> Self {
        match error {
            PtyError::CwdMissing(path) => Self::CwdMissing(path.display().to_string()),
            PtyError::OpenPty(msg) | PtyError::Spawn(msg) | PtyError::Writer(msg) => {
                Self::SpawnFailed(msg)
            }
            PtyError::NotFound(_) | PtyError::LockPoisoned => Self::Internal(error.to_string()),
        }
    }
}

#[tauri::command]
pub async fn pty_spawn(
    args: SpawnArgs,
    manager: State<'_, PtyManager>,
) -> Result<SpawnResponse, SpawnError> {
    let manager = manager.inner().clone();
    tokio::task::spawn_blocking(move || spawn_inner(manager, args))
        .await
        .map_err(|e| SpawnError::Internal(format!("blocking task join failed: {e}")))?
}

fn spawn_inner(manager: PtyManager, args: SpawnArgs) -> Result<SpawnResponse, SpawnError> {
    validate(&args)?;

    let config = SpawnConfig {
        command: args.command,
        args: args.args,
        cwd: args.cwd.map(PathBuf::from),
        env: merge_env_defaults(args.env),
        cols: args.cols,
        rows: args.rows,
    };

    let id = manager.spawn(config)?;
    let session = manager
        .get(id)
        .ok_or_else(|| SpawnError::Internal("spawned session missing from registry".into()))?;
    spawn_reader(manager.clone(), &session);
    Ok(SpawnResponse { session_id: id })
}

fn validate(args: &SpawnArgs) -> Result<(), SpawnError> {
    if args.command.trim().is_empty() {
        return Err(SpawnError::InvalidArgs("command must not be empty".into()));
    }
    if args.cols == 0 || args.rows == 0 {
        return Err(SpawnError::InvalidArgs(
            "cols and rows must be greater than zero".into(),
        ));
    }
    Ok(())
}

/// Layer caller-supplied env on top of PTY-friendly defaults.
///
/// `TERM` and `COLORTERM` are set so colour-aware programs render
/// correctly out of the box; the frontend can still override them by
/// passing the same keys.
fn merge_env_defaults(env: HashMap<String, String>) -> HashMap<String, String> {
    let mut merged = HashMap::with_capacity(env.len() + 2);
    merged.insert("TERM".to_string(), "xterm-256color".to_string());
    merged.insert("COLORTERM".to_string(), "truecolor".to_string());
    merged.extend(env);
    merged
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn args(command: &str) -> SpawnArgs {
        SpawnArgs {
            command: command.to_string(),
            args: vec![],
            cwd: None,
            env: HashMap::new(),
            cols: 80,
            rows: 24,
        }
    }

    #[test]
    fn rejects_empty_command() {
        let m = PtyManager::new();
        let err = spawn_inner(m, args("   ")).expect_err("empty command should fail");
        assert!(matches!(err, SpawnError::InvalidArgs(_)));
    }

    #[test]
    fn rejects_zero_dimensions() {
        let m = PtyManager::new();
        let mut a = args("/bin/sleep");
        a.cols = 0;
        let err = spawn_inner(m, a).expect_err("zero cols should fail");
        assert!(matches!(err, SpawnError::InvalidArgs(_)));
    }

    #[test]
    fn rejects_missing_cwd() {
        let m = PtyManager::new();
        let mut a = args("/bin/sleep");
        a.args = vec!["60".into()];
        a.cwd = Some("/this/path/does/not/exist/ever-xyz".into());
        match spawn_inner(m, a) {
            Err(SpawnError::CwdMissing(_)) => {}
            other => panic!("expected CwdMissing, got {other:?}"),
        }
    }

    #[test]
    fn rejects_unknown_binary() {
        let m = PtyManager::new();
        let a = args("/this/binary/definitely/does/not/exist-xyz");
        match spawn_inner(m, a) {
            Err(SpawnError::SpawnFailed(_)) => {}
            other => panic!("expected SpawnFailed, got {other:?}"),
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn spawn_succeeds_and_registers_session() {
        let m = PtyManager::new();
        let mut a = args("/bin/sleep");
        a.args = vec!["60".into()];
        let resp = spawn_inner(m.clone(), a).expect("spawn");
        assert!(
            m.get(resp.session_id).is_some(),
            "session must be registered"
        );
        m.kill(resp.session_id).expect("kill");
    }

    #[test]
    fn merge_env_provides_defaults() {
        let merged = merge_env_defaults(HashMap::new());
        assert_eq!(
            merged.get("TERM").map(String::as_str),
            Some("xterm-256color")
        );
        assert_eq!(
            merged.get("COLORTERM").map(String::as_str),
            Some("truecolor")
        );
    }

    #[test]
    fn merge_env_keeps_caller_overrides() {
        let mut user = HashMap::new();
        user.insert("TERM".to_string(), "screen-256color".to_string());
        user.insert("CUSTOM".to_string(), "x".to_string());
        let merged = merge_env_defaults(user);
        assert_eq!(
            merged.get("TERM").map(String::as_str),
            Some("screen-256color")
        );
        assert_eq!(merged.get("CUSTOM").map(String::as_str), Some("x"));
        assert_eq!(
            merged.get("COLORTERM").map(String::as_str),
            Some("truecolor")
        );
    }
}
