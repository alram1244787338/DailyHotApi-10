import type { RouterData, ListContext, Options } from "../types.js";
import { load } from "cheerio";
import { get } from "../utils/getData.js";
import { getCurrentDateTime } from "../utils/getTime.js";

export const handleRoute = async (c: ListContext, noCache: boolean) => {
  // 获取日期
  const day = c.req.query("day") || getCurrentDateTime(true).day;
  const month = c.req.query("month") || getCurrentDateTime(true).month;
  const listData = await getList({ month, day }, noCache);
  const routeData: RouterData = {
    name: "history",
    title: "历史上的今天",
    type: `${month}-${day}`,
    params: {
      month: "月份",
      day: "日期",
    },
    link: "https://baike.baidu.com/calendar",
    total: listData.data?.length || 0,
    ...listData,
  };
  return routeData;
};

interface HistoryItem {
  title: string;
  cover: string;
  pic_share: string;
  desc: string;
  year: string;
  link: string;
}

interface HistoryResponse {
  [month: string]: {
    [monthDay: string]: HistoryItem[];
  };
}

const getList = async (options: Options, noCache: boolean) => {
  const { month, day } = options;
  const monthStr = month?.toString().padStart(2, "0");
  const dayStr = day?.toString().padStart(2, "0");
  const url = `https://baike.baidu.com/cms/home/eventsOnHistory/${monthStr}.json`;
  const result = await get<HistoryResponse>({
    url,
    noCache,
    // 接口数据按“月”聚合（日期是在拿到整月数据后再筛选），且 params 里的 _ 只是给上游 CDN 的
    // 防缓存时间戳、并不影响返回内容。因此用按月的稳定逻辑键，避免每次时间戳不同导致本地缓存永不命中。
    cacheKey: `history:${monthStr}`,
    params: {
      _: new Date().getTime(),
    },
  });
  const list = monthStr ? result.data[monthStr][monthStr + dayStr] : [];
  return {
    ...result,
    data: list.map((v, index: number) => ({
      id: index,
      title: load(v.title).text().trim(),
      cover: v.cover ? v.pic_share : undefined,
      desc: load(v.desc).text().trim(),
      year: v.year,
      timestamp: undefined,
      hot: undefined,
      url: v.link,
      mobileUrl: v.link,
    })),
  };
};
