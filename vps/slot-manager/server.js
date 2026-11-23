"use strict";

// Flow Unlock slot manager — a zero-dependency HTTP shell around request-core.
// Holds one in-memory queue state, sweeps stale clients, and answers the
// extension's acquire/heartbeat/release calls. Config comes from the environment:
//
//   PROXY_USER, PROXY_PASS   credentials the extension must send (same as the proxy)
//   SLOT_LIMIT               max active users at once (default 20)
//   PORT                     listen port (default 8444)
//
// Requests are CORS-simple (POST, text/plain body, no custom headers), so the
// extension needs no preflight; we return Access-Control-Allow-Origin: * anyway
// and answer OPTIONS, in case a browser upgrades the request.

const http = require("http");
const { createState, sweep } = require("./queue-core");
const { handle } = require("./request-core");

const LIMIT = Number(process.env.SLOT_LIMIT) || 20;
const PORT = Number(process.env.PORT) || 8444;
const CREDS = { username: process.env.PROXY_USER, password: process.env.PROXY_PASS };

if (!CREDS.username || !CREDS.password) {
  console.error("Set PROXY_USER and PROXY_PASS."); process.exit(1);
}

const SWEEP_MS = 5000;
const TIMEOUT_MS = 30000;
const state = createState(LIMIT);
setInterval(() => sweep(state, Date.now(), TIMEOUT_MS), SWEEP_MS).unref();

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const server = http.createServer((req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }

  let raw = "";
  req.on("data", (c) => {
    raw += c;
    if (raw.length > 4096) req.destroy(); // tiny JSON only; don't buffer abuse
  });
  req.on("end", () => {
    let body = null;
    try { body = JSON.parse(raw || "{}"); } catch { body = null; }
    const out = body === null
      ? { code: 400, json: { error: "bad_json" } }
      : handle(state, CREDS, Date.now(), req.method, req.url, body);
    res.writeHead(out.code, { ...CORS, "Content-Type": "application/json" });
    res.end(JSON.stringify(out.json));
  });
});

server.listen(PORT, () => console.log(`slot manager on :${PORT} (limit ${LIMIT})`));
