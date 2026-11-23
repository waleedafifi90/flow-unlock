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
