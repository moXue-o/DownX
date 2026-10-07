// DownX TUI 前端：连后台服务，展示任务、控制下载（支持鼠标 + 右键菜单）。
import { BoxRenderable, TextRenderable, InputRenderable, StyledText, createCliRenderer, t, fg, bg, bold } from "@opentui/core";
import { appendFileSync } from "node:fs";
import { T, dw, padR, padL, truncR, humanSize } from "./theme";
import { DAEMON_LOG } from "./paths";
import type { Client, TaskInfo } from "./client";
import { THREAD_OPTIONS, CONCURRENT_OPTIONS, SPEED_OPTIONS, PART_OPTIONS, RETRY_OPTIONS, TIMEOUT_OPTIONS, type Settings } from "./settings";

const tlog = (m: string) => {
  try {
    appendFileSync(DAEMON_LOG, `[tui ${new Date().toISOString()}] ${m}\n`);
  } catch {}
};

const txt = (r: any, o: any) => new TextRenderable(r, { wrapMode: "none", truncate: true, ...o });

const LEFT_W = 18;
const RIGHT_W = 34;

function pctOf(t: TaskInfo): number {
  if (t.state === 2) return 100;
  if (t.total > 0) return Math.min(100, Math.floor((t.downloaded / t.total) * 100));
  return 0;
}
function barCol(t: TaskInfo): string {
  if (t.state === 2) return T.success;
  if (t.state === 3) return T.error;
  if (t.state === 4) return T.muted;
  if (t.state === 0) return T.muted;
  if (t.paused) return T.warning;
  return T.primary;
}

function fmtDur(ms: number): string {
  if (!isFinite(ms) || ms <= 0) return "00:00";
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`;
}
function elapsedMs(t: TaskInfo): number {
  const start = t.startedAt || t.addedAt || Date.now();
  const end = t.finishedAt && t.finishedAt > 0 ? t.finishedAt : Date.now();
  return Math.max(0, end - start);
}
function etaMs(t: TaskInfo): number | null {
  if (t.state !== 1 || t.paused) return null;
  if (!(t.speed > 0) || !(t.total > 0) || t.downloaded >= t.total) return null;
  return ((t.total - t.downloaded) / t.speed) * 1000;
}

/** 速度文字：运行中=速度，否则=状态词 */
function speedOrState(t: TaskInfo): string {
  if (t.state === 0) return "排队";
  if (t.state === 2) return "完成";
  if (t.state === 3) return "失败";
  if (t.state === 4) return "已取消";
  if (t.paused) return "已暂停";
  return `${humanSize(t.speed)}/s`;
}

/** 把一段文字按显示宽度放进 w 列，做 左/中/右 对齐，返回彩色块 */
function seg(s: string, w: number, align: "l" | "c" | "r", color: string, boldFlag = false): any[] {
  const text = dw(s) > w ? truncR(s, w) : s;
  const d = dw(text);
  let lead = 0;
  let trail = 0;
  if (align === "l") trail = w - d;
  else if (align === "r") lead = w - d;
  else {
    lead = Math.floor((w - d) / 2);
    trail = w - d - lead;
  }
  const out: any[] = [];
  if (lead > 0) out.push(fg(T.muted)(" ".repeat(lead)));
  out.push(boldFlag ? bold(fg(color)(text)) : fg(color)(text));
  if (trail > 0) out.push(fg(T.muted)(" ".repeat(trail)));
  return out;
}

/** 第一行：名字(左) - 进度条(中，居中) - 百分比(右) */
function line1(t: TaskInfo, selected: boolean, W: number): StyledText {
  const S = Math.max(12, Math.floor(W * 0.2)); // 左右等宽（窄）→ 中间列更长且居中
  const C1 = Math.max(8, W - 2 * S);
  const pct = pctOf(t);
  const f = Math.round((pct / 100) * C1);
  return new StyledText([
    ...seg(t.name, S, "l", T.text, selected),
    fg(barCol(t))("█".repeat(f)),
    fg(T.borderSubtle)("░".repeat(Math.max(0, C1 - f))),
    ...seg(pct + "%", S, "r", T.text),
  ]);
}

/** 平均速度 = 文件大小 / 用时 */
function avgSpeed(t: TaskInfo): number {
  const ms = elapsedMs(t);
  const bytes = t.size > 0 ? t.size : t.downloaded;
  return ms > 0 && bytes > 0 ? bytes / (ms / 1000) : 0;
}

/** 第二行：用时(左) - 速度/平均速度(中，居中) - 剩余(右) */
function line2(t: TaskInfo, W: number): StyledText {
  const S = Math.max(12, Math.floor(W * 0.22));
  const C2 = Math.max(8, W - 2 * S);
  const el = fmtDur(elapsedMs(t));
  const running = t.state === 1 && !t.paused;
  const eta = etaMs(t);
  let centerStr: string;
  let centerCol: string;
  if (running) {
    centerStr = `${humanSize(t.speed)}/s`;
    centerCol = T.primary;
  } else if (t.state === 2) {
    centerStr = `${humanSize(avgSpeed(t))}/s`; // 完成后 -> 平均速度
    centerCol = T.success;
  } else {
    centerStr = speedOrState(t);
    centerCol = T.muted;
  }
  const rightStr = running ? (eta != null ? `剩余 ${fmtDur(eta)}` : "剩余 —") : "";
  const leftStr = `用时 ${el}`;
  const leftPad = Math.max(0, S - dw(leftStr));
  return new StyledText([
    fg(T.muted)("用时 "),
    fg(T.text)(el),
    fg(T.muted)(" ".repeat(leftPad)),
    ...seg(centerStr, C2, "c", centerCol),
    ...seg(rightStr, S, "r", T.text),
  ]);
}

/** "分段"里的一行：已下载 / 总大小 */
function segText(s: { from: number; to: number; current: number }, i: number): StyledText {
  const total = Math.max(0, s.to - s.from + 1);
  const done = Math.max(0, Math.min(total, s.current - s.from));
  const fin = total > 0 && done >= total;
  return new StyledText([
    fg(T.muted)(`#${i + 1} `),
    fg(fin ? T.success : T.primary)(humanSize(done)),
    fg(T.muted)(` / ${humanSize(total)}`),
  ]);
}

