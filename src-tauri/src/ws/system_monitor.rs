//! System monitor bridge (T18.5).
//!
//! A single background tokio task polls [`sysinfo`] on a fixed cadence
//! (default: 2 seconds) and broadcasts the resulting snapshot to every
//! subscribed WebSocket connection. Per-connection forwarders live in
//! [`super::pty_bridge`] — they pull from the broadcast channel and
//! ship `system_stats` frames through the same outbound mpsc that
//! carries PTY frames.
//!
//! Why broadcast (and not one ticker per connection):
//!   * sysinfo's [`System`] refresh is the expensive part — sampling
//!     it once per tick and fanning out is cheaper than N samplers
//!     stomping each other.
//!   * CPU usage is computed as a delta between two consecutive
//!     refreshes, so the **first** read after constructing `System`
//!     is always `0%`. A shared sampler that's been priming since boot
//!     means the very first frame a freshly-connected client receives
//!     already has a real CPU number — no per-connection warm-up.
//!
//! The broadcast channel is intentionally small (`BROADCAST_CAPACITY`):
//! stats are time-series, the only sensible recovery from a lag is to
//! drop old snapshots and emit the next one. We rely on
//! `broadcast::error::RecvError::Lagged` returning the count and let
//! the receiver loop continue without re-emitting stale data.

use std::time::Duration;

use sysinfo::{
    CpuRefreshKind, MemoryRefreshKind, RefreshKind, System, MINIMUM_CPU_UPDATE_INTERVAL,
};
use tokio::sync::broadcast;

use crate::pty::PtyManager;

use super::protocol::ServerMessage;

/// `PROJECT_PLAN` T18.5: "every 2 seconds".
pub const DEFAULT_INTERVAL: Duration = Duration::from_secs(2);

/// Broadcast lane width. Snapshots are produced once every
/// [`DEFAULT_INTERVAL`], so a lagging receiver only needs a handful of
/// slots before the next live frame overwrites the queue. 16 absorbs a
/// brief blocked-write hiccup (~30 s of buffered ticks) without
/// pretending we have unbounded memory.
const BROADCAST_CAPACITY: usize = 16;

/// Snapshot of host stats produced on each tick. Cloned into every
/// subscribed connection by the tokio broadcast channel.
#[derive(Clone, Debug, PartialEq)]
pub struct StatsSnapshot {
    pub cpu_percent: f32,
    pub ram_used_bytes: u64,
    pub ram_total_bytes: u64,
    pub pty_session_count: usize,
}

impl StatsSnapshot {
    /// Lift the snapshot into the wire-level `ServerMessage` variant.
    pub fn into_message(self) -> ServerMessage {
        ServerMessage::SystemStats {
            cpu_percent: self.cpu_percent,
            ram_used_bytes: self.ram_used_bytes,
            ram_total_bytes: self.ram_total_bytes,
            pty_session_count: self.pty_session_count,
        }
    }
}

/// Cheap-to-clone handle to the running monitor task. Each WebSocket
/// connection clones one of these (via [`SystemMonitorHandle::subscribe`])
/// to attach to the broadcast stream.
#[derive(Clone)]
pub struct SystemMonitorHandle {
    tx: broadcast::Sender<StatsSnapshot>,
}

impl SystemMonitorHandle {
    /// Open a new subscription to the live stats stream. The first
    /// frame the receiver sees is the *next* one published — buffered
    /// snapshots from before `subscribe` are not replayed (broadcast
    /// receivers start at the channel's current tail).
    pub fn subscribe(&self) -> broadcast::Receiver<StatsSnapshot> {
        self.tx.subscribe()
    }
}

/// Start the monitor on a Tauri-managed tokio task. The interval
/// matches `PROJECT_PLAN` T18.5 (2 seconds).
pub fn start(manager: PtyManager) -> SystemMonitorHandle {
    start_with_interval(manager, DEFAULT_INTERVAL)
}

/// Same as [`start`] but with a caller-supplied tick period. Test-only
/// callers use a sub-second period to keep `cargo test` snappy.
pub(crate) fn start_with_interval(manager: PtyManager, period: Duration) -> SystemMonitorHandle {
    let (tx, _) = broadcast::channel::<StatsSnapshot>(BROADCAST_CAPACITY);
    let publisher = tx.clone();
    tokio::spawn(run(manager, period, publisher));
    SystemMonitorHandle { tx }
}

