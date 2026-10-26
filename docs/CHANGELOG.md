# 变更日志（插件 / 配置 / 外部程序）

> 谁改了什么、为什么改、怎么退回去。用户原始要求（m00001）：
> 「记得记录你搞了什么插件，方便出问题能还原」。
>
> 一条一条按时间倒序记。新增条目写在最上面。

---

---

## 2026-10-26 · 发布后补丁：称谓读取加固（已上线，随下一版发布）

> 主人 m02960：「为什么 Molly 叫子房还是不叫宝宝，是没调用称谓吗」。

- **结论**：调用了，「# 怎么称呼」段确实在 system prompt 里；坏在段内容——第一条是 `他希望你叫他「什」`。
- **根因**：① 学习链路把「你叫我什么」这种反问存成了称谓（模型层加了 `称谓：` 前缀后原样入库，茶茶/大肥鱼各一条）；② `addressOf()` 只按 kind 过滤，把自称（`他自称「你宝宝呢」`）也当成硬要求并列进去。三段互相矛盾，flash 档就退回群名片叫法。
- **改动**：
  - `lib/memory.js`：新增 `addressName(text)` 只认第二人称指令句式、抽成名字并过滤疑问词/动作词；`addressOf()` 改为解析 + 按名字去重 + 时间新→旧，返回带 `name` 的条目；解析不出的（自称/昵称说明）不进提示词。
  - `lib/engine-context.js`：「# 怎么称呼」只拼 `- 叫他「X」`；同一人多条时提示「以第一行为准（最近一次说的）」。
  - `lib/engine.js`：模型层 address 入库前必须含「叫他」；`guessKind()` 的 address 触发词去掉 `昵称/自称叫`（归 person）。
- **数据清理**：删 3 条 `他希望你叫他「什」`、1 条把子房名片记成「梦梦」的错误条目（走插件 HTTP API，不直接改加密盘）。
- **自测**：`${MOLLY_ROOT}\out\_addrname_test.mjs` 15 条解析用例全过；真库审计 8 个 QQ 称呼可用，子房只剩「宝宝」。
- **上线**：gen `gen-mvorxuj7-llrtgn`（`boot-health ok=true`、link online）；`/chat/simulate` 以 888888888 试三条，两条回复带「宝宝」。
- **回退**：`addressOf()` 恢复成只按 kind 过滤；`addressName` 可留。

## 2026-10-26 · v1.1.5 正式版：合并 preview.1/2/3 + Hotfix.1/2/3 + 今日四项 + 部署可移植性

> 主人 m01820「整理目前更新内容，准备发布1.1.5正式版，唱歌功能未完成的状态挪给1.1.6的第一个预览版」。
> 正式版规矩（STATE.md §10）：preview 序列必须先合并进正式版；Hotfix/Plus 可并列继承；发版必须带 `#molly`。

**版本号**：`1.1.3-Hotfix.3` → **`1.1.5`**（package.json / 控制台 FALLBACK_VERSION / 控制台页脚 / README / cordis.patch.yml 升级提示 / publish-assets 一并改）。

**新增**

- **底层状态激发指令 `#molly`**（私聊/群里整条消息触发）：主人看详情、别人看一行；不受闭眼模式影响，总开关关闭时不吭声；30 秒冷却（主人豁免）；`/state.statusCommand` 可查。
- **语音语速与句间停顿生效**：`voiceSpeed`（默认 0.93）与 `voicePauseMs`（默认 30）现在真的传给 GPT-SoVITS（`speed_factor` + 逐句合成插静音），以前是「配置写了、代码没读」的死配置。
- **语音「英文腔」修复**：念稿前做中文规范化，`2K 60Hz / 1080P / 16GB / 40% / 12,000` 这类不再整句切英文音素（只改念出来的词，不改她发出的文字）。
- **记忆新增「称谓」类 `address`**：单独成类、按 QQ 匹配、每轮必带（不吃权重窗口）；历史记忆已迁移 13 条。
- **控制台数据补齐 + QQ 页合并**（preview.1）：模型/额度/并发/记忆等页面数据更全，QQ 相关页面合并为一处。
- **GIF / 动图理解**（preview.2）：多帧采样拼图送多模态模型，带图轮次输出预算单独放宽（`imageMaxTokens` / `imageReasoningEffort`）。
- **北京时间与作息**（preview.3）：不依赖系统时区；新增作息窗口、群趣味（抽奖 / 口令场 / @我 #）、GIF 表情库重扫脚本。

