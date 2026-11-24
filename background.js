// Registers engine.js (page world) and bridge.js (extension world) on Flow at
// document_start while the switch is on, and removes them when it is off.
// Also drives the optional VPS proxy (proxy-core.js provides the pure helpers:
// loaded here in Chrome's service worker, and via the manifest in Firefox).

if (typeof importScripts === "function") {
  if (typeof matchesProxyHost === "undefined") importScripts("proxy-core.js");
  if (typeof slotDecision === "undefined") importScripts("slot-core.js");
}

const MATCHES = ["https://flow.google.com/*", "https://labs.google/fx/*"];
const SCRIPTS = [
  { id: "flow-unlock-engine", js: ["engine.js"], world: "MAIN" },
  { id: "flow-unlock-bridge", js: ["bridge.js"], world: "ISOLATED" }
];

// Runs one at a time: install, startup and worker wake can all fire together, and
// two interleaved unregister/register passes would fail on the duplicate id.
let queue = Promise.resolve();
function sync() {
  queue = queue.then(syncNow, syncNow);
  return queue;
}

async function syncNow() {
  const { enabled = true } = await chrome.storage.local.get("enabled");
  let regError = null;
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: SCRIPTS.map((s) => s.id) });
    if (existing.length) {
      await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
    }
    if (enabled) {
      await chrome.scripting.registerContentScripts(
        SCRIPTS.map((s) => ({ ...s, matches: MATCHES, runAt: "document_start", allFrames: true, persistAcrossSessions: true }))
      );
    }
  } catch (err) {
    // Surfaced in the popup's diagnostics; otherwise this fails silently.
    regError = String(err?.message || err);
  }
  await chrome.storage.local.set({ regError });
  await chrome.action.setBadgeBackgroundColor({ color: regError ? "#d93025" : "#188038" });
  await chrome.action.setBadgeText({ text: regError ? "ERR" : enabled ? "ON" : "" });
}

// ---------------------------------------------------------------- VPS proxy
// Chrome exposes chrome.proxy.settings (PAC); Firefox exposes chrome.proxy.onRequest
// (per-request listener). Feature-detect so one shared file serves both.
const proxyUsesOnRequest = proxyBackend(chrome.proxy) === "onRequest"; // Firefox vs Chrome PAC
let ffProxy = null; // Firefox: the active proxy config, or null when off.

// Firefox per-request router: proxy the Google set, everything else direct.
function ffOnRequest(details) {
  if (ffProxy) {
    try {
      if (matchesProxyHost(new URL(details.url).hostname)) {
        return { type: "http", host: ffProxy.host, port: ffProxy.port };
      }
    } catch {}
  }
  return { type: "direct" };
}

// Turn the proxy on (apply) or off (clear) at the browser level, using the right
// backend for Chrome (PAC) or Firefox (onRequest). The slot gate below calls this
// directly so it can force the proxy off for a queued user.
async function setProxy(on, proxyConfig) {
  try {
    if (on) {
      if (!proxyUsesOnRequest) {
        await chrome.proxy.settings.set({
          value: { mode: "pac_script", pacScript: { data: buildPac(proxyConfig.host, proxyConfig.port) } },
          scope: "regular",
        });
      } else {
        ffProxy = proxyConfig;
        if (!chrome.proxy.onRequest.hasListener(ffOnRequest)) {
          chrome.proxy.onRequest.addListener(ffOnRequest, { urls: ["<all_urls>"] });
        }
      }
    } else {
      if (!proxyUsesOnRequest) {
        await chrome.proxy.settings.clear({ scope: "regular" });
      } else {
        ffProxy = null;
        if (chrome.proxy.onRequest.hasListener(ffOnRequest)) {
          chrome.proxy.onRequest.removeListener(ffOnRequest);
        }
      }
    }
    await chrome.storage.local.set({ proxyError: null });
  } catch (err) {
    await chrome.storage.local.set({ proxyError: String(err?.message || err) });
  }
}

// Apply or clear the proxy to match storage. Idempotent, so it is safe to run
// on every worker wake and on every relevant storage change.
async function applyProxyState() {
  const { proxyEnabled = false, proxyConfig = null } = await chrome.storage.local.get(["proxyEnabled", "proxyConfig"]);
  await setProxy(proxyDecision(proxyEnabled, proxyConfig) === "apply", proxyConfig);
}

// ------------------------------------------------------------------ slot queue
// Optional gatekeeper: before turning the proxy on, ask the VPS slot manager for
// a slot. Active → proxy on. Queued → proxy stays off and the popup shows the
// position. No slot manager configured, or it is unreachable → proxy on directly
// (slot-core's "direct" fallback), so an outage never strands the user.
const BEAT_ALARM = "flow-slot-beat";

// The slot manager reuses the proxy's host/user/pass plus a slot port.
function slotCfg(proxyConfig, slotConfig) {
  if (!proxyConfig || !slotConfig || !slotConfig.port) return null;
  return { host: proxyConfig.host, port: Number(slotConfig.port), username: proxyConfig.username, password: proxyConfig.password };
}

async function getClientId() {
  const { clientId } = await chrome.storage.local.get("clientId");
  if (clientId) return clientId;
  const id = (crypto.randomUUID && crypto.randomUUID()) || Date.now() + Math.random().toString(16).slice(2);
  await chrome.storage.local.set({ clientId: id });
  return id;
}

