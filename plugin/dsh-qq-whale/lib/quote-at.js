/*
 * 「@ 谁 / 引用哪条」的纯函数（2026-10-25，主人 m02736 + m02835 / m02846）。
 *
 * 背景是两起真机事故：
 *   ① 某个群 11:24：一位成员发了张图，另一位成员只发了一条「@Molly」、一个字没说；
 *      她回那张图时，@ 却落到了后者头上——因为旧兜底只会 @「触发这条回复的消息的发送者」。
 *   ② 用户群 22:20：她答「某某问的那个…」却 @ 了另一个人——
 *      模型从名册里挑错了 QQ 号，而代码对模型写的号不做任何校验。
 *
 * 所以这里只做三件纯事（不依赖 engine / OneBot / config，输入全由调用方传）：
 *   1. isPureNudge(ev)        这条消息是不是「只有 @/表情，没有正文」；
 *   2. resolveExplicitAt(...) 模型写的 <at>号 该不该认；
 *   3. pickQuoteTarget(...)   这次要不要带引用、引哪一条。
 *
 * 引用只在该带的时候带（主人 m02846：「引用也不用每条，同一时间发的人特别多才引用」）。
 */

/** 引用策略默认值（同名配置项见 main.js 的 DEFAULTS） */
export const QUOTE_DEFAULTS = {
  enabled: true,
  windowSeconds: 30,
  minMessages: 3,
  minSpeakers: 2,
  /** @ 号校验时回看多少条最近消息里的说话人 */
  atWindowMessages: 20,
}

/** 去掉占位/标点/空白之后还剩多少「实字」 */
function coreLength(text) {
  return String(text || '')
    .replace(/\[[^\]]{1,24}\]/g, '') // [图片] [表情] [语音] 这类占位
    .replace(/[\s\p{P}\p{S}]/gu, '') // 空白 + 标点 + 符号
    .length
}

/**
 * 触发消息是不是「纯叫醒」：只有 @（可能带个表情或空白），没有一个字的正文。
 * 这种消息不该被当作「她要回的那个人」——她接的是上下文里的上一条。
 *
 * @param {object} ev OneBot 原始事件（SnowLuma 会给 ev.message 数组）
 * @returns {boolean}
 */
export function isPureNudge(ev) {
  if (!ev || typeof ev !== 'object') return false
  const segs = Array.isArray(ev.message) ? ev.message : []
  let text = ''
  let hasSeg = false
  for (const seg of segs) {
    if (!seg || typeof seg !== 'object') continue
    hasSeg = true
    if (seg.type !== 'text') continue
    text += String(seg.data?.text ?? '')
  }
  // 兜底：没有 segments 时看 raw_message（先剥 CQ 码）
  if (!hasSeg) text = String(ev.raw_message || '').replace(/\[CQ:[^\]]*\]/g, '')
  return coreLength(text) <= 1
}

/**
 * 「同一时间发的人特别多」的量化：回看 windowSeconds 秒，数别人的消息条数和说话人数。
 *
 * @param {Array} history conv.history（user 条目带 at / userId）
 * @param {number} nowMs 当前时间戳
 * @param {{windowSeconds?:number}} [opts]
 * @returns {{count:number, speakers:number, since:number}}
 */
export function crowdStats(history, nowMs = Date.now(), opts = {}) {
  const windowSeconds = Number(opts.windowSeconds ?? QUOTE_DEFAULTS.windowSeconds)
  const list = Array.isArray(history) ? history : []
  const since = Number(nowMs) - windowSeconds * 1000
  const speakers = new Set()
  let count = 0
  for (const h of list) {
    if (!h || h.role !== 'user') continue
    const at = Number(h.at || 0)
    if (!at || at < since) continue
    count++
    if (h.userId) speakers.add(String(h.userId))
  }
  return { count, speakers: speakers.size, since }
}

