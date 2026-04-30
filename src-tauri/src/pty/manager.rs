//! PTY session registry.
//!
//! Manages the lifecycle of all PTY sessions. The registry lives for the
//! lifetime of the application, independent of any window.

use std::collections::HashMap;
use std::sync::Arc;

use bytes::Bytes;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tokio::sync::{broadcast, Mutex};
use tokio::task;
use uuid::Uuid;

use super::session::PtySession;

/// Central registry for all active PTY sessions.
///
/// Clones of `PtyManager` share the same underlying registry.
#[derive(Clone)]
pub struct PtyManager {
    sessions: Arc<Mutex<HashMap<Uuid, PtySession>>>,
}

impl PtyManager {
    /// Create a new empty registry.
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Spawn a new PTY session.
    ///
    /// Opens a pseudo-terminal, spawns the given command, and starts a
    /// background reader task that broadcasts output bytes.
    pub async fn spawn(
        &self,
        cwd: &str,
        command: &str,
        env: HashMap<String, String>,
        cols: u16,
        rows: u16,
    ) -> anyhow::Result<Uuid> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut cmd = CommandBuilder::new(command);
        cmd.cwd(cwd);
        for (key, value) in env {
            cmd.env(key, value);
        }

        let child = pair.slave.spawn_command(cmd)?;
        let pid = child.process_id().unwrap_or(0);

        let master = pair.master;
        let reader = master.try_clone_reader()?;
        let writer = master.take_writer()?;

        let (output_tx, _) = broadcast::channel::<Bytes>(1024);
        let output_tx_clone = output_tx.clone();

        // Spawn a background task to read PTY output and broadcast it.
        task::spawn_blocking(move || {
            let mut reader = reader;
            let mut buf = [0u8; 4096];
            loop {
                match std::io::Read::read(&mut reader, &mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let _ = output_tx_clone.send(Bytes::copy_from_slice(&buf[..n]));
                    }
                    Err(_) => break,
                }
            }
        });

        let session = PtySession::new(Uuid::new_v4(), pid, master, child, writer, output_tx);
        let id = self.insert(session).await;
        Ok(id)
    }

    /// Insert a session into the registry and return its ID.
    pub async fn insert(&self, session: PtySession) -> Uuid {
        let id = session.id;
        self.sessions.lock().await.insert(id, session);
        id
    }

    /// Remove a session from the registry.
    ///
    /// Dropping the returned `PtySession` kills the underlying child process.
    pub async fn remove(&self, id: &Uuid) -> Option<PtySession> {
        self.sessions.lock().await.remove(id)
    }

    /// Check whether a session exists in the registry.
    pub async fn contains(&self, id: &Uuid) -> bool {
        self.sessions.lock().await.contains_key(id)
    }

    /// List IDs of all active sessions.
    pub async fn list(&self) -> Vec<Uuid> {
        self.sessions.lock().await.keys().copied().collect()
    }

    /// Write raw bytes to a session's stdin.
    pub async fn write(&self, id: &Uuid, data: &[u8]) -> Option<std::io::Result<()>> {
        let sessions = self.sessions.lock().await;
        let session = sessions.get(id)?;
        Some(session.write(data).await)
    }

    /// Resize a session's PTY.
    pub async fn resize(&self, id: &Uuid, cols: u16, rows: u16) -> Option<anyhow::Result<()>> {
        let sessions = self.sessions.lock().await;
        let session = sessions.get(id)?;
        Some(session.resize(cols, rows))
    }

    /// Subscribe to a session's output broadcast channel.
    pub async fn subscribe(&self, id: &Uuid) -> Option<broadcast::Receiver<Bytes>> {
        let sessions = self.sessions.lock().await;
        let session = sessions.get(id)?;
        Some(session.subscribe())
    }
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}
