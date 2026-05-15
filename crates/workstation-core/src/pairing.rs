//! Tauri-managed state holding the WS server's bound address + token
//! and (optionally) the Cloudflare quick-tunnel URL exposing it.
//!
//! Populated during boot:
//!   * `set_bridge` once `ws::init` succeeds, carrying the bound socket
//!     and the bearer token.
//!   * `set_tunnel` is called repeatedly by the tunnel task as it moves
//!     through `Starting → Running` (or `Unavailable`/`Failed`).
//!
//! Read by `get_pairing_info` to render the Settings QR. If either half
//! is missing (bridge failed, tunnel not yet up) the command returns
//! whatever's present so the UI can degrade.

use std::net::SocketAddr;
use std::sync::Mutex;

#[derive(Default)]
pub struct PairingState {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    bridge: Option<Bridge>,
    tunnel: TunnelState,
}

struct Bridge {
    addr: SocketAddr,
    token: String,
}

#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum TunnelState {
    /// The tunnel has not been started yet (e.g. when the bridge isn't
    /// running).
    #[default]
    Disabled,
    /// Spawning `cloudflared`, no public URL yet.
    Starting,
    /// `cloudflared` is up and the quick tunnel resolved to `url`.
    Running { url: String },
    /// `cloudflared` exited or errored after spawning. Includes the
    /// stderr fragment so the UI can surface it.
    Failed { reason: String },
    /// The cloudflared binary couldn't be spawned (typically missing on
    /// PATH). `reason` includes an install hint.
    Unavailable { reason: String },
}

impl PairingState {
    pub fn set_bridge(&self, addr: SocketAddr, token: String) {
        let mut guard = self.inner.lock().expect("pairing state poisoned");
        guard.bridge = Some(Bridge { addr, token });
    }

    pub fn set_tunnel(&self, tunnel: TunnelState) {
        let mut guard = self.inner.lock().expect("pairing state poisoned");
        guard.tunnel = tunnel;
    }

    pub fn addr(&self) -> Option<SocketAddr> {
        let guard = self.inner.lock().ok()?;
        guard.bridge.as_ref().map(|b| b.addr)
    }

    pub fn token(&self) -> Option<String> {
        let guard = self.inner.lock().ok()?;
        guard.bridge.as_ref().map(|b| b.token.clone())
    }

    pub fn tunnel(&self) -> TunnelState {
        let guard = self.inner.lock().expect("pairing state poisoned");
        guard.tunnel.clone()
    }
}
