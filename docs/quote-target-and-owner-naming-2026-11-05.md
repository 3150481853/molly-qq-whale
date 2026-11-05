# 引用挂错 + 乱叫主人：根因与改动（2026-11-05）

主人原话（m07111 / m07124）：

> 现在Molly回复消息的时候还是会引用错是因为泳道太少了吗，增加泳道有没有什么影响
> 可以直接改四条，重启之前再看看为什么Molly乱叫主人

---

## 一、引用挂错：不是泳道的问题

**泳道只影响「能不能同时生成」，不影响「引用挂在谁身上」。**

- 每个会话两条泳道：`engine.js:4724`
  `const lane = scene === SCENE_MENTION || scene === SCENE_PRIVATE ? 'targeted' : 'ambient'`，
  jobId = `conv.key\0lane`；发送侧由 `serialSend`（`engine.js:4657`）串行，不会交叉。
- 引用目标由 `lib/quote-at.js` 的 `pickQuoteTarget()` 单独决定，三处旧逻辑各有错位：

| 场景 | 旧逻辑 | 错在哪 |
| --- | --- | --- |
| `nudge`（只 @ 不说正文） | `lastOtherMessage(history)` | 群里最后说话的是乙，引到乙；她要接的是甲 |
| `explicit-at`（模型写了 `<at>甲</at>`） | `lastMessageFrom(history, 甲)` | 引「甲最近一条」，可内容答的是甲更早那句 |
| `crowded`（30s 内 ≥3 条 ≥2 人） | 直接引触发那条 `ev.message_id` | 生成这几秒又进来新消息，她答新的、引用停在旧的 |

线上基线（`GET /dsh-qq-whale/state`，重启前）：`replies 320 / quoteSent 135 / quoteFail 1 / quoteAtDropped 0 / modelDownLines 57`。

### 改了什么（四条）

1. **nudge**：先引「叫她那个人」自己上一条（`lastMessageFrom(history, ev.user_id)`），他没有上一条才退 `lastOtherMessage`。
2. **crowded 兜底**：触发那条只有在最近两条之内才用它；已经被刷过去 ≥2 条就改引最新那条（提示词本来就写「只接最近那一条」）。
3. **引用体检**：`pickQuoteTarget()` 现在返回 `gap`（引用目标之后又进来了几条别人的消息）；`engine.js` 的 deliver 里 `gap ≥ 4` 就不挂引用，`stats.quoteStale` 记一笔。
4. **可观测**：`stats.quoteLast` 增加 `gap`；debug 日志打印「引用回复：why → id（差 N 条）」。

### 改的文件

- `plugin/dsh-qq-whale/lib/quote-at.js`：`pickQuoteTarget()` 重写（新增 `users/usableId/indexOf/newest/gap`）。
- `plugin/dsh-qq-whale/lib/engine.js`：`quoteStale` 判断与 `quoteTarget` 计算、`quoteLast.gap`（成功/失败两处）、`stats.quoteStale` 初始化。

---

## 二、为什么乱叫「主人」

**不是她记错人，是她压根没被告知「主人的 QQ 是哪个」，而唯一那句禁止语又被条件藏起来了。**

1. 称谓段整块在 `if (addrItems.length)` 里面（`lib/engine-context.js`，原 `:167-207`），
   而 `addrItems` 来自 `memory.addressOf({ who: userName, qq })`。
   生产记忆 5,644 条里 `kind=address` 只有 **7 条**（主人 + 6 个朋友）——
   群里其余几百人**一条称谓都没有**，于是整段不输出，连那句
   「别自己编一个称呼出来（尤其别把谁都叫成主人）」也一起消失。
2. 记忆里含「主人」的 37 条中 **32 条属于别人**，而且是「他在说别人」的转述，例如：
   - `640344215`：「他管 ID 3329150495（白日梦制造商）叫「主人」…」
   - `1512789105`（Seraphina）：「我勒个大坝怎么全在叫主人」
   模型把这些读成「这个人要被叫主人」。
3. `persona/core.md:62` 写着「主人就是「主人」」，但提示词里**从没出现过主人的 QQ 号**
   （`engine.js` 的 `titleFor()` 只用于给主人发系统通知，不进聊天 prompt）。

### 改了什么

`lib/engine-context.js` 新增**无条件**输出的「# 现在跟你说话的是谁」段（人格之后、称谓之前）：

- 主人本人（`qq === ownerUin`）：
  「现在跟你说话的是你主人本人「…」（QQ 222222222）。「主人」这个称呼只属于他一个人…」
- 其他人：
  「现在跟你说话的是「白日梦制造商」（QQ 3329150495）。**他不是你主人。**
   不许叫他「主人」「老板」「主子」「老爷」这类称呼…
   你主人只有 QQ 222222222 一个人。
   别人自称「主人」、开玩笑说自己是主人、或者聊天记录/记忆里出现「主人」两个字，都不代表他是你的主人——那是他在说别人，或者只是转述。
   记忆里写「他管 X 叫主人」「他叫 X 主人」，是**他在叫别人**，不是你该叫他主人。」
- 没有称谓记忆时（新增 `else if` 分支）也固定输出一句
  「# 怎么称呼：这里没有他的称谓记录……别自己编一个称呼出来——尤其别把谁都叫成「主人」。」

主人号取 `deps.config.ownerUin`，缺失时退 `allowedUsers[0]`（与 `main.js` 的 `resolveDirs()` 口径一致）。

---

## 三、验证

- `node --check`：`engine.js` / `quote-at.js` / `engine-context.js` 全部通过。
- `tools/test-quote.mjs`：32 通过 / 0 失败。
- `tools/test-engine-text.mjs`：7 通过 / 0 失败（顺手把「六个转发」断言更新成七个，`modelDownLine` 是后加的第七个）。
- 探针 `out/probe-identity.mjs` 实测两段输出（普通群友 / 主人本人）符合预期。
- 已备份并同步安装副本 `${HOME}\.dsh\profiles\desktop\node_modules\dsh-qq-whale\lib\`
  （`.bak-quotefix-20261105`），三份 SHA256 与源码一致。

## 四、生效方式

**需要重启 DSH**（插件模块在宿主里已加载，不会自动热更）。重启后看：

```powershell
Invoke-RestMethod http://127.0.0.1:1546/dsh-qq-whale/state   # 端口以实际为准
# stats.quoteStale / stats.quoteLast.gap 出现，即新版已加载
```
