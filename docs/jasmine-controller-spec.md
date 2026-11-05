# 茉莉花控制台（Jasmine Controller）· 精简版规格

> 面向「茉莉花（Jasmine）记忆系统独立分支」的单机控制台：只做记忆这一件事，随 jasmine 包单独发包。
> 与 Molly 控制台（`${MOLLY_ROOT}\qq-whale\console`）是两个产品：不共享后端、不引用 QQ/DSH/守护/插件等任何能力。

## 1. 定位

| | Molly 控制台 | 茉莉花控制台（本规格） |
| --- | --- | --- |
| 管什么 | QQ 机器人整机（会话、守护、插件、模型、预算…） | 只有记忆库 |
| 数据源 | `molly-console.exe` + DSH 插件 | `JasmineStore`（`jasmine.json` / `ledger.jsonl` / `_archive.json`） |
| 依赖 | DSH、QQ、Windows 进程 | 零依赖，Node ≥ 18 |
| 形态 | WPF + WebView2 桌面应用 | 单进程 HTTP + 浏览器；随 jasmine 包发 zip |

一句话：**茉莉花控制台 = 记忆库的阅览室与管理台**。

## 2. 目录与文件（只允许新增下面这些）

```
${MOLLY_ROOT}\qq-whale\jasmine\
  controller\
    server.mjs          # node:http，零依赖，默认 127.0.0.1:19430
    web\index.html
    web\app.js
    web\style.css
    README.md           # 怎么启动、数据在哪、怎么导入导出
```

- 允许修改 `${MOLLY_ROOT}\qq-whale\jasmine\package.json`：`files` 增 `controller/`，`bin` 增 `"jasmine-controller": "controller/server.mjs"`，版本 `0.3.0 → 0.4.0`。
- 禁止修改：`jasmine\src\**`、`jasmine\index.mjs`、`console\**`、`tools\**`、`dist\**`、`desktop\**`、`plugin\**`。
- 测试数据用 `${MOLLY_ROOT}\qq-whale\out\jz-controller-data\`（可删可重建），**不要**指向 `${MOLLY_ROOT}\data\qq-whale\jasmine`（那是 token 账本目录）。

## 3. 启动

```bash
node controller/server.mjs --dir <数据目录> --port 19430 [--open]
```

- `--dir` 省略时用 `controller\config.json` 里的 `dataDir`，再退到 `%LOCALAPPDATA%\Jasmine\data`。
- 只监听 `127.0.0.1`；写操作必须 `POST` + JSON body。
- 启动时打印一行：`茉莉花控制台 http://127.0.0.1:19430 · 数据目录 … · 5,436 条`。

## 4. 界面（三页，左侧窄栏）

视觉沿用 Molly 控制台的暖纸+墨绿语言，但更「书房」：纸白底、细线、宋体标题（`Songti SC, SimSun, Georgia` 回退）配 MiSans 正文；不用磨砂、不用玻璃、不做动画花活。只有三处动效：换页淡入 160ms、列表行 hover 底色、详情抽屉滑入 190ms。

### 4.1 记忆库 `#/memory`（默认页）
- 顶部：标题「茉莉花记忆」+ 副标题「Jasmine · N 条 · 活跃天 D」；右侧「＋ 记一条」「导出」。
- 四指标：总条数 / 今日新增 / 有身份（who 或 qq 非空）占比 / 平均有效权重。
- 类型分布条：七类（称呼/人物/事实/偏好/约定/事件/梗与表情）横条，悬停显示条数与占比。
- 三栏：左 216px 索引（类型 / 人物 Top 12 / 权重档 / 时间桶），中列表，右 340px 详情。
  - 中栏工具条：搜索（正文/人物/QQ，空格分词 AND）+ 排序（加入时间新旧 / 有效权重新旧 / 命中次数）+ 计数。
  - 列表每行：正文（最多两行省略）、meta（日期 · 类型 · 权重 `w6→5.5` · 命中 n 次）、点击选中。
  - 详情：正文、who/qq/kind/权重（基础→有效、空闲活跃天、宽限）、命中、来源、创建与最后命中时间、关联（edges 有才显示）、按钮「改这条 / 删这条 / 载入到检索框」。
- 列表 60 条一批 +「加载更多」；空库时给一段引导（先记一条 / 从 bundle 导入）。

### 4.2 曲线 `#/curves`
- 权重分布：1–10 每档一条柱，显示基础权重分布与有效权重分布两条（同一坐标）。
- 衰减进度表：按类型列出「宽限天数 / 掉权步长 / 下限 / 当前最近 idle」。
- 归档簿：`_archive.json` 条目列表（类型、正文、归档时间），只读，可「取回」。

### 4.3 数据 `#/data`
- 原始账：读 `ledger.jsonl` 最后 200 行，`op` 标签着色（add/update/remove/archive/touch/week），只读。
- 导出：`GET /api/export` 下载 `jasmine-bundle-YYYYMMDD.json`。
- 导入：选择本地 JSON（bundle 或条目数组），先预览「将新增 N / 合并 M / 跳过 K」，确认后写入。
- 维护：`从原始账重建`（`rebuildFromRaw`，需二次确认）、`归档陈旧条目`（`archiveStale`，先显示预计条数）。

## 5. API（全部 JSON，错误统一 `{ ok:false, error }`）

