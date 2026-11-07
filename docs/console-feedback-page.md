# 问题反馈页（控制台 · #/feedback）

面向部署者的 bug / 建议收集入口。要求必须写 **bot 名称**——同一套插件有很多人在跑，站长靠这个字段认出是哪一台部署出问题。

- 前端：`console/index.html`（`#fbPage` 段，581 行起）、`console/console.js`（`fbState`…`bindFeedback`）、`console/console.css`（§42 表单 / §43 说明卡）
- 后端：`tools/console-server.mjs` 的三个动作 `feedback/meta`、`feedback/submit`、`feedback/list`
- 存档目录：`<Molly>/qq-whale/out/feedback/`
- 配置：`<Molly>/qq-whale/out/feedback-config.json`

## 一、页面结构

左右两列（`.fb-grid`：左表单 1.55fr / 右侧栏 1fr，1180px 以下自动单列）：

| 区域 | 内容 |
| --- | --- |
| 左卡 | bot 名称（必填）、一句话标题（必填）、类型、发生时间、发生了什么（必填）、怎么复现（可选）、附带日志三勾选、提交按钮 + 状态行、提交结果面板 |
| 右栏 `.fb-side` | 「本机存档」列表（可点行复制路径）、「提交之后会怎样」三步说明 + 脱敏说明 |

类型取值：`bug` 功能坏了 / `ui` 界面·显示问题 / `perf` 卡顿·占用高 / `docs` 文档看不懂 / `feature` 想要的新功能 / `other` 其它。

进页自己会拉一次 `feedback/meta` + `feedback/list`（60 秒 TTL），点右上角「重新读取」或顶栏刷新是强制重拉。

## 二、一次提交发生了什么

1. **本机落盘**：`out/feedback/<本地时间戳>-<标题slug>.md` 与同名 `.json`。时间戳是本地时间（`YYYYMMDDHHmmss`），不是 UTC——否则 23:42 提交的文件会叫 `154209`。
2. **尝试发论坛**：`POST <forumBase>/api/forum/posts/<postId>/comments`，body `{content: markdown}`；配置了 `bugKey` 时额外带 `x-bug-key` 头（给站长做「只为 Molly 客户端放行」的凭据）。
   - 成功 → 结果面板标题「已提交（论坛 + 本机存档）」，状态 `ok`。
   - 401 `login-required` / 网络失败 → 结果面板标题「已存到本机（论坛要手动贴）」，状态 `warn`，并把生成的 Markdown 放进只读框，一键复制去论坛贴。
3. **提醒站长**：读 `tools/watchdog-config.json` 的 `notify`，`enabled && type === 'pushplus' && token` 时 `POST https://www.pushplus.plus/send`（`code:905` = 账号未实名，只影响推送，不影响提交）。
4. **结果面板**：只读 Markdown + 「复制内容」「打开论坛」（`window.open` → 桌面壳里走系统默认浏览器）。

提交成功后不会再被论坛状态提示覆盖状态行（`renderFeedback()` 里 `resultShown` 守卫）。

## 三、脱敏规则（`maskFeedbackText()`）

| 目标 | 处理 |
| --- | --- |
| QQ 号 / 手机号 | 保留前 5 后 2，中间 `****`（正则 `(?<!\d)(\d{5})\d{2,6}(\d{2})(?!\d)`） |
| 本机绝对路径 | `${HOME}\...\file.log` → `<本机>\file.log` |
| token / secret / password / authorization 一类键 | 值换成 `<已隐去>` |

日志只取白名单三份（`console` / `watchdog` / `plugin`），每份末尾 120 行、5000 字符，放进 Markdown 的 `<details>` 折叠块。

## 四、后端动作

| 动作 | 入参 | 说明 |
| --- | --- | --- |
| `feedback/meta` | `{}` | `GET <forumBase>/api/forum/posts/<postId>` 探活（**不会发空评论**，避免论坛放权后留垃圾楼层）；回 `{config, forum:{reachable,error}, forumUrl, kinds, logs}` |
| `feedback/submit` | `{bot,title,kind,when,desc,steps,logs}` | 校验 bot/title/desc → 落盘 → 发论坛 → 推送；回 `{saved,savedPath,posted,forumUrl,forumError,pushed,pushError,markdown}` |
| `feedback/list` | `{}` | 最近 12 份存档，回 `{dir, items:[{name,path,size,at,title}]}` |

## 五、配置 `out/feedback-config.json`

```json
{
  "forumBase": "https://example.asia",
  "postId": 35,
  "bugKey": "",
  "mineBot": "Molly"
}
```

`bugKey` 留空即匿名提交（当前论坛对匿名一律 401，所以会走「存本机 + 复制 Markdown」降级路径）；站长放权后把 key 填进来即可直发。`mineBot` 用来预填 bot 名称。

## 六、验收记录（2026-11-06/07）

- `feedback/meta` → `forum.reachable = true`，`forumUrl = https://example.asia/dsh/forum/35`
- `feedback/submit`（脚本）→ `saved = true`、`posted = false`、`forumError = 论坛还没放权匿名提交（401 login-required）…`、`pushed = true`
- `feedback/submit`（页面点按钮，端到端）→ 结果面板「已存到本机（论坛要手动贴）」，Markdown 5789 字，`#fbOpen` 带正确 `data-url`，存档列表实时多一条
- 生产环境（`dist/desktop/molly-console.exe`，端口 19392，`1.1.8-preview.2`）截图确认：两列布局、右侧两张卡对齐、`#fbBot` 带 `required`、进页即拉到存档列表
- 三个前端副本已同步：`console/`、`dist/console/`、`dist/desktop/console/`

## 七、已知限制

- 论坛匿名发帖未放权（`POST .../comments` → 401），需要站长按 `docs/forum-anonymous-bug-api-request.md` 开放；在那之前只能「存本机 + 复制粘贴」。
- PushPlus 未实名时 `code:905`，推送失败不影响存档与发帖。
- 存档不会自动清理；`out/feedback/` 涨起来可以手动删，删了不影响插件。
