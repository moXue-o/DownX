import { join } from "node:path";
import { homedir } from "node:os";
import { existsSync, mkdirSync } from "node:fs";

/** 运行期根目录：%LOCALAPPDATA%\DownX */
export const ROOT = join(process.env.LOCALAPPDATA ?? homedir(), "DownX");

export function ensureDir(p: string): string {
  if (!existsSync(p)) mkdirSync(p, { recursive: true });
  return p;
}

ensureDir(ROOT);

/** 后台进程信息（端口 + pid）。 */
export const DAEMON_FILE = join(ROOT, "daemon.json");
/** 任务持久化。 */
export const TASKS_FILE = join(ROOT, "tasks.json");
/** 用户设置。 */
export const SETTINGS_FILE = join(ROOT, "settings.json");
/** 当前 TUI 的 pid（用于"已有 TUI 就前置它"）。 */
export const TUI_FILE = join(ROOT, "tui.json");
/** 释放内嵌原生库的缓存目录。 */
export const CACHE_DIR = ensureDir(join(ROOT, "cache"));
/** 后台进程日志。 */
export const DAEMON_LOG = join(ROOT, "daemon.log");
/** 默认下载目录。 */
export const DEFAULT_DOWNLOAD_DIR = ensureDir(join(ROOT, "downloads"));