fn refresh_kinds() -> RefreshKind {
    RefreshKind::nothing()
        .with_cpu(CpuRefreshKind::nothing().with_cpu_usage())
        .with_memory(MemoryRefreshKind::nothing().with_ram())
}

async fn run(manager: PtyManager, period: Duration, tx: broadcast::Sender<StatsSnapshot>) {
    let kinds = refresh_kinds();
    let mut system = System::new_with_specifics(kinds);

    // sysinfo computes CPU usage as a delta between two consecutive
    // refreshes; the first read after construction is always 0%. Prime
    // with one refresh + the documented minimum interval before
    // publishing — otherwise every reconnect would see a misleading
    // zero spike on the first frame.
    system.refresh_specifics(kinds);
    tokio::time::sleep(MINIMUM_CPU_UPDATE_INTERVAL).await;

    let mut ticker = tokio::time::interval(period);
    // If the task is starved (e.g. blocking work hogging the runtime)
    // and `tick().await` would fire several times back-to-back, just
    // skip the missed ticks — stats are a time-series, we want the
    // freshest reading, not a backlog.
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);

    loop {
        ticker.tick().await;
        system.refresh_specifics(kinds);
        let snapshot = StatsSnapshot {
            cpu_percent: system.global_cpu_usage(),
            ram_used_bytes: system.used_memory(),
            ram_total_bytes: system.total_memory(),
            pty_session_count: manager.count(),
        };
        // `send` errors only when the channel has zero receivers —
        // i.e. no PWA is currently connected. That's the common idle
        // case; swallow it and keep polling so a future connection
        // sees fresh data immediately.
        let _ = tx.send(snapshot);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A short tick keeps the test under a second while still letting
    /// the priming sleep complete inside the wait budget below.
    const TEST_INTERVAL: Duration = Duration::from_millis(50);

    #[tokio::test]
    async fn publishes_snapshots_on_interval() {
        let manager = PtyManager::new();
        let handle = start_with_interval(manager, TEST_INTERVAL);
        let mut rx = handle.subscribe();

        // Allow priming (MINIMUM_CPU_UPDATE_INTERVAL ~ 200ms on most
        // platforms) plus one tick. 2 seconds is generous so a noisy
        // CI host doesn't flake.
        let first = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("monitor did not publish a snapshot in time")
            .expect("monitor broadcast closed unexpectedly");

        assert!(first.ram_total_bytes > 0, "ram_total_bytes was zero");
        assert!(
            first.ram_used_bytes <= first.ram_total_bytes,
            "used ({}) > total ({})",
            first.ram_used_bytes,
            first.ram_total_bytes,
        );
        assert!(
            (0.0..=100.0).contains(&first.cpu_percent),
            "cpu_percent out of range: {}",
            first.cpu_percent,
        );
        assert_eq!(first.pty_session_count, 0);
    }

    #[tokio::test]
    async fn snapshot_into_message_carries_all_fields() {
        let snap = StatsSnapshot {
            cpu_percent: 7.25,
            ram_used_bytes: 42,
            ram_total_bytes: 100,
            pty_session_count: 2,
        };
        let json = serde_json::to_string(&snap.into_message()).expect("serialize");
        assert!(json.contains(r#""type":"system_stats""#), "got {json}");
        assert!(json.contains(r#""cpu_percent":7.25"#), "got {json}");
        assert!(json.contains(r#""ram_used_bytes":42"#), "got {json}");
        assert!(json.contains(r#""ram_total_bytes":100"#), "got {json}");
        assert!(json.contains(r#""pty_session_count":2"#), "got {json}");
    }

    /// A late subscriber should still see snapshots — the publisher
    /// must not stop when receivers come and go. The current behaviour
    /// is exactly this: `tx.send` returns `Err` when no receivers
    /// exist but the task ignores it and continues.
    #[tokio::test]
    async fn late_subscriber_still_receives_snapshots() {
        let manager = PtyManager::new();
        let handle = start_with_interval(manager, TEST_INTERVAL);
        // Let the publisher run for a beat with no subscribers.
        tokio::time::sleep(Duration::from_millis(300)).await;

        let mut rx = handle.subscribe();
        let next = tokio::time::timeout(Duration::from_secs(2), rx.recv())
            .await
            .expect("late subscriber timed out")
            .expect("broadcast closed");
        assert!(next.ram_total_bytes > 0);
    }
}
