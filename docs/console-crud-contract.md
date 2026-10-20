# 控制台 CRUD 契约：表情包 + 记忆（2026-10-19 17:40）

用户需求原话：**「那个控制台，我想你给他加几个功能：1.可以增删改表情包及其关键词，2.可以增删改记忆」**

本文件是**唯一契约**。三方（插件端 / console-server 代理端 / 前端）都按这份实现，不要各自发挥。

---

## 0. 为什么写操作必须走插件，不能前端直改文件

- **记忆**：`lib/memory.js` 的 `MemoryStore` 把 `entries` 放在**内存数组**里，`save()` 是「整个数组覆写 `memory.json` + 重渲染 `memory.md`」。如果控制台直接改盘上的 json，插件下一次 `add()` 会把内存里的旧数组整个写回去，**控制台的修改被静默吞掉**。
- **表情包**：`lib/stickers.js` 的 `StickerLibrary` 是**扫盘**得到的目录，关键词就编码在**文件名**里（`动漫少女_震惊_张嘴_这么强.jpg` → 关键词 = `动漫少女 / 震惊 / 张嘴 / 这么强`）。`stickers\学来的\.learned.json` 只是一串内容哈希，用来防止同一张图被重复「学」，**不是关键词表**。

⇒ 写操作一律走插件 HTTP 接口（它持有真实内存状态），再由 console-server 代理给前端。前端永远不碰磁盘。

---

## 1. 数据事实（实测，2026-10-19 17:35）

| 项 | 位置 | 现状 |
|---|---|---|
| 记忆 | `${HOME}\.dsh\qq-whale\memory\memory.json` | 15895 B，`{version:1, entries:[...]}`，**78 条** |
| 记忆可读版 | `...\memory\memory.md` | 6147 B，由 `renderMarkdown()` 生成，只读展示用 |
| 记忆 entry | — | `{id:"mmvc3yjucwige", kind:"fact", who:"主人", text:"…", weight:3, at:1792224107508}` |
| kind 分布 | — | `work:27 fact:22 sticker:15 person:13 preference:1` |
| 表情包 | `...\qq-whale\stickers\学来的\*` | 15 张，jpg/png/gif |
| 表情包哈希表 | `...\学来的\.learned.json` | 数组，元素是 sha256 字符串 |

`MemoryStore` 已有：`load() / save() / add({kind,who,text,weight}) / prune() / renderMarkdown()`，**缺 update / delete**。
`StickerLibrary` 已有：`scan() / maybeRescan() / match() / for() / random() / catalogText()`，**缺增删改**。

---

## 2. 插件端接口（`lib/web.js`，宿主 7053，前缀 `/dsh-qq-whale`）

统一响应：成功 `{ok:true,…}`，失败 `{ok:false,error:"<人话>"}` + 合适的 HTTP 状态码（400 参数错 / 404 找不到 / 409 冲突 / 500）。

### 2.1 记忆

```
GET  /dsh-qq-whale/memory/list
  → {ok:true, count:78, entries:[{id,kind,who,text,weight,at}]}      # 按 at 倒序

POST /dsh-qq-whale/memory/add
  body {kind?:string="fact", who?:string="", text:string, weight?:number=3}
  → {ok:true, entry:{…}, count:79, merged:false}
  校验：text trim 后 1..200 字，超长 400；kind 必须在 {fact,preference,promise,person,event,work,sticker}
  merged（真实行为，A 端已实现）：`MemoryStore.add()` 自带相似度去重——同 who + 同 kind 且
  三元组相似度 >0.8 时不新建，而是并入已有条目（刷新它的 at、取较大的 weight）并返回那条旧 entry。
  所以 merged:true 表示「内容相近，已合并到已有条目」，此时 count 不变；merged:false 才是真的新增。
  前端请用 merged 而不是 count 判断是否新增。

POST /dsh-qq-whale/memory/update
  body {id:string, text?:string, kind?:string, who?:string, weight?:number}
  → {ok:true, entry:{…}}
  校验：id 必须存在否则 404；text 若给则同样 1..200；weight 若给则 1..5
  语义：只改传进来的字段；改完 entry.at 不变（at 是"记下的时间"，不是"改的时间"）

POST /dsh-qq-whale/memory/delete
  body {id:string}
  → {ok:true, deleted:1, count:77}
  校验：id 必须存在否则 404
```

