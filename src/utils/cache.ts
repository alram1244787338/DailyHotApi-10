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
  maxKeys: 1000,
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
 * 从缓存中获取数据（Redis 优先，NodeCache 兜底）
 * 两层使用完全相同的 key（由调用方通过 cacheKey 工具构建）
 * @param key 缓存键（已包含请求参数的复合键）
 * @returns 缓存数据
 */
export const getCache = async (key: string): Promise<CacheData | undefined> => {
  await ensureRedisConnection();
  if (isRedisAvailable) {
    try {
      const redisResult = await redis.get(key);
      if (redisResult) {
        logger.debug?.(`💾 [Redis] HIT key: ${key}`);
        return parse(redisResult);
      }
    } catch (error) {
      logger.error(
        `📦 [Redis] get error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }
  // NodeCache 兜底（与 Redis 使用同一 key）
  const nodeResult = cache.get(key) as CacheData | undefined;
  if (nodeResult) {
    logger.debug?.(`💾 [NodeCache] HIT key: ${key}`);
  }
  return nodeResult;
};

/**
 * 将数据写入缓存（Redis + NodeCache 双写，使用同一 key）
 * @param key 缓存键（已包含请求参数的复合键）
 * @param value 缓存值
 * @param ttl 缓存过期时间（ 秒 ）
 * @returns 是否写入成功
 */
export const setCache = async (
  key: string,
  value: CacheData,
  ttl: number = config.CACHE_TTL,
): Promise<boolean> => {
  // 尝试写入 Redis（跳过 Buffer 类型，Redis 序列化不支持）
  if (isRedisAvailable && !Buffer.isBuffer(value?.data)) {
    try {
      await redis.set(key, stringify(value), "EX", ttl);
      logger.info(`💾 [Redis] SET key: ${key} (ttl=${ttl}s)`);
    } catch (error) {
      logger.error(
        `📦 [Redis] set error: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
  }
  // NodeCache 始终写入（保持两层一致）
  const success = cache.set(key, value, ttl);
  logger.info(`💾 [NodeCache] SET key: ${key} (ttl=${ttl}s)`);
  return success;
};

/**
 * 从缓存中删除数据（Redis + NodeCache 双删，使用同一 key）
 * @param key 缓存键（已包含请求参数的复合键）
 * @returns 是否删除成功
 */
export const delCache = async (key: string): Promise<boolean> => {
  let redisSuccess = true;
  try {
    const deleted = await redis.del(key);
    if (deleted > 0) {
      logger.info(`🗑️ [Redis] DEL key: ${key}`);
    }
  } catch (error) {
    redisSuccess = false;
    logger.error(
      `📦 [Redis] del error: ${error instanceof Error ? error.message : "Unknown error"}`,
    );
  }
  // 尝试删除 NodeCache
  const nodeCacheSuccess = cache.del(key) > 0;
  if (nodeCacheSuccess) {
    logger.info(`🗑️ [NodeCache] DEL key: ${key}`);
  }
  return redisSuccess && nodeCacheSuccess;
};

/**
 * 断开 Redis 连接（仅供测试清理使用）
 */
export const disconnectRedis = async (): Promise<void> => {
  try {
    redis.disconnect();
  } catch {
    // 忽略断开连接时的错误
  }
};
