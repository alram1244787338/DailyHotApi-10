/**
 * 缓存键构建工具
 *
 * 为 GET / POST 请求生成确定性的缓存键，避免因参数差异导致缓存串台。
 * 核心原则：相同请求参数 → 相同 key；不同请求参数 → 不同 key。
 */

/**
 * 将对象按 key 字典序递归序列化，确保相同内容产生相同字符串。
 * - 忽略 undefined 值（与 JSON.stringify 行为一致）
 * - null、number、string、boolean 直接转字符串
 * - Buffer 转为 "Buffer:<length>:<hex-slice>" 以区分不同二进制内容
 * - 数组按索引顺序序列化
 * - 对象按 key 排序序列化
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Buffer.isBuffer(value)) {
    // 取前 128 字节做摘要，足够区分不同 body
    return `Buffer:${value.length}:${value.subarray(0, 128).toString("hex")}`;
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => stableStringify(v)).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const parts: string[] = [];
    for (const key of keys) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      parts.push(`${key}=${stableStringify(v)}`);
    }
    return "{" + parts.join("&") + "}";
  }
  return String(value);
}

/**
 * 归一化 URL：
 * - 分离 base + query
 * - 对 query 参数按 key 排序，保证同一 URL 不同拼法得到相同 key
 */
export function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    const params = Array.from(u.searchParams.entries());
    if (params.length === 0) {
      // 去掉尾部多余的 ? 号
      return u.origin + u.pathname;
    }
    params.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    const sorted = params.map(([k, v]) => `${k}=${v}`).join("&");
    return `${u.origin}${u.pathname}?${sorted}`;
  } catch {
    // 非标准 URL（极少数场景）直接返回原串
    return url;
  }
}

export interface BuildGetKeyOptions {
  url: string;
  params?: Record<string, string | number>;
  /** 额外标识，如 "json" / "rss"，用于区分同一 URL 的不同响应形态 */
  tag?: string;
}

/**
 * 构建 GET 请求缓存键。
 * 组成：归一化 URL + 独立 params + 可选 tag
 */
export function buildGetCacheKey(options: BuildGetKeyOptions): string {
  const { url, params, tag } = options;
  let key = `GET:${normalizeUrl(url)}`;
  if (params && Object.keys(params).length > 0) {
    key += `:params:${stableStringify(params)}`;
  }
  if (tag) {
    key += `:${tag}`;
  }
  return key;
}

export interface BuildPostKeyOptions {
  url: string;
  body?: string | object | Buffer | undefined;
  tag?: string;
}

/**
 * 构建 POST 请求缓存键。
 * 组成：归一化 URL + body 稳定序列化 + 可选 tag
 */
export function buildPostCacheKey(options: BuildPostKeyOptions): string {
  const { url, body, tag } = options;
  let key = `POST:${normalizeUrl(url)}`;
  if (body !== undefined && body !== null && body !== "") {
    key += `:body:${stableStringify(body)}`;
  }
  if (tag) {
    key += `:${tag}`;
  }
  return key;
}
