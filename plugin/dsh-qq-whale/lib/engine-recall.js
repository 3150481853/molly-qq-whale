/*
 * 撤回处理（2026-10-24，主人 m00480 需求②）。
 *
 * 真机症状：有人发错一条消息、撤回、再重发一条，Molly 回的是**撤回掉的那条**
 * （甚至在那条被撤回后还在继续生成/发送），看起来像"对着空气说话"。
 *
 * 根因：SnowLuma 的撤回通知（notice: group_recall / friend_recall）在
 * lib/main.js 的 notice 分支里没有分支处理，直接被丢掉了；engine 里也没有
 * 任何「这条消息已经不存在」的状态，于是：
 *   - conv.history 里还留着撤回内容 → 后面每次生成都把它当上下文；
 *   - 防抖/排队/生成中的回复照常发出去；
 *   - 45 秒同文去重（_recentSent）还会把「对方重发后」的正常回复吞掉。
 *
 * 这个模块只放**纯函数**：解析事件字段、清理过期记录、按 message_id 剔除
 * history / pending。状态本身（Map、计数器）留在 engine 里，方便 /state 观察
 * 和离线单测（tools/recall-test.mjs）。
 *
 * OneBot 字段（以 SnowLuma 打包源码 ${MOLLY_ROOT}\snowluma\index.mjs 为准）：
 *   群：{ notice_type:'group_recall', group_id, operator_id, user_id, message_id }
 *       —— user_id 是被撤回消息的作者，operator_id 是动手撤回的人（可能是管理员）。
 *   私聊：{ notice_type:'friend_recall', user_id, message_id }（没有 group_id/operator_id）
 *   message_id 由 SnowLuma 用与普通消息同一个 resolver 生成，可直接与入站
 *   message_id 精确比对（线上可能是负数 int32，所以一律按字符串处理）。
 */

/** 撤回记录保留时长：10 分钟足够覆盖「撤回 → 重发 → 回复」这一段。 */
export const RECALL_TTL_MS = 10 * 60 * 1000

/** 撤回记录上限，防止长期运行无限涨。 */
export const RECALL_MAX = 500

/**
 * 撤回后的「轻回一句」台词池（用户 m00585 决策：群里也轻回一句）。
 *
 * 原则：只说人话、不客服腔、不超过 10 个字；具体发不发由 engine 按
 * 概率 + 延迟 + 「有没有新消息」决定，这里只提供候选文本。
 */
export const RECALL_WHISPER_LINES = [
  '诶？那条呢',
  '你撤回了啥',
  '我还没看完呢',
  '手滑了？',
  '刚那条我当没看见',
  '怎么又收回去了',
  '嗯？没了？',
]

/** 取撤回事件的 message_id；取不到/为 0 时返回空串（调用方据此放弃匹配）。 */
export function recallMessageId(ev) {
  const raw = ev?.message_id ?? ev?.messageId ?? ''
  const text = String(raw ?? '').trim()
  if (!text || text === '0' || text === 'undefined' || text === 'null') return ''
  return text
}

/** 撤回事件对应的会话 key（与 engine.conversationKey 的格式保持一致）。 */
export function recallKeyOf(ev) {
  const type = String(ev?.notice_type || ev?.noticeType || '')
  if (type === 'group_recall') {
    const gid = ev?.group_id ?? ev?.groupId
    return gid ? `group:${gid}` : ''
  }
  if (type === 'friend_recall') {
    const uid = ev?.user_id ?? ev?.userId
    return uid ? `private:${uid}` : ''
  }
  return ''
}

/** 被撤回消息的作者 QQ 号（群撤回里 user_id 才是作者）。 */
export function recallAuthorId(ev) {
  const type = String(ev?.notice_type || ev?.noticeType || '')
  if (type === 'group_recall' || type === 'friend_recall') return String(ev?.user_id ?? '')
  return ''
}

/** 清理过期/超量的撤回记录，返回删掉的条数。 */
export function pruneRecalled(map, now = Date.now()) {
  if (!map || typeof map.delete !== 'function') return 0
  let dropped = 0
  for (const [key, at] of map) {
    if (!(at > 0) || now - at > RECALL_TTL_MS) {
      map.delete(key)
      dropped += 1
    }
  }
  while (map.size > RECALL_MAX) {
    const first = map.keys().next()
    if (first.done) break
    map.delete(first.value)
    dropped += 1
  }
  return dropped
}

/**
 * 从会话历史里剔除某条消息（按 messageId 精确匹配）。
 *
 * 注意：只删 user 条目里带 messageId 的那种；assistant 条目记的是
 * `self-<ts>`，本来就不会撞上。
 */
export function purgeHistory(conv, messageId) {
  if (!conv || !Array.isArray(conv.history) || !messageId) return 0
  const target = String(messageId)
  const before = conv.history.length
  conv.history = conv.history.filter((entry) => String(entry?.messageId ?? '') !== target)
  return before - conv.history.length
}

/** 从任务排队里剔除某条消息（避免「撤回的那条」在队列里再回一次）。 */
export function filterPending(job, messageId) {
  if (!job || !Array.isArray(job.pending) || !messageId) return 0
  const target = String(messageId)
  const before = job.pending.length
  job.pending = job.pending.filter((p) => String(p?.ev?.message_id ?? '') !== target)
  return before - job.pending.length
}

/** 随机挑一句轻回台词（rand 可以是函数也可以是 0~1 的数，注入是为了单测确定性）。 */
export function pickWhisperLine(rand = Math.random) {
  const raw = typeof rand === 'function' ? Number(rand()) : Number(rand)
  const r = Number.isFinite(raw) ? raw : 0
  const lines = RECALL_WHISPER_LINES
  const idx = Math.min(lines.length - 1, Math.max(0, Math.floor(r * lines.length)))
  return lines[idx]
}
