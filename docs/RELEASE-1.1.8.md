# v1.1.8 发布说明（2026-11-08）

> 上一正式版：`v1.1.7`。本版把「回复错位」这一类问题一次收干净：被打断的那句不再丢、同一个人连发只答一次、引用框永远落在这轮真正该引的那条上；并定下两条行为规则——**一条一句**、**命令与状态回执不接话**。
>
> 技术记录：`docs/quote-anchor-carry-2026-11-06.md`、`docs/quote-target-and-owner-naming-2026-11-05.md`。

## 一、修了什么

### 1. 「总是回下一条」：被打断的那句不再消失
一轮回复要生成 20–60 秒，这期间同一会话再来消息就会 abort 上一轮，原来那条消息**永久没人回答**，她最后回的、引用框挂的永远是后一条。

- `scheduleReply()` 现在把每轮的触发消息存下来，abort 时 `stashCarry()` 留存，下一轮 debounce 结束后 `takeCarry()` 取回并合并（**同一个人、20 秒内、最多 3 条**）；
- 提示词新增「# 这一轮你要接的是这几条」（≥2 条时编号列出，要求先答第 1 条）；
- `pickQuoteTarget()` 新增 `anchorId`，引用框钉在这一轮的正题上；
- `quoteStale`（gap ≥ 4 丢弃引用）对 `anchored` 命中豁免，否则刚接回来的正题又不挂引用。

### 2. 同一个人连发，只答一次（双泳道去重）
`@我` 的 targeted 泳道和闲聊的 ambient 泳道会各开一轮、互不知情，同一件事在群里回两遍、引用各挂一条。

- 新增 `laneMergeDecision()`：半分钟内同一个人两条道撞车时，`@我` 赢、闲聊让位；
- 新增 `rememberAnswered()` / `alreadyAnswered()`：记「这几条答过了」，含同一人窗口内的历史消息；
- `carry` 的 key 从 `jobId` 改成**会话 key**，跨泳道能接上；
- trace 新增 `lane-merge` / `lane-yield` / `skip-covered`。

### 3. 引用框不再挂错人、错条
- `pickQuoteTarget()` 优先级改为 `explicit-at > anchor > nudge > 触发条(≤1) > newest`；
- `lastMessageFrom()` / `lastOtherMessage()` 支持 `excludeId`——「空叫醒」时终于能正确地找被叫醒者真正的上一条；
- 模型写的 `<at>` 号要过 `resolveExplicitAt()` 校验（名册里不存在就不认）。

### 4. 只发一张图、一条语音时，引用框挂在它自己身上
真机现象：管理员只发一张截图、一个字没打，她的回复却引用了两分钟前别人另一张图。

根因：`isPureNudge()` 只统计 text 段实字，纯图片消息实字数恒为 0，被判成「空的叫醒」。

- `image` / `mface` / `record` / `video` / `file` / `forward` / `ark` / `json` / `xml` / `music` / `contact` / `markdown` / `lightapp`（含 `raw_message` 里的同名 CQ 码）一律算「有内容」，不算叫醒；
- `pickQuoteTarget()` 新增 `media` 理由：这类触发照样挂引用，且挂在它自己身上。

### 5. 命令 / 状态回执不接话
群里不止一个机器人时，`#茶茶` 这类命令换来的一行「茶茶（987654321） · 在线 · v1.1.7-preview.1 · 已运行 1天22小时」会被当成普通群消息起一轮回复；那一轮被打断后回执进了 carry，下一轮的锚点就成了状态行——她说的话全对，引用框却挂在系统信息上。

- 新增 `looksLikeEchoLine()`：整条就是 `#xxx` / `/xxx` 指令，或「括号里 5–12 位 QQ 号 + 在线/离线/已运行等状态词 + `·`/`・`/`|`/`｜` 分隔符」三条件同时成立，才算回执（普通人说「我（123456）现在在线呢」不会误判）；
- `shouldRespond()` 之前加闸口：群聊命中直接不接，trace 记 `skip-echo`；
- `stashCarry()` 过滤回执，不许它当下一轮的锚点。

### 6. 印象里的「主人」只对主人成立
`relations.json` 里一条「他是你的主人」会让每个说话的人都被当成主人。

- `RelationStore.contextFor(key, { ownerQq })`：印象里提到「主人」时，只对该印象所属的人**就是主人本人**时才渲染；
- 认人护栏（「他不是你主人」「不许叫主人/老板/主子/老爷」）继续兜底。

## 二、行为变化（能直接感觉到的）

- **一条一句**：不再把两句话揉进一个气泡，换行即分条，默认最多 5 条（`maxTextBubblesPerReply`）；
- **引用更克制也更准**：只在人多时挂，挂的是这轮的正题；
- **不接机器话**：别人发命令、别的机器人刷状态，她不出声；
- **连发不重复**：同一个人半分钟内先闲扯再 `@` 她，并成一轮回答。

## 三、可观测（新增）

