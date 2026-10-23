# cn-media 探测结论（国内游戏垂媒）

- 探测时间：2026-10-23 11:47:53（+08:00）
- 脚本：`research/probes/cn-media.mjs`（`node research/probes/cn-media.mjs` 可直接重跑，约 7s，全程 0 依赖）
- 机器可读结果：`research/sources/cn-media.json`
- 结果：**9 条入口 verified，0 条真失败，1 个站（VGtime）整站废掉**

## 一句话结论

国内垂媒的信源质量比预期好得多——**8 个站里有 4 个有可用 RSS、1 个有干净的 JSON:API**，
真正必须扒 HTML 的只有游民星空、3DM、触乐三家；而这三家的 HTML 列表**反而都带真实发布时间**
（3DM 精确到秒，游民到分，触乐只到天）。
全组唯一拿不到时间的是 indienova 的 HTML 列表页——但它的 RSS（`/feed/` **必须带尾斜杠**）时间很干净，
所以这条也补上了。**真正的坑不是反爬，是 VGtime 域名已经废了。**

## 总览

| # | 源 | 入口 | 类型 | HTTP | 一次条数 | 真实发布时间 | 热度 | 判定 |
|---|---|---|---|---|---|---|---|---|
| 1 | 机核 | `https://www.gcores.com/rss` | rss | 200 | 20 | ✅ 到分 | — | verified |
| 2 | 机核（API） | `https://www.gcores.com/gapi/v1/articles?page[limit]=20&sort=-published_at` | json | 200 | 20 | ✅ 到秒 | ✅ likes/comments/plays | verified |
| 3 | 游研社 | `https://www.yystv.cn/rss/feed` | rss | 200 | 12 | ✅ 到分 | — | verified |
| 4 | 游民星空 | `https://www.gamersky.com/news/` | html | 200 | **176** | ✅ 到分 | — | verified |
| 5 | 3DM | `https://www.3dmgame.com/news/` | html | 200 | 20（~24） | ✅ **到秒** | — | verified |
| 6 | GameLook | `http://www.gamelook.com.cn/feed/` | rss | 200 | **31** | ✅ 到分（UTC 需换算） | — | verified ⚠️偶发 502 |
| 7 | indienova | `https://indienova.com/feed/` | rss | 200 | 10 | ✅ 到分 | — | verified |
| 8 | indienova（列表） | `https://indienova.com/indie-game-news/` | html | 200 | 12 | ❌ **拿不到** | ✅ 点赞/评论数 | verified（仅作热度用） |
| 9 | 触乐 | `https://www.chuapp.com/` | html | 200 | 25 | ⚠️ 只到天 | — | verified |
| — | **VGtime** | `https://www.vgtime.com/` | — | 200/500/404 | 0 | — | — | **rejected** |

延迟实测 19–2001ms（GameLook 最慢 2s、indienova RSS 0.8s，其余都在 100–600ms，国内直连很快）。

---

## 逐源要点

### 1. 机核 RSS —— 最省事，直接进第一版

标准 RSS 2.0，一次 20 条，没有分页参数。`pubDate` 带 `+0800`，是真时间。
额外有 `<thumb>`（封面图 URL，不用从 description 抠图）和 `<author>`（多作者用逗号分隔）。
`description` 是整段 HTML，要自己 strip。

### 2. 机核 JSON:API —— 全组唯一「时间 + 热度」都齐的入口

`https://www.gcores.com/gapi/v1/articles` 是标准 JSON:API，**但三个参数坑全踩过**：

1. **`Accept` 必须是 `application/vnd.api+json`**。写成 `application/json` 直接 406，
   而且错误信息明确说「must use the 'application/vnd.api+json' Accept without media type parameters」。
2. **分页必须用 `page[limit]` / `page[offset]`**。用 `?limit=20&page=1` 会 400 `Invalid Page Object`。
3. **必须显式 `sort=-published_at`**。不带 sort 直接 `?` 空参数请求，返回的第一条是 **2013 年** 的老文章
   （id=34，讲 PS4 手柄原型图），很容易误判成「这接口是死数据」。

`attributes` 里带热度：`likes-count` / `comments-count` / `bookmarks-count` / `plays`，
另有 `tag-data`、`owner-type`、`is-news`、`vol`。`meta.record-count` 显示全站约 3 万篇，可深翻。

> 备注：curl 调试时 URL 里的 `[]` 会被当成 glob，要加 `-g`；JS 的 fetch 会编码成 `%5B`，服务端照样认。

