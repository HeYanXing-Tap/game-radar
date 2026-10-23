# overseas 域信源探测结论

> 探测时间：2026-10-23 11:55 (+08:00)
> 脚本：`node research/probes/overseas.mjs` → `research/sources/overseas.json`
> 实测 23 个入口，19 个 verified，4 个进 rejected。落地配置写在 `app/sources.d/overseas.json`（11 个源，全部 ✓）。

## 一句话结论

**v1 收 11 个源：6 个媒体 RSS + Reddit + 3 个厂商官方 + Steam 三榜 JSON。**
Steam 系只用 JSON 接口（`featuredcategories` + `enrich=steamApp`），HTML 的 coming soon / 标签页虽然能抓但拿不到愿望单或关注数，按「没有量级数值就不留」的原则**全部砍掉**；itch 列表页 0 个时间字段，也**砍掉**。

**「愿望单量级」这个引进业务最想要的数值，公开渠道拿不到，必须承认。** 现实替代是 Steam 评测总数 + 榜单名次 + 媒体提及量。

---

## 一、进第一版的源（`app/sources.d/overseas.json` 实测全 ✓）

| id | 名称 | role | tier | 类型 | 条数 | 时间 | 热度 | 备注 |
|---|---|---|---|---|---|---|---|---|
| `ign` | IGN | overseas | 2 | rss | 20 | 20 | – | 302→`www.ign.com/rss/articles/feed`，可翻页 |
| `gematsu` | Gematsu | overseas | 2 | rss | 20 | 20 | – | **信噪比最高**：标题自带档期 + category 带平台/厂商 |
| `eurogamer` | Eurogamer | overseas | 2 | rss | 100 | 100 | – | 一次给满 100 条 |
| `pcgamer` | PC Gamer | overseas | 2 | rss | 50 | 50 | – | 全文 feed，单次 ~5MB |
| `rps` | Rock Paper Shotgun | overseas | 2 | rss | 100 | 100 | – | PC/独立游戏，适合挖引进候选 |
| `gamesindustry` | GamesIndustry.biz | overseas | 2 | rss | 100 | 100 | – | 商业/并购线索 |
| `reddit_r_games` | Reddit r/games | community | 2 | rss | 25 | 25 | 榜位 | **必须 `.rss`**，见坑表 |
| `ps_blog` | PlayStation Blog | platform | 3 | rss | 10 | 10 | – | 一手官方 |
| `xbox_wire` | Xbox Wire | platform | 3 | rss | 10 | 10 | – | ID@Xbox 公布对引进最有用 |
| `nintendo_whatsnew` | Nintendo（美） | platform | 3 | html | 30 | 30 | – | 无 RSS，rowPattern 抠内嵌 JSON |
| `steam_trending` | Steam 热销/新品/即将发售 | platform | 2 | json | 50 | 14 | 50 | 三榜合并 + `enrich=steamApp` |

验证输出（`cd app && node src/cli.ts probe --file=sources.d/overseas.json`）：

```
探测 11 个信源（不入库）

✓ ign                    20 条  时间 20  摘要 18  热度 0  (1234ms)
✓ gematsu                20 条  时间 20  摘要 20  热度 0  (439ms)
✓ eurogamer             100 条  时间 100  摘要 100  热度 0  (307ms)
✓ pcgamer                50 条  时间 50  摘要 50  热度 0  (477ms)
✓ rps                   100 条  时间 100  摘要 100  热度 0  (377ms)
✓ gamesindustry         100 条  时间 100  摘要 100  热度 0  (281ms)
✓ reddit_r_games         25 条  时间 25  摘要 25  热度 0  (1250ms)
✓ ps_blog                10 条  时间 10  摘要 10  热度 0  (1938ms)
✓ xbox_wire              10 条  时间 10  摘要 10  热度 0  (488ms)
✓ nintendo_whatsnew      30 条  时间 30  摘要 30  热度 0  (274ms)
✓ steam_trending         50 条  时间 14  摘要 14  热度 50  (18338ms)
```