`/dsh-qq-whale/state` 的 `stats` 新增：

| 字段 | 含义 |
| --- | --- |
| `carryMerged` | 被打断的消息被合并进下一轮的次数 |
| `quoteAnchored` | 引用框钉在正题（anchor）上的次数 |
| `replyStarts` / `replyDelivered` / `replyAborted` | 回复轮次：开始 / 送达 / 被打断 |
| `modelNull` | 模型返回空内容（没生成出东西）的次数 |
| `skipEcho` | 因「命令 / 状态回执」被跳过的消息数 |

`replyTrace` 新增阶段：`carry`、`lane-merge`、`lane-yield`、`skip-covered`、`skip-echo`。

回复流水另落盘一份：`<dataDir>/trace/replies-YYYY-MM-DD.jsonl`（一天一个文件，进程重启不丢，用来算空回复率这类比例）。

## 四、验证

| 测试 | 结果 |
| --- | --- |
| `tools/test-quote-anchor.mjs`（引用优先级、nudge 排除、内容段不算叫醒、命令回执识别） | **51 / 51** |
| `tools/test-lane-dedupe.mjs`（撞车裁决、答过别再答、跨泳道 carry） | **18 / 18** |
| `tools/test-carry.mjs`（取出/清空/不同人/超 20 秒/最多 3 条/顺序） | **7 / 7** |
| `tools/test-split-reply.mjs`（换行分条、`<sep/>` 混用、上限、`@` 挂第一条） | **8 / 8** |
| `tools/test-this-turn.mjs`（「这一轮要接的几条」输出） | **5 / 5** |
| `tools/test-relations-owner.mjs`（主人印象只对主人生效） | **4 / 4** |
| `tools/test-engine-text.mjs` | **7 / 7** |
| `tools/test-quote.mjs` | **32 / 32** |
| `tools/test-command-fixes.mjs` | **12 / 12** |
| 记忆内核：`test-memory-graph` / `test-memory-quality` / `test-memory-pending` | 25 / 55 / 25 |
| `node --check`（改动的 lib 文件） | 通过 |

重启后的验收口径：

- `/dsh-qq-whale/state` → `stats.carryMerged`、`stats.quoteAnchored` 会随群聊递增；
- 有人连发时 `replyTrace` 出现 `carry`；同一人先闲聊再 `@` 时出现 `lane-merge` / `lane-yield`，群里只有一轮回复；
- 有人发 `#xxx`、别的机器人回状态行时出现 `skip-echo`、`stats.skipEcho` 递增，她不接那行；
- `stats.modelNull / stats.replyStarts` 即空回复率，长期数字看 `<dataDir>/trace/replies-*.jsonl`。

## 五、已知限制

- carry 只合并**同一人、20 秒内、最多 3 条**；跨人连发不合并（故意，避免把别人的话算到主人头上）；
- 「一条一句」之后**条内换行没有了**，需要多行排版的内容会变成多条气泡；`maxTextBubblesPerReply` 设 1 即回到旧行为；
- 去重有代价：半分钟内先闲扯再 `@` 她，那句闲聊会被并进回答（`laneMergeMs` 调小可放宽，设 0 可关闭）；
- 只发图/语音时引用挂在消息本身；若其后又被刷两条以上，引用改挂最新那条；
- 回执识别是**按文本特征**判的：别的机器人用别的格式刷状态（不带括号 QQ 号或不用分隔符）仍会漏，漏了就往 `looksLikeEchoLine()` 里加一条判据；
- 模型仍可能无视提示词去答最后一条——概率问题，`quoteAnchored` / `carryMerged` 就是用来量化它的。

## 六、怎么退回

1. 只退「合并」：`scheduleReply()` 里把 `takeCarry` 的返回值改成 `[]`；
2. 只退「anchor」：`deliver()` 调用里去掉 `anchorId`（anchor 分支没有输入就不会命中）；
3. 只退「双泳道去重」：`config.laneMergeMs` 设 0，并去掉 `alreadyAnswered` / `rememberAnswered` 两处调用；
4. 只退「图片触发不挂错引用」：删掉 `isPureNudge()` 开头那句 `if (hasContentSegment(segs)) return false`；
5. 只退「回执不接话」：删掉 `scheduleReply()` 里 `looksLikeEchoLine(norm?.text)` 那段闸口（`stashCarry` 的过滤可保留）；
6. 全退：用 `v1.1.7` 的 `lib/` 覆盖回去，重启 DSH。

## 七、升级方式

- **源码部署**：覆盖 `plugin/dsh-qq-whale/lib/` 里改动的文件 → **重启 DSH**（插件模块在宿主内，不会热更）；
- **用 zip**：解压覆盖同名目录，同样重启；
- 与 `v1.1.7` 相比，控制台 / 桌面外壳有增量（问题反馈页、在线时间页、体检卡与两列布局），记忆内核同步小改（核心条目排序、群聊点名召回）；数据结构不变，无需迁移。
