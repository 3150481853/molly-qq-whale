/*
 * 戳一戳回应（2026-10-23，主人 m01231：「看看能不能实现对 QQ 的戳一戳进行回应，
 * 比如反戳、被戳多了生气这种」）。
 *
 * 设计取舍：
 *  1. **不走模型**。戳一戳是高频、廉价的肢体互动，走一次模型要 1~5 秒、一次 token，
 *     而且她正忙着聊别的时候会被排在后面——真人被戳是"反射"，不是"思考"。
 *     所以文案固定在这里，按关系粗分（主人 / 熟人 / 陌生人）。
 *  2. **反戳 + 说一句可以同时发生，但受概率控制**。默认 70% 反戳、45% 说一句；
 *     两个都独立掷骰——全都不中就是"被戳了但没反应"，真人也会这样。
 *  3. **被戳多了会生气**：同一个对象在窗口期（默认 180 秒）内被戳到第 N 次（默认 4）
 *     起，文案切到"生气"档，并进入更长的冷却（默认 90 秒），不再反戳。
 *  4. 冷却按「会话 + 戳的人」记账（群：群号+QQ；私聊：QQ），避免一个群里
 *     陌生人连着戳就把她刷屏。
 *  5. 受和回复一样的闸门约束：enabled、blindMode、白名单、发言开关（reply）、
 *     休息时段。任何一环不放行就静默——被戳不回应不是故障，是礼貌。
 */

/** 默认配置（main.js DEFAULTS 里同名键是权威默认值，这里给独立使用时的兜底） */
export const POKE_DEFAULTS = {
  pokeEnabled: true,
  pokeBackChance: 0.7, // 反戳概率
  pokeSayChance: 0.45, // 附带说一句的概率（独立掷骰）
  pokeAngryAfter: 4, // 窗口内被戳到第几次开始生气
  pokeAngryWindowSeconds: 180, // 计数窗口（秒）
  pokeCooldownSeconds: 8, // 两次反应之间的最小间隔（秒）
  pokeAngryCooldownSeconds: 90, // 生气之后的冷却（秒）
}

/** 文案池。{who} 会替换成对方名字（拿不到就用"你"）。 */
const POKE_TEXTS = {
  back: ['戳回去了', '喵？', '你戳我干嘛', '再戳一下试试'],
  say: ['别戳了，再戳要漏气了', '干嘛呀你', '有事说事，别动手', '戳一下收五毛'],
  angry: ['疼！再戳真的不理你了', '说了别戳了……', '你手很闲是吧', '再戳我就生气了！'],
  stranger: ['你是谁呀，别乱戳', '我们熟吗就戳'],
}

/** 判断一个事件是不是「戳一戳」通知。NapCat/OneBot11：notice_type=notify, sub_type=poke */
export function isPokeNotice(ev) {
  if (!ev || typeof ev !== 'object') return false
  if (ev.post_type && ev.post_type !== 'notice') return false
  const t = String(ev.notice_type || '').toLowerCase()
  if (t !== 'notify') return false
  const s = String(ev.sub_type || '').toLowerCase()
  return s === 'poke'
}

const pick = (arr, random) => arr[Math.floor(random() * arr.length) % arr.length]

export class PokeReactor {
  /**
   * @param {object} opts
   * @param {object} opts.client        OneBot 客户端（sendGroupPoke/sendPrivatePoke/sendGroupMsg/sendPrivateMsg）
   * @param {object} opts.config        插件 config（读 poke* 键）
   * @param {Function} [opts.logger]
   * @param {object} [opts.stats]       engine.stats（直接累加 pokeReceived/pokeBack/pokeSay/pokeAngry）
   * @param {Function} [opts.now]
   * @param {Function} [opts.random]
   * @param {string} [opts.selfId]
   * @param {Function} [opts.isAllowed]  (ev) => boolean，白名单/场景闸门
   * @param {Function} [opts.inRestWindow] () => boolean，休息时段
   * @param {Function} [opts.isOwner]   (qq) => boolean
   * @param {Function} [opts.isKnown]   (qq) => boolean 熟人（主人/审批人/记忆里出现过）
   */
  constructor({
    client,
    config = {},
    logger = () => {},
    stats = null,
    now = () => Date.now(),
    random = Math.random,
    selfId = '',
    isAllowed = () => true,
    inRestWindow = () => false,
    isOwner = () => false,
    isKnown = () => false,
  }) {
    this.client = client
    this.config = config
    this.logger = logger
    this.stats = stats
    this.now = now
    this.random = random
    this.selfId = String(selfId || '')
    this.isAllowed = isAllowed
    this.inRestWindow = inRestWindow
    this.isOwner = isOwner
    this.isKnown = isKnown
    /** key -> { hits:number[], lastActAt:number, angryUntil:number } */
    this.records = new Map()
    /** 最近一次处理结果（诊断用，暴露在 /state.poke.last） */
    this.last = null
    /** 最近处理记录环（≤12 条） */
    this.recent = []
  }

