# cn-community —— 中文社区热榜 + TapTap 站内（探测结论文档）

> 机器可读契约：[cn-community.json](./cn-community.json) ｜ 可重跑脚本：[../probes/cn-community.mjs](../probes/cn-community.mjs)
> 实测时间：**2026-10-23 11:48 (+08:00)** ｜ 12 个源全部 `verified: true` ｜ 1 个源进 rejected（小黑盒）
> 一次全量探测 = 16 次请求 / 6.4 秒，同域名串行间隔 ≥1.1s。

---

## 0. 一句话结论

**除了小黑盒，全部热榜都能在「不登录、不签名」的前提下抓到**，而且三个原本预判会死的源（**抖音、小红书、B站分区榜**）实测结论都反过来了：

| 预判 | 实测 | 关键差别 |
|---|---|---|
| 小黑盒「可能需要签名」 | ❌ 真的需要签名 | HMAC-SHA256，密钥内联在前端 bundle，无法绕过 |
| 抖音「大概率失败」 | ✅ **能抓，不需要签名** | `aweme/v1/web/hot/search/list` 这个 web 入口居然不校验 `a_bogus` |
| 小红书「大概率失败」 | ✅ **能抓** | 失败的是内部 API（需 `x-s`），但 `/explore` 带 `Accept-Language: zh-CN` 会返回 SSR 数据 |
| B站「可能需要 cookie」 | ⚠️ **要 buvid3，但不用登录** | 从公开 `finger/spi` 领 `b_3` 即可，不是用户 cookie |
| B站游戏区 rid=4 | ⚠️ 能抓但**榜单冻结** | 96 条全是 2025-03/04 的内容，不能当雷达用 |

---

## 1. 总表

| id | 源 | role | type | 条数 | 热值 | 原文链接 | 时间戳 | 进第一版 |
|---|---|---|---|---|---|---|---|---|
| `taptap-reserve` | TapTap 预约榜 | internal | json | 10/页（total 150） | ✅ 预约数 | ✅ 站内 | ❌ | ✅ **最高优先** |
| `taptap-hot` | TapTap 热门榜 | internal | json | 10/页（total 150） | ✅ 人气 | ✅ 站内 | ❌ | ✅ **最高优先** |
| `taptap-pop` | TapTap 热玩榜 | internal | json | 10/页（total 150） | ✅ 人气 | ✅ 站内 | ❌ | ✅ 推荐 |
| `bilibili-ranking` | B站全站排行 | community | json | 100 | ✅ 播放量 | ✅ bvid | ✅ pubdate | ✅ 推荐 |
| `bilibili-game-filter` | B站游戏（全站榜过滤） | community | json | 17 | ✅ 播放量 | ✅ bvid | ✅ pubdate | ✅ 推荐 |
| `zhihu-hot` | 知乎热榜 | community | json | 30 | ✅「万热度」 | ✅ 问题页 | ⚠️ 问题创建时间 | ✅ 推荐 |
| `douyin-hot` | 抖音热点榜 | community | json | 49 | ✅ hot_value | ❌ 只有词 | ✅ event_time | ✅ 推荐 |
| `weibo-hotsearch` | 微博热搜 | community | json | 52 | ✅ num | ❌ 只有词 | ❌ | ✅ 可进 |
| `baidu-hot` | 百度热搜 | community | html | 51 | ✅ hotScore | ❌ 搜索跳转 | ❌ | ✅ 可进（摘要很好） |
| `tieba-hottopic` | 贴吧热议话题 | community | html | 30 | ✅ 实时讨论数 | ❌ 话题聚合页 | ❌ | ✅ 可进（游戏圈最贴） |
| `xiaohongshu-explore` | 小红书发现流 | community | html | 28–29 | ⚠️ 点赞数 | ⚠️ SPA 打不开 | ❌ | ⚠️ 二期（能抓但不稳） |
| `bilibili-game-rank` | B站游戏区 rid=4 | community | json | 96 | ✅ 播放量 | ✅ bvid | ❌ **2025 年** | ❌ **弃用** |
| — | 小黑盒 | — | — | 0 | — | — | — | ❌ rejected |

---

## 2. 三个横切结论（决定后续架构）

### 2.1 能进第一版的热榜（8 个）

按「价值密度」排序，全部零登录零签名：

