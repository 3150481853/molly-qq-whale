/**
 * 持久记忆。
 *
 * 需求很直接：「不要在 QQ 聊着聊着就忘了我」。
 *
 * 而 DSH 本身就把会话存成 jsonl.zstd 落在磁盘上，天然具备持久化。
 * 所以这里**不重新造一套记忆库**，而是：
 *   1. 把每一轮 QQ 对话映射到一条固定的 DSH 会话（每个私聊对象 / 每个群一条）
 *   2. 会话不通就自动重建，重建时用 memory.md 里的"她的记忆摘要"当种子
 *   3. 另外维护一份人读得懂的记忆文件（memory.md），记录事实与关系，
 *      供上下文压缩和跨会话召回使用
 *
 * 为什么不直接塞 vector DB：这个场景的记忆量级是「几百条事实」，
 * 结构化文件 + 命中关键词比向量检索更可控，也不会产生"记错了"的幻觉。
 */

import fs from 'node:fs'
import path from 'node:path'

import { localDateKey, localDateTime } from './budget.js'
import {
  decryptText,
  isEnvelope,
  loadKey,
  resolveKeyFile,
  writeEncryptedFile,
} from './memcrypt.js'

/**
 * 记忆召回窗口（P5 起点，task-55 定档）。
 *
 * ★ 要调窗口**只改这一处**：`MEMORY_WINDOW_PROFILES` + `WINDOW_PROFILE` 两个常量。
 *   其它文件（engine.js / engine-context.js / main.js）一律从这里取，不许再写死数字。
 *   改完把源码 lib 与安装副本 lib 各同步一次，再跑 tools/test-window-config.mjs。
 *
 * 数字怎么来的（2026-10-19 真实数据）：memory.md 共 60 条，单行 26~76 字，
 * 平均 42.6 字（其中「- 2026-10-19 [fact/w3] 」这类前缀约占 28 字，
 * 正文平均只有 15 字），所以一条记忆折进提示词大约 40~45 字。
 *
 *   - contextLimit 32：32 条 ≈ 1.4k 字 ≈ 950 token。原来是 24 条，
 *     在 60~100 条的规模下，第 25~32 位的「较早但高权重的偏好」会被切掉——
 *     用户抱怨的"记不住我说过的话"有一部分就是这个。再往上（48+）在
 *     当前记忆量级里重叠度高、边际收益小，先停在 32。
 *   - queryLimit 12：关键词召回要求「两字以上词命中」，精度高、条数天然偏少；
 *     同一话题常有 3~5 条相关（"猫叫团子" + "猫不爱吃湿粮" + "团子怕生"），
 *     8 条在高召回时会漏边，12 条留出余量。
 *   - degradedContextLimit 12 / degradedQueryLimit 6：降智档（trae）上下文小、
 *     响应慢，按主档 ×1.5 温和提高（8→12、4→6），仍显著小于主档，
 *     宁可少喂也不能让它想太久。
 *   - entryChars 240：单条记忆超过 240 字通常是模型自己写长的段落，会把
 *     别的条目挤掉；截断保留主干，超长内容本来就该拆成多条记
 *     （200→240 是给「一条完整的因果」留出空间）。
 *
 * 三档用途：small = 省钱/小模型，balanced = 线上默认，large = 排查
 * 「是不是喂太少」时对照用。切档只改 WINDOW_PROFILE 一个字符串，不动任何调用点。
 */
/*
 * 2026-10-25（体积审计 A 项，主人拍板「A 记忆窗口」）：
 *   large → balanced。审计实测（docs/AUDIT-2026-10-25-context-budget.md）：
 *   large 档 48 条记忆段 3,329 字 ≈ 2,145 token，是 system prompt 里最大单块；
 *   切 balanced 后 上下文 48→32 条、关键词召回 16→12 条、单条上限 320→240，
 *   一轮完整 prompt 省 ~931 token（约 -13.6%），人设/硬性规则一行不动。
 *   要回退：把这行改回 'large' 即恢复，不动任何调用点。
 */
export const WINDOW_PROFILE = 'balanced'

export const MEMORY_WINDOW_PROFILES = Object.freeze({
  small: Object.freeze({
    contextLimit: 20,
    queryLimit: 6,
    degradedContextLimit: 8,
    degradedQueryLimit: 4,
    entryChars: 200,
    charBudget: 800,
  }),
  balanced: Object.freeze({
    contextLimit: 32,
    queryLimit: 12,
    degradedContextLimit: 12,
    degradedQueryLimit: 6,
    entryChars: 240,
    charBudget: 1200,
  }),
  large: Object.freeze({
    contextLimit: 48,
    queryLimit: 16,
    degradedContextLimit: 18,
    degradedQueryLimit: 9,
    entryChars: 320,
    charBudget: 1600,
  }),
})

export const MEMORY_WINDOW = MEMORY_WINDOW_PROFILES[WINDOW_PROFILE]

// 配错档位名会静默变成 undefined，进而让 engine 里 limit=undefined 变成"不限"，
// 那是灾难级 bug；这里宁可启动就炸，也不要带着错配置跑。
if (!MEMORY_WINDOW) {
  throw new Error(`WINDOW_PROFILE 配错了：「${WINDOW_PROFILE}」，可选 ${Object.keys(MEMORY_WINDOW_PROFILES).join('/')}`)
}

/**
 * 记忆条目：
 *   { id, kind: 'fact'|'preference'|'promise'|'person'|'event'|'work'|'sticker'|'meme', who, qq, text, weight, at }
 * 2026-10-25（主人第 5 条）：新增 'meme'（梗/名场面/口头禅），她闲聊时能直接拿来玩。
 * 2026-10-26（回退到 preview.3 后的「认人」补丁）：新增 'address'（称谓），
 * 只由 addressOf() 按 QQ 读取、每轮必带，不参与普通召回（contextFor 里被过滤掉）。
 * weight 1..10（可一位小数），越高越不该被压缩掉。
 * 2026-10-27 主人 m01402：刻度从 5 级扩到 10 级，老数据整体 ×2 迁过来。
 *
 * `who` 与 `qq`（2026-10-19 用户需求）：
 *   - who：**名字**，给人看的（群名片/昵称，可带 emoji）
 *   - qq：**QQ 号，字符串**，唯一身份。同名不同号必须当成两个人
 *   - 老条目没有 qq → 读时补空串（不写盘），召回时退化成"只按名字认"
 * 为什么叫 qq 不叫 id：条目本身已经有 `id`（CRUD 的 update/delete 靠它），撞名。
 */
export const QQ_PATTERN = /^[1-9]\d{4,11}$/

/**
 * 权重刻度（2026-10-27 主人 m01402：「权重等级从 5 改为 10，按比例改动现有记忆权重，
 * 允许小数点后一位」；m01449：「称谓记忆依旧是最高，10」）。
 *
 * 旧刻度 1..5 → 新刻度 1..10 的等比映射就是 ×2：
 * 老的默认 3 → 6，老的最高 5 → 10，老的最低 1 → 2。
 * 现有数据已在 2026-10-27 全量 ×2 迁完（见 docs/CHANGELOG.md「权重刻度 5 → 10」）。
 *
 * 为什么要 ×2 而不是只把上限拉大：召回打分的 `weight * 0.3` 是**绝对**加分，
 * 若只改上限、老数据仍是 1..5，新记的条目凭空比旧的重一倍；
 * 反过来只改上限加数据 ×2、公式不动，分数又会整体翻倍盖过关键词命中。
 * 所以三处同时等比：数据 ×2、默认为 2 倍、打分系数减半 —— 排序结果与改动前完全一致。
 */
export const WEIGHT_MIN = 1
export const WEIGHT_MAX = 10
export const WEIGHT_DEFAULT = 6

/**
 * 记忆库的名字（2026-10-27 主人 m02812 定的署名）。
 *
 * 只用于对外的说明性文案：发布说明、文档、控制台的「记忆库」标题。
 * **不参与任何检索/去重/衰减逻辑**——名字是给人看的，不是给召回用的。
 */
export const MEMORY_SYSTEM_NAME = '茉莉花'

/**
 * 把任意输入夹进 1..10 并四舍五入到一位小数；非法值退回 fallback。
 * 路由层（web.js 的 parseWeight）和 store 层共用这一份，避免两处口径不一致。
 */
export function clampWeight(value, fallback = WEIGHT_DEFAULT) {
  const w = Number(value)
  if (!Number.isFinite(w)) return fallback
  const one = Math.round(w * 10) / 10
  return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, one))
}

/**
 * 记忆分七类（2026-10-27 主人 m01748 第 2 条：「记忆分账号再分七类储存」）。
 *
 * 为什么是这七类：原先 8 个 kind 混在一个 memory.json 里，尺子还不一样
 * （表情包和「他住广州」在同一个池子里抢窗口，还共用一套权重下限）。
 * 分七类之后一类一个文件，各有一套下限（见 WEIGHT_FLOOR）：
 * 「梗」可以烂得比「事实」快，而「约定」不该像闲聊一样掉价。
 *
 * 老 kind 一律映射过来，不丢数据：
 *   work    → event   （工作/项目进展本身就是一段时间里发生的事）
 *   sticker → meme    （表情包是拿来玩的梗，不是知识）
 *   其余未知 → fact   （宁可当成普通事实，也不能让它从召回里消失）
 */
export const MEMORY_KINDS = Object.freeze([
  'person',
  'address',
  'promise',
  'fact',
  'preference',
  'event',
  'meme',
])

/** 老 kind → 新七类的别名表（work→event、sticker→meme），读取/写入口都过一遍 */
export const KIND_ALIASES = Object.freeze({ work: 'event', sticker: 'meme' })

/** 任意 kind → 七类之一；空/非法一律落 fact */
export function normalizeKind(kind) {
  const k = String(kind ?? '').trim().toLowerCase()
  if (!k) return 'fact'
  if (MEMORY_KINDS.includes(k)) return k
  return KIND_ALIASES[k] || 'fact'
}

/**
 * 这条记忆是谁说的。
 *
 * 引入来源不是为了追责，而是为了**挡住一种最常见的污染**：
 * 她自己接话时说「我听说他下个月要搬家」，被当成事实记下来，
 * 三天后就有了「他下个月要搬家」这条"记忆"——可用户从来没说过。
 * 第 5 篇（木子伟宸）把这条写成硬规矩：「事实必须来自用户陈述或明确认可，
 * 助手单方面编写的经历不能当作已经发生」。
 *
 * 所以：assistant 来源只允许写 preference / event / meme（她的印象、她的梗），
 * 不许写 fact / person（客观事实与身份）。
 */
export const MEMORY_SOURCES = Object.freeze(['user', 'assistant', 'system'])

export function normalizeSource(source) {
  const s = String(source ?? '').trim().toLowerCase()
  return MEMORY_SOURCES.includes(s) ? s : 'user'
}

/**
 * 每类的权重下限（2026-10-27 主人 m01748 第 1 条：「模拟艾宾浩斯来逐渐降低权重，
 * 按照小数点级下降，但是有下限」）。
 *
 * 为什么下限要分类定，而不是统一 1：
 *   - 称谓（address）根本不参与召回、每轮无条件注入，衰减没有意义，钉死 10；
 *   - 约定（promise）掉到 1 就等于「答应过的事也想不起来了」，下限给 5；
 *   - 人物（person）是「你是谁」这类问题唯一的答案来源，下限 4；
 *   - 事实/偏好 3，闲聊里的事、玩过的梗 1（这些本来就可以忘）。
 * 想调大调小，只改这张表——effectiveWeight() 是唯一读它的地方。
 */
export const WEIGHT_FLOOR = Object.freeze({
  address: 10,
  promise: 5,
  person: 4,
  fact: 3,
  preference: 3,
  event: 1,
  meme: 1,
})

/**
 * 归档门槛（P1-3，学白守的「归档而不是只靠淘汰」）：
 * 有效权重掉到该类下限、并且晾够 90 个**活跃天**的 event/meme，
 * 从热池挪进 `<shardDir>/_archive.json`——不物理删除，人工可复原。
 *
 * 为什么是 90：event/meme 的下限只有 1，掉到底本身已经说明「很久没用了」；
 * 再加 90 个活跃天（不是日历天，理由见下面衰减那段）是第二道保险，
 * 免得一段刚聊过、只是权重低的经历被立刻归档。
 * 为什么只归档 event/meme：事实/偏好/约定/人物/称谓掉到下限更应该留在池子里
 * 等下一次命中（命中会把权重拉回去），它们不该因为「暂时没被问」就被挪走。
 */
