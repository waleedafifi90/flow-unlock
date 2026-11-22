#!/usr/bin/env bash
# Installs and starts the Flow Unlock proxy (3proxy) on an Ubuntu VPS.
# Run it on the VPS over your own SSH — it never receives your SSH credentials.
#
# Usage (as root / sudo):
#   sudo PROXY_USER=myuser PROXY_PASS='a-long-random-password' PROXY_PORT=8443 ./setup.sh
set -euo pipefail

: "${PROXY_USER:?set PROXY_USER}"
: "${PROXY_PASS:?set PROXY_PASS}"
: "${PROXY_PORT:?set PROXY_PORT}"

if [ "$(id -u)" -ne 0 ]; then
  echo "Run with sudo (needs apt, systemd, ufw)." >&2
  exit 1
fi

HERE="$(cd "$(dirname "$0")" && pwd)"

apt-get update
apt-get install -y 3proxy || {
  echo "3proxy is not available via apt on this system. Install it manually, then re-run." >&2
  exit 1
}

BIN="$(command -v 3proxy)"
[ -n "$BIN" ] || { echo "3proxy binary not found after install." >&2; exit 1; }

install -d /etc/3proxy
sed -e "s|__USER__|${PROXY_USER}|g" \
    -e "s|__PASS__|${PROXY_PASS}|g" \
    -e "s|__PORT__|${PROXY_PORT}|g" \
    "$HERE/3proxy.cfg" > /etc/3proxy/3proxy.cfg
chown nobody:nogroup /etc/3proxy/3proxy.cfg
chmod 600 /etc/3proxy/3proxy.cfg

cat > /etc/systemd/system/3proxy.service <<UNIT
[Unit]
Description=3proxy for Flow Unlock
After=network.target

[Service]
ExecStart=${BIN} /etc/3proxy/3proxy.cfg
Restart=on-failure
User=nobody

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now 3proxy.service

if command -v ufw >/dev/null 2>&1; then
  ufw allow "${PROXY_PORT}/tcp" || true
fi

echo
echo "Proxy is up on port ${PROXY_PORT}. Test from your own machine:"
echo "  curl -x \"http://${PROXY_USER}:<password>@<VPS_IP>:${PROXY_PORT}\" https://api.ipify.org"
echo "It should print the VPS IP."
