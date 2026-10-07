// 后台服务：持有引擎与任务表，持久化，发通知，暴露本地 HTTP API（也是 Chrome 扩展接口）。
import { engine, type Segment } from "./engine";
import { claimSingleInstance } from "./win32";
import { loadSettings, saveSettings, type Settings } from "./settings";
import { DAEMON_FILE, TASKS_FILE, DEFAULT_DOWNLOAD_DIR, ensureDir, ROOT } from "./paths";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, openSync, rmSync } from "node:fs";

const VERSION = "0.1.0";

// 单实例：已有后台在跑就直接退出（免得占端口后又把 daemon.json 改乱）
if (!claimSingleInstance("Local\\DownX-Daemon")) {
  console.log("[daemon] 已有一个后台实例，退出");
  process.exit(0);
}

interface Task {
  uid: number;
  bid: number; // 桥接任务 id（0 = 无）
  url: string;
  path: string;
  name: string;
  dir: string;
  paused: boolean;
  addedAt: number;
  startedAt: number;
  finishedAt: number;
  // 运行时快照（持久化时只存状态）
  state: number;
  downloaded: number;
  total: number;
  speed: number;
  parts: number;
  size: number;
  err: string;
  segments: Segment[];
}

const tasks = new Map<number, Task>();
let nextUid = 1;
let settings: Settings = loadSettings();

// ── 从磁盘恢复 ────────────────────────────────────────────
try {
  if (existsSync(TASKS_FILE)) {
    const arr = JSON.parse(readFileSync(TASKS_FILE, "utf8")) as Partial<Task>[];
    for (const t of arr) {
      if (!t || !t.url || !t.path) continue;
      const task: Task = {
        uid: t.uid ?? nextUid++,
        bid: 0,
        url: t.url,
        path: t.path,
        name: t.name ?? basename(t.path),
        dir: t.dir ?? DEFAULT_DOWNLOAD_DIR,
        paused: !!t.paused,
        addedAt: t.addedAt ?? Date.now(),
        startedAt: t.startedAt ?? t.addedAt ?? Date.now(),
        finishedAt: t.finishedAt ?? 0,
        state: t.state ?? 1,
        downloaded: t.downloaded ?? 0,
        total: t.total ?? 0,
        speed: 0,
        parts: t.parts ?? 0,
        size: t.size ?? 0,
        err: t.err ?? "",
        segments: [],
      };
      if (task.uid >= nextUid) nextUid = task.uid + 1;
      tasks.set(task.uid, task);
    }
  }
} catch (e) {
  console.error("[daemon] 读取任务失败:", e);
}

function persist() {
  try {
    const arr = [...tasks.values()].map((t) => ({
      uid: t.uid,
      url: t.url,
      path: t.path,
      name: t.name,
      dir: t.dir,
      paused: t.paused,
      addedAt: t.addedAt,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
      state: t.state,
      downloaded: t.downloaded,
      total: t.total,
      parts: t.parts,
      size: t.size,
      err: t.err,
    }));
    writeFileSync(TASKS_FILE, JSON.stringify(arr, null, 2));
  } catch (e) {
    console.error("[daemon] 保存任务失败:", e);
  }
}

// ── Windows 通知（WinRT toast，可点击打开 TUI；best-effort）──
/** PowerShell 单引号字符串 */
const psq = (s: string) => "'" + s.replace(/'/g, "''") + "'";

/** 启动器（GUI 子系统、无控制台）。运行时由启动器通过 DOWNX_LAUNCHER 告知真实路径。 */
const LAUNCHER_PATH = process.env.DOWNX_LAUNCHER || join(dirname(process.execPath), "downx.exe");

/** 注册 `downx:` 协议 → 无控制台启动器（前置已有 TUI，或启动一个）。仅编译版有效。 */
function registerProtocol() {
  if (process.execPath.toLowerCase().endsWith("bun.exe")) return; // 开发态不注册
  try {
    const cmd = `"${LAUNCHER_PATH}" "%1"`;
    const ps = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "$base = 'HKCU:\\Software\\Classes\\downx'",
      "New-Item -Path $base -Force | Out-Null",
      "Set-ItemProperty -Path $base -Name '(Default)' -Value 'URL:DownX'",
      "Set-ItemProperty -Path $base -Name 'URL Protocol' -Value ''",
      "New-Item -Path \"$base\\shell\\open\\command\" -Force | Out-Null",
      `Set-ItemProperty -Path \"$base\\shell\\open\\command\" -Name '(Default)' -Value ${psq(cmd)}`,
    ].join("; ");
    const enc = Buffer.from(ps, "utf16le").toString("base64");
    spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", enc], {
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    console.log("[daemon] 已注册 downx: 协议（点通知前置/打开 TUI，零闪）");
  } catch (e) {
    console.log("[daemon] 注册协议失败:", e);
  }
}

