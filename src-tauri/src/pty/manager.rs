//! PTY session registry.
//!
//! Manages the lifecycle of all PTY sessions. The registry lives for the
//! lifetime of the application, independent of any window.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use bytes::Bytes;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::ipc::InvokeResponseBody;
use tokio::sync::{broadcast, Mutex};
use tokio::task;
use tokio::time::{interval, Duration};
use uuid::Uuid;

use super::session::{PtySession, SessionInfo};
use crate::pty::scrollback::ScrollbackBuffer;

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
        let mut reader = master.try_clone_reader()?;
        let writer = master.take_writer()?;

        let (output_tx, _) = broadcast::channel::<Bytes>(1024);
        let frontend_channels: Arc<std::sync::Mutex<Vec<tauri::ipc::Channel<InvokeResponseBody>>>> =
            Arc::new(std::sync::Mutex::new(Vec::new()));

        let scrollback = Arc::new(std::sync::Mutex::new(ScrollbackBuffer::default()));

        // ── Coalescing output reader ─────────────────────────────
        // Two tasks work together:
        // 1. A blocking reader fills a shared buffer from the PTY.
        // 2. An async flusher drains the buffer every ~16 ms and emits
        //    batched bytes to broadcast + frontend channels + scrollback.

        let coalesce_buf = Arc::new(std::sync::Mutex::new(Vec::with_capacity(65536)));
        let reader_buf = coalesce_buf.clone();
        let flusher_buf = coalesce_buf.clone();
        let reader_alive = Arc::new(AtomicBool::new(true));
        let flusher_alive = reader_alive.clone();

        let output_tx_clone = output_tx.clone();
        let flusher_channels = frontend_channels.clone();
        let flusher_scrollback = scrollback.clone();

        // Blocking reader task.
        task::spawn_blocking(move || {
            let mut local = [0u8; 4096];
            loop {
                match std::io::Read::read(&mut reader, &mut local) {
                    Ok(0) => break,
                    Ok(n) => {
                        if let Ok(mut b) = reader_buf.lock() {
                            b.extend_from_slice(&local[..n]);
                        }
                    }
                    Err(_) => break,
                }
            }
            reader_alive.store(false, Ordering::Relaxed);
        });

        // Async flusher task.
        tokio::spawn(async move {
            let mut tick = interval(Duration::from_millis(16));
            loop {
                tick.tick().await;

                // Drain buffer.
                let chunk = {
                    if let Ok(mut b) = flusher_buf.lock() {
                        if b.is_empty() {
                            None
                        } else {
                            Some(std::mem::take(&mut *b))
                        }
                    } else {
                        None
                    }
                };

                if let Some(data) = chunk {
                    let bytes = Bytes::from(data.clone());

                    // Store in scrollback buffer.
                    if let Ok(mut sb) = flusher_scrollback.lock() {
                        sb.push(bytes.clone());
                    }

                    let _ = output_tx_clone.send(bytes);

                    // Forward to frontend channels, pruning dead ones.
                    let mut channels = flusher_channels.lock().unwrap();
                    let mut alive = Vec::with_capacity(channels.len());
                    for ch in channels.drain(..) {
                        if ch.send(InvokeResponseBody::Raw(data.clone())).is_ok() {
                            alive.push(ch);
                        }
                    }
                    *channels = alive;
                }

                if !flusher_alive.load(Ordering::Relaxed) {
                    // Reader is done; do one final flush and exit.
                    let final_chunk = {
                        if let Ok(mut b) = flusher_buf.lock() {
                            if b.is_empty() {
                                None
                            } else {
                                Some(std::mem::take(&mut *b))
                            }
                        } else {
                            None
                        }
                    };

                    if let Some(data) = final_chunk {
                        let bytes = Bytes::from(data.clone());

                        if let Ok(mut sb) = flusher_scrollback.lock() {
                            sb.push(bytes.clone());
                        }

                        let _ = output_tx_clone.send(bytes);

                        let mut channels = flusher_channels.lock().unwrap();
                        let mut alive = Vec::with_capacity(channels.len());
                        for ch in channels.drain(..) {
                            if ch.send(InvokeResponseBody::Raw(data.clone())).is_ok() {
                                alive.push(ch);
                            }
                        }
                        *channels = alive;
                    }
                    break;
                }
            }
        });

        let session = PtySession::new(
            Uuid::new_v4(),
            pid,
            command.to_string(),
            cwd.to_string(),
            cols,
            rows,
            master,
            child,
            writer,
            output_tx,
            frontend_channels,
            scrollback,
        );
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

    /// List metadata for all active sessions.
    pub async fn list_sessions(&self) -> Vec<SessionInfo> {
        self.sessions
            .lock()
            .await
            .values()
            .map(|s| s.info())
            .collect()
    }

    /// Get metadata for a single session.
    pub async fn session_info(&self, id: &Uuid) -> Option<SessionInfo> {
        self.sessions.lock().await.get(id).map(|s| s.info())
    }

    /// Write raw bytes to a session's stdin.
    pub async fn write(&self, id: &Uuid, data: &[u8]) -> Option<std::io::Result<()>> {
        let stdin = {
            let sessions = self.sessions.lock().await;
            let session = sessions.get(id)?;
            session.clone_stdin()
        };
        let mut stdin = stdin.lock().await;
        Some(stdin.write_all(data).and_then(|_| stdin.flush()))
    }

    /// Resize a session's PTY.
    pub async fn resize(&self, id: &Uuid, cols: u16, rows: u16) -> Option<anyhow::Result<()>> {
        let mut sessions = self.sessions.lock().await;
        let session = sessions.get_mut(id)?;
        Some(session.resize(cols, rows))
    }

    /// Subscribe to a session's output broadcast channel.
    pub async fn subscribe(&self, id: &Uuid) -> Option<broadcast::Receiver<Bytes>> {
        let sessions = self.sessions.lock().await;
        let session = sessions.get(id)?;
        Some(session.subscribe())
    }

    /// Retrieve scrollback buffer chunks for a session.
    pub async fn get_scrollback(
        &self,
        id: &Uuid,
        offset: usize,
        limit: usize,
    ) -> Option<Vec<Bytes>> {
        let sessions = self.sessions.lock().await;
        let session = sessions.get(id)?;
        Some(session.get_scrollback(offset, limit))
    }

    /// Register a frontend Tauri channel for a session's output.
    pub async fn add_frontend_channel(
        &self,
        id: &Uuid,
        channel: tauri::ipc::Channel<InvokeResponseBody>,
    ) -> Option<()> {
        let channels = {
            let sessions = self.sessions.lock().await;
            let session = sessions.get(id)?;
            session.frontend_channels()
        };
        channels.lock().unwrap().push(channel);
        Some(())
    }

    /// Gracefully kill a session and remove it from the registry.
    ///
    /// Returns `None` if the session does not exist.
    pub async fn kill(&self, id: &Uuid) -> Option<anyhow::Result<()>> {
        let mut sessions = self.sessions.lock().await;
        let mut session = sessions.remove(id)?;
        Some(session.kill().await)
    }
}

impl Default for PtyManager {
    fn default() -> Self {
        Self::new()
    }
}
