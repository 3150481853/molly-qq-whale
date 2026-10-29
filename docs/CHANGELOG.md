# 变更日志（插件 / 配置 / 外部程序）

> 谁改了什么、为什么改、怎么退回去。用户原始要求（m00001）：
> 「记得记录你搞了什么插件，方便出问题能还原」。
>
> 一条一条按时间倒序记。新增条目写在最上面。

---

## 2026-10-29 · 控制台「QQ 客户端 未登录」：SnowLuma token 落到字面量 `${ONEBOT_TOKEN}`

> 主人（m00844，配截图）：「顺便检查一下为什么这边显示qq未登录」。
> 未升版本号（仍是 `1.1.6-Hotfix.1`），只改控制台服务端**取 token 的方式**，不动 OneBot 链路。

**现象**：控制台「QQ 连接」页自相矛盾 —— 状态「Molly 已连接 QQ」、Molly 链路「已连接」，但 **QQ 客户端「未登录」**，下面还挂一行红字 `unauthorized`；顶栏三个灯全绿。

**根因**（`tools/console-server.mjs:165`）：
```js
const SNOWLUMA_TOKEN = String(pick('MOLLY_SNOWLUMA_TOKEN', 'snowlumaToken', '${ONEBOT_TOKEN}')).trim()
```
`pick()` 只做「环境变量 → `console.json` 的 key → 字面 fallback」三选一，**从不展开 `${...}`**；`console.json` 里没有 `snowlumaToken`，`MOLLY_SNOWLUMA_TOKEN` / `ONEBOT_TOKEN` 在 User / Machine 两级都没设 ⇒ 控制台一直拿字符串 `Bearer ${ONEBOT_TOKEN}` 去打 SnowLuma，被 401 拒；OneBot 回 `retcode ≠ 0` + `message: unauthorized` ⇒ `buildSnowluma()` 走 `retcode !== 0` 分支，得到 `isLogin:false` + `loginError:'unauthorized'` ⇒ 前端 `clientReachable=true / clientLogin=false` ⇒ 渲染成「未登录」（而不是「不可达」）。Molly 自己的 WS 链路用的是另一套凭据，照样通，所以状态行还是「已连接」。

**改动**（1 个文件）：
- `tools/console-server.mjs`：token 取值链改成「`MOLLY_SNOWLUMA_TOKEN` → `console.json` 的 `snowlumaToken` → **`watchdog-config.json` 的 `snowluma.token`**（唯一真源）→ 空串」；三处都没有就**不发** `Authorization` 头，不再拿假 token 去撞 401。上方留中文注释写明这次事故。

**验证**（`Invoke-WebRequest -Method POST http://127.0.0.1:3000/get_login_info`）：

| 请求头 | 结果 |
| --- | --- |
| 不带 auth | **401** |
| `Bearer ${ONEBOT_TOKEN}`（事故现场原样） | **401** |
| `Bearer <watchdog-config.json 里的 token>` | **200** `{"status":"ok","retcode":0,"data":{"nickname":"Molly"}}` |

改完 `--check` 语法校验 exit 0 → `Stop-Process` 旧 pid → `Start-ScheduledTask Molly-Console`（动作是 `wscript.exe tools\console-hidden.vbs`）→ 新 pid 70888 监听 19392。`/api/overview` 的 qq 块变成 `clientLogin:true`、`isLogin:true`、`loginPhase:"online"`、`coreReady:true`、`deepOk:true`、`loginError:""`、`onlineClients:[{"name":"example'sTUF","kind":"手机"}]`，页面「QQ 客户端」变绿「已登录」。

**代价与退回**：无行为代价。若哪天把 token 挪到别处，把新位置加进那条取值链即可；三处都没有时表现为「不发 auth 头」，SnowLuma 若强制要 token 会直接 401（错误仍显示 unauthorized，不会静默变成假在线）。

---

## 2026-10-29 · 发布管线把仓库地址脱敏成 `222222222`（市场里全是 404）

> 触发链：主人（m01404）「所以那个邮件讲的是啥」→ 翻出 awesome-dsh-plugin 维护者 fkysly 2026-10-28 的来信，指出 `package.json` 的 `repository.url` 与插件 README 的安装命令都指向 `222222222/molly-qq-whale`（**404**）；主人（m01432）「可以，你的改动和经验记得写进changelog和state」。
> 未升版本号（仍是 `1.1.6-Hotfix.1`），只改发布管线的脱敏规则。

**现象**：GitHub 上的 `plugin/dsh-qq-whale/package.json`（`repository.url` / `homepage` / `bugs.url`）、`plugin/dsh-qq-whale/README.md` 的安装命令、根 `README.md` 的安装命令、`jasmine/README.md`、`docs/CHANGELOG.md` 里所有 GitHub 链接，全写成 `https://github.com/222222222/molly-qq-whale` —— 点开是 404，市场里的「安装」命令也装不上。

**根因**：不是笔误。主人的 QQ 号 `3150…853` 恰好就是他的 GitHub 账号名，而 `tools/build-publish.mjs` 的 `REPLACEMENTS` 里有一条**全局**替换 `[/222222222/g, '222222222']`（主人的 QQ 号 → 占位号），于是 `github.com/3150481853/…`、`github:3150481853/…` 一并被改成九个 2。**源仓库里本来就是对的**（`plugin/dsh-qq-whale/package.json:29/32/34` 等处的 URL 都指向真账号名），是构建时才被改坏 —— 所以之前手工改发布副本再推 GitHub（`4226dba6 → d9e7becb`）只是治标，下次重建又会改回去。

**改动**（1 个文件 `tools/build-publish.mjs`）：
- 新增「GitHub 地址豁免」：跑 `REPLACEMENTS` 之前，先把**地址/简写形态**里的账号名换成哨兵 `@@GH-OWNER@@`，替换完再原样还原。豁免三种形态：带域名的（`github.com` / `raw.githubusercontent.com` / `codeload.github.com` / `objects.githubusercontent.com` / `api.github.com/repos`）、`github:` 安装简写、裸 slug（`<owner>/molly-qq-whale`）。
- `verifyText()` 同样先换哨兵再匹配，否则 `qq` 规则会把合法地址判成泄漏，触发 `<REDACTED>` 兜底把整个文件里的真账号名连坐替换。
- `GH_OWNER` 与哨兵常量**拆成两段拼**（`['3150','481853'].join('')`）：本文件自己也要过一遍脱敏，写成整串会被它自己的规则改掉 —— 实测第一版就是这么坏的：还原步把源文件里那句哨兵常量也替换成了真账号名，再被兜底改成 `<REDACTED>`，同时把同文件里 3 处注释 URL 一起连坐。

**验证**：
- 重建：`node tools\build-publish.mjs` → **207 文件 / 3.50 MB /「第二次扫描：命中 0」/ exit 0**。
- 发布副本里 `github.com/3150481853` + `github:3150481853` + `raw.githubusercontent.com/3150481853` 共 **13 处**（含新增的注释示例），全部是真账号名；`222222222` 只剩「占位示例号」该在的地方（配置示例、测试夹具、本文件自身的规则表）。
- 逐处恢复：`plugin/dsh-qq-whale/package.json` 三条 URL、两处 README 安装命令、`jasmine/README.md:70`、`console/console.js:2920`、`docs/CHANGELOG.md` 里的历史 Release 链接。

**代价与退回**：账号名出现在自己的仓库地址里本来就等于公开（GitHub 上那个 URL 谁都能看见），不算泄漏；`222222222` 作为占位示例号仍保留。若将来要连账号名一起藏（比如另建匿名仓库），删掉 `GH_OWNER_URL_RES` 与 `protectGithubUrls` 的两处调用即可恢复旧行为，同时得把文档里的链接改成新仓库地址。

---

## 2026-10-29 · 动图理解：6 帧 → 12 帧（4 列 240px）+ 钉死「这是一张动图，别数格子」

> 主人（m02267）：「准确来说她说的是『这六格』，给 molly 增加帧数（格子）并添加约束词吧」。
> 未升版本号（仍是 `1.1.6-Hotfix.1`），只改「发图给模型前」的拼图参数与随图说明。

**现象**：动图会被采样成 6 帧、3 列 2 行拼成一张 PNG，每格左上角画着 `1/6`…`6/6`。她看到的是一张图，却按格子读成「六张/六格」，回复里出现「这六格…」。原先的说明只写了「按顺序看就是完整动作」，等于默认她会自己理解成一张动图。

**改动**（4 个文件）：

- `plugin/dsh-qq-whale/lib/gif-frames.js` `GIF_DEFAULTS`：`frames` `6` → `12`、`columns` `3` → `4`、`frameWidth` `320` → `240`（4 列 × 3 行；采样仍是按时间均匀取，不是只取开头）。
- `plugin/dsh-qq-whale/lib/main.js` `DEFAULTS.gifFramesCount/gifFramesColumns/gifFrameWidth`：`6/3/320` → `12/4/240`（profile 里同步）。
- `plugin/dsh-qq-whale/lib/engine-context.js`：新增导出函数 `gifNoteText(frames)`，`buildMessages()` 里改成按实际帧数生成说明，措辞为「这是一张动图，按时间均匀取了 N 个瞬间排在同一张图里；格子左上角的 1/N…N/N 只表示先后顺序。把它当成一张动图，直接描述发生了什么动作就好：不要说『这几张』『这几格』『几帧』『拼图』，也不要逐格报数。」
- `plugin/dsh-qq-whale/lib/persona.js` 人设里补一句同样的约束（收到动图时看到的是同一张图里排开的几个瞬间，不许数几张/几格）。
- `${HOME}\.dsh\profiles\desktop\cordis.patch.yml` 的 dsh-qq-whale 段：`gifFramesCount: 6` → `12`，并补 `gifFramesColumns: 4`、`gifFrameWidth: 240`。

**验证**：

