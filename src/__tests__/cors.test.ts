/**
 * CORS 测试脚本
 *
 * 运行方式：
 * 1. 先启动服务：npm run dev
 * 2. 运行测试：npx tsx src/__tests__/cors.test.ts
 */

const BASE_URL = "http://localhost:6688";

interface TestCase {
  name: string;
  method?: string;
  headers?: Record<string, string>;
  expectedStatus: number;
  expectedCorsHeader?: string;
  description: string;
}

const testCases: TestCase[] = [
  {
    name: "无 Origin 头（curl/服务端调用）",
    method: "GET",
    headers: {},
    expectedStatus: 200,
    expectedCorsHeader: undefined,
    description: "应该正常返回，不设置 CORS 头",
  },
  {
    name: "预检请求（OPTIONS）无 Origin",
    method: "OPTIONS",
    headers: {},
    expectedStatus: 204,
    expectedCorsHeader: undefined,
    description: "应该返回 204，允许预检",
  },
  {
    name: "合法 Origin（ALLOWED_DOMAIN=*）",
    method: "GET",
    headers: { Origin: "https://example.com" },
    expectedStatus: 200,
    expectedCorsHeader: "*",
    description: "应该返回 Access-Control-Allow-Origin: *",
  },
  {
    name: "预检请求（OPTIONS）合法 Origin",
    method: "OPTIONS",
    headers: {
      Origin: "https://example.com",
      "Access-Control-Request-Method": "POST",
    },
    expectedStatus: 204,
    expectedCorsHeader: "*",
    description: "应该返回 204 和 CORS 头",
  },
  {
    name: "同源请求",
    method: "GET",
    headers: {
      Origin: "http://localhost:6688",
      Host: "localhost:6688",
    },
    expectedStatus: 200,
    expectedCorsHeader: "http://localhost:6688",
    description: "应该允许同源请求",
  },
];

async function runTest(test: TestCase): Promise<boolean> {
  try {
    const response = await fetch(`${BASE_URL}/`, {
      method: test.method || "GET",
      headers: test.headers || {},
    });

    const corsHeader = response.headers.get("Access-Control-Allow-Origin");
    const statusMatch = response.status === test.expectedStatus;
    const corsMatch = corsHeader === test.expectedCorsHeader;

    const passed = statusMatch && corsMatch;

    console.log(`\n${passed ? "✓" : "✗"} ${test.name}`);
    console.log(`  描述: ${test.description}`);
    console.log(`  状态码: ${response.status} (期望: ${test.expectedStatus}) ${statusMatch ? "✓" : "✗"}`);
    console.log(`  CORS 头: ${corsHeader} (期望: ${test.expectedCorsHeader}) ${corsMatch ? "✓" : "✗"}`);

    return passed;
  } catch (error) {
    console.log(`\n✗ ${test.name}`);
    console.log(`  错误: ${error}`);
    return false;
  }
}

async function main() {
  console.log("🧪 CORS 测试开始");
  console.log(`📡 测试目标: ${BASE_URL}`);

  let passed = 0;
  let failed = 0;

  for (const test of testCases) {
    const result = await runTest(test);
    if (result) {
      passed++;
    } else {
      failed++;
    }
  }

  console.log(`\n📊 测试结果: ${passed} 通过, ${failed} 失败`);

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("测试执行失败:", error);
  process.exit(1);
});
