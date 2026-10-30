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
  if (s.patched > 0) {
    show("تم فتح Flow ✓", "ok");
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

chrome.storage.local.get(["rpcid", "flagIndex"]).then(({ rpcid, flagIndex }) => {
  if (rpcid) $("rpcid").value = rpcid;
  if (flagIndex !== undefined) $("flagIndex").value = flagIndex;
});
refreshStatus();
