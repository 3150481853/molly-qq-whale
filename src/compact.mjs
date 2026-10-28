/**
 * 茉莉花（Jasmine）记忆系统 · 上下文压缩提醒（P0-2）
 *
 * 结论先说：**压缩本身不省钱，它只是在救「注意力」。**
 *
 * 为什么：缓存命中与未命中的单价差 50 倍。压掉 10 万 token 大概每轮省 0.002 元，
 * 但压缩要改历史 → 前缀缓存重建 → 那一轮多花接近 1 元。要 500 轮才回本。
 * 所以「能不动就不动」，动它的唯一理由是：上下文快满了，当前这轮已经不是
 * 提示词里最重要的东西了——这时候模型会开始答非所问、读工具时断片。
 *
 * 因此这一层只做**提醒**，不做压缩：
 *   1. 三档触发：增长档（攒够 5 万可压缩 token）、压力档（75%）、紧急档（95%）
 *   2. 能回收不足 5000 token 的，不提醒（防止高频小折，每次都得重建缓存）
 *   3. 提醒追加在**本次请求末尾**，不写进历史，不占后续轮次的前缀
 */

/** 可压缩量达到这个数才触发增长档 */
export const GROWTH_TOKENS = 50000

/** 压力档 / 紧急档：按窗口占用率 */
export const PRESSURE_RATIO = 0.75
export const URGENT_RATIO = 0.95

/** 能回收的量低于这个数就不提醒 */
export const MIN_RECLAIM_TOKENS = 5000

/** 粗估 token：中文按 0.75/字，西文按 4 字符/token（不引依赖，量级够用） */
export function estimateTokens(text) {
  const s = String(text ?? '')
  let cjk = 0
  let other = 0
  for (const ch of s) {
    if (/[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(ch)) cjk += 1
    else other += 1
  }
  return Math.max(0, Math.ceil(cjk * 0.75 + other / 4))
}

/**
 * 判断这次该不该提醒压缩。
 *
 * @param {object} input
 * @param {number} input.usedTokens 当前上下文已用 token
 * @param {number} input.limitTokens 窗口上限
 * @param {number} [input.compactableTokens] 其中「可压缩」的部分（历史、工具输出）
 * @param {number} [input.sinceLastCompact] 上次压缩后新增的可压缩 token
 * @param {boolean} [input.remindedThisTurn] 本回合是否已经提醒过（同一回合最多一次）
 * @returns {{tier: 'none'|'growth'|'pressure'|'urgent', ratio: number, reclaim: number, reason: string}}
 */
export function evaluateCompaction({
  usedTokens = 0,
  limitTokens = 0,
  compactableTokens = 0,
  sinceLastCompact = 0,
  remindedThisTurn = false,
  minReclaim = MIN_RECLAIM_TOKENS,
} = {}) {
  const used = Math.max(0, Number(usedTokens) || 0)
  const limit = Math.max(1, Number(limitTokens) || 1)
  const ratio = used / limit
  const reclaim = Math.max(0, Number(compactableTokens) || 0)
  if (remindedThisTurn) return { tier: 'none', ratio: ratio, reclaim, reason: '本回合已提醒过' }
  if (reclaim < minReclaim) return { tier: 'none', ratio: ratio, reclaim, reason: `可回收不足 ${minReclaim} token` }

  if (ratio >= URGENT_RATIO) return { tier: 'urgent', ratio: ratio, reclaim, reason: '窗口快满了' }
  if (ratio >= PRESSURE_RATIO) return { tier: 'pressure', ratio: ratio, reclaim, reason: '窗口压力' }
  if (Number(sinceLastCompact) >= GROWTH_TOKENS) {
    return { tier: 'growth', ratio: ratio, reclaim, reason: `攒够 ${GROWTH_TOKENS} token` }
  }
  return { tier: 'none', ratio: ratio, reclaim, reason: '未触发' }
}

/**
 * 生成末尾提醒（一行，尽量短）。它不写进历史，只贴在本轮请求的最末尾。
 * @param {{tier: string, reclaim: number}} input
 */
export function buildReminder({ tier = 'none', reclaim = 0 } = {}) {
  if (tier === 'none') return ''
  const k = Math.max(1, Math.round(reclaim / 1000))
  const head =
    tier === 'urgent'
      ? '窗口快满了'
      : tier === 'pressure'
        ? '上下文有点重'
        : '历史攒得有点多'
  return `（${head}，约 ${k}K 可压缩。真需要时把早期细节收进长期记忆，别现在压；要压就一次压够，别反复改前缀。）`
}