**修复**

- 群语音转写 20 秒超时（retcode 100）→ 本地 faster-whisper 兜底（Hotfix.1）。
- 自动开奖计数 + 新人入群自动欢迎失效（Hotfix.2）。
- 抽奖 `@` 段被吞（Hotfix.3）。
- 小玩具入口统一（plus.2）。

**部署可移植性（重点）**

- **没有 G: 盘也能启动**：`memoryKeyFile`、`workSandboxDir`、`voiceRefAudio`、`voiceAsrModelDir`、boot-health 路径、三个 Python 路径、work-guard 护栏、`sleepOverridePath()` 全部改为「从 dataDir 推导 + 配置可覆盖」，不再出现盘符字面量。以前无 G 盘的机器会 `mkdir ${MOLLY_ROOT}\keys` 抛 ENOENT → `ChatEngine` 构造失败 → 插件「加载成功但 OneBot 从未连过」。
- **加密失败降级而不是炸**：钥匙目录建不出来时降级明文 + warn（`/state.memory.keyError` 写明原因）；盘上是密文但没有钥匙时置 `broken` 并拒绝写回，避免明文覆盖唯一一份密文。
- **配置项**：新增 `voiceAsrModelDir`（空 = `<dataDir>/asr/models`）；`memoryKeyFile`、`workSandboxDir`、`voiceRefAudio` 默认值改由 dataDir 推导。
- 自测：`tools\path-portability-selftest.mjs`（8 项，模拟无盘机器）。

**音色包 v1.2（随本版 Release 附件发布）**

- 附件 `molly-voice-pack-v1.2.zip`（78 文件 / 315.93 MB，sha256 `<REDACTED>`）：54 句训练素材、参考音频、5 条样例、切分/训练/合成脚本与权重（GPT e10 + SoVITS e16_s864）。
- 与 v1.1 差别：5 条样例按线上参数（`speed_factor 0.93` + 句间 30 ms）重渲染；文档修正 `voicePauseMs` 笔误、补「QQ 语音转文字」实测与限制说明；数据与权重未变。直接覆盖旧的 `molly-voice-pack-v1.1.zip` 即可。
- 主人 m02313「语音目前改完qq转文字识别不了……测完后命名为v1.2的语音包并内置进v1.1.5正式版」；实测四组参数（1.0 整段 / 0.93 整段 / 1.05 整段 / 0.93 逐句 30 ms）都能被 QQ 转文字识别，结论是此前的「识别不了」为偶发，线上参数保持 `0.93 + 30 ms` 不变。

**已知问题 / 排期**

- **唱歌功能未完成**（音色训练集只能念，不能真唱；算法已能跑，卡在数据集），`singingEnabled` 保持关闭，**排期到 `1.1.6-preview.1`**。代码保留，不删除。

**升级注意**

- 老配置里显式写了 `memoryKeyFile` / `workSandboxDir` 等路径的机器，行为完全不变（作者机就是这一档）。
- 想开加密：配 `memoryKeyFile` 到自己机器可写目录；不想加密：`memoryEncrypt: false` 即可，记忆以明文 `memory.json` 落盘（可直接翻看）。
- 装插件的 profile 仍按 publish 仓库 README 的 `file:` 依赖方式接，`dsh-qq-whale` 包内 `plugin/dsh-qq-whale` 目录结构未变。

## 2026-10-26 · v1.1.3-Hotfix.3：自动开奖计数 + 新人入群自动欢迎修复


> 主人 m07147「先推github，还有，你新人欢迎又是我手动的」。

### 修了什么

- **新人入群不自动欢迎**：`lib/main.js` 的 notice 分支原来只把 `notify/poke` 转给 `engine.onNotice`，`group_increase` 一路落到 `return` 被静默丢弃 —— 表现就是「新人欢迎开关开着，但从来不自动发，只能主人手动补一句」。现在所有 notice 都交给 `engine.onNotice` 判：它内部先看 `group_increase`（新人欢迎），再处理 poke（反戳 / 回话），其它类型一律返回 ignored。
- **自动开奖不计入统计**：`lib/groupfun.js` 的 `LotteryBox` 新增 `onDraw` 回调，定时器到点 / 心跳兜底开奖成功后都会回调；`lib/engine.js` 构造时接上 `stats.lotteryDrawn += 1`（手动「开奖」仍由命令路径计数，不重复）。

