# patch-quote-engine.md — 把「引用的正文」接进 engine.js（P3）+ 记忆窗口（P5）

> 本文件是给 **Lead** 的接线说明。数据层已经做完并自测通过（`lib/onebot.js` 新增 `fetchQuoted`），
> 但 `lib/engine.js` 正在被 task-12 的 owner 改，本任务不碰它，所以接线由 Lead 做。
>
> 行号以 **2026-10-19 11:45 的 engine.js（157474 B / 3499 行，mtime 2026-10-18 13:04）** 为准。
> 如果 task-12 已经改过，行号会漂——**按下面每段的「锚点代码」定位，不要按行号硬跳**。

---

## 0. 一句话

在 `ChatEngine.onMessage()` 里 `normalizeMessage(...)` 之后加 4 行：有 `norm.replyTo` 就
`await fetchQuoted(this.client, norm.replyTo)`，把返回的 `q.text`（形如
`[引用 @张三：他刚才说的原话]`）**拼到 `norm.text` 最前面**。后续
`decideScene / pushHistory / maybeLearn / decideResearch` 全部自动看见引用内容，不需要改别处。

---

## 1. 改 import（1 行）

**位置**：engine.js:51，锚点是 `const { normalizeMessage, buildMessage } = await import(sub('./onebot.js'))`

```js
// 改前
const { normalizeMessage, buildMessage } = await import(sub('./onebot.js'))
// 改后
const { normalizeMessage, buildMessage, fetchQuoted } = await import(sub('./onebot.js'))
```

> 引擎用的是带 `?rev=` 的动态 import（热重载），别改成静态 `import`，否则改文件不重启不生效。

---

## 2. 在 onMessage 里取回被引用正文（核心，4 行）

**位置**：engine.js:1254 之后、1255 `if (!norm.text && norm.images.length === 0) return` 之前。

**锚点代码**：

```js
    const norm = normalizeMessage(ev.message, this.selfId)
    if (!norm.text && norm.images.length === 0) return
```

**在两句之间插入**：

```js
    /*
     * P3：引用消息要把被引用那条的正文取回来。
     *
     * 之前 normalizeMessage 只写一个 '[引用]'，模型只知道"他在回某条"，
     * 不知道回的是哪条，于是只能反复追问/反复检索那个模糊问题（P2/P3）。
     * fetchQuoted 自带 3 秒超时 + 降级文案，永远不抛，所以这里可以放心 await。
     * 失败时 q.text 是 '[引用：取不到内容]'，同样能当前缀用，不需要分支。
     */
    if (norm.replyTo) {
      const q = await fetchQuoted(this.client, norm.replyTo)
      norm.text = `${q.text} ${norm.text}`.trim()
    }
```

**为什么放在这个位置**：

| 位置 | 谁看不见 | 说明 |
|---|---|---|
| 1248 之前 | — | 不行，`norm` 还没算出来（`replyTo` 在里面） |
| **1254 与 1255 之间（推荐）** | 无 | 纯引用、没打字的空消息（`norm.text` 为空）也能活下来，不会在 1255 被 return 掉 |
| 1257 `decideScene` 之后 | `decideScene` | 场景判定看不到引用；好处是引用里出现 `@Molly` 时不会误判成「在 @ 我」 |
| 1346 `pushHistory` 之后 | 历史、记忆抽取 | 不推荐：模型在历史里看到的仍然是 `[引用]`，白干 |

**格式**：`fetchQuoted` 返回的 `text` 已经是成品 `[引用 @张三：正文…]`，**拼在正文最前面**
（用户要的就是"先知道他说的是哪句，再读新问题"）。正文超过 200 字会截断成 `…`，
图片/表情/语音分别写成 `[图片]` `[表情]` `[语音]`，嵌套引用（引用里再套引用）只跳过不递归。

最终 `norm.text` 长这样（`[引用]` 那个旧标记还在，是 `normalizeMessage` 留的，无害）：

```
[引用] [引用 @群里的明哥：这个链接里有你要的答案[图片]] 这个是怎么实现的
```

想让语气干净一点，可以在这 4 行后面再加一句（可选）：

```js
      norm.text = norm.text.replace(/^\[引用\]\s*/, '')
```

---

## 3. P5：记忆窗口（2 处，可选但建议一起做）

`lib/memory.js` 已把窗口做成常量并导出（改前/改后见下表），但 **engine.js 组装提示词时是显式传
limit 的**，硬编码值在 engine.js:2240 / 2247，需要在 engine 侧接上新常量，否则 memory.js 的默认值不生效。

### 3a. import（engine.js:31）

```js
// 改前
const { MemoryStore } = await import(sub('./memory.js'))
// 改后
const { MemoryStore, MEMORY_WINDOW } = await import(sub('./memory.js'))
```

### 3b. 两处 limit（engine.js:2240 / 2247）

```js
// 改前 2240
const memText = this.memory.contextFor({ who: userName, limit: degraded ? 6 : 16 })
// 改后
const memText = this.memory.contextFor({
  who: userName,
  limit: degraded ? MEMORY_WINDOW.degradedContextLimit : MEMORY_WINDOW.contextLimit,
})
```

```js
// 改前 2247
.recall({ query: lastUserText.slice(0, 40), limit: degraded ? 3 : 6 })
// 改后
.recall({ query: lastUserText.slice(0, 40), limit: degraded ? MEMORY_WINDOW.degradedQueryLimit : MEMORY_WINDOW.queryLimit })
```

