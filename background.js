// Registers engine.js (page world) and bridge.js (extension world) on Flow at
// document_start while the switch is on, and removes them when it is off.
// Also drives the optional VPS proxy (proxy-core.js provides the pure helpers:
// loaded here in Chrome's service worker, and via the manifest in Firefox).

if (typeof importScripts === "function" && typeof matchesProxyHost === "undefined") {
  importScripts("proxy-core.js");
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

// Apply or clear the proxy to match storage. Idempotent, so it is safe to run
// on every worker wake and on every relevant storage change.
async function applyProxyState() {
  const { proxyEnabled = false, proxyConfig = null } = await chrome.storage.local.get(["proxyEnabled", "proxyConfig"]);
  const decision = proxyDecision(proxyEnabled, proxyConfig);
  try {
    if (decision === "apply") {
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
  if ("proxyEnabled" in changes || "proxyConfig" in changes) applyProxyState();
});
// Also on every worker wake: a Chrome update or profile sync can drop the
// persisted registration, and nothing else would put it back.
sync();
applyProxyState();
