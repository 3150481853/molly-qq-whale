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

function coreRank(e) {
  const t = String(e?.text || '')
  let s = 0
  if (/名字|全名/.test(t)) s += 3
  if (/叫[\u4e00-\u9fa5]{1,4}(，|,|。|$)/.test(t)) s += 2
  if (/\d{1,3}\s*岁/.test(t)) s += 3
  if (/职业|做的是|上班|工作|在读|学生/.test(t)) s += 2
  if (/住在|老家|城市|省|市/.test(t)) s += 2
  if (t.length <= 60) s += 2
  if (t.length > 120) s -= 2
  if (/今天|昨天|前天|（\d{1,2}月\d{1,2}日/.test(t)) s -= 3
  return s
}

export const MEMORY_WINDOW = MEMORY_WINDOW_PROFILES[WINDOW_PROFILE]

/*
 * 核心档案保底位。
 *
 * 为什么需要：写入侧越写越多以后，人名、年龄、职业这种「最不该丢」的条目会被
 * 一屋子一次性细节挤出窗口 —— 实测问「我叫什么、多大了」，候选池只进来 1 条称呼，
 * 她于是答「你全名和年龄我都没记过」，直接从「记得」翻成「错否」。
 *
 * 做法：不论问什么，只要库里有一条关于本人的稳定身份条目（kind=person、权重够、
 * 正文含名字/年龄/职业/所在地这类词、没被取代），就固定占窗口最前面 1 个位置。
 * 只占位置，不改正文、不改打分、不算 hit。
 * 可用 MOLLY_CORE_SLOTS=0 关闭；MOLLY_CORE_SLOTS=2 可占两位。
 */
