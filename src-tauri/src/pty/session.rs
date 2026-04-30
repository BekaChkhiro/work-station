use bytes::Bytes;
use portable_pty::{Child, MasterPty};
use std::io::Write;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};
use tokio::time::{sleep, Duration};

/// A single PTY session.
///
/// Owns the master PTY handle, the child process, and the output broadcast channel.
/// Dropping a session sends a kill signal to the child process.
pub struct PtySession {
    pub id: uuid::Uuid,
    pub pid: u32,
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send>,
    stdin: Arc<Mutex<Box<dyn Write + Send>>>,
    output_tx: broadcast::Sender<Bytes>,
    frontend_channels: Arc<std::sync::Mutex<Vec<tauri::ipc::Channel<Vec<u8>>>>>,
}

impl PtySession {
    pub fn new(
        id: uuid::Uuid,
        pid: u32,
        master: Box<dyn MasterPty + Send>,
        child: Box<dyn Child + Send>,
        stdin: Box<dyn Write + Send>,
        output_tx: broadcast::Sender<Bytes>,
        frontend_channels: Arc<std::sync::Mutex<Vec<tauri::ipc::Channel<Vec<u8>>>>>,
    ) -> Self {
        Self {
            id,
            pid,
            master,
            child,
            stdin: Arc::new(Mutex::new(stdin)),
            output_tx,
            frontend_channels,
        }
    }

    /// Write raw bytes to the PTY stdin.
    pub async fn write(&self, data: &[u8]) -> std::io::Result<()> {
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(data)?;
        stdin.flush()?;
        Ok(())
    }

    /// Resize the PTY.
    pub fn resize(&self, cols: u16, rows: u16) -> anyhow::Result<()> {
        self.master.resize(portable_pty::PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
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
    ) -> Arc<std::sync::Mutex<Vec<tauri::ipc::Channel<Vec<u8>>>>> {
        self.frontend_channels.clone()
    }

    /// Register a frontend Tauri channel to receive output bytes.
    pub fn add_frontend_channel(&self, channel: tauri::ipc::Channel<Vec<u8>>) {
        self.frontend_channels.lock().unwrap().push(channel);
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
            if ch.send(data.clone()).is_ok() {
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
