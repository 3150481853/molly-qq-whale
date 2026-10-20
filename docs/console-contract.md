# Molly 控制台 —— 接口契约（v1）

> 这份文件是**唯一事实来源**。服务端、前端、面板入口三方都按它写，不要各自发明字段。
> 契约变更必须先改这份文件，并在文末「变更记录」追加一行。

## 0. 架构决策（为什么是独立进程）

控制台**不是** DSH 插件路由，而是一个**独立 Node 进程** + **独立浏览器窗口**。

理由（2026-10-18 实测教训）：

1. DSH 插件的 `lib/*.js` 改了必须重启宿主才生效，而重启宿主会**杀掉正在登录的 QQ 会话**
   （今晚已因此掉线两次）。控制台要长期迭代，绝不能每次改 UI 都冒这个险。
2. 控制台要控制的东西**超出插件边界**：守护脚本（watchdog）、NapCat 进程、登录二维码、
   Windows 计划任务。插件进程内做这些事很别扭，独立进程 spawn 一下就行。
3. `assets/*` 虽然能热读，但只能改挂件，做不出「独立窗口 + 完整仪表盘」。

窗口形态：`msedge.exe --app=http://127.0.0.1:19392/`，即一个无地址栏的独立窗口，
看起来就是一个桌面应用（用户要的「另一个窗口」）。

## 1. 端口与进程

| 进程 | 端口 | 说明 |
|---|---|---|
| DSH 宿主（插件 `/dsh-qq-whale/*`） | 7053 | 由 DSH 决定，可能变，**不写死** |
| 数据服务 `panel-data.mjs` | 19391 | 已存在，只读数据 |
| **控制台 `console-server.mjs`** | **19392** | 本次新增，只读 + 可执行动作 |
| NapCat WebUI | 6099 | 需 JWT 鉴权（见 §6） |
| OneBot WS | 3001 | 插件连它 |

控制台**只监听 127.0.0.1**，不对外暴露。

## 2. 静态资源

```
GET /                      → console/index.html
GET /console.js            → console/console.js
GET /console.css           → console/console.css
GET /favicon.ico           → 204 或内联图标
```

**禁止引用任何外部 CDN**（本机曾整网中断，控制台必须离线可用）。
只用原生 HTML/CSS/JS，不用框架、不用构建步骤。

## 3. 数据接口（全部 GET，只读）

### 3.1 `GET /api/health`
```json
{ "ok": true, "version": "1.0.0", "at": 1792330000000 }
```

### 3.2 `GET /api/overview`
一次拿全仪表盘要的所有东西。任何上游挂了都**不能**让整个接口 500，
对应字段置为 `{ "reachable": false, "error": "..." }`。

```json
{
  "ok": true,
  "at": 1792330000000,
  "plugin": {
    "reachable": true,
    "enabled": true,
    "link": { "ready": true, "state": "online" },
    "bot": { "userId": "111111111", "nickname": "Molly" },
    "model": "deepseek-v4.1-flash",
    "metrics": { "messages": 222, "conversations": 10, "avgReplySeconds": 88.7, "lastReplyAt": "...", "lastReplyMs": 44839 },
    "memory": { "count": 42 },
    "stickers": { "count": 15, "learned": 15 },
    "budget": { "enabled": true, "dailyCap": 500, "used": 0.05, "day": "2026-10-18" },
    "learner": { "kept": 0, "rejected": 0, "dup": 0 }
  },
  "napcat": {
    "reachable": true,
    "isLogin": true,
    "loginPhase": "ready",
    "coreReady": true,
    "uin": "111111111",
    "qrcodeurl": "",
    "loginError": ""
  },
  "watchdog": {
    "reachable": true,
    "state": { "lastState": "online", "lastOnlineAt": 1792330000000, "offlineSince": 0, "recoverAttempts": 0, "consecutiveFails": 0, "lastNotifyAt": 1792330000000 },
    "config": { "enabled": true, "intervalMinutes": 10, "quietHours": [0,9], "repeatMinutes": 60, "autoRecover": true, "maxAutoRecoverAttempts": 3, "slowRecoverMinutes": 30, "settleMinutesAfterRecover": 30, "notifyOnRecover": true },
    "quiet": false,
    "taskEnabled": true,
    "lastRun": "2026-10-18 22:00:01",
    "lastResult": 1
  },
  "sidecar": {
    "reachable": true,
    "memory": { "count": 42, "groups": { "主人": 4, "杂项": 15 } },
    "stickers": { "count": 15 },
    "metrics": { "messages": 222 },
    "budget": { "cap": 500 }
  }
}
```

