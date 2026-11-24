# Slot queue for the VPS proxy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cap concurrent proxy users at a configurable limit (default 20) with a FIFO queue, show each waiting user their position in the popup, and let the next person in automatically when a slot frees.

**Architecture:** A new zero-dependency Node service on the VPS (`vps/slot-manager/`) holds active+queue state in memory and exposes acquire/heartbeat/release over HTTP. The extension asks for a slot before enabling the proxy, heartbeats via `chrome.alarms`, and shows slot state in the popup. If the service is absent/unreachable, the extension falls back to turning the proxy on directly (no queue).

**Tech Stack:** Node.js (built-in `http`, `node:test`), WebExtensions MV3 (Chrome + Firefox), existing `proxy-core.js` pure-core + thin-shell pattern.

**Spec:** docs/superpowers/specs/2026-11-23-slot-queue-design.md

## Global Constraints

- Server has **zero external npm dependencies** — built-in Node modules only.
- Keep the pure-core + thin-shell split: testable logic in a `*-core.js` module unit-tested under `node --test`; browser/http APIs only in the shell.
- Cross-browser: every extension-side change works in both Chrome and Firefox (both have `chrome.alarms`, `chrome.storage`, `chrome.permissions`).
- Auth reuses the existing proxy username/password; introduce no new stored secret.
- Backward compatible: with no slot config or an unreachable service, the proxy turns on directly as it does today.
- Extension requests to the service are **CORS-simple** (POST, `Content-Type: text/plain`, credentials in the JSON body, no custom headers) so no preflight is needed; the service sets `Access-Control-Allow-Origin: *`.
- Reaching `http://<host>:<port>` from the extension needs host access for that origin; request it as an **optional** permission scoped to the configured host on a user gesture (saving slot settings). Decline/unavailable → direct fallback.

## Review Focus

- Two browsers acquire the last free slot in the same sweep window → the limit must never be exceeded; `acquire` is the single authority on count. (Task 1 tests concurrent acquire past the limit.)
- A browser closes without calling `/release` → its slot must free within the timeout and promote the queue head. (Task 1 `sweep` tests stale eviction + promotion.)
- `acquire` called repeatedly by an already-active or already-queued id → must be idempotent (no duplicate slot, stable queue position). (Task 1 tests re-acquire.)
- Wrong/missing credentials on a request → rejected without mutating state. (Task 2 tests auth rejection.)
- Service unreachable or slot unconfigured while proxy is toggled on → proxy still turns on (direct), user is never stranded. (Task 4 `slotDecision` tests the error/empty response → direct.)

---

### Task 1: Queue core (pure, tested)

**Files:**
- Create: `vps/slot-manager/queue-core.js`
- Test: `vps/slot-manager/test/queue-core.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `createState(limit) -> State`; `acquire(state, id, now) -> {status, position, total}`; `heartbeat(state, id, now) -> {status, position, total}`; `release(state, id) -> void`; `sweep(state, now, timeoutMs) -> void`; `position(state, id) -> number`. `State = { limit, active: Set<string>, queue: string[], seen: Map<string, number> }` — `seen` holds the last-seen ms for **every** id (active or queued) so `sweep` can evict stale ids from either place. `status` is `"active" | "queued" | "none"`. `position` is the 1-based queue index (0 when active or absent); `total` is `active.size + queue.length`. Exported via `module.exports`.

- [ ] **Step 1: Write the failing tests**

```js
const { test } = require("node:test");
const assert = require("node:assert");
const { createState, acquire, heartbeat, release, sweep, position } = require("../queue-core");

test("acquire grants a slot while under the limit", () => {
  const s = createState(2);
  assert.deepEqual(acquire(s, "a", 1000), { status: "active", position: 0, total: 1 });
  assert.deepEqual(acquire(s, "b", 1000), { status: "active", position: 0, total: 2 });
});

test("acquire past the limit queues in FIFO order", () => {
  const s = createState(1);
  acquire(s, "a", 1000);
  assert.deepEqual(acquire(s, "b", 1000), { status: "queued", position: 1, total: 2 });
  assert.deepEqual(acquire(s, "c", 1000), { status: "queued", position: 2, total: 3 });
});

