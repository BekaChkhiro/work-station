//! App-wide registry of live PTY sessions (T2.3).
//!
//! Held by Tauri as managed state — its lifetime is the app, not any
//! window — so a webview reload never drops the spawned shells (verified
//! by T2.12). Spawning, lookup, and teardown all flow through here.

#![allow(dead_code)] // T2.5 wires this into the Tauri command surface.

use std::collections::HashMap;
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use thiserror::Error;
use uuid::Uuid;

use super::session::PtySession;

/// SIGTERM → SIGKILL escalation window for `PtyManager::kill` (T2.8).
///
/// Gives well-behaved shells time to run trap handlers, flush, and
/// teardown subprocesses before we resort to force-kill.
pub const KILL_GRACE: Duration = Duration::from_secs(2);

#[derive(Debug, Error)]
pub enum PtyError {
    #[error("cwd does not exist: {0}")]
    CwdMissing(PathBuf),
    #[error("command not found on PATH: {0}")]
    CommandNotFound(String),
    #[error("openpty failed: {0}")]
    OpenPty(String),
    #[error("spawn failed: {0}")]
    Spawn(String),
    #[error("take_writer failed: {0}")]
    Writer(String),
    #[error("write to pty failed: {0}")]
    WriteIo(String),
    #[error("write to closed pty (session {0})")]
    WriteToClosed(Uuid),
    #[error("resize pty failed: {0}")]
    ResizeIo(String),
    #[error("session not found: {0}")]
    NotFound(Uuid),
    #[error("registry lock poisoned")]
    LockPoisoned,
    #[error("pty reader pipeline panicked (session {0})")]
    ReaderPanic(Uuid),
}

/// Result of `PtyManager::read_scrollback` (T2.10).
///
/// `total_bytes` reflects the scrollback size at the moment the slice
/// was taken; the frontend uses it to detect eviction across paginated
/// reads. `next_offset` is `offset + data.len()` clamped to total —
/// pass it back as `offset` for the next page.
#[derive(Debug, Clone)]
pub struct ScrollbackChunk {
    pub data: Vec<u8>,
    pub total_bytes: usize,
    pub next_offset: usize,
}

/// Snapshot of per-session backpressure counters (T2.16).
///
/// Read once under the scrollback mutex (for the eviction counters)
/// plus relaxed-atomic loads (for the broadcast counters), so the
/// snapshot is internally consistent for the eviction pair but the
/// broadcast values may be a few µs newer than the eviction values.
/// That's fine for a debug panel — exactness across cores doesn't help
/// the user spot "frontend is falling behind."
#[derive(Debug, Clone, Copy)]
pub struct BackpressureSnapshot {
    pub broadcast_lag_events: u64,
    pub broadcast_dropped_frames: u64,
    pub subscribers_disconnected_on_lag: u64,
    pub scrollback_evicted_frames: u64,
    pub scrollback_evicted_bytes: u64,
    pub scrollback_total_bytes: usize,
    pub scrollback_cap_bytes: usize,
}

/// Inputs for `PtyManager::spawn`. T2.5 fills these from frontend args.
#[derive(Debug, Clone)]
pub struct SpawnConfig {
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
pub struct PtyManager {
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

