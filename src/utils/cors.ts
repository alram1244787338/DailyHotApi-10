import { config } from "../config.js";
import logger from "./logger.js";

/**
 * CORS 来源判定
 *
 * 入口的跨域判断不能想当然：
 *  - 很多请求根本没有 Origin（curl、服务端调用、健康探活、定时预热、部分代理转发），
 *    对它们来说不存在“跨域”，应直接放行且不写 Access-Control-Allow-Origin。
 *  - 旧实现用 `origin.endsWith(ALLOWED_HOST)` 判断，会把 `https://evilimsyy.top`
 *    这类“后缀相同但其实是别的域名”的来源误判为合法，存在安全隐患。
 *  - `credentials: true` 时回显字面量 `*` 会被浏览器拒绝，需要回显具体 Origin。
 *
 * 这里把判定逻辑做成纯函数（decideOrigin / parseHost / hostMatches），方便单测，
 * 真正接入 Hono 的副作用（读 config、打日志）收敛在 resolveCorsOrigin。
 */

/**
 * 从一个 Origin 头或配置值里解析出纯主机名（小写）。
 * 兼容：带协议的完整 Origin（https://imsyy.top:443）、裸主机（imsyy.top）、
 * 误带的路径/端口/尾斜杠等。无法解析时返回 null。
 */
export const parseHost = (value: string): string | null => {
  const v = (value ?? "").trim();
  if (!v) return null;
  try {
    // 已带协议则直接解析，否则补一个协议再交给 URL 解析
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v);
    const url = new URL(hasScheme ? v : `https://${v}`);
    const host = url.hostname.toLowerCase();
    return host || null;
  } catch {
    return null;
  }
};

/**
 * 子域名安全匹配：origin 主机等于 allowed，或是其真子域（结尾为 `.allowed`）。
 * 这样 `www.imsyy.top` 命中 `imsyy.top`，而 `evilimsyy.top` 不会命中。
 */
export const hostMatches = (originHost: string, allowedHost: string): boolean =>
  originHost === allowedHost || originHost.endsWith(`.${allowedHost}`);

/**
 * 规范化 ALLOWED_HOST。
 * 返回 host 为空表示“未配置”（含空串 / `*`）；invalid 为 true 表示“配置了但格式不对”。
 */
const normalizeAllowedHost = (raw: string): { host: string; invalid: boolean } => {
  const v = (raw ?? "").trim();
  if (!v || v === "*") return { host: "", invalid: false };
  const host = parseHost(v);
  if (!host || host === "*") return { host: "", invalid: true };
  return { host, invalid: false };
};

/** 来源判定结果 */
export type OriginDecision =
  | { kind: "no-origin" }
  | { kind: "allowed"; value: string }
  | {
      kind: "denied";
      origin: string;
      reason: "not-in-allowlist" | "malformed-origin" | "host-misconfigured";
    };

/**
 * 纯函数：给定原始 Origin 头与配置，给出该如何处理。
 *
 * 口径（对应各类来源）：
 *  - 空来源（无 Origin 头）        → no-origin（放行、不写 ACAO）
 *  - 同源 / 合法子域名 / 命中白名单 → allowed（回显该 Origin）
 *  - 非法来源 / 配置无法匹配        → denied（不写 ACAO，浏览器自行拦截）
 *
 * 优先级：配置了 ALLOWED_HOST 就以它为准（与 .env 注释一致：填写后忽略 ALLOWED_DOMAIN）；
 * ALLOWED_HOST 未配置时回退 ALLOWED_DOMAIN；ALLOWED_HOST 配错则保守拒绝跨域（fail closed）。
 */
