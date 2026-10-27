#!/usr/bin/env node
/**
 * release-assets.mjs — 把版本打包成 GitHub Release 附件（2026-10-25 m03530）。
 *
 * 主人要求：「上新版本的时候把挂在上面的旧版本打包作为 release 传上去，注意隐私管理」。
 *
 * 流程（每个 tag）：
 *   0. **回填底层状态指令 `#molly`**（2026-10-26 m00525，默认开）：`status-carry.mjs`
 *      往导出树里插三段代码 + 补 `lib/status-command.js`。历史 tag 的提交树不动，
 *      只是打出来的附件带上这个功能；`--no-carry-status` 可关（几乎不需要）。
 *      回填失败或校验不过 → 该 tag 拒绝上传（宁可不上，也不上坏包）。
 *   1. `git archive` 导出该 tag 的提交树到临时目录（不含 .git / 未提交文件）；
 *   2. **隐私扫描**：真实 QQ 号/群号、OneBot/NapCat/PushPlus token、本机用户目录；
 *   3. 命中就地**脱敏**（换成占位符），再扫一遍；仍有命中 → 拒绝上传并报文件:行号；
 *   4. 用 bsdtar 打成 `molly-qq-whale-<tag>.zip`；
 *   5. GitHub REST API：release 不存在就建（preview tag 自动标 prerelease），
 *      上传附件；同名附件先删后传，可重复执行；
 *   6. release 正文写清「隐私扫描/脱敏结果 + 文件数 + sha256」。
 *
 * 用法（源码仓库根目录，用 bundled node）：
 *   node tools/release-assets.mjs --dry-run          # 只扫描/脱敏/打包，不上传
 *   node tools/release-assets.mjs                    # 所有 tag 补齐 release 附件
 *   node tools/release-assets.mjs --tags v1.1.3      # 只处理指定 tag
 *
 * 凭据（按顺序）：GITHUB_TOKEN / GH_TOKEN / MOLLY_GH_TOKEN → `git credential fill`。
 * 凭据只在内存里用，绝不打印、绝不写日志。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { applyStatusCarry, STATUS_REL } from './status-carry.mjs'

const DEFAULT_REPO_DIR = 'G:\\Molly\\publish\\molly-qq-whale'
const WORK_DIR = path.join(process.cwd(), 'out', 'release-assets')

/* ── 隐私名单：真实 QQ 号/群号/token 只放本地文件，绝不进发布仓库 ────────────
 * 本地文件：`tools/release-assets.secrets.json`（{"patterns":[…],"redact":{…}}）
 * 可用环境变量 MOLLY_RELEASE_SECRETS 指向别处；读不到就只有通用规则（路径/密钥头）。
 */
/* 通用规则：只认「私钥/证书头」这类明确长串；本机路径类不在这里拦——
 * 文档里 `C:\\Users\\…` 是示例路径，拦了反而把正常文档改坏。
 * 注意：下面的字面量用拼接写，避免脚本自身被自己的规则命中。 */
const GENERIC_PATTERNS = [
  ['BEGIN ', 'RSA PRIVATE KEY'].join(''),
  ['BEGIN ', 'PRIVATE KEY'].join(''),
  ['ssh-', 'rsa AAAA'].join(''),
]
const SECRETS_FILE = process.env.MOLLY_RELEASE_SECRETS || path.join(process.cwd(), 'tools', 'release-assets.secrets.json')