### 3. 游研社 RSS —— 能进第一版，但一次只有 12 条

标准 RSS 2.0，`pubDate` 带 `+0800`。
**没有 author、没有 dc:creator、没有任何热度字段**，首图要自己从 `description` 里取 `<img>`。
一次只有 12 条 → 想不漏稿只能靠高频轮询，建议 15 分钟一次（RSS 里 `<ttl>5</ttl>`，官方自己认为 5 分钟就够更新）。

### 4. 游民星空 —— HTML 兜底里的头号选手，一次能捞 176 条

站内 RSS 已废（`/rss/` → **403**，`/rss.xml`、`/rss.aspx` → **404**），只能扒页面。
`/news/` 是纯服务端渲染，结构极规整：

```html
<li>
  <div class="tit"><a class="tt" href="/news/202610/2233632.shtml" title="标题">标题</a></div>
  <div class="img"><a><img src="..."></a></div>
  <div class="con">
    <div class="txt">一句话摘要</div>
    <div class="tem">
      <div class="time">2026-10-23 10:38</div>
      <div class="pls cy_comment" data-sid="2233632"></div>
    </div>
  </div>
</li>
```

- 标题 / 链接 / 摘要 / 首图 / **真实时间（到分）** 全在同一个 `<li>` 里，一次拿全。
- 单页能解析出 **176–177 条去重资讯**（页面按「今日推荐/单机电玩/NS/手游/网游/业界/硬件/科技」多个 tab
  预渲染，共 223 个 `div.tit`）—— 这是全组单次抓取量最大的源。
- ⚠️ **tab 混排导致结果不是时间倒序**，必须客户端按 `publishedAt` 重排再用。
- 评论数是畅言（`cy_comment` + `data-sid`）JS 异步注入，HTML 里是空 div，抓不到。
- 分页由 `contentpaging` 的 `PageList()` JS 驱动，没有干净的 `?page=`；单页 176 条已够用，不强求翻页。

### 5. 3DM —— 时间精度全组最高（到秒），分页最干净

`/news/` 主列表是 `<li class="selectpost">` 序列：

```html
<a href="/news/202610/3957560.html" target="_blank" class="bt">标题</a>
<div class="bq"><a href="/news/46128/">《超英派遣中心》</a><span class="time">2026-10-23 11:40:41</span></div>
```

- 时间到**秒**，是本组唯一能做到「秒级时效」的源。
- 分页是纯 URL：`/news_all_2/`、`/news_all_3/` …… 可稳定深翻。
- 没有摘要正文（列表只有标题 + 缩略图）。
- ⚠️ 解析坑：`<a>` 的属性顺序是 **href 在前、`class="bt"` 在后**，正则别写成
  `class="bt" ... href=`（我第一次这样写直接 0 条）。正确做法是先抓整个 `<a>` 标签，再分别取 `href` 和 class。
- ⚠️ `div.bq` 里的 `<a>` 是「所属游戏 / 栏目」标签，**不是作者**，别往 `author` 里塞。
- 详情页 `<span id="Ct_total">（N人参与，M条评论）` 有服务端渲染的评论数，但列表页没有，要 N+1，故未标 heat。
- 同页 sidebar 有「近期热门」模块（`div.QZ_title` + `div.net a`），人工排序、无数值，可当第二路信号。

### 6. GameLook —— 能用，但两个坑会咬人

WordPress 站，`/feed/` 是标准 RSS 2.0，一次 **31 条**（全组第二多），带 `dc:creator` 和 `category`。

1. **只支持 http**。https 的 443 直接 `connection refused`（curl 7 号错误），不是证书问题。
2. **`/feed/` 偶发 502**（nginx 回源失败）。实测第一次 502、第三次才 200。
   脚本里做了兜底：`/feed/` 拿不到就退到 `?feed=rss2`（它 301 回 `/feed/`）并重试。
3. `pubDate` 是 **GMT（+0000）**，不换算会整体早 8 小时。
4. 正文图在 `<content:encoded>` 里，`description` 只有纯文本摘要。

> 游戏葡萄（youxiputao.com）按需求「二选一」未启用，GameLook 已够用。

### 7 + 8. indienova —— 同一家站的两个入口，一条有时间没热度、一条有热度没时间

**这是全组最值得记下来的坑。** 我一开始测 `https://indienova.com/feed`（无尾斜杠）→ **404**，
差点直接判「indienova 没有 RSS，只能扒 HTML」，然后就去啃那个没有时间的列表页了。
实际上 **`https://indienova.com/feed/`（带尾斜杠）→ 200，是标准 RSS 2.0**。

