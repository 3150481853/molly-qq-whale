# 变更日志（插件 / 配置 / 外部程序）

> 谁改了什么、为什么改、怎么退回去。用户原始要求（m00001）：
> 「记得记录你搞了什么插件，方便出问题能还原」。
>
> 一条一条按时间倒序记。新增条目写在最上面。

---

## 2026-10-25 · v1.1.3-Hotfix.1：入站语音转文字（别人发的语音她终于「听」得见了）

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
