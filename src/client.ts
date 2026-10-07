// 与后台服务通信的本地 HTTP 客户端。
import { DAEMON_FILE } from "./paths";
import type { Settings } from "./settings";
import { existsSync, readFileSync } from "node:fs";

export interface TaskInfo {
  uid: number;
  url: string;
  path: string;
  name: string;
  dir: string;
  paused: boolean;
  state: number; // 0 init 1 running 2 done 3 failed 4 canceled
  downloaded: number;
  total: number;
  speed: number;
  parts: number;
  size: number;
  err: string;
  segments: { from: number; to: number; current: number }[];
  addedAt: number;
  startedAt: number;
  finishedAt: number;
}

export class Client {
  constructor(private port: number) {}

  private url(p: string) {
    return `http://127.0.0.1:${this.port}${p}`;
  }

  static async connect(): Promise<Client | null> {
    if (!existsSync(DAEMON_FILE)) return null;
    try {
      const j = JSON.parse(readFileSync(DAEMON_FILE, "utf8")) as { port: number };
      const r = await fetch(`http://127.0.0.1:${j.port}/ping`).catch(() => null);
      if (r && r.ok) return new Client(j.port);
    } catch {}
    return null;
  }

  get daemonPort() {
    return this.port;
  }

  async state(): Promise<{ version: string; tasks: TaskInfo[] }> {
    const r = await fetch(this.url("/state"));
    return r.json() as any;
  }
  async settings(): Promise<Settings> {
    const r = await fetch(this.url("/settings"));
    return r.json() as any;
  }
  async saveSettings(p: Partial<Settings>): Promise<Settings> {
    const r = await fetch(this.url("/settings"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(p),
    });
    return r.json() as any;
  }
  /** 超限模式：on=true 会先申请管理员，成功才返回 ok。 */
  async turbo(on: boolean): Promise<{ ok: boolean; settings?: Settings; error?: string }> {
    const r = await fetch(this.url("/turbo"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ on }),
    });
    return r.json() as any;
  }
  async add(url: string, dir?: string, name?: string) {
    const r = await fetch(this.url("/add"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, dir, name }),
    });
    return r.json() as Promise<{ uid?: number; error?: string }>;
  }
  async post(path: string, body: unknown) {
    const r = await fetch(this.url(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return r.json() as Promise<{ ok?: boolean; error?: string }>;
  }
}