每次写操作后必须 `store.save()`（它会同时重写 `memory.json` 与 `memory.md`）；**不要**自己 `fs.writeFileSync`。

### 2.2 表情包

```
GET  /dsh-qq-whale/stickers/list
  → {ok:true, count:15, items:[{name:"动漫少女_震惊_张嘴_这么强", ext:".jpg",
                               file:"动漫少女_震惊_张嘴_这么强.jpg", size:29629,
                               keywords:["动漫少女","震惊","张嘴","这么强"], mtime:…}]}

POST /dsh-qq-whale/stickers/add
  body {dataBase64:string, keywords:string[]|string, filename?:string}
  → {ok:true, item:{…}, count:16}
  规则：
    - dataBase64 允许带 `data:image/jpeg;base64,` 前缀，自行剥掉
    - 只收 jpg/jpeg/png/gif/webp（按**魔数**判，不信扩展名）；单张 ≤ 8 MB
    - 超过 8 MB 一律回 **413** `{ok:false,error:"图片太大，单张上限 8 MB"}`（不是 400，也不是断连）：
      正文超过读入上限（约 11.7 MB）时在读 body 阶段就回 413，并且**必须先把请求体排空、再写响应**，
      不能 `req.destroy()`——客户端还在写时断连接，前端只会看到 `ECONNRESET`/「网络错误」。
      正文没超、但解码后超过 8 MB 的，同样回这个 413。
    - 关键词数组清洗：trim、去掉 `_\/*?"<>|:` 等非法字符（把 `_` 换成 `-`，因为 `_` 是关键词分隔符）、去空、去重、最多 8 个
    - 最终文件名 = `keywords.join('_') + ext`；重名则追加 `_2`、`_3`…
    - 落盘目录固定 `stickers\学来的\`
    - 落盘后把内容 sha256 写进 `.learned.json`（避免被当"新图"重新学一遍）
    - 落盘后**必须**让 `StickerLibrary` 重新 scan（否则本轮对话看不到新表情）

POST /dsh-qq-whale/stickers/update
  body {file:string, keywords:string[]}
  → {ok:true, item:{…}, renamed:{from,to}}
  语义：改关键词 = **重命名文件**（关键词编码在文件名里）。用同一套清洗规则。
  校验：file 必须存在且必须位于 `stickers\学来的\` 内（防路径穿越，`..` 一律 400）

POST /dsh-qq-whale/stickers/delete
  body {file:string}
  → {ok:true, deleted:1, count:14}
  语义：删文件 + 从 `.learned.json` 里删掉该文件的 sha256（这样以后同一张图还能被重新学）
  校验：file 必须存在且在目录内
```

`scan()` 之后要保证 `match()/catalogText()` 用的是新目录 —— 如果 `StickerLibrary` 有内部缓存，重扫要能覆盖它。

---

## 3. console-server 代理（`tools/console-server.mjs`，19392）

把上面 8 个接口挂进现有 `/api/action/<name>` 体系（现在是 14 个，扩到 22 个）：

```
POST /api/action/memory/list      body {}                       → 透传
POST /api/action/memory/add       body {kind,who,text,weight}   → 透传
POST /api/action/memory/update    body {id,text,kind,who,weight}→ 透传
POST /api/action/memory/delete    body {id,confirm:true}        → 透传（破坏性，必须 confirm）
POST /api/action/stickers/list    body {}                       → 透传
POST /api/action/stickers/add     body {dataBase64,keywords}    → 透传
POST /api/action/stickers/update  body {file,keywords}          → 透传
POST /api/action/stickers/delete  body {file,confirm:true}      → 透传（破坏性，必须 confirm）
```

要求：
- 返回体统一 `{ok:true, data:<插件原始响应>, durationMs}`，失败 `{ok:false, error, status}`。
- `/api/action/<未知>` 的 `data.available` 列表要同步更新到 22 个。
- 上传体积上限调到 **12 MB**（base64 膨胀后），超过返回 413。
- **禁止**把 base64 内容写进日志。
- 现有 `/api/memory`、`/api/stickers`（只读、供页面首次渲染）保持不变。

---

## 4. 前端（`console/`，10 页不变）

### 4.1 记忆页（`记忆`）
- 每一行右侧加三个小按钮：`改` / `删`。
- 页头加 `+ 新增记忆`。
- 新增/编辑用一个**页内弹层**（不要 `prompt()`，太丑也不安全）：
  - 字段：`kind`（下拉：fact/preference/promise/person/event/work/sticker，中文标签）、`who`（文本，可空）、`text`（多行 textarea，实时字数 `x/200`）、`weight`（1–5 数字或滑块）
  - 按钮：`保存` / `取消`；保存中禁用并显示 spinner
  - 失败时把后端 `error` 原文显示在弹层里，**不要关弹层**
- 删除：二次确认（弹层内写明「删掉后不可恢复」，并用危险色按钮）。
- 成功后：`toast` 提示 + 重新拉 `/api/memory` 刷新列表（不要整页 reload）。

### 4.2 表情包页（`表情包`）
- 每张卡片下方加 `改关键词` / `删`；页头加 `+ 上传表情包`。
- 上传：`<input type="file" accept="image/jpeg,image/png,image/gif,image/webp">` + 关键词输入（逗号或空格分隔，前端显示成一个个 tag chip）；选中文件后**本地预览**再提交。
- 改关键词：弹层里改 tag chips，保存后文件名会变，列表要刷新（用返回的 `renamed.to` 更新）。
- 删除：二次确认，文案写明「同时会把它从学过的哈希表里移除，以后同一张图还能重新学」。
- 体积/类型不合格在前端就拦一次，给出人话提示（不要等后端 400）。

### 4.3 通用
- 所有写操作按钮在请求期间 `disabled`，防连点。
- 颜色/圆角/间距继续用 `console-design.md` 的浅色 Notion token；危险动作用现有 warn/bad 色。
- 遵守既有约定：4 秒轮询、`visibilityState==='hidden'` 暂停、失败不清屏、`safe()` 报错可见。
- **改完 console.js/css 不需要重启服务**（`console-server.mjs` 已按 mtime+size 算 `build` 并注入 `?v=`，前端发现 build 变了会自己 reload 一次）。

---

## 5. 硬约束（三方通用）

1. **禁止重启 DSH 宿主**（会杀 QQ 登录）；**禁止**杀 QQ / NapCat；**禁止**跑 `start-molly.ps1`。
2. 改 `lib/*.js` 前后都要 `Copy-Item` 备份成 `.bak-20261019-<时:分>`，改完**同步到安装副本** `${HOME}\.dsh\profiles\desktop\node_modules\dsh-qq-whale\lib\`。
3. **插件重载由 Lead 统一做**，实现者不要自己 `set_plugin` / `set_bundle`。
4. 动记忆/表情包之前，先把 `memory\memory.json` 与 `stickers\学来的\` **整个目录拷一份** 到 `qq-whale\out\crud-backup-<时:分>\`，测试产生的脏数据要清掉。
5. 测试**不许**在真库上乱写：用 `out\test-crud-data\` 之类的临时数据目录，跑完删。
6. node 全路径 `${HOME}\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`（PATH 里没有 node）；判文件内容一律用 node `readFileSync(f,'utf8')`，不要用 PS 5.1 `Get-Content`。
7. `.ps1` 存 UTF-8 **带 BOM**；`.vbs` ANSI 无 BOM；`.md`/`.js` UTF-8 无 BOM。

---

## 6. 验收（Lead 复核，缺一项不算完）

1. `GET /dsh-qq-whale/memory/list` → 200 且条数与 `memory.json` 一致。
2. 真机加一条记忆 → `/memory/list` 立刻能看到、`memory.json` 与 `memory.md` 同步变化、**再让 Molly 回一句话后那条仍在**（证明没被插件覆写）。
3. 改一条记忆的 text/weight → 见变化；删一条 → 条数 -1；删不存在的 id → 404。
4. `/stickers/list` 15 项，`keywords` 数组正确。
5. 上传一张测试图（带 3 个关键词）→ 文件出现在 `stickers\学来的\`、文件名以关键词拼成、`.learned.json` 多一个哈希、`/stickers/list` 变 16。
6. 改这张图的关键词 → 文件被重命名、列表 `keywords` 更新、旧文件不存在。
7. 删它 → 文件消失、`.learned.json` 的那个哈希被移除、列表回到 15。
8. 路径穿越 `file="../../memory/memory.json"` → **400，且文件没被动过**。
9. 上传非图片（如改扩展名的文本）→ **400 被魔数拦下**；>8 MB → 400。
10. 前端三处交互（新增/编辑/删除）× 两个页面，共 6 条路径，逐条实操截图或 DOM 断言。
11. 全程 Molly 不掉线（`/state` 的 `link.state` 始终 `online`）。

---

## 7. 部署约束（用户 m24220 追加，**本轮就要遵守，不要事后返工**）

用户原话：「必要的话可以做成 exe，我后期想着可以部署一部分服务到服务器上」。

### 7.1 本轮必须遵守的三条（成本几乎为零，但省掉以后大改）
1. **前端不许出现硬编码 `127.0.0.1:19392`** —— 所有 `fetch` 用**相对路径** `/api/...`。这样以后放在反向代理后面、或改端口/域名，前端一行都不用动。（现状里顶栏/入口按钮那类绝对地址等 Lead 统一收口，新增代码必须用相对路径。）
2. **console-server 的监听地址必须可配**：`const HOST = process.env.MOLLY_CONSOLE_HOST || '127.0.0.1';`、`const PORT = Number(process.env.MOLLY_CONSOLE_PORT || 19392);`。默认值不变，行为不变。
3. **预留 token 校验但不默认开启**：`MOLLY_CONSOLE_TOKEN` 有值时才校验请求头 `x-molly-token`（密钥放在请求头，不要放 query，避免进日志）；没值就维持现在的本机免鉴权。上传/删除这类写动作将来上公网必须有它。

### 7.2 为什么这个架构天然适合「一部分服务上服务器」
- **必须留在本机的**：DSH 宿主（7053，跑 agent）、NapCat（6099 / OneBot 3001，持有 QQ 登录态）、QQ.exe。这些跟登录态绑死，搬到服务器就得重新扫码，且要一台常开的机器跑 QQ。
- **可以搬上服务器的**：`console-server.mjs`（19392）。它本来就是个**纯代理 + 只读聚合层**：对外提供控制台页面与 API，对内转调本机插件/NapCat/watchdog。搬上去以后，本机只需要把 19392 反代出去（或让 console-server 反向连回本机），控制台就能从任何地方打开。
- 所以 **console-server 里所有对本机的调用都必须写成可配 base**，不要写死：`PLUGIN_BASE`（默认 `http://127.0.0.1:7053/dsh-qq-whale`）、`SIDECAR`（19391）、`NAPCAT`（6099）。本轮只需把常量提到配置区顶部并允许 env 覆盖，实现别动。

### 7.3 打包 exe（下一阶段，不在本轮三端范围内）
- 技术路线：Node 的 SEA（Single Executable Application，node 24 支持 `--experimental-sea-config`）优先，`pkg` 已停更不选。
- 形态：`molly-console.exe`，双击 ⇒ 起 19392 + 用 Edge `--app` 开窗（复用 `start-console.ps1` 的逻辑，但改成纯 node/内嵌）。
- 配置放 exe 同目录 `console.json`（host/port/token/edge 路径），改配置不用重新打包。
- 这条另开任务（task-20），**等本轮 CRUD 三端验收完再动**，不要并行搅进 console-server 的大改里。
