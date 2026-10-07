//! DownX 的引擎桥接层：把 DownloadCore 的 Rust 引擎包一层**轮询式** C 接口。
//!
//! 为什么要这层：DownloadCore 的 C ABI 是"同步 + 回调"，回调会从引擎的工作线程触发；
//! 直接在 Bun/JS 里跨线程回调不安全。这里把下载跑在独立 Rust 线程，状态写进原子量，
//! 对 JS 只暴露 start / poll / pause / cancel / remove —— JS 侧轮询即可。

use std::collections::HashMap;
use std::ffi::CStr;
use std::os::raw::c_char;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use downloadcore::{Callbacks, Config, Engine, ErrorKind, PartProgress, Progress, Request};
use serde::Deserialize;
use std::time::Duration;

/// 每个任务的引擎配置（由后台以 JSON 传入；缺省字段用默认值）。
#[derive(Debug, Default, Deserialize)]
struct TaskCfg {
    threads: Option<i64>,
    user_agent: Option<String>,
    /// 限速：字节/秒（0 = 不限）
    max_speed: Option<u64>,
    max_retries: Option<usize>,
    /// 分块大小（字节）
    min_part_size: Option<i64>,
    /// 空闲超时（秒）
    idle_timeout_secs: Option<u64>,
    /// 代理：http://[user:pass@]host:port 或 socks5://...
    proxy: Option<String>,
}

impl TaskCfg {
    fn to_config(&self) -> Config {
        let mut cfg = Config::default();
        let n = self.threads.unwrap_or(16).clamp(1, 64) as usize;
        cfg.initial_threads = n;
        cfg.max_threads = n;
        if let Some(ua) = self.user_agent.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            cfg.user_agent = ua.to_string();
        }
        if let Some(s) = self.max_speed {
            cfg.max_speed = s;
        }
        if let Some(r) = self.max_retries {
            cfg.max_retries = r.min(1000);
        }
        if let Some(m) = self.min_part_size {
            if m > 0 {
                cfg.min_part_size = m;
            }
        }
        if let Some(t) = self.idle_timeout_secs {
            if t > 0 {
                cfg.idle_timeout = Duration::from_secs(t);
            }
        }
        if let Some(p) = self.proxy.as_ref().map(|s| s.trim()).filter(|s| !s.is_empty()) {
            cfg.proxy = Some(p.to_string());
        }
        cfg
    }
}

/// 进度快照（全 i64，无填充，方便 FFI 读取）。
#[repr(C)]
pub struct DownxProgress {
    /// 0=初始化 1=进行中 2=完成 3=失败 4=已取消
    pub state: i64,
    pub downloaded: i64,
    pub total: i64,
    pub speed: i64,
    pub parts: i64,
    pub size: i64,
}

/// 单个分段的进度（全 i64，无填充，方便 FFI 读取）。
#[repr(C)]
#[derive(Clone, Copy)]
pub struct DownxPart {
    pub from: i64,
    pub to: i64,
    pub current: i64,
}

struct Task {
    state: AtomicI64,
    downloaded: AtomicI64,
    total: AtomicI64,
    speed: AtomicI64,
    parts: AtomicI64,
    size: AtomicI64,
    cancel: Arc<AtomicBool>,
    pause: Arc<AtomicBool>,
    err: Mutex<String>,
    parts_data: Mutex<Vec<DownxPart>>,
}

impl Task {
    fn new() -> Self {
        Task {
            state: AtomicI64::new(1),
            downloaded: AtomicI64::new(0),
            total: AtomicI64::new(0),
            speed: AtomicI64::new(0),
            parts: AtomicI64::new(0),
            size: AtomicI64::new(0),
            cancel: Arc::new(AtomicBool::new(false)),
            pause: Arc::new(AtomicBool::new(false)),
            err: Mutex::new(String::new()),
            parts_data: Mutex::new(Vec::new()),
        }
    }
}

static TASKS: OnceLock<Mutex<HashMap<i64, Arc<Task>>>> = OnceLock::new();
static NEXT_ID: AtomicI64 = AtomicI64::new(1);

fn tasks() -> &'static Mutex<HashMap<i64, Arc<Task>>> {
    TASKS.get_or_init(|| Mutex::new(HashMap::new()))
}

unsafe fn cstr(p: *const c_char) -> String {
    if p.is_null() {
        return String::new();
    }
    unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned()
}