/**
 * 最近 limit 条消息里的说话人集合（@ 号校验用）。
 *
 * @param {Array} history
 * @param {number} [limit]
 * @returns {Set<string>}
 */
export function recentSpeakers(history, limit = QUOTE_DEFAULTS.atWindowMessages) {
  const list = Array.isArray(history) ? history : []
  const set = new Set()
  let seen = 0
  for (let i = list.length - 1; i >= 0 && seen < limit; i--) {
    const h = list[i]
    if (!h || h.role !== 'user') continue
    seen++
    if (h.userId) set.add(String(h.userId))
  }
  return set
}

/**
 * 上一条「不是她自己发」的消息（纯叫醒时用它当引用目标）。
 * 她自己发的历史记账 id 是 `self-<时间戳>`，不能拿来引用，跳过。
 *
 * @param {Array} history
 * @param {number} [limit]
 * @returns {{messageId:string, userId:string, who:string}|null}
 */
export function lastOtherMessage(history, limit = 40) {
  const list = Array.isArray(history) ? history : []
  let seen = 0
  for (let i = list.length - 1; i >= 0 && seen < limit; i--) {
    const h = list[i]
    if (!h || h.role !== 'user') continue
    seen++
    const id = h.messageId == null ? '' : String(h.messageId)
    if (!id || id.startsWith('self-')) continue
    return { messageId: id, userId: String(h.userId || ''), who: String(h.who || '') }
  }
  return null
}

/**
 * 某个 QQ 最近发的一条（引用目标用）。
 *
 * 2026-10-26，主人 m0xxxx：「引用不能精确」——她回的是甲，引用框却挂在
 * 「触发这一轮的最后一条消息」上（往往是乙）。模型既然写了 <at>甲</at>，
 * 就说明这话是接甲的，引用框也该落在甲那条上。
 *
 * @param {Array} history
 * @param {string} userId
 * @param {number} [limit]
 * @returns {{messageId:string, userId:string, who:string}|null}
 */
export function lastMessageFrom(history, userId, limit = 40) {
  const qq = String(userId || '')
  if (!qq) return null
  const list = Array.isArray(history) ? history : []
  let seen = 0
  for (let i = list.length - 1; i >= 0 && seen < limit; i--) {
    const h = list[i]
    if (!h || h.role !== 'user') continue
    seen++
    if (String(h.userId || '') !== qq) continue
    const id = h.messageId == null ? '' : String(h.messageId)
    if (!id || id.startsWith('self-')) return null
    return { messageId: id, userId: qq, who: String(h.who || '') }
  }
  return null
}

/**
 * 校验模型写的 @ 号。
 *
 * 规则（宁可少 @ 一个，也别 @ 错人）：
 *   1. 必须是 5–12 位数字，且不能是我自己；
 *   2. 必须在「最近 20 条消息的说话人」里 → 认；
 *   3. 不在最近说话人里：只有历史里确实出现过这个号、**且正文点了他的名字**，才认；
 *   4. 其他一律丢弃（调用方退回「不 @」）。
 *
 * @param {{raw?:string, history?:Array, selfId?:string, text?:string, limit?:number}} input
 * @returns {{qq:string, why:string}|null}
 */
export function resolveExplicitAt(input = {}) {
  const qq = String(input.raw || '').trim()
  if (!/^\d{5,12}$/.test(qq)) return null
  const selfId = String(input.selfId || '')
  if (selfId && qq === selfId) return null
  const history = Array.isArray(input.history) ? input.history : []
  const limit = Number(input.limit ?? QUOTE_DEFAULTS.atWindowMessages)
  if (recentSpeakers(history, limit).has(qq)) return { qq, why: 'recent' }
  const text = String(input.text || '')
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]
    if (!h || h.role !== 'user') continue
    if (String(h.userId || '') !== qq) continue
    const who = String(h.who || '').trim()
    if (who && text.includes(who)) return { qq, why: 'named' }
    return null
  }
  return null
}

