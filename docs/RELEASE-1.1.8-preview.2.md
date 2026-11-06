# Molly 1.1.8-preview.2 · 「总是回下一条」：被打断的那条不再被丢掉

> 基线：`1.1.8-preview.1`（2026-11-05）
> 本版：`1.1.8-preview.2`（2026-11-06）
> 范围：只动插件侧（`plugin/dsh-qq-whale`）五个文件——调度与分条（`lib/engine.js`）、引用目标（`lib/quote-at.js`）、提示词与认人（`lib/engine-context.js`）、分条（`lib/persona.js`）、关系印象（`lib/relations.js`）。控制台、桌面外壳、记忆内核与 1.1.7 一致。

---

## 一、现象

主人在群里连发两句：

```
18:09:46  为什么总是回下一条
18:09:54  [一张 The Rock 表情图]
18:10:27  Molly：「这哪说得清，我眼睛一看到下一条就先冲出去了……」  ← 引用框挂在表情图上
```

第一句**从头到尾没有被回答过**；她的回复既答的不是第一句，引用框也只挂在第二句上。她自己那句话（「反正我就这么一路错下去了」）其实已经描述得很准：不是她故意答下一条，是**上一条在她开始想的时候就已经被扔了**。

## 二、根因（两层）

### 1. 调度层：同泳道「新消息直接 abor
t 旧的」

`lib/engine.js` 的 `scheduleReply()` 里，同一个 `conv.key + lane` 只允许一个 job 在跑：

```js
if (existing?.phase === 'thinking') existing.controller.abort()   // 旧 job 直接死
```

被 abort 的那一轮**只留下统计里的 `aborted`**，它携带的 `ev / norm` 没有任何地方保存——那条消息于是永久失去被回答的机会。实测（`/state.replyTrace`）：

| 时间 | 事件 |
| --- | --- |
| 18:09:46 | `start(bystander)` ← 「为什么总是回下一条」 |
| 18:09:54 | `start(bystander)` ← 表情图，**上一个 job 被 abort** |
| — | `model-null` → `aborted(where=generate)` |
| 18:10:27 | `delivered(ms 33360, parts 2)` |

一轮生成要 30–58 秒（`metrics.avgReplySeconds = 19.8`，慢的时候 45–58 秒），所以「生成期间主人再补一句」几乎必然发生，abort 也就几乎必然发生。

### 2. 交付层：引用目标跟着「最新那条」走

`lib/quote-at.js` 的 `pickQuoteTarget()` 原来有三处会把引用推到「下一条」上：

| 分支 | 旧行为 | 为什么是错的 |
| --- | --- | --- |
| `nudge`（纯 @ / 纯图叫醒） | 先 `lastMessageFrom(caller)`，但**叫醒那条本身也在历史里**，判定 `mine.messageId === triggerId` 后被跳过 → 退到 `lastOtherMessage`（群里最后说话的人） | 11-05 加的「引叫你的人自己上一条」其实是**死代码**，永远走不到 |
| 兜底 | 触发条被刷过 ≥2 条就改引 `newest` | 生成要 20–60 秒，这个条件几乎恒成立 → 引用永远落在最新那条 |
| `crowded` | 引触发消息 | 答的是新话题，引用停在旧话题 |

叠在一起就是主人看到的样子：**回的永远是最后一条，引用也永远挂最后一条。**

## 三、改了什么

### 1. 被打断的消息，合并进下一轮（`lib/engine.js`）

- `scheduleReply()` 给每个 job 存一份 `trigger = { ev, norm, scene, userName, groupName, at }`；
- 同泳道 abort 时 `this.stashCarry(jobId, existing.trigger)`，按 `conv+lane` 攒；
- 下一轮 debounce 结束后 `const carry = this.takeCarry(jobId, ev)`（放在 debounce **之后**取，避免 debounce 阶段再被打断时把 carry 弄丢）；
- 过滤规则：**同一个人**（`user_id` 相同）且 **20 秒内**、最多 3 条——群里 A/B 交替说话时不会被硬凑成一句；
- `generate()` 签名单增 `carry`，`deliver()` 单增 `anchorId`（这串里的**第一条**）。

### 2. 提示词明确「这一轮要接的是哪几条」（`lib/engine-context.js`）

`buildSystemPrompt()` 新增「# 这一轮你要接的是这几条」段（`thisTurn` ≥ 2 条时才输出）：

```
1. [18:09] 主人：为什么总是回下一条
2. [18:09] 主人：[图片]

**先回答第 1 条里问的那件事**，再顺带看后面补的。
别只接最后一条，也别把两条当成一句话答。
引用框已经钉在这串的第一条上。
```

同时把原先与它冲突的群体噪声段改口径：从「这条回复**只接最近的那一条**」改成「只接一个人：接那个真正在跟你说话的人、接他那句正事」。

### 3. 引用框钉在这一轮的正题上（`lib/quote-at.js` + `lib/engine.js`）

- `pickQuoteTarget()` 新增输入 `anchorId` 与输出 `anchored`；优先级变成
  `explicit-at > anchor > nudge > 触发条（≤1 条之内）> newest`；