/** 同步"开机自启动"到注册表 Run 项（登录时由启动器静默拉起后台）。 */
function applyAutoStart() {
  if (process.execPath.toLowerCase().endsWith("bun.exe")) return; // 开发态不管
  try {
    const cmd = `"${LAUNCHER_PATH}" autostart`;
    const ps = settings.autoStart
      ? [
          "$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'",
          `Set-ItemProperty -Path $k -Name 'DownX' -Value ${psq(cmd)}`,
        ].join("; ")
      : [
          "$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'",
          "Remove-ItemProperty -Path $k -Name 'DownX' -ErrorAction SilentlyContinue",
        ].join("; ");
    const enc = Buffer.from(ps, "utf16le").toString("base64");
    spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", enc], {
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    console.log(`[daemon] 开机自启动：${settings.autoStart ? "开" : "关"}`);
  } catch (e) {
    console.log("[daemon] 设置开机自启动失败:", e);
  }
}

// ── 实验性·超限模式（下载时把其他应用的网速压到极低；需要管理员）──
const TURBO_PS = join(ROOT, "turbo.ps1");
const TURBO_ON = join(ROOT, "turbo.on");
const TURBO_QUIT = join(ROOT, "turbo.quit");
const TURBO_PID = join(ROOT, "turbo.pid");
let turboActive = false;
let turboHelperStarted = false;

/**
 * 常驻限速助手：看到 turbo.on 就"给当前有活动连接的其他应用"逐个下 1Kbit 限流；
 * 看到 turbo.quit 退出。**只针对别的进程**——DownX 自己不在名单里。
 */
function turboScript(): string {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$root = Join-Path $env:LOCALAPPDATA 'DownX'",
    "$on = Join-Path $root 'turbo.on'",
    "$quit = Join-Path $root 'turbo.quit'",
    "Set-Content -Path (Join-Path $root 'turbo.pid') -Value $PID -Encoding ascii",
    // 我们自己 + 关键系统进程不碰
    "$exclude = @('downx','downx-console','System','Idle','svchost','lsass','services','csrss','wininit','winlogon','spoolsv','dwm','MemCompression','Registry')",
    "$managed = @{}",
    "function Clear-All {",
    "  Get-NetQosPolicy -PolicyStore ActiveStore | Where-Object { $_.Name -like 'DownX-Turbo-*' } | ForEach-Object {",
    "    Remove-NetQosPolicy -Name $_.Name -PolicyStore ActiveStore -Confirm:$false | Out-Null",
    "  }",
    "  $script:managed = @{}",
    "}",
    "function Apply {",
    "  $names = @()",
    "  Get-NetTCPConnection -State Established | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {",
    "    $p = Get-Process -Id $_",
    "    if ($p -and $exclude -notcontains $p.ProcessName) { $names += ($p.ProcessName + '.exe') }",
    "  }",
    "  $names = $names | Sort-Object -Unique",
    "  foreach ($n in $names) {",
    "    if (-not $script:managed.ContainsKey($n)) {",
    "      New-NetQosPolicy -Name ('DownX-Turbo-' + $n) -AppPathNameMatchCondition $n -ThrottleRateActionBitsPerSecond 1024 -PolicyStore ActiveStore | Out-Null",
    "      $script:managed[$n] = $true",
    "    }",
    "  }",
    "  foreach ($n in @($script:managed.Keys)) {",
    "    if ($names -notcontains $n) {",
    "      Remove-NetQosPolicy -Name ('DownX-Turbo-' + $n) -PolicyStore ActiveStore -Confirm:$false | Out-Null",
    "      $script:managed.Remove($n)",
    "    }",
    "  }",
    "}",
    "Clear-All",
    "while (-not (Test-Path $quit)) {",
    "  if (Test-Path $on) { Apply } elseif ($script:managed.Count -gt 0) { Clear-All }",
    "  Start-Sleep -Milliseconds 2000",
    "}",
    "Clear-All",
  ].join("\r\n");
}