// POST a slot request as a CORS-simple call; return the parsed body or null on
// any failure (slotDecision turns null into the "direct" fallback).
async function slotBeat(cfg, path, clientId) {
  try {
    const res = await fetch(slotUrl(cfg, path), {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(slotBody(cfg, clientId)),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function writeStatus(dec) {
  await chrome.storage.local.set({ slotStatus: { state: dec.state, position: dec.position ?? 0, total: dec.total ?? 0 } });
}

// Called when the proxy is switched on: acquire a slot (or enter the queue).
async function gateProxyOn() {
  const { proxyConfig = null, slotConfig = null } = await chrome.storage.local.get(["proxyConfig", "slotConfig"]);
  const cfg = slotCfg(proxyConfig, slotConfig);
  if (!isSlotConfigured(cfg)) {
    await applyProxyState();
    await chrome.storage.local.set({ slotStatus: { state: "direct", position: 0, total: 0 } });
    return;
  }
  const dec = slotDecision(await slotBeat(cfg, "/acquire", await getClientId()));
  await setProxy(dec.applyProxy, proxyConfig);
  await writeStatus(dec);
  startBeat();
}

// Periodic heartbeat: keep the slot (or queue place) alive and react to promotion.
async function onBeat() {
  const { proxyEnabled = false, proxyConfig = null, slotConfig = null, slotStatus = null } =
    await chrome.storage.local.get(["proxyEnabled", "proxyConfig", "slotConfig", "slotStatus"]);
  if (!proxyEnabled) return stopBeat();
  const cfg = slotCfg(proxyConfig, slotConfig);
  if (!isSlotConfigured(cfg)) return; // direct mode: nothing to beat
  // Pass the prior status so a failed beat keeps a queued user queued (not direct).
  const dec = slotDecision(await slotBeat(cfg, "/heartbeat", await getClientId()), slotStatus);
  await setProxy(dec.applyProxy, proxyConfig);
  await writeStatus(dec);
  // Just promoted from the queue → reload Flow so it retries with the proxy on.
  if (dec.state === "active" && slotStatus && slotStatus.state === "queued") {
    const tabs = await chrome.tabs.query({ url: "https://flow.google.com/*" });
    for (const t of tabs) chrome.tabs.reload(t.id);
  }
}

// Called when the proxy is switched off: give the slot back and stop beating.
async function releaseSlot() {
  stopBeat();
  const { proxyConfig = null, slotConfig = null } = await chrome.storage.local.get(["proxyConfig", "slotConfig"]);
  const cfg = slotCfg(proxyConfig, slotConfig);
  if (isSlotConfigured(cfg)) await slotBeat(cfg, "/release", await getClientId());
  await setProxy(false, proxyConfig);
  await chrome.storage.local.remove("slotStatus");
}

function startBeat() {
  if (chrome.alarms) chrome.alarms.create(BEAT_ALARM, { periodInMinutes: 0.5 }); // 30s (Chrome's min)
}
function stopBeat() {
  if (chrome.alarms) chrome.alarms.clear(BEAT_ALARM);
}

// On a cold worker wake, line the proxy back up with the stored switch.
async function reconcileProxy() {
  const { proxyEnabled = false } = await chrome.storage.local.get("proxyEnabled");
  if (proxyEnabled) await gateProxyOn();
  else await applyProxyState();
}

// Answer the proxy's auth challenge from stored credentials — and ONLY the
// proxy's, never a site's own login. Reads storage live so a cold worker still
// has the password. Chrome uses the asyncBlocking callback; Firefox a Promise.
async function proxyCredentials(details) {
  if (!details.isProxy) return {};
  const { proxyConfig } = await chrome.storage.local.get("proxyConfig");
  if (proxyConfig && proxyConfig.username && proxyConfig.password) {
    return { authCredentials: { username: proxyConfig.username, password: proxyConfig.password } };
  }
  return {};
}

// Register the proxy-auth handler, but never let a failure here stop the content
// scripts below from registering. Firefox needs "webRequestBlocking" for the
// blocking form; if that permission is missing the addListener throws, and
// without this guard it would kill the country-unlock registration too.
if (chrome.webRequest && chrome.webRequest.onAuthRequired) {
  try {
    if (!proxyUsesOnRequest) {
      chrome.webRequest.onAuthRequired.addListener(
        (details, callback) => { proxyCredentials(details).then(callback); },
        { urls: ["<all_urls>"] },
        ["asyncBlocking"]
      );
    } else {
      chrome.webRequest.onAuthRequired.addListener(
        proxyCredentials,
        { urls: ["<all_urls>"] },
        ["blocking"]
      );
    }
  } catch (err) {
    chrome.storage.local.set({ proxyError: "auth listener: " + String(err?.message || err) });
  }
}

chrome.runtime.onInstalled.addListener(sync);
chrome.runtime.onStartup.addListener(sync);
chrome.runtime.onMessage.addListener((msg) => {
  if (msg === "flow-unlock-resync") sync();
});
chrome.storage.onChanged.addListener((changes) => {
  if ("enabled" in changes) sync();
  if ("proxyEnabled" in changes) {
    if (changes.proxyEnabled.newValue) gateProxyOn();
    else releaseSlot();
  } else if ("proxyConfig" in changes || "slotConfig" in changes) {
    reconcileProxy(); // re-acquire with the new settings if the proxy is on
  }
});
if (chrome.alarms) {
  chrome.alarms.onAlarm.addListener((a) => { if (a.name === BEAT_ALARM) onBeat(); });
}
// Also on every worker wake: a Chrome update or profile sync can drop the
// persisted registration, and nothing else would put it back.
sync();
reconcileProxy();
