// Runs in the page's own JS world at document_start on Flow.
// Flow asks the server for its account config through a batchexecute RPC; the
// reply carries a "Flow available in your country" flag. When it is false the
// app redirects to /unsupported-country. We flip that flag in the reply before
// the app reads it. Nothing leaves the browser.
(() => {
  "use strict";
  if (window.__flowUnlock) return;

  const spec = {
    rpcid: "cPZSdc",   // the config RPC
    flagIndex: 30,      // region-availability flag inside its payload
    extraIndexes: [31]  // neighbouring eligibility flag, only flipped when explicitly false
  };
  // Besides the patch count, keep enough detail for the popup's diagnostics to
  // tell "script never ran" from "RPC id changed" from "flag moved".
  const state = (window.__flowUnlock = {
    patched: 0,
    before: null,
    seen: [],       // rpcids of every batchexecute call this page made
    payloadLen: null,
    falseIdx: [],   // indexes that were false in the config payload before patching
    error: null
  });
  // Mirror state onto <html> so bridge.js (another JS world) can report it to the popup.
  const publish = () => {
    if (document.documentElement) document.documentElement.dataset.flowUnlock = JSON.stringify(state);
  };
  publish();

  // Optional overrides from bridge.js (the popup's "advanced" fields).
  window.addEventListener("message", (e) => {
    if (e.source !== window || e.data?.type !== "flow-unlock-spec") return;
    Object.assign(spec, e.data.spec);
  });

  function isTarget(rawUrl) {
    try {
      const u = new URL(rawUrl, location.href);
      if (!u.pathname.endsWith("/batchexecute")) return false;
      const sameOrigin = u.origin === location.origin;
      const ids = (u.searchParams.get("rpcids") || "").split(",").filter(Boolean);
      // Cross-origin calls are only recorded (prefixed with their host), never patched.
      const fresh = ids.map((id) => (sameOrigin ? id : `${u.host}:${id}`)).filter((id) => !state.seen.includes(id));
      if (fresh.length) {
        state.seen.push(...fresh);
        publish();
      }
      return sameOrigin && ids.includes(spec.rpcid);
    } catch {
      return false;
    }
  }

  // batchexecute body: ")]}'" then pairs of lines <length>\n<json envelope>.
  // Returns the patched body, or null if there was nothing to patch.
  function patch(body) {
    const lines = body.split("\n");
    let changed = false;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i].replace(/\r$/, "");
      if (!raw.startsWith("[[")) continue;
      let envelopes;
      try { envelopes = JSON.parse(raw); } catch { continue; }

      let hit = false;
      for (const env of envelopes) {
        if (!Array.isArray(env) || env[0] !== "wrb.fr" || env[1] !== spec.rpcid || typeof env[2] !== "string") continue;
        let payload;
        try { payload = JSON.parse(env[2]); } catch { continue; }
        if (!Array.isArray(payload)) continue;

        state.payloadLen = payload.length;
        state.falseIdx = payload.flatMap((v, idx) => (v === false ? [idx] : []));
        while (payload.length <= spec.flagIndex) payload.push(null);
        state.before = payload[spec.flagIndex];
        payload[spec.flagIndex] = true;
        for (const idx of spec.extraIndexes) {
          if (payload[idx] === false) payload[idx] = true;
        }
        env[2] = JSON.stringify(payload);
        hit = true;
      }
      if (!hit) continue;

      const next = JSON.stringify(envelopes);
      // Keep the length prefix on the previous line consistent (it may count
      // UTF-16 units or bytes, and may include the newline).
      const prev = Number(lines[i - 1]);
      if (i > 0 && Number.isFinite(prev)) {
        const bytes = (s) => new TextEncoder().encode(s).length;
        const unit = [bytes, (s) => s.length].find((f) => [0, 1, 2].includes(prev - f(raw)));
        if (unit) lines[i - 1] = String(prev + unit(next) - unit(raw));
      }
      lines[i] = next;
      changed = true;
    }
    if (changed) {
      state.patched++;
      state.error = null;
    } else {
      state.error = `reply had no ${spec.rpcid} payload`;
    }
    publish();
    return changed ? lines.join("\n") : null;
  }

  // Exposed for the Node test script.
  if (typeof module !== "undefined") module.exports = { patch, isTarget, spec };

  // fetch transport
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = async function (input, init) {
      const res = await origFetch.apply(this, arguments);
      const url = input instanceof Request ? input.url : String(input);
      if (!isTarget(url)) return res;
      try {
        const out = patch(await res.clone().text());
        if (out === null) return res;
        const headers = new Headers(res.headers);
        // Both describe the original wire bytes, not the rewritten body.
        headers.delete("content-length");
        headers.delete("content-encoding");
        const next = new Response(out, { status: res.status, statusText: res.statusText, headers });
        // A constructed Response has an empty url and type "default"; carry the
        // real ones over (clones too) in case the app checks them.
        const keepMeta = (r) => {
          for (const key of ["url", "redirected", "type"]) {
            Object.defineProperty(r, key, { value: res[key], configurable: true });
          }
          const clone = r.clone.bind(r);
          Object.defineProperty(r, "clone", { value: () => keepMeta(clone()), configurable: true });
          return r;
        };
        return keepMeta(next);
      } catch (err) {
        console.warn("[Flow Unlock] fetch patch failed", err);
        state.error = String(err);
        publish();
        return res;
      }
    };
  }

  // XHR transport
  const proto = XMLHttpRequest.prototype;
  const targets = new WeakSet();
  const cache = new WeakMap();
  const origOpen = proto.open;
  proto.open = function (method, url) {
    if (isTarget(String(url))) targets.add(this); else targets.delete(this);
    cache.delete(this);
    return origOpen.apply(this, arguments);
  };
  for (const prop of ["responseText", "response"]) {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc?.get || !desc.configurable) continue;
    Object.defineProperty(proto, prop, {
      ...desc,
      get() {
        const raw = desc.get.call(this);
        if (!targets.has(this) || typeof raw !== "string") return raw;
        // Hold partial chunks back: if the app parses the reply while it is still
        // loading, it would read the unpatched flag before we can flip it.
        if (this.readyState === 3) return "";
        if (this.readyState !== 4) return raw;
        if (!cache.has(this)) {
          let out = null;
          try {
            out = patch(raw);
          } catch (err) {
            console.warn("[Flow Unlock] xhr patch failed", err);
            state.error = String(err);
            publish();
          }
          cache.set(this, out ?? raw);
        }
        return cache.get(this);
      }
    });
  }
})();
