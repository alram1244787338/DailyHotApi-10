import { config } from "../config.js";
import { stringify, parse } from "flatted";
import logger from "./logger.js";
import NodeCache from "node-cache";
import Redis from "ioredis";

interface CacheData {
  updateTime: string;
  data: unknown;
}

// ── NodeCache ────────────────────────────────────────────────────────────────
const nodeCache = new NodeCache({
  stdTTL: config.CACHE_TTL,
  checkperiod: 600,
  useClones: false,
  maxKeys: 100,
});

nodeCache.on("expired", (key) => {
  logger.info(`⏳ [NodeCache] Key "${key}" has expired.`);
});

nodeCache.on("del", (key) => {
  logger.info(`🗑️ [NodeCache] Key "${key}" has been deleted.`);
});

// ── Redis ────────────────────────────────────────────────────────────────────
const redis = new Redis({
  host: config.REDIS_HOST,
  port: config.REDIS_PORT,
  password: config.REDIS_PASSWORD,
  db: config.REDIS_DB,
  maxRetriesPerRequest: 3,
  retryStrategy: (times) => Math.min(times * 50, 2000),
  lazyConnect: true,
  // 避免 ioredis 在 connect 失败时反复抛 unhandled error
  enableOfflineQueue: false,
});

/**
 * Redis 可用性状态机
 *
 * 状态流转:
 *   initial  ──connect()──▶ ready
 *   ready    ──error/close──▶ disconnected  ──retryTimer──▶ connecting ──▶ ready
 *   disconnected (重试失败) ──retryTimer──▶ connecting ──▶ disconnected
 *
 * retryIntervalMs: 断开后每隔多久尝试重连（默认 10 秒）
 */
type RedisState = "initial" | "ready" | "disconnected" | "connecting";

let redisState: RedisState = "initial";
let retryTimer: ReturnType<typeof setInterval> | null = null;
const RETRY_INTERVAL_MS = 10_000;

// ── 内部工具 ──────────────────────────────────────────────────────────────────

function setRedisState(next: RedisState, reason?: string) {
  const prev = redisState;
  if (prev === next) return;
  redisState = next;
  if (reason) {
    switch (next) {
      case "ready":
        logger.info(`📦 [Redis] ${prev === "initial" ? "首次连接成功" : "重连成功"} — ${reason}`);
        break;
      case "disconnected":
        logger.error(`📦 [Redis] ${prev === "initial" ? "首次连接失败" : "运行中断连"} — ${reason}`);
        break;
      case "connecting":
        logger.info(`📦 [Redis] 正在尝试重连 — ${reason}`);
        break;
    }
  }
}

/**
 * 启动定时重连（仅在 disconnected 状态时有效）
 */
function startRetryTimer() {
  if (retryTimer) return;
  retryTimer = setInterval(async () => {
    if (redisState !== "disconnected") {
      stopRetryTimer();
      return;
    }
    setRedisState("connecting", "定时重连");
    try {
      if (redis.status === "ready") {
        // 底层仍然就绪，直接同步状态
        setRedisState("ready", "定时重连检测到底层就绪");
        stopRetryTimer();
        return;
      }
      if (redis.status !== "connecting") {
        await redis.connect();
      }
      // connect() 成功后会触发 "connect" 事件，在事件里切到 ready
    } catch {
      setRedisState("disconnected", "定时重连失败");
    }
  }, RETRY_INTERVAL_MS);
}

function stopRetryTimer() {
  if (retryTimer) {
    clearInterval(retryTimer);
    retryTimer = null;
  }
}

// ── Redis 事件监听 ────────────────────────────────────────────────────────────

redis.on("connect", () => {
  setRedisState("ready", `status=${redis.status}`);
  stopRetryTimer();
});

redis.on("ready", () => {
  setRedisState("ready", "连接就绪");
  stopRetryTimer();
});

redis.on("close", () => {
  setRedisState("disconnected", "连接关闭");
  startRetryTimer();
});

redis.on("error", (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  // 仅在非 ready 状态下打 error，避免 ready 时的瞬态网络抖动刷屏
  if (redisState !== "ready") {
    setRedisState("disconnected", `error: ${msg}`);
  } else {
    // ready 状态下的单次错误，降级但保持重连
    logger.warn(`📦 [Redis] 运行中读写错误: ${msg}`);
    setRedisState("disconnected", `运行时错误: ${msg}`);
  }
  startRetryTimer();
});

// ── 统一入口：确保 Redis 可用 ─────────────────────────────────────────────────

/**
 * 尝试让 Redis 进入 ready 状态。
 * - initial: 首次调用 connect()
 * - ready: 直接返回 true
 * - disconnected: 触发一次即时重连尝试（不等定时器）
 * - connecting: 等待当前连接结果（短暂超时）
 *
 * @returns true 表示 Redis 当前可用
 */
