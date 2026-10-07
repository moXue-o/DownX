// popup 逻辑：显示任务、添加、暂停/继续/重试/删除
const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((res) => chrome.runtime.sendMessage(msg, res));

function human(n) {
  if (!n) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

const esc = (s) => String(s ?? "").replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" }[c]));

function stateTag(t) {
  const map = {
    0: ["排队", "tag"],
    1: ["下载中", "tag run"],
    2: ["完成", "tag done"],
    3: ["失败", "tag err"],
    4: ["已取消", "tag"],
  };
  const [text, cls] = map[t.state] || ["", "tag"];
  return `<span class="${cls}">${text}${t.paused && (t.state === 0 || t.state === 1) ? " · 暂停" : ""}</span>`;
}

let tasks = [];

function render() {
  const ul = $("list");
  const active = tasks.filter((t) => t.state === 0 || t.state === 1).length;
  const done = tasks.filter((t) => t.state === 2).length;
  $("sum").textContent = tasks.length ? `进行 ${active} · 完成 ${done}` : "";

  if (!tasks.length) {
    ul.innerHTML = '<li class="empty">暂无任务</li>';
    return;
  }

  ul.innerHTML = "";
  for (const t of tasks.slice().sort((a, b) => b.addedAt - a.addedAt)) {
    const pct = t.state === 2 ? 100 : t.total > 0 ? Math.floor((t.downloaded / t.total) * 100) : 0;
    const speed = t.state === 1 && !t.paused ? `  ·  ${human(t.speed)}/s` : "";
    const name = esc(t.name);
    const li = document.createElement("li");
    li.innerHTML = `
      <div class="row"><span class="name" title="${name}">${name}</span>${stateTag(t)}</div>
      <div class="bar"><div class="fill" style="width:${pct}%"></div></div>
      <div class="meta"><span>${pct}%${speed}</span><span>${human(t.downloaded)}${t.total ? " / " + human(t.total) : ""}</span></div>
      <div class="acts">
        ${t.state === 0 || t.state === 1 ? `<button data-a="pause" data-uid="${t.uid}">${t.paused ? "继续" : "暂停"}</button>` : ""}
        ${t.state === 3 || t.state === 4 ? `<button data-a="retry" data-uid="${t.uid}">重试</button>` : ""}
        <button data-a="remove" data-uid="${t.uid}">删除</button>
      </div>`;
    ul.appendChild(li);
  }

  ul.querySelectorAll("button[data-a]").forEach((b) => {
    b.onclick = async () => {
      const uid = Number(b.dataset.uid);
      const t = tasks.find((x) => x.uid === uid);
      const paused = b.dataset.a === "pause" ? !(t && t.paused) : undefined;
      await send({ type: "task", action: b.dataset.a, uid, paused });
      refresh();
    };
  });
}

async function refreshIntercept() {
  const { intercept } = await chrome.storage.sync.get({ intercept: true });
  const on = intercept !== false;
  const el = $("icpt");
  el.textContent = on ? "拦截 开" : "拦截 关";
  el.className = on ? "on" : "muted";
}

async function refresh() {
  const r = await send({ type: "state" });
  const ok = !!(r && r.ok);
  $("dot").classList.toggle("on", ok);
  $("hint").textContent = ok ? "" : "未连接";
  if (!ok) {
    tasks = [];
    $("list").innerHTML = '<li class="empty">未连接 DownX —— 请先运行 downx.exe</li>';
    $("sum").textContent = "";
    return;
  }
  tasks = r.res.tasks || [];
  render();
}

$("add").onclick = async () => {
  const url = $("url").value.trim();
  if (!url) return;
  const r = await send({ type: "add", url });
  if (r && r.ok && r.res && r.res.uid) {
    $("url").value = "";
    refresh();
  } else {
    $("hint").textContent = "添加失败";
  }
};
$("url").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("add").click();
});
$("opts").onclick = () => chrome.runtime.openOptionsPage();

refresh();
refreshIntercept();
setInterval(refresh, 1000);
