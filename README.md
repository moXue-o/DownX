# DownX

一个**终端界面的下载管理器**，引擎用我们的 Rust 库 [DownloadCore](https://github.com/moXue-o/DownloadCore)（多线程分段 / 断点续传）。

## 设计：单 exe，前后端分离

同一个 `downx.exe`，按参数分角色：

| 命令 | 作用 |
| --- | --- |
| `downx` | **启动器**：已有 TUI 就**前置**它，否则开一个新 TUI（GUI 子系统、零闪）；后台没起会分离启动后台 |
| `downx daemon` | **后台服务**（无界面）：引擎 + 任务表 + 持久化 + 通知 + 本地 API |
| `downx add <url> [目录] [文件名]` | 加任务（脚本 / Chrome 扩展可用） |
| `downx state` | 打印任务 JSON |

- **关掉终端，下载继续**：TUI 用 detached 方式拉起后台，后台脱离终端独立运行。
- **持久化**：任务与进度写盘，后台重启后自动**断点续传**（引擎自带）。

```
┌──────────┐   本地 HTTP     ┌──────────────────────────────┐
│  TUI     │ ───────────────▶│  daemon（后台）               │
│ (OpenTUI)│ ◀─────────────── │   ├─ DownloadCore 引擎        │
└──────────┘ /state /settings│   ├─ 任务表 + tasks.json       │
                             │   ├─ Windows 通知              │
  Chrome 扩展 ───HTTP────────▶│   └─ HTTP API（含 CORS）       │
                             └──────────────────────────────┘
```

## 运行

```powershell
downx                     # 打开 TUI
downx add "https://..."   # 直接加一个下载
downx state               # 看任务
```

TUI 键位：`↑ ↓` 选择 · `← →` 切换筛选 · 输入网址后 `⏎` 开始 · `Ctrl+P` 暂停/继续 · `Ctrl+X` 取消 · `Ctrl+R` 重试 · `Ctrl+D` 删除 · `Ctrl+C` 退出（**不影响后台下载**）。顶栏的 **下载 / 设置** 可用鼠标点击切换。

鼠标：**左键双击任务** = 打开文件；**右键任务** = 菜单（打开 / 打开所在位置 / 暂停继续 / 取消 / 重试 / 删除）。同一时刻只保留一个 TUI（**Win32 命名互斥体 + GUI 子系统启动器**从系统层保证）：双击 `downx.exe` / 点通知 / `downx:` 都由**无控制台的启动器**处理——已有 TUI 就**前置**（`FindWindowW`+`SetForegroundWindow`），没有才开新窗口，**全程不闪终端**。

## 设置

顶栏点 **设置** 进入设置页（点 **下载** 或按 `Esc` 返回）。分三类：

**常规**：下载目录 · 并发连接数(8/16/32) · 同时下载数(1/2/3/5/8) · 开机自启动

**网络**：代理（`http://[user:pass@]host:port` 或 `socks5://…`；留空=直连）· User-Agent · 空闲超时(秒)

**下载**：全局限速(KB/s，0=不限) · 分块大小(MiB) · 每段重试次数 · **超限模式(实验)**

**关于**：版本 · 引擎 · 服务地址 · 许可证 · 项目主页

除"下载目录 / 代理 / User-Agent"是输入框（回车保存）外，其余都是点击切换的选项。设置持久化在 `settings.json`，并通过 `GET/POST /settings` 暴露给扩展（Chrome 插件的选项页也能改）。用 `DOWNX_VIEW=settings downx` 可直接打开设置页。

> 代理由引擎的 native 网络层实现：`http://` 代理支持 HTTPS 目标（CONNECT 隧道）与 HTTP 目标（绝对地址转发），`socks5://` 走 SOCKS5 握手（域名交给代理解析）。

> **超限模式（实验）**：打开时会弹**一次 UAC** 申请管理员，并拉起一个常驻"限速助手"（`%LOCALAPPDATA%\DownX\turbo.ps1`）。**有任务在下载时**，它用 Windows QoS（`New-NetQosPolicy`）给 DownX 自身设最高优先级（DSCP 46），把其余流量限到 **1 Kbit/s**；下载结束或关闭开关即撤销策略、助手退出。需要 `NetQos` 模块（Win10/11 自带）。注意：Windows QoS 只做**发送方向**整形，对其他应用的影响是间接的；效果以实测为准。

## 存放位置（`%LOCALAPPDATA%\DownX`）

| 文件 | 说明 |
| --- | --- |
| `daemon.json` | 服务端口 + pid |
| `tasks.json` | 任务持久化 |
| `tui.json` | 当前 TUI 的 pid（供启动器前置） |
| `downx-console.exe` | 从 `downx.exe` 释放出的控制台程序（首次运行） |
| `settings.json` | 用户设置（目录 / 并发 / 同时下载数 / 代理 / UA / 限速 …） |
| `tray.ps1` · `tray.log` | 托盘图标脚本与其日志（PowerShell 宿主） |
| `downloads/` | 默认下载目录 |
| `cache/` | 释放内嵌原生库的缓存 |
| `daemon.log` | 后台日志 |

## Chrome 扩展接口（预留）

后台服务在 `127.0.0.1` 上开一个本地 HTTP 服务（端口见 `daemon.json`），**已开 CORS**，扩展可直接调用：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/ping` | 探活 |
| `GET` | `/state` | 全部任务 |
| `GET` | `/settings` | 读取设置 |
| `POST` | `/settings` | `{ "downloadDir"?, "threads"?, "maxConcurrent"?, "notify"?, "tray"?, "proxy"?, "userAgent"?, "maxSpeedKB"?, "minPartMiB"?, "maxRetries"?, "idleTimeoutSecs"? }` |
| `POST` | `/add` | `{ "url": "...", "dir"?: "...", "name"?: "..." }` |
| `POST` | `/pause` | `{ "uid": 1, "paused": true }` |
| `POST` | `/cancel` | `{ "uid": 1 }` |
| `POST` | `/retry` | `{ "uid": 1 }` |
| `POST` | `/remove` | `{ "uid": 1 }` |
| `POST` | `/open` | `{ "uid": 1 }` 用默认程序打开文件 |
| `POST` | `/reveal` | `{ "uid": 1 }` 在资源管理器中定位文件 |

> 扩展的典型流程：`GET /ping` 找端口 → `POST /add` 把当前下载丢给 DownX。
>
> `GET /state` 里每个任务带 `segments`（引擎动态分段的每一段 `{ from, to, current }`），扩展可据此显示分段进度。

## 通知与托盘

- **通知**：任务**完成 / 失败**时发 Windows **toast**（WinRT，best-effort）。**始终开启**，不提供开关。
  **点击通知正文（不是按钮）会打开/前置 TUI**——后台启动时把 `downx:` 协议注册到**无控制台的 GUI 启动器** `downx.exe`（仅编译版）：已有 TUI 就前置，没有才启动。若 TUI 已开着，则**只把它前置**，不再开第二个，且**全程不闪终端**。
- **托盘图标**：后台在系统托盘放一个图标——悬停显示「进行中 N / 共 M」，右键菜单 **打开 DownX / 打开下载目录 / 退出**，双击也可打开界面。后台退出后托盘自动消失。**始终开启**，不提供开关。

## 构建

```bash
# 一键：桥接(Rust cdylib) → 控制台程序(Bun) → 单文件启动器(Rust GUI)
bun run compile
```

（等价于依次 `build:bridge` / `build:tui` / `build:launcher`；`build:bridge` 依赖 `../DownloadCode`。）

产物：**单个 `downx.exe`**。

- **`downx.exe`** 是 **GUI 子系统**（**双击不分配控制台 → 零闪**，约 110MB）：抢命名互斥体 → 已有 TUI 就**前置**它，没有才用 `CREATE_NEW_CONSOLE` 拉起控制台程序；`add` / `state` / `daemon` 会附着到父控制台再转发（终端里照样有输出）。
- 它**内嵌**了真正的控制台程序（Bun + 桥接 DLL），首次运行释放到 `%LOCALAPPDATA%\DownX\downx-console.exe`，之后直接复用。**分发只要 `downx.exe` 一个文件**（`downx-console.exe` 是构建中间产物）。

> 为什么这样做：控制台程序双击时，Windows 会在代码运行**之前**就分配一个控制台窗口（必然闪一下）；GUI 子系统不会。这样才能"点 exe 置顶已有窗口、不闪空终端"。（参考 [OpenDownloader](https://github.com/moXue-o/OpenDownloader) 的做法：主程序走 GUI 子系统，需要时才要控制台。）

## 目录

| 路径 | 作用 |
| --- | --- |
| `bridge/` | Rust 桥接层（DownloadCore → 轮询式 C ABI） |
| `launcher/` | Rust **GUI 启动器**（单文件入口：内嵌控制台程序 + 单实例 + 前置） |
| `chrome-extension/` | Chrome 扩展（MV3：右键菜单 / 拦截下载（默认开）/ popup） |
| `src/win32.ts` | 少量 Win32 调用（命名互斥体 / 前置窗口） |
| `src/engine.ts` | 加载内嵌 DLL、FFI 封装 |
| `src/daemon.ts` | 后台服务（任务 + 持久化 + 通知 + HTTP API） |
| `src/client.ts` | 连后台的 HTTP 客户端 |
| `src/settings.ts` | 用户设置（读写 + 校验） |
| `src/tui.ts` | OpenTUI 前端 |
| `src/theme.ts` | 配色与对齐工具 |
| `src/index.ts` | 入口分发 |
