/**
 * 缓存模块可执行校验（无需外部 Redis，使用内存假客户端模拟各种状态）。
 *
 * 运行方式：
 *   npm run test:cache
 *   # 或者
 *   cross-env NODE_ENV=test USE_LOG_FILE=false tsx test/cache.test.ts
 *
 * 覆盖场景（对应需求第 7 条）：
 *   1. Redis 启动即连接失败  → 稳定回退 NodeCache，删除缓存如实失败、不硬调 del
 *   2. 运行中断线后恢复      → 自动接回，且首连/断线/重连日志可区分
 *   2b. 双层一致性          → Redis 可用时以 Redis 为权威，MISS 不读过期 NodeCache
 *   3. Redis 正常时删除缓存  → Redis 与 NodeCache 同时清除
 *   4. 写 Redis 失败回退     → 本地仍有数据，单次读异常时降级读 NodeCache
 *   4b. Buffer 本地权威      → Redis 可用且 MISS 时仍能从 NodeCache 读回
 */

// 必须在导入缓存模块之前固定环境，避免默认实例去连真实 Redis / 写日志文件
process.env.NODE_ENV = "test";
process.env.USE_LOG_FILE = "false";

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import NodeCache from "node-cache";
import { stringify } from "flatted";
import type { CacheData, CacheLogger, RedisLike } from "../src/utils/cache.js";

// 动态导入：确保上面的 env 已生效后再加载模块（其默认实例会因 NODE_ENV=test 跳过自动连接）
const { createCacheStore } = (await import(
  "../src/utils/cache.js"
)) as typeof import("../src/utils/cache.js");

// ── 测试替身 ─────────────────────────────────────────────────────────────

/** 内存版假 Redis：可手动触发连接事件，并可让单次读写删抛错 */
class FakeRedis extends EventEmitter implements RedisLike {
  store = new Map<string, string>();
  status = "wait";
  failGet = false;
  failSet = false;
  failDel = false;
  getCalls = 0;
  setCalls = 0;
  delCalls = 0;
  lastSetTtl = 0;

  async connect(): Promise<void> {
    this.status = "connecting";
  }

  async get(key: string): Promise<string | null> {
    this.getCalls++;
    if (this.failGet) throw new Error("simulated GET failure");
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }

  async set(key: string, value: string, secondsToken: "EX", ttl: number): Promise<unknown> {
    this.setCalls++;
    if (this.failSet) throw new Error("simulated SET failure");
    // 顺带校验调用约定（key, value, "EX", ttl）并记录最近一次 TTL
    if (secondsToken !== "EX") throw new Error(`unexpected token: ${secondsToken}`);
    this.lastSetTtl = ttl;
    this.store.set(key, value);
    return "OK";
  }

  async del(key: string): Promise<number> {
    this.delCalls++;
    if (this.failDel) throw new Error("simulated DEL failure");
    return this.store.delete(key) ? 1 : 0;
  }

  // ── 手动驱动连接生命周期 ──
  goReady(): void {
    this.status = "ready";
    this.emit("ready");
  }
  goError(message = "ECONNREFUSED"): void {
    this.status = "reconnecting";
    this.emit("error", new Error(message));
  }
  goClose(): void {
    this.status = "close";
    this.emit("close");
  }
}

/** 记录各级别日志，便于断言排障信息是否到位 */
const makeRecordingLogger = () => {
  const lines = { info: [] as string[], warn: [] as string[], error: [] as string[], debug: [] as string[] };
  const logger: CacheLogger = {
    info: (m) => lines.info.push(m),
    warn: (m) => lines.warn.push(m),
    error: (m) => lines.error.push(m),
    debug: (m) => lines.debug.push(m),
  };
  return { logger, lines };
};

const data = (tag: string): CacheData => ({ updateTime: `time-${tag}`, data: { value: tag } });

const build = () => {
  const redis = new FakeRedis();
  const cache = new NodeCache({ stdTTL: 100, checkperiod: 0, useClones: false, maxKeys: 100 });
  const { logger, lines } = makeRecordingLogger();
  const store = createCacheStore({ redis, cache, logger, ttl: 100, autoConnect: false });
  return { redis, cache, logger, lines, store };
};

const has = (arr: string[], re: RegExp) => arr.some((m) => re.test(m));

// ── 极简测试运行器 ───────────────────────────────────────────────────────

type TestFn = () => Promise<void> | void;
const cases: { name: string; fn: TestFn }[] = [];
const test = (name: string, fn: TestFn) => cases.push({ name, fn });

// ── 场景 1：Redis 启动连接失败 → 稳定回退 NodeCache；删除如实失败且不硬删 ──
test("startup failure: falls back to NodeCache and delCache is honest (no hard del)", async () => {
  const { redis, store, lines } = build();

  // 启动即失败，从未 ready
  redis.goError("ECONNREFUSED");
  assert.equal(store.isRedisReady(), false);
  assert.ok(has(lines.error, /initial connection failed/i), "应记录首次连接失败日志");

  // 写入回退到 NodeCache
  const okSet = await store.setCache("k1", data("1"));
  assert.equal(okSet, true, "Redis 不可用时写 NodeCache 应成功");

  // 读取从 NodeCache 命中
  assert.deepEqual(await store.getCache("k1"), data("1"));

  // 删除：Redis 不可用 → 不调用 redis.del，如实返回 false
  const delCallsBefore = redis.delCalls;
  const okDel = await store.delCache("k1");
  assert.equal(okDel, false, "Redis 不可用时 delCache 必须返回 false（不能假成功）");
  assert.equal(redis.delCalls, delCallsBefore, "Redis 不可用时绝不能硬调 redis.del");
  assert.ok(has(lines.warn, /only NodeCache cleared/i), "应提示仅清除了本地缓存");

  // 本地确实已删除
  assert.equal(await store.getCache("k1"), undefined, "删除后本地应读不到");
});

