#!/usr/bin/env bash
# Configure a named Cloudflare Tunnel that fronts the Work Station
# cloud-agent. Replaces the manual recipe at the bottom of
# scripts/cloud-agent-install.sh (T19.3) — the operator pastes a
# hostname, the script does the rest. Idempotent: re-running picks up a
# fresh DNS route or a renamed tunnel without dropping state.
#
# Usage:
#
#   sudo HOSTNAME=agent.example.com ./scripts/cloud-agent-tunnel.sh
#
# Required:
#   HOSTNAME           Public DNS name to route into the tunnel. Must
#                      be on a Cloudflare-managed zone the operator
#                      logged into in step 2 below.
#
# Optional:
#   TUNNEL_NAME=work-station     cloudflared tunnel name (idempotent)
#   LISTEN_HOST=127.0.0.1        host the cloud-agent binds to
#   LISTEN_PORT=7420             port  the cloud-agent binds to
#   CFD_HOME=/root/.cloudflared  where cloudflared stores creds + cert
#   CONFIG_PATH=/etc/cloudflared/config.yml
#
# The script:
#   1. Verifies cloudflared is installed (left over from
#      scripts/cloud-agent-bootstrap.sh).
#   2. If $CFD_HOME/cert.pem is missing, runs `cloudflared tunnel
#      login` so the operator can authenticate the zone. This step is
#      interactive — it prints a URL the operator opens on their
#      laptop. Re-runs after the cert exists skip the prompt.
#   3. Looks for a tunnel named ${TUNNEL_NAME}; creates one if absent
#      and captures the resulting credentials JSON path.
#   4. Routes ${HOSTNAME} to the tunnel via `cloudflared tunnel route
#      dns`. Tolerates a pre-existing record (`already exists`) so
#      re-runs don't error.
#   5. Writes ${CONFIG_PATH} with an ingress rule that forwards
#      ${HOSTNAME} → http://${LISTEN_HOST}:${LISTEN_PORT}, falling
#      through to http_status:404 for everything else.
#   6. Installs cloudflared as a systemd service (`cloudflared
#      service install`) and enables + starts the unit.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Run as root (or via sudo)." >&2
  exit 1
fi

HOSTNAME_INPUT="${HOSTNAME:-}"
if [[ -z "${HOSTNAME_INPUT}" ]]; then
  echo "HOSTNAME is required. Example:" >&2
  echo "  sudo HOSTNAME=agent.example.com $0" >&2
  exit 2
fi

TUNNEL_NAME="${TUNNEL_NAME:-work-station}"
LISTEN_HOST="${LISTEN_HOST:-127.0.0.1}"
LISTEN_PORT="${LISTEN_PORT:-7420}"
CFD_HOME="${CFD_HOME:-/root/.cloudflared}"
CONFIG_PATH="${CONFIG_PATH:-/etc/cloudflared/config.yml}"

log() { printf '\n\033[1;34m==> %s\033[0m\n' "$*"; }
err() { printf '\033[1;31m!! %s\033[0m\n' "$*" >&2; }

# ---- 1. Verify cloudflared is installed --------------------------------

if ! command -v cloudflared >/dev/null 2>&1; then
  err "cloudflared is not installed — run scripts/cloud-agent-bootstrap.sh first"
  exit 1
fi

log "cloudflared $(cloudflared --version 2>/dev/null | head -1)"

install -d -m 0700 "${CFD_HOME}"

# ---- 2. Authenticate with Cloudflare (interactive on first run) --------

CERT_PATH="${CFD_HOME}/cert.pem"
if [[ ! -f "${CERT_PATH}" ]]; then
  log "Running 'cloudflared tunnel login' — open the URL it prints on your laptop"
  # `tunnel login` parks until the operator finishes the browser flow.
  # cloudflared writes cert.pem to its origin-cert path; we point it at
  # ${CFD_HOME} so re-runs of this script find the cert.
  TUNNEL_ORIGIN_CERT="${CERT_PATH}" cloudflared tunnel login
  if [[ ! -f "${CERT_PATH}" ]]; then
    err "cloudflared did not produce ${CERT_PATH} — login flow aborted?"
    exit 1
  fi
else
  log "Reusing existing origin cert at ${CERT_PATH}"
fi

# Pin the origin cert for every subsequent cloudflared call so the
# tunnel + DNS API calls authenticate against the cert from step 2 even
# when run from a non-root login shell later.
export TUNNEL_ORIGIN_CERT="${CERT_PATH}"

# ---- 3. Ensure the named tunnel exists ---------------------------------

# `cloudflared tunnel list` prints columns: ID, NAME, CREATED, CONNECTORS.
# Match by the second column to dodge a substring collision in NAME.
TUNNEL_ID="$(cloudflared tunnel list 2>/dev/null \
  | awk -v name="${TUNNEL_NAME}" '$2 == name {print $1; exit}')"

