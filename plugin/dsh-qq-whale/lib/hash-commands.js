/**
 * 私聊 `#` 命令通道（主人 m01007，2026-10-26）
 * ===========================================================================
 * 起因：主人说「我发命令结果提示权限不足，干脆简化一下，变成私聊发 `#` 给我一个菜单」。
 *
 * 原来那套是**自然语言路由**（commands.js 的 ROUTER_PROMPT）：她得先猜你想干嘛，
 * 猜成任务才去干活，猜成闲聊就只回一句话；而且判错方向时会被角色门挡回来。
 * 主人要的是一个不看运气、不看上下文、不花额度的入口：私聊发一个 `#`，直接给菜单。
 *
 * 三条硬规矩：
 *   1. **低层**：在 blindMode / 总开关之后的**模型链路之前**拦。整条消息就是一个
 *      `#命令` 时，不进聊天历史、不调模型、不花额度。闭眼模式照样应答
 *      （闭眼 = 不说话但活着，正是最需要查状态的时候）；总开关关了才彻底不吭声。
 *   2. **精确**：只认「整条消息是纯文本、且以 # 开头」。带图、带 @、带别的话都不算，
 *      免得群里随口一句就被当命令。
 *   3. **私聊详细、群里简约**（主人 m01116）：私聊回完整菜单/状态；群里只认
 *      `#molly` 这一条，且只回一行摘要（在线没在线 · 版本 · 记忆条数），
 *      只给主人和白名单群，30 秒一条，防刷屏。群里其它 `#` 一律当没看见。
 *      权限：私聊主人/管理员发才答，其他人回一句人话就吞掉；
 *      所有命令都是只读 —— 写库、改配置、重启仍然要她在聊天里确认。
 *
 * 纯函数（parse / 文案）与 IO（send）分开，tools 里能离线自测。
 */

import fs from 'node:fs'
import { createRoleGate, ROLE_GUEST } from './roles.js'

/**
 * 版本号：从包根的 package.json 读。
 *
 * 两种布局都要读得到（见 boot.js 的说明）：
 *   - 源码：`<包根>/lib/hash-commands.js` → `../package.json` = 包根 ✓
 *   - 热重载副本：`<包根>/gen-<rev>/hash-commands.js` → `../package.json` = 包根 ✓
 * 读不到就返回空串，文案退化成「未知版本」，绝不因为版本读不出来就不回话。
 */
const PKG_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return String(pkg?.version || '').trim()
  } catch {
    return ''
  }
})()

/** 当前版本号（读不到时为 '未知版本'）。 */
export function version() {
  return PKG_VERSION || '未知版本'
}

/** 出厂默认：开着。关掉等于这条通道不存在（聊天不受影响）。 */
export const DEFAULT_HASH_COMMANDS = Object.freeze({ enabled: true })

/**
 * 命令别名表。键一律小写、不带 `#`。
 *
 * 别名只做「同一个意思的不同写法」：中文为主，英文给习惯打英文的人。
 * 故意不做前缀匹配（`#记` 不等于 `#记忆`）——命令要精确，猜错比不回更烦人。
 */
export const ALIASES = Object.freeze({
  '': 'menu',
  '?': 'menu',
  '？': 'menu',
  help: 'menu',
  '菜单': 'menu',
  '帮助': 'menu',
  menu: 'menu',
  status: 'status',
  '状态': 'status',
  '在不在': 'status',
  memory: 'memory',
  '记忆': 'memory',
  '记得': 'memory',
  who: 'who',
  '谁': 'who',
  '认人': 'who',
  switches: 'switches',
  switch: 'switches',
  '开关': 'switches',
  /*
   * `#molly` 是老版本（v1.1.5 的 status-command.js）在群里查状态的触发词，
   * 回退时被一起移走了；主人 m01116 要求补回来，所以收回这套通道里。
   * 私聊等价于 `#状态`（详细），群里只给一行摘要 —— 见 createHashHandler。
   */
  molly: 'status',
})

