/**
 * 茉莉花（Jasmine）记忆系统 · 每周一封信（P0-3）
 *
 * 「周聚合」解决的是**记忆**问题（把 7 天的碎事压成一条），
 * 这一封解决的是**叙事**问题：让 Agent 有一天能说「上周三你跟我说过……」，
 * 而不是只有一堆冷冰冰的条目。
 *
 * 设计上刻意不调模型：模板 + 事实卡片，生成一封 200～600 字的信。
 * 理由：写信要稳定、要能追溯到具体记忆、要不花钱；文采交给宿主的人格层。
 * 但模板不能死板，所以用周键做种子挑句式，同一周永远同一句（可复现），
 * 不同周换着说。
 */

/** 一句式变体池：同样的意思换个说法，避免每周读起来一模一样 */
const OPENERS = [
  '这周过得挺快的。',
  '一周又过去了。',
  '翻到这一页的时候，才发现又过了一周。',
  '这周的日历翻完了。',
]

const CLOSERS = [
  '下周想先聊什么？',
  '下周要不要去干点什么？',
  '下周有什么想让我记着的？',
  '先写到这，下周见。',
]

/** 小种子，保证同一周同一封信 */
function seedOf(text) {
  let h = 2166136261
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

function pick(list, seed) {
  return list[seed % list.length]
}

/**
 * 判断这周该不该写信：每周一写一次，当前周不写（没写完的周不总结）。
 * @param {{lastLetterWeek?: string, now?: number}} input
 */
export function shouldWriteLetter({ lastLetterWeek = '', now = Date.now() } = {}) {
  return !lastLetterWeek || lastLetterWeek !== currentWeekKey(now)
}

/** 用 UTC 近似算一个周键（宿主有自己的时区就自己传 weekKey） */
export function currentWeekKey(now = Date.now()) {
  const d = new Date(Number(now))
  const base = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dow = (base.getUTCDay() + 6) % 7
  base.setUTCDate(base.getUTCDate() - dow + 3)
  const year = base.getUTCFullYear()
  const first = new Date(Date.UTC(year, 0, 4))
  const fDow = (first.getUTCDay() + 6) % 7
  first.setUTCDate(first.getUTCDate() - fDow + 3)
  const week = 1 + Math.round((base.getTime() - first.getTime()) / (7 * 86_400_000))
  return `${year}-W${String(week).padStart(2, '0')}`
}

/**
 * 生成一封信。
 *
 * @param {object} input
 * @param {string} input.weekKey 周键，如 2026-W45
 * @param {{who?: string, text: string, at?: number}[]} input.facts 这周的事实卡（按时间正序）
 * @param {string} [input.owner] 主人称呼（默认「你」）
 * @param {number} [input.quietDays] 这周没怎么说话的天数（可选，会写进信里）
 * @param {number} [input.maxChars] 字符上限（默认 600）
 * @param {number} [input.maxFacts] 最多写几件事（默认 5）
 * @returns {{weekKey: string, text: string, used: number}}
 */
export function buildLetter({
  weekKey = currentWeekKey(),
  facts = [],
  owner = '你',
  quietDays = 0,
  maxChars = 600,
  maxFacts = 5,
} = {}) {
  const seed = seedOf(weekKey)
  const picked = [...facts]
    .filter((f) => f && String(f.text || '').trim())
    .sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))
    .slice(0, Math.max(1, maxFacts))

  const lines = []
  lines.push(`${pick(OPENERS, seed)}（${weekKey}）`)
  if (!picked.length) {
    lines.push(quietDays > 0 ? `这周安安静静的，${quietDays} 天没怎么说话。` : '这周没什么特别的事。')
  } else {
    for (const f of picked) {
      const who = String(f.who || '').trim()
      const body = String(f.text).replace(/\s+/g, ' ').trim()
      lines.push(who && who !== owner ? `${who}：${body}` : body)
    }
  }
  if (quietDays >= 3) lines.push(`其中有 ${quietDays} 天没怎么聊，我都记着。`)
  lines.push(pick(CLOSERS, seed >> 3))

  let text = lines.join('\n')
  const cap = Math.max(80, Number(maxChars) || 600)
  if (text.length > cap) text = `${text.slice(0, cap - 1)}…`
  return { weekKey, text, used: picked.length }
}

/**
 * 把信渲染成一条记忆（kind=event，level=2，weight=8），跟周聚合同级。
 * 这样「我说过什么」和「我写过什么」都在同一层，召回时能一起被翻到。
 */
export function letterEntry({ weekKey, text, owner = '' }, { id } = {}) {
  return {
    id: id || `letter-${weekKey}`,
    kind: 'event',
    who: owner,
    qq: '',
    text,
    weight: 8,
    level: 2,
    source: 'system',
    hits: 0,
    lastActiveDay: 0,
    at: Date.now(),
    letterFor: weekKey,
  }
}
