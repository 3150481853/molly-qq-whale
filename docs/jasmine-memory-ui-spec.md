# 茉莉花记忆系统（Jasmine）界面重构规格

Lead 定稿于 2026-11-05。执行者按此实现，Lead 只做验收。

## 0. 一句话

把现在「按类型堆一长条 `<details>`」的记忆页，改成**能翻得动的三栏浏览器**：
左边索引（类型 / 人物 / 权重 / 时间），中间结果列表，右边详情面板；同时把这一模块正式命名为
**茉莉花记忆系统**，英文 **Jasmine**。

## 1. 命名（全站可见文案）

| 位置 | 现在 | 改成 |
|---|---|---|
| 侧栏导航项 | 记忆（`◇`） | **Jasmine 记忆**（图标 `❀`） |
| 页面标题 | 记忆 | **茉莉花记忆系统** |
| 页面副标题 | 共 5428 条 · … | `Jasmine · 5,428 条 · 最近更新 11-05 11:56` |
| 总览统计卡 | 记忆 | **Jasmine 记忆** |
| 关于页「数据」卡 | 记忆 | **Jasmine 记忆** |
| 待核实副标题 | 通过后才会进正式记忆 | 通过后才会写进**茉莉花记忆** |
| 新增按钮 | + 新增记忆 | **+ 记一条** |
| 新增弹层标题 | 新增记忆 | **记一条新记忆** |
| 编辑弹层标题 | 改记忆 | **改这条记忆** |
| 删除弹层标题 | 删掉这条记忆？ | 保持 |
| 成功提示 | 已添加 | **已记下** |

要求：数据模型里的 `kind` 值（fact/person/…）与接口路径 `memory/*` **一律不改**，只改人看的字。

## 2. 数据与接口（不要新增后端）

- 列表：`POST /api/action/memory/list`，body `{}` → `{ok:true, data:{count, entries:[…]}}`（也兼容插件直连时 `entries` 在顶层）。
- 条目字段：`id, kind, who, qq, text, weight(1–10), source, level, hits, lastActiveDay, at(ms), lastHitAt(ms), edges?:[[id, score, at], …]`。
- 新增/改：`POST /api/action/memory/add|update`，body `{kind, who, qq, text, weight}`（update 另加 `id`）。
- 删除：`POST /api/action/memory/delete`，body `{id, confirm:true}`。
- 现有校验口径（正文 ≤200 码点、权重 1–10 一位小数、QQ 5–12 位非 0 开头）与 `openCrud`/`saveMemoryEntry`/`memDeleteExisting` 全部复用，不许重写一套。
- **只读降级**（`memory/list` 404 / `__http===0`）分支必须保留。

## 3. 布局

三栏在内容区内部（不要动 `.app` / `.sidebar` / `.topbar`）：

```
.jz-hero            ← 指标条 + 类型分布
.jz-body
  .jz-facets        ← 232px 索引栏（sticky）
  .jz-list          ← flex:1 结果区
  .jz-detail        ← 340px 详情（sticky，桌面常显）
```

断点：

- `min-width: 1280px`：三栏并排，详情常显。
- `1024–1279px`：索引栏折成顶部一排 chip（类型 + 权重），详情改为点击行后从右侧滑出的抽屉（`.jz-detail.is-drawer`，`transform:translateX(100%)` → `0`，180ms `cubic-bezier(.22,1,.36,1)`，遮罩 `rgba(18,26,22,.18)`）。
- `<1024px`：单栏。索引栏成为横向可滚的 chip 行；详情走抽屉；列表行压缩成两行（正文 2 行 + meta 1 行）。

## 4. 指标条（.jz-hero）

四个数字 + 一条类型分布：

1. 总条数 `5,428`
2. 今日新增（`at` 在今天 0 点之后）
3. 有身份（`qq` 非空）占比，显示 `4,812 · 89%`
4. 平均权重 `w6.1`

类型分布：单行水平堆叠条（7 段），段宽 = 该类占比，段间 2px 间隙；每段 `title` 给 `类型 条数·占比`；条下方是图例行（`类型名 条数`），点击图例等价于点索引栏对应项。
配色只用两种中性色相 + 主色强调，**不要七彩**：`--primary` 与 `rgba(25,33,30,.18)`，其余类型用透明度阶梯（.18/.30/.42/.54/.66/.78/.90 与主色 mix）。

## 5. 索引栏（.jz-facets）

四个分组，标题小字大写间距（沿用 `.nav-group-title` 的观感），组内是可选行：