export const ARCHIVE_IDLE_DAYS = 90

/**
 * 衰减参数（2026-10-27 主人 m01812：「建议不要完全按照艾宾浩斯的天数曲线」）。
 *
 * 改成**活跃天 + 阶梯**，不再用「日历天 × 指数」：
 *   1. 只在「这一天真的聊过天」时才记 1 个活跃天。关机一周、换机器、停机维护
 *      都不算时间——记忆不会因为我们没上班而变淡；
 *   2. 同一天里问多少句都只算 1 天，避免「晚上聊得多，早上全忘了」；
 *   3. 曲线是阶梯不是断崖：先白给一段宽限期，之后每 7 个活跃天掉 0.5，
 *      掉到该类下限为止。0.5 的步子比指数曲线好解释，也不会掉到一半突然跳；
 *   4. 命中会把它拉回当前活跃天（相当于复习一次，重新开始计），
 *      这就是「记住的东西更牢」的那部分。
 *
 * 为什么不做成真·艾宾浩斯（R = e^(−t/S)）：那个曲线的假设是「被动遗忘」，
 * 而我们这里绝大多数记忆根本没人问、没进过上下文——按日历天算会让全部记忆
 * 同时掉到下限，等于「所有人一起忘」，反而没有区分度。
 */
export const DECAY_STEP_DAYS = 7
export const DECAY_STEP = 0.5

/** 宽限期（活跃天）：这段时间内一律不掉，之后才开始走阶梯 */
export const GRACE_ACTIVE_DAYS = Object.freeze({
  address: Infinity,
  promise: 14,
  person: 14,
  fact: 14,
  preference: 14,
  event: 7,
  meme: 7,
})

/**
 * 有效权重：base − ⌊(idle − 宽限) / 7⌋ × 0.5，夹在该类下限与上限之间，一位小数。
 *
 * `activeDays` 由 store 维护（今天聊过天才 +1，见 touchActivity()）；
 * 条目记 `lastActiveDay`，差值就是「它被晾了多少个活跃天」。
 * 老条目没有这个字段时按 0 处理——也就是从迁移那一刻开始重新计时，不追溯。
 *
 * 关键设计：**只在读取时算，永不写回盘**。盘上只有 base + hits + lastActiveDay，
 * 是事实；衰减是看法，取决于什么时候读。所以没有复利 bug，也不需要定时任务。
 */
export function effectiveWeight(entry, activeDays = 0) {
  const kind = normalizeKind(entry?.kind)
  if (kind === 'address') return WEIGHT_MAX
  const base = clampWeight(entry?.weight)
  const floor = WEIGHT_FLOOR[kind] ?? WEIGHT_MIN
  if (base <= floor) return base
  const now = Math.max(0, Math.round(Number(activeDays) || 0))
  const last = Math.max(0, Math.round(Number(entry?.lastActiveDay) || 0))
  const idle = Math.max(0, now - last)
  const grace = GRACE_ACTIVE_DAYS[kind] ?? DECAY_STEP_DAYS
  if (!Number.isFinite(grace) || idle <= grace) return base
  const steps = Math.floor((idle - grace) / DECAY_STEP_DAYS)
  const eff = base - steps * DECAY_STEP
  return Math.min(WEIGHT_MAX, Math.max(floor, Math.round(eff * 10) / 10))
}

/** 把任意输入规整成 qq 字段：合法就留字符串，不合法/空就返 ''（唯一身份缺失） */
export function normalizeQq(value) {
  const s = String(value ?? '').trim()
  return QQ_PATTERN.test(s) ? s : ''
}

/** 控制台要区分「没填」和「填错了」，所以校验单独暴露一个函数 */
export function isValidQq(value) {
  const s = String(value ?? '').trim()
  return s === '' || QQ_PATTERN.test(s)
}

/**
 * 从一条记忆里抽出「该叫他什么」，抽不出来就返回 ''。
 *
 * 2026-10-26 真机事故（主人 m01649 / m01672，回退后补的最小补丁）：
 * 群里 47 个 QQ 只有 11 个人有称谓，剩下的人只能靠记忆里的自述
 * （「他自称「小鲸鱼」」「他认下了「哦鲸鲸」这个叫法」）。模型会把自述读成
 * "要我这么叫他"，于是出现了这一幕：
 *
 *   Wishing（999999999）的记忆里有一条「他深夜还在外面漂泊，自称"主人"」，
 *   而她三分钟前才刚对真正的主人（222222222）说过「主人就是主人」，
 *   转头就把 Wishing 叫成了「主人」。
 *
 * 所以这里只认**明确要求**的句式：叫他X / 叫你X / 喊他X，以及
 * 「X 这个称呼」「称呼为X」。自称、外号、叫法回忆一律不算——宁可退回
 * 群名片，也不要她编一个称呼出来。
 */