- 新增 `tools/test-gif-note.mjs`：**12 通过 / 0 失败**（默认帧数 12、列数 4、单帧 240、说明含「一张动图」与 1/12…12/12、禁止数格子的四个词、帧数变化时序号跟着变、非法帧数不产生 NaN、`buildMessages` 真的调用了 `gifNoteText`、`main.js`/`persona.js`/`gif-frames.js` 三处默认值一致）。
- `tools/test-sanitize.mjs`：**33 / 33**（人设改动没误伤既有清洗逻辑）。
- 真机样本：`${MOLLY_ROOT}\data\qq-whale\stickers\学来的\Q版女巫_少女_挥手_眨眼_害羞_可爱.gif`（903 KB / 27 帧）→ 实际采样 **12 帧**、拼图 **980×850**、PNG 540 KB，说明里正确写出 `1/12`…`12/12`；按「面积 / 784」估算视觉 token ≈ **1.06k**（比 9 帧 @320 的 976×1114 ≈1.39k 还便宜，因为宽度压到 980 px 不触发上游缩放）。
- 部署：三个 `lib` 文件覆盖到 `${HOME}\.dsh\profiles\desktop\node_modules\dsh-qq-whale\lib\`（SHA-256 逐一比对一致），`plugin_manager` 关开一次；重载后最新 `gen-mvsyuwue-fhiy53` 副本里已是 `frames: 12` / `columns: 4` / `frameWidth: 240`，`/state` 正常（`enabled=true`、`link=online`、`memory.count=2335`）。

**代价与退回**：12 帧拼图 980×850 ≈ **1.06k 视觉 token**（比 9 帧 @320 的 ≈1.39k 更省，宽 980 px 不触发上游缩放，单格 240 px 仍看得清表情）；一轮里最多同时带 3 张图（`MAX_IMAGE_ENTRIES = 3`），最坏 ≈3.2k，占 128k 窗口约 2.5%。如果觉得太糊或太贵，把 `gifFramesCount` 改回 `6`、`gif-frames.js` 的 `frames/columns/frameWidth` 改回 `6/3/320` 即可恢复旧行为，说明措辞可保留（不影响帧数）。`python`/Pillow 缺失或超时仍会安静回退成「只发首帧」，不会丢消息。

---

## 2026-10-31 · v1.1.6-Hotfix.1：周信改成「有感受」的写法 + 补一个预览接口

> 主人（m02167）：「1.做，2.主要是不要念流水账，要有molly自己的感受」；发版指令（m02479）：「够了，把改动写1.1.6热修复1就行」。
> 版本口径：Molly `1.1.6-Hotfix.1`，茉莉花 `0.2.0` 不变（只改周信生成与插件接线，不动记忆模块 API）。

**改了什么**

- **周信提示词**（`jasmine/src/letter.mjs` 的 `buildLetterPrompt()`）：明确「不是工作汇报，是你一个人坐下来写给的私房话」；禁止「先…然后…接着」流水账，要求材料只挑 1~2 件展开、至少四处具体感受、写自己的变化/做砸的事/偷偷得意的事、不要只写主人吩咐的活、不编造事实、不出现 QQ 号/群号/时间戳/数字统计、开头别套话结尾别升华。
- **质量自检 + 一次重写**（新增导出 `letterQuality()` / `buildLetterRetryHint()`）：按感受词（觉得/心里/有点/忽然…）与事务动词（帮/替/完成了/回复了…）粗略打分，`feeling>=3` 且 `chore<=max(2, ceil(feeling*0.8))` 才算过；第一版不过就把「上一版写成了流水账」追加进提示再写一次，`source` 记 `model` / `model-weak`，仍不过就用第二版。
- **素材抽成方法**（`engine.js` 新增 `collectLetterFacts(weekKey)`）：周聚合摘要 + 原始记忆（event/person/meme/promise/preference）+ 事件桶兜底；`maybeWriteWeeklyLetter()` 与预览共用同一份取样逻辑。
- **预览接口**（`web.js` 新增 `POST /dsh-qq-whale/letter`，体 `{weekKey?}`）：只生成、不发送、不写记忆，返回 `{ok,weekKey,text,source,quality,facts,chars}`；由 `engine.previewWeeklyLetter()` 实现。控制台/群主想先看一版不用等到周一。
- 开关不变：`jasmineLetter`（总开关）、`jasmineLetterModel`（false 时退回模板）。

**验证**

- `cd jasmine && node --test` → **47 pass / 0 fail**（新增 2 条：流水账判不合格、有感受判合格；另有重写提示文案断言）。
- `node --check engine.js` / `web.js` / `letter.mjs` 全过。
- 真机预览（weekKey `2026-10-19`，519 条素材）：`source=model`、793 字、`feeling=19 chore=1`、`quality.ok=true`；样信存 `out/ja_letter_sample_2026-10-19.md`。
- 线上插件已热重载（`plugin_manager target=include:dsh-qq-whale` false→true），`/state.jasmine.available=true`。

**怎么退**

- 想回模板版：`config.jasmineLetterModel = false`（模板路径一直保留）。
- 想回旧提示词：还原 `jasmine/src/letter.mjs` 的 `buildLetterPrompt`（旧版 7 条要求，感受只要求「至少两处」）。

**顺带（不随包）**：3 个真实群成员号的全历史重写 + Release 附件重传已完成，细节见 `docs/STATE.md` §9.6。

---

## 2026-10-31 · v1.1.6 正式版：1.1.6 收口（预览 1~6 的全部内容 + 周信改成模型写）

> 主人（m02013）：「总结一下如今的升级（包括浏览小黑盒等），准备发1.1.6正式版」。
> 版本口径：Molly `1.1.6`（去掉 preview 后缀），茉莉花 `0.2.0` 随包。这一版**没有引入新代码**，
> 是把 preview.1~preview.6 已经真机跑过的东西收成一个正式版本，外加预览 6 之后的两处收尾（周信改为模型生成、`client.call` 成败判定修正）。

**相对 `v1.1.6-preview.6` 的实际改动（其余为收口）**

- **周信改由模型写（`jasmineLetterModel`，默认开）**：`engine.js` 新增 `writeLetterWithModel()`，
  用 `buildLetterPrompt()` 拼「她是住在 QQ 群里的机器人 + 上周事实清单」的系统/用户两段，`callModel()`
  带 90 秒 `AbortSignal`、`maxTokens: 1600`、`reasoningEffort: 'low'` 要一封 600~900 字的第一人称日记信；
  出稿先过 `cleanModelLetter()`（去 markdown/序号/QQ 号/群号、补句末标点），再做「像不像工作汇报」自检，
  不合格判失败。**失败/超时/太短/模型不可用一律回退模板版**，信一定写得出来（线上一卦实测：模型出稿 973 字，
  另一次模型超时后模板 1,300 字照发）。`jasmineLetterModel=false` 可退回纯模板。
- **`client.call()` 成败判定修正**：OneBot 的 `call()` 成功即 resolve、失败即 reject，旧代码按
  `res.status/retcode` 判成败会把**上传成功误判成失败**（表现：文件其实发出去了，日志写「上传失败，改发纯文本」）。
  `upload_private_file` 与分条发送都改成「不抛异常即成功」。
- **周信长信走文件**：正文 ≥550 字时落 `<dataDir>/jasmine/letters/<周一>.md` 再 `upload_private_file`
  私聊主人（附件名 `Molly周信-YYYY-MM-DD.md`），发不出去退回按段落分条发文本。真机验证 `file_id` 已返回。
- **单测补到 45**：`jasmine/test/features.test.mjs` 加「不像汇报 / 不出现 QQ 号 / 有感受句 / 讲的是她自己的视角」
  四条断言，`cd jasmine && node --test` = **45 pass / 0 fail**；`node --check` 全过。

**1.1.6 正式版里包着的（预览 1~6 累计，细节见各预览条目）**

- 记忆底座：七类分片 + 5 万池 + 活跃天阶梯衰减 + 三级去重 + 权重 5→10 + 命中记账；
  RRF 名次融合召回（`RRF_K=60`，关键词 0.6 / 权重 0.4）+ `lastRecall` 对账；识海图 + 记忆抽象两个开关；
  周聚合（`summarizeWeek`）+ 归档（`_archive.json`，90 个活跃天）+ 压缩标记（`coveredUntil` / `lastCompactionAt`）。
- 茉莉花 `jasmine/` 0.2.0：`JasmineStore` / `TokenLedger` / `shouldSpeak` / `buildLetter` / `verifyReply` /
  `evaluateCompaction`，零依赖纯 Node ESM，独立分支 `jasmine` + tag `jasmine-v0.2.0`，接入见 `jasmine/docs/PORTING.md`。
- 插件接入：出口核对（只记 trace）、压缩三档提醒（追加请求末尾）、周信定时、token 账本（`/api/jasmine/tokens`）、
  群聊四档信号（只否决「@ 的是别人」）；`boot.js` 物化副本补拷 `.mjs`（预热漏拷 `jasmine-bridge.mjs` 会让 engine 整包加载失败）。
- 稳定性：超预算不降智（备用脑 → trae → 正常链）、`trae.chat()` 异常归一、表情包/语音「文字冒充图片」口径修掉、
  同群双泳道、`Molly-DSH` 开机自启、控制台数据服务自愈。

**验证**：`lib/` 全量 `node --check` 通过；六个记忆门禁 + 三个 jasmine 离线门禁 + 桥接自检全绿；
线上 `/state.jasmine.available=true`，`trace.jsonl` 有真实群回复核对记录；周信真机发过（模型版 973 字 + 模板版 1,300 字文件）。

**退回**：`jasmineVerify` / `jasmineCompact` / `jasmineLetter` / `jasmineLetterModel` / `jasmineSignal` 任一设 `false`
即回退单项；`memoryGraph` / `memoryAbstract` 关掉即回旧召回；整体回退见 `v1.1.6-preview.6` 条目「退回」段。

---

## 2026-10-30 · v1.1.6-preview.6：茉莉花记忆系统 0.2.0 整合进包（识海图 + 周信 + 账本 + 出口核对）

> 主人（m02258）：「再验证一遍，可以的话整合成新版的茉莉花记忆系统发GitHub」
> 版本口径（主人拍板）：Molly `1.1.6-preview.6`、jasmine `0.2.0`。

**这一版把预览3 之后散着的东西收进一个包**

- **茉莉花记忆系统 `jasmine/`（0.2.0）随包发布**：`JasmineStore`（双卡存储 / RRF 召回）、
  `TokenLedger`（token 账本）、`shouldSpeak`（群聊四档信号）、`buildLetter`（周信）。
  插件侧通过 `lib/jasmine-bridge.mjs` 按 `../jasmine/index.mjs` 动态加载，缺失时降级为「无记忆系统」，不影响主流程。
- **P0-1 出口核对**：`verifyOutgoing()` 在 45 秒去重之后、真正发送之前对照「本轮召回过的条目」；
  只记 `jasmine/trace.jsonl`，不改写、不阻拦。
- **P0-2 压缩提醒**：`buildMessages()` 之后按三档（可压 ≥5 万且增量 ≥1 万 / 75% / 95%）在请求末尾追加一行提示，不写进历史。
- **P0-3 周信**：`main.js` 30 分钟定时 + 启动 60 秒首检，`summarizeWeek()` → `buildLetter()` → 写回一条 `letter` 记忆 → 私聊主人；一周一封。
- **P1-5 token 账本**：`recordUsage()` 除原有 budget 记账外，再追加 jasmine 账本（model + purpose + 输入/缓存/输出）。
  控制台新增 `GET /api/jasmine/tokens?days=7`（只读聚合 + 最近 20 条）。
- **P1-6 群聊信号**：`shouldRespond()` 外包一层，只对「这条 @ 的是别人」一票否决，其余档只进 `decisionLog`。
- **识海图（preview.5 引入，本版随包）**：`memoryGraph` 同一次召回的前 5 条两两连边、召回时沿边扩 2 跳（每跳 ×0.6）；
  `memoryAbstract` 同 tag ≥3 条且至少一条 `hits>0` 时抽象一条「关于X：…」节点，原条目降一级不删。两个开关默认关，profile 里已打开。
- **超预算不再降智**：`generate()` 的 `budgetOut` 分支不再丢掉上下文、不再系统级「说短点」；
  超预算只走「备用脑 → trae（历史最近 12 条 + 降智提示）→ 正常分层链」，`callDegraded()` 的 `trae.chat()` 补了 try/catch。
- **表情包/语音「文字假装发图」修复**：`persona.js` 把改写式发图宣告（「我打了张…的图」）转成真 `<sticker>` 指令，
  纯旁白 `（我……了）` 整段删除但正文为空时保留原文；`voice.js` 送 TTS 前先剥掉「我发送了一个表情：xx」。

**验证（发版前跑）**

- 语法：`lib/` 下 **51 个 js** `node --check` 全过；`jasmine/` 全部 `.mjs` 全过。
- 单测：`test-memory-graph.mjs` **25/25**、`test-sticker-claim.mjs` **20/20**、`test-sanitize.mjs` **33/33**；
  `jasmine` 包内 `node --test`：`features` **33 pass**、`store` **12 pass**。
- 接入自检：`jasmine-bridge-selftest.mjs` **12/12**、`_jasmine_engine_check` **15/15**、`_jasmine_ledger_check` **9/9**、`_jasmine_signal_check` **11/11**。
- 记忆六回归：rrf 25/25、dedup 27/27、v2 25/25、archive 20/20、week 17/17、compact 18/18。
- 线上：`/dsh-qq-whale/state` 的 `memory.graph=true`、`abstractTags=true`、`links=136`、`count≈2090`。

**退回**

- 只关功能：profile 里 `jasmine*` 四个开关置 `false`、`memoryGraph`/`memoryAbstract` 置 `false`。
- 连代码一起退：覆盖回 preview.5 的 `lib/`，或 `git checkout -- plugin/dsh-qq-whale/lib` + 删 `jasmine/`；控制台接口随包，退回旧 `tools/console-server.mjs` 即可。

---

## 2026-10-28（晚）· 识海图：记忆之间连边 + 两跳扩散；同 tag 自动抽象（未升版本号，仍是 1.1.6-preview.5）

> 主人（m02008）：「按照你的推荐来，日记的话不用，我有周记了」
> 缘起：小黑盒那篇「四层记忆框架」把记忆写成一张带边的图（节点 + edges + 沿边扩散）；
> Molly 的记忆库此前只有孤立节点——同一次对话里一起被想起来的几条，回盘上互不相干，谁也带不出谁。

**新增两个开关（默认关；本次在 profile 里打开）**

- `memoryGraph`：同一次召回命中的**前 5 条**两两连边（双向存 `edges: [[id, w, at], …]`，
  首次 0.6、每再连一次 +0.25、封顶 1，单节点最多 8 条边）；召回时以融合分头部 8 条为种子，
  沿边扩散**最多 2 跳**、每跳 ×0.6、多路取最大，增益直接加到 `rrf` 上再重排序。
  扩散只在候选池内走，不会把没命中关键词的条目拉进来。
- `memoryAbstract`：某个 tag 攒到 **3 条**、且至少一条真被问过（`hits > 0`），就生成一条
  `kind='fact'`、`source='system'` 的「关于X：…」节点（正文取前 4 条各截 40 字，上限 200 字）；
  原条目**不删**，只降一级（`level+1`，`abstractedBy` 记来源于哪个 tag），避免反复抽象。

**边会自己老化**：`prune()` 时清掉悬空边、自环、权重 < 0.05 的边、以及 90 个**日历天**没再被连过的边。
条目衰减按「活跃天」（不聊天就不掉），边按日历天——两者口径不同是有意的：边是「两条记忆的关联」，
人不说话它也在变淡。

**验证**

- 新增 `tools/test-memory-graph.mjs`：**25 通过 / 0 失败**（边增益抬排名、只扩两跳、老化裁剪、
  单节点边数上限、抽象生成与幂等、召回接线、两个开关全关时与改动前逐条一致）。
- `node --check` 过 `memory.js` / `main.js` / `engine.js`；`/dsh-qq-whale/state` 的 `memory` 段新增
  `graph` / `abstractTags` / `links` / `abstracted` 四个字段（控制台一眼能看出有没有生效）。

**退回**

- 只关功能：`${HOME}\.dsh\profiles\desktop\cordis.patch.yml` 里把 `memoryGraph` / `memoryAbstract` 改回 `false`。
- 连代码一起退：`git checkout -- plugin/dsh-qq-whale/lib/memory.js plugin/dsh-qq-whale/lib/main.js plugin/dsh-qq-whale/lib/engine.js`
  并删掉 `tools/test-memory-graph.mjs`。

---

## 2026-10-31 · 茉莉花（Jasmine）记忆系统 0.1.0 发布 + P0/P1 接入（**preview.4**）

> 主人（2026-10-31）：「开始做p0和p1，项目代码命名为茉莉花（Jasmine）记忆系统，做好后发布GitHub作为独立的分支更新（可供移植到其他人的其他架构上使用，又默认包含在molly的每一次更新中）」

**新包：`jasmine/`（仓库根，零依赖纯 Node ESM，Node ≥ 18）**

- 八个模块：`src/store.mjs`（双卡：衰减卡 `jasmine.json` + 原始账 `ledger.jsonl`，归档 `_archive.json`）、
  `src/recall.mjs`（RRF 两臂融合，K=60，关键词 0.6 / 权重 0.4）、`src/decay.mjs`（七类记忆、活跃天衰减、
  只读不写回）、`src/verify.mjs`（出口核对）、`src/compact.mjs`（压缩三档提醒）、`src/letter.mjs`（周信模板）、
  `src/ledger.mjs`（token 账本，按 purpose 分组）、`src/signal.mjs`（群聊四档信号）。
- 测试：`node --test "test/**/*.test.mjs"`，39 用例（store/features）。
- 文档：`README.md`、`docs/PORTING.md`（宿主接入 10 步）、`docs/DESIGN.md`（取舍与被否掉的方案）。
- 发布：随 Molly 每次更新一起发（`tools/build-publish.mjs` 的 `DIRS` 加了 `['jasmine','jasmine',true]`），
  同时在发布仓库的 **`jasmine` 孤儿分支**独立维护（tag `jasmine-v0.1.0`）。

**接入点（插件侧）**

1. **P0-1 出口核对**：新增 `lib/jasmine-bridge.mjs`（按 `../jasmine/index.mjs` 动态加载，失败降级为「无记忆系统」）；
   `engine.js` 新增 `verifyOutgoing()`，在 `deliver()` 的 45 秒去重之后、真正 `sendPayload` 之前调用；
   `engine-context.js` 召回后 `noteRecalled(ids)` 回传本轮 id 作为「出处白名单」。
   只记 trace（`<dataDir>/jasmine/trace.jsonl`，5MB 轮转）、**不改写、不阻拦**。
2. **P0-2 压缩提醒**：`engine.js` 新增 `maybeHintCompaction()`，`buildMessages()` 之后按三档
   （可压 ≥5万且增量 ≥1万 / 75% / 95%，能回收 <5000 不提醒）往**本轮请求末尾**追加一行，
   不写进历史；`contextWindowTokens`、`compactMinReclaim` 可配。
3. **P0-3 周信**：`main.js` 加 30 分钟定时器 + 启动 60 秒首检；`engine.js` 新增 `maybeWriteWeeklyLetter()`，
   `summarizeWeek(weekKey)` → `buildLetter()` → 写回一条 `letter` 记忆 → 私聊主人；一周只写一封（状态落 `state.json`）。
4. **P1-5 token 账本**：`recordUsage()` 在原有 budget 记账之后追加 jasmine 账本（model + purpose + 输入/缓存/输出）。
5. **P1-6 群聊四档信号**：`shouldRespond()` 外包一层，只做「这条 @ 的是别人（score=0）」一票否决；
   其余档位只进 `decisionLog`（新增 `signal`/`signalScore` 字段）。
6. `web.js` 的 `/state` 增加 `jasmine` 字段（available / checked / flagged / lastConstraint / compact / letter / recalledIds / loader）。

**开关（默认全开，出问题单独关）**：`jasmineVerify` `jasmineCompact` `jasmineLetter` `jasmineSignal`，
任一设 `false` 即回退到接入前行为。

**验证**：`node --check` 全过；离线自检 `tools/jasmine-bridge-selftest.mjs` **12/12**、
`out/_jasmine_engine_check.mjs`（压缩三档 + 周信）**15/15**、`out/_jasmine_ledger_check.mjs` **9/9**、
`out/_jasmine_signal_check.mjs` **11/11**；jasmine 包内 **39/39**。

**已知限制**：线上插件实例尚未重载，`/state.jasmine` 要等 DSH 重启后才出现；
核对层是规则 + 统计，不做语义级事实核验。

**退回**：四个开关任一设 `false` 只关单项；要整体回到 preview.3 的行为，
把 `jasmineVerify/jasmineCompact/jasmineLetter/jasmineSignal` 全设 `false`（代码留着不执行），
或者覆盖回 preview.3 的插件包。`<dataDir>/jasmine/` 删掉即清零，不影响 `memory/` 里的旧记忆。

---

## 2026-10-28 · 表情包/语音「发图宣告变成文字」修复（未升版本号，仍是 preview.3）

> 主人（2026-10-28 00:1x）：「为什么 Molly 表情包又开始文字了」→ 排查后我给了两个修法，主人选 **A**（出口兜底）：
> 「A：把清洗正则放宽到「（我(发|打|甩|扔|贴|丢)了…(表情包|图|图片)…）」→ 认下来，能抽关键词就发对应图，
> 抽不到随机一张；纯动作旁白（我闭眼了）不补图、只删旁白」。

**现象（真机取证，群 666666666，2026-10-27 23:52 ~ 10-28 00:04）**

- 她开始用**文字演动作**，其中最要命的一条：`00:00:06` 消息号 `-77507227`
  「收到，鱼要睡了。都散了吧，熬夜的那几个也是。**（我打了张打哈欠的图，先撤了）**」——
  前后三分钟里**没有任何图片消息**，等于"说我发了图，其实一个像素都没发"。
- 同窗口还有三条纯旁白：「（我缩回被窝里了）」「（我团成一团，缩进被窝里了）」「（我闭眼了）」。
- 分时段统计（群内最近 900 条里属于她的）：`23:00` 时段 67 条 / 11 张图 / **0** 条括号动作；
  `00:00` 时段 12 条 / 2 张图 / **4** 条括号动作 / 其中 1 条"假发图"。
- **当天上午的两种变体（2026-10-28 10:46 / 11:23 真机，主人补齐）**：
  `（发了张表情包：眯眼）`、`（发了张表情包：无语）` —— **没有主语「我」**；
  主人还反馈「**发语音也会带着（我发送了一个表情：xx）**」—— 动词是「发送」、
  名词是「表情」（不带"包"），而且这句会被一起送进 TTS **真念出来**。

**根因：她在模仿自己的历史**

1. 她真发出图后，`deliver()` 往 history 里写的是人话 `（我发了张表情包：${query}）`
   （`lib/engine.js:5650` 那段，初衷是别让模型学到 `[表情包:x]` 这种协议格式）。
2. 这段 history 下一轮原样喂回，模型学会了句式，开始**改写**成「我打了张打哈欠的图」——
   只写句子、不写 `<sticker>` 标记，于是没有任何图发出去。
3. 出口护栏只认两种**精确**写法：`[表情包:x]`（`lib/persona.js:303`）和
   `（我发了(一张|张)?(表情包|图|图片)：x）`（`lib/persona.js:315`）。动词一换、
   中间多几个修饰词就全漏成正文 —— 用正则实测：`（我打了张打哈欠的图，先撤了）`、
   `（我甩了张表情包：睡觉）` **都不匹配**。
4. 顺带确认不是功能坏了：图库 `scan()` = 557 张 / 跳过 0、`catalogText()` 222 字符标签齐全、
   `/state.stats` 里 `stickersSent=26`、`stickerFallback=0`、`unmatched=17`（没命中也会改随机图）。

**改动（只动 `lib/persona.js`，出口清洗层）**

1. **改写式发图宣告 → 真出图**（`lib/persona.js:320` 起）：动词放宽到 `发/发送/打/甩/扔/贴/丢/拍/做`，
   主语「我」改为**可选**，名词补上「表情」（不带"包"），中间允许任意修饰；关键词抽取顺序 =
   **冒号后的内容 → 「X 的图」里的 X → 空**（空则交 `engine.resolveSticker()` 随机挑一张）。
   转换结果是 `<sticker>关键词</sticker>`，走原有出图链路。
2. **纯旁白动作 → 只删旁白**（`lib/persona.js:354` 起）：`（我……了）` 这类自述动作整段去掉，
   正文保留；**保险**：删完若整条为空，则保留原文，绝不发空气泡。
3. 新增 `pickStickerKeyword()`（`lib/persona.js:458`）负责上面那套关键词抽取（纯字符串处理，不查图库）。
4. **语音链路同步清洗**（`lib/voice.js:48` `cleanVoiceText()`）：送进 TTS 之前把括号里提到
   「图 / 表情 / 表情包」的短句剔掉（`（我发送了一个表情：可爱）` → 空），避免她把自己"发了个表情"
   当台词念出来；不含图/表情的普通括号（如「（好好笑）」）照旧保留。
5. 语音假宣告的两条护栏也一并放宽（`lib/persona.js:348-352`）：主语可选、动词补「发送」。

**验证（2026-10-28 00:2x / 11:5x 两轮实测）**

- 新增回归 `tools/test-sticker-claim.mjs`：**20 通过 / 0 失败**
  （改写式三种形态、无主语版、`发送`+`表情` 版、无关键词仍出图、原有两种护栏不回归、
  纯旁白只删旁白、只有旁白时不变空、普通插入语/语音宣告/正常句子不误伤、
  语音清洗剔掉「发了张表情包」且不误伤普通括号）。
- 既有 `tools/test-sanitize.mjs`：**33 通过 / 0 失败**（格式兜底没被改坏）。
- `node --check` 通过：`lib/persona.js`（`BB3DF64B…`）、`lib/voice.js`（`26E985BB…`）；
  部署副本与源目录逐字节一致；插件关开重载后 `/dsh-qq-whale/state`：
  `enabled=true`、`link=online`、`stickers.count=557`、`plugins.failed=[]`。
- 行为预期：上面那句改写现在会变成**「收到，鱼要睡了。都散了吧，熬夜的那几个也是。」+ 一张图**
  （关键词 `打哈欠` → 图库匹配不到就随机，比甩一句假话强）；语音里夹的同一句不再被念出来。

**已知限制 / 没做的**

- **只做了 A（出口兜底）**：B（改 history 记录句式，从源头让模型学不到）与
  C（system prompt 结尾再钉一句）主人这次没选，没动。A 是"改写被认下来变真图"，
  模型还会继续改写，只是不会再漏成文字。
- 纯旁白动作在**整条只有旁白**时仍会保留原文（防空气泡的代价）；要彻底不出现，得上 B/C。
- 图库标签抽不中时是**随机图**，可能与语义不完全吻合；`unmatched` 计数继续累积，用来评估图库标签质量。

**退回**

```bash
git checkout -- plugin/dsh-qq-whale/lib/persona.js plugin/dsh-qq-whale/lib/voice.js
```

部署侧：把旧的 `persona.js` / `voice.js` 拷回 `…\node_modules\dsh-qq-whale\lib\` → `plugin_manager` 关开一次。
数据侧无需处理（这次只改出站清洗，不碰记忆/账本）。

---

## 2026-10-27 · v1.1.6-preview.3（预览版，已推送 GitHub）

> 主人（2026-10-27 23:2x，本会话）：「推送一下Molly现在的版本，作为1.1.6的下一个预览版」，确认版本号：「预览3」

**基线**：上一个发行版是 `v1.1.6-preview.2`（Release #425068427、tag 提交 `ec12b3d`、2026-10-27T05:34Z、附件 1,373,023 B / 180 文件 / 3.13 MB）。
本预览版 = preview.2 构建之后到今晚的全部改动：**第二批记忆改造第一次真正进包** + 超预算不再降智 + 远程指令信箱。

**本版特性（按影响面排）**

1. **第二批记忆改造随包发出**（`lib/memory.js` / `lib/engine.js`）
   - preview.2 那次构建早于这批改动落地，GitHub 上的 `v1.1.6-preview.2` **不含**这批代码；本版是第一次真正打包发出，细节见下面「第二批记忆改造续记」。
   - **P0-2 召回改 RRF 名次融合**：`RRF_K=60`、关键词臂 0.6 / 权重臂 0.4，两路各自排序再融合；`status().lastRecall` 能看到候选数、分词与前 5 条的两路名次+融合分。
   - **P1-3 归档**：`ARCHIVE_IDLE_DAYS=90`，`event`/`meme` 到该类下限且闲置够久 → 移进 `_archive.json`，**不物理删除**；归档簿坏了只 warn、条目留在热池。
   - **P1-4 周聚合 + missing 补漏**：`summarizeWeek()` 生成 `kind=event / level=2 / weight=8` 的周摘要，原始事件 `level+1` 自然衰减；启动时 `missingWeeks({lookback:2})` 只补最近两周、**当前周不补**、天然幂等。
   - **P2-5 压缩标记**：`coveredUntil` 写到被覆盖的原始 event 与摘要条；`index.json.lastCompactionAt` 只有周聚合会推进；老 index 缺字段当 0 且**不回写**（老文件字节不变）。
2. **超预算不再降智**（主人 m01170「molly切换到智降级后报错」）
   - 根因：`generate()` 把「主脑积分超限」直接传成 `degraded` —— 人设提示词被切成"说短点"、历史只喂 12 条；`budgetOut && trae` 还整条短路掉分层链。
   - 现在：① 超预算 → 备用脑（同款 cn flash、**全量上下文**），只是换个钱包；② 备用脑烧满 → trae 接盘，这一层才真降智（512 token + 最近 12 条，裁剪挪进 `callDegraded()` 自己算）；③ 两条都没接住 → 回落正常免费额度链。预算闸照旧（超限期间不往主脑积分池砸钱）。
   - `callDegraded()` 另外把 trae 适配器抛的异常归一成 `{ok:false}`（原来会穿到外层 catch，整轮变成"走神"兜底 —— 主人看到的"报错"就是它）。
3. **远程指令信箱（新增）** —— 服务器存指令、家里轮询执行并回写，全程出站，不需要端口映射
   - `tools/cmd-agent.mjs`：`--once` 跑一轮 / `--loop` 常驻（默认 30 秒）/ `--issue-otp` 生成一次性口令 / `--dry-run` 只打印。
   - `tools/qq-say.mjs`：零依赖 OneBot v11 WS 发消息（`--group` / `--user` / `--login`），cmd-agent 的嘴。
   - `tools/run-hidden.vbs` + `tools/cmd-agent-once.cmd`：无黑框每分钟一轮，计划任务 `MollyCmdAgent`（已装、状态 Ready）。
   - 动作白名单：`ping` / `status` / `logs` / `budget` 只读；`reload-watchdog` / `say` 属破坏性动作，必须带一次性口令（6 位、5 分钟、用一次即废，**口令只私信主人**、不写进公开 result）。每轮落 `out/cmd-agent.log`，执行细节落 `out/cmd-audit.log`。
4. **版本号**：`plugin/dsh-qq-whale/package.json` → `1.1.6-preview.3`；控制台 `tools/console-server.mjs` 的 `FALLBACK_VERSION` 与 `console/index.html` 页脚同步（唯一真源仍是 package.json）。
5. **脱敏补漏（发布流程本身）**：本版发布前用 `tools/release-assets.mjs` 的口径对 tag 树做了一次兜底复扫，抓到 3 个真实群成员号（已换成 `888888888` / `999999999` / `987654321`）散在 `lib` 注释、CHANGELOG 与地址解析自测夹具里 —— `tools/build-publish.mjs` 的 `REPLACEMENTS` / `REAL_NUMBERS` 之前没登记。已补规则并重建（0 命中），本版提交是修正后的树。

**验证（发版前实测，2026-10-27 23:3x）**

- `lib/` **49 个 js** 全部 `node --check` 通过；`tools/{cmd-agent,qq-say,build-publish,release-assets}.mjs` 同样 exit 0。
- 六个记忆门禁全绿：`_memory_rrf_check` 25/25、`_memory_dedup_check` 27/27、`_memory_v2_check` 25/25、`_memory_archive_check` 20/20、`_memory_week_check` 17/17、`_memory_compact_check` 18/18。
- 线上 `GET http://127.0.0.1:4739/dsh-qq-whale/state` 200：`memory.name="茉莉花"`、`count=1786`、`limit=baseLimit=maxLimit=50000`、`archiveCount=0`、`lastCompactionAt` 已推进；`memory.lastRecall.top[]` 带 `rrf/rankKeyword/rankWeight` —— 召回确实在走 RRF。
- 部署副本与源目录**逐字节一致**（`memory.js`、`engine.js` 的 SHA-256 相同），插件已重载、`/state` 正常。
- `tools/build-publish.mjs` 重建：**命中 0**、无丢弃；文件数与体积见发布副本 `PUBLISH-MANIFEST.md`。

**已知限制**

- **归档还没在真机触发**：`archiveCount=0`（阈值 90 活跃天，库才有 1 个活跃天），行为现阶段靠门禁脚本保证。
- **不做同义词扩展**：`memory-test3.mjs` 的「咖啡→美式」仍失败（老基线就如此），不是本版回归。
- **不含语音包**：音色包仍单独下 Releases 里的 `voice-pack-v1.2`；唱歌保持关闭（`singingEnabled=false`）。
- **旧提交里仍有这 3 个真实群成员号**：本版只把**当前树**修干净（本版提交已改写并强推）；`ec12b3d` 及更早的旧提交、旧 tag 仍能按 SHA 下载到它们。彻底清要走 2026-10-23 那次的全历史重写 + GitHub Support「Clear Cached Views」同款流程，**等主人定**，别自己动手重写全史。
- **cmd-agent 是自有服务器配套件**：发布副本里 relayBase 会被脱敏成 `example.asia`，部署者要自己填；`MollyCmdAgent` 计划任务也要自己建（本版没有一键安装脚本）。