- **类型**：7 项，带计数，选中项左侧 2px 主色竖条 + 文字加重。
- **人物**：按条数取前 12，行显示 `名字`（过长截断）+ 右侧计数；底部「全部人物（38）」展开成可滚列表（`max-height:220px`）。没有 `who` 的归到「未记名字」。
- **权重**：`核心 w≥8` / `常规 w5–7` / `边缘 w≤4`。
- **时间**：`今天` / `近 7 天` / `近 30 天` / `更早`（按 `at`）。

每组单选，组间 AND；顶部有「清除筛选」与当前筛选的 pill 回显（点 pill 取消该项）。

## 6. 结果区（.jz-list）

- 工具条：搜索框（占位「搜正文 / 人物 / QQ 号，空格分隔多个关键词」）、排序下拉（最近活跃 / 最近加入 / 权重 / 命中次数）、右侧 `5,428 条中 137 条`。
- 搜索：空格分词，词间 AND，匹配 `text+who+qq+kindLabel`，不区分大小写；命中片段在正文里用 `<mark>` 高亮（只需前 2 处，避免长文本爆量）。
- 行（`.jz-row`）：高 62px。第一行正文（2 行截断 `-webkit-line-clamp:2`）；第二行 meta：`11-05 11:13 · 事实 · 往事随风k · w6 · 命中 4`。hover 行尾出现 `改 / 删` 小按钮；选中行有 `box-shadow:inset 2px 0 0 var(--primary)`。
- 批量渲染：一次 60 条，滚动到距底部 240px 自动追加，另有「加载更多」按钮兜底；筛选/搜索变化时重置为 60 条并回到顶部。
- 空态：`没有符合条件的记忆` + 「清除筛选」按钮。加载态：6 行骨架条（`.is-skeleton`，`animation: jz-shimmer 1.2s infinite`），`prefers-reduced-motion` 下关闭。
- 键盘：`↑/↓` 移动选中行（不滚动整个页面，只 `scrollIntoView({block:'nearest'})`），`Enter` 打开详情，`Esc` 清空搜索。

## 7. 详情面板（.jz-detail）

自上而下：

1. 类型 chip + 权重胶囊（`w6`）+ 操作（改 / 删 / 关闭按钮，仅抽屉态显示关闭）。
2. 正文全文（`white-space:pre-wrap`，`font-size:14.5px`，`line-height:1.75`）。
3. 元数据表（`.kv` 风格）：人物 / QQ / 来源（`source`）/ 层级（`level`）/ 命中（`hits` 次）/ 上次命中 / 记录时间。
4. 关系：`edges` 数量；展开列出前 8 条，每条把目标 id 解析成「类型 + 正文前 24 字」，点击把该条设为选中（若不在当前筛选结果里，提示「这条不在当前筛选内」并清除筛选后定位）。
5. 快捷筛选：`只看这个人` / `只看这个类型`。

空态：`从左边挑一条记忆看详情`。

## 8. 视觉

- 沿用现有 token（`--primary` 墨绿、暖纸、MiSans、`--hairline`）与玻璃材质；卡片圆角 10–12px，阴影只用 `0 1px 2px rgba(30,45,35,.04), 0 18px 36px -26px rgba(30,45,35,.28)`。
- 新增一个 20px 的**茉莉花线稿 mark**（内联 SVG，5 瓣，`stroke:currentColor`、`stroke-width:1.25`、`fill:none`）放在页面标题左侧与空态里；不要外链图片。
- 数字一律 `.mono`；行内分隔用 `.` 与 hairline，不要新加横线分隔面板。
- 允许的新增动画只有：抽屉滑入 180ms、行选中 120ms、骨架闪烁；全部在 `prefers-reduced-motion` 下关闭。
- 不要引入任何第三方库、不要内联 `<style>`、不要 `!important`（除既有例外）。

## 9. 交付与验收

- 只允许改这三个文件：`${MOLLY_ROOT}\qq-whale\console\index.html`、`console\console.js`、`console\console.css`。**不要碰** `tools\`、`dist\`、`desktop\`、插件目录。
- 预览（不要动生产 19392）：
  ```powershell
  $env:MOLLY_CONSOLE_DIR='${MOLLY_ROOT}\qq-whale\console'
  $env:MOLLY_CONSOLE_PORT='19411'
  Start-Process '${MOLLY_ROOT}\qq-whale\dist\molly-console.exe' -ArgumentList '--no-browser' -WorkingDirectory '${MOLLY_ROOT}\qq-whale\dist'
  ```
  然后 `http://127.0.0.1:19411/?shell=desktop#/memory`（浏览器/ego/Edge headless 均可；桌面壳的玻璃观感由 Lead 复验）。