async function ensureRedis(): Promise<boolean> {
  if (redisState === "ready" && redis.status === "ready") return true;

  if (redisState === "initial") {
    try {
      await redis.connect();
      // connect 成功会触发 connect/ready 事件，状态由事件驱动
      return (redisState as RedisState) === "ready";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRedisState("disconnected", `首次连接失败: ${msg}`);
      startRetryTimer();
      return false;
    }
  }

  if (redisState === "disconnected") {
    // 即时触发一次重连，不等定时器
    setRedisState("connecting", "按需即时重连");
    try {
      // 如果底层已经 ready（事件丢失 / 竞态），直接同步状态
      if (redis.status === "ready") {
        setRedisState("ready", "底层连接仍在就绪");
        stopRetryTimer();
        return true;
      }
      if (redis.status !== "connecting") {
        await redis.connect();
      }
      return (redisState as RedisState) === "ready";
    } catch {
      setRedisState("disconnected", "即时重连失败");
      return false;
    }
  }

  // connecting：等待一小段时间看是否能就绪
  return new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => {
      redis.removeListener("ready", onReady);
      resolve(false);
    }, 2000);
    const onReady = () => {
      clearTimeout(timeout);
      resolve(true);
    };
    redis.once("ready", onReady);
    // 如果此时已经 ready（事件刚触发）
    if (redis.status === "ready") {
      clearTimeout(timeout);
      redis.removeListener("ready", onReady);
      resolve(true);
    }
  });
}

// ── 公共 API ─────────────────────────────────────────────────────────────────

/**
 * 从缓存中获取数据。
 * 优先读 Redis；Redis 不可用或无数据时回退到 NodeCache。
 *
 * @param key 缓存键
 * @returns 缓存数据，未命中返回 undefined
 */
export const getCache = async (key: string): Promise<CacheData | undefined> => {
  const redisReady = await ensureRedis();

  if (redisReady) {
    try {
      const raw = await redis.get(key);
      if (raw) {
        return parse(raw) as CacheData;
      }
      // Redis 未命中 → 回退 NodeCache
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`📦 [Redis] GET 失败，回退 NodeCache: ${msg}`);
      // 单次读写失败不算断连，但标记状态让下次 ensureRedis 触发重连
      setRedisState("disconnected", `GET 异常: ${msg}`);
      startRetryTimer();
    }
  }

  return nodeCache.get(key) as CacheData | undefined;
};

/**
 * 将数据写入缓存。
 * Redis 可用时双写（Redis + NodeCache）；Redis 不可用时仅写 NodeCache。
 *
 * @param key   缓存键
 * @param value 缓存值
 * @param ttl   过期时间（秒），默认使用 config.CACHE_TTL
 * @returns 是否至少写入一层成功
 */
export const setCache = async (
  key: string,
  value: CacheData,
  ttl: number = config.CACHE_TTL,
): Promise<boolean> => {
  let redisOk = false;
  const redisReady = await ensureRedis();

  if (redisReady && !Buffer.isBuffer(value?.data)) {
    try {
      await redis.set(key, stringify(value), "EX", ttl);
      redisOk = true;
      logger.info(`💾 [Redis] ${key} 已写入`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`📦 [Redis] SET 失败: ${msg}`);
      setRedisState("disconnected", `SET 异常: ${msg}`);
      startRetryTimer();
    }
  }

  // NodeCache 始终写，保证本地回退层有数据
  const nodeOk = nodeCache.set(key, value, ttl);
  logger.info(`💾 [NodeCache] ${key} 已写入`);

  return redisOk || nodeOk;
};

/**
 * 从缓存中删除数据。
 * Redis 可用时删除 Redis + NodeCache；Redis 不可用时仅删除 NodeCache，
 * 并返回 false 表示两层未完全同步。
 *
 * @param key 缓存键
 * @returns true = 两层均删除成功（或 Redis 不可用时仅 NodeCache 成功删除但会 warn）
 */
export const delCache = async (key: string): Promise<boolean> => {
  let redisOk = false;
  const redisReady = await ensureRedis();

  if (redisReady) {
    try {
      await redis.del(key);
      redisOk = true;
      logger.info(`🗑️ [Redis] ${key} 已删除`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`📦 [Redis] DEL 失败: ${msg}`);
      setRedisState("disconnected", `DEL 异常: ${msg}`);
      startRetryTimer();
    }
  } else {
    logger.warn(`🗑️ [Redis] ${key} 删除跳过 — Redis 不可用，仅清理 NodeCache`);
  }

  const nodeDeleted = nodeCache.del(key) > 0;
  if (nodeDeleted) {
    logger.info(`🗑️ [NodeCache] ${key} 已删除`);
  }

  if (!redisOk && redisReady) {
    // Redis 声称可用但 del 失败 — 不一致风险
    logger.warn(`🗑️ [Cache] ${key} 两层删除不一致，Redis 失败`);
  }
  if (!redisReady) {
    // Redis 不可用，无法保证两层一致，返回 false 明确告知调用方
    return false;
  }
  return redisOk;
};

/**
 * 获取当前 Redis 连接状态（用于调试/监控）
 */
export const getRedisState = (): RedisState => redisState;

/**
 * 获取 Redis 底层实例（供测试或高级场景使用）
 */
export const getRedisClient = (): Redis => redis;

/**
 * 获取 NodeCache 实例（供测试使用）
 */
export const getNodeCache = (): NodeCache => nodeCache;