### 3c. 数值前后对照（`lib/memory.js` 里的 `MEMORY_WINDOW`）

| 常量 | 改前 | 改后 | 为什么是这个值 |
|---|---|---|---|
| `contextLimit` | 16（engine 硬编码） | **24** | 实测 memory.md 60 条、单行 26~76 字（正文平均 15 字）。24 条 ≈ 1.0k 字 ≈ 700 token；60 条的规模下第 17~24 位正好是"高权重偏好被切掉"的那截 |
| `queryLimit` | 6 | **8** | 关键词召回要求两字以上命中，精度高但偏少；同一话题常有 2 条以上相关记忆（"猫叫团子"+"猫不吃湿粮"），6 条会漏边 |
| `degradedContextLimit` | 6 | **8** | 降智档（trae）只温和提，宁可少喂也别让它想太久 |
| `degradedQueryLimit` | 3 | **4** | 同上 |
| `entryChars` | 无上限 | **200**（memory.js 内已生效，无需接线） | 单条超 200 字通常是模型自己写长的段落，会挤掉别人；超长本来就该拆成多条记 |

---

## 4. 副作用 / 坑（接线前先读）

1. **`looksLikeAtMe` 可能被引用前缀触发**。`decideScene`（engine.js:576）用
   `Text.includes('@' + 昵称/群名片/QQ号)` 判"是不是在 @ 我"。如果有人引用了 **Molly 自己说的话**，
   前缀就是 `[引用 @Molly（在想…）：…]` → 场景被判成 `SCENE_MENTION`（群里从"旁观"变成"被点名"）。
   多数情况下这是**对的**（引用她的话等于在跟她说话）；如果你不希望这样，就把 4 行插到
   `const scene = this.decideScene(ev, norm)` **之后**。
2. **`maybeLearn` 会看到引用文本**（engine.js:1364 在插入点之后）。极端情况下模型可能把被引用者的话
   当成当前说话人的事实记下来。风险很低（`maybeLearn` 自身有抽取 prompt 过滤），先在真实对话里观察，
   真有问题再把插入点挪到 `maybeLearn` 之后。
3. **最多多花 3 秒**，且只在"这条消息确实带引用段"时发生。NapCat 是本机回环，实测一次 `get_msg`
   在 20ms 量级；3 秒是兜底，不是常态。
4. **不要插两次**。`norm.text` 已经含 `[引用]` 时不要再包一层；插完搜一下
   `grep -n "fetchQuoted" lib/engine.js` 应该只有 1 处调用 + 1 处 import。
5. **失败不抛、不阻塞**：`fetchQuoted` 内部 try/catch 覆盖 `client.call` 的 reject（超时/未连接/retcode≠0）
   和返回体结构异常，任何一条都返回 `{ ok:false, text:'[引用：取不到内容]' }`。
6. **task-12 的冲突**：task-12 也在 `onMessage` 里改投递/循环逻辑。合并时以代码文本为锚点重放这 4 行，
   不要整段覆盖对方改动。

---

## 5. 验收（接线后照做）

```powershell
# 1) 语法
& '${HOME}\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' --check qq-whale\plugin\dsh-qq-whale\lib\engine.js

# 2) 数据层自测（不依赖 engine）
& '${HOME}\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe' qq-whale\tools\test-quote.mjs
# 期望：结果：32 通过 / 0 失败
```

3) 真实 QQ：在群里**引用一条别人发过的消息**再打一句话，观察接下来这一轮：
   - 她能复述被引用那条的内容（不再问"你说的是哪条"）；
   - 引用一条**图片/表情**消息时，`norm.text` 里出现 `[图片]` / `[表情]` 而不是空白；
   - 引用一条**已撤回**的消息时，日志是 debug 级、回复正常继续（降级文案生效）。
4) `lib/index.js` 热重载后 `GET http://127.0.0.1:<宿主端口>/dsh-qq-whale/state` 的 `link.state` 仍是 `online`。

---

## 6. 回滚

只需删两处：engine.js:51 的 `fetchQuoted` 尾项、以及 onMessage 里那 4 行 `if (norm.replyTo) { ... }`。
`lib/onebot.js` / `lib/memory.js` / `lib/qqtools.js` 的新增都是**纯增量**（新导出 + 默认参数变大），
不删也不影响旧行为（`MEMORY_WINDOW` 不接线时 engine 仍用 16/6）。

---

## 附：本次数据层改动索引

| 文件 | 改动 | 行（当前文件） |
|---|---|---|
| `lib/onebot.js` | 新增 `HISTORY_DEFAULT_COUNT=50` | 12-23（导出在 23） |
| `lib/onebot.js` | 新增 `QUOTE_TEXT_MAX/QUOTE_TIMEOUT_MS/QUOTE_FAIL_TEXT` + `quoteSegmentsToText` + `quoteIdForApi` + `fetchQuoted` | 181-315 |
| `lib/onebot.js` | `getGroupMsgHistory` / `getFriendMsgHistory` 默认 20 → 50 | 629 / 633 |
| `lib/memory.js` | 新增导出 `MEMORY_WINDOW`（24/8/8/4/200） | 22-51 |
| `lib/memory.js` | `recall` / `contextFor` 默认 limit 20 → 24；`contextFor` 按 200 字截断单条 | 142 / 227-237 |
| `lib/qqtools.js` | 新增 `HISTORY_DEFAULT_COUNT/MAX_COUNT`，count 默认 20 → 50（上限仍 200） | 91-102 / 272 |