/* ── 每个版本的「本版特性」：写进 release 正文，让仓库读者一眼看到改了什么 ── */
const RELEASE_FEATURES = {
  'v1.1.6-preview.2': [
    '**预览版（1.1.6 第二个）**：记忆体系重做 + 同群双泳道 + 「回不过来」兜底 + 开机自启 + 三级去重。预览版可能有毛刺，稳妥请留在 `v1.1.5-A-Hotfix.1`',
    '**记忆库正式署名「茉莉花」**：这套记忆系统的名字就叫**茉莉花**（代码里 `MEMORY_SYSTEM_NAME`，控制台与 `/state.memory.name` 都能看到）。名字只用于对外说明，不参与任何检索/去重/衰减逻辑',
    '**容量一次给到 5 万条**：`memoryPoolLimit` / `memoryPoolMax` 都设成 50000，先攒到 5 万，再满才按「有效权重 + 活跃天」淘汰（以前是 2000 满了才慢慢扩到 1 万）',
    '**三级去重（学自白守的设计，代码全自写）**：相似度 ≥0.92 当重复直接跳过（文字不重写、只刷新"又被提起"的时间）；0.70~0.92 才合并（新的覆盖旧的、权重取高的、命中次数相加）；<0.70 当新信息。**意思相反的修正不合并**——「他喜欢猫」被「他其实不喜欢猫」纠正时两条都留，旧的打 `supersededBy` 标记、召回降权，避免提示词里两句相反的让她自己猜',
    '**记忆改成按机器人账号分七类落盘**：`<dataDir>/memory/<机器人QQ>/` 下拆成 `person` / `address` / `promise` / `fact` / `preference` / `event` / `meme` 七个加密分片，各带一个 `index.json`（条数、活跃天）。老的单个 `memory.json` 首次启动自动迁移成 `_legacy-memory.json` 归档，不会丢；多开时各账号互不污染（`qq` 字段仍然只表示"跟谁说"）',
    '**权重刻度 5 → 10（支持一位小数）**：老数据按 ×2 等比迁移，召回打分系数同步减半，排序结果与迁移前一致；称谓（address）一律钉满 10',
    '**阶梯衰减替代"永不忘记"**：只在"这天真聊过天"时记 1 个活跃天（关机不算），人物/约定/事实/偏好白给 14 活跃天、事件/梗 7 天，之后每 7 个活跃天 −0.5，掉到该类下限为止（约定 5 / 人物 4 / 事实与偏好 3 / 事件与梗 1）；命中会把它拉回当前活跃天（等于复习重新计时）。只在读取时算有效权重，不改盘、不依赖定时任务',
    '**命中记账**：每次被召回就 `hits+1` 并记 `lastHitAt` / `lastActiveDay`。以前全靠"印象"判断哪些常用，会系统性偏向遗忘刚用过的东西',
    '**写入闸门（防记忆库变谣言库）**：`source=assistant` 的**助手自述**不许写成 `fact` / `person`，只许 `preference` / `event` / `meme`；HTTP 接口会直接 400 说明原因',
    '**检索预算与压缩等级**：一次注入的记忆按字符预算截断（small 800 / balanced 1200 / large 1600 字符），并新增 `level` 0–3（原句 / 半句 / 一句 / 关键词）——只标记、不自动改写',
    '**三条现场投诉的修复**：① 认人——「他自称『茶茶』」这类句子不再被当成称谓（旧逻辑会把它抽成"叫他茶茶"，压过真正的「宝宝」）；名册每个成员后面直接标「（你要叫他「X」）」，称谓和时间在提示词结尾再念一遍；② 报时——群里别人说的点数**一律不算数**，只信时钟行，被问几点直接按行回答；③ 夜间语气——睡眠时段被反复催睡时别再冲人',
    '**取消「回不过来就不回」**：模型链全挂（主脑/备用/trae 都没接住、回空内容、流程抛错）时，改说一句人话兜底（「等等，我刚刚走神了，你再说一遍？」等四句随机），同会话 90 秒最多一次；`/state.stats.modelDownLines` 可看触发次数，仍想恢复静默就配 `silentOnModelFail: true`',
    '**同群双泳道（子房连 @ 三次不回的真凶）**：以前一个群只有一个 job，她在思考时来新消息就「作废重来」，刷屏时谁先 @ 谁被顶掉。现在拆成 `targeted`（@我 / 回我 / 私聊）与 `ambient`（群友闲聊）两条道：围观消息顶不掉 @ 她的那条；发送仍按会话串行，气泡不会交叉、引用不会挂错；另有全局模型并发闸门（`modelConcurrency` 默认 3）防止免费 flash 并发一高空回',
    '**开机自启（新增 `tools/start-dsh.ps1`）**：以前重启电脑后没人拉起 DeepSeek Harness 本体，QQ 自动登录了但她"没有大脑"。现在有登录触发的计划任务 `Molly-DSH`（延迟 30 秒，非管理员身份，已启动则跳过），watchdog 也加了一轮兜底（连续两轮没进程才拉起，3 分钟冷却），不会再因为重启整晚失联',
    '**控制台数据服务自愈**：19391 的数据服务（`panel-data.mjs`）没起来时，控制台会自己补拉一个（30 秒内最多一次），新部署少一个"数据服务不可达"的坑',
    '**仍然不含唱歌**：`singingEnabled` 保持关闭（音色未达标），本来说排在 1.1.6-preview.1，实际继续顺延',
    '本版**不含语音包**：音色包仍单独下 Releases 里的 `voice-pack-v1.2`（301 MB）',
    '升级：直接覆盖旧的插件包。老 `memory.json` 会自动迁移并归档，配置不用改；想回退见 `docs/CHANGELOG.md` 对应条目的「退回」段',
  ],
  'v1.1.5-A-Hotfix.1': [
    '**热修复（A 版第一个）**：抽奖房间落盘 + 群里 `#molly` 的在线状态',
    '**抽奖不再怕重载**：`start` / `join` / `draw` 都会把房间写到 `<dataDir>/out/lottery-rooms.json`（先写 `.tmp` 再 rename），插件重载或进程重启后自动恢复；到点没开的场次按 `endsAt` 补开一次，名单不丢，公告带前缀「（刚才我重载了一下，这场补开）」',
    '**补开会丢数据的真 bug 修掉**：旧流程是「先删场次 + 落盘，再发公告」，而启动时 `engine.init()` 早于 `engine.client` 挂载，`send` 必然抛错 —— 一抛就把那场和名单永久删光、群里什么都不发。现在改成「发成功才删」，失败按 15 秒重试、最多 8 次（`lotteryAnnounceRetries`），期间名单一直留在盘上；心跳与补发定时器之间加了互斥标志，不会重复发两条公告',
    '**卸载清理**：插件停用时会停掉抽奖心跳并 `dispose()`，不再留僵尸定时器',
    '**群里 `#molly` 一直显示「离线」修复**：链路状态有字符串和对象两种形状，`/state` 面板两种都兼容，但命令回复只按对象读 `ready`，字符串 `"online"` 读出来是 `undefined` → 永远落到「没连上」。现在统一归一，显示「在线 / 连接中 / 断线重连中 / 已停止」',
    '本版**不含语音包**：音色包仍单独下 Releases 里的 `voice-pack-v1.2`（301 MB）',
    '升级：直接覆盖旧的插件包，老配置文件不用改',
  ],
  'v1.1.5-A': [
    '**正式版（方案 A）**：以真机跑过的 `v1.1.5-preview.3` 为基线，重做「认人 / 命令通道 / 稳定性」三类补丁；不再整体搬回被撤回的 `v1.1.5` 那 32 个文件',
    '**认人（本版核心）**：记忆「称谓」按 QQ 匹配、每轮单独成段注入（不吃记忆权重窗口）；同一人多条按 **5 级权重**排序再按时间；提示词硬禁「不许把谁都叫成主人」「不许用哥们儿/兄弟/群友/老铁这类泛称，那等于没认出他」',
    '群里人多时新增「这会儿群里人多」段：只接最近那一条、接不过来就直说跟不上；**引用框锁定她真正在回的人**（模型点名 → 上一句 → 触发消息三级回退），不再固定挂最后一条',
    '私聊 `#` 菜单：`#` / `#状态` / `#记忆 关键词` / `#谁 名字或QQ` / `#开关`，纯文本直出、不进模型、不花额度；群里发 `#molly` 只回一行摘要（版本 · 在不在线 · 运行时长），**任何人可触发，同群 30 秒一条**',
    '群趣味：抽奖（时长上限 **1 小时**，支持「2 小时 / 90 分钟」写法）/ 口令场 / 新人自动欢迎；开奖加了 `sweep()` 兜底 + 15 秒心跳，定时器被吞也能补开',
    '修复抽奖 `@` 段发不出去（`{type:"at", data:{qq}}` → `{type:"at", qq}`）：以前到点开奖了但公告被 SnowLuma 整条拒绝，群里看着像「没开奖」',
    '语音：念稿中文规范化（`2K 60Hz` → 两K 六十赫兹、`28℃` → 二十八摄氏度、`40%` → 百分之四十）；本版**不启用** `voiceSpeed 0.93` + 句间停顿，回到 1.0 整段合成',
    '部署可移植性：没有 G: 盘也能启动（密钥/沙箱/参考音频/ASR 模型/boot-health/护栏全部按 `dataDir` 推导）；密钥按目录找，**盘上是密文但没有钥匙时拒绝写回**，不会明文覆盖',
    '**看板数据服务随包走**：补上 `tools/panel-data.mjs` 与 `tools/resolve-paths.mjs`（之前白名单漏发，新部署一开控制台就是「数据服务 19391 不可达」）；控制台与启动脚本也不再写死作者机路径',
    '**不含唱歌**：`singingEnabled` 保持关闭，排期 `1.1.6-preview.1`' ,
    '本版**不含语音包**：音色包单独下 Releases 里的 `voice-pack-v1.2`（301 MB）',
    '升级：直接覆盖旧的插件包；老配置里显式写了 `memoryKeyFile` / `workSandboxDir` 的机器行为不变',
  ],
  'v1.1.5-Hotfix.3': [
    '**部署修复（部署者反馈）**：发布包补上大看板的数据服务 `tools/panel-data.mjs`（与它用的 `tools/resolve-paths.mjs`）。之前白名单漏了它，任何新部署的控制台一打开就是「数据服务 19391 不可达」，概览/记忆/表情三块全空 —— 不是部署姿势问题',
    '控制台路径不再写死作者机：`tools/console-server.mjs` 的 `ROOT` 改为按脚本位置推导、`DATA` 按「`MOLLY_DATA_DIR` > 插件配置里的 `dataDir` > `~/.dsh/qq-whale`」解析；`panel-data.mjs` 同规则，端口可用 `MOLLY_SIDECAR_PORT` 覆盖',
    '`tools/start-molly.ps1` 启动 19391 时不再写死 node 绝对路径（`MOLLY_NODE` > PATH 里的 node > 历史路径兜底）',
    '同批合入另一条工作线的改动：群抽奖支持「小时」单位（最长 1 小时）、引用回复策略（人多时才引用）、开奖回调 `onDraw`',
    '插件本体路径可移植（之前只有工具链可移植）：`lib/main.js` 的 `memoryKeyFile` / `workSandboxDir` / `voiceRefAudio` / 三个 Python 解释器默认值全部改为「留空再按 `dataDir` 推导」，`lib/boot.js` 的健康文件、`lib/commands.js` 的沙箱与受保护路径、`lib/work-guard.js` 的护栏前缀、`lib/local-asr.js` / `lib/gif-frames.js` / `lib/singing.js` 的解释器路径也不再写死作者机的 `G:` 盘 —— 换机器不会再「插件像加载成功、其实 OneBot 从不连接」；没配 Python 时本地 ASR / 拆 GIF 帧 / 唱歌只是静默跳过，不影响聊天',
    '语音「英文腔」修复回到本版：合成前先把数字/单位念成中文（`2K 60Hz` → 两K 六十赫兹、`1080P` → 一零八零P、`16GB` → 十六个G、`40%` → 百分之四十、`28℃` → 二十八摄氏度、`5km` → 五公里、`12ms` → 十二毫秒），不再把阿拉伯数字和英文单位直接念成英文腔',
    '本版**不含语音包**：音色包与上一版相同，单独下 Releases 里的 `voice-pack-v1.2`（301 MB）',
    '升级：直接覆盖旧的插件包；控制台首次使用前先 `node tools/panel-data.mjs`（或由 `start-molly.ps1` 拉起），19391 没起来时页面会提示「数据服务不可达」，QQ 本体不受影响',
  ],
  'v1.1.5-Hotfix.2': [
    '**撤回 v1.1.5 与 v1.1.5-Hotfix.1**：这两个版本把「称谓」做坏了（会把群里的人认错、把主人叫成「群友哥们儿」），Release 与 tag 都已删除，请不要再用',
    '认人修复：称谓按**权重**优先（同一人多条时 5 级权重高的说了算，权重相同再按时间），「他自称…」「外号…」不再被当成你该怎么叫他',
    '称谓段加硬禁：群里打闹、开玩笑、别人怎么称呼他，都不许改用「哥们儿」「兄弟」「群友」「老铁」这类泛称；没记到的就用群名片或「你」，不许自己编',
    '新增私聊 `#` 菜单：`#` / `#状态` / `#记忆 关键词` / `#谁 名字或QQ` / `#开关`，纯文本直出、不进模型、不花额度；群里发 `#molly` 只回一行摘要（版本 · 在不在线 · 运行时长），同群 30 秒一条',
    '记忆密钥定位可移植（发布级地雷）：不再写死 `G:\\Molly\\keys\\memory.key`，按「配置 > 数据目录同级 qq-whale-keys > 数据目录内 > 老 G 盘路径」依次找；**有密文但找不到钥匙时拒绝新建、拒绝改写**，报「本机密钥不可用」而不是把记忆清空',
    '本版**不含语音包**：音色包与 v1.2 相同（权重逐字节一致），需要就单独下 Releases 里的 `voice-pack-v1.2`',
    '升级：直接覆盖旧的插件包即可；旧配置里写了 `memoryKeyFile` 的照旧生效',
  ],
  'v1.1.5-Hotfix.1': [
    '热修复：**称谓读取加固**——她按 QQ 记住的「叫他 X」不再被「你叫什么」这类反问带偏；同一人多条按最近一条算；解析不出的自称/昵称说明不再进提示词',
    '根因：学习链路把反问存成了称谓、`addressOf()` 把自称也当硬要求并列，三段互相矛盾 → flash 档退回群名片叫法。现在「# 怎么称呼」只拼 `- 叫他「X」`',
    '模型层 address 入库前必须含「叫他」；`guessKind()` 的 address 触发词去掉 `昵称/自称叫`（归 person 类）',
    '本版**不含语音包**：音色包 v1.2 单独发布在 Releases 的 `voice-pack-v1.2`（301 MB，包内 `README.md` 有用法与许可）',
    '升级：直接覆盖旧的插件包即可，不用改配置（历史里几条错误称谓已在上线时清掉）',
  ],
  'voice-pack-v1.2': [
    '与 voice-pack-v1.1 的差别：5 条样例按线上参数（`speed_factor 0.93` + 句间 30 ms）重渲染；文档修正 `voicePauseMs` 笔误、补「QQ 语音转文字」实测与限制说明；**数据与权重未变**',
    '内容不变：54 句训练素材、参考音频、5 条样例、切分/训练/合成脚本与权重（GPT e10 + SoVITS e16_s864）',
    '用法与 v1.1 相同：起 GPT-SoVITS `api_v2.py` → 切权重与参考音频 → `POST /tts` 带 `speed_factor: 0.93`；接进 Molly 时配 `voiceSpeed: 0.93` + `voicePauseMs: 30`',
  ],
  'v1.1.5': [
    '正式版：合并 v1.1.3-preview.1/2/3 与 v1.1.3-Hotfix.1/2/3、v1.1.3-plus.1/2/3（控制台数据补齐、GIF 多帧理解、北京时间/作息/群趣味）',
    '新增底层状态激发指令 `#molly`：私聊或群里整条消息触发，主人看详情、别人看一行，30 秒冷却',
    '语音：voiceSpeed（0.93）与 voicePauseMs（30）真正生效；念稿前做中文规范化，2K/60Hz/1080P/16GB 这类不再整句切英文音素',
    '记忆：新增「称谓」类 address，单独成类、按 QQ 匹配、每轮必带；历史记忆已迁移 13 条',
    '部署可移植性：没有 G: 盘也能启动；密钥/沙箱/参考音频/ASR 模型/boot-health/护栏全部按 dataDir 推导并可用配置覆盖；加密不可用时降级明文而不是启动崩溃（/state.memory.keyError 说明原因）',
    '唱歌功能未完成（音色训练集只能念不能真唱），singingEnabled 保持关闭，排期继续顺延到后续 1.1.6 版本',
  ],
  'v1.1.3-Hotfix.3': [
    '本版已合并 v1.1.3-plus.3（群趣味：抽奖 / 口令抽奖 / @我 # 小玩具入口），plus.3 的 tag 与 Release 已删除',
    '新人入群自动欢迎修好：notice 分发不再只转 poke，group_increase 能进引擎（之前欢迎开关开着也从不自动发）',
    '自动开奖 / 心跳兜底开奖现在计入控制台统计（/state.groupfun.stats.drawn）',
    '新增本地调试路由 POST /dsh-qq-whale/groupfun/notice，用合成入群通知验证欢迎链路',
  ],
  'v1.1.3-plus.3': [
    '修复抽奖自动开奖时 @ 消息段字段错位（导致到点开奖消息被拒发、群里看起来没开奖）',
    '群趣味新增 15 秒心跳扫尾（sweep / lastTick / lastAuto），到点漏开会自动补开',
    '新增本地调试路由 POST /dsh-qq-whale/lottery/simulate（以指定群员身份驱动抽奖/欢迎命令）',
    '升级：无需改配置；原先卡住的抽奖可在下一轮验证',
  ],
  'v1.0.0': [
    '首个正式版：记忆、表情包、语音、QQ 空间、自愈、控制台全部跑通闭环',
    '插件化跑在 DeepSeek Harness 宿主上（lib/boot.js 热更新，改插件不用重启宿主）',
    'SnowLuma OneBot v11 后端：群聊/私聊、CQ 码、戳一戳、语音条',
    '本地控制台：状态总览、记忆、表情包、开关与配置',
  ],
  'v1.1.0': [
    '记忆池：上限可配 2000 条，记满自动扩到 10000；写入去重（新的覆盖旧的，相似度 0.7）',
    '记忆加密：AES-256-GCM 信封落盘，密钥与数据分目录（keys/memory.key）',
    '记忆备份：每 2 小时把记忆文件复制到 D:\\\\MollyBackup 与 G:\\\\MollyBackup（保留 48 份）',
    '语音：字数上限 42 → 220 字（≈56 秒），新增 58 秒时长闸门，合成超时 20s → 90s',
    '模型链路：新增 gatewayRealm 可钉国内积分池（X-Realm），/state.model 回读 realm',
  ],
  'v1.1.1': [
    '语音显式触发：新标记 <voice>…</voice>，模型可主动让她「说出来」（不看 voiceChance，仍受 220 字/58 秒闸门）',
    '戳一戳回应：反戳 / 说一句 / 被戳多下生气（状态机，不走模型）',
    '重复发消息根治：出站 60 秒幂等窗口，同目标同文本只发一次',
    '假宣告修复：历史里的「（我发了一条语音：…）」与 [语音:…] 反向翻译回 <voice>',
  ],
  'v1.1.2': [
    '撤回后不追旧消息：剔除历史、作废在途回复，可轻回一句（新 lib/engine-recall.js）',
    '群里明确要求就当场发：显式要求 / 坚持第二遍 / 180 秒兜底，按句分条（新 lib/group-echo.js）',
    '查资料不再自己往群里发：research 期间出站被拦，只给结论由引擎发回',
    '好友申请不漏报：user_id 为空时合成 key，支持按序号审批',
    '默认音色切到 molly_own（自录 54 句微调）',
  ],
  'v1.1.3': [
    '合并三个预览版：戳一戳改模型回话、控制台改版、记忆「梗」类、上下文体积优化 A、@ 错人修复',
    '引用回复不带语音：引用某条消息时语音段自动降级成文字（保留内容）',
    '控制台版本号以插件版本为真源：左下角不再写死 v1.0.0',
    '控制台表情包搜索：按名字 / 关键词即时过滤（空格多词 AND，Esc 清空）',
    '每个版本都提供脱敏后的源码 zip 附件（本仓库 Release）',
  ],
  'v1.1.3-Hotfix.1': [
    '入站语音转文字：别人发语音时用 QQ 自带转写（SnowLuma fetch_ptt_text，实测 0.2–0.3 秒）把内容带给模型',
    '转写失败降级成「[语音：没听清]」（不再当成空消息）；10 分钟缓存，同一条语音只转一次',
    '新配置 voiceTranscribeEnabled / voiceTranscribeTimeoutMs（默认开 / 6000ms）',
  ],
  'v1.1.3-Hotfix.2': [
    '群聊语音本地 ASR 兜底：QQ 服务端转写拿不到结果时，用本机 faster-whisper 识别（复用视频分析 venv 里已装模型，无新依赖、不联网）',
    '语音识别分级：QQ fetch_ptt_text 优先（0.2–0.3 秒）→ 失败转 get_record wav + 本地识别（首次 1.6 秒、之后 1.4–1.6 秒）→ 再失败降级「[语音：没听清]」',
    '新增 7 个 voiceAsr* 配置（开关 / Python 解释器 / 模型 / 线程 / 超时 / 空闲退出 / 最长识别时长），/state.stats 新增 voiceAsrTranscribed / voiceAsrFail',
    '控制台「本次更新说明」：左下角版本号可点击，弹层直接读 docs/CHANGELOG.md 最新一节；新增 GET /api/changelog',
  ],
  'v1.1.5-preview.3': [
    '⚠️ 本 tag 于 2026-10-25 重建：并入群趣味（抽奖 / 口令抽奖 / 新人欢迎）与 @我 # 小玩具入口',
    '时间感知：每轮提示词带「北京时间」（timeContextEnabled），问几点/星期几不再靠猜',
    '唱歌（暂缓，默认关闭）：算法已实现（逐字合成 + ACF 基频搬移 + WSOLA 保时长，42 个音平均误差 14.6 音分），但语音包只有 54 句 / 3.5 分钟、音色未达标，按主人要求先下架；等训练数据齐后改用社区歌唱模型再开',
    '动图表情重扫：新增 tools/rescan-gif-stickers.mjs（默认预览，--apply 改名，报告在 out/rescan-gif-report.json）',
    '作息：按北京时间判断该不该睡（sleepWindowStart/End 默认 23:50–09:00）：窗口内不主动找人、群聊不插话，私聊叫醒；控制台「设置 → 作息时间」可改，保存立即生效',
    '升级后请运行：node tools/rescan-gif-stickers.mjs（先预览）→ node tools/rescan-gif-stickers.mjs --apply',
  ],
  'v1.1.5-preview.2': [
    '⚠️ 本 tag 于 2026-10-25 重建：并入群趣味（抽奖 / 口令抽奖 / 新人欢迎）与 @我 # 小玩具入口',
    '动图理解：GIF / 动画表情在发模型前用本机 Pillow 拆成多帧拼图（默认 6 帧 / 3 列 / 320px，左上角帧号），模型能按顺序看懂动作；单帧 GIF、缺 Pillow、超时都会回退原图',
    '新增 6 个 gifFrames* 配置（开关 / 帧数 / 列数 / 帧宽 / Python 路径 / 超时），/state.stats 新增 gifSheets / gifSheetFail',
    '带图轮次不再「看了不吭声」：输出预算抬到 imageMaxTokens（默认 3200）并传 reasoning_effort=minimal，避免思考 token 吃光正文',
    '两个回归脚本：out/_gif_frames_test.mjs（16 项）、out/_image_effort_test.mjs（5 项）',
  ],
  'v1.1.5-preview.1': [
    '⚠️ 本 tag 于 2026-10-25 重建：并入群趣味（抽奖 / 口令抽奖 / 新人欢迎）与 @我 # 小玩具入口',
    '控制台数据补齐：学习器（累计/今日）、群数（SnowLuma 群列表）、记忆条数（加密后走插件兜底并标注来源）、表情包「已学」不再显示「—」',
    'QQ 下「登录」「QQ 连接」合并为一页：连接状态卡 + 扫码登录同页，旧 #/login 自动跳转 #/qq',
  ],
  'v1.1.3-preview.1': [
    '戳一戳「说一句」改为模型回复：pokeUseModel，超时/失败回退原固定句池',
    '控制台改版：去掉 NapCat 品牌、QQ 连接四态判定、导航六组、新增 #/qq 页面',
  ],
  'v1.1.3-preview.2': [
    '记忆新增「梗」类（meme）：抽取认「梗：/热梗：/名场面：」前缀，召回加权 +3',
    '上下文体积优化 A：记忆窗口 large → balanced，一轮 prompt 6,869 → 5,935 token（-13.6%）',
  ],
  'v1.1.3-preview.3': [
    '@ 错人修复（新 lib/quote-at.js）：@ 号必须是最近说话人、纯叫醒不算回复对象、人群拥挤时才引用、提示词补两句',
  ],
  'v1.1.3-plus.2': [
    '小玩具统一入口：@我 # 打开小玩具菜单，@我 #抽奖 直达抽奖菜单（以后新玩具都挂这里）',
    '口令抽奖：抽奖 口令 干饭 3人 60秒 —— 窗口内整句发出口令的人才算参加，到点只从这些人里抽',
    '抽奖全家桶：开一场 / 参加 / 提前开奖 / 取消 / 名单，到点自动开奖，每群同时一场',
    '新人欢迎：有人入群自动欢迎，welcomeTexts 支持 {name}/{group}/{molly} 模板，60 秒冷却',
  ],
  'v1.1.3-plus.1': [
    '群内抽奖（新 lib/groupfun.js）：@Molly 抽奖 出菜单，支持 开一场 / 报名 / 开奖 / 取消 / 看名单；默认 3 人 120 秒、到点自动开奖并 @ 中奖者',
    '新人入群自动欢迎：识别 group_increase 通知，按群名 / 昵称生成欢迎语，可配文案、默认 60 秒冷却',
    '全部走纯逻辑不进模型（不花 token）；配置 13 个 groupfun*/lottery*/welcome* 键；/state.groupfun 暴露状态',
  ],
  'voice-pack-v1.0': [
    'Molly 自录 54 句微调音色包：GPT / SoVITS 权重 + 参考音频 + 切好的训练片段 + 训练配置与脚本',
    '授权 CC BY-NC-SA 4.0（禁止冒充真人 / 商用）；不含原始连续录音，只发切好的片段',
  ],
}