`steam_trending` 时间 14/50 是设计结果，不是 bug：新品 30 条里 `enrich` 只补前 15 条，即将发售那 10 条**本来就没有发售日**（Steam 返回 `"coming_soon": true, "date": "即将推出"`）。

---

## 二、砍掉的源与理由

| 源 | 实测结果 | 处置 | 理由 |
|---|---|---|---|
| **SteamDB 愿望单榜** | `/stats/mostwished/`、`/charts/`、首页**全 403**，返回恒定 ~10KB 的 `<title>SteamDB</title>` 空壳 | **砍** | Cloudflare 挑战页，按约束不绕。无公开 API |
| **Reddit `hot.json`** | 403 `You've been blocked by network security`，5 种 UA 全废 | **改用 `.rss`** | 不是 UA 问题。`.rss` 用自定义 UA 就是 200 / 25 条 |
| **Steam HTML「即将发售」** | 200 / 50 条，能拿到 appid、标题、发售日、评测数 tooltip | **砍** | 只有「发售日升序」这一个排序，**拿不到愿望单/关注数**；且未发售游戏无评测，可比数值为 0 |
| **Steam 标签页（tags=492 独立 + comingsoon）** | 200 / 50 条，`&tags=492` 确实生效 | **砍** | 同上：能按标签筛，但没有「高关注」这个维度，Steam 不公开愿望单数 |
| **Steam `featured`** | 200 / 30 条（win/mac/linux 大量重复） | **砍** | 和 `featuredcategories` 重叠，且只是首页编排位，无排名含金量、无价格外信息 |
| **itch.io 最新/最高评分** | 200 / 各 36 条，标题+链接+作者能拿 | **砍** | 列表页 **0 个时间字段**，也没有播放/评分数值。`.rss`、`.json`、`?format=rss` 全 404/无效 |
| **YouTube IGN 频道** | 200 / 15 条，**免 API key**，带 `views` / 点赞数 | **暂不进 v1** | 好用但**有 IP 级限速**：连续打 5–8 次后稳定 404（偶发 500），冷却几分钟才恢复。对定时轮询不稳，等有了降级策略再上 |
| **TGA 官网** | 200，只渲染出 3 条 `/news/` 链接，且**无标题文本** | 砍 | 无 RSS/无 JSON；新作公布实际走媒体，抓 IGN/Eurogamer 更快 |
| **Day of the Devs** | 200，10 条标题+链接（真实标题） | 砍 | **0 条发布时间**；`/games` 花名册 962KB 但 JS 渲染，源码里 0 个 Steam/itch 链接 |
| **Summer Game Fest** | 200，1 条有效标题（其余是 "Watch Event" 按钮） | 砍 | 页面 0 个日期字符串，无 RSS/无 JSON |

> 结论：**「独立游戏展会」这一类目前是空缺。** 它们的价值（选品名单）实际上要通过 Steam 页面 + 媒体报道二次发现，不建议为展会单独建源。

---

## 三、Steam 系接口：哪些字段真的能用

实测 `cc=cn&l=schinese`（中国大陆视角，价格返回 **CNY**）。

### 1. `store.steampowered.com/api/featuredcategories`（JSON，v1 主力）

返回顶层：`top_sellers` / `new_releases` / `specials` / `coming_soon` / `0`~`6`（策划位）/ `genres`。
每榜结构 `{ items: [...] }`，每条字段：

| 字段 | 值样例 | 可用性 |
|---|---|---|
| `id` | `1091500` | ✅ 拼 `https://store.steampowered.com/app/{id}` |
| `name` | `赛博朋克 2077` | ✅ 已本地化中文 |
| `discounted` / `discount_percent` | `true` / `70` | ✅ |
| `original_price` / `final_price` | `29800` / `8940`（分） | ✅ CNY |
| `currency` | `CNY` | ✅ |
| `header_image` / `large_capsule_image` / `small_capsule_image` | URL | ✅ 封面 |
| ~~发布时间~~ | — | ❌ **接口没有** |
| ~~评价数 / 愿望单~~ | — | ❌ **接口没有** |