**退回**

```bash
git checkout -- plugin/dsh-qq-whale/lib/memory.js plugin/dsh-qq-whale/lib/engine.js \
               plugin/dsh-qq-whale/package.json console/index.html tools/console-server.mjs
rm -f tools/cmd-agent.mjs tools/qq-say.mjs tools/run-hidden.vbs tools/cmd-agent-once.cmd
```

数据侧：`_archive.json` 不需要时直接删（缺失当空）；`index.json` 的 `lastCompactionAt` 缺失当 0，删了不影响加载。
部署侧：把旧 `memory.js` / `engine.js` 拷回 `…\node_modules\dsh-qq-whale\lib\` → `plugin_manager` 关开一次。

---

## 2026-10-27 · v1.1.6-preview.2（预览版，已推送 GitHub）

> 主人 m02546：「读一下 state 和 changelog 这些文件，分析从上一个 github 发行版后 molly 升级改动了什么，整理成 v1.1.6 第一个预览版，刷一下 molly 版本号但是不要推送 github」
> 主人 m02812：「做之前先把现在的版本打包上传，命名为v1.1.6-preview.2，并署名记忆库为"茉莉花"记忆系统」
> 主人 m02845：「发布前请改动：记忆库扩容至5w条」

**基线**：上一个发行版是 `v1.1.5-A-Hotfix.1`（Release #424182053、tag 提交 `75cf38f`、2026-10-26T11:45Z、附件 1,317,133 B / 177 文件）。
本预览版 = 那个 tag 之后到今天的全部改动，全部已落盘、已部署、已在线上跑过。

**本版特性（按影响面排）**

1. **记忆体系重做**（`lib/memory.js` 为主）
   - **记忆库署名「茉莉花」**（`MEMORY_SYSTEM_NAME`，`/state.memory.name` 可见）；名字只用于对外说明，不参与检索/去重/衰减。
   - **容量一次给到 5 万条**：`memoryPoolLimit` / `memoryPoolMax` 都是 50000（`lib/main.js` DEFAULTS +
     `${HOME}\.dsh\profiles\desktop\cordis.patch.yml`），满了才按有效权重/活跃天淘汰。
   - 按机器人账号分七类落盘：`<dataDir>/memory/<机器人QQ>/{person,address,promise,fact,preference,event,meme}.json` + `index.json`；
     老 `memory.json` 首次启动自动迁移并归档成 `_legacy-memory.json`。
   - 权重刻度 5 → 10（一位小数），老数据 ×2 等比迁移、召回打分系数 0.3 → 0.15、称谓钉满 10。
   - 阶梯衰减：只在"真聊过天"的日子累加活跃天，人物/约定/事实/偏好宽限 14 活跃天、事件/梗 7 天，
     之后每 7 个活跃天 −0.5，到下限为止；命中把它拉回当前活跃天。只在读取时算，不改盘。
   - 命中记账（`hits` / `lastHitAt` / `lastActiveDay`）。
   - 写入闸门：`source=assistant` 不许写 `fact` / `person`。
   - 检索预算（字符 800/1200/1600）+ `level` 0–3 压缩等级（只标记不自动改）。
   - **三级去重 + 冲突不合并**（学自白守 BaiShou-Next 的设计，代码全自写）：
     `findDuplicate()` 改成返回 `{entry, score}`；≥0.92 跳过（不重写文字、只刷新提起时间）、
     0.70~0.92 合并（权重取高、hits 相加）、<0.70 新增；`findConflict()` 独立扫「意思相反」的旧条目
     （不依赖相似度——「他喜欢猫」→「他其实不喜欢猫」字面只有 0.2），命中则两条都留、旧的打
     `supersededBy`/`supersededAt`、召回 ×0.4 降权；`dedupeAll()` 也不再合并冲突对。
2. **同群双泳道 + 发送串行 + 模型并发闸门**（`lib/engine.js`）——子房连 @ 三次不回的根因修复。
3. **取消「回不过来就不回」**：模型链全挂时说一句兜底（90 秒节流 / `silentOnModelFail` 可关回）。
4. **认人 / 报时 / 夜间语气**三条现场投诉修复（自称判废、名册带称谓、结尾重念称谓与时间、别人报的点数不算数）。
5. **运维**：开机自启（见下一条）+ 控制台数据服务自愈。

**状态核对（2026-10-27 10:40 本地，`/state` 实测）**

- 插件：`missing=[] failed=[]`、`link={"ready":true,"state":"online"}`、`bot=Molly(111111111)`、`model.ok=true`（`deepseek-v4.1-flash`，网关 `127.0.0.1:8788`）
- 记忆：`count=1478`、`account=111111111`、`activeDays=1`、`shards={person:130, address:7, promise:105, fact:622, preference:33, event:94, meme:487}`
- 并行：`parallel={"jobs":1,"lanes":["group:666666666|ambient"],"model":{"limit":3,"active":0,"waiting":0}}`
- 累计：`metrics.messages=12540`、`stats.replies=28`、`stats.modelDownLines=4`、语音 `ok=7 fail=0`、抽奖 `restored=0 expired=[]`
  （`stats.*` 是内存计数，升版本号时又重载过一次会归零；`metrics` / `memory` 落盘，不受影响）

**验证**

- `_memory_v2_check.mjs` 25/25、`_memory_api_probe.mjs` 16/16、`_parallel_lane_check.mjs` 44/44、`_model_down_check.mjs` 24/24、
  `_memory_dedup_check.mjs` 27/27（三级去重 / 冲突不合并 / hits 相加 / 降权 / supersededBy 落盘）；
  线上迁移 1462 条 → 七分片，`index.json` 与 `/state.memory` 对得上。
- 观察哨 `_memory_watch.mjs` 十分钟 30 次采样：记忆 1463 → 1467、分片 542 → 550 KB、消息 12336 → 12396，报警 0 条。

**已知限制**

- **仍然不含唱歌**（`singingEnabled` 保持 `false`，音色未达标）。
- 预览版：双泳道的真机效果还在观察（看 `/state.parallel` 的 `lanes` 与 `model.waiting`），
  文档里承诺的"方案 B 真并发"没做，也不建议在免费 flash 上做。
- 本版**已**跑 `tools/build-publish.mjs` 并推送 GitHub（tag `v1.1.6-preview.2`；tag 带 `-preview` 会自动标 prerelease），
  附件由 `tools/release-assets.mjs` 从 tag 树重打包（含隐私扫描与 `#molly` 回填）。

**退回**

```bash
git checkout -- plugin/dsh-qq-whale/lib/{memory,engine,engine-text,engine-context,clock,web,main}.js \
               plugin/dsh-qq-whale/package.json console/index.html console/console.js tools/release-assets.mjs
```

数据侧：把 `data/qq-whale/memory/_legacy-memory.json` 改回 `memory.json`、删掉 `<账号>/` 分片目录即可回到单文件记忆
（权重已 ×2，回旧刻度需要手动 ÷2，没有自动反算脚本）。

### 第二批记忆改造续记（原记在 v1.1.6-preview.2 名下；实际随 v1.1.6-preview.3 发出，2026-10-27）

> **补记（2026-10-27 23:4x）**：这批改动当时**没有**进 `v1.1.6-preview.2` 的发布包（那次构建早于改动落地），
> 从 `v1.1.6-preview.3` 起正式随包发出。本小节末尾「不升版本号、不提交发布仓」的说法按此更正。

> 板子第 7 条：把 `docs/memory-upgrade-from-baishou.md` 的第二批 P0-2 / P1-3 / P1-4 / P2-5 做完记账。
> P0-2 / P1-3 / P1-4 / P2-5 四项改造 + `engine.js` 里的挂载改动**全部已实现、已部署、已上线验收**。代码 `lib/memory.js`（2172 行）与 `lib/engine.js`（6714 行），
> 括号里的行号都是本次改动后的实测行号（行号会随下次改动漂移，认符号名）。

**1. P0-2：召回从「单一加权分」改成 RRF 名次融合**（`memory.js` `recall()` @1533）

- 两路各自排序再融合：关键词路（身份加成 qqHit +4 / sameName +2 / nameContains +1、2-gram IDF、meme 意图 +3、
  新鲜度 +0.3 上限）与权重路（`effectiveWeight(e, activeDays)`）；`RRF_K = 60`（@2100）、
  关键词臂 0.6 / 权重臂 0.4（@2101-2102），按融合分排序，同分比 `lastActiveDay` / `at` 兜底。
- 被 `supersededBy` 标记的条目两路都 ×0.4（`SUPERSEDED_PENALTY` @2090；**只降权，正文不删**）。
- 新增 `kwStrong` 字段（@1609-1633）：**只**由「≥2 字词命中」置位，和会被身份命中置位的 `strongHit` 拆开
  （否则「叫了声名字」就会把候选池闸门打开）。闸门规则：有强关键词命中 → 只留 `kwStrong ∪ 同 qq 硬身份命中`；
  否则退回身份命中；短 query 再退到单字命中（@1676-1684）。
- `status()` 新增 `lastRecall` 对账字段（最近一次召回的候选数、分词、前 5 条两路名次与融合分，@1742-1776），
  召回为什么没出来可以直接看 `/state.memory.lastRecall`。

**2. P1-3：归档而不是只靠淘汰**（`memory.js`）

- 新增 `ARCHIVE_IDLE_DAYS = 90`（@240）：`event` / `meme` 两类里 `effectiveWeight() <= WEIGHT_FLOOR[kind]`
  且闲置 ≥90 **活跃天**的条目移入 `<shardDir>/_archive.json`（@1195）——不物理删除、不进召回、不参与统计。
- `prune()`（@1136）改成「先归档 → 再走原扩容/淘汰逻辑 → 被挤出上限的条目也进归档簿（reason=over-limit）」；
  归档簿走加密信封 + `.tmp` 原子 rename，和分片同一套落盘纪律。
- 归档簿坏掉**只 warn**、不修改原文件、条目留在热池（宁可不归档，不能丢数据）；
  `status()` 加 `archiveCount` / `archived`（@1022-1023）。

**3. P1-4：周聚合 + missing 补漏**

- 新增 `weekKeyOf`（周键 = 那周周一日期，@1913）、`weekLabelOf`（@1921）、
  `eventBuckets`（桶键优先级 `qq:<号>` > `who:<名>` > `global`，@1345）、
  `summarizeWeek(weekKey)`（@1383）、`missingWeeks({lookback:2})`（@1484）。
- 摘要条：`kind=event`、`level=2`、`weight=8`、`source=system`，带 `weekSummaryFor` + `groupKey`，
  正文形如「10-12~10-18：某群聊了 18 件事，主要是 …」；被覆盖的原始事件 `level = min(3, level+1)`。
- 四条例外口径：**当前周不补**（没结束的周补了就是错账）；摘要**不走 `add()`**（不污染活跃天、不参与去重/冲突判定）；
  补漏失败只 warn、不阻断启动；按「周 + 群」判缺（同一个周不同群各自一张摘要）。
- 挂载：`lib/engine.js` `init()` 里 `await this.restoreGroupfunRooms()` 之后**只加 7 行** try/catch
  调 `this.memory.missingWeeks()`（@914-920）。

**4. P2-5：压缩标记（向后兼容硬要求）**

- `add()` 新增可选 `messageId`（@785）：**给了才写** `entry.messageId`（@862），老条目零改动。
- `summarizeWeek()` 把 `coveredUntil` 同时写到被覆盖的原始 event 和新摘要条（@1430-1455）：
  优先用真消息号按数值比大小，没有消息号则退回最后条目 id 兜底。
- `index.json` 新增 `lastCompactionAt`，构造（@414）/ `load()`（@547-548）/ `writeIndex()`（@500）/
  `status()`（@1025）全链路透传，**只有周聚合会推进它**（@1461）。
- 兼容：老 index 缺字段当 0 且 `load()` **不回写**（老文件字节一致）；老 event **不凭空补** `coveredUntil`；
  压缩写回时保留 `version / account / kinds / total / activeDays / activeDayKey / savedAt`。

**5. 新增工程资产**

- `docs/AI-CODE.md`：给接手的 AI 看的规则 SSOT（10 节），每条规则带 `[版本或日期｜出处行号]` 锚点。
- 六个门禁脚本（`${MOLLY_ROOT}\out\`）：既有 `_memory_{rrf,dedup,v2}_check.mjs`，本批新增
  `_memory_{archive,week,compact}_check.mjs`。

**验证（全量重跑，均 exit=0）**

- 六测全绿：`_memory_rrf_check.mjs` 25/25、`_memory_dedup_check.mjs` 27/27、`_memory_v2_check.mjs` 25/25、
  `_memory_archive_check.mjs` 20/20、`_memory_week_check.mjs` 17/17、`_memory_compact_check.mjs` 18/18。
- `tools/memory-test3.mjs` **13/14**（老基线 12/14）。唯一失败是「咖啡」→「美式」纯词面不可达，
  **已知限制＝不做同义词扩展**，不是本批引入的回归。
- 线上 HTTP 契约 `out/_memory_api_probe.mjs` **16/16 ALL PASS**；`lib/` 下 49 个 js 全部 `node --check` 通过。

**部署（只同步两个真有差异的文件，不升版本号）**

- 目标 `${HOME}\.dsh\profiles\desktop\node_modules\dsh-qq-whale\lib\`，部署后 SHA-256 与源目录逐字节相同：
  `memory.js` `<REDACTED>`（95771 B）、
  `engine.js` `<REDACTED>`（311978 B）。
- 被替换的旧文件备份在 `out/_deploy_backup_20261027_1302/`（memory.js 70188 B / engine.js 311591 B）。
- `plugin_manager` 关开 `include:dsh-qq-whale`：**发现上一轮会话死在关开中间，插件一直处于 disabled**（这就是当时
  「改了没生效」的原因），关开一次即恢复。

**线上验收（`GET http://127.0.0.1:4739/dsh-qq-whale/state` 返回 200，实测）**

- `memory.name="茉莉花"`、`count=1535`、`limit=baseLimit=maxLimit=50000`、`encrypted=true`、`keySource=file`、
  **`broken:false`**、`archiveCount=0`、`lastCompactionAt` 已推进。
- `shards={person:134, address:7, promise:114, fact:641, preference:35, event:97, meme:507}`，合计 **1535 = count**。
- `index.json`（339 B）七类与 `total` 对得上，`version/account/kinds/total/activeDays/activeDayKey/savedAt` 老键全保留。
- 首启周聚合**真的跑了**：`event` 94 → 97（+3 条摘要）；`/memory/list` 里 92 条带 `coveredUntil`、3 条带 `weekSummaryFor`。

**退回**

- 部署侧：把 `out/_deploy_backup_20261027_1302/` 里两个文件拷回部署目录 → `plugin_manager` 关开一次。
- 数据侧：`_archive.json` 不需要时可直接删（缺失当空，归档条目不会回到热池）；`index.json` 的
  `lastCompactionAt` 缺失当 0，删了不影响加载。
- 源码侧没有自动反算：本批改动**不升版本号、不提交发布仓**，回滚由发布流程负责人处理（改前两个文件即上面那份备份）。

---

## 2026-10-27 · 运维补丁：DSH 开机自启 + 控制台数据服务自愈（未升版本号）

> 主人 m00682：「检查为什么我电脑重启没有自动拉起Molly，她现在没法说话」

**根因（两条）**

1. **没人拉起 DeepSeek Harness 本体**。重启后 22:00 计划任务 `SnowLuma-Boot` 把 QQ/NapCat 拉起来了，
   22:02 QQ 自动登录，22:08:18 的 DSH 父进程却是 `explorer.exe`——是手动双击开的，不是自启。
   启动夹、`HKCU/HKLM\...\Run`、`StartupApproved` 全查过，**没有任何一项负责 DSH**；
   `Molly-Watchdog` 只看 NapCat 的 `phase=online`（QQ 登录了就算"一切正常"），所以整段时间它认为没事。
   结果：22:00–22:08 她有耳朵没脑子，之后 SnowLuma 的入站推送其实也断了（22:02 那条 `login history sync disabled`
   之后再无 `[Event]`），群里全是人说话她一条不回。
2. **控制台的数据服务不会自己起来**。`panel-data.mjs`（19391）没启动时，看板整屏「数据服务 19391 不可达」。

**改动**

- 新增 `tools/start-dsh.ps1`（102 行，UTF-8 BOM）：查 `DeepSeek Harness` 进程，在跑就记一行日志跳过；
  没跑就 `Start-Process` 拉起，**管理员身份下经 `explorer.exe` 中转以普通权限启动**（否则 DSH 会比手动双击多一层提权，
  和部署文档不一致）；最多等 30 秒确认进程出现，日志写 `out/start-dsh.log`（超 512 KB 滚动）。
- 新计划任务 `Molly-DSH`：登录触发、延迟 30 秒、交互式 + 非提权（与已知可用的 `Molly-Console` 同形）、
  `MultipleInstances=IgnoreNew`、`ExecutionTimeLimit=PT0S`；动作用参数 `-WaitSeconds 30`。
- `tools/watchdog.mjs` 新增 `ensureDsh()` 兜底：**连续两轮查不到进程**才拉起（3 分钟冷却，防拉起后被重复拉）；
  进程在就只探 `/dsh-qq-whale/state`，端点不通只记日志**绝不重启活着的 DSH**（缓存的旧端口会误杀）。
- `tools/build-publish.mjs` 白名单补 `tools/start-dsh.ps1`（否则发布版里 watchdog 会 exec 一个不存在的脚本）。
- `tools/console-server.mjs` 新增 `ensureSidecar()`：控制台发现 19391 不可达时自己补一个 `panel-data.mjs`，
  30 秒内最多一次，失败只记日志不影响只读接口。

**验证**

- `start-dsh.ps1` 空跑 exit 0，日志「已在运行（8 个进程：…），跳过」；`Parser::ParseFile` 语法 OK。
- `Molly-DSH` 实测 `LastTaskResult=0`；`watchdog.mjs --once` exit 0，`watchdog-state.json` 出现
  `dshFails=0 / dshEndpointFails=0 / lastDshAt`，`Molly-Watchdog` 每分钟照跑 `LastTaskResult=0`，没有多余拉起。
- 链路恢复：23:38:10 用 `SnowLuma-Relogin`（= `snowluma-start.ps1 -QQOnly`，只温和重启 QQ 不动 SnowLuma 进程，
  避免设备指纹变化逼人重新扫码）重挂后，23:38:42 起恢复收消息，23:39:37 她在 109 群正常回话。

**退回**

```powershell
Unregister-ScheduledTask -TaskName Molly-DSH -Confirm:$false   # 去掉自启
```
代码侧：`git checkout -- tools/watchdog.mjs tools/console-server.mjs tools/build-publish.mjs` 并删掉 `tools/start-dsh.ps1`。

---

## 2026-10-27 · 同群双泳道 + 发送串行 + 模型并发闸门（方案 A，未升版本号）

> 主人 m02421：「不能多加几条链路能同时处理多条吗」
> 主人 m02427：「A」

**根因（子房连 @ 三次不回，查日志查出来的）**

09:34–09:42 那八分钟，群 666666666 进站 **91 条**，她只发了 18 条。子房有礼了
09:35:14「查看一下」、09:37:11「申请查看亲密度」、09:38:22「molly不理我」，
三次 @ 全被晾着，直到 09:41:43 才回「宝宝我在呢，刚跟一桌人抢锅底躲不开」。

不是模型挂了（那段时间每条都是正常 `delivered`，16–30 秒一条），也不是新加的
「回不过来就兜底」那条路（`/state.stats.modelDownLines` 当时是 4，但都不在这段）。
真凶是 `lib/engine.js` 里那句：

```js
if (existing?.phase === 'thinking') { existing.controller.abort() }
```

`this.jobs` 的 key 是 `conv.key`，**一个群只有一个 job**。她在思考时来了新消息，
就把手里这轮「作废重来」、改用最新那条——群里刷起来的时候，谁先 @ 谁被后面
的人顶掉，@ 得越勤越排不上。

**改动**

1. **同群双泳道**（`lib/engine.js`）：job key 从 `conv.key` 改成
   `conv.key\u0000lane`，分 `targeted`（@我 / 回我 / 私聊）与 `ambient`（群友闲聊）。
   ambient 内部照旧「新的顶掉旧的」；targeted 只被更新的 targeted 顶掉，
   不再被围观消息打断。跨群、群与私聊本来就是并行的（key 里带群号/QQ），没动。
2. **发送串行**：新方法 `serialSend(convKey, fn)`。两条道可以并行生成，但
   `deliver` 排队——否则两条回复交叉发出，QQ 的引用框会挂到对方那条上
   （2026-10-25「回复挂错人」就是这类事故）。锁的粒度按会话，不按全局。
3. **模型并发闸门**：新方法 `modelSlot(signal)` / `releaseModelSlot()`，
   `callModel()` 外面包一层，原逻辑改名 `callModelUnlocked()`。上限读新配置
   `modelConcurrency`（默认 **3**）。理由：免费 intl flash 并发一高就空回，
   当天已经连吃 4 次；排队中被撤回中止会立刻出队，不占坑。
4. **配套的小修**：
   - 群名片「正在想」还原前先看 `otherLaneThinking()`——不然 ambient 先回完就撤，
     targeted 还在打字，群里看着是「名片没闪却突然冒话」；
   - 撤回消息时的队列清理从取单个 job 改成 `jobsOf()` 遍历所有泳道
     （只清一条，另一条还会把被撤回的内容说出来）；
   - 撤回后的「轻回」让路判断改 `hasJobs()`；
   - `/state.parallel` 新增实时水位：`{jobs, lanes, model:{limit,active,waiting}}`。
     **要不要继续上真并发（方案 B）就看这两个数**：lanes 长期是 2 说明同群确实在并行；
     model.waiting 长期 > 0 说明闸门在排队、免费 flash 已经吃不住，这时候不该再加。

**验证**

