import { config } from "../config.js";
import { stringify, parse } from "flatted";
import logger from "./logger.js";
import NodeCache from "node-cache";
import Redis from "ioredis";

export interface CacheData {
  updateTime: string;
  data: unknown;
}

/**
 * 缓存模块的设计口径（两层缓存的一致性约定）
 * --------------------------------------------------------------------------
 * - Redis 是「共享 / 权威」层：只要 Redis 可用，读写都以 Redis 为准，
 *   这样多实例之间看到的缓存内容一致。
 * - NodeCache 是「本地 / 降级」层：始终写一份本地副本，作用有两个——
 *     1. Redis 不可用时作为唯一的兜底数据源；
 *     2. Redis 单次读取异常时作为临时回退。
 * - 关键一致性规则：当 Redis 可用且未命中（MISS）时，直接视为「无缓存」，
 *   不再回退去读可能过期的 NodeCache，避免出现「A 接口读到旧的本地缓存、
 *   B 接口读到新的 Redis 数据」这种排查地狱。
 * - 唯一例外是 Buffer 数据：它无法安全序列化进 Redis，因此始终只存在于
 *   NodeCache（本地权威）。getCache 在 Redis 未命中时，会对「本地存的是
 *   Buffer」这一类键回退读取本地副本，保证 setCache 与 getCache 行为一致。
 *   这类值天然是「单实例本地」的，不参与多实例共享。
 *
 * Redis 可用性完全由 ioredis 的事件驱动（ready/error/close），并依赖
 * retryStrategy 在后台持续重连，因此：首次连不上不会永久卡死，运行中断线
 * 后只要环境恢复就能自动接回，全程不需要业务侧手动重试。
 */

// 仅声明本模块真正用到的 Redis 能力，便于在测试中注入假客户端
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, secondsToken: "EX", ttl: number): Promise<unknown>;
  del(key: string): Promise<number>;
  connect?(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  status?: string;
}

// 仅声明用到的日志能力，方便测试断言
export interface CacheLogger {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
}

export interface CacheStore {
  getCache: (key: string) => Promise<CacheData | undefined>;
  setCache: (key: string, value: CacheData, ttl?: number) => Promise<boolean>;
  delCache: (key: string) => Promise<boolean>;
  /** 当前 Redis 是否可用（主要给测试与排障用） */
  isRedisReady: () => boolean;
}

interface CreateCacheStoreOptions {
  redis: RedisLike;
  cache: NodeCache;
  logger: CacheLogger;
  /** 默认 TTL（秒） */
  ttl?: number;
  /**
   * 是否在创建时主动发起一次连接（生产/开发为 true）。
   * 测试中设为 false，连接状态完全由手动触发的事件控制。
   */
  autoConnect?: boolean;
}

const errMsg = (error: unknown): string =>
  error instanceof Error ? error.message : "Unknown error";

/**
 * 创建一个缓存存储实例。把核心逻辑做成工厂，既保证三个入口
 * （getCache / setCache / delCache）行为统一，也便于注入假 Redis 做测试。
 */
