# Molly 1.1.8-preview.1 · 引用挂错与称呼乱叫主人的修复

> 基线：`1.1.7`（2026-11-05）
> 本版：`1.1.8-preview.1`（2026-11-05）
> 范围：只动插件侧（`plugin/dsh-qq-whale`）——引用目标、悬空引用拦截、身份与称呼提示词、一个过期测试断言。控制台前端、桌面外壳、记忆内核与 1.1.7 完全一致。

---

## 一、问题是什么

### 1. 引用挂错

群里聊天被刷屏时，Molly 的回复会「挂错引用」：内容回答的是新话题，引用气泡却停在几分钟前那条。被引的人可能根本没说这句话，看起来像她在乱回。

拆开看，只有三种情况会挂引用（`lib/quote-at.js` 的 `pickQuoteTarget()`）：

| 触发 | 旧逻辑引谁 | 错在哪 |
| --- | --- | --- |
| 纯 @ 无正文（`nudge`） | `lastOtherMessage`（群里最后说话的人） | 引到「最后说话的人」，常常不是叫她的人 |
| 模型写了 `<at>`（`explicit-at`） | `lastMessageFrom(history, qq)` | 引「那个人最近一条」，不是被回答的那一条 |
| 30 秒内 ≥3 条 ≥2 人（`crowded`） | `ev.message_id`（触发消息本身） | 生成这几秒里又进来新消息 → 答新的、引旧的 |

### 2. 乱叫主人

她会对普通群友叫「主人」。不是记忆写错，而是提示词缺两件事：

- 称谓段（`lib/engine-context.js`）整块包在 `if (addrItems.length)` 里，`addrItems` 来自 `memory.addressOf()`。全库 5,645 条记忆里 `kind=address` 只有 7 条，**剩下几百人根本看不到那句「别把谁都叫成主人」**；
- 提示词里**从来没写主人是谁**。含「主人」的记忆 37 条里 32 条是别人的转述——例如「他管 ID 3329150495 叫「主人」」「我勒个大坝怎么全在叫主人」。模型读到的意思是「这个人要被叫主人」。

---

## 二、改了什么

### 1. 引用目标重写（`lib/quote-at.js`）

`pickQuoteTarget()` 重写，新增 `users` / `usableId()` / `indexOf()` / `newest` 与返回字段 `gap`：

- `explicit-at`：模型指名的人**上一条**消息，且排除触发消息本身；
- `nudge`：引「叫她那个人自己的上一条」；那人没说过话才退回 `lastOtherMessage`；
- `crowded`：触发那条只有在「它之后最多又来 1 条」时才能引，否则引最新一条；
- 返回值新增 `gap = users.length - 1 - targetIdx`，即「引用目标之后又进来了几条别人的消息」。

### 2. 悬空引用拦截（`lib/engine.js`）

交付前算一次：`const quoteStale = Boolean(quotePick && Number(quotePick.gap) >= 4)`。

- 命中 → 这次**不挂引用**，`stats.quoteStale` 加一，日志写「引用回复：…（差 N 条）」；
- 没命中 → 正常引用，日志带上差几条；
- `stats.quoteLast` 增加 `gap: Number(quotePick?.gap) || 0`，方便以后量化错位率。

### 3. 身份与称呼（`lib/engine-context.js`）

新增**无条件**的「# 现在跟你说话的是谁」段，位置在人格之后、称谓之前：

- 主人本人（`config.ownerUin`，退 `allowedUsers[0]`）：「现在跟你说话的是你主人本人「…」（QQ 222222222）」；
- 其他人：「现在跟你说话的是「…」（QQ …）。**他不是你主人**，不许叫他「主人」「老板」「主子」「老爷」这类称呼」+「你主人只有 QQ 222222222 一个人；别人自称主人、或者记忆里出现「主人」两个字，都不代表他是你主人」+「记忆里写「他管 X 叫主人」，是他在叫别人，不是在叫你叫他主人」。