### 新增（调试）

- `POST /dsh-qq-whale/groupfun/notice`（仅本机 127.0.0.1 + 宿主端口可达）：body `{ groupId, userId }`，用合成的入群通知驱动 `engine.onNotice`，用来验证「新人入群自动欢迎」整条链路（会真的往群里发欢迎语）。

### 实测

- 合成入群通知（群 `666666666`、假 QQ `1234567890`）→ 返回 `{"acted":true,"kind":"welcome"}`；群内真实发出「欢迎 新朋友 加入 本群～我是 Molly，有问题随时 @我」（message_id `1160694340`），`/state.groupfun.stats.welcomed` 由 0 → 1。

## 2026-10-26 · v1.1.3-plus.3：抽奖 @ 段修复（自动开奖能发了）+ 本地调试路由

> 主人 m06713：「Molly刚刚没开奖是因为发言被我关了吗」→ 实为消息段字段错误；m06903：「先自己测一下能不能开奖，而且要模拟真人用@molly # 使用抽奖机，不要用你自己的 LLM 链路」。

**1）根因** 自动开奖的 @ 段写成 `{ type:'at', data:{ qq } }`，而 SnowLuma 的协议是 `{ type:'at', qq }`；发送时整条消息被拒（`message segment "at" is missing required or usable fields`），异常被发送层吞掉，只落在 `/state.groupfun.lastAuto.error`。

**2）修复** `lib/engine.js` 两处构造 @ 段改为 `{ type:'at', qq: String(qq) }`。

**3）兜底** `lib/groupfun.js` 新增 `sweep()`（到点未开的房间补开）与 `tick()` 心跳；`engine` 每 15 秒调一次；`/state.groupfun` 暴露 `lastTick` / `lastAuto` / `sweeps`。

**4）自测** `out/_lottery_sweep_test.mjs` 15 项、`_lottery_keyword_test.mjs` 33 项、`_groupfun_test.mjs` 51 项全过；并在群 666666666 用调试路由实跑一局（3 人报名 → 到点开奖 @ 三位，`lastAuto.ok=true, sent=true`）。

---

## 2026-10-25 · v1.1.3-plus.2：小玩具统一入口 @我 #（含抽奖 / 口令抽奖 / 新人欢迎）

> 主人 m06563：「触发菜单的命令就用@Molly+空格+#吧，以后的小玩具都这样」。
> 主人 m06473：「抽奖机加一个：菜单其中一个功能，可以在抽奖开始后只选择规定时间内发送指定口令的才能在倒计时结束时成为抽奖参与者」。

**1）小玩具统一入口**

- `@我 #` → 发「小玩具」总菜单（同时也是以后所有小玩具的入口）；`@我 #抽奖` → 直达抽奖菜单。
- 旧写法全部保留：`@我 抽奖`、`抽奖 开 …`、`参加`、`抽奖 名单` 等照旧可用。

**2）口令抽奖（新玩法）**

- 开局：`抽奖 口令 干饭 3 人 60秒`（口令 1–16 字；名额 1–10；时长 30–600 秒；后两个参数可省，默认 3 人 / 120 秒）。
- 报名：窗口内**整句**发出口令（如「干饭」）的人才算参加；发 `参加` 会被提示「本场是口令抽奖，发『干饭』才算报名哦」。
- 开奖：到点自动开 / 发起人 `抽奖 开奖` 提前开，只从口令参与者里抽；无人发口令则自动取消。
- 抽奖名单会显示口令与参与人数；口令只按整句严格相等匹配（防误触），同一句口令不会重复报名。

**3）回归**

- 普通抽奖 / 新人欢迎逻辑不变；新增自测 `out/_lottery_keyword_test.mjs`（33 项）与 `out/_toy_menu_test.mjs`（7 项），全部通过。

**回滚**

- 去掉 `@我 #` 入口不影响旧指令；要整体关掉：`groupfunEnabled: false`，或单独关 `lotteryEnabled` / `welcomeEnabled`。

## 2026-10-25 · v1.1.3-plus.1：群趣味——抽奖 + 新人欢迎

