"use strict";

// Pure slot-queue client helpers, shared by the Chrome and Firefox background
// scripts and unit-tested under Node. No browser APIs here (background.js does the
// fetch and storage); this only shapes requests and reads the server's answer.
//
// The slot config reuses the proxy's host/user/pass plus a slot port:
//   cfg = { host, port, username, password }

function isSlotConfigured(cfg) {
  return !!(
    cfg &&
    typeof cfg.host === "string" && cfg.host.length > 0 &&
    Number.isInteger(cfg.port) && cfg.port >= 1 && cfg.port <= 65535 &&
    typeof cfg.username === "string" && cfg.username.length > 0 &&
    typeof cfg.password === "string" && cfg.password.length > 0
  );
}

function slotUrl(cfg, path) {
  return "http://" + cfg.host + ":" + cfg.port + path;
}

function slotBody(cfg, clientId) {
  return { clientId, username: cfg.username, password: cfg.password };
}

// Turn the server's parsed response into a decision for the background script.
// A real response is honored as-is. A null/garbled/unknown response means the
// service is down or unconfigured; then:
//   - if the client was already queued (prev.state === "queued"), KEEP it queued
//     (proxy stays off). Falling to "direct" here would briefly admit a queued
//     user on every failed heartbeat and defeat the cap — the spec's anti-goal.
//   - otherwise fall back to "direct" (proxy on), so first contact / a new user
//     is never stranded by a transient outage.
function slotDecision(resp, prev) {
  if (resp && resp.status === "active") {
    return { applyProxy: true, state: "active", position: resp.position ?? 0, total: resp.total ?? 1 };
  }
  if (resp && resp.status === "queued") {
    return { applyProxy: false, state: "queued", position: resp.position ?? 0, total: resp.total ?? 0 };
  }
  if (prev && prev.state === "queued") {
    return { applyProxy: false, state: "queued", position: prev.position ?? 0, total: prev.total ?? 0 };
  }
  return { applyProxy: true, state: "direct" };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { isSlotConfigured, slotUrl, slotBody, slotDecision };
}
