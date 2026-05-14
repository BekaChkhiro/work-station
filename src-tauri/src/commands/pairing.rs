//! Mobile-pairing surface (QR code) for the Settings panel.
//!
//! Returns everything the UI needs to render a QR encoding a
//! `https://<pwa-origin>/?h=<host>&t=<token>` deep-link:
//!
//!   * the WebSocket server's bound port,
//!   * the bearer token,
//!   * a list of LAN-reachable IPv4 addresses (kept for the manual
//!     fallback when the tunnel is unavailable),
//!   * the Cloudflare quick-tunnel URL — preferred for the QR because
//!     it's an HTTPS public endpoint the PWA can reach from any
//!     network, no mixed-content blocks.
//!
//! When the server is bound to `127.0.0.1` (the default) the PWA on a
//! phone cannot reach it over LAN — but the tunnel makes that
//! irrelevant. The `bound_to_loopback` flag is still reported so the
//! UI can flag any LAN-mode fallback.

use std::net::IpAddr;

use serde::Serialize;
use tauri::State;

use crate::pairing::{PairingState, TunnelState};

#[derive(Debug, Serialize)]
pub struct PairingInfo {
    /// The exact host the server is bound to (e.g. `127.0.0.1` or
    /// `0.0.0.0`). Frontends use this only to detect loopback binds.
    pub bound_host: String,
    pub bound_port: u16,
    /// True when `bound_host` is the IPv4 / IPv6 loopback — phones on
    /// the same Wi-Fi cannot reach this address.
    pub bound_to_loopback: bool,
    /// All non-loopback IPv4 addresses on this machine. Useful when the
    /// server binds to `0.0.0.0` and the tunnel is unavailable.
    pub lan_addresses: Vec<String>,
    /// The bearer token the PWA must present.
    pub token: String,
    /// Current state of the Cloudflare quick tunnel.
    pub tunnel: TunnelState,
}

#[tauri::command]
pub fn get_pairing_info(state: State<'_, PairingState>) -> Option<PairingInfo> {
    let addr = state.addr()?;
    let token = state.token()?;
    let bound_host = addr.ip().to_string();
    let bound_to_loopback = addr.ip().is_loopback();
    let lan_addresses = enumerate_lan_addresses();
    let tunnel = state.tunnel();
    Some(PairingInfo {
        bound_host,
        bound_port: addr.port(),
        bound_to_loopback,
        lan_addresses,
        token,
        tunnel,
    })
}

fn enumerate_lan_addresses() -> Vec<String> {
    let mut out = Vec::new();
    let Ok(ifaces) = local_ip_address::list_afinet_netifas() else {
        return out;
    };
    for (_name, ip) in ifaces {
        // We only surface IPv4 — most home routers don't expose a
        // routable IPv6, and IPv4 is what users recognise on a phone.
        // Skip loopback, link-local (169.254/16), and the all-zero
        // 0.0.0.0 placeholder that some interfaces report.
        let IpAddr::V4(v4) = ip else { continue };
        if v4.is_loopback() || v4.is_unspecified() || v4.is_link_local() {
            continue;
        }
        let s = v4.to_string();
        if !out.contains(&s) {
            out.push(s);
        }
    }
    out
}
