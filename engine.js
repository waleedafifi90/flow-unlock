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
  const state = (window.__flowUnlock = { patched: 0, before: null });
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
      return u.origin === location.origin &&
        u.pathname.endsWith("/data/batchexecute") &&
        (u.searchParams.get("rpcids") || "").split(",").includes(spec.rpcid);
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
      publish();
    }
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
        headers.delete("content-length");
        return new Response(out, { status: res.status, statusText: res.statusText, headers });
      } catch (err) {
        console.warn("[Flow Unlock] fetch patch failed", err);
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
        if (!targets.has(this) || this.readyState !== 4 || typeof raw !== "string") return raw;
        if (!cache.has(this)) {
          let out = null;
          try { out = patch(raw); } catch (err) { console.warn("[Flow Unlock] xhr patch failed", err); }
          cache.set(this, out ?? raw);
        }
        return cache.get(this);
      }
    });
  }
})();