test("acquire is idempotent for an active id", () => {
  const s = createState(1);
  acquire(s, "a", 1000);
  assert.deepEqual(acquire(s, "a", 1001), { status: "active", position: 0, total: 1 });
});

test("acquire is idempotent for a queued id and keeps its position", () => {
  const s = createState(1);
  acquire(s, "a", 1000);
  acquire(s, "b", 1000);
  acquire(s, "c", 1000);
  assert.deepEqual(acquire(s, "b", 1002), { status: "queued", position: 1, total: 3 });
});

test("release frees a slot and promotes the queue head", () => {
  const s = createState(1);
  acquire(s, "a", 1000);
  acquire(s, "b", 1000);
  release(s, "a");
  assert.equal(heartbeat(s, "b", 1001).status, "active");
});

test("sweep evicts a stale active id and promotes the queue head", () => {
  const s = createState(1);
  acquire(s, "a", 1000);
  acquire(s, "b", 1000);
  sweep(s, 1000 + 40000, 30000); // a is stale (no heartbeat since 1000)
  assert.equal(heartbeat(s, "b", 1000 + 40001).status, "active");
});

test("sweep evicts a stale queued id", () => {
  const s = createState(1);
  acquire(s, "a", 1000);
  acquire(s, "b", 1000);
  heartbeat(s, "a", 70000); // keep a alive
  sweep(s, 70000, 30000);   // b is stale
  assert.equal(position(s, "b"), 0);
});
```

- [ ] **Step 2: Run the tests, verify they fail** — `node --test vps/slot-manager/test/queue-core.test.js`; Expected: FAIL, `createState` not defined.
- [ ] **Step 3: Implement `queue-core.js`** to satisfy the signatures above. `acquire`: if active, refresh and return active; if already queued, return its position; if `active.size < limit`, add to active; else push to queue. `heartbeat`: refresh `lastSeen` wherever the id is (active or queue); if the id is unknown, behave like `acquire`. `release`/`sweep`: remove the id, then while `active.size < limit` and queue non-empty, shift the head into active with the current time. Track queued `lastSeen` in a parallel map or a `{id, lastSeen}` queue — builder's choice, as long as `sweep` can evict stale queued ids.
- [ ] **Step 4: Run the tests, verify they pass** — Expected: PASS, 7/7.
- [ ] **Step 5: Commit** — `git add vps/slot-manager/queue-core.js vps/slot-manager/test/queue-core.test.js && git commit -m "feat(slot): queue core (acquire/heartbeat/release/sweep)"`

---

### Task 2: Request handler + HTTP server (tested handler)

**Files:**
- Create: `vps/slot-manager/server.js`
- Create: `vps/slot-manager/request-core.js`
- Test: `vps/slot-manager/test/request-core.test.js`

**Interfaces:**
- Consumes: Task 1's `queue-core` functions.
- Produces: `handle(state, creds, now, method, path, body) -> {code, json}` in `request-core.js`, where `creds = {username, password}` are the server's configured credentials and `body` is the parsed request object (`{clientId, username, password}`). Routes: `POST /acquire|/heartbeat|/release`. Auth: body `username`/`password` must equal `creds`; otherwise `{code:401, json:{error:"unauthorized"}}` with no state change. Unknown route/method → `{code:404}`. `server.js` imports `handle`, reads env `SLOT_LIMIT` (default 20), `PORT` (default 8444), `PROXY_USER`, `PROXY_PASS`, creates one `State`, runs `sweep` on a `setInterval`, and on each request reads the text body, parses JSON, calls `handle`, and writes the JSON response with `Access-Control-Allow-Origin: *`; it also answers `OPTIONS` with 204 + CORS headers.

- [ ] **Step 1: Write the failing tests**

```js
const { test } = require("node:test");
const assert = require("node:assert");
const { createState } = require("../queue-core");
const { handle } = require("../request-core");
const CREDS = { username: "u", password: "p" };
const ok = (clientId) => ({ clientId, username: "u", password: "p" });

