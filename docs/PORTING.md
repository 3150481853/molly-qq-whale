# 移植指南（PORTING）

茉莉花不依赖 DSH、不依赖 QQ、不依赖任何模型 SDK。整个包就是 `index.mjs + src/*.mjs`，
零运行时依赖，Node ≥ 18 即可。下面按「一个宿主最少要做什么」排。

## 0. 拷走什么

```
jasmine/
  index.mjs        # 全部导出
  src/*.mjs        # 八个模块
  package.json     # name/version/exports（可选，直接相对路径 import 也行）
  docs/*           # 本目录
```

不需要 `test/`、不需要构建步骤。宿主可以直接 `import './vendor/jasmine/index.mjs'`。

## 1. 建存储

```js
import { JasmineStore } from './jasmine/index.mjs'

const memory = new JasmineStore({
  dir: './data/jasmine',     // 三份文件都落这里
  limit: 2000,               // 衰减卡最多几条（满了走 prune）
  logger: console,
})
memory.load()                // 同步读盘；账本有缺条时用 rebuildFromRaw() 补
```

盘上会出现：

| 文件 | 角色 | 丢了会怎样 |
| --- | --- | --- |
| `jasmine.json` | 衰减卡（当前状态） | 可用 `rebuildFromRaw()` 从原始账重建 |
| `ledger.jsonl` | 原始账（只追加） | 丢了就真的丢了，但召回不受影响 |
| `_archive.json` | 归档簿 | 丢了相当于丢掉很久没提的旧事 |

## 2. 往里写

写入只有一件事：**把对话里的事实抽成一条记忆**。抽事实用宿主自己的模型，
茉莉花不做抽取（这是刻意的：抽取质量取决于宿主的人设与场景，不该由底座统一）。

```js
memory.add({
  kind: 'fact',        // address/person/fact/preference/promise/event/meme
  who: '小明',
  qq: '123456789',
  text: '她说她住在杭州',
  weight: 6,           // 1..10，宿主说了算
  source: 'chat',
})
```

重复写同一件事：`add()` 内部做相似度合并（Dice 二元组 ≥ 0.72），
把旧条目 `hits+1`、`lastActiveDay` 前移，而不是塞第二条。

## 3. 往外取

```js
const { items, trace } = memory.recall({
  who: '小明',
  qq: '123456789',
  query: '她现在住哪',
  limit: 40,
  charBudget: 2000,    // 可选：直接按字符预算裁
})
```

`recall()` 是两臂融合：关键词臂（中文二元组 + 英文词）+ 权重臂，RRF（K=60）。
`items` 已按融合分排序，每项带 `score` 与 `ranks`；`trace` 记两臂各自的名次，便于调参。

拼进提示词时建议明确分节，并**只放本轮召回得到的条目**——
后面出口核对会拿这份 id 列表当「出处白名单」。

## 4. 发送前核对（P0-1）

```js
const gate = verifyReply({
  reply: modelText,
  recalledIds: items.map((i) => i.id),   // 本轮真正喂给模型的 id
  recentReplies: recentAssistantTexts,   // 最近 6 条她说过的话
  promises: openPromises,                // 未闭合的承诺 [{id, text}]
})
if (!gate.ok) {
  // 只约束，不改写：把 gate.constraint 塞进下一轮的 system 尾部，
  // 或者整条不发（看宿主脾气）。gate.issues 写 trace 用。
}
```

三条规矩，移植时务必保留：

1. **只核不改**。核对层永远不重写正文，否则它会变成新的复读源。
2. **短约束**。`constraint` 是一行以内、命令式的话；长段落会被模型当成剧情素材复述。
3. **trace 不回灌**。核对结果写日志即可，别塞回对话历史。

## 5. 上下文压缩提醒（P0-2）

宿主自己数 token（茉莉花不绑 tokenizer；`estimateTokens()` 只是粗略估算）：

