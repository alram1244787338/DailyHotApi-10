import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ── Mock: ioredis ────────────────────────────────────────────────────────────
type EventHandler = (...args: unknown[]) => void;

class MockRedis {
  status: string = "wait";
  private handlers: Record<string, EventHandler[]> = {};

  connectSpy = vi.fn();
  getSpy = vi.fn();
  setSpy = vi.fn();
  delSpy = vi.fn();

  connectBehavior: "success" | "fail" = "success";
  getBehavior: "success" | "fail" = "success";
  setBehavior: "success" | "fail" = "success";
  delBehavior: "success" | "fail" = "success";
  getReturn: string | null = null;

  async connect() {
    this.connectSpy();
    if (this.connectBehavior === "fail") {
      const err = new Error("ECONNREFUSED");
      // 同步触发 error，让 cache 模块的事件处理器立即响应
      this.emit("error", err);
      throw err;
    }
    this.status = "ready";
    // 同步触发事件，保证 ensureRedis 返回时状态已更新
    this.emit("connect");
    this.emit("ready");
  }

  async get(key: string) {
    this.getSpy(key);
    if (this.getBehavior === "fail") throw new Error("GET_TIMEOUT");
    return this.getReturn;
  }

  async set(key: string, val: string, mode?: string, ttl?: number) {
    this.setSpy(key, val, mode, ttl);
    if (this.setBehavior === "fail") throw new Error("SET_TIMEOUT");
    return "OK";
  }

  async del(key: string) {
    this.delSpy(key);
    if (this.delBehavior === "fail") throw new Error("DEL_TIMEOUT");
    return 1;
  }

  on(event: string, handler: EventHandler) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(handler);
    return this;
  }

  once(event: string, handler: EventHandler) {
    const wrapper: EventHandler = (...args) => {
      this.removeListener(event, wrapper);
      handler(...args);
    };
    return this.on(event, wrapper);
  }

  removeListener(event: string, handler: EventHandler) {
    if (!this.handlers[event]) return this;
    this.handlers[event] = this.handlers[event].filter((h) => h !== handler);
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    // 复制一份数组，防止 handler 内部 removeListener 导致迭代异常
    const fns = [...(this.handlers[event] || [])];
    fns.forEach((h) => h(...args));
  }

  disconnect() {
    this.status = "end";
    this.emit("close");
  }

  quit() {
    this.status = "end";
  }
}

const mockRedis = new MockRedis();

vi.mock("ioredis", () => {
  const RedisMock = function () {
    return mockRedis;
  };
  return { default: RedisMock };
});

// ── Mock: node-cache ─────────────────────────────────────────────────────────
class MockNodeCache {
  private store = new Map<string, { value: unknown; expireAt: number }>();
  private handlers: Record<string, EventHandler[]> = {};

  constructor(_opts?: unknown) {}

  get(key: string) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expireAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: unknown, ttl?: number) {
    const expireAt = Date.now() + (ttl || 3600) * 1000;
    this.store.set(key, { value, expireAt });
    return true;
  }

  del(key: string) {
    return this.store.delete(key) ? 1 : 0;
  }

  on(event: string, handler: EventHandler) {
    if (!this.handlers[event]) this.handlers[event] = [];
    this.handlers[event].push(handler);
    return this;
  }

  emit(event: string, ...args: unknown[]) {
    (this.handlers[event] || []).forEach((h) => h(...args));
  }

  keys() {
    return [...this.store.keys()];
  }

  flushAll() {
    this.store.clear();
  }
}

const mockNodeCache = new MockNodeCache();

vi.mock("node-cache", () => {
  const NodeCacheMock = function () {
    return mockNodeCache;
  };
  return { default: NodeCacheMock };
});

// ── Mock: flatted ────────────────────────────────────────────────────────────
vi.mock("flatted", () => ({
  stringify: (v: unknown) => JSON.stringify(v),
  parse: (s: string) => JSON.parse(s),
}));

