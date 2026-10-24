# 变更日志（插件 / 配置 / 外部程序）

> 谁改了什么、为什么改、怎么退回去。用户原始要求（m00001）：
> 「记得记录你搞了什么插件，方便出问题能还原」。
>
> 一条一条按时间倒序记。新增条目写在最上面。

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