> 主人 m06096：「加两个群趣味功能作为1.1.3plus.1上线：1.群内抽奖小插件…2.新人欢迎小插件」。

**1）群内抽奖（纯代码，不进模型）**

- 触发：「@Molly 抽奖」或「@Molly 抽个奖」→ 发菜单（菜单同时也是使用说明）。
- 指令（整句匹配，防误触）：
  - `抽奖 开 3 人 60秒`：开局（名额 1–10，默认 3；时长 30–600 秒，默认 120，可省略）
  - `参加`：报名（开奖前都能报，重复报名会被拦下）
  - `抽奖 开奖`：提前开奖（只有发起人能开）
  - `抽奖 取消` / `抽奖 名单`
- 到点自动开奖；同一时间每群只能有一场；抽签不放回、每人最多中一次。
- 实现：`lib/groupfun.js`（纯逻辑状态机，注入 now/random/send 便于测试）+ `engine.maybeGroupFun` 在会话路由之前接管，命中后不再走模型。

**2）新人欢迎**

- 监听 `group_increase` 通知（含 `sub_type=increase` 的兼容形态），新人入群自动发欢迎语。
- 模板在 `welcomeTexts`（`|` 分隔多条，随机一条），占位符 `{name}` `{group}` `{molly}`；60 秒冷却（`welcomeCooldownSeconds`）。
- 欢迎语只发一次、不进历史，也不花 token。

**观测**

- `/state.groupfun` 回读开关与房间数；`/state.stats` 新增 `lotteryStarted` / `lotteryJoined` / `lotteryDrawn` / `welcomeSent`。
- 自测：`out/_groupfun_test.mjs` 51 项全过（解析、状态机、抽签均匀性、欢迎模板、入群事件）。

**配置（cordis.patch.yml）**

```yaml
groupfunEnabled: true
lotteryEnabled: true
lotteryDefaultCount: 3
lotteryMaxCount: 10
lotteryDefaultSeconds: 120
lotteryMinSeconds: 30
lotteryMaxSeconds: 600
lotteryJoinKeyword: 参加
welcomeEnabled: true
welcomeTexts: 欢迎 {name} 加入 {group}！我是 {molly}，有不懂的可以问我喵~
welcomeCooldownSeconds: 60
```

## 2026-10-25 · v1.1.5-preview.3：看得见时间、按点睡觉、动图表情重扫（唱歌暂缓）

> 主人 m05189：「1.给鱼加一个能看时间的插件功能，要求北京时间 2.鱼想唱歌，优化一下语音模型写一下算法，让鱼能唱出歌来 3.利用新的动图识别功能，重新给表情包库的gif打tag，同时推preview.3的时候,增加脚本提示，让更新者获得提示：请利用新功能重新扫描gif库」。
>
> 追加（m05905 / m05958）：「第②件可以开工，计入preview3」——第②件按主人澄清指「北京时间」那条：把作息也交给北京时间判断，并且能在控制台改。

**1）北京时间**

新增 `lib/clock.js`（纯函数、无依赖）+ engine 注入 `clockText`：每轮提示词带一行「现在是 2026-10-25 周日 20:57（北京时间）」，并提醒「不知道具体分钟数就别编」。配置 `timeContextEnabled`（默认开）、`timeZoneOffsetMinutes`（默认 480 = 北京时间）。以前她没有任何时间来源，问几点只能糊弄。

**2）唱歌（暂缓，默认关闭）**

算法已经做完并验收（`lib/singing.js` + 内嵌 numpy 渲染器：逐字合成 → ACF 测基频 → 重采样搬音高 → WSOLA 保时长 → 全局校准，实测 42 个音平均误差 14.6 音分），但**音色没过关**：她的语音包 fine-tune 数据只有 **54 句 / 3.5 分钟**（`logs/molly_own/molly_own.list`），而 GPT-SoVITS 是「说话」模型，变调搬移会连共振峰一起搬，听起来「不人不鬼」。主人 m05752 决定：先去收集足够原始录音（目标 30 分钟以上），唱歌这一路改走社区歌唱模型（DiffSinger / So-VITS-SVC），1.1.5 正式版等数据齐了再说。代码保留、`singingEnabled` 默认 **false**，将来可直接开。

**3）动图表情重扫（升级后建议跑一下）**