export function addressName(text) {
  const t = String(text ?? '').trim()
  if (!t) return ''
  /*
   * 2026-10-27 真机（主人 333333333 被叫成「茶茶」）：
   * 一条 `他自称「茶茶」，可以直接叫他茶茶` 里**确实**有「叫他茶茶」，
   * 于是 addressName 抽出「茶茶」，权重和时间又刚好压过同一个人真正的
   * 「他希望你叫他「宝宝」」，结果她在群里连着三句把老板叫成茶茶，
   * 而茶茶是群里另一个人（987654321）。
   *
   * 这条 memory 的句式本身已经在说「自称」——作者的意思是"他自己这么叫自己"，
   * 只是后半句顺手写成了「叫他茶茶」。所以只要整句里出现自称/外号类字样，
   * 直接判为不可当称谓。宁可退回群名片，也不要她编一个称呼出来。
   */
  if (/自称|自封|外号/.test(t)) return ''
  const hit =
    t.match(/叫他\s*[「『"'“]?([^」』"'”，,。；;\s]{1,12})/) ||
    t.match(/叫你\s*[「『"'“]?([^」』"'”，,。；;\s]{1,12})/) ||
    t.match(/喊(他|你)\s*[「『"'“]?([^」』"'”，,。；;\s]{1,12})/) ||
    t.match(/(?:称呼|叫法)[^「『"'“]{0,8}[「『"'“]([^」』"'”]{1,12})/)
  if (!hit) return ''
  const name = String(hit[hit.length - 1] || '').trim()
  // 单字一律不认：真事里出问题的那条是 `他希望你叫他「什」`（把「你叫我什么」
  // 抽成了称呼）。单字称呼（哥/姐）本来也少，宁可退回群名片，也不要把半截字
  // 塞进提示词里当硬要求。
  if ([...name].length < 2) return ''
  // 抽出来的是问句/代词（「他希望你叫他「什么」」）就作废，别把垃圾塞进提示词
  if (/^(谁|什么|啥|怎么|称呼|叫法|他|你|我)$/.test(name)) return ''
  return name
}

export class MemoryStore {
  /**
   * @param {object} options
   * @param {string} options.dir 记忆目录
   * @param {Function} [options.logger] (level, msg) => void
   * @param {number} [options.limit] 初始容量（2026-10-23 主人 m00709：默认 2000）
   * @param {number} [options.growTo] 记满后自动扩到的上限（主人要求 10000；0=不自动扩）
   * @param {{keyFile?: string}|null} [options.crypt] 传了就加密落盘（生产用）；null=明文（测试/迁移工具）
   * @param {string} [options.poolFile] 扩容状态落盘位置，默认 <分片目录>/memory-pool.json
   * @param {string} [options.dataDir] 数据目录（密钥默认放在它的**同级** qq-whale-keys/ 里）；
   *   不传就按 dir 的上一级推断（dir 通常是 <dataDir>/memory）
   * @param {string} [options.account] 账号维度 = **机器人自己的 QQ**（2026-10-27 主人 m01748
   *   第 2 条「记忆分账号」）。记忆落 `<dir>/<account>/<kind>.json`，将来一个进程带多个号
   *   也不会串库。取不到就落 '<dir>/default/'——注意条目里的 `qq` 字段是**对话者**，不是账号。
   */
  constructor({ dir, logger, limit = 2000, growTo = 0, crypt = null, poolFile = '', dataDir = '', account = '' }) {
    this.dir = dir
    this.dataDir = String(dataDir || '').trim() || path.dirname(path.resolve(dir))
    this.logger = logger || (() => {})
    this.crypt = crypt || null
    this.broken = false
    this.migrated = false
    this.deduped = 0
    this.mergedCount = 0
    this.baseLimit = Math.max(1, Number(limit) || 2000)
    this.maxLimit = Math.max(this.baseLimit, Number(growTo) || 0)
    this.account = normalizeQq(account) || 'default'
    this.shardDir = path.join(dir, this.account)
    this.indexFile = path.join(this.shardDir, 'index.json')
    /*
     * P1-3 归档簿：prune 挤出去的、以及烂到底的老 event/meme 都写这里，
     * **不物理删除**（出事要能人工复原）。它跟分片放同一个账号目录下，
     * 这样换号也不会串库；加密开着就跟分片一样走密文信封。
     */
    this.archiveFile = path.join(this.shardDir, '_archive.json')
    this.archiveCount = 0
    this._archiveList = []
    this._archiveIds = new Set()
    this._archiveOk = true
    // 老的单文件布局：只在「首次迁移」和「迁移后存档」时用到，正常读写全在分片里
    this.file = path.join(dir, 'memory.json')
    this.legacyFile = path.join(dir, '_legacy-memory.json')
    this.mdFile = path.join(this.shardDir, 'memory.md')
    this.mdEncFile = path.join(this.shardDir, 'memory.md.enc')
    this.poolFile = poolFile || path.join(this.shardDir, 'memory-pool.json')
    this.entries = []
    // 活跃天计数（衰减用）：只在「这天真聊过天」时 +1，见 touchActivity()
    this.activeDays = 0
    this.activeDayKey = ''
    this._hitSaveAt = 0
    // 上一次召回的排序对账数据（P0-2 RRF：状态接口/日志里能看到两路名次与融合分）
    this.lastRecall = null
    /*
     * P2-5：最近一次压缩（周聚合）的时间戳，落在 index.json 里。
     * 0 表示「这个库还没压过」——老 index.json 没有这个键时读出来就是 0，
     * 不因为缺字段去改写老账本。
     */
    this.lastCompactionAt = 0
    this.limit = this.readGrownLimit() || this.baseLimit
    if (this.crypt) {
      /*
       * 密钥定位（2026-10-26，1.1.5-Hotfix.2）：
       *   配置里的 memoryKeyFile > 已存在的候选（数据目录同级的 qq-whale-keys/、数据目录里、
       *   老的 ${MOLLY_ROOT}\keys）> 新建在「数据目录同级/qq-whale-keys/memory.key」。
       *   老代码把默认值写死成 ${MOLLY_ROOT}\keys\memory.key，换台机器没有 G 盘时
       *   mkdir 报 ENOENT，插件看着加载成功、实际记忆全空（官方事故记录在 memcrypt.js 顶部）。
       */
      const keyFile = resolveKeyFile({
        keyFile: this.crypt.keyFile,
        dataDir: this.dataDir,
        // 测试/迁移工具可以传 null 关掉「老 G 盘钥匙」这条兜底，免得在本机误用真钥匙
        legacy: this.crypt.legacyKeyFile === null ? '' : this.crypt.legacyKeyFile,
      })
      this.keyFile = keyFile
      // 已经有密文却找不到钥匙：绝不新建一把新的（那等于默认记忆清空），直接冻住不写
      if (!fs.existsSync(keyFile) && this.hasStoredData()) {
        this.broken = true
        this.logger(
          'error',
          `记忆是加密的，但本机密钥不可用：${keyFile}（已停止记忆读写以免覆盖密文；把 memoryKeyFile 指回原钥匙，或设 memoryEncrypt:false 后手工迁移）`,
        )
        return
      }
      const info = loadKey({ keyFile, create: true })
      this.key = info.key
      this.keyFile = info.file
      this.keySource = info.source
      if (info.source === 'created') {
        this.logger('info', `记忆密钥已新建在 ${info.file}（备份时请把它单独拷走）`)
      }
    }
    this.load()
  }

  /** 是否加密落盘 */
  get encrypted() {
    return Boolean(this.crypt)
  }

  /** 某一类的分片文件 */
  shardFile(kind) {
    return path.join(this.shardDir, `${normalizeKind(kind)}.json`)
  }

  /**
   * 盘上到底有没有记忆数据（分片优先，其次老单文件）。
   * 只在「有密文但找不到钥匙」时用：找不到数据就不该冻住，否则换台机器一启动就是废的。
   */
  hasStoredData() {
    try {
      if (fs.existsSync(this.indexFile)) return true
      for (const kind of MEMORY_KINDS) if (fs.existsSync(this.shardFile(kind))) return true
    } catch {}
    return fs.existsSync(this.file)
  }

  /** 读分片索引；不存在或不是本账号的返回 null（按「还没分片」处理，会走老文件迁移） */
  readIndex() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.indexFile, 'utf8'))
      if (!raw || String(raw.account) !== this.account) return null
      return raw
    } catch {
      return null
    }
  }

  /**
   * 写索引（原子：先 .tmp 再 rename）。
   * 只放元信息、不放正文，所以不加密也无所谓——它就是个「账本封面」。
   */
  writeIndex(counts) {
    try {
      fs.mkdirSync(this.shardDir, { recursive: true })
      const body = JSON.stringify(
        {
          version: 1,
          account: this.account,
          kinds: counts,
          total: Object.values(counts).reduce((a, b) => a + b, 0),
          activeDays: this.activeDays,
          activeDayKey: this.activeDayKey,
          // P2-5：最近一次压缩（周聚合）的时间戳；0 = 还没压过（老库首次写入就是这个值）
          lastCompactionAt: Math.max(0, Number(this.lastCompactionAt) || 0),
          savedAt: new Date().toISOString(),
        },
        null,
        2,
      )
      const tmp = `${this.indexFile}.tmp`
      fs.writeFileSync(tmp, `${body}\n`, 'utf8')
      fs.renameSync(tmp, this.indexFile)
    } catch (err) {
      this.logger('warn', `记忆分片索引写入失败（不影响正文）: ${err.message}`)
    }
  }

  /**
   * 老单文件迁移成功后改名存档，**绝不删**：
   * 回滚时要拿它、出事时要能对账，多占 500 KB 换一个「能退回去」是值的。
   */
  archiveLegacy() {
    try {
      if (!fs.existsSync(this.file)) return
      let target = this.legacyFile
      if (fs.existsSync(target)) {
        const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
        target = this.legacyFile.replace(/\.json$/, `-${stamp}.json`)
      }
      fs.renameSync(this.file, target)
      this.logger('info', `老记忆库已按七类拆开，原文件存档到 ${target}`)
    } catch (err) {
      this.logger('warn', `老记忆库存档失败（不影响分片读写）: ${err.message}`)
    }
  }

  /**
   * 读盘：**分片优先**。
   *
   * 顺序：有 index.json 就当分片库读；没有就按老单文件读，读完立刻拆成七类落盘，
   * 再把老文件改名存档。这样升级是一次性的、可回滚的，不需要手工迁移脚本。
   */
  load() {
    // 归档簿先读进缓存：后面 save()/prune() 要往里追加，别把已有归档当成不存在
    this.refreshArchive()
    const index = this.readIndex()
    if (index) {
      // 活跃天是衰减的分母，必须跟着账本一起回来，否则重启就等于「记忆忽然变新」
      this.activeDays = Math.max(0, Math.round(Number(index.activeDays) || 0))
      this.activeDayKey = String(index.activeDayKey || '')
      // P2-5：老账本没有 lastCompactionAt → 0（「没压过」），不报错、不回写老文件
      this.lastCompactionAt = Math.max(0, Number(index.lastCompactionAt) || 0)
      this.loadShards()
      return
    }
    this.loadLegacy()
    if (this.broken) return
    if (this.entries.length || fs.existsSync(this.file)) {
      if (this.save()) this.archiveLegacy()
    }
  }

  /** 读七类分片（每片可能是密文信封，也可能是明文——迁移中途可能出现） */
  loadShards() {
    const all = []
    let needsResave = false
    for (const kind of MEMORY_KINDS) {
      const file = this.shardFile(kind)
      let raw
      try {
        raw = fs.readFileSync(file, 'utf8')
      } catch (err) {
        if (err.code !== 'ENOENT') this.logger('warn', `${path.basename(file)} 读取失败: ${err.message}`)
        continue
      }
      let text = raw
      if (this.crypt) {
        let outer = null
        try {
          outer = JSON.parse(raw)
        } catch {
          outer = null
        }
        if (outer && isEnvelope(outer)) {
          try {
            text = decryptText(outer, this.key)
          } catch (err) {
            // 解不开就是解不开：宁可整池停写，也不能覆盖唯一一份密文
            this.broken = true
            this.entries = []
            this.logger('error', `记忆分片 ${path.basename(file)} 解密失败（已停止读写以免覆盖）: ${err.message}`)
            return
          }
        } else {
          needsResave = true
        }
      }
      try {
        const parsed = JSON.parse(text)
        const list = Array.isArray(parsed?.entries) ? parsed.entries : []
        for (const e of list) {
          all.push({ ...e, kind: normalizeKind(e.kind), qq: normalizeQq(e.qq) })
        }
      } catch (err) {
        this.broken = true
        this.entries = []
        this.logger('error', `记忆分片 ${path.basename(file)} 不是合法 JSON（已停止写回以免覆盖）: ${err.message}`)
        return
      }
    }
    this.entries = all
    // 明文分片 + 开了加密 = 迁移到一半，立刻补齐密文
    if (needsResave && all.length) this.save()
  }

  /** 老布局：单个 memory.json（可能是明文，也可能是整池密文信封） */
  loadLegacy() {
    let raw
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') this.logger('warn', `memory.json 读取失败: ${err.message}`)
      this.entries = []
      return
    }
    let text = raw
    if (this.crypt) {
      let outer = null
      try {
        outer = JSON.parse(raw)
      } catch {
        outer = null
      }
      if (outer && isEnvelope(outer)) {
        try {
          text = decryptText(outer, this.key)
        } catch (err) {
          // 解不开就是解不开：宁可让整个池子停止读写，也不能覆盖唯一一份密文
          this.broken = true
          this.entries = []
          this.logger('error', `记忆池解密失败（密钥不对或文件损坏，已停止读写以免覆盖）: ${err.message}`)
          return
        }
      } else {
        // 历史明文文件：标记迁移，下面会先去重再整体加密
        this.needsMigration = true
      }
    }
    try {
      const parsed = JSON.parse(text)
      const list = Array.isArray(parsed?.entries) ? parsed.entries : []
      // 老条目没有 qq：这里补空串而不是补一个猜出来的号——
      // 猜错等于把两个人的记忆挂到同一个人身上，比"没号"更糟。
      // 只补在内存里，不写盘（下次 save() 自然会带出去）。
      this.entries = list.map((e) => ({ ...e, kind: normalizeKind(e.kind), qq: normalizeQq(e.qq) }))
    } catch (err) {
      this.broken = true
      this.entries = []
      this.logger('error', `记忆池内容不是合法 JSON（已停止写回以免覆盖）: ${err.message}`)
      return
    }
    if (this.needsMigration && this.crypt) this.migrate()
  }

  /** 读回「已经自动扩容过」的容量：记满之后重启不该缩回 2000 */
  readGrownLimit() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.poolFile, 'utf8'))
      const n = Math.round(Number(parsed?.limit))
      if (!Number.isFinite(n) || n <= 0) return 0
      if (this.maxLimit && n > this.maxLimit) return 0
      return n >= this.baseLimit ? n : 0
    } catch {
      return 0
    }
  }

  /** 扩容状态落盘（只在真正扩容时写一次，不是每条记忆都写） */
  writeGrownLimit() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(
        this.poolFile,
        `${JSON.stringify(
          { version: 1, base: this.baseLimit, limit: this.limit, grownAt: new Date().toISOString() },
          null,
          2,
        )}\n`,
        'utf8',
      )
    } catch (err) {
      this.logger('warn', `记忆池扩容状态写入失败（下次重启会退回 ${this.baseLimit} 条）: ${err.message}`)
    }
  }

  /**
   * 明文 → 密文迁移：先去重（主人 m00709 第 2 条，历史重复一次性清掉），
   * 再整体加密写回；旧的 memory.md 转成 memory.md.enc 后删掉。
   * 不留明文副本——真要回滚，用 D:\MollyBackup 里的历史快照。
   */
  migrate() {
    const before = this.entries.length
    const rep = this.dedupeAll()
    this.deduped = rep.removed
    try {
      this.save()
      this.migrated = true
      this.logger(
        'info',
        `记忆池已加密迁移：${before} 条 → ${this.entries.length} 条（去重合并 ${rep.removed} 条）→ ${this.file}`,
      )
    } catch (err) {
      this.broken = true
      this.logger('error', `记忆池加密迁移失败（保留原明文文件，等修好再重试）: ${err.message}`)
    }
  }

  /**
   * 落盘：**七类各一个文件** + index.json 账本 + 一份人读的 memory.md。
   *
   * 为什么按类拆文件，而不是继续一个大 json：
   *   1. 一类一个有下限（见 WEIGHT_FLOOR），混在一个池子里按同一把尺子淘汰必然出事；
   *   2. 写「梗」不用重写 500 KB 的「事实」，闪存友好，坏一个文件也不至于全丢；
   *   3. 出问题能一眼看出是哪一类炸的（看 index.json 的 kinds 计数）。
   *
   * @returns {boolean} 是否真的写成功了（控制台 CRUD 要据此回 500，不能报假成功）
   */
  save() {
    if (this.broken) {
      this.logger('error', '记忆池处于 broken 状态（解密/迁移失败），拒绝写回以免覆盖唯一一份数据')
      return false
    }
    try {
      fs.mkdirSync(this.shardDir, { recursive: true })
      const groups = new Map(MEMORY_KINDS.map((k) => [k, []]))
      for (const e of this.entries) {
        const kind = normalizeKind(e.kind)
        e.kind = kind
        groups.get(kind).push(e)
      }
      const counts = {}
      for (const kind of MEMORY_KINDS) {
        const list = groups.get(kind)
        counts[kind] = list.length
        const body = JSON.stringify({ version: 2, account: this.account, kind, entries: list }, null, 2)
        const file = this.shardFile(kind)
        if (this.crypt) {
          writeEncryptedFile(file, body, this.key)
        } else {
          fs.writeFileSync(file, body, 'utf8')
        }
      }
      const md = this.renderMarkdown()
      if (this.crypt) {
        writeEncryptedFile(this.mdEncFile, md, this.key)
        // 明文 md 已经加密存了，顺手删掉（否则「加密了但旁边还有一份明文」等于没加密）
        try {
          if (fs.existsSync(this.mdFile)) fs.unlinkSync(this.mdFile)
        } catch {}
      } else {
        fs.writeFileSync(this.mdFile, md, 'utf8')
      }
      this.writeIndex(counts)
      return true
    } catch (err) {
      this.logger('error', `记忆写入失败: ${err.message}`)
      return false
    }
  }

  /**
   * 记一条。
   *
   * @param {object} [input]
   * @param {string} [input.kind] 七类之一（老名 work/sticker 会被折成 event/meme）
   * @param {string} [input.source] 谁说的：`user`（默认，用户本人）/ `assistant`（她自己）/
   *   `system`。assistant 来源不许写 fact / person，见上方 MEMORY_SOURCES 的说明。
   */
  add({
    kind = 'fact',
    who = '',
    qq = '',
    text = '',
    weight = WEIGHT_DEFAULT,
    source = 'user',
    level = 0,
    // P2-5：可选的来源消息 id。只有调用方给的时候才落到条目上，
    // 周聚合时用它填 coveredUntil（「这条记忆覆盖到哪条消息」）。
    messageId = '',
  } = {}) {
    const t = String(text || '').trim()
    if (!t) return null
    const k = normalizeKind(kind)
    const src = normalizeSource(source)
    if (src === 'assistant' && (k === 'fact' || k === 'person')) {
      this.logger('warn', `拒绝写入：助手自述不能写成 ${k}（${t.slice(0, 24)}）`)
      return null
    }
    const q = normalizeQq(qq)
    const name = String(who || '').trim()
    /*
     * 称谓一律钉死在最高档（2026-10-27 主人 m01449：「称谓记忆依旧是最高，10」）。
     * 理由：address 不参与普通召回、每轮无条件注入，它的「权重」只用来决定
     * **同一个人多条称谓时谁排第一行**（engine-context 的规矩是以第一行为准）。
     * 让别的 kind 跟它比高低没有意义，钉满反而不会因为迁移或手滑把「宝宝」压低。
     */
    const w = k === 'address' ? WEIGHT_MAX : clampWeight(weight)
    this.touchActivity()
    // 去重（2026-10-23 主人 m00709 第 2 条）：
    //   1. 比"人"：优先 qq（唯一身份），老条目没号时才退回比名字；
    //   2. 比"话"：**不再看 kind**——「喜欢猫」记成 fact 还是 preference 都是同一件事；
    //   3. 新的覆盖旧的：文字/时间用新的，权重取高的。
    const dup = this.findDuplicate({ who: name, qq: q, text: t, kind: k })
    // 冲突优先于「跳过/合并」，而且**必须独立判定**：
    // 「他喜欢猫」和「他其实不喜欢猫」字面相似度只有 0.2，根本进不了 findDuplicate
    // 的门槛，靠 dup 命中后再判冲突等于永远判不到（2026-10-27 自测第 4/7 组就是这么挂的）。
    // 所以这里单独扫一遍：意思相反的修正两条都留，旧的打 supersededBy、召回降权。
    const conflictEntry = this.findConflict({ who: name, qq: q, text: t })
    const conflicting = !!conflictEntry
    if (dup && !conflicting) {
      const prev = dup.entry
      if (dup.score >= DUP_SKIP_SIMILARITY) {
        // 近似重复：文字不用重写，只记「又被提起」（衰减从这里重新算）
        prev.lastActiveDay = this.activeDays
        prev.at = Date.now()
        this.mergedCount += 1
        this.save()
        this.logger('debug', `近似重复（${dup.score.toFixed(2)}），未写入：${t.slice(0, 24)}`)
        return { ...prev, skipped: true }
      }
      prev.text = t
      prev.at = Date.now()
      prev.weight = Math.max(clampWeight(prev.weight), w)
      if (k !== prev.kind) prev.kind = k
      // 被重写等于「最近又被提起」，衰减从这里重新算
      prev.lastActiveDay = this.activeDays
      // 老条目这次带了号，顺手把身份补上（下次就能按 qq 找到了）
      if (q && !normalizeQq(prev.qq)) prev.qq = q
      if (name && !prev.who) prev.who = name
      // 命中次数跨条目累计（合并时两边的 hits 相加，不能因为覆盖就清零）
      prev.hits = (Number(prev.hits) || 0)
      this.mergedCount += 1
      this.save()
      return prev
    }
    const entry = {
      id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      kind: k,
      who: name,
      qq: q,
      text: t,
      weight: w,
      source: src,
      /*
       * 压缩等级 0..3（2026-10-27 第 2 篇「压缩四级」的落点）：
       *   0 原句 / 1 半句 / 2 一句 / 3 关键词。
       * 现在只在**读**的时候用它决定要不要再压（renderMarkdown 会显示 l0..l3），
       * 不改正文——压缩正文必须是显式动作，不能悄悄发生在检索里。
       */
      level: Math.max(0, Math.min(3, Math.round(Number(level) || 0))),
      // 命中记账（衰减靠它区分「没被问过」和「问过但没记住」）
      hits: 0,
      lastActiveDay: this.activeDays,
      at: Date.now(),
      // P2-5：只有调用方真的给了消息 id 才写这个字段（老条目没有它 → 老数据零改动）
      ...(String(messageId ?? '').trim() ? { messageId: String(messageId).trim() } : {}),
    }
    this.entries.push(entry)
    if (conflicting && conflictEntry) {
      // 旧的那条是「被更正」的：正文留着备查（不删，防止纠错纠错），
      // 但打上标记，召回时降权——免得提示词里同时出现
      // 「他喜欢猫」和「他其实不喜欢猫」，让模型自己猜哪句算数。
      conflictEntry.supersededBy = entry.id
      conflictEntry.supersededAt = Date.now()
      this.logger(
        'debug',
        `记忆冲突，两条都留：${String(conflictEntry.text).slice(0, 20)} → ${t.slice(0, 20)}`,
      )
    }
    this.prune()
    this.save()
    return entry
  }

  /**
   * 找「同一个人 + 同一件事」的老条目。
   *
   * 2026-10-27（对照 BaiShou-Next 的 memory-deduplication.service.ts）改成
   * **连相似度一起返回**：调用方要靠分数分档——>=0.92 当重复直接跳过，
   * 0.70~0.92 才合并。以前只返回条目，等于把「几乎一模一样」和「有点沾边」
   * 当成一回事，一律覆盖，结果每次重复提及都会重写一遍文字。
   *
   * @param {{who?: string, qq?: string, text?: string, kind?: string}} probe
   * @returns {{entry: object, score: number}|null}
   */
  findDuplicate({ who = '', qq = '', text = '', kind = '' } = {}) {
    const q = normalizeQq(qq)
    const name = String(who || '').trim()
    const key = normalizeForDup(text)
    if (!key) return null
    let best = null
    let bestScore = 0
    for (const e of this.entries) {
      if (!sameIdentity({ who: name, qq: q }, e)) continue
      const exact = normalizeForDup(e.text) === key
      const score = exact ? 1 : similarity(e.text, text)
      if (score >= dupThreshold(kind, e.kind) && score > bestScore) {
        best = e
        bestScore = score
      }
    }
    return best ? { entry: best, score: bestScore } : null
  }

  /**
   * 找「同一个人 + 说的同一件事 + 意思相反」的老条目。
   *
   * 和 findDuplicate 分开是有原因的：修正句的**字面相似度往往很低**
   * （「他喜欢猫」→「他其实不喜欢猫」只有 0.2），如果把它挂在相似度门槛后面，
   * 这个分支永远不会被触发——被纠正过的旧结论会一直躺在库里，等着和新结论一起
   * 进提示词。所以这里不看相似度，只看两件事：
   *   1. 是不是同一个人（qq 优先，老条目没号才比名字）；
   *   2. `conflicts()`——一边否定一边不否定，且共享至少两个实词。
   *
   * @param {{who?: string, qq?: string, text?: string}} probe
   * @returns {object|null}
   */
  findConflict({ who = '', qq = '', text = '' } = {}) {
    const q = normalizeQq(qq)
    const name = String(who || '').trim()
    if (!normalizeForDup(text)) return null
    let best = null
    let bestScore = 0
    for (const e of this.entries) {
      if (e.supersededBy) continue // 已经被更正的不用再更正一次
      if (!sameIdentity({ who: name, qq: q }, e)) continue
      if (!conflicts(e.text, text)) continue
      const n = sharedKeywordCount(e.text, text)
      if (n > bestScore) {
        best = e
        bestScore = n
      }
    }
    return best
  }

  /**
   * 全量去重（迁移时跑一次；也留给控制台/工具手动跑）。
   * 规则与 add() 完全一致：同一个人 + 文本相似 → 只留一条，**新的覆盖旧的**。
   * @param {{threshold?: number}} [options]
   * @returns {{kept: number, removed: number}}
   */
  dedupeAll({ threshold = 0.7 } = {}) {
    const kept = []
    let removed = 0
    for (const e of this.entries) {
      const q = normalizeQq(e.qq)
      const key = normalizeForDup(e.text)
      if (!key) {
        kept.push(e)
        continue
      }
      let merged = false
      for (const k of kept) {
        if (!sameIdentity(e, k)) continue
        const exact = normalizeForDup(k.text) === key
        const score = exact ? 1 : similarity(k.text, e.text)
        const min = normalizeKind(k.kind) === 'meme' || normalizeKind(e.kind) === 'meme' ? 1 : threshold
        if (score < min) continue
        // 新的覆盖旧的：at 更大的算新
        const newer = e.at >= k.at ? e : k
        const older = newer === e ? k : e
        // 意思相反的不能合成一条（「喜欢猫」不能被「不喜欢猫」并掉）
        if (conflicts(older.text, newer.text)) continue
        older.text = newer.text
        older.at = newer.at
        older.weight = Math.max(clampWeight(older.weight), clampWeight(newer.weight))
        // 命中次数是两条之和：合并不能把她「被问过多少次」的记忆清零
        older.hits = (Number(older.hits) || 0) + (Number(newer.hits) || 0)
        if (newer.kind && newer.kind !== older.kind) older.kind = newer.kind
        if (normalizeQq(newer.qq) && !normalizeQq(older.qq)) older.qq = newer.qq
        if (newer.who && !older.who) older.who = newer.who
        removed += 1
        merged = true
        break
      }
      if (!merged) kept.push(e)
    }
    this.entries = kept
    return { kept: kept.length, removed }
  }

  /**
   * 给 /state 用的容量与加密状态。
   * 主人和挂件都要能一眼看到「现在多大 / 上限多少 / 加密没有 / 钥匙在哪」。
   */
  /** 七类各多少条（控制台/状态接口用） */
  countByKind() {
    const out = {}
    for (const k of MEMORY_KINDS) out[k] = 0
    for (const e of this.entries) out[normalizeKind(e.kind)] += 1
    return out
  }

  status() {
    return {
      // 记忆库的名字（2026-10-27 主人 m02812 定的）：文档、发布说明、控制台都按这个署名
      name: MEMORY_SYSTEM_NAME,
      count: this.entries.length,
      limit: this.limit,
      baseLimit: this.baseLimit,
      maxLimit: this.maxLimit,
      encrypted: Boolean(this.crypt),
      keyFile: this.crypt ? this.keyFile : '',
      keySource: this.crypt ? this.keySource : '',
      broken: this.broken,
      deduped: this.deduped,
      merged: this.mergedCount,
      migrated: this.migrated,
      // 分账号 + 七类布局（2026-10-27）
      account: this.account,
      shards: this.countByKind(),
      activeDays: this.activeDays,
      activeDayKey: this.activeDayKey,
      // P1-3：归档条数（已经挪进 _archive.json 的那些，不进召回、不计入 count/shardes）
      archiveCount: this.archiveCount,
      archived: this.archiveCount,
      // P2-5：最近一次压缩（周聚合）时间戳；0 = 还没压过
      lastCompactionAt: this.lastCompactionAt,
      // 上一次召回的 RRF 对账（两路名次 + 融合分 + 老的原始合成分），只在内存里
      lastRecall: this.lastRecall,
    }
  }

  /**
   * 按 id 改一条记忆（控制台 CRUD 用，2026-10-19）。
   *
   * 为什么必须走这个类、不能让控制台直接改盘上的 memory.json：
   * `entries` 是**内存数组**，插件下一次 `add()` 会拿内存里的旧数组整个覆写
   * 磁盘文件——控制台绕过内存的修改会被静默吞掉。所以所有写操作都从这里过，
   * 改完立刻 `save()`（它同时重写 memory.json 与 memory.md）。
   *
   * 语义：只改传进来的字段；`at` 保持不动（那是"记下的时间"，不是"改的时间"）。
   * `qq` 可改：格式合法性由路由层（web.js）先校验，这里只做规整，
   * 保证落盘的一定是 `''` 或 `/^[1-9]\d{4,11}$/`。
   * @param {string} id
   * @param {{kind?:string, who?:string, qq?:string, text?:string, weight?:number}} patch
   * @returns {object|null} 改完的 entry；id 不存在返回 null（路由层转 404）
   */
  update(id, patch = {}) {
    const target = String(id ?? '')
    const entry = this.entries.find((e) => e.id === target)
    if (!entry) return null
    if (patch.kind !== undefined) entry.kind = normalizeKind(patch.kind)
    if (patch.who !== undefined) entry.who = String(patch.who ?? '').trim()
    if (patch.qq !== undefined) entry.qq = normalizeQq(patch.qq)
    if (patch.text !== undefined) entry.text = String(patch.text ?? '').trim()
    if (patch.weight !== undefined) entry.weight = clampWeight(patch.weight, entry.weight)
    // 压缩等级 0..3（原句/半句/一句/关键词），只改标记不改正文
    if (patch.level !== undefined) {
      const lv = Math.round(Number(patch.level))
      if (Number.isFinite(lv)) entry.level = Math.max(0, Math.min(3, lv))
    }
    // 称谓恒为最高档（见 add() 里的说明）
    if (entry.kind === 'address') entry.weight = WEIGHT_MAX
    if (!this.save()) return null
    return entry
  }

  /**
   * 按 id 删一条记忆。改完立刻落盘。
   * @returns {number} 删掉的条数（0 表示 id 不存在 → 路由层转 404）
   */
  remove(id) {
    const target = String(id ?? '')
    const idx = this.entries.findIndex((e) => e.id === target)
    if (idx < 0) return 0
    this.entries.splice(idx, 1)
    if (!this.save()) {
      // 落盘失败就把内存也回滚，避免"内存里没了、文件里还在"的鬼状态
      this.load()
      return 0
    }
    return 1
  }

  /**
   * 记一个「活跃天」：每个自然日只加一次，而且只有真聊过天才加。
   *
   * 这是「不按日历天衰减」的关键——关机三天、插件停一周，记忆既不变好也不变坏；
   * 只有她真的在说话的那天，才算「过了一天」，才开始逼近遗忘。
   * 由 recall() / add() 自动调用，引擎不需要额外配合。
   * @returns {boolean} 今天是不是第一次记
   */
  touchActivity() {
    const key = localDateKey(new Date())
    if (key === this.activeDayKey) return false
    this.activeDayKey = key
    this.activeDays += 1
    // 一天只写一次账本；不写的话重启会退回旧的活跃天数，衰减就白算了
    if (!this.broken) this.save()
    return true
  }

  /**
   * 命中记账：只记**真正返回给模型看的那几条**。
   *
   * 为什么必须记账（第 2 篇《让鲸鱼娘永生》原话：「命中必须有账，
   * 靠印象判断一定会偏向遗忘」）：没有 hits，衰减就分不清
   * 「这条从来没人问」和「天天在问、只是排序靠后」，结果把常用的也一起忘掉——
   * 那不是遗忘，是丢东西。
   *
   * `addressOf()` 不走这里：称谓每轮无条件注入，记了必然刷成满分，没有信息量。
   */
  markHits(list) {
    if (!Array.isArray(list) || !list.length) return
    const now = Date.now()
    let changed = 0
    for (const e of list) {
      if (!e || normalizeKind(e.kind) === 'address') continue
      e.hits = Math.max(0, Math.round(Number(e.hits) || 0)) + 1
      e.lastHitAt = now
      e.lastActiveDay = this.activeDays
      changed += 1
    }
    if (!changed) return
    // 一轮对话里 recall 可能被调好几次，5 秒内只落一次盘
    if (now - this._hitSaveAt < 5000) return
    this._hitSaveAt = now
    this.save()
  }

  /**
   * 超量时才剪：先删低权重 + 旧的，保住高权重。
   *
   * 2026-10-23 主人 m00709 第 1 条：满了**别直接剪**，先自动扩容一次
   * （2000 → 10000，扩容状态写 memory-pool.json，重启不缩回）。
   * 换句话说：正常态是 2000，真记满了才升到 10000，升完之后才按老规则淘汰。
   */
  prune() {
    /*
     * P1-3：先归档「烂到底且晾够 90 活跃天」的 event/meme。
     * 归档不是淘汰，但同样要从热池里挪走，所以放在超量判断**之前**——
     * 没满也可以归档（烂掉的经历不该一直占着窗口）。
     */
    this.archiveStale()
    if (this.entries.length <= this.limit) return
    if (this.maxLimit > this.limit) {
      const before = this.limit
      this.limit = this.maxLimit
      this.writeGrownLimit()
      this.logger('info', `记忆池已满（${before} 条）→ 自动扩容到 ${this.limit} 条`)
      if (this.entries.length <= this.limit) return
    }
    /*
     * 排序用**有效权重**而不是 base（2026-10-27）：
     * 淘汰的意义是「谁现在最不重要」，而不是「谁当初分数最低」。
     * 一条 base=10 但三个月没被问过的事实，应该排在刚记下的 base=8 后面。
     */
    const days = this.activeDays
    this.entries.sort(
      (a, b) => effectiveWeight(b, days) - effectiveWeight(a, days) || b.weight - a.weight || b.at - a.at,
    )
    // P1-3：挤出去的条目写进归档簿，不再静默丢掉。
    // 容量语义不变：热池还是切成 limit 条，归档只是「淘汰前先留个底」。
    const evicted = this.entries.slice(this.limit)
    this.entries = this.entries.slice(0, this.limit)
    if (evicted.length) {
      const n = this.appendArchive(evicted, 'over-limit')
      if (n < evicted.length) {
        this.logger('warn', `记忆池超限：挤出去 ${evicted.length} 条，其中 ${evicted.length - n} 条没能写进归档簿`)
      }
    }
  }

  /**
   * P1-3 归档：有效权重掉到该类下限、且晾够 ARCHIVE_IDLE_DAYS 个活跃天的
   * event/meme 挪出热池（不删，写进归档簿）。
   *
   * 只在 prune() 里调用，所以天然幂等：归档过的条目已经不在 this.entries 里，
   * 再跑一次也找不到它；就算有一条 id 已经在归档簿里，appendArchive 也会跳过。
   *
   * 关键取舍：**归档写不进去就不挪走**。宁可下次 prune 再试，也不静默丢数据——
   * 归档簿损坏时（readArchive 返回 ok:false）这一轮什么都不归档，只 warn。
   *
   * @returns {number} 这一轮真正挪进归档簿的条数
   */
  archiveStale() {
    const days = this.activeDays
    const keep = []
    const stale = []
    for (const e of this.entries) {
      const kind = normalizeKind(e.kind)
      if (kind !== 'event' && kind !== 'meme') {
        keep.push(e)
        continue
      }
      const idle = Math.max(0, days - Math.max(0, Math.round(Number(e.lastActiveDay) || 0)))
      if (idle >= ARCHIVE_IDLE_DAYS && effectiveWeight(e, days) <= (WEIGHT_FLOOR[kind] ?? WEIGHT_MIN)) {
        stale.push(e)
      } else {
        keep.push(e)
      }
    }
    if (!stale.length) return 0
    this.appendArchive(stale, 'stale')
    // 只挪走「确认已经进归档簿」的那些；写失败的留在池子里等下一轮
    const moved = new Set(
      stale.filter((e) => this._archiveIds.has(String(e.id || ''))).map((e) => String(e.id || '')),
    )
    if (!moved.size) return 0
    this.entries = keep.filter((e) => !moved.has(String(e.id || '')))
    return moved.size
  }

  /**
   * 往归档簿里追加（幂等：同一个 id 只归档一次）。
   *
   * 条目保留**全部原字段**，再补四个复原用的快照字段：
   *   archivedAt（淘汰时间，ISO）、archivedDay（淘汰时的活跃天）、
   *   archivedReason（stale=烂到底 / over-limit=超量挤出）、archivedWeight（淘汰时的有效权重）。
   * 原文就是 e.text，kind/who/qq/at/weight 也都在，人工复原一条记忆不需要别的信息。
   *
   * @param {object[]} items
   * @param {'stale'|'over-limit'} [reason]
   * @returns {number} 新增条数
   */
  appendArchive(items, reason = 'stale') {
    const list = Array.isArray(items) ? items.filter((e) => e && typeof e === 'object') : []
    if (!list.length) return 0
    if (!this._archiveOk) {
      this.logger('warn', `归档簿不可用（损坏/读不出来），本轮 ${list.length} 条不归档，原样留在热池`)
      return 0
    }
    const at = new Date().toISOString()
    const days = this.activeDays
    const fresh = []
    for (const e of list) {
      const id = String(e.id || '')
      if (id && this._archiveIds.has(id)) continue
      fresh.push({
        ...e,
        archivedAt: at,
        archivedDay: days,
        archivedReason: reason,
        archivedWeight: effectiveWeight(e, days),
      })
      if (id) this._archiveIds.add(id)
    }
    if (!fresh.length) return 0
    const next = this._archiveList.concat(fresh)
    if (!this.writeArchive(next)) {
      // 写失败就把刚占上的 id 撤回去：没进盘就不算归档（下一轮还能重试）
      for (const e of fresh) if (e.id) this._archiveIds.delete(String(e.id))
      return 0
    }
    this._archiveList = next
    this.archiveCount = next.length
    this.logger('debug', `记忆归档 ${fresh.length} 条（${reason}），归档簿共 ${next.length} 条`)
    return fresh.length
  }

  /**
   * 归档簿落盘：**整份重写**（先 .tmp 再 rename），加密开着就走密文信封。
   * 不做行式追加——JSON 不是行格式，追加半截就是坏文件。
   */
  writeArchive(list) {
    const body = JSON.stringify({ version: 1, account: this.account, archived: list }, null, 2)
    try {
      fs.mkdirSync(this.shardDir, { recursive: true })
      if (this.crypt) {
        writeEncryptedFile(this.archiveFile, body, this.key)
      } else {
        const tmp = `${this.archiveFile}.tmp`
        fs.writeFileSync(tmp, `${body}\n`, 'utf8')
        fs.renameSync(tmp, this.archiveFile)
      }
      return true
    } catch (err) {
      this.logger('warn', `归档簿写入失败（条目留在热池里，下次再试）: ${err.message}`)
      return false
    }
  }

  /**
   * 读归档簿。**容错优先**：缺失当空、损坏就返回 ok:false。
   *
   * 调用方看到 ok:false 只读不改——宁可这一轮不归档，
   * 也绝不能用一份空数据把盘上已有的归档覆盖掉（那才是真丢）。
   */
  readArchive() {
    let raw
    try {
      raw = fs.readFileSync(this.archiveFile, 'utf8')
    } catch (err) {
      if (err.code === 'ENOENT') return { list: [], ids: new Set(), ok: true }
      this.logger('warn', `归档簿读取失败（保留原文件，本轮不归档）: ${err.message}`)
      return { list: [], ids: new Set(), ok: false }
    }
    let text = raw
    if (this.crypt) {
      let outer = null
      try {
        outer = JSON.parse(raw)
      } catch {
        outer = null
      }
      if (outer && isEnvelope(outer)) {
        try {
          text = decryptText(outer, this.key)
        } catch (err) {
          this.logger('warn', `归档簿解密失败（保留原文件，本轮不归档）: ${err.message}`)
          return { list: [], ids: new Set(), ok: false }
        }
      }
    }
    try {
      const parsed = JSON.parse(text)
      const list = Array.isArray(parsed?.archived) ? parsed.archived.filter((e) => e && typeof e === 'object') : null
      if (!list) throw new Error('缺少 archived 数组')
      const ids = new Set()
      for (const e of list) if (e.id) ids.add(String(e.id))
      return { list, ids, ok: true }
    } catch (err) {
      this.logger('warn', `归档簿内容不可用（保留原文件，本轮不归档）: ${err.message}`)
      return { list: [], ids: new Set(), ok: false }
    }
  }

  /** 把归档簿读进内存缓存（load() 开头走一次，之后只读缓存） */
  refreshArchive() {
    const arc = this.readArchive()
    this._archiveList = arc.list
    this._archiveIds = arc.ids
    this._archiveOk = arc.ok
    this.archiveCount = arc.list.length
  }

  /**
   * 某周的**原始** event，按「群」分桶（P1-4 周聚合的第一步）。
   *
   * 桶键：有 qq 就按 qq（唯一身份），否则按 who，都没有算 global。
   * 带 `weekSummaryFor` 的摘要条**一律不算原始数据**——否则下一轮会把周摘要
   * 再当成一条 event 聚合进去，越聚越假。
   *
   * @param {string} weekKey 周一那天，'YYYY-MM-DD'
   * @returns {Map<string, {groupKey: string, who: string, qq: string, items: object[]}>}
   */
  eventBuckets(weekKey) {
    const buckets = new Map()
    for (const e of this.entries) {
      if (normalizeKind(e.kind) !== 'event') continue
      if (e.weekSummaryFor) continue
      if (weekKeyOf(e.at) !== weekKey) continue
      const q = normalizeQq(e.qq)
      const who = String(e.who || '').trim()
      const groupKey = q ? `qq:${q}` : who ? `who:${who}` : 'global'
      let b = buckets.get(groupKey)
      if (!b) {
        b = { groupKey, who, qq: q, items: [] }
        buckets.set(groupKey, b)
      }
      b.items.push(e)
    }
    return buckets
  }

  /**
   * P1-4 周聚合：把某一周的 event 碎片按群压成一条摘要记忆。
   *
   * 语义照 docs/memory-upgrade-from-baishou.md 第 69-73 行（不自己发明）：
   *   1. 同周同群有原始 event → 生成一条 `kind='event'`、`level=2`、`weight=8` 的摘要，
   *      正文形如「10-20~10-26：109 群聊了 X 件事，主要是 …」；
   *   2. **原条目降级不删除**：`level` +1（封顶 3），`lastActiveDay` 不动，让它继续自然衰减；
   *   3. 摘要条带 `weekSummaryFor` / `groupKey` 标记，天然幂等——同一个周同一个群只生成一次。
   *
   * 保守边角（文档没写清，选了最小动作）：
   *   - 摘要直接 push 进 entries，**不走 add()**：add() 会 touchActivity()，等于
   *     「没人聊天也算一个活跃天」，和衰减的设计前提冲突；也免得摘要被当成
   *     「用户说过的话」参与去重/冲突判定。
   *   - 摘要 source 记 `system`：它是机器压出来的，不是谁说的话。
   *   - 「主要是」取有效权重最高的 3 条，每条截 20 字，超出加省略号——摘要不该比原文长。
   *
   * @param {string|number|Date} weekKey 周键（周一那天）；也接受时间戳/Date
   * @returns {object[]} 这次新建的摘要条目（已总结过的不重复建，返回空数组）
   */
  summarizeWeek(weekKey) {
    const raw = String(weekKey ?? '')
    const key = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : weekKeyOf(weekKey)
    if (!key) return []
    const buckets = this.eventBuckets(key)
    if (!buckets.size) return []
    // 已经总结过的群（同一个周键）不再总结：这就是「再跑一次不重复生成」的根据
    const done = new Set()
    for (const e of this.entries) {
      if (e.weekSummaryFor === key) done.add(String(e.groupKey || ''))
    }
    const label = weekLabelOf(key)
    const created = []
    let demoted = 0
    for (const [groupKey, b] of buckets) {
      if (done.has(groupKey)) continue
      const n = b.items.length
      const top = b.items
        .slice()
        .sort((x, y) => effectiveWeight(y, this.activeDays) - effectiveWeight(x, this.activeDays) || y.at - x.at)
        .slice(0, 3)
        .map((x) =>
          String(x.text || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 20),
        )
        .filter(Boolean)
      const head = b.who || b.qq || '群里'
      const more = n > top.length ? ' …' : ''
      const text = `${label}：${head}聊了 ${n} 件事，主要是 ${top.join('、')}${more}`
      /*
       * P2-5 压缩标记：这一条摘要覆盖到哪条消息。
       * 优先用条目自己带的 messageId（数字按数值比大小，否则按字符串比）；
       * 一条消息 id 都没有时退回「最后被覆盖的那条记忆的 id」——至少是个可回溯的锚点，
       * 不硬编一个假消息号。文档只要求这个字段存在且能读回，语义边角已回报 lead。
       */
      const mids = b.items
        .map((x) => String(x.messageId ?? '').trim())
        .filter(Boolean)
        .sort((x, y) => {
          const nx = Number(x)
          const ny = Number(y)
          if (Number.isFinite(nx) && Number.isFinite(ny)) return nx - ny
          return x < y ? -1 : x > y ? 1 : 0
        })
      const lastAt = b.items.slice().sort((x, y) => y.at - x.at)[0]
      const coveredUntil = mids.length ? mids[mids.length - 1] : String(lastAt?.id || '')
      const entry = {
        id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        kind: 'event',
        who: b.who,
        qq: b.qq,
        text: text.trim(),
        weight: 8,
        source: 'system',
        level: 2,
        hits: 0,
        lastActiveDay: this.activeDays,
        at: Date.now(),
        // P2-5：摘要覆盖到的最后一条消息
        coveredUntil,
        // 周摘要的两个标记：哪个周、哪个群（幂等与「别再聚合自己」都靠它）
        weekSummaryFor: key,
        groupKey,
      }
      this.entries.push(entry)
      created.push(entry)
      // 原条目降级不删除：level +1 封顶 3，lastActiveDay 不动（等自然衰减）
      for (const x of b.items) {
        x.level = Math.min(3, Math.max(0, Math.round(Number(x.level) || 0)) + 1)
        // P2-5：被这次压缩覆盖过的原始 event 也记下「覆盖到哪」
        x.coveredUntil = coveredUntil
        demoted += 1
      }
    }
    if (!created.length) return []
    // P2-5：本库最近一次压缩时间（落 index.json，重启后能知道压到哪了）
    this.lastCompactionAt = Date.now()
    this.prune()
    this.save()
    this.logger('info', `周聚合 ${key}（${label}）：生成 ${created.length} 条摘要，${demoted} 条原始 event 已降级`)
    return created
  }

  /**
   * P1-4 补漏（对应白守的 detectMissingSummaries，即 mode="missing"）：
   * 找出「有原始 event 但没有周摘要」的周，补最近的 2 周。
   *
   * 三个刻意的保守（文档只写了「补最近 2 周」，这些边角由我定，已回报 lead）：
   *   ① **不碰正在进行的这一周**：周中生成的摘要没法再更新（幂等），会变成半周快照
   *      一直挂着；等这周过完，下次启动自然补上。
   *   ② 只补最近 2 周：首次接入老数据时不给远古数据批量造摘要（那会一次写出几百条）。
   *   ③ 按「周 + 群」判定缺漏：某周只总结了 A 群、B 群还缺，也算缺——补的时候
   *      summarizeWeek 只会补 B 群，A 群不会重复。
   *
   * 天然幂等：补过的周已经有摘要，再跑就找不到「缺」的了。
   *
   * @param {{lookback?: number}} [options] lookback：最多补几周（默认 2，文档口径）
   * @returns {{weeks: string[], created: number}}
   */
  missingWeeks({ lookback = 2 } = {}) {
    const thisWeek = weekKeyOf(new Date())
    const covered = new Set()
    const rawWeeks = new Set()
    for (const e of this.entries) {
      if (normalizeKind(e.kind) !== 'event') continue
      if (e.weekSummaryFor) {
        covered.add(`${e.weekSummaryFor}|${String(e.groupKey || '')}`)
        continue
      }
      const k = weekKeyOf(e.at)
      if (k) rawWeeks.add(k)
    }
    const missing = []
    for (const k of rawWeeks) {
      if (!thisWeek || k >= thisWeek) continue // 当前周不补，见上面 ①
      for (const groupKey of this.eventBuckets(k).keys()) {
        if (!covered.has(`${k}|${groupKey}`)) {
          missing.push(k)
          break
        }
      }
    }
    missing.sort().reverse() // 最近的周优先
    const limit = Math.max(0, Math.round(Number(lookback) || 0))
    const weeks = missing.slice(0, limit)
    let created = 0
    for (const k of weeks) created += this.summarizeWeek(k).length
    return { weeks, created }
  }

  /**
   * 按人 + 关键词召回。
   *
   * 这里踩过一个坑：「猫」「咖啡」这种单字 query 原先是直接用
   * `q.split(/\s/).filter(w => w.length >= 2)` 取词的，单字全被过滤掉，
   * 词袋为空 → 关键词一分不计 → 排序退化成"权重最高的几条"，
   * 于是问"我家猫叫啥"会返回"记得吃药"。
   *
   * 现在改成两步：
   *   1. 分词：先按标点切块，中文块再按 2-gram 切成"子词"。
   *      这样「我家猫叫啥」→ [我家, 家猫, 猫叫, 叫啥, 猫, 啥]，单字也留一份。
   *   2. 打分：命中的词越长越值钱（3 字 3 分、2 字 2 分、单字 1 分），
   *      再乘一个 IDF 味道的系数——在所有记忆里都出现的词（如"主人"）不值钱，
   *      只在少数记忆里出现的词（"锅贴""香菜"）才值钱。
   *
   * 最后有相关性阈值：query 非空时，一分没命中的条目直接不返回。
   * 宁可"想不起来"也别答非所问——这正是用户最烦的那种失忆。
   */
  recall({ who = '', qq = '', query = '', limit = MEMORY_WINDOW.contextLimit, charBudget = MEMORY_WINDOW.charBudget } = {}) {
    this.touchActivity()
    const q = String(query || '').toLowerCase().trim()
    const words = tokenize(q)
    const qqStr = normalizeQq(qq)
    const name = String(who || '').trim()

    /*
     * 身份匹配（2026-10-19 用户需求：「who 是名字，qq 是唯一身份」）。
     *
     * 优先级：qq 完全匹配（+4）> 名字完全匹配（+2）> 名字互相包含（+1）。
     *
     * 两个细节：
     *   ① 给了 qq 时，**别的号但同名**的人不再吃名字加成——同名不同号是两个人，
     *      名字一样不代表是他，否则"小王"的记忆会串到另一个"小王"身上。
     *   ② 老条目（qq 为空）没有身份信息，给了 qq 时仍允许按名字认它——
     *      宁可让它留在候选里（可能就是这个人的历史记忆），也不要整条丢失。
     */
    const identity = (e) => {
      const eQq = normalizeQq(e.qq)
      const qqHit = Boolean(qqStr) && eQq === qqStr
      const differentPerson = Boolean(qqStr) && Boolean(eQq) && eQq !== qqStr
      const sameName = Boolean(name) && e.who === name && !differentPerson
      const nameContains =
        Boolean(name) &&
        !sameName &&
        !differentPerson &&
        Boolean(e.who) &&
        (e.who.includes(name) || name.includes(e.who))
      return { qqHit, sameName, nameContains, differentPerson }
    }

    // 词频统计，用来算 IDF
    const df = new Map()
    if (words.length) {
      for (const e of this.entries) {
        const t = e.text.toLowerCase()
        for (const w of words) {
          if (contains(t, w)) df.set(w, (df.get(w) || 0) + 1)
        }
      }
    }
    const N = Math.max(1, this.entries.length)
    const idf = (w) => {
      const d = df.get(w) || 0
      if (d === 0) return 0
      return Math.log(1 + N / d) // 越罕见的词越大
    }

    /*
     * 2026-10-25（主人第 5 条）：问句里出现「梗」时，梗类条目直接加成，
     * 否则按身份命中排序时会被更新的普通事实压过去（问「说个梗」先甩一条"他住广州"）。
     * 只对梗类加，避免扰动其他意图的既有召回顺序。
     */
    const wantMeme = /梗/.test(q)

    const scored = this.entries.map((e) => {
      const id = identity(e)
      /*
       * 2026-10-27 P0-2（对齐白守 hybrid-search.ts 的 RRF 思路）：两路信号**分开存**。
       *
       *   kw = 相关性（身份 + 关键词命中 × IDF + 梗加成 + 新鲜度）
       *   w  = 有效权重（衰减之后的重要程度）
       *
       * 以前是 `kw + w*0.15` 直接相加。两路尺度根本不可比：一条权重 10 的条目
       * 白送 1.5 分，比「两个 2 字词全中」的 1 分还高，于是「权重高但不相关」
       * 稳稳压过「强命中但权重低」。白守的做法是**按名次融合**，不拿原始分相加。
       * 老公式的合成分仍算一份存在 `raw` 里，只用于调试对账，不再决定顺序。
       */
      let kw = 0
      if (id.qqHit) kw += 4 // 硬身份，比名字更值钱
      else if (id.sameName) kw += 2 // 熟人优先，但不再压过相关性
      else if (id.nameContains) kw += 1
      let hit = false
      let strongHit = false
      /*
       * kwStrong（2026-10-27 P0-2 收尾）：**只**由「≥2 字词命中」置位，
       * 跟下面会被身份命中也点亮的 strongHit 区分开。
       *
       * 为什么要拆：候选池原先只按 strongHit 筛，而 strongHit 会被 qqHit/sameName
       * 点亮，于是「问我家猫叫啥」时，同一个人名下所有条目都进了池子——包括跟猫
       * 毫无关系的「主人叫小李，ERP 后端」。这些无关条目 kw 只有 2.6（sameName 2 +
       * 新鲜度 0.6），却因为有效权重 w=5 在权重路拿到 rankWeight=1，RRF 直接反超
       * 真正命中「猫叫锅贴」的那条（kw=10.04 / w=3 / rankWeight=5）。老代码用裸分
       * 相加（10.492 vs 6.633）时尺度差异没暴露这个问题。
       *
       * 修法：池子先过一道「强关键词闸」——只要全池存在真关键词命中，就只留这些；
       * 一条都没有时才退回身份兜底（「我喜欢什么」这类问句里没有能命中文本的词，
       * 此时同一个人在名下的条目就是合理答案）。
       */
      let kwStrong = false
      if (words.length) {
        const t = e.text.toLowerCase()
        for (const w of words) {
          if (!contains(t, w)) continue
          hit = true
          const base = w.length >= 3 ? 3 : w.length === 2 ? 2 : 1
          // 两字以上的词才算"真的命中了这个话题"，单字只做加成
          if (w.length >= 2) {
            strongHit = true
            kwStrong = true
          }
          kw += base * Math.max(0.15, idf(w))
        }
      }
      /*
       * 身份命中本身就等于"这条确实是这个人的"。
       *
       * 不把它算进 strongHit 的话，问「我喜欢什么」这种问题会因为关键词
       * 一个都对不上而被下面那层过滤整片丢掉——人明明有记忆，却被判成"想不起来"。
       */
      if (id.qqHit || id.sameName) strongHit = true
      if (wantMeme && e.kind === 'meme') kw += 3 // 问梗时梗优先
      // 越新越值钱，但只值一点点，避免"全是刚说的废话"
      const ageDays = (Date.now() - e.at) / 86400000
      kw += Math.max(0, 2 - ageDays / 30) * 0.3
      // 权重一路用**有效权重**（衰减 + 命中之后的值），让「久不联系」真的变淡
      let w = effectiveWeight(e, this.activeDays)
      const raw = kw + w * 0.15 // 老公式，仅留作对账
      /*
       * 被更正过的条目（supersededBy，2026-10-27 三级去重引入）：
       * 「他喜欢猫」后来被「他其实不喜欢猫」纠正，正文还留着备查，
       * 但不能再跟新结论平起平坐地挤进提示词——否则模型看到两句相反的，
       * 只能靠语气猜哪句算数。这里只降权不删除，两路都降。
       */
      if (e.supersededBy) {
        kw *= SUPERSEDED_PENALTY
        w *= SUPERSEDED_PENALTY
      }
      return { e, kw, w, raw, hit, strongHit, kwStrong, id }
    })

    /*
     * query 非空时的取舍顺序（2026-10-27 P0-2 收尾重排）：
     *   有"两字以上词"真命中的条目 → 只要它们（相关性够硬，身份命中不得扩大池子）
     *   都没有 → 退回身份兜底（qqHit/sameName），「我喜欢什么」这种泛问靠它
     *   再没有 → 接受只有单字命中的 → 但此时必须是短 query（"猫"）
     *   还是没有 → 空数组，宁可说想不起来，也不拿不相干的记忆凑数
     * 泛问兜底（intentKinds）在池子仍为空时于下面接上。
     */
    let pool
    if (!words.length) {
      pool = scored
    } else if (scored.some((x) => x.kwStrong)) {
      /*
       * 闸门只对「软身份」生效：
       *   - sameName（同名，可能同名不同号）不再自动进入候选池；
       *   - qqHit（唯一 QQ 号完全匹配）保留，因为那是「确实是这个人」的硬证据，
       *     而且 rrf_check 的 [1-2] 用例明确要求这种条目留在候选里让两路打架
       *     （「高权重但只沾一个单字」仍进池，只是不能被 RRF 顶到第一）。
       */
      pool = scored.filter((x) => x.kwStrong || x.id.qqHit)
    } else if (scored.some((x) => x.strongHit)) {
      pool = scored.filter((x) => x.strongHit)
    } else if (q.length <= 2) {
      pool = scored.filter((x) => x.hit)
    } else {
      pool = []
    }

    // 兜底：泛问召回。
    //
    // 「我喜欢什么」「我叫啥」「我生日是哪天」这类问句里**根本没有能命中记忆文本的词**
    // —— 记忆条目写的是「他养了一只猫叫团子」，问「我喜欢什么」时 2-gram 切出来
    // 一个词都不在文本里，于是上面直接返回空。可这正是最需要她记得住的时刻。
    //
    // 所以按意图分类兜底：认出问句意图后，直接回该人对应 kind 的高权重条目。
    // 只在 keyword 一分没命中时才启用，不干扰正常检索。
    if (pool.length === 0 && (name || qqStr) && q) {
      const kinds = intentKinds(q)
      if (kinds) {
        /*
         * 按意图的 kind 优先级排序（2026-10-25，第 5 条）：
         * 问「有什么梗」时，梗类要排在 fact 前面；同 kind 再按权重/新鲜度。
         * 之前只按权重排，导致问梗却先甩过来一条事实。
         */
        const kindRank = (e) => {
          const i = kinds.indexOf(e.kind)
          return i < 0 ? 99 : i
        }
        const fallback = this.entries
          .filter((e) => {
            const id = identity(e)
            return (id.qqHit || id.sameName || !e.who) && kinds.includes(e.kind)
          })
          .sort(
            (a, b) =>
              kindRank(a) - kindRank(b) ||
              effectiveWeight(b, this.activeDays) - effectiveWeight(a, this.activeDays) ||
              b.at - a.at,
          )
        if (fallback.length) {
          this.logger?.('debug', `泛问兜底召回：${q} → ${fallback.length} 条`)
          const picked = this.applyCharBudget(fallback.slice(0, limit), charBudget)
          this.markHits(picked)
          return picked
        }
      }
    }

    /*
     * RRF 融合排序（P0-2，2026-10-27）。
     *
     * 两路各排一次序，再按**名次**加分：`0.6/(名次+60) + 0.4/(名次+60)`。
     * 常数 60 和 0.6/0.4 都直接照白云的 hybrid-search.ts（RRF_K / 关键词 0.3 / 向量 0.7
     * 里的关键词那一路；我们没有向量，所以第二路换成「有效权重」）。
     * 为什么不按原始分相加：见上面 scored 里的注释——尺度不可比。
     *
     * 同分时「最近被提起过」的优先（lastActiveDay 大者在前），再不稳就按记录时间。
     * 名次与两路分数都留在 this.lastRecall 里，`/state` 的 memory.status() 能对账。
     */
    const byKeyword = [...pool].sort(compareKeywordArm)
    const byWeight = [...pool].sort(compareWeightArm)
    const rankKeyword = new Map()
    const rankWeight = new Map()
    byKeyword.forEach((x, i) => rankKeyword.set(x, i))
    byWeight.forEach((x, i) => rankWeight.set(x, i))
    for (const x of pool) {
      const rk = rankKeyword.get(x)
      const rw = rankWeight.get(x)
      x.rank = { keyword: rk + 1, weight: rw + 1 }
      x.rrf = RRF_KEYWORD_WEIGHT / (rk + RRF_K) + RRF_WEIGHT_ARM_WEIGHT / (rw + RRF_K)
    }
    pool.sort((a, b) => b.rrf - a.rrf || compareRecency(a, b))
    this.lastRecall = {
      query: q,
      candidates: pool.length,
      words,
      at: Date.now(),
      top: pool.slice(0, 5).map((x) => ({
        id: x.e.id,
        kind: x.e.kind,
        rrf: Number(x.rrf.toFixed(6)),
        rankKeyword: x.rank.keyword,
        rankWeight: x.rank.weight,
        kw: Number(x.kw.toFixed(3)),
        w: Number(x.w.toFixed(2)),
        raw: Number(x.raw.toFixed(3)),
      })),
    }
    if (pool.length) {
      this.logger?.(
        'debug',
        `召回(RRF) ${q || '(空查询)'} → ${pool.length} 候选，头部：${this.lastRecall.top
          .map((t) => `${t.id}(rrf=${t.rrf} kw=${t.kw} w=${t.w} raw=${t.raw})`)
          .join(' > ')}`,
      )
    }
    const picked = this.applyCharBudget(pool.slice(0, limit).map((x) => x.e), charBudget)
    this.markHits(picked)
    return picked
  }

  /**
   * 检索预算：这一轮真正喂回去的正文合计不超过 `charBudget` 字符（balanced 档 1200）。
   *
   * 为什么用字符数而不是条数：一条 240 字的「因果」和一条 8 字的「他住广州」，
   * 对上下文的占用差 30 倍；只限条数等于没限流。
   * 只决定「收哪几条」，**不改写正文**——截断由 contextFor() 负责，
   * 这里动 text 会连带写回盘，等于偷偷改记忆。
   * 至少保留第一条：宁可让她说一句，也别「什么都想不起来」。
   */
  applyCharBudget(list, budget = MEMORY_WINDOW.charBudget) {
    if (!Array.isArray(list) || !list.length) return []
    const cap = Math.round(Number(budget))
    if (!Number.isFinite(cap) || cap <= 0) return list
    const out = []
    let used = 0
    for (const e of list) {
      const len = String(e?.text ?? '').length
      if (out.length && used + len > cap) break
      out.push(e)
      used += len
    }
    return out
  }

  /**
   * 按 QQ 取称谓（2026-10-26 认人补丁）。
   *
   * 跟别的记忆不一样：**不看权重、不参与窗口裁剪、每轮无条件带上**。
   * 原因很简单——称谓只有几个字，省不出什么；而忘掉的代价是「你是谁啊」
   * 和把别人叫成主人。
   *
   * 只认 addressName() 抽得出名字的条目（也就是「叫他X」这种明确要求）。
   * 自称、外号一律抽不出来，直接丢——这是这次事故的正解。
   */
  addressOf({ who = '', qq = '', limit = 8 } = {}) {
    const q = normalizeQq(qq)
    const name = String(who || '').trim()
    /*
     * 排序：**先看权重，再看时间**（2026-10-26 主人 m01431：「恢复称谓的权重，
     * 但是维持 5 级权重」；2026-10-27 m01449 改成 10 级，称谓一律钉满 10）。
     *
     * 为什么不能只按时间：同一个人可能同时有「他希望你叫他「宝宝」」和
     * 「他是主人本人，你叫他「主人」」；纯按 at 排，谁后写谁在前，
     * 一条新写的闲聊外号就能把人工确认过的正经称谓挤到第二行——而
     * engine-context 的规矩是「同一人多条以第一行为准」。权重是人确认过的
     * 强度，比「谁后说的」更该说了算。权重相同再按时间新→旧。
     */
    const raw = this.entries
      .filter((e) => normalizeKind(e.kind) === 'address')
      .filter((e) => (q ? normalizeQq(e.qq) === q : Boolean(name) && e.who === name))
      .sort((a, b) => (b.weight || 0) - (a.weight || 0) || (b.at || 0) - (a.at || 0))
    const out = []
    const seen = new Set()
    for (const e of raw) {
      const n = addressName(e.text)
      if (!n || seen.has(n)) continue
      seen.add(n)
      out.push({ ...e, name: n })
      if (out.length >= limit) break
    }
    return out
  }

  /** 给模型看的记忆段落 */
  contextFor({ who = '', qq = '', query = '', limit = MEMORY_WINDOW.contextLimit } = {}) {
    // 称谓单列一段（engine-context 里每轮必带），这里必须滤掉：
    // 否则「他自称茶茶」会混进「你记得的事」，又变成可被当成称呼的证据。
    const items = this.recall({ who, qq, query, limit }).filter((e) => e.kind !== 'address')
    if (items.length === 0) return ''
    // 单条过长时截断（见 MEMORY_WINDOW.entryChars 的说明），避免一条长记忆挤掉别人
    const clip = (t) => {
      const s = String(t ?? '')
      return s.length > MEMORY_WINDOW.entryChars ? `${s.slice(0, MEMORY_WINDOW.entryChars - 1)}…` : s
    }
    const lines = items.map((e) => `- [${e.kind}]${e.who ? `（${e.who}）` : ''} ${clip(e.text)}`)
    return lines.join('\n')
  }

  renderMarkdown() {
    // who 只是显示名：同名不同号的人要分成两小节，否则 memory.md 里两家的记忆混在一块，
    // 人一眼看过去会以为记串了。只有一个人时保持老格式（不额外加 QQ，免得每行都变长）。
    const byWho = new Map()
    for (const e of this.entries) {
      const k = e.who || '_general'
      if (!byWho.has(k)) byWho.set(k, new Map())
      const byQq = byWho.get(k)
      const q = normalizeQq(e.qq)
      if (!byQq.has(q)) byQq.set(q, [])
      byQq.get(q).push(e)
    }
    const out = ['# 蓝色大肥鱼的记忆', '', `更新时间：${localDateTime()}`, '']
    for (const [who, byQq] of byWho) {
      const multi = [...byQq.keys()].filter(Boolean).length > 1
      for (const [q, list] of byQq) {
        const head = who === '_general' ? '杂项' : who
        out.push(multi ? `## ${head}${q ? `（QQ ${q}）` : '（无 QQ）'}` : `## ${head}`)
        for (const e of list.sort((a, b) => b.at - a.at)) {
          const d = localDateKey(new Date(e.at))
          // 展示「base → 有效权重」：一眼能看出这条是不是正在变淡
          const eff = effectiveWeight(e, this.activeDays)
          const w = eff === e.weight ? `w${e.weight}` : `w${e.weight}→${eff}`
          const lv = Number.isFinite(Number(e.level)) ? ` l${Math.max(0, Math.min(3, Math.round(Number(e.level))))}` : ''
          const hits = Number(e.hits) > 0 ? ` h${e.hits}` : ''
          out.push(`- ${d} [${e.kind}/${w}${lv}${hits}] ${e.text}`)
        }
        out.push('')
      }
    }
    return out.join('\n')
  }
}