test("acquire route grants a slot", () => {
  const s = createState(2);
  const r = handle(s, CREDS, 1000, "POST", "/acquire", ok("a"));
  assert.equal(r.code, 200);
  assert.equal(r.json.status, "active");
});

test("wrong password is rejected without mutating state", () => {
  const s = createState(1);
  const r = handle(s, CREDS, 1000, "POST", "/acquire", { clientId: "a", username: "u", password: "x" });
  assert.equal(r.code, 401);
  assert.equal(handle(s, CREDS, 1001, "POST", "/acquire", ok("b")).json.status, "active"); // slot still free
});

test("unknown route is 404", () => {
  const s = createState(1);
  assert.equal(handle(s, CREDS, 1000, "POST", "/nope", ok("a")).code, 404);
});

test("heartbeat route returns current status", () => {
  const s = createState(1);
  handle(s, CREDS, 1000, "POST", "/acquire", ok("a"));
  handle(s, CREDS, 1000, "POST", "/acquire", ok("b"));
  assert.equal(handle(s, CREDS, 1001, "POST", "/heartbeat", ok("b")).json.status, "queued");
});

test("release route frees the slot", () => {
  const s = createState(1);
  handle(s, CREDS, 1000, "POST", "/acquire", ok("a"));
  handle(s, CREDS, 1000, "POST", "/acquire", ok("b"));
  handle(s, CREDS, 1001, "POST", "/release", ok("a"));
  assert.equal(handle(s, CREDS, 1002, "POST", "/heartbeat", ok("b")).json.status, "active");
});
```

- [ ] **Step 2: Run the tests, verify they fail** — `node --test vps/slot-manager/test/request-core.test.js`; Expected: FAIL, `handle` not defined.
- [ ] **Step 3: Implement `request-core.js`** (`handle` dispatching to Task 1) and **`server.js`** (http shell: env config, single `State`, `setInterval` sweep ~5s with 30s timeout, body read, JSON parse with try/catch → 400 on bad JSON, CORS headers, OPTIONS 204).
- [ ] **Step 4: Run the tests, verify they pass** — Expected: PASS, 5/5. Then `node --check vps/slot-manager/server.js`.
- [ ] **Step 5: Commit** — `git add vps/slot-manager/request-core.js vps/slot-manager/server.js vps/slot-manager/test/request-core.test.js && git commit -m "feat(slot): request handler and http server"`

---

### Task 3: Deploy script, systemd unit, and docs

**Files:**
- Create: `vps/slot-manager/setup.sh`
- Modify: `vps/README.md`

**Interfaces:**
- Consumes: `server.js`. Produces: nothing code-facing.

- [ ] **Step 1: Write `setup.sh`** (mirrors `vps/setup.sh`): `set -euo pipefail`; require env `PROXY_USER`/`PROXY_PASS`, optional `SLOT_LIMIT` (default 20) and `SLOT_PORT` (default 8444); require root; ensure Node is present (`command -v node`, else `apt-get install -y nodejs`); copy `server.js`, `request-core.js`, `queue-core.js` to `/opt/flow-slot-manager/`; write `/etc/systemd/system/flow-slot-manager.service` (`ExecStart=/usr/bin/node /opt/flow-slot-manager/server.js`, `Environment=` lines for the vars, `User=nobody`, `Restart=on-failure`); `systemctl enable --now`; `ufw allow <SLOT_PORT>/tcp`. Credentials passed via systemd `Environment=`, never written into a world-readable file.
- [ ] **Step 2: Verify** — `bash -n vps/slot-manager/setup.sh`; Expected: no output (valid syntax).
- [ ] **Step 3: Update `vps/README.md`** — a "Slot queue (optional)" section: what it does, how to deploy (`scp` the folder, run `setup.sh` with the same proxy creds and a `SLOT_LIMIT`), that the extension needs the slot port entered and will ask for permission to reach the VPS, and that skipping it leaves the proxy working without a queue.
- [ ] **Step 4: Commit** — `git add vps/slot-manager/setup.sh vps/README.md && git commit -m "feat(slot): deploy script, systemd unit, and docs"`

---

### Task 4: Extension slot-core (pure, tested)

**Files:**
- Create: `slot-core.js`
- Test: `test/slot-core.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `isSlotConfigured(cfg) -> boolean` (true when host+port+username+password all present); `slotUrl(cfg, path) -> string` (`http://<host>:<port><path>`); `slotBody(cfg, clientId) -> object` (`{clientId, username, password}`); `slotDecision(resp) -> {applyProxy, state, position, total}` where `resp` is the parsed service response or `null`/thrown→caught. Mapping: `status:"active"` → `{applyProxy:true, state:"active"}`; `status:"queued"` → `{applyProxy:false, state:"queued", position, total}`; `null`/missing/unknown (service down or unconfigured) → `{applyProxy:true, state:"direct"}`. Exported via `module.exports` and also usable as plain globals when loaded as a background script (same dual pattern as `proxy-core.js`).