新增 `tools/rescan-gif-stickers.mjs`：把表情包库里的 GIF 拆成多帧拼图 → 视觉模型重新概括「角色/画面/动作/情绪」→ 写回文件名（文件名就是 tag）。默认 **dry-run 只预览**，`--apply` 才真正改名；每张的旧名/新名都写进 `out/rescan-gif-report.json`，改错可照报告改回；单帧 GIF 跳过，一张失败不影响其它张。旧的 tag 多是按首帧或人工起的，用新的动图识别能补上「动作」。

> 升级到本版后，先 `node tools/rescan-gif-stickers.mjs` 预览，确认没问题再 `node tools/rescan-gif-stickers.mjs --apply`。

**4）作息：按北京时间判断「该不该睡」**

以前她没有作息概念，休息窗用的是宿主本地时间，于是会出现「聊着聊着突然说要睡」。现在新增 `sleepWindowEnabled`（默认开）、`sleepWindowStart`（默认 23:50）、`sleepWindowEnd`（默认 09:00），全部按**北京时间**判断：

- 窗口内：不主动找人、群聊不接话（被 @ 才回），私聊叫她会醒、语气带起床气，但不会长篇大论。
- 窗口外：想聊多久聊多久，不再中途喊困。
- 配置在控制台「设置」页的「作息时间」卡片里改，保存后立即生效、无需重启；覆盖值落盘 `${MOLLY_ROOT}\data\qq-whale\sleep-window.json`，插件接口 `GET/POST /dsh-qq-whale/sleep`（控制台 `/api/sleep`）。
- 自测：`out/_sleep_test.mjs` 15/15（跨午夜窗口、边界含端点、非法输入 400、控制台代理、私聊叫醒）。

## 2026-10-26 · v1.1.5-preview.2：让她看懂动图（GIF 多帧）+ 带图轮次不再「看了不吭声」

> 主人 m04893「现在做preview.2，目标是让Molly能看懂gif动图，他现在面对那些gif和gif表情包只能看到首图」。

**为什么只看得到首图**
- QQ 侧没问题：图片 URL 下载下来就是完整 GIF（实测群历史 14 张图里 2 张是 GIF，最大 1.18 MB）。
- 是模型侧的问题：多模态模型对 `image/gif` 只解码第一帧，插件原来把 GIF 原样当 data URL 发，等于只给模型看首帧。

**改法（新增 `lib/gif-frames.js`，约 250 行，无新依赖）**
- 下载后按魔数确认是 GIF → 调本机 `${MOLLY_ROOT}\data\video\venv` 的 Pillow，把整段动画采样成 N 帧（默认 6 帧 / 3 列 / 每帧 320px），拼成一张 PNG，每格左上角标「n/N」帧号。
- 接入点在 `engine-context.loadImages`：拆帧函数由 engine 通过 deps 注入，该文件保持「只组装、不 import 能力」；没装 Pillow / 超时 / 单帧 GIF 一律回退原图，绝不影响这轮回复。
- 配置（cordis.patch.yml）：`gifFramesEnabled` / `gifFramesCount` / `gifFramesColumns` / `gifFrameWidth` / `gifFramesPython` / `gifFramesTimeoutMs`。实测拆帧 204–235 ms，拼图输出 21 KB。
- 真机 A/B：原图首帧 → 「两只小猫抱在一起，一只用爪子捂着另一只的嘴」；拆帧图 → 按帧号讲出「捂嘴 → 蓝色液体漏出 → 又大量溢出」的完整动作。`out/_gif_frames_test.mjs` 16/16；`out/_gif_e2e.mjs` 用群里真实 GIF 跑通（8 帧取 6）。

**连带修：带图轮次会「看了不吭声」**
- 实测图类请求 reasoning token 934–4094 波动，默认 `maxTokens 1536` 一旦被思考吃光，正文就是空串 → engine 判「模型返回空内容，沉默」。
- 改法：带图轮次 `maxTokens` 抬到 `imageMaxTokens`（默认 3200），并传 `reasoning_effort: 'minimal'`（思考压到 ~900，回答质量不受影响；gateway 只在显式配置时才带该字段）。新增配置 `imageMaxTokens` / `imageReasoningEffort`；`out/_image_effort_test.mjs` 5/5。

