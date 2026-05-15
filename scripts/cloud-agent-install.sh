#!/usr/bin/env bash
# Install / upgrade the Work Station cloud-agent on a Hetzner Ubuntu VPS.
# Idempotent — safe to re-run. Assumes the bootstrap script (T19.0) has
# already run on this host: the `wsagent` service user and the
# /opt/cloud-agent + /var/lib/cloud-agent directories must already exist.
#
# Usage (one-line install, binary pre-staged at /tmp/cloud-agent):
#
#   scp target/release/cloud-agent root@<vps>:/tmp/cloud-agent
#   ssh root@<vps> 'curl -fsSL https://raw.githubusercontent.com/<you>/work-station/master/scripts/cloud-agent-install.sh | bash'
#
# Binary source precedence:
#   1. $BINARY        — local path to an already-built cloud-agent binary
#   2. $BINARY_URL    — https URL the script will curl into place
#   3. /tmp/cloud-agent if present (the scp default above)
#
# Optional env vars:
#   AGENT_USER=wsagent   service user (must already exist)
#   INSTALL_DIR=/opt/cloud-agent
#   CONFIG_DIR=/etc/cloud-agent
#   STATE_DIR=/var/lib/cloud-agent
#   UNIT_PATH=/etc/systemd/system/cloud-agent.service

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (or via sudo)." >&2
  exit 1
fi

AGENT_USER="${AGENT_USER:-wsagent}"
INSTALL_DIR="${INSTALL_DIR:-/opt/cloud-agent}"
CONFIG_DIR="${CONFIG_DIR:-/etc/cloud-agent}"
STATE_DIR="${STATE_DIR:-/var/lib/cloud-agent}"
UNIT_PATH="${UNIT_PATH:-/etc/systemd/system/cloud-agent.service}"
TARGET_BINARY="${INSTALL_DIR}/cloud-agent"
CONFIG_PATH="${CONFIG_DIR}/config.toml"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
err() { printf '\033[1;31m!! %s\033[0m\n' "$*" >&2; }

# ---- 1. Locate the binary -----------------------------------------------

if ! id -u "${AGENT_USER}" >/dev/null 2>&1; then
  err "service user '${AGENT_USER}' does not exist — run scripts/cloud-agent-bootstrap.sh first"
  exit 1
fi

STAGED_BINARY=""
if [[ -n "${BINARY:-}" ]]; then
  STAGED_BINARY="${BINARY}"
elif [[ -n "${BINARY_URL:-}" ]]; then
  STAGED_BINARY="$(mktemp -t cloud-agent.XXXXXX)"
  log "Downloading cloud-agent binary from ${BINARY_URL}"
  curl -fSL --proto '=https' --tlsv1.2 -o "${STAGED_BINARY}" "${BINARY_URL}"
elif [[ -f /tmp/cloud-agent ]]; then
  STAGED_BINARY="/tmp/cloud-agent"
else
  err "no binary found. Set BINARY=/path/to/cloud-agent, BINARY_URL=https://..., or stage the binary at /tmp/cloud-agent."
  exit 1
fi

if [[ ! -f "${STAGED_BINARY}" ]]; then
  err "staged binary '${STAGED_BINARY}' is not a regular file"
  exit 1
fi

# Smoke-test before we touch anything in /opt — refuses to install a
# binary that won't even print its version.
log "Verifying binary: ${STAGED_BINARY} --version"
chmod +x "${STAGED_BINARY}"
"${STAGED_BINARY}" --version

# ---- 2. Install binary --------------------------------------------------

log "Installing binary → ${TARGET_BINARY}"
install -d -m 0755 "${INSTALL_DIR}"
# install(1) is atomic enough for our purposes: it writes to a temp file
# then renames over the target, so the running service either sees the
# old or new binary, never a half-written one.
install -m 0755 -o root -g root "${STAGED_BINARY}" "${TARGET_BINARY}"

# ---- 3. Config dir + default config -------------------------------------

log "Installing config dir → ${CONFIG_DIR}"
install -d -m 0755 -o root -g root "${CONFIG_DIR}"

if [[ ! -f "${CONFIG_PATH}" ]]; then
  log "Writing default config → ${CONFIG_PATH}"
  # Mode 0640 so wsagent can read it but only root can edit. Owner stays
  # root so a compromised agent process can't rewrite its own listen
  # address or state dir.
  install -m 0640 -o root -g "${AGENT_USER}" /dev/null "${CONFIG_PATH}"
  cat >"${CONFIG_PATH}" <<'EOF'
# Work Station cloud-agent config. Edit and restart the unit:
#   systemctl restart cloud-agent
#
# Every field is optional — the agent falls back to the defaults below
# when omitted (or when this file is missing entirely).