// ── Mock: logger ─────────────────────────────────────────────────────────────
vi.mock("../utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Mock: config ─────────────────────────────────────────────────────────────
vi.mock("../config.js", () => ({
  config: {
    CACHE_TTL: 3600,
    REDIS_HOST: "127.0.0.1",
    REDIS_PORT: 6379,
    REDIS_PASSWORD: "",
    REDIS_DB: 0,
  },
}));

// ── 工具函数 ─────────────────────────────────────────────────────────────────
function resetMockRedis() {
  mockRedis.status = "wait";
  mockRedis.connectBehavior = "success";
  mockRedis.getBehavior = "success";
  mockRedis.setBehavior = "success";
  mockRedis.delBehavior = "success";
  mockRedis.getReturn = null;
  mockRedis.connectSpy.mockClear();
  mockRedis.getSpy.mockClear();
  mockRedis.setSpy.mockClear();
  mockRedis.delSpy.mockClear();
  // 清空事件监听器（每个 module reload 会重新注册）
  (mockRedis as unknown as { handlers: Record<string, EventHandler[]> }).handlers = {};
}

function resetMockNodeCache() {
  mockNodeCache.flushAll();
}

// ── 测试 ─────────────────────────────────────────────────────────────────────
describe("cache 模块", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetMockRedis();
    resetMockNodeCache();
    vi.resetModules();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ─── 1. Redis 启动失败，回退 NodeCache ──────────────────────────────────
  describe("Redis 启动失败", () => {
    it("getCache: Redis 连接失败时回退到 NodeCache", async () => {
      mockRedis.connectBehavior = "fail";

      const { getCache } = await import("../utils/cache.js");
      mockNodeCache.set("test-key", { updateTime: "t1", data: { foo: "bar" } });

      const result = await getCache("test-key");

      expect(result).toEqual({ updateTime: "t1", data: { foo: "bar" } });
      expect(mockRedis.connectSpy).toHaveBeenCalled();
    });

    it("setCache: Redis 不可用时仅写 NodeCache", async () => {
      mockRedis.connectBehavior = "fail";

      const { setCache, getRedisState } = await import("../utils/cache.js");
      const ok = await setCache("k1", { updateTime: "t2", data: [1, 2, 3] });

      expect(ok).toBe(true);
      expect(mockRedis.setSpy).not.toHaveBeenCalled();
      expect(mockNodeCache.get("k1")).toEqual({ updateTime: "t2", data: [1, 2, 3] });
      expect(getRedisState()).toBe("disconnected");
    });

    it("delCache: Redis 不可用时返回 false（不制造假象）", async () => {
      mockRedis.connectBehavior = "fail";

      const { delCache } = await import("../utils/cache.js");
      mockNodeCache.set("k2", { updateTime: "t3", data: "x" });

      const ok = await delCache("k2");

      expect(ok).toBe(false);
      expect(mockNodeCache.get("k2")).toBeUndefined();
      expect(mockRedis.delSpy).not.toHaveBeenCalled();
    });
  });

  // ─── 2. Redis 正常运行 ──────────────────────────────────────────────────
  describe("Redis 正常运行", () => {
    it("setCache + getCache: 双写、Redis 优先读", async () => {
      const { setCache, getCache } = await import("../utils/cache.js");

      await setCache("k3", { updateTime: "t4", data: { a: 1 } });

      expect(mockRedis.setSpy).toHaveBeenCalledWith("k3", expect.any(String), "EX", 3600);

      mockRedis.getReturn = JSON.stringify({ updateTime: "t4", data: { a: 1 } });
      const result = await getCache("k3");

      expect(result).toEqual({ updateTime: "t4", data: { a: 1 } });
      expect(mockRedis.getSpy).toHaveBeenCalledWith("k3");
    });

    it("delCache: 两层都删除成功时返回 true", async () => {
      const { setCache, delCache } = await import("../utils/cache.js");

      await setCache("k4", { updateTime: "t5", data: "v" });
      const ok = await delCache("k4");

      expect(ok).toBe(true);
      expect(mockRedis.delSpy).toHaveBeenCalledWith("k4");
    });
  });

  // ─── 3. Redis 运行中故障 & 恢复 ─────────────────────────────────────────
  describe("Redis 运行中断连与恢复", () => {
    it("Redis 断连后 getCache 回退 NodeCache，恢复后重新使用 Redis", async () => {
      const mod = await import("../utils/cache.js");

      // 1) 先成功写入
      await mod.setCache("k5", { updateTime: "t6", data: "hello" });
      expect(mod.getRedisState()).toBe("ready");

      // 2) 模拟 Redis 断连（使用 disconnect 同时更新 status 和触发 close 事件）
      mockRedis.disconnect();
      expect(mod.getRedisState()).toBe("disconnected");

      // 3) getCache 应该回退 NodeCache（即时重连会失败）
      mockRedis.connectBehavior = "fail";
      mockNodeCache.set("k5", { updateTime: "t6", data: "hello" });
      const fallback = await mod.getCache("k5");
      expect(fallback).toEqual({ updateTime: "t6", data: "hello" });
      expect(mod.getRedisState()).toBe("disconnected");

      // 4) 模拟 Redis 恢复
      mockRedis.connectBehavior = "success";
      mockRedis.status = "wait"; // disconnect() 把 status 设为 "end"，恢复前重置
      mockRedis.getReturn = JSON.stringify({ updateTime: "t7", data: "recovered" });

      // 快进定时器触发重连
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mod.getRedisState()).toBe("ready");

      // 恢复后应该能从 Redis 读到新数据
      const recovered = await mod.getCache("k5");
      expect(recovered).toEqual({ updateTime: "t7", data: "recovered" });
    });
  });

  // ─── 4. 写缓存失败回退 ──────────────────────────────────────────────────
  describe("写缓存失败回退", () => {
    it("setCache: Redis SET 失败时 NodeCache 仍写入成功", async () => {
      const { setCache } = await import("../utils/cache.js");

      // 连接成功
      await setCache("init", { updateTime: "t0", data: "warm" });
      expect(mockRedis.setSpy).toHaveBeenCalled();

      // 现在 SET 会抛错
      mockRedis.setBehavior = "fail";
      mockRedis.setSpy.mockClear();

      const ok = await setCache("k6", { updateTime: "t8", data: "fallback" });

      expect(ok).toBe(true);
      expect(mockNodeCache.get("k6")).toEqual({ updateTime: "t8", data: "fallback" });
    });

    it("delCache: Redis DEL 失败时返回 false 并 warn", async () => {
      const { setCache, delCache } = await import("../utils/cache.js");

      await setCache("k7", { updateTime: "t9", data: "x" });

      mockRedis.delBehavior = "fail";
      mockRedis.delSpy.mockClear();

      const ok = await delCache("k7");

      expect(ok).toBe(false);
      expect(mockRedis.delSpy).toHaveBeenCalledWith("k7");
    });
  });

  // ─── 5. Buffer 数据不写 Redis ──────────────────────────────────────────
  describe("Buffer 数据处理", () => {
    it("setCache: value.data 为 Buffer 时跳过 Redis 写入", async () => {
      const { setCache } = await import("../utils/cache.js");

      await setCache("k8", { updateTime: "t10", data: Buffer.from("binary") });

      expect(mockRedis.setSpy).not.toHaveBeenCalled();
      expect(mockNodeCache.get("k8")).toBeDefined();
    });
  });

  // ─── 6. 定时重连机制 ───────────────────────────────────────────────────
  describe("定时重连机制", () => {
    it("Redis 断连后按 RETRY_INTERVAL_MS 间隔重连", async () => {
      const mod = await import("../utils/cache.js");

      // 先建立连接
      await mod.setCache("ping", { updateTime: "t0", data: "pong" });
      expect(mod.getRedisState()).toBe("ready");

      // 断连（使用 disconnect 同时更新 status 和触发事件）
      mockRedis.disconnect();
      expect(mod.getRedisState()).toBe("disconnected");

      // 让 connect 持续失败
      mockRedis.connectBehavior = "fail";
      mockRedis.connectSpy.mockClear();

      // 快进 10 秒触发一次定时器
      await vi.advanceTimersByTimeAsync(10_000);
      expect(mockRedis.connectSpy).toHaveBeenCalled();
    });
  });
});