1. **TapTap 三个榜**（预约/热门/热玩）—— 唯一带结构化站内热度面板（评分/评论/粉丝/心愿）的源，见 §3
2. **知乎热榜** —— 中文热榜里**唯一直接给正文入口**的，`target.id` 拼 question 页即可，还带 `excerpt` 摘要
3. **B站全站榜 + 游戏过滤** —— 唯一带播放量排序 + 真实 pubdate 的热榜，且「全站榜里混着非游戏」本身就是破圈信号
4. **抖音热点榜** —— 49 条 + `hot_value` + `event_time`（本次唯一带时间戳的外部热榜）
5. **微博热搜** —— 52 条 + `num`，舆情面最广
6. **百度热搜** —— 51 条 + `hotScore` + **`desc` 摘要**，摘要质量高到能省一次正文抓取
7. **贴吧热议话题** —— 30 条，内容偏电竞/游戏圈，对游戏雷达最贴
8. **小红书发现流** —— 能抓但结构不稳，且不是榜单，放二期

### 2.2 只有标题、没有原文链接的（4 个，必须二次检索）

这是本次最关键的架构结论：**热榜 ≠ 资讯源**，8 个外部热榜里有 4 个只给话题词。

| 源 | 能拿到什么 | 二次检索代价 |
|---|---|---|
| 微博热搜 | 词条 + 热度 + 「新/热/沸/爆」标签 | 拼 `s.weibo.com/weibo?q=%23词%23`，**该搜索页无 cookie 常被踢到 passport → 实际拿不到正文** |
| 抖音热点 | 词条 + 热度 + 事件时间 | `douyin.com/hot/<sentence_id>` 是 SPA 空壳（实测 72KB，title 为空）→ **等于抓不到** |
| 百度热搜 | 词条 + 热度 + **摘要** + 配图 | `url` 是百度自家搜索结果跳转（`rsv_dl=fyb_news`），非原文；但 `desc` 摘要够用 |
| 贴吧热议 | 话题 + 实时讨论数 + 一句话摘要 | `hottopic/browse/hottopic?topic_id=` 话题聚合页**服务端渲染**，可再抓一层拿到原帖列表 |

反向的 4 个：**知乎（直接给 question 页）**、**B站（bvid → 视频页）**、**TapTap（app id → 商店页，实测 200）**、小红书（有 note 页 URL 但 SPA 无正文）。

> 工程建议：把热榜当「**话题发现层**」，不要当「内容层」。第一版就接受「微博/抖音只有标题」，用标题做聚类/关键词命中即可；需要正文时只对**命中游戏关键词的少数条目**去做二次检索，而不是全量。

### 2.3 需要 cookie / 特殊头才能稳的（3 个）

| 源 | 需要什么 | 无它会怎样 |
|---|---|---|
| `bilibili-ranking` | `Cookie: buvid3=...` | 返回 `{"code":-352}`（风控，不是 403） |
| `xiaohongshu-explore` | `Accept-Language: zh-CN`（**不是 cookie**） | 302 到 `/login?redirectPath=...`，看起来像「必须登录」 |
| `taptap-*` | `X-UA` 固定指纹串（**不是签名**） | `INVALID_XUA: XUA is empty`（HTTP 400） |

**没有任何一个源需要真实登录态。** 三种「必填项」都可以在代码里自带：
- bilibili：`GET https://api.bilibili.com/x/frontend/finger/spi` → `data.b_3` 就是 buvid3（每次探测现领，不伪造）
- taptap：`X-UA: V=1&PN=WebApp&LANG=zh_CN&VN_CODE=102&LOC=CN&PLT=PC&DS=Android&UID=&OS=Android` 写死即可
- 小红书：`Accept-Language: zh-CN,zh;q=0.9` 写死即可

真实 cookie 值在 JSON 里统一写成 `<需用户提供>`，本探测**未使用任何用户凭据**。

---

## 3. TapTap 站内数据可得性（重点，用户自有平台）

**结论：完全可得，而且比所有外部热榜都好用 —— 不需要登录、不需要签名、不需要 appkey。**

### 3.1 唯一接口

```
GET https://www.taptap.cn/webapiv2/app-top/v2/hits?type_name=hot|reserve|pop
Header: X-UA: V=1&PN=WebApp&LANG=zh_CN&VN_CODE=102&LOC=CN&PLT=PC&DS=Android&UID=&OS=Android
Header: Referer: https://www.taptap.cn/top/download
```

返回 `data.list`（10 条）+ `data.total=150` + `data.next_page`（自带分页游标 `?from=10&limit=10&type_name=reserve`）。