/* 旧版本附件里的文件数（GitHub API 不回报文件数，这里记住） */
const RELEASE_ASSET_FILES = {
  'v1.1.3-Hotfix.3': 166,
  'v1.1.3-plus.3': 0,
  'v1.0.0': 150, 'v1.1.0': 155, 'v1.1.1': 156, 'v1.1.2': 158,
  'v1.1.3-preview.1': 158, 'v1.1.3-preview.2': 159, 'v1.1.3-preview.3': 160,
  'v1.1.3': 161, 'v1.1.3-Hotfix.1': 161, 'v1.1.3-Hotfix.2': 162, 'v1.1.5-preview.1': 166, 
  'v1.1.3-plus.1': 166,
  'v1.1.3-plus.2': 166,
  'v1.1.5-preview.3': 166, 'v1.1.5-preview.2': 166, 'voice-pack-v1.0': 76,
}

/* 旧版本脱敏命中数（正文里如实披露，body-only 刷新时沿用） */
const RELEASE_REDACT = {
  'v1.1.1': 5, 'v1.1.2': 8, 'v1.1.3-preview.1': 8, 'v1.1.3-preview.2': 8,
}


function loadPrivacy() {
  let patterns = [...GENERIC_PATTERNS]
  let redact = {}
  try {
    const raw = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'))
    if (Array.isArray(raw.patterns)) patterns = [...new Set([...patterns, ...raw.patterns.map(String)])]
    if (raw.redact && typeof raw.redact === 'object') redact = { ...raw.redact }
  } catch {
    console.warn(`[release-assets] 未读到本地隐私名单：${SECRETS_FILE}（只按通用规则扫描）`)
  }
  return { patterns, redact }
}

