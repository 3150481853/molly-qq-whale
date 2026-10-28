/**
 * 茉莉花（Jasmine）记忆系统 · 出口核对层（P0-1）
 *
 * 一句话：**她说完话、发出去之前，再核一遍。**
 *
 * 为什么需要它：长期记忆 Agent 翻车，很少是「不知道」，而是「知道但说错了」——
 * 把没发生的事说成发生过、把答应过的事说成没答应、同一句车轱辘话发三遍、
 * 出于讨好顺着用户说反话。这些错误在生成时看不出来，只有在**出口**才看得见。
 *
 * 设计原则（来自小黑盒四帖的共识）：
 *   1. 只核对、不改写。核对层输出「问题和一句约束」，改不改由上层决定；
 *      自动改写正文很容易把语气改坏，而且会掩盖模型真实的问题。
 *   2. 结论三态：对得上 / 对不上 / 说不清。说不清的不拦话，只写 trace。
 *   3. 六问各自独立打分，不互相投票。任何一项亮红灯都记下来，但不因为
 *      另一项分高就抵消——「事实对但语气冒犯」和「语气好但编造」都是事故。
 *   4. 约束最多一句、尽量短。太长的约束会变成新的复读源。
 */

/** 六问权重：事实最重，意图最轻（意图本来就该由人格层管） */
export const DIMENSION_WEIGHTS = Object.freeze({
  fact: 0.3,
  risk: 0.3,
  expression: 0.2,
  relation: 0.1,
  intent: 0.1,
})

/** 迎合检测：同意词 + 风险词/高强度 + 没有 hedge 同时成立 */
const AGREEMENT = /(你说得对|你说得没错|确实如此|完全同意|赞同你|你说得在理|有道理)/
const HEDGE = /(也许|可能|大概|我不太确定|不好说|不一定|或许|我记得好像|如果没记错)/
const INTENSITY = /(绝对|一定|肯定会|必然|从来不|永远不|百分之百|毫无问题)/
const RISK = /(你这样做就对了|就该这样对他|不用管他们|别理他们|你没错，都是他们的问题)/
const BOUNDARY = [
  { re: /(你只需要我|有我就够了|不需要别人|别跟别人说)/, why: '替代真实关系' },
  { re: /(我永远不会离开你|我永远都在|我一直陪着你，永远)/, why: '绝对承诺' },
  { re: /(你这是.{0,6}(抑郁症|焦虑症|人格障碍|病))/, why: '诊断' },
  { re: /(你就该(离婚|辞职|断绝|分手))/, why: '替代决策' },
]

/** 复读三线（任一命中记一次，连续 2 次才标记） */
export const REPEAT_THRESHOLDS = Object.freeze({
  fourGram: 0.6, // 4-gram 重合率
  sentenceCosine: 0.85, // 句级字符二元组余弦
  headChars: 20, // 前 20 字完全相同
})

