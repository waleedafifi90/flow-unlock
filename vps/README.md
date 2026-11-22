# Flow Unlock — VPS proxy setup

A small authenticated HTTP proxy (`3proxy`) on your US Ubuntu VPS. The extension
routes only Google/Flow traffic through it, so Google sees a US IP. You run these
steps yourself over SSH; nothing here ever receives your SSH login.

## 1. Copy this folder to the VPS

From your machine:

```bash
scp -r vps youruser@YOUR_VPS_IP:~/flow-proxy
```

## 2. Run the setup script on the VPS

SSH in, then run it with your chosen credentials and port:

```bash
cd ~/flow-proxy
sudo PROXY_USER=myuser PROXY_PASS='a-long-random-password' PROXY_PORT=8443 ./setup.sh
```

- **Password:** long, random, and used nowhere else. Generate one with
  `openssl rand -base64 24`.
- **Port:** pick a non-default high port (not 8080/3128), e.g. `8443`.

The script installs `3proxy`, writes `/etc/3proxy/3proxy.cfg`, creates a systemd
service that starts on boot, and opens the port in `ufw`.

## 3. Test it

From your own machine:

```bash
curl -x "http://myuser:a-long-random-password@YOUR_VPS_IP:8443" https://api.ipify.org
```

It should print the **VPS IP**. If it does, the proxy works.

## 4. Enter it in the extension

Open the extension popup → **بروكسي VPS (اختياري)** → fill the IP, port, user,
and password → **حفظ البروكسي** → turn the switch on → reload Flow.

## Security notes

- The proxy password is sent to the VPS over the proxy connection in cleartext
  (your TLS to Google stays end-to-end). Treat the VPS as the trust boundary:
  use a strong unique password and a non-default port.
- Consider `fail2ban`, or restricting the port to your home IP in `ufw` if it is
  static (`sudo ufw allow from YOUR_HOME_IP to any port 8443 proto tcp`, after
  removing the open rule).
- A proxy in a US (supported) region only changes the apparent country. If Flow's
  `/unavailable` is tied to the account (age, subscription), no proxy changes that.

## Manage the service

```bash
sudo systemctl status 3proxy     # check it
sudo systemctl restart 3proxy    # after editing the config
sudo journalctl -u 3proxy -e     # logs
```
