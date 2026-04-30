use bytes::Bytes;
use portable_pty::{Child, MasterPty};
use std::io::Write;
use std::sync::Arc;
use tokio::sync::{broadcast, Mutex};

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
}

impl PtySession {
    pub fn new(
        id: uuid::Uuid,
        pid: u32,
        master: Box<dyn MasterPty + Send>,
        child: Box<dyn Child + Send>,
        stdin: Box<dyn Write + Send>,
        output_tx: broadcast::Sender<Bytes>,
    ) -> Self {
        Self {
            id,
            pid,
            master,
            child,
            stdin: Arc::new(Mutex::new(stdin)),
            output_tx,
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
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // Graceful cleanup: kill the child process.
        // The master PTY is closed automatically when dropped.
        let _ = self.child.kill();
    }
}
