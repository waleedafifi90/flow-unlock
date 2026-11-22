const { test } = require("node:test");
const assert = require("node:assert");
const C = require("../proxy-core.js");

test("matches google + subdomains, not others", () => {
  assert.ok(C.matchesProxyHost("flow.google.com"));
  assert.ok(C.matchesProxyHost("accounts.google.com"));
  assert.ok(C.matchesProxyHost("content.googleapis.com"));
  assert.ok(!C.matchesProxyHost("example.com"));
  assert.ok(!C.matchesProxyHost("notgoogle.com"));
});

test("config completeness", () => {
  assert.ok(C.isCompleteProxyConfig({ host: "1.2.3.4", port: 8443, username: "u", password: "p" }));
  assert.ok(!C.isCompleteProxyConfig({ host: "1.2.3.4", port: 8443, username: "u", password: "" }));
  assert.ok(!C.isCompleteProxyConfig({ host: "", port: 8443, username: "u", password: "p" }));
  assert.ok(!C.isCompleteProxyConfig({ host: "1.2.3.4", port: 0, username: "u", password: "p" }));
});

test("decision", () => {
  const good = { host: "1.2.3.4", port: 8443, username: "u", password: "p" };
  assert.equal(C.proxyDecision(true, good), "apply");
  assert.equal(C.proxyDecision(false, good), "clear");
  assert.equal(C.proxyDecision(true, { host: "" }), "clear");
});

test("backend: onRequest wins (Firefox exposes both), settings is Chrome", () => {
  assert.equal(C.proxyBackend({ onRequest: {}, settings: {} }), "onRequest"); // Firefox
  assert.equal(C.proxyBackend({ settings: {} }), "settings"); // Chrome
  assert.equal(C.proxyBackend(null), "none");
});

test("pac proxies google, direct otherwise", () => {
  const pac = C.buildPac("1.2.3.4", 8443);
  const run = new Function(pac + "\nreturn FindProxyForURL;")();
  assert.equal(run("https://flow.google.com/x", "flow.google.com"), "PROXY 1.2.3.4:8443");
  assert.equal(run("https://example.com/", "example.com"), "DIRECT");
});
