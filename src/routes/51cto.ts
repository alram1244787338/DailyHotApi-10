import type { RouterData, RouterResType } from "../types.js";
import { getToken, sign } from "../utils/getToken/51cto.js";
import { get } from "../utils/getData.js";
import { getTime } from "../utils/getTime.js";

export const handleRoute = async (_: undefined, noCache: boolean) => {
  const listData = await getList(noCache);
  const routeData: RouterData = {
    name: "51cto",
    title: "51CTO",
    type: "推荐榜",
    link: "https://www.51cto.com/",
    total: listData.data?.length || 0,
    ...listData,
  };
  return routeData;
};

interface CtoItem {
  source_id: string;
  title: string;
  cover: string;
  abstract: string;
  pubdate: string;
  url: string;
}

interface CtoResponse {
  data: {
    data: {
      list: CtoItem[];
    };
  };
}

const getList = async (noCache: boolean): Promise<RouterResType> => {
  const url = `https://api-media.51cto.com/index/index/recommend`;
  const params = {
    page: 1,
    page_size: 50,
    limit_time: 0,
    name_en: "",
  };
  const timestamp = Date.now();
  const token = (await getToken()) as string;
  const result = await get<CtoResponse>({
    url,
    // timestamp / token / sign 每次请求都不同（且 sign 由 timestamp 派生），但不影响返回内容，
    // 响应只由分页等业务参数决定，故用业务参数构成的稳定逻辑键，避免缓存永不命中。
    cacheKey: `51cto:recommend:p${params.page}:s${params.page_size}`,
    params: {
      ...params,
      timestamp,
      token,
      sign: sign("index/index/recommend", params, timestamp, token),
    },
    noCache,
  });
  const list = result.data.data.data.list;
  return {
    ...result,
    data: list.map((v) => ({
      id: v.source_id,
      title: v.title,
      cover: v.cover,
      desc: v.abstract,
      timestamp: getTime(v.pubdate),
      hot: undefined,
      url: v.url,
      mobileUrl: v.url,
    })),
  };
};