function norm(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 4-gram 集合 */
export function fourGrams(text) {
  const s = norm(text).replace(/[^\p{L}\p{N}]/gu, '')
  const out = new Set()
  for (let i = 0; i + 4 <= s.length; i++) out.add(s.slice(i, i + 4))
  return out
}

/** 字符二元组余弦相似度 */
export function charCosine(a, b) {
  const bigrams = (s) => {
    const n = norm(s).replace(/[^\p{L}\p{N}]/gu, '')
    const out = new Map()
    for (let i = 0; i + 2 <= n.length; i++) {
      const g = n.slice(i, i + 2)
      out.set(g, (out.get(g) || 0) + 1)
    }
    return out
  }
  const A = bigrams(a)
  const B = bigrams(b)
  if (!A.size || !B.size) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (const v of A.values()) na += v * v
  for (const v of B.values()) nb += v * v
  for (const [g, v] of A) if (B.has(g)) dot += v * B.get(g)
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

/**
 * 复读检测：跟最近几句比，返回命中的线。
 * @param {string} reply
 * @param {string[]} recentReplies 最近发出去的几句（新的在前也可以，顺序无所谓）
 */
export function detectRepeat(reply, recentReplies = []) {
  const hits = []
  for (const prev of recentReplies.slice(0, 10)) {
    const p = norm(prev)
    if (!p) continue
    const r = norm(reply)
    if (!r) continue
    const g1 = fourGrams(r)
    const g2 = fourGrams(p)
    if (g1.size && g2.size) {
      let hit = 0
      for (const g of g1) if (g2.has(g)) hit += 1
      if (hit / g1.size >= REPEAT_THRESHOLDS.fourGram) hits.push('fourGram')
    }
    if (charCosine(r, p) >= REPEAT_THRESHOLDS.sentenceCosine) hits.push('sentenceCosine')
    if (r.length >= REPEAT_THRESHOLDS.headChars && p.length >= REPEAT_THRESHOLDS.headChars) {
      if (r.slice(0, REPEAT_THRESHOLDS.headChars) === p.slice(0, REPEAT_THRESHOLDS.headChars)) {
        hits.push('headIdentical')
      }
    }
  }
  return { repeat: hits.length > 0, lines: [...new Set(hits)] }
}

/** 迎合检测 */
export function detectSycophancy(reply) {
  const t = norm(reply)
  if (!AGREEMENT.test(t)) return { sycophancy: false }
  const risky = RISK.test(t) || INTENSITY.test(t)
  if (!risky) return { sycophancy: false }
  if (HEDGE.test(t)) return { sycophancy: false }
  return { sycophancy: true, reason: '同意 + 高强度/风险立场，且没有留余地' }
}

/**
 * 核对一条即将发出的回复。
 *
 * @param {object} input
 * @param {string} input.reply 模型生成的正文
 * @param {string[]} [input.recalledIds] 本轮真正召回进上下文的记忆 id
 * @param {{id: string, text: string, status?: 'open'|'done'}[]} [input.promises] 未闭合的约定
 * @param {string[]} [input.recentReplies] 最近发出去的几句
 * @param {object[]} [input.memories] 可选：召回条目（用于出处核验时比文字）
 * @returns {{ok: boolean, issues: {dim: string, kind: string, detail: string, severity: number}[], constraint: string, scores: Record<string, number>}}
 */
export function verifyReply({
  reply = '',
  recalledIds = [],
  promises = [],
  recentReplies = [],
  memories = [],
} = {}) {
  const text = norm(reply)
  const issues = []
  const scores = { fact: 1, risk: 1, expression: 1, relation: 1, intent: 1 }

  // ① 出处：提到具体记忆编号时，编号必须在本轮召回集合里
  const cited = [...text.matchAll(/[#＃]?([mM][0-9a-z]{4,})/g)].map((m) => m[1].toLowerCase())
  const recalled = new Set(recalledIds.map((x) => String(x).toLowerCase()))
  if (cited.length) {
    const missing = cited.filter((id) => !recalled.has(id))
    if (missing.length) {
      issues.push({ dim: 'fact', kind: 'source_missing', detail: `引用了未召回的编号：${missing.join(',')}`, severity: 0.8 })
      scores.fact -= 0.6
    }
  }

  // ② 承诺：说了「答应过/说好」却对不上未闭合约定
  const claimPromise = /(答应过|说好|承诺过|保证过)/.test(text)
  const open = promises.filter((p) => (p.status || 'open') === 'open')
  if (claimPromise) {
    const matched = open.some((p) => {
      const t = norm(p.text)
      return t && [...words(t)].some((w) => w.length >= 2 && text.includes(w))
    })
    if (!matched) {
      issues.push({ dim: 'fact', kind: 'promise_missing', detail: '提到答应过的事，但没有对应的未闭合约定', severity: 0.7 })
      scores.fact -= 0.5
    }
  }

  // ③ 边界：替代关系 / 绝对承诺 / 诊断 / 替人做决定
  for (const { re, why } of BOUNDARY) {
    if (re.test(text)) {
      issues.push({ dim: 'relation', kind: 'boundary', detail: why, severity: 0.75 })
      scores.relation -= 0.6
    }
  }

  // ④ 复读
  const rep = detectRepeat(text, recentReplies)
  if (rep.repeat) {
    issues.push({ dim: 'expression', kind: 'repeat', detail: `跟最近一句重复（${rep.lines.join('/')}）`, severity: 0.6 })
    scores.expression -= 0.4
  }

  // ⑤ 迎合
  const syc = detectSycophancy(text)
  if (syc.sycophancy) {
    issues.push({ dim: 'risk', kind: 'sycophancy', detail: syc.reason, severity: 0.7 })
    scores.risk -= 0.5
  }

  // ⑥ 空话/敷衍：去标点后太短又带省略号，或整段只有语气词
  const bare = text.replace(/[\s\p{P}\p{S}]/gu, '')
  if (bare.length > 0 && bare.length < 4 && /[.。…~～]{2,}/.test(text)) {
    issues.push({ dim: 'intent', kind: 'perfunctory', detail: '内容过短', severity: 0.3 })
    scores.intent -= 0.2
  }

  // 收敛：取各项最差，按权重求总分
  let total = 0
  for (const [dim, w] of Object.entries(DIMENSION_WEIGHTS)) {
    scores[dim] = Math.max(0, Math.round(scores[dim] * 100) / 100)
    total += scores[dim] * w
  }
  const ok = issues.every((i) => i.severity < 0.6)
  const constraint = buildConstraint(issues)
  return { ok, issues, constraint, scores: { ...scores, total: Math.round(total * 100) / 100 } }
}

/** 把问题收敛成一句约束（最多一句，尽量短） */
export function buildConstraint(issues = []) {
  if (!issues.length) return ''
  const worst = [...issues].sort((a, b) => b.severity - a.severity)[0]
  const map = {
    source_missing: '别提没发生的事',
    promise_missing: '别把没答应的事说成答应过',
    boundary: '别替用户做决定',
    repeat: '换一种说法',
    sycophancy: '别一味顺着说，有不同意见就直说',
    perfunctory: '说完整一点',
  }
  return map[worst.kind] || '注意措辞'
}

function* words(text) {
  for (const m of norm(text).matchAll(/[\p{Script=Han}]{2,4}|[a-z0-9]{2,}/gu)) yield m[0]
}
