// 用户设置：持久化到 %LOCALAPPDATA%\DownX\settings.json。
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { SETTINGS_FILE, DEFAULT_DOWNLOAD_DIR } from "./paths";

export interface Settings {
  /** 新任务的默认下载目录 */
  downloadDir: string;
  /** 每个任务的并发连接数（=分段数） */
  threads: number;
  /** 同时下载的任务数 */
  maxConcurrent: number;
  /** 开机自启动（登录时在后台静默启动） */
  autoStart: boolean;
  /** 实验性·超限模式：下载时把其他应用的网速压到极低（需要管理员） */
  turbo: boolean;
  /** 代理：http://[user:pass@]host:port 或 socks5://...；空 = 直连 */
  proxy: string;
  /** User-Agent；空 = 用引擎默认 */
  userAgent: string;
  /** 全局限速（KB/s），0 = 不限 */
  maxSpeedKB: number;
  /** 分块大小（MiB） */
  minPartMiB: number;
  /** 每段最大重试次数 */
  maxRetries: number;
  /** 空闲超时（秒） */
  idleTimeoutSecs: number;
}

/** 可选项（设置页里的"chips"）。 */
export const THREAD_OPTIONS = [8, 16, 32];
export const CONCURRENT_OPTIONS = [1, 2, 3, 5, 8];
export const SPEED_OPTIONS = [0, 512, 1024, 2048, 5120];
export const PART_OPTIONS = [1, 2, 4, 8];
export const RETRY_OPTIONS = [3, 5, 10, 20];
export const TIMEOUT_OPTIONS = [10, 15, 30, 60];

export const DEFAULT_SETTINGS: Settings = {
  downloadDir: DEFAULT_DOWNLOAD_DIR,
  threads: 16,
  maxConcurrent: 3,
  autoStart: false,
  turbo: false,
  proxy: "",
  userAgent: "",
  maxSpeedKB: 0,
  minPartMiB: 1,
  maxRetries: 10,
  idleTimeoutSecs: 15,
};

/** 把明显不合理的值拉回可用范围。 */
export function normalizeSettings(s: Settings): Settings {
  const num = (v: unknown, lo: number, hi: number, def: number) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
  };
  return {
    downloadDir:
      typeof s.downloadDir === "string" && s.downloadDir.trim()
        ? s.downloadDir.trim()
        : DEFAULT_SETTINGS.downloadDir,
    threads: num(s.threads, 1, 64, DEFAULT_SETTINGS.threads),
    maxConcurrent: num(s.maxConcurrent, 1, 32, DEFAULT_SETTINGS.maxConcurrent),
    autoStart: s.autoStart === true,
    turbo: s.turbo === true,
    proxy: typeof s.proxy === "string" ? s.proxy.trim() : "",
    userAgent: typeof s.userAgent === "string" ? s.userAgent.trim() : "",
    maxSpeedKB: num(s.maxSpeedKB, 0, 10_000_000, DEFAULT_SETTINGS.maxSpeedKB),
    minPartMiB: num(s.minPartMiB, 1, 1024, DEFAULT_SETTINGS.minPartMiB),
    maxRetries: num(s.maxRetries, 0, 1000, DEFAULT_SETTINGS.maxRetries),
    idleTimeoutSecs: num(s.idleTimeoutSecs, 1, 600, DEFAULT_SETTINGS.idleTimeoutSecs),
  };
}

export function loadSettings(): Settings {
  try {
    if (existsSync(SETTINGS_FILE)) {
      const j = JSON.parse(readFileSync(SETTINGS_FILE, "utf8")) as Partial<Settings>;
      return normalizeSettings({ ...DEFAULT_SETTINGS, ...j });
    }
  } catch {}
  return { ...DEFAULT_SETTINGS };
}

export function saveSettings(s: Settings): Settings {
  const n = normalizeSettings(s);
  try {
    writeFileSync(SETTINGS_FILE, JSON.stringify(n, null, 2));
  } catch {}
  return n;
}
