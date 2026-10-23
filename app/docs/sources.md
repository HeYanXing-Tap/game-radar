# 信源配置说明

信源全部写在 `app/sources.json` 的 `sources` 数组里。**改配置不用改代码。**

每条：

```json
{
  "id": "gamersky",            // 唯一，小写
  "name": "游民星空",           // 界面显示名
  "role": "media",             // media | community | overseas | platform | signal | internal
  "region": "cn",              // cn | global
  "type": "html",              // rss | json | html
  "url": "https://www.gamersky.com/news/",
  "tier": 2,                   // 3=一手官方, 2=准一手, 1=二手聚合
  "enabled": true,
  "intervalMin": 60,           // 抓取间隔（分钟）
  "headers": {},               // 必须带的请求头
  "adapter": {},               // 见下
  "note": "给未来的自己看的备注"
}
```

`tier` 会影响两件事：热度权重（3 级 ×1.6，2 级 ×1.15，1 级 ×1.0）和打分门槛（一手源更宽松）。

---

## type: "rss"

`adapter` 留空即可。自动吃 RSS 2.0 / Atom / RDF。

## type: "json"

```json
"adapter": {
  "path": "data",                       // 取数组的路径，点号分隔；根就是数组则留空
  "urlTemplate": "https://www.gcores.com/articles/{id}",  // 没有 url 字段时用条目字段拼
  "map": {
    "title": ["attributes.title"],      // 点号支持多层
    "url": [],                          // 空数组 = 用 urlTemplate
    "summary": ["attributes.excerpt"],
    "publishedAt": ["attributes.published-at"],
    "image": ["attributes.cover"],
    "author": ["attributes.owner-name"]
  },
  "heat": {                             // 可选，把数值字段映射成热度
    "likes": "attributes.likes-count",
    "comments": "attributes.comments-count"
  }
}
```

多榜单合并（每个榜单自动带 rank 作为热度）：

```json
"adapter": {
  "sections": ["new_releases.items", "coming_soon.items"],
  "urlTemplate": "https://store.steampowered.com/app/{id}",
  "map": { "title": ["name"], "url": [] }
}
```

`map` 里每个字段都按顺序取第一个非空值，所以可以写多个候选名。

**`urlTemplate` 支持三种占位符**：

| 写法 | 用途 |
|---|---|
| `{id}` / `{app.id}` | 取字段，支持点号路径 |
| `{target.url\|lastPathSegment}` | 取一个字符串字段的**路径尾段**。知乎热榜必须用它——`target.id` 是 19 位数字，超过 2^53，`JSON.parse` 会丢精度，拼出来的链接是错的 |
| `{xxx\|digits}` | 只取字段里的第一段连续数字 |

**`heat` 支持字符串转数字**：`"7903979"`、`"3.1万"`、`"1.2亿"` 都会被转成数值，所以百度 `hotScore` 这类字段可以直接映射。

## type: "html"

### 方式 A：行块抽取（推荐，能同时拿到标题+链接+时间）

先看列表页的一条长什么样，把整块当外层，再逐字段抠：

```json
"adapter": {
  "rowPattern": "<li[^>]*class=\"selectpost\"[^>]*>[\\s\\S]*?</li>",
  "title": "<a[^>]*class=\"bt\"[^>]*>([\\s\\S]*?)</a>",
  "link": "href=\"([^\"]+)\"",
  "time": "<span[^>]*class=\"time\"[^>]*>([\\s\\S]*?)</span>",
  "image": "<img[^>]*src=\"([^\"]+)\"",
  "urlPrefix": "https://www.3dmgame.com"
}
```

行块的 `heat` 支持两种写法（用来抠阅读数/讨论数）：

```json
"heat": { "views": "([\\d.]+)\\s*万" }
"heat": { "discuss": { "pattern": "([\\d.]+)W", "mult": 10000 } }
```

第二种适合源站用 `W` 表示万、但正则只能抠到数字的情况（贴吧就是）。

规则：
- 每个字段是**行块内**的正则，取**第 1 个捕获组**
- 链接去重保留 query（只砍 `#` 后的部分）——贴吧、NGA、Discourse 这类靠 `?id=` 区分条目的站点，如果砍掉 query 会全部塌缩成一条
- `rowPattern` 一定要写到闭合标签，否则会一锅端
- 属性顺序反了就匹配不到（`href` 在前、`class` 在后是常见的）
- 时间格式支持 `2026-10-23 11:40:41`、`2026年10月23日`、RFC822、unix 秒/毫秒、`3小时前`
- 拿不到真实时间就**不写 `time`**，宁可没有，也不要让抓取时间冒充发布时间

### 方式 B：通用抽链（兜底）

```json
"adapter": { "hrefPattern": "/news/\\d{6}/", "minTitle": 8, "limit": 60 }
```

只拿标题和链接，**时间一定为空**。用在没有更好结构的站。

---

## 验证

```bash
node src/cli.ts probe --file=app/sources.d/cn-media.json
node src/cli.ts probe --file=app/sources.d/cn-media.json --only=gamersky
```

输出「条数 / 有时间 / 有摘要 / 有热度」四个数 + 前两条样本。**不入库、不干扰现有数据。**

判断标准：
- 条数 ≥ 5 且样本标题正确 → 可用
- `时间 0` → 该源在选题雷达里会一直排后面（没有时效就没法判断「现在还来不来得及」）
- 时间全是抓取时刻 → 更糟，会让旧闻冒充新闻，不如不抓

## 已知坑

| 源 | 坑 |
|---|---|
| 机核 | 必须 `Accept: application/vnd.api+json`，否则 406；分页用 `page[limit]`；必须 `sort=-published_at`，不带会返回 2013 年的文章 |
| indienova | RSS 必须带尾斜杠 `/feed/`；`/feed` 是 404 |
| 3DM | `<a>` 属性顺序是 href 在前，正则写反抓到 0 条 |
| 游民星空 | 站内 RSS 已死（403/404），只能扒 `/news/` 页面；单页 177 条但**不是**时间倒序，必须按时间重排 |
| 触乐 | 标题在 `h2` 或 `h3` 里，只取 h2 会漏一半；时间只到天 |
| GameLook | pubDate 是 GMT，不换算会整体早 8 小时；`/feed/` 偶发 502 |
| VGtime | 域名已死，首页是 SEO 镜像壳，**不要收录** |
| 小黑盒 | 接口需要签名，无公开稳定入口 |