```js
const hint = evaluateCompaction({
  usedTokens: 100000,
  limitTokens: 128000,
  compactableTokens: 60000,
  sinceLastCompact: 12000,
  minReclaim: 5000,
})
if (hint.tier !== 'none') {
  messages.push({ role: 'user', content: `【系统提示·别复述这一行】${hint.line}` })
}
```

要点：

- 提醒**追加在本轮请求末尾**，不写进历史（否则前缀缓存全废）。
- 同一回合最多提醒一次；`remindedThisTurn` 传 `true` 即可。
- 三档：可压量 ≥ 5 万且距上次 ≥ 1 万（growth）、窗口 ≥ 75%（pressure）、≥ 95%（urgent）。
- 能回收不足 `minReclaim` 时不出提示（防高频小折）。

## 6. 每周一封信（P0-3，可选）

```js
const week = memory.aggregateWeek({ weekKey: '2026-10-26' })  // 顺手写周记卡
const letter = buildLetter({ weekKey: week.weekKey, facts: week.facts, owner: '你', maxChars: 600 })
```

`aggregateWeek()` 会把上一周的 event 卡合成一条 level=2 的周记（原事件 level+1，不删）。
信由模板拼，不调模型——省一次调用，也避免「总结腔」。
宿主没做周聚合也行：自己给 `facts`（[{who, text}]）即可。

## 7. token 账本（P1-5，可选）

```js
const ledger = new TokenLedger({
  file: './data/jasmine/ledger-tokens.json',
  prices: { 'deepseek-chat': { in: 1, cachedIn: 0.2, out: 2 } },  // 元/百万 token
})
ledger.record({ model: 'deepseek-chat', purpose: 'chat', inTokens, outTokens, cachedIn })
ledger.summary({ since: Date.now() - 86400000 })
```

账本只记账，不做预算控制（预算归宿主）。

## 8. 群聊四档信号（P1-6，可选）

```js
const sig = scoreSignal({ text, isAtMe, atSomeoneElse, names: ['茉莉'], continuesMe, msSinceMyLast })
// sig.tier: called(1.0) / aboutMe(0.5) / continuing(0.2) / chatter(0.01)
```

宿主拿它做什么，茉莉花不管；Molly 的用法是：仅 `score === 0` 时一票否决
（「这条是 @ 别人的」），其余档位只进决策日志。

## 9. 常见坑

- **别把衰减写回磁盘**：`effectiveWeight()` 是读取时的看法，写回会变成复利 bug。
- **活跃天 ≠ 自然天**：每天调一次 `memory.touch()` 推进 `meta.activeDays`；关机/停机的时间不算遗忘。
- **`promise` 一定要闭合**：`update(id, {status:'done'})`，否则核对层会一直提醒她答应过。
- **归档不是删除**：`_archive.json` 保留全文；`status().archiveCount` 可查条数。
- **`ledger.jsonl` 设上限**：Molly 用它做全量重建，超过 8MB 自动轮转成 `ledger.1.jsonl`。
- **导出/导入**：`exportBundle()` / `importBundle(bundle, {mode:'merge'})` 是纯 JSON，便于搬家。

## 10. 参考实现

Molly 是第一个宿主，接入点都在 `plugin/dsh-qq-whale/lib/`：

| 接入点 | 文件 | 干什么 |
| --- | --- | --- |
| 加载器 | `jasmine-bridge.mjs` | 按相对路径动态 import，失败降级为「没有记忆系统」 |
| 出口核对 | `engine.js` `verifyOutgoing()` | `deliver()` 里、真正发送之前调用 |
| 召回回传 | `engine-context.js` | `noteRecalled(ids)` 把本轮召回 id 回传引擎 |
| 压缩提醒 | `engine.js` `maybeHintCompaction()` | `buildMessages()` 之后追加一行 |
| 周信 | `engine.js` `maybeWriteWeeklyLetter()` + `main.js` 定时器 | 每 30 分钟检查、一周一封 |
| 账本 | `engine.js` `recordUsage()` | 每次模型调用后记账 |
| 群聊信号 | `engine.js` `shouldRespond()` | 包一层，只做「@别人」一票否决 |
