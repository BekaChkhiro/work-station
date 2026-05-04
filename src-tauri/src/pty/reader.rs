//! Per-session PTY reader with output coalescing (T2.4).
//!
//! `spawn_reader` wires up two halves around a single PTY session:
//!
//!   * a `std::thread` doing blocking 64KB reads off the cloned master
//!     reader, pushing raw chunks into a bounded `tokio::mpsc`;
//!   * an async `tokio::spawn`ed coalescer that flushes the accumulated
//!     bytes either when ≥4KB have piled up or after a ~12ms timer.
//!
//! Coalescing is what keeps `cat huge.log` from drowning the IPC bus —
//! one ~4KB `Bytes` frame per flush instead of hundreds of tiny ones.
//!
//! On EOF the coalescer flushes any tail bytes, removes the session
//! from the registry (so it isn't dangling), and exits. Dropping the
//! task drops its broadcast `Sender` clone, which lets the channel
//! close once the session itself is gone, signalling subscribers.

#![allow(dead_code)] // call site lands in T2.5 (pty_spawn).

use std::io::Read;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::{Bytes, BytesMut};
use tokio::sync::{broadcast, mpsc};
use uuid::Uuid;

use super::manager::PtyManager;
use super::scrollback::Scrollback;
use super::session::PtySession;

/// Size at which the coalescer flushes early. One IPC frame's worth so
/// `cat huge.log` lands in O(N/4KB) sends instead of O(N).
const FLUSH_BYTES: usize = 4 * 1024;

/// Time-based flush window. Mid-range of the 8–16ms target so latency
/// stays sub-frame at 60Hz while still amortising small writes.
const FLUSH_INTERVAL: Duration = Duration::from_millis(12);

/// Read buffer for the blocking reader thread; matches the typical
/// max per-iteration yield from a Linux pty master.
const READ_BUF_BYTES: usize = 64 * 1024;

/// Bounded backpressure between the blocking reader and the async
/// coalescer. Small enough that a slow coalescer applies pressure on
/// the reader, large enough to absorb bursty child output.
const RAW_CHANNEL_CAPACITY: usize = 32;

/// Spawn the per-session reader pipeline.
///
/// Holds neither the session nor the manager any longer than needed:
///   * the blocking thread keeps only the cloned `Read` and the mpsc
///     `Sender`;
///   * the coalescer task keeps a `broadcast::Sender<Bytes>` clone and
///     a `PtyManager` clone (cheap `Arc`).
///
/// That means an external `manager.kill` can drop the registry's
/// `Arc<PtySession>` without the reader holding the session alive
/// indefinitely.
pub(crate) fn spawn_reader(manager: PtyManager, session: &PtySession) {
    let session_id = session.id;
    let pid = session.pid;
    let output_tx = session.output_tx.clone();
    // Cloning the Arc — not the session — so a `manager.kill` can drop
    // the session while the coalescer still has somewhere to deposit its
    // last frame. The session's own clone goes away on drop, leaving
    // the coalescer's clone as the last reference until it exits.
    let scrollback = Arc::clone(&session.scrollback);

    let reader = {
        let Ok(guard) = session.master.lock() else {
            tracing::warn!(
                session_id = %session_id,
                pid,
                "pty reader: master mutex poisoned; not starting reader",
            );
            return;
        };
        match guard.try_clone_reader() {
            Ok(r) => r,
            Err(error) => {
                tracing::warn!(
                    session_id = %session_id,
                    pid,
                    %error,
                    "pty reader: try_clone_reader failed; not starting reader",
                );
                return;
            }
        }
    };

    let (raw_tx, raw_rx) = mpsc::channel::<Bytes>(RAW_CHANNEL_CAPACITY);

    std::thread::Builder::new()
        .name(format!("pty-read-{session_id}"))
        .spawn(move || run_blocking_reader(session_id, pid, reader, raw_tx))
        .expect("spawn pty reader thread");

    tokio::spawn(run_coalescer(
        session_id, pid, raw_rx, output_tx, scrollback, manager,
    ));
}

