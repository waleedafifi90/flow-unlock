# Slot queue for the VPS proxy — design

## Intent / why

The VPS proxy is shared. The user wants to cap how many people use it at once
(initially **20**) and give everyone past the cap a fair, first-come-first-served
queue with a visible position in the extension popup ("you're #N of M"). When an
active user leaves, the next person in line is let in automatically. Without this,
extra users either overload the box or silently fail on `/unavailable`.

## Goals

- Hard cap of N active proxy users at once (N configurable on the server; default 20).
- FIFO queue for everyone beyond the cap.
- Popup shows the user's state: **active**, or **queued at position K of M**.
- A user who gets a slot has the proxy turned on automatically; a queued user keeps
  the proxy **off** until their turn.
- Leaving (toggle off, close the browser) frees the slot automatically and promotes
  the next person — no manual step, no stuck slots.
- **Backward compatible:** if no slot-manager is configured, or it is unreachable,
  the extension falls back to the current behavior — turn the proxy on directly, no
  queue. Existing users who do not deploy the new service keep working unchanged.

## Non-goals

- Not a hardened public gate. The extension cooperates with the server; someone who
  edits the extension can bypass the check. Fine for a known group, not for abuse.
- No accounts/identity per person beyond an anonymous per-browser id. No login UI.
- No persistence across server restarts — the queue lives in memory. A restart
  clears it and everyone re-acquires (acceptable; restarts are rare).
- The proxy itself is unchanged; this only decides *whether* the extension turns it on.

## Anti-goals

- Must not keep the proxy on for a queued user (that would defeat the cap).
- Must not leave a slot held by a browser that has gone away (sweeper prevents this).

## Approaches considered

1. **3proxy connection cap only** (`maxconn`). Already present, but it counts
   connections not people, and when full it drops connections → the user sees a
   broken page, never a message or a queue. Fails the core requirement. Rejected.
2. **Extension-only coordination.** Impossible: one browser cannot see other users'
   state, so it cannot count active users or order a queue. Rejected.
3. **Small gatekeeper service on the VPS + cooperating extension.** The only design
   that can count users across browsers and return a queue position. **Chosen.**

## Architecture (chosen)

A new lightweight **slot-manager** service runs on the same VPS next to 3proxy,
and the extension talks to it before using the proxy.

### Slot-manager service (`vps/slot-manager/`)

- Node.js, **zero external dependencies** (built-in `http`), its own port
  (default 8444), systemd unit, `ufw` opened — mirrors the existing 3proxy setup.
- In-memory state: `active` (id → lastSeen) and `queue` (ordered ids).
- Auth: the **same proxy username/password** the user already enters — sent on each
  request; no new secret to configure. Plain HTTP, same trust boundary and cleartext
  caveat as the proxy itself (documented).
- Endpoints (JSON):
  - `POST /acquire {clientId}` → if already active, or active has room, mark active
    and return `{status:"active"}`. Otherwise place/keep in queue and return
    `{status:"queued", position, total}`.
  - `POST /heartbeat {clientId}` → refresh `lastSeen`; return current
    `{status, position, total}` (so promotion is noticed on the next beat).
  - `POST /release {clientId}` → remove from active/queue; promote the head of the
    queue into the freed slot.
- **Sweeper** (every few seconds): drop ids whose `lastSeen` is older than a timeout
  (e.g. 30s) from active and queue, then promote queued ids into any free slots.
- **Pure core** (`vps/slot-manager/queue-core.js`): acquire / heartbeat / release /
  sweep / position as pure functions over a state object, with **Node unit tests**
  (`node --test`) — same pattern as `proxy-core.js`. The `http` layer is a thin shell.

### Extension changes

- A persistent random `clientId` generated once and stored (identity in the queue).
- A slot-manager port field (default 8444); host reuses the proxy host.
- Background flow when the proxy should turn on:
  - Call `/acquire`. If `active` → apply the proxy (existing `applyProxyState`) and
    start a heartbeat. If `queued` → **do not** apply the proxy; store
    `slotStatus = {state:"queued", position, total}` for the popup; keep heartbeating.
  - If no slot-manager is configured, or `/acquire` fails/times out → fall back:
    apply the proxy directly and set `slotStatus = {state:"direct"}` (popup shows a
    plain "active", no queue). The gate never blocks a user because of a server
    outage.
  - Heartbeat via **`chrome.alarms`** (survives MV3 service-worker sleep), ~every 10s.
    On each beat, update `slotStatus`; the moment status flips to `active`, apply the
    proxy automatically.
  - On proxy off / browser close → best-effort `/release`, clear the alarm, clear
    `slotStatus`.
- Popup: a status line driven by `slotStatus` — "نشط ✓" when active, or
  "بالطابور: دورك رقم K من M — خلّي المتصفح مفتوح" when queued, refreshed on storage
  change. The proxy toggle stays; turning it on now may land you in the queue.

## Left to the builder

- Exact timeout/interval values (heartbeat ~10s, sweep ~5s, slot timeout ~30s) —
  tune so a closed browser frees its slot within ~30s without false eviction.
- Exact popup wording/styling, consistent with the current Arabic popup.
- systemd unit and README wording, mirroring `vps/setup.sh` / `vps/README.md`.
- Whether the slot port is a new popup field or derived/fixed — builder's call, but
  it must be configurable without code changes.

## Constraints

- Keep the pure/tested-core + thin-shell split already used in `proxy-core.js`.
- No new runtime dependencies on the server (built-in Node only).
- Cross-browser: the extension side must work in both Chrome and Firefox (alarms and
  storage APIs exist in both).