**回滚**
- 只关动图理解：`gifFramesEnabled: false`。
- 连「带图轮次预算」也回旧行为：`imageMaxTokens: 1536`、`imageReasoningEffort: ''`。
- 代码层：`lib/gif-frames.js` 可整体删除（只通过 deps 注入被用到）；`engine-context.js` 里 `mime === 'image/gif'` 那个分支可直接去掉。
- 提示词没动；记忆 / 戳一戳 / 语音链路不受影响。

## 2026-10-25 · v1.1.5-preview.1：控制台数据补齐 + QQ 页合并

> 主人 m04755「控制台里的学习器，记忆，群数等数据还是none，看看怎么弄一下」+「QQ这里两个模块功能有点重复了吧，看看是合并还是清晰区分一下」。

**为什么是「—」**
- 学习器：插件 `/state.learner` 本来就有 `total` 和 `today{kept,...}`，`console-server` 的 `out.learner` 没透传。
- 群数：`out.plugin.bot` 没有 `groupCount`。
- 记忆：QQ 记忆池 10-23 改成加密存储，控制台旧数据面（19391 的 panel-data）读不到明文 `memory.md` 就返回空。
- 表情包「已学」：`out.stickers.learned` 缺失。
- 都是控制台聚合层/取值链的问题，**Molly 插件本身数据是好的**。

**改了什么**
- `tools/console-server.mjs`：`out.learner` 补 `total` + `today`；`out.plugin.bot.groupCount` 用已有的 `snowlumaAction('get_group_list')` 取群列表长度（retcode 0 且为数组才算）；`out.stickers.learned` 回落 `learner.total`；`out.sidecar.memory` 为空时回落插件 `/state.memory.count` 并标 `source:'plugin'`。
- `console/console.js`：取值链改 `p.bot.groupCount`、`learner.total`、`learner.today.kept`、`stk.learned`、`(side.memory.count)||(p.memory.count)`；`PAGES` 去 `login`、`#/login` 与 `#/napcat` 都别名到 `#/qq`；`renderPageNow('qq')` 同时渲染连接页与登录块；`startLoginPoll()`/`handleQrExpired()` 页面判断改 `qq`；连上时不再重复「不需要扫码」。
- `console/index.html`：左侧 QQ 组只留一项「QQ 连接」（`#loginBadge` 移到该项）；QQ 页 = 连接状态卡 + 服务信息 + 扫码登录块（重新登录/二维码/状态/倒计时/进度/复制链接/诊断）；删掉独立「登录」页。

**验证**
- `node --check` 通过（`tools/console-server.mjs`、`console/console.js`）；重启 `Molly-Console` 后 `/api/health` 版本号跟随 `plugin/dsh-qq-whale/package.json`。
- `/api/overview`：`bot.groupCount=10`、`learner.total=234`、`learner.today.kept=45`、`stickers.learned=234`、`memory.count=911`、`sidecar.memory={count:911,source:'plugin'}`。
- 浏览器实测：总览「群数 10 / 累计学会 234 张 / 今日学会 45 条 / 记忆 911 条」；QQ 页只剩一个导航项，状态卡与扫码登录同页。

**回退**
- 纯控制台（前端 + 一个 server 文件）：`git checkout` 回 `tools/console-server.mjs`、`console/index.html`、`console/console.js`，重启 `Molly-Console`。不涉及插件运行时和线上 Molly 行为。

---

## 2026-10-25 · v1.1.3-Hotfix.2：群聊语音本地 ASR 兜底 + 控制台「本次更新说明」

> 主人 m04446「把语音识别加进这个版本呢，然后一起发」、m04404 选「本地兜底」、m04452「控制台上的版本更新一下，注释一下这次更新了什么」。
> 与 `v1.1.3-Hotfix.1` 分开发布：Hotfix.1 只有 QQ 服务端转写（`fetch_ptt_text`）这一条；本地 ASR 兜底 + 控制台「本次更新说明」归到本版（Hotfix.2）。

**为什么还要本地兜底**
- 上一版上线后真机又出现：群聊里群友发的语音，`fetch_ptt_text` 20 秒不回（SnowLuma 回 `retcode=100`），她只能回「[语音：没听清]」；同一条消息换成私聊就正常。
- 复测也说明 QQ 服务端转写是**时好时坏**：本轮同一条群语音 209 ms 就返回了「8秒够卖了。」，所以本地 ASR 只做兜底，不抢主路、不加延迟。

