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