function turboHelperRunning(): boolean {
  try {
    const pid = Number(readFileSync(TURBO_PID, "utf8").trim());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 申请管理员权限拉起限速助手（会有一次 UAC）。只在"开启时/启动时"调用，不会反复弹。 */
function startTurboHelper() {
  if (turboHelperRunning()) {
    turboHelperStarted = true;
    return;
  }
  try {
    writeFileSync(TURBO_PS, turboScript(), "utf8");
    rmSync(TURBO_QUIT, { force: true });
    const ps = `Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psq(TURBO_PS)}`;
    const enc = Buffer.from(ps, "utf16le").toString("base64");
    spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", enc], {
      stdio: "ignore",
      windowsHide: true,
    }).unref();
    turboHelperStarted = true;
    console.log("[daemon] 超限模式：已申请管理员权限（如弹出 UAC 请允许）");
  } catch (e) {
    console.log("[daemon] 超限模式启动失败:", e);
  }
}

function stopTurboHelper() {
  turboActive = false;
  turboHelperStarted = false;
  try {
    rmSync(TURBO_ON, { force: true });
  } catch {}
  try {
    writeFileSync(TURBO_QUIT, "");
  } catch {}
}

/** 等待限速助手真正跑起来（= 用户同意了 UAC）。 */
function waitTurboHelper(timeoutMs = 25000): Promise<boolean> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const tick = () => {
      if (turboHelperRunning()) return resolve(true);
      if (Date.now() - t0 > timeoutMs) return resolve(false);
      setTimeout(tick, 300);
    };
    tick();
  });
}

/** 按"当前有没有任务在下载"关/开限速（只动标记文件，助手负责真正的 QoS）。 */
function applyTurbo() {
  if (!settings.turbo) return;
  const want = runningCount() > 0;
  if (want === turboActive) return;
  turboActive = want;
  try {
    if (want) writeFileSync(TURBO_ON, "");
    else rmSync(TURBO_ON, { force: true });
  } catch {}
  console.log(`[daemon] 超限模式：${want ? "开始限速其他应用" : "已撤销限速"}`);
}

/** 记录当前是否已提权（方便判断"超限模式为什么不弹 UAC"）。 */
async function logElevation() {
  try {
    const ps =
      "([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)";
    const enc = Buffer.from(ps, "utf16le").toString("base64");
    const p = Bun.spawn(["powershell.exe", "-NoProfile", "-EncodedCommand", enc], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
    });
    const out = (await new Response(p.stdout as ReadableStream).text()).trim();
    console.log(
      `[daemon] 权限：${out === "True" ? "管理员（已提权，开启超限模式不会弹 UAC）" : "普通用户（开启超限模式会弹 UAC）"}`,
    );
  } catch {}
}

function notify(title: string, body: string) {
  const esc = (s: string) =>
    s
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  const xml =
    `<toast activationType="protocol" launch="downx:">` +
    `<visual><binding template="ToastGeneric">` +
    `<text>${esc(title)}</text><text>${esc(body)}</text>` +
    `</binding></visual>` +
    `</toast>`;
  const ps = [
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] > $null",
    "[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] > $null",
    "$doc = [Windows.Data.Xml.Dom.XmlDocument]::new()",
    `$doc.LoadXml(${psq(xml)})`,
    "$toast = [Windows.UI.Notifications.ToastNotification]::new($doc)",
    "$appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show($toast)",
  ].join("; ");
  try {
    const enc = Buffer.from(ps, "utf16le").toString("base64");
    const p = spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", enc], {
      stdio: "ignore",
      windowsHide: true,
    });
    p.unref();
    console.log(`[daemon] 通知：${title} — ${body}`);
  } catch (e) {
    console.log(`[daemon] 通知失败：${e}`);
  }
}

// ── 系统托盘（PowerShell 宿主，best-effort）──────────────
let trayProc: ReturnType<typeof spawn> | null = null;