条数上限：热销 10、即将发售 10、新品 30，无分页参数。**热度只能取「数组顺序」当 rank。**

### 2. `store.steampowered.com/api/appdetails?appids={id}`（JSON，补数用）

| 字段 | 值样例 | 为什么重要 |
|---|---|---|
| `recommendations.total` | `900060` | ★ **唯一能公开拿到的「量级」数值**（全站累计评测数，已发售游戏） |
| `release_date.date` | `2020 年 12 月 9 日` | ★ 档期 |
| `release_date.coming_soon` | `false` | ★ 判断是否未发售 |
| `metacritic.score` | `86` | 口碑 |
| `genres[].description` | `角色扮演` | 品类（已中文化） |
| `categories[].description` | `单人` / `应用内购买` | 玩法/付费形态 |
| `developers` / `publishers` | `["CD PROJEKT RED"]` | ★ 找发行权的谈判对象 |
| `price_overview.final` / `currency` | `8940` / `CNY` | 国区定价 |
| `supported_languages` | HTML 串 | ★ **是否已有简体中文**（判断引进必要性的关键） |
| `short_description` / `detailed_description` | 文本 | 简介 |
| `is_free` / `platforms` / `screenshots` / `movies` | — | — |
| ~~愿望单数 / 关注数~~ | — | ❌ **任何 Steam 官方接口都不返回** |

★ **坑：`appids=a,b,c` 批量传会直接 400**（返回 4 字节空体），只能一个 appid 一次请求。所以 `enrichLimit` 别开大，15 条≈18s。

### 3. `api.steampowered.com/ISteamNews/GetNewsForApp/v2`（厂商公告流）

`gid` / `title` / `url` / `author` / `contents` / `feedlabel` / `date`（Unix 秒）/ `feedname` / `feed_type` / `appid` / `tags`。是更新日志，不是媒体新闻，无热度。

### 4. `store.steampowered.com/search/?filter=comingsoon`（HTML，已砍但字段留档）

行内可解析：`data-ds-appid`、`<span class="title">`、`search_released`（**发售日**）、`data-ds-tagids`（标签 ID 数组）、`data-price-final`、`search_review_summary[data-tooltip-html]`（形如「888 篇用户评测中 75% 为好评」）。
⚠️ `l=schinese` 时这个评测数**只统计中文评测**，要全量口径必须用 `appdetails.recommendations.total` 或 `l=english`。

---

## 四、引进信号：最现实的抓取路径

分三层，按「能不能拿到可比数值」排：

**第 1 层（有数值，直接进打分）**
1. `featuredcategories` 三榜 → 候选池（rank = 热度）
2. 对候选逐条 `appdetails` → `recommendations.total`（量级）+ `release_date` + `genres` + `supported_languages` + `publishers`
3. 组合判断：**评测数够大 + 未发售/新发售 + 没有简体中文 + 有国区价格** = 高优先级引进候选

**第 2 层（有信号无数值，做交叉验证）**
4. `Gematsu` 的档期条目（标题即「XX launches March 4, 2027 in Japan」）—— 日系/亚洲新作最早的公开线索
5. `YouTube` 频道播放量（`views`）—— 但限速，只能低频跑
6. `Reddit` 热榜位次 + `IGN/Eurogamer/RPS` 的提及次数 —— 按「多少家媒体在写」当热度替代

**第 3 层（拿不到，别浪费时间）**
7. **愿望单数**：Steam 不公开；SteamDB 被 Cloudflare 挡（不绕）；第三方数据商（VG Insights / Gamalytic / SteamDB Pro）**均付费**
8. **关注数 / 粉丝数**：同上
9. **itch.io 评分数值**：列表页没有，`api/1` 要注册 key

