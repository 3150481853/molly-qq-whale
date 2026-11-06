# 2026-11-06 · 被打断的那条不再被丢掉（quote anchor + carry）

> 关联：`docs/quote-target-and-owner-naming-2026-11-05.md`（上一轮修的是「引用挂错人、乱叫主人」）。
> 本轮修的是**它的残余**：引用不再挂错人，但永远挂在「下一次说话」上——因为**上一句在开始生成时就被 abort 扔掉了**。

## 一、现场（2026-11-06 18:09，群 666666666）

主人连发：

```
18:09:46  为什么总是回下一条
18:09:54  [The Rock 表情图]
```

`/dsh-qq-whale/state` 的 `replyTrace`：

| 时间 | 事件 |
| --- | --- |
| 18:09:46 | `start(bystander)` |
| 18:09:54 | `start(bystander)` |
| — | `model-null` |
| — | `aborted(where=generate)` |
| 18:10:27 | `delivered(ms 33360, parts 2)` |

`stats.quoteLast = { id, why: "nudge", gap: 0 }`；`lastReplyDiag.text` 是「我眼睛一看到下一条就先冲出去了」。

结论：**第一句从未被回答**；第二句触发 abort，回复与引用都落在第二句。

## 二、根因

### 1. `scheduleReply`：同泳道 abort 即丢弃

`lib/engine.js`（原 4840-4843）：

```js
if (existing?.phase === 'thinking') {
  existing.controller.abort();
}
```

只 abort，不保存、不合并 → `ev / norm` 随 job 一起销毁。而一轮生成要 **20–58 秒**（`metrics.avgReplySeconds = 19.8`，慢时 45–58 秒），所以「生成期间再来一条」几乎必然发生。

### 2. `pickQuoteTarget`：三处把引用推向「最新那条」

- `nudge`：先找 `lastMessageFrom(caller)`，但**叫醒那条自身也在 history 里**，`mine.messageId === triggerId` 被跳过 → 退到 `lastOtherMessage`（群里最后说话的人）。11-05 号称修好的「引叫你的人自己上一条」是**死代码**。
- 兜底：触发条被刷过 ≥2 条就改引 `newest`——生成 30 秒，这个条件恒成立。
- `crowded`：引触发条，答的却是新话题。

## 三、改动

| 文件 | 改动 |
| --- | --- |
| `lib/engine.js` | `scheduleReply` 给 job 存 `trigger`；abort 时 `stashCarry(jobId, existing.trigger)`；debounce 后 `takeCarry(jobId, ev)`（同人 + 20 秒内 + 最多 3 条）；`generate` 收 `carry`，`deliver` 收 `anchorId = carry[0].ev.message_id`；`pickQuoteTarget` 传 `anchorId`；`quoteStale` 对 `anchored` 豁免 |
| `lib/quote-at.js` | `pickQuoteTarget` 新增 `anchorId` 入参 / `anchored` 出参，优先级 `explicit-at > anchor > nudge > 触发条(≤1) > newest`；`lastMessageFrom` / `lastOtherMessage` 新增 `excludeId`，nudge 分支排除触发条 |
| `lib/engine-context.js` | 新增「# 这一轮你要接的是这几条」段（`thisTurn` ≥2 条时编号列出，要求先答第 1 条）；群体噪声段的「只接最近的那一条」改成「只接一个人、接他那句正事」 |

统计：`stats.carryMerged`（合并条数）、`stats.quoteAnchored`（引用钉在正题的次数）；`replyTrace` 新增 `carry` 阶段。

## 四、验收

- `tools/test-quote-anchor.mjs`（33）、`tools/test-carry.mjs`（7）、`tools/test-this-turn.mjs`（5）、`tools/test-engine-text.mjs`（7）全绿；
- 重启后：`stats.carryMerged > 0`、`stats.quoteAnchored > 0`、`quoteLast.why` 出现 `anchor`、`replyTrace` 出现 `carry`；
- 抽样看回复是否「先答第 1 条」，而不是只答最后一条。

## 五、退回

见 `docs/RELEASE-1.1.8-preview.2.md` 第六节：可单独退「合并」（把 `takeCarry` 改成 `[]`）或「anchor」（不传 `anchorId`），或整包退到 1.1.8-preview.1 的三个文件。
