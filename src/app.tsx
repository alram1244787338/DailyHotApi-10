import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "@hono/node-server/serve-static";
import { compress } from "hono/compress";
import { prettyJSON } from "hono/pretty-json";
import { trimTrailingSlash } from "hono/trailing-slash";
import logger from "./utils/logger.js";
import { resolveCorsOrigin, validateCorsConfig } from "./utils/cors.js";
import registry from "./registry.js";
import robotstxt from "./robots.txt.js";
import NotFound from "./views/NotFound.js";
import Home from "./views/Home.js";
import Error from "./views/Error.js";

const app = new Hono();

// 启动时校验一次 CORS 配置，尽早暴露 env 配错
validateCorsConfig();

// 压缩响应
app.use(compress());

// prettyJSON
app.use(prettyJSON());

// 尾部斜杠重定向
app.use(trimTrailingSlash());

// CORS
app.use(
  "*",
  cors({
    // 来源判定收敛在 resolveCorsOrigin：无 Origin 放行、合法来源回显、非法来源拒绝
    origin: (origin) => resolveCorsOrigin(origin),
    allowMethods: ["GET", "HEAD", "POST", "OPTIONS"],
    // 覆盖常见请求头，避免带这些头的预检（OPTIONS）被拦
    allowHeaders: ["Content-Type", "Authorization", "X-Custom-Header", "Upgrade-Insecure-Requests"],
    exposeHeaders: ["Content-Length"],
    // 预检结果缓存 10 分钟，减少 OPTIONS 往返
    maxAge: 600,
    credentials: true,
  }),
);

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
