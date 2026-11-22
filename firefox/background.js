// Registers engine.js (page world) and bridge.js (extension world) on Flow at
// document_start while the switch is on, and removes them when it is off.

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

chrome.runtime.onInstalled.addListener(sync);
chrome.runtime.onStartup.addListener(sync);
chrome.runtime.onMessage.addListener((msg) => {
  if (msg === "flow-unlock-resync") sync();
});
chrome.storage.onChanged.addListener((changes) => {
  if ("enabled" in changes) sync();
});
// Also on every worker wake: a Chrome update or profile sync can drop the
// persisted registration, and nothing else would put it back.
sync();
