# Design — VPS proxy integration for Flow Unlock

Date: 2026-11-22
Status: awaiting approval

## Intent and why

Flow Unlock already removes Google Flow's *country* check by flipping a flag in
the config response. It does nothing about the `/unavailable` page, which Google
decides server-side partly from the user's IP region. The owner has a US Ubuntu
VPS (a Flow-supported region). The goal: run an authenticated HTTP proxy on that
VPS and let the extension route Google traffic through it automatically, so
Google sees a US IP while the extension is on.

This is the user proxying their own browser through their own server — an
ordinary proxy/VPN-style use.

## Goals

- A small, reliable authenticated HTTP proxy on the Ubuntu VPS (`3proxy`).
- The extension sends only Google-related traffic through the proxy, the rest
  stays direct.
- Proxy host/port/username/password are entered in the popup and stored locally;
  the extension supplies the password to the proxy automatically.
- Works in both the Chrome and the Firefox build.
- A separate toggle from the existing unlock switch, so each can be on alone.

## Non-goals

- No change to the existing country-flag patch (engine.js stays as is).
- Not a full-device VPN; only this browser, only while toggled on.
- No automatic VPS provisioning from the extension. Setup is run by the user over
  their own SSH, from commands/config we provide (we never hold VPS credentials).

## Anti-goals (would make this a failure)

- Credentials readable by other sites or leaked into page content.
- An open proxy with no auth that strangers can relay through.
- Routing the user's entire browsing through the VPS unintentionally.
- A mismatched-IP setup (login direct, Flow proxied) that trips "unusual activity".

## Constraints found

- **Chrome MV3** needs the `webRequestAuthProvider` permission to answer the
  proxy's auth challenge automatically; plain `webRequestBlocking` is not
  available to a normal extension in MV3. Proxy is set with `chrome.proxy` using
  a PAC script.
- **Firefox** has no `chrome.proxy.settings`; it uses a `proxy.onRequest`
  listener that returns the proxy per request. Auth via `webRequest.onAuthRequired`.
  So the proxy-setting code is per-browser; everything else is shared.
- HTTP CONNECT carries the Basic proxy password in cleartext **to the VPS**. TLS
  to Google stays end-to-end. Mitigate with a strong unique password and a
  non-standard port; a TLS-terminating proxy is a later upgrade, out of scope now.
- Google is reached over many hosts (accounts, apis, gstatic, labs, flow). The
  proxy must cover the set used for sign-in + Flow, or IPs will be inconsistent.

## Approach (chosen)

Authenticated HTTP forward proxy (`3proxy`) on the VPS; the extension routes only
Google hosts through it. Rejected: SOCKS5 (Chrome can't pass SOCKS auth via the
extension API, forcing fragile IP-allowlisting); routing all traffic (slower, and
sends unrelated sites through the VPS).

### VPS side (user runs over SSH)

- Install `3proxy`, write a config with one proxy user, listening on a chosen
  high port, `proxy` (HTTP/CONNECT) only.
- A systemd unit so it starts on boot.
- UFW: open only the chosen proxy port (plus existing SSH). Note the option to
  restrict the source IP if the home IP is static.
- We provide a copy-paste setup script and the config; the user edits the
  username/password/port and runs it. Credentials are shown to the user, never
  committed.

### Extension side (shared + per-browser)

- Popup gains a second section: a "route Google through my VPS" toggle and four
  fields (host, port, username, password), saved to `storage.local`.
- Background:
  - Builds the Google host list (flow.google.com, labs.google, accounts.google.com,
    *.googleapis.com, *.gstatic.com, apis.google.com, play.google.com, and the
    related hosts Flow loads).
  - Chrome: sets a PAC script returning `PROXY host:port` for those hosts and
    `DIRECT` otherwise; clears it when the toggle is off.
  - Firefox: a `proxy.onRequest` listener returning the proxy for those hosts.
  - Both: `webRequest.onAuthRequired` returns the stored credentials for the
    proxy's challenge only (isProxy), never for site logins.
- Manifest: Chrome build adds `proxy`, `webRequest`, `webRequestAuthProvider`.
  Firefox build adds `proxy`, `webRequest`. Both add the proxy is reached via
  host access already present for Google; the proxy host itself needs no match.
- `build-firefox.sh` keeps mirroring shared files; only the two manifests and the
  per-browser proxy-set function differ.

## Left to the builder

- Exact final Google host list (start from the set above; refine by watching
  which hosts Flow actually calls).
- Port number and credential values are the user's, entered at runtime.
- Popup layout/wording for the new section (follow the existing popup style).
- Whether the proxy toggle also nudges a reload of open Flow tabs (propose: yes,
  same as the unlock toggle).

## Security notes to surface to the user

- Use a long random password, unique to this proxy.
- Keep the proxy port non-default; consider fail2ban or source-IP limiting.
- The password is stored in the browser's extension storage and sent to the VPS
  over the proxy connection; treat the VPS as the trust boundary.
