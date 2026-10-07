// 少量 Win32 调用（bun:ffi）：命名互斥体做"单实例"，以及按标题前置窗口。
import { dlopen, FFIType, ptr } from "bun:ffi";

const isWin = process.platform === "win32";
const ERROR_ALREADY_EXISTS = 183;

const k32 = isWin
  ? dlopen("kernel32.dll", {
      CreateMutexW: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr], returns: FFIType.ptr },
      GetLastError: { args: [], returns: FFIType.u32 },
      SetConsoleTitleW: { args: [FFIType.ptr], returns: FFIType.i32 },
      GetConsoleWindow: { args: [], returns: FFIType.ptr },
      FreeConsole: { args: [], returns: FFIType.i32 },
    })
  : null;

const u32 = isWin
  ? dlopen("user32.dll", {
      FindWindowW: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
      ShowWindow: { args: [FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
      SetForegroundWindow: { args: [FFIType.ptr], returns: FFIType.i32 },
    })
  : null;

const wstr = (s: string) => Buffer.from(s + "\0", "utf16le");

/**
 * 申请系统命名互斥体。已在运行 → 返回 false（句柄故意不关，进程退出时系统自动释放）。
 * 非 Windows 环境恒返回 true。
 */
export function claimSingleInstance(name: string): boolean {
  if (!k32) return true;
  try {
    const h = k32.symbols.CreateMutexW(null, 0, ptr(wstr(name)));
    const err = k32.symbols.GetLastError();
    if (!h || err === ERROR_ALREADY_EXISTS) return false;
    return true;
  } catch {
    return true; // FFI 出问题就别拦，放行
  }
}

/** 设置控制台窗口标题（便于由标题定位窗口）。 */
export function setConsoleTitle(title: string): void {
  try {
    k32?.symbols.SetConsoleTitleW(ptr(wstr(title)));
  } catch {}
}

/** 按标题找顶层窗口并前置；找到返回 true。 */
export function focusWindowByTitle(title: string): boolean {
  if (!u32) return false;
  try {
    const h = u32.symbols.FindWindowW(null, ptr(wstr(title)));
    if (!h) return false;
    u32.symbols.ShowWindow(h, 9); // SW_RESTORE
    u32.symbols.SetForegroundWindow(h);
    return true;
  } catch {
    return false;
  }
}

/** 立刻隐藏并脱离自己刚被系统分配的控制台窗口（用于"第二个实例"，避免空终端一闪）。 */
export function hideOwnConsole(): void {
  try {
    const h = k32?.symbols.GetConsoleWindow();
    if (h) u32?.symbols.ShowWindow(h, 0); // SW_HIDE
    k32?.symbols.FreeConsole();
  } catch {}
}