- `${MOLLY_ROOT}\out\_parallel_lane_check.mjs` **44/44**：泳道归属（含「群号前缀相同不串味」
  的 666666666 vs 6666666661）、同一会话串行且不同会话互不阻塞、前一条抛错不卡死
  后面、并发上限与排队、排队中被 abort 立刻出队不占坑、已 abort 的 signal 不排队，
  外加 12 条源码接线断言（防止只改一半）。
- `node --check` engine.js / web.js / main.js 全 exit 0。
- 部署 SHA256 一致（engine `598D5466`、web `96BC4FDE`、main `0A200B05`），
  `plugin_manager set_plugin include:dsh-qq-whale` 关→开重载一次。
- 重载后 `/state`：`link=online`、`model.ok=true`、`missing/failed` 空、
  `parallel={"jobs":1,"lanes":["group:666666666|ambient"],"model":{"limit":3,"active":1,"waiting":0}}`。

**退回**

```bash
git checkout -- plugin/dsh-qq-whale/lib/engine.js plugin/dsh-qq-whale/lib/web.js plugin/dsh-qq-whale/lib/main.js
```

只想关掉双泳道、保留其余修复：把 `engine.js` 里的 `lane`/`jobId` 两行改回
`const existing = this.jobs.get(key)` 与 `this.jobs.set(key, job)` 即可——
但那样会丢掉「同群并行」，子房那种连续 @ 被顶掉的老毛病会回来。
只想压并发不拆泳道：配 `modelConcurrency: 1`（等于完全串行）。

---

## 2026-10-27 · 取消「回不过来就不回」：模型链全挂时说一句兜底（未升版本号）

> 主人 m02307：「还是取消回不过来就不回的机制吧」

**根因（三条静默路径，都在 `lib/engine.js` 的 `generate()` / `scheduleReply()` 里）**

1. `generate()` 的 `if (!res)`：主脑、备用脑、trae 全没接住（429 重试用尽、网关 5xx、非限流错误直接放弃）→ 直接 `return null`。
2. `generate()` 的 `if (parts.length === 0)`：模型回了空正文（带图轮次里思考 token 把输出预算吃光是典型，日志原文「模型返回空内容，沉默」）→ `return null`。
3. `scheduleReply()` 的 `catch (err)`：整条流程抛错（模型客户端炸了、解析炸了）→ 只写日志，什么都不发。

三条的共同后果：调用方把 `null` 当成「这轮没话可说」，用户看到的是**已读不回 / 像掉线**。

**改动**

- `lib/engine-text.js` 新增 `modelDownLine(rand)`：四句符合人设的短台词（「等等，我刚刚走神了，你再说一遍？」「脑子卡了一下——刚那句我没接住」等），**不解释技术原因**。
- `lib/engine.js` 新增 `modelDownReply(convKey, { reason })`：把台词包成正常回复对象（`parts/raw/degraded/backend:'model-down-line'/fallbackLine:true`），走原有 `deliver()`，所以历史、节流、打字延迟全部照旧。
  - 两个刹车：`silentOnModelFail: true` 退回旧的沉默行为；`modelDownNoticeGapMs`（默认 **90000** 毫秒）保证同一个会话 90 秒内只提醒一次——否则模型挂掉的十分钟会把群里刷满「我卡了一下」。
- 三条静默路径全部改掉：`model-null` / `empty-parts` / `threw`。`stats.modelDownLines` 计数，`/state.stats` 直接能看。

**验证**

- `${MOLLY_ROOT}\out\_model_down_check.mjs` **24/24**：台词池、出话、90 秒节流、跨会话不干扰、`silentOnModelFail` 总开关、`gap=0` 不节流、`splitReply` 空时返回 null 不抛，以及源码里三条路径都已替换、旧文案已删。
- `node --check` 两个文件 exit 0；部署到 `${HOME}\.dsh\profiles\desktop\node_modules\dsh-qq-whale\lib\`（engine `A07FF4C4`、engine-text `C4C07487`）后关开重载，新快照 `gen-mvq1g81y-tbwrkb` 里能 grep 到 `export function modelDownLine`，`/state.stats.modelDownLines=0`。

**退回**

```powershell
cd ${MOLLY_ROOT}\qq-whale
git checkout -- plugin/dsh-qq-whale/lib/engine.js plugin/dsh-qq-whale/lib/engine-text.js
```
或临时把配置改成 `silentOnModelFail: true`（不改代码就退回沉默，但保留计数）。

---

## 2026-10-27 · 记忆体系改造：分账号七类 + 阶梯衰减 + 命中记账 + 写入闸门 + 检索预算（未升版本号）

> 主人 m01748：「可以，我还有几个想法你考虑一下：1.模拟艾宾浩斯来逐渐降低权重，按照小数点级下降，但是有下限 2.记忆分账号再分七类储存」
> 主人 m01812：「建议不要完全按照艾宾浩斯的天数曲线」→ 最终选「每 7 个活跃天掉 0.5」的阶梯，不是日历天指数曲线。

**为什么改（四个根因）**：

1. 一个 `memory.json` 混着 8 种 kind，但尺子只有一把：表情包和「他住广州」抢同一个上下文窗口，
   还共用同一套权重下限——「梗」本该烂得比「事实」快。
2. 只有 base weight，没有时间维度：三个月没人问过的 `w10` 和今早刚记的 `w10` 一样重，等于「记了就不会忘」。
3. 没有命中计数：靠印象判断「这条常不常用」必然系统性偏向遗忘（第 2 篇文章原话：「命中必须有账」）。
4. 助手自己接话编出来的事能写成事实；检索也没有字数上限，长条目能把窗口吃光。

**改动**：

- **分账号 + 七类分片**：落 `<memoryDir>/<机器人QQ>/<kind>.json`，另有 `index.json` 记条数与活跃天。
  七类是 `person`（人物）/`address`（称谓）/`promise`（约定）/`fact`（事实）/`preference`（偏好）/`event`（事件）/`meme`（梗与表情）；
  老 kind 走别名表 `KIND_ALIASES`：`work → event`、`sticker → meme`，读取时自动折算，不丢数据。
- **老数据自动迁移**：启动时没有 `index.json` 就按老布局读 `memory.json`（明文或整池密文都行），
  读完立刻按七类写分片，再把老文件改名成 `_legacy-memory.json` 留底（不删）。
- **阶梯衰减（活跃天制）**：只有「这一天真的聊过天」才 `activeDays + 1`（`touchActivity()`），
  关机/停机不算时间。有效权重 = `base − floor((闲置活跃天 − 宽限) / 7) × 0.5`，夹在每类下限
  （约定 5 / 人物 4 / 事实·偏好 3 / 事件·梗 1），称谓恒 10。
  **只在读取时算、永不写回盘**——盘上只有事实（base、hits、lastActiveDay），衰减是看法，所以没有复利 bug、不需要定时任务。
- **命中记账**：`recall()` 真正返回给模型的那几条才 `hits+1`、刷新 `lastHitAt`/`lastActiveDay`（相当于复习一次，重新计时）；
  称谓不记账（每轮无条件注入，记了必然刷满）。一轮对话里多次召回，5 秒内只落一次盘。
- **写入闸门**：条目带 `source`（`user`/`assistant`/`system`），**助手自述不许写成 `fact`/`person`**，
  只许 `preference`/`event`/`meme`——挡住「她自己编的经历三天后变成事实」这种污染。
- **检索预算 + 压缩等级**：`charBudget` 三档 800/1200/1600（small/balanced/large），只决定收哪几条、不改写正文，至少留一条；
  条目新增 `level`（0 原句 / 1 半句 / 2 一句 / 3 关键词），add/update 都收，检索与 markdown 里会显示 `l0..l3`——
  **只标记不自动压缩**，压正文必须是显式动作，不能悄悄发生在检索里。
- **对外契约**：`/memory/add`、`/memory/update` 的 `kind` 认七类和两个老别名；`weight` 仍是 1–10 一位小数；
  被闸门拒收时返回 400 并说明原因（不是含糊的 500）。

**验证**：

- `${MOLLY_ROOT}\out\_memory_v2_check.mjs` **24/24**：别名归一、宽限 14 天内不掉 / 每 7 天 −0.5 / 掉到下限停、称谓恒 10、
  命中拉回、七类密文分片落盘与读回、老明文（含 work/sticker）自动迁移并归档、老密文路径、活跃天同日只加一次且重启能回来、
  `markHits` 跳过称谓、`applyCharBudget` 边界、`recall` 记账、`prune` 按有效权重淘汰。
- `${MOLLY_ROOT}\out\_memory_api_probe.mjs` **14/14**：`kind=sticker` 折 meme、`kind=work` 折 event、非法 kind 400、`weight=11` 400、
  `weight=6.5` 可写、`assistant + fact` 被闸门 400、`assistant + meme` 允许、`/memory/list` 字段齐、`/state.memory` 的 `shards` 合计等于 `count`。
- **线上迁移实测**：1462 条 → `${MOLLY_ROOT}\data\qq-whale\memory\111111111\` 七片
  （person 127 / address 7 / promise 104 / fact 616 / preference 33 / event 94 / meme 481），`index.json` 与 `/state.memory` 自洽，`broken=false`。

**退回**：

- 代码：`git checkout -- plugin/dsh-qq-whale/lib/memory.js plugin/dsh-qq-whale/lib/engine.js plugin/dsh-qq-whale/lib/web.js console/console.js`，
  再把部署副本 `${HOME}\.dsh\profiles\desktop\node_modules\dsh-qq-whale\lib\` 三个文件拷回去，禁用/启用插件各一次。
- 数据：把 `memory\_legacy-memory.json` 改名回 `memory.json`，删掉 `memory\111111111\` 整个目录。
  **注意**：迁移之后新写的记忆只在分片里，退回会丢这部分（本次迁移到退回之间只有探针写的 1 条，已删）。

---

## 2026-10-27 · 称谓数据两条整改（示例成员F / 甘蓝橘子）

> 主人 m01636：「可以」（同意改这两条）。

**问题**（查「称谓是不是按聊天对象召回」时翻出来的）：

1. `mmvlvdjysnc7f`（qq `987654321` 示例成员F）存的是「他习惯**叫你**「Niki」，要答应」。
   `addressName` 的 `叫你X` 句式把它抽成了 `Niki`，可 Niki 是**示例成员F对她的称呼**，不是她该叫示例成员F的称呼——
   方向反了，于是对示例成员F说话她会先叫一声「Niki」。
2. `mmvlsqejqggf6`（qq `3460113718` 甘蓝橘子）存的是「他**自称**「example-friend」，叫他 example-friend 就行」。
   2026-10-27 新加的「自称/外号整句判废」把它整条拦掉，结果是**召不回**（本意就想要她叫 example-friend）。

**改动**（只动数据，`POST /memory/update`，代码不变）：

- 示例成员F那条：`kind` 改 `fact`，正文改成「示例成员F习惯喊我「Niki」，那是他对我的叫法；不是我要叫他的称呼。」——不含 `叫你/喊你` 句式，不再被当称谓。
- 甘蓝橘子那条：正文改成「他希望你叫他「example-friend」。」，仍是 `kind=address`。

**验证**：`out\_address_verify2.mjs` 用真数据重拼 prompt——示例成员F**没有**「# 怎么称呼」段也没有结尾称谓提示；
甘蓝橘子首行 `- 叫他「example-friend」`、结尾 `这轮开口就要叫对方「example-friend」`；子房有礼了仍是「宝宝」。称谓池从 8 条变 7 条。

**退回**：把这两条按上表原文改回去即可（`kind=address` + 原正文）。

---

## 2026-10-27 · 记忆权重刻度 5 → 10（未升版本号）

> 主人 m01402：「权重等级从 5 改为 10，按比例改动现有记忆权重，运行小数点后一位」；
> 主人 m01449 补充：「称谓记忆依旧是最高，10」。

### 改动

1. 刻度从 1..5（整数）改成 **1..10（可一位小数）**，老数据整体 **×2**（等比：老默认 3→6、老最高 5→10、老最低 1→2）。
2. 三处同时等比，保证排序结果与改前完全等价：
   - **数据** ×2（1439 条全量迁移）；
   - **代码默认值** ×2（`memory.js` 的 `WEIGHT_DEFAULT = 6`、`web.js` 的 `/memory/add` 默认值、`engine.js` 里 14 处写死的 `weight: 2/3/4` → `4/6/8`）；
   - **召回打分系数** `0.3 → 0.15`（`memory.js` 里 `s += clampWeight(e.weight) * 0.15`）。
     只改上限不动系数的话，所有老条目会凭空重一倍；只改数据不动系数的话，分数整体翻倍会盖过关键词命中。
3. **称谓（kind=address）一律钉死 10**：`add()` / `update()` 里强制 `weight = WEIGHT_MAX`。
   称谓不参与普通召回、每轮无条件注入，权重只用来决定「同一个人多条称谓谁排第一行」，所以永远给它最高档。
4. 新增导出 `WEIGHT_MIN / WEIGHT_MAX / WEIGHT_DEFAULT / clampWeight()`，`web.js`、`console.js` 统一走它，
   校验口径：**1..10 的数字，最多一位小数**（服务端 `parseWeight` 与前端表单提示一致）。
5. 控制台表单：`权重（1–10，一位小数，越高越常被想起）`，`min=1 max=10 step=0.1`，默认值 6。

### 验证

- `lib/{clock,memory,engine-context,engine,web}.js` 全部 `node --check` 通过。
- 部署快照 `gen-mvpzlwx3-xyw857` 里 `WEIGHT_MAX`×6、`clampWeight`×8、`1~10`×3 均在位；插件已关→开重载（`reloadAt=1793063325979`）。
- `out\_scale_weights_verify.mjs` **8/8**：`clampWeight` 边界（0→1、11→10、3.14→3.1、6.04→6、NaN→6）、1439 条权重全在 1..10 且最多一位小数、8 条称谓全部 10。
- 迁移后分布：`address/w10×8  fact/w6×586  fact/w8×5  fact/w10×3  meme/w6×6  person/w6×111  person/w8×11  person/w10×4  preference/w6×21  preference/w8×12  promise/w6×102  promise/w10×1  sticker/w4×469  work/w6×94`。
- 迁移脚本自带防呆：`out\_scale_weights_data.done.json` 落了章，再跑 `--apply` 会直接 exit 2（要重来必须 `--force`）。

### 退回

- 代码：`git checkout -- plugin/dsh-qq-whale/lib/{memory,web,engine}.js console/console.js`。
- 数据：把 1439 条权重 ÷2（称谓回到 5），再把 `memory.js` 的 `WEIGHT_DEFAULT` 改回 3、打分系数改回 `0.3`。
  没有自动回滚脚本——**回滚前先备份 `data/qq-whale/memory/memory.json`**。

---

## 2026-10-27 · 认人/报时/夜间语气：三条现场投诉的补丁（未升版本号）

> 主人 m01226：「做完的时候，molly 1.不叫 子房有礼了 宝宝，还把 mndnbd 认成茶茶
> 2.问她时间回答的不是北京时间 3.感觉鱼崽们晚上会一直吵着睡觉很不耐烦」。

三条是三个不同的病，根因分别落在**数据**、**提示词位置**、**提示词措辞**上：

**① 把 333333333（示例管理员）叫成「茶茶」——数据错，不是模型糊涂**

- 现场：`snowluma-2026-10-27.log` 00:35:04 群里问「我是谁」→ 00:35:36 她答
  「你是茶茶啊，号我记着呢，333333333」；00:38:31 私聊又答「茶茶啊，还能是谁」。
  而茶茶是群里另一个人（`987654321`）。
- 根因：`333333333` 名下**两条 kind=address、权重都是 4**：
  `[10-23 23:46] 他希望你叫他「宝宝」；他喜欢跟你撒娇`
  `[10-25 18:42] 他自称「茶茶」，可以直接叫他茶茶`
  `memory.js:744 addressOf()` 先按 weight、同权重按 at 新→旧，10-25 那条排第一，
  而 `engine-context.js` 的规矩是「同一人多条以第一行为准」。
  `addressName()` 之所以认下它：句子后半截确实写着「可以直接叫他茶茶」，
  它只看句式，看不出前半截的「自称」是"他自己这么叫自己"、不是"你要这么叫他"。
- 改动：
  - `lib/memory.js addressName()`：整句命中 `自称|自封|外号` 就直接判废，不进称谓。
  - 现场数据：把那条降级成 `kind=fact`，文字改成「他开玩笑时会自称「茶茶」，
    那不是要你这样叫他；正经称呼见另一条「宝宝」。」；把「宝宝」那条权重提到 5。
    （走 `POST /memory/update`，没动 memory.json 的其它 1433 条。）

**② 「子房有礼了」不叫宝宝——数据是对的，位置输了**

- 现场：00:36:52 / 00:40:40 她开口都是「子房……」，而他名下明明有一条
  `w=5 他希望你叫他「宝宝」，每次开口就要叫，不用等他提醒`。
- 根因：称谓段在 system prompt 偏前（`engine-context.js:153`），群聊这一轮后面还压着
  记忆/名册/表情包/活动，模型真正照做的是最靠近结尾的指令。
- 改动：`engine-context.js` 在 `# 刚刚你在` 之后新增 `# 开口前再确认` 段（只两行、
  不新增事实），把「这轮要叫对方「X」」和「现在是几点」各念一遍；
  另外 `lib/engine.js` 新增 `addressLabel(qq, who)`，`memberRoster()` 每行末尾
  挂 `（你要叫他「宝宝」）`——把「这个人→这么叫」变成查表，不用她回忆。

**③ 说「快三点」而真实是 0 点半——她在附和群友，不是时钟坏了**

- 现场：00:27:27 大肥鱼说「一点半了」→ 00:27:43 她「老大说得对，都快一点半了」；
  00:29:58 有人喊「快三点了」→ 00:30:21 她「三点就三点」。五分钟里把 0 点报成 3 点。
- 根因：`clockSection()` 只写了「有人问几点就按这个答」，**没写「别人说的点数不算数」**，
  群聊里的错误点数直接盖过那一行。
- 改动：`lib/clock.js clockSection()` 加两条硬规矩——「群里别人说的点数一律不算数」
  和「有人报错了就直接说「才 HH:mm」，别跟着往上加、别附和对对对」。
  结尾的「开口前再确认」也重复一次时间。

**④ 半夜被催睡时不耐烦——「简短」被读成了「冲」**

- 改动：`engine-context.js` 睡眠窗提示后补一句：「有人缠着你睡前讲故事、或者一直催睡：
  可以推掉、可以先溜，但别冲人发火、别甩脸色、别嫌他们烦——困归困，话要软。」

**验证**

- `${MOLLY_ROOT}\out\_molly_fix_check.mjs` 16/16：addressName 新规矩 / addressOf 排序 /
  clockSection 硬规矩 / 结尾段顺序与内容 / 名册称谓后缀。
- `${MOLLY_ROOT}\out\_molly_fix_check_deployed.mjs` 5/5：直接 import **gen 快照目录**
  （`gen-mvpyvhgg-s6pl9u`）里的那份代码跑，证明「加载的不是源码那份副本」也带上了改动。
- 现场核对：`POST /memory/update` 后 `/memory/list` 里 `333333333` 只剩一条 address
  （「宝宝」w=5），`222222222` 仍是 `w=5「主人」`，`888888888` 仍是 `w=5「宝宝」`。
- 生效方式：`plugin_manager set_plugin include:dsh-qq-whale` 关→开（8:48:12 生成新快照），
  `/state` 复核 `link=online`、`model.ok=true`、`plugins.missing/failed` 均为空。

**退回**

- 代码：`git checkout -- plugin/dsh-qq-whale/lib/{clock,memory,engine-context,engine}.js`
  （四个文件），再复制到 `${HOME}\.dsh\profiles\desktop\node_modules\dsh-qq-whale\lib\`。
- 数据：把 `mmvnp8c2da4mw` 改回 `kind=address`、`mmvl56o30joct` 权重改回 4 即可复原
  （改之前的两条原文见上面「根因」）。

---

## 2026-10-26 · v1.1.5-A-Hotfix.1：抽奖房间落盘 + 群里 `#molly` 在线状态修复

> 主人 m00343：「把更新的东西推 v1.1.5A 的第一个热修复」。
> 上一版「已知问题」里那条「抽奖房间存在内存里，插件热重载/进程重启会丢那场」在本版修掉。

**根因（三个）**

1. 抽奖房间只在内存：`groupfun.js` 的 `LotteryBox` 只有 `rooms` Map，插件重载/进程重启后，到点没开的那场连同名单一起消失。
2. 就算加了落盘，补开的发送链路本身也会丢数据：`lib/main.js:1353` 的 `await engine.init()` 跑在 `lib/main.js:1417` `engine.client = client` **之前**，`init()` 里的 `restoreGroupfunRooms()` 对过期场次立即 `sweep()`，此时 `send` 必抛 `TypeError`；而原 `sweep()` 是「先 `rooms.delete` + flush 再发消息」，一抛就把场次和名单永久删光，群里什么都没发。
3. 群里 `#molly` 永远回「离线」：`lib/onebot.js:538` 的 `setState()` 回调的是字符串（`'online'` 等），`lib/main.js:1403` 原样存进 `state.link`；`lib/web.js` 两种形状都兼容，但 `lib/hash-commands.js` 旧代码按对象读 `link.ready` → `'online'.ready === undefined` → 一直落到「没连上」兜底。

**改动**

