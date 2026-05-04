//! PTY Tauri commands (T2.5 spawn, T2.6 write, T2.7 resize, T2.8 kill).
//!
//! Validates input from the frontend, forwards to `PtyManager`, and maps
//! crate errors onto Serialize-able enums so the webview can branch on
//! `kind` rather than parse free-form strings.

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
            PtyError::WriteIo(_)
            | PtyError::ResizeIo(_)
            | PtyError::NotFound(_)
            | PtyError::LockPoisoned => Self::Internal(error.to_string()),
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteArgs {
    pub session_id: Uuid,
    pub data: Vec<u8>,
}

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum WriteError {
    #[error("session not found: {0}")]
    NotFound(String),
    #[error("write failed: {0}")]
    WriteFailed(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl From<PtyError> for WriteError {
    fn from(error: PtyError) -> Self {
        match error {
            PtyError::NotFound(id) => Self::NotFound(id.to_string()),
            PtyError::WriteIo(msg) => Self::WriteFailed(msg),
            other => Self::Internal(other.to_string()),
        }
    }
}

#[tauri::command]
pub async fn pty_write(args: WriteArgs, manager: State<'_, PtyManager>) -> Result<(), WriteError> {
    let manager = manager.inner().clone();
    tokio::task::spawn_blocking(move || write_inner(&manager, args))
        .await
        .map_err(|e| WriteError::Internal(format!("blocking task join failed: {e}")))?
}

fn write_inner(manager: &PtyManager, args: WriteArgs) -> Result<(), WriteError> {
    manager.write(args.session_id, &args.data)?;
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ResizeArgs {
    pub session_id: Uuid,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum ResizeError {
    #[error("invalid arguments: {0}")]
    InvalidArgs(String),
    #[error("session not found: {0}")]
    NotFound(String),
    #[error("resize failed: {0}")]
    ResizeFailed(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl From<PtyError> for ResizeError {
    fn from(error: PtyError) -> Self {
        match error {
            PtyError::NotFound(id) => Self::NotFound(id.to_string()),
            PtyError::ResizeIo(msg) => Self::ResizeFailed(msg),
            other => Self::Internal(other.to_string()),
        }
    }
}

#[tauri::command]
pub async fn pty_resize(
    args: ResizeArgs,
    manager: State<'_, PtyManager>,
) -> Result<(), ResizeError> {
    let manager = manager.inner().clone();
    tokio::task::spawn_blocking(move || resize_inner(&manager, args))
        .await
        .map_err(|e| ResizeError::Internal(format!("blocking task join failed: {e}")))?
}

fn resize_inner(manager: &PtyManager, args: ResizeArgs) -> Result<(), ResizeError> {
    if args.cols == 0 || args.rows == 0 {
        return Err(ResizeError::InvalidArgs(
            "cols and rows must be greater than zero".into(),
        ));
    }
    manager.resize(args.session_id, args.cols, args.rows)?;
    Ok(())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KillArgs {
    pub session_id: Uuid,
}

#[derive(Debug, Error, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum KillError {
    #[error("session not found: {0}")]
    NotFound(String),
    #[error("internal error: {0}")]
    Internal(String),
}

impl From<PtyError> for KillError {
    fn from(error: PtyError) -> Self {
        match error {
            PtyError::NotFound(id) => Self::NotFound(id.to_string()),
            other => Self::Internal(other.to_string()),
        }
    }
}

/// Graceful PTY shutdown (T2.8).
///
/// Off-loaded to `spawn_blocking` because the manager's graceful path
/// can sleep up to `KILL_GRACE` (2s) waiting on the child to honour
/// SIGTERM. Repeat calls for the same id resolve to `NotFound` after
/// the first one removes the session.
#[tauri::command]
pub async fn pty_kill(args: KillArgs, manager: State<'_, PtyManager>) -> Result<(), KillError> {
    let manager = manager.inner().clone();
    tokio::task::spawn_blocking(move || kill_inner(&manager, args))
        .await
        .map_err(|e| KillError::Internal(format!("blocking task join failed: {e}")))?
}

fn kill_inner(manager: &PtyManager, args: KillArgs) -> Result<(), KillError> {
    manager.kill(args.session_id)?;
    Ok(())
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

    #[test]
    fn write_unknown_session_returns_not_found() {
        let m = PtyManager::new();
        let err = write_inner(
            &m,
            WriteArgs {
                session_id: Uuid::new_v4(),
                data: b"hello".to_vec(),
            },
        )
        .expect_err("unknown session should fail");
        assert!(matches!(err, WriteError::NotFound(_)));
    }

    #[test]
    fn write_empty_data_is_noop_for_unknown_session() {
        // Empty payloads short-circuit before the registry lookup, so
        // even an unregistered id succeeds — this lets the frontend
        // fire-and-forget zero-byte debounced writes.
        let m = PtyManager::new();
        write_inner(
            &m,
            WriteArgs {
                session_id: Uuid::new_v4(),
                data: vec![],
            },
        )
        .expect("empty write must be a no-op");
    }

    /// Smoke test for T2.6 acceptance: drive `/bin/cat` over the pty,
    /// write ASCII then UTF-8 input, and observe both round-trip back
    /// through the reader's broadcast channel.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn write_round_trips_ascii_and_utf8_via_pty() {
        use tokio::sync::broadcast::error::RecvError;
        use tokio::time::{timeout, Duration};

        async fn await_substring(
            rx: &mut tokio::sync::broadcast::Receiver<bytes::Bytes>,
            needle: &[u8],
        ) -> Vec<u8> {
            let mut combined: Vec<u8> = Vec::new();
            loop {
                match rx.recv().await {
                    Ok(b) => {
                        combined.extend_from_slice(&b);
                        if combined.windows(needle.len()).any(|w| w == needle) {
                            return combined;
                        }
                    }
                    Err(RecvError::Closed) => return combined,
                    Err(RecvError::Lagged(_)) => {}
                }
            }
        }

        let m = PtyManager::new();
        let resp = spawn_inner(m.clone(), args("/bin/cat")).expect("spawn cat");
        let session_id = resp.session_id;
        let mut rx = m
            .get(session_id)
            .expect("get session")
            .output_tx
            .subscribe();

        // ASCII
        let m_w = m.clone();
        tokio::task::spawn_blocking(move || {
            write_inner(
                &m_w,
                WriteArgs {
                    session_id,
                    data: b"hello\n".to_vec(),
                },
            )
            .expect("ascii write");
        })
        .await
        .expect("ascii join");

        let received = timeout(Duration::from_secs(3), await_substring(&mut rx, b"hello"))
            .await
            .expect("ascii round-trip timed out");
        assert!(
            received.windows(5).any(|w| w == b"hello"),
            "ascii bytes missing in {:?}",
            String::from_utf8_lossy(&received),
        );

        // UTF-8 — uses multi-byte sequences (é, en-dash, Greek) to prove
        // the writer doesn't mangle bytes in transit.
        let utf8 = "héllo–αβγ\n".as_bytes().to_vec();
        let needle = "αβγ".as_bytes().to_vec();
        let m_w = m.clone();
        let payload = utf8.clone();
        tokio::task::spawn_blocking(move || {
            write_inner(
                &m_w,
                WriteArgs {
                    session_id,
                    data: payload,
                },
            )
            .expect("utf8 write");
        })
        .await
        .expect("utf8 join");

        let received = timeout(Duration::from_secs(3), await_substring(&mut rx, &needle))
            .await
            .expect("utf8 round-trip timed out");
        let h_e = "hé".as_bytes();
        let dash = "–".as_bytes();
        assert!(
            received.windows(h_e.len()).any(|w| w == h_e),
            "utf8 'hé' missing in {:?}",
            String::from_utf8_lossy(&received),
        );
        assert!(
            received.windows(dash.len()).any(|w| w == dash),
            "utf8 en-dash missing in {:?}",
            String::from_utf8_lossy(&received),
        );

        m.kill(session_id).expect("kill cat");
    }

    #[test]
    fn resize_rejects_zero_dimensions() {
        let m = PtyManager::new();
        let err = resize_inner(
            &m,
            ResizeArgs {
                session_id: Uuid::new_v4(),
                cols: 0,
                rows: 24,
            },
        )
        .expect_err("zero cols should fail");
        assert!(matches!(err, ResizeError::InvalidArgs(_)));
    }

    #[test]
    fn resize_unknown_session_returns_not_found() {
        let m = PtyManager::new();
        let err = resize_inner(
            &m,
            ResizeArgs {
                session_id: Uuid::new_v4(),
                cols: 100,
                rows: 30,
            },
        )
        .expect_err("unknown session should fail");
        assert!(matches!(err, ResizeError::NotFound(_)));
    }

    #[test]
    fn kill_unknown_session_returns_not_found() {
        let m = PtyManager::new();
        let err = kill_inner(
            &m,
            KillArgs {
                session_id: Uuid::new_v4(),
            },
        )
        .expect_err("unknown session should fail");
        assert!(matches!(err, KillError::NotFound(_)));
    }

    /// T2.8 acceptance: `pty_kill` ends the child (no zombie) and
    /// decrements the manager's session count.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn kill_terminates_child_and_decrements_count() {
        use std::time::{Duration, Instant};

        let m = PtyManager::new();
        let mut a = args("/bin/sleep");
        a.args = vec!["60".into()];
        let resp = spawn_inner(m.clone(), a).expect("spawn sleep");
        assert_eq!(m.count(), 1, "session should be registered");
        let pid = m.get(resp.session_id).expect("get session").pid;
        assert!(pid > 0);

        let m_k = m.clone();
        tokio::task::spawn_blocking(move || {
            kill_inner(
                &m_k,
                KillArgs {
                    session_id: resp.session_id,
                },
            )
            .expect("kill");
        })
        .await
        .expect("kill join");

        assert_eq!(m.count(), 0, "kill should decrement manager count");
        assert!(m.get(resp.session_id).is_none());

        // Verify the child is fully reaped (not a zombie). `ps -p` exits
        // 1 once the kernel clears the entry.
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let out = std::process::Command::new("ps")
                .args(["-p", &pid.to_string(), "-o", "stat="])
                .output()
                .expect("ps");
            let stat = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if stat.is_empty() {
                return;
            }
            assert!(
                !stat.starts_with('Z'),
                "child {pid} ended as a zombie: {stat}",
            );
            assert!(
                Instant::now() < deadline,
                "child {pid} still tracked by ps after pty_kill: {stat}",
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }

    /// Calling `pty_kill` twice in a row resolves to `NotFound` on the
    /// second call rather than racing inside the registry.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn kill_twice_returns_not_found_second_time() {
        let m = PtyManager::new();
        let mut a = args("/bin/sleep");
        a.args = vec!["60".into()];
        let resp = spawn_inner(m.clone(), a).expect("spawn sleep");

        let m1 = m.clone();
        let id = resp.session_id;
        tokio::task::spawn_blocking(move || {
            kill_inner(&m1, KillArgs { session_id: id }).expect("first kill");
        })
        .await
        .expect("first kill join");

        let m2 = m.clone();
        let err = tokio::task::spawn_blocking(move || {
            kill_inner(&m2, KillArgs { session_id: id }).expect_err("second kill should fail")
        })
        .await
        .expect("second kill join");
        assert!(matches!(err, KillError::NotFound(_)));
    }

    /// T2.7 acceptance: after resize the child must observe the new
    /// winsize. Drives `/bin/sh` and reads `stty size` before/after.
    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn resize_propagates_to_child_via_stty() {
        use tokio::sync::broadcast::error::RecvError;
        use tokio::time::{timeout, Duration};

        async fn await_substring(
            rx: &mut tokio::sync::broadcast::Receiver<bytes::Bytes>,
            needle: &[u8],
        ) -> Vec<u8> {
            let mut combined: Vec<u8> = Vec::new();
            loop {
                match rx.recv().await {
                    Ok(b) => {
                        combined.extend_from_slice(&b);
                        if combined.windows(needle.len()).any(|w| w == needle) {
                            return combined;
                        }
                    }
                    Err(RecvError::Closed) => return combined,
                    Err(RecvError::Lagged(_)) => {}
                }
            }
        }

        let m = PtyManager::new();
        let resp = spawn_inner(m.clone(), args("/bin/sh")).expect("spawn sh");
        let session_id = resp.session_id;
        let mut rx = m
            .get(session_id)
            .expect("get session")
            .output_tx
            .subscribe();

        // Initial dims: spawn defaults to 80x24 — see `args(...)` helper.
        let m_w = m.clone();
        tokio::task::spawn_blocking(move || {
            write_inner(
                &m_w,
                WriteArgs {
                    session_id,
                    data: b"stty size\n".to_vec(),
                },
            )
            .expect("write stty 1");
        })
        .await
        .expect("join 1");

        let _ = timeout(Duration::from_secs(3), await_substring(&mut rx, b"24 80"))
            .await
            .expect("initial '24 80' not seen from stty");

        // Resize via the command-layer entry point so the validation +
        // error mapping it adds is exercised end-to-end.
        let m_r = m.clone();
        tokio::task::spawn_blocking(move || {
            resize_inner(
                &m_r,
                ResizeArgs {
                    session_id,
                    cols: 120,
                    rows: 40,
                },
            )
            .expect("resize");
        })
        .await
        .expect("resize join");

        let m_w = m.clone();
        tokio::task::spawn_blocking(move || {
            write_inner(
                &m_w,
                WriteArgs {
                    session_id,
                    data: b"stty size\n".to_vec(),
                },
            )
            .expect("write stty 2");
        })
        .await
        .expect("join 2");

        let _ = timeout(Duration::from_secs(3), await_substring(&mut rx, b"40 120"))
            .await
            .expect("post-resize '40 120' not seen from stty");

        m.kill(session_id).expect("kill sh");
    }
}