### 3.2 三个榜的差异（都实测通过）

| 榜 | `type_name` | heat 用哪个字段 | 实测榜首 |
|---|---|---|---|
| 热门榜 | `hot` | `stat.hits_total` | 光·遇（45,918,394） |
| 预约榜 | `reserve` | `stat.reserve_count` | 异人之下（2,621,738） |
| 热玩榜 | `pop` | `stat.hits_total` | 心动小镇（61,762,030） |

**预约榜是「引进信号」属性最强的榜**：条目全是未上线新游，`released_time=0`、`hits_total=0`、`reserve_count` 百万级。对「该不该引进某个游戏」这个决策，这个榜比任何外部热榜都直接。

### 3.3 站内监控面板数据（外部热榜给不了的）

每条 `app.stat` 里有：`rating.score`（评分）、`latest_review_count`（版本评论数）、`review_count`、`fans_count`（粉丝）、`feed_count`（社区帖）、`topic_count`、`video_count`、`album_count`（截图）、`wish_count`（心愿）、`play_total`、`pc_sale_count`。

这是**分品类可比的面板数据**——外部热榜只给你一个「热值」数字，TapTap 给你的是一组能横向对比的结构化指标。

### 3.4 榜单全量品类（从 `/top/download` 页的 `__NUXT_DATA__` 里挖出来的 24 个 tab）

热门榜=`hot`、预约榜=`reserve`、热玩榜=`pop`、新品榜=`new`、热卖榜=`sell`、新版本榜=`in_app_event_reserve`、独家榜=`exclusive`；
按品类：`action` 动作、`strategy` 策略、`idle` 放置、`single` 单机、`casual` 休闲、`sandbox_survival` 沙盒生存、`management` 模拟经营、`unriddle` 解谜、`shooter` 射击、`multiplayer` 多人对战、`acgn` 二次元、`music` 音乐节奏、`scenario` 剧情、`swordsman` 武侠、`otome` 女性向、`independent` 独立、`roguelike`。

**同一个接口换 `type_name` 就拿到全部 24 个榜**，这是本次探测性价比最高的发现。

### 3.5 两个硬限制

1. **没有 `publishedAt`**：榜单条目只有 `released_time`（游戏上线/公测日，预约榜为 0），不等于「上榜时间」。要做「新进榜」只能靠两次快照 diff。
2. **每页 10 条**：150 条全量要 15 次请求，很贵。**建议只取首页 10 条 + 1–2 小时轮询**，diff 出进榜/掉榜。

---

## 4. 逐源踩坑记录

### 4.1 小黑盒 —— ❌ rejected（唯一真的过不去的）

站点是**纯 SPA 空壳**（3651 字节，`<div id="app">` 里什么都没有，无 `__NUXT__` / `__NEXT_DATA__`），HTML 路线直接死。

从 `index-*.js`（2MB）里挖出签名逻辑：

```js
// 请求参数里必须带 _rnd
async function SEe(e) {
  if (e.rnd === "15") {
    const t = await Uwe(e.params.nonce, `${e.params._time}:${e.params.nonce}`);
    e.params._rnd = `15:${t}`;
  }
}
// Uwe = HMAC-SHA256(key=qM, msg = qM + nonce + `${_time}:${nonce}`)
function Uwe(e, t) {
  const key = new TextEncoder().encode(qM);          // qM = 内联常量密钥
  const msg = new TextEncoder().encode(qM + e + t);
  return crypto.subtle.importKey("raw", key, {name:"HMAC", hash:"SHA-256"}, ...)
    .then(k => crypto.subtle.sign("HMAC", k, msg))
    .then(sig => hex(sig));
}
```

- 缺签名的实测返回：`HTTP 200 {"msg":"请求失败了","result":{},"status":"failed"}`
- 另外 `bEe()` 会补 `os_type/app/x_client_type/x_os_type/x_app/x_client_version` 等指纹参数，缺一不可
- RSSHub 公共实例 `rsshub.app/xiaoheihe/news` → **HTTP 403 Cloudflare 人机校验墙**（不是签名问题，换自建实例可能可行，但同样躲不开签名）

**判定：不可用。「需要签名」+ 密钥内联，属于典型的「能逆向但不该做」，按约束放弃。**

### 4.2 B站 —— 要 buvid3，但不要登录

