/*
 * web-lookup.js —— 聊天面的「查一下」（2026-11-21，主人转来的群截图）
 *
 * 事故：群里孤星两次怼她「你说话之前不开联网搜索和思考吗？天天不懂乱说」，
 * 起因是她断言「Anthropic 还没上市吧？哪来的发行价 83 刀」——而 11-19 它就上市了，
 * 发行价正好 83 美元，一次搜索就能查到。她的问题不是态度，是**手里没有网**：
 * commands.js 的 CHAT_DENY_TOOLS 把 web_search / web_fetch / research 全禁掉了
 * （那是「聊天时不许动主人文件」那轮的产物，连只读搜索一起误伤）。
 *
 * 这一层做的事：给聊天面一个**只读**的搜索工具 web_lookup —— 只发一个查询词，
 * 拿回几条网页标题 + 摘要 + 链接。不碰文件、不碰 shell、不读记忆、不写盘。
 * 走的是 lib/webview.js 里现成的 Bing RSS（国内直连、无 key、实测 300ms 上下），
 * 不用国外 API、不用代理。
 *
 * 边界（都写进工具描述里，让模型自己判断）：
 *   · 只用来查「世界上发生过的事」：新公司动态、股价/上市、日期、版本号、比赛结果、
 *     人物身份、新闻。不查私聊内容、日记、后台地址、密码这些（persona 里已经写过）。
 *   · 拿回来的只是网页摘要，可能过时，也可能有错——所以要交代「这是搜到的」，
 *     别当成亲眼所见；查不到就说查不到。
 */

import { searchBing } from './webview.js'

export const WEB_LOOKUP_TOOL_NAME = 'web_lookup'
export const DEFAULT_LIMIT = 3
export const DEFAULT_TIMEOUT_MS = 8000
const MAX_QUERY_CHARS = 120

/** 查询词擦一擦：去掉换行和多余空白，太长就截断（Bing 也不喜欢超长词）。 */
export function normalizeQuery(raw) {
  const q = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  return q.length > MAX_QUERY_CHARS ? q.slice(0, MAX_QUERY_CHARS) : q
}

/** limit 收进 1..5 —— 群里贴五条以上没人看，也容易刷屏。 */
export function clampLimit(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return DEFAULT_LIMIT
  return Math.min(5, Math.max(1, Math.trunc(n)))
}

/**
 * 把搜索结果排成人话。要求：
 *   · 一条一行，标题 + 摘要，链接单独一行（QQ 会自动识别链接）
 *   · 明确说「这是搜到的摘要」，别让她复述成「我确认过」
 *   · 一条都没有时给一句收口的话，不要空着
 */
export function formatLookupText(query, results, { provider = 'bing-rss', ms = 0 } = {}) {
  const q = String(query || '')
  const list = Array.isArray(results) ? results : []
  if (!list.length) {
    return `「${q}」搜了，没搜到像样的结果。这种就别硬答了，直接说没查到。`
  }
  const head = `查了「${q}」（Bing，${list.length} 条，${Math.max(1, Math.round(ms / 100) / 10)}s）`
  const lines = [head]
  list.forEach((it, i) => {
    const title = String(it?.title || '').trim()
    const snippet = String(it?.snippet || '').trim()
    const url = String(it?.url || '').trim()
    lines.push('')
    lines.push(`${i + 1}. ${title || url}`)
    if (snippet) lines.push(snippet)
    if (url) lines.push(url)
  })
  lines.push('')
  lines.push('（以上是网页摘要，可能过时或有错；回答时按「我查到」说，别当成你亲眼确认过。provider=' + provider + '）')
  return lines.join('\n')
}

/**
 * 真正的执行体：查一次，回 { ok, query, text }。
 * search 可注入，测试里不发网络。
 */