# host:port the WebSocket listener binds to. Loopback by default because
# Cloudflare Tunnel terminates publicly and forwards locally (no inbound
# port is opened on this VPS).
listen = "127.0.0.1:7420"

# Directory the agent owns: future pairing token, scrollback overflow,
# the SQLite project DB. Created by systemd's StateDirectory= on first
# launch if missing.
state_dir = "/var/lib/cloud-agent"

# Tracing filter. Same syntax as RUST_LOG. The --log-filter CLI flag
# overrides this for a single run without editing the file.
log_filter = "info"

# Bearer token. Leave commented to let cloud-agent manage one at
# <state_dir>/pairing_token via 'cloud-agent pair show|rotate' (T19.22).
# auth_token = "REPLACE_ME"

# Public URL the desktop / PWA uses to reach this agent — typically the
# Cloudflare Tunnel hostname. Consumed only by 'cloud-agent pair show'.
# public_url = "wss://agent.example.com"
EOF
else
  log "Existing config at ${CONFIG_PATH} — preserved as-is"
fi

# ---- 4. State dir -------------------------------------------------------
# systemd's StateDirectory= would create this on first start, but we
# create it eagerly so --check-config in the next step has somewhere to
# look if the config is using the default state_dir.

log "Ensuring state dir → ${STATE_DIR} (owner ${AGENT_USER})"
install -d -m 0750 -o "${AGENT_USER}" -g "${AGENT_USER}" "${STATE_DIR}"

# ---- 5. Validate config -------------------------------------------------

log "Validating config (cloud-agent --check-config)"
# Run as the service user so any path-permission issues surface here
# instead of after systemctl start.
sudo -u "${AGENT_USER}" \
  CLOUD_AGENT_CONFIG="${CONFIG_PATH}" \
  "${TARGET_BINARY}" --check-config

# ---- 6. systemd unit ----------------------------------------------------

log "Writing systemd unit → ${UNIT_PATH}"
cat >"${UNIT_PATH}" <<EOF
[Unit]
Description=Work Station cloud-agent
Documentation=https://github.com/BekaChkhiro/work-station/blob/master/docs/cloud-agent-vps.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${AGENT_USER}
Group=${AGENT_USER}
Environment=CLOUD_AGENT_CONFIG=${CONFIG_PATH}
ExecStart=${TARGET_BINARY}
Restart=on-failure
RestartSec=5s

# Managed dirs — systemd ensures these exist with the right ownership
# every start, so the agent never has to chown its own state.
StateDirectory=cloud-agent
StateDirectoryMode=0750

# Hardening. The agent is a network daemon that owns one state dir and
# reads one config file — everything else can be locked down.
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
LockPersonality=yes
MemoryDenyWriteExecute=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
SystemCallArchitectures=native
ReadWritePaths=${STATE_DIR}

[Install]
WantedBy=multi-user.target
EOF
chmod 0644 "${UNIT_PATH}"

# ---- 7. Reload + enable + start -----------------------------------------

log "Reloading systemd + enabling cloud-agent"
systemctl daemon-reload
systemctl enable cloud-agent.service

# `restart` rather than `start` so an upgrade picks up the new binary
# even when the unit was already running.
log "Starting cloud-agent (restart to pick up upgrades)"
systemctl restart cloud-agent.service

# Give it a beat to settle so the status output below reflects reality
# rather than the transient "activating" state.
sleep 1

systemctl --no-pager status cloud-agent.service || true

# ---- 8. Operator pointers -----------------------------------------------

cat <<EOF

\033[1;32mcloud-agent installed.\033[0m

  binary       ${TARGET_BINARY}
  config       ${CONFIG_PATH}        (edit + 'systemctl restart cloud-agent')
  state        ${STATE_DIR}
  unit         ${UNIT_PATH}
  listen       (see config — default 127.0.0.1:7420)

  Logs:        journalctl -u cloud-agent -f
  Restart:     systemctl restart cloud-agent
  Stop:        systemctl stop cloud-agent

Next step — expose the agent to your desktop via Cloudflare Tunnel
(deferred to T19.15, which wires this up from the Settings UI). Until
then, a manual one-liner from this VPS:

  cloudflared tunnel login
  cloudflared tunnel create work-station
  cloudflared tunnel route dns work-station agent.<your-domain>
  cat > /etc/cloudflared/config.yml <<TUNNEL
  tunnel: work-station
  credentials-file: /root/.cloudflared/work-station.json
  ingress:
    - hostname: agent.<your-domain>
      service: http://127.0.0.1:7420
    - service: http_status:404
  TUNNEL
  systemctl enable --now cloudflared

EOF
