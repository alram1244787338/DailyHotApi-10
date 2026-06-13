/**
 * cacheKey.ts 单元测试
 * 运行: npx tsx --test src/utils/__tests__/cacheKey.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  stableStringify,
  normalizeUrl,
  buildGetCacheKey,
  buildPostCacheKey,
} from "../cacheKey.js";

describe("stableStringify", () => {
  it("对相同对象产生相同输出，不受 key 顺序影响", () => {
    const a = { b: "2", a: "1" };
    const b = { a: "1", b: "2" };
    assert.equal(stableStringify(a), stableStringify(b));
  });

  it("忽略 undefined 值", () => {
    const a = { x: "1", y: undefined };
    const b = { x: "1" };
    assert.equal(stableStringify(a), stableStringify(b));
  });

  it("处理嵌套对象", () => {
    const a = { z: { b: "2", a: "1" }, a: "x" };
    const b = { a: "x", z: { a: "1", b: "2" } };
    assert.equal(stableStringify(a), stableStringify(b));
  });

  it("区分不同值", () => {
    assert.notEqual(stableStringify({ a: "1" }), stableStringify({ a: "2" }));
  });

  it("处理数组", () => {
    assert.equal(stableStringify([1, 2, 3]), "[1,2,3]");
    assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
  });

  it("处理 Buffer", () => {
    const buf1 = Buffer.from("hello");
    const buf2 = Buffer.from("world");
    const buf3 = Buffer.from("hello");
    assert.equal(stableStringify(buf1), stableStringify(buf3));
    assert.notEqual(stableStringify(buf1), stableStringify(buf2));
  });

  it("处理基本类型", () => {
    assert.equal(stableStringify(null), "");
    assert.equal(stableStringify(undefined), "");
    assert.equal(stableStringify("abc"), "abc");
    assert.equal(stableStringify(42), "42");
    assert.equal(stableStringify(true), "true");
  });
});

describe("normalizeUrl", () => {
  it("对 query 参数排序", () => {
    const a = normalizeUrl("https://api.example.com/path?b=2&a=1");
    const b = normalizeUrl("https://api.example.com/path?a=1&b=2");
    assert.equal(a, b);
  });

  it("无参数时去掉尾部 ?", () => {
    const result = normalizeUrl("https://api.example.com/path");
    assert.equal(result, "https://api.example.com/path");
  });

  it("相同 URL 不同参数顺序结果一致", () => {
    const a = normalizeUrl("https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all&wbi=xxx");
    const b = normalizeUrl("https://api.bilibili.com/x/web-interface/ranking/v2?type=all&rid=0&wbi=xxx");
    assert.equal(a, b);
  });

  it("不同参数值产生不同结果", () => {
    const a = normalizeUrl("https://api.example.com/path?type=0");
    const b = normalizeUrl("https://api.example.com/path?type=1");
    assert.notEqual(a, b);
  });
});

describe("buildGetCacheKey", () => {
  it("同 URL 同 params → 相同 key", () => {
    const key1 = buildGetCacheKey({ url: "https://api.example.com/list", params: { type: "hot", page: 1 } });
    const key2 = buildGetCacheKey({ url: "https://api.example.com/list", params: { page: 1, type: "hot" } });
    assert.equal(key1, key2);
  });

  it("同 URL 不同 params → 不同 key", () => {
    const key1 = buildGetCacheKey({ url: "https://api.example.com/list", params: { type: "hot" } });
    const key2 = buildGetCacheKey({ url: "https://api.example.com/list", params: { type: "new" } });
    assert.notEqual(key1, key2);
  });

  it("同 URL 有 params 和无 params → 不同 key", () => {
    const key1 = buildGetCacheKey({ url: "https://api.example.com/list", params: { type: "hot" } });
    const key2 = buildGetCacheKey({ url: "https://api.example.com/list" });
    assert.notEqual(key1, key2);
  });

  it("params 中时间戳不同 → 不同 key（防止 history.ts 串数据）", () => {
    const key1 = buildGetCacheKey({ url: "https://baike.baidu.com/cms/home/eventsOnHistory/06.json", params: { _: 1000 } });
    const key2 = buildGetCacheKey({ url: "https://baike.baidu.com/cms/home/eventsOnHistory/06.json", params: { _: 2000 } });
    assert.notEqual(key1, key2);
  });

  it("URL 中已含 query 参数时，不同 type 值 → 不同 key（bilibili 场景）", () => {
    const key1 = buildGetCacheKey({ url: "https://api.bilibili.com/x/web-interface/ranking/v2?rid=0&type=all" });
    const key2 = buildGetCacheKey({ url: "https://api.bilibili.com/x/web-interface/ranking/v2?rid=1&type=all" });
    assert.notEqual(key1, key2);
  });

  it("tag 不同时 → 不同 key（区分 responseType）", () => {
    const key1 = buildGetCacheKey({ url: "https://example.com/api", tag: "arraybuffer" });
    const key2 = buildGetCacheKey({ url: "https://example.com/api" });
    assert.notEqual(key1, key2);
  });

  it("key 以 GET: 开头", () => {
    const key = buildGetCacheKey({ url: "https://example.com/api" });
    assert.ok(key.startsWith("GET:"));
  });
});

describe("buildPostCacheKey", () => {
  it("同 URL 同 body → 相同 key", () => {
    const key1 = buildPostCacheKey({ url: "https://ngabbs.com/nuke.php", body: { __output: "14" } });
    const key2 = buildPostCacheKey({ url: "https://ngabbs.com/nuke.php", body: { __output: "14" } });
    assert.equal(key1, key2);
  });

  it("同 URL 不同 body → 不同 key", () => {
    const key1 = buildPostCacheKey({ url: "https://ngabbs.com/nuke.php", body: { __output: "14" } });
    const key2 = buildPostCacheKey({ url: "https://ngabbs.com/nuke.php", body: { __output: "15" } });
    assert.notEqual(key1, key2);
  });

  it("同 URL 有 body 和无 body → 不同 key", () => {
    const key1 = buildPostCacheKey({ url: "https://ngabbs.com/nuke.php", body: { __output: "14" } });
    const key2 = buildPostCacheKey({ url: "https://ngabbs.com/nuke.php" });
    assert.notEqual(key1, key2);
  });

  it("body 为 string 时正常工作", () => {
    const key1 = buildPostCacheKey({ url: "https://example.com/api", body: "foo=bar" });
    const key2 = buildPostCacheKey({ url: "https://example.com/api", body: "foo=baz" });
    assert.notEqual(key1, key2);
  });

  it("body 为 Buffer 时区分内容", () => {
    const key1 = buildPostCacheKey({ url: "https://example.com/api", body: Buffer.from("hello") });
    const key2 = buildPostCacheKey({ url: "https://example.com/api", body: Buffer.from("world") });
    assert.notEqual(key1, key2);
  });

  it("body 为空字符串时等同于无 body", () => {
    const key1 = buildPostCacheKey({ url: "https://example.com/api", body: "" });
    const key2 = buildPostCacheKey({ url: "https://example.com/api" });
    assert.equal(key1, key2);
  });

  it("key 以 POST: 开头", () => {
    const key = buildPostCacheKey({ url: "https://example.com/api" });
    assert.ok(key.startsWith("POST:"));
  });
});
