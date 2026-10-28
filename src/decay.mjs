/**
 * 茉莉花（Jasmine）记忆系统 · 衰减与归档
 *
 * 这一层是**纯函数**：不碰磁盘、不读时钟、不 import 任何外部模块。
 * 参数刻意跟 Molly（plugin/dsh-qq-whale/lib/memory.js）保持一致，
 * 这样同一份记忆在两边算出来的有效权重完全相同，搬运时不会「换了个系统就变重/变轻」。
 *
 * 核心约定：
 *   1. 盘上存的只有 base（weight）+ hits + lastActiveDay，是**事实**；
 *      衰减是**看法**，只在读取时按当前活跃天计算，永不写回。
 *      所以没有复利 bug，也不需要定时任务。
 *   2. 时间用「活跃天」而不是日历天：只有真聊过天的那一天才 +1。
 *      关机一周不算遗忘，聊天多的一天也只算一天。
 *   3. 曲线是阶梯：先白给一段宽限期，之后每 7 个活跃天掉 0.5，掉到该类下限为止。
 */

/** 七类记忆。顺序即渲染顺序（称谓最前，闲聊最后） */
export const KINDS = Object.freeze(['address', 'person', 'fact', 'preference', 'promise', 'event', 'meme'])

/** 老数据里的 kind 别名，读进来时折叠成新名 */
export const KIND_ALIASES = Object.freeze({ work: 'event', sticker: 'meme' })

export const WEIGHT_MIN = 1
export const WEIGHT_MAX = 10
export const WEIGHT_DEFAULT = 6

/**
 * 每类的权重下限。
 *   - 称谓（address）每轮无条件注入，不参与召回，衰减没意义 → 钉死 10
 *   - 约定（promise）掉到 1 约等于「答应过的事也想不起来了」→ 5
 *   - 人物（person）是「你是谁」唯一答案来源 → 4
 *   - 事实/偏好 3，闲聊里的事/梗 1（这些本来就可以忘）
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

/** 只有这两类会归档：它们掉到下限本身已经说明「很久没用了」 */
export const ARCHIVABLE_KINDS = Object.freeze(['event', 'meme'])

/** 归档门槛：有效权重触底，并且晾够 90 个**活跃天** */
export const ARCHIVE_IDLE_DAYS = 90

export const DECAY_STEP_DAYS = 7
export const DECAY_STEP = 0.5

/** 宽限期（活跃天）：这段时间内一律不掉 */
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
 * 把任意输入规整成七类之一；不认识的一律当 fact（宁可记成「事」也不要丢）。
 * @param {string} kind
 * @returns {string}
 */
export function normalizeKind(kind) {
  const k = String(kind ?? '').trim().toLowerCase()
  const mapped = KIND_ALIASES[k] || k
  return KINDS.includes(mapped) ? mapped : 'fact'
}

/**
 * 权重夹到 [1, 10] 的整数；非法值回落到默认 6。
 * @param {unknown} value
 * @param {number} [fallback]
 */
export function clampWeight(value, fallback = WEIGHT_DEFAULT) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(WEIGHT_MIN, Math.min(WEIGHT_MAX, Math.round(n)))
}

/**
 * 有效权重：base − ⌊(idle − 宽限) / 7⌋ × 0.5，夹在该类下限与上限之间，一位小数。
 * @param {{kind?: string, weight?: number, lastActiveDay?: number}} entry
 * @param {number} activeDays 当前库的活跃天总数
 * @returns {number}
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

/**
 * 这条记忆该不该归档。
 *
 * 三个条件同时成立才动：类别可归档（event/meme）、有效权重已触底、
 * 并且它自己晾了 ≥ idleDays 个活跃天。第二道保险是防止
 * 「刚聊过但权重低」的经历被立刻挪走。
 *
 * @param {object} entry
 * @param {{activeDays?: number, idleDays?: number}} [opts]
 * @returns {boolean}
 */
export function isArchivable(entry, { activeDays = 0, idleDays = ARCHIVE_IDLE_DAYS } = {}) {
  const kind = normalizeKind(entry?.kind)
  if (!ARCHIVABLE_KINDS.includes(kind)) return false
  const floor = WEIGHT_FLOOR[kind] ?? WEIGHT_MIN
  if (effectiveWeight(entry, activeDays) > floor) return false
  const now = Math.max(0, Math.round(Number(activeDays) || 0))
  const last = Math.max(0, Math.round(Number(entry?.lastActiveDay) || 0))
  return now - last >= Math.max(1, Math.round(Number(idleDays) || ARCHIVE_IDLE_DAYS))
}

/** 命中一次：把条目的「最近活跃」拉到今天，权重不写回（衰减是看法） */
export function applyHit(entry, activeDay) {
  if (!entry) return entry
  entry.hits = Math.max(0, Number(entry.hits) || 0) + 1
  entry.lastActiveDay = Math.max(0, Math.round(Number(activeDay) || 0))
  return entry
}

/**
 * 时间的两种表述互转：活跃天 ↔ 日历天。
 * 只在上层需要「按日期展示」时用，记忆内部一律用活跃天。
 */
export function weekIndexOf(ts, { tzOffsetMinutes = 0 } = {}) {
  const d = new Date(Number(ts) - tzOffsetMinutes * 60_000)
  const day = Math.floor(d.getTime() / 86_400_000)
  // 1970-01-01 是周四，+3 让每周从周一开始
  return Math.floor((day + 3) / 7)
}

/** 周键，形如 2026-W45（ISO 周，周一为界，按调用方给的时区偏移） */
export function weekKeyOf(ts, opts = {}) {
  const { tzOffsetMinutes = 0 } = opts
  const d = new Date(Number(ts) - tzOffsetMinutes * 60_000)
  const base = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dow = (base.getUTCDay() + 6) % 7 // 周一 = 0
  base.setUTCDate(base.getUTCDate() - dow + 3) // 该周的周四
  const weekYear = base.getUTCFullYear()
  const firstThursday = new Date(Date.UTC(weekYear, 0, 4))
  const firstDow = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDow + 3)
  const week = 1 + Math.round((base.getTime() - firstThursday.getTime()) / (7 * 86_400_000))
  return `${weekYear}-W${String(week).padStart(2, '0')}`
}
