/**
 * 会话路由器（task-46，2026-10-20 主人拍板）。
 *
 * 目标：一条 QQ 消息该由哪条会话接——聊天（chat）、查询（work）、改代码（code）。
 * 三条会话各有独立 sessionId、独立模型、独立工具面（见 commands.js 的 role）。
 *
 * 判定顺序（**规则优先，模型只兜半确定**）：
 *   1. 显式覆盖 `#chat ` / `#work ` / `#code ` 前缀（前缀剥掉、不进正文）
 *   2. 现有 `commandPrefixes`（`命令 `）→ work
 *   3. 改代码意图词 + 同时出现文件/路径/代码词 → code
 *   4. 其余 → chat
 * 只有「意图词命中、但没提文件/路径」这种半确定情况才花一次极便宜的模型分类；
 * 解析失败按 chat。
 *
 * **兜底原则：判错必须错向权限最小的会话。**
 * chat 没有任何文件/命令工具，work 没有写工具，code 才有全套（且写盘过 guard）。
 * 所以宁可把一条模糊消息当闲聊，也不要把它送进 code。
 *
 * 这个文件不依赖 commands.js / engine.js，方便单测直接 import。
 */

export const ROUTES = ['chat', 'work', 'code']

/** 显式覆盖前缀：`#chat 你好`、`#code 把 engine.js 改一下` */
export const OVERRIDE_RE = /^#(chat|work|code)(?=\s|$|[:：,，、-])[\s:：,，、-]*/i

/**
 * 改代码意图词。
 *
 * 按主人给的清单：改|修|加|删|重构|提交|部署|写个插件|改一下|改成。
 * 单字「改」「修」「加」「删」必须和上下文词**同时**出现才判 code，否则
 * 「今天天气加件衣服」会被误判——那种情况走「半确定 → 模型兜底」。
 */
export const CODE_INTENT_RE =
  /(重构|提交|部署|回滚|合并|写个插件|写个脚本|改一下|改成|改掉|修复|修一下|加上|加个|删掉|删了|[改修加删])/i

/**
 * 文件/路径/代码上下文词。只有和意图词**同时**出现才判 code。
 *
 * 刻意**不含**「代码」二字：「你会改代码吗」这种是半确定，交给模型兜底；
 * 真让你改代码的人通常会带文件名/路径/函数名。
 */
export const CODE_CONTEXT_RE =
  /(\.(?:js|mjs|cjs|ts|tsx|json|yml|yaml|md|css|html|ps1|py|sh|toml|ini)\b|lib[\\/]|src[\\/]|plugin[\\/]|engine\.js|package\.json|函数|方法|配置|源码|diff|patch)/i

/** 从消息里剥掉 `#chat/#work/#code` 前缀。
 * @returns {{route: 'chat'|'work'|'code'|null, text: string, raw: string}}
 */
export function stripOverride(text) {
  const raw = String(text || '')
  const m = raw.match(OVERRIDE_RE)
  if (!m) return { route: null, text: raw, raw }
  return { route: m[1].toLowerCase(), text: raw.slice(m[0].length).trim(), raw }
}

/** 命中现有 commandPrefixes 就把前缀剥掉；没命中返回 null。 */
export function matchCommandPrefix(text, prefixes = []) {
  const s = String(text || '')
  for (const p of prefixes) {
    if (p && s.startsWith(p)) return s.slice(p.length).trim()
  }
  return null
}

/** 纯表情/纯标点/空消息：一定是闲聊。 */
export function isTrivial(text) {
  const s = String(text || '').trim()
  if (!s) return true
  // 去掉空白、标点、符号、emoji 之后什么都不剩
  const core = s.replace(/[\p{P}\p{S}\p{Z}\s]/gu, '')
  return core.length === 0
}

/**
 * 规则层判定（不花 token）。
 *
 * @returns {{route: 'chat'|'work'|'code', by: 'override'|'rule', why: string, text: string}
 *          | {route: null, by: 'model', why: string, text: string}}
 *   route=null 表示「半确定，交给模型分类」。
 */
export function ruleRoute({ text, prefixes = [] } = {}) {
  const raw = String(text || '')
  const ov = stripOverride(raw)
  if (ov.route) {
    return { route: ov.route, by: 'override', why: `显式前缀 #${ov.route}`, text: ov.text }
  }
  const body = raw.trim()
  if (isTrivial(body)) {
    return { route: 'chat', by: 'rule', why: '空消息/纯表情', text: body }
  }
  const cmd = matchCommandPrefix(body, prefixes)
  if (cmd !== null) {
    return { route: 'work', by: 'rule', why: `命令前缀（${prefixes.find((p) => p && body.startsWith(p)) || '命令'}）→ 查询会话`, text: cmd }
  }
  const intent = CODE_INTENT_RE.test(body)
  const context = CODE_CONTEXT_RE.test(body)
  if (intent && context) {
    return { route: 'code', by: 'rule', why: '改代码意图 + 文件/代码上下文', text: body }
  }
  if (intent && !context) {
    // 半确定：只有意图词，没法确定是不是在说代码。交给模型分类，失败按 chat。
    return { route: null, by: 'model', why: '改代码意图但没提文件/路径', text: body }
  }
  return { route: 'chat', by: 'rule', why: '无指令/无改代码特征', text: body }
}

/** 模型分类器的 system prompt（极短，maxTokens 32 就够）。 */
export const CLASSIFY_SYSTEM = [
  '你只做一件事：判断用户这句话该交给哪种会话。',
  'chat = 闲聊/情绪/记忆类对话；work = 查询信息、跑只读操作、发消息；code = 改代码/改配置/改插件。',
  '只输出 JSON：{"route":"chat"} / {"route":"work"} / {"route":"code"}，不要输出别的字。',
  '拿不准就输出 chat（chat 权限最小，判错也不伤人）。',
].join('\n')

/** 解析模型分类结果；任何异常都回 chat。 */
export function parseRouteAnswer(text) {
  const s = String(text || '')
  const m = s.match(/"route"\s*:\s*"(chat|work|code)"/i)
  if (m) return m[1].toLowerCase()
  const bare = s.trim().toLowerCase()
  if (ROUTES.includes(bare)) return bare
  return 'chat'
}

/**
 * 完整路由：规则 → 半确定才问模型 → 默认 chat。
 *
 * @param {object} opts
 * @param {string} opts.text
 * @param {string[]} [opts.prefixes]
 * @param {(text: string) => Promise<'chat'|'work'|'code'|null>} [opts.classify] 模型兜底
 * @returns {Promise<{route: 'chat'|'work'|'code', by: 'override'|'rule'|'model', why: string, text: string, modelError?: string}>}
 */
export async function routeMessage({ text, prefixes = [], classify } = {}) {
  const base = ruleRoute({ text, prefixes })
  if (base.route) return base
  let route = 'chat'
  let why = '模型兜底（未给出）'
  let modelError = ''
  if (typeof classify === 'function') {
    try {
      const answer = await classify(base.text)
      if (answer) {
        route = answer
        why = `模型兜底：${base.why} → ${answer}`
      }
    } catch (err) {
      modelError = String(err?.message || err)
      why = `模型兜底失败（按 chat）：${modelError}`
    }
  }
  return { route, by: 'model', why, text: base.text, modelError }
}
