/** 全局类型定义。Node 原生 TS 直跑，只能erasable语法：无 enum、无 namespace、无参数属性。 */

export type SourceRole =
  | 'media' // 垂媒 / 综合资讯
  | 'community' // 社区热榜
  | 'overseas' // 海外一线
  | 'platform' // 平台与厂商
  | 'signal' // 引进信号
  | 'internal'; // TapTap 站内

export type SourceType = 'rss' | 'json' | 'html';

export interface Source {
  id: string;
  name: string;
  role: SourceRole;
  region: 'cn' | 'global';
  type: SourceType;
  url: string;
  /**
   * 3 = 一手（官方公告、平台接口）
   * 2 = 准一手（官方社媒、垂媒一手报道）
   * 1 = 二手（转载、聚合、热榜）
   * 一手源在打分门槛上放宽，二手源收紧。
   */
  tier: 1 | 2 | 3;
  enabled: boolean;
  /** 抓取间隔（分钟）。产出少的源自动拉长见 collector/adapt.ts */
  intervalMin: number;
  headers?: Record<string, string>;
  /** JSON / HTML 适配器配置 */
  adapter?: Record<string, unknown>;
  note?: string;
}

/** 抓下来的原始条目，未打分、未聚簇。 */
export interface RawItem {
  sourceId: string;
  url: string;
  title: string;
  /** 摘要 / 正文片段 */
  summary?: string;
  image?: string;
  author?: string;
  /** ISO8601 带时区。拿不到真实发布时间的源会是 null —— 这类条目必须降级处理 */
  publishedAt?: string | null;
  lang?: 'zh' | 'en' | 'ja' | 'other';
  /** 热度原值，如 { rank: 3, hot: 1200000, comments: 88 } */
  heat?: Record<string, number> | null;
  /** 热榜条目没有原文链接时，记录话题名以便二次检索 */
  topicOnly?: boolean;
}

/** 媒体来源视角下，一条内容属于哪条雷达。 */
export type Radar = 'topic' | 'game';

export interface AxisScore {
  /** 轴名，见 prompts/radar-*.md */
  key: string;
  score: number; // 1-5
  why: string;
}

export interface ItemScore {
  radar: Radar;
  total: number; // 0-100
  axes: AxisScore[];
  /** 一句话结论：为什么值得/不值得看 */
  verdict: string;
  /** 选题雷达：可用的选题角度（标题候选 + 切入点） */
  angle?: string;
  /** 作品雷达：识别出的作品名 */
  games?: string[];
  /** 反方理由，防止一边倒 */
  against?: string;
  model: string;
  scoredAt: string;
}

export interface CallCost {
  promptTokens: number;
  completionTokens: number;
  calls: number;
}