  get enabled() {
    return this.config.pokeEnabled !== false
  }

  /**
   * 取 client。
   *
   * 坑（2026-10-23 真机：主人戳了 5 次，Molly 一次都没回）：
   * engine 是在 main.js:1157 `new ChatEngine({ ..., client: null })` 建的，
   * WS 客户端要等 1204 行才创建、1225 行才 `engine.client = client` 补上。
   * 所以构造本类时 client 必然是 null；如果老老实实把 null 存下来用，
   * 之后每次发送都会 `Cannot read properties of null (reading 'sendGroupMsg')`，
   * 更糟的是 plan() 已经把这条算过一次动作、把 lastActAt 设了，
   * 于是后续 8 秒全判 cooldown —— 表现就是"戳了完全没反应"。
   * 所以允许传函数，每次现取。
   */
  _resolveClient() {
    return typeof this.client === 'function' ? this.client() : this.client
  }

  /** 纯计算：给定一次戳，返回本次该做什么（不做 IO，方便单测） */
  plan({ scene, gid, uid, nowMs = this.now() }) {
    if (!this.enabled) return { act: 'none', reason: 'disabled', count: 0 }
    const cfg = this.config
    const windowMs = Math.max(1, Number(cfg.pokeAngryWindowSeconds ?? POKE_DEFAULTS.pokeAngryWindowSeconds)) * 1000
    const cooldownMs = Math.max(0, Number(cfg.pokeCooldownSeconds ?? POKE_DEFAULTS.pokeCooldownSeconds)) * 1000
    const angryCooldownMs = Math.max(0, Number(cfg.pokeAngryCooldownSeconds ?? POKE_DEFAULTS.pokeAngryCooldownSeconds)) * 1000
    const angryAfter = Math.max(1, Number(cfg.pokeAngryAfter ?? POKE_DEFAULTS.pokeAngryAfter))
    const backChance = Math.min(1, Math.max(0, Number(cfg.pokeBackChance ?? POKE_DEFAULTS.pokeBackChance)))
    const sayChance = Math.min(1, Math.max(0, Number(cfg.pokeSayChance ?? POKE_DEFAULTS.pokeSayChance)))

    const key = `${gid ? String(gid) : 'private'}:${String(uid)}`
    let rec = this.records.get(key)
    if (!rec) {
      rec = { hits: [], lastActAt: 0, angryUntil: 0 }
      this.records.set(key, rec)
    }
    // 窗口外的旧计数丢掉
    rec.hits = rec.hits.filter((t) => nowMs - t <= windowMs)
    rec.hits.push(nowMs)
    const count = rec.hits.length

    if (nowMs < rec.angryUntil) return { act: 'none', reason: 'angry-cooldown', count }

    const stranger = !this.isOwner(uid) && !this.isKnown(uid)
    // 生气判断要排在普通冷却前面（2026-10-23 真机）：否则连戳 4 下时，
    // 第 2~4 下都被 8 秒冷却吃掉，窗口内的计数涨到 4 也永远轮不到"生气"。
    if (count >= angryAfter) {
      rec.lastActAt = nowMs
      rec.angryUntil = nowMs + angryCooldownMs
      rec.hits = []
      const pool = stranger ? POKE_TEXTS.stranger : POKE_TEXTS.angry
      return { act: 'angry', text: pick(pool, this.random), count, key }
    }

    if (nowMs - rec.lastActAt < cooldownMs) return { act: 'none', reason: 'cooldown', count }

    const roll = this.random()
    const doBack = roll < backChance
    const doSay = this.random() < sayChance
    // 第二次被戳还掷空就别装了：连着两次毫无反应，体感跟功能坏了一样
    if (!doBack && !doSay && count >= 2) {
      rec.lastActAt = nowMs
      return {
        act: 'say',
        text: pick(stranger ? POKE_TEXTS.stranger : POKE_TEXTS.say, this.random),
        back: false,
        say: true,
        count,
        key,
      }
    }
    if (!doBack && !doSay) return { act: 'none', reason: 'dice', count }
    let text = ''
    if (doSay) text = pick(stranger ? POKE_TEXTS.stranger : POKE_TEXTS.say, this.random)
    rec.lastActAt = nowMs
    // 反戳 + 说话同时发生：act 记为 'back'，文本另外带出去由 handle 决定
    return { act: doBack ? 'back' : 'say', text, back: doBack, say: doSay, count, key }
  }

