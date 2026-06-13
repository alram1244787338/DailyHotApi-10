import type { Context } from "hono";
import type { ResponseType } from "axios";

// Context
export type ListContext = Context;

// 榜单数据
export interface ListItem {
  id: number | string;
  title: string;
  cover?: string;
  author?: string;
  desc?: string;
  hot: number | undefined;
  timestamp: number | undefined;
  url: string;
  mobileUrl: string;
}

// 路由接口数据
export interface RouterResType {
  updateTime: string | number;
  fromCache: boolean;
  data: ListItem[];
  message?: string;
}

// 路由数据
export interface RouterData extends RouterResType {
  name: string;
  title: string;
  type: string;
  description?: string;
  params?: Record<string, string | object>;
  total: number;
  link?: string;
}

// 请求类型
export interface Get {
  url: string;
  headers?: Record<string, string | string[]>;
  params?: Record<string, string | number>;
  timeout?: number;
  noCache?: boolean;
  ttl?: number;
  originaInfo?: boolean;
  responseType?: ResponseType;
  /**
   * 自定义缓存键（逻辑键）。
   * 当请求中包含时间戳、签名等“每次都不同但并不影响响应内容”的参数时，
   * 默认会把这些参数也算进缓存键，导致缓存永远命中不了。
   * 这种情况下可由调用方显式指定一个稳定的逻辑键（需保证它能区分所有会影响响应的变量）。
   */
  cacheKey?: string;
}

export interface Post {
  url: string;
  headers?: Record<string, string | string[]>;
  body?: string | object | Buffer | undefined;
  timeout?: number;
  noCache?: boolean;
  ttl?: number;
  originaInfo?: boolean;
  /**
   * 自定义缓存键（逻辑键），含义同 {@link Get.cacheKey}。
   * 适用于请求体里带时间戳/签名等易变字段的接口。
   */
  cacheKey?: string;
}

// 参数类型
export interface Options {
  [key: string]: string | number | undefined;
}
