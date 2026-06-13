import { config } from "../config.js";
import { stringify, parse } from "flatted";
import logger from "./logger.js";
import NodeCache from "node-cache";
import Redis from "ioredis";

interface CacheData {
  updateTime: string;
  data: unknown;
}

// init NodeCache
const cache = new NodeCache({
  // 缓存过期时间（ 秒 ）
  stdTTL: config.CACHE_TTL,
  // 定期检查过期缓存（ 秒 ）
  checkperiod: 600,
  // 克隆变量
  useClones: false,
  // 最大键值对
  maxKeys: 100,
});

// init Redis client
const redis = new Redis({
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  password: config.REDIS_PASSWORD,
  db: config.REDIS_DB,
  maxRetriesPerRequest: 5,
  // 重试策略：最小延迟 50ms，最大延迟 2s
  retryStrategy: (times) => Math.min(times * 50, 2000),
  // 仅在第一次建立连接
  lazyConnect: true,
});

// Redis 是否可用
let isRedisAvailable: boolean = false;
let isRedisTried: boolean = false;

// Redis 连接状态
const ensureRedisConnection = async () => {
  if (isRedisTried) return;
  try {
    if (redis.status !== "ready" && redis.status !== "connecting") await redis.connect();
    isRedisAvailable = true;
    isRedisTried = true;
    logger.info("📦 [Redis] connected successfully.");
  } catch (error) {
    isRedisAvailable = false;
    isRedisTried = true;
    logger.error(
      `📦 [Redis] connection failed: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
};

// Redis 事件监听
redis.on("error", (err) => {
  if (!isRedisTried) {
    isRedisAvailable = false;
    isRedisTried = true;
    logger.error(
      `📦 [Redis] connection failed: ${err instanceof Error ? err.message : "Unknown error"}`,
    );
  }
});

// NodeCache 事件监听
cache.on("expired", (key) => {
  logger.info(`⏳ [NodeCache] Key "${key}" has expired.`);
});

cache.on("del", (key) => {
  logger.info(`🗑️ [NodeCache] Key "${key}" has been deleted.`);
});

/**
 * 从缓存中获取数据
 * @param key 缓存键
 * @returns 缓存数据
 */
export const getCache = async (key: string): Promise<CacheData | undefined> => {
  await ensureRedisConnection();
  if (isRedisAvailable) {
    try {
      const redisResult = await redis.get(key);
      if (redisResult) return parse(redisResult);
    } catch (error) {
      logger.error(
        `📦 [Redis] get error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }
  return cache.get(key);
};

/**
 * 将数据写入缓存
 * @param key 缓存键
 * @param value 缓存值
 * @param ttl 缓存过期时间（ 秒 ）
 * @returns 是否写入成功
 */
export const setCache = async (
  key: string,
  value: CacheData,
  ttl: number = config.CACHE_TTL,
): Promise<boolean> => {
  // 尝试写入 Redis
  if (isRedisAvailable && !Buffer.isBuffer(value?.data)) {
    try {
      await redis.set(key, stringify(value), "EX", ttl);
      if (logger) logger.info(`💾 [REDIS] ${key} has been cached`);
    } catch (error) {
      logger.error(
        `📦 [Redis] set error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }
  const success = cache.set(key, value, ttl);
  if (logger) logger.info(`💾 [NodeCache] ${key} has been cached`);
  return success;
};

/**
 * 从缓存中删除数据
 *
 * Redis 与 NodeCache 使用同一个 key 删除，保证两层行为一致。
 * 注意：“键本来就不存在”属于正常情况（例如强制刷新一个还没缓存过的请求），
 * 不应被当作删除失败，因此返回值只反映“删除过程是否出错”，而不是“是否真的删到了东西”。
 *
 * @param key 缓存键
 * @returns 删除过程是否未出错
 */
export const delCache = async (key: string): Promise<boolean> => {
  let redisSuccess = true;
  // 与 get/set 保持一致：先确保 Redis 连接状态已确定
  await ensureRedisConnection();
  if (isRedisAvailable) {
    try {
      const redisRemoved = await redis.del(key);
      logger.info(`🗑️ [REDIS] deleted key: ${key} (removed ${redisRemoved})`);
    } catch (error) {
      redisSuccess = false;
      logger.error(
        `📦 [Redis] del error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }
  // 删除 NodeCache（同一个 key）
  const nodeCacheRemoved = cache.del(key);
  logger.info(`🗑️ [NodeCache] deleted key: ${key} (removed ${nodeCacheRemoved})`);
  return redisSuccess;
};

/**
 * 关闭缓存连接并释放资源。
 *
 * NodeCache 的过期检查定时器与 Redis 的后台重连定时器都会一直占用事件循环，
 * 进程（或测试）若想正常退出需要主动关闭。主要用于进程优雅退出与测试收尾。
 */
export const disconnectCache = (): void => {
  try {
    // 立即断开并停止重连
    redis.disconnect();
  } catch {
    // 关闭异常无需处理
  }
  // 停止 NodeCache 的定时检查并清空
  cache.close();
};
