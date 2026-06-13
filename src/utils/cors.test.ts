import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { decideOrigin, parseHost, hostMatches } from "./cors.js";

/**
 * CORS 来源判定的单测 + 一小段真实 Hono 集成测试。
 * 运行：node --import tsx --test src/utils/cors.test.ts  （或 npm test）
 */

describe("parseHost", () => {
  it("解析完整 Origin", () => {
    assert.equal(parseHost("https://imsyy.top"), "imsyy.top");
    assert.equal(parseHost("https://www.imsyy.top:8443"), "www.imsyy.top");
    assert.equal(parseHost("http://localhost:6688"), "localhost");
  });

  it("兼容裸主机 / 尾斜杠 / 误带路径", () => {
    assert.equal(parseHost("imsyy.top"), "imsyy.top");
    assert.equal(parseHost("imsyy.top/"), "imsyy.top");
    assert.equal(parseHost("imsyy.top/foo"), "imsyy.top");
  });

  it("无法解析时返回 null", () => {
    assert.equal(parseHost(""), null);
    assert.equal(parseHost("   "), null);
    assert.equal(parseHost("http://"), null); // 空主机
  });

  it("注意：URL 把 'null' 当合法主机名 —— `Origin: null` 哨兵在 decideOrigin 层拦截", () => {
    assert.equal(parseHost("null"), "null");
  });
});

describe("hostMatches（子域名安全匹配）", () => {
  it("精确匹配与真子域命中", () => {
    assert.equal(hostMatches("imsyy.top", "imsyy.top"), true);
    assert.equal(hostMatches("www.imsyy.top", "imsyy.top"), true);
    assert.equal(hostMatches("a.b.imsyy.top", "imsyy.top"), true);
  });

  it("后缀相同但其实是别的域名 —— 不命中（旧实现的安全漏洞）", () => {
    assert.equal(hostMatches("evilimsyy.top", "imsyy.top"), false);
    assert.equal(hostMatches("imsyy.top.evil.com", "imsyy.top"), false);
  });
});