/**
 * 泛问意图分类。返回该问题应该信任的 kind 列表，认不出来就返回 null。
 *
 * 存在的理由：关键词召回对「我喜欢什么」这种问题天然失效——记忆条目里
 * 压根没有"喜欢"两个字。可这类问题恰恰是用户检验"你到底记不记得我"的首选。
 */
/**
 * 周键（P1-4 周聚合用）：一周从**周一**开始，键就是周一那天的 'YYYY-MM-DD'。
 *
 * 为什么用周一：文档里周摘要正文写的是「10-20~10-26」，那是周一到周日。
 * 为什么键用日期而不是 W43：日期跨年不会出错，也不用记 ISO 周序号的规则。
 *
 * @param {string|number|Date} [input]
 * @returns {string} 空串表示输入不是合法时间
 */
export function weekKeyOf(input = new Date()) {
  const d = input instanceof Date ? new Date(input.getTime()) : new Date(input)
  if (Number.isNaN(d.getTime())) return ''
  const diff = (d.getDay() + 6) % 7 // 周一=0，周日=6
  return localDateKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() - diff))
}

/** 周键 → 正文里的「10-20~10-26」（周一到周日） */
export function weekLabelOf(weekKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(weekKey || ''))
  if (!m) return ''
  const mon = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(mon.getTime())) return ''
  const sun = new Date(mon.getFullYear(), mon.getMonth(), mon.getDate() + 6)
  const md = (x) => `${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`
  return `${md(mon)}~${md(sun)}`
}