- 无 cookie：`HTTP 200 {"code":-352,"message":"-352","ttl":1}`——注意**是 200 不是 403**，容易误判成「抓到了空数据」
- 解法不是伪造 cookie，而是现领：`GET /x/frontend/finger/spi` → `data.b_3`，塞进 `Cookie: buvid3=<b_3>` 即可
- 也不需要 `wbi` 签名（`ranking/v2` 不校验 wbi）
- **`rid=4`（游戏区）的坑**：返回 96 条，但**全部 pubdate 落在 2025-03-28 ~ 2025-04-02**（最新一条距今 569 天）。多次重试 + 加 cachebuster 结果完全一致 → 是一份**冻结快照**，不是抓取失败。同一次探测里 `rid=0` 最新是 2026-10-22，证明不是网络问题。
- **替代口径**：取 `rid=0` 全站榜 100 条，按 `tname ∈ {手机游戏, 单机游戏, 网络游戏, 电子竞技, 桌游棋牌}` 过滤 → 本次得到 17 条**新鲜**游戏热门（见 `bilibili-game-filter`）。若要多，可再试 `rid=17`（单机游戏）等其他分区，但**必须逐个验时效**。

### 4.3 微博 —— 只要 UA + Referer，但时间戳是零

`weibo.com/ajax/side/hotSearch` 完全不需要 cookie。`data.realtime` 52 条 + `data.hotgovs` 1 条政务置顶。

- 头部字段：`word`、`num`（热值）、`realpos`（真实排名）、`label_name`（新/热/沸/爆）、`note`、`icon`
- ⚠️ **`rank` 字段恒为 0，别用它排序**，要用 `realpos` 或数组顺序
- ⚠️ `hotgovs` 是政务要闻置顶，游戏雷达必须排除
- ⚠️ **零时间戳**：别指望判断「这条多久了」

### 4.4 知乎 —— 换个域名就活了

- 候选 A（官方）：`www.zhihu.com/api/v3/feed/topstory/hot-lists/total` → `HTTP 401 {"code":101,"name":"AuthenticationError"}`，需 `z_c0` 登录 cookie
- 候选 B（移动端）：`api.zhihu.com/topstory/hot-list?limit=50` → **无需 cookie 直接可用**，30 条
- ⚠️ `www.zhihu.com/billboard` HTML 走的是 `zh-zse-ck` 动态反爬脚本（403），别碰
- ⚠️ `heat` 是 `detail_text` 字符串（`"2377 万热度"`），不是数字
- ⚠️ `target.created` 是**问题创建时间**，不是上榜时间；`target.url` 指向 `api.zhihu.com`，要自己拼 `www.zhihu.com/question/<id>`

### 4.5 百度 —— 没有接口，但有更好的东西

没有独立 JSON 接口。数据以 `<!--s-data:{...}-->` 内联在 `top.baidu.com/board?tab=realtime` 的 HTML 里（约 192KB），在 `s-data:` 之后做**字符串感知的括号配对**就能切出合法 JSON。

- 字段最全：`hotScore`（热值）、`index`（排名，0 起）、`query`（标题）、`desc`（摘要！）、`img`（配图）
- 兜底接口 `top.baidu.com/api/board?platform=wise` 也能用，但**没有 hotScore**
- ⚠️ `url` / `appUrl` 是 `www.baidu.com/s?wd=...&rsv_dl=fyb_news` 的自家搜索跳转，**不是原文**

### 4.6 抖音 —— 预期会死，结果没死

`www.douyin.com/aweme/v1/web/hot/search/list/?device_platform=webapp&aid=6383&channel=channel_pc_web&detail_list=1&source=6` 实测 **200，不需要 `a_bogus` / `X-Bogus` 签名**。49 条。

- 字段：`word`、`hot_value`、`position`、`max_rank`、`event_time`（秒）、`video_count`、`discuss_video_count`、`word_cover`
- ✅ **`event_time` 是本次外部热榜里唯一好用的时间戳**（0.4h ~ 44.8h 前，说明榜单只装最近约 2 天的事件）
- 兜底：`iesdouyin.com/web/api/v2/hotsearch/billboard/word/` 也 200，字段更少（只有 `word` + `hot_value`）
- ⚠️ `trending_list`（上升榜 5 条）和 `word_list` 是两套，别混
- ⚠️ `douyin.com/hot/<sentence_id>` 是 SPA 空壳（72KB，title 为空），**别指望从它拿正文**

### 4.7 小红书 —— 一个 header 决定生死