/** 命令清单（菜单与「未知命令」提示的唯一来源，避免两处漂移）。 */
export const COMMANDS = Object.freeze([
  { cmd: 'status', usage: '#状态', desc: '在不在线 / 版本 / 模型 / 记忆条数' },
  { cmd: 'memory', usage: '#记忆 关键词', desc: '我到底记住了什么' },
  { cmd: 'who', usage: '#谁 名字或QQ', desc: '我认为这个人是谁（含我该怎么叫他）' },
  { cmd: 'switches', usage: '#开关', desc: '哪些功能开着' },
  { cmd: 'menu', usage: '#菜单', desc: '再发这张表' },
])

/**
 * 私聊菜单。
 *
 * 为什么要带版本号：主人现在正在回退验证，第一眼就得知道眼前这套是哪个版本。
 */
export function menuText({ version: v = '' } = {}) {
  const ver = v || PKG_VERSION || '未知版本'
  const lines = [
    `# 命令菜单（${ver}）`,
    '',
    '私聊直接发下面这一条就行，不用加别的话：',
    '',
  ]
  for (const c of COMMANDS) lines.push(`${c.usage.padEnd(14, ' ')}${c.desc}`)
  lines.push('', '群里发 `#molly` 只回一行摘要（版本 · 在不在线 · 运行时长）；详细内容只在私聊给。')
  lines.push('这些都是本地直读，不调模型、不花额度。干活还是直接跟我说话。')
  return lines.join('\n')
}

/**
 * 把 `state.link` 归一成 `{ready, state}`。
 *
 * 这个字段有两种历史写法：早期是 `{ready, state: 'online'}` 对象；现在
 * onebot.js 的 `setState(s)` 直接把**字符串**（'connecting' / 'handshaking' /
 * 'online' / 'reconnecting' / 'stopped'）回调出去，main.js 原样赋给
 * `state.link`。只按对象读的话 `.ready` 永远是 undefined ——
 * 于是 `#molly` 在群里一直回「没连上」，人看着就是「离线」
 * （2026-10-26 主人反馈：明明在群里回着话，#molly 却说离线）。
 *
 * web.js 的 snapshot() 早就做了同样的兼容（见那里的注释），这里是命令通道那份。
 *
 * @param {any} link
 * @returns {{ready: boolean, state: string}}
 */
export function linkInfo(link) {
  if (typeof link === 'string') {
    const state = link.trim()
    return { ready: state === 'online', state }
  }
  if (link && typeof link === 'object') {
    const state = String(link.state || '').trim()
    return { ready: !!link.ready || state === 'online', state }
  }
  return { ready: false, state: '' }
}

/** 链路状态 → 中文。不把 'connecting' 这类内部英文直接摊到群里。 */
export function linkWords(link) {
  const { ready, state } = linkInfo(link)
  if (ready) return '在线'
  if (state === 'connecting' || state === 'handshaking') return '连接中'
  if (state === 'reconnecting') return '断线重连中'
  if (state === 'stopped') return '已停止'
  return state || '没连上'
}

/**
 * 群里的一行摘要（主人 m01116：群里只要简约摘要，详细的留私聊）。
 *
 * 为什么只给一行：群里有 35 个人看着，状态细节（模型、开关、记忆条数）
 * 是主人自己的事，刷在群里既吵又泄露配置。一行足够回答「她还在不在」。
 * 2026-10-26 主人要求：记忆条数换成运行时长（"记忆 1305 条"在群里等于
 * 把她的库有多大摊开给人看，运行时长才是在回答"她醒着多久了"）。
 */
export function summaryText({ config = {}, getEnv = () => ({}) } = {}) {
  const env = getEnv() || {}
  const bits = [`Molly ${version()}`, linkWords(env.state?.link)]
  if (env.bootedAt) bits.push(`运行 ${humanDuration(Date.now() - Number(env.bootedAt))}`)
  if (config?.enabled === false) bits.push('总开关关着')
  return bits.join(' · ')
}

