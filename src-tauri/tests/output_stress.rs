//! Output stress test — validates backend throughput and memory bounds
//! under high-volume PTY output.
//!
//! Simulates the equivalent of `cat large.log` (default 100 MiB,
//! configurable up to 1 GiB via env) and asserts:
//!
//! 1. All bytes are received by the broadcast consumer.
//! 2. Throughput stays above a minimum threshold (default 5 MB/s).
//! 3. Scrollback buffer is capped at its configured limit (default 1 MiB).
//!
//! # Environment variables
//!
//! | Variable | Default | Description |
//! |----------|---------|-------------|
//! | `STRESS_TEST_SIZE_MB` | 100 | Output size in MiB |
//! | `STRESS_TEST_MIN_MBPS` | 5.0 | Minimum acceptable throughput |
//!
//! To run the full 1 GB test locally:
//! ```bash
//! STRESS_TEST_SIZE_MB=1024 cargo test --test output_stress -- --nocapture
//! ```

use std::collections::HashMap;
use std::io::Write;
use std::time::{Duration, Instant};
use tokio::time::timeout;
use work_station_lib::pty::PtyManager;
use work_station_lib::pty::ScrollbackBuffer;

/// Repeating byte pattern used to fill the stress file.
const PATTERN: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

fn default_shell() -> &'static str {
    #[cfg(windows)]
    {
        "cmd.exe"
    }
    #[cfg(not(windows))]
    {
        "/bin/sh"
    }
}

fn current_dir() -> String {
    std::env::current_dir()
        .unwrap()
        .to_string_lossy()
        .to_string()
}

/// Create a temporary file filled with `PATTERN` repeated to `size_bytes`.
fn create_stress_file(size_bytes: usize) -> std::path::PathBuf {
    let tmp = std::env::temp_dir();
    let name = format!("workstation_stress_{}.bin", uuid::Uuid::new_v4());
    let path = tmp.join(&name);

    let mut file = std::fs::File::create(&path).expect("create temp file");
    let mut written = 0usize;
    while written < size_bytes {
        let chunk_len = PATTERN.len().min(size_bytes - written);
        file.write_all(&PATTERN[..chunk_len]).expect("write temp file");
        written += chunk_len;
    }
    file.flush().expect("flush temp file");
    path
}

/// Collect all broadcast output for a session, returning the total bytes
/// received and the elapsed time from the first chunk.
async fn collect_output(
    rx: &mut tokio::sync::broadcast::Receiver<bytes::Bytes>,
    expected_bytes: usize,
    timeout_sec: u64,
) -> (Vec<u8>, Duration) {
    let deadline = Duration::from_secs(timeout_sec);
    let mut output = Vec::with_capacity(expected_bytes);
    let start = Instant::now();

    while output.len() < expected_bytes {
        let remaining = deadline.saturating_sub(start.elapsed());
        if remaining.is_zero() {
            break;
        }

        match timeout(remaining, rx.recv()).await {
            Ok(Ok(chunk)) => output.extend_from_slice(&chunk),
            Ok(Err(_)) => break, // channel closed
            Err(_) => break,     // deadline reached
        }
    }

    (output, start.elapsed())
}

// ------------------------------------------------------------------
// Stress test
// ------------------------------------------------------------------