const CORE_SLOTS = Number(process.env.MOLLY_CORE_SLOTS ?? 1)
const CORE_KINDS = new Set(['person'])
const CORE_MIN_WEIGHT = 5
const CORE_TEXT_RE = /名字|叫[^，。]{0,6}|\d{1,3}\s*岁|生日|职业|工作|上班|上学|住|城市|老家|省|市|在广州|在上海|在北京/

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
  /*
   * 复习加成（2026-11-07 v0.8）。
   *
   * 原来 hits 只用来置 lastActiveDay，权重一点不涨：实测 hits=0 和 hits>=10 的 fact
   * 衰减完全一样（6.0 → 3.0），"被反复问过的事更牢"这件事根本没实现。
   * 这里让常被召回的条目**老得慢一点**：hits>=3 起，idle 最多打七折（封顶 30%），
   * 只改衰减斜率，不改 base、不动下限，所以不会把旧事顶成新事。
   */
  const hits = Math.max(0, Math.round(Number(entry?.hits) || 0))
  const keep = hits >= 3 ? Math.min(0.3, Math.log2(hits) * 0.06) : 0
  const idle = Math.max(0, now - last) * (1 - keep)
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
  constructor({
    dir,
    logger,
    limit = 2000,
    growTo = 0,
    crypt = null,
    poolFile = '',
    dataDir = '',
    account = '',
    graph = false,
    abstractTags = false,
  }) {
    this.dir = dir
    this.dataDir = String(dataDir || '').trim() || path.dirname(path.resolve(dir))
    this.logger = logger || (() => {})
    this.crypt = crypt || null
    this.broken = false
    this.migrated = false
    this.deduped = 0
    this.mergedCount = 0
    /*
     * 识海图（2026-10-28，对照小黑盒「四层记忆框架」的 L1 edges）：
     *   graph=true 时，同一次召回命中的条目两两连边（`e.edges = [[id, w, at], ...]`），
     *   召回打分时沿边扩散两跳（每跳 ×0.6，取最大值）。
     *   默认关——纯算法增量：关掉时既不连边也不扩散，行为与改动前逐条一致。
     */
    this.graphEnabled = Boolean(graph)
    /** 同 tag ≥3 条且被问过 → 抽象一条「关于X：…」的规律节点（默认关） */
    this.abstractTagsEnabled = Boolean(abstractTags)
    this.linksAdded = 0
    this.abstracted = 0
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
      /*
       * 加载即自检（2026-11-02）：旧版 conflicts() 误标了 952 条 supersededBy，
       * 全靠人记得跑清理脚本是等不到的——实测清理完两分钟就被旧进程 save() 覆盖回去了。
       * 所以把复核放进装载流程：每次启动顺手摘掉失效标记，没问题就零写入。
       */
      this.healSupersededOnLoad()
      // 相对日期补写（MH01）：老条目里只有「明天」没有日期，装载时按 at 补一次
      this.healRelativeDatesOnLoad()
      // 语气补写 + 过期计划打标（2026-11-03 评论区：计划不等于已发生）
      this.healTenseOnLoad()
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
    /*
     * 相对日期归一（2026-11-02 molly-bench 加难卷 MH01）。
     * 库里 240 条（5.6%）正文只有「明天/上周三/后天」这类相对词，没有任何日期锚：
     * 问「他说『明天』再排查，那天是哪天」，条目本身答不出来。她自己的周信里都在问
     * 「你说明天再排查。结果这个『明天』我好像等了好几天」。
     * 所以在**入库**这一步按条目自己的写入时间折算成绝对日期。
     */
    const t = normalizeRelativeDates(String(text || '').trim(), Date.now())
    if (!t) return null
    const k = normalizeKind(kind)
    // 计划 / 已发生分开（见 detectTense 的注释）：写路径不加模型调用，纯词面判断
    const tenseInfo = TENSE_ON ? detectTense(t, k, Date.now()) : { tense: '', dueAt: 0 }
    const src = normalizeSource(source)
    /*
     * v0.5（2026-11-06）：放行「她自己说过的话」。
     *
     * 原来的闸门是「助手自述一律不许写成 fact/person」，为的是防幻觉——
     * 她不能把自己瞎编的东西当成用户的客观事实。那个担心仍然成立，
     * 所以只放行**带「我说过：」前缀**的：前缀由抽取模型显式打上，
     * 语义是「这是我自己说过的话」，不是「用户的事实」。
     */
    const selfQuote = /^我说过[:：]/.test(t)
    if (src === 'assistant' && (k === 'fact' || k === 'person') && !selfQuote) {
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
    const conflictEntry = this.findConflict({ who: name, qq: q, text: t, kind: k })
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
    /*
     * 同题合并（2026-11-02 主人 m01658）。走到这里说明「字面不像」，
     * 但可能「意思像」——同一场八点之约被说了几十遍，每遍措辞都不同。
     * 不新建条目，只把老条目往前挪一天、加一点权重、记一次「又被提起」。
     *
     * 为什么不覆盖正文（不像上面的 findDuplicate 合并分支那样 `prev.text = t`）：
     * 同题的两句话细节不同（「校门口见真章」vs「端锅过来」），谁替换谁都会丢细节。
     * 保留最早那条（通常是信息最全的原句），后来者只贡献「还在这件事上」的信号。
     *
     * 冲突（改口）时不合并：`conflicting` 表示这是对旧说法的更正，必须留成新条目。
     *
     * **默认关闭**（`MOLLY_TOPIC_MERGE=1` 才开）。原因写在这里，别再试第二次：
     * 沙箱 4548 条语料上，开与不开的四档成绩完全一致（14/14/13/14，MH02 的 d15 都是
     * 「金条根本没进候选池」）——这个改动没有任何实测收益，却会永久改变写入行为。
     * 按「没有量到的收益不进生产」的规矩，先留成开关 + 迁移工具。
     * 反直觉的结论：把 210 条「八点」折叠成 20 条，并没有让 MH02 的金条被召回，
     * 因为它的失败点不在拥挤，而在**候选池阶段就漏了**（金条 rank=0）。
     */
    if (!conflicting && TOPIC_MERGE_ON) {
      const topic = this.findSameTopic({ who: name, qq: q, text: t, kind: k })
      if (topic) {
        const prev = topic.entry
        prev.lastActiveDay = this.activeDays
        prev.at = Date.now()
        prev.weight = Math.min(WEIGHT_MAX, Math.max(clampWeight(prev.weight), w) + TOPIC_MERGE_WEIGHT_GAIN)
        prev.repeats = (Number(prev.repeats) || 1) + 1
        if (q && !normalizeQq(prev.qq)) prev.qq = q
        if (name && !prev.who) prev.who = name
        this.topicMerged = (Number(this.topicMerged) || 0) + 1
        this.save()
        this.logger(
          'debug',
          `同题合并（${topic.score.toFixed(2)} / ${topic.shared} 词），未写入：${t.slice(0, 24)}`,
        )
        return { ...prev, skipped: true, sameTopic: true }
      }
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
      // 语气与到期：只有判出来才写，没判出来保持老条目形状（不影响老数据）
      ...(tenseInfo.tense ? { tense: tenseInfo.tense } : {}),
      ...(tenseInfo.tense === 'plan' && tenseInfo.dueAt ? { dueAt: tenseInfo.dueAt } : {}),
    }
    /* v1.0：状态翻新（「还没报价」→「已发来报价」），旧的降权不删 */
    const pendingOld = this.findPendingUpdate({ who: name, qq: q, text: t })
    if (pendingOld) {
      pendingOld.supersededBy = entry.id
      pendingOld.supersededAt = entry.at
      this.stateUpdated = (Number(this.stateUpdated) || 0) + 1
      this.logger('debug', `状态翻新：${String(pendingOld.text).slice(0, 20)} -> ${t.slice(0, 20)}`)
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
   * 找「同一个人 + 同一件事，但换了说法」的老条目（2026-11-02 主人 m01658）。
   *
   * 和 findDuplicate 的分工：
   *   - findDuplicate 认「字面像」（trigram ≥ 0.7）——同一句话被重复说；
   *   - findSameTopic 认「意思像」（2-gram 实词包含度 ≥ 0.85 且共享 ≥ 5 词）——
   *     同一件事被不同句子说了几十遍。生产里 210 条「白饭鱼 + 八点」大多属于后者，
   *     字面重合只有 0.2~0.4，旧阈值一条都合不进去。
   *
   * 限定窗口（默认 3 天）：八点之约和十天后的八点之约是两件事，
   * 同题合并只负责「同一场活动被反复抽条」，不负责跨月归并。
   *
   * @param {{who?: string, qq?: string, text?: string, kind?: string, at?: number}} probe
   * @returns {{entry: object, score: number, shared: number}|null}
   */
  findSameTopic({ who = '', qq = '', text = '', kind = '', at = Date.now() } = {}) {
    const k = normalizeKind(kind)
    if (TOPIC_MERGE_SKIP_KINDS.has(k)) return null
    const probe = { who: String(who || '').trim(), qq: normalizeQq(qq) }
    const tar = contentKeywords(text)
    if (tar.size < TOPIC_MERGE_SHARED) return null
    let best = null
    for (const e of this.entries) {
      if (e.mergedInto) continue
      if (normalizeKind(e.kind) !== k) continue
      if (!sameIdentity(probe, e)) continue
      if (Math.abs(Number(at) - Number(e.at || 0)) > TOPIC_MERGE_WINDOW_MS) continue
      const cur = contentKeywords(e.text)
      if (cur.size < TOPIC_MERGE_SHARED) continue
      let shared = 0
      for (const w of tar) if (cur.has(w)) shared++
      if (shared < TOPIC_MERGE_SHARED) continue
      const score = shared / Math.min(tar.size, cur.size)
      if (score < TOPIC_MERGE_SIMILARITY) continue
      if (!best || score > best.score) best = { entry: e, score, shared }
    }
    return best
  }

  /**
   * 存量迁移：把历史上已经被反复抽条的「同题条目」折叠回最早那条。
   *
   * 为什么不删：被折叠的条目只是打 `mergedInto`，正文留在盘上（可回滚、可审计），
   * recall 用 `active` 把它们排除在召回和 IDF 统计之外。
   * 默认 dryRun，`---apply` 才落盘。
   */
  mergeSameTopics({ dryRun = true, windowMs = TOPIC_MERGE_WINDOW_MS } = {}) {
    const list = [...this.entries].sort((a, b) => Number(a.at || 0) - Number(b.at || 0))
    const keys = new Map(list.map((e) => [e.id, contentKeywords(e.text)]))
    const heads = []
    const items = []
    for (const e of list) {
      const k = normalizeKind(e.kind)
      const cur = keys.get(e.id)
      let head = null
      let bestScore = 0
      if (!TOPIC_MERGE_SKIP_KINDS.has(k) && cur.size >= TOPIC_MERGE_SHARED) {
        for (const h of heads) {
          if (normalizeKind(h.kind) !== k) continue
          if (Number(e.at || 0) - Number(h.at || 0) > windowMs) continue
          if (!sameIdentity(e, h)) continue
          const hk = keys.get(h.id)
          if (hk.size < TOPIC_MERGE_SHARED) continue
          let shared = 0
          for (const w of cur) if (hk.has(w)) shared++
          if (shared < TOPIC_MERGE_SHARED) continue
          const score = shared / Math.min(cur.size, hk.size)
          if (score >= TOPIC_MERGE_SIMILARITY && score > bestScore) {
            head = h
            bestScore = score
          }
        }
      }
      if (!head) {
        heads.push(e)
        continue
      }
      items.push({ id: e.id, into: head.id, score: Number(bestScore.toFixed(2)), text: String(e.text || '').slice(0, 40) })
      if (!dryRun) {
        e.mergedInto = head.id
        e.mergedAt = Date.now()
      }
    }
    if (!dryRun && items.length) this.save()
    return { dryRun, merged: items.length, items }
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
  /**
   * v1.0：找「被翻新的旧状态」——「还没报价」→「已发来报价」。
   *
   * 和 findConflict 的区别：改口是「同一件事两种相反说法」，这里是
   * 「事情往前走了」——旧条目没错，只是过期了。所以判据不同：
   *   1. 旧条目里带「还没 / 尚未 / 还在等」这类未完成标记；
   *   2. 新条目里带「已经 / 发来 / 改到 / 定下来」这类完成标记；
   *   3. 两条共享 ≥2 个实词（同一件事），同一个人。
   * 命中就把旧条目标 supersededBy——召回降权，正文保留（可回溯）。
   */
  findPendingUpdate({ who = '', qq = '', text = '' } = {}) {
    if (process.env.MOLLY_STATE_UPDATE === '0') return null
    const t = String(text || '')
    if (!PENDING_DONE_RE.test(t)) return null
    const q = normalizeQq(qq)
    const name = String(who || '').trim()
    let best = null
    let bestScore = 0
    for (const e of this.entries) {
      if (e.supersededBy) continue
      if (e.kind === 'meme' || e.kind === 'address') continue
      if (!sameIdentity({ who: name, qq: q }, e)) continue
      if (!PENDING_OPEN_RE.test(String(e.text || ''))) continue
      const n = sharedKeywordCount(e.text, t)
      if (n >= 2 && n > bestScore) {
        best = e
        bestScore = n
      }
    }
    return best
  }

  findConflict({ who = '', qq = '', text = '', kind = '' } = {}) {
    const q = normalizeQq(qq)
    const name = String(who || '').trim()
    /*
     * 表情包不是"说法"，不会被推翻（2026-11-02 复查：剩下 13 条全是 meme 互相取代）。
     * 「面无表情」里的"无"被当成否定词，「学到了表情包：蓝发_面无表情」就被判成
     * 和「学到了表情包：蓝发_半睁眼」改口——两张图而已，谁也不取代谁。
     */
    if (normalizeKind(kind) === 'meme') return null
    if (!normalizeForDup(text)) return null
    let best = null
    let bestScore = 0
    for (const e of this.entries) {
      if (e.supersededBy) continue // 已经被更正的不用再更正一次
      if (e.kind === 'meme') continue
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
   * 复核所有「被更正」标记（2026-11-02 molly-bench 发现 4 的存量清理）。
   *
   * 旧版 conflicts() 会把「都在讲猫」的两条长叙述判成改口，历史库里的错误标记
   * 不会因为判定规则改了而自己消失，必须复核一遍：
   *   - 取代者已经不存在 → 摘掉标记（取代链断了，降权没有意义）；
   *   - 按新规则两条已不构成改口 → 摘掉标记。
   * 默认 dryRun，先看清单再动手。
   *
   * @param {{dryRun?: boolean}} [options]
   * @returns {{checked: number, cleared: number, items: object[]}}
   */
  repairSuperseded({ dryRun = true } = {}) {
    const byId = new Map(this.entries.map((e) => [e.id, e]))
    const items = []
    for (const e of this.entries) {
      if (!e.supersededBy) continue
      const successor = byId.get(e.supersededBy)
      let reason = ''
      if (!successor) reason = '取代者已不存在'
      else if (!conflicts(successor.text, e.text)) reason = '按新规则不算改口'
      if (!reason) continue
      items.push({
        id: e.id,
        who: e.who,
        kind: e.kind,
        text: String(e.text || '').slice(0, 50),
        successor: String((successor && successor.text) || '').slice(0, 50),
        reason,
      })
      if (!dryRun) {
        delete e.supersededBy
        delete e.supersededAt
      }
    }
    if (!dryRun && items.length) this.save()
    return { checked: this.entries.filter((e) => e.supersededBy).length, cleared: items.length, items }
  }

  /**
   * 装载时自检「被更正」标记（2026-11-02）。
   *
   * 只在确实有标记时才跑；没有任何标记就是一次 `Array.some` 的开销，不写盘。
   * 不能抛：记忆自检失败绝不该连带插件起不来。
   */
  healSupersededOnLoad() {
    if (this.broken || !this.entries.length) return
    if (!this.entries.some((e) => e.supersededBy)) return
    try {
      const res = this.repairSuperseded({ dryRun: false })
      if (res.cleared) this.logger('info', `记忆自检：摘除 ${res.cleared} 条失效的「被更正」标记`)
    } catch (err) {
      this.logger('warn', `记忆自检失败（不影响读写）: ${err && err.message}`)
    }
  }

  /**
   * 相对日期补写（2026-11-02 molly-bench 加难卷 MH01）。
   *
   * 入库时已经会归一（add()），但老条目是归一之前写的：240 条正文只有
   * 「明天/上周三/后天」，没有日期锚。问「那天是哪天」时条目自己答不出来。
   * 这里按每条自己的 at 补一次，补过的不再动（幂等），改完 save 一次。
   */
  healRelativeDatesOnLoad() {
    if (this.broken || !this.entries.length) return 0
    let fixed = 0
    for (const e of this.entries) {
      const before = String(e.text || '')
      if (!before) continue
      const after = normalizeRelativeDates(before, e.at || Date.now())
      if (after !== before) {
        e.text = after
        fixed += 1
      }
    }
    if (fixed) {
      this.logger('info', `相对日期补写 ${fixed} 条（「明天」→「明天（10月21日）」）`)
      this.save()
    }
    return fixed
  }

  /**
   * 过期未兑现的计划打标（2026-11-03，评论区 @shuun 指出的「明天不代表已经发生」）。
   *
   * 只认 `tense === 'plan'` 且带 `dueAt` 的条目；过了到期时间再宽容
   * `graceMs`（默认半天）还没被标成 fulfilled 的，打 `unfulfilled`。
   * **不删、不改正文**：计划本身是真实信息（「他答应过端锅来」），
   * 只是在读的时候降权，并且不再冒充「已经发生」。
   *
   * @param {{now?: number, graceMs?: number, dryRun?: boolean}} [options]
   * @returns {{count: number, dryRun: boolean}}
   */
  sweepPlans({ now = Date.now(), graceMs = PLAN_GRACE_MS, dryRun = false } = {}) {
    if (!TENSE_ON || this.broken || !this.entries.length) return { count: 0, dryRun }
    let count = 0
    for (const e of this.entries) {
      if (e.tense !== 'plan' || !e.dueAt || e.unfulfilled || e.fulfilledAt) continue
      if (now < Number(e.dueAt) + graceMs) continue
      count += 1
      if (dryRun) continue
      e.unfulfilled = true
      e.unfulfilledAt = now
      // 降权但不删：欠账类问题仍然要能问到
      e.weight = clampWeight(Math.max(WEIGHT_MIN, (Number(e.weight) || WEIGHT_DEFAULT) - 0.5))
    }
    if (count && !dryRun) {
      this.logger('info', `计划过期未兑现 ${count} 条（降权保留，仍可问「还欠着什么」）`)
      this.save()
    }
    return { count, dryRun }
  }

  /**
   * 装载时补写语气（`tense` / `dueAt`），再扫一遍过期计划。
   *
   * 老条目没有这两个字段，靠这里按自己的 `at` 补一次（幂等：已判过的不再动）。
   * 只写「判出来的」，判不出来保持原样——宁可少标，不要给每条记忆瞎贴标签。
   */
  healTenseOnLoad() {
    if (!TENSE_ON || this.broken || !this.entries.length) return 0
    let filled = 0
    for (const e of this.entries) {
      if (e.tense !== undefined) continue
      const info = detectTense(e.text, e.kind, e.at || Date.now())
      if (!info.tense) continue
      e.tense = info.tense
      if (info.tense === 'plan' && info.dueAt) e.dueAt = info.dueAt
      filled += 1
    }
    const dry = this.sweepPlans({ dryRun: true })
    if (filled || dry.count) {
      this.logger('info', `语气补写 ${filled} 条；过期计划 ${dry.count} 条`)
      this.sweepPlans({})
      this.save()
    }
    return filled
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
      // 识海图 / tag 抽象（2026-10-28）：开关状态与本进程内的累计产量，控制台一眼能看出有没有生效
      graph: this.graphEnabled,
      abstractTags: this.abstractTagsEnabled,
      links: this.linksAdded,
      abstracted: this.abstracted,
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
   * 装载条目向量（2026-11-02，向量第二路的存储侧）。
   *
   * key = 条目 id，value = 已归一化的 Float32Array（余弦 = 点积，省一次开方）。
   * 缺向量的条目不会丢——recall 里它们排在向量臂尾部，仍按老权重次序走。
   * 传 null / 空表 = 关掉向量臂，行为与这次改动之前一致。
   */
  setVectors(map) {
    this.vectors = map instanceof Map ? map : new Map(Object.entries(map || {}))
    return this.vectors.size
  }

  /**
   * 接外部重排器（本地 sidecar 的 /rerank）。
   *
   * 约定：`fn(query, texts) => number[]`，分数越大越相关；**必须是同步函数**——
   * recall() 是同步的，调用链（engine-context → contextFor → recall）里没有 await 的位置。
   * 所以外面用 execFileSync 调 curl，最长 1.5 秒；超时/异常在这里一律吞掉并退回粗排。
   */
  setReranker(fn) {
    this.reranker = typeof fn === 'function' ? fn : null
    return Boolean(this.reranker)
  }

  /**
   * 接外部嵌入器（本地 sidecar 的 /embed）。
   * 约定：`fn(text) => Float32Array | null`，已 L2 归一化；同样必须同步。
   * 没接的时候 recall 走纯关键词，行为与 2026-11-02 之前完全一致。
   */
  setEmbedder(fn) {
    this.embedder = typeof fn === 'function' ? fn : null
    return Boolean(this.embedder)
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
    // 连边放在节流之前：边是「长期资产」，不该因为 5 秒节流被丢掉
    if (this.graphEnabled) this.linkRecall(list)
    // 一轮对话里 recall 可能被调好几次，5 秒内只落一次盘
    if (now - this._hitSaveAt < 5000) return
    this._hitSaveAt = now
    this.save()
  }

  /**
   * 把这次**一起被想起来**的条目两两连边（识海图的写入端，2026-10-28）。
   *
   * 只连前 `pairLimit` 条：召回的头部才是"这次对话真正用到的那几条"，
   * 尾巴上本来就沾边的弱命中连起来会迅速把图连成一张网，扩散信号就废了。
   * 称谓（address）不参与：它每轮无条件注入，连边等于把所有条目都挂到称谓上。
   *
   * @returns {number} 参与连边的条目数（<2 时什么都不做）
   */
  linkRecall(list, { pairLimit = 5, gain = GRAPH_EDGE_GAIN } = {}) {
    if (!this.graphEnabled) return 0
    const head = []
    for (const e of list) {
      if (!e || !e.id) continue
      if (normalizeKind(e.kind) === 'address') continue
      head.push(e)
      if (head.length >= pairLimit) break
    }
    if (head.length < 2) return 0
    for (let i = 0; i < head.length; i += 1) {
      for (let j = i + 1; j < head.length; j += 1) this.addEdge(head[i], head[j], gain)
    }
    return head.length
  }

  /**
   * 给一条边加权（双向各存一份，召回时从任意一端都能扩散过去）。
   *
   * 边存成 `[id, w, at]` 而不是对象：5 万条池子里每条多 8 个对象，
   * 落盘体积和 JSON.parse 的耗时都会翻倍，数组足够且更好砍。
   */
  addEdge(a, b, gain = GRAPH_EDGE_GAIN) {
    if (!a || !b || !a.id || !b.id || a.id === b.id) return
    const at = Date.now()
    const bump = (src, dst) => {
      if (!Array.isArray(src.edges)) src.edges = []
      const edge = src.edges.find((x) => Array.isArray(x) && x[0] === dst.id)
      if (edge) {
        edge[1] = Math.min(1, Number(edge[1]) + gain)
        edge[2] = at
      } else {
        src.edges.push([dst.id, Math.min(1, Math.max(gain, 0.6)), at])
      }
      // 只留最强的 GRAPH_EDGE_MAX 条：弱的先滚，避免一对高频条目把图连成团
      if (src.edges.length > GRAPH_EDGE_MAX) {
        src.edges.sort((x, y) => (Number(y[1]) - Number(x[1])) || (Number(y[2]) - Number(x[2])))
        src.edges.length = GRAPH_EDGE_MAX
      }
    }
    bump(a, b)
    bump(b, a)
    this.linksAdded += 1
  }

  /**
   * 图扩散：以本轮候选里最强的几条为种子，沿边扩最多两跳，每跳 ×0.6。
   *
   * 只在**本轮候选池**里扩散——池外的条目这轮本来就没被关键词命中，
   * 硬拉进来等于让一条老记忆靠连边越权插队（那是"复读"而不是"联想"）。
   * 同一个目标被多个种子够到，取最大值而不是累加：累加会让枢纽节点通吃。
   *
   * @param {Array<{e: object, rrf: number}>} pool 已算好 rrf 的候选
   * @returns {Map<string, number>} 条目 id → 该加在 rrf 上的增量
   */
  graphBoost(pool, { hops = GRAPH_HOPS, decay = GRAPH_DECAY, seeds = GRAPH_SEED_LIMIT } = {}) {
    const byId = new Map()
    for (const x of pool) if (x?.e?.id) byId.set(x.e.id, x)
    if (byId.size < 2) return new Map()
    const ranked = [...pool].sort((a, b) => b.rrf - a.rrf)
    const boost = new Map()
    for (const seed of ranked.slice(0, seeds)) {
      if (!seed?.e?.id) continue
      let frontier = [{ id: seed.e.id, score: seed.rrf, depth: 0 }]
      const seen = new Set([seed.e.id])
      while (frontier.length) {
        const next = []
        for (const node of frontier) {
          const cur = byId.get(node.id)
          if (!cur || node.depth >= hops) continue
          const edges = Array.isArray(cur.e?.edges) ? cur.e.edges : []
          for (const edge of edges) {
            if (!Array.isArray(edge) || !edge[0]) continue
            if (!byId.has(edge[0])) continue
            const w = Math.max(0, Math.min(1, Number(edge[1]) || 0))
            const score = node.score * decay * w
            if (score <= 0) continue
            if (score > (boost.get(edge[0]) || 0)) boost.set(edge[0], score)
            if (!seen.has(edge[0])) {
              seen.add(edge[0])
              next.push({ id: edge[0], score, depth: node.depth + 1 })
            }
          }
        }
        frontier = next
      }
    }
    // 种子也照吃不误：边本来就是双向的，"它俩总一起被想起"对两边都算数；
    // 唯一要防的是自己给自己加分，而 addEdge 已经拒绝自环。
    return boost
  }

  /**
   * 边老化（识海图的养护端）：指向已删条目的边、晾了 90 天没再被一起想起的边、
   * 以及权重掉到 0.05 以下的边，一并清掉。
   *
   * 90 天用的是**日历天**而不是活跃天：边是"两条记忆的关联"，人不聊天它也在变淡；
   * 而条目的衰减用活跃天（不聊就不掉），两者口径不同是有意的。
   *
   * @returns {number} 清掉的边数
   */
  pruneEdges({ idleDays = GRAPH_EDGE_IDLE_DAYS } = {}) {
    if (!this.graphEnabled) return 0
    const ids = new Set(this.entries.map((e) => e.id))
    let dropped = 0
    for (const e of this.entries) {
      if (!Array.isArray(e.edges) || !e.edges.length) continue
      const keep = []
      for (const edge of e.edges) {
        if (!Array.isArray(edge)) {
          dropped += 1
          continue
        }
        const [id, w, at] = edge
        if (!ids.has(id) || id === e.id) {
          dropped += 1
          continue
        }
        const ageDays = (Date.now() - (Number(at) || 0)) / 86400000
        if ((Number(w) || 0) < GRAPH_EDGE_MIN || ageDays > idleDays) {
          dropped += 1
          continue
        }
        keep.push([id, Number(w), Number(at) || 0])
      }
      e.edges = keep
    }
    if (dropped) this.logger('debug', `识海图老化：清掉 ${dropped} 条边`)
    return dropped
  }

  /**
   * tag 抽象（2026-10-28）：同一个 tag 下攒够 ABSTRACT_MIN_COUNT 条、
   * 且至少有一条被真问过（hits>0），压成一条「关于X：…」的规律节点。
   *
   * 为什么要求 hits>0：没人问过的三件事未必构成"规律"，
   * 很可能只是同一批灌进来的记录；被问起过才说明它俩在对话里真的在场。
   *
   * 幂等：已经抽象过的 tag 只更新正文与权重，不再长第二条；
   * 同一个 tag 的原条目只降级一次（`abstractedBy` 记着是谁抽的）。
   *
   * @returns {number} 本次新建的抽象节点数
   */
  abstractTags() {
    if (!this.abstractTagsEnabled) return 0
    const groups = new Map()
    for (const e of this.entries) {
      if (!e || e.abstractOf) continue
      const tags = Array.isArray(e.tags) ? e.tags : []
      for (const raw of tags) {
        const tag = String(raw || '').trim()
        if (!tag) continue
        const list = groups.get(tag) || []
        list.push(e)
        groups.set(tag, list)
      }
    }
    let created = 0
    for (const [tag, list] of groups) {
      if (created >= ABSTRACT_MAX_NEW) break
      if (list.length < ABSTRACT_MIN_COUNT) continue
      if (!list.some((e) => (Number(e.hits) || 0) > 0)) continue
      const text = this.buildAbstractText(tag, list)
      if (!text) continue
      const maxWeight = clampWeight(Math.max(...list.map((e) => clampWeight(e.weight))))
      const existing = this.entries.find((e) => e.abstractOf === tag)
      if (existing) {
        existing.text = text
        existing.at = Date.now()
        existing.weight = Math.max(clampWeight(existing.weight), maxWeight)
        this.abstracted += 1
        continue
      }
      this.entries.push({
        // a 前缀：便于一眼认出「这是抽象出来的，不是谁原话」
        id: `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        kind: 'fact',
        who: '',
        qq: '',
        text,
        weight: maxWeight,
        source: 'system',
        level: 0,
        hits: 0,
        lastActiveDay: this.activeDays,
        at: Date.now(),
        tags: [tag, 'abstract'],
        abstractOf: tag,
      })
      for (const e of list) {
        if (e.abstractedBy === tag) continue
        e.abstractedBy = tag
        e.level = Math.max(0, Math.min(3, (Number(e.level) || 0) + 1))
      }
      created += 1
      this.abstracted += 1
      this.logger('debug', `tag 抽象：${tag} ← ${list.length} 条 → ${text.slice(0, 24)}`)
    }
    return created
  }

  /** 把同 tag 的几条拼成一段「关于X：…」（正文封顶 ABSTRACT_TEXT_MAX 字） */
  buildAbstractText(tag, list) {
    const sorted = [...list].sort(
      (a, b) => (Number(b.hits) || 0) - (Number(a.hits) || 0) || clampWeight(b.weight) - clampWeight(a.weight),
    )
    const parts = []
    const seen = new Set()
    for (const e of sorted) {
      const t = String(e.text || '').trim()
      if (!t || seen.has(t)) continue
      seen.add(t)
      parts.push(t.length > 40 ? `${t.slice(0, 40)}…` : t)
      if (parts.length >= 4) break
    }
    if (!parts.length) return ''
    const text = `关于${tag}：${parts.join('；')}`
    return text.length > ABSTRACT_TEXT_MAX ? `${text.slice(0, ABSTRACT_TEXT_MAX)}…` : text
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
     * 识海图的养护放在最前：边老化、tag 抽象都是"没满也要做"的事
     * （与下面 archiveStale 同理——烂掉/该合并的东西不该一直占着窗口）。
     */
    if (this.graphEnabled) this.pruneEdges()
    if (this.abstractTagsEnabled) this.abstractTags()
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
  recall({
    who = '',
    qq = '',
    query = '',
    queryVector = null,
    mention = [],
    limit = MEMORY_WINDOW.contextLimit,
    charBudget = MEMORY_WINDOW.charBudget,
  } = {}) {
    this.touchActivity()
    const q = String(query || '').toLowerCase().trim()
    /*
     * 没传向量、但外面接好了嵌入器（本地 sidecar）时，这里自己补一次。
     * 放在最前面：候选生成阶段就要用向量，晚补等于没补（MC06 就是这么丢的）。
     */
    if (!queryVector && this.embedder && q) {
      /*
       * 同一句话一轮里会被问两遍（contextFor 一次、engine-context 的关键词召回再一次），
       * 每条查询多花 100ms 没必要——按文本缓存，最多 128 条，FIFO 淘汰。
       */
      if (!this._vecCache) this._vecCache = new Map()
      if (this._vecCache.has(q)) {
        queryVector = this._vecCache.get(q)
      } else {
        try {
          queryVector = this.embedder(q) || null
          if (queryVector) {
            this._vecCache.set(q, queryVector)
            if (this._vecCache.size > 128) this._vecCache.delete(this._vecCache.keys().next().value)
          }
        } catch (err) {
          queryVector = null
          this.logger?.('warn', `取查询向量失败，退回关键词：${err?.message || err}`)
        }
      }
    }
    const words = tokenize(q)
    const qqStr = normalizeQq(qq)
    const name = String(who || '').trim()
    // 名字切出来的词（「白饭鱼」→ 白饭/饭鱼）：身份命中后这些词不再重复计分，见下面 scored
    const nameWords = new Set(name ? tokenize(name) : [])
    const mentionList = (Array.isArray(mention) ? mention : [mention]).filter(Boolean)
    const mentionNames = mentionList
      .map((x) => (typeof x === 'object' ? x.who || '' : x))
      .map((x) => String(x || '').trim())
      .filter(Boolean)
    const mentionQqs = new Set(
      mentionList
        .map((x) => (typeof x === 'object' ? String(x.qq || '') : ''))
        .filter(Boolean),
    )

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
      /*
       * 群聊点名（2026-11-07 v0.7）：
       * 「白饭鱼今天说了啥」——问的人不是白饭鱼，但话里点了他。
       * 旧逻辑只会把白饭鱼的条目按跨人 0.05 清零，于是群里问谁都问不出别人说过的话
       * （轴 A3 实测 0/48）。这里把「被点名的人」认出来，单独放行。
       */
      /*
       * mention 里既可以放名字，也可以放 { qq }（引擎从 [CQ:at,qq=…] 里解析出来的）。
       * QQ 是硬身份，比名字可靠——群里有同名的人时不会认错。
       */
      const mentioned =
        (Boolean(eQq) && mentionQqs.has(String(eQq))) ||
        (Boolean(e.who) &&
          mentionNames.some((mn) => e.who === mn || e.who.includes(mn) || mn.includes(e.who)))
      const sameName = Boolean(name) && e.who === name && !differentPerson
      const nameContains =
        Boolean(name) &&
        !sameName &&
        !differentPerson &&
        Boolean(e.who) &&
        (e.who.includes(name) || name.includes(e.who))
      return { qqHit, sameName, nameContains, differentPerson, mentioned }
    }

    /*
     * 「取代者」还活着才算降权（2026-11-02 molly-bench 发现 4）。
     * 旧条目被打了 supersededBy 之后，若那条新条目后来被裁剪/归档/迁移掉了，
     * 标记还挂在身上，于是一条本该恢复的记忆被永久打压——取代链断了，降权却还在。
     */
    const liveIds = new Set(this.entries.map((e) => e.id))
    /*
     * 同题合并后的「活跃条目」（2026-11-02 主人 m01658）：被折叠的条目只是打了 mergedInto，
     * 正文留在盘上，但既不参与召回、也不参与 IDF 统计——否则几十条转述会把「八点」这个词
     * 的 df 打满，让真正的关键内容变成「到处都有 = 不值钱」。
     */
    const active = this.entries.filter((e) => !(e.mergedInto && liveIds.has(e.mergedInto)))

    // 词频统计，用来算 IDF
    const df = new Map()
    if (words.length) {
      for (const e of active) {
        const t = e.text.toLowerCase()
        for (const w of words) {
          if (contains(t, w)) df.set(w, (df.get(w) || 0) + 1)
        }
      }
    }
    const N = Math.max(1, active.length)
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

    /*
     * 「取代者」还活着才算降权（2026-11-02 molly-bench 发现 4）。
     * 旧条目被打了 supersededBy 之后，若那条新条目后来被裁剪/归档/迁移掉了，
     * 标记还挂在身上，于是一条本该恢复的记忆被永久打压——取代链断了，降权却还在。
     * （`liveIds` / `active` 已在上面算过，这里不再重复声明。）
     */

    const scored = active.map((e) => {
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
      /*
       * 跨人串味（2026-11-02 molly-bench 发现 3）：
       * recall 原来**只有身份加分、没有身份硬闸**，「明确是别人」的条目照样能挤进这个人的上下文。
       * 小卷里问 <REDACTED>「他不喜欢什么表情包」，陌生人「他喜欢奶龙」那条就躺在旁边，
       * 模型完全可能照着那句答反。这里分两档：
       *   - 正文里压根没提当前这个人 → 关键词路几乎清零，不许占语义名额；
       *   - 正文提到了这个人（关系类记忆，如「茶茶跟他说过…」）→ 两路打半折，仍可被捞。
       */
      const crossPerson = id.differentPerson
      const mentionsTarget = crossPerson && Boolean(name) && String(e.text).includes(name)
      const mentionedPerson = crossPerson && id.mentioned
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
        /*
         * 名字本身不再重复计分（2026-11-02 MH02）：
         * 「白饭鱼说：[引用 @Molly：…八点见…]」这类转述条目正文里带着说话人名字，
         * 于是问「白饭鱼……八点……」时它们靠「白饭/饭鱼」两个字躺赢，
         * 把真正记着事实的那条（正文写「他跟 Molly、晚星斗嘴定下赌约」）挤到第 49 名。
         * 身份分（qqHit +4）已经算过一次「这是本人」，正文里的名字不该再赚一次。
         */
        const identitySelf = id.qqHit || id.sameName
        for (const w of words) {
          if (identitySelf && nameWords.has(w)) continue
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
      // 跨人条目：不许占关键词语义名额（正文里提到了这个人时放行一半，见上面注释）
      if (crossPerson) {
        if (mentionedPerson) {
          // 群聊里被点名的人：不给跨人罚，补一个略高于「熟人级 2 分」的加成
          kw += MENTION_PERSON_KW
        } else if (mentionsTarget) kw *= 0.5
        else {
          kw *= CROSS_PERSON_KW_PENALTY
          kwStrong = false
          strongHit = false
        }
      }
      /*
       * 全群摘要（who 为空的 event）在点名问某人时**不进候选池**（2026-11-02 MH03）。
       * 只降分不够：一条 800 字的周信谁的事都写，问「示例成员F的真名」时它靠「真名」两个字
       * 就能挤进 top——里面那句「熊老板悄悄跟我说了真名」足以让模型拿别人的真名顶上。
       * 泛问（没点名）时它照旧参与，当背景用。
       */
      if (!e.who && e.kind === 'event' && (name || qqStr)) {
        kw *= GROUP_WIDE_EVENT_PENALTY
        kwStrong = false
        strongHit = false
      }
      /*
       * 过期未兑现的计划（2026-11-03，评论区 @shuun）。
       * 「明天八点端锅过来」只是打算，不能当「他端过了」。到点没兑现的降权一半，
       * 但保留可召回——问「他还欠你什么」要答得出来。
       */
      if (TENSE_ON && e.unfulfilled) {
        kw *= UNFULFILLED_PENALTY
      }
      if (wantMeme && e.kind === 'meme') kw += 3 // 问梗时梗优先
      // 越新越值钱，但只值一点点，避免"全是刚说的废话"
      const ageDays = (Date.now() - e.at) / 86400000
      kw += Math.max(0, 2 - ageDays / 30) * 0.3
      // 权重一路用**有效权重**（衰减 + 命中之后的值），让「久不联系」真的变淡
      let w = effectiveWeight(e, this.activeDays)
      if (crossPerson) w *= 0.5 // 别人的事只在真没别的可捞时才轮得到
      const raw = kw + w * 0.15 // 老公式，仅留作对账
      /*
       * 被更正过的条目（supersededBy，2026-10-27 三级去重引入）：
       * 「他喜欢猫」后来被「他其实不喜欢猫」纠正，正文还留着备查，
       * 但不能再跟新结论平起平坐地挤进提示词——否则模型看到两句相反的，
       * 只能靠语气猜哪句算数。这里只降权不删除，两路都降。
       */
      if (e.supersededBy && liveIds.has(e.supersededBy)) {
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
        const fallback = active
          .filter((e) => {
            const id = identity(e)
            return (id.qqHit || id.sameName || id.mentioned || !e.who) && kinds.includes(e.kind)
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
    /*
     * 向量侧的候选补充（2026-11-02，molly-bench MC06 暴露的第二个问题）。
     *
     * 上面那道闸门只看「词」，于是「他住哪个城市？」这种问句永远进不了池子——
     * 记忆里写的是「他在广州」，两个字都对不上，RRF 再怎么排也没用：**候选生成阶段就丢了**。
     * 所以有 queryVector 时，额外按余弦把「这个人自己的」前 VECTOR_CANDIDATES 条拉进池子，
     * 让它们在 RRF 里和关键词候选一起竞争，而不是直接当答案。
     *
     * 只取同一个人的：群聊里问 A 的事，不能因为 B 也聊过相似的句子就把 B 的记忆拉进来。
     * 跨人条目只有在正文里真的点了这个人的名字时才放行（跟 recall 里跨人降权同一套判断）。
     */
    const scoredById = new Map(scored.map((x) => [x.e.id, x]))
    const poolIds = new Set(pool.map((x) => x.e.id))
    const vectorExtras = new Map() // id → 余弦，用于 lastRecall 对账
    if (queryVector && this.vectors && this.vectors.size) {
      const cand = []
      for (const e of active) {
        const v = this.vectors.get(e.id)
        if (!v) continue
        const id = identity(e)
        if ((qqStr || name) && id.differentPerson && !id.mentioned && !(name && String(e.text).includes(name))) continue
        cand.push({ e, s: cosineSimilarity(queryVector, v) || 0 })
      }
      cand.sort((a, b) => b.s - a.s)
      for (const { e, s } of cand.slice(0, VECTOR_CANDIDATES)) {
        if (poolIds.has(e.id)) {
          vectorExtras.set(e.id, s)
          continue
        }
        const base = scoredById.get(e.id)
        if (!base) continue
        base.viaVector = true
        poolIds.add(e.id)
        vectorExtras.set(e.id, s)
        pool.push(base)
      }
      this.logger?.('debug', `向量补充候选 ${vectorExtras.size} 条（池子 ${pool.length}）`)
    }

    const byKeyword = [...pool].sort(compareKeywordArm)
    const byWeight = [...pool].sort(compareWeightArm)

    /*
     * 第二路的三种形态（2026-11-02，molly-bench 发现 MC06「他人在广州」永远召不回）：
     *
     *   1. 有 queryVector + 条目向量（this.vectors）→ 用余弦相似度排序；
     *      没向量覆盖的条目按原权重次序接在后面，保证「路」永远覆盖整个池子。
     *   2. 没有 queryVector → 退回老办法：用「有效权重」当第二路。
     *
     * 为什么不把余弦分直接加到 kw 上：kw 是词频尺度（0~十几），余弦是 0~1，
     * 相加等于让词频说话、余弦只当噪声。RRF 只吃名次，天然免疫尺度不一致。
     */
    let bySecond = byWeight
    let secondArm = 'weight'
    const vecScores = new Map()
    if (queryVector && this.vectors && this.vectors.size) {
      const withVec = []
      const withoutVec = []
      for (const x of pool) {
        const v = this.vectors.get(x.e.id)
        const s = v ? cosineSimilarity(queryVector, v) : null
        if (s === null) {
          withoutVec.push(x)
        } else {
          vecScores.set(x.e.id, s)
          withVec.push({ x, s })
        }
      }
      if (withVec.length) {
        withVec.sort((a, b) => b.s - a.s || compareRecency(a.x, b.x))
        bySecond = [...withVec.map((v) => v.x), ...withoutVec.sort(compareWeightArm)]
        secondArm = 'vector'
      }
    }

    const rankKeyword = new Map()
    const rankWeight = new Map()
    const rankSecond = new Map()
    byKeyword.forEach((x, i) => rankKeyword.set(x, i))
    byWeight.forEach((x, i) => rankWeight.set(x, i))
    bySecond.forEach((x, i) => rankSecond.set(x, i))
    for (const x of pool) {
      const rk = rankKeyword.get(x)
      const rw = rankWeight.get(x)
      const rs = rankSecond.get(x)
      x.rank = { keyword: rk + 1, weight: rw + 1, second: rs + 1 }
      x.rrf = RRF_KEYWORD_WEIGHT / (rk + RRF_K) + RRF_WEIGHT_ARM_WEIGHT / (rs + RRF_K)
    }
    pool.sort((a, b) => b.rrf - a.rrf || compareRecency(a, b))
    /*
     * 识海图扩散（2026-10-28，默认关）：以头部几条为种子沿边扩两跳，
     * 命中的条目在 rrf 上加一个小数增量再重排——只微调名次，不推翻 RRF，
     * 这样「关键词一个都没对上」的条目仍然进不了池子（池子已经定过了）。
     */
    if (this.graphEnabled && pool.length > 1) {
      const boost = this.graphBoost(pool)
      if (boost.size) {
        for (const x of pool) {
          const b = boost.get(x.e.id)
          if (!b) continue
          x.graphBoost = b
          x.rrf += b
        }
        pool.sort((a, b) => b.rrf - a.rrf || compareRecency(a, b))
      }
    }
    /*
     * 交叉编码器重排（2026-11-03，评论区 @IX维亚济马：「Qwen embedding 作为召回方案，
     * 可以配合 reranker 构成检索基线」——他说得对，我们原来只有粗排）。
     *
     * 沙箱实测（4578 条语料 / 14 考点 × 4 档，脚本 `${MOLLY_ROOT}\out\_xhh3\tune-blend.py`）：
     *   纯粗排            可答 48/56，金条进前 5 38/56
     *   纯重排            可答 48/56，金条进前 5 42/56（MC06「他住哪」23→4、MH01 16→1，
     *                     但 MC08「只会三首歌」4→13 掉出窗口——重排会把同义但更泛的条目顶上来）
     *   **RRF 融合 0.8/0.2** 可答 52/56，金条进前 5 40/56  ← 两个指标都涨，取这组
     *
     * 只重排前 RERANK_POOL 条：全池 200 条要 3.5 秒，40 条约 0.7 秒，群聊等不起。
     * 任何异常（sidecar 没起、超时、长度对不上）都**静默退回粗排**，绝不让聊天卡住。
     */
    if (RERANK_ON && this.reranker && pool.length > 1) {
      const head = pool.slice(0, RERANK_POOL)
      // 同一轮里 contextFor 与 engine-context 会用同一句话召回两次，重排结果按「问题+头部 id」缓存一次
      const sig = `${q}|${head.map((x) => x.e.id).join(',')}`
      if (!this._rerankCache) this._rerankCache = new Map()
      try {
        let scores = this._rerankCache.get(sig)
        if (!scores) {
          scores = this.reranker(
            q,
            head.map((x) => String(x.e.text || '').slice(0, 300)),
          )
          if (Array.isArray(scores) && scores.length === head.length) {
            this._rerankCache.set(sig, scores)
            if (this._rerankCache.size > 32) this._rerankCache.delete(this._rerankCache.keys().next().value)
          }
        }
        if (Array.isArray(scores) && scores.length === head.length && scores.every(Number.isFinite)) {
          const order = head.map((_, i) => i).sort((a, b) => scores[b] - scores[a])
          const rankOf = new Map()
          order.forEach((i, pos) => rankOf.set(i, pos + 1))
          const blended = head.map((x, i) => ({
            x,
            s:
              RERANK_W * (1 / (RERANK_K + rankOf.get(i))) +
              (1 - RERANK_W) * (1 / (RERANK_K + i + 1)),
          }))
          blended.sort((a, b) => b.s - a.s)
          pool = [...blended.map((b) => b.x), ...pool.slice(head.length)]
          this.lastRecallRerank = true
        }
      } catch (err) {
        this.lastRecallRerank = false
        this.logger?.('warn', `重排失败，退回粗排：${err?.message || err}`)
      }
    }
    this.lastRecall = {
      query: q,
      candidates: pool.length,
      words,
      secondArm,
      at: Date.now(),
      top: pool.slice(0, this.recallTopLimit || 5).map((x) => ({
        id: x.e.id,
        kind: x.e.kind,
        rrf: Number(x.rrf.toFixed(6)),
        rankKeyword: x.rank.keyword,
        rankWeight: x.rank.second,
        kw: Number(x.kw.toFixed(3)),
        w: Number(x.w.toFixed(2)),
        raw: Number(x.raw.toFixed(3)),
        // 向量第二路给了多少余弦（undefined = 这一轮没用向量）
        cos: vecScores.has(x.e.id) ? Number(vecScores.get(x.e.id).toFixed(3)) : undefined,
        // 图扩散加了多少（0 = 没用上图；两开关都关时这里恒为 0）
        graph: Number((x.graphBoost || 0).toFixed(6)),
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
    const base = pool.slice(0, limit).map((x) => x.e)
    const coreSlots = this.pickCoreProfile({
      who,
      qq,
      limit: CORE_SLOTS,
      exclude: new Set(base.map((e) => e.id)),
    })
    /*
     * 保底位占的是「额外」预算，不挤占原有 1200 字窗口。
     * v1.1 里它直接顶掉一条普通记忆，结果是身份题涨了、偏好/约定题掉得更狠
     * （偏好 −7、带条件偏好 −7、相似事件 −8）—— 等于拿别人的位置换档案的位置。
     * 档案只有几十字，单独给它算长度、预算按需加长，两条路就都不吃亏。
     */
    const coreCost = coreSlots.reduce((n, e) => n + String(e.text || '').length, 0)
    const picked = this.applyCharBudget(coreSlots.concat(base), charBudget + coreCost)
    this.markHits(picked)
    return picked
  }

  /**
   * 挑「核心档案」：关于本人的、稳定的身份类条目（名字/年龄/职业/所在地）。
   * 与打分无关，纯按 weight → 新旧排序，结果稳定、不会每轮抖动。
   */
  pickCoreProfile({ who = '', qq = '', limit = CORE_SLOTS, exclude = new Set() } = {}) {
    const n = Math.max(0, Math.min(4, Number(limit) || 0))
    if (!n) return []
    if (!who && !qq) return []
    const target = { name: String(who || ''), qq: String(qq || ''), who: String(who || '') }
    const alive = new Set(this.entries.filter((e) => e && e.id).map((e) => e.id))
    return this.entries
      .filter((e) => {
        if (!e || !e.text) return false
        if (exclude.has(e.id)) return false
        if (!CORE_KINDS.has(e.kind)) return false
        if (Number(e.weight) < CORE_MIN_WEIGHT) return false
        if (!CORE_TEXT_RE.test(String(e.text || ''))) return false
        // 兜底写进来的原话（「他说过：…」）是碎句，不能当档案
        if (/^他说过[:：]/.test(String(e.text || ''))) return false
        if (e.supersededBy && alive.has(e.supersededBy)) return false
        const id = sameIdentity(e, target)
        return id === 'qq' || id === 'name' || String(e.who || '') === String(who || '')
      })
      .sort((a, b) => coreRank(b) - coreRank(a) || Number(b.weight) - Number(a.weight) || Number(a.at || 0) - Number(b.at || 0))
      .slice(0, n)
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
    /*
     * 记账按「实际会渲染的字数」算（2026-11-02 molly-bench 发现）：contextFor 会把单条截到
     * `MEMORY_WINDOW.entryChars`，但这里原来按原长扣预算——一条 1000 字的流水账会吃掉
     * 四条配额，而它在上下文里只占 240 字，剩下的钱全扔了，真答案被挤出去。
     * 顺手把 `break` 改成 `continue`：超长条目不该挡住排在它后面的短条目。
     */
    const perEntryCap = MEMORY_WINDOW.entryChars
    for (const e of list) {
      const len = String(e?.text ?? '').length
      const cost = Math.min(len, perEntryCap)
      if (out.length && used + cost > cap) continue
      out.push(e)
      used += cost
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
  /**
   * 库里出现过的说话人（2026-11-07 v0.7，给"群聊点名"用）。
   *
   * 引擎拿不到全群成员名单，但记忆里有：扫一遍活条目，按 qq 去重，按条数排。
   * 只要名字，不碰正文，也不算贵（4578 条实测 <5ms），而且可以按需缓存。
   */
  knownSpeakers({ limit = 200 } = {}) {
    const m = new Map()
    for (const e of this.entries || []) {
      const qq = String(e.qq || '')
      const who = String(e.who || '').trim()
      if (!qq || !who) continue
      if (e.supersededBy) continue
      const k = qq + '|' + who
      m.set(k, (m.get(k) || 0) + 1)
    }
    return [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([k]) => ({ qq: k.split('|')[0], who: k.split('|')[1] }))
  }

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
 * 余弦相似度（2026-11-02，向量第二路）。
 *
 * 前提：两侧都已 L2 归一化（BGE 编码后立刻 normalize），所以余弦 = 点积。
 * 不做归一化兜底是故意的——每轮对 4000 多条算一次开方，纯属浪费；
 * 若哪天真传了未归一化的向量，分数会 >1 但**名次**仍然对（同乘一个常数不影响排序）。
 */
function cosineSimilarity(a, b) {
  if (!a || !b || !a.length || !b.length) return null
  const n = Math.min(a.length, b.length)
  let s = 0
  for (let i = 0; i < n; i += 1) s += a[i] * b[i]
  return s
}

/**
 * 相对日期归一（2026-11-02 molly-bench 加难卷 MH01）。
 *
 * 记忆写的是「打算明天再排查」，三个月后被问「那天是哪天」就没人答得出来——
 * 库里有 240 条（5.6%）正文只有相对词，没有一个日期锚。
 * 这里按条目自己的写入时间（at）折算成绝对日期，追加在括号里：
 *   「打算明天再排查」→「打算明天（10月21日）再排查」
 * 已经带括号日期的不再加工，保证反复调用是幂等的。
 *
 * @param {string} text 正文
 * @param {number} at 条目写入时间（ms）
 * @returns {string}
 */
const RELATIVE_DAY_OFFSET = { 今天: 0, 今日: 0, 明天: 1, 明日: 1, 昨天: -1, 昨日: -1, 前天: -2, 后天: 2 }
const WEEKDAY_INDEX = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 7, 天: 7 }

function fmtMonthDay(ms) {
  const d = new Date(ms)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

/**
 * v0.5：日期后面带上周几。
 *
 * 为什么：官方 714 题里「时间题 15/48、相对日期 15/44」，失败样例多数不是
 * 「不知道哪天」，而是问「那天是周几 / 隔了几天」——只给日期，模型得自己
 * 心算，算错就成「编造」；周几写进正文，它是**看得见**的，不用推。
 */
function fmtDateWeekday(ms) {
  const d = new Date(ms)
  const wd = '日一二三四五六'[d.getDay()]
  return `${d.getMonth() + 1}月${d.getDate()}日，周${wd}`
}

export function normalizeRelativeDates(text, at) {
  let out = String(text || '')
  if (!out) return out
  /* 表情包的名字里常带「周五」这类词（学到了表情包：蓝发少女_打鼓_庆祝周五），那是标签不是日期 */
  if (/^学到了表情包/.test(out)) return out
  const base = Number(at) || Date.now()
  /*
   * 凌晨（0–5 点）说的「明天」，口语里指的是**天亮后的这一天**，不是日历意义上的明天。
   * 例：2026-10-21 00:49「打算明天再排查」= 当天白天，不是 10-22。
   * 不加这条，时间锚会整体偏一天——比没有日期更糟，因为它看起来是对的。
   */
  const hour = new Date(base).getHours()
  /*
   * 幂等要**逐处判断**，不能整句跳过：一条记忆里常同时有
   * 「今天（10月24日）…明天再说」，整句跳过会让后半句永远补不上，
   * 而且每次装载都重新判断一次（实测 7 条被反复重写）。
   */
  const alreadyDated = (rest) => /^（\d{1,2}月\d{1,2}日/.test(rest)
  /*
   * 2026-11-07：括号**里面**的日期词不算正文（「（9月18日，周五）」里的「周五」），
   * 否则每装载一次就再补一层括号，幂等直接崩掉。
   */
  const insideParen = (full, offset) => {
    const open = full.lastIndexOf('（', offset - 1)
    const close = full.lastIndexOf('）', offset - 1)
    return open > close
  }
  /*
   * 历史遗留：早期版本的幂等判断认不出「（10月19日那一周）」，每次装载都再补一遍，
   * 生产里有 7 条被补成了「（10月19日那一周）」×5。这里先把相邻重复的括号合并掉，
   * 再往下走——归一函数自己修自己，不需要额外的迁移脚本。
   */
  out = out.replace(/(（\d{1,2}月\d{1,2}日[^）]{0,8}）)\1+/g, '$1')
  out = out.replace(/(今天|今日|明天|明日|昨天|昨日|前天|后天)/g, (m, _g, offset, full) => {
    if (alreadyDated(full.slice(offset + m.length))) return m
    if (insideParen(full, offset)) return m
    let offsetDays = RELATIVE_DAY_OFFSET[m]
    if ((m === '明天' || m === '明日') && hour < 5) offsetDays = 0
    if ((m === '昨天' || m === '昨日') && hour < 5) offsetDays = -2
    return `${m}（${fmtDateWeekday(base + offsetDays * 86400000)}）`
  })
  /*
   * 周几换算（2026-11-07 重写）。旧版三个病：裸「周三」不处理、「上周五」在周日被算成
   * 9 天前、「下周一」在周日被算成 7 天后。现在按真人怎么说话来：
   *   上周X = 本周那个只要还没过就用它，否则减 7 天
   *   下周X = 本周那个只要还没到就用它，否则加 7 天
   *   裸周X = 本周那个 ±7 天三选一，取离今天最近的
   *   这周/本周X = 本周那个
   * 周日记成 7（ISO 口径），一周从周一起算。
   */
  const DAY = 86400000
  const dayStart = (ms) => {
    const d = new Date(ms)
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  }
  out = out.replace(/(?:(上|下|本|这)周([一二三四五六日天])?|周([一二三四五六日天]))/g, (m, dir, wdWithDir, wdAlone, offset, full) => {
    if (alreadyDated(full.slice(offset + m.length))) return m
    if (insideParen(full, offset)) return m
    /*
     * 防误伤（2026-11-07）：这些都不是"某一天"，写上去反而污染记忆。
     *   「一周一次」「两周三次」——前面是数量词；
     *   「每周一」「第一周」——表示循环或序数，折算不出单日；
     *   「这周边」「周末」这类——后面还接着别的字，就不是整周/周几。
     */
    const prev = full[offset - 1] || ''
    const next = full[offset + m.length] || ''
    if (/[每第半一两二三四五六七八九十几多零0-9]/.test(prev)) return m
    if (/[次遍回天个周整]/.test(next)) return m
    const dir2 = dir || ''
    const wd = wdWithDir || wdAlone || ''
    const today = dayStart(base)
    const weekday = new Date(base).getDay() === 0 ? 7 : new Date(base).getDay()
    const monday = today - (weekday - 1) * DAY
    const shift = dir2 === '上' ? -1 : dir2 === '下' ? 1 : 0
    if (!wd) {
      // 「上周/下周/这周」不带周几：后面必须紧跟标点/空白/句尾，否则不算整周
      if (!/^[\s，。！？、；：）】」』…—~～\/|]/.test(next) && next !== '') return m
      return `${m}（${fmtMonthDay(monday + shift * 7 * DAY)}那一周）`
    }
    const target = WEEKDAY_INDEX[wd]
    const thisWeek = monday + (target - 1) * DAY
    let stamp
    if (dir2 === '上') stamp = thisWeek < today ? thisWeek : thisWeek - 7 * DAY
    else if (dir2 === '下') stamp = thisWeek > today ? thisWeek : thisWeek + 7 * DAY
    else if (dir2 === '本' || dir2 === '这') stamp = thisWeek
    else {
      // 裸周几：三个候选里取最近的（周期 7，不会打平）
      const cands = [thisWeek - 7 * DAY, thisWeek, thisWeek + 7 * DAY]
      let best = cands[0]
      for (const c of cands) if (Math.abs(c - today) < Math.abs(best - today)) best = c
      stamp = best
    }
    return `${m}（${fmtDateWeekday(stamp)}）`
  })

  return out
}

/**
 * 判断一句话是「计划」还是「已经发生」，并给计划算一个到期时间。
 *
 * 场景来源：评论区 @shuun（2026-11-03）——「只说『明天』不代表这件事已经发生」。
 * 例：「他打算明天再排查」是计划，「他昨天排查了」是事实；计划没兑现要给个说法，
 * 否则库里那条永远算"有效"。
 *
 * 判定只靠词面信号，不做语义推断（没有模型调用，写路径上不能加延迟）：
 *   - 许诺类（promise）一律算计划；
 *   - 出现「明天/明早/后天/下周/等会」这类未来词 → 计划；
 *   - 出现「打算/准备/约好/答应」且没有过去标记 → 计划；
 *   - 出现「已经/刚刚/昨天/当时/后来」这类过去词 → 已发生；
 *   - 都没提 → 不表态（''），保持旧行为。
 */
export function detectTense(text, kind, at = Date.now()) {
  const s = String(text || '')
  if (!s) return { tense: '', dueAt: 0 }
  const base = Number(at) || Date.now()
  const hour = new Date(base).getHours()
  const k = normalizeKind(kind)
  const future = /(明天|明日|明早|明晚|后天|大后天|下周|下个|下次|等会|会儿|待会|回头)/.test(s)
  /*
   * 只用**明确的计划动词**，不放裸「要」「得」「会」：
   * 实测放开裸「要」会把「他要对我家鱼崽作甚」这种问句也标成计划（1660/4577），
   * 标签一多就没人信；宁可漏标，不要给每条记忆瞎贴。
   */
  const planVerb = /(打算|准备|计划|约好|约定|说好|定下|答应|想着|商量)/.test(s)
  const past = /(已经|曾经|刚刚|刚才|昨天|昨日|前天|上周|上次|当时|后来|结果|了|过)/.test(s)
  if (k === 'promise') return { tense: 'plan', dueAt: dueAtFrom(s, base, hour) }
  if (future) return { tense: 'plan', dueAt: dueAtFrom(s, base, hour) }
  if (planVerb && !past) return { tense: 'plan', dueAt: dueAtFrom(s, base, hour) }
  if (past) return { tense: 'past', dueAt: 0 }
  return { tense: '', dueAt: 0 }
}

/**
 * 从正文里取第一个未来时间词，算成「那天结束」的时间戳。
 * 凌晨 0–5 点的「明天」按天亮后当天算，跟 normalizeRelativeDates 保持同一口径。
 */
function dueAtFrom(s, base, hour) {
  const m = /(明天|明日|明早|明晚|后天|大后天|下周|下个|等会|待会|会儿)/.exec(String(s || ''))
  if (!m) return 0
  let days = 0
  if (m[1] === '明天' || m[1] === '明日' || m[1] === '明早' || m[1] === '明晚') days = hour < 5 ? 0 : 1
  else if (m[1] === '后天') days = 2
  else if (m[1] === '大后天') days = 3
  else if (m[1] === '下周' || m[1] === '下个') days = 7
  const due = new Date(base + days * 86400000)
  due.setHours(23, 59, 0, 0)
  return due.getTime()
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
  for (const chunk of q.toLowerCase().split(/[^\p{Script=Han}a-z0-9]+/u)) {
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
 * 「明确是别人」的条目在关键词路上的系数（2026-11-02 molly-bench 发现 3）。
 * 不给硬闸是因为群聊里存在关系类记忆（正文会提到当前这个人），那种靠 0.5 的半折放行；
 * 剩下正文里根本没提这个人的，压到 0.05 ≈ 不许占语义名额。
 */
const CROSS_PERSON_KW_PENALTY = 0.05
/* 群聊里被点名的人（v0.7）：不加跨人罚，补一个略高于「熟人级 2 分」的加成 */
const MENTION_PERSON_KW = 2.5
/*
 * 同题合并（2026-11-02 主人 m01658：「研究写入侧的『同题合并』」）。
 *
 * 实测动机：MH02（「白饭鱼最后把八点见面地点定在哪」）在 d15 掉出窗口，
 * 根因不是遗忘，是**拥挤**——单是「白饭鱼 + 含八点」就有 210 条，全库含「八点」481 条。
 * 10-28 晚上那一桩「明早八点见真章」被逐句抽成了几十条记录，谁问都只能捞到最新那几条。
 *
 * 阈值来自沙箱 4546 条语料的实测（`${MOLLY_ROOT}\out\_xhh2\p-dup3.mjs`）：
 *   包含度 ≥ 0.80 → 3377 对；≥ 0.85 → 935 对；两档的金条（10 个考点的锚条目）**零牵连**。
 * 取 0.85 是保守值：宁可少合，不能把「八点算账」和「八点端锅」合成一条把细节吞掉。
 *
 * 表情包和称谓不参与：表情包名字差一个字就是另一张图（`气鼓鼓_叉` vs `暴怒_举起电击枪`，
 * 包含度 0.80 但它们不是同一件事）；称谓本来就是一人一条，合并没有收益。
 */
const TOPIC_MERGE_SIMILARITY = 0.95
const TOPIC_MERGE_SHARED = 5
const TOPIC_MERGE_WINDOW_MS = 1 * 86400000
const TOPIC_MERGE_SKIP_KINDS = new Set(['meme', 'address'])
/** 同题合并时给老条目加的那点权重（同一件事被反复提起 ≈ 更重要，但不该更新鲜） */
const TOPIC_MERGE_WEIGHT_GAIN = 0.2
/**
 * 同题合并的总开关，默认关。
 * 打开才改变写入行为（`MOLLY_TOPIC_MERGE=1`）；关着时 findSameTopic/mergeSameTopics 仍可手工调用做诊断。
 */
const TOPIC_MERGE_ON = process.env.MOLLY_TOPIC_MERGE === '1'

/* v1.0 状态翻新：未完成 -> 已完成 的词面标记 */
const PENDING_OPEN_RE = /(还没|尚未|还没有|仍在|还在等|在等|没定|未定|待定)/
const PENDING_DONE_RE = /(已经|已发|已到|发来了|发过来|改到|改成|换成|定下来|定了|确认了|完成了|到货|做好了)/
/*
 * 全局事件（周信一类 who 为空的 event）在「点名问某人」时的折扣（2026-11-02 MH03）。
 * 一条 800 字的周信谁的事都写，问「示例成员F的真名叫什么」时它排第三，
 * 里面那句「熊老板悄悄跟我说了真名」就足以让模型拿别人的真名顶上。
 * 周信是「全群摘要」，可以在泛问时当背景，但不该当某个人的主证据。
 */
const GROUP_WIDE_EVENT_PENALTY = 0.35
/*
 * 计划与已发生要分开（2026-11-03，评论区 @shuun 指出）。
 *
 * 他原话：「只说『明天』不代表这件事已经发生，结果你就把它记录到明天的事项里，
 * 感觉这是一个明显的错误。」——对。我们上一轮只把「明天」换成了「明天（10月21日）」，
 * 却没标这句是**打算**还是**已经发生**。于是「他打算明天排查」和「他昨天排查了」
 * 在库里长得一样；计划没兑现（八点没去成）也永远不会被证伪。
 *
 * 现在入库时打 `tense: 'plan' | 'past'`，计划条目再记 `dueAt`；过了到期时间
 * （`PLAN_GRACE_MS`）还没被兑现标记的，打 `unfulfilled` 并降权——**不删**：
 * 问「他还欠你什么」要能问到，问「他今早做了什么」不该由它来答。
 */
const UNFULFILLED_PENALTY = 0.5
/** 计划到期后给多久的宽限（半天，够她把「去过了」这类后续记下来） */
const PLAN_GRACE_MS = 12 * 3600 * 1000
/** 开关：`MOLLY_TENSE=0` 可整条关掉（回滚用） */
const TENSE_ON = process.env.MOLLY_TENSE !== '0'
/*
 * 交叉编码器重排（2026-11-03，评论区 @IX维亚济马 指出我们没有 rerank）。
 * 参数来自沙箱实测：只重排前 40 条（全池 200 条要 3.5s，40 条 0.7s），
 * 与粗排做 RRF 融合，重排占 0.8——纯重排会把 MC08 那种「同义更泛」的条目顶上来，融合能压住。
 */
const RERANK_POOL = 40
const RERANK_W = 0.8
const RERANK_K = 60
/** `MOLLY_RERANK=0` 关掉重排（sidecar 没起时也会自动退回粗排，这条是给回滚留的） */
const RERANK_ON = process.env.MOLLY_RERANK !== '0'

/**
 * 向量补充候选的条数（2026-11-02，molly-bench MC06）。
 *
 * 为什么需要它：关键词闸门是「候选生成」这一层的硬闸，问句和记忆正文一个词都不重合时
 * （「他住哪个城市？」vs「他在广州」），条目根本进不了池子，后面的 RRF 再准也无从下手。
 * 12 = MEMORY_WINDOW.queryLimit：和关键词臂的候选预算对齐，两路贡献相当，
 * 不至于让向量把池子撑成「谁都能进来」。
 */
const VECTOR_CANDIDATES = 12

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
 * 识海图（L1 的 edges）四个旋钮（2026-10-28）。
 *
 * 来源是小黑盒那篇「四层记忆框架」里的做法：沿边扩散两跳、每跳 ×0.6；
 * 我们没有向量，所以边只存在**同一次召回同时命中**的条目之间
 * （"这两条总是一起被想起来"本身就是相关性证据）。
 *
 * 边权 0..1：每连一次 +0.25，首次 0.6；饱和后不再涨（防止一对高频条目
 * 把整张图拉成一条直线）。单节点最多存 8 条边，超了先砍最弱的。
 */
export const GRAPH_DECAY = 0.6
export const GRAPH_HOPS = 2
export const GRAPH_EDGE_MAX = 8
export const GRAPH_EDGE_GAIN = 0.25
export const GRAPH_EDGE_MIN = 0.05
export const GRAPH_EDGE_IDLE_DAYS = 90
export const GRAPH_SEED_LIMIT = 8

/**
 * tag 抽象（2026-10-28）：同一个 tag 下攒够 3 条、且至少有一条被人问起过，
 * 就把它们压成一条「关于X：…」的规律节点。原条目**不删**，只把 level +1
 * （正文留着备查），与周摘要「压成摘要但不删原句」的口径一致。
 */
export const ABSTRACT_MIN_COUNT = 3
export const ABSTRACT_MAX_NEW = 5
export const ABSTRACT_TEXT_MAX = 200

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
 * 否定词是不是**紧贴着**这个词出现的（0~3 字之内）。
 *
 * 2026-11-02 改造（molly-bench 发现 4）：原来 hasNegation 扫全文，
 * 于是任何一条长叙述里只要出现一个「不/别/没」，整条就被算成"否定句"，
 * 再碰上另一条同样长的叙述共享两个二字词，就被判成"改口"。
 * 真实案例：白饭鱼「猫叫锅底，脸圆、爱打哈欠、睡觉爱贴着人」被
 * 「他深夜困得不行，说自己跟图里打哈欠的猫一个样…睡了睡了」取代——
 * 两条都在讲猫，可一个说名字，一个说困，八竿子打不着，却永久降权。
 */
function negatedNear(text, keyword) {
  const t = String(text || '')
  const k = String(keyword || '')
  if (!t || !k) return false
  /*
   * 固定搭配里的「无/没」不是否定：面无表情、无语、没毛病、没什么、不得了。
   * 不加这层，「面无表情」会把「表情」判成被否定，两张表情包描述就被当成互相改口
   * （2026-11-02 复查剩下的 13 条误标，全是这么来的）。
   */
  const idiom = /面无表情|无语|没毛病|没什么|没事|没错|不得了|无所谓|非主流/g
  let idx = t.indexOf(k)
  while (idx >= 0) {
    const before = t.slice(Math.max(0, idx - 3), idx)
    if (/(?:不|别|没|未|无|非|not|never)\s*$/i.test(before)) {
      idiom.lastIndex = 0
      let hit = false
      let m
      while ((m = idiom.exec(t))) {
        // 命中「固定搭配」且关键词正好落在这个搭配里 → 不算否定
        if (m.index <= idx && idx + k.length <= m.index + m[0].length) {
          hit = true
          break
        }
      }
      if (!hit) return true
    }
    idx = t.indexOf(k, idx + 1)
  }
  return false
}

/**
 * 只留「实词」：两字以上的 2-gram/整词（单字太泛，长文本里必然撞一大片）。
 *
 * 2026-11-02（同题合并）：先把 `[引用 @某人：…]` / `[图片]` 这类方括号块抹掉。
 * 群聊转述的格式是「白饭鱼说：[引用 @茶茶：焦的归我] 焦的归你」，方括号里是**别人**的原话，
 * 拿它算同题会把「他复述谁」也当成话题本身，几百条转述会互相粘成一片。
 */
function contentKeywords(text) {
  const s = String(text ?? '').replace(/\[[^\]]*\]/gu, ' ')
  return new Set(tokenize(s).filter((w) => w.length >= 2))
}

/**
 * 两条记忆是不是「意思相反」。
 *
 * 判据（2026-11-02 收紧，原版见 git 历史里那句「一边否定一边不否定 + 共享两个实词」）：
 *   1. 共享至少两个实词；
 *   2. 共享词要占**短边**的三分之一以上——长叙述天然共享一堆二字词，比例不够就是"都在说话"，
 *      不是"说同一件事"；
 *   3. 否定必须**紧贴**某个共享词出现，且只有一边有。
 * 宁可漏判（两条相反的都留着）也不乱判（把一条真事实永久降权）。
 */
function conflicts(prevText, nextText) {
  // 原始转述/引用不是「主张」，谈不上改口：群聊里的话一旦被原样记下来，
  // 「别」「不」几乎是每三句一个，拿它判否定一定误伤（promise 类全是这种）。
  if (looksLikeQuote(prevText) || looksLikeQuote(nextText)) return false
  const A = contentKeywords(prevText)
  const B = contentKeywords(nextText)
  if (!A.size || !B.size) return false
  const shared = [...A].filter((w) => B.has(w))
  if (shared.length < 2) return false
  if (shared.length / Math.min(A.size, B.size) < 0.34) return false
  const a = shared.some((w) => negatedNear(prevText, w))
  const b = shared.some((w) => negatedNear(nextText, w))
  return a !== b
}

/** 「X说：…」「含 @引用」这类是聊天原文，不是抽出来的主张 */
function looksLikeQuote(text) {
  const t = String(text || '')
  return /^[^，。！？\n]{0,14}说[：:]/.test(t) || t.includes('[引用 @')
}
