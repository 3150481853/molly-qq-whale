/*
 * 「明确要求发群里」判定 + 长文分条（2026-10-24，主人 m00480 需求①）。
 *
 * 现场：群里有人让 Molly 翻译一段东西，她回「细节我私聊你」；对方第二遍说
 * 「你就在群里发」，她还是推私聊。她自己后来说「群里懒得刷一大段」——
 * 也就是说，真正的开关有两层：
 *   1. persona/core.md 的「群里别贴长文，细节私聊说」；
 *   2. switches.js 的 180 字长度线（超了就截断 + 加「细节私聊」后缀）。
 * 对方已经**明确要求**、甚至**第二次坚持**的时候，这两层都该让路——人家
 * 就是想让大家看见。但仍然有底线：真代码/日志/隐私不发（那条安全线不放宽）。
 *
 * 这个模块只做纯计算，不碰 socket、不碰 engine 的 this：
 *   - detectGroupEcho：这一轮该不该「群里照发」
 *   - planEchoBubbles：长文本按句拆成多颗气泡（≤maxBubbleChars/颗、总量封顶）
 *
 * 注意：判定必须在 generate 之前，这样才能把「这次要在群里发」写进 system prompt，
 * 让模型自己就按「分条、别推私聊」来组织话；只在 deliver 放行是不够的。
 */

/** 一次「群里照发」默认管多久（毫秒）。 */
export const GROUP_ECHO_DEFAULT_TTL_MS = 180 * 1000

/** 她说「私聊」之后，多久之内的追问算「第二次坚持」。 */
export const GROUP_ECHO_REPEAT_WINDOW_MS = 300 * 1000

/** 历史兜底：多久之内有人明确说过「发群里」，后续这条继续按群发算。 */
export const GROUP_ECHO_HISTORY_WINDOW_MS = 180 * 1000

export const GROUP_ECHO_DEFAULT_MAX_BUBBLE_CHARS = 400
export const GROUP_ECHO_DEFAULT_MAX_TOTAL_CHARS = 1200

const GROUP_SCENES = new Set(['group_mention', 'group_bystander'])

/**
 * 「就在群里发/别私聊/公开说」这类明确要求。
 * 只认「要发在群里」的意图，不认「别在群里发」（后者由 NEGATIVE 挡掉）。
 */
const EXPLICIT_PATTERNS = [
  /发(?:到|进|在)?群里/u,
  /群里(?:发|说|贴|讲|打|念|写|回)/u,
  /(?:就|直接)(?:在)?这(?:儿|里)?(?:发|说|贴|讲|打|念)/u,
  /在这(?:儿|里)(?:发|说|贴|讲|打|念)/u,
  /别(?:私聊|私信)/u,
  /不(?:用|要|许)(?:私聊|私信)/u,
  /公开(?:发|说|讲|贴)/u,
  /当众(?:发|说|讲|贴)/u,
  /让(?:大家|他们|别人|群里)(?:都)?(?:看|听|知道)/u,
  /(?:念|发|贴|打)出来/u,
  /发出来(?:看看|看看|嘛)?/u,
  /直接(?:发|说|贴|念)(?:出来)?/u,
]

/** 反例：明确说「别在群里发」。命中的话，任何关键词都不算数。 */
const NEGATIVE_PATTERNS = [
  /别(?:在群里|在群里|发群里|发到群里|往群里|在群里发)/u,
  /不(?:要|许|准)(?:在群里|发群里|发到群里|往群里)/u,
  /别(?:发|贴|说)(?:到|在)?群/u,
]

/** 她说「私聊」之后，对方带这些词 = 在催 / 在坚持。 */
const URGE_PATTERNS = [
  /再(?:发|说|贴|讲|来)/u,
  /发(?:吧|啊|呗|出来|一下|给我)/u,
  /(?:贴|放|摆|扔)(?:出来|上来|进来)/u,
  /就(?:在)?这(?:儿|里)?(?:发|说|贴|讲)/u,
  /直接(?:发|说|贴|来)/u,
  /(?:喂|喂喂|人呢|咋不|怎么不|快点|赶紧)/u,
  /(?:你)(?:倒是)?(?:发|说|贴)/u,
]

function coreText(s) {
  return String(s || '')
    .replace(/[\p{P}\p{S}\p{Z}\s]/gu, '')
    .toLowerCase()
}

function bigrams(s) {
  const out = new Set()
  const n = String(s || '')
  if (n.length < 2) return out
  for (let i = 0; i < n.length - 1; i++) out.add(n.slice(i, i + 2))
  return out
}

/** 交集 / 较小集合大小（和 dedupe.js 的口径一致，避免两套相似度）。 */
function containment(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return inter / Math.min(A.size, B.size)
}

/**
 * 找「她上一条回复在推私聊」这件事。
 *
 * 只看最后一条 assistant：如果最后一条她没提私聊，那就不是这个场景
 * （往回翻会把半小时前的「私聊」翻出来，误伤正常聊天）。
 */
function lastPrivateReply(history, since) {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i]
    if (!h || h.role !== 'assistant') continue
    if (Number(h.at || 0) < since) return null
    if (!/私聊|私信/.test(String(h.text || ''))) return null
    let userText = ''
    for (let j = i - 1; j >= 0; j--) {
      if (history[j]?.role === 'user') {
        userText = String(history[j].text || '')
        break
      }
    }
    return { at: Number(h.at || 0), userCore: coreText(userText) }
  }
  return null
}