/**
 * 解析一条消息文本。
 *
 * @param {string} raw 整条消息的纯文本
 * @returns {{matched:boolean, cmd:string, rest:string, trigger:string}}
 *   matched=false 表示这条消息不是 `#` 命令（调用方应当放它去走聊天）；
 *   matched=true 而 cmd 不认识时，cmd 是原文（调用方回「没有这条」）。
 *   `trigger` 是命中的那个别名原文（小写、去 `#`）：群里要靠它区分
 *   「`#molly` 摘要」和「`#状态` 这种只该在私聊出现的命令」。
 */
export function parseHashCommand(raw) {
  const text = String(raw ?? '')
    .replace(/\u3000/g, ' ')
    .trim()
  if (!text.startsWith('#')) return { matched: false, cmd: '', rest: '', trigger: '' }
  const body = text.slice(1).trim()
  if (!body) return { matched: true, cmd: 'menu', rest: '', trigger: '' }
  const m = body.match(/^(\S+)\s*([\s\S]*)$/)
  const head = String(m?.[1] ?? '').toLowerCase()
  const rest = String(m?.[2] ?? '').trim()
  return { matched: true, cmd: ALIASES[head] || head, rest, trigger: head }
}

/**
 * 把 OneBot 消息段里的纯文本抠出来。
 *
 * 只要有一个非 text 段（at / image / face / reply / mface …）就返回 null：
 * 这是「整条消息就是一条命令」的口径，宁可漏判也别误判 ——
 * 误判的代价是群里一句带图的 # 就被吃掉，漏判的代价只是再发一次。
 */
function messageText(message) {
  if (typeof message === 'string') return message
  if (!Array.isArray(message) || message.length === 0) return null
  const parts = []
  for (const seg of message) {
    if (!seg || seg.type !== 'text') return null
    parts.push(String(seg?.data?.text ?? ''))
  }
  return parts.join('')
}

