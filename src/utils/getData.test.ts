/**
 * get / post 缓存层关键测试（网络无关）。
 *
 * 运行：`npm test` 或 `tsx --test src/utils/getData.test.ts`
 *
 * 覆盖需求：
 * - 同 URL 不同 params → 不同缓存键（GET）
 * - 同 URL 不同 body  → 不同缓存键（POST）
 * - GET / POST 同 URL 互不串台
 * - responseType / originaInfo 不同 → 缓存键隔离（二进制 / 原始响应不污染普通 JSON）
 * - cacheKey 覆盖 → 时间戳等易变参数不影响键（history/36kr/51cto 场景）
 * - get() 命中精确键，且不同 params 不会读到别的缓存（“串数据”修复）
 * - noCache 强制刷新只删匹配的精确键，兄弟键不受影响
 *
 * 说明：测试不依赖外网与 Redis。Redis 未启动时缓存层会自动回退到 NodeCache；
 * 命中分支在请求网络之前就返回，未命中分支统一指向不可解析域名（.invalid）以保证快速失败。
 */
import test, { after } from "node:test";
import assert from "node:assert/strict";

// 在加载被测模块前设定测试友好的环境变量（config 在模块加载时读取）
process.env.USE_LOG_FILE = "false";
process.env.REQUEST_TIMEOUT = "200";

const { generateCacheKey, get, post } = await import("./getData.js");
const { setCache, getCache, disconnectCache } = await import("./cache.js");

// 收尾：关闭缓存连接，释放 NodeCache / Redis 定时器，让测试进程能正常退出
after(() => {
  disconnectCache();
});

test("GET：同 URL 不同 params 生成不同缓存键", () => {
  const url = "https://api.example.com/rank";
  const a = generateCacheKey({ method: "GET", url, params: { type: "1" } });
  const b = generateCacheKey({ method: "GET", url, params: { type: "2" } });
  assert.notEqual(a, b);
});

test("GET：params 顺序不同但语义相同 → 同一缓存键", () => {
  const url = "https://api.example.com/rank";
  const a = generateCacheKey({ method: "GET", url, params: { a: "1", b: "2" } });
  const b = generateCacheKey({ method: "GET", url, params: { b: "2", a: "1" } });
  assert.equal(a, b);
});

test("POST：同 URL 不同 body 生成不同缓存键", () => {
  const url = "https://api.example.com/list";
  const a = generateCacheKey({ method: "POST", url, body: { page: 1 } });
  const b = generateCacheKey({ method: "POST", url, body: { page: 2 } });
  assert.notEqual(a, b);
});

test("GET 与 POST 同 URL 不冲突", () => {
  const url = "https://api.example.com/same";
  assert.notEqual(
    generateCacheKey({ method: "GET", url }),
    generateCacheKey({ method: "POST", url }),
  );
});

test("responseType / originaInfo 不同 → 缓存键隔离（二进制 / 原始响应）", () => {
  const url = "https://api.example.com/rss";
  const json = generateCacheKey({ method: "GET", url, responseType: "json" });
  const buf = generateCacheKey({ method: "GET", url, responseType: "arraybuffer" });
  const orig = generateCacheKey({ method: "GET", url, originaInfo: true });
  assert.notEqual(json, buf);
  assert.notEqual(json, orig);
  assert.notEqual(buf, orig);
});

test("cacheKey 覆盖 → 易变参数（时间戳）不影响键（history/36kr/51cto 场景）", () => {
  const url = "https://baike.example.com/06.json";
  const a = generateCacheKey({ method: "GET", url, params: { _: 1 }, cacheKey: "history:06" });
  const b = generateCacheKey({ method: "GET", url, params: { _: 999999 }, cacheKey: "history:06" });
  assert.equal(a, b);
  assert.equal(a, "GET:history:06");
});

test("get()：命中精确缓存键，不同 params 不会串数据", async () => {
  const url = "https://example.invalid/list";
  // 预置 type=a 对应的精确缓存（键的计算方式与 get() 内部一致）
  const keyA = generateCacheKey({
    method: "GET",
    url,
    params: { type: "a" },
    responseType: "json",
    originaInfo: false,
  });
  await setCache(keyA, { data: { tag: "A" }, updateTime: "t-A" }, 60);

  // 同一 params → 命中缓存，且不发起网络请求
  const hit = await get<{ tag: string }>({ url, params: { type: "a" } });
  assert.equal(hit.fromCache, true);
  assert.equal(hit.updateTime, "t-A");
  assert.deepEqual(hit.data, { tag: "A" });

  // 不同 params → 不应命中 A 的缓存（核心“串数据”修复）
  const keyB = generateCacheKey({
    method: "GET",
    url,
    params: { type: "b" },
    responseType: "json",
    originaInfo: false,
  });
  assert.equal(await getCache(keyB), undefined);
});

test("post()：同 URL 不同 body 不会串数据", async () => {
  const url = "https://example.invalid/post-list";
  const keyA = generateCacheKey({ method: "POST", url, body: { page: 1 }, originaInfo: false });
  await setCache(keyA, { data: "page-1", updateTime: "t1" }, 60);

  const hit = await post<string>({ url, body: { page: 1 } });
  assert.equal(hit.fromCache, true);
  assert.equal(hit.data, "page-1");

  const keyB = generateCacheKey({ method: "POST", url, body: { page: 2 }, originaInfo: false });
  assert.equal(await getCache(keyB), undefined);
});

test("noCache：强制刷新只删匹配的精确键，兄弟键不受影响", async () => {
  const url = "https://example.invalid/refresh";
  const keyA = generateCacheKey({
    method: "GET",
    url,
    params: { type: "a" },
    responseType: "json",
    originaInfo: false,
  });
  const keyB = generateCacheKey({
    method: "GET",
    url,
    params: { type: "b" },
    responseType: "json",
    originaInfo: false,
  });
  await setCache(keyA, { data: "A", updateTime: "t" }, 60);
  await setCache(keyB, { data: "B", updateTime: "t" }, 60);

  // 触发强制刷新：内部会先删 keyA，再请求网络（域名不可解析 → 抛错，属预期）
  await assert.rejects(get({ url, params: { type: "a" }, noCache: true }));

  // keyA 被强制刷新删除，keyB（不同 params）必须完好保留
  assert.equal(await getCache(keyA), undefined, "强制刷新应删除 keyA");
  const survived = await getCache(keyB);
  assert.notEqual(survived, undefined, "keyB 不应被误删");
  assert.equal(survived?.data, "B");
});