- [ ] **Step 1: Write the failing tests**

```js
const { test } = require("node:test");
const assert = require("node:assert");
const { isSlotConfigured, slotUrl, slotBody, slotDecision } = require("../slot-core");
const CFG = { host: "1.2.3.4", port: 8444, username: "u", password: "p" };

test("isSlotConfigured needs all fields", () => {
  assert.equal(isSlotConfigured(CFG), true);
  assert.equal(isSlotConfigured({ ...CFG, port: 0 }), false);
  assert.equal(isSlotConfigured(null), false);
});

test("slotUrl and slotBody build the request", () => {
  assert.equal(slotUrl(CFG, "/acquire"), "http://1.2.3.4:8444/acquire");
  assert.deepEqual(slotBody(CFG, "cid"), { clientId: "cid", username: "u", password: "p" });
});

test("active response turns the proxy on", () => {
  assert.deepEqual(slotDecision({ status: "active", position: 0, total: 1 }),
    { applyProxy: true, state: "active", position: 0, total: 1 });
});

test("queued response keeps the proxy off with a position", () => {
  assert.deepEqual(slotDecision({ status: "queued", position: 2, total: 5 }),
    { applyProxy: false, state: "queued", position: 2, total: 5 });
});

test("no/garbled response falls back to direct (proxy on)", () => {
  assert.equal(slotDecision(null).applyProxy, true);
  assert.equal(slotDecision(null).state, "direct");
  assert.equal(slotDecision({}).state, "direct");
});
```

- [ ] **Step 2: Run the tests, verify they fail** — `node --test test/slot-core.test.js`; Expected: FAIL, module not found.
- [ ] **Step 3: Implement `slot-core.js`** per the signatures, with the `module.exports` guard at the bottom mirroring `proxy-core.js`.
- [ ] **Step 4: Run the tests, verify they pass** — Expected: PASS, 5/5. Then run the whole suite: `node --test` (from repo root) — Expected: all suites green (proxy-core, queue-core, request-core, slot-core).
- [ ] **Step 5: Commit** — `git add slot-core.js test/slot-core.test.js && git commit -m "feat(slot): extension slot-core (config, url, decision)"`

---

### Task 5: Background wiring + manifests

**Files:**
- Modify: `background.js`
- Modify: `manifest.json`

**Interfaces:**
- Consumes: Task 4's `slot-core` (`importScripts("slot-core.js")` alongside `proxy-core.js` in Chrome; via manifest `background.scripts` in Firefox — Task 6), `proxy-core`'s `applyProxyState`.
- Produces: storage keys `clientId` (string, generated once via `crypto.randomUUID()`), `slotConfig` (`{port:number}`; host/user/pass come from the existing `proxyConfig`), `slotStatus` (`{state, position, total}` written for the popup).

