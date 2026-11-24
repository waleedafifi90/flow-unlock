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

test("a failed beat while queued keeps the user queued, not direct", () => {
  const prev = { state: "queued", position: 3, total: 10 };
  assert.deepEqual(slotDecision(null, prev), { applyProxy: false, state: "queued", position: 3, total: 10 });
});

test("a failed beat with no prior queue still falls back to direct", () => {
  assert.equal(slotDecision(null, { state: "active" }).state, "direct");
  assert.equal(slotDecision(null, { state: "direct" }).state, "direct");
  assert.equal(slotDecision(null).state, "direct");
});

test("a real response ignores prior state", () => {
  assert.equal(slotDecision({ status: "active" }, { state: "queued" }).state, "active");
});