- **RSS 入口（推荐）**：10 条/次，`pubDate` 带 `+0800`，整点发布（08:00 / 14:00），带 `dc:creator`、
  `category`，正文 HTML 在 `<content:encoded>`。有 `<slash:comments>` 但 10 条全是 0，没点赞数 → `heat=false`。
- **HTML 列表页**：12 条/页，分页干净（`/indie-game-news/page/2/` … 共 **530 页**），
  `.article-panel` 里有 `h4>a` 标题、`p` 摘要、封面图，以及 `.views-badge`
  （`number-first`=点赞、`number-last`=评论）——**这是全组唯一能在列表页直接拿到互动数的入口**。
  但**整页没有发布时间**。

**关于 indienova 的「假时间」要特别说明**：我进详情页复核时，页面上确实能搜到一个
`2026-10-23 11:42:33`，但它藏在一段 HTML 注释里——
`<!-- <div class="hidden"> 2026-10-23 11:42:33 -->`，**那是服务端渲染时刻，不是发布时间**，
拿它当 `publishedAt` 会让整条雷达的时间全部变成「现在」。真正的发文信息是
`<span class="header-info">作者：…<br />前天 10-21 08:00</span>`，「相对日期 + MM-DD」无年份，且只在详情页。

### 9. 触乐 —— 时间只到「天」，要「分」得 N+1

服务端渲染 HTML，无 RSS、无 JSON 接口（首页里没有任何 `/api/` 或 ajax 路径）。

- 首页能抓到 **25 条** `/article/<id>.html`。
- ⚠️ 标题在 `<h2>`（有作者卡的条目）**或 `<h3>`（无作者卡的条目）**，
  只取 `h2` 会漏掉 10 条（`h3` 在没有 `h2` 时本身就是标题，不是作者）。
- 列表页印的是 `<span>10.22</span>`，只有月.日，无年份无时分；
  但每条封面的图片路径 `img.chuapp.com/wp-content/Picture/YYYY-MM-DD/` **带完整年月日**，
  脚本优先用它补年份，取不到才退回 `MM.DD` 按当年推断。
- 详情页复核（实测 `/article/291706.html`）：有
  `<div class="author-time"><span class="friendly_time" data-time="1792666380">2026年10月22日 18时53分</span>`，
  **`data-time` 是 unix 秒，精确到分**，同块还有 `<em>编辑</em>` 作者名；
  但**没有** `meta[property=article:published_time]`、没有 ld+json 的 `datePublished`。
  → 想拿「分」级时间必须逐条进详情页（25 条 = 25 次请求，不划算），列表页只能给到「天」级。
- 首页另有一个「热门文章」模块（`div.news > div.line` 拼出「热门文章」四个 span，其后 `ul li` 是人工热榜），
  但**只有排序、没有阅读数/评论数**，所以 `heat` 仍标 `false`。

### ✗ VGtime —— 整站已废，不是反爬

```
https://www.vgtime.com/        → 200，但只有 19156 字节的 SEO 镜像壳
https://www.vgtime.com/news/   → 500
https://www.vgtime.com/rss     → 404
```

首页 HTML 开头留着 `<!-- saved from url=(0021)https://www.u78g.com/ -->` 注释，
CSS 指向 `youjiu.173183.com`，正文全是「某游戏上线 / 某活动开启」的软文标题，
**没有任何 vgtime 自有栏目或文章链接**。HEAD 请求还带着空文件的 etag
（`da39a3ee5e6b4b0d3255bfef95601890afd80709`，即空字符串的 SHA1）和 `Content-Length: 0`。

这是**典型的域名过期后被停放 / SEO 农场接管**，跟反爬、UA 黑名单都没关系——换 UA、加 Referer 都救不回来。
**结论：VGtime 从雷达里划掉，别再排期。**

---

## 热度专项（`fields.heat: true` 的只有两条）

按需求专门找了「有热度值」的入口，全组只有两个能拿到**数值**（不是排序）：

| 入口 | 热度字段 | 量级 | 可用性 |
|---|---|---|---|
| 机核 JSON:API | `likes-count` / `comments-count` / `bookmarks-count` / `plays` | 正常（新稿评论 0） | ✅ 强烈推荐，跟时间同一份 payload，零额外成本 |
| indienova HTML 列表 | `.views-badge > .number-first`（点赞）/ `.number-last`（评论） | 点赞 0–5、评论全 0 | ⚠️ 弱信号，只能当参考 |

