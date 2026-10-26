/**
 * 底层状态激发指令（主人 m00001，2026-10-26）
 * ===========================================================================
 * 起因：主人在群里发 `#sl`，所有跑 SnowLuma 的号各自回一条「SnowLuma 状态」。
 * 查清了：那是 SnowLuma（OneBot 实现层）的**内置指令**，在事件交给下游之前
 * 自己就接走并回复了（snowluma/index.mjs:259304 的 handleStatusCommand，
 * 默认 `{enabled:true, swallow:false, cooldownSeconds:5, trigger:"#sl"}`），
 * 所以同架构的号会一起响。
 *
 * 主人要 Molly 也有一个同类的「底层」指令：不管模型在不在、上下文里有什么、
 * 群里允不允许她插话，只要整条消息就是触发词，就立刻回一条她自己的真实状态。
 *
 * 四条硬规矩（对齐 SnowLuma 的语义）：
 *   1. **低层**：在 blindMode / 命令体系 / 模型链路之前拦。不进聊天历史、
 *      不花 token、不会因为「她正在忙/冷却中/没被 @」而哑火。
 *   2. **精确**：整条消息只有 text 段、且 trim + 折叠空白后等于触发词。
 *      带图、带表情、带 @、带别的话都不算 —— 否则群里随口一句就全员回话。
 *   3. **冷却**：同一会话（群 / 私聊）默认 30 秒一次，防刷屏。主人不受限。
 *   4. **分层**：主人看详情（版本/链路/运行时长/模型/记忆/额度/开关），
 *      别人只看一行（谁、在不在线、什么版本、跑了多久）。
 *
 * 跟 SnowLuma 的差别（都是主人拍板的，m00093 三问）：
 *   - **总开关关了不吭声**：那是主人让她「彻底闭嘴」的唯一手段，状态指令也闭嘴。
 *   - **闭眼模式仍然应答**：闭眼 = 不说话但活着，正是最需要它来确认「她还在不在」。
 *   - **陌生人拿不到完整状态**：私聊只认主人/白名单，群里只认 allowedGroups，
 *     而且只给一行。模型名、记忆条数、额度这些不给群友看。
 *
 * 判定/文案全是纯函数，不碰 socket、不读全局，方便 tools 里离线自测。
 */

import fs from 'node:fs'

/** 默认参数。改这里等于改「所有装的机器人」的出厂值。 */
export const DEFAULT_STATUS_COMMAND = {
  /** 关掉就完全不再应答（跟总开关不是一回事：这个只关「状态指令」这一条通道）。 */
  enabled: true,
  /** 触发词。整条消息（trim 后、不分大小写）等于它才算。 */
  trigger: '#molly',
  /** 同一会话（群 / 私聊）两次应答的最小间隔秒数。0 = 不限。 */
  cooldownSeconds: 30,
  /** 主人看详情，其他人只看一行。关掉 = 所有人都只看一行。 */
  ownerDetail: true,
}

/**
 * 版本号：从包根的 package.json 读。
 *
 * 两种布局都要读得到（见 boot.js 的说明）：
 *   - 源码：`<包根>/lib/status-command.js` → `../package.json` = 包根 ✓
 *   - 热重载副本：`<包根>/gen-<rev>/status-command.js` → `../package.json` = 包根 ✓
 * 读不到就返回空串，文案里退化成「未知版本」，绝不因为版本读不出来就不回话。
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

/** 配置合并：`config.statusCommand` 里没填的项落回默认值。 */
export function effectiveOption(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const cooldown = Number(src.cooldownSeconds)
  return {
    enabled: src.enabled === undefined ? DEFAULT_STATUS_COMMAND.enabled : src.enabled !== false,
    trigger: normalizeTrigger(src.trigger),
    cooldownSeconds: Number.isFinite(cooldown) && cooldown >= 0 ? cooldown : DEFAULT_STATUS_COMMAND.cooldownSeconds,
    ownerDetail:
      src.ownerDetail === undefined ? DEFAULT_STATUS_COMMAND.ownerDetail : src.ownerDetail !== false,
  }
}

/**
 * 规整触发词：去空白、转小写、没写 `#` 的补上。
 *
 * 补 `#` 是故意的：配置里写 `molly` 的人，心里想的几乎一定是 `#molly`，
 * 而裸 `molly` 在群里被叫到的概率太高（叫名字就会触发全员回状态）。
 */