- `lib/groupfun.js`：新增 `hydrate(records,{config})` / `snapshot()` / `flush()` —— 房间可序列化并从盘上恢复，未到期重挂 `setTimeout`，已过期进 `expired` 交给 `restoreGroupfunRooms()` 补开；本文件不碰 fs，快照通过注入的 `save` 回调交出去。
- `lib/groupfun.js`：`draw({gid, by, config, keep:true})` 只算结果、不删场次也不 flush；`sweep()` 改成「发送成功才 `rooms.delete` + flush」，失败走新增的 `requeue()`（塞回 `rooms`、`endsAt = now + lotteryAnnounceRetryMs`、重挂定时器、flush），上限 `lotteryAnnounceRetries`（默认 8）次后放弃并记 `lastRequeue.giveUp`。
- `lib/groupfun.js`：`sweep()` 加 `room.announcing` 互斥标志，防补发定时器与 15 秒心跳撞车重复发公告。
- `lib/engine.js`：`persistGroupfunRooms(rooms)` 写 `<dataDir>/out/lottery-rooms.json`（`{version:1, savedAt, rooms}`，先写 `.tmp` 再 rename）；`restoreGroupfunRooms()` 读盘 → `hydrate` → 对 `expired` 调 `sweep()`；`init()` 在心跳起来之后调它。
- `lib/main.js`：卸载钩子里补 `stopGroupfunHeartbeat?.()` 与 `groupfun?.dispose?.()`，不再留僵尸定时器。
- `lib/hash-commands.js`：新增 `linkInfo()` / `linkWords()`，把字符串与对象两种链路形状归一；中文映射 online → 在线、connecting / handshaking → 连接中、reconnecting → 断线重连中、stopped → 已停止。
- `lib/web.js`：`/state.groupfun` 多暴露 `requeue`（最近一次补发失败/放弃的原因）。
- `tools/console-server.mjs`：`FALLBACK_VERSION` 跟到 `1.1.5-A-Hotfix.1`。

**验证**

- `out/_lottery_persist_check.mjs` 21/21：`LotteryBox` 的序列化 / 恢复 / 过期判定（`save` 是桩）。
- `out/_lottery_engine_io_check.mjs` 60/60：真打 `ChatEngine.prototype.persistGroupfunRooms` / `restoreGroupfunRooms`，临时目录真文件 I/O；覆盖盘上文件不存在 / 坏 JSON / 脏记录、启动顺序下 `send` 抛错 → 重试成功且**只发一条**、并发 `sweep()` 只发一条、心跳 start/stop 无僵尸、`dispose()` 不写盘。
- `out/_hash_link_status_check.mjs` 39/39：含端到端 `createHashHandler(...).handle(ev)` 群分支，实际回复 `Molly 1.1.5-A · 在线 · 运行 2 小时`。
- 线上 `http://127.0.0.1:14749/dsh-qq-whale/state` 实测 `link.ready=true`、`link.state='online'`、`model.ok=true`。
- 线上数据清理：`data/qq-whale/out/lottery-rooms.json` 里有一条测试残留假场次（`gid=999999999` / `keyword=自测`，已过期），备份为 `lottery-rooms.json.bak-testroom-20261026-1925` 后清空 —— 否则下次重载会去一个不存在的群发假开奖。

**发布**