- 内部 API：`POST edith.xiaohongshu.com/api/sns/web/v1/homefeed` → `HTTP 406 {"code":-1,"success":false}`，需 `x-s` / `x-t` / `x-s-common` 签名 + `a1` / `web_session` cookie
- **但** `GET www.xiaohongshu.com/explore`：
  - 不带 `Accept-Language` → `302 /login?redirectPath=...`（**这就是「小红书必须登录」这个误判的来源**）
  - 带 `Accept-Language: zh-CN,zh;q=0.9` → **HTTP 200，167KB SSR 页面**，`window.__INITIAL_STATE__.feed.feeds` 里直接躺着 28–29 条笔记
- ⚠️ 该对象里混了裸 `undefined`，**不是合法 JSON**，解析前必须 `.replace(/\bundefined\b/g, "null")`（否则 `JSON.parse` 报 `Unexpected token 'u'`）
- ⚠️ 条数会在 28↔29 浮动（推荐流轮换），别假设稳定
- ⚠️ 这不是榜单：无排名、无时间戳，只有 `interactInfo.likedCount`（字符串，`"3.1万"` 这种中文单位）
- ⚠️ 详情页 `/explore/<noteId>?xsec_token=<token>` 是 SPA，服务端不返正文 → **有链接但抓不到内容**

### 4.8 贴吧 —— 名叫 topicList，其实是 HTML

`tieba.baidu.com/hottopic/browse/topicList?res_type=1` 我以为返回 JSON（名字像接口），加 `X-Requested-With: XMLHttpRequest` 也没用，**返回的是完整 HTML 页面（62KB）**。

- 榜单在 `<li class="topic-top-item">` 里，`split` 切块 + 正则就能拿：`class="topic-text"` 标题、`<span class="topic-num">` 热值（`"278.3W实时讨论"`）、`<p class="topic-top-item-desc">` 摘要、`<img>` 封面
- ⚠️ 标题里有 HTML 实体（`&quot;`），要解码
- ⚠️ 链接是 `hottopic/browse/hottopic?topic_id=` 话题聚合页（服务端渲染），不是原帖，**但比微博/抖音强，可再抓一层**
- 为什么选贴吧而不是虎扑/NGA：**唯一不登录就能稳定拿到的**，而且内容（HLE/TES 换队服、拾漏卡皇）比综合热榜更贴游戏圈

---

## 5. 更新频率观察

⚠️ **诚实说明：单次探测测不出刷新间隔**（除抖音外，所有热榜的响应里都没有时间字段）。下表区分「实测依据」和「推断」：

| 源 | 时间字段 | 实测依据 | 结论 / 建议轮询 |
|---|---|---|---|
| 抖音 | ✅ `event_time` | 49 条距现在 0.4–44.8h，最新 0.4h 前 | 高频滚动，**10–15 分钟** |
| B站全站榜 | ✅ `pubdate` | 100 条跨 4 天 | 日级排名（近几日综合），**1 小时**足够 |
| 知乎 | ⚠️ 问题创建时间 | 13–66h 前 | 热榜本身滚动，**15–30 分钟** |
| 微博 | ❌ | 两次探测间榜首 `num` 1,144,782 → 1,151,222 在变 | 实时滚动，**15 分钟** + diff |
| 百度 | ❌ | 同一热值 7,904,415 → 7,903,979 在变 | 实时滚动，**15 分钟** + diff |
| 贴吧 | ❌ | 热值为「实时讨论数」，量级稳定 | 推断小时级，**30 分钟** |
| TapTap | ❌ | 无任何时间字段 | 日级重排，**1–2 小时** + diff 出进榜 |
| 小红书 | ❌ | 无任何时间字段 | 不确定，**2 小时**，当弱信号 |
| B站 rid=4 | — | 冻结在 2025-04 | **不用** |

所有源的统一做法：**存快照 → diff 出新进榜**，这比纠结刷新频率更有效（新浪/百度这类榜单没有「上榜时间」字段，diff 是唯一出路）。

---

## 6. 复现

```bash
node research/probes/cn-community.mjs
# → 写出 research/sources/cn-community.json，并打印每个源的条数/HTTP/耗时
```

脚本特性：
- 零依赖，原生 `fetch`；同域名串行队列 + 强制间隔 1.1s；单次请求 20s 超时
- 每个源给 `failure`（含传输层错误），失败不影响其他源
- 请求头里的 `<浏览器 UA>` / `<需用户提供>` 是**文档占位符**，`sanitizeHeaders()` 会把它们过滤掉（Node 的 fetch 遇到非 Latin-1 头会直接抛 `TypeError`，这个坑踩过一次）
- 请求预算：小黑盒 3 + B站 3 + 微博 1 + 知乎 2 + 百度 1 + 抖音 1 + 小红书 1 + TapTap 3 + 贴吧 1 = **16 次/轮**

