// DownX Chrome 扩展：后台脚本（MV3 service worker）
// 职责：右键菜单 / 拦截浏览器下载 / 角标进度 / 给 popup、options 转发请求。
// 说明：把下载交给 DownX 时会弹一条通知；连不上 DownX 也会提示。

const DEFAULT_PORT = 8787;

async function getPort() {
  const { port } = await chrome.storage.sync.get({ port: DEFAULT_PORT });
  return port || DEFAULT_PORT;
}

async function api(path, init) {
  const port = await getPort();
  const res = await fetch(`http://127.0.0.1:${port}${path}`, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const post = (path, body) =>
  api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const add = (url, dir, name) => post("/add", { url, dir, name });

function notify(title, message) {
  try {
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/128.png",
      title,
      message: String(message ?? "").slice(0, 200),
    });
  } catch {}
}

async function refreshBadge() {
  try {
    const s = await api("/state");
    const active = (s.tasks || []).filter((t) => t.state === 0 || t.state === 1).length;
    await chrome.action.setBadgeText({ text: active ? String(active) : "" });
    await chrome.action.setBadgeBackgroundColor({ color: "#fab283" });
  } catch {
    await chrome.action.setBadgeText({ text: "!" });
    await chrome.action.setBadgeBackgroundColor({ color: "#e06c75" });
  }
}

// ── 右键菜单 ─────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async () => {
  chrome.contextMenus.create({ id: "downx-link", title: "用 DownX 下载", contexts: ["link", "image", "video", "audio"] });
  chrome.contextMenus.create({ id: "downx-page", title: "用 DownX 下载当前页", contexts: ["page"] });
  // 老版本可能把 intercept 存成了 false（当时默认未勾选）——首次升级强制回"开"一次
  try {
    const s = await chrome.storage.sync.get({ interceptDefaultSet: false });
    if (!s.interceptDefaultSet) {
      await chrome.storage.sync.set({ intercept: true, interceptDefaultSet: true });
    }
  } catch {}
  refreshBadge();
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  const url = info.menuItemId === "downx-page" ? info.pageUrl : info.linkUrl || info.srcUrl;
  if (!url || !/^https?:/i.test(url)) return;
  try {
    await add(url);
    notify("已交给 DownX", url);
  } catch (e) {
    notify("DownX 未运行", "请先启动 DownX（" + String(e) + "）");
  }
  refreshBadge();
});

// ── 拦截浏览器下载（默认开）──────────────────────────────
// 安全约束（避免误伤整个下载列表）：
//   · 只处理"新创建 / 正在下载 / http(s)"的条目；
//   · 必须先确认 id 是数字——没有合法 id 就什么都不做；
//   · erase 只针对这一条（绝不使用无 id 的查询）；
//   · 同一 URL 10 分钟内只接管一次，防循环。
const HANDLED_TTL_MS = 10 * 60 * 1000;
const handled = new Map();

async function interceptEnabled() {
  const { intercept } = await chrome.storage.sync.get({ intercept: true });
  return intercept !== false;
}

// 权限缺失时（例如还没重新加载扩展）也别让整个后台脚本挂掉
if (chrome.downloads) {
  chrome.downloads.onCreated.addListener(async (item) => {
    if (!(await interceptEnabled())) return;
    if (!item || typeof item.id !== "number") return;
    if (item.byExtensionId) return;
    if (item.state && item.state !== "in_progress") return;

    const url = item.finalUrl || item.url || "";
    if (!/^https?:\/\//i.test(url)) return; // blob:/data:/file: 不接管

    const now = Date.now();
    for (const [k, ts] of handled) {
      if (now - ts > HANDLED_TTL_MS) handled.delete(k);
    }
    if (handled.has(url)) return;
    handled.set(url, now);

    try {
      await chrome.downloads.cancel(item.id);
    } catch {}
    try {
      await chrome.downloads.erase({ id: item.id });
    } catch {}

    const name = item.filename ? item.filename.split(/[\\/]/).pop() : undefined;
    try {
      await add(url, undefined, name);
      notify("已交给 DownX", url);
    } catch (e) {
      notify("DownX 未运行", "请先启动 DownX（" + String(e) + "）");
    }
    refreshBadge();
  });

  chrome.downloads.onChanged.addListener(() => refreshBadge());
} else {
  console.warn("DownX: 缺少 downloads 权限，拦截不可用（请移除并重新加载扩展）");
}

// ── popup / options 的请求转发 ───────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.type) {
        case "add":
          sendResponse({ ok: true, res: await add(msg.url, msg.dir, msg.name) });
          break;
        case "state":
          sendResponse({ ok: true, res: await api("/state") });
          break;
        case "settings":
          sendResponse({ ok: true, res: await api("/settings") });
          break;
        case "saveSettings":
          sendResponse({ ok: true, res: await post("/settings", msg.patch) });
          break;
        case "task":
          sendResponse({ ok: true, res: await post("/" + msg.action, { uid: msg.uid, paused: msg.paused }) });
          break;
        default:
          sendResponse({ ok: false, error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message ?? e) });
    }
  })();
  return true; // 异步响应
});

setInterval(refreshBadge, 3000);
chrome.runtime.onStartup.addListener(refreshBadge);
refreshBadge();