字段缺失用 `null`，不要用空字符串假装有值。

### 3.3 `GET /api/logs?source=watchdog|plugin&tail=200`
```json
{ "ok": true, "source": "watchdog", "path": "...\\out\\watchdog.log", "lines": ["...", "..."] }
```
- `source=watchdog` → `qq-whale/out/watchdog.log`
- `source=plugin` → 插件自己落的日志文件；**没有就返回 `lines: []` 且 `note: "该日志不存在"`**，不要报错
- `tail` 默认 200，上限 2000

### 3.4 `GET /api/memory`
透传 `19391/api/memory`，原样返回（不要改结构）。

### 3.5 `GET /api/stickers`
透传 `19391/api/stickers`。

### 3.6 `GET /api/sticker/<文件名>`
透传 `19391/sticker/<文件名>`，保留原 `Content-Type`。
**必须校验文件名**：只允许 `[A-Za-z0-9_\-.()\u4e00-\u9fa5]+`，禁止 `..`、`/`、`\`。

### 3.7 `GET /api/qr/latest.png`
返回最近一次生成的二维码 PNG（`qq-whale/out/console-qr.png`）。
不存在 → 404 `{ "ok": false, "error": "还没有二维码，先点「生成二维码」" }`。

## 4. 动作接口（全部 POST，`Content-Type: application/json`）

统一响应：
```json
{ "ok": true, "action": "watchdog/once", "at": 1792330000000, "data": { }, "stdout": "", "durationMs": 812 }
```
失败：`{ "ok": false, "action": "...", "error": "人话原因", "stdout": "...", "durationMs": 12 }`，HTTP 状态用 400/409/500/503。

### 4.1 破坏性动作必须显式确认
凡是会**重启进程 / 改写配置 / 改动计划任务**的动作，请求体必须含 `"confirm": true`，
否则返回 **409** 和 `{ "ok": false, "error": "需要 confirm:true 才执行" }`。
前端必须在按钮上加二次确认（window.confirm 也行，但文案要说清后果）。

### 4.2 动作清单

| action | body | 说明 | 需 confirm |
|---|---|---|---|
| `plugin/toggle` | `{enabled:boolean}` | 转 `POST 7053/dsh-qq-whale/toggle` | 否 |
| `plugin/recheck` | `{}` | 转 `/recheck` | 否 |
| `plugin/budget` | `{enabled?:boolean, cap?:number}` | 转 `/budget` | 否 |
| `plugin/work-probe` | `{}` | 转 `/work/probe` | 否 |
| `plugin/work-run` | `{task:string}` | 转 `/work/run`，`task` 不能空 | 否 |
| `plugin/research-test` | `{text:string}` | 转 `/research/test` | 否 |
| `napcat/qr` | `{}` | spawn `make-qr.mjs`，成功后 `data.png = "/api/qr/latest.png"`、`data.url` | 否 |
| `napcat/restart` | `{confirm:true}` | spawn `start-molly.ps1 -Restart`，**会踢掉当前登录** | **是** |
| `watchdog/status` | `{}` | spawn `watchdog.mjs --status`，返回解析后的 JSON 到 `data` | 否 |
| `watchdog/once` | `{}` | spawn `--once` | 否 |
| `watchdog/test-notify` | `{}` | spawn `--test-notify` | 否 |
| `watchdog/config` | `{confirm:true, patch:{...}}` | 合并写 `watchdog-config.json`（只允许 §3.2 里列出的键） | **是** |
| `watchdog/task` | `{confirm:true, enable:boolean}` | `schtasks /Change /TN Molly-Watchdog /ENABLE|/DISABLE` | **是** |
| `process/start-napcat` | `{confirm:true}` | spawn `start-molly.ps1`（不带 -Restart） | **是** |

`plugin/*` 的转发**必须先把 7053 端口探出来**（从 `/state` 探测或读配置），不要写死；
宿主端口每次重启都会变。

## 5. 前端要求（console/index.html + console.js + console.css）

### 5.1 布局
- 左侧固定导航（宽 200px）：总览 / 会话与消息 / 记忆 / 表情包 / 预算 / 干活 / 守护 / NapCat / 执行块 / 设置
- 顶部状态条：Molly 在线灯、当前模型、积分用量、NapCat 登录态、守护最近一次结果、最后刷新时间
- 主区：卡片网格（`.card`），卡片标题 + 关键数值 + 操作按钮
- 右下角浮动日志抽屉：可展开看 `watchdog` 日志尾部，自动滚到底

### 5.2 数据刷新
- 默认 **4 秒**轮询 `/api/overview`
- 切到后台标签页时暂停（`document.visibilityState`），回来立刻刷一次
- 轮询失败**不要把界面清空**，只在状态条上标红「连接中断（上次数据 12 秒前）」

### 5.3 执行块（用户明确要的功能）
「执行块」页要把 §4.2 的动作渲染成**卡片**，每张卡：
- 标题 + 一行说明 + 参数输入（需要的话）+ 执行按钮
- 需要 confirm 的卡用红色按钮，并在卡片上写明「会踢掉当前登录」之类的后果
- 执行中显示 spinner，执行完把 `stdout` 尾部和 `durationMs` 展示在卡片下方（可折叠）
- 失败要显红并把 `error` 显示出来

### 5.4 视觉
**严格按 `qq-whale/docs/console-design.md` 执行**（浅色 Notion 系，来源 awesome-design-md 的 notion DESIGN.md）。

要点复述（细节看那份文件，冲突时以它为准）：
- **浅色**，不做深色主题
- 颜色/圆角/间距**全部**走 `:root` 的 CSS 变量，不许散落魔法值
- 主按钮紫 `#5645d4`，8px 圆角（**不是胶囊**）；卡片 12px 圆角 + 1px `#e5e3df` 边框，**默认无阴影**
- 数字用 `--font-mono` + `tabular-nums`
- 危险按钮白底红框红字，并写明后果
- 目标窗口 1280×860，最小 1024×700，不要横向滚动条

## 6. NapCat 鉴权（服务端实现参考）

`/api/QQLogin/*` 需要 `Authorization: Bearer <base64(JSON{Data:{CreatedTime,HashEncoded},Hmac})>`：

```js
const SECRET = process.env.NAPCAT_WEBUI_JWT_SECRET_KEY || '${NAPCAT_JWT_SECRET}'
const TOKEN  = '${NAPCAT_TOKEN}'
const hash = crypto.createHash('sha256').update(TOKEN + '.napcat').digest('hex')
const data = { CreatedTime: Math.floor(Date.now()/1000), HashEncoded: hash }
const hmac = crypto.createHmac('sha256', SECRET).update(JSON.stringify(data), 'utf8').digest('hex')
const bearer = Buffer.from(JSON.stringify({ Data: data, Hmac: hmac })).toString('base64')
```

**不要在日志里打印 token/secret。**

## 7. 约束（写代码前先读）

1. **绝对不要改 `plugin/dsh-qq-whale/lib/*.js`** —— 那需要重启 DSH，会杀掉 QQ 登录。
2. **绝对不要在开发过程中执行 `start-molly.ps1 -Restart` / `napcat/restart`** —— 会踢掉线上 Molly。
   要验证就只验证「命令拼装正确」，不要真的跑。
3. 服务端只用 Node 内置模块（`http`/`fs`/`child_process`/`crypto`），**不要装依赖**。
4. 所有 `spawn` 都要带超时（默认 30s，`napcat/qr` 45s，`watchdog/once` 120s），超时要 kill。
5. Windows 上 spawn `powershell.exe` 用 `-NoProfile -ExecutionPolicy Bypass -File`。
6. 路径里的中文不要紧，但**不要用 `shell: true`**（会因编码/空格炸掉）。
7. 写文件一律 `UTF-8 无 BOM`（`fs.writeFileSync(p, s, 'utf8')` 即可；**不要用 PowerShell 的 `Set-Content -Encoding UTF8`，会加 BOM**）。

## 8. 验收标准

- [ ] `node --check` 全部通过
- [ ] `curl http://127.0.0.1:19392/api/health` → `{"ok":true,...}`
- [ ] `curl http://127.0.0.1:19392/api/overview` → `plugin.link.state` 为 `online`（Molly 在线时）
- [ ] 浏览器打开 `http://127.0.0.1:19392/` 无 console error，10 个导航页都能点
- [ ] 断网/关掉 19391 后，`/api/overview` 仍返回 200，`sidecar.reachable=false`
- [ ] `POST /api/action/watchdog/status` 返回 `ok:true` 且 `data.lastState` 有值
- [ ] `POST /api/action/napcat/restart`（不带 confirm）→ 409
- [ ] 执行块里所有卡片都能渲染，按钮有 disabled 态

## 变更记录

- 2026-10-18 v1 初稿（Lead）
