/**
 * 记忆入库质量闸门（2026-10-19，用户批的「三条」第二条）。
 *
 * 背景：库里 78 条里混着模型的自言自语和碎片——
 *   「我不能骂人。这段对话里没有值得记录的事实。」
 *   「他不在意」
 *   「他提到了「把」这个字。」
 * 用户点开控制台一条条删太难受，所以在**入库那一刻**就挡住。
 *
 * 设计原则：**宁可放过，不可错杀**。
 *   - 真实有用的短句（「他在广州。」「他喜欢历史人物游戏。」）必须留下；
 *   - 拿不准的一律放行，让合并/去重那一层去处理；
 *   - 规则是**表驱动**的（`RULES`），加规则只加一行，测试逐条打靶。
 *
 * 不做的事：不碰 `memory.js` 的存取逻辑，不改 `qq` 字段语义
 * （task-22 定的），不在这里做合并——合并是 `dedupe.js` 的活。
 *
 * ── 关于「待核实区」的边界（2026-10-19 定，别为了"多拦一点"就越界）──
 * 真正该进待核实区的是：**关于她是谁 / 涉及她的侮辱或占便宜**
 * （「他是你爹」「他说你是傻逼」「他在意他是个傻子」这种），
 * **不是**「所有提到脏字的记忆」。`work` 操作日志里转述的脏话、
 * 表情包文件名里的脏字，都属于后者：留在正式库，别挪。
 * 拦进来也不等于删——待核实区是给人过一眼的地方，宁可多进几条让人放过，
 * 但**判据本身**必须一直指向"她"，不能退化成关键词黑名单。
 */

import { coreText, similarity } from './dedupe.js'

/** 标点/符号/emoji/分隔符（含空白）：判「有几个实字」用 */
const INVISIBLE = /[\p{P}\p{S}\p{Z}\s]/gu

const strip = (s) => String(s || '').replace(INVISIBLE, '')

/* ── 规则素材 ─────────────────────────────────────────────────────── */

/**
 * 模型在自言自语「这轮没啥可记的」。
 * 这类句子最长能到两百字（它会先自辩一段再下结论），所以只查关键词，
 * 不查长度。
 */
const SELF_TALK_RE = /没有值得记录|这段对话里没有|无需记录|不值得记|没有值得记的|不必记录|不需要记录/u

/**
 * 关于「记忆 / 系统提示 / 我能不能记住」的元叙述。
 *
 * 只对 `kind !== 'work'` 生效：`work` 那批是「我帮他做过：…」的操作日志，
 * 里面出现「记忆」是正常业务词（例：`查询关于 888888888 的记忆`），
 * 拿它当垃圾会误杀一整类真实记录。
 */
const META_RE = /系统提示|注入指令|提示词|写进记忆|记忆里.{0,10}没有这条|不是漏加|没法核实|无法核实真伪/u

/** 「他提到了 X」这种转述前缀 */
const FRAG_RE = /^(?:他|她|对方|用户|我)?(?:说到了?|提到(?:了)?|说起(?:了)?)([\s\S]*)$/u

/** 去掉「这个字 / 这个词 / 这句话」这类指代，剩下的才是真正记下的内容 */
const DEIXIS_RE = /这个(?:字|词|词儿|字儿|句子|话)|这句话|这个词|那个字|那句话/gu

/**
 * 无信息断言：`他不在意` / `他对温度无所谓` / `随便` / `不知道`。
 * 必须**整句就这一件事**、且长度 ≤ 12 个字才算——一旦后面跟了具体内容
 * （「他不在意别人怎么看，但很在意项目进度」），就是真信息，放行。
 */
const VAC_RE =
  /^(?:他|她|对方|用户)?[^，。！？,.!?…]{0,10}?(?:不在意|无所谓|随便|不知道|不清楚|没意见|都行)[。！？!?…\s]*$/u

const VAC_MAX = 12

/* ── 侮辱判定（2026-10-19 用户需求：骂她的、拿辈分占便宜的，进待核实区）───── */

/**
 * 三类，**宁可多拦进待核实区，也不许错杀普通记忆**：
 *   1. 辈分占便宜：「他是你爹」「你是我爹」「他叫你爹」「你是我儿子」
 *   2. 直接骂人词：「傻逼」「智障」「废物」「去死」…
 *   3. 第三人称贬损：「他是个傻子」——用户明确要求这种也要算
 *      （「他在意他是个傻子这件事」就在真库里躺着）
 *
 * 不拦的：`他喜欢玩猜历史人物游戏`、`他会写代码`、`他在意别人怎么看`
 * 这类普通叙述——它们一个侮辱词都没有，别用「在意/在意」这种字眼去猜。
 */
const INSULT_PATTERNS = [
  // 1. 辈分占便宜（指向「你」或「她」，或反过来让对方叫爹）
  /(?:你|您)(?:才|就)?是(?:我|他|她|俺)?(?:的)?(?:爹|爸|父亲|老子|儿子|孙子)/u,
  /(?:他|她)(?:才|就)?是(?:你|您)(?:的)?(?:爹|爸|父亲|老子|爷爷)/u,
  /(?:叫|让|喊)(?:你|您)(?:叫|喊)?(?:爹|爸|爷爷)/u,
  // 2. 直接骂人
  /傻逼|煞笔|傻b|傻叉|沙比|智障|脑残|废物|垃圾玩意|贱人|犯贱|婊子|贱货|滚蛋|去死|白痴|狗东西|杂种|畜生|孽畜/iu,
  // 3. 第三人称贬损：「他是个傻子」「你是个蠢货」
  /(?:是|当|成了|当成|像个)(?:个)?(?:傻子|傻逼|白痴|蠢货|废物|智障|笨蛋|傻帽)/u,
]

