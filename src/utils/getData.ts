import type { Get, Post } from "../types.js";
import { config } from "../config.js";
import { getCache, setCache, delCache } from "./cache.js";
import logger from "./logger.js";
import md5 from "md5";
import axios from "axios";

// 基础配置
const request = axios.create({
  // 请求超时设置
  timeout: config.REQUEST_TIMEOUT,
  withCredentials: true,
});

// 请求拦截
request.interceptors.request.use(
  (request) => {
    if (!request.params) request.params = {};
    // 发送请求
    return request;
  },
  (error) => {
    logger.error("❌ [ERROR] request failed");
    return Promise.reject(error);
  },
);

// 响应拦截
request.interceptors.response.use(
  (response) => {
    return response;
  },
  (error) => {
    // 继续传递错误
    return Promise.reject(error);
  },
);

export interface RequestResult<T = unknown> {
  fromCache: boolean;
  updateTime: string;
  data: T;
}

/**
 * 稳定序列化：递归地对对象按 key 排序后序列化。
 * 保证“语义相同、仅书写顺序不同”的参数 / 请求体得到完全一致的字符串，
 * 从而让缓存键只取决于真正会影响响应结果的内容，而不受属性顺序影响。
 */
const stableStringify = (value: unknown): string => {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  // Buffer（如 arraybuffer 请求体）按内容摘要，避免把整段二进制拼进键里
  if (Buffer.isBuffer(value)) return `buf:${md5(value.toString("base64"))}`;
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",")}}`;
};

export interface CacheKeyOptions {
  method: "GET" | "POST";
  url: string;
  params?: Record<string, string | number>;
  body?: string | object | Buffer;
  responseType?: string;
  originaInfo?: boolean;
  /** 调用方显式指定的稳定逻辑键，详见 Get/Post 类型上的说明 */
  cacheKey?: string;
}

/**
 * 生成缓存键。
 *
 * 设计要点：
 * 1. 把所有“会影响响应结果”的因素都纳入键：请求方法、url、查询参数（GET）、
 *    请求体（POST）、responseType（json / arraybuffer 等返回类型不同，缓存内容也不同）、
 *    以及 originaInfo（决定缓存的是完整响应还是仅 data，结构不同）。
 *    这样分页、关键词、榜单子分类、JSON / RSS 等差异都会自然体现在 params / body / url 上，
 *    不会再出现“不同条件请求命中同一缓存、互相串数据”的问题。
 * 2. GET 与 POST 使用同一套规则，并以方法名前缀区分，避免同 url 的 GET / POST 撞键。
 * 3. get / set / del 全部使用本函数生成的同一个键，保证强制刷新（noCache）能删到正确缓存。
 * 4. 键格式为 `METHOD:url:hash`，保留可读的 method + url 前缀，方便排查线上“串台”问题。
 *
 * 当请求中带有时间戳 / 签名等“每次不同但不影响响应内容”的易变参数时，
 * 调用方可传入 `cacheKey` 直接指定稳定逻辑键，避免缓存永远命中不了。
 */
export const generateCacheKey = (options: CacheKeyOptions): string => {
  const { method, url, params, body, responseType, originaInfo, cacheKey } = options;
  // 显式逻辑键：调用方自行保证它能区分所有会影响响应的变量
  if (cacheKey) return `${method}:${cacheKey}`;
  const variant = stableStringify({
    params: params ?? null,
    body: body ?? null,
    responseType: responseType ?? null,
    originaInfo: originaInfo ?? false,
  });
  return `${method}:${url}:${md5(variant)}`;
};

// GET
export const get = async <T = unknown>(options: Get): Promise<RequestResult<T>> => {
  const {
    url,
    headers,
    params,
    noCache,
    ttl = config.CACHE_TTL,
    originaInfo = false,
    responseType = "json",
    cacheKey,
  } = options;
  // 计算细粒度缓存键，读 / 写 / 删都用它
  const key = generateCacheKey({ method: "GET", url, params, responseType, originaInfo, cacheKey });
  logger.info(`🌐 [GET] ${url} → cacheKey: ${key}`);
  try {
    // 检查缓存
    if (noCache) {
      // 强制刷新：先删掉该请求对应的精确缓存，下面重新请求后再写回最新数据
      await delCache(key);
    } else {
      const cachedData = await getCache(key);
      if (cachedData) {
        logger.info(`💾 [CACHE] hit GET cacheKey: ${key}`);
        return {
          fromCache: true,
          updateTime: cachedData.updateTime,
          data: cachedData.data as T,
        };
      }
      logger.info(`🚫 [CACHE] miss GET cacheKey: ${key}`);
    }
    // 缓存不存在时请求接口
    const response = await request.get(url, { headers, params, responseType });
    const responseData = response?.data || response;
    // 存储新获取的数据到缓存
    const updateTime = new Date().toISOString();
    const data = originaInfo ? response : responseData;
    await setCache(key, { data, updateTime }, ttl);
    // 返回数据
    logger.info(`✅ [${response?.status}] GET ${url} stored at cacheKey: ${key}`);
    return { fromCache: false, updateTime, data: data as T };
  } catch (error) {
    logger.error(`❌ [ERROR] GET ${url} failed (cacheKey: ${key})`);
    throw error;
  }
};

// POST
export const post = async <T = unknown>(options: Post): Promise<RequestResult<T>> => {
  const {
    url,
    headers,
    body,
    noCache,
    ttl = config.CACHE_TTL,
    originaInfo = false,
    cacheKey,
  } = options;
  // 计算细粒度缓存键，读 / 写 / 删都用它（请求体纳入键，避免同 url 不同 body 串数据）
  const key = generateCacheKey({ method: "POST", url, body, originaInfo, cacheKey });
  logger.info(`🌐 [POST] ${url} → cacheKey: ${key}`);
  try {
    // 检查缓存
    if (noCache) {
      // 强制刷新：先删掉该请求对应的精确缓存，下面重新请求后再写回最新数据
      await delCache(key);
    } else {
      const cachedData = await getCache(key);
      if (cachedData) {
        logger.info(`💾 [CACHE] hit POST cacheKey: ${key}`);
        return { fromCache: true, updateTime: cachedData.updateTime, data: cachedData.data as T };
      }
      logger.info(`🚫 [CACHE] miss POST cacheKey: ${key}`);
    }
    // 缓存不存在时请求接口
    const response = await request.post(url, body, { headers });
    const responseData = response?.data || response;
    // 存储新获取的数据到缓存
    const updateTime = new Date().toISOString();
    const data = originaInfo ? response : responseData;
    // 与 GET 行为保持一致：强制刷新后同样写回最新数据，使后续普通请求能命中新缓存
    await setCache(key, { data, updateTime }, ttl);
    // 返回数据
    logger.info(`✅ [${response?.status}] POST ${url} stored at cacheKey: ${key}`);
    return { fromCache: false, updateTime, data: data as T };
  } catch (error) {
    logger.error(`❌ [ERROR] POST ${url} failed (cacheKey: ${key})`);
    throw error;
  }
};