- 验收清单：
  1. 页面能列出 5,428 条而不卡（首屏 ≤1.5s，滚动追加无长任务 >200ms）。
  2. 搜索 `无人之岛` 有命中且高亮；`往事随风k` 能按人物命中；`1302670175` 能按 QQ 命中。
  3. 类型（如「约定 1376」）+ 时间（近 7 天）+ 人物三组筛选组合生效，计数随之变化，「清除筛选」可一键复位。
  4. 点击行 → 详情显示完整正文、元数据、`edges` 关系；「只看这个人」生效。
  5. 改 / 删 / 新增仍走原弹层与原校验（删除仍需 confirm）；**不要真的写入或删除生产记忆**，只验证弹层打开、校验提示、取消关闭。
  6. `node --check console.js` 退出 0；CSS 花括号平衡；三文件 UTF-8 无 BOM。
  7. 1440 与 390 宽无横向溢出（390 用 ego 的 `Emulation.setDeviceMetricsOverride` 实测 `scrollWidth==clientWidth`）。
  8. 其余 14 个页面不报错、切换仍走 §33 的过渡动画、`window.onerror` 为 0。
- 报告：改了哪些行（文件:行号）、验收每一项的实测数字或截图路径（放 `${MOLLY_ROOT}\qq-whale\out\jasmine-*.png`）。
## 8. 记忆曲线（权重衰减）的可见化（2026-11-05）

主人问「现在茉莉花还有记忆曲线降权吗，为什么我看全都是权 6」。查下来两件事：

1. **曲线一直在跑，但一条都还没到掉权的时候。** 真正生效的实现是 `plugin/dsh-qq-whale/lib/memory.js` 的
   `effectiveWeight(entry, activeDays)`：盘上只存基础权重 `weight` + `hits` + `lastActiveDay`，衰减在读取时现算 ——
   `idle = activeDays − lastActiveDay`，超过该类宽限期后 `floor((idle − grace) / 7)` 步、每步 −0.5，夹在该类下限与 10 之间。
   `WEIGHT_FLOOR = { address:10, promise:5, person:4, fact:3, preference:3, event:1, meme:1 }`、
   `GRACE_ACTIVE_DAYS = { address:∞, promise:14, person:14, fact:14, preference:14, event:7, meme:7 }`、`DECAY_STEP_DAYS=7`、`DECAY_STEP=0.5`。
   当时 `activeDays = 10`、最长空闲 10 天 → 事实/约定/人物/偏好还没过 14 天宽限，闲聊/梗虽只有 7 天宽限但 `floor((10−7)/7)=0` 仍是 0 步，所以 5,432 条**全部 `decayed: 0`**。
2. **界面只显示基础权重。** `GET /memory/list` 直接回盘上的 `weight`，页面照抄，于是满屏 `w6`（抽取默认权重就是 6）。

### 改了什么

- `tools/console-server.mjs`：`/api/overview` 的 `plugin.memory` 增加 `activeDays` 与 `activeDayKey`（衰减唯一时间轴）。
- `console/console.js`：
  - 新增 `JZ_DECAY_FLOOR / JZ_DECAY_GRACE / JZ_DECAY_STEP_DAYS / JZ_DECAY_STEP`（注释要求与 plugin 侧同步）、
    `jzActiveDays()`（优先后端 `memory.activeDays`，缺失时退化为 `max(lastActiveDay)`）、`jzDecay(it)` → `{base, eff, idle, grace, steps, floor, days}`、`jzWLabel(it)`。
  - 列表行与详情头改显示有效权重：没掉权 `w6`，掉权 `w6→5.5`（`.jz-wdown` 上色）。
  - 「按权重」排序、权重档筛选（核心/常规/边缘）、hero 的「平均权重」全部改用 `eff`。
  - hero 增加一行 `.jz-decay-note`：「衰减曲线：活跃天 10 天 · 事实/约定/人物/偏好宽限 14 天、闲聊/梗 7 天，之后每 7 活跃天 −0.5 · 还没有条目掉权」。
  - 详情 kv 增加「权重」行：`w6 → w5.5` + 「空闲 N 活跃天 · 宽限 N 天」。
- `console/console.css` §36：`.jz-wdown`、`.jz-decay-note`（`flex:0 0 100%` + 顶部细分隔线）、`.jz-kv-hint`。

### 验收

