//! Cloudflare Tunnel manager — spawns `cloudflared tunnel --url ...` so
//! the mobile PWA (HTTPS Vercel origin) can reach the loopback-bound WS
//! bridge without mixed-content blocks or LAN reachability issues.
//!
//! On boot we attempt a "quick tunnel" (no auth, no DNS record) which
//! returns an ephemeral `https://<sub>.trycloudflare.com` hostname. The
//! hostname is published into [`crate::pairing::PairingState`] so the
//! Settings QR encodes a phone-reachable URL instead of a `127.0.0.1`
//! or LAN IP that the PWA can't talk to over HTTPS.
//!
//! The child process is owned by the spawned task — when the task ends
//! (app shutdown, drop), `kill_on_drop(true)` reaps the process.

use std::process::Stdio;

use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};

use crate::pairing::{PairingState, TunnelState};

/// Start the quick tunnel and feed URL + status back into `PairingState`.
///
/// Drives the process until it exits. The child is killed on drop via
/// `kill_on_drop(true)`.
pub fn spawn(app: AppHandle, port: u16) {
    tauri::async_runtime::spawn(async move {
        if let Err(error) = run(app.clone(), port).await {
            tracing::error!(target: "tunnel", %error, "tunnel task errored");
            let state = app.state::<PairingState>();
            state.set_tunnel(TunnelState::Failed {
                reason: error.clone(),
            });
        }
    });
}

async fn run(app: AppHandle, port: u16) -> Result<(), String> {
    {
        let state = app.state::<PairingState>();
        state.set_tunnel(TunnelState::Starting);
    }

    let mut cmd = Command::new("cloudflared");
    cmd.args([
        "tunnel",
        "--no-autoupdate",
        "--url",
        &format!("http://127.0.0.1:{port}"),
    ]);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    cmd.kill_on_drop(true);

    let mut child: Child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            let reason = if error.kind() == std::io::ErrorKind::NotFound {
                "cloudflared not installed (try: brew install cloudflared)".to_string()
            } else {
                format!("failed to spawn cloudflared: {error}")
            };
            tracing::warn!(target: "tunnel", %reason, "cloudflared unavailable");
            let state = app.state::<PairingState>();
            state.set_tunnel(TunnelState::Unavailable { reason });
            return Ok(());
        }
    };

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "child stdout unavailable".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "child stderr unavailable".to_string())?;

    spawn_url_reader(app.clone(), stdout, "stdout");
    spawn_url_reader(app.clone(), stderr, "stderr");

    match child.wait().await {
        Ok(status) if status.success() => {
            tracing::info!(target: "tunnel", "cloudflared exited cleanly");
        }
        Ok(status) => {
            let reason = format!("cloudflared exited with {status}");
            tracing::warn!(target: "tunnel", %reason);
            let state = app.state::<PairingState>();
            state.set_tunnel(TunnelState::Failed { reason });
        }
        Err(error) => {
            return Err(format!("waiting on cloudflared failed: {error}"));
        }
    }
    Ok(())
}

fn spawn_url_reader<R>(app: AppHandle, reader: R, label: &'static str)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        loop {
            match lines.next_line().await {
                Ok(Some(line)) => {
                    if let Some(url) = extract_trycloudflare_url(&line) {
                        tracing::info!(target: "tunnel", %url, source = label, "quick tunnel ready");
                        let state = app.state::<PairingState>();
                        state.set_tunnel(TunnelState::Running { url });
                    }
                }
                Ok(None) => break,
                Err(error) => {
                    tracing::debug!(target: "tunnel", %error, source = label, "tunnel reader error");
                    break;
                }
            }
        }
    });
}

/// Extract the first `https://*.trycloudflare.com` URL on a line.
/// cloudflared's "Your quick Tunnel has been created" banner emits the
/// URL on its own line surrounded by box-drawing characters, but the
/// extraction is robust to leading log timestamps and trailing noise.
fn extract_trycloudflare_url(line: &str) -> Option<String> {
    let needle = ".trycloudflare.com";
    let idx = line.find(needle)?;
    let start = line[..idx].rfind("https://")?;
    let end = idx + needle.len();
    Some(line[start..end].to_string())
}

#[cfg(test)]
mod tests {
    use super::extract_trycloudflare_url;

    #[test]
    fn extracts_url_from_banner_line() {
        let line =
            "2026-05-14 INF |  https://big-cat-9999.trycloudflare.com                          |";
        assert_eq!(
            extract_trycloudflare_url(line).as_deref(),
            Some("https://big-cat-9999.trycloudflare.com"),
        );
    }

    #[test]
    fn ignores_lines_without_url() {
        assert!(extract_trycloudflare_url("starting metrics server").is_none());
    }

    #[test]
    fn ignores_http_scheme() {
        let line = "http://example.trycloudflare.com fake";
        assert!(extract_trycloudflare_url(line).is_none());
    }
}