fn run_blocking_reader(
    session_id: Uuid,
    pid: u32,
    mut reader: Box<dyn Read + Send>,
    tx: mpsc::Sender<Bytes>,
) {
    let mut buf = vec![0u8; READ_BUF_BYTES];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => {
                tracing::debug!(
                    session_id = %session_id,
                    pid,
                    "pty reader: EOF on master",
                );
                return;
            }
            Ok(n) => {
                let chunk = Bytes::copy_from_slice(&buf[..n]);
                if tx.blocking_send(chunk).is_err() {
                    tracing::debug!(
                        session_id = %session_id,
                        pid,
                        "pty reader: coalescer dropped; exiting",
                    );
                    return;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(error) => {
                tracing::warn!(
                    session_id = %session_id,
                    pid,
                    %error,
                    "pty reader: read error; exiting",
                );
                return;
            }
        }
    }
}

enum Event {
    Chunk(Option<Bytes>),
    Timer,
}

async fn run_coalescer(
    session_id: Uuid,
    pid: u32,
    mut raw_rx: mpsc::Receiver<Bytes>,
    output_tx: broadcast::Sender<Bytes>,
    scrollback: Arc<Mutex<Scrollback>>,
    manager: PtyManager,
) {
    let mut buf = BytesMut::with_capacity(FLUSH_BYTES * 2);
    let mut deadline: Option<Instant> = None;

    loop {
        let event = match deadline {
            Some(when) => {
                let timeout = when.saturating_duration_since(Instant::now());
                tokio::select! {
                    biased;
                    chunk = raw_rx.recv() => Event::Chunk(chunk),
                    () = tokio::time::sleep(timeout) => Event::Timer,
                }
            }
            None => Event::Chunk(raw_rx.recv().await),
        };

        match event {
            Event::Chunk(Some(chunk)) => {
                buf.extend_from_slice(&chunk);
                if deadline.is_none() {
                    deadline = Some(Instant::now() + FLUSH_INTERVAL);
                }
                if buf.len() >= FLUSH_BYTES {
                    flush(session_id, &mut buf, &output_tx, &scrollback, "size");
                    deadline = None;
                }
            }
            Event::Chunk(None) => {
                if !buf.is_empty() {
                    flush(session_id, &mut buf, &output_tx, &scrollback, "eof");
                }
                tracing::info!(
                    session_id = %session_id,
                    pid,
                    "pty reader: session EOF; removing from registry",
                );
                // Child has already exited — `remove` skips the
                // SIGTERM/SIGKILL dance that `kill` performs so this
                // stays cheap inside the tokio coalescer.
                if let Err(error) = manager.remove(session_id) {
                    tracing::debug!(
                        session_id = %session_id,
                        pid,
                        %error,
                        "pty reader: remove on EOF: session already gone",
                    );
                }
                return;
            }
            Event::Timer => {
                if !buf.is_empty() {
                    flush(session_id, &mut buf, &output_tx, &scrollback, "timer");
                }
                deadline = None;
            }
        }
    }
}