function trayScript(port: number): string {
  const psQ = (s: string) => "'" + s.replace(/'/g, "''") + "'";
  const compiled = !process.execPath.toLowerCase().endsWith("bun.exe");
  return `
$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$DaemonPid = ${process.pid}
$Port = ${port}
$Compiled = $${compiled ? "true" : "false"}
$ExePath = ${psQ(process.execPath)}
$Launcher = ${psQ(LAUNCHER_PATH)}
$DevDir = ${psQ(process.cwd())}
$DevCmd = 'bun run src\\index.ts'

function Open-DownX {
  if ($Compiled) { Start-Process -FilePath $Launcher }
  else { Start-Process -FilePath 'cmd.exe' -ArgumentList '/k', $DevCmd -WorkingDirectory $DevDir }
}

$ni = New-Object System.Windows.Forms.NotifyIcon
try { $ni.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($ExePath) } catch { $ni.Icon = [System.Drawing.SystemIcons]::Application }
$ni.Text = 'DownX'
$ni.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$miOpen = $menu.Items.Add('打开 DownX')
$miOpen.add_Click({ Open-DownX })
$miDir = $menu.Items.Add('打开下载目录')
$miDir.add_Click({
  try {
    $s = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/settings" -TimeoutSec 3
    Start-Process -FilePath 'explorer.exe' -ArgumentList $s.downloadDir
  } catch {}
})
$null = $menu.Items.Add('-')
$miExit = $menu.Items.Add('退出')
$miExit.add_Click({
  Stop-Process -Id $DaemonPid -Force
  $ni.Visible = $false
  $script:running = $false
})
$ni.ContextMenuStrip = $menu
$ni.add_MouseDoubleClick({ Open-DownX })

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 2000
$timer.add_Tick({
  if (-not (Get-Process -Id $DaemonPid -ErrorAction SilentlyContinue)) {
    $ni.Visible = $false
    $script:running = $false
    return
  }
  try {
    $s = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/state" -TimeoutSec 3
    $run = @($s.tasks | Where-Object { $_.state -eq 1 }).Count
    $all = @($s.tasks).Count
    $ni.Text = "DownX · 进行中 $run / 共 $all"
  } catch {
    $ni.Text = 'DownX · 未连接'
  }
})
$timer.Start()

# 手动消息泵（隐藏窗口下 Application.Run() 会立刻返回）
$script:running = $true
while ($script:running) {
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 100
}
$ni.Visible = $false
`;
}

function startTray(port: number) {
  if (trayProc) return;
  try {
    const file = join(ROOT, "tray.ps1");
    // 必须带 UTF-8 BOM：Windows PowerShell 5.1 默认按本地代码页读脚本，中文会解析失败
    writeFileSync(file, "\uFEFF" + trayScript(port), "utf8");
    let out: number | "ignore" = "ignore";
    try {
      out = openSync(join(ROOT, "tray.log"), "a");
    } catch {}
    trayProc = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", file],
      { detached: false, stdio: ["ignore", out, out], windowsHide: true },
    );
    trayProc.unref();
    trayProc.on("exit", (code: number | null) => {
      console.log(`[daemon] 托盘进程退出 code=${code}`);
      trayProc = null;
    });
    console.log(`[daemon] 托盘图标已启动 (pid=${trayProc.pid})`);
  } catch (e) {
    console.log("[daemon] 托盘启动失败:", e);
  }
}

function stopTray() {
  if (trayProc) {
    try {
      trayProc.kill();
    } catch {}
    trayProc = null;
  }
}

function deriveName(url: string): string {
  try {
    const u = new URL(url);
    const n = basename(u.pathname);
    return n && n !== "/" ? n : "download.bin";
  } catch {
    return "download.bin";
  }
}

/** 用资源管理器打开文件（reveal=true 则定位选中它）。 */
function openInExplorer(path: string, reveal: boolean) {
  try {
    spawn("explorer.exe", reveal ? [`/select,${path}`] : [path], { stdio: "ignore" }).unref();
  } catch {}
}

// ── 任务操作 ──────────────────────────────────────────────
/** 按当前设置构建引擎任务配置。 */
function taskConfig() {
  return {
    threads: settings.threads,
    user_agent: settings.userAgent || undefined,
    max_speed: settings.maxSpeedKB > 0 ? settings.maxSpeedKB * 1024 : 0,
    max_retries: settings.maxRetries,
    min_part_size: settings.minPartMiB * 1048576,
    idle_timeout_secs: settings.idleTimeoutSecs,
    proxy: settings.proxy || undefined,
  };
}