const { patterns: SECRET_PATTERNS, redact: REDACT } = loadPrivacy()

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.json', '.md', '.yml', '.yaml', '.html', '.css',
  '.txt', '.ps1', '.cmd', '.bat', '.sh', '.py', '.svg', '.example', '.gitignore', '.manifest',
])

/* ── 小工具 ──────────────────────────────────────────────────────────────── */
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`)
const isText = (file) => TEXT_EXT.has(path.extname(file).toLowerCase())

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (entry.isFile()) out.push(p)
  }
  return out
}

function parseArgs(argv) {
  const out = { repoDir: DEFAULT_REPO_DIR, tags: [], dryRun: false, bodyOnly: false, carryStatus: true }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--body-only') out.bodyOnly = true
    else if (a === '--no-carry-status') out.carryStatus = false
    else if (a === '--repo-dir') out.repoDir = argv[(i += 1)]
    else if (a === '--tags') out.tags = String(argv[(i += 1)] || '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--help' || a === '-h') {
      console.log('用法: node tools/release-assets.mjs [--dry-run] [--body-only] [--tags a,b] [--repo-dir DIR] [--no-carry-status]')
      process.exit(0)
    } else throw new Error(`未知参数：${a}`)
  }
  return out
}

/* ── 凭据：env 优先，其次 git credential store ───────────────────────────── */
function resolveToken(repoDir) {
  const envTok = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.MOLLY_GH_TOKEN || '').trim()
  if (envTok) return envTok
  try {
    const raw = execFileSync('git', ['credential', 'fill'], {
      cwd: repoDir,
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
    })
    const m = raw.match(/^password=(.+)$/m)
    if (m && m[1].trim()) return m[1].trim()
  } catch {
    /* ignore */
  }
  throw new Error('拿不到 GitHub 凭据：设 GITHUB_TOKEN，或先 git push 让 credential store 记住 PAT')
}

function parseRepo(repoDir) {
  const url = git(repoDir, ['remote', 'get-url', 'origin'])
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i)
  if (!m) throw new Error(`不是 GitHub 仓库：${url}`)
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') }
}

async function gh(token, method, apiPath, { json, body, headers = {} } = {}) {
  const res = await fetch(apiPath.startsWith('http') ? apiPath : `https://api.github.com${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'molly-release-assets',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: json ? JSON.stringify(json) : body,
  })
  if (res.status === 404) return null
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`${method} ${apiPath} → HTTP ${res.status} ${txt.slice(0, 400)}`)
  }
  if (res.status === 204) return {}
  return res.json()
}