- [ ] **Step 1: Add `alarms` to `manifest.json` permissions** (now `["scripting","storage","proxy","webRequest","webRequestAuthProvider","alarms"]`); `importScripts("slot-core.js")` guarded like the `proxy-core.js` import.
- [ ] **Step 2: Implement the slot gate in `background.js`.** Build `slotCfg` by merging `proxyConfig` with `slotConfig.port`. A new `acquireOrQueue()` that: generates/loads `clientId`; if `!isSlotConfigured(slotCfg)` → `applyProxyState()` directly and write `slotStatus={state:"direct"}`; else `fetch(slotUrl(slotCfg,"/acquire"), {method:"POST", headers:{"Content-Type":"text/plain"}, body: JSON.stringify(slotBody(slotCfg, clientId))})`, parse, `slotDecision`; if `applyProxy` → `applyProxyState()`, else clear the proxy (queued users must not proxy) and set `slotStatus`. Wrap the fetch in try/catch → `slotDecision(null)` (direct) on failure. Start a `chrome.alarms` alarm `flow-slot-beat` (periodInMinutes ~0.17 ≈ 10s) while the proxy switch is on; on alarm, POST `/heartbeat`, re-run `slotDecision`, and apply/clear the proxy + update `slotStatus` as the status changes. On proxy-off: best-effort POST `/release`, clear the alarm, remove `slotStatus`.
- [ ] **Step 3: Route the existing proxy toggle through the gate.** Where `storage.onChanged` currently calls `applyProxyState()` for `proxyEnabled`/`proxyConfig`, call `acquireOrQueue()` when turning on and the release path when turning off. Keep the direct `applyProxyState()` reachable for the direct/active cases.
- [ ] **Step 4: Verify** — `node --check background.js`; Expected: no output. `node --test` (repo root) still green (pure cores unchanged).
- [ ] **Step 5: Commit** — `git add background.js manifest.json && git commit -m "feat(slot): background gate, heartbeat alarm, and alarms permission"`

---

### Task 6: Popup UI, optional permission, and Firefox build

**Files:**
- Modify: `popup.html`, `popup.js`
- Modify: `firefox/manifest.json`
- Modify: `build-firefox.sh`

**Interfaces:**
- Consumes: `slotStatus`, `slotConfig`, `proxyConfig` from storage.
- Produces: nothing code-facing.

- [ ] **Step 1: Add the slot port field + status line to `popup.html`** inside the existing `#proxyBox` proxy `<details>`: a `#slotPort` number input (placeholder 8444) and a `#slotMsg` line, labelled e.g. "بورت الطابور (اختياري)".
- [ ] **Step 2: Wire `popup.js`.** Load/save `slotConfig.port` next to the proxy fields. When saving slot settings (a user gesture), if a port is set, request the optional host permission for the configured host: `chrome.permissions.request({ origins: ["http://" + host + "/*"] })`; on denial, write a `#slotMsg` note that the queue is off and the proxy will connect directly. Render `slotStatus` into `#slotMsg`: `direct`/`active` → "نشط ✓"; `queued` → "بالطابور: دورك رقم {position} من {total} — خلّي المتصفح مفتوح". Refresh on `chrome.storage.onChanged`. Add `slot` to `collectDiagnostics()` (`{configured, state, position}` — never the password).
- [ ] **Step 3: Add `optional_host_permissions`/`alarms` to `firefox/manifest.json`** (permissions gains `alarms`; add `optional_host_permissions: ["http://*/*"]` — Firefox grants per-origin at request time), and add `slot-core.js` to `background.scripts` before `background.js`. Mirror Chrome's `manifest.json` where they share keys. (Chrome host access for the configured origin is the Step-2 optional request; add `optional_host_permissions` to Chrome's `manifest.json` too if required for `permissions.request` to resolve.)
- [ ] **Step 4: Add `slot-core.js` to `build-firefox.sh`** `SHARED` list, then run `bash build-firefox.sh`.
- [ ] **Step 5: Verify** — `node --check popup.js`; mirrored files present in `firefox/` (`ls firefox/slot-core.js`). `node --test` (repo root) green.
- [ ] **Step 6: Commit** — `git add popup.html popup.js firefox/manifest.json manifest.json build-firefox.sh firefox/ && git commit -m "feat(slot): popup status, optional host permission, Firefox parity"`