/**
 * 决定这次要不要带引用、引哪一条。返回 null 表示不带引用。
 *
 * 命中任一条件就引用：
 *   - nudge     ：对方只是 @ 了她、没正文（上面那种空的 @）→ 引「上一条非自己的消息」；
 *   - crowded   ：windowSeconds 内别人的消息 ≥ minMessages 且说话人 ≥ minSpeakers；
 *   - explicit-at：模型显式点名了别人（引用 + @ 一起说清在回谁）。
 * 引用目标默认是触发消息本身（nudge 时换成上一条非自己的消息）。
 *
 * @param {{ev?:object, history?:Array, scene?:string, explicitAt?:string, config?:object, nowMs?:number}} input
 * @returns {{messageId:string, why:string, nudge:boolean, count:number, speakers:number}|null}
 */
export function pickQuoteTarget(input = {}) {
  const ev = input.ev
  if (!ev || ev.message_type !== 'group') return null
  const config = input.config || {}
  if (config.groupQuoteReply === false) return null
  const windowSeconds = Number(config.groupQuoteWindowSeconds ?? QUOTE_DEFAULTS.windowSeconds)
  const minMessages = Number(config.groupQuoteMinMessages ?? QUOTE_DEFAULTS.minMessages)
  const minSpeakers = Number(config.groupQuoteMinSpeakers ?? QUOTE_DEFAULTS.minSpeakers)
  const history = Array.isArray(input.history) ? input.history : []
  const nudge = isPureNudge(ev)
  const crowd = crowdStats(history, Number(input.nowMs ?? Date.now()), { windowSeconds })
  const crowded = crowd.count >= minMessages && crowd.speakers >= minSpeakers
  const reasons = []
  if (nudge) reasons.push('nudge')
  if (crowded) reasons.push('crowded')
  if (input.explicitAt) reasons.push('explicit-at')
  if (!reasons.length) return null

  const triggerId = ev.message_id == null ? '' : String(ev.message_id)
  let target = null
  /*
   * 优先按模型点名的号锁定引用目标（2026-10-26，主人：「引用不能精确」）。
   * 她写了 <at>甲</at>，引用框就落在甲最近那条上，而不是「触发这一轮的最后一条」。
   */
  if (input.explicitAt) target = lastMessageFrom(history, input.explicitAt)
  if (!target && nudge) target = lastOtherMessage(history)
  if (!target && triggerId && !triggerId.startsWith('self-')) target = { messageId: triggerId }
  if (!target || !target.messageId) return null
  if (String(target.messageId).startsWith('self-')) return null
  return {
    messageId: String(target.messageId),
    why: reasons.join('+'),
    nudge,
    count: crowd.count,
    speakers: crowd.speakers,
  }
}

/**
 * 引用回复不能带语音（主人 m03353：QQ 端「引用 + 语音」这条根本发不出去）。
 * 一次回复只要决定挂引用框，就把所有语音段降级成文字：内容不丢，
 * 只是不再发 record 段，也不会因为 record 被拒收而整条丢消息。
 */
export function shouldDemoteVoice({ isGroup = false, quoteTarget = '' } = {}) {
  return Boolean(isGroup && quoteTarget)
}

/**
 * 语音段 → 文字段：保留文字内容、丢掉文件引用，不改原对象。
 * 文字为空时返回 null（调用方应丢弃这一段，不要发空消息）。
 */
export function voicePartToText(part) {
  const text = String(part?.text || '').trim()
  if (!text) return null
  const { file, ...rest } = part || {}
  return { ...rest, type: 'text', text }
}

export default {
  QUOTE_DEFAULTS,
  isPureNudge,
  crowdStats,
  recentSpeakers,
  lastOtherMessage,
  resolveExplicitAt,
  pickQuoteTarget,
  shouldDemoteVoice,
  voicePartToText,
}
