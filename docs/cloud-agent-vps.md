# Cloud-agent dev VPS — provisioning runbook

This is the host that runs `cloud-agent` (T19.2) for Work Station's cloud mode (Phase 19). It's a personal-use box — one user, one agent, no high-availability.

The VPS hosts the cloud-agent only. PTYs, the SQLite project DB, and the workstation-core data layer (T19.1) all live on this box. The desktop app connects to it over WebSocket via Cloudflare Tunnel (no public ports open to the internet).

## 1. Sizing

| Plan  | vCPU       | RAM  | Disk  | Region                | €/mo   | Verdict                                                                          |
| ----- | ---------- | ---- | ----- | --------------------- | ------ | -------------------------------------------------------------------------------- |
| CX22  | 2 (shared) | 4 GB | 40 GB | Falkenstein/Nuremberg | ~€4.50 | **Default for solo dev use.** Handles 5–10 idle PTYs + a Rust build comfortably. |
| CPX21 | 3 (AMD)    | 4 GB | 80 GB | same                  | ~€7    | If you'll build the cloud-agent on the box (faster `cargo build`).               |
| CAX21 | 4 (ARM64)  | 8 GB | 80 GB | Falkenstein/Helsinki  | ~€6.50 | If you don't need x86 (cloud-agent built for `aarch64-unknown-linux-gnu`).       |

Pick **CX22** unless you specifically want to build Rust on the box.

## 2. Create the VPS (manual, Hetzner Cloud Console)

1. Sign in to https://console.hetzner.cloud → New Project → "work-station".
2. **Add SSH key** (Security → SSH Keys) — paste your `~/.ssh/id_ed25519.pub`. Do this _before_ creating the server so password auth is never enabled.
3. **New server**:
   - Location: closest to you (Nuremberg / Falkenstein / Helsinki).
   - Image: **Ubuntu 24.04**.
   - Type: CX22 (or per §1).
   - Networking: IPv4 + IPv6, no extra volumes.
   - SSH key: the one from step 2.
   - Firewall: skip — we'll add one in step 3.
   - Name: `ws-cloud-agent-dev`.
4. Note the assigned IPv4. SSH in once to accept the host key: `ssh root@<ip>`.

## 3. Hetzner Cloud Firewall (recommended)

In the console → Firewalls → Create:

| Direction | Protocol | Port | Source                                   |
| --------- | -------- | ---- | ---------------------------------------- |
| Inbound   | TCP      | 22   | your home IP (or `0.0.0.0/0` if dynamic) |
| Inbound   | ICMP     | —    | `0.0.0.0/0`                              |
| Outbound  | \*       | \*   | `0.0.0.0/0`                              |

**No inbound 7420 / 80 / 443** — all WebSocket traffic comes in over Cloudflare Tunnel as an outbound connection from the VPS.

Attach the firewall to `ws-cloud-agent-dev`.

## 4. Bootstrap the box

Run as root on the freshly-created VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/<you>/work-station/master/scripts/cloud-agent-bootstrap.sh | sudo bash
```

(Or `scp` it over and run locally if you don't want the curl|sh dance.)

The script is idempotent. It:

- Sets a hostname and timezone (UTC).
- `apt update && unattended-upgrades` configured.
- Installs `ufw`, `fail2ban`, `tmux`, `curl`, `ca-certificates`, `htop`.
- Locks SSH down: `PasswordAuthentication no`, `PermitRootLogin prohibit-password`, `MaxAuthTries 3`.
- Creates a non-login service user `wsagent` with `~wsagent/.ssh` seeded from `root`'s `authorized_keys` (so you can `ssh wsagent@<ip>` from the same key).
- Creates `/opt/cloud-agent/` (binary lands here in T19.3) and `/var/lib/cloud-agent/` (state dir, owned by `wsagent`).
- Installs the `cloudflared` apt repo + package, but does **not** configure the tunnel — that's a per-user step (T19.15 wires it up from the desktop Settings UI).

Reboot afterwards: `reboot`.

## 5. Verify

From your laptop:

```bash
ssh wsagent@<ip> 'id && systemctl is-active fail2ban && cloudflared --version'
```

Expected: `uid=1001(wsagent) ...`, `active`, `cloudflared version 2024.x`.

## 6. Install the cloud-agent

Build the binary on your laptop (the VPS doesn't have a Rust toolchain by default — keeping it off the box saves RAM and disk):

```bash
# On your laptop, from the repo root:
cargo build --release -p cloud-agent
scp target/release/cloud-agent root@<ip>:/tmp/cloud-agent
```

Then run the install script on the VPS:

```bash
ssh root@<ip> 'curl -fsSL https://raw.githubusercontent.com/<you>/work-station/master/scripts/cloud-agent-install.sh | bash'
```

The script is idempotent. It:

- Verifies the binary (`--version`) before touching `/opt/cloud-agent`.
- Installs the binary to `/opt/cloud-agent/cloud-agent` (root-owned, 0755).
- Drops a default `/etc/cloud-agent/config.toml` on first install — preserved on re-runs so your edits survive upgrades.
- Validates the config with `--check-config` running **as `wsagent`** so file-permission issues surface before `systemctl start`.
- Writes a hardened systemd unit to `/etc/systemd/system/cloud-agent.service` (NoNewPrivileges, ProtectSystem=strict, StateDirectory=cloud-agent, etc.).
- Reloads systemd and `restart`s the unit so an upgrade picks up the new binary.

Binary source precedence (env vars):

| Variable     | Use                                          |
| ------------ | -------------------------------------------- |
| `BINARY`     | Absolute path to a locally-staged binary     |
| `BINARY_URL` | HTTPS URL the script downloads from          |
| _(default)_  | `/tmp/cloud-agent` — matches the `scp` above |

Verify:

```bash
systemctl status cloud-agent
journalctl -u cloud-agent -n 50
```

## 7. What's next

- **T19.15** — Settings UI to register the Cloudflare Tunnel and pair the desktop with this agent. Until then, the install script prints the manual `cloudflared tunnel create` recipe at the end.

## 8. Tear-down

When you're done with this dev box: Hetzner console → server → Delete. Billing is hourly — leaving a CX22 running 24/7 ≈ €4.50/mo; killing it after each session saves money but costs a fresh bootstrap each time. Snapshot before deleting if you want to skip §4 next time (Hetzner snapshots are €0.012/GB-mo).
