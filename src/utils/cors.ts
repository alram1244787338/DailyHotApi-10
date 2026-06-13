import { config } from "../config.js";
import logger from "./logger.js";

/**
 * CORS 来源验证结果
 */
export interface CorsValidationResult {
  allowed: boolean;
  origin: string | null;
  reason: string;
}

/**
 * 验证 CORS 来源是否合法
 *
 * @param origin 请求的 Origin 头
 * @param host 请求的 Host 头（用于同源判断）
 * @returns 验证结果
 */
export function validateCorsOrigin(
  origin: string | undefined | null,
  host?: string | null,
): CorsValidationResult {
  // 1. 没有 Origin 头的情况（curl、服务端调用、健康检查、定时任务等）
  if (!origin || origin.trim() === "") {
    return {
      allowed: true,
      origin: null,
      reason: "No origin header (non-browser request)",
    };
  }

  // 2. ALLOWED_DOMAIN 为 "*" 时，允许所有来源
  if (config.ALLOWED_DOMAIN === "*") {
    return {
      allowed: true,
      origin,
      reason: "All origins allowed (ALLOWED_DOMAIN=*)",
    };
  }

  // 3. 检查是否同源
  if (host && origin) {
    try {
      const originUrl = new URL(origin);
      const originHost = originUrl.host;

      // 完全同源
      if (originHost === host) {
        return {
          allowed: true,
          origin,
          reason: "Same origin",
        };
      }
    } catch (e) {
      logger.warn(`⚠️  [CORS] Invalid origin format: ${origin}`);
    }
  }

  // 4. 检查 ALLOWED_HOST（子域名匹配）
  if (config.ALLOWED_HOST && config.ALLOWED_HOST.trim() !== "") {
    try {
      const originUrl = new URL(origin);
      const originHost = originUrl.hostname;
      const allowedHost = config.ALLOWED_HOST.trim();

      // 完全匹配
      if (originHost === allowedHost) {
        return {
          allowed: true,
          origin,
          reason: `Matches ALLOWED_HOST: ${allowedHost}`,
        };
      }

      // 子域名匹配（例如：api.imsyy.top 匹配 imsyy.top）
      if (originHost.endsWith(`.${allowedHost}`)) {
        return {
          allowed: true,
          origin,
          reason: `Subdomain of ALLOWED_HOST: ${allowedHost}`,
        };
      }
    } catch (e) {
      logger.warn(`⚠️  [CORS] Failed to parse origin: ${origin}`);
      return {
        allowed: false,
        origin,
        reason: `Invalid origin format: ${origin}`,
      };
    }
  }

  // 5. 检查 ALLOWED_DOMAIN（精确匹配）
  if (config.ALLOWED_DOMAIN && config.ALLOWED_DOMAIN.trim() !== "") {
    const allowedDomain = config.ALLOWED_DOMAIN.trim();

    // 支持多个域名，用逗号分隔
    const allowedDomains = allowedDomain.split(",").map((d) => d.trim());

    if (allowedDomains.includes(origin)) {
      return {
        allowed: true,
        origin,
        reason: `Matches ALLOWED_DOMAIN: ${allowedDomain}`,
      };
    }
  }

  // 6. 不合法的来源
  logger.warn(
    `⚠️  [CORS] Origin not allowed: ${origin} | ALLOWED_HOST=${config.ALLOWED_HOST} | ALLOWED_DOMAIN=${config.ALLOWED_DOMAIN}`,
  );

  return {
    allowed: false,
    origin,
    reason: `Origin not allowed: ${origin}`,
  };
}

/**
 * 获取 CORS 响应头
 */
export function getCorsHeaders(
  origin: string | undefined | null,
  host?: string | null,
): Record<string, string> {
  const validation = validateCorsOrigin(origin, host);

  if (!validation.allowed) {
    return {};
  }

  const headers: Record<string, string> = {};

  // 如果来源合法且不是 "*"，设置具体的 Origin
  if (validation.origin) {
    headers["Access-Control-Allow-Origin"] = validation.origin;
  } else if (config.ALLOWED_DOMAIN === "*") {
    headers["Access-Control-Allow-Origin"] = "*";
  }

  // 允许的方法
  headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, DELETE, OPTIONS";

  // 允许的头
  headers["Access-Control-Allow-Headers"] =
    "Content-Type, Authorization, X-Custom-Header, Upgrade-Insecure-Requests";

  // 允许携带凭证
  headers["Access-Control-Allow-Credentials"] = "true";

  // 预检请求缓存时间（秒）
  headers["Access-Control-Max-Age"] = "86400";

  return headers;
}
