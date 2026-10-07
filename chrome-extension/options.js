// options 逻辑：扩展本地设置（端口）+ 读写 DownX 后台设置
const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

async function init() {
  const { port, intercept } = await chrome.storage.sync.get({ port: 8787, intercept: true });
  $("port").value = port;
  $("intercept").checked = intercept !== false;
  await loadDaemon();
}

async function loadDaemon() {
  const r = await send({ type: "settings" });
  if (!(r && r.ok)) {
    $("status").textContent = "未连接（请先运行 downx.exe）";
    $("status").className = "err";
    return;
  }
  $("status").textContent = "已连接";
  $("status").className = "ok";
  const s = r.res;
  $("downloadDir").value = s.downloadDir || "";
  $("proxy").value = s.proxy || "";
  $("threads").value = s.threads || 16;
  $("maxConcurrent").value = s.maxConcurrent || 3;
}

$("save").onclick = async () => {
  $("msg").textContent = "保存中…";
  $("msg").className = "muted";
  // 1) 扩展本地设置
  await chrome.storage.sync.set({
    port: Number($("port").value) || 8787,
    intercept: $("intercept").checked,
  });
  // 2) 后台设置
  const patch = {
    downloadDir: $("downloadDir").value.trim(),
    proxy: $("proxy").value.trim(),
    threads: Number($("threads").value) || 16,
    maxConcurrent: Number($("maxConcurrent").value) || 3,
  };
  const r = await send({ type: "saveSettings", patch });
  if (r && r.ok) {
    $("msg").textContent = "已保存";
    $("msg").className = "ok";
    await loadDaemon();
  } else {
    $("msg").textContent = "后台未响应（本地设置已保存）";
    $("msg").className = "err";
  }
};

init();