fn flush(
    session_id: Uuid,
    buf: &mut BytesMut,
    output_tx: &broadcast::Sender<Bytes>,
    scrollback: &Mutex<Scrollback>,
    reason: &'static str,
) {
    let frame = buf.split().freeze();
    let bytes = frame.len();
    tracing::trace!(
        session_id = %session_id,
        bytes,
        reason,
        "pty reader: flush",
    );

    // Tap the scrollback first — `Bytes::clone` is a refcount bump, no
    // copy. A poisoned mutex shouldn't kill the broadcast path, so we
    // log and keep going; the live stream still reaches subscribers.
    //
    // Lock-hold is one push and is bounded; T2.10's `read_scrollback`
    // can hold this same mutex for a worst-case ~4MiB copy, so flushes
    // back up briefly while a frontend replay is in flight. Acceptable
    // for personal-use scope; revisit if reader stalls show up.
    match scrollback.lock() {
        Ok(mut sb) => sb.push(frame.clone()),
        Err(error) => tracing::warn!(
            session_id = %session_id,
            %error,
            "pty reader: scrollback mutex poisoned; frame skipped",
        ),
    }

    // Err = no active subscribers; routine and not worth logging.
    let _ = output_tx.send(frame);
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use crate::pty::manager::SpawnConfig;
    use std::collections::HashMap;
    use tokio::sync::broadcast::error::RecvError;

    fn spawn_config(command: &str, args: &[&str]) -> SpawnConfig {
        SpawnConfig {
            command: command.to_string(),
            args: args.iter().map(|s| (*s).to_string()).collect(),
            cwd: None,
            env: HashMap::new(),
            cols: 80,
            rows: 24,
        }
    }

    async fn drain(rx: &mut broadcast::Receiver<Bytes>) -> Vec<Bytes> {
        let mut frames = Vec::new();
        loop {
            match rx.recv().await {
                Ok(frame) => frames.push(frame),
                Err(RecvError::Closed) => return frames,
                // Test config wouldn't normally lag; just keep going.
                Err(RecvError::Lagged(_)) => {}
            }
        }
    }

    /// On EOF the reader must flush trailing bytes, drop the session
    /// from the registry, and close the broadcast channel.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn streams_output_and_clears_registry_on_eof() {
        let m = PtyManager::new();
        let id = m.spawn(spawn_config("/bin/echo", &["hi"])).expect("spawn");
        let session = m.get(id).expect("get");
        let mut rx = session.output_tx.subscribe();
        spawn_reader(m.clone(), &session);
        drop(session);

        let frames = drain(&mut rx).await;
        let combined: Vec<u8> = frames.iter().flat_map(|b| b.iter().copied()).collect();
        let text = String::from_utf8_lossy(&combined);
        assert!(text.contains("hi"), "expected 'hi' in output, got {text:?}");

        // EOF path runs `manager.kill`; channel close means the
        // coalescer task already exited, so the kill has happened.
        assert_eq!(m.count(), 0, "session should be removed on EOF");
    }

    /// `seq 1 10000` emits ~48KB. With 4KB-size coalescing we expect
    /// the total to come through in well under a hundred frames.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn coalesces_burst_output() {
        let m = PtyManager::new();
        let id = m
            .spawn(spawn_config("/usr/bin/seq", &["1", "10000"]))
            .expect("spawn");
        let session = m.get(id).expect("get");
        let mut rx = session.output_tx.subscribe();
        spawn_reader(m.clone(), &session);
        drop(session);

        let frames = drain(&mut rx).await;
        let total: usize = frames.iter().map(Bytes::len).sum();

        // `seq 1 10000` produces 48894 bytes; pty cooked-mode `\n`->`\r\n`
        // expansion can roughly double that, so accept a wide range.
        assert!(
            (40_000..=120_000).contains(&total),
            "expected ~48–96KB total, got {total}",
        );
        assert!(
            frames.len() < 200,
            "coalescing should keep frame count modest, got {}",
            frames.len(),
        );
        assert_eq!(m.count(), 0, "session should be removed on EOF");
    }

    /// T2.9 acceptance: every frame the reader broadcasts is also
    /// stored in the per-session scrollback, byte-for-byte.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn scrollback_captures_broadcast_frames() {
        let m = PtyManager::new();
        let id = m
            .spawn(spawn_config("/usr/bin/seq", &["1", "200"]))
            .expect("spawn");
        let session = m.get(id).expect("get");
        // Hold a scrollback handle independent of the session — drop
        // the session before draining so the broadcast channel can
        // close (otherwise drain hangs on the session's own sender).
        let scrollback_handle = Arc::clone(&session.scrollback);
        let mut rx = session.output_tx.subscribe();
        spawn_reader(m.clone(), &session);
        drop(session);

        let frames = drain(&mut rx).await;
        let broadcast_total: usize = frames.iter().map(Bytes::len).sum();
        assert!(broadcast_total > 0, "expected non-empty output");

        let sb = scrollback_handle.lock().expect("scrollback lock");
        assert_eq!(
            sb.total_bytes(),
            broadcast_total,
            "scrollback total must match broadcast total",
        );
        assert_eq!(
            sb.frame_count(),
            frames.len(),
            "scrollback should contain one entry per broadcast frame",
        );
        let scrollback_bytes: Vec<u8> = sb.iter().flat_map(|b| b.iter().copied()).collect();
        let broadcast_bytes: Vec<u8> = frames.iter().flat_map(|b| b.iter().copied()).collect();
        assert_eq!(
            scrollback_bytes, broadcast_bytes,
            "scrollback bytes must match broadcast bytes",
        );
    }

    /// T2.9 acceptance: with a tight cap, scrollback total stays
    /// bounded and the oldest output is dropped while live broadcast
    /// is unaffected.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn scrollback_cap_bounds_memory_under_burst() {
        // Constrain to 8 KiB so a `seq 1 10000` burst (~50KB+) forces
        // multiple eviction passes during the run.
        const CAP: usize = 8 * 1024;

        let m = PtyManager::new();
        let id = m
            .spawn(spawn_config("/usr/bin/seq", &["1", "10000"]))
            .expect("spawn");
        let session = m.get(id).expect("get");
        // Replace the default 4MB scrollback with a tight cap before
        // the reader starts pushing into it.
        {
            let mut sb = session.scrollback.lock().expect("scrollback lock");
            *sb = Scrollback::with_capacity(CAP);
        }
        let scrollback_handle = Arc::clone(&session.scrollback);
        let mut rx = session.output_tx.subscribe();
        spawn_reader(m.clone(), &session);
        drop(session);

        let frames = drain(&mut rx).await;
        let broadcast_total: usize = frames.iter().map(Bytes::len).sum();
        assert!(
            broadcast_total > CAP,
            "test pre-condition: broadcast {broadcast_total} should exceed cap {CAP}",
        );

        let sb = scrollback_handle.lock().expect("scrollback lock");
        assert!(
            sb.total_bytes() <= CAP,
            "scrollback {} exceeded cap {CAP}",
            sb.total_bytes(),
        );
        assert!(!sb.is_empty(), "scrollback must retain a tail of output");

        // The retained tail is a suffix of the broadcast stream — i.e.
        // the most-recent N bytes, byte-identical to the broadcast.
        let broadcast_bytes: Vec<u8> = frames.iter().flat_map(|b| b.iter().copied()).collect();
        let scrollback_bytes: Vec<u8> = sb.iter().flat_map(|b| b.iter().copied()).collect();
        assert!(
            broadcast_bytes.ends_with(&scrollback_bytes),
            "scrollback should be a contiguous tail of the broadcast",
        );
    }
}