/* ── 导出 tag 树（经 tar 中转，绝不带 .git）──────────────────────────────── */
function exportTag(repoDir, tag) {
  const dir = path.join(WORK_DIR, `tree-${tag}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const tarFile = path.join(WORK_DIR, `${tag}.tar`)
  execFileSync('git', ['archive', '--format=tar', '-o', tarFile, tag], { cwd: repoDir })
  execFileSync('tar', ['-x', '-f', tarFile, '-C', dir])
  fs.rmSync(tarFile, { force: true })
  return dir
}

/* ── 某 tag 的提交树里是否已自带 `#molly`（--body-only 判正文用）──────────── */
function treeHasStatus(repoDir, tag) {
  try {
    execFileSync('git', ['cat-file', '-e', `${tag}:${STATUS_REL}`], { cwd: repoDir, stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function tagVersion(repoDir, tag) {
  try {
    return String(JSON.parse(git(repoDir, ['show', `${tag}:package.json`]))?.version || '')
  } catch {
    return ''
  }
}

/* ── 回填台账：哪些 tag 的**附件**已经带过 `#molly`（历史 tag 的提交树里没有）──
 * `--body-only` 只改正文、不重打包，靠这份台账才敢继续宣称「带 #molly」；
 * 台账由真正上传成功的那次写（不写进 git 也能接受：它只是本地记录，
 * 丢了最多是正文少一行说明，功能本身在 zip 里）。
 */
const CARRY_LEDGER = path.join(process.cwd(), 'tools', 'release-carry.json')

function readCarryLedger() {
  try {
    const raw = JSON.parse(fs.readFileSync(CARRY_LEDGER, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch {
    return {}
  }
}

function recordCarried(tag, carried, asset) {
  if (!carried) return
  try {
    const ledger = readCarryLedger()
    ledger[tag] = {
      at: new Date().toISOString(),
      version: carried.version || '',
      sha256: asset?.sha || '',
      bytes: asset?.bytes || 0,
      files: asset?.files || 0,
    }
    fs.writeFileSync(CARRY_LEDGER, JSON.stringify(ledger, null, 2) + '\n', 'utf8')
  } catch {
    /* 台账写不进去不影响发布 */
  }
}

/* ── 扫描 / 脱敏 ─────────────────────────────────────────────────────────── */
function scanTree(dir) {
  const hits = []
  for (const file of walk(dir)) {
    if (!isText(file) || fs.statSync(file).size > 8 * 1024 * 1024) continue
    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split(/\r?\n/)
    for (const pat of SECRET_PATTERNS) {
      lines.forEach((line, idx) => {
        if (line.includes(pat)) hits.push({ pattern: pat, file: path.relative(dir, file), line: idx + 1 })
      })
    }
  }
  return hits
}

function sanitizeTree(dir) {
  // 每个敏感串都要有替换值；REDACT 没写到的按类型兜底，避免「脱敏后仍有命中」
  const map = { ...REDACT }
  for (const pat of SECRET_PATTERNS) {
    if (map[pat]) continue
    if (/^\d+$/.test(pat)) map[pat] = '111111111'
    else if (pat.includes('\\') || pat.includes('/')) map[pat] = '${PATH}'
    else map[pat] = '${SECRET}'
  }
  let files = 0
  let replacements = 0
  for (const file of walk(dir)) {
    if (!isText(file) || fs.statSync(file).size > 8 * 1024 * 1024) continue
    const before = fs.readFileSync(file, 'utf8')
    let after = before
    for (const [from, to] of Object.entries(map)) {
      if (!after.includes(from)) continue
      const parts = after.split(from)
      replacements += parts.length - 1
      after = parts.join(to)
    }
    if (after !== before) {
      fs.writeFileSync(file, after, 'utf8')
      files += 1
    }
  }
  return { files, replacements }
}

/* ── 打包（bsdtar 按扩展名自动用 zip）────────────────────────────────────── */
function zipTree(dir, tag) {
  fs.mkdirSync(WORK_DIR, { recursive: true })
  const name = `molly-qq-whale-${tag}.zip`
  const file = path.join(WORK_DIR, name)
  fs.rmSync(file, { force: true })
  execFileSync('tar', ['-a', '-c', '-f', file, '-C', path.dirname(dir), path.basename(dir)])
  const files = walk(dir).length
  return { file, name, files, bytes: fs.statSync(file).size, sha: sha256(file) }
}

/* ── 部署前必读：正式版 release 正文置顶提醒（2026-10-25 m05815） ── */
const DEPLOY_NOTICE = [
  '> **⚠️ 部署前必读**',
  '> - **不自带大脑**：回复全部来自大模型 API，没有可用 API 或网关就聊不起来。',
  '> - **API 怎么来**：直连 DeepSeek 官方 API 即可（国内可访问、按量付费）；也可用中转站或自建网关——中转站质量/稳定性参差、额度限制常见，自行甄别。',
  '> - **部署要花钱**：多群/语音/动图都会消耗 token，几十块起步；代部署的 AI 也在烧 token，建议先把网关跑通再装。',
  '',
]

function releaseBody(tag, asset, commit, redact, carried) {
  const kind = tag.includes('-preview') ? '预览版' : '正式版'
  const lines = []
  // 正式版置顶部署提醒；预览版不加，避免干扰（m05815）
  if (!tag.includes('-preview')) lines.push(...DEPLOY_NOTICE, '')
  lines.push('**molly-qq-whale ' + tag + '**（' + kind + (commit ? '，提交 \`' + commit + '\`' : '') + '）')

  const feats = RELEASE_FEATURES[tag]
  if (feats && feats.length) {
    lines.push('', '## 本版特性', ...feats.map((f) => '- ' + f))
  }

  // 底层状态指令 `#molly`：2026-10-26 起所有附件统一回填（m00525）
  if (carried) {
    const ver = carried.version ? '（v' + carried.version + '）' : ''
    lines.push('', '## 内置状态指令', '- 群里/私聊**整条消息**发 \`#molly\`' + ver + '，她会回一条自己的真实状态（不花 token、不看上下文、闭眼模式也应答）。')
  }

  var replacements = redact && Number(redact.replacements) > 0 ? Number(redact.replacements) : 0
  if (asset) {
    lines.push('')
    lines.push('- 附件：\`' + asset.name + '\`（' + fmtSize(asset.bytes) + (asset.files ? '，' + asset.files + ' 个文件' : '') + '）')
    if (asset.sha) lines.push('- sha256：\`' + asset.sha + '\`')
  }
  lines.push('')
  if (replacements > 0) {
    lines.push('- 隐私：该版本历史提交树里还残留 ' + replacements + ' 处真实 QQ 号/群号/token，**附件已就地脱敏**（换成占位符）后才打包。')
  } else {
    lines.push('- 隐私：打包前对该 tag 的提交树做了敏感串扫描（真实 QQ 号/群号、token、本机用户目录），0 命中。')
  }
  lines.push('- 内容来自发布仓库的该 tag 提交树，不含 \`.git\`、不含未提交文件。')
  return lines.join('\n')
}

async function ensureRelease(token, repoInfo, tag, asset, commit, redact, carried) {
  const { owner, repo } = repoInfo
  const body = releaseBody(tag, asset, commit, redact, carried)
  const existing = await gh(token, 'GET', `/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`)
  if (existing) {
    await gh(token, 'PATCH', `/repos/${owner}/${repo}/releases/${existing.id}`, {
      json: { body, prerelease: tag.includes('-preview'), name: tag },
    })
    return { id: existing.id, created: false }
  }
  const created = await gh(token, 'POST', `/repos/${owner}/${repo}/releases`, {
    json: { tag_name: tag, name: tag, body, draft: false, prerelease: tag.includes('-preview') },
  })
  return { id: created.id, created: true }
}

async function uploadAsset(token, repoInfo, releaseId, asset) {
  const { owner, repo } = repoInfo
  const list = await gh(token, 'GET', `/repos/${owner}/${repo}/releases/${releaseId}/assets?per_page=100`)
  const same = (list || []).find((a) => a.name === asset.name)
  if (same) await gh(token, 'DELETE', `/repos/${owner}/${repo}/releases/assets/${same.id}`)
  const res = await fetch(
    `https://uploads.github.com/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/zip',
        'User-Agent': 'molly-release-assets',
        'Content-Length': String(asset.bytes),
      },
      body: fs.readFileSync(asset.file),
    },
  )
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`上传 ${asset.name} 失败：HTTP ${res.status} ${txt.slice(0, 400)}`)
  }
  return res.json()
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const repoDir = path.resolve(args.repoDir)
  if (!fs.existsSync(path.join(repoDir, '.git'))) throw new Error(`不是 git 仓库：${repoDir}`)

  const allTags = git(repoDir, ['tag', '--list', '--sort=v:refname']).split(/\r?\n/).filter(Boolean)
  const tags = args.tags.length ? args.tags : allTags
  if (!args.bodyOnly) for (const t of tags) if (!allTags.includes(t)) throw new Error(`tag 不存在：${t}`)

  const repoInfo = parseRepo(repoDir)
  const token = args.dryRun ? '' : resolveToken(repoDir)
  fs.mkdirSync(WORK_DIR, { recursive: true })
  console.log(`仓库：${repoInfo.owner}/${repoInfo.repo}  发布目录：${repoDir}`)
  console.log(`待处理 tag（${tags.length}）：${tags.join(', ')}${args.dryRun ? '   [dry-run]' : ''}\n`)

  const summary = []
  for (const tag of tags) {
    if (args.bodyOnly) {
      const rel = await gh(token, 'GET', '/repos/' + repoInfo.owner + '/' + repoInfo.repo + '/releases/tags/' + encodeURIComponent(tag))
      if (!rel) throw new Error('release 不存在，无法只改正文：' + tag)
      const assets = rel.assets || []
      const zip = assets.find((a) => /\.zip$/i.test(a.name)) || assets[0] || null
      const led = readCarryLedger()[tag] || null
      const asset = zip
        ? {
            name: zip.name,
            bytes: zip.size,
            // 台账里记的是上次真正上传时的文件数（回填后比老地图准一个文件）
            files: led?.files || RELEASE_ASSET_FILES[tag] || 0,
            sha: String(zip.digest || '').replace(/^sha256:/, ''),
          }
        : null
      let commit = ''
      try { commit = git(repoDir, ['rev-list', '-n', '1', tag]) } catch { commit = '' }
      const redact = { replacements: RELEASE_REDACT[tag] || 0 }
      const carried = treeHasStatus(repoDir, tag)
        ? { version: tagVersion(repoDir, tag) }
        : readCarryLedger()[tag] || null
      const updated = await ensureRelease(token, repoInfo, tag, asset, commit, redact, carried)
      console.log('- ' + tag + ' 正文已更新（release #' + updated.id + '，附件 ' + (asset ? asset.name : '无') + '）')
      summary.push({ tag, status: 'body-only', asset, redact })
      continue
    }
    const commit = git(repoDir, ['rev-list', '-n', '1', tag])
    process.stdout.write(`- ${tag}（${commit.slice(0, 7)}）导出… `)
    const dir = exportTag(repoDir, tag)
    // 0. 回填底层状态指令 `#molly`（2026-10-26 m00525；历史 tag 的提交树不动，只改打出来的包）
    let carried = null
    if (args.carryStatus) {
      process.stdout.write('回填 #molly… ')
      const carry = applyStatusCarry(dir)
      if (!carry.ok) {
        console.log('❌ 回填校验不过，拒绝上传')
        for (const p of carry.problems.slice(0, 8)) console.log(`    - ${String(p).split('\n')[0]}`)
        summary.push({ tag, status: 'blocked-carry', problems: carry.problems })
        fs.rmSync(dir, { recursive: true, force: true })
        continue
      }
      carried = { version: carry.manifest.version || '' }
      process.stdout.write(`${carry.changed ? '已插入' : '已存在'} ${carry.manifest.addedLines} 行，`)
    }
    let hits = scanTree(dir)
    let redact = { files: 0, replacements: 0 }
    if (hits.length) {
      process.stdout.write(`命中 ${hits.length} 处，就地脱敏… `)
      redact = sanitizeTree(dir)
      hits = scanTree(dir)
      if (hits.length) {
        console.log('❌ 脱敏后仍有命中，拒绝上传')
        for (const h of hits.slice(0, 8)) console.log(`    ${h.pattern} :: ${h.file}:${h.line}`)
        summary.push({ tag, status: 'blocked', hits: hits.length })
        fs.rmSync(dir, { recursive: true, force: true })
        continue
      }
    }
    const asset = zipTree(dir, tag)
    fs.rmSync(dir, { recursive: true, force: true })
    const tagNote = redact.replacements ? `脱敏 ${redact.replacements} 处 / ${redact.files} 文件，` : ''
    console.log(`${tagNote}${asset.name} ${fmtSize(asset.bytes)} / ${asset.files} 文件 / sha256=${asset.sha.slice(0, 16)}…`)
    if (args.dryRun) {
      summary.push({ tag, status: 'dry-run', asset, redact, carried })
      continue
    }
    const rel = await ensureRelease(token, repoInfo, tag, asset, commit, redact, carried)
    await uploadAsset(token, repoInfo, rel.id, asset)
    recordCarried(tag, carried, asset)
    console.log(`    release ${rel.created ? '已新建' : '已存在'} #${rel.id}，附件已上传`)
    summary.push({ tag, status: redact.replacements ? 'sanitized' : 'ok', asset, releaseId: rel.id, redact, carried })
  }

  console.log('\n=== 汇总 ===')
  for (const s of summary) {
    const carryNote = s.carried ? ' 含 #molly' : ''
    const note = s.asset ? `${s.asset.name} ${fmtSize(s.asset.bytes)}${s.redact && s.redact.replacements ? `（脱敏 ${s.redact.replacements} 处）` : ''}${carryNote}` : carryNote.trim()
    console.log(`${s.tag.padEnd(22)} ${s.status.padEnd(10)} ${note}`)
  }
  const blocked = summary.filter((s) => s.status === 'blocked')
  const blockedCarry = summary.filter((s) => s.status === 'blocked-carry')
  if (blocked.length) {
    console.log(`\n注意：${blocked.length} 个 tag 脱敏后仍有敏感命中，未上传。`)
  }
  if (blockedCarry.length) {
    console.log(`\n注意：${blockedCarry.length} 个 tag 的 #molly 回填校验不过，未上传：${blockedCarry.map((s) => s.tag).join(', ')}`)
  }
  if (blocked.length || blockedCarry.length) process.exitCode = 2
}

main().catch((err) => {
  console.error('\n[release-assets] 失败：', err && err.message ? err.message : err)
  process.exitCode = 1
})
