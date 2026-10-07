//! DownX 单文件启动器（GUI 子系统，**双击不分配控制台 → 零闪**）。
//!
//! 本体内嵌真正的控制台程序（`downx-console.exe`），首次运行时释放到 `%LOCALAPPDATA%\DownX\`。
//!   · TUI 角色（无参数 / `tui` / `downx:`）：已有 TUI（命名互斥体）→ 前置它；否则用
//!     CREATE_NEW_CONSOLE 拉起控制台程序。
//!   · 控制台角色（`daemon`/`add`/`state`/`-v`）：AttachConsole(父) 后转发，终端里能看到输出。
#![windows_subsystem = "windows"]

use std::ffi::OsString;
use std::os::windows::ffi::OsStrExt;
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::Command;

/// 内嵌的控制台程序（由 `bun run build:tui` 生成，构建后会被删除）
static CONSOLE_EXE: &[u8] = include_bytes!("../embed/downx-console.exe");

const SYNCHRONIZE: u32 = 0x0010_0000;
const ATTACH_PARENT_PROCESS: u32 = 0xFFFF_FFFF;
const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const SW_RESTORE: i32 = 9;

#[link(name = "kernel32")]
extern "system" {
    fn OpenMutexW(desired_access: u32, inherit: i32, name: *const u16) -> isize;
    fn CloseHandle(h: isize) -> i32;
    fn AttachConsole(pid: u32) -> i32;
}

#[link(name = "user32")]
extern "system" {
    fn FindWindowW(class: *const u16, title: *const u16) -> isize;
    fn ShowWindow(h: isize, cmd: i32) -> i32;
    fn SetForegroundWindow(h: isize) -> i32;
}

// 与 Bun 侧 index.ts 的 TUI_MUTEX / TUI_TITLE 一致
const MUTEX_NAME: &str = "Local\\DownX-TUI";
const WINDOW_TITLE: &str = "DownX";
const CONSOLE_NAME: &str = "downx-console.exe";

fn wide(s: &str) -> Vec<u16> {
    std::ffi::OsStr::new(s).encode_wide().chain(std::iter::once(0)).collect()
}

/// 记录启动器动作（点 exe 没反应时看这个文件）。
fn log(msg: &str) {
    let Some(base) = std::env::var_os("LOCALAPPDATA") else { return };
    let dir = PathBuf::from(base).join("DownX");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("launcher.log")) {
        use std::io::Write;
        let ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let _ = writeln!(f, "[{ms}] {msg}");
    }
}

fn tui_running() -> bool {
    let name = wide(MUTEX_NAME);
    unsafe {
        let h = OpenMutexW(SYNCHRONIZE, 0, name.as_ptr());
        if h != 0 {
            CloseHandle(h);
            true
        } else {
            false
        }
    }
}

fn focus_existing() {
    let title = wide(WINDOW_TITLE);
    unsafe {
        let h = FindWindowW(std::ptr::null(), title.as_ptr());
        if h != 0 {
            ShowWindow(h, SW_RESTORE);
            SetForegroundWindow(h);
        }
    }
}

/// 把内嵌的控制台程序释放到 %LOCALAPPDATA%\DownX\（大小一致就跳过；写不动则退回用现有文件）。
fn ensure_console_exe() -> Option<PathBuf> {
    let base = std::env::var_os("LOCALAPPDATA")?;
    let dir = PathBuf::from(base).join("DownX");
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join(CONSOLE_NAME);
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    if size != CONSOLE_EXE.len() as u64 {
        match std::fs::write(&path, CONSOLE_EXE) {
            Ok(_) => log(&format!("released {CONSOLE_NAME} ({} bytes)", CONSOLE_EXE.len())),
            Err(e) => {
                // 多半是旧副本还在运行占着文件——退回用现有文件，至少能跑起来
                log(&format!("write {CONSOLE_NAME} failed: {e}"));
                if !path.exists() {
                    log("no usable console exe -> abort");
                    return None;
                }
            }
        }
    }
    Some(path)
}

fn main() {
    let launcher = std::env::current_exe().ok();
    let launcher_dir = launcher
        .as_ref()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_else(|| PathBuf::from("."));

    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let cmd = args
        .first()
        .map(|a| a.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    let console_cmd = matches!(cmd.as_str(), "daemon" | "add" | "state" | "-v" | "--version");

    // 控制台角色：先附着父控制台，再转发（无需释放/拉起新窗口）
    if console_cmd {
        let Some(exe) = ensure_console_exe() else { return };
        unsafe {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
        let _ = Command::new(&exe).args(&args).status();
        return;
    }

    // 开机自启动：静默拉起后台（无窗口），日志写 daemon.log
    if cmd == "autostart" {
        let Some(exe) = ensure_console_exe() else { return };
        let mut c = Command::new(&exe);
        c.arg("daemon").creation_flags(CREATE_NO_WINDOW);
        if let Some(base) = std::env::var_os("LOCALAPPDATA") {
            let dir = PathBuf::from(base).join("DownX");
            let _ = std::fs::create_dir_all(&dir);
            if let Ok(f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("daemon.log")) {
                if let Ok(f2) = f.try_clone() {
                    c.stdout(std::process::Stdio::from(f2));
                }
                c.stderr(std::process::Stdio::from(f));
            }
        }
        let _ = c.spawn();
        return;
    }

    // TUI 角色：已有 → 前置；没有 → 拉起（新控制台）
    log(&format!("cmd={cmd:?} tui_running={}", tui_running()));
    if tui_running() {
        focus_existing();
        log("focused existing TUI, exit");
        return;
    }
    let Some(exe) = ensure_console_exe() else { return };
    log(&format!("spawning {}", exe.display()));
    let mut c = Command::new(&exe);
    c.arg("tui")
        .creation_flags(CREATE_NEW_CONSOLE)
        .current_dir(&launcher_dir)
        .env("DOWNX_LAUNCHER", launcher.as_ref().map(|p| p.as_os_str()).unwrap_or_default());
    match c.spawn() {
        Ok(child) => log(&format!("spawned ok pid={}", child.id())),
        Err(e) => log(&format!("spawn failed: {e}")),
    }
}
