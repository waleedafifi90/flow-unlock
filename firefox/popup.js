const $ = (id) => document.getElementById(id);
const FLOW_URL = "https://flow.google.com/";
const isFlow = (url = "") => url.startsWith("https://flow.google.com/") || url.startsWith("https://labs.google/fx/");

const TITLES = { ok: "شغّالة", warn: "انتبه", "": "متوقفة" };

function show(text, kind = "") {
  $("status").textContent = text;
  $("statusTitle").textContent = TITLES[kind];
  $("card").className = "card " + kind;
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function refreshStatus() {
  const { enabled = true } = await chrome.storage.local.get("enabled");
  $("enabled").checked = enabled;
  if (!enabled) return show("الإضافة متوقفة.");

  const tab = await activeTab();
  if (!tab || !isFlow(tab.url)) return show("شغّالة. افتح Flow من الزر تحت.", "ok");

  let raw = null;
  try { raw = await chrome.tabs.sendMessage(tab.id, "flow-unlock-status"); } catch {}
  if (!raw) return show("هاي الصفحة انفتحت قبل الإضافة — اضغط «تحديث الصفحة».", "warn");

  const s = JSON.parse(raw);
  const { rpcid = "cPZSdc" } = await chrome.storage.local.get("rpcid");
  if (s.patched > 0) {
    show("تم فتح Flow ✓", "ok");
  } else if (s.seen?.length && !s.seen.includes(rpcid)) {
    show(`جوجل غيّر رقم الطلب. الأرقام اللي ظهرت: ${s.seen.join("، ")} — اضغط «نسخ التشخيص» وابعته.`, "warn");
  } else if (s.error) {
    show(`وصل الرد بس ما قدرت أعدّله (${s.error}). اضغط «نسخ التشخيص».`, "warn");
  } else if (tab.url.includes("unsupported-country")) {
    show("لسا محوّلك على صفحة الدولة. اضغط «تحديث الصفحة»؛ إذا ضلت، يمكن جوجل غيّر الأرقام (شوف متقدم).", "warn");
  } else {
    show("جاهزة، ولسا ما وصل رد الإعدادات من جوجل.", "ok");
  }
}

$("enabled").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ enabled: e.target.checked });
  refreshStatus();
});

$("open").addEventListener("click", () => chrome.tabs.create({ url: FLOW_URL }));

$("reload").addEventListener("click", async () => {
  const tab = await activeTab();
  if (tab && isFlow(tab.url)) {
    // Leave the unsupported-country page so the app re-runs its check.
    chrome.tabs.update(tab.id, { url: tab.url.includes("unsupported-country") ? FLOW_URL : tab.url });
  } else {
    chrome.tabs.create({ url: FLOW_URL });
  }
  window.close();
});

$("saveAdv").addEventListener("click", async () => {
  const rpcid = $("rpcid").value.trim();
  const flagIndex = $("flagIndex").value === "" ? undefined : Number($("flagIndex").value);
  await chrome.storage.local.remove(["rpcid", "flagIndex"]);
  await chrome.storage.local.set({ ...(rpcid && { rpcid }), ...(Number.isInteger(flagIndex) && { flagIndex }) });
  show("انحفظ. حدّث صفحة Flow لتطبيقه.", "ok");
});

// ---- VPS proxy (optional) ----
function renderSlot(slotStatus) {
  if (!slotStatus || slotStatus.state === "none") return ($("slotMsg").textContent = "");
  if (slotStatus.state === "queued") {
    $("slotMsg").textContent = `بالطابور: دورك رقم ${slotStatus.position} من ${slotStatus.total} — خلّي المتصفح مفتوح.`;
  } else {
    $("slotMsg").textContent = "نشط ✓"; // direct or active
  }
}

async function loadProxy() {
  const { proxyEnabled = false, proxyConfig = null, slotConfig = null, slotStatus = null } =
    await chrome.storage.local.get(["proxyEnabled", "proxyConfig", "slotConfig", "slotStatus"]);
  $("proxyEnabled").checked = proxyEnabled;
  if (proxyConfig) {
    $("proxyHost").value = proxyConfig.host || "";
    $("proxyPort").value = proxyConfig.port || "";
    $("proxyUser").value = proxyConfig.username || "";
    $("proxyPass").value = proxyConfig.password || "";
  }
  if (slotConfig && slotConfig.port) $("slotPort").value = slotConfig.port;
  renderSlot(slotStatus);
}