export async function webLookup(rawQuery, { limit = DEFAULT_LIMIT, timeoutMs = DEFAULT_TIMEOUT_MS, search = searchBing } = {}) {
  const query = normalizeQuery(rawQuery)
  if (!query) {
    return { ok: false, query: '', text: '查什么？给我个关键词，比如「Anthropic 上市 发行价」。' }
  }
  const max = clampLimit(limit)
  try {
    const res = await search(query, { limit: max, timeoutMs })
    const results = Array.isArray(res?.results) ? res.results.slice(0, max) : []
    return {
      ok: true,
      query,
      text: formatLookupText(query, results, { provider: res?.provider || 'bing-rss', ms: res?.ms || 0 }),
    }
  } catch (err) {
    const why = String(err?.message || err).slice(0, 80)
    return { ok: false, query, text: `没查成（${why}）。别编，直接跟他说「我这边没查到」。` }
  }
}

/**
 * 工具定义。描述里写清「什么时候该主动查」，这是让模型自己判断的唯一手段。
 */
export function buildWebLookupTool({ getConfig = () => ({}), search = searchBing } = {}) {
  const cfg = () => {
    try {
      return getConfig() || {}
    } catch {
      return {}
    }
  }

  return {
    name: WEB_LOOKUP_TOOL_NAME,
    description: [
      '联网查一下：给个关键词，拿回几条网页标题、摘要和链接（Bing，国内直连）。',
      '该主动用的情况：说到最近发生的事、具体数字、日期、股价/上市/融资、公司动态、产品版本、比赛结果、',
      '某个人的身份或近况——只要你不确定，就先查一眼再开口，别凭印象断言（尤其别说「XX 还没上市吧」这种）。',
      '对方明确说「你查一下 / 联网搜搜 / 别瞎说」时，也用它，别再嘴硬。',
      '不该用的：私聊内容、日记、后台地址、密码这类不能当关键词；也不要拿它查聊天记录——那是另一套检索。',
      '拿回来的只是网页摘要，可能过时或有错：回答时按「我查到」说，查不到就说查不到，别把摘要说成你亲眼确认过。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，一行，别超过 120 字。' },
        limit: { type: 'integer', description: '要几条结果，1..5，默认 3。' },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          query: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['ok', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args = {}) {
      const c = cfg()
      const timeoutMs = Number(c.webLookupTimeoutMs) > 0 ? Number(c.webLookupTimeoutMs) : DEFAULT_TIMEOUT_MS
      return webLookup(args.query, { limit: args.limit, timeoutMs, search })
    },
  }
}

/**
 * 注册进宿主 tools 服务。跟 anime_find 一样：注册失败只降级，绝不抛。
 *
 * 注意：聊天面的 deny 清单（commands.js 的 CHAT_DENY_TOOLS）里**不能**出现这个名字，
 * 否则注册了也会被 restrict 掉。名字故意叫 web_lookup 而不是 web_search，
 * 就是为了跟宿主那个（读整页、能带 shell 语义的）区分开。
 */
export function registerWebLookupTool({ ctx, getConfig = () => ({}), logger = () => {}, search = searchBing }) {
  const status = { name: WEB_LOOKUP_TOOL_NAME, registered: false, error: '' }
  let tools
  try {
    tools = typeof ctx?.get === 'function' ? ctx.get('tools') : ctx?.tools
  } catch (err) {
    status.error = `读不到 tools 服务：${err?.message || err}`
    logger('warn', `web_lookup 未注册：${status.error}`)
    return { status, dispose: null }
  }
  if (!tools?.register) {
    status.error = '宿主没有 tools 服务（或版本太旧）'
    logger('warn', `web_lookup 未注册：${status.error}`)
    return { status, dispose: null }
  }
  try {
    const dispose = tools.register(buildWebLookupTool({ getConfig, search }))
    status.registered = true
    logger('info', 'web_lookup 工具已注册：聊天里能自己查资料了（只读搜索）')
    return { status, dispose: typeof dispose === 'function' ? dispose : null }
  } catch (err) {
    status.error = err?.message || String(err)
    logger('warn', `web_lookup 注册失败：${status.error}`)
    return { status, dispose: null }
  }
}
