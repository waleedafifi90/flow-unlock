#!/usr/bin/env bash
# Installs and starts the Flow Unlock slot manager on an Ubuntu VPS, next to the
# 3proxy from ../setup.sh. Run it on the VPS over your own SSH.
#
# Usage (as root / sudo), using the SAME credentials as the proxy:
#   sudo PROXY_USER=myuser PROXY_PASS='the-proxy-password' SLOT_LIMIT=20 SLOT_PORT=8444 ./setup.sh
set -euo pipefail

: "${PROXY_USER:?set PROXY_USER (same as the proxy)}"
: "${PROXY_PASS:?set PROXY_PASS (same as the proxy)}"
SLOT_LIMIT="${SLOT_LIMIT:-20}"
SLOT_PORT="${SLOT_PORT:-8444}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo (needs apt, systemd, ufw)." >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"

# --- Node runtime -------------------------------------------------------------
if command -v node >/dev/null 2>&1; then
  echo "Using existing node at $(command -v node)"
else
  echo "Installing nodejs from apt..."
  apt-get update && apt-get install -y nodejs
fi
NODE="$(command -v node)"
[ -n "$NODE" ] || { echo "node not found after install." >&2; exit 1; }

# --- Install the service files ------------------------------------------------
APP=/opt/flow-slot-manager
install -d "$APP"
install -m0644 "$HERE/queue-core.js" "$HERE/request-core.js" "$HERE/server.js" "$APP/"

# --- systemd unit (credentials via Environment=, not a world-readable file) ---
cat > /etc/systemd/system/flow-slot-manager.service <<UNIT
[Unit]
Description=Flow Unlock slot manager
After=network.target

[Service]
ExecStart=${NODE} ${APP}/server.js
Environment=PROXY_USER=${PROXY_USER}
Environment=PROXY_PASS=${PROXY_PASS}
Environment=SLOT_LIMIT=${SLOT_LIMIT}
Environment=PORT=${SLOT_PORT}
Restart=on-failure
User=nobody

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now flow-slot-manager.service

if command -v ufw >/dev/null 2>&1; then
  ufw allow "${SLOT_PORT}/tcp" || true
fi

echo
echo "Slot manager up on port ${SLOT_PORT} (limit ${SLOT_LIMIT})."
echo "Enter this port in the extension's proxy section (same IP/user/pass as the proxy)."