export const createCacheStore = ({
  redis,
  cache,
  logger,
  ttl: defaultTtl = config.CACHE_TTL,
  autoConnect = true,
}: CreateCacheStoreOptions): CacheStore => {
  // 当前 Redis 是否可用（唯一真相，由事件驱动）
  let isRedisAvailable = false;
  // 是否曾经成功连接过——用于区分「首次连接失败」与「运行中断线」
  let hasEverConnected = false;
  // 当前这段「不可用周期」是否已经打过一次错误日志——用于抑制重连刷屏
  let loggedDownError = false;

  // ── Redis 连接事件：统一在这里维护可用性状态与排障日志 ──────────────
  redis.on("ready", () => {
    const wasDown = !isRedisAvailable;
    isRedisAvailable = true;
    loggedDownError = false;
    if (!hasEverConnected) {
      hasEverConnected = true;
      logger.info("📦 [Redis] connected successfully (first connection); Redis is now primary cache.");
    } else if (wasDown) {
      logger.info("📦 [Redis] reconnected successfully; switching back from NodeCache fallback.");
    }
  });

  redis.on("error", (error: unknown) => {
    const wasAvailable = isRedisAvailable;
    isRedisAvailable = false;
    // ioredis 在每次重连失败时都会抛 error，这里只在「状态切换」时打一次，避免刷屏
    if (loggedDownError) return;
    loggedDownError = true;
    const message = errMsg(error);
    if (!hasEverConnected) {
      logger.error(`📦 [Redis] initial connection failed; falling back to NodeCache: ${message}`);
    } else if (wasAvailable) {
      logger.warn(`📦 [Redis] connection lost at runtime; falling back to NodeCache: ${message}`);
    } else {
      logger.warn(`📦 [Redis] still unreachable, retrying in background: ${message}`);
    }
  });

  redis.on("close", () => {
    // error 事件通常已切换状态，这里兜底确保不可用（不重复打日志）
    isRedisAvailable = false;
  });

  redis.on("reconnecting", (...args: unknown[]) => {
    const delay = typeof args[0] === "number" ? args[0] : undefined;
    logger.debug?.(`📦 [Redis] reconnecting${delay !== undefined ? ` in ${delay}ms` : ""}...`);
  });

  // 主动发起首次连接；失败已由 "error" 事件统一记录，retryStrategy 负责后续重连
  if (autoConnect && typeof redis.connect === "function") {
    Promise.resolve(redis.connect()).catch(() => {
      /* 首次连接失败由 "error" 事件统一处理，这里无需重复日志 */
    });
  }

  /**
   * 从缓存中获取数据
   * @param key 缓存键
   * @returns 缓存数据
   */
  const getCache = async (key: string): Promise<CacheData | undefined> => {
    if (isRedisAvailable) {
      try {
        const redisResult = await redis.get(key);
        if (redisResult !== null && redisResult !== undefined) {
          return parse(redisResult) as CacheData;
        }
        // Redis 可用但未命中：以 Redis 为权威，视为无缓存。
        // 例外：Buffer 数据无法安全写入 Redis，只存在于本地 NodeCache，
        // 属于「本地权威」的值——对这类键回退读取本地副本，否则会出现
        // 「setCache 报成功、getCache 永远读不到」的自相矛盾。
        // 非 Buffer 的普通值仍严格视为无缓存，绝不回退读可能过期的本地数据。
        const localOnMiss = cache.get<CacheData>(key);
        if (localOnMiss !== undefined && Buffer.isBuffer(localOnMiss.data)) {
          return localOnMiss;
        }
        return undefined;
      } catch (error) {
        // 单次读失败 → 降级读取本地 NodeCache（兜底）
        logger.error(`📦 [Redis] GET "${key}" failed, falling back to NodeCache: ${errMsg(error)}`);
      }
    }
    return cache.get<CacheData>(key);
  };

  /**
   * 将数据写入缓存
   * @param key 缓存键
   * @param value 缓存值
   * @param ttl 缓存过期时间（ 秒 ）
   * @returns 是否写入成功（以「读取时能否生效」为准）
   */
  const setCache = async (
    key: string,
    value: CacheData,
    ttl: number = defaultTtl,
  ): Promise<boolean> => {
    const isBuffer = Buffer.isBuffer(value?.data);
    // 本地副本始终写入：降级时是唯一数据源，平时是 Redis 的本地镜像
    const nodeOk = cache.set(key, value, ttl);

    if (!isRedisAvailable) {
      logger.info(`💾 [NodeCache] "${key}" cached (Redis unavailable, ttl=${ttl}s).`);
      return nodeOk;
    }

    if (isBuffer) {
      // Buffer 无法安全序列化进 Redis，只能保留在 NodeCache（本地权威）。
      // getCache 在 Redis 未命中时会对 Buffer 键回退读本地，因此这里的成功是
      // 真实可读的成功，不是假象；代价是该值仅在本实例可见、不跨实例共享。
      logger.warn(
        `💾 [Cache] "${key}" is Buffer data, kept in NodeCache only (local-only, not shared via Redis).`,
      );
      return nodeOk;
    }

    try {
      await redis.set(key, stringify(value), "EX", ttl);
      logger.info(`💾 [Redis+NodeCache] "${key}" cached (ttl=${ttl}s).`);
      return nodeOk;
    } catch (error) {
      // Redis 是权威读取源；权威写失败则后续读取（Redis 可用时）将 MISS，
      // 因此如实返回 false，不制造「写成功」的假象。
      logger.error(`📦 [Redis] SET "${key}" failed (kept in NodeCache only): ${errMsg(error)}`);
      return false;
    }
  };

  /**
   * 从缓存中删除数据
   * @param key 缓存键
   * @returns 是否删除成功（能否保证全局删除）
   */
  const delCache = async (key: string): Promise<boolean> => {
    // 本地副本总是先清掉
    const nodeRemoved = cache.del(key) > 0;

    if (!isRedisAvailable) {
      // 关键修复：Redis 没连上时绝不硬调 del——既避免日志刷屏，
      // 也避免「业务看起来删成功、其实 Redis 里还在」的假象，如实返回 false。
      logger.warn(
        `🗑️ [Cache] Redis unavailable: only NodeCache cleared for "${key}". ` +
          `Cannot guarantee Redis deletion — reporting failure to avoid a false success.`,
      );
      return false;
    }

    try {
      await redis.del(key);
      logger.info(
        `🗑️ [Redis+NodeCache] "${key}" deleted${nodeRemoved ? "" : " (no local copy)"}.`,
      );
      return true;
    } catch (error) {
      logger.error(`📦 [Redis] DEL "${key}" failed: ${errMsg(error)}`);
      return false;
    }
  };

  return { getCache, setCache, delCache, isRedisReady: () => isRedisAvailable };
};

// ── 默认实例（供全项目复用，保持原有命名导出不变） ─────────────────────

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
  // 单条命令的最大重试次数，配合 enableOfflineQueue:false 实现快速失败回退
  maxRetriesPerRequest: 2,
  // 连接未就绪时不要把命令排队挂起，直接快速失败以便回退 NodeCache
  enableOfflineQueue: false,
  // 重连策略：持续重连（最小 200ms，最大 5s），保证环境恢复后能自动接回
  retryStrategy: (times) => Math.min(times * 200, 5000),
  // 启动时不立即连接，由下方 createCacheStore 统一发起
  lazyConnect: true,
});

// NodeCache 事件监听
cache.on("expired", (key) => {
  logger.info(`⏳ [NodeCache] Key "${key}" has expired.`);
});

cache.on("del", (key) => {
  logger.info(`🗑️ [NodeCache] Key "${key}" has been deleted.`);
});

const defaultStore = createCacheStore({
  redis: redis as unknown as RedisLike,
  cache,
  logger,
  ttl: config.CACHE_TTL,
  // 测试环境不主动连真实 Redis，避免悬挂的 socket / 重连定时器
  autoConnect: process.env.NODE_ENV !== "test",
});

export const getCache = defaultStore.getCache;
export const setCache = defaultStore.setCache;
export const delCache = defaultStore.delCache;
export const isRedisReady = defaultStore.isRedisReady;

// 暴露底层 Redis 客户端，便于优雅关闭 / 测试清理（一般业务不需要）
export const redisClient = redis;
