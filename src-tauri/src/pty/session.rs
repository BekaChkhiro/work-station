use bytes::Bytes;
use portable_pty::{Child, MasterPty};
use std::io::Write;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::ipc::InvokeResponseBody;
use tokio::sync::{broadcast, Mutex};
use tokio::time::{sleep, Duration};

use crate::pty::scrollback::ScrollbackBuffer;

/// Metadata for an active PTY session.
#[derive(Debug, Clone)]
pub struct SessionInfo {
    pub id: uuid::Uuid,
    pub pid: u32,
    pub command: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub created_at: u64,
}

/// A single PTY session.
///
/// Owns the master PTY handle, the child process, and the output broadcast channel.
/// Dropping a session sends a kill signal to the child process.
pub struct PtySession {
    pub id: uuid::Uuid,
    pub pid: u32,
    pub command: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    pub created_at: u64,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send>,
    stdin: Arc<Mutex<Box<dyn Write + Send>>>,
    output_tx: broadcast::Sender<Bytes>,
    frontend_channels: Arc<std::sync::Mutex<Vec<tauri::ipc::Channel<InvokeResponseBody>>>>,
    scrollback: Arc<std::sync::Mutex<ScrollbackBuffer>>,
}

impl PtySession {
    pub fn new(
        id: uuid::Uuid,
        pid: u32,
        command: String,
        cwd: String,
        cols: u16,
        rows: u16,
        master: Box<dyn MasterPty + Send>,
        child: Box<dyn Child + Send>,
        stdin: Box<dyn Write + Send>,
        output_tx: broadcast::Sender<Bytes>,
        frontend_channels: Arc<std::sync::Mutex<Vec<tauri::ipc::Channel<InvokeResponseBody>>>>,
        scrollback: Arc<std::sync::Mutex<ScrollbackBuffer>>,
    ) -> Self {
        let created_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        Self {
            id,
            pid,
            command,
            cwd,
            cols,
            rows,
            created_at,
            master,
            child,
            stdin: Arc::new(Mutex::new(stdin)),
            output_tx,
            frontend_channels,
            scrollback,
        }
    }

    /// Return a snapshot of session metadata.
    pub fn info(&self) -> SessionInfo {
        SessionInfo {
            id: self.id,
            pid: self.pid,
            command: self.command.clone(),
            cwd: self.cwd.clone(),
            cols: self.cols,
            rows: self.rows,
            created_at: self.created_at,
        }
    }

    /// Clone the stdin handle so callers can write without holding `&self`
    /// across await points (required for `Send` futures in Tauri commands).
    pub fn clone_stdin(&self) -> Arc<Mutex<Box<dyn Write + Send>>> {
        self.stdin.clone()
    }

    /// Write raw bytes to the PTY stdin.
    pub async fn write(&self, data: &[u8]) -> std::io::Result<()> {
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(data)?;
        stdin.flush()?;
        Ok(())
    }

    /// Resize the PTY.
    pub fn resize(&mut self, cols: u16, rows: u16) -> anyhow::Result<()> {
        self.master.resize(portable_pty::PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;
        self.cols = cols;
        self.rows = rows;
        Ok(())
    }

    /// Clone a reader for the PTY output.
    pub fn try_clone_reader(&self) -> anyhow::Result<Box<dyn std::io::Read + Send>> {
        self.master.try_clone_reader()
    }

    /// Subscribe to the output broadcast channel.
    pub fn subscribe(&self) -> broadcast::Receiver<Bytes> {
        self.output_tx.subscribe()
    }

    /// Clone the frontend channels Arc so callers can push channels without
    /// holding a reference to `PtySession` across await points.
    pub fn frontend_channels(
        &self,
    ) -> Arc<std::sync::Mutex<Vec<tauri::ipc::Channel<InvokeResponseBody>>>> {
        self.frontend_channels.clone()
    }

    /// Register a frontend Tauri channel to receive output bytes.
    pub fn add_frontend_channel(&self, channel: tauri::ipc::Channel<InvokeResponseBody>) {
        self.frontend_channels.lock().unwrap().push(channel);
    }

    /// Retrieve scrollback buffer chunks for the given byte range.
    pub fn get_scrollback(&self, offset: usize, limit: usize) -> Vec<Bytes> {
        self.scrollback.lock().unwrap().get_range(offset, limit)
    }

    /// Broadcast output bytes to all subscribers (broadcast + frontend channels).
    ///
    /// Dead frontend channels are pruned automatically.
    pub fn broadcast_output(&self, data: Vec<u8>) {
        if data.is_empty() {
            return;
        }

        let _ = self.output_tx.send(Bytes::from(data.clone()));

        let mut channels = self.frontend_channels.lock().unwrap();
        let mut alive = Vec::with_capacity(channels.len());
        for ch in channels.drain(..) {
            if ch.send(InvokeResponseBody::Raw(data.clone())).is_ok() {
                alive.push(ch);
            }
        }
        *channels = alive;
    }

    /// Gracefully kill the child process.
    ///
    /// Unix: sends SIGTERM, waits up to 2 seconds, then SIGKILL if still alive.
    /// Windows: immediate force kill (no standard graceful termination API).
    pub async fn kill(&mut self) -> anyhow::Result<()> {
        #[cfg(unix)]
        {
            if let Some(pid) = self.child.process_id() {
                // Send SIGTERM for graceful shutdown.
                unsafe {
                    let _ = libc::kill(pid as i32, libc::SIGTERM);
                }

                // Poll for up to 2 seconds (40 × 50 ms).
                for _ in 0..40 {
                    sleep(Duration::from_millis(50)).await;
                    match self.child.try_wait() {
                        Ok(Some(_)) => return Ok(()),
                        Ok(None) => continue,
                        Err(e) => return Err(e.into()),
                    }
                }
            }
        }

        // Force kill (SIGKILL on Unix, TerminateProcess on Windows).
        self.child.kill().map_err(|e| e.into())
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // Graceful cleanup: kill the child process.
        // The master PTY is closed automatically when dropped.
        let _ = self.child.kill();
    }
}
