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
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use bytes::Bytes;
use portable_pty::{Child, MasterPty};
use tokio::sync::broadcast;
use uuid::Uuid;

use super::scrollback::Scrollback;

/// Default capacity for the per-session output broadcast channel.
///
/// 1024 frames lets the reader task (T2.4) buffer several hundred ms of
/// output before slow subscribers start lagging.
pub(crate) const DEFAULT_OUTPUT_CAPACITY: usize = 1024;

/// Polling cadence while waiting for a SIGTERM/EOF to land before we
/// escalate to SIGKILL. 50ms gives sub-frame responsiveness without
/// burning CPU on the wait loop.
const TERMINATE_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Live PTY session.
///
/// `master`, `writer`, and `child` are wrapped in `Mutex` so the whole
/// struct is `Sync`, which lets the registry (T2.3) hand out
/// `Arc<PtySession>` from Tauri-managed state. Lock holds are short —
/// clone-the-reader for T2.4 and per-write-call for T2.6. `child` is
/// behind a mutex (rather than `&mut self` access) so T2.8's graceful
/// shutdown can call `try_wait` / `kill` / `wait` through the shared
/// `Arc<PtySession>`.
pub(crate) struct PtySession {
    pub(crate) id: Uuid,
    pub(crate) pid: u32,
    pub(crate) master: Mutex<Box<dyn MasterPty + Send>>,
    pub(crate) writer: Mutex<Box<dyn Write + Send>>,
    pub(crate) child: Mutex<Box<dyn Child + Send + Sync>>,
    pub(crate) output_tx: broadcast::Sender<Bytes>,
    /// Bounded scrollback (T2.9) — `Arc` so the reader can clone-and-tap
    /// without keeping the whole session alive past EOF. Default cap is
    /// [`scrollback::DEFAULT_SCROLLBACK_BYTES`]; T3.4 will plumb the
    /// user-configured value from `app_settings`.
    pub(crate) scrollback: Arc<Mutex<Scrollback>>,
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
            child: Mutex::new(child),
            output_tx,
            scrollback: Arc::new(Mutex::new(Scrollback::new())),
            created_at: SystemTime::now(),
        }
    }

    /// Best-effort graceful shutdown (T2.8).
    ///
    /// 1. Signal the child to exit cleanly:
    ///    * Unix — `kill(pid, SIGTERM)` so shells run trap handlers and
    ///      foreground programs flush before exit.
    ///    * Windows — drop the writer (replace with `io::sink`) so the
    ///      child sees EOF on stdin, since there's no SIGTERM equivalent.
    /// 2. Poll `try_wait` for up to `grace`, sleeping
    ///    [`TERMINATE_POLL_INTERVAL`] between checks.
    /// 3. If the child is still alive, escalate with `Child::kill`
    ///    (SIGKILL on Unix, `TerminateProcess` on Windows) and `wait`.
    ///
    /// Returns `true` if the child exited within the grace window,
    /// `false` if it had to be force-killed. Errors are logged and
    /// swallowed — termination is best-effort and the registry must move
    /// on regardless.
    pub(crate) fn terminate_gracefully(&self, grace: Duration) -> bool {
        let id = self.id;
        let pid = self.pid;

        // Fast path: child has already exited (e.g. EOF cleanup race).
        if self.child_exited() {
            return true;
        }

        self.signal_terminate();

        let deadline = Instant::now() + grace;
        loop {
            if self.child_exited() {
                return true;
            }
            if Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(TERMINATE_POLL_INTERVAL);
        }

        let grace_ms = u64::try_from(grace.as_millis()).unwrap_or(u64::MAX);
        tracing::warn!(
            session_id = %id,
            pid,
            grace_ms,
            "pty session: child did not exit on graceful signal; escalating to SIGKILL",
        );

        let mut child = match self.child.lock() {
            Ok(guard) => guard,
            Err(error) => {
                tracing::warn!(
                    session_id = %id,
                    pid,
                    %error,
                    "pty session: child mutex poisoned during force-kill",
                );
                return false;
            }
        };
        if let Err(error) = child.kill() {
            tracing::warn!(
                session_id = %id,
                pid,
                %error,
                "pty session: SIGKILL failed",
            );
        }
        if let Err(error) = child.wait() {
            tracing::warn!(
                session_id = %id,
                pid,
                %error,
                "pty session: wait after SIGKILL failed",
            );
        }
        false
    }

    /// `Ok(Some(_))` from `try_wait` means the child has exited and is
    /// reaped. Lock errors and `Ok(None)` both report "still running" so
    /// the caller keeps polling.
    fn child_exited(&self) -> bool {
        let Ok(mut child) = self.child.lock() else {
            return false;
        };
        matches!(child.try_wait(), Ok(Some(_)))
    }

    #[cfg(unix)]
    fn signal_terminate(&self) {
        // Pid `0` is the registry default for "process_id was missing"
        // and would broadcast SIGTERM to our own process group; pids
        // beyond `i32::MAX` would wrap into negative territory which
        // also broadcasts to a process group — both are footguns.
        let Ok(pid) = i32::try_from(self.pid) else {
            return;
        };
        if pid <= 0 {
            return;
        }
        // SAFETY: `libc::kill` is async-signal-safe. We pass a positive
        // pid so the signal is delivered to that single process; failure
        // (ESRCH if the child raced past us, EPERM if portable-pty
        // dropped privileges) is informational only.
        let rc = unsafe { libc::kill(pid, libc::SIGTERM) };
        if rc != 0 {
            let err = std::io::Error::last_os_error();
            tracing::debug!(
                session_id = %self.id,
                pid = self.pid,
                error = %err,
                "pty session: SIGTERM not delivered (likely already exited)",
            );
        }
    }

    #[cfg(windows)]
    fn signal_terminate(&self) {
        // No SIGTERM on Windows — the closest equivalent is closing the
        // child's stdin so well-behaved console programs read EOF and
        // shut down. Replace the writer with `io::sink` so the original
        // pipe handle is dropped (and hence closed).
        match self.writer.lock() {
            Ok(mut guard) => {
                *guard = Box::new(std::io::sink());
            }
            Err(error) => {
                tracing::warn!(
                    session_id = %self.id,
                    pid = self.pid,
                    %error,
                    "pty session: writer mutex poisoned; cannot close stdin",
                );
            }
        }
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        let id = self.id;
        let pid = self.pid;

        // Drop only ever sees this code path when the session is being
        // discarded WITHOUT a prior `terminate_gracefully` (e.g. the EOF
        // path or a panic during spawn). Going straight to SIGKILL is
        // intentional — a graceful caller has already cleared this work.
        let child = self.child.get_mut();
        let child = match child {
            Ok(c) => c,
            Err(error) => {
                tracing::warn!(
                    session_id = %id,
                    pid,
                    %error,
                    "pty session drop: child mutex poisoned",
                );
                return;
            }
        };

        match child.try_wait() {
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

        if let Err(error) = child.kill() {
            tracing::warn!(
                session_id = %id,
                pid,
                %error,
                "pty session drop: kill failed",
            );
        }

        match child.wait() {
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

    fn open_session(cmd_args: &[&str]) -> PtySession {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        let mut cmd = CommandBuilder::new(cmd_args[0]);
        for a in &cmd_args[1..] {
            cmd.arg(a);
        }

        let child = pair.slave.spawn_command(cmd).expect("spawn_command");
        let writer = pair.master.take_writer().expect("take_writer");
        drop(pair.slave);

        PtySession::new(pair.master, writer, child)
    }

    #[test]
    fn drop_reaps_child_no_zombie() {
        let session = open_session(&["/bin/sleep", "60"]);
        let pid = session.pid;
        assert!(pid > 0, "pid should be populated");
        assert!(
            pid_alive_in_ps(pid).is_some(),
            "child {pid} should be running before drop",
        );

        drop(session);

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match pid_alive_in_ps(pid) {
                None => return,
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

    /// `sh -c "trap 'exit 0' TERM; sleep 60"` exits cleanly on SIGTERM
    /// with no SIGKILL escalation — the graceful path must finish well
    /// before the grace deadline.
    #[test]
    fn terminate_gracefully_exits_on_sigterm() {
        let session = open_session(&[
            "/bin/sh",
            "-c",
            "trap 'exit 0' TERM; while :; do sleep 1; done",
        ]);
        let pid = session.pid;
        assert!(
            pid_alive_in_ps(pid).is_some(),
            "child {pid} should be running",
        );

        let started = Instant::now();
        let graceful = session.terminate_gracefully(Duration::from_secs(2));
        let elapsed = started.elapsed();

        assert!(graceful, "expected graceful exit on SIGTERM");
        assert!(
            elapsed < Duration::from_millis(1500),
            "graceful path took too long: {elapsed:?}",
        );

        // Process must be reaped, not zombied.
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match pid_alive_in_ps(pid) {
                None => break,
                Some(line) => {
                    assert!(
                        Instant::now() < deadline,
                        "child {pid} still in ps after graceful kill: {line}",
                    );
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }

    /// Fast-path: an already-exited child should report graceful
    /// termination immediately without firing SIGTERM or SIGKILL. We
    /// can't observe the absence of `kill(2)` directly here, but the
    /// near-zero elapsed time is a good proxy.
    #[test]
    fn terminate_gracefully_short_circuits_when_child_already_exited() {
        let session = open_session(&["/bin/sh", "-c", "exit 0"]);

        // Wait until the child reaps so the fast-path branch is taken.
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            {
                let mut child = session.child.lock().expect("child lock");
                if matches!(child.try_wait(), Ok(Some(_))) {
                    break;
                }
            }
            assert!(Instant::now() < deadline, "child failed to exit in time");
            std::thread::sleep(Duration::from_millis(20));
        }

        let started = Instant::now();
        let graceful = session.terminate_gracefully(Duration::from_secs(5));
        assert!(graceful);
        assert!(
            started.elapsed() < Duration::from_millis(100),
            "fast-path should not poll: {:?}",
            started.elapsed(),
        );
    }

    /// SIGTERM-trapping child that refuses to exit forces the
    /// SIGKILL escalation. Use a short grace so the test stays fast.
    ///
    /// Perl over `/bin/sh -c 'trap ...'` because macOS bash-as-sh's
    /// trap delivery while inside a builtin is flaky under load —
    /// `$SIG{TERM} = "IGNORE"` is unambiguous and never races.
    #[test]
    fn terminate_gracefully_escalates_to_sigkill() {
        let session = open_session(&[
            "/usr/bin/perl",
            "-e",
            "$SIG{TERM} = 'IGNORE'; while (1) { sleep 1 }",
        ]);
        let pid = session.pid;
        // Give perl a moment to install the signal handler before we
        // start firing SIGTERMs; otherwise we race against startup and
        // the default handler (which terminates) might still be active.
        std::thread::sleep(Duration::from_millis(150));
        assert!(
            pid_alive_in_ps(pid).is_some(),
            "child {pid} should be running",
        );

        let graceful = session.terminate_gracefully(Duration::from_millis(300));
        assert!(!graceful, "expected force-kill, not graceful exit");

        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            match pid_alive_in_ps(pid) {
                None => return,
                Some(line) => {
                    assert!(
                        Instant::now() < deadline,
                        "child {pid} survived SIGKILL: {line}",
                    );
                    std::thread::sleep(Duration::from_millis(50));
                }
            }
        }
    }
}

/// Cross-platform session lifecycle tests for T2.13.
///
/// These complement the unix-only tests above (which use `ps` for
/// zombie verification) so the Drop and terminate paths get exercised
/// on Windows CI too.
#[cfg(test)]
mod xplat_tests {
    use super::*;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    fn open_long_running() -> PtySession {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("openpty");

        #[cfg(unix)]
        let cmd = {
            let mut c = CommandBuilder::new("/bin/sleep");
            c.arg("60");
            c
        };
        #[cfg(windows)]
        let cmd = {
            let mut c = CommandBuilder::new("cmd.exe");
            c.arg("/C");
            c.arg("ping -n 60 127.0.0.1 > NUL");
            c
        };

        let child = pair.slave.spawn_command(cmd).expect("spawn_command");
        let writer = pair.master.take_writer().expect("take_writer");
        drop(pair.slave);
        PtySession::new(pair.master, writer, child)
    }

    /// Drop must not panic and must complete promptly on either OS,
    /// even when the child is non-cooperative.
    #[test]
    fn drop_on_long_running_child_completes_promptly() {
        let session = open_long_running();
        assert!(session.pid > 0);
        let started = Instant::now();
        drop(session);
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "Drop took too long: {:?}",
            started.elapsed(),
        );
    }

    /// `terminate_gracefully` must end a non-cooperative child within
    /// (grace + escalation) on both OSes. We can't assert which path
    /// (graceful vs. forced) wins because /bin/sleep happily exits on
    /// SIGTERM while ping.exe ignores stdin closure, so we just bound
    /// the wall-time and verify the child is reaped afterwards.
    #[test]
    fn terminate_gracefully_terminates_long_running_child() {
        let session = open_long_running();
        let started = Instant::now();
        let _ = session.terminate_gracefully(Duration::from_millis(200));
        assert!(
            started.elapsed() < Duration::from_secs(3),
            "termination took too long: {:?}",
            started.elapsed(),
        );

        // Child must be reaped (or already gone) by the time
        // terminate_gracefully returns. Repeating try_wait should yield
        // `Some(_)` immediately.
        let mut child = session.child.lock().expect("child lock");
        match child.try_wait() {
            Ok(Some(_)) => {}
            Ok(None) => panic!("child still running after terminate_gracefully"),
            Err(error) => panic!("try_wait failed: {error}"),
        }
    }
}