function intentKinds(q) {
  const s = String(q || '')
  // 先摘掉问句外壳，只看实义部分
  if (/(喜欢|爱吃|爱喝|爱好|口味|讨厌|受不了|雷点|忌口)/.test(s)) {
    return ['preference', 'fact']
  }
  if (/(我是谁|我叫什么|我叫啥|我名字|我的名字|猜猜我是)/.test(s)) {
    return ['person']
  }
  if (/(生日|几岁|多大|年龄)/.test(s)) {
    return ['person', 'event']
  }
  if (/(答应|说好|约好|承诺|计划|打算)/.test(s)) {
    return ['promise', 'event']
  }
  // 2026-10-25（主人第 5 条）：问「有什么梗/说个梗」时优先召回梗类
  // 放在 promise 之后、近况之前：以「梗」为实义词的提问才命中
  if (/(梗|玩梗|接梗|烂梗|热梗|梗图|名场面|口头禅|乐子|整活)/.test(s)) {
    return ['meme', 'fact']
  }
  // 「最近怎么样」必须带自我指代，否则「今天天气怎么样」也会被当成问自己的近况
  if (/((我|俺|咱).{0,4}(最近|怎么样|还好吗|忙什么|在干嘛|过得))|^(最近|最近在)/.test(s)) {
    return ['event', 'fact']
  }
  return null
}

