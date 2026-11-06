# 论坛接口放权请求：让部署者不登录也能提交 bug

> 这份是给站长看的。Molly 控制台新加了一个「问题反馈」页，用户填完直接向论坛发一条 bug 楼层；现在被 `login-required` 挡住了。

## 一、现状（实测）

| 请求 | 结果 |
| --- | --- |
| `GET /api/forum/posts` | 200 |
| `GET /api/forum/posts/35` | 200 `{"post":{id:35,…}}` |
| `POST /api/forum/posts/35/comments`，body `{"content":"…"}`，无 cookie | **401 `{"error":"login-required"}`** |
| `POST /api/forum/bugs` | 404 |
| `POST /api/bug-reports` | 404 |

也就是说：评论接口存在、格式清楚，但没有「非登录 + 非浏览器」的入口。部署者大多数只装插件、不在论坛注册，让他们为了报一个 bug 先注册登录，实际上等于不报。

## 二、请求：加一个专用端点

**首选**：`POST /api/forum/bugs`（不影响现有评论的权限模型）

**次选**：在 `POST /api/forum/posts/35/comments` 上放行「带凭据头」的匿名请求

```
POST /api/forum/bugs
content-type: application/json
x-bug-key: <给 Molly 客户端的固定 key，可随时轮换>

{
  "bot": "Molly",                         // 必填：哪一台部署（重名多，靠它认机器）
  "title": "在线时间页 90 天视图柱子挤成一条",   // 必填，≤120 字
  "kind": "bug",                          // bug|ui|perf|docs|feature|other
  "when": "2026-11-07T00:08",             // 用户填的发生时间（本地时间，无时区）
  "desc": "看到什么、期望什么",             // 必填，≤4000 字
  "steps": "点了哪、第几步开始不对",         // 可选
  "env": {
    "version": "1.1.8-preview.2",
    "build": "0209ddea",
    "platform": "win32 x64",
    "node": "v24.21.0",
    "port": 19392,
    "pid": 27216,
    "uptimeMin": 12,
    "totalMb": 1866,
    "grandTotalMb": 9842,
    "atLocal": "2026/11/7 00:08:12"
  },
  "logs": { "console": "…末尾 120 行…", "watchdog": "…", "plugin": null }
}
```

**返回**：`200 {"ok":true,"commentUrl":"https://example.asia/dsh/forum/35#c1234","id":1234}`；失败用 4xx + `{"error":"…"}`（客户端会退回「本地存档 + 复制 Markdown」的降级路径，不会丢反馈）。

## 三、建议的防护（都能在服务端做，不需要客户端配合）

1. **凭据头**：`x-bug-key` 不对就 401。key 只发给 Molly 客户端，泄露了换一个即可。
2. **限流**：同一 IP 每小时 ≤5 条、全天 ≤20 条；同一 `bot` 每小时 ≤3 条。
3. **体积上限**：body ≤ 256 KB；`logs` 每份 ≤ 32 KB，超了截断而不是拒绝。
4. **内容处理**：`title`/`desc` 做长度裁剪 + HTML 转义（防 XSS）；链接数 ≤3。
5. **落库标记**：存 `source='molly-client'`、IP 哈希、`user_agent`，方便事后批量清理或拉黑。
6. **审核开关**：可以先让这类楼层进「待审核」，站长后台放行后公开——比直接公开更稳。
7. **可关闭**：一个开关（比如环境变量或后台设置）就能整体停掉这个端点，不用改代码。

## 四、客户端已经做好的事（不需要站长额外投入）

- 提交前自动脱敏：QQ 号打码、本机绝对路径换成 `<本机>\<文件名>`、`token/secret/password` 一类字段值隐去。
- 日志是白名单三份（控制台 / 守护 / 插件），各取末尾 120 行，不是整份日志。
- 论坛连不上、或接口返回 401 时，反馈仍然会存到用户本机 `out/feedback/`，同时把整段 Markdown 显示在页面上供复制——所以**即使不放权，反馈也不会丢**，只是需要人工搬运。
- key 通过 `out/feedback-config.json` 的 `bugKey` 字段下发，改成空字符串即恢复纯匿名。

## 五、放权之后客户端怎么用

1. 站长把 key 发回来，写进 `out/feedback-config.json`：`{"forumBase":"https://example.asia","postId":35,"bugKey":"<key>"}`。
2. 用户下次提交：`POST /api/forum/posts/35/comments`（带 `x-bug-key`，兼容现有的评论接口）或 `POST /api/forum/bugs`（如果做了专用端点）。
3. 页面结果面板会显示「已提交（论坛 + 本机存档）」，不再需要手动粘贴。

## 六、验证用 curl

```bash
curl -i -X POST https://example.asia/api/forum/bugs \
  -H 'content-type: application/json' \
  -H 'x-bug-key: test-key' \
  -d '{"bot":"Molly","title":"接口联调","kind":"bug","desc":"这是客户端联调用的测试反馈","env":{"version":"1.1.8-preview.2"}}'
```

期望：`200 {"ok":true,"commentUrl":"…"}`；`x-bug-key` 错则 `401 {"error":"bad-bug-key"}`。

## 七、为什么值得做

- 部署者反馈的路径从「找群、截图、描述、等回复」变成「页面里填三行、点一下」。
- 反馈自带版本号、构建号、进程占用与脱敏日志，定位成本大幅下降。
- 端点只服务 Molly 客户端、带 key、带限流，风险面比「开放匿名评论」小得多。
