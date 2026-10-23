# 信源探测输出契约

每个探测员只写自己负责的文件，不要碰 `app/` 目录。

产物：
1. `research/sources/<domain>.json` —— 机器可读，主交付物
2. `research/sources/<domain>.md` —— 给人看的结论 + 踩坑记录
3. `research/probes/<domain>.mjs` —— 可重跑的探测脚本（`node research/probes/<domain>.mjs` 必须能直接跑出上面的 json）

## JSON 结构

```json
{
  "domain": "cn-media",
  "probedAt": "2026-10-23T12:00:00+08:00",
  "sources": [
    {
      "id": "gcores",
      "name": "机核",
      "role": "media",
      "region": "cn",
      "type": "rss",
      "url": "https://www.gcores.com/rss",
      "verified": true,
      "httpStatus": 200,
      "latencyMs": 210,
      "itemCount": 20,
      "latestAt": "2026-10-23T09:12:00+08:00",
      "fields": {
        "title": true,
        "link": true,
        "publishedAt": true,
        "summary": true,
        "image": true,
        "heat": false,
        "author": true
      },
      "headers": {},
      "notes": "标准 RSS 2.0，摘要含 HTML，需要去标签；发布时间为 UTC+8",
      "failure": null,
      "sample": [
        { "title": "……", "url": "https://……", "publishedAt": "2026-10-23T09:12:00+08:00" }
      ]
    }
  ],
  "rejected": [
    { "name": "小红书", "reason": "接口需要签名，无公开稳定入口", "tried": ["url1", "url2"] }
  ]
}
```

## 字段约定

- `role`：`media`（垂媒/综合） | `community`（社区热榜） | `overseas`（海外） | `platform`（平台厂商） | `signal`（引进信号） | `internal`（TapTap 站内）
- `type`：`rss` | `json` | `html`
- `fields.publishedAt`：**最重要**。没有它就没法判断时效，两条雷达都会废。必须实测确认是真时间还是抓取时间。
- `fields.heat`：有热度/评分/评论数/播放量等排序依据时标 true，并写进 `notes`（字段名与量级）。
- `headers`：请求必须带的头（UA / Referer / Cookie 结构）。不要写真实 cookie 值，写 `"Cookie": "<需用户提供>"`。
- `failure`：失败时填字符串原因，`verified: false`。
- `sample`：3–5 条，必须来自本次实测的真实返回，标题原样照抄。

## 判定标准

- **verified 只给实测拿到 ≥5 条带标题的数据源。** 返回 200 但内容是 JS 空壳的，算失败。
- 只测公开可访问的入口。**不要尝试登录、绕过验证码、破签名。**
- 每个源至少试 2 个候选入口（站内 RSS / RSSHub 路由 / 页面 JSON 接口 / sitemap）。
- 记录**分页与条数上限**，以及「一次抓到多少条算合理」。
- 礼貌抓取：同一域名连续请求间隔 ≥1s，单源不超过 5 次请求。
- 时间统一写成带 +08:00 的 ISO 格式。
