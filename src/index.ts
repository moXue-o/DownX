// DownX 单 exe 入口：按参数分角色。
//   downx            → TUI 前端（若后台没起，分离启动它）
//   downx daemon     → 后台服务（无界面）
//   downx add <url> [目录] [文件名] → 加任务（脚本/扩展可用）
//   downx state      → 打印任务 JSON
import { spawn } from "node:child_process";
import { appendFileSync, openSync, existsSync, readFileSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { Client } from "./client";
import { DAEMON_LOG, TUI_FILE } from "./paths";
import { claimSingleInstance, setConsoleTitle, focusWindowByTitle, hideOwnConsole } from "./win32";

const TUI_TITLE = "DownX"; // 供 AppActivate / FindWindow 定位（保持 ASCII）
const TUI_MUTEX = "Local\\DownX-TUI";

const VERSION = "0.1.0";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const args = process.argv.slice(2);
const cmd = args[0] ?? "tui";

function logerr(tag: string, e: unknown): void {
  try {
    appendFileSync(DAEMON_LOG, `[${new Date().toISOString()}] [${tag}] ${(e as any)?.stack ?? String(e)}\n`);
  } catch {}
}

// 兜底：不让未捕获异常/未处理 Promise 直接干掉进程（尤其是 TUI）。
process.on("uncaughtException", (e) => logerr("uncaught", e));
process.on("unhandledRejection", (e) => logerr("unhandled", e));

async function waitDaemon(): Promise<Client> {
  for (let i = 0; i < 300; i++) {
    const c = await Client.connect();
    if (c) return c;
    await sleep(100);
  }
  throw new Error("无法连接后台进程（daemon.json 或端口）");
}

/** 分离启动后台：脱离当前终端，关掉窗口也继续下。 */
function spawnDaemon(): void {
  try {
    const compiled = !process.execPath.toLowerCase().endsWith("bun.exe");
    const argv = compiled ? ["daemon"] : ["run", "./src/daemon.ts"];
    let out: number | "ignore" = "ignore";
    try {
      out = openSync(DAEMON_LOG, "a");
    } catch {}
    const child = spawn(process.execPath, argv, {
      detached: true,
      stdio: ["ignore", out, out],
      windowsHide: true,
      cwd: process.cwd(),
    });
    child.unref();
  } catch (e) {
    logerr("spawn-daemon", e);
  }
}

async function ensureDaemon(): Promise<Client> {
  const c = await Client.connect();
  if (c) return c;
  spawnDaemon();
  return await waitDaemon();
}

/** 是否已有存活的 TUI（返回其 pid）。 */
function liveTuiPid(): number | null {
  try {
    if (!existsSync(TUI_FILE)) return null;
    const { pid } = JSON.parse(readFileSync(TUI_FILE, "utf8")) as { pid?: number };
    if (!pid || pid === process.pid) return null;
    process.kill(pid, 0); // 进程不存在会抛
    return pid;
  } catch {
    return null;
  }
}

/** 兜底：按 pid 找主窗口并前置（非阻塞，best-effort）。 */
function focusTuiWindow(pid: number): void {
  const sig =
    '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);' +
    '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);';
  const ps =
    "$ErrorActionPreference='SilentlyContinue';" +
    `Add-Type -MemberDefinition '${sig}' -Name W -Namespace Win32;` +
    `$h=(Get-Process -Id ${pid}).MainWindowHandle;` +
    "if($h -ne 0){[Win32.W]::ShowWindow($h,9)|Out-Null;[Win32.W]::SetForegroundWindow($h)|Out-Null}";
  try {
    const enc = Buffer.from(ps, "utf16le").toString("base64");
    spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-EncodedCommand", enc], {
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  } catch {}
}

function claimTui(): void {
  try {
    writeFileSync(TUI_FILE, JSON.stringify({ pid: process.pid, at: Date.now() }));
    const clean = () => {
      try {
        const { pid } = JSON.parse(readFileSync(TUI_FILE, "utf8")) as { pid?: number };
        if (pid === process.pid) unlinkSync(TUI_FILE);
      } catch {}
    };
    process.on("exit", clean);
  } catch {}
}

async function main(): Promise<void> {
  if (cmd === "daemon") {
    await import("./daemon");
    return;
  }
  if (cmd === "-v" || cmd === "--version") {
    console.log(`DownX ${VERSION}`);
    return;
  }
  if (cmd === "add") {
    const url = args[1];
    if (!url) {
      console.error("用法: downx add <url> [目录] [文件名]");
      process.exit(1);
    }
    const c = await ensureDaemon();
    const r = await c.add(url, args[2], args[3]);
    console.log(r.uid ? `已加入任务 #${r.uid}` : `失败：${r.error}`);
    return;
  }
  if (cmd === "state") {
    const c = await ensureDaemon();
    console.log(JSON.stringify(await c.state(), null, 2));
    return;
  }
  // 默认：TUI。用系统命名互斥体保证单实例；已有实例则前置它并退出。
  if (!claimSingleInstance(TUI_MUTEX)) {
    hideOwnConsole(); // 先把系统刚给我分配的空控制台窗口干掉，别让它杵着
    if (!focusWindowByTitle(TUI_TITLE)) {
      const pid = liveTuiPid();
      if (pid) focusTuiWindow(pid);
    }
    return;
  }
  setConsoleTitle(TUI_TITLE);
  const c = await ensureDaemon();
  claimTui();
  const { runTui } = await import("./tui");
  await runTui(c);
}

main().catch((e) => {
  logerr("main", e);
  console.error("DownX:", e?.message ?? String(e));
  process.exit(1);
});
