#!/usr/bin/env bash
# Installs and starts the Flow Unlock proxy (3proxy) on an Ubuntu VPS.
# Run it on the VPS over your own SSH — it never receives your SSH credentials.
# 3proxy is no longer in Ubuntu's apt repos (removed as of 24.04), so this falls
# back to building it from source.
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

# --- obtain the 3proxy binary -------------------------------------------------
if command -v 3proxy >/dev/null 2>&1; then
  BIN="$(command -v 3proxy)"
  echo "Using existing 3proxy at $BIN"
elif apt-get update && apt-get install -y 3proxy 2>/dev/null; then
  BIN="$(command -v 3proxy)"
  echo "Installed 3proxy from apt at $BIN"
else
  echo "3proxy not in apt — building from source..."
  apt-get install -y git build-essential
  SRC="$(mktemp -d)"
  git clone --depth 1 https://github.com/3proxy/3proxy "$SRC"
  make -C "$SRC" -f Makefile.Linux
  install -m0755 "$SRC/bin/3proxy" /usr/local/bin/3proxy
  rm -rf "$SRC"
  BIN=/usr/local/bin/3proxy
  echo "Built 3proxy at $BIN"
fi
[ -n "${BIN:-}" ] || { echo "3proxy binary not found." >&2; exit 1; }

# --- write the config ---------------------------------------------------------
# Literal bash substitution (not sed), so passwords with /, &, | etc. are safe.
cfg="$(cat "$HERE/3proxy.cfg")"
cfg="${cfg//__USER__/$PROXY_USER}"
cfg="${cfg//__PORT__/$PROXY_PORT}"
cfg="${cfg//__PASS__/$PROXY_PASS}"

install -d /etc/3proxy
printf '%s\n' "$cfg" > /etc/3proxy/3proxy.cfg
chown nobody:nogroup /etc/3proxy/3proxy.cfg
chmod 600 /etc/3proxy/3proxy.cfg

# --- service ------------------------------------------------------------------
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