const CATS = ["全部", "进行中", "已完成", "失败"] as const;
const MENU: Array<[string, string]> = [
  ["打开", "open"],
  ["打开所在位置", "reveal"],
  ["暂停 / 继续", "pause"],
  ["取消", "cancel"],
  ["重试", "retry"],
  ["删除", "remove"],
];

export async function runTui(client: Client): Promise<void> {
  tlog(`runTui start (port=${client.daemonPort})`);
  const renderer: any = await createCliRenderer({
    exitOnCtrlC: true,
    useMouse: true,
    ...(process.env.DOWNX_COLS ? { width: Number(process.env.DOWNX_COLS) } : {}),
    ...(process.env.DOWNX_ROWS ? { height: Number(process.env.DOWNX_ROWS) } : {}),
  });
  tlog("renderer created");

  let tasks: TaskInfo[] = [];
  let selected = 0;
  let cat = 0;
  let message = "";
  let view: "downloads" | "settings" = process.env.DOWNX_VIEW === "settings" ? "settings" : "downloads";
  let settings: Settings | null = null;
  let lastClick = { uid: 0, at: 0 };

  const app = new BoxRenderable(renderer, {
    id: "app",
    flexDirection: "column",
    width: "100%",
    height: "100%",
    backgroundColor: T.bg,
  });
  renderer.root.add(app);
  app.onMouseDown = () => {
    if (view === "downloads") blurInput();
  };

  // 顶栏：品牌 + 标签
  const top = new BoxRenderable(renderer, { id: "top", height: 1, flexDirection: "row" });
  top.add(txt(renderer, { content: t`${bg(T.element)(fg(T.text)(" ▚ DownX "))}` }));
  const tabDownloads = txt(renderer, { id: "tab-downloads", content: t`` });
  const tabSettings = txt(renderer, { id: "tab-settings", content: t`` });
  tabDownloads.onMouseDown = () => setView("downloads");
  tabSettings.onMouseDown = () => setView("settings");
  top.add(tabDownloads);
  top.add(tabSettings);
  top.add(new BoxRenderable(renderer, { id: "topSpacer", flexGrow: 1 }));
  app.add(top);

  function renderTop() {
    tabDownloads.content =
      view === "downloads"
        ? t`${bg(T.element)(bold(fg(T.text)(" 下载 ")))}`
        : t`${fg(T.muted)(" 下载 ")}`;
    tabSettings.content =
      view === "settings"
        ? t`${bg(T.element)(bold(fg(T.text)(" 设置 ")))}`
        : t`${fg(T.muted)(" 设置 ")}`;
  }

  // 下载视图（默认）
  const downView = new BoxRenderable(renderer, { id: "downView", flexGrow: 1, width: "100%", flexDirection: "column" });
  app.add(downView);

  const body = new BoxRenderable(renderer, { id: "body", flexGrow: 1, flexDirection: "row" });
  downView.add(body);

  // 左：筛选
  const left = new BoxRenderable(renderer, {
    id: "left",
    width: LEFT_W,
    flexDirection: "column",
    backgroundColor: T.panel,
    paddingTop: 2,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
  });
  body.add(left);
  left.add(txt(renderer, { content: t`${bold(fg(T.text)("筛选"))}` }));
  left.add(txt(renderer, { content: t` ` }));
  const catNodes = CATS.map((name, i) => {
    const n = txt(renderer, { content: t`${fg(T.text)("  " + name)}` });
    n.onMouseDown = () => {
      cat = i;
      selected = 0;
      blurInput();
      hideMenu();
      render();
    };
    left.add(n);
    return n;
  });
  left.add(new BoxRenderable(renderer, { id: "leftSpacer", flexGrow: 1 }));
  left.add(txt(renderer, { content: t`${fg(T.success)("•")} ${bold(fg(T.text)("Down"))}${bold(fg(T.text)("X"))} ${fg(T.muted)("0.0.1")}` }));

  // 中：任务列表（每项两行）
  const main = new BoxRenderable(renderer, { id: "main", flexGrow: 1, flexDirection: "column", paddingTop: 2, paddingLeft: 2, paddingRight: 2 });
  body.add(main);
  const mainTitle = txt(renderer, { content: t`${bold(fg(T.text)("任务"))}` });
  main.add(mainTitle);
  main.add(txt(renderer, { content: t` ` }));
  const listBox = new BoxRenderable(renderer, { id: "list", flexDirection: "column" });
  listBox.onMouseScroll = (e: any) => {
    const d = e.scroll?.direction;
    if (d === "up") selected = Math.max(0, selected - 1);
    else if (d === "down") selected = Math.min(visible().length - 1, selected + 1);
    render();
  };
  main.add(listBox);

  // 右：概览
  const right = new BoxRenderable(renderer, {
    id: "right",
    width: RIGHT_W,
    flexDirection: "column",
    backgroundColor: T.panel,
    paddingTop: 2,
    paddingBottom: 1,
    paddingLeft: 2,
    paddingRight: 2,
  });
  body.add(right);
  const rTitle = txt(renderer, { content: t`` });
  const rSub = txt(renderer, { content: t`` });
  const rSpeed = txt(renderer, { content: t`` });
  const rGot = txt(renderer, { content: t`` });
  const rBar = txt(renderer, { content: t`` });
  const rErr = txt(renderer, { content: t`` });
  right.add(rTitle);
  right.add(rSub);
  right.add(txt(renderer, { content: t` ` }));
  right.add(rSpeed);
  right.add(rGot);
  right.add(txt(renderer, { content: t` ` }));
  right.add(rBar);
  const rSegBox = new BoxRenderable(renderer, { id: "rightSegs", flexDirection: "column" });
  right.add(rSegBox);
  right.add(rErr);
  right.add(new BoxRenderable(renderer, { id: "rightSpacer", flexGrow: 1 }));
  right.add(txt(renderer, { content: t`${fg(T.muted)("右键任务可操作")}` }));

  // 输入框
  const inputRow = new BoxRenderable(renderer, { id: "inputRow", height: 3, flexDirection: "row", paddingLeft: 2, paddingRight: 2 });
  downView.add(inputRow);
  inputRow.add(new BoxRenderable(renderer, { id: "accent", width: 1, backgroundColor: T.secondary }));
  const inputBox = new BoxRenderable(renderer, {
    id: "input",
    flexGrow: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: T.border,
    flexDirection: "column",
    paddingLeft: 1,
    paddingRight: 1,
  });
  inputRow.add(inputBox);
  const PLACEHOLDER = "输入下载地址，回车添加任务…";
  const urlInput = new InputRenderable(renderer, {
    id: "url-input",
    placeholder: PLACEHOLDER,
    placeholderColor: T.muted,
    backgroundColor: T.input,
    textColor: T.text,
    focusedBackgroundColor: T.input,
    focusedTextColor: T.text,
    cursorColor: T.primary,
    cursorStyle: { style: "line", blinking: true }, // 细光标
    width: "100%",
  });
  inputBox.add(urlInput);
  // InputRenderable 不会调用 onSubmit，而是派发 "enter" 事件（携带当前值）
  urlInput.on("enter", (value: string) => {
    void submitUrl(typeof value === "string" ? value : urlInput.value);
  });
  function focusInput() {
    urlInput.focus();
    urlInput.placeholder = ""; // 聚焦后隐藏提示
  }
  function blurInput() {
    urlInput.blur();
    urlInput.placeholder = PLACEHOLDER;
  }
  inputBox.onMouseDown = (e: any) => {
    e.stopPropagation?.();
    focusInput();
  };
  focusInput();

  // 底部状态行（在输入框下面）：提示/结果 + 计数
  const status = new BoxRenderable(renderer, {
    id: "status",
    height: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    paddingLeft: 2,
    paddingRight: 2,
  });
  downView.add(status);
  const statusLeft = txt(renderer, { content: t`` });
  const statusRight = txt(renderer, { content: t`` });
  status.add(statusLeft);
  status.add(statusRight);

  // ── 设置页 ──────────────────────────────────────────────
  const settingsView = new BoxRenderable(renderer, {
    id: "settingsView",
    flexGrow: 1,
    width: "100%",
    flexDirection: "column",
    backgroundColor: T.bg,
    paddingTop: 1,
    paddingLeft: 4,
    paddingRight: 4,
  });
  settingsView.add(txt(renderer, { content: t`${bold(fg(T.text)("设置"))}` }));
  settingsView.add(txt(renderer, { content: t` ` }));

  type ChipRow = { nodes: any[]; options: any[]; key: keyof Settings; fmt: (v: any) => string };
  const chipRows: ChipRow[] = [];
  const textInputs: Array<{ inp: any; key: keyof Settings }> = [];

  const section = (title: string) => {
    settingsView.add(txt(renderer, { content: t` ` }));
    settingsView.add(txt(renderer, { content: t`${fg(T.muted)(title)}` }));
  };

  function chipRow(
    label: string,
    key: keyof Settings,
    options: any[],
    fmt: (v: any) => string,
    action?: (v: any) => void,
  ) {
    const nodes = options.map((opt) => {
      const nd = txt(renderer, { content: t`` });
      nd.onMouseDown = (e: any) => {
        e.stopPropagation?.();
        if (action) action(opt);
        else void saveSetting(key, opt as any);
      };
      return nd;
    });
    const line = new BoxRenderable(renderer, { flexDirection: "row", height: 1 });
    line.add(txt(renderer, { content: t`${fg(T.text)(padR(label, 16))}` }));
    nodes.forEach((nd, i) => {
      if (i > 0) line.add(txt(renderer, { content: t`${fg(T.muted)(" ")}` }));
      line.add(nd);
    });
    settingsView.add(line);
    chipRows.push({ nodes, options, key, fmt });
  }

  function textRow(label: string, key: keyof Settings, placeholder: string) {
    const line = new BoxRenderable(renderer, { flexDirection: "row", height: 1 });
    line.add(txt(renderer, { content: t`${fg(T.text)(padR(label, 16))}` }));
    const holder = new BoxRenderable(renderer, { flexGrow: 1, height: 1, backgroundColor: T.input });
    const inp = new InputRenderable(renderer, {
      placeholder,
      placeholderColor: T.muted,
      backgroundColor: T.input,
      textColor: T.text,
      focusedBackgroundColor: T.input,
      focusedTextColor: T.text,
      cursorColor: T.primary,
      cursorStyle: { style: "line", blinking: true },
      width: "100%",
    });
    inp.on("enter", (v: string) => void saveSetting(key, String(v ?? "").trim() as any));
    holder.add(inp);
    holder.onMouseDown = (e: any) => {
      e.stopPropagation?.();
      inp.focus();
    };
    line.add(holder);
    settingsView.add(line);
    textInputs.push({ inp, key });
    return inp;
  }

  section("常规");
  const dirInput = textRow("  下载目录", "downloadDir", "默认下载目录…");
  chipRow("  并发连接数", "threads", THREAD_OPTIONS, (v) => `${v}`);
  chipRow("  同时下载数", "maxConcurrent", CONCURRENT_OPTIONS, (v) => `${v}`);
  chipRow("  开机自启动", "autoStart", [true, false], (v) => (v ? "开" : "关"));

  section("网络");
  textRow("  代理", "proxy", "http://host:port 或 socks5://…（留空=直连）");
  textRow("  User-Agent", "userAgent", "留空 = 引擎默认");
  chipRow("  空闲超时(秒)", "idleTimeoutSecs", TIMEOUT_OPTIONS, (v) => `${v}`);

  section("下载");
  chipRow("  限速(KB/s)", "maxSpeedKB", SPEED_OPTIONS, (v) => (v === 0 ? "不限" : `${v}`));
  chipRow("  分块(MiB)", "minPartMiB", PART_OPTIONS, (v) => `${v}`);
  chipRow("  重试次数", "maxRetries", RETRY_OPTIONS, (v) => `${v}`);
  chipRow("  超限模式(实验)", "turbo", [true, false], (v) => (v ? "开" : "关"), (v) => void setTurbo(v));

  section("关于");
  const abVersion = txt(renderer, { content: t`` });
  const abEngine = txt(renderer, { content: t`` });
  const abDaemon = txt(renderer, { content: t`` });
  const abLicense = txt(renderer, { content: t`` });
  const abUrl = txt(renderer, { content: t`` });
  for (const nd of [abVersion, abEngine, abDaemon, abLicense, abUrl]) settingsView.add(nd);

  function renderSettings() {
    const s = settings;
    for (const { inp, key } of textInputs) inp.value = String((s as any)?.[key] ?? "");
    for (const row of chipRows) {
      const cur = (s as any)?.[row.key];
      for (let i = 0; i < row.nodes.length; i++) {
        const on = cur === row.options[i];
        const label = row.fmt(row.options[i]);
        row.nodes[i].content = on
          ? t`${bg(T.primary)(fg(T.bg)(` ${label} `))}`
          : t`${fg(T.muted)(` ${label} `)}`;
      }
    }
    const kv = (k: string, v: string, col = T.text) => t`${fg(T.muted)(padR("    " + k, 18))}${fg(col)(v)}`;
    abVersion.content = kv("DownX", "0.1.0");
    abEngine.content = kv("下载核心", "DownloadCore · Rust 多线程分段引擎");
    abDaemon.content = kv("服务地址", `127.0.0.1:${client.daemonPort}`);
    abLicense.content = kv("许可证", "MIT OR Apache-2.0");
    abUrl.content = kv("项目主页", "github.com/moXue-o/DownloadCore", T.accent);
  }

  async function saveSetting<K extends keyof Settings>(k: K, v: Settings[K]) {
    try {
      settings = await client.saveSettings({ [k]: v } as Partial<Settings>);
    } catch {}
    renderSettings();
  }

  /** 超限模式：先申请管理员、拿到权限才置为"开"。 */
  async function setTurbo(on: boolean) {
    if ((settings?.turbo ?? false) === on) return;
    if (!on) {
      try {
        const r = await client.turbo(false);
        if (r?.settings) settings = r.settings;
      } catch {}
      renderSettings();
      return;
    }
    try {
      const r = await client.turbo(true);
      if (r?.ok && r.settings) settings = r.settings;
    } catch {}
    renderSettings();
  }

  function setView(v: "downloads" | "settings") {
    if (v === view) return;
    if (v === "settings") {
      app.remove(downView);
      app.add(settingsView);
      urlInput.blur();
      dirInput.focus();
    } else {
      app.remove(settingsView);
      app.add(downView);
      dirInput.blur();
      focusInput();
    }
    view = v;
    renderTop();
    if (v === "settings") renderSettings();
    render();
  }

  // ── 右键菜单 ────────────────────────────────────────────
  let menu: any = null;
  function hideMenu() {
    if (menu) {
      app.remove(menu);
      menu = null;
      render();
    }
  }
  function showMenu(x: number, y: number, task: TaskInfo) {
    hideMenu();
    const w = 16;
    const left = Math.max(0, Math.min(x, (renderer.terminalWidth ?? 120) - w - 1));
    const box = new BoxRenderable(renderer, {
      id: "menu",
      position: "absolute",
      left,
      top: Math.max(0, y),
      zIndex: 1000,
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      borderColor: T.border,
      backgroundColor: T.panel,
      paddingLeft: 1,
      paddingRight: 1,
    });
    box.onMouseDown = (e: any) => e.stopPropagation?.();
    for (const [label, kind] of MENU) {
      const it = txt(renderer, { content: t`${fg(T.text)(label)}` });
      it.onMouseDown = (e: any) => {
        e.stopPropagation?.();
        void actOn(task, kind);
      };
      box.add(it);
    }
    menu = box;
    app.add(box);
    render();
  }

  // ── 渲染 ────────────────────────────────────────────────
  const cardPool = new Map<number, { box: any; l1: any; l2: any }>();

  function visible(): TaskInfo[] {
    if (cat === 1) return tasks.filter((t) => t.state === 1 || t.state === 0);
    if (cat === 2) return tasks.filter((t) => t.state === 2);
    if (cat === 3) return tasks.filter((t) => t.state === 3);
    return tasks;
  }

  function cardWidth(): number {
    const total = renderer.terminalWidth ?? 120;
    return Math.max(30, total - LEFT_W - RIGHT_W - 6);
  }

  function render() {
    const vis = visible();
    if (selected >= vis.length) selected = Math.max(0, vis.length - 1);

    for (let i = 0; i < catNodes.length; i++) {
      const on = i === cat;
      catNodes[i].content = on ? t`${fg(T.primary)("▌")} ${bold(fg(T.text)(CATS[i]))}` : t`${fg(T.text)("  " + CATS[i])}`;
      catNodes[i].bg = on ? T.selected : undefined;
    }

    const W = cardWidth();
    for (const c of [...listBox.getChildren()]) listBox.remove(c);
    if (vis.length === 0) {
      listBox.add(txt(renderer, { id: "empty", content: t`${fg(T.muted)("（暂无任务）")}` }));
    }
    for (let i = 0; i < vis.length; i++) {
      const task = vis[i];
      let card = cardPool.get(task.uid);
      if (!card) {
        const box = new BoxRenderable(renderer, {
          id: "row-" + task.uid,
          flexDirection: "column",
          width: "100%",
          paddingLeft: 1,
          paddingRight: 1,
        });
        const l1 = txt(renderer, {});
        const l2 = txt(renderer, {});
        box.add(l1);
        box.add(l2);
        card = { box, l1, l2 };
        cardPool.set(task.uid, card);
      }
      const { box, l1, l2 } = card;
      box.backgroundColor = i === selected ? T.selected : undefined;
      l1.content = line1(task, i === selected, W);
      l2.content = line2(task, W);
      box.onMouseDown = (e: any) => {
        e.stopPropagation?.();
        blurInput();
        if (e.button === 2) {
          const idx = visible().findIndex((x) => x.uid === task.uid);
          if (idx >= 0) selected = idx;
          render();
          showMenu(e.x ?? 0, e.y ?? 0, task);
        } else if (e.button === 0) {
          const idx = visible().findIndex((x) => x.uid === task.uid);
          if (idx >= 0) selected = idx;
          hideMenu();
          render();
          // 左键双击 → 打开文件
          const now = Date.now();
          if (lastClick.uid === task.uid && now - lastClick.at < 500) {
            lastClick = { uid: 0, at: 0 };
            void actOn(task, "open");
          } else {
            lastClick = { uid: task.uid, at: now };
          }
        }
      };
      listBox.add(box, i);
    }

    mainTitle.content = t`${bold(fg(T.text)("任务"))}   ${fg(T.muted)(`${vis.length} 个`)}`;
    renderRight(vis[selected]);

    const running = tasks.filter((t) => t.state === 1).length;
    const done = tasks.filter((t) => t.state === 2).length;
    const failed = tasks.filter((t) => t.state === 3).length;
    statusLeft.content = t``;
    statusRight.content = t`${fg(T.primary)("●")} ${fg(T.text)("" + running)} ${fg(T.muted)("进行")}   ${fg(T.success)("⊙")} ${fg(T.text)("" + done)} ${fg(T.muted)("完成")}   ${fg(T.error)("✗")} ${fg(T.text)("" + failed)} ${fg(T.muted)("失败")}`;
  }

  function renderSegments(cur?: TaskInfo) {
    for (const c of [...rSegBox.getChildren()]) rSegBox.remove(c);
    const all = cur?.segments ?? [];
    // 只显示"还没下完"的分段（下完的隐藏），并保留原始段号
    const active = all
      .map((s, i) => ({ s, i }))
      .filter(({ s }) => {
        const total = Math.max(0, s.to - s.from + 1);
        const done = Math.max(0, Math.min(total, s.current - s.from));
        return total === 0 || done < total;
      });
    if (active.length === 0) return;
    // 右栏放得下多少行就显示多少行，多出来的隐藏（并提示还剩几段）
    const H = renderer.terminalHeight ?? 40;
    const room = Math.max(0, H - 19);
    if (room <= 0) return;
    rSegBox.add(txt(renderer, { content: t`${fg(T.muted)(`分段 (${active.length})`)}` }));
    const shown = Math.min(active.length, room);
    for (let k = 0; k < shown; k++) {
      rSegBox.add(txt(renderer, { content: segText(active[k].s, active[k].i) }));
    }
    if (active.length > shown) {
      rSegBox.add(txt(renderer, { content: t`${fg(T.muted)(`… 还有 ${active.length - shown} 段`)}` }));
    }
  }

  function renderRight(cur?: TaskInfo) {
    if (cur) {
      const pct = pctOf(cur);
      const f = Math.round((pct / 100) * 12);
      rTitle.content = t`${bold(fg(T.text)(truncR(cur.name, 28)))}`;
      rSub.content = t`${fg(T.muted)(truncR(cur.dir, 30))}`;
      rSpeed.content = t`${fg(T.muted)("速度")}   ${fg(cur.state === 1 && !cur.paused ? T.primary : T.muted)(speedOrState(cur))}`;
      rGot.content = t`${fg(T.muted)("已下载")} ${fg(T.text)(humanSize(cur.downloaded))}${fg(T.muted)(" / " + (cur.total ? humanSize(cur.total) : "—"))}`;
      rBar.content = new StyledText([fg(barCol(cur))("█".repeat(f)), fg(T.borderSubtle)("░".repeat(Math.max(0, 12 - f))), fg(T.text)(`  ${pct}%`)]);
      rErr.content = t`${fg(cur.state === 3 ? T.error : T.muted)(truncR(cur.err || "", 30))}`;
      renderSegments(cur);
    } else {
      rTitle.content = t`${bold(fg(T.text)("概览"))}`;
      rSub.content = t`${fg(T.muted)("没有选中任务")}`;
      rSpeed.content = t``;
      rGot.content = t``;
      rBar.content = t``;
      rErr.content = t``;
      renderSegments(undefined);
    }
  }

  // （输入框改用 InputRenderable 组件：自带光标 / 占位符 / 回车提交）

  // ── 动作 ────────────────────────────────────────────────
  async function submitUrl(url: string) {
    const u = (url ?? "").trim();
    if (!u) return;
    urlInput.value = ""; // 立即清空，避免重复提交
    message = "";
    render();
    const r = await client.add(u);
    message = r.uid ? `已加入任务 #${r.uid}` : `失败：${r.error}`;
    await refresh();
  }

  async function actOn(task: TaskInfo | undefined, kind: string) {
    hideMenu();
    if (!task) return;
    if (kind === "pause") await client.post("/pause", { uid: task.uid, paused: !task.paused });
    else if (kind === "cancel") await client.post("/cancel", { uid: task.uid });
    else if (kind === "retry") await client.post("/retry", { uid: task.uid });
    else if (kind === "open") await client.post("/open", { uid: task.uid });
    else if (kind === "reveal") await client.post("/reveal", { uid: task.uid });
    else if (kind === "remove") {
      await client.post("/remove", { uid: task.uid });
      cardPool.delete(task.uid);
    }
    await refresh();
  }

  let daemonLost = 0;
  async function refresh() {
    try {
      const s = await client.state();
      tasks = (s.tasks ?? []).sort((a, b) => b.addedAt - a.addedAt);
      daemonLost = 0;
    } catch (e) {
      tlog(`state failed: ${(e as any)?.message ?? e}`);
      message = "后台连接断开";
      // 后台没了（例如托盘菜单里点了"退出"）：TUI 也跟着退出，把终端还回去
      if (++daemonLost >= 3) {
        tlog("daemon lost -> exit TUI");
        try {
          renderer.destroy();
        } catch {}
        process.exit(0);
      }
    }
    try {
      render();
    } catch (e) {
      message = String((e as any)?.message ?? e);
      tlog(`render error: ${(e as any)?.stack ?? e}`);
    }
  }

  // ── 键盘 ────────────────────────────────────────────────
  function clampSel() {
    const n = visible().length;
    if (selected >= n) selected = Math.max(0, n - 1);
  }

  async function onKey(key: any) {
    const name = key.name;
    if (view === "settings") {
      if (name === "escape") setView("downloads");
      return; // 设置页里其余按键交给输入框
    }
    if (name === "up") {
      selected = Math.max(0, selected - 1);
      render();
      return;
    }
    if (name === "down") {
      selected = Math.min(visible().length - 1, selected + 1);
      render();
      return;
    }
    if (name === "left") {
      cat = (cat + CATS.length - 1) % CATS.length;
      selected = 0;
      hideMenu();
      render();
      return;
    }
    if (name === "right") {
      cat = (cat + 1) % CATS.length;
      selected = 0;
      hideMenu();
      render();
      return;
    }
    if (key.ctrl) {
      if (name === "p") await actOn(visible()[selected], "pause");
      else if (name === "x") await actOn(visible()[selected], "cancel");
      else if (name === "r") await actOn(visible()[selected], "retry");
      else if (name === "d") await actOn(visible()[selected], "remove");
      else if (name === "q") {
        renderer.destroy();
        process.exit(0);
      }
      clampSel();
      return;
    }
    if (name === "escape") {
      if (menu) hideMenu();
      else {
        urlInput.value = "";
        message = "";
      }
      render();
      return;
    }
    // 其余按键（打字 / 回车 / 退格）交给输入框组件处理
  }
  renderer.keyInput.on("keypress", (k: any) => void onKey(k).catch(() => {}));

  settings = await client.settings().catch(() => null);
  if (view === "settings") {
    app.remove(downView);
    app.add(settingsView);
    dirInput.focus();
  }
  renderTop();
  renderSettings();
  setInterval(refresh, 400);
  await refresh();
  tlog("first render done");
}