| 方法 | 路径 | body / query | 返回 |
| --- | --- | --- | --- |
| GET | `/api/status` | — | `{ok, dir, count, archiveCount, activeDays, activeDayKey, counts{kind→n}, limit}` |
| POST | `/api/list` | `{q, kinds[], who[], bands[], day, sort, offset, limit}` | `{ok, total, entries[]}`（entries 已带 `eff/grace/floor/idle`） |
| GET | `/api/item?id=` | — | `{ok, entry, edges}` |
| POST | `/api/add` | `{kind, who, qq, text, weight}` | `{ok, entry}` |
| POST | `/api/update` | `{id, patch{…}}` | `{ok, entry}` |
| POST | `/api/remove` | `{id}` | `{ok, removed:true}` |
| POST | `/api/restore` | `{id}` | `{ok, entry}`（从归档簿取回） |
| POST | `/api/archive-stale` | `{dryRun}` | `{ok, moved|wouldMove}` |
| POST | `/api/rebuild` | `{}` | `{ok, count}` |
| GET | `/api/raw?limit=200` | — | `{ok, lines[]}` |
| GET | `/api/export` | — | bundle JSON（`Content-Disposition` 附件） |
| POST | `/api/import` | `{bundle\|entries[], dryRun}` | `{ok, added, merged, skipped}` |
| GET | `/api/curves` | — | `{ok, baseBands[], effBands[], kinds[], archive[]}` |

约束：`text` 1–200 码点（超了截断并回 `truncated:true`）、`weight` 1–10 一位小数、`kind` 走 `normalizeKind`；所有写操作返回后前端要刷新计数。

## 6. 验收（子会话必须在报告里逐条给证据）

1. `node --check` 三个 JS 全过；server 零 `npm i`、零 `import` 第三方包。
2. 空目录启动 → `#/memory` 显示空态引导，不报错。
3. 用脚本灌 300 条假数据（七类混）→ 列表、搜索（验证 AND 分词与高亮）、四类筛选、五种排序全对；任一条记下 id 后 `update` / `remove` / `restore` 各验一次。
4. 导出 → 删库 → 导入，条数与权重峰值一致（bundle 校验 `sha256` 打印在报告里）。
5. `archive-stale` 先 dryRun 显示预计条数，再真跑，归档簿出现条目且主库计数下降。
6. 三页在 1440 与 1024 视口都 `documentElement.scrollWidth === clientWidth`；控制台零报错。
7. 截图 5 张存 `${MOLLY_ROOT}\qq-whale\out\jz-ctl-*.png`（记忆库、详情打开、曲线、数据页、空态）。
8. 打包：`${MOLLY_ROOT}\qq-whale\out\jasmine-controller-0.4.0.zip`，含 `jasmine/`（index.mjs、src、docs、controller、README、package.json、LICENSE）+ `start.bat`，`unzip -l` 清单写进报告。

## 7. 打包细节

- `start.bat`：`@echo off` → 找 `node`（PATH 或 `%ProgramFiles%\nodejs\node.exe`）→ 无则提示装 Node 18+ 并 `pause` → 有则 `node "%~dp0jasmine\controller\server.mjs" --dir "%~dp0data" --open`。
- zip 用 PowerShell `Compress-Archive` 或 `ZipFile::CreateFromDirectory`，根目录名 `jasmine-controller-0.4.0`。
- 报告里给出 zip 大小与 `sha256`。

## 落地记录（2026-11-05，已发包）

**代码**（`${MOLLY_ROOT}\qq-whale\jasmine\`，版本 `0.4.0`）

| 文件 | 字节 | 说明 |
| --- | --- | --- |
| `controller\server.mjs` | 26,083（复核后） | `node:http`，只监听 `127.0.0.1`；静态文件 + 12 个 API |
| `controller\web\index.html` | 9,482 | 三页外壳 |
| `controller\web\app.js` | 35,630 | 无框架无构建，hash 路由 |
| `controller\web\style.css` | 25,974 | 书房配色：纸白 `#faf9f6` / 墨绿 `#294f3e` / 细线 `#e6e3db` |
| `controller\README.md` | 约 6 KB | 启动、三个页面、接口表、口径、Molly 迁移 |

**Lead 复核时改掉的六处**

1. `/api/import` 只认 `bundle` / `entries[]`，认不出 Molly 的 `{ok,data:{entries[]}}` → 四种形状都接受。
2. 默认 `limit: 2000`（内核缺省）会把上千条记忆 `prune()` 进归档簿 → 控制台缺省改 `20000`，并开放 `--limit`。
3. 从 Molly 导入后 `activeDays` 为 0，全部记忆显示「没掉过权」→ 导入与每次请求前用 `max(lastActiveDay)` 兜底。
4. 权重档标签与阈值不一致（写「满格 9–10」实际 ≥9.95）→ 统一为 满格 10 / 高 8–9.9 / 中 5–7.9 / 低 3–4.9 / 见底 <3。
5. 左栏数据目录换行被截 → 单行省略 + `title` 完整路径。
6. 七类分布条配色发灰难分 → 绿（称呼/人物/事实）+ 琥珀 + 陶土 + 青灰 + 沙。

**真实数据验证**：用 Molly `/api/action/memory/list` 导出 5,436 条（2,374,489 B，sha256 `0cc02aec…d0a`），导入空库 → `{"added":5435,"merged":0,"skipped":1,"count":5435}`（跳过的是正文为空的那条），`activeDays` 兜底成 10，`avgEff 5.7`；截图 `out\jz-real-{memory,curves,data}.png`。

**发包**：`${MOLLY_ROOT}\qq-whale\out\jasmine-controller-0.4.0.zip`，81,559 B / 20 条目 / sha256 `<REDACTED>`；解压后 `start.bat` + `jasmine\`。冒烟：`--help` 正常、空库 `/api/status` = `{"count":0,"limit":20000,"activeDays":0}`、`GET /` 200/9,482 B。