/**
 * 检索词是否出现在文本中。
 *
 * 单字要额外小心：中文 2-gram 切词会切出「啡」「什」这种碎片，
 * 它们能在完全无关的句子里命中（"咖啡" 的 "啡" 命中 "睡午觉" 里的片段）。
 * 但也不能一刀切否掉单字——用户问"猫"时，"主人的猫叫锅贴" 必须命中。
 *
 * 折中：单字命中时要求它**前后至少有一侧是汉字**，也就是"这个字确实是
 * 某个词的一部分"，而不是被标点孤立的残渣。再配合 recall 里的规则
 * （有整词命中时只取整词），碎片噪声就被压住了。
 */
function contains(text, w) {
  if (!w) return false
  if (w.length >= 2) return text.includes(w)
  const hanNum = (c) => (c && /[\p{Script=Han}a-z0-9]/u.test(c) ? 1 : 0)
  let from = 0
  while (from <= text.length - 1) {
    const idx = text.indexOf(w, from)
    if (idx < 0) return false
    // 两侧至少一侧连着汉字 → 这个字在句子里是个真词的一部分
    if (hanNum(text[idx - 1]) + hanNum(text[idx + 1]) >= 1) return true
    from = idx + 1
  }
  return false
}

/**
 * 把一句话切成检索词。
 *
 * 中文没有空格，"我家猫叫啥" 直接 includes 匹配不到 "猫叫锅贴"。
 * 所以按 2-gram 切：先按标点分成若干块，每块再取连续两字 + 补充单字。
 * 「我家猫叫啥」→ [我家, 家猫, 猫叫, 叫啥] + [猫, 啥]
 * 一个字的块（"猫"）就只留单字。
 */