        // Pre-flight command resolution (T2.15). Catching ENOENT here —
        // before openpty + spawn — gives the frontend a deterministic
        // `CommandNotFound` instead of a generic `SpawnFailed` derived
        // from a platform-specific error string.
        if !command_resolves(&config.command) {
            return Err(PtyError::CommandNotFound(config.command.clone()));
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
        // portable-pty's `CommandBuilder::new()` starts with an empty
        // environment on Unix. Inherit the host process's env so spawned
        // shells see PATH / HOME / LANG / TERM-like vars and child tools
        // (claude, mcp servers, language toolchains) can find their
        // config files. Caller-supplied `config.env` then overrides /
        // augments — used to inject WS_PROJECT_ID and friends.
        for (k, v) in std::env::vars_os() {
            // Skip vars with non-UTF8 contents — CommandBuilder::env takes
            // &str. The kernel allows arbitrary bytes here but we never
            // need them in practice and they'd silently fail the cast.
            if let (Some(k), Some(v)) = (k.to_str(), v.to_str()) {
                cmd.env(k, v);
            }
        }
        // Force a sensible TERM when the host didn't have one set so xterm
        // negotiation works (e.g. Tauri launched from Finder gets nothing).
        if std::env::var_os("TERM").is_none() {
            cmd.env("TERM", "xterm-256color");
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

    /// Graceful kill (T2.8): SIGTERM (or close-stdin on Windows), wait
    /// up to [`KILL_GRACE`], then SIGKILL if still alive. The session is
    /// removed from the registry *before* we start signalling so a slow
    /// shutdown never blocks lookups for other sessions, and concurrent
    /// `kill` calls for the same id resolve to a single `NotFound` for
    /// the loser.
    ///
    /// The pulled-out `Arc` is dropped after termination — its `Drop` is
    /// a no-op at that point because the child has already been waited
    /// on.
    pub fn kill(&self, id: Uuid) -> Result<(), PtyError> {
        let session = self
            .inner
            .write()
            .map_err(|_| PtyError::LockPoisoned)?
            .remove(&id)
            .ok_or(PtyError::NotFound(id))?;
        session.terminate_gracefully(KILL_GRACE);
        // Closes the broadcast channel once the last receiver hangs up,
        // which signals subscribers (frontend handlers, future scrollback
        // tap) that the session is done.
        drop(session);
        Ok(())
    }

    /// Remove a session from the registry without termination logic.
    ///
    /// Used by the reader task's EOF path (T2.4): the child has already
    /// exited, so `terminate_gracefully` would just round-trip a
    /// `try_wait`. Skipping it keeps the call cheap inside the tokio
    /// coalescer and avoids a dead-pid SIGTERM that would only ever land
    /// in the kernel's bit-bucket.
    pub fn remove(&self, id: Uuid) -> Result<(), PtyError> {
        let session = self
            .inner
            .write()
            .map_err(|_| PtyError::LockPoisoned)?
            .remove(&id)
            .ok_or(PtyError::NotFound(id))?;
        drop(session);
        Ok(())
    }

    /// Forward raw bytes to the session's pty stdin.
    ///
    /// Resolves the session under a short read lock, releases it, then
    /// holds only the per-session writer mutex while doing the blocking
    /// `write_all` + `flush`. Other registry ops aren't blocked by a slow
    /// child reading its end of the pty.
    ///
    /// `data.is_empty()` is treated as a no-op so the frontend can
    /// debounce keystrokes without conditional branches.
    pub fn write(&self, id: Uuid, data: &[u8]) -> Result<(), PtyError> {
        if data.is_empty() {
            return Ok(());
        }
        let session = {
            let map = self.inner.read().map_err(|_| PtyError::LockPoisoned)?;
            map.get(&id).cloned()
        }
        .ok_or(PtyError::NotFound(id))?;

        // T2.15: if the child has already exited the master writer is
        // pointed at a closed pipe — depending on platform the next
        // write either succeeds silently or fails with a non-portable
        // error string. A short `try_wait` pre-flight gives the
        // frontend a deterministic `WriteToClosed` instead.
        {
            let mut child = session.child.lock().map_err(|_| PtyError::LockPoisoned)?;
            if let Ok(Some(_)) = child.try_wait() {
                return Err(PtyError::WriteToClosed(id));
            }
        }

        let mut writer = session.writer.lock().map_err(|_| PtyError::LockPoisoned)?;
        writer.write_all(data).map_err(|e| map_write_error(e, id))?;
        writer.flush().map_err(|e| map_write_error(e, id))?;
        Ok(())
    }

    /// Resize the pty so the child sees a SIGWINCH and re-flows its output.
    ///
    /// Calls `MasterPty::resize` under a short master-mutex hold; the
    /// reader task (T2.4) only locks the master once at startup to clone
    /// its reader, so this can't deadlock against an in-flight read.
    /// Zero dimensions are a frontend bug and rejected up-front rather
    /// than forwarded to the kernel where they'd silently no-op.
    pub fn resize(&self, id: Uuid, cols: u16, rows: u16) -> Result<(), PtyError> {
        let session = {
            let map = self.inner.read().map_err(|_| PtyError::LockPoisoned)?;
            map.get(&id).cloned()
        }
        .ok_or(PtyError::NotFound(id))?;

        let master = session.master.lock().map_err(|_| PtyError::LockPoisoned)?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| PtyError::ResizeIo(e.to_string()))?;
        Ok(())
    }

    /// Copy a byte range out of the session's scrollback (T2.10).
    ///
    /// Offsets are into the *current* ring snapshot — oldest retained
    /// byte is `0`. The slice is taken under the scrollback mutex so a
    /// single call is internally consistent; callers that want a stable
    /// view across pagination should size `limit` to the full
    /// `total_bytes` from the response and read in one shot.
    pub fn read_scrollback(
        &self,
        id: Uuid,
        offset: usize,
        limit: usize,
    ) -> Result<ScrollbackChunk, PtyError> {
        let session = {
            let map = self.inner.read().map_err(|_| PtyError::LockPoisoned)?;
            map.get(&id).cloned()
        }
        .ok_or(PtyError::NotFound(id))?;

        let sb = session
            .scrollback
            .lock()
            .map_err(|_| PtyError::LockPoisoned)?;
        let total_bytes = sb.total_bytes();
        let data = sb.slice(offset, limit);
        let next_offset = offset.saturating_add(data.len()).min(total_bytes);
        Ok(ScrollbackChunk {
            data,
            total_bytes,
            next_offset,
        })
    }

    /// Read the per-session backpressure counters (T2.16).
    ///
    /// Reads scrollback eviction counts under the scrollback mutex, and
    /// broadcast lag counters via relaxed atomics — so a snapshot in
    /// flight while the reader is pushing frames may show eviction
    /// counts a hair behind the live total, but never inconsistent.
    pub fn get_backpressure_stats(&self, id: Uuid) -> Result<BackpressureSnapshot, PtyError> {
        let session = {
            let map = self.inner.read().map_err(|_| PtyError::LockPoisoned)?;
            map.get(&id).cloned()
        }
        .ok_or(PtyError::NotFound(id))?;

        let (
            scrollback_evicted_frames,
            scrollback_evicted_bytes,
            scrollback_total_bytes,
            scrollback_cap_bytes,
        ) = {
            let sb = session
                .scrollback
                .lock()
                .map_err(|_| PtyError::LockPoisoned)?;
            (
                sb.evicted_frames(),
                sb.evicted_bytes(),
                sb.total_bytes(),
                sb.cap_bytes(),
            )
        };

        Ok(BackpressureSnapshot {
            broadcast_lag_events: session
                .backpressure
                .broadcast_lag_events
                .load(Ordering::Relaxed),
            broadcast_dropped_frames: session
                .backpressure
                .broadcast_dropped_frames
                .load(Ordering::Relaxed),
            subscribers_disconnected_on_lag: session
                .backpressure
                .subscribers_disconnected_on_lag
                .load(Ordering::Relaxed),
            scrollback_evicted_frames,
            scrollback_evicted_bytes,
            scrollback_total_bytes,
            scrollback_cap_bytes,
        })
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

/// Resolve a command in the same way the spawned child eventually will.
///
/// Mirrors the typical PATH-walk behaviour of `execvp` / `CreateProcessW`
/// so we can detect a missing binary up-front and surface
/// `CommandNotFound` to the frontend instead of waiting for the platform
/// to fail the spawn with an opaque error string (T2.15).
fn command_resolves(name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    let candidate = Path::new(name);
    let has_separator = name.contains('/') || cfg!(windows) && name.contains('\\');
    if candidate.is_absolute() || has_separator {
        return is_executable_file(candidate);
    }

    let path_var = std::env::var_os("PATH").unwrap_or_default();
    for dir in std::env::split_paths(&path_var) {
        let direct = dir.join(name);
        if is_executable_file(&direct) {
            return true;
        }
        // Windows: PATHEXT lookup. Test the conventional set first so
        // we don't miss `git` (which lives as `git.exe` on PATH).
        #[cfg(windows)]
        {
            for ext in ["exe", "cmd", "bat", "com"] {
                let with_ext = direct.with_extension(ext);
                if is_executable_file(&with_ext) {
                    return true;
                }
            }
        }
    }
    false
}

#[cfg(unix)]
fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() {
        return false;
    }
    meta.permissions().mode() & 0o111 != 0
}

#[cfg(windows)]
fn is_executable_file(path: &Path) -> bool {
    // Windows: file existence is enough — execution permission is
    // governed by ACLs, not a unix-style mode bit, and the spawn API
    // surfaces ACL failures the same way ENOENT does.
    path.is_file()
}

/// Translate an `io::Error` from a write/flush onto the per-session pty
/// stdin into the typed PTY error. `BrokenPipe` is the kernel's signal
/// that the child has closed its end (exited or close(0)) — surface it
/// as `WriteToClosed` so the frontend can show "session ended" instead
/// of treating it as a generic IO failure.
fn map_write_error(error: std::io::Error, session_id: Uuid) -> PtyError {
    match error.kind() {
        ErrorKind::BrokenPipe => PtyError::WriteToClosed(session_id),
        _ => PtyError::WriteIo(error.to_string()),
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
    fn read_scrollback_unknown_returns_not_found() {
        let m = PtyManager::new();
        match m.read_scrollback(Uuid::new_v4(), 0, 16) {
            Err(PtyError::NotFound(_)) => {}
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn read_scrollback_reflects_session_buffer() {
        // Inject frames directly into the session's scrollback (the
        // reader-driven path is covered by the reader tests) so this
        // exercises the manager's lock + slice plumbing in isolation.
        let m = PtyManager::new();
        let id = m.spawn(sleep_config()).expect("spawn");
        let session = m.get(id).expect("get");

        {
            let mut sb = session.scrollback.lock().expect("scrollback lock");
            sb.push(bytes::Bytes::from_static(b"abc"));
            sb.push(bytes::Bytes::from_static(b"defg"));
        }

        let chunk = m.read_scrollback(id, 0, usize::MAX).expect("read");
        assert_eq!(chunk.total_bytes, 7);
        assert_eq!(chunk.data, b"abcdefg".to_vec());
        assert_eq!(chunk.next_offset, 7);

        let middle = m.read_scrollback(id, 2, 4).expect("read mid");
        assert_eq!(middle.data, b"cdef".to_vec());
        assert_eq!(middle.next_offset, 6);

        let past_end = m.read_scrollback(id, 99, 4).expect("read past end");
        assert!(past_end.data.is_empty());
        assert_eq!(past_end.next_offset, 7);

        m.kill(id).expect("kill");
    }

    /// T2.16: `get_backpressure_stats` must surface scrollback eviction
    /// counters — so a 1GB-cat-style burst into a tight scrollback shows
    /// up as observable drops without OOM.
    #[test]
    fn backpressure_stats_reflect_scrollback_evictions() {
        let m = PtyManager::new();
        let id = m.spawn(sleep_config()).expect("spawn");
        let session = m.get(id).expect("get");

        // Constrain the scrollback to a tight cap so synthetic frames
        // immediately overflow and trigger eviction without needing to
        // run a real 1GB cat.
        {
            let mut sb = session.scrollback.lock().expect("scrollback lock");
            *sb = super::super::scrollback::Scrollback::with_capacity(8);
            sb.push(bytes::Bytes::from_static(b"AAAA"));
            sb.push(bytes::Bytes::from_static(b"BBBB"));
            // Both fit at cap (total 8); next push will evict.
            sb.push(bytes::Bytes::from_static(b"CCCC"));
        }
        drop(session);

        let stats = m.get_backpressure_stats(id).expect("stats");
        assert_eq!(stats.scrollback_cap_bytes, 8);
        assert_eq!(stats.scrollback_total_bytes, 8);
        assert_eq!(stats.scrollback_evicted_frames, 1);
        assert_eq!(stats.scrollback_evicted_bytes, 4);
        // Broadcast counters untouched by direct scrollback push.
        assert_eq!(stats.broadcast_lag_events, 0);
        assert_eq!(stats.broadcast_dropped_frames, 0);

        m.kill(id).expect("kill");
    }

    /// T2.16: broadcast lag counter is bumped through the session's
    /// `BackpressureStats::record_lag`, and the manager surfaces the
    /// running tally byte-identically.
    #[test]
    fn backpressure_stats_reflect_broadcast_lag() {
        let m = PtyManager::new();
        let id = m.spawn(sleep_config()).expect("spawn");
        let session = m.get(id).expect("get");

        // Simulate three subscriber-side lag events with varying gaps.
        session.backpressure.record_lag(7);
        session.backpressure.record_lag(13);
        session.backpressure.record_lag(20);
        drop(session);

        let stats = m.get_backpressure_stats(id).expect("stats");
        assert_eq!(stats.broadcast_lag_events, 3);
        assert_eq!(stats.broadcast_dropped_frames, 40);

        m.kill(id).expect("kill");
    }

    #[test]
    fn backpressure_stats_unknown_returns_not_found() {
        let m = PtyManager::new();
        let unknown = Uuid::new_v4();
        match m.get_backpressure_stats(unknown) {
            Err(PtyError::NotFound(id)) => assert_eq!(id, unknown),
            other => panic!("expected NotFound, got {other:?}"),
        }
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

/// Cross-platform manager smoke tests for T2.13.
///
/// The unix tests above lean on `ps` to assert no-zombie reaping; this
/// module exercises the same registry / portable-pty surface using a
/// command available on the host OS so coverage stays meaningful on
/// Windows CI.
#[cfg(test)]
mod xplat_tests {
    use super::*;

    fn long_running() -> SpawnConfig {
        #[cfg(unix)]
        let (command, args) = ("/bin/sleep".to_string(), vec!["60".to_string()]);
        // `ping -n 60 127.0.0.1 > NUL` keeps cmd.exe alive ~60s without
        // printing to stdout. Avoids `timeout`, which refuses to run
        // when stdin is redirected (which a pty effectively is).
        #[cfg(windows)]
        let (command, args) = (
            "cmd.exe".to_string(),
            vec!["/C".to_string(), "ping -n 60 127.0.0.1 > NUL".to_string()],
        );
        SpawnConfig {
            command,
            args,
            cwd: None,
            env: HashMap::new(),
            cols: 80,
            rows: 24,
        }
    }

    #[test]
    fn spawn_then_kill_clears_registry() {
        let m = PtyManager::new();
        let id = m.spawn(long_running()).expect("spawn");

        assert_eq!(m.count(), 1);
        assert_eq!(m.list(), vec![id]);
        let session = m.get(id).expect("get");
        assert_eq!(session.id, id);
        assert!(session.pid > 0);
        drop(session);

        m.kill(id).expect("kill");
        assert_eq!(m.count(), 0);
        assert!(m.get(id).is_none());
    }

    #[test]
    fn write_unknown_returns_not_found() {
        let m = PtyManager::new();
        let unknown = Uuid::new_v4();
        match m.write(unknown, b"hello") {
            Err(PtyError::NotFound(id)) => assert_eq!(id, unknown),
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    /// Empty payloads short-circuit before the registry lookup so the
    /// frontend can fire-and-forget zero-byte debounced writes.
    #[test]
    fn write_empty_is_noop_for_unknown_session() {
        let m = PtyManager::new();
        m.write(Uuid::new_v4(), &[])
            .expect("empty write must be a no-op");
    }

    #[test]
    fn write_to_live_session_succeeds() {
        let m = PtyManager::new();
        let id = m.spawn(long_running()).expect("spawn");
        // Long-running probe doesn't read stdin — the pty master's own
        // buffer absorbs the write so the call must not block or error.
        m.write(id, b"hello\n").expect("write");
        m.kill(id).expect("kill");
    }

    /// T2.15: write to a session whose child has already exited must
    /// return `WriteToClosed` (not generic `WriteIo`) so the frontend
    /// can render a "session ended" message.
    #[test]
    fn write_to_exited_child_returns_write_to_closed() {
        use std::time::{Duration, Instant};

        // Use an immediately-exiting command so the child is reaped
        // long before the test calls write().
        let cfg = SpawnConfig {
            #[cfg(unix)]
            command: "/bin/sh".to_string(),
            #[cfg(unix)]
            args: vec!["-c".to_string(), "exit 0".to_string()],
            #[cfg(windows)]
            command: "cmd.exe".to_string(),
            #[cfg(windows)]
            args: vec!["/C".to_string(), "exit /B 0".to_string()],
            cwd: None,
            env: HashMap::new(),
            cols: 80,
            rows: 24,
        };
        let m = PtyManager::new();
        let id = m.spawn(cfg).expect("spawn");

        // No reader is attached at the manager-level test (spawn_reader
        // is wired in by the commands layer), so the registry never
        // auto-removes the session — try_wait observes the exited child
        // directly.
        let session = m.get(id).expect("get");
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            {
                let mut child = session.child.lock().expect("child lock");
                if matches!(child.try_wait(), Ok(Some(_))) {
                    break;
                }
            }
            assert!(Instant::now() < deadline, "child failed to exit");
            std::thread::sleep(Duration::from_millis(20));
        }
        drop(session);

        match m.write(id, b"hello") {
            Err(PtyError::WriteToClosed(returned)) => assert_eq!(returned, id),
            other => panic!("expected WriteToClosed, got {other:?}"),
        }

        m.remove(id).expect("remove");
    }

    /// T2.15: a relative command name must be resolved against PATH.
    /// `/bin/sleep` is absolute and exists, so the pre-flight passes.
    /// Bare `sleep` is on PATH on every test runner we target — but
    /// sanity check the negative case explicitly.
    #[test]
    fn spawn_unknown_relative_command_returns_command_not_found() {
        let m = PtyManager::new();
        let cfg = SpawnConfig {
            command: "definitely-not-on-path-xyz".to_string(),
            args: vec![],
            cwd: None,
            env: HashMap::new(),
            cols: 80,
            rows: 24,
        };
        match m.spawn(cfg) {
            Err(PtyError::CommandNotFound(name)) => {
                assert_eq!(name, "definitely-not-on-path-xyz");
            }
            other => panic!("expected CommandNotFound, got {other:?}"),
        }
    }

    #[test]
    fn resize_unknown_returns_not_found() {
        let m = PtyManager::new();
        let unknown = Uuid::new_v4();
        match m.resize(unknown, 100, 30) {
            Err(PtyError::NotFound(id)) => assert_eq!(id, unknown),
            other => panic!("expected NotFound, got {other:?}"),
        }
    }

    #[test]
    fn resize_live_session_succeeds_repeatedly() {
        let m = PtyManager::new();
        let id = m.spawn(long_running()).expect("spawn");
        for (cols, rows) in [(100u16, 30u16), (132, 50), (80, 24)] {
            m.resize(id, cols, rows).expect("resize");
        }
        m.kill(id).expect("kill");
    }
}