if [[ -z "${TUNNEL_ID}" ]]; then
  log "Creating tunnel '${TUNNEL_NAME}'"
  cloudflared tunnel create "${TUNNEL_NAME}"
  TUNNEL_ID="$(cloudflared tunnel list 2>/dev/null \
    | awk -v name="${TUNNEL_NAME}" '$2 == name {print $1; exit}')"
  if [[ -z "${TUNNEL_ID}" ]]; then
    err "tunnel '${TUNNEL_NAME}' was not found after create — check 'cloudflared tunnel list'"
    exit 1
  fi
else
  log "Reusing existing tunnel '${TUNNEL_NAME}' (${TUNNEL_ID})"
fi

CREDENTIALS_FILE="${CFD_HOME}/${TUNNEL_ID}.json"
if [[ ! -f "${CREDENTIALS_FILE}" ]]; then
  err "tunnel credentials file ${CREDENTIALS_FILE} is missing — re-run 'cloudflared tunnel create ${TUNNEL_NAME}' or copy the json over"
  exit 1
fi

# ---- 4. Route the hostname ---------------------------------------------

log "Routing ${HOSTNAME_INPUT} → tunnel ${TUNNEL_NAME}"
# `tunnel route dns` errors when the record already points at this
# tunnel. Trap that case so re-runs succeed; surface every other
# failure verbatim.
set +e
ROUTE_OUTPUT="$(cloudflared tunnel route dns "${TUNNEL_NAME}" "${HOSTNAME_INPUT}" 2>&1)"
ROUTE_STATUS=$?
set -e
if [[ ${ROUTE_STATUS} -ne 0 ]]; then
  if echo "${ROUTE_OUTPUT}" | grep -qiE 'already (exists|has)|record .* already'; then
    log "DNS record already exists — leaving as-is"
  else
    err "tunnel route dns failed:"
    echo "${ROUTE_OUTPUT}" >&2
    exit 1
  fi
else
  echo "${ROUTE_OUTPUT}"
fi

# ---- 5. Write /etc/cloudflared/config.yml ------------------------------

CONFIG_DIR="$(dirname "${CONFIG_PATH}")"
install -d -m 0755 "${CONFIG_DIR}"

log "Writing ${CONFIG_PATH}"
# Owner root, mode 0644 — config is non-secret (the credentials file
# referenced inside it carries the secret). Keep the file readable so
# the cloudflared systemd unit (runs as root by default after `service
# install`) picks it up without ACL massaging.
cat >"${CONFIG_PATH}" <<EOF
# Work Station cloud-agent — Cloudflare Tunnel config.
# Generated by scripts/cloud-agent-tunnel.sh (T19.30). Edit and run
#   systemctl restart cloudflared
# to pick up changes.

tunnel: ${TUNNEL_NAME}
credentials-file: ${CREDENTIALS_FILE}

ingress:
  - hostname: ${HOSTNAME_INPUT}
    service: http://${LISTEN_HOST}:${LISTEN_PORT}
  - service: http_status:404
EOF
chmod 0644 "${CONFIG_PATH}"

# ---- 6. Install + enable the cloudflared systemd unit ------------------

# `cloudflared service install` writes /etc/systemd/system/cloudflared.service
# pointing at ${CONFIG_PATH} via the default search path
# (/etc/cloudflared/config.yml). Re-running it after the file already
# exists is a no-op apart from a daemon-reload, so it's safe in the
# idempotent path here.
log "Installing cloudflared systemd unit"
cloudflared service install || true

log "Enabling + starting cloudflared"
systemctl daemon-reload
systemctl enable cloudflared
systemctl restart cloudflared

# Give it a beat so the status output reflects the post-restart state.
sleep 1
systemctl --no-pager status cloudflared || true

# ---- 7. Operator pointers ----------------------------------------------

cat <<EOF

$(printf '\033[1;32mCloudflare Tunnel configured.\033[0m')

  tunnel       ${TUNNEL_NAME} (${TUNNEL_ID})
  hostname     ${HOSTNAME_INPUT}
  forwards to  http://${LISTEN_HOST}:${LISTEN_PORT}
  config       ${CONFIG_PATH}
  credentials  ${CREDENTIALS_FILE}

  Logs:        journalctl -u cloudflared -f
  Restart:     systemctl restart cloudflared

Next:
  1. From this VPS, run:
       cloud-agent pair show
     and copy the printed URL + token block. The 'URL' field should
     now read 'wss://${HOSTNAME_INPUT}' — if 'public_url' is unset in
     the cloud-agent config, set it before pairing:
       echo 'public_url = "wss://${HOSTNAME_INPUT}"' >> /etc/cloud-agent/config.toml
       systemctl restart cloud-agent
  2. In the Work Station desktop app, open Settings → Cloud → Pair
     and paste the block.

EOF