describe("decideOrigin", () => {
  const host = { allowedHost: "imsyy.top", allowedDomain: "*" };

  it("无 Origin（curl / 服务端 / 探活 / 预热）→ no-origin，放行", () => {
    assert.deepEqual(decideOrigin("", host), { kind: "no-origin" });
    assert.deepEqual(decideOrigin(undefined, host), { kind: "no-origin" });
    assert.deepEqual(decideOrigin(null, host), { kind: "no-origin" });
    assert.deepEqual(decideOrigin("   ", host), { kind: "no-origin" });
  });

  it("合法来源（同源 / 子域）→ 回显该 Origin", () => {
    assert.deepEqual(decideOrigin("https://imsyy.top", host), {
      kind: "allowed",
      value: "https://imsyy.top",
    });
    assert.deepEqual(decideOrigin("https://www.imsyy.top", host), {
      kind: "allowed",
      value: "https://www.imsyy.top",
    });
  });

  it("非法来源（含后缀相似的钓鱼域名）→ denied / not-in-allowlist", () => {
    assert.deepEqual(decideOrigin("https://evil.com", host), {
      kind: "denied",
      origin: "https://evil.com",
      reason: "not-in-allowlist",
    });
    // 关键安全回归：evilimsyy.top 不再被误放行
    assert.deepEqual(decideOrigin("https://evilimsyy.top", host), {
      kind: "denied",
      origin: "https://evilimsyy.top",
      reason: "not-in-allowlist",
    });
  });

  it("畸形 Origin → denied / malformed-origin", () => {
    assert.deepEqual(decideOrigin("null", host), {
      kind: "denied",
      origin: "null",
      reason: "malformed-origin",
    });
  });

  it("ALLOWED_HOST 优先于 ALLOWED_DOMAIN", () => {
    const d = decideOrigin("https://other.com", { allowedHost: "imsyy.top", allowedDomain: "*" });
    assert.equal(d.kind, "denied"); // 即便 domain 是 *，host 配了就以 host 为准
  });

  it("ALLOWED_HOST 配错（带协议）仍能容错匹配", () => {
    const opts = { allowedHost: "https://imsyy.top", allowedDomain: "" };
    assert.deepEqual(decideOrigin("https://www.imsyy.top", opts), {
      kind: "allowed",
      value: "https://www.imsyy.top",
    });
  });

  it("ALLOWED_HOST 配成无法解析的值 → denied / host-misconfigured", () => {
    const opts = { allowedHost: "://", allowedDomain: "*" };
    const d = decideOrigin("https://imsyy.top", opts);
    assert.equal(d.kind, "denied");
    assert.equal(d.kind === "denied" && d.reason, "host-misconfigured");
  });

  describe("回退 ALLOWED_DOMAIN（未配 ALLOWED_HOST）", () => {
    it("domain 为空或 * → 放开所有来源，回显具体 Origin", () => {
      for (const allowedDomain of ["", "*"]) {
        assert.deepEqual(decideOrigin("https://anything.example", { allowedHost: "", allowedDomain }), {
          kind: "allowed",
          value: "https://anything.example",
        });
        // 即便放开，无 Origin 依旧是 no-origin（不写 ACAO）
        assert.deepEqual(decideOrigin("", { allowedHost: "", allowedDomain }), { kind: "no-origin" });
      }
    });

    it("domain 指定具体来源 → 仅匹配项放行", () => {
      const opts = { allowedHost: "", allowedDomain: "https://app.example.com" };
      assert.equal(decideOrigin("https://app.example.com", opts).kind, "allowed");
      assert.equal(decideOrigin("https://evil.com", opts).kind, "denied");
    });

    it("domain 写成裸主机时按主机名（含子域）匹配", () => {
      const opts = { allowedHost: "", allowedDomain: "example.com" };
      assert.equal(decideOrigin("https://example.com", opts).kind, "allowed");
      assert.equal(decideOrigin("https://api.example.com", opts).kind, "allowed");
      assert.equal(decideOrigin("https://notexample.com", opts).kind, "denied");
    });
  });
});

describe("Hono CORS 集成（预检 / 无 Origin / 非法来源）", () => {
  const buildApp = (opts: { allowedHost: string; allowedDomain: string }) => {
    const app = new Hono();
    app.use(
      "*",
      cors({
        origin: (o) => {
          const d = decideOrigin(o, opts);
          return d.kind === "allowed" ? d.value : undefined;
        },
        allowMethods: ["GET", "HEAD", "POST", "OPTIONS"],
        allowHeaders: ["Content-Type", "Authorization"],
        credentials: true,
        maxAge: 600,
      }),
    );
    app.get("/", (c) => c.text("ok"));
    return app;
  };

  const opts = { allowedHost: "imsyy.top", allowedDomain: "*" };

  it("预检 OPTIONS（合法子域 + credentials）→ 204 且回显 Origin", async () => {
    const app = buildApp(opts);
    const res = await app.request("/", {
      method: "OPTIONS",
      headers: {
        Origin: "https://www.imsyy.top",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "Content-Type",
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get("access-control-allow-origin"), "https://www.imsyy.top");
    assert.equal(res.headers.get("access-control-allow-credentials"), "true");
    assert.ok(res.headers.get("access-control-allow-methods")?.includes("POST"));
  });

  it("无 Origin 的普通请求（curl / 探活）→ 200，且不写 ACAO（不影响直接访问）", async () => {
    const app = buildApp(opts);
    const res = await app.request("/");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
    assert.equal(res.headers.get("access-control-allow-origin"), null);
  });

  it("非法来源 → 接口照常 200，但不下发 ACAO（交由浏览器拦截，不把接口打挂）", async () => {
    const app = buildApp(opts);
    for (const bad of ["https://evil.com", "https://evilimsyy.top"]) {
      const res = await app.request("/", { headers: { Origin: bad } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("access-control-allow-origin"), null);
    }
  });
});
