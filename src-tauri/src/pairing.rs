//! Tauri-managed state holding the WS server's bound address + token
//! so the `get_pairing_info` command can serve a QR payload without
//! re-reading the SQLite row or re-binding the listener.
//!
//! The state is populated once during boot (in `lib.rs`) after
//! `ws::init` succeeds; if the bridge fails to bind, the state stays
//! empty and the command returns `None` — the UI renders a
//! "bridge not running" placeholder.

use std::net::SocketAddr;
use std::sync::Mutex;

#[derive(Default)]
pub struct PairingState {
    inner: Mutex<Option<Inner>>,
}

struct Inner {
    addr: SocketAddr,
    token: String,
}

impl PairingState {
    pub fn set(&self, addr: SocketAddr, token: String) {
        let mut guard = self.inner.lock().expect("pairing state poisoned");
        *guard = Some(Inner { addr, token });
    }

    pub fn addr(&self) -> Option<SocketAddr> {
        let guard = self.inner.lock().ok()?;
        guard.as_ref().map(|i| i.addr)
    }

    pub fn token(&self) -> Option<String> {
        let guard = self.inner.lock().ok()?;
        guard.as_ref().map(|i| i.token.clone())
    }
}
