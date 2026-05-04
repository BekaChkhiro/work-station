//! App-wide registry of live PTY sessions (T2.3).
//!
//! Held by Tauri as managed state — its lifetime is the app, not any
//! window — so a webview reload never drops the spawned shells (verified
//! by T2.12). Spawning, lookup, and teardown all flow through here.

#![allow(dead_code)] // T2.5 wires this into the Tauri command surface.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, RwLock};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use thiserror::Error;
use uuid::Uuid;

use super::session::PtySession;

#[derive(Debug, Error)]
pub(crate) enum PtyError {
    #[error("cwd does not exist: {0}")]
    CwdMissing(PathBuf),
    #[error("openpty failed: {0}")]
    OpenPty(String),
    #[error("spawn failed: {0}")]
    Spawn(String),
    #[error("take_writer failed: {0}")]
    Writer(String),
    #[error("session not found: {0}")]
    NotFound(Uuid),
    #[error("registry lock poisoned")]
    LockPoisoned,
}

/// Inputs for `PtyManager::spawn`. T2.5 fills these from frontend args.
#[derive(Debug, Clone)]
pub(crate) struct SpawnConfig {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

/// Process registry for live PTY sessions.
///
/// Cloning the manager is cheap: it shares the inner `Arc<RwLock<...>>`,
/// which is exactly the handle Tauri's `.manage()` will hand out via
/// `State<PtyManager>`.
#[derive(Default, Clone)]
pub(crate) struct PtyManager {
    inner: Arc<RwLock<HashMap<Uuid, Arc<PtySession>>>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// Spawn a new PTY session and register it. Returns the session id.
    ///
    /// Validation and pty/process setup happen *outside* the registry
    /// lock so a slow spawn never blocks `count` / `list` / `get`.
    pub fn spawn(&self, config: SpawnConfig) -> Result<Uuid, PtyError> {
        if let Some(cwd) = &config.cwd {
            if !cwd.exists() {
                return Err(PtyError::CwdMissing(cwd.clone()));
            }
        }

        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: config.rows,
                cols: config.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::OpenPty(e.to_string()))?;

        let mut cmd = CommandBuilder::new(&config.command);
        for arg in &config.args {
            cmd.arg(arg);
        }
        if let Some(cwd) = &config.cwd {
            cmd.cwd(cwd);
        }
        for (k, v) in &config.env {
            cmd.env(k, v);
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| PtyError::Spawn(e.to_string()))?;

        let writer = pair
            .master
            .take_writer()
            .map_err(|e| PtyError::Writer(e.to_string()))?;

        // Slave fd must be released in the parent so the child sees EOF
        // when its stdio peers close.
        drop(pair.slave);

        let session = Arc::new(PtySession::new(pair.master, writer, child));
        let id = session.id;

        self.inner
            .write()
            .map_err(|_| PtyError::LockPoisoned)?
            .insert(id, session);
        Ok(id)
    }

    pub fn get(&self, id: Uuid) -> Option<Arc<PtySession>> {
        self.inner.read().ok()?.get(&id).cloned()
    }

    /// Remove the session from the registry. The underlying child is
    /// reaped when the last `Arc<PtySession>` is dropped (see
    /// `PtySession::drop`); T2.8 will layer SIGTERM → SIGKILL grace on
    /// top of this.
    ///
    /// The pulled-out `Arc` is dropped *after* the lock is released so a
    /// slow `wait` never blocks other sessions.
    pub fn kill(&self, id: Uuid) -> Result<(), PtyError> {
        let session = self
            .inner
            .write()
            .map_err(|_| PtyError::LockPoisoned)?
            .remove(&id)
            .ok_or(PtyError::NotFound(id))?;
        drop(session);
        Ok(())
    }

    pub fn list(&self) -> Vec<Uuid> {
        self.inner
            .read()
            .map(|m| m.keys().copied().collect())
            .unwrap_or_default()
    }

    pub fn count(&self) -> usize {
        self.inner.read().map_or(0, |m| m.len())
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    fn sleep_config() -> SpawnConfig {
        SpawnConfig {
            command: "/bin/sleep".to_string(),
            args: vec!["60".to_string()],
            cwd: None,
            env: HashMap::new(),
            cols: 80,
            rows: 24,
        }
    }

    #[test]
    fn empty_manager_reports_zero() {
        let m = PtyManager::new();
        assert_eq!(m.count(), 0);
        assert!(m.list().is_empty());
        assert!(m.get(Uuid::new_v4()).is_none());
    }

    #[test]
    fn spawn_registers_session() {
        let m = PtyManager::new();
        let id = m.spawn(sleep_config()).expect("spawn");

        assert_eq!(m.count(), 1);
        assert_eq!(m.list(), vec![id]);

        let session = m.get(id).expect("get");
        assert_eq!(session.id, id);
        assert!(session.pid > 0);

        m.kill(id).expect("kill");
    }

    #[test]
    fn kill_removes_and_reaps() {
        let m = PtyManager::new();
        let id = m.spawn(sleep_config()).expect("spawn");
        let pid = m.get(id).expect("get").pid;

        m.kill(id).expect("kill");
        assert_eq!(m.count(), 0);
        assert!(m.get(id).is_none());

        // The Arc was the only one outstanding, so Drop ran. Allow a
        // beat for the kernel to clear the process table.
        let deadline = Instant::now() + Duration::from_secs(2);
        while Instant::now() < deadline {
            let out = std::process::Command::new("ps")
                .args(["-p", &pid.to_string(), "-o", "stat="])
                .output()
                .expect("ps");
            let line = String::from_utf8_lossy(&out.stdout);
            let stat = line.trim();
            if stat.is_empty() {
                return; // gone
            }
            assert!(
                !stat.starts_with('Z'),
                "child {pid} ended as a zombie: {stat}",
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("child {pid} still tracked by ps after kill");
    }

    #[test]
    fn kill_unknown_returns_not_found() {
        let m = PtyManager::new();
        let unknown = Uuid::new_v4();
        match m.kill(unknown) {
            Err(PtyError::NotFound(id)) => assert_eq!(id, unknown),
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn cwd_missing_is_rejected_without_spawn() {
        let m = PtyManager::new();
        let cfg = SpawnConfig {
            cwd: Some(PathBuf::from("/this/path/should/not/exist/ever-xyz")),
            ..sleep_config()
        };
        match m.spawn(cfg) {
            Err(PtyError::CwdMissing(_)) => {}
            other => panic!("expected CwdMissing, got {other:?}"),
        }
        assert_eq!(m.count(), 0);
    }

    #[test]
    fn manager_clone_shares_state() {
        let m1 = PtyManager::new();
        let m2 = m1.clone();
        let id = m1.spawn(sleep_config()).expect("spawn");

        assert_eq!(m2.count(), 1);
        assert_eq!(m2.list(), vec![id]);
        m2.kill(id).expect("kill via clone");
        assert_eq!(m1.count(), 0);
    }
}
