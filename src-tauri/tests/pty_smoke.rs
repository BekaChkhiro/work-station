//! PTY smoke tests — integration tests against the real OS PTY layer.
//!
//! These tests spawn actual shell processes and exercise the full
//! PtyManager → PtySession → portable-pty stack end-to-end.
//!
//! # Platform support
//!
//! - Unix (Linux, macOS): uses `/bin/sh`
//! - Windows: uses `cmd.exe`

use std::collections::HashMap;
use std::time::Duration;
use tokio::time::{sleep, timeout};
use work_station_lib::pty::PtyManager;

/// Return the default shell for the current platform.
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

/// Return the current working directory as a string.
fn current_dir() -> String {
    std::env::current_dir()
        .unwrap()
        .to_string_lossy()
        .to_string()
}

/// Wait up to `max_ms` for the broadcast receiver to produce data,
/// returning all bytes received.
async fn collect_output(
    rx: &mut tokio::sync::broadcast::Receiver<bytes::Bytes>,
    max_ms: u64,
) -> Vec<u8> {
    let deadline = Duration::from_millis(max_ms);
    let mut output = Vec::new();

    let start = std::time::Instant::now();
    while start.elapsed() < deadline {
        match timeout(Duration::from_millis(50), rx.recv()).await {
            Ok(Ok(chunk)) => output.extend_from_slice(&chunk),
            Ok(Err(_)) => break,
            Err(_) => continue, // timeout on single recv, keep polling
        }
    }

    output
}

// ------------------------------------------------------------------
// 1. Basic spawn / list / info lifecycle
// ------------------------------------------------------------------

#[tokio::test]
async fn smoke_spawn_and_list() {
    let mgr = PtyManager::new();
    let id = mgr
        .spawn(current_dir().as_str(), default_shell(), HashMap::new(), 80, 24)
        .await
        .expect("spawn should succeed");

    let list = mgr.list().await;
    assert!(list.contains(&id), "new session should appear in list");

    let info = mgr.session_info(&id).await.expect("session should exist");
    assert_eq!(info.command, default_shell());
    assert_eq!(info.cols, 80);
    assert_eq!(info.rows, 24);

    mgr.kill(&id).await.unwrap().expect("kill should succeed");
    assert!(!mgr.contains(&id).await);
}

// ------------------------------------------------------------------
// 2. Write input and observe output
// ------------------------------------------------------------------

#[tokio::test]
async fn smoke_write_and_read_echo() {
    let mgr = PtyManager::new();
    let id = mgr
        .spawn(current_dir().as_str(), default_shell(), HashMap::new(), 80, 24)
        .await
        .expect("spawn should succeed");

    let mut rx = mgr.subscribe(&id).await.expect("subscribe should succeed");

    // Drain any initial banner / prompt output.
    let _ = collect_output(&mut rx, 500).await;

    // Write a distinctive command.
    let cmd = if cfg!(windows) {
        "echo SMOKETEST42\r\n"
    } else {
        "echo SMOKETEST42\n"
    };
    mgr.write(&id, cmd.as_bytes())
        .await
        .expect("write should succeed")
        .expect("write I/O should succeed");

    // Wait for the echoed command + output to arrive.
    let output = collect_output(&mut rx, 2000).await;
    let text = String::from_utf8_lossy(&output);
    assert!(
        text.contains("SMOKETEST42"),
        "output should contain the echoed text. got: {}",
        text
    );

    mgr.kill(&id).await.unwrap().expect("kill should succeed");
}

// ------------------------------------------------------------------
// 3. Resize
// ------------------------------------------------------------------

#[tokio::test]
async fn smoke_resize_updates_dimensions() {
    let mgr = PtyManager::new();
    let id = mgr
        .spawn(current_dir().as_str(), default_shell(), HashMap::new(), 80, 24)
        .await
        .expect("spawn should succeed");

    let result = mgr.resize(&id, 120, 40).await;
    assert!(result.is_some(), "resize should return Some for existing session");
    assert!(result.unwrap().is_ok(), "resize should succeed");

    let info = mgr.session_info(&id).await.unwrap();
    assert_eq!(info.cols, 120);
    assert_eq!(info.rows, 40);

    mgr.kill(&id).await.unwrap().expect("kill should succeed");
}

