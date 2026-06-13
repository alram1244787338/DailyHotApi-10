import { Hono } from "hono";
import { config } from "./config.js";
import { serveStatic } from "@hono/node-server/serve-static";
import { compress } from "hono/compress";
import { prettyJSON } from "hono/pretty-json";
import { trimTrailingSlash } from "hono/trailing-slash";
import logger from "./utils/logger.js";
import { getCorsHeaders, validateCorsOrigin } from "./utils/cors.js";
import registry from "./registry.js";
import robotstxt from "./robots.txt.js";
import NotFound from "./views/NotFound.js";
import Home from "./views/Home.js";
import Error from "./views/Error.js";

const app = new Hono();

// 压缩响应
app.use(compress());

// prettyJSON
app.use(prettyJSON());

// 尾部斜杠重定向
app.use(trimTrailingSlash());

// 自定义 CORS 中间件
app.use("*", async (c, next) => {
  const origin = c.req.header("Origin");
  const host = c.req.header("Host");
  const method = c.req.method;

  // 验证来源
  const validation = validateCorsOrigin(origin, host);

  // 记录 CORS 验证结果（仅对非空 Origin 记录详细信息）
  if (origin) {
    if (validation.allowed) {
      logger.debug(`✓ [CORS] ${validation.reason} | Origin: ${origin}`);
    } else {
      logger.warn(`✗ [CORS] ${validation.reason} | Method: ${method}`);
    }
  }

  // 获取 CORS 响应头
  const corsHeaders = getCorsHeaders(origin, host);

  // 设置 CORS 头
  Object.entries(corsHeaders).forEach(([key, value]) => {
    c.header(key, value);
  });

  // 处理预检请求（OPTIONS）
  if (method === "OPTIONS") {
    if (validation.allowed) {
      logger.debug(`✓ [CORS] Preflight request allowed | Origin: ${origin || "none"}`);
      return c.body(null, 204);
    } else {
      logger.warn(`✗ [CORS] Preflight request denied | Origin: ${origin}`);
      return c.text("CORS origin not allowed", 403);
    }
  }

  // 如果来源不合法，拒绝请求
  if (!validation.allowed && origin) {
    logger.error(
      `❌ [CORS] Request denied | Origin: ${origin} | Path: ${c.req.path} | Method: ${method}`,
    );
    return c.json(
      {
        code: 403,
        message: "CORS origin not allowed",
        origin: origin,
        allowedHost: config.ALLOWED_HOST,
      },
      403,
    );
  }

  await next();
});

// 静态资源
app.use(
  "/*",
  serveStatic({
    root: "./public",
    rewriteRequestPath: (path) => (path === "/favicon.ico" ? "/favicon.png" : path),
  }),
);

// 主路由
app.route("/", registry);

// robots
app.get("/robots.txt", robotstxt);
// 首页
app.get("/", (c) => c.html(<Home />));
// 404
app.notFound((c) => c.html(<NotFound />, 404));
// error
app.onError((err, c) => {
  logger.error(`❌ [ERROR] ${err?.message}`);
  return c.html(<Error error={err?.message} />, 500);
});

export default app;
