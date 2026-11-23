"use strict";

// Pure proxy helpers, shared by the Chrome and Firefox background scripts and
// unit-tested under Node. No browser APIs here, so it loads in both worlds.

// Host suffixes routed through the VPS: sign-in + Flow + the Google services
// Flow loads. Kept together so the apparent IP stays consistent across them.
const GOOGLE_HOST_PATTERNS = [
  "flow.google.com",
  "labs.google",
  "accounts.google.com",
  "googleapis.com",
  "gstatic.com",
  "apis.google.com",
  "play.google.com",
  "googleusercontent.com",
];

// True when hostname equals a pattern or is a subdomain of one.
function matchesProxyHost(hostname, patterns = GOOGLE_HOST_PATTERNS) {
  const host = String(hostname || "").toLowerCase();
  return patterns.some((p) => host === p || host.endsWith("." + p));
}

// Every field present and sane. A blank password or zero port is incomplete,
// so the background never arms a half-configured proxy.
function isCompleteProxyConfig(config) {
  if (!config || typeof config !== "object") return false;
  const port = config.port;
  return (
    typeof config.host === "string" && config.host.length > 0 &&
    Number.isInteger(port) && port >= 1 && port <= 65535 &&
    typeof config.username === "string" && config.username.length > 0 &&
    typeof config.password === "string" && config.password.length > 0
  );
}

// "apply" only when the switch is on and the config is complete; "clear" otherwise.
function proxyDecision(enabled, config) {
  return enabled && isCompleteProxyConfig(config) ? "apply" : "clear";
}

// Which proxy API to drive. Firefox exposes proxy.onRequest (and also
// proxy.settings, with a different schema), so onRequest uniquely marks Firefox;
// Chrome has only proxy.settings (PAC).
function proxyBackend(proxyApi) {
  if (proxyApi && proxyApi.onRequest) return "onRequest";
  if (proxyApi && proxyApi.settings) return "settings";
  return "none";
}

// A PAC that sends matching Google hosts to the proxy and everything else direct.
// The patterns are inlined as a literal so the function is self-contained in the
// browser's PAC sandbox, which has no access to this module's scope.
function buildPac(host, port, patterns = GOOGLE_HOST_PATTERNS) {
  const list = JSON.stringify(patterns);
  const proxy = JSON.stringify(`PROXY ${host}:${port}`);
  return (
    "function FindProxyForURL(url, host) {\n" +
    "  host = (host || '').toLowerCase();\n" +
    "  var patterns = " + list + ";\n" +
    "  for (var i = 0; i < patterns.length; i++) {\n" +
    "    var p = patterns[i];\n" +
    "    if (host === p || host.slice(-(p.length + 1)) === '.' + p) return " + proxy + ";\n" +
    "  }\n" +
    "  return 'DIRECT';\n" +
    "}\n"
  );
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { GOOGLE_HOST_PATTERNS, matchesProxyHost, isCompleteProxyConfig, proxyDecision, proxyBackend, buildPac };
}
