/**
 * CORS 工具函数单元测试
 *
 * 运行方式：npx tsx src/__tests__/cors-unit.test.ts
 */

import { validateCorsOrigin } from "../utils/cors.js";
import { config } from "../config.js";

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

function test(name: string, fn: () => void) {
  try {
    fn();
    results.push({ name, passed: true, details: "" });
  } catch (error) {
    results.push({
      name,
      passed: false,
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}

console.log("🧪 CORS 单元测试开始");
console.log(`📋 当前配置: ALLOWED_DOMAIN=${config.ALLOWED_DOMAIN}, ALLOWED_HOST=${config.ALLOWED_HOST}`);

// 测试 1: 无 Origin 头
test("无 Origin 头应该允许", () => {
  const result = validateCorsOrigin(undefined);
  assert(result.allowed === true, "应该允许无 Origin 的请求");
  assert(result.origin === null, "origin 应该是 null");
});

test("空字符串 Origin 应该允许", () => {
  const result = validateCorsOrigin("");
  assert(result.allowed === true, "应该允许空 Origin");
  assert(result.origin === null, "origin 应该是 null");
});

test("空白字符串 Origin 应该允许", () => {
  const result = validateCorsOrigin("   ");
  assert(result.allowed === true, "应该允许空白 Origin");
  assert(result.origin === null, "origin 应该是 null");
});

// 测试 2: ALLOWED_DOMAIN 为 "*"
if (config.ALLOWED_DOMAIN === "*") {
  test("ALLOWED_DOMAIN=* 时任意 Origin 应该允许", () => {
    const result = validateCorsOrigin("https://example.com");
    assert(result.allowed === true, "应该允许任意 Origin");
    assert(result.origin === "https://example.com", "应该返回原始 origin");
    assert(result.reason.includes("All origins allowed"), "应该标记为全部允许");
  });
}

// 测试 3: 同源请求（当 ALLOWED_DOMAIN 不是 "*" 时）
test("同源请求应该允许（临时设置 ALLOWED_DOMAIN）", () => {
  const originalDomain = config.ALLOWED_DOMAIN;
  config.ALLOWED_DOMAIN = "";

  const result = validateCorsOrigin(
    "http://localhost:6688",
    "localhost:6688"
  );
  assert(result.allowed === true, "应该允许同源请求");
  assert(result.reason.includes("Same origin"), "应该标记为同源");

  config.ALLOWED_DOMAIN = originalDomain;
});

// 测试 4: ALLOWED_HOST 匹配（当 ALLOWED_DOMAIN 不是 "*" 时）
test("完全匹配 ALLOWED_HOST 应该允许（临时设置 ALLOWED_DOMAIN）", () => {
  const originalDomain = config.ALLOWED_DOMAIN;
  const originalHost = config.ALLOWED_HOST;

  config.ALLOWED_DOMAIN = "";
  config.ALLOWED_HOST = "example.com";

  const result = validateCorsOrigin(`https://example.com`);
  assert(result.allowed === true, "应该允许完全匹配的域名");
  assert(
    result.reason.includes("Matches ALLOWED_HOST"),
    "应该标记为匹配 ALLOWED_HOST"
  );

  config.ALLOWED_DOMAIN = originalDomain;
  config.ALLOWED_HOST = originalHost;
});

test("子域名匹配 ALLOWED_HOST 应该允许（临时设置 ALLOWED_DOMAIN）", () => {
  const originalDomain = config.ALLOWED_DOMAIN;
  const originalHost = config.ALLOWED_HOST;

  config.ALLOWED_DOMAIN = "";
  config.ALLOWED_HOST = "example.com";

  const result = validateCorsOrigin(`https://api.example.com`);
  assert(result.allowed === true, "应该允许子域名");
  assert(
    result.reason.includes("Subdomain"),
    "应该标记为子域名匹配"
  );

  config.ALLOWED_DOMAIN = originalDomain;
  config.ALLOWED_HOST = originalHost;
});

// 测试 5: 非法 Origin
test("非法 Origin 应该拒绝", () => {
  // 临时修改配置来测试
  const originalDomain = config.ALLOWED_DOMAIN;
  const originalHost = config.ALLOWED_HOST;

  config.ALLOWED_DOMAIN = "https://allowed.com";
  config.ALLOWED_HOST = "";

  const result = validateCorsOrigin("https://evil.com");
  assert(result.allowed === false, "应该拒绝非法 Origin");

  // 恢复配置
  config.ALLOWED_DOMAIN = originalDomain;
  config.ALLOWED_HOST = originalHost;
});

// 测试 6: 无效的 Origin 格式（当 ALLOWED_DOMAIN 不是 "*" 时）
test("无效的 Origin 格式应该拒绝（临时设置 ALLOWED_DOMAIN）", () => {
  const originalDomain = config.ALLOWED_DOMAIN;
  const originalHost = config.ALLOWED_HOST;

  config.ALLOWED_DOMAIN = "";
  config.ALLOWED_HOST = "example.com";

  const result = validateCorsOrigin("not-a-valid-url");
  assert(result.allowed === false, "应该拒绝无效的 URL");
  assert(
    result.reason.includes("Invalid origin format"),
    "应该标记为无效格式"
  );

  config.ALLOWED_DOMAIN = originalDomain;
  config.ALLOWED_HOST = originalHost;
});

// 输出结果
console.log("\n📊 测试结果:\n");
let passed = 0;
let failed = 0;

results.forEach((result) => {
  if (result.passed) {
    console.log(`  ✓ ${result.name}`);
    passed++;
  } else {
    console.log(`  ✗ ${result.name}`);
    console.log(`    ${result.details}`);
    failed++;
  }
});

console.log(`\n总计: ${passed} 通过, ${failed} 失败`);

if (failed > 0) {
  process.exit(1);
}