// ── 场景 2：运行中断线后恢复，且日志可区分首连/断线/重连 ──
test("runtime recovery: reconnects and logs distinct first-connect / lost / reconnect", async () => {
  const { redis, store, lines } = build();

  redis.goReady();
  assert.equal(store.isRedisReady(), true);
  assert.ok(has(lines.info, /first connection/i), "应记录首次连接成功");

  redis.goError("read ECONNRESET");
  assert.equal(store.isRedisReady(), false);
  assert.ok(has(lines.warn, /connection lost at runtime/i), "应记录运行中断线");

  redis.goReady();
  assert.equal(store.isRedisReady(), true, "环境恢复后应自动接回");
  assert.ok(has(lines.info, /reconnected successfully/i), "应记录重连成功");
});

// ── 场景 2b：双层一致性 —— Redis 可用时以 Redis 为权威 ──
test("consistency: Redis is authoritative when available; miss does not serve stale NodeCache", async () => {
  const { redis, cache, store } = build();
  redis.goReady();

  // 本地是旧值、Redis 是新值 → 必须返回新值
  cache.set("kc", data("OLD"));
  redis.store.set("kc", stringify(data("NEW")));
  assert.deepEqual(await store.getCache("kc"), data("NEW"), "Redis 可用时应以 Redis 为准");

  // Redis 未命中但本地有旧值 → 视为无缓存，不返回过期本地数据
  cache.set("kc2", data("STALE"));
  assert.equal(
    await store.getCache("kc2"),
    undefined,
    "Redis 命中失败时不得回退读取过期的 NodeCache",
  );
});

// ── 场景 3：Redis 正常时删除缓存 —— 两层同时清除 ──
test("delete when Redis up: clears both Redis and NodeCache", async () => {
  const { redis, cache, store } = build();
  redis.goReady();

  await store.setCache("kd", data("d"));
  assert.equal(redis.store.has("kd"), true, "set 后 Redis 应有该键");
  assert.notEqual(cache.get("kd"), undefined, "set 后 NodeCache 镜像应存在");

  const okDel = await store.delCache("kd");
  assert.equal(okDel, true, "Redis 可用时删除成功应返回 true");
  assert.equal(redis.store.has("kd"), false, "Redis 中应已删除");
  assert.equal(cache.get("kd"), undefined, "NodeCache 中应已删除");
  assert.equal(await store.getCache("kd"), undefined);
});

// ── 场景 4：写 Redis 失败 → 本地仍有数据；单次读异常时降级读 NodeCache ──
test("write failure: reports false but keeps NodeCache copy for degraded reads", async () => {
  const { redis, cache, store, lines } = build();
  redis.goReady();

  redis.failSet = true;
  const okSet = await store.setCache("kw", data("w"));
  assert.equal(okSet, false, "权威层（Redis）写失败应如实返回 false");
  assert.ok(has(lines.error, /SET "kw" failed/i), "应记录单次写失败");
  assert.deepEqual(cache.get("kw"), data("w"), "本地副本仍应保留（写失败回退）");

  // 现在让 Redis 读也异常 → 降级读取本地副本
  redis.failGet = true;
  assert.deepEqual(await store.getCache("kw"), data("w"), "单次读异常应降级读 NodeCache");
  assert.ok(has(lines.error, /GET "kw" failed/i), "应记录单次读失败");
});

// ── 场景 4b：Buffer 为本地权威 —— Redis 可用且未命中时仍能从 NodeCache 读回 ──
test("buffer values are local-authoritative: cached and read back even when Redis is up", async () => {
  const { redis, store, lines } = build();
  redis.goReady();

  const setBefore = redis.setCalls;
  const buf: CacheData = { updateTime: "t-buf", data: Buffer.from("raw-bytes") };
  const okSet = await store.setCache("kbuf", buf);
  assert.equal(okSet, true, "Buffer 写入（本地权威）应返回成功");
  assert.equal(redis.setCalls, setBefore, "Buffer 绝不能写入 Redis（无法安全序列化）");
  assert.ok(has(lines.warn, /Buffer data, kept in NodeCache only/i), "应提示 Buffer 仅存本地");

  // Redis 可用且必然 MISS（从未写入 Redis），但 Buffer 属本地权威 → 必须读回
  const getBefore = redis.getCalls;
  const got = await store.getCache("kbuf");
  assert.ok(got !== undefined, "Redis 未命中时 Buffer 值仍应从 NodeCache 读回");
  assert.ok(Buffer.isBuffer(got?.data), "读回的应仍是 Buffer");
  assert.equal((got?.data as Buffer).toString(), "raw-bytes");
  assert.ok(redis.getCalls > getBefore, "getCache 仍应先查询 Redis 以确认 MISS（不是直接跳过）");
});

// ── 运行 ─────────────────────────────────────────────────────────────────
(async () => {
  let passed = 0;
  let failed = 0;
  for (const c of cases) {
    try {
      await c.fn();
      passed++;
      console.log(`  ✅ ${c.name}`);
    } catch (error) {
      failed++;
      console.error(`  ❌ ${c.name}`);
      console.error(`     ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
  }

  console.log(`\nCache verification: ${passed} passed, ${failed} failed.`);
  // 强制退出：默认缓存模块实例会创建 NodeCache 周期定时器，避免进程悬挂
  process.exit(failed > 0 ? 1 : 0);
})();