- `deliver()` 里 `quoteStale = gap >= 4` 的丢弃规则**对 anchor 豁免**——否则刚修好的「被顶掉那条」又会因为 gap 大而不挂引用；
- `lastMessageFrom()` / `lastOtherMessage()` 新增 `excludeId`：`nudge` 分支现在排除「叫醒那条」去找**叫他的人真正的上一条**，11-05 的死代码被修活。

### 4. 可观测

`stats` 新增两个计数器：

| 字段 | 含义 |
| --- | --- |
| `carryMerged` | 被打断后合并进下一轮的消息条数 |
| `quoteAnchored` | 引用框钉在「这一轮正题」上的次数 |

`replyTrace` 新增 `carry` 阶段（带 `n` 与 `anchor`）。

### 5. 一条一句：不再把两句话揉进一个气泡（`lib/persona.js` + `lib/engine.js`）

用户原话（2026-11-06 晚）：「不要多句话揉在一起，分开回复」。真机证据：群 666666666 里她发的是

```
发死老鼠这事，我代表大肥鱼谴责一下
鹈鹕你今晚的白饭没了，让我饿着陪你看图
```

一个气泡里两句话。根因在 `splitReply()`：文本块只按 `<sep/>` 切，**换行整段留在同一条**。

现在换行也是分隔符，一行一条；新增 `maxTextBubblesPerReply`（默认 5，`cordis.patch.yml` 可配），超出的并回最后一条，避免从「挤在一起」变成「刷屏」。提示词同步改成「要分几条发就用 `<sep/>` 或者换行隔开——一条一句」。

### 6. 印象里的「主人」只对主人成立（`lib/relations.js` + `lib/engine-context.js`）

`relations.json` 里 `group:666666666:3329150495`（白日梦制造商）的 impression 写死了一条「他是你的主人」，每轮都渲染成「你对他的印象：- 他是你的主人」，把 11-05 那段「他不是你主人」的护栏盖掉。

现在 `contextFor()` 接收 `ownerQq`：印象文本里提到「主人」时，只有说话人 QQ 等于 `ownerUin` 才喂进提示词，其余一律过滤。

## 四、验证

| 测试 | 结果 |
| --- | --- |
| `tools/test-quote-anchor.mjs`（新增，含复刻 18:09 现场与 nudge 排除触发条） | **33 / 33** |
| `tools/test-carry.mjs`（新增：取出/清空/不同人不合并/超 20 秒不合并/最多 3 条/顺序） | **7 / 7** |
| `tools/test-this-turn.mjs`（新增：两条时输出该段并编号、单条不输出） | **5 / 5** |
| `tools/test-split-reply.mjs`（新增：换行分条、`<sep/>` 混用、空行、`<br>`、上限 5、上限可调、`@` 仍挂第一条） | **8 / 8** |
| `tools/test-relations-owner.mjs`（新增：非主人不渲染「主人」、主人保留、无关印象照常、不传 ownerQq 保守过滤） | **4 / 4** |
| `tools/test-engine-text.mjs` | **7 / 7** |
| `tools/test-quote.mjs` | **32 / 32** |
| `node --check`（改动的 5 个 lib 文件） | 通过 |

重启后验收口径：

- `/dsh-qq-whale/state` → `stats.carryMerged > 0`（连发时）；
- `stats.quoteAnchored > 0`，`quoteLast.why` 出现 `anchor`；
- `replyTrace` 里出现 `carry` 阶段，`aborted(where=generate)` 后面紧跟的 `delivered` 带 `parts ≥ 1` 且不再「只答最后一条」。

## 五、已知限制

- carry 只合并**同一人、20 秒内、最多 3 条**；跨人连发不会被合并（故意，避免把别人的话算到主人头上）；
- 若一轮在 debounce 阶段被打断（`aborted(where=debounce)`），carry 依然成立（takeCarry 在 debounce 之后取）；
- 模型仍然可能无视提示词去答最后一条——这是概率问题，不是必定；`quoteAnchored` 与 `carryMerged` 就是用来量化它到底听不听的；
- 引用框只会挂在**第一颗气泡**上（一轮回复拆成多颗时，后面几颗本来就没有引用框，属于既有行为）；
- 「一条一句」之后**条内换行没有了**：模型要用多行排版的内容会变成多条气泡；想调整连发条数改 `maxTextBubblesPerReply`（默认 5），设 1 就退回「一条消息装全部」的旧行为。

## 六、怎么退回

1. 只退「合并」：把 `scheduleReply()` 里 `this.takeCarry(jobId, ev)` 改成 `[]`，其余不变；
2. 只退「anchor」：`deliver()` 调用里去掉 `anchorId` 参数（`pickQuoteTarget` 的 anchor 分支没有输入就不会命中）；
3. 全退：用 1.1.8-preview.1 的三个文件覆盖回去（`lib/engine.js`、`lib/quote-at.js`、`lib/engine-context.js`），重启 DSH。

## 七、升级方式

- 源码部署：覆盖 `plugin/dsh-qq-whale/lib/` 三个文件 → **重启 DSH**（插件模块在宿主内，不会热更）；
- 用 zip：解压覆盖同名目录，同样重启；
- 与 1.1.8-preview.1 相比，控制台 / 桌面外壳 / 记忆内核无差异（版本号除外）。
