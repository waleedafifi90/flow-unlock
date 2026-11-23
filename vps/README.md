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

The script installs `3proxy` (building it from source when apt has no package —
Ubuntu 24.04 dropped it), writes `/etc/3proxy/3proxy.cfg`, creates a systemd
service that starts on boot, and opens the port in `ufw`.

> Keep the password free of spaces and `#` (3proxy parses the config on
> whitespace). `openssl rand -base64 24` is safe.

If the script isn't executable after copying, run it with `bash setup.sh` (as in
the command above) or `chmod +x setup.sh` first.

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

## Capacity and limits

The VPS hardware is almost never the bottleneck — 3proxy is light, so RAM and
CPU handle thousands of connections. The real ceiling is your **uplink
bandwidth**, because Flow's generated media downloads through the proxy. On a
1 Gbit link, expect roughly **20–40 heavy users** (all generating and
downloading at once) or **100+ light users** (mostly browsing and prompting).

Two guards are in `3proxy.cfg`:

- `maxconn 3000` — caps total simultaneous connections so a spike can't exhaust
  the box. A browser opens several connections per site; 3000 covers a few dozen
  active users. Adjust to taste.
- `bandlimin 900000000 <user>` — a total download ceiling of 900 Mbit/s (bits
  per second), set below the 1 Gbit link so the OS keeps headroom. This is **one
  shared bucket** for everyone on the account, a whole-box safety ceiling, not a
  per-person quota.

### True per-person limits

A single shared account can't be metered per person — everyone authenticates as
the same user, so any limit is shared. For a real per-person cap, give each
person their own account and limit each one:

```
users alice:CL:pass1 bob:CL:pass2
allow alice,bob
bandlimin 50000000 alice      # 50 Mbit/s for alice
bandlimin 50000000 bob        # 50 Mbit/s for bob
maxconn 200                   # per-service connection cap
proxy -a -p8443
```

Separate accounts also let you revoke one person without changing everyone's
password, and make it easy to see who is using how much.

## Keeping the IP off Google's radar

Honest framing first: **no proxy setting reliably prevents Google from blocking
an IP.** Blocks come from the IP's reputation and the behavior of the accounts
behind it, not from a config flag. What actually lowers the risk:

- **Fewer Google accounts per IP.** This is the biggest factor. Many distinct
  accounts logging in from one IP is the classic flag. Keep the number small.
- **This is a datacenter (VPS) IP**, which Google already trusts less than a
  home/residential IP. If you get flagged, that's usually why — a residential or
  your-own-ISP IP is less suspect, but harder to run a server on.
- **Stay consistent, don't rotate.** For a logged-in account, keeping the same
  IP looks *more* normal than switching IPs between sessions.
- **Proxy Google only** (already configured) — the IP's footprint stays limited
  to Flow/Google traffic, nothing else.
- **`-a` (anonymous)** is already set, so the proxy doesn't leak the client's
  real IP to Google in an `X-Forwarded-For` header.
- **Keep strangers off the port** so the IP isn't used for abuse by others: a
  strong password (set), and `fail2ban` or a `ufw` rule locking the port to
  known IPs (see Security notes).
- **No scraping or automation** through this IP — that's what gets IPs banned.

## Manage the service

```bash
sudo systemctl status 3proxy     # check it
sudo systemctl restart 3proxy    # after editing the config
sudo journalctl -u 3proxy -e     # logs
```