/** 毫秒 → 「3 天 4 小时」这种人话。 */
function humanDuration(ms) {
  const n = Number(ms)
  if (!Number.isFinite(n) || n < 0) return '未知'
  const s = Math.floor(n / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  const parts = []
  if (d) parts.push(`${d} 天`)
  if (h) parts.push(`${h} 小时`)
  if (!d && m) parts.push(`${m} 分`)
  return parts.length ? parts.join(' ') : `${s} 秒`
}

/** 开关的人话名。没登记的开关不显示（免得变成一张内部配置表）。 */
const SWITCH_LABELS = Object.freeze([
  { key: 'enabled', label: '总开关（会说话）' },
  { key: 'blindMode', label: '闭眼模式（只听不说）' },
  { key: 'voiceEnabled', label: '会发语音' },
  { key: 'stickerSprinkle', label: '补表情包' },
  { key: 'stickerLearn', label: '学别人的表情包' },
  { key: 'researchEnabled', label: '先查再说' },
])

const onoff = (v) => (v === false ? '关' : '开')

/** 记忆条目 → 一行。`谁` 只在有值时带上，别让每条都拖一截空括号。 */
function entryLine(e) {
  const who = String(e?.who || '').trim()
  const qq = String(e?.qq || '').trim()
  const tail = [who, qq].filter(Boolean).join(' / ')
  const kind = String(e?.kind || '?')
  const text = String(e?.text || '').replace(/\s+/g, ' ').trim()
  return `· [${kind}] ${text}${tail ? `（${tail}）` : ''}`
}

/**
 * 造一条命令的回复文本。
 *
 * 这里绝不做写操作：查记忆、读开关、读状态——都是只读。
 * 任何一段拿不到数据（engine 没起来、记忆坏了）都降级成一句话，不许抛。
 *
 * @param {{cmd:string, rest:string}} parsed
 * @param {{config?:object, getEnv?:Function, uid?:string}} opts
 * @returns {string}
 */
export function buildReply(parsed, { config = {}, getEnv = () => ({}) } = {}) {
  const cmd = String(parsed?.cmd || '')
  const rest = String(parsed?.rest || '').trim()

  if (cmd === 'menu') return menuText()

  if (cmd === 'status') {
    const env = getEnv() || {}
    const link = env.state?.link
    const model = env.state?.model || {}
    const mem = (() => {
      try {
        return env.engine?.memory?.status?.() || null
      } catch {
        return null
      }
    })()
    const lines = [`# 状态（${version()}）`]
    lines.push(`链路：${linkWords(link)}`)
    if (model?.ok) lines.push(`模型：${model.model || '?'}${model.fallback ? `（备用 ${model.fallback}）` : ''}`)
    else lines.push(`模型：不可用${model?.error ? `（${String(model.error).slice(0, 60)}）` : ''}`)
    if (mem) {
      lines.push(`记忆：${mem.count} 条${mem.encrypted ? '（加密）' : ''}${mem.broken ? ' — 钥匙不可用，已停止读写' : ''}`)
    }
    if (env.bootedAt) lines.push(`运行：${humanDuration(Date.now() - Number(env.bootedAt))}`)
    if (config?.enabled === false) lines.push('总开关：关（她不会主动说话）')
    return lines.join('\n')
  }

  if (cmd === 'memory') {
    if (!rest) return '用法：`#记忆 关键词`——比如 `#记忆 宝宝`。'
    const env = getEnv() || {}
    let items = []
    try {
      items = env.engine?.memory?.recall?.({ query: rest, limit: 8 }) || []
    } catch {
      items = []
    }
    if (!items.length) return `# 记忆：${rest}\n没找到。`
    return [`# 记忆：${rest}`, ...items.map(entryLine)].join('\n')
  }

  if (cmd === 'who') {
    if (!rest) return '用法：`#谁 名字` 或 `#谁 QQ号`。'
    const env = getEnv() || {}
    const mem = env.engine?.memory
    if (!mem) return '# 谁\n记忆模块没起来，查不了。'
    const isQq = /^[1-9]\d{4,11}$/.test(rest)
    let qq = isQq ? rest : ''
    let who = ''
    try {
      if (isQq) {
        const hit = mem.recall?.({ qq, limit: 1 }) || []
        who = String(hit[0]?.who || '').trim()
      } else {
        const hit = mem.recall?.({ query: rest, limit: 8 }) || []
        const mine = hit.find((e) => String(e?.who || '').includes(rest)) || hit[0]
        who = String(mine?.who || '').trim()
        qq = String(mine?.qq || '').trim()
      }
    } catch {
      /* 查不到就当没有，下面统一回「没印象」 */
    }
    if (!qq && !who) return `# 谁：${rest}\n没印象。`
    const names = (() => {
      try {
        return (mem.addressOf?.({ who, qq, limit: 8 }) || []).map((e) => e.name).filter(Boolean)
      } catch {
        return []
      }
    })()
    const lines = [`# ${who || rest}${qq ? `（${qq}）` : ''}`]
    lines.push(names.length ? `我叫他：${names.map((n) => `「${n}」`).join(' ')}` : '我叫他：没定过，用群名片或「你」。')
    let items = []
    try {
      items = mem.recall?.({ who, qq, limit: 5 }) || []
    } catch {
      items = []
    }
    if (items.length) lines.push('', ...items.map(entryLine))
    return lines.join('\n')
  }

  if (cmd === 'switches') {
    const lines = ['# 开关']
    for (const s of SWITCH_LABELS) lines.push(`${onoff(config?.[s.key])}  ${s.label}`)
    if (Number.isFinite(Number(config?.maxStickersPerReply))) lines.push(`    一轮最多 ${config.maxStickersPerReply} 张表情包`)
    return lines.join('\n')
  }

  return `没有 #${cmd} 这条。发 \`#\` 看菜单。`
}

/**
 * 建处理器。返回 { handle(ev) }：handle 返回 true = 这条消息已被吃掉，
 * 主链路必须 return，不能再往下走（跟 status-command 的口径一致）。
 */
export function createHashHandler({ config = {}, getEnv = () => ({}), logger = () => {}, onEvent = () => {}, send = null } = {}) {
  const gate = createRoleGate(config || {})
  const opt = () => {
    const raw = config?.hashCommands
    return { enabled: raw?.enabled === undefined ? DEFAULT_HASH_COMMANDS.enabled : raw.enabled !== false }
  }
  /** 同一个人/同一个群的重复回话节流：命令是「一问一答」，连着两条往往是一次手抖。 */
  const lastAt = new Map()
  const PRIVATE_COOLDOWN_MS = 1000
  /** 群里 30 秒一条：35 个人同时试一下也不该刷出一屏。 */
  const GROUP_COOLDOWN_MS = 30_000

  const reply = (scene, id, text, ev, extra) => {
    onEvent?.('hash-command', ev, extra)
    if (!send) return
    Promise.resolve()
      .then(() => send({ scene, id, text }))
      .catch((err) => logger('warn', `# 命令回复失败：${err?.message || err}`))
  }

  /**
   * 群里的分支：**只认 `#molly`**，只回一行摘要。
   *
   * 谁发都回（主人 2026-10-26：「触发取消白名单」）——摘要里只有版本、
   * 在不在线、运行时长，没有模型/开关/记忆这些私事，摊在群里不亏；
   * 刷屏靠同群 30 秒一条兜住，不靠名单拦人。
   */
  const handleGroup = (ev, parsed, uid) => {
    if (parsed.trigger !== 'molly') return false
    const gid = String(ev.group_id || '')
    if (!gid) return false
    const key = `group:${gid}`
    const now = Date.now()
    if (now - (lastAt.get(key) || 0) < GROUP_COOLDOWN_MS) {
      onEvent?.('hash-throttled', ev, { cmd: parsed.cmd, scene: 'group' })
      return true
    }
    lastAt.set(key, now)
    const out = summaryText({ config, getEnv })
    logger('debug', `#molly 摘要 → 群 ${gid}（${uid}）`)
    reply('group', gid, out, ev, { cmd: 'status', summary: true })
    return true
  }

  const handle = (ev) => {
    try {
      if (!opt().enabled) return false
      if (!ev || ev.post_type !== 'message') return false
      // 总开关关了就是「彻底闭嘴」，命令通道也不例外（跟状态指令同口径）。
      if (config?.enabled === false) return false
      const scene = String(ev.message_type || '')
      if (scene !== 'private' && scene !== 'group') return false
      const text = messageText(ev.message)
      if (text == null) return false
      const parsed = parseHashCommand(text)
      if (!parsed.matched) return false
      const uid = String(ev.user_id || '')
      if (!uid) return false

      if (scene === 'group') return handleGroup(ev, parsed, uid)

      if (gate.roleOf(uid) === ROLE_GUEST) {
        // 陌生人私聊本来就是「转审批」那条路；这里只回一句人话，不进模型。
        reply('private', uid, '这个只有主人能用。', ev, { cmd: parsed.cmd, denied: true })
        return true
      }

      const key = `private:${uid}`
      const now = Date.now()
      if (now - (lastAt.get(key) || 0) < PRIVATE_COOLDOWN_MS) {
        onEvent?.('hash-throttled', ev, { cmd: parsed.cmd })
        return true
      }
      lastAt.set(key, now)

      const out = buildReply(parsed, { config, getEnv })
      logger('debug', `# 命令：${parsed.cmd}${parsed.rest ? ` ${parsed.rest}` : ''} ← ${uid}`)
      reply('private', uid, out, ev, { cmd: parsed.cmd })
      return true
    } catch (err) {
      // 命令通道自己出错也绝不能把主链路带崩：记一笔，当没处理。
      logger('warn', `# 命令处理失败：${err?.stack || err}`)
      return true
    }
  }

  return { handle, parse: parseHashCommand, option: opt, menuText, summaryText }
}