export const decideOrigin = (
  rawOrigin: string | undefined | null,
  opts: { allowedHost: string; allowedDomain: string },
): OriginDecision => {
  const origin = (rawOrigin ?? "").trim();
  // 1. 没有 Origin：curl / 服务端调用 / 探活 / 预热，本就不是跨域请求
  if (!origin) return { kind: "no-origin" };

  // 2. `Origin: null` 是特殊哨兵（沙箱 iframe / file:// / 跨站重定向），
  //    带 credentials 时回显 null 不安全（多个无关上下文共享该来源），一律拒绝
  if (origin.toLowerCase() === "null") return { kind: "denied", origin, reason: "malformed-origin" };

  // 3. 有 Origin 但解析不出主机：畸形来源，拒绝
  const originHost = parseHost(origin);
  if (!originHost) return { kind: "denied", origin, reason: "malformed-origin" };

  const { host: allowedHost, invalid: hostInvalid } = normalizeAllowedHost(opts.allowedHost);

  // 4. ALLOWED_HOST 优先
  if (allowedHost) {
    return hostMatches(originHost, allowedHost)
      ? { kind: "allowed", value: origin }
      : { kind: "denied", origin, reason: "not-in-allowlist" };
  }
  // 4b. ALLOWED_HOST 配了但格式不对：属于配置问题，保守拒绝并在日志里点明
  if (hostInvalid) {
    return { kind: "denied", origin, reason: "host-misconfigured" };
  }

  // 5. 回退 ALLOWED_DOMAIN
  const domain = (opts.allowedDomain ?? "").trim();
  // 5a. 未配置或 `*`：放开所有来源，但回显具体 Origin（而非字面量 *），保证 credentials 合法
  if (!domain || domain === "*") {
    return { kind: "allowed", value: origin };
  }
  // 5b. 指定了具体来源：支持“完整 Origin 全等”或“主机名（含子域）匹配”两种写法
  if (origin === domain) return { kind: "allowed", value: origin };
  const domainHost = parseHost(domain);
  if (domainHost && hostMatches(originHost, domainHost)) {
    return { kind: "allowed", value: origin };
  }
  return { kind: "denied", origin, reason: "not-in-allowlist" };
};

/**
 * 接入 Hono `cors({ origin })` 的适配器：读取全局 config，返回应写入
 * Access-Control-Allow-Origin 的值；返回 null 表示不写该头（放行或交由浏览器拦截）。
 *
 * 日志按三类问题分别落地，方便线上定位：来源不合法 / 配置有问题 / 请求没带 Origin。
 */
export const resolveCorsOrigin = (rawOrigin: string): string | null => {
  const decision = decideOrigin(rawOrigin, {
    allowedHost: config.ALLOWED_HOST,
    allowedDomain: config.ALLOWED_DOMAIN,
  });

  switch (decision.kind) {
    case "no-origin":
      // 非跨域请求（curl / 服务端 / 探活 / 预热）：放行，不写 ACAO。debug 级别避免刷屏
      logger.debug("🌐 [CORS] 请求未携带 Origin，按非跨域请求放行");
      return null;
    case "allowed":
      return decision.value;
    case "denied":
      if (decision.reason === "host-misconfigured") {
        logger.warn(
          `🌐 [CORS] 配置问题：ALLOWED_HOST='${config.ALLOWED_HOST}' 格式无效（应形如 imsyy.top），已拒绝来源 ${decision.origin}`,
        );
      } else if (decision.reason === "malformed-origin") {
        logger.warn(`🌐 [CORS] 非法来源：收到无法解析的 Origin '${decision.origin}'，已拒绝`);
      } else {
        logger.warn(`🌐 [CORS] 非法来源：${decision.origin} 不在允许列表，已拒绝`);
      }
      return null;
  }
};

/**
 * 启动时校验一次 CORS 配置，把“配置层面”的问题尽早暴露在日志里，
 * 避免线上等到请求被拒才发现 env 配错。
 */
export const validateCorsConfig = (): void => {
  const { host, invalid } = normalizeAllowedHost(config.ALLOWED_HOST);
  const domain = (config.ALLOWED_DOMAIN ?? "").trim();

  if (invalid) {
    logger.warn(
      `🌐 [CORS] 配置问题：ALLOWED_HOST='${config.ALLOWED_HOST}' 格式可能有误（应形如 imsyy.top），跨域请求将一律被拒绝，请修正后重启`,
    );
    return;
  }
  if (host) {
    logger.info(`🌐 [CORS] 允许来源：${host} 及其子域`);
  } else if (!domain || domain === "*") {
    logger.info("🌐 [CORS] 未配置来源白名单（ALLOWED_HOST / ALLOWED_DOMAIN 均为空或 *），将回显任意 Origin");
  } else {
    logger.info(`🌐 [CORS] 允许来源：${domain}`);
  }
};
