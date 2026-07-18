import { lookup } from "node:dns/promises";

export const MAX_RESOURCE_BYTES = 5 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set(["pdf", "txt", "md", "markdown"]);
const ALLOWED_MIME = new Set([
  "application/pdf",
  "text/plain",
  "text/markdown",
  "text/x-markdown",
]);

export function validateUpload(input: {
  name: string;
  type: string;
  size: number;
}): string | null {
  const extension = input.name.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED_EXTENSIONS.has(extension)) return "仅支持 PDF、TXT、MD 文件";
  // 浏览器常给出空 MIME；有值时才严格校验，空值按扩展名放行
  if (input.type && !ALLOWED_MIME.has(input.type)) return "文件 MIME 类型不受支持";
  if (!Number.isFinite(Number(input.size)) || Number(input.size) <= 0) return "文件为空";
  if (Number(input.size) > MAX_RESOURCE_BYTES) return "单文件不能超过 5MB";
  return null;
}

export function isPrivateIp(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized.startsWith("::ffff:")) {
    return isPrivateIp(normalized.slice("::ffff:".length));
  }
  if (
    normalized === "::1" ||
    normalized === "::" ||
    normalized.startsWith("fe80:") ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd")
  ) {
    return true;
  }
  const parts = normalized.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

export async function validatePublicUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    console.error("链接解析失败", error);
    throw new Error("链接格式无效");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("链接仅允许 http/https");
  }
  if (url.username || url.password) {
    throw new Error("链接不能包含账号凭据");
  }
  if (
    url.port &&
    !(
      (url.protocol === "http:" && url.port === "80") ||
      (url.protocol === "https:" && url.port === "443")
    )
  ) {
    throw new Error("链接端口不受支持");
  }
  const hostname = url.hostname.toLowerCase();
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    throw new Error("不允许访问本地地址");
  }
  try {
    const addresses = await lookup(hostname, { all: true });
    if (!addresses.length || addresses.some((item) => isPrivateIp(item.address))) {
      throw new Error("不允许访问私有网络地址");
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("私有网络")) throw error;
    console.error("链接 DNS 校验失败", error);
    throw new Error("链接域名无法安全解析");
  }
  return url;
}

export function normalizeIntervals(input: unknown): number[] {
  if (!Array.isArray(input)) return [3, 7, 14, 30];
  const values = input
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0 && value <= 365);
  return [...new Set(values)].sort((a, b) => a - b).slice(0, 12);
}

export function nextReviewDate(
  current: Date,
  intervals: number[],
  index: number,
  result: "remember" | "fuzzy" | "forgot",
): { dueAt: Date; intervalIndex: number } {
  const safe = normalizeIntervals(intervals);
  const maxIndex = Math.max(0, safe.length - 1);
  const nextIndex =
    result === "remember"
      ? Math.min(index + 1, maxIndex)
      : result === "fuzzy"
        ? Math.max(0, index)
        : 0;
  const baseDays = safe[nextIndex] ?? 3;
  const days =
    result === "remember" ? baseDays : result === "fuzzy" ? Math.max(1, Math.ceil(baseDays / 2)) : 1;
  const dueAt = new Date(current);
  dueAt.setDate(dueAt.getDate() + days);
  return { dueAt, intervalIndex: nextIndex };
}