- GitHub Release [v1.1.5-A-Hotfix.1](https://github.com/3150481853/molly-qq-whale/releases/tag/v1.1.5-A-Hotfix.1)（**#424182053**，`latest`），tag → `75cf38f`，附件 `molly-qq-whale-v1.1.5-A-Hotfix.1.zip` 1,317,133 B / 177 文件，sha256 `<REDACTED>`；本版**不含语音包**（音色包仍单独发 `voice-pack-v1.2`）。
- 下载实测：解包 177 文件，包内 `plugin/dsh-qq-whale/package.json` = `1.1.5-A-Hotfix.1`，`lib/hash-commands.js` 含 `linkWords`，`lib/groupfun.js` 含 `requeue`；正文「本版特性」7 条与「内置状态指令」都在。
- 打包注意：必须在**源仓库**跑 `node tools/release-assets.mjs --tags <tag>`（cwd = `qq-whale`）—— 从发布目录跑会读不到 `tools/release-assets.secrets.json`，隐私扫描退化成只用通用规则，本次实测该名单命中 7 处 / 5 文件。

**踩坑（别重犯）**

- `tools/release-assets.mjs` 是**脚本本体，不是库**：一旦 `import()` 它就等于跑了一遍 CLI。本次为了核对 `RELEASE_FEATURES` 键写了 `import('./tools/release-assets.mjs')`，结果它在没带 `--tags` 的情况下把 22 个 tag 全走了一遍，重建重传了 `v1.1.5-A` / `Hotfix.2` / `Hotfix.3` 三个**已发布**附件（内容不变、zip 字节变、sha256 变，正文被自动同步）；另外 19 个 tag 因 `#molly` 回填校验不过被拒，未受影响。
- 以后核对常量只用 `grep` / 正则读源码；真要试跑一律带 `--tags <某一个>` + `--dry-run`。

**退回**

- 回滚 `lib/groupfun.js` / `lib/engine.js` / `lib/main.js` / `lib/web.js` / `lib/hash-commands.js` 到 `v1.1.5-A`；再删掉 `<dataDir>/out/lottery-rooms.json`，即回到「房间只在内存」的旧行为（已存的场次会丢，属预期）。
- 只想退回 `#molly` 的显示：把 `linkWords()` 换回原来的 `link.ready ? … : '没连上'`。

## 2026-10-26 · v1.1.5-A 正式版（方案 A：`1.1.5-preview.3` 基线 + 全套补丁）

> 主人 m03287「整理一下 1.1.3 后的版本更新，准备发布 1.1.5 A正式版」。
> 为什么是「A」：原 `v1.1.5`（全量合并版）与 `v1.1.5-Hotfix.1` 因**称谓读取 bug**（把「他希望你叫他「什」」这类反问残句当硬称谓）已于 2026-10-26 **撤回**，GitHub 上连 tag 一起删了。当时给主人两条路，主人选了方案 A：**不把 1.1.5 那 32 个文件的改动整体搬回来**，改为在已被真机跑过的 `1.1.5-preview.3` 基线上，只补「认人 / 命令通道 / 稳定性」三类。
> 基线：`v1.1.5-preview.3`（`b90407c`，lib 48 个 js）+ 本会话全部补丁，共 49 个 js（新增 `hash-commands.js`）。

### 相对 1.1.3 正式版的全部改动

**看得见 / 聊得顺**

- 控制台数据补齐 + QQ 页合并（preview.1）：模型、额度、并发、记忆等页面数据更全，QQ 相关页面合到一处。
- GIF / 动图理解（preview.2）：按帧采样拼图送多模态模型，带图轮次单独放宽输出预算（`imageMaxTokens` / `imageReasoningEffort`）。
- 北京时间与作息（preview.3）：不依赖系统时区；新增作息窗口（夜间不主动），GIF 表情库重扫脚本。

**群趣味**

- 抽奖 + 新人自动欢迎 + 统一入口 `@我 #`（plus.1 / plus.2）。
- 自动开奖计数、新人入群通知（Hotfix.3 的两个修复，本版按 preview.3 重新实现：`groupfun.onDraw` 回调 + 所有 notice 统一交给 `engine.onNotice`）。
- 抽奖 `@` 段发不出去（plus.3 的修复，本版重新实现）：`{type:'at', data:{qq}}` → `{type:'at', qq}`，并把开奖兜底做成 `sweep()` + 15 秒心跳，定时器丢了也能补开。
- **抽奖时长上限 600 秒 → 3600 秒**，支持「1 小时 / 2 小时 / 90 分钟」写法（超出仍夹到 1 小时）。

**认人与称呼（本版的核心）**

- 记忆新增「称谓」类 `address`：按 QQ 匹配、每轮单独成段注入，不吃记忆权重窗口。
- **权重优先**：同一人有多条称谓时按 `weight` 排序再按时间，不再「谁后说的谁赢」。
- **防泛称硬禁**：提示词明确「不许把谁都叫成『主人』」「不许用哥们儿/兄弟/群友/老铁这类泛称——那等于没认出他」。
- 群里人多时注入「这会儿群里人多」段：只接最近那一条、接不过来就直说跟不上，避免一条回复塞好几个人。
- **引用精确化**：引用框锁定她真正在回的那个人（模型点名 → 上一句 → 触发消息三级回退），不再固定挂最后一条。

**命令**

- 私聊 `#` 菜单（`hash-commands.js`）：`#` / `#状态` / `#记忆 关键词` / `#谁 名字或QQ` / `#开关`，不走模型、不花额度；陌生人只回一句人话。
- 群里 `#molly` 一行摘要（版本 · 在不在线 · 运行时长），**任何人可触发，同群 30 秒一条**；群里 `#状态` 不响应，私聊才给详情。

**语音**

- 念稿中文规范化（英文腔修复）：`2K 60Hz` → `两K 六十赫兹`、`28℃` → `二十八摄氏度`、`40%` → `百分之四十`，只改念出来的词。
- 本版**不启用** `voiceSpeed 0.93` + 句间停顿（v1.1.5 引入后听感变差，按主人要求回到 1.0 整段合成）；语音缓存键已改，避免复用旧参数渲染的音频。

**部署可移植性（重点）**

- 无 G 盘也能启动：`memoryKeyFile`、`workSandboxDir`、`voiceRefAudio`、`voiceAsrModelDir`、boot-health、三个 Python 路径、`work-guard` 护栏全部改成「从 `dataDir` 推导 + 配置可覆盖」，`lib` 里只剩 `memcrypt.js` 一条 legacy 兜底字面量。
- 密钥按目录找：`<dataDir 同级>/qq-whale-keys/memory.key` → `<dataDir>/memory.key` → legacy；**盘上是密文但没有钥匙时置 `broken` 并拒绝写回**，不再明文覆盖。
- **看板数据服务随包走**：补上 `tools/panel-data.mjs` + `tools/resolve-paths.mjs`（之前白名单漏了，新部署一开控制台就是「数据服务 19391 不可达」）。
- 控制台/启动脚本不再写死作者机路径：`console-server.mjs` 的 `ROOT` 按脚本位置推导、`DATA` 按 `MOLLY_DATA_DIR` > 配置 `dataDir` > `~/.dsh/qq-whale` 解析；`start-molly.ps1` 的 node 路径按 `MOLLY_NODE` > PATH 找。

**数据侧（本机，不进代码）**

- 记忆池 1329 → 1301 条：清 26 条脏数据（引用残留 / 问句当事实 / 串号 / 截断句 / 无「叫他」的假称谓），删 3 处 `relations` 里的「他希望你叫他「什」」。
- 关系簿 42 → 16 条印象（按主人逐条勾选）；「熊文浩 / 陈淇涠」两处真名按主人要求替换为「熊老板 / 涠老板」。

### 不包含

- **唱歌**：`singingEnabled` 保持 `false`，代码与配置保留，整体排期 `1.1.6-preview.1`。
- **`status-command.js` 版的 `#molly`**：与 `hash-commands.js` 会抢同一个触发词，只保留后者。
- **1.1.5 的语音 0.93 + 句间停顿**：见上。

### 已撤回（不提供下载）

- `v1.1.5`（Release #423843992）与 `v1.1.5-Hotfix.1`（#423894508）：称谓读取 bug。

### 已知问题

- 群里人特别多时，她仍可能只回一条（本版是「只接最近那条」，不是逐条引用）——主人已确认这个取舍。
- 抽奖房间存在内存里，插件热重载/进程重启会丢那场（心跳兜底只解决「定时器被吞」，解决不了进程重启）。

**发布**：GitHub Release [v1.1.5-A](https://github.com/3150481853/molly-qq-whale/releases/tag/v1.1.5-A)（**#424147415**，`latest`），tag → `14bf283`，附件 `molly-qq-whale-v1.1.5-A.zip` 1,306,383 B / 177 文件，sha256 `<REDACTED>`；本版**不含语音包**。

> 附件 sha256 变更说明（2026-10-26T11:42Z）：发 `v1.1.5-A-Hotfix.1` 时误跑了一次不带 `--tags` 的 `tools/release-assets.mjs`，它把 A / Hotfix.2 / Hotfix.3 三个已发布附件按 tag 树重建重传了。**文件清单、文件内容、压缩后大小都没变**（177 文件 / 1,306,383 B），变的只是 zip 容器本身的字节，所以 sha256 从 `a971bf06…` 变成 `4c55afaf…`；release 正文里的 sha256 已被脚本自动同步成新值，与线上附件一致。下载计数被重置为 0。

## 2026-10-26 · v1.1.5-Hotfix.3：部署修复——看板数据服务随包走 + 工具默认路径不再写死作者机

> 部署者反馈（主人转述 m03207）：装完控制台第一屏就是「数据服务 19391 不可达」，记忆/表情/概览三块全空。

**根因**
- 大看板的数据来自 `127.0.0.1:19391` 的 sidecar，实现是 `tools/panel-data.mjs`（`tools/console-server.mjs:130` 默认 `SIDECAR=http://127.0.0.1:19391`，`:1363`/`:1370` 代理 `/api/memory`、`/api/stickers`）。
- 这个文件**从来没进过发布白名单**（`tools/build-publish.mjs` 的白名单是显式列举），所以发布包里根本没有它，任何新部署都起不来 19391。不是部署姿势问题。
- 即使有人手动补上，它内部还写死了作者机的 `${MOLLY_ROOT}\data\qq-whale`，别的机器读不到数据。

**改动**
- `tools/panel-data.mjs`：数据目录按 `MOLLY_DATA_DIR` → DSH 插件配置里的 `dataDir`（`~/.dsh/profiles/*/cordis.patch.yml` 的 `dsh-qq-whale` 项）→ `<用户目录>/.dsh/qq-whale` 的顺序解析；端口支持 `MOLLY_SIDECAR_PORT`；密钥按插件同一套规则找（`MOLLY_MEMORY_KEY_FILE` 可覆盖）。版本 1.0.1。
- `tools/resolve-paths.mjs`（新增）：只读解析 yml 找 `dataDir`，同时给 console-server 复用，避免两处写法漂移。
- `tools/console-server.mjs`：`ROOT` 默认改为按脚本位置推导（源码模式 `<root>/tools/..`），`DATA` 默认走同一套推导；两者仍可被 `MOLLY_ROOT` / `MOLLY_DATA_DIR` / `console.json` 覆盖。
- `tools/start-molly.ps1`：启动 19391 时不再写死作者机 node 绝对路径（`MOLLY_NODE` → PATH → 历史路径兜底）；dataDir 交给 panel-data 自己解析。
- `tools/build-publish.mjs`：白名单新增 `tools/panel-data.mjs` 与 `tools/resolve-paths.mjs`，否则下次构建又漏。

**验证**
- `node --check` 全过；本机不带任何 `MOLLY_*` 环境变量起实例，`/api/health` 返回 `dataDir=${MOLLY_ROOT}\data\qq-whale`，`/api/all` → memory 1307 条 / stickers 409 / metrics 10125，与线上一致。
- console-server 在备用端口 19498 起实例：`/api/overview` 里 `sidecar.reachable=true`、`sidecar.memory.count=1307`。

**退回**
- 删掉 `tools/resolve-paths.mjs`、把 `panel-data.mjs`/`console-server.mjs` 的两处默认值改回绝对路径即可；不影响插件本体与线上 Molly。

**同批合入（另一条工作线，主人拍板「一起发」）**：群抽奖时长支持「小时」单位（最长 1 小时）、引用回复策略（人多时才引用，不是每条都带）、开奖回调 `onDraw`。

**补发（2026-10-26 10:5x，同版本重切）**：首次发布只带上了工具链的可移植性，插件本体与语音规范化漏了。这次补齐两项，版本号不变（同一天、同版本、无人下载过旧包）：
- **插件本体路径可移植**：`lib/main.js` 的 `memoryKeyFile` / `workSandboxDir` / `voiceRefAudio` / `voiceAsrPython` / `gifFramesPython` / `singingPython` 默认值全部改为空串，运行期按 `dataDir` 推导（`<dataDir 父目录>/qq-whale-keys/memory.key`、`<dataDir 父目录>/sandbox/qq-work`、`<dataDir>/voice-ref/molly-ref.wav`、`<dataDir>/asr/models`）；`lib/boot.js` 的健康文件回退目录改为 `MOLLY_DATA_DIR` / 包根同级 / cwd 三级；`lib/commands.js` 的沙箱路径与受保护路径改由 `PROTECTED_PREFIXES` 与 `config.workSandboxDir` 生成；`lib/work-guard.js` 的护栏前缀改为「插件包根 + `~/.dsh/profiles` + 存在的宿主工作区」；三个用 Python 的模块（`local-asr.js` / `gif-frames.js` / `singing.js`）解释器默认留空 = 没配就静默跳过；`lib/engine.js` 的兜底目录、`lib/main.js` 的 `main-apply-beat.txt` 诊断落点同样不再写死盘符。整份 `lib` 现在只剩 `memcrypt.js` 的 `DEFAULT_KEY_FILE` 一处字面量（legacy 只读兜底，`resolveKeyFile` 绝不拿它新建）。
- **语音「英文腔」修复回到本版**：`lib/voice.js` 从 v1.1.5 搬回「念稿中文规范化」（`chineseNumber` / `readDigits` / `SPEAK_RULES` / `normalizeSpeakText`），合成前把 `2K 60Hz`、`1080P`、`16GB`、`40%`、`28℃`、`5km`、`12ms` 这类写法念成中文；`cleanVoiceText` 之后接 `normalizeSpeakText` 再截断。
- 验证：`node --check` 全 49 个 js 通过；称谓解析 15/15、`#` 命令 39/0、密钥定位 10/0、抽奖开奖 8/0、群趣兜底 15/0、引用精确 11/0；新写 `${MOLLY_ROOT}\out\_portability_check.mjs` 9/0（换到没有 G 盘的假数据目录时不选 G 盘、受保护前缀跟着包根走）；真机热重载 `gen-mvp538ln-ks4bre` 后 `link=online`、`memory=1313`、`broken=false`、`keySource=file`、`voice=sovits`、`plugins` 9 个全加载、`groupfun.lastTick` 在跳。

**版本**：`1.1.5-Hotfix.3`（不含语音包；语音包仍用 `voice-pack-v1.2`）。

**发布**：GitHub Release [v1.1.5-Hotfix.3](https://github.com/3150481853/molly-qq-whale/releases/tag/v1.1.5-Hotfix.3)（#424138530，tag → `fd82f1c`），附件 `molly-qq-whale-v1.1.5-Hotfix.3.zip` 1,305,885 B / 177 文件，sha256 `<REDACTED>`。
> 同版本重切过两次：#424127469（10:45，1,300,624 B，sha256 `bb09e620…`）漏了本版补发的两处修复，已删除；重切后旧 tag `b7dab06`/`d80c8c6` 一并作废。

---

---

## 2026-10-26 · v1.1.5-Hotfix.2：撤回坏版本 + 认人修复 + 私聊 `#` 菜单 + 密钥按目录找

> 主人 m01716：「先撤回github的1.1.5和其hotfix（两个有问题的版本），然后发布1.1.5-Hotfix.2」。

**撤回**
- GitHub 上 `v1.1.5`（id 423843992）与 `v1.1.5-Hotfix.1`（id 423894508）两个 Release **连同 tag 一起删除**；提交历史保留，`voice-pack-v1.2` 不动。
- 原因：1.1.5 动记忆时把「称谓」做坏（`他希望你叫他「什」`、自称被当硬要求），Hotfix.1 只加固了解析、没解决真机认错人（15:00 群里把 999999999 叫成「主人」、把主人叫成「群友哥们儿」）。

**回归基线**
- 线上先回退到 `v1.1.5-preview.3`（两份副本：`${MOLLY_ROOT}\qq-whale\plugin\dsh-qq-whale` 与 `${HOME}\.dsh\profiles\desktop\node_modules\dsh-qq-whale`，逐字节比对 `lib` 48 个 js），再在其上叠加本版补丁；回退记录见 `${MOLLY_ROOT}\backup\rollback-20261026\ROLLBACK.md`。

**认人（`lib/memory.js` / `lib/engine-context.js` / `lib/web.js`）**
- 新增 `addressName(text)`：只认 `叫他X` / `叫你X` / `喊(他|你)X` / `称呼|叫法「X」`，单字、疑问词、「一声/一句」这类量词一律丢弃。
- 新增 `MemoryStore.addressOf({ who, qq, limit })`：只取 `kind='address'`、按 QQ 匹配、**按权重新→旧**（同权重再按时间），解析不出名字的不进提示词。
- `buildSystemPrompt()` 在「记忆」之前插 `# 怎么称呼` 段，每条 `- 叫他「X」`；段内加硬禁：群里打闹不许改用「哥们儿/兄弟/群友/老铁」，没记到的用群名片或「你」，别自己编。
- `contextFor()` 把 `address` 从「你记得的事」里排除，避免自称句混进去。
- 控制台 `MEMORY_KINDS` 收 `address`（不再当非法 kind）。

**私聊 `#` 菜单（新文件 `lib/hash-commands.js`，`lib/main.js` 接在 `drop-self` 之后）**
- 命令：`#`（菜单）/ `#状态` / `#记忆 关键词` / `#谁 名字或QQ` / `#开关`；纯文本直出、不进模型、不花额度；非主人只回一句人话并吞掉。
- 群里发 `#molly` 只回一行摘要（版本 · 在不在线 · 运行时长），任何人都能触发、同群 30 秒一条；`#状态` 在群里不回。

**记忆密钥定位（`lib/memcrypt.js` / `lib/memory.js`）**
- 删掉写死的 `DEFAULT_KEY_FILE` 兜底逻辑，新增 `KEY_DIR_NAME` / `keyCandidates()` / `resolveKeyFile()`：显式配置 > `<dataDir 同级>/qq-whale-keys/memory.key` > `<dataDir>/memory.key` > 老 `${MOLLY_ROOT}\keys\memory.key`。
- `MemoryStore` 新增 `dataDir` 选项；**有密文却没有钥匙时 `broken=true`、拒绝 `save()`**，密文原样不动，只报「记忆是加密的，但本机密钥不可用」。
- 自测：`tools/memcrypt-key-resolution-selftest.mjs` 10/10。

**自测**
- `tools/memory-address-parse-selftest.mjs` 15/15；`tools/hash-command-selftest.mjs` 39/39；`tools/memcrypt-key-resolution-selftest.mjs` 10/10；`lib/*.js` 全量 `node --check` 通过。

**退回**
- 认人：换回 `${MOLLY_ROOT}\backup\rollback-20261026\installed-preview3-pre-patch\lib\` 三个文件并热重载；
- `#` 菜单：删 `lib/hash-commands.js` + 撤销 `main.js` 三处接线 + `module-health.js` 的 manifest 项；
- 密钥定位：`resolveKeyFile` 改回直接返回 `DEFAULT_KEY_FILE`。

---

## 2026-10-26 · v1.1.5-Hotfix.1：称谓读取加固（热修复，已发布）

> 主人 m02960：「为什么 Molly 叫子房还是不叫宝宝，是没调用称谓吗」。
> 主人 m02960：「发布不带 1.2 语音包的热修复版本 1，同时语音包单独发一遍」。

- **结论**：调用了，「# 怎么称呼」段确实在 system prompt 里；坏在段内容——第一条是 `他希望你叫他「什」`。
- **根因**：① 学习链路把「你叫我什么」这种反问存成了称谓（模型层加了 `称谓：` 前缀后原样入库，茶茶/大肥鱼各一条）；② `addressOf()` 只按 kind 过滤，把自称（`他自称「你宝宝呢」`）也当成硬要求并列进去。三段互相矛盾，flash 档就退回群名片叫法。
- **改动**：
  - `lib/memory.js`：新增 `addressName(text)` 只认第二人称指令句式、抽成名字并过滤疑问词/动作词；`addressOf()` 改为解析 + 按名字去重 + 时间新→旧，返回带 `name` 的条目；解析不出的（自称/昵称说明）不进提示词。
  - `lib/engine-context.js`：「# 怎么称呼」只拼 `- 叫他「X」`；同一人多条时提示「以第一行为准（最近一次说的）」。
  - `lib/engine.js`：模型层 address 入库前必须含「叫他」；`guessKind()` 的 address 触发词去掉 `昵称/自称叫`（归 person）。
- **数据清理**：删 3 条 `他希望你叫他「什」`、1 条把子房名片记成「梦梦」的错误条目（走插件 HTTP API，不直接改加密盘）。
- **自测**：`${MOLLY_ROOT}\out\_addrname_test.mjs` 15 条解析用例全过；真库审计 8 个 QQ 称呼可用，子房只剩「宝宝」。
- **上线**：gen `gen-mvorxuj7-llrtgn`（`boot-health ok=true`、link online）；`/chat/simulate` 以 888888888 试三条，两条回复带「宝宝」。
- **发布**：版本号 `1.1.5` → **`1.1.5-Hotfix.1`**（package.json / 控制台 FALLBACK_VERSION / 控制台页脚 / README 一并改）。本版 Release **只挂插件 zip，不带语音包**；音色包 v1.2 单独发成 `voice-pack-v1.2` Release。v1.1.5 上原有的 `molly-voice-pack-v1.2.zip` 附件**保留不动**（主人 m02960 定：已有链接别失效）。
- **顺带修的发布工具**：`tools/status-carry.mjs` 校验接受 `statusMod` / `bootedAt` 两代写法——v1.1.5 发版时正常回填被误判成 `blocked-carry`。
- **回退**：`addressOf()` 恢复成只按 kind 过滤；`addressName` 可留。

## 2026-10-26 · v1.1.5 正式版（**已撤回**）：合并 preview.1/2/3 + Hotfix.1/2/3 + 今日四项 + 部署可移植性

> ⚠️ **本版已于同日撤回**（Release #423843992 与 tag `v1.1.5` 均已删除）：称谓读取把「他希望你叫他「什」」这类反问残句当硬称谓，导致她认错人。现行正式版见上方 **v1.1.5-A**。本条目保留只作历史对照。

> 主人 m01820「整理目前更新内容，准备发布1.1.5正式版，唱歌功能未完成的状态挪给1.1.6的第一个预览版」。
> 正式版规矩（STATE.md §10）：preview 序列必须先合并进正式版；Hotfix/Plus 可并列继承；发版必须带 `#molly`。

**版本号**：`1.1.3-Hotfix.3` → **`1.1.5`**（package.json / 控制台 FALLBACK_VERSION / 控制台页脚 / README / cordis.patch.yml 升级提示 / publish-assets 一并改）。

**新增**

- **底层状态激发指令 `#molly`**（私聊/群里整条消息触发）：主人看详情、别人看一行；不受闭眼模式影响，总开关关闭时不吭声；30 秒冷却（主人豁免）；`/state.statusCommand` 可查。
- **语音语速与句间停顿生效**：`voiceSpeed`（默认 0.93）与 `voicePauseMs`（默认 30）现在真的传给 GPT-SoVITS（`speed_factor` + 逐句合成插静音），以前是「配置写了、代码没读」的死配置。
- **语音「英文腔」修复**：念稿前做中文规范化，`2K 60Hz / 1080P / 16GB / 40% / 12,000` 这类不再整句切英文音素（只改念出来的词，不改她发出的文字）。
- **记忆新增「称谓」类 `address`**：单独成类、按 QQ 匹配、每轮必带（不吃权重窗口）；历史记忆已迁移 13 条。
- **控制台数据补齐 + QQ 页合并**（preview.1）：模型/额度/并发/记忆等页面数据更全，QQ 相关页面合并为一处。
- **GIF / 动图理解**（preview.2）：多帧采样拼图送多模态模型，带图轮次输出预算单独放宽（`imageMaxTokens` / `imageReasoningEffort`）。
- **北京时间与作息**（preview.3）：不依赖系统时区；新增作息窗口、群趣味（抽奖 / 口令场 / @我 #）、GIF 表情库重扫脚本。

**修复**

- 群语音转写 20 秒超时（retcode 100）→ 本地 faster-whisper 兜底（Hotfix.1）。
- 自动开奖计数 + 新人入群自动欢迎失效（Hotfix.2）。
- 抽奖 `@` 段被吞（Hotfix.3）。
- 小玩具入口统一（plus.2）。

**部署可移植性（重点）**

- **没有 G: 盘也能启动**：`memoryKeyFile`、`workSandboxDir`、`voiceRefAudio`、`voiceAsrModelDir`、boot-health 路径、三个 Python 路径、work-guard 护栏、`sleepOverridePath()` 全部改为「从 dataDir 推导 + 配置可覆盖」，不再出现盘符字面量。以前无 G 盘的机器会 `mkdir ${MOLLY_ROOT}\keys` 抛 ENOENT → `ChatEngine` 构造失败 → 插件「加载成功但 OneBot 从未连过」。
- **加密失败降级而不是炸**：钥匙目录建不出来时降级明文 + warn（`/state.memory.keyError` 写明原因）；盘上是密文但没有钥匙时置 `broken` 并拒绝写回，避免明文覆盖唯一一份密文。
- **配置项**：新增 `voiceAsrModelDir`（空 = `<dataDir>/asr/models`）；`memoryKeyFile`、`workSandboxDir`、`voiceRefAudio` 默认值改由 dataDir 推导。
- 自测：`tools\path-portability-selftest.mjs`（8 项，模拟无盘机器）。

**音色包 v1.2（随本版 Release 附件发布）**

- 附件 `molly-voice-pack-v1.2.zip`（78 文件 / 315.93 MB，sha256 `<REDACTED>`）：54 句训练素材、参考音频、5 条样例、切分/训练/合成脚本与权重（GPT e10 + SoVITS e16_s864）。
- 与 v1.1 差别：5 条样例按线上参数（`speed_factor 0.93` + 句间 30 ms）重渲染；文档修正 `voicePauseMs` 笔误、补「QQ 语音转文字」实测与限制说明；数据与权重未变。直接覆盖旧的 `molly-voice-pack-v1.1.zip` 即可。
- 主人 m02313「语音目前改完qq转文字识别不了……测完后命名为v1.2的语音包并内置进v1.1.5正式版」；实测四组参数（1.0 整段 / 0.93 整段 / 1.05 整段 / 0.93 逐句 30 ms）都能被 QQ 转文字识别，结论是此前的「识别不了」为偶发，线上参数保持 `0.93 + 30 ms` 不变。

**已知问题 / 排期**

- **唱歌功能未完成**（音色训练集只能念，不能真唱；算法已能跑，卡在数据集），`singingEnabled` 保持关闭，**排期到 `1.1.6-preview.1`**。代码保留，不删除。

**升级注意**

- 老配置里显式写了 `memoryKeyFile` / `workSandboxDir` 等路径的机器，行为完全不变（作者机就是这一档）。
- 想开加密：配 `memoryKeyFile` 到自己机器可写目录；不想加密：`memoryEncrypt: false` 即可，记忆以明文 `memory.json` 落盘（可直接翻看）。
- 装插件的 profile 仍按 publish 仓库 README 的 `file:` 依赖方式接，`dsh-qq-whale` 包内 `plugin/dsh-qq-whale` 目录结构未变。

## 2026-10-26 · v1.1.3-Hotfix.3：自动开奖计数 + 新人入群自动欢迎修复


> 主人 m07147「先推github，还有，你新人欢迎又是我手动的」。

### 修了什么

- **新人入群不自动欢迎**：`lib/main.js` 的 notice 分支原来只把 `notify/poke` 转给 `engine.onNotice`，`group_increase` 一路落到 `return` 被静默丢弃 —— 表现就是「新人欢迎开关开着，但从来不自动发，只能主人手动补一句」。现在所有 notice 都交给 `engine.onNotice` 判：它内部先看 `group_increase`（新人欢迎），再处理 poke（反戳 / 回话），其它类型一律返回 ignored。
- **自动开奖不计入统计**：`lib/groupfun.js` 的 `LotteryBox` 新增 `onDraw` 回调，定时器到点 / 心跳兜底开奖成功后都会回调；`lib/engine.js` 构造时接上 `stats.lotteryDrawn += 1`（手动「开奖」仍由命令路径计数，不重复）。

### 新增（调试）

- `POST /dsh-qq-whale/groupfun/notice`（仅本机 127.0.0.1 + 宿主端口可达）：body `{ groupId, userId }`，用合成的入群通知驱动 `engine.onNotice`，用来验证「新人入群自动欢迎」整条链路（会真的往群里发欢迎语）。

### 实测

- 合成入群通知（群 `666666666`、假 QQ `1234567890`）→ 返回 `{"acted":true,"kind":"welcome"}`；群内真实发出「欢迎 新朋友 加入 本群～我是 Molly，有问题随时 @我」（message_id `1160694340`），`/state.groupfun.stats.welcomed` 由 0 → 1。

## 2026-10-26 · v1.1.3-plus.3：抽奖 @ 段修复（自动开奖能发了）+ 本地调试路由

> 主人 m06713：「Molly刚刚没开奖是因为发言被我关了吗」→ 实为消息段字段错误；m06903：「先自己测一下能不能开奖，而且要模拟真人用@molly # 使用抽奖机，不要用你自己的 LLM 链路」。

**1）根因** 自动开奖的 @ 段写成 `{ type:'at', data:{ qq } }`，而 SnowLuma 的协议是 `{ type:'at', qq }`；发送时整条消息被拒（`message segment "at" is missing required or usable fields`），异常被发送层吞掉，只落在 `/state.groupfun.lastAuto.error`。

**2）修复** `lib/engine.js` 两处构造 @ 段改为 `{ type:'at', qq: String(qq) }`。

**3）兜底** `lib/groupfun.js` 新增 `sweep()`（到点未开的房间补开）与 `tick()` 心跳；`engine` 每 15 秒调一次；`/state.groupfun` 暴露 `lastTick` / `lastAuto` / `sweeps`。

**4）自测** `out/_lottery_sweep_test.mjs` 15 项、`_lottery_keyword_test.mjs` 33 项、`_groupfun_test.mjs` 51 项全过；并在群 666666666 用调试路由实跑一局（3 人报名 → 到点开奖 @ 三位，`lastAuto.ok=true, sent=true`）。

---

## 2026-10-25 · v1.1.3-plus.2：小玩具统一入口 @我 #（含抽奖 / 口令抽奖 / 新人欢迎）

> 主人 m06563：「触发菜单的命令就用@Molly+空格+#吧，以后的小玩具都这样」。
> 主人 m06473：「抽奖机加一个：菜单其中一个功能，可以在抽奖开始后只选择规定时间内发送指定口令的才能在倒计时结束时成为抽奖参与者」。

**1）小玩具统一入口**

- `@我 #` → 发「小玩具」总菜单（同时也是以后所有小玩具的入口）；`@我 #抽奖` → 直达抽奖菜单。
- 旧写法全部保留：`@我 抽奖`、`抽奖 开 …`、`参加`、`抽奖 名单` 等照旧可用。

**2）口令抽奖（新玩法）**

- 开局：`抽奖 口令 干饭 3 人 60秒`（口令 1–16 字；名额 1–10；时长 30–600 秒；后两个参数可省，默认 3 人 / 120 秒）。
- 报名：窗口内**整句**发出口令（如「干饭」）的人才算参加；发 `参加` 会被提示「本场是口令抽奖，发『干饭』才算报名哦」。
- 开奖：到点自动开 / 发起人 `抽奖 开奖` 提前开，只从口令参与者里抽；无人发口令则自动取消。
- 抽奖名单会显示口令与参与人数；口令只按整句严格相等匹配（防误触），同一句口令不会重复报名。

**3）回归**

- 普通抽奖 / 新人欢迎逻辑不变；新增自测 `out/_lottery_keyword_test.mjs`（33 项）与 `out/_toy_menu_test.mjs`（7 项），全部通过。

**回滚**

- 去掉 `@我 #` 入口不影响旧指令；要整体关掉：`groupfunEnabled: false`，或单独关 `lotteryEnabled` / `welcomeEnabled`。

## 2026-10-25 · v1.1.3-plus.1：群趣味——抽奖 + 新人欢迎

> 主人 m06096：「加两个群趣味功能作为1.1.3plus.1上线：1.群内抽奖小插件…2.新人欢迎小插件」。

**1）群内抽奖（纯代码，不进模型）**

- 触发：「@Molly 抽奖」或「@Molly 抽个奖」→ 发菜单（菜单同时也是使用说明）。
- 指令（整句匹配，防误触）：
  - `抽奖 开 3 人 60秒`：开局（名额 1–10，默认 3；时长 30–600 秒，默认 120，可省略）
  - `参加`：报名（开奖前都能报，重复报名会被拦下）
  - `抽奖 开奖`：提前开奖（只有发起人能开）
  - `抽奖 取消` / `抽奖 名单`
- 到点自动开奖；同一时间每群只能有一场；抽签不放回、每人最多中一次。
- 实现：`lib/groupfun.js`（纯逻辑状态机，注入 now/random/send 便于测试）+ `engine.maybeGroupFun` 在会话路由之前接管，命中后不再走模型。

**2）新人欢迎**

- 监听 `group_increase` 通知（含 `sub_type=increase` 的兼容形态），新人入群自动发欢迎语。
- 模板在 `welcomeTexts`（`|` 分隔多条，随机一条），占位符 `{name}` `{group}` `{molly}`；60 秒冷却（`welcomeCooldownSeconds`）。
- 欢迎语只发一次、不进历史，也不花 token。

**观测**

- `/state.groupfun` 回读开关与房间数；`/state.stats` 新增 `lotteryStarted` / `lotteryJoined` / `lotteryDrawn` / `welcomeSent`。
- 自测：`out/_groupfun_test.mjs` 51 项全过（解析、状态机、抽签均匀性、欢迎模板、入群事件）。

**配置（cordis.patch.yml）**

```yaml
groupfunEnabled: true
lotteryEnabled: true
lotteryDefaultCount: 3
lotteryMaxCount: 10
lotteryDefaultSeconds: 120
lotteryMinSeconds: 30
lotteryMaxSeconds: 600
lotteryJoinKeyword: 参加
welcomeEnabled: true
welcomeTexts: 欢迎 {name} 加入 {group}！我是 {molly}，有不懂的可以问我喵~
welcomeCooldownSeconds: 60
```

## 2026-10-25 · v1.1.5-preview.3：看得见时间、按点睡觉、动图表情重扫（唱歌暂缓）

> 主人 m05189：「1.给鱼加一个能看时间的插件功能，要求北京时间 2.鱼想唱歌，优化一下语音模型写一下算法，让鱼能唱出歌来 3.利用新的动图识别功能，重新给表情包库的gif打tag，同时推preview.3的时候,增加脚本提示，让更新者获得提示：请利用新功能重新扫描gif库」。
>
> 追加（m05905 / m05958）：「第②件可以开工，计入preview3」——第②件按主人澄清指「北京时间」那条：把作息也交给北京时间判断，并且能在控制台改。

**1）北京时间**

新增 `lib/clock.js`（纯函数、无依赖）+ engine 注入 `clockText`：每轮提示词带一行「现在是 2026-10-25 周日 20:57（北京时间）」，并提醒「不知道具体分钟数就别编」。配置 `timeContextEnabled`（默认开）、`timeZoneOffsetMinutes`（默认 480 = 北京时间）。以前她没有任何时间来源，问几点只能糊弄。

**2）唱歌（暂缓，默认关闭）**

算法已经做完并验收（`lib/singing.js` + 内嵌 numpy 渲染器：逐字合成 → ACF 测基频 → 重采样搬音高 → WSOLA 保时长 → 全局校准，实测 42 个音平均误差 14.6 音分），但**音色没过关**：她的语音包 fine-tune 数据只有 **54 句 / 3.5 分钟**（`logs/molly_own/molly_own.list`），而 GPT-SoVITS 是「说话」模型，变调搬移会连共振峰一起搬，听起来「不人不鬼」。主人 m05752 决定：先去收集足够原始录音（目标 30 分钟以上），唱歌这一路改走社区歌唱模型（DiffSinger / So-VITS-SVC），1.1.5 正式版等数据齐了再说。代码保留、`singingEnabled` 默认 **false**，将来可直接开。

**3）动图表情重扫（升级后建议跑一下）**

新增 `tools/rescan-gif-stickers.mjs`：把表情包库里的 GIF 拆成多帧拼图 → 视觉模型重新概括「角色/画面/动作/情绪」→ 写回文件名（文件名就是 tag）。默认 **dry-run 只预览**，`--apply` 才真正改名；每张的旧名/新名都写进 `out/rescan-gif-report.json`，改错可照报告改回；单帧 GIF 跳过，一张失败不影响其它张。旧的 tag 多是按首帧或人工起的，用新的动图识别能补上「动作」。

> 升级到本版后，先 `node tools/rescan-gif-stickers.mjs` 预览，确认没问题再 `node tools/rescan-gif-stickers.mjs --apply`。

**4）作息：按北京时间判断「该不该睡」**

以前她没有作息概念，休息窗用的是宿主本地时间，于是会出现「聊着聊着突然说要睡」。现在新增 `sleepWindowEnabled`（默认开）、`sleepWindowStart`（默认 23:50）、`sleepWindowEnd`（默认 09:00），全部按**北京时间**判断：

- 窗口内：不主动找人、群聊不接话（被 @ 才回），私聊叫她会醒、语气带起床气，但不会长篇大论。
- 窗口外：想聊多久聊多久，不再中途喊困。
- 配置在控制台「设置」页的「作息时间」卡片里改，保存后立即生效、无需重启；覆盖值落盘 `${MOLLY_ROOT}\data\qq-whale\sleep-window.json`，插件接口 `GET/POST /dsh-qq-whale/sleep`（控制台 `/api/sleep`）。
- 自测：`out/_sleep_test.mjs` 15/15（跨午夜窗口、边界含端点、非法输入 400、控制台代理、私聊叫醒）。

## 2026-10-26 · v1.1.5-preview.2：让她看懂动图（GIF 多帧）+ 带图轮次不再「看了不吭声」

> 主人 m04893「现在做preview.2，目标是让Molly能看懂gif动图，他现在面对那些gif和gif表情包只能看到首图」。

**为什么只看得到首图**
- QQ 侧没问题：图片 URL 下载下来就是完整 GIF（实测群历史 14 张图里 2 张是 GIF，最大 1.18 MB）。
- 是模型侧的问题：多模态模型对 `image/gif` 只解码第一帧，插件原来把 GIF 原样当 data URL 发，等于只给模型看首帧。

**改法（新增 `lib/gif-frames.js`，约 250 行，无新依赖）**
- 下载后按魔数确认是 GIF → 调本机 `${MOLLY_ROOT}\data\video\venv` 的 Pillow，把整段动画采样成 N 帧（默认 6 帧 / 3 列 / 每帧 320px），拼成一张 PNG，每格左上角标「n/N」帧号。
- 接入点在 `engine-context.loadImages`：拆帧函数由 engine 通过 deps 注入，该文件保持「只组装、不 import 能力」；没装 Pillow / 超时 / 单帧 GIF 一律回退原图，绝不影响这轮回复。
- 配置（cordis.patch.yml）：`gifFramesEnabled` / `gifFramesCount` / `gifFramesColumns` / `gifFrameWidth` / `gifFramesPython` / `gifFramesTimeoutMs`。实测拆帧 204–235 ms，拼图输出 21 KB。
- 真机 A/B：原图首帧 → 「两只小猫抱在一起，一只用爪子捂着另一只的嘴」；拆帧图 → 按帧号讲出「捂嘴 → 蓝色液体漏出 → 又大量溢出」的完整动作。`out/_gif_frames_test.mjs` 16/16；`out/_gif_e2e.mjs` 用群里真实 GIF 跑通（8 帧取 6）。

**连带修：带图轮次会「看了不吭声」**
- 实测图类请求 reasoning token 934–4094 波动，默认 `maxTokens 1536` 一旦被思考吃光，正文就是空串 → engine 判「模型返回空内容，沉默」。
- 改法：带图轮次 `maxTokens` 抬到 `imageMaxTokens`（默认 3200），并传 `reasoning_effort: 'minimal'`（思考压到 ~900，回答质量不受影响；gateway 只在显式配置时才带该字段）。新增配置 `imageMaxTokens` / `imageReasoningEffort`；`out/_image_effort_test.mjs` 5/5。

**回滚**
- 只关动图理解：`gifFramesEnabled: false`。
- 连「带图轮次预算」也回旧行为：`imageMaxTokens: 1536`、`imageReasoningEffort: ''`。
- 代码层：`lib/gif-frames.js` 可整体删除（只通过 deps 注入被用到）；`engine-context.js` 里 `mime === 'image/gif'` 那个分支可直接去掉。
- 提示词没动；记忆 / 戳一戳 / 语音链路不受影响。

## 2026-10-25 · v1.1.5-preview.1：控制台数据补齐 + QQ 页合并

> 主人 m04755「控制台里的学习器，记忆，群数等数据还是none，看看怎么弄一下」+「QQ这里两个模块功能有点重复了吧，看看是合并还是清晰区分一下」。

**为什么是「—」**
- 学习器：插件 `/state.learner` 本来就有 `total` 和 `today{kept,...}`，`console-server` 的 `out.learner` 没透传。
- 群数：`out.plugin.bot` 没有 `groupCount`。
- 记忆：QQ 记忆池 10-23 改成加密存储，控制台旧数据面（19391 的 panel-data）读不到明文 `memory.md` 就返回空。
- 表情包「已学」：`out.stickers.learned` 缺失。
- 都是控制台聚合层/取值链的问题，**Molly 插件本身数据是好的**。

**改了什么**
- `tools/console-server.mjs`：`out.learner` 补 `total` + `today`；`out.plugin.bot.groupCount` 用已有的 `snowlumaAction('get_group_list')` 取群列表长度（retcode 0 且为数组才算）；`out.stickers.learned` 回落 `learner.total`；`out.sidecar.memory` 为空时回落插件 `/state.memory.count` 并标 `source:'plugin'`。
- `console/console.js`：取值链改 `p.bot.groupCount`、`learner.total`、`learner.today.kept`、`stk.learned`、`(side.memory.count)||(p.memory.count)`；`PAGES` 去 `login`、`#/login` 与 `#/napcat` 都别名到 `#/qq`；`renderPageNow('qq')` 同时渲染连接页与登录块；`startLoginPoll()`/`handleQrExpired()` 页面判断改 `qq`；连上时不再重复「不需要扫码」。
- `console/index.html`：左侧 QQ 组只留一项「QQ 连接」（`#loginBadge` 移到该项）；QQ 页 = 连接状态卡 + 服务信息 + 扫码登录块（重新登录/二维码/状态/倒计时/进度/复制链接/诊断）；删掉独立「登录」页。

**验证**
- `node --check` 通过（`tools/console-server.mjs`、`console/console.js`）；重启 `Molly-Console` 后 `/api/health` 版本号跟随 `plugin/dsh-qq-whale/package.json`。
- `/api/overview`：`bot.groupCount=10`、`learner.total=234`、`learner.today.kept=45`、`stickers.learned=234`、`memory.count=911`、`sidecar.memory={count:911,source:'plugin'}`。
- 浏览器实测：总览「群数 10 / 累计学会 234 张 / 今日学会 45 条 / 记忆 911 条」；QQ 页只剩一个导航项，状态卡与扫码登录同页。

**回退**
- 纯控制台（前端 + 一个 server 文件）：`git checkout` 回 `tools/console-server.mjs`、`console/index.html`、`console/console.js`，重启 `Molly-Console`。不涉及插件运行时和线上 Molly 行为。

---

## 2026-10-25 · v1.1.3-Hotfix.2：群聊语音本地 ASR 兜底 + 控制台「本次更新说明」

> 主人 m04446「把语音识别加进这个版本呢，然后一起发」、m04404 选「本地兜底」、m04452「控制台上的版本更新一下，注释一下这次更新了什么」。
> 与 `v1.1.3-Hotfix.1` 分开发布：Hotfix.1 只有 QQ 服务端转写（`fetch_ptt_text`）这一条；本地 ASR 兜底 + 控制台「本次更新说明」归到本版（Hotfix.2）。

**为什么还要本地兜底**
- 上一版上线后真机又出现：群聊里群友发的语音，`fetch_ptt_text` 20 秒不回（SnowLuma 回 `retcode=100`），她只能回「[语音：没听清]」；同一条消息换成私聊就正常。
- 复测也说明 QQ 服务端转写是**时好时坏**：本轮同一条群语音 209 ms 就返回了「8秒够卖了。」，所以本地 ASR 只做兜底，不抢主路、不加延迟。

**改动**
- 新增 `lib/local-asr.js`（无新 npm 依赖、无 ffmpeg）：
  - `fetchRecordWav(client, file)`：调 SnowLuma `get_record { file, out_format:'wav' }` 取 24k/16bit/mono wav（SnowLuma 自带解码）；超时 12 秒、体积上限 8 MB、失败永远返回 `{ok:false,error}`。
  - `wavSeconds(buffer)`：解析 RIFF 头算时长，给「太长不识别」的判断用。
  - `LocalAsr`：常驻 Python worker（借用 `${MOLLY_ROOT}\data\video\venv` 里已装的 faster-whisper + 本地缓存模型，`local_files_only` 不联网），首次加载约 1.6 秒、之后每段 1.4–1.6 秒；空闲 10 分钟自动退出；串行队列避免并发拖爆 CPU；旧 worker 迟到的 exit/error 不会影响新 worker（踩过：dispose 后立刻重启会被旧子进程的退出事件打成 `asr worker 未就绪`）。
- `lib/engine.js`：`transcribeVoice(messageId, { file })` 改成分级返回 `{text, source}`——
  1. 先走 QQ 服务端 `fetch_ptt_text`（快、免费）；
  2. 失败且 `voiceAsrEnabled !== false` 时：`get_record` 转 wav → `voiceAsrMaxSeconds`（默认 15 秒）以内 → 本地识别；
  3. 仍然失败则沿用 `[语音：没听清]` 降级。
  `/state.stats` 新增 `voiceAsrTranscribed / voiceAsrFail`（`voice.source === 'asr'` 的条数单独记）。
- `lib/main.js` + `cordis.patch.yml` 新增 7 个配置：`voiceAsrEnabled`（true）、`voiceAsrPython`（venv 解释器）、`voiceAsrModel`（small）、`voiceAsrThreads`（8）、`voiceAsrTimeoutMs`（25000）、`voiceAsrIdleSeconds`（600）、`voiceAsrMaxSeconds`（15）。
- 控制台「本次更新说明」（主人 m04452）：
  - `tools/console-server.mjs` 新增 `GET /api/changelog`：直接读仓库 `docs/CHANGELOG.md` 最新一节（不另维护文案），文件缺失也返回 200；版本真源仍是插件 `package.json`（`FALLBACK_VERSION` 兜底）。
  - `console/index.html` + `console.js` + `console.css`：左下角版本号改成可点按钮，点开弹层按 markdown 轻渲染展示本节；Esc / 点遮罩关闭，底部「完整变更日志」跳 GitHub。

**验证**
- `out/_local_asr_test.mjs` **17/17 PASS**：wav 头解析、坏输入不崩、`fetchRecordWav` 各失败路径、worker 冷启动识别（2.34 s 样本 → 「喂喂 听得见我说话吗」）、空闲/重启后仍可用、disabled 直接空串。
- `out/_asr_e2e_test.mjs` **8/8 PASS**：拉真实群语音（`-246478423`）→ `fetch_ptt_text` 得「8秒够卖了。」[信息项] → `get_record` 67278 B wav（1.40 s）→ 本地识别出文本（3.5 s，含首次加载）。
- 已热重载 `gen-mvnix03p-oz7o14`；`/state.stats` 出现 `voiceAsrTranscribed/voiceAsrFail`，7 个配置键在 yml 里存活。

**已知限制**
- 本地用的是 `small` 模型：安静清晰的语音（2.3 s「喂喂，听得见我说话吗？」）转写正确；嘈杂短句会听错（同一条 1.4 s 群语音，QQ 服务端「8秒够卖了。」，本地识别成「白鸟 夠白了」）。想更准可换 `voiceAsrModel: medium`（首次需联网下载约 1.5 GB，CPU 约慢 3–5 倍）。
- 群里 15 秒以上的长语音不走本地（`voiceAsrMaxSeconds`），仍回降级文案。

**回滚**
- `voiceAsrEnabled: false` 只关本地兜底，保留 QQ 服务端转写；
- `voiceTranscribeEnabled: false` 连 QQ 转写一起关，退回只看见 `[语音]` 的老行为；
- 整体回退：还原 `lib/local-asr.js`（删除）、`lib/engine.js`、`lib/main.js`、`cordis.patch.yml` 与三个控制台文件。

---

> 主人 m04041「Molly好像还是不能读语音啊，你看那个交流群她和群友聊的」、m04153「这个修复推github1.1.3-Hotfix.1」。

**根因**
- `lib/onebot.js` 的 `normalizeMessage` 把 `record` 段压成占位符 `[语音]` 之后，再没有任何环节去取内容：模型只看见「有一条语音」，只能回「听不出说的啥，换成字」。
- 真机证据：15:05–15:10，群友连发三条语音，她三次都只能要求对方换成文字。

**改动**
- `lib/onebot.js`：新增 `fetchPttText(client, messageId, { timeoutMs })`——调 SnowLuma 的 OneBot 扩展动作 `fetch_ptt_text`（走 QQ 自带语音转文字，零依赖）；6 秒硬超时、永不抛异常、失败统一给 `PTT_FAIL_TEXT = '[语音：没听清]'`。
- `lib/engine.js`：`onMessage` 在归一化之后、空消息判断之前检测 `record` 段 → 转写 → 把正文里的 `[语音]` 换成「（语音转文字：原文）」；新增 `transcribeVoice()`，带 10 分钟 / 按 `message_id` 的缓存（同一条语音可能被「旁观评估」和「真回复」各读一次）；`/state.stats` 新增 `voiceTranscribed / voiceTranscribeFail`。
- `lib/main.js` + `cordis.patch.yml`：新配置 `voiceTranscribeEnabled`（默认 true）、`voiceTranscribeTimeoutMs`（默认 6000）。

**验证**
- `out/_ptt_inbound_test.mjs` 6/6：连 WS 3001 取群里真实语音消息，转写 **261 ms**、正文正确；不存在的 `message_id` / 空 id / 无 client 都走降级文案。
- `out/_ptt_e2e_sim.mjs`：用真实消息段跑 `onMessage` 里的替换表达式，`[语音]` → `（语音转文字：放我出来，我又没被关着…）`（就是她先前没读懂的那条）。
- 已热重载 `gen-mvnhzoxb-8ct0sa`；`/state` 新计数器就位，语音与引用相关配置未受影响。

**回滚**
- 配置 `voiceTranscribeEnabled: false` 即退回「只看见 `[语音]`」的老行为。
- 整体回退：还原 `lib/onebot.js` / `lib/engine.js` / `lib/main.js` 与两个配置键（`git revert` 对应提交即可）。

---

## 2026-10-25 · v1.1.3 正式版：三个预览版合并 + 引用不带语音 + 控制台版本自动同步 + 表情包搜索

> 主人 m03522「控制台左下角还显示 1.0，刷一下，一起作为 1.1.3 正式版上线」、m03530「上新版本时把挂在上面的旧版本打包作为 release 传上去，注意隐私管理」。
> 版本号从 `1.1.3-preview.3` → `1.1.3`；此前预览版 tags（`v1.1.3-preview.1/.2/.3`）保留不动，GitHub Releases 另建正式版条目。

**合并进来的内容（详见下面三个预览版条目）**
- 戳一戳改用模型回一句（`pokeReplyText`，失败回退固定句）。
- 控制台改版：去 NapCat 品牌、QQ 连接四态判定、导航分组、`#/qq` 页面。
- 记忆池新增「梗」类（`meme`）。
- 上下文体积优化 A：记忆窗口 `large→balanced`（每轮 6,869 → 5,935 token，-13.6%）。
- @ 错人修复：`lib/quote-at.js`（@ 号校验、纯叫醒不算目标、条件引用、提示词两句）。

**本次新增：引用回复不带语音（m03353「QQ 里引用的消息回复不能使用语音」）**
- `lib/quote-at.js`：`shouldDemoteVoice(parts)` / `voicePartToText(part)`——引用了某条消息时，把语音段降级成纯文字（保留内容，不丢话）；不被引用时语音照常。
- `lib/engine.js` `deliver`：挂引用前先做降级，`/state.stats.quoteVoiceDemoted` 计数。
- 自测 `out/_quote_voice_test.mjs` 13 项全过；真机：`SnowLuma` 日志确认引用消息只发文字、`get_msg` 段里没有 `record`。

**本次新增：控制台版本号以插件版本为真源（m03522）**
- `tools/console-server.mjs`：`VERSION` 改为读 `plugin/dsh-qq-whale/package.json` 的 `version`（exe 打包模式读不到时兜底 `1.1.3`）。以前这里写死 `1.0.0`，所以左下角一直显示 v1.0.0。
- `console/index.html`：无 JS 时的默认文本 `v1` → `v1.1.3`。
- `/api/health` 与页面 `#footVersion` 都跟着插件版本走，以后发版不再需要手改控制台。

**本次新增：控制台表情包搜索（m03735「表情包做一个搜索功能并推github」）**
- `console/index.html`：表情包页 `.toolbar` 增加搜索框 `#stkSearch`（占满剩余宽度，placeholder「搜索表情包：名字 / 关键词，空格分隔多个」）。
- `console/console.js`：`stkSearchText()` / `stkTokens()` / `stickerHit()` 把 `name`、`file`、`keywords` 拼成检索串（文件名里的 `_` 当空格），多词 = AND、大小写不敏感；`renderStickers()` 按 `state.stkQuery` 过滤，副标题显示「「词」命中 M / 共 N 张」，无命中显示空态 +「清空搜索」；`input` 即时过滤（纯前端，不重新请求 `/api/stickers`），`Esc` 清空。
- `console/console.css`：`.toolbar .stk-search{ flex:1 1 280px; max-width:none }`。
- 真机浏览器验证（1400×900）：「白猫 偷笑」→ 命中 1 / 共 222 张；不存在的词 → 空态；点「清空搜索」→ 回到 222 张全量。
- 回滚：纯前端改动，`git revert` 本提交即可，不影响插件运行时。

**本次新增：GitHub Releases 发布包（m03530）**
- 新脚本 `tools/release-assets.mjs`：给每个 tag 打 `molly-qq-whale-<tag>.zip`（`git archive`，不含 `.git`），上传为对应 GitHub Release 的附件；新版本发布时会顺带补齐旧版本的包。
- **隐私门**：上传前对 tag 树做敏感串扫描（真实 QQ 号 / 群号 / OneBot token / 本机用户目录），命中即拒绝上传并报文件行号；发布版正文写明「扫描 0 命中 + sha256」。

**验证**
- 全量 15 个自测脚本全绿（`_quote_at` 26、`_quote_voice` 13、`_poke` 21、`_voice_trigger` 16、`_meme` 10、`domtest` 17、`_memory_crypt` 27、`_voice_guard`、`_testD` 26 等）；3 个过时脚本的假设已修正（见 §3「测试脚本刷新」）。
- 发布副本：159+ 文件 / ~2.6 MB，二次脱敏扫描 0 命中。

**回滚**
- 引用语音降级：`quote-at.js` 里 `shouldDemoteVoice` 直接 `return false` 即恢复旧行为。
- 控制台版本：把 `tools/console-server.mjs` 的 `VERSION` 改回固定字符串并重启 console-server。
- 版本号：`plugin/dsh-qq-whale/package.json` 回退即可（GitHub 发版包与 tag 需一并回退）。

---

> 第三个预览版，只含这一项；正式版本号仍走 1.1.x 线。起因（m02736 第 1 件）：「Molly 现在在那个交流群里，出现了 a 提问却 @ b 进行回复」；做法按主人 m02835「试着让她引用精准回复」、m02846「引用也不用每条，同一时间发的人特别多才引用」。

**新增 `lib/quote-at.js`（纯函数，无依赖）**
- `isPureNudge(ev)`：只有 @ / 表情 / 空白 = 纯叫醒，不算「要回谁」。
- `crowdStats(history, now)`：30 秒窗口内的条数与说话人数；`recentSpeakers(history)`：最近 20 条里说过话的人。
- `resolveExplicitAt({ raw, history, selfId, text })`：模型写的 `<at>` 号必须是 5–12 位数字、且不是自己；在最近说话人里 → 认；否则若历史里出现过且正文点名 → 认；其余**丢弃**（不再乱 @）。
- `pickQuoteTarget(...)`：纯叫醒 / 人群拥挤 / 显式点名三者命中才给引用目标（纯叫醒引用上一条非自己消息，否则引用触发消息）。

**`lib/engine.js`**
- `deliver` 里模型显式 `<at>` 先过校验（丢弃时 warn + `quoteAtDropped++`）；有引用目标或纯叫醒时**不再按概率 @ 触发者**。
- 发送前把 `{ type: "reply", data: { id } }` 挂到第一条气泡；引用发送失败（被撤回 / 太老 / 拿不到 seq）自动去掉引用、纯文本重发（`quoteFail++`）。
- `/state.stats` 新增 `quoteSent / quoteFail / quoteAtDropped / quoteLast`。

**提示词 / 配置**
- `lib/engine-context.js` 名册段补两句：对方只是 @ 你、一个字没说，那不算你要回的人（代码会自动引用上一条）；引用是代码自动加的，别自己写。
- 新配置 `groupQuoteReply`（默认 true）、`groupQuoteWindowSeconds`（30）、`groupQuoteMinMessages`（3）、`groupQuoteMinSpeakers`（2），已写入示例配置与文档。

**验证**
- `out/_quote_at_test.mjs` 26 项离线自测全过；`_poke_test` 21、`_voice_trigger_test` 16、`_meme_test` 10 回归全过。
- 真机：发送侧引用自检通过（引用后 `get_msg` 能看到 `reply,text` 段）；上线后 12:54:07 首次自然命中（多人同时发图的拥挤场景，自动引用了被讨论的那张图），`/state.stats.quoteSent = 1`。
- 已热重载 `gen-mvncpntd-l294fe`。

**回滚**
- 配置 `groupQuoteReply: false` 即关闭引用（仍保留 @ 号校验）；要整体回退，删除 `lib/quote-at.js` 并把 `engine.deliver` 里 `quotePick` / `triggerNudge` 相关分支还原。

---

## 2026-10-25 · v1.1.3-preview.2：记忆「梗」类 + 上下文体积优化 A（预览版）

> 第二个预览版，只含这两项；正式版本号仍走 1.1.x 线。主人要求（m02619）：「推github，作为第二个预览」。

**记忆「梗」类（`lib/memory.js`、`lib/memory-quality.js`、`lib/engine.js`、`lib/web.js`、`console/console.js`）**
- 记忆类型从 7 种扩到 8 种，新增 `meme`：模型抽取时若一条记忆以 `梗：` / `热梗：` / `名场面：` 开头就归为梗类（普通记忆混着梗则保持原类型，避免误伤）。
- 抽取提示词加「梗」分类；梗类单条上限放宽到 60 字（普通 200 字），质检对梗类只要求「至少 2 个字、不是纯数字」，不再套用事实类那套「6 字+身份」的严格门槛。
- 召回上给梗类小幅加权（+3 分，能被「接梗/玩梗/这个梗」这类问法主动唤回）；管理面：`/state`、控制台记忆页、`/memory/*` 接口与 `memory-guide.md` 全部认识 `meme`。
- 验证：新增 10 项离线自测全过（抽取提示词含梗类、`梗：` 前缀归 meme、质检放行、召回加权、控制台标签渲染、落盘 JSON 类型正确）；已热重载 `gen-mvn52qio-q6xbmd` 上线，`/state.memory` 正常（当时 742 条 / 加密态）。
- 回滚：把 `guessKind()` 里的梗正则与 `learnByModel` 提示词里的梗行删掉即回到 7 类，已写入的梗条目不认也不会报错，可在控制台逐条改类型。

**上下文体积优化 A（`lib/memory.js`）**
- 记忆窗口档位 `WINDOW_PROFILE` `'large'` → `'balanced'`：上下文注入 48→32 条、关键词召回 16→12 条、单条上限 320→240 字、降智档 18/9→12/6；人设、硬性规则、注入顺序一行没动。
- 依据：`docs/AUDIT-2026-10-25-context-budget.md`（真测校准，非估算）——一轮完整提示词 6,869 token 里 82.5% 是 system prompt，记忆段 2.1k，48 条里后 16 条与本轮相关性最低。
- 实测：同一探针复测一轮完整 prompt **6,869 → 5,935 token（-934 / -13.6%）**，与预估 -931 吻合；已热重载 `gen-mvn5b3hy-lqwxc2`，`/state.memory` 742 条 / 上限 2000 / 自动扩 10000 / 加密正常，`/chat/simulate` 真链正常出话。
- 回滚：`memory.js` 里 `WINDOW_PROFILE` 改回 `'large'` 即可，不用动任何调用点。观察点：上下文记忆条数从 48 降到 32、单条 320→240 字，若出现「忘上文」迹象可回退；后续 B（`contextLimit` 60→40）/ C / D 仍待批。

## 2026-10-25 · v1.1.3-preview.1：戳一戳改模型回话 + 控制台改版（预览版）

> 预览版，只含这两项供提前验收；正式版本号沿用 1.1.x 线。
> 主人要求（m02205）：「先推这两个到github作为1.1.2preview」。因 `v1.1.2` 已于 2026-10-24 21:31 发布并推送，经主人确认改用 `1.1.3-preview.1`。

**戳一戳「说一句」改为模型回复（`lib/poke.js`、`lib/engine.js`、`lib/main.js`、`lib/web.js`）**
- 新增配置 `pokeUseModel`（默认 `true`）、`pokeModelTimeoutMs`（默认 `10000`）、`pokeModelMaxChars`（默认 `40`）；`engine.pokeReplyText()` 让模型结合上下文与她此刻情绪说一句短的，超过 10 秒或失败自动回退原固定句池，失败计入 `stats.pokeModelFail`。
- 真机验证：私聊连戳两次 → 第 1 次回戳；第 2 次她用模型回「又戳，手是闲不住是吧。」（OneBot 日志确认发送成功）。
- 回滚：`cordis.patch.yml` 里 `pokeUseModel: false` 即退回固定句池，无需改代码。

**控制台改版（`console/index.html`、`console/console.js`、`console/console.css`、`tools/console-server.mjs`）**
- QQ 状态改四态判定：`connected` / `bridge-only` / `client-only` / `offline`，每种状态一句人话 + 下一步提示；`/api/overview` 新增 `qq` 字段（状态、后端、`webui`、`uin`、`nickname`、`nextStep`），侧车探测 800ms 超时 + 10s 缓存。
- 顶部灯与总览卡读同一份判定；侧栏按「她 / 行为 / QQ / 运维 / 系统」六组重组；「QQ 连接」页把状态与扫码登录分两块；全仓清掉 NapCat 品牌（旧 `#/napcat` 自动跳到 `#/qq`）。
- 已用真实浏览器验收：总览、QQ 连接、登录三页渲染正常，其它依赖未动。
- 回滚：用 `console\*.bak-20261025` 四个备份覆盖回去，再重启控制台进程（`schtasks /End /TN Molly-Console` → `/Run`）。

## 2026-10-24 · 音色包：molly_own（自录 54 句微调）上线并开源

**换音色（`tools/voice-sovits-start.ps1`、`cordis.patch.yml`）**
- 语音后端从社区 Dania 换成作者自己录 **54 句**中文微调的 **molly_own**（GPT-SoVITS v2ProPlus）：GPT `molly_own-e10.ckpt`（155,312,694 B）+ SoVITS `molly_own_e16_s864.pth`（172,764,661 B），参考音频 `${MOLLY_ROOT}\data\qq-whale\voice-ref\molly-ref.wav`，参考文本「想的美，今天本鱼才是老大，你喝白开水去！」。
- `voice-sovits-start.ps1` 第 35–37 行写死上述三条路径，服务就绪后幂等调用 `/set_gpt_weights`、`/set_sovits_weights`、`/set_refer_audio`；`Molly-Voice` 计划任务每 5 分钟保活。
- 行为不变：`voiceChance 0.35`、`voiceMaxChars 220`、`voiceMaxSeconds 58`、23:50–09:00 静默、失败回退 edge-tts。

**开源音色包（产物在 `out/`，不是插件代码）**
- `${MOLLY_ROOT}\out\molly-voice-pack-v1.0\`：权重 + 参考音频 + **切好的 54 句**训练音频（32 kHz，13.4 MB）+ 训练配置/脚本 + 5 条真实合成样例 + README / RELEASE-NOTES / LICENSE-VOICE / SHA256SUMS，共 343 MB、76 个文件；zip 约 301 MB。
- **不含 7 段原始连续录音（.m4a，5.11 MB）**——只发切好的片段，保护作者原声。
- 授权：CC BY-NC-SA 4.0 + 禁止冒充真人/商用（`LICENSE-VOICE.md`）。
- GitHub 单文件 100 MB 硬限 → 走 Release 附件（≤2 GB）/ 网盘 / 模型站，上传路线待定。

**验证**
- `/state.voice.ready=true`；真机语音条正常（SnowLuma PTT）；`${MOLLY_ROOT}\data\qq-whale\voice\` 下 19:2x 之后的 wav 即新音色产物，5 条已放进包内 `samples/`。

## 2026-10-24 · v1.1.2：撤回不追回 + 群里明确要求就直发 + 查资料不再外发 + 好友申请不漏报

**撤回后不追旧消息（新 `lib/engine-recall.js`）**
- `main.js` notice 分支接 `group_recall`/`friend_recall` → `engine.onRecall()`；`recalled` 表存 10 分钟（上限 500）。
- 命中后：把被撤回内容从会话历史里剔除、作废在途回复（thinking 阶段直接 abort）、过滤排队消息、清 `_recentSent`（免得 45 秒去重把新回复吞掉）。
- 附带「轻回一句」：`recallWhisperEnabled`（默认开）、`recallWhisperChance 0.45`、`recallWhisperDelaySeconds 20`；三条条件都满足才发，台词池 7 句（≤10 字）。
- 探针 `POST /dsh-qq-whale/chat/recall-test`、`/state.recall`；单测 `tools/recall-test.mjs` 16/16 PASS。

**群里明确要求就当场发（新 `lib/group-echo.js`）**
- 判定 = 显式要求（「发群里/就在这儿说/别私聊」等 12 条）+ 300 秒内第二遍坚持（`groupEchoRepeatWindowSeconds`）+ 180 秒历史兜底；命中后本轮不推私聊。
- 投递：跳过 180 字截断（`echoRelax`）、按句分条（`planEchoBubbles`，≤400 字/颗、总 ≤1200 字），翻译/解释照实给；真代码/日志仍不上群。
- 配置 `groupEchoEnabled/groupEchoMaxBubbleChars/groupEchoMaxTotalChars`；单测 `tools/group-echo-test.mjs` 21/21 PASS。

**查资料不再自己往群里发（`lib/qqtools.js`、`lib/engine.js`）**
- research 期间给 client 挂 `__qqWhaleSendBlock` 计数，`send_group_msg`/`send_private_msg` 直接返回 `ok:false` + 「只给结论，由引擎发回原群」；任务文案同步写死。
- 命令（主人明确指定目的地）不受影响；真链路 probe `POST /research/test` 200 / 11.3s / SnowLuma 出站计数 996→996（确实没发）。

**好友申请不漏报（`lib/engine.js`、`lib/gatekeeper.js`）**
- `onRequest` 在 `user_id` 为 0/空时用 `friend:<flag>` 合成 key 照常登记 + 私聊主人；`/state.pending` 可见。
- 支持「通过 1 / 拒绝 2 / 同意第3个」按序号审批（`parseVerdict`），合成 key 不写 approved/denied 名单。

**音色默认值（`lib/voice.js`、`tools/voice-sovits-start.ps1`）**
- 参考文本与默认权重切到 `molly_own`（主人自录 54 句微调，2026-10-24）：`MOLLY_PROMPT_TEXT = '想的美，今天本鱼才是老大，你喝白开水去！'`，旧常量名 `DANIA_PROMPT_TEXT` 保留为别名；启动脚本默认权重改成 `molly_own-e10.ckpt` / `molly_own_e16_s864.pth` / `voice-ref\molly-ref.wav`。音色包本体走 Release `voice-pack-v1.0`（301 MB zip）。

**验证**：`tools/recall-test.mjs` 16/16、`tools/group-echo-test.mjs` 21/21 PASS；空跑探针 `recall-test` / `group-echo` / `research/test` / 好友申请均通过；部署热重载 `gen-mvmbqdse-c4p5tf`。

**怎么退**：`recallEnabled: false` / `groupEchoEnabled: false` 关功能；`qqtools.js` 删掉 `__qqWhaleSendBlock` 检查恢复原样；好友申请改动在 `onRequest`，恢复安装副本备份即可。

---

## 2026-10-24 · v1.1.1：语音显式触发 + 戳一戳回应 + 重复发消息根治

**语音显式触发（`lib/persona.js`、`lib/engine.js`）**
- 新增第四种合法标记 `<voice>…</voice>`（与 `<sticker>`、`<sep/>`、`<at>` 同级）：模型把想用声音说的话包进去，`splitReply` 产出 `{type:"voice",text}` 段，可与文字/表情包混排；`resolveVoiceRequests()` 用真 `VoiceMaker` 合成，**不看 `voiceChance`**，仍受 `voiceMaxChars 220` / `voiceMaxSeconds 58` 闸门。
- 触发场景写进系统提示词：对方明确要（发个语音/用语音说/说句话听听/让我听听你声音）、撒娇/凶他/道谢/道歉/想他、晚安早安短句、让念一段；禁止长回答/讲道理/列清单/带链接代码。
- 降级：语音关闭 / 23:50–09:00 静默 / 超字 / 不足 2 字 / 合成失败 → 该段原地变回文字，空宣告段丢弃，不会出现「说了发了语音却没发」。
- 假宣告根治：history 里的「（我发了一条语音：…）」与 `[语音:…]` 反向翻译回 `<voice>`，能合成就是真语音。
- 防重复：相同语音段去重；文字段与语音段同内容只留语音；`maybeVoice` 检测到已有 voice 段直接 return。

**戳一戳回应（新 `lib/poke.js`、`lib/main.js`）**
- `onOneBotEvent` 新增 notice 分支 → `engine.onNotice()` → `PokeReactor`（状态机，不走模型）：默认 180 秒窗口内第 4 次起生气（文案换凶档 + 90 秒冷却不回应）、反戳概率 0.7、附带说一句 0.45（独立掷骰）、两次反应最小间隔 8 秒。
- 准入同普通回复（`enabled`/`blindMode`/`allowedGroups`/`allowedUsers`/`switches.reply`）；戳的不是她不插话。
- 配置 `pokeEnabled/pokeBackChance/pokeSayChance/pokeAngryAfter/pokeAngryWindowSeconds/pokeCooldownSeconds/pokeAngryCooldownSeconds`（`main.js` DEFAULTS + schema；`cordis.patch.yml`），`/state.poke` 可回读。
- 修复真机 bug：构造函数时序让 `PokeReactor` 存了 `null` client（`Cannot read properties of null (reading 'sendGroupMsg')`）——改成取值函数 `client: () => this.client` + `_resolveClient()`，发送失败不计冷却，生气判断挪到普通冷却之前。

**重复发消息根治（`lib/qqtools.js`）**
- 症状：私聊命令她在群里发一句，同一句出现 2~4 条。
- 根因三层：干活 agent 在同一条 turn 的不同 step 用完全相同参数重复调 `qq_onebot send_group_msg`；`installReportCapture` 只拦 `runCommand` 会话 target；`checkToolLoop` 只认连续同参。
- 修复：出站幂等窗口 `SEND_DEDUPE_WINDOW_MS = 60000`，key = `action|目标|去标点小写正文`，`recentSends` 最多 200 条；窗口内同目标同文本的第二次调用直接返回上次 `message_id` 并提示模型别再发。只作用于 agent 调 `qq_onebot`，不影响引擎自己的聊天/命令投递与 `splitReply` 多气泡。

**验证**：`out\_voice_trigger_test.mjs` 16/16 PASS、真机语音链路 4.1s / 262444B wav、两群 60 条相邻同文重复 0 组；`out\_poke_test.mjs` 21/21 PASS、真机群戳 → 真回戳；真机 `/work/run` 私聊同句只发 1 条（`message_id -1233770797`）。

**怎么退**：提示词里删掉触发场景（或把 `voiceChance` 调 0 只留显式触发）；`pokeEnabled: false`（或删七个 poke 键）；`qqtools.js` 恢复安装副本备份 `lib/qqtools.js.bak-20261024-112902` → `plugin_manager` 切 `include:dsh-qq-whale`。

---

## 2026-10-23 · v1.1.0：记忆池扩容/去重/加密 + 语音时长放宽 + 模型链路可钉国内池

**记忆池（`lib/memory.js`、`lib/memcrypt.js`）**
- 上限可配且会自动长：`memoryPoolLimit`（默认 2000）→ 记满按 `memoryPoolMax`（默认 10000）渐进扩容，状态存 `memory-pool.json`，重启不回缩；`memoryLimit: 800` 那个老键是抽取节流，**不是池容量**。
- 写入去重：同一个人（同 `qq`；两边都没 `qq` 时同 `who`）+ 相似度 ≥ 0.7（表情包只认完全相同）→ 只留一条，**新的文本覆盖旧的**；历史数据可用 `dedupeAll()` 重跑。
- 加密落盘：`memory.json` 变 AES-256-GCM 信封（`{"version":2,"enc":"aes-256-gcm",...}`），`memory.md` → `memory.md.enc`；密钥默认 `keys/memory.key`（`memoryKeyFile` / 环境变量 `MOLLY_MEMORY_KEY` 可改），与数据分目录存放。
- 懒迁移：启动发现明文自动加密，改盘前先留 `*.plain.bak`；解不开则整池只读 `broken`，绝不写回覆盖唯一一份数据。
- 备份：`tools/backup-memory.ps1` 默认每 2 小时把记忆文件拷到 `D:\MollyBackup\memory` 与 `${MOLLY_ROOT}Backup\memory`（保留 48 份），密钥单独备份到两盘 `keys\`；`tools/install-memory-backup-task.cmd` 装计划任务。
- 控制台兜底：`GET /api/memory` 在旧 panel-data 读不到加密文件时，改走插件 `/memory/list`。

**语音（`lib/voice.js`）**：`voiceMaxChars` 42 → 220（≈56 秒），新增 `voiceMaxSeconds: 58` 产物时长闸门（超了退回文字），`voiceTimeoutMs` 20000 → 90000。

**模型链路（`lib/gateway.js`）**：新增 `gatewayRealm`（映射到 `X-Realm`），主脑 Realm 不再只由模型名硬钉；`/state.model` 回读 `realm` / `realmPinned`。国际版恢复后，删掉 `cordis.patch.yml` 里的 `gatewayRealm: "cn"` 即回到免费优先。

**怎么退**：`memoryPoolLimit: 800` + `memoryPoolMax: 0` + `memoryEncrypt: false`（**已加密的文件仍需密钥**，回退前先解回明文）、`voiceMaxChars: 42` + `voiceMaxSeconds: 0`、删 `gatewayRealm` 行 → `plugin_manager` 切 `include:dsh-qq-whale`。

---

## 2026-10-17 深夜 · 干活会话"写一次就坏"的根因（`lib/commands.js`）

**症状**：`/work/run` 每次都报
`stored session "qq-whale-work-111111111" failed validation:
session event at seq 8 message must have role "user"`，
而且删掉会话目录重建之后**下一次又坏**——说明不是历史遗留，是每次写入都在写脏。

**根因**：`agent.followup({ id, content, source })` 少了一个 `role: 'user'`。

链路是这样：`followup()` → `send()` → `inbox.splice()` 把消息塞进 pending →
`step()` 里 `this.session.append("user/message", message, {surfaceOp:"append"})`
**原样**把消息对象当成事件 data 写进日志。而写入时不校验字段，
`dsh-session/lib/index.js` 的 `adoptSessionEvent`（读取时才跑）会按
`MESSAGE_ROLE_BY_TYPE = { "user/message": "user", ... }` 校验 role，
对不上就整个会话判为损坏。

对照 DSH 自己写的 runtime-context 消息，data 形状是
`{ content, source, role: "user", id }` —— 我们缺的正是 role。

**修法**：`commands.js` 的 followup 调用补 `role: 'user'`，并在注释里记下这段因果，
避免以后有人"清理冗余字段"时又把它删掉。

**怎么退回**：删掉那个 role 字段即可退回（没理由退回）。

**连带清理**：损坏的会话目录已删
`${HOME}\.dsh\sessions\--C-Users-example-.dsh-profiles-desktop--\qq-whale-work-111111111`，
连同 `.corrupt-*` / `.old-*` 备份。

---

## 2026-10-17 深夜 · 查网状态可观测（`lib/web.js` + `lib/engine.js`）

「先查再说」是个**看不见的中间步骤**：她查到了回复里就有具体数字，没查到就是"不知道"，
而"不知道"有四种成因——真不知道 / 网络挂了 / 判定没命中 / 上游没给结果——在聊天里长得一模一样。
所以 `/state` 新增 `research` 字段：

```js
research: {
  enabled,      // 开关
  ok,           // researcher 是否可用（依赖干活会话）
  lastAt,       // 上一次判定时间
  lastNeed,     // 上一句判没判出"要查"
  lastReason,   // 命中哪条规则，如 "matched:天气|气温|..."
  lastFound,    // 查回来有没有内容
  lastMs,       // 耗时
  count,        // 本次插件加载以来查了多少次
}
```

`engine.js` 里对应新增 `this.lastResearch` / `this.researchCount`，
**只在真的进过判定时才写**（否则关掉查网后挂件上还挂着旧的 `need=true`，会让人以为开关没生效）。

另新增 `Engine.decideResearch(text)` 方法——把判定从 `generate()` 里抽出来，
好让 `POST /dsh-qq-whale/research/test` 能单独调用它。
实测跑通：`{"need":true,"reason":"matched:天气|...","found":true,
"summary":"今天上海阴天，当前约 23.8°C（体感 25.2°C），全天 21.4~28°C，降水概率 18%，湿度 76%。","ms":7154}`

**怎么退回**：删 `out.research` 块和 `lastResearch` 赋值即可，不影响聊天。

---

用户原话（m11614）：

> 1.感觉有点傻傻的，问啥东西都说不知道，既然接wb了应该能做些啥事了吧
> 2.把回复延时调短点
> 3.在左下角状态栏增加一个可看当前是什么模型在运行她
> 4.更新任务清单

### ① 先查再说（新增 `lib/research.js`）

| 项 | 内容 |
|---|---|
| 新增文件 | `lib/research.js`（约 250 行） |
| 改了 | `lib/engine.js`（import、构造 `this.researcher`、`generate()` 里调用、`buildSystemPrompt()` 加 `research` 参数） |
| 改了 | `lib/persona.js`（core.md 的「不懂就说不知道」补了一句"能查的先查"） |
| 改了 | `lib/main.js`（新增配置 `researchEnabled` / `researchTimeoutSeconds`） |
| 改了 | `lib/web.js`（`snapshot()` 新增 `active` 字段，见③） |

**它怎么工作**：收到消息 → `needsResearch()` 规则判定要不要查 → 要查的交给
干活会话（`CommandExecutor.run`，它有宿主全部工具）→ 拿回结论压成 220 字以内 →
塞进 system prompt 当"你刚查到的" → 她用自己的话说出来。

**三道保险**：
1. 只查强事实信号（天气/时间/「查一下」/是什么/是谁/新闻价格）
2. 超时 45 秒就放弃，**绝不阻塞回复**
3. 查不到照常聊天，不硬编

**回归测试**：`tools/research-verdict-probe.mjs` —— 21 条用例，
覆盖"该查的 8 条"和"闲聊误判 13 条"。改判定表后必跑。

**怎么关**：`cordis.patch.yml` 里 `researchEnabled: false`，或代码里
`this.researcher.enabled = false`。

### ② 回复延时调短（`lib/main.js`）

```diff
- typingCharactersPerSecond: 3.5   # 模拟真人手机打字
+ typingCharactersPerSecond: 7.5   # 20 字约 2.7 秒（原来 6 秒）
```

改的是 `DEFAULTS` 默认值。如果 `cordis.patch.yml` 里显式写了这个配置项，
以 yml 为准——**记得去看一眼**。

**怎么退回**：把 7.5 改回 3.5。

### ③ 左下角显示当前模型（`lib/web.js` + `assets/qq-widget.js`）

**后端**：`snapshot()` 新增 `active` 对象

```js
active: {
  degraded,          // 是否在降智模式（走 trae）
  provider,          // workbuddy-ai / trae
  model,             // deepseek-v4.1-flash
  flavor,            // cn / global（wbai 的计费档位）
  label,             // "deepseek-v4.1-flash · cn"
  reason,            // "正常免费额度" / "今日积分已用完，切到备用脑"
}
```

**顺带修的**：`main.js` 的 `recheckModel()` 原来只往 `state.model` 写
`ok/uid/expiresAt`，挂件拿不到模型名。现在补了 `model` / `flavor` / `fallback`。

**前端**：`assets/qq-widget.js`
- 新增 `.qw-dock` 横向容器，鲸鱼头 + 模型标签并排
- 新增 `.qw-model` 标签：常驻显示 `label`，降智态变黄色
- 面板展开时自动隐藏（详情在面板里，不重复）
- 面板里新增「当前模型」行 + 一行原因说明

**怎么退回**：删掉 `snapshot()` 里的 `out.active` 块和 widget 里的
`modelTag` / `dock` 相关代码（都在注释里标了 m11614-3）。

### 重载方式（怎么让改动生效）

```powershell
# 1. 同步到安装副本（五样全拷）
$src="${WORKSPACE}\qq-whale\plugin\dsh-qq-whale"
$dst="${HOME}\.dsh\profiles\desktop\node_modules\dsh-qq-whale"
Copy-Item "$src\lib\*" "$dst\lib\" -Force
Copy-Item "$src\persona\*" "$dst\persona\" -Force
Copy-Item "$src\assets\*" "$dst\assets\" -Force
Copy-Item "$src\package.json" "$dst\" -Force
Copy-Item "$src\cordis.patch.yml" "$dst\" -Force
```

```
# 2. 重载（必须两步，先关再开）
plugin_manager set_plugin include:dsh-qq-whale enabled=false
plugin_manager set_plugin include:dsh-qq-whale enabled=true

# 3. 验证
GET http://127.0.0.1:19387/dsh-qq-whale/state
# 期望看到 active 字段
```

---

## 2026-10-17 晚 · 群里回谁就 @ 谁（`lib/engine.js#deliver`）

用户原话（m11335）：「他她真的分得清楚群里同时跟他说话的人吗，要不然加一个回谁@谁好了」

原来代码里有个空的占位分支（`text = text`），随机数都生成了但什么都没干。

| 场景 | @ 概率 |
|---|---|
| 被 @ / 被回复（`group_mention`） | 82% |
| 旁观插话（`group_bystander`） | 22% |
| 私聊 | 0 |

只 @ 第一条气泡（后面连发的不重复），且跳过 @ 自己。

---

## 2026-10-17 晚 · 命令链路三修（`lib/commands.js` + `lib/engine.js`）

1. **`{{cwd}}` 缺值** → `agents.create()` 没传 `meta.cwd`。补上，并用
   `safeCwd()` 挑一个真实存在的目录。
2. **429 限流** → 接到第三层兜底：换 flavor → 低频重试 → trae 接盘 → 说句人话。
3. **`throwError` 被吞** → 加了监听。之前任何失败在 QQ 里都只显示
   「干完了，但没说话」。
