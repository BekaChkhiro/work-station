//! Per-session PTY state.
//!
//! `PtySession` owns the master side of a pty, the writer used to feed input,
//! the spawned child process handle, and the broadcast channel that fans
//! pty output out to subscribers (the reader task in T2.4).
//!
//! Drop reaps the child so dropping a session never leaves a zombie.

// T2.3 (PtyManager) is the first consumer; remaining fields land in
// later phase-2 tasks (e.g. scrollback + binary IPC).
#![allow(dead_code)]

use std::io::Write;
use std::sync::Mutex;
use std::time::SystemTime;

use bytes::Bytes;
use portable_pty::{Child, MasterPty};
use tokio::sync::broadcast;
use uuid::Uuid;

/// Default capacity for the per-session output broadcast channel.
///
/// 1024 frames lets the reader task (T2.4) buffer several hundred ms of
/// output before slow subscribers start lagging.
pub(crate) const DEFAULT_OUTPUT_CAPACITY: usize = 1024;

/// Live PTY session.
///
/// `master` and `writer` are wrapped in `Mutex` so the whole struct is
/// `Sync`, which lets the registry (T2.3) hand out `Arc<PtySession>` from
/// Tauri-managed state. Lock holds are short — clone-the-reader for T2.4
/// and per-write-call for T2.6.
pub(crate) struct PtySession {
    pub(crate) id: Uuid,
    pub(crate) pid: u32,
    pub(crate) master: Mutex<Box<dyn MasterPty + Send>>,
    pub(crate) writer: Mutex<Box<dyn Write + Send>>,
    pub(crate) child: Box<dyn Child + Send + Sync>,
    pub(crate) output_tx: broadcast::Sender<Bytes>,
    pub(crate) created_at: SystemTime,
}

impl PtySession {
    /// Build a session from an already-spawned pty + child trio.
    ///
    /// The output broadcast channel is created here so callers don't have
    /// to thread it in; subscribe via `output_tx.subscribe()`.
    pub(crate) fn new(
        master: Box<dyn MasterPty + Send>,
        writer: Box<dyn Write + Send>,
        child: Box<dyn Child + Send + Sync>,
    ) -> Self {
        let pid = child.process_id().unwrap_or(0);
        let (output_tx, _) = broadcast::channel(DEFAULT_OUTPUT_CAPACITY);
        Self {
            id: Uuid::new_v4(),
            pid,
            master: Mutex::new(master),
            writer: Mutex::new(writer),
            child,
            output_tx,
            created_at: SystemTime::now(),
        }
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        let id = self.id;
        let pid = self.pid;

        match self.child.try_wait() {
            Ok(Some(status)) => {
                tracing::debug!(
                    session_id = %id,
                    pid,
                    status = %status,
                    "pty session dropped; child already exited",
                );
                return;
            }
            Ok(None) => {}
            Err(error) => {
                tracing::warn!(
                    session_id = %id,
                    pid,
                    %error,
                    "pty session drop: try_wait failed",
                );
            }
        }

        if let Err(error) = self.child.kill() {
            tracing::warn!(
                session_id = %id,
                pid,
                %error,
                "pty session drop: kill failed",
            );
        }

        match self.child.wait() {
            Ok(status) if status.success() => {
                tracing::debug!(
                    session_id = %id,
                    pid,
                    status = %status,
                    "pty session dropped cleanly",
                );
            }
            Ok(status) => {
                tracing::warn!(
                    session_id = %id,
                    pid,
                    status = %status,
                    "pty session dropped; child did not exit cleanly",
                );
            }
            Err(error) => {
                tracing::warn!(
                    session_id = %id,
                    pid,
                    %error,
                    "pty session drop: wait failed",
                );
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::process::Command;
    use std::time::{Duration, Instant};

    fn pid_alive_in_ps(pid: u32) -> Option<String> {
        let output = Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "pid=,stat="])
            .output()
            .expect("ps must be available on unix");
        if !output.status.success() {
            return None;
        }
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if stdout.is_empty() {
            None
        } else {
            Some(stdout)
        }
    }

    #[test]
    fn drop_reaps_child_no_zombie() {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        // Long-running command so we can prove Drop terminates it.
        let mut cmd = CommandBuilder::new("/bin/sleep");
        cmd.arg("60");

        let child = pair.slave.spawn_command(cmd).expect("spawn_command");
        let writer = pair.master.take_writer().expect("take_writer");
        // Slave fd must be released in the parent so the child sees EOF on close.
        drop(pair.slave);

        let session = PtySession::new(pair.master, writer, child);
        let pid = session.pid;
        assert!(pid > 0, "pid should be populated");

        // Sanity: process is alive before drop.
        assert!(
            pid_alive_in_ps(pid).is_some(),
            "child {pid} should be running before drop",
        );

        drop(session);

        // Reaping is async vs ps; allow up to 2s for the kernel to clear it.
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match pid_alive_in_ps(pid) {
                None => return, // fully gone — neither alive nor zombie
                Some(line) => {
                    assert!(
                        !line
                            .split_whitespace()
                            .nth(1)
                            .is_some_and(|s| s.starts_with('Z')),
                        "child {pid} ended as a zombie: {line}",
                    );
                    assert!(
                        Instant::now() < deadline,
                        "child {pid} still tracked by ps after Drop: {line}",
                    );
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
}