export function normalizeTrigger(raw) {
  const s = String(raw ?? '')
    .replace(/\u3000/g, ' ')
    .trim()
    .toLowerCase()
  if (!s) return DEFAULT_STATUS_COMMAND.trigger
  return s.startsWith('#') ? s : `#${s}`
}

/**
 * 把 OneBot 消息段里的纯文本抠出来。
 *
 * 只要有一个非 text 段（at / image / face / reply / mface …）就返回 null：
 * 这是 SnowLuma 同口径的「整条消息就是触发词」，宁可漏判也别误判 ——
 * 误判的代价是所有人被刷一条消息，漏判的代价只是再发一次。
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

/** 折叠空白（含换行、连续空格）后再比对。 */
function squeeze(text) {
  return String(text ?? '')
    .replace(/[\s\u3000]+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * 这条消息是不是「底层状态激发指令」。
 *
 * @param {{message?: any, raw_message?: string}|null} ev OneBot 消息事件
 * @param {string} [trigger] 触发词（会被 normalizeTrigger 规整）
 * @returns {boolean}
 */
export function matchStatusMessage(ev, trigger = DEFAULT_STATUS_COMMAND.trigger) {
  const want = normalizeTrigger(trigger)
  let text = messageText(ev?.message)
  /*
   * 有的实现只给 raw_message。只有一种情况可以退回去用它：
   * 有 raw_message、但没有任何 CQ 码（没有 `[CQ:`）—— 那就是一条纯文本。
   * 否则 `[CQ:face,id=1]#molly` 这种也会被当成触发词。
   */
  if (text === null) {
    const raw = String(ev?.raw_message ?? '')
    if (!raw || raw.includes('[CQ:')) return false
    text = raw
  }
  return squeeze(text) === want
}

/** 人类可读的时长：45秒 / 12分 / 3小时12分 / 2天3小时。 */
export function formatUptime(ms) {
  const totalSec = Math.max(0, Math.floor(Number(ms) || 0) / 1000)
  if (totalSec < 60) return `${Math.floor(totalSec)}秒`
  const totalMin = Math.floor(totalSec / 60)
  if (totalMin < 60) return `${totalMin}分`
  const totalHour = Math.floor(totalMin / 60)
  const min = totalMin % 60
  if (totalHour < 24) return min ? `${totalHour}小时${min}分` : `${totalHour}小时`
  const day = Math.floor(totalHour / 24)
  const hour = totalHour % 24
  return hour ? `${day}天${hour}小时` : `${day}天`
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** 时间戳 → 北京时间 `MM-DD HH:mm`（按配置的偏移算，不依赖机器时区）。 */
export function formatClock(ts, offsetMinutes = 480) {
  const t = Number(ts)
  if (!Number.isFinite(t) || t <= 0) return ''
  const d = new Date(t + Number(offsetMinutes || 0) * 60000)
  return `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`
}

/** 从 `ws://127.0.0.1:3001` 里抠端口，抠不到返回空串。 */
function portOf(url) {
  const m = /:(\d{2,5})(?:\/|$)/.exec(String(url || ''))
  return m ? m[1] : ''
}

/**
 * 把运行时状态收集成一份「快照」。
 *
 * 只读、全包 try/catch：状态指令最需要活着的时刻，恰恰是某个子系统已经坏掉
 * 的时刻。任何一个字段取不到都必须退化成「这项不显示」，绝不许整条指令抛错。
 *
 * @param {{config?: object, state?: object, engine?: object|null, metrics?: object|null,
 *          bootedAt?: number, now?: number}} env
 */
export function collectStatus(env = {}) {
  const now = Number(env.now) || Date.now()
  const config = env.config && typeof env.config === 'object' ? env.config : {}
  const state = env.state && typeof env.state === 'object' ? env.state : {}
  const engine = env.engine || null
  const metrics = env.metrics || null
  const bootedAt = Number(env.bootedAt) || 0

  const snap = {
    at: now,
    version: version(),
    qq: String(state?.bot?.userId || config.selfId || ''),
    nickname: String(state?.bot?.nickname || 'Molly'),
    linkReady: false,
    linkState: '',
    linkPort: portOf(config.onebotUrl),
    uptimeMs: bootedAt ? Math.max(0, now - bootedAt) : 0,
    startedAt: bootedAt,
    offsetMinutes: Number.isFinite(Number(config.timeOffsetMinutes)) ? Number(config.timeOffsetMinutes) : 480,
    backend: String(config.modelBackend || ''),
    model: '',
    realm: String(config.gatewayRealm || ''),
    memory: null,
    budget: null,
    metrics: null,
    /*
     * 开关这四项只在「配置里真有这个键」时才给结论；缺键给 null，
     * 文案里渲染成 `?`。为什么要这样：tools\status-command-preview.mjs
     * 只能从 /state 猜这台机器的情况，/state 并不暴露 live config 的开关，
     * 早期把它当 false 渲染，预览里就出现了「群插话关 · 主动联系关」这种
     * 与线上相反的假象。真机路径里 config 永远是补全过的，不会出现 `?`。
     */
    flags: {
      enabled: config.enabled === undefined ? null : config.enabled !== false,
      blindMode: config.blindMode === undefined ? null : config.blindMode === true,
      groupAutoReply: config.groupAutoReply === undefined ? null : config.groupAutoReply !== false,
      proactiveEnabled: config.proactiveEnabled === undefined ? null : config.proactiveEnabled === true,
    },
  }

  // 连接：state.link 历史上有两种写法（字符串 / {ready,state} 对象），两种都要认。
  try {
    const link = state?.link
    if (typeof link === 'string') {
      snap.linkState = link
      snap.linkReady = link === 'online'
    } else if (link && typeof link === 'object') {
      snap.linkState = String(link.state || '')
      snap.linkReady = Boolean(link.ready)
    } else {
      snap.linkState = String(state?.connected ? 'online' : '')
      snap.linkReady = Boolean(state?.connected)
    }
  } catch {}
  // engine.client 的 ready 是更硬的口径（state.link 可能因为回调没触发而陈旧）
  try {
    if (typeof engine?.client?.ready === 'boolean') snap.linkReady = engine.client.ready
  } catch {}

  // 模型：聊天用的那个 model 优先（chatModelName 只在对应后端下才返回非空）
  try {
    const chat = typeof engine?.chatModelName === 'function' ? engine.chatModelName() : ''
    snap.model = String(chat || config?.chatModel?.model || config.model || '')
  } catch {}

  // 记忆条数 / 上限：memory.status() 是 web.js 用的同一口径，别再养第二套数法。
  try {
    const mem = engine?.memory
    if (mem && typeof mem.status === 'function') {
      const st = mem.status() || {}
      snap.memory = {
        count: Number.isFinite(Number(st.count)) ? Number(st.count) : null,
        limit: Number.isFinite(Number(st.limit)) ? Number(st.limit) : null,
      }
    }
  } catch {}

  // 今日积分用量（budget.json 那套，跨重启延续）
  try {
    const b = engine?.budget
    if (b && typeof b.snapshot === 'function') {
      const st = b.snapshot() || {}
      snap.budget = {
        used: Number.isFinite(Number(st.used)) ? Number(st.used) : null,
        cap: Number.isFinite(Number(st.cap)) ? Number(st.cap) : null,
        calls: Number.isFinite(Number(st.calls)) ? Number(st.calls) : null,
      }
    }
  } catch {}

  // 消息计数 / 平均回复 / 上一条时间
  try {
    if (metrics && typeof metrics.snapshot === 'function') {
      const st = metrics.snapshot() || {}
      snap.metrics = {
        messages: Number.isFinite(Number(st.messages)) ? Number(st.messages) : null,
        conversations: Number.isFinite(Number(st.conversations)) ? Number(st.conversations) : null,
        avgReplySeconds: Number.isFinite(Number(st.avgReplySeconds)) ? Number(st.avgReplySeconds) : null,
      }
    }
  } catch {}

  return snap
}

function round1(n) {
  return Math.round(Number(n) * 10) / 10
}

/**
 * 造回话正文。
 *
 * 两种档位：
 *   - `public`：一行。谁、在不在、什么版本、跑了多久。群友/陌生人看这个。
 *   - `owner`：多行详情。主人看这个。
 *
 * 文案故意不堆术语：这条消息可能出现在群里，读的人不懂 wb-proxy / realm。
 *
 * @param {object} snap collectStatus() 的返回值
 * @param {{tier?: 'owner'|'public'}} [opts]
 */
export function buildStatusText(snap, { tier = 'public' } = {}) {
  const s = snap || {}
  const who = s.qq ? `${s.nickname || 'Molly'}（${s.qq}）` : String(s.nickname || 'Molly')
  const ver = `v${s.version || '未知版本'}`
  const up = s.uptimeMs > 0 ? formatUptime(s.uptimeMs) : ''
  const stateText = s.linkReady
    ? '在线'
    : `连接中断${s.linkState ? `（${s.linkState === 'connecting' ? '正在连' : s.linkState}）` : '，正在重连'}`

  if (tier !== 'owner') {
    const bits = [who, stateText, ver]
    if (up) bits.push(`已运行 ${up}`)
    return bits.join(' · ')
  }

  const lines = [`${who} 状态 · ${ver}`]

  // 连接
  const linkBits = [stateText]
  if (s.linkPort) linkBits.push(`OneBot ${s.linkPort}`)
  if (up) linkBits.push(`${formatClock(s.startedAt, s.offsetMinutes) || '本次启动'} 起运行 ${up}`)
  lines.push(`连接 ${linkBits.join(' · ')}`)

  // 模型
  const modelBits = []
  if (s.model) modelBits.push(s.model)
  if (s.backend) modelBits.push(`后端 ${s.backend}`)
  if (s.realm) modelBits.push(`realm ${s.realm}`)
  if (modelBits.length) lines.push(`模型 ${modelBits.join(' · ')}`)

  // 记忆 + 额度
  const dataBits = []
  if (s.memory && s.memory.count !== null) {
    dataBits.push(`记忆 ${s.memory.count}${s.memory.limit ? `/${s.memory.limit}` : ''} 条`)
  }
  if (s.budget && s.budget.used !== null) {
    const cap = s.budget.cap !== null ? `/${s.budget.cap}` : ''
    const calls = s.budget.calls !== null ? `（${s.budget.calls} 次调用）` : ''
    dataBits.push(`今日额度 ${round1(s.budget.used)}${cap} 分${calls}`)
  }
  if (dataBits.length) lines.push(`数据 ${dataBits.join(' · ')}`)

  // 消息量
  if (s.metrics && s.metrics.messages !== null) {
    const mBits = [`消息 ${s.metrics.messages} 条`]
    if (s.metrics.conversations !== null) mBits.push(`${s.metrics.conversations} 个会话`)
    if (s.metrics.avgReplySeconds !== null) mBits.push(`平均回复 ${round1(s.metrics.avgReplySeconds)} 秒`)
    lines.push(mBits.join(' · '))
  }

  // 开关（这是主人最常来核的四项）
  const f = s.flags || {}
  const onoff = (v) => (v === true ? '开' : v === false ? '关' : '?')
  lines.push(
    `开关 总开关${onoff(f.enabled)} · 闭眼${onoff(f.blindMode)} · 群插话${onoff(f.groupAutoReply)} · 主动${onoff(f.proactiveEnabled)}`,
  )

  return lines.join('\n')
}

/**
 * 冷却表：按会话 key 记「上次真回了」的时间。
 *
 * 键用 `group:<群号>` / `private:<QQ号>`，不用「人」：同一群里两个人先后发，
 * 也应该共用一份冷却 —— 否则两个人轮流发就能把群里刷满。
 */
export class StatusCooldown {
  constructor(seconds) {
    this.seconds = Math.max(0, Number(seconds) || 0)
    this.last = new Map()
  }

  /** @returns {{allowed: boolean, retryAfterMs: number}} */
  check(key, now = Date.now()) {
    if (!this.seconds) return { allowed: true, retryAfterMs: 0 }
    const prev = this.last.get(key)
    // 第一次见这个会话：直接放行并记时。不能拿 0 当「上次回的时间」去比 now ——
    // 那样在 now 很小（测试里传的假时间戳、或系统时钟被拨到 1970 附近）时
    // 第一次就会被误判成冷却中。
    if (prev === undefined) {
      this.last.set(key, now)
      return { allowed: true, retryAfterMs: 0 }
    }
    const wait = Number(prev) + this.seconds * 1000 - now
    if (wait > 0) return { allowed: false, retryAfterMs: wait }
    this.last.set(key, now)
    // 表别无限长：超过 500 个会话就清掉最老的一半（这个规模不可能有活人会碰到）
    if (this.last.size > 500) {
      const keys = [...this.last.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k)
      for (const k of keys.slice(0, keys.length >> 1)) this.last.delete(k)
    }
    return { allowed: true, retryAfterMs: 0 }
  }
}

/**
 * 造一个「消息进来时先过一遍」的处理器。
 *
 * 只做判定和派发，真正的发送由调用方注入（send），这样离线测试不需要 socket。
 *
 * @param {object} opts
 * @param {object} opts.config      插件配置（读 statusCommand / enabled / ownerUin / allowedUsers / allowedGroups）
 * @param {() => object} opts.getEnv 每次应答时现场取 {state, engine, metrics, bootedAt}（要反映最新值）
 * @param {(req: {scene: 'group'|'private', id: string, text: string, tier: 'owner'|'public', ev: object}) => any} opts.send
 * @param {(level: string, msg: string) => void} [opts.logger]
 * @param {(type: string, ev: object, extra?: object) => void} [opts.onEvent] 事件环记录
 */
export function createStatusHandler({ config, getEnv, send, logger, onEvent } = {}) {
  const cooldown = new StatusCooldown(effectiveOption(config?.statusCommand).cooldownSeconds)
  const log = typeof logger === 'function' ? logger : () => {}
  const trace = typeof onEvent === 'function' ? onEvent : () => {}

  /** 主人：roles/gatekeeper 的口径优先，退回 ownerUin 直接比对。 */
  function isOwner(uin) {
    const id = String(uin || '')
    if (!id) return false
    try {
      const gk = getEnv?.()?.engine?.gatekeeper
      if (gk && typeof gk.isOwner === 'function' && gk.isOwner(id)) return true
    } catch {}
    return Boolean(config?.ownerUin) && String(config.ownerUin) === id
  }

  function inList(list, id) {
    if (!Array.isArray(list) || !id) return false
    return list.map((x) => String(x)).includes(String(id))
  }

  /**
   * @returns {boolean} true = 这条消息已被状态指令吃掉，调用方必须 return（不能再去走模型）
   */
  function handle(ev) {
    try {
      const opt = effectiveOption(config?.statusCommand)
      if (!opt.enabled) return false
      if (!ev || ev.post_type !== 'message') return false
      if (!matchStatusMessage(ev, opt.trigger)) return false

      const uin = String(ev.user_id || '')
      const self = String(ev.self_id || config?.selfId || '')
      if (!uin || uin === self) return false

      /*
       * 总开关关了就彻底不吭声（主人 m00093 拍板）。
       * 注意这里**不**判 blindMode：闭眼模式正是最需要它来确认「她还在不在」的场景。
       */
      if (config?.enabled === false) {
        trace('status-drop-disabled', ev)
        return true
      }

      const isGroup = ev.message_type === 'group'
      const gid = String(ev.group_id || '')
      const owner = isOwner(uin)

      if (isGroup) {
        // 群：主人哪儿都能问；陌生人只在她被允许插话的群里能问
        if (!owner && !inList(config?.allowedGroups, gid)) {
          trace('status-drop-group', ev, { group: gid })
          return true
        }
      } else if (!owner && !inList(config?.allowedUsers, uin)) {
        // 私聊：陌生人（连好友都不一定算）一律不回，别把白名单绕过
        trace('status-drop-private', ev)
        return true
      }

      const tier = owner && opt.ownerDetail ? 'owner' : 'public'
      /*
       * 冷却只拦外人，不拦主人（2026-10-26 09:50 改回来）。
       *
       * 之前的判断反了：主人手滑连发两条，难看的是「两条一样的」，但**不吭声**
       * 更糟 —— 主人 09:39 连发两次、第二次被 30 秒冷却吃掉，观感就是「她不回我」，
       * 直接以为功能坏了。主人是唯一会主动点这条通道的人，他要两次就是想要两次；
       * 外人在白名单群/私聊里 30 秒一次，防刷的目的照样达到。
       * 钥匙按会话（group:/private:），不按人：同一群里两个外人先后发也只回一次。
       */
      if (!owner) {
        const key = isGroup ? `group:${gid}` : `private:${uin}`
        const gate = cooldown.check(key)
        if (!gate.allowed) {
          trace('status-cooldown', ev, { waitMs: Math.round(gate.retryAfterMs) })
          return true
        }
      }

      const env = getEnv?.() || {}
      const snap = collectStatus({ ...env, config })
      const text = buildStatusText(snap, { tier })
      const req = { scene: isGroup ? 'group' : 'private', id: isGroup ? gid : uin, text, tier, ev }
      trace('status', ev, { tier, scene: req.scene })
      // 发送失败只记日志：这条通道是「诊断用」的，不能反过来影响主链路
      Promise.resolve()
        .then(() => send?.(req))
        .catch((err) => log('warn', `状态指令发送失败：${err?.message || err}`))
      return true
    } catch (err) {
      log('warn', `状态指令判定异常（不影响聊天）：${err?.message || err}`)
      return false
    }
  }

  return { handle, isOwner, option: () => effectiveOption(config?.statusCommand) }
}
