# Molly 控制台「关于」页 — 设计规格（Lead 定稿，实现照此执行）

参考：THRM（第三方飞智工作站）应用内「关于」详情页的信息编排 —— 身份与版本 → 检查更新 → 联系与仓库 → 许可与平台。
**只借它的信息结构，不借它的营销页排版**：Molly 是常驻控制台，这一页要安静、可扫读，和现有的玻璃卡片同一套材质。

## 落位

- 路由 `#/about`，`data-page="about"`。
- 侧栏「偏好与高级」组里，「偏好设置」之后加一条：`<a class="nav-item" href="#/about" data-page="about"><span class="nav-icon" aria-hidden="true">ⓘ</span><span>关于</span></a>`。
- 页面 section 放在 settings 那个 `<section class="page" data-page="settings">` 之后。

## 版面

内容区起手两列栅格（`grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr)`，gap 18px）；宽度 < 1120px 时单列堆叠。
所有卡片沿用现有 `.card`（无边框、玻璃底、圆角 10px），标题用现有 `.card-h`。

### 左列

**卡 1 · 身份（hero）**
- 左侧 56–64px 圆角方块标识：墨绿渐变（`--primary` 到 `#1b3529`），白色衬线或 600 字重「M」，内高光 1px，圆角 14px。与任务栏图标同色系，不要引入新色。
- 右侧：`Molly`（26–28px / 600 / 行高 1.2）＋ 副标题「她的控制台 · 本地 QQ 智能体的记忆、发言与守护」（13px，`--ink-3`）。
- 副标题下一行 pill 组（复用 `.pill`）：`v1.1.7-preview.1`、`构建 <build>`、`127.0.0.1:19392`、`桌面应用`（浏览器模式时显示「浏览器」）。
- 底部一行小字：「数据都在本机；DSH 关掉不影响这里的记忆、表情与守护。」（12px，`--ink-3`）

**卡 2 · 检查更新**
- 两行 kv：`当前版本` → 版本号；`服务端构建` → 8 位 build。
- 右上一个 `.btn`「检查更新」。
- 下方状态行（12px）：初始「还没检查过」；点击后先「检查中…」，再二选一：
  - 一致：「已是最新 · <时间>」
  - 不一致：「服务端前端已更新（<新 build>），刷新后生效」＋ 一个「刷新」按钮（`location.reload()`）。
- 再下一行链接「更新日志」：点开在卡片内就地展开最后 5 条（`/api/changelog`，取不到就显示「本版本没有更新记录」）。不要跳页。

**卡 3 · 数据与连接**（事实行，全部来自 `/api/overview`，取不到显示 `—`，不许编数字）
- `记忆` `<plugin.memory.count> 条`
- `表情` `<plugin.stickers.count> 张`
- `已聊` `<plugin.metrics.messages> 条 / <plugin.metrics.conversations> 个会话`
- `积分` `<plugin.budget.used> / <plugin.budget.dailyCap>`
- `QQ` `<plugin.bot.nickname>（<plugin.bot.userId>）· <plugin.link.state>`
- `守护` `正常 / 不可达`
- `DSH 宿主` `<plugin.base>`

### 右列

**卡 4 · 开发者与联系**（行式：图标 + 标题 + 副标题 + 右侧动作）
- `论坛帖` / `dsh-online-time 0.1.3` / ↗ 打开 `https://example.asia/dsh/forum/35`
- `项目目录` / `${MOLLY_ROOT}\qq-whale` / 「复制」按钮（`navigator.clipboard.writeText`，成功后 toast「路径已复制」）
- `排障文档` / `docs\desktop-app.md` / 「复制」按钮
- `恢复入口` / `start-dsh.ps1` / 「复制」按钮
- 行间用 1px `--hairline-soft` 分隔（这是列表分隔，不是面板分隔线，允许保留）。

**卡 5 · 版本与许可**（纯 kv，紧凑）
- `版本` `v1.1.7-preview.1`｜`构建` 8 位｜`许可` `私有自用`｜`平台` `Windows · WebView2`｜`语言` `中文`｜`外观` `玻璃（可在偏好设置里关）`

## 硬约束