- `/api/overview` → `plugin.memory = {"count":5432,"activeDays":10,"activeDayKey":"2026-11-05"}`，build `27e0ea97`。
- 桌面壳 `#/memory`：`.jz-decay-note` 文案如上；指标「总条数 5,432 / 今日新增 130 / 有身份 4,517 · 83% / 平均权重 w5.7」；前 60 行权重 `w6`、`.jz-wdown` 计数 0（符合「还没到掉权」）；详情 kv 显示「权重 w6 空闲 0 活跃天 · 宽限 14 天」。
- 截图 `out\decay-ui-1.png`（2040x1320，含 hero 曲线说明、列表、详情）。

### 以后要是想让它更早掉

只改一处即可（`plugin/dsh-qq-whale/lib/memory.js` 的 `GRACE_ACTIVE_DAYS`）：例如把 fact/person 的 14 天改成 7 天，或把 `DECAY_STEP_DAYS` 改成 5。控制台这边的 `JZ_DECAY_*` 必须同步，否则显示的与召回用的不是一个数。
## 9. 中栏滚动、按日期看、排序（2026-11-05，主人反馈后补）

主人原话：「中间的有点难滑动啊，你加一个滑动条，并且可选择按日期选择或者直接这样滑动，同时可以按时间正倒序，按权重正倒序」。

### 9.1 中栏自己滚（不再整页滚）
`console.css` §37：
- `.jz-list{display:flex;flex-direction:column;max-height:calc(100vh - 150px);min-height:360px}`
- `#memGroups{flex:1 1 auto;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable}`

意义：列表区变成独立滚动容器，左手索引、右手详情都不动；滚到列表底不会再带动整页。

### 9.2 常显滚动条
`#memGroups::-webkit-scrollbar{width:12px}`，命中区 12px、视觉拇指 6px（`border:3px solid transparent` + `background-clip:content-box`），轨道 `rgba(25,33,30,.055)`、拇指 `rgba(25,33,30,.42)`、hover `.58`、`min-height:48px`。实测列表 clientHeight 480 / scrollHeight 7440 时拇指清晰可见、可拖。
视口 <1280 时退回整页滚动（`.jz-list{max-height:none}`、`#memGroups{overflow:visible}`），避免窄屏两处滚动打架。

### 9.3 按日期看某一天
- 常驻 `#jzDate`（工具条第二行，`type="date"`），不再藏在左侧索引底部（那里要滚很久才看得见）。
- `memView.day` 与「今天 / 近 7 天 / 近 30 天 / 更早」互斥：设日期清时间桶，点时间桶清日期。
- 生效后出现可点掉的胶囊「日期：11-04 ×」，计数变成「5,436 条中 223 条」。
- JS：`jzDayKey(ms)`（本地时区 YYYY-MM-DD）、`jzTodayKey()`、`jzSyncDate()`（回填值 / 设 `max` 为今天 / 切 `.is-on` 高亮）；`jzPass` 里 `if (skip !== 'day' && memView.day && jzDayKey(it.at) !== memView.day) return false;`。

### 9.4 排序
| 值 | 文案 | 说明 |
| --- | --- | --- |
| `added` | 时间：新→旧 | 默认，按加入时间 |
| `old` | 时间：旧→新 | 按加入时间倒过来 |
| `active` | 最近活跃 | 命中过就按最后命中时间，没命中按加入时间 |
| `weight` | 权重：高→低 | 用**有效权重**（含衰减） |
| `weight-asc` | 权重：低→高 | 同上，升序 |
| `hits` | 命中次数 | 召回次数 |

工具条布局：搜索独占一行，第二行放排序 + 日期 + 计数（`.jz-toolbar{flex-wrap:wrap;row-gap:6px;padding:8px 12px}`，`.jz-search{order:0;flex:1 1 100%}`、`.jz-sort{order:1}`、`.jz-date-slot{order:2;flex:0 0 140px}`、`.jz-count{order:3;margin-left:auto}`）。

### 9.5 验收（CDP，窗口 1324x739）
- 列表滚动：`scrollTop` 可到 `scrollHeight - clientHeight`（3278），滚到底拇指到底。
- 日期 `2026-11-04` → 计数「5,436 条中 223 条」、胶囊出现；点胶囊 → 计数回「5,436 条」、日期框清空、高亮撤销。
- `old` 首行 `10-17 17:53`（升序）；`weight-asc` 首行全 `w4`。
- `node --check console.js` 退出 0；`console.css` 95,818 字符、花括号 895/895；三份副本同步；干净重启后 `/api/health` build `b5ada9b4`。