/// 开始一个下载，返回任务 id（>0）。`cfg_json` 为任务配置（JSON，可空）。
#[unsafe(no_mangle)]
pub extern "C" fn downx_start(url: *const c_char, path: *const c_char, cfg_json: *const c_char) -> i64 {
    let url = unsafe { cstr(url) };
    let path = unsafe { cstr(path) };
    let raw = unsafe { cstr(cfg_json) };
    let tcfg: TaskCfg = if raw.trim().is_empty() {
        TaskCfg::default()
    } else {
        serde_json::from_str(&raw).unwrap_or_default()
    };
    let id = NEXT_ID.fetch_add(1, Ordering::SeqCst);

    let task = Arc::new(Task::new());
    tasks().lock().unwrap().insert(id, task.clone());

    std::thread::spawn(move || {
        let engine = Engine::new(tcfg.to_config());
        let req = Request {
            url,
            target_file: Some(path),
            headers: Vec::new(),
            cancel: Some(task.cancel.clone()),
            pause: Some(task.pause.clone()),
            expected_sha256: None,
        };
        let tc = task.clone();
        let tp = task.clone();
        let cbs = Callbacks {
            on_progress: Some(Box::new(move |p: Progress| {
                tc.downloaded.store(p.downloaded, Ordering::SeqCst);
                tc.total.store(p.total, Ordering::SeqCst);
                tc.speed.store(p.speed, Ordering::SeqCst);
                tc.parts.store(p.parts as i64, Ordering::SeqCst);
            })),
            on_status: None,
            on_log: None,
            on_parts: Some(Box::new(move |v: Vec<PartProgress>| {
                let list: Vec<DownxPart> = v
                    .into_iter()
                    .map(|p| DownxPart { from: p.from, to: p.to, current: p.current })
                    .collect();
                if let Ok(mut g) = tp.parts_data.lock() {
                    *g = list;
                }
            })),
        };
        match engine.download(req, cbs) {
            Ok(res) => {
                task.size.store(res.size, Ordering::SeqCst);
                task.state.store(2, Ordering::SeqCst);
            }
            Err(e) => {
                if e.kind == ErrorKind::Canceled {
                    task.state.store(4, Ordering::SeqCst);
                } else {
                    *task.err.lock().unwrap() = e.to_string();
                    task.state.store(3, Ordering::SeqCst);
                }
            }
        }
    });
    id
}

/// 读取进度，返回状态码（0=任务不存在）。
#[unsafe(no_mangle)]
pub extern "C" fn downx_poll(id: i64, out: *mut DownxProgress) -> i64 {
    let t = tasks().lock().unwrap().get(&id).cloned();
    let Some(t) = t else { return 0 };
    let state = t.state.load(Ordering::SeqCst);
    if !out.is_null() {
        unsafe {
            out.write(DownxProgress {
                state,
                downloaded: t.downloaded.load(Ordering::SeqCst),
                total: t.total.load(Ordering::SeqCst),
                speed: t.speed.load(Ordering::SeqCst),
                parts: t.parts.load(Ordering::SeqCst),
                size: t.size.load(Ordering::SeqCst),
            });
        }
    }
    state
}

#[unsafe(no_mangle)]
pub extern "C" fn downx_pause(id: i64, paused: i64) {
    if let Some(t) = tasks().lock().unwrap().get(&id) {
        t.pause.store(paused != 0, Ordering::SeqCst);
    }
}

#[unsafe(no_mangle)]
pub extern "C" fn downx_cancel(id: i64) {
    if let Some(t) = tasks().lock().unwrap().get(&id) {
        t.cancel.store(true, Ordering::SeqCst);
        t.pause.store(false, Ordering::SeqCst);
    }
}

/// 把错误信息写入调用方缓冲，返回写入长度。
#[unsafe(no_mangle)]
pub extern "C" fn downx_error(id: i64, buf: *mut c_char, len: i64) -> i64 {
    let msg = tasks()
        .lock()
        .unwrap()
        .get(&id)
        .map(|t| t.err.lock().unwrap().clone())
        .unwrap_or_default();
    let bytes = msg.as_bytes();
    let cap = (len.max(0) as usize).saturating_sub(1);
    let n = bytes.len().min(cap);
    if !buf.is_null() && len > 0 {
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), buf as *mut u8, n);
            *buf.add(n) = 0;
        }
    }
    n as i64
}

#[unsafe(no_mangle)]
pub extern "C" fn downx_remove(id: i64) {
    tasks().lock().unwrap().remove(&id);
}

/// 返回分段数量（任务不存在返回 0）。
#[unsafe(no_mangle)]
pub extern "C" fn downx_parts_count(id: i64) -> i64 {
    tasks()
        .lock()
        .unwrap()
        .get(&id)
        .map(|t| t.parts_data.lock().map(|g| g.len() as i64).unwrap_or(0))
        .unwrap_or(0)
}

/// 取第 index 段写入 out，成功返回 1，越界/不存在返回 0。
#[unsafe(no_mangle)]
pub extern "C" fn downx_parts_get(id: i64, index: i64, out: *mut DownxPart) -> i64 {
    let t = tasks().lock().unwrap().get(&id).cloned();
    let Some(t) = t else { return 0 };
    let Ok(g) = t.parts_data.lock() else { return 0 };
    if index < 0 || index as usize >= g.len() {
        return 0;
    }
    if !out.is_null() {
        unsafe { out.write(g[index as usize]) };
    }
    1
}

/// 桥接层版本号（写进缓冲，返回长度）。
#[unsafe(no_mangle)]
pub extern "C" fn downx_version(buf: *mut c_char, len: i64) -> i64 {
    let v = env!("CARGO_PKG_VERSION");
    let bytes = v.as_bytes();
    let cap = (len.max(0) as usize).saturating_sub(1);
    let n = bytes.len().min(cap);
    if !buf.is_null() && len > 0 {
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), buf as *mut u8, n);
            *buf.add(n) = 0;
        }
    }
    n as i64
}
