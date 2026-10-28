/**
 * 茉莉花（Jasmine）记忆系统 · 召回
 *
 * 两路名次融合（Reciprocal Rank Fusion）：
 *   关键词臂：这条记忆跟这一句问话「字面上有多相关」
 *   权重臂：这条记忆本身有多重（有效权重 + 最近性）
 *
 * 用 RRF 而不是把两路分数加起来，是因为两路的量纲根本不可比：
 * 关键词是 0..1 的覆盖率，权重是 1..10 的档位，直接加权求和等于
 * 让「权重臂」永远赢。RRF 只看名次，天然免疫量纲问题（K=60 是经验值，
 * 名次差越大分差越小，前几名几乎均分——避免一条超高分记忆霸占上下文）。
 *
 * 这一层同样是纯函数：传入记忆数组，返回排序结果，不碰磁盘。
 */

export const RRF_K = 60

/** 两路各自的话语权（关键词稍微重要一点：问什么答什么） */
export const ARM_WEIGHTS = Object.freeze({ keyword: 0.6, weight: 0.4 })

/** 中文停用字：单个字大多没有区分度，进关键词臂只会让「的了吗」互相命中 */
const STOP_CHARS = new Set('的了是我你他她它们在有和就不都一个上也很到说要去会着没看好这那什么怎么还但把被让给对里吧呢啊哦嗯'.split(''))

/** 抽取关键词元：中文取连续片段的二字组，西文/数字取整词 */
export function terms(text) {
  const s = String(text ?? '').toLowerCase()
  const out = new Set()
  // 西文/数字
  for (const m of s.matchAll(/[a-z0-9_@.\-]{2,}/g)) out.add(m[0])
  // 中日韩连续片段 → 二字组
  for (const m of s.matchAll(/[\u3400-\u9fff]{1,}/g)) {
    const run = m[0]
    if (run.length === 1) {
      if (!STOP_CHARS.has(run)) out.add(run)
      continue
    }
    for (let i = 0; i < run.length - 1; i++) {
      const bg = run.slice(i, i + 2)
      if (!STOP_CHARS.has(bg[0]) && !STOP_CHARS.has(bg[1])) out.add(bg)
    }
  }
  return out
}

/** 关键词相关度 0..1：查询词被命中的比例，整句包含再给一点奖励 */
export function keywordScore(text, query) {
  const q = terms(query)
  if (!q.size) return 0
  const t = terms(text)
  if (!t.size) return 0
  let hit = 0
  for (const term of q) if (t.has(term)) hit += 1
  const coverage = hit / q.size
  const qs = String(query ?? '').trim().toLowerCase()
  const ts = String(text ?? '').toLowerCase()
  const bonus = qs.length >= 4 && ts.includes(qs) ? 0.15 : 0
  return Math.min(1, coverage + bonus)
}

function rankIndex(list) {
  const out = new Map()
  list.forEach((item, i) => out.set(item, i + 1))
  return out
}

/**
 * RRF 融合。
 * @param {object[]} entries 候选记忆
 * @param {object} opts
 * @param {string} [opts.query] 问话
 * @param {number} [opts.activeDays] 库里当前活跃天（算衰减用）
 * @param {number} [opts.now] 当前时间戳（算最近性用）
 * @param {Function} [opts.weightOf] 自定义权重函数（默认 effectiveWeight）
 * @param {number} [opts.k] RRF 常数
 * @param {{keyword?:number, weight?:number}} [opts.armWeights]
 * @returns {{items: {entry: object, score: number, ranks: {keyword: number|null, weight: number}}[], arms: {keyword: number, weight: number}}}
 */
export function fuseRecall(entries, opts = {}) {
  const {
    query = '',
    activeDays = 0,
    now = Date.now(),
    weightOf = null,
    k = RRF_K,
    armWeights = ARM_WEIGHTS,
  } = opts
  const weight = weightOf || ((e) => (Number.isFinite(Number(e?.weight)) ? Number(e.weight) : 6))

  // 关键词臂：只有真命中才进榜（0 分的条目进榜会把纯权重臂也稀释掉）
  const kw = []
  for (const e of entries) {
    const s = keywordScore(e?.text, query)
    if (s > 0) kw.push({ e, s })
  }
  kw.sort((a, b) => b.s - a.s || (Number(b.e.hits) || 0) - (Number(a.e.hits) || 0))

  // 权重臂：有效权重高者先；权重相同看最近（at 新的先）
  const wt = entries
    .map((e) => ({ e, s: weight(e, activeDays) }))
    .sort((a, b) => b.s - a.s || (Number(b.e.at) || 0) - (Number(a.e.at) || 0))

  const kwRank = rankIndex(kw.map((x) => x.e))
  const wtRank = rankIndex(wt.map((x) => x.e))

  const fused = new Map()
  const touch = (entry) => {
    let cur = fused.get(entry)
    if (!cur) {
      cur = { entry, score: 0, ranks: { keyword: null, weight: null } }
      fused.set(entry, cur)
    }
    return cur
  }
  for (const [entry, rank] of kwRank) {
    const cur = touch(entry)
    cur.score += (armWeights.keyword ?? 0) / (k + rank)
    cur.ranks.keyword = rank
  }
  for (const [entry, rank] of wtRank) {
    const cur = touch(entry)
    cur.score += (armWeights.weight ?? 0) / (k + rank)
    cur.ranks.weight = rank
  }

  const items = [...fused.values()].sort(
    (a, b) => b.score - a.score || (Number(b.entry.at) || 0) - (Number(a.entry.at) || 0),
  )
  return { items, arms: { keyword: kw.length, weight: wt.length } }
}

/**
 * 按字符预算裁剪召回结果。
 * 贪心取分高的，直到超预算；至少留 1 条（否则「问起某人」时会一条都不给）。
 * @param {{entry: object}[]} items fuseRecall 的结果
 * @param {number} budget 字符预算（0 = 不限）
 */
export function applyCharBudget(items, budget = 0) {
  const cap = Math.max(0, Math.round(Number(budget) || 0))
  if (!cap) return items
  const out = []
  let used = 0
  for (const it of items) {
    const len = String(it?.entry?.text ?? '').length
    if (out.length && used + len > cap) continue
    out.push(it)
    used += len
  }
  return out
}
