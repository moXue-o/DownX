// 主题与显示宽度工具（配色沿用 opencode 强调色 + 已定的浅底）。
export const T = {
  bg: "#1a1a1a",
  panel: "#212121",
  input: "#1a1a1a",
  element: "#2b2b2b",
  selected: "#2b2b2b",
  borderSubtle: "#333333",
  border: "#3d3d3d",
  text: "#e8e8e8",
  muted: "#8c8c8c",
  primary: "#fab283",
  secondary: "#5c9cf5",
  accent: "#9d7cd8",
  success: "#7fd88f",
  warning: "#f5a742",
  error: "#e06c75",
  info: "#56b6c2",
};

function cw(cp: number): number {
  if (cp < 0x20) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}
export function dw(s: string): number {
  let w = 0;
  for (const ch of s) w += cw(ch.codePointAt(0)!);
  return w;
}
export function padR(s: string, w: number): string {
  const d = dw(s);
  return d >= w ? s : s + " ".repeat(w - d);
}
export function padL(s: string, w: number): string {
  const d = dw(s);
  return d >= w ? s : " ".repeat(w - d) + s;
}
export function truncR(s: string, w: number): string {
  if (dw(s) <= w) return s;
  let out = "";
  let d = 0;
  for (const ch of s) {
    const c = cw(ch.codePointAt(0)!);
    if (d + c > w - 1) break;
    out += ch;
    d += c;
  }
  return out + "…";
}
export function humanSize(n: number): string {
  if (!n) return "—";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}
