// 引擎桥接：加载内嵌的 downx_bridge.dll，暴露轮询式接口。
import { dlopen, FFIType, ptr } from "bun:ffi";
import dllAsset from "../bridge/target/release/downx_bridge.dll" with { type: "file" };
import { join } from "node:path";
import { CACHE_DIR } from "./paths";

/** 把内嵌（或磁盘上）的 DLL 释放到缓存目录，返回可被 dlopen 的真实路径。 */
async function materialize(): Promise<string> {
  const src = typeof dllAsset === "string" ? dllAsset : String(dllAsset);
  const target = join(CACHE_DIR, `downx_bridge_${process.pid}.dll`);
  const bytes = await Bun.file(src).arrayBuffer();
  await Bun.write(target, bytes);
  return target;
}

const dllPath = await materialize();

export const lib = dlopen(dllPath, {
  downx_start: { args: [FFIType.cstring, FFIType.cstring, FFIType.cstring], returns: FFIType.i64 },
  downx_poll: { args: [FFIType.i64, FFIType.ptr], returns: FFIType.i64 },
  downx_pause: { args: [FFIType.i64, FFIType.i64], returns: FFIType.void },
  downx_cancel: { args: [FFIType.i64], returns: FFIType.void },
  downx_remove: { args: [FFIType.i64], returns: FFIType.void },
  downx_error: { args: [FFIType.i64, FFIType.ptr, FFIType.i64], returns: FFIType.i64 },
  downx_parts_count: { args: [FFIType.i64], returns: FFIType.i64 },
  downx_parts_get: { args: [FFIType.i64, FFIType.i64, FFIType.ptr], returns: FFIType.i64 },
});

export const STATE = { INIT: 0, RUNNING: 1, DONE: 2, FAILED: 3, CANCELED: 4 } as const;

export interface Snap {
  state: number;
  downloaded: number;
  total: number;
  speed: number;
  parts: number;
  size: number;
}

const _out = new BigInt64Array(6);
const _part = new BigInt64Array(3);

export interface Segment {
  from: number;
  to: number;
  current: number;
}

/** 传给引擎的任务配置（缺省字段用引擎默认值）。 */
export interface TaskConfig {
  threads?: number;
  user_agent?: string;
  max_speed?: number;
  max_retries?: number;
  min_part_size?: number;
  idle_timeout_secs?: number;
  proxy?: string;
}

export const engine = {
  start(url: string, path: string, cfg: TaskConfig = {}): number {
    const u = Buffer.from(url + "\0");
    const p = Buffer.from(path + "\0");
    const c = Buffer.from(JSON.stringify(cfg) + "\0");
    const id = lib.symbols.downx_start(u, p, c);
    return Number(id);
  },
  poll(id: number): Snap | null {
    const st = Number(lib.symbols.downx_poll(id, ptr(_out)));
    if (st === 0) return null;
    return {
      state: st,
      downloaded: Number(_out[1]),
      total: Number(_out[2]),
      speed: Number(_out[3]),
      parts: Number(_out[4]),
      size: Number(_out[5]),
    };
  },
  pause(id: number, paused: boolean) {
    lib.symbols.downx_pause(id, paused ? 1 : 0);
  },
  cancel(id: number) {
    lib.symbols.downx_cancel(id);
  },
  remove(id: number) {
    lib.symbols.downx_remove(id);
  },
  error(id: number): string {
    const buf = Buffer.alloc(1024);
    const n = Number(lib.symbols.downx_error(id, ptr(buf), 1024));
    return buf.toString("utf8", 0, n);
  },
  /** 每个分段的进度（引擎动态分段，段数会变）。 */
  parts(id: number): Segment[] {
    const n = Number(lib.symbols.downx_parts_count(id));
    const out: Segment[] = [];
    for (let i = 0; i < n; i++) {
      if (Number(lib.symbols.downx_parts_get(id, i, ptr(_part))) !== 1) break;
      out.push({ from: Number(_part[0]), to: Number(_part[1]), current: Number(_part[2]) });
    }
    return out;
  },
};
