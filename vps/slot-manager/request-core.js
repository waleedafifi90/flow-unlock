"use strict";

// Pure request router for the slot manager: no sockets here, so it is unit-tested
// under Node. server.js reads the socket and calls handle(); this decides auth,
// routing, and the JSON response from queue-core.

const { acquire, heartbeat, release } = require("./queue-core");

// handle(state, creds, now, method, path, body) -> { code, json }
// - creds: the server's configured { username, password }.
// - body:  the parsed request object { clientId, username, password }.
// Auth is checked before any state change, so a bad request never mutates state.
function handle(state, creds, now, method, path, body) {
  if (method !== "POST") return { code: 405, json: { error: "method" } };
  body = body || {};
  if (body.username !== creds.username || body.password !== creds.password) {
    return { code: 401, json: { error: "unauthorized" } };
  }
  const id = body.clientId;
  if (!id || typeof id !== "string") return { code: 400, json: { error: "clientId" } };

  if (path === "/acquire") return { code: 200, json: acquire(state, id, now) };
  if (path === "/heartbeat") return { code: 200, json: heartbeat(state, id, now) };
  if (path === "/release") {
    release(state, id);
    return { code: 200, json: { status: "none", position: 0, total: state.active.size + state.queue.length } };
  }
  return { code: 404, json: { error: "not_found" } };
}

module.exports = { handle };
