// Extension-world helper: hands the popup's optional overrides to engine.js,
// and answers the popup's status question by reading what engine.js recorded.
chrome.storage.local.get(["rpcid", "flagIndex"]).then(({ rpcid, flagIndex }) => {
  const spec = {};
  if (rpcid) spec.rpcid = rpcid;
  if (Number.isInteger(flagIndex)) spec.flagIndex = flagIndex;
  if (Object.keys(spec).length) window.postMessage({ type: "flow-unlock-spec", spec }, location.origin);
});

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg === "flow-unlock-status") {
    reply(document.documentElement.dataset.flowUnlock || null);
  }
});
