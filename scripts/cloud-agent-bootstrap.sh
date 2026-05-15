#!/usr/bin/env bash
# Bootstrap a fresh Hetzner Ubuntu 24.04 VPS for the Work Station cloud-agent.
# Idempotent — safe to re-run. See docs/cloud-agent-vps.md.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (or via sudo)." >&2
  exit 1
fi

AGENT_USER="${AGENT_USER:-wsagent}"
AGENT_HOME="/home/${AGENT_USER}"
INSTALL_DIR="/opt/cloud-agent"
STATE_DIR="/var/lib/cloud-agent"
HOSTNAME_NEW="${HOSTNAME_NEW:-ws-cloud-agent-dev}"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }

log "Set hostname → ${HOSTNAME_NEW}, timezone → UTC"
hostnamectl set-hostname "${HOSTNAME_NEW}"
timedatectl set-timezone UTC

log "apt update + base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg lsb-release \
  ufw fail2ban unattended-upgrades \
  tmux htop git

log "Enable unattended-upgrades"
dpkg-reconfigure -f noninteractive unattended-upgrades

log "Configure ufw (deny inbound except SSH)"
ufw --force reset >/dev/null
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'ssh'
ufw --force enable

log "Harden sshd"
SSHD_CONF=/etc/ssh/sshd_config.d/99-cloud-agent.conf
cat >"${SSHD_CONF}" <<'EOF'
PasswordAuthentication no
PermitRootLogin prohibit-password
MaxAuthTries 3
ClientAliveInterval 60
ClientAliveCountMax 3
EOF
systemctl reload ssh

log "Create service user ${AGENT_USER}"
if ! id -u "${AGENT_USER}" >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash "${AGENT_USER}"
fi
install -d -m 0700 -o "${AGENT_USER}" -g "${AGENT_USER}" "${AGENT_HOME}/.ssh"
if [[ -f /root/.ssh/authorized_keys ]]; then
  install -m 0600 -o "${AGENT_USER}" -g "${AGENT_USER}" \
    /root/.ssh/authorized_keys "${AGENT_HOME}/.ssh/authorized_keys"
fi

log "Create ${INSTALL_DIR} and ${STATE_DIR}"
install -d -m 0755 "${INSTALL_DIR}"
install -d -m 0750 -o "${AGENT_USER}" -g "${AGENT_USER}" "${STATE_DIR}"

log "Install cloudflared (tunnel configured later, see T19.15)"
if ! command -v cloudflared >/dev/null 2>&1; then
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg \
    | gpg --dearmor -o /usr/share/keyrings/cloudflare-main.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" \
    >/etc/apt/sources.list.d/cloudflared.list
  apt-get update -y
  apt-get install -y cloudflared
fi

log "Enable + start fail2ban"
systemctl enable --now fail2ban

log "Done."
cat <<EOF

Next:
  • Reboot to apply kernel updates: reboot
  • Verify from your laptop:
      ssh ${AGENT_USER}@\$(hostname -I | awk '{print \$1}')
  • Then run scripts/cloud-agent-install.sh (T19.3) to drop the binary in.
EOF