---

## 7. 给第一版的取舍建议

**照抄这 8 个源即可覆盖「受众现在在聊什么」**：TapTap(3 榜) + B站(全站榜+游戏过滤) + 知乎 + 抖音 + 微博 + 百度 + 贴吧。

1. **TapTap 三榜放最高优先级**：结构化、新鲜、可横向比、且是自家平台，进榜/掉榜可以直接驱动选题
2. **知乎热榜是唯一的「能点开看正文」的中文热榜**，成本最低，别漏
3. **微博 + 抖音 + 百度 + 贴吧当「话题发现层」**，接受「只有标题」，只对命中游戏关键词的条目做二次检索
4. **B站用 `rid=0` + tname 过滤，别用 `rid=4`**（会拿到 2025 年的数据，静默污染）
5. **小红书放二期**：能抓，但非榜单、无时间、结构随发版会变，收益/维护比不划算
6. **小黑盒不用再试**：签名在内联密钥里，除非官方给接口，否则无解

---

## 8. 落到雷达配置（第二段：探测 → `app/sources.d/cn-community.json`）

探测层的 12 个源，转到雷达配置时因为「适配器能力」被砍了一刀。雷达的 JSON 适配器有三个硬约束（读 `app/src/parsers.ts` / `collector.ts` 得到）：

1. `urlTemplate` 的 `{占位符}` **只读行对象的顶层字段**（`o[k]`），不支持 `{app.id}` 这种点号路径 —— `map.title` / `heat` 支持点号，**只有 urlTemplate 不支持**；
2. `heat` 只接受 `typeof === 'number'` 的值，**字符串热度（百度的 hotScore、知乎的「万热度」、贴吧的「278.3W实时讨论」）会被静默丢弃**；
3. `type: "html"` 的数据**完全没有 heat**（`collector.ts` 走 html 分支时不写 heat），只有 `rank`（还是 JSON 分支才有的）。

按「热度必须 >0」的门槛，最终 8 个源进配置，4 个被砍：

| 源 | 结果 | 原因 |
|---|---|---|
| TapTap 热门/预约/热玩 | ✅ 收（`internal`, tier 2） | 唯一代价：`app.id` 嵌套在 `app` 对象里，urlTemplate 拼不出 `/app/<id>`，先用「榜页 + `?game={identification}`」当代理链接 |
| B站全站榜 | ✅ 收（`community`, tier 1） | `buvid3` 写死在 headers，`{bvid}` 在顶层，链接完美 |
| 知乎热榜 | ✅ 收 | `target.url` 可用（是 api.zhihu.com 地址），正文页 `/question/{target.id}` 因嵌套拼不出来 |
| 抖音热点 | ✅ 收 | `{word}` 在顶层，`event_time` 是真时间戳 |
| 微博热搜 | ✅ 收 | `{word}` 在顶层 |
| 百度热搜 | ✅ 收，但**热度只有 rank** | `hotScore` 是字符串，heat 拿不到量级 |
| 贴吧热议话题 | ❌ 删 | 只有 HTML，html 分支没有 heat |
| 小红书发现流 | ❌ 删 | 同上（HTML + 点赞数是字符串） |
| B站游戏区 rid=4 | ❌ 删 | 榜单冻结在 2025-04，会静默污染 |
| 小黑盒 | ❌ 删 | 签名 |

### 一个改动能解锁 4 个源的链接质量

`parsers.ts` 的 `mapJsonItems` 里，urlTemplate 的占位解析如果从 `o[k]` 改成和 `map` 一样走 `get(o, [k])`（支持点号），立刻能让：

- TapTap：`https://www.taptap.cn/app/{app.id}` ← 真正的商店页（实测 200，标题正确）
- 知乎：`https://www.zhihu.com/question/{target.id}` ← 真正的问答页

约 5 行改动，`map.title` / `heat` 已有的点号能力复用即可。

第二个小改动：`heat` 的值加一次 `Number(v)` 兜底（当前只认 `typeof v === 'number'`），就能拿到百度 `hotScore`（700 万量级）和知乎 `detail_text`（需去掉「万热度」后缀）的真实热值。