#[tokio::test]
async fn stress_high_volume_output() {
    let size_mb: usize = std::env::var("STRESS_TEST_SIZE_MB")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(100);
    let min_mbps: f64 = std::env::var("STRESS_TEST_MIN_MBPS")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(5.0);

    let total_bytes = size_mb * 1024 * 1024;
    let timeout_sec = (size_mb as u64).max(30); // at least 30 s, 1 s per MB

    // 1. Create the stress file.
    let file_path = create_stress_file(total_bytes);

    // 2. Spawn a shell in the temp directory so relative paths work.
    let mgr = PtyManager::new();
    let shell = default_shell();
    let cwd = file_path.parent().unwrap().to_string_lossy().to_string();

    let id = mgr
        .spawn(&cwd, shell, HashMap::new(), 80, 24)
        .await
        .expect("spawn should succeed");

    let mut rx = mgr.subscribe(&id).await.expect("subscribe should succeed");

    // Drain any initial banner / prompt output.
    tokio::time::sleep(Duration::from_millis(300)).await;
    let _ = collect_output(&mut rx, 1024 * 1024, 2).await;

    // 3. Start the cat command.
    let cat_cmd = if cfg!(windows) {
        format!("type {}\r\n", file_path.file_name().unwrap().to_string_lossy())
    } else {
        format!("cat {}\n", file_path.file_name().unwrap().to_string_lossy())
    };

    mgr.write(&id, cat_cmd.as_bytes())
        .await
        .unwrap()
        .unwrap();

    // 4. Collect all output.
    let (received, elapsed) = collect_output(&mut rx, total_bytes, timeout_sec).await;

    // 5. Gather scrollback stats before killing the session.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let scrollback = mgr.get_scrollback(&id, 0, usize::MAX).await.unwrap_or_default();
    let scrollback_bytes: usize = scrollback.iter().map(|b| b.len()).sum();

    // 6. Cleanup.
    let _ = mgr.kill(&id).await;
    let _ = std::fs::remove_file(&file_path);

    let received_bytes = received.len();
    let throughput_mbps = (received_bytes as f64 / elapsed.as_secs_f64()) / (1024.0 * 1024.0);

    // Print metrics for `--nocapture` runs.
    println!(
        "stress test: size={}MB received={}B elapsed={:.2}s throughput={:.1}MB/s scrollback={}B",
        size_mb,
        received_bytes,
        elapsed.as_secs_f64(),
        throughput_mbps,
        scrollback_bytes,
    );

    // 7. Assertions.

    // We should have received at least the file contents.  Shell echo of the
    // command + the trailing prompt add overhead, so we only check the lower
    // bound (the file data itself must be present).
    assert!(
        received_bytes >= total_bytes,
        "expected at least {} bytes of file data, got {} (throughput {:.1} MB/s)",
        total_bytes,
        received_bytes,
        throughput_mbps
    );

    assert!(
        throughput_mbps >= min_mbps,
        "throughput too low: {:.1} MB/s (minimum {} MB/s)",
        throughput_mbps,
        min_mbps
    );

    // Scrollback must be bounded.  Because the flusher coalesces output in
    // ~16 ms ticks, a single chunk can temporarily exceed the 1 MiB cap
    // (the buffer always keeps at least the newest chunk).  We allow a
    // generous headroom of 2× the expected per-tick chunk size.
    let max_scrollback = ScrollbackBuffer::default().max_bytes();
    let bytes_per_tick = (throughput_mbps * 1024.0 * 1024.0 * 0.016) as usize;
    let allowed_headroom = (bytes_per_tick * 2).max(65536);
    assert!(
        scrollback_bytes <= max_scrollback + allowed_headroom,
        "scrollback unbounded: {} bytes (soft limit ~{} bytes, headroom {} bytes)",
        scrollback_bytes,
        max_scrollback,
        allowed_headroom
    );
}

// ------------------------------------------------------------------
// Burst test — rapid small writes (simulates verbose build output)
// ------------------------------------------------------------------

#[tokio::test]
async fn stress_rapid_small_lines() {
    let line_count = 10_000;
    let mgr = PtyManager::new();
    let id = mgr
        .spawn(current_dir().as_str(), default_shell(), HashMap::new(), 80, 24)
        .await
        .expect("spawn should succeed");

    let mut rx = mgr.subscribe(&id).await.expect("subscribe should succeed");
    tokio::time::sleep(Duration::from_millis(300)).await;
    let _ = collect_output(&mut rx, 1024 * 1024, 2).await;

    // Generate many short lines quickly.
    let cmd = if cfg!(windows) {
        format!("for /L %i in (1,1,{}) do @echo BURST_LINE_%i\r\n", line_count)
    } else {
        format!("for i in $(seq 1 {}); do echo BURST_LINE_$i; done\n", line_count)
    };

    let start = Instant::now();
    mgr.write(&id, cmd.as_bytes()).await.unwrap().unwrap();

    // Collect until we see the last expected line or time out.
    let deadline = Duration::from_secs(30);
    let mut received = Vec::new();
    let mut saw_last = false;

    while start.elapsed() < deadline {
        match timeout(Duration::from_millis(500), rx.recv()).await {
            Ok(Ok(chunk)) => {
                received.extend_from_slice(&chunk);
                if received.windows(20).any(|w| w == b"BURST_LINE_10000") {
                    saw_last = true;
                    break;
                }
            }
            Ok(Err(_)) => break,
            Err(_) => continue,
        }
    }

    let elapsed = start.elapsed();
    let _ = mgr.kill(&id).await;

    let text = String::from_utf8_lossy(&received);
    let matched = text.matches("BURST_LINE_").count();

    println!(
        "burst test: lines={} matched={} elapsed={:.2}s",
        line_count, matched, elapsed.as_secs_f64()
    );

    assert!(
        saw_last || matched >= line_count,
        "expected at least {} burst lines, found {} (elapsed {:.2}s)",
        line_count,
        matched,
        elapsed.as_secs_f64()
    );
}