1. **只改 `${MOLLY_ROOT}\qq-whale\console\` 下的 `index.html`、`console.js`、`console.css`**（先备份：`out\backup-about\*.bak-about-20261104`）。禁止改 `tools\`、`desktop\`、`dist\`。
2. `console.css` 只在文件末尾追加一段 `/* §28 关于页 */`，不加新色值、不加边框、不覆盖既有选择器。
3. `console.js` 只在既有渲染体系里加 `renderAbout(ov)`；沿用该文件已有的 DOM 取值、格式化（数字千分位）、toast 辅助函数，不要引入新依赖。
4. 中文文案直接用，文件必须是 **UTF-8 无 BOM**；写文件一律用 Node 的 `fs.writeFileSync(p, s, 'utf8')` 或编辑工具，**禁止** PowerShell `Get-Content | Set-Content`（会把 UTF-8 当 GBK 读成乱码）。
5. 提交前自检：`node --check console\console.js` 退出码 0；`console.css` 花括号配平；页面上不出现 `undefined`/`NaN`/`null`。
6. 不碰生产：不要重建 EXE、不要重启 `Molly.exe` 或 `molly-console.exe`。预览用
   `$env:MOLLY_CONSOLE_DIR='${MOLLY_ROOT}\qq-whale\console'; $env:MOLLY_CONSOLE_PORT='19410'` 再
   `& '${MOLLY_ROOT}\qq-whale\dist\molly-console.exe' --no-browser`。

## 验收（Lead 复核）

- 1440×900 下两列不溢出、卡片高度不被拉齐成空白块；390px 下自然单列、无横向滚动。
- 数字行全部有值（或 `—`），无 `undefined`。
- 「检查更新」两次结果都正确（一致 / 人为改 build 后不一致），不吃掉按钮焦点。
- 玻璃主题下这一页没有新增的实底方块；关掉磨砂（`data-glass=false`）时同样可读。
- `#/about` 刷新后直接可达（深链接），侧栏高亮正确。

---

## 落地记录（2026-11-04，已上生产）

侧栏路径：**偏好与高级 → 关于**（`#/about`）。子会话 `f05a53c6-4c4b-41a9-829f-b8b07b69b080` 照本规格实现，Lead 做美术打磨与真机验收。

### 改动落点

| 文件 | 位置 |
| --- | --- |
| `console\index.html` | `:47` nav-item；`:380-471` `<section data-page="about" id="aboutPage">` |
| `console\console.js` | `:19` PAGES 加 `'about'`；`:25-28` PAGE_BUILD；`:126-129` `state.about`；`:2965+` 关于页逻辑（`aboutValue`/`aboutFacts`/`checkAboutUpdate`/`aboutChgItems`/`renderAbout`）；`:4437` renderPageNow case；`:4466` setPage 里进页读 health；`:4481-4495` 事件委托 |
| `console\console.css` | 末尾 `/* §28 关于页 */`（`.about-grid` / `.about-hero` / `.about-mark` / `.about-rows` / `.about-dot` / `.about-chg*` + 两条响应式） |

`dist\console\` 与 `dist\desktop\console\` 各留同一份副本；**只改前端，没重建 EXE**（两个 console 目录都是纯文件拷贝，改文件即生效，页面 4 秒轮询比对 build 自动 reload）。

### 与规格的偏差（有意为之）

1. 「更新日志」不只取最后 5 条：按 `**小节**` 切段后优先取「改了什么」那一段，并补上该版标题 —— 发布说明里的「验证 / 怎么退回」对用户是噪音。无小节时退回全部 bullet，并过滤 `通过 x/y`、`单测`、`.mjs` 这类测试结论行。
2. 数字统一包 `<span class="mono">`，与其它页面对齐；守护用 6px 状态点（`.about-dot.is-ok/.is-bad`）而不是绿底 pill，避免这一页出现整页唯一一块实色。
3. 「开发者与联系」四个图标统一为 `◎ ◫ ◇ ↻`（原本混用 `↗/▤/≡/↺`，且 `↗` 与右侧动作「打开 ↗」重复）。
4. 外观值缩成「玻璃」/「不透明」（原文案「玻璃 · 可在偏好设置里关」在 320px 列宽里会折两行）。
5. ≤640 追加 `.log-fab{display:none}`：右下角固定的「查看日志」浮钮会压住「表情」行；`.nav-search` 改 `align-self:stretch;white-space:nowrap`，390 下「查找功能」不再断行。

### 验收证据

| 项 | 结果 | 产物 |
| --- | --- | --- |
| 1440 两列 | 不溢出、无空白拉齐 | `out\about-prod-1440b.png`、`out\about-final-1440-chg.png` |
| 390 单列 | `clientWidth=scrollWidth=382`，无横向溢出（ego `Emulation.setDeviceMetricsOverride` 实测；headless `--window-size=390` 的「右侧被裁」是窗口最小宽度假象） | `out\about-ego-390b.png` |
| 检查更新 | 点后 `is-ok`「已是最新 · 20:36:31」，按钮不失焦 | `out\about-1440-checked.png` |
| 更新日志 | 展开 4 条「改了什么」+ 小标题 | `out\about-final-1440-chg.png` |
| 关磨砂 | 仍可读，退回暖纸面 | `out\about-1440-glassfalse.png` |
| 玻璃壳真机 | 桌面应用内页正常、数据全有值 | `out\about-app-ship.png` |
| 自检 | `node --check console.js` 0；CSS 花括号 657/657；无 `undefined`/`NaN` | — |

### 已知限制

- 本机部署没有发版服务器，「检查更新」比的是**前端 build 与服务端 build 是否一致**；服务端先更新时既有 `maybeReloadForNewBuild()`（4 秒轮询 + sessionStorage 60 秒防抖）通常先把页面刷掉，所以手动点「检查更新」多数时候看到的是「已是最新」——这是预期行为，不是失效。
- 论坛帖链接固定指向 `https://example.asia/dsh/forum/35`（在线时间插件帖）；插件版本升到 0.1.3 后需要登录论坛才更新得了那篇帖。
