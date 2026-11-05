# 茉莉花控制台（精简版）

一个**零依赖**的本地网页控制台，用来照看 `jasmine` 记忆库：看条目、看有效权重怎么掉、
看归档簿、看原始账、导入导出。它只读 `../index.mjs` 暴露的 `JasmineStore`，不改内核。

- 单文件服务端：`controller/server.mjs`（`node:http`，只监听 `127.0.0.1`）
- 三个静态文件：`web/index.html`、`web/style.css`、`web/app.js`
- 无构建步骤、无第三方包，Node ≥ 18 直接跑

## 启动

```bash
node controller/server.mjs --dir D:\somewhere\jasmine-data --port 19430
node controller/server.mjs --dir D:\somewhere\jasmine-data --port 19430 --open
```

| 参数 | 说明 |
| --- | --- |
| `--dir` | 记忆库目录（`jasmine.json` / `ledger.jsonl` / `_archive.json` 所在处）。缺省读 `controller/config.json` 的 `dataDir`，再退 `%LOCALAPPDATA%\Jasmine\data` |
| `--port` | 端口，缺省 `19430`；`0` 表示随机 |
| `--limit` | 热池容量上限，缺省 `20000`。控制台是浏览用途，别用内核默认的 2000 —— 超过上限后写新条目会触发 `prune()`，把低权重的旧事件/梗挪进归档簿 |
| `--open` | 启动后调用系统浏览器打开 |

也可以当 npm bin 用：`npx jasmine-controller --dir <目录>`。

## 三个页面

| 路由 | 页面 | 内容 |
| --- | --- | --- |
| `#/memory` | 记忆库（默认） | 四指标、七类分布条、左索引（类型 / 人物 Top12 / 权重档 / 时间桶）、列表与详情抽屉、搜索与五种排序、增改删 |
| `#/curves` | 曲线 | 1–10 权重档的基础/有效双柱、衰减口径表（宽限天数 / 步长 / 下限 / 当前 idle）、归档簿 |
| `#/data` | 数据 | 本库信息、导出 / 导入 bundle（先预览再写）、从原始账重建、归档陈旧条目、原始账最后 200 行 |

**详情抽屉**是这套界面的重点：它把「基础权重 → 有效权重」摊开写清楚——空闲了多少活跃天、
宽限还剩几天、每 7 天掉多少、已经掉到哪、下限是多少，一眼能看出哪条正在掉权。

## 筛选与排序

- 搜索：空格分词，**全部命中（AND）**；匹配正文、人物、QQ；命中词在列表里高亮。
- 筛选项：类型、人物、权重档（满格 10 / 高 8–9.9 / 中 5–7.9 / 低 3–4.9 / 见底 <3）、时间桶（今日 / 7 天 / 30 天 / 90 天 / 更早），多个条件同时生效。
- 排序：加入时间新旧、有效权重新旧、命中次数，共五种。

## HTTP 接口

写操作一律 `POST` + JSON，错误统一 `{ ok: false, error }`。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/status` | 库状态（条数、活跃天、七类计数、有身份占比、平均有效权重…） |
| POST | `/api/list` | `{ q, kinds[], who[], bands[], day, sort, offset, limit }` → `{ total, entries, facets, tokens }` |
| GET | `/api/item?id=` | 单条详情（含 `edges`） |
| POST | `/api/add` | `{ kind, who, qq, text, weight }` |
| POST | `/api/update` | `{ id, patch }` |
| POST | `/api/remove` | `{ id }` → 软删：移入归档簿，可 `restore` |
| POST | `/api/restore` | `{ id }` 从归档簿取回 |
| POST | `/api/archive-stale` | `{ dryRun }` → `{ moved }` / `{ wouldMove }` |
| POST | `/api/rebuild` | 从 `ledger.jsonl` 回放重建 |
| GET | `/api/raw?limit=200` | 原始账尾部 |
| GET | `/api/export` | 下载 `jasmine-bundle-YYYYMMDD.json` |
| POST | `/api/import` | `{ bundle \| entries[] \| data:{entries[]}, dryRun }` → `{ added, merged, skipped }` |
| GET | `/api/curves` | 权重分布、衰减口径、归档簿 |

`entries` / `entry` 上都带派生字段：`base`、`eff`、`idle`、`grace`、`floor`、`step`、`stepDays`、`dropped`。

## 口径

有效权重完全按内核的 `effectiveWeight(entry, activeDays)` 算，控制器不另立一套：

```
idle  = activeDays - (entry.lastActiveDay ?? 0)
idle <= grace            → eff = base
否则 steps = floor((idle - grace) / 7)
     eff = clamp(round((base - steps * 0.5) * 10) / 10, floor, 10)
```

宽限天数：称呼 ∞（不衰减）、约定/人物/事实/偏好 14、事件/梗 7。下限：称呼 10、约定 5、人物 4、事实/偏好 3、事件/梗 1。

## 数据一致性

`JasmineStore.save()` 只写 `jasmine.json`，`_archive.json` 只在 `importBundle()` / `rebuildFromRaw()` 里落盘。
因此控制器在「移除 / 取回 / 归档」之后会自己把归档簿写回 `_archive.json`，否则重启会丢归档记录。

每个写请求前都会 `store.load()` 重读盘，所以用脚本或别的进程改了库文件，控制台下一屏就能看到。
若库文件被整体删除，控制器会把内存态一并归零（`load()` 本身不会，它只在文件存在时覆盖）。

## 已知限制

- 内核 `clampWeight` 会把权重取整，所以界面上权重是 1–10 的整数；详情里的「有效权重」才有一位小数。
- 单个进程、无鉴权，仅绑定 `127.0.0.1`，不要暴露到公网。
- 归档簿只读展示 + 「取回」；不提供批量删除归档。
- 列表一次 60 条，「加载更多」按偏移累加，不做虚拟滚动（默认上限 20000 条）。

## 从 Molly 控制台迁移记忆

Molly 那边的记忆条目字段与 jasmine 完全同构，所以可以直接搬过来：

```bash
# 1) 从正在跑的 Molly 控制台导出（read-only，不会改数据）
curl -X POST http://127.0.0.1:19392/api/action/memory/list -d "{}" -o molly-memory.json

# 2) 在「数据」页选这个文件：先预览（新增 / 合并 / 跳过），再确认写入
```

`/api/import` 接受三种形状：jasmine `exportBundle()` 的 bundle、纯数组 `entries[]`、以及上面那种 `{ok, data:{count, entries[]}}`。
按 `id` 去重：已存在的合并（取较新的 `at`、较大的 `hits` / `lastActiveDay`），不存在的追加。

导入时如果库里没有 `activeDays`（Molly 的导出不带这个元数据），控制器会用 `max(lastActiveDay)` 兜底补上，
否则空闲天数恒为负、所有记忆都会显示成「没掉过权」。导入完可以在「数据」页核对条数与活跃天。

## 目录

```
controller/
├── server.mjs      # HTTP 服务 + API + 静态文件
└── web/
    ├── index.html
    ├── style.css   # 「书房」配色：纸白 / 墨绿 / 细线
    └── app.js      # 无框架、无构建
```