  /** 处理一条戳一戳通知。返回 { acted, act, reason }；结果同时记到 last/recent 供 /state 诊断 */
  async handle({ ev, userName = '' } = {}) {
    const result = await this._handle(ev, userName)
    const note = {
      at: new Date(this.now()).toISOString(),
      noticeType: String(ev?.notice_type ?? ''),
      subType: String(ev?.sub_type ?? ''),
      gid: ev?.group_id ? String(ev.group_id) : '',
      uid: String(ev?.user_id ?? ''),
      target: String(ev?.target_id ?? ''),
      ...result,
    }
    this.last = note
    this.recent.push(note)
    if (this.recent.length > 12) this.recent.shift()
    return result
  }

  async _handle(ev, userName = '') {
    if (!isPokeNotice(ev)) return { acted: false, reason: 'not-poke' }
    if (!this.enabled) return { acted: false, reason: 'disabled' }
    const uid = String(ev.user_id ?? ev.target_id ?? '')
    if (!uid || uid === this.selfId) return { acted: false, reason: 'self' }
    const gid = ev.group_id ? String(ev.group_id) : ''
    const selfPoked = String(ev.target_id ?? '') === this.selfId || !ev.target_id
    // target_id 不是自己 = 戳的是别人，别插话
    if (!selfPoked) return { acted: false, reason: 'not-target' }
    if (this.inRestWindow()) return { acted: false, reason: 'rest' }
    if (!this.isAllowed(ev)) return { acted: false, reason: 'not-allowed' }

    const scene = gid ? 'group_mention' : 'private'
    const plan = this.plan({ scene, gid, uid })
    if (this.stats) this.stats.pokeReceived = (this.stats.pokeReceived || 0) + 1
    if (plan.act === 'none') {
      this.logger('info', `戳一戳：${uid} 在 ${gid || '私聊'}（第 ${plan.count} 次，${plan.reason}，不回应）`)
      return { acted: false, act: 'none', reason: plan.reason, count: plan.count }
    }

    const who = userName || (gid ? '' : '')
    const fill = (s) => String(s || '').replace(/\{who\}/g, who || '你')
    const bot = this._resolveClient()
    if (!bot) return { acted: false, act: 'none', reason: 'no-client', count: plan.count }
    try {
      if (plan.back) {
        if (gid) await bot.sendGroupPoke(gid, uid)
        else await bot.sendPrivatePoke(uid)
        if (this.stats) this.stats.pokeBack = (this.stats.pokeBack || 0) + 1
      }
      if (plan.text) {
        const seg = [{ type: 'text', data: { text: fill(plan.text) } }]
        if (gid) await bot.sendGroupMsg(gid, seg)
        else await bot.sendPrivateMsg(uid, seg)
      }
      if (plan.act === 'angry') {
        if (this.stats) this.stats.pokeAngry = (this.stats.pokeAngry || 0) + 1
      } else if (plan.say) {
        if (this.stats) this.stats.pokeSay = (this.stats.pokeSay || 0) + 1
      }
      this.logger('debug', `戳一戳：${gid || '私聊'} 来自 ${uid}（第 ${plan.count} 次）→ ${plan.act}`)
      return { acted: true, act: plan.act, count: plan.count, back: !!plan.back, say: !!(plan.text && plan.act !== 'angry') }
    } catch (err) {
      // 发失败不算"回应过"：把冷却起点清掉，下一条戳能立刻重试
      if (plan.key) {
        const rec = this.records.get(plan.key)
        if (rec) rec.lastActAt = 0
      }
      this.logger('warn', `戳一戳回应失败: ${err?.message || err}`)
      return { acted: false, act: 'error', reason: String(err?.message || err) }
    }
  }
}