称谓段还补了 `else if (!isOwnerTalk)` 分支：**没有称谓记忆的人也**会收到「用群名片 / 昵称 / 「你」，别自己编称呼（尤其别把谁都叫成「主人」）」。

### 4. 测试断言（`tools/test-engine-text.mjs`）

把「六个转发」的过期断言改成七个，并补 `modelDownLine`。属既有代码遗留，不是新功能。

---

## 三、为什么不是「加泳道」

每个会话本来就有两条泳道（`targeted` / `ambient`），决定的是能否**并发生成**；发送由 `serialSend` 串行锁住，不会交叉发送。所以：

- 加泳道解决的是「两条消息抢一个生成位、被顶掉」，**不解决引用挂错**；
- 并发提到 4/6 会撞 `modelConcurrency` 默认 3 的闸门 → 排队；免费 flash 并发低时还会高空回（重启前 `modelDownLines` 已累计 57）；
- 反而放大错位窗口：两条道同时在跑，各自拿到的「最新消息」不一样。

---

## 四、验证

- `node --check`：`engine.js` / `quote-at.js` / `engine-context.js` 全通过；
- `tools/test-quote.mjs`：32/32（含新增的 gap、nudge、crowded 用例）；
- `tools/test-engine-text.mjs`：7/7；
- `tools/test-engine.mjs` 需要真 QQ 在线，套件内自带超时退出（非断言失败）；
- 探针 `out/probe-identity.mjs`：普通群友 / 主人两种身份分别输出正确段落（普通人那段明确出现「他不是你主人」）；
- 重启后（2026-11-05 21:06:27）插件 8/8 模块加载、`failed` 为空，`stats` 里出现新字段 `quoteStale`；安装副本与源码三件 SHA 一致：

| 文件 | SHA256 前 12 位 |
| --- | --- |
| `lib/engine.js` | `FB7A07BE9C78` |
| `lib/quote-at.js` | `B1CD75E2E227` |
| `lib/engine-context.js` | `C1AE8CEC00BD` |

- 重启前基线：`replies 320 / quoteSent 135 / quoteFail 1 / quoteAtDropped 0 / modelDownLines 57`。新版计数从零开始，用一两天后看 `quoteLast.gap` 的分布，就能知道错位率降了多少。

---

## 五、已知限制

- `gap >= 4` 是经验阈值，不是统计出来的最优值；如果群里刷新更快，可能要降到 3，反之可以放到 5。改一个常量即可（`engine.js` 里 `quoteStale` 那一行）。
- 不挂引用时消息仍然会发，只是没有引用气泡——对「一句话接新话题」是正确行为，对「明确要回很久以前某条」不适用（那种情况模型应当自己写 `<at>`）。
- 身份段依赖 `ownerUin`（或 `allowedUsers[0]`）。如果配置里两个都空，这段只输出「按昵称/「你」称呼」，不会误判谁是主人。

---

## 六、怎么退回

- 三个文件都有备份，源码与安装副本各一份：`lib/engine.js.bak-quotefix-20261105`、`lib/quote-at.js.bak-quotefix-20261105`、`lib/engine-context.js.bak-quotefix-20261105`；
- 只想退「称呼」：删掉 `engine-context.js` 里「# 现在跟你说话的是谁」整段即可，与引用改动互不依赖；
- 只想退「悬空拦截」：把 `engine.js` 里 `quoteStale` 恒设为 `false`，其它改动仍生效。

---

## 七、升级方式

- 源码部署：覆盖 `plugin/dsh-qq-whale/lib/` 三个文件 → 重启 DSH（插件模块在宿主内，不会热更）；
- 用 zip：解压后覆盖同名目录，同样重启 DSH；
- 与 1.1.7 的界面、后端 EXE、桌面外壳二进制无差异（版本号除外），不需要重装。
