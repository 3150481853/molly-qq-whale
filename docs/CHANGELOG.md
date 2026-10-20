# 变更日志（插件 / 配置 / 外部程序）

> 谁改了什么、为什么改、怎么退回去。用户原始要求（m00001）：
> 「记得记录你搞了什么插件，方便出问题能还原」。
>
> 一条一条按时间倒序记。新增条目写在最上面。

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
