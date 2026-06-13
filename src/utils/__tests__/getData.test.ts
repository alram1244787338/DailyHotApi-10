/**
 * getData.ts 集成测试
 * 覆盖：同 URL 不同 params、同 URL 不同 body、noCache 强制刷新
 * 运行: npx tsx --test src/utils/__tests__/getData.test.ts
 *
 * 原理：启动本地 HTTP 服务器，通过返回值差异验证缓存是否正确区分参数。
 * 由于 Redis 在本测试环境不可用，实际验证的是 NodeCache 层（与 Redis 使用相同 key 逻辑）。
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { get, post } from "../getData.js";
import { getCache, delCache, disconnectRedis } from "../cache.js";
import { buildGetCacheKey, buildPostCacheKey } from "../cacheKey.js";

// --- 本地测试服务器 ---
let server: http.Server;
let baseUrl: string;

before(async () => {
  server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://localhost`);
    let body = "";

    if (req.method === "POST") {
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        // POST 返回 body 内容作为标识
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ method: "POST", body, path: url.pathname }));
      });
    } else {
      // GET 返回 query 参数作为标识
      const params: Record<string, string> = {};
      url.searchParams.forEach((v, k) => { params[k] = v; });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ method: "GET", params, path: url.pathname }));
    }
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        baseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  // 断开 Redis 连接，防止 ioredis 重连导致进程挂起
  await disconnectRedis();
});

describe("GET 缓存键隔离", () => {
  it("同 URL 不同 params 应返回不同数据（不串台）", async () => {
    const url = `${baseUrl}/api/list`;

    // 第一次：type=hot
    const r1 = await get<{ params: Record<string, string> }>({
      url,
      params: { type: "hot" },
    });
    assert.equal(r1.data.params.type, "hot");
    assert.equal(r1.fromCache, false);

    // 第二次：type=new —— 不应该命中 type=hot 的缓存
    const r2 = await get<{ params: Record<string, string> }>({
      url,
      params: { type: "new" },
    });
    assert.equal(r2.data.params.type, "new", "type=new 不应返回 type=hot 的缓存数据");
    assert.equal(r2.fromCache, false, "不同 params 不应命中旧缓存");

    // 第三次：再次请求 type=hot —— 应命中缓存
    const r3 = await get<{ params: Record<string, string> }>({
      url,
      params: { type: "hot" },
    });
    assert.equal(r3.data.params.type, "hot");
    assert.equal(r3.fromCache, true, "相同 params 应命中缓存");
  });

  it("同 URL 不同 params 的缓存 key 应该不同", async () => {
    const url = `${baseUrl}/api/isolated`;
    const key1 = buildGetCacheKey({ url, params: { type: "a" } });
    const key2 = buildGetCacheKey({ url, params: { type: "b" } });
    assert.notEqual(key1, key2);

    // 写入 key1 的缓存不应被 key2 读到
    const r1 = await get({ url, params: { type: "a" } });
    assert.equal(r1.fromCache, false);

    const r2 = await get({ url, params: { type: "b" } });
    assert.equal(r2.fromCache, false, "key2 不应读到 key1 的缓存");
  });

  it("无 params 时正常缓存", async () => {
    const url = `${baseUrl}/api/simple`;
    const r1 = await get({ url });
    assert.equal(r1.fromCache, false);

    const r2 = await get({ url });
    assert.equal(r2.fromCache, true, "同 URL 无 params 应命中缓存");
  });
});

describe("POST 缓存键隔离", () => {
  it("同 URL 不同 body 应返回不同数据（不串台）", async () => {
    const url = `${baseUrl}/api/post`;

    const r1 = await post<{ body: string }>({
      url,
      body: { action: "listA" },
    });
    assert.ok(r1.data.body.includes("listA"));
    assert.equal(r1.fromCache, false);

    const r2 = await post<{ body: string }>({
      url,
      body: { action: "listB" },
    });
    assert.ok(r2.data.body.includes("listB"), "不同 body 不应返回 listA 的缓存数据");
    assert.equal(r2.fromCache, false, "不同 body 不应命中旧缓存");
  });

  it("同 URL 同 body 应命中缓存", async () => {
    const url = `${baseUrl}/api/post-cached`;

    const r1 = await post({ url, body: { id: "42" } });
    assert.equal(r1.fromCache, false);

    const r2 = await post({ url, body: { id: "42" } });
    assert.equal(r2.fromCache, true, "相同 body 应命中缓存");
  });
});

describe("noCache 强制刷新", () => {
  it("noCache=true 应绕过缓存并刷新数据", async () => {
    const url = `${baseUrl}/api/refresh`;

    // 第一次正常请求，缓存数据
    const r1 = await get<{ params: Record<string, string> }>({
      url,
      params: { v: "1" },
    });
    assert.equal(r1.fromCache, false);

    // 第二次正常请求，应该命中缓存
    const r2 = await get<{ params: Record<string, string> }>({
      url,
      params: { v: "1" },
    });
    assert.equal(r2.fromCache, true);

    // 第三次 noCache=true，应该强制刷新
    const r3 = await get<{ params: Record<string, string> }>({
      url,
      params: { v: "1" },
      noCache: true,
    });
    assert.equal(r3.fromCache, false, "noCache 应强制请求");

    // 第四次正常请求，应该再次命中缓存（由 noCache 请求写入的新缓存）
    const r4 = await get<{ params: Record<string, string> }>({
      url,
      params: { v: "1" },
    });
    assert.equal(r4.fromCache, true, "noCache 后正常请求应命中缓存");
  });

  it("POST noCache=true 应绕过缓存", async () => {
    const url = `${baseUrl}/api/post-refresh`;

    const r1 = await post({ url, body: "test" });
    assert.equal(r1.fromCache, false);

    const r2 = await post({ url, body: "test" });
    assert.equal(r2.fromCache, true);

    const r3 = await post({ url, body: "test", noCache: true });
    assert.equal(r3.fromCache, false, "POST noCache 应强制请求");
  });

  it("delCache 能删除复合 key 的缓存", async () => {
    const url = `${baseUrl}/api/del-test`;
    const params = { category: "test" };

    // 写入缓存
    await get({ url, params });
    const cacheKey = buildGetCacheKey({ url, params });

    // 确认缓存存在
    const cached = await getCache(cacheKey);
    assert.ok(cached, "缓存应该存在");

    // 删除缓存
    await delCache(cacheKey);

    // 确认已删除（NodeCache 层，Redis 可能未连接）
    const afterDel = await getCache(cacheKey);
    assert.equal(afterDel, undefined, "删除后缓存应为空");
  });
});