/**
 * 这条文本是不是侮辱/占便宜。
 *
 * 跳过两类：
 *   - `kind === 'sticker'`：正文是表情包文件名，不含人身评价；
 *   - `kind === 'work'`：「我帮他做过：给某人发送『测试内容』这句话」
 *     这种是**操作日志**，正文里的脏话是转述一条指令，不是在骂她。
 *     真库里 [72] 就是这条，扫出来只会给迁移添噪声。
 *
 * @param {string} text
 * @param {string} [kind]
 * @returns {boolean}
 */
export function isInsult(text, kind = 'fact') {
  const k = String(kind)
  if (k === 'sticker' || k === 'work') return false
  const t = String(text || '')
  return INSULT_PATTERNS.some((re) => re.test(t))
}

/* ── 单条规则 ─────────────────────────────────────────────────────── */

function isFragment(text) {
  const m = String(text || '')
    .trim()
    .match(FRAG_RE)
  if (!m) return false
  const rest = m[1].replace(DEIXIS_RE, '')
  return strip(rest).length < 3
}

function isVacuous(text) {
  const t = String(text || '').trim()
  if (strip(t).length > VAC_MAX) return false
  return VAC_RE.test(t)
}

/**
 * 找重复：同一个人（同 qq 或同 who）名下已经有高度相似的一条。
 * 用 `dedupe.js` 的 Jaccard（二元组），阈值 0.9——比合并那层（0.62 一带）
 * 严格得多，这里只挡「几乎逐字重复」，剩下的交给合并。
 */
function findDuplicate({ text, who, qq, existing }) {
  if (!Array.isArray(existing) || existing.length === 0) return null
  const mine = String(text || '').trim()
  if (!mine) return null
  for (const e of existing) {
    if (!e || typeof e.text !== 'string') continue
    const sameOwner =
      (qq && e.qq && String(e.qq) === String(qq)) || (who && e.who && String(e.who) === String(who))
    if (!sameOwner) continue
    const theirs = e.text.trim()
    if (!theirs) continue
    if (theirs === mine) return e
    if (similarity(theirs, mine) >= 0.9) return e
  }
  return null
}

/* ── 规则表（顺序即优先级，先命中先返回）──────────────────────────── */

export const RULES = [
  {
    id: 'no-identity',
    // 表情包记忆没有「谁」，它们由 learnStickers 用固定模板写入，不该被这条拦
    test: (c) => !c.who && !c.qq && c.kind !== 'sticker',
  },
  {
    id: 'insult',
    // 排在 too-short 前面：一句「傻逼」要报 insult 而不是 too-short，
    // 待核实区里「为什么被拦」比「太短」有用得多
    test: (c) => isInsult(c.text, c.kind),
  },
  { id: 'too-short', test: (c) => c.plain.length < 4 },
  { id: 'self-talk', test: (c) => SELF_TALK_RE.test(c.text) },
  { id: 'meta-narration', test: (c) => c.kind !== 'work' && META_RE.test(c.text) },
  { id: 'fragment', test: (c) => isFragment(c.text) },
  { id: 'vacuous', test: (c) => isVacuous(c.text) },
  {
    id: 'no-content',
    // 去掉标点/emoji 之后不到 4 个实字；纯数字也不算内容
    test: (c) => c.core.length < 4 || /^\d+$/.test(c.core),
  },
  { id: 'duplicate', test: (c) => findDuplicate(c) !== null },
]

/* ── 对外接口 ─────────────────────────────────────────────────────── */

/**
 * 判一条记忆能不能入库。
 *
 * @param {object} input
 * @param {string} input.text  记忆正文
 * @param {string} [input.kind='fact'] fact/person/work/preference/promise/sticker…
 * @param {string} [input.who]  人名（插件里的 who 字段）
 * @param {string} [input.qq]   QQ 号（可选；没有就只按 who 判重）
 * @param {object[]} [input.existing] 现有记忆数组，判 duplicate 用
 * @returns {{ok: boolean, reason: string}}
 */
export function judge(input) {
  input = input || {}
  const text = String(input.text == null ? '' : input.text)
  const ctx = {
    text,
    kind: String(input.kind || 'fact'),
    who: String(input.who || '').trim(),
    qq: String(input.qq || '').trim(),
    existing: input.existing || [],
    plain: text.trim(),
    core: coreText(text),
  }
  for (const rule of RULES) {
    let hit = false
    try {
      hit = Boolean(rule.test(ctx))
    } catch {
      hit = false // 规则写错就放行，绝不因为闸门自己崩了而丢记忆
    }
    if (hit) return { ok: false, reason: rule.id }
  }
  return { ok: true, reason: 'ok' }
}

/** 给人看的说明：报警时带上依据，方便排查误杀 */
export function explain(reason) {
  return (
    {
      'no-identity': '没有主语的记忆（who 和 qq 都空），不知道记的是谁',
      insult: '侮辱/占便宜的记录（骂她或拿辈分压她），放进待核实区让人看',
      'too-short': '去掉空白不到 4 个字',
      'self-talk': '模型在自言自语「这轮没什么可记的」',
      'meta-narration': '在讲"我怎么记/系统提示"的元叙述，不是关于用户的事实',
      fragment: '只是一句转述碎片（他提到了 X）',
      vacuous: '无信息断言（不在意/无所谓/随便/不知道）',
      'no-content': '去掉标点表情后没有实际内容（或纯数字）',
      duplicate: '同一个人名下已有几乎相同的记忆',
      ok: '通过',
    }[reason] || reason
  )
}

export default judge