function tokenize(q) {
  if (!q) return []
  const out = new Set()
  // 停用词：句子里出现但跟记忆无关的高频虚词，留着重罚
  const stop = new Set(['什么', '怎么', '为什', '是不', '不是', '有没', '没有', '我的', '你的', '他叫', '她叫'])
  for (const chunk of q.split(/[^\p{Script=Han}a-z0-9]+/u)) {
    if (!chunk) continue
    if (/\p{Script=Han}/u.test(chunk)) {
      if (chunk.length === 1) out.add(chunk)
      else {
        for (let i = 0; i + 2 <= chunk.length; i++) {
          const g = chunk.slice(i, i + 2)
          if (!stop.has(g)) out.add(g)
        }
        // 三字以上的块再补一个整体，防止「锅贴」被切碎后漏掉
        if (chunk.length >= 3) out.add(chunk)
        // 单字也留：短词查询（"猫"）全靠它
        for (const ch of chunk) out.add(ch)
      }
    } else {
      out.add(chunk)
    }
  }
  return [...out].filter((w) => w.length >= 1)
}

/** 去重前先抹平"格式差异"：空白、标点、emoji、大小写都不该让同一句话变成两条 */
function normalizeForDup(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 粗糙相似度：字符 trigram 重合率。够用来去重，不用上编辑距离。 */
function similarity(a, b) {
  const A = String(a || '')
  const B = String(b || '')
  if (!A || !B) return 0
  if (A === B) return 1
  const grams = (s) => {
    const set = new Set()
    for (let i = 0; i < s.length - 2; i++) set.add(s.slice(i, i + 3))
    if (s.length < 3) set.add(s)
    return set
  }
  const ga = grams(A)
  const gb = grams(B)
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter++
  return inter / Math.max(ga.size, gb.size)
}

/**
 * 两条记忆是不是「同一个人」。
 *
 * 为什么单独抽出来：2026-10-23 主人要求「每一条记忆都去重，新的覆盖旧的」，
 * 而原来的判断只认「两条都有 qq 且相等」或「两条都有名字且相等」，
 * 两边都没有身份的条目（群里没登记的陌生人，who 为空、qq 为空）永远判「不是同一人」，
 * 于是 dedupeAll 在生产上一次只能合 0 条——主人听到的「去重没生效」就是这个。
 * 现在的规则：
 *   1) 两边都有 qq → 只认 qq；
 *   2) 否则两边都有名字 → 认名字；
 *   3) 只有一边有身份 → 不敢说同一人（名字对不上就不合）；
 *   4) 两边都没有身份 → 只能靠文本判重（和无名条目合并要保守，靠 similarity 阈值兜底）。
 */
function sameIdentity(a, b) {
  const aQq = normalizeQq(a?.qq)
  const bQq = normalizeQq(b?.qq)
  if (aQq && bQq) return aQq === bQq
  const aWho = String(a?.who ?? '').trim()
  const bWho = String(b?.who ?? '').trim()
  if (aWho && bWho) return aWho === bWho
  if (aQq || bQq || aWho || bWho) return false
  return true
}

/**
 * 去重阈值。
 * 表情包是「一张图一条」，名字差一个字就是另一张图（生产里 0.72 相似的两条其实是不同图），
 * 所以 sticker **只认去掉格式后完全一样**；其余语义文本给 0.70 的模糊阈值。
 */
function dupThreshold(kindA, kindB) {
  return normalizeKind(kindA) === 'meme' || normalizeKind(kindB) === 'meme' ? 1 : DUP_MERGE_SIMILARITY
}

/**
 * 三级去重的两条线（对照 BaiShou-Next 的 DUPLICATE_THRESHOLD / MERGE_THRESHOLD）。
 *
 *   score >= DUP_SKIP_SIMILARITY  → 当重复，直接跳过（只刷新「又被提起」的时间）
 *   DUP_MERGE_SIMILARITY ~ 0.92   → 合并：新的覆盖旧的文字，权重取高的
 *   < DUP_MERGE_SIMILARITY        → 全新信息，直接存
 *
 * 为什么不再「沾边就覆盖」：生产里同一件事被反复提起时，每次都会重写一遍正文、
 * 重新算一次时间，看上去像「今天刚知道的」，实际是三天前的旧结论。
 */
const DUP_SKIP_SIMILARITY = 0.92
const DUP_MERGE_SIMILARITY = 0.7
/** 被更正过的条目在召回时的降权系数（只降权，不删除） */
const SUPERSEDED_PENALTY = 0.4

/**
 * RRF（Reciprocal Rank Fusion）融合排序的三个旋钮（P0-2，2026-10-27）。
 *
 * 来源是白守 `hybrid-search.ts`：`RRF_K = 60`、`score = w / (rank + 60)`，
 * 按**名次**融合而不是原始分相加——两路分数尺度不可比。
 * 他们两路是关键词 0.3 / 向量 0.7；我们没有 embedding，第二路换成「有效权重」，
 * 所以给 0.6 / 0.4（关键词是相关性主线，权重只做重要度校正）。
 */
const RRF_K = 60
const RRF_KEYWORD_WEIGHT = 0.6
const RRF_WEIGHT_ARM_WEIGHT = 0.4

/**
 * RRF 两路的排序器（入参是 recall() 里 score 出来的 `{ e, kw, w }`）。
 *
 * 关键词路主看 kw（相关性），权重路主看 w（有效权重）；各自辅以另一路和
 * 「最近被提起」做稳定次序——否则同分条目的顺序取决于数组插入顺序，
 * 一天里反复调用会看到召回结果在抖。
 */
function compareKeywordArm(a, b) {
  return b.kw - a.kw || b.w - a.w || compareRecency(a, b)
}

function compareWeightArm(a, b) {
  return b.w - a.w || b.kw - a.kw || compareRecency(a, b)
}

/** 同分时「最近被提起过」的排前面（lastActiveDay 大者在前），再按记录时间 */
function compareRecency(a, b) {
  const la = Number(a?.e?.lastActiveDay ?? -1)
  const lb = Number(b?.e?.lastActiveDay ?? -1)
  return lb - la || (b?.e?.at || 0) - (a?.e?.at || 0)
}

/**
 * 这句话是不是否定表述。
 *
 * 去重最大的事故是「他喜欢猫」被「他其实不喜欢猫」按相似度覆盖掉——字面几乎一样，
 * 意思正好相反。这里只做粗判，宁可漏判也不乱判：
 *   - 英文 not / never / don't / can't …
 *   - 「不喜欢 / 不要 / 不是 / 不会 / 不能」这类否定谓词
 *   - 句首或标点后的「不」「别」
 * 刻意避开「不错 / 不过 / 不好意思 / 别人 / 别的」这些含「不」「别」但不是否定的词。
 */
function hasNegation(text) {
  const t = String(text || '')
  if (!t) return false
  if (/(?:^|[\s，。；！？,.;!?])?(?:not|never|cannot)\b/i.test(t)) return true
  if (/\b(?:don't|doesn't|isn't|aren't|won't|can't)\b/i.test(t)) return true
  if (/不(?:喜欢|想|要|是|会|能|爱|去|来|吃|喝|玩|睡|做|认识|记得|同意|接受|觉得)/.test(t)) return true
  if (/(?:^|[，。；、！？,.;:：\s])不(?!错|过|好意思|行|用|少|久)/.test(t)) return true
  if (/(?:^|[，。；、！？,.;:：\s])别(?!人|的|处)/.test(t)) return true
  if (/没有|没了|不再|从未|从来不/.test(t)) return true
  return false
}

/**
 * 两条文本共享几个实词（长度 >= 2 的切词）。
 * 只有说的是同一件事才谈得上冲突——同一个人的两条无关记忆不该互相压制。
 */
function sharedKeywordCount(a, b) {
  const A = new Set(tokenize(a).filter((w) => w.length >= 2))
  if (A.size === 0) return 0
  let n = 0
  for (const w of new Set(tokenize(b).filter((x) => x.length >= 2))) {
    if (A.has(w)) n += 1
  }
  return n
}

/**
 * 两条记忆是不是「意思相反」。
 * 判定条件：一边否定、一边不否定，且共享至少两个实词。
 * 只用于去重时决定「不许合并」，不用来删东西。
 */
function conflicts(prevText, nextText) {
  const a = hasNegation(prevText)
  const b = hasNegation(nextText)
  if (a === b) return false
  return sharedKeywordCount(prevText, nextText) >= 2
}