> 一句话给业务：**用「评测总数 + 榜单名次 + 媒体提及家数」当引进评分的三元组，愿望单量级这一栏只能空着或买数据。**

---

## 五、必须付费 / 申请 key 的

- **本次 v1 全部 11 个源：免费、无需 key、无需登录。**
- 需要 key 但**没采用**：YouTube Data API v3（要 key + 每日配额）→ 已用免 key 的 `feeds/videos.xml` 替代。
- 需要申请 app 但**没采用**：Reddit 官方 OAuth（免费注册但要走审批）→ 已用 `.rss` 替代。
- 纯付费：SteamDB Pro、VG Insights、Gamalytic、AppMagic（都涉及愿望单/收入量级）。
- 唯一「想要但只能花钱」的是**愿望单量级**，其余都不需要花钱。

---

## 六、踩坑记录（按踩的先后）

1. **IGN**：`feeds.ign.com/ign/all` 是 **302**，不是 200。必须跟随跳转到 `www.ign.com/rss/articles/feed`，否则拿到空。另：`description` 是空的，摘要在 `content:encoded`。
2. **Reddit（最大的坑）**：`hot.json` 403，**换 5 种 UA 全废**（官方推荐格式、Chrome、通用 bot、python-requests、Googlebot），响应体恒为 189,908 字节的拦截页 → 是 IP/策略拦截不是指纹。`old.reddit.com` 302 跳登录；`api.reddit.com` 403。**正解是 `.rss` + 自定义 UA `game-radar/0.1 (by tap-editor)`**（浏览器 UA 反而被拒）。
3. **Reddit 限流**：`.rss` 被短时间连打会 **429**（我前面打 `hot.json` 太多次导致）。等几分钟就恢复，`intervalMin` 不要低于 60。探测脚本里已加 429 退避重试。
4. **Steam `appdetails` 不支持批量**：`appids=1091500,730` → **400**（4 字节）。一个 appid 一次请求。
5. **Steam 搜索页排序是假的**：`&sort_by=Released_DESC` 被忽略，页面里根本没有 `data-sort` 选项。`filter=comingsoon` 恒按发售日升序，**Steam 没有「按愿望单排序」的公开口子**。
6. **itch.io 属性顺序不一致**：`/games/newest` 是 `data-label`→`href`→`class`，`/games/top-rated` 是 `href`→`data-label`。写死顺序必挂，要先抓整个 `<a>` 再判断。
7. **Nintendo 没有 RSS/没有公开 JSON API**：文章数据在 Next.js 内嵌的 `initialApolloState`（Contentful）里。好在每个 `"__typename":"NewsArticle"` 对象内 `title` / `publishDate` / `url({\"relative\":true})` / 摘要文本是连续的，可以用 `rowPattern` 整块抠（属性顺序改版就挂，间隔放宽到 180 分钟）。
8. **YouTube `feeds/videos.xml` 有 IP 级额度**：连续 5–8 次后稳定 404（偶发 500），冷却几分钟恢复。必须「失败退避重试 + 换 UA」，间隔 2 秒的重试无效。
9. **PC Gamer 单次 ~5MB**：正文全塞在 `content:encoded`，只取标题/时间的话注意内存。
10. **SteamDB 三路由全 403**：`/stats/mostwished/`、`/charts/`、首页，返回恒定 ~10KB 的 Cloudflare 挑战页。按约束不绕。
11. **展会官网全军覆没**：TGA（3 条无标题）、DotD（10 条无时间）、SGF（1 条有效）。这三个的新闻实际都通过 IGN/Eurogamer 二次传播，不值得单独建源。

---

## 七、复跑

```bash
# 只跑探测，重新生成 research/sources/overseas.json
node research/probes/overseas.mjs

# 验证落地的信源配置（不入库）
cd app && node src/cli.ts probe --file=sources.d/overseas.json
```