// ------------------------------------------------------------------
// 4. Scrollback accumulates output
// ------------------------------------------------------------------

#[tokio::test]
async fn smoke_scrollback_populated() {
    let mgr = PtyManager::new();
    let id = mgr
        .spawn(current_dir().as_str(), default_shell(), HashMap::new(), 80, 24)
        .await
        .expect("spawn should succeed");

    let mut rx = mgr.subscribe(&id).await.expect("subscribe should succeed");
    let _ = collect_output(&mut rx, 500).await;

    // Emit a known string.
    let cmd = if cfg!(windows) {
        "echo SCROLLBACK_MARKER\r\n"
    } else {
        "echo SCROLLBACK_MARKER\n"
    };
    mgr.write(&id, cmd.as_bytes())
        .await
        .unwrap()
        .unwrap();

    // Give the flusher task time to land data in scrollback.
    sleep(Duration::from_millis(200)).await;
    let _ = collect_output(&mut rx, 500).await;
    sleep(Duration::from_millis(200)).await;

    let chunks = mgr
        .get_scrollback(&id, 0, 1024)
        .await
        .expect("scrollback should be available");
    let combined: Vec<u8> = chunks.iter().flat_map(|b| b.iter().copied()).collect();
    let text = String::from_utf8_lossy(&combined);
    assert!(
        text.contains("SCROLLBACK_MARKER"),
        "scrollback should contain the marker. got: {}",
        text
    );

    mgr.kill(&id).await.unwrap().expect("kill should succeed");
}

// ------------------------------------------------------------------
// 5. Multiple sessions are independent
// ------------------------------------------------------------------

#[tokio::test]
async fn smoke_multiple_sessions_isolated() {
    let mgr = PtyManager::new();

    let id1 = mgr
        .spawn(current_dir().as_str(), default_shell(), HashMap::new(), 80, 24)
        .await
        .unwrap();
    let id2 = mgr
        .spawn(current_dir().as_str(), default_shell(), HashMap::new(), 80, 24)
        .await
        .unwrap();

    assert_ne!(id1, id2);

    let list = mgr.list_sessions().await;
    assert_eq!(list.len(), 2);

    // Kill one; the other survives.
    mgr.kill(&id1).await.unwrap().unwrap();
    assert!(!mgr.contains(&id1).await);
    assert!(mgr.contains(&id2).await);

    mgr.kill(&id2).await.unwrap().unwrap();
    assert!(mgr.list().await.is_empty());
}

// ------------------------------------------------------------------
// 6. Missing session returns None / no panic
// ------------------------------------------------------------------

#[tokio::test]
async fn smoke_operations_on_missing_session() {
    let mgr = PtyManager::new();
    let fake_id = uuid::Uuid::new_v4();

    assert!(!mgr.contains(&fake_id).await);
    assert!(mgr.session_info(&fake_id).await.is_none());
    assert!(mgr.write(&fake_id, b"x").await.is_none());
    assert!(mgr.resize(&fake_id, 80, 24).await.is_none());
    assert!(mgr.subscribe(&fake_id).await.is_none());
    assert!(mgr.get_scrollback(&fake_id, 0, 100).await.is_none());
    assert!(mgr.kill(&fake_id).await.is_none());
}

// ------------------------------------------------------------------
// 7. Kill cleans up child process
// ------------------------------------------------------------------

#[tokio::test]
async fn smoke_kill_cleans_up() {
    let mgr = PtyManager::new();
    let id = mgr
        .spawn(current_dir().as_str(), default_shell(), HashMap::new(), 80, 24)
        .await
        .unwrap();

    assert!(mgr.contains(&id).await);
    mgr.kill(&id).await.unwrap().unwrap();
    assert!(!mgr.contains(&id).await);
    assert!(mgr.list().await.is_empty());
}
