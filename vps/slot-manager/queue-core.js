"use strict";

// Pure slot-queue logic for the Flow Unlock slot manager. No I/O here, so it is
// unit-tested under Node and reused by the HTTP shell (server.js via request-core).
//
// State = { limit, active: Set<string>, queue: string[], seen: Map<string, number> }
// - active: ids currently holding a slot (size <= limit).
// - queue:  ids waiting, in first-come order.
// - seen:   last-seen ms for EVERY id (active or queued), so sweep can evict
//           whichever side a stale id sits on.

function createState(limit) {
  return { limit, active: new Set(), queue: [], seen: new Map() };
}

// 1-based position in the queue, or 0 when the id is active or unknown.
function position(state, id) {
  const i = state.queue.indexOf(id);
  return i === -1 ? 0 : i + 1;
}

function total(state) {
  return state.active.size + state.queue.length;
}

function statusOf(state, id) {
  if (state.active.has(id)) return "active";
  if (state.queue.includes(id)) return "queued";
  return "none";
}

function result(state, id) {
  return { status: statusOf(state, id), position: position(state, id), total: total(state) };
}

// Pull queue heads into free active slots (used after release/sweep and on acquire).
function promote(state, now) {
  while (state.active.size < state.limit && state.queue.length > 0) {
    const next = state.queue.shift();
    state.active.add(next);
    state.seen.set(next, now);
  }
}

function acquire(state, id, now) {
  state.seen.set(id, now);
  if (state.active.has(id) || state.queue.includes(id)) return result(state, id);
  if (state.active.size < state.limit) {
    state.active.add(id);
  } else {
    state.queue.push(id);
  }
  return result(state, id);
}

// Refresh an id's last-seen wherever it is; an unknown id behaves like acquire.
function heartbeat(state, id, now) {
  if (!state.active.has(id) && !state.queue.includes(id)) return acquire(state, id, now);
  state.seen.set(id, now);
  return result(state, id);
}

function remove(state, id) {
  state.active.delete(id);
  const i = state.queue.indexOf(id);
  if (i !== -1) state.queue.splice(i, 1);
  state.seen.delete(id);
}

function release(state, id) {
  remove(state, id);
  promote(state, Date.now());
}

// Evict ids not seen within timeoutMs from active and queue, then backfill.
function sweep(state, now, timeoutMs) {
  for (const id of [...state.active, ...state.queue]) {
    const last = state.seen.get(id) ?? 0;
    if (now - last > timeoutMs) remove(state, id);
  }
  promote(state, now);
}

module.exports = { createState, acquire, heartbeat, release, sweep, position };