**改动**
- 新增 `lib/local-asr.js`（无新 npm 依赖、无 ffmpeg）：
  - `fetchRecordWav(client, file)`：调 SnowLuma `get_record { file, out_format:'wav' }` 取 24k/16bit/mono wav（SnowLuma 自带解码）；超时 12 秒、体积上限 8 MB、失败永远返回 `{ok:false,error}`。
  - `wavSeconds(buffer)`：解析 RIFF 头算时长，给「太长不识别」的判断用。
  - `LocalAsr`：常驻 Python worker（借用 `${MOLLY_ROOT}\data\video\venv` 里已装的 faster-whisper + 本地缓存模型，`local_files_only` 不联网），首次加载约 1.6 秒、之后每段 1.4–1.6 秒；空闲 10 分钟自动退出；串行队列避免并发拖爆 CPU；旧 worker 迟到的 exit/error 不会影响新 worker（踩过：dispose 后立刻重启会被旧子进程的退出事件打成 `asr worker 未就绪`）。
- `lib/engine.js`：`transcribeVoice(messageId, { file })` 改成分级返回 `{text, source}`——
  1. 先走 QQ 服务端 `fetch_ptt_text`（快、免费）；
  2. 失败且 `voiceAsrEnabled !== false` 时：`get_record` 转 wav → `voiceAsrMaxSeconds`（默认 15 秒）以内 → 本地识别；
  3. 仍然失败则沿用 `[语音：没听清]` 降级。
  `/state.stats` 新增 `voiceAsrTranscribed / voiceAsrFail`（`voice.source === 'asr'` 的条数单独记）。
- `lib/main.js` + `cordis.patch.yml` 新增 7 个配置：`voiceAsrEnabled`（true）、`voiceAsrPython`（venv 解释器）、`voiceAsrModel`（small）、`voiceAsrThreads`（8）、`voiceAsrTimeoutMs`（25000）、`voiceAsrIdleSeconds`（600）、`voiceAsrMaxSeconds`（15）。
- 控制台「本次更新说明」（主人 m04452）：
  - `tools/console-server.mjs` 新增 `GET /api/changelog`：直接读仓库 `docs/CHANGELOG.md` 最新一节（不另维护文案），文件缺失也返回 200；版本真源仍是插件 `package.json`（`FALLBACK_VERSION` 兜底）。
  - `console/index.html` + `console.js` + `console.css`：左下角版本号改成可点按钮，点开弹层按 markdown 轻渲染展示本节；Esc / 点遮罩关闭，底部「完整变更日志」跳 GitHub。

**验证**
- `out/_local_asr_test.mjs` **17/17 PASS**：wav 头解析、坏输入不崩、`fetchRecordWav` 各失败路径、worker 冷启动识别（2.34 s 样本 → 「喂喂 听得见我说话吗」）、空闲/重启后仍可用、disabled 直接空串。
- `out/_asr_e2e_test.mjs` **8/8 PASS**：拉真实群语音（`-246478423`）→ `fetch_ptt_text` 得「8秒够卖了。」[信息项] → `get_record` 67278 B wav（1.40 s）→ 本地识别出文本（3.5 s，含首次加载）。
- 已热重载 `gen-mvnix03p-oz7o14`；`/state.stats` 出现 `voiceAsrTranscribed/voiceAsrFail`，7 个配置键在 yml 里存活。

**已知限制**
- 本地用的是 `small` 模型：安静清晰的语音（2.3 s「喂喂，听得见我说话吗？」）转写正确；嘈杂短句会听错（同一条 1.4 s 群语音，QQ 服务端「8秒够卖了。」，本地识别成「白鸟 夠白了」）。想更准可换 `voiceAsrModel: medium`（首次需联网下载约 1.5 GB，CPU 约慢 3–5 倍）。
- 群里 15 秒以上的长语音不走本地（`voiceAsrMaxSeconds`），仍回降级文案。

**回滚**
- `voiceAsrEnabled: false` 只关本地兜底，保留 QQ 服务端转写；
- `voiceTranscribeEnabled: false` 连 QQ 转写一起关，退回只看见 `[语音]` 的老行为；
- 整体回退：还原 `lib/local-asr.js`（删除）、`lib/engine.js`、`lib/main.js`、`cordis.patch.yml` 与三个控制台文件。

---

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