/**
 * 判定这一轮要不要「群里照发」。
 *
 * @param {{text?:string, scene?:string, conv?:object, now?:number, repeatWindowMs?:number, historyWindowMs?:number}} input
 * @returns {{active:boolean, why:string}}
 */
export function detectGroupEcho(input = {}) {
  const { text, scene, conv, now = Date.now() } = input
  if (!GROUP_SCENES.has(String(scene || ''))) return { active: false, why: '' }
  const raw = String(text || '').trim()
  if (!raw) return { active: false, why: '' }

  const negated = NEGATIVE_PATTERNS.some((re) => re.test(raw))
  if (!negated && EXPLICIT_PATTERNS.some((re) => re.test(raw))) {
    return { active: true, why: 'explicit' }
  }

  const repeatWindowMs = Number(input.repeatWindowMs) > 0 ? Number(input.repeatWindowMs) : GROUP_ECHO_REPEAT_WINDOW_MS
  const historyWindowMs =
    Number(input.historyWindowMs) > 0 ? Number(input.historyWindowMs) : GROUP_ECHO_HISTORY_WINDOW_MS
  const history = Array.isArray(conv?.history) ? conv.history : []

  // 第二次坚持：上一轮她说「私聊」，这一轮对方在催 / 把同样的话重贴一遍。
  const lastPrivate = lastPrivateReply(history, now - repeatWindowMs)
  if (lastPrivate) {
    const core = coreText(raw)
    if (URGE_PATTERNS.some((re) => re.test(raw))) return { active: true, why: 'repeat-urge' }
    if (lastPrivate.userCore && containment(core, lastPrivate.userCore) >= 0.6) {
      return { active: true, why: 'repeat-repost' }
    }
  }

  // 历史兜底：三分钟内有人明确说过「发群里/别私聊」，这条继续算群发。
  const recent = history
    .filter((h) => h && h.role === 'user' && Number(h.at || 0) >= now - historyWindowMs)
    .slice(-8)
  for (const h of recent) {
    const t = String(h.text || '')
    if (!t || NEGATIVE_PATTERNS.some((re) => re.test(t))) continue
    if (EXPLICIT_PATTERNS.some((re) => re.test(t))) return { active: true, why: 'history' }
  }

  return { active: false, why: '' }
}

/** 按句号/问叹号/换行切句；单句过长时再按长度硬切，保证每块 ≤ maxLen。 */
function splitSentences(text, maxLen) {
  const raw = String(text || '')
  const pieces = raw
    .split(/(?<=[。！？!?；;~～])|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean)
  const out = []
  for (const p of pieces) {
    if (p.length <= maxLen) {
      out.push(p)
      continue
    }
    for (let i = 0; i < p.length; i += maxLen) out.push(p.slice(i, i + maxLen))
  }
  return out.length ? out : [raw]
}

/**
 * 把 splitReply 出来的 parts 重排成「群里照发」的样子：
 *   - 文本段按句拆成多颗气泡，每颗 ≤ maxBubbleChars；
 *   - 总量封顶 maxTotalChars，超了就在末尾诚实说一句「太长先贴到这儿」；
 *   - 贴纸/语音段原样保留；
 *   - atQq 只留在第一颗文字气泡上（和 splitReply 的约定一致）。
 *
 * @param {Array<object>} parts
 * @param {{maxBubbleChars?:number, maxTotalChars?:number}} opts
 * @returns {{parts: Array<object>, truncated: boolean}}
 */
export function planEchoBubbles(parts, opts = {}) {
  const list = Array.isArray(parts) ? parts : []
  const maxBubble = Math.max(60, Number(opts.maxBubbleChars) || GROUP_ECHO_DEFAULT_MAX_BUBBLE_CHARS)
  const maxTotal = Math.max(maxBubble, Number(opts.maxTotalChars) || GROUP_ECHO_DEFAULT_MAX_TOTAL_CHARS)
  const out = []
  let used = 0
  let truncated = false

  const pushText = (text, atQq) => {
    const t = String(text || '').trim()
    if (!t) return
    const part = { type: 'text', text: t }
    if (atQq) part.atQq = atQq
    out.push(part)
    used += t.length
  }

  for (const part of list) {
    if (!part || part.type !== 'text') {
      out.push(part)
      continue
    }
    let atQq = part.atQq || ''
    const chunks = splitSentences(part.text, maxBubble)
    let buf = ''
    for (const chunk of chunks) {
      if (used >= maxTotal) {
        truncated = true
        break
      }
      const room = Math.min(maxBubble, maxTotal - used)
      if (chunk.length > room) {
        if (buf) {
          pushText(buf, atQq)
          atQq = ''
          buf = ''
        }
        pushText(chunk.slice(0, room), atQq)
        atQq = ''
        truncated = true
        continue
      }
      if (buf && buf.length + chunk.length > maxBubble) {
        pushText(buf, atQq)
        atQq = ''
        buf = chunk
      } else {
        buf += chunk
      }
    }
    if (buf && used < maxTotal) pushText(buf, atQq)
  }

  if (truncated) {
    out.push({ type: 'text', text: '（太长了，先贴到这儿；还要剩下的跟我说一声）' })
  }
  return { parts: out, truncated }
}