其余「热门」入口（3DM 的「近期热门」、触乐的「热门文章」）都是**人工排序、没有数值**，
没法做成可计算的排序依据，所以没有标 `heat`。

**如果雷达只能选一个热度源，选机核 JSON:API** —— 它是唯一「时间 + 热度 + 作者 + 封面」
全在一个 payload 里、且免费无鉴权的入口。

---

## 结论

### 值得进第一版（4 条，覆盖两个语义层）

1. **机核 JSON:API** —— 时间到秒 + 热度齐全，性价比最高，建议作为「精品/深度内容」主源。
2. **游民星空 HTML** —— 一次 176 条，量最大，覆盖单机/主机快讯，是「大流量资讯」主源（必须客户端重排时间）。
3. **3DM HTML** —— 时间到秒、分页干净，做「秒级时效」和「补量」最合适。
4. **GameLook RSS** —— 产业/商业视角唯一的源（31 条/次），补齐「行业向」这一层。**注意只走 http + 要重试。**

游研社（12 条/次，无作者无热度）和 indienova（10 条/次）建议放第二版——量小但质量高，
适合当「深度阅读」子栏目，不适合当主力轮询源。

### 必须靠 HTML 兜底的（3 家，且都能接受）

只有 **游民星空、3DM、触乐** 三家必须扒 HTML。好消息是它们都服务端渲染、结构稳定、
**都带真实发布时间**，没有一家需要跑 headless 浏览器：

- 游民星空：`div.tit > a.tt` + `div.time`
- 3DM：`a.bt` + `span.time`（注意属性顺序）+ `/news_all_N/` 翻页
- 触乐：`h2` 或 `h3`（二选一必须都试）+ 封面图路径补日期

### 拿不到 / 拿不准时间戳的

| 源 | 情况 | 影响 |
|---|---|---|
| **触乐** | 列表只到「天」（`10.22` + 图片路径补年），「分」要 N+1 进详情页 | 能做排序和排重，做**不了**秒级时效 |
| **indienova 列表页** | 完全没有发布时间；页面里的 `2026-10-23 11:42:33` 是**服务端渲染时间戳**，不是发布时间 | 只能用它的 RSS 补时间，列表页只当热度参考 |
| **VGtime** | 整站已废 | 直接剔除 |

另外两个隐性时间坑，都在脚本里处理了，但下游要留意：
**GameLook 的 pubDate 是 GMT**（不换算会整体早 8 小时）；
**触乐/3DM 的时间串没有时区标记但都是 CST**，按 `+08:00` 解读。

### 整体抓取风险

- **反爬：几乎没有。** 9 个入口全部裸 `curl` + 一个普通 Chrome UA 就 200，没有验证码、没有 JS 挑战、
  没有签名（机核 API 的 `Accept` 是协议要求，不是反爬）。全程零 cookie、零登录。
- **CDN / 可用性：这是真实风险。**
  - GameLook `/feed/` 偶发 502，且 **https 不通**——必须做失败重试 + 降级到 `?feed=rss2`。
  - VGtime 已经证明「国内垂媒域名会真的死掉」，**巡检要能区分「站点挂了」和「解析挂了」**，
    否则一个域名过期会伪装成解析 bug 排查半天。
- **条款：** 全组都是公开页面/RSS，没有 `robots.txt` 层面的破门行为；但仍建议
  **同域 ≥1s 间隔、单源单轮 ≤5 次请求**（脚本已内置 1100ms 全局限速）。
  游民星空单页 176 条已够用，没必要深翻；indienova 列表 530 页更没必要翻。
- **时间戳语义风险（最容易被忽略的一条）：** 这类站点普遍存在
  「服务端渲染时刻混在 HTML 里」「相对日期（前天/昨天）+ MM-DD 无年份」「pubDate 偷偷用 UTC」三种情况。
  **判定原则：凡是 HTML 里出现的完整时间串，先确认它属于哪条记录、是不是渲染时刻，再决定收不收。**
  indienova 那个注释里的时间戳就是活教材。

---

## 重跑

```bash
node research/probes/cn-media.mjs
```

- 无依赖（原生 fetch），约 7s 跑完 9 个入口 + VGtime。
- 内置同域 ≥1100ms 限速；GameLook 自动重试/降级；所有时间统一归一化成 `+08:00` 的 ISO。
- 产物覆盖写 `research/sources/cn-media.json`；stderr 打进度，stdout 打结论表。
- `verified` 的判定：HTTP 2xx **且** 解析到 ≥5 条带标题的条目，否则 `verified:false` + 写 `failure`。