$("saveProxy").addEventListener("click", async () => {
  const config = {
    host: $("proxyHost").value.trim(),
    port: Number($("proxyPort").value),
    username: $("proxyUser").value.trim(),
    password: $("proxyPass").value,
  };
  const slotPort = Number($("slotPort").value);
  await chrome.storage.local.set({ proxyConfig: config });
  $("proxyMsg").textContent = "انحفظ ✓ — إذا البروكسي شغّال، حدّث Flow.";

  if (Number.isInteger(slotPort) && slotPort > 0) {
    await chrome.storage.local.set({ slotConfig: { port: slotPort } });
    // Reaching http://host:port needs host access; ask for it on this click.
    let granted = true;
    try {
      granted = await chrome.permissions.request({ origins: ["http://" + config.host + "/*"] });
    } catch { granted = false; }
    $("slotMsg").textContent = granted
      ? "الطابور مفعّل ✓"
      : "ما في صلاحية الوصول للسيرفر — البروكسي رح يشتغل مباشرة بدون طابور.";
  } else {
    await chrome.storage.local.remove("slotConfig");
    $("slotMsg").textContent = "";
  }
});

$("proxyEnabled").addEventListener("change", async (e) => {
  await chrome.storage.local.set({ proxyEnabled: e.target.checked });
  $("proxyMsg").textContent = e.target.checked ? "شغّال — حدّث Flow ليسري." : "متوقف — التصفح رجع مباشر.";
  const tabs = await chrome.tabs.query({ url: "https://flow.google.com/*" });
  for (const t of tabs) chrome.tabs.reload(t.id);
});

// Everything needed to tell why it fails on a given machine, as copyable text.
async function collectDiagnostics() {
  chrome.runtime.sendMessage("flow-unlock-resync").catch(() => {});
  const tab = await activeTab();
  const stored = await chrome.storage.local.get(["enabled", "regError", "rpcid", "flagIndex", "proxyEnabled", "proxyConfig", "proxyError", "slotConfig", "slotStatus"]);
  let registered = [];
  try { registered = (await chrome.scripting.getRegisteredContentScripts()).map((s) => `${s.id}@${s.world}`); } catch (e) { registered = [String(e)]; }
  let page = null;
  if (tab && isFlow(tab.url)) {
    try { page = JSON.parse(await chrome.tabs.sendMessage(tab.id, "flow-unlock-status")); } catch { page = "no response from page script"; }
  }
  const url = tab?.url ? new URL(tab.url) : null;
  return {
    extension: chrome.runtime.getManifest().version,
    chrome: (navigator.userAgent.match(/Chrome\/([\d.]+)/) || [])[1],
    enabled: stored.enabled ?? true,
    regError: stored.regError ?? null,
    registered,
    overrides: { rpcid: stored.rpcid ?? null, flagIndex: stored.flagIndex ?? null },
    proxy: {
      enabled: stored.proxyEnabled ?? false,
      // configured, never the password itself
      configured: !!(stored.proxyConfig && stored.proxyConfig.host && stored.proxyConfig.username),
      error: stored.proxyError ?? null
    },
    slot: {
      configured: !!(stored.slotConfig && stored.slotConfig.port),
      state: stored.slotStatus?.state ?? null,
      position: stored.slotStatus?.position ?? null
    },
    tab: url ? url.origin + url.pathname : null,
    page
  };
}

$("diagBtn").addEventListener("click", async () => {
  const text = JSON.stringify(await collectDiagnostics(), null, 2);
  $("diag").textContent = text;
  $("diag").hidden = false;
  try {
    await navigator.clipboard.writeText(text);
    show("انتسخ التشخيص ✓ — ابعته لحتى نعرف شو المشكلة.", "ok");
  } catch {
    show("ما قدرت أنسخ تلقائياً — انسخ النص اللي تحت يدوياً.", "warn");
  }
});

chrome.storage.local.get(["rpcid", "flagIndex"]).then(({ rpcid, flagIndex }) => {
  if (rpcid) $("rpcid").value = rpcid;
  if (flagIndex !== undefined) $("flagIndex").value = flagIndex;
});
// Keep the slot line live while the popup is open (the background updates it on
// each heartbeat / promotion).
chrome.storage.onChanged.addListener((changes) => {
  if ("slotStatus" in changes) renderSlot(changes.slotStatus.newValue);
});

loadProxy();
refreshStatus();
