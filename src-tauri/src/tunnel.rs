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
//! Quick tunnels are ephemeral: Cloudflare can drop the connector and
//! refuse re-registration after a long idle period or transient edge
//! failure. cloudflared keeps the process alive in that state but its
//! `/ready` endpoint reports 0 ready connections — the public URL is a
//! black hole. A watchdog polls that endpoint and, if unhealthy for
//! several consecutive checks, kills the child so the outer loop can
//! respawn it with a fresh hostname.

use std::process::Stdio;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::watch;

use crate::pairing::{PairingState, TunnelState};

const HEALTHCHECK_INTERVAL: Duration = Duration::from_secs(5);
const HEALTHCHECK_GRACE: Duration = Duration::from_secs(20);
const HEALTHCHECK_FAILURE_THRESHOLD: u32 = 4;
const RESPAWN_BACKOFF: Duration = Duration::from_secs(5);

/// Start the quick tunnel and feed URL + status back into `PairingState`.
///
/// Drives an outer respawn loop: if cloudflared exits (organically or
/// after the watchdog kills it for being unhealthy) the loop sleeps for
/// `RESPAWN_BACKOFF` and tries again. The respawn loop exits only when
/// cloudflared is missing from PATH — there's no point retrying that.
pub fn spawn(app: AppHandle, port: u16) {
    tauri::async_runtime::spawn(async move {
        loop {
            match run(app.clone(), port).await {
                Ok(RunOutcome::Respawn) => {
                    tokio::time::sleep(RESPAWN_BACKOFF).await;
                }
                Ok(RunOutcome::Stop) => break,
                Err(error) => {
                    tracing::error!(target: "tunnel", %error, "tunnel task errored");
                    let state = app.state::<PairingState>();
                    state.set_tunnel(TunnelState::Failed {
                        reason: error.clone(),
                    });
                    tokio::time::sleep(RESPAWN_BACKOFF).await;
                }
            }
        }
    });
}

enum RunOutcome {
    /// cloudflared exited (cleanly, errored, or killed by the watchdog).
    /// Respawn after a short backoff.
    Respawn,
    /// Don't respawn — typically because cloudflared is not installed.
    Stop,
}

async fn run(app: AppHandle, port: u16) -> Result<RunOutcome, String> {
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
            return Ok(RunOutcome::Stop);
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

    let (metrics_tx, metrics_rx) = watch::channel::<Option<String>>(None);

    spawn_output_reader(app.clone(), stdout, "stdout", metrics_tx.clone());
    spawn_output_reader(app.clone(), stderr, "stderr", metrics_tx);

    let watchdog = tokio::spawn(watchdog_loop(metrics_rx));
    let watchdog_abort = watchdog.abort_handle();

    tokio::select! {
        result = child.wait() => {
            watchdog_abort.abort();
            match result {
                Ok(status) if status.success() => {
                    tracing::info!(target: "tunnel", "cloudflared exited cleanly");
                }
                Ok(status) => {
                    let reason = format!("cloudflared exited with {status}");
                    tracing::warn!(target: "tunnel", %reason);
                    let state = app.state::<PairingState>();
                    state.set_tunnel(TunnelState::Failed { reason });
                }
                Err(error) => return Err(format!("waiting on cloudflared failed: {error}")),
            }
        }
        _ = watchdog => {
            tracing::warn!(target: "tunnel", "watchdog tripped, restarting cloudflared");
            let state = app.state::<PairingState>();
            state.set_tunnel(TunnelState::Failed {
                reason: "tunnel lost connection to Cloudflare edge — restarting".to_string(),
            });
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
    }

    Ok(RunOutcome::Respawn)
}

/// Poll cloudflared's `/ready` endpoint. Returns once the tunnel has
/// been unhealthy for `HEALTHCHECK_FAILURE_THRESHOLD` consecutive
/// checks, signalling the caller (via `tokio::select!`) to kill the
/// child and respawn. Resolves only after the metrics URL has been
/// observed in the child's output.
async fn watchdog_loop(mut metrics_rx: watch::Receiver<Option<String>>) {
    let addr = loop {
        if let Some(addr) = metrics_rx.borrow_and_update().clone() {
            break addr;
        }
        if metrics_rx.changed().await.is_err() {
            return;
        }
    };

    tokio::time::sleep(HEALTHCHECK_GRACE).await;

    let client = match reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(error) => {
            tracing::warn!(target: "tunnel", %error, "watchdog client build failed; skipping health checks");
            std::future::pending::<()>().await;
            return;
        }
    };

    let url = format!("http://{addr}/ready");
    let mut failures: u32 = 0;

    loop {
        tokio::time::sleep(HEALTHCHECK_INTERVAL).await;
        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                failures = 0;
            }
            Ok(resp) => {
                failures += 1;
                tracing::debug!(target: "tunnel", status = %resp.status(), failures, "ready check unhealthy");
            }
            Err(error) => {
                failures += 1;
                tracing::debug!(target: "tunnel", %error, failures, "ready check error");
            }
        }
        if failures >= HEALTHCHECK_FAILURE_THRESHOLD {
            tracing::warn!(
                target: "tunnel",
                failures,
                threshold = HEALTHCHECK_FAILURE_THRESHOLD,
                "ready threshold exceeded"
            );
            return;
        }
    }
}

fn spawn_output_reader<R>(
    app: AppHandle,
    reader: R,
    label: &'static str,
    metrics_tx: watch::Sender<Option<String>>,
) where
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
                    if metrics_tx.borrow().is_none() {
                        if let Some(addr) = extract_metrics_addr(&line) {
                            tracing::debug!(target: "tunnel", %addr, source = label, "metrics endpoint discovered");
                            let _ = metrics_tx.send(Some(addr));
                        }
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

/// Extract the `host:port` of cloudflared's metrics server from a log
/// line like `Starting metrics server on 127.0.0.1:20241/metrics`.
fn extract_metrics_addr(line: &str) -> Option<String> {
    let idx = line.find("/metrics")?;
    let prefix = &line[..idx];
    let start = prefix.rfind(|c: char| c.is_whitespace())? + 1;
    let candidate = &prefix[start..idx];
    candidate.parse::<std::net::SocketAddr>().ok()?;
    Some(candidate.to_string())
}

#[cfg(test)]
mod tests {
    use super::{extract_metrics_addr, extract_trycloudflare_url};

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

    #[test]
    fn extracts_metrics_addr() {
        let line = "2026-05-15T08:08:09Z INF Starting metrics server on 127.0.0.1:20241/metrics";
        assert_eq!(
            extract_metrics_addr(line).as_deref(),
            Some("127.0.0.1:20241"),
        );
    }

    #[test]
    fn ignores_lines_without_metrics_addr() {
        assert!(extract_metrics_addr("nothing to see here").is_none());
        assert!(extract_metrics_addr("Starting metrics server on bogus/metrics").is_none());
    }
}