function startTask(t: Task) {
  t.bid = engine.start(t.url, t.path, taskConfig());
  t.state = 1;
  t.err = "";
  t.segments = [];
  t.speed = 0;
  t.startedAt = Date.now();
  t.finishedAt = 0;
}

function runningCount(): number {
  let n = 0;
  for (const t of tasks.values()) if (t.bid !== 0 && t.state === 1) n++;
  return n;
}

/** 把排队中的任务补到"同时下载数"上限。 */
function schedule() {
  let running = runningCount();
  for (const t of tasks.values()) {
    if (running >= settings.maxConcurrent) break;
    if (t.bid === 0 && t.state === 0 && !t.paused) {
      startTask(t);
      running++;
    }
  }
}

/** 取消桥接任务并等它真正结束（释放目标文件锁），再移除。返回是否已结束。 */
async function stopBridge(bid: number): Promise<boolean> {
  engine.cancel(bid);
  for (let i = 0; i < 150; i++) {
    // 最多 ~15s
    const s = engine.poll(bid);
    if (!s || s.state >= 2) {
      engine.remove(bid);
      return true;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  engine.remove(bid);
  return false;
}

function add(url: string, dir?: string, name?: string): number {
  const d = ensureDir(dir && dir.length ? dir : settings.downloadDir);
  const p = join(d, name && name.length ? name : deriveName(url));
  const t: Task = {
    uid: nextUid++,
    bid: 0,
    url,
    path: p,
    name: basename(p),
    dir: d,
    paused: false,
    addedAt: Date.now(),
    startedAt: Date.now(),
    finishedAt: 0,
    state: 0,
    downloaded: 0,
    total: 0,
    speed: 0,
    parts: 0,
    size: 0,
    err: "",
    segments: [],
  };
  tasks.set(t.uid, t);
  schedule();
  persist();
  return t.uid;
}

// —— 启动时：未完成的重启（引擎自带断点续传；按"同时下载数"排队）——
for (const t of tasks.values()) {
  if (t.state === 2 && existsSync(t.path)) continue; // 已完成且文件在
  t.bid = 0;
  t.state = 0; // 重新排队
}
schedule();

// ── 轮询：刷新运行时快照 + 状态迁移 + 通知 ───────────────
setInterval(() => {
  let changed = false;
  for (const t of tasks.values()) {
    if (t.bid === 0) continue;
    const s = engine.poll(t.bid);
    if (!s) {
      t.bid = 0;
      continue;
    }
    const prev = t.state;
    t.state = s.state;
    t.downloaded = s.downloaded;
    t.total = s.total;
    // 速度平滑（EWMA），避免瞬时值抖动
    t.speed = t.speed > 0 ? Math.round(t.speed * 0.6 + s.speed * 0.4) : s.speed;
    t.parts = s.parts;
    t.segments = engine.parts(t.bid);
    if (s.state >= 2) {
      t.size = s.size;
      if (s.state === 3) t.err = engine.error(t.bid);
      t.finishedAt = Date.now();
      engine.remove(t.bid);
      t.bid = 0;
      changed = true;
      const mb = (Math.max(s.size, s.downloaded) / 1048576).toFixed(1);
      if (s.state === 2) notify("DownX 下载完成", `${t.name}（${mb} MB）`);
      else if (s.state === 3) notify("DownX 下载失败", `${t.name}：${t.err.slice(0, 80)}`);
    } else if (prev !== s.state) {
      changed = true;
    }
  }
  schedule(); // 有槽位就启动排队中的任务
  applyTurbo(); // 有下载就限速其他应用，没有就撤销
  if (changed) persist();
}, 500);

setInterval(persist, 3000);

// ── 本地 HTTP API（= Chrome 扩展接口）─────────────────────
function state() {
  return {
    version: VERSION,
    tasks: [...tasks.values()].map((t) => ({
      uid: t.uid,
      url: t.url,
      path: t.path,
      name: t.name,
      dir: t.dir,
      paused: t.paused,
      state: t.state,
      downloaded: t.downloaded,
      total: t.total,
      speed: t.speed,
      parts: t.parts,
      size: t.size,
      err: t.err,
      segments: t.segments,
      addedAt: t.addedAt,
      startedAt: t.startedAt,
      finishedAt: t.finishedAt,
    })),
  };
}

async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const CORS = {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,POST,OPTIONS",
    };
    const json = (o: unknown, code = 200) =>
      new Response(JSON.stringify(o), { status: code, headers: { "content-type": "application/json", ...CORS } });
    try {
      if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
      if (req.method === "GET" && url.pathname === "/ping") return json({ ok: true, version: VERSION });
      if (req.method === "GET" && url.pathname === "/state") return json(state());
      if (req.method === "GET" && url.pathname === "/settings") return json(settings);
      // 超限模式：只有确认拿到管理员权限（助手起来）才真正开启
      if (req.method === "POST" && url.pathname === "/turbo") {
        const b = (await req.json()) as { on?: boolean };
        if (b.on) {
          startTurboHelper();
          const ok = await waitTurboHelper();
          if (!ok) return json({ ok: false, error: "未获得管理员权限" });
          settings = saveSettings({ ...settings, turbo: true });
          applyTurbo();
          return json({ ok: true, settings });
        }
        settings = saveSettings({ ...settings, turbo: false });
        stopTurboHelper();
        return json({ ok: true, settings });
      }
      if (req.method === "POST" && url.pathname === "/settings") {
        const b = (await req.json()) as Partial<Settings>;
        // turbo 只能走 /turbo（要过 UAC），这里忽略它
        delete (b as Record<string, unknown>).turbo;
        const beforeAuto = settings.autoStart;
        settings = saveSettings({ ...settings, ...b });
        if (settings.autoStart !== beforeAuto) applyAutoStart();
        schedule(); // 同时下载数可能变了
        return json(settings);
      }
      if (req.method === "POST" && url.pathname === "/add") {
        const b = (await req.json()) as { url?: string; dir?: string; name?: string };
        if (!b.url) return json({ error: "url required" }, 400);
        const uid = add(b.url, b.dir, b.name);
        return json({ uid });
      }
      if (req.method === "POST") {
        const b = (await req.json()) as { uid?: number; paused?: boolean };
        const t = b.uid != null ? tasks.get(b.uid) : undefined;
        if (!t) return json({ error: "task not found" }, 404);
        switch (url.pathname) {
          case "/pause":
            t.paused = !!b.paused;
            if (t.bid) engine.pause(t.bid, t.paused);
            schedule();
            persist();
            return json({ ok: true });
          case "/cancel":
            if (t.bid) engine.cancel(t.bid);
            else if (t.state === 0) {
              t.state = 4; // 排队中直接取消
              t.finishedAt = Date.now();
            }
            schedule();
            persist();
            return json({ ok: true });
          case "/retry": {
            // 旧任务若还在跑：先取消并等它释放目标文件锁，否则新任务会 busy
            const old = t.bid;
            if (old) {
              await stopBridge(old);
              if (t.bid === old) t.bid = 0;
            }
            t.state = 0; // 重新排队
            t.paused = false;
            t.err = "";
            t.finishedAt = 0;
            schedule();
            persist();
            return json({ ok: true });
          }
          case "/remove": {
            const old = t.bid;
            tasks.delete(t.uid);
            persist();
            if (old) void stopBridge(old); // 取消后台下载（不阻塞响应）
            schedule();
            return json({ ok: true });
          }
          case "/open":
            if (existsSync(t.path)) openInExplorer(t.path, false);
            return json({ ok: true });
          case "/reveal":
            openInExplorer(t.path, true);
            return json({ ok: true });
        }
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
}

function listen(port: number) {
  return Bun.serve({ hostname: "127.0.0.1", port, fetch: handle });
}

// 固定端口（扩展可直接找），被占用则退回系统随机端口
const preferred = Number(process.env.DOWNX_PORT ?? 8787);
let server: ReturnType<typeof Bun.serve>;
try {
  server = listen(preferred);
} catch {
  server = listen(0);
}

writeFileSync(DAEMON_FILE, JSON.stringify({ port: server.port, pid: process.pid, version: VERSION }));
console.log(`[daemon] listening on 127.0.0.1:${server.port} (pid ${process.pid})`);
startTray(server.port);
registerProtocol();
applyAutoStart();
void logElevation();
if (settings.turbo) {
  startTurboHelper();
  applyTurbo();
}

process.on("SIGINT", () => {
  persist();
  stopTray();
  process.exit(0);
});
process.on("SIGTERM", () => {
  persist();
  stopTray();
  process.exit(0);
});
process.on("exit", () => stopTray());