/// Cross-platform reader tests for T2.13.
///
/// The unix-only tests above lean on `/usr/bin/seq` and `/bin/echo`;
/// this module uses `cmd.exe /C echo` on Windows so the reader pipeline
/// (blocking thread → coalescer → broadcast → registry cleanup on EOF)
/// is exercised on Windows CI as well.
#[cfg(test)]
mod xplat_tests {
    use super::*;
    use crate::pty::manager::SpawnConfig;
    use std::collections::HashMap;
    use tokio::sync::broadcast::error::RecvError;

    fn echo_then_exit(text: &str) -> SpawnConfig {
        #[cfg(unix)]
        let (command, args) = ("/bin/echo".to_string(), vec![text.to_string()]);
        #[cfg(windows)]
        let (command, args) = (
            "cmd.exe".to_string(),
            vec!["/C".to_string(), format!("echo {text}")],
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

    async fn drain(rx: &mut broadcast::Receiver<Bytes>) -> Vec<Bytes> {
        let mut frames = Vec::new();
        loop {
            match rx.recv().await {
                Ok(frame) => frames.push(frame),
                Err(RecvError::Closed) => return frames,
                Err(RecvError::Lagged(_)) => {}
            }
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn streams_output_and_clears_registry_on_eof() {
        let m = PtyManager::new();
        let id = m.spawn(echo_then_exit("xplat-marker")).expect("spawn echo");
        let session = m.get(id).expect("get session");
        let mut rx = session.output_tx.subscribe();
        spawn_reader(m.clone(), &session);
        drop(session);

        let frames = drain(&mut rx).await;
        let combined: Vec<u8> = frames.iter().flat_map(|b| b.iter().copied()).collect();
        let text = String::from_utf8_lossy(&combined);
        assert!(
            text.contains("xplat-marker"),
            "expected 'xplat-marker' in output, got {text:?}",
        );
        assert_eq!(m.count(), 0, "session should be removed on EOF");
    }
}
