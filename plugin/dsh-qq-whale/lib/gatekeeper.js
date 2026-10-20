/**
 * 陌生人审批：有人想跟 Molly 私聊，先问主人，主人点头才放行。
 *
 * 为什么需要这个（用户 m16260）：
 *   早先私聊只有「白名单内聊 / 白名单外静默」两态，没有中间地带。
 *   有人加 Molly 好友、或者主动私信她，她一声不吭，主人也不知道
 *   有人来找过 —— 既漏了人，也没法事后追认。
 *
 *   改成三态：
 *     - 白名单 / 主人本人  → 直接聊
 *     - 不认识的人        → 不回复对方，改为私信主人「XXX(QQ) 来找你了，
 *                          通过吗？」，主人回「1/0」当场批
 *     - 主人在群里发起的  → 跟以前一样，群白名单照旧
 *
 * 三条设计原则（都是踩过的坑换来的）：
 *
 * 1. **绝不回复陌生人**。哪怕只是一句「稍等，我问下我主人」也不行 ——
 *    那等于告诉对方「这个号背后有人看着」，还会把「申请一次就能确认
 *    有人在」变成骚扰手段。沉默是唯一的正确反应。
 *
 * 2. **绝不刷屏主人**。同一个人 24 小时内只问一次；主人没回、没批，
 *    就静静待着。真机里最烦的就是被同一个人的请求反复弹窗。
 *
 * 3. **状态必须落盘**。待审批队列、已拒绝名单、静默计时器都在内存里
 *    太容易丢 —— DSH 重启一次就全忘了，于是同一个人第二天又被问一遍，
 *    或者主人明明拒过，重启后又来问。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 同一个人两次「求审批」之间的最小间隔：24 小时 */
const ASK_COOLDOWN_MS = 24 * 60 * 60 * 1000

/** 待审批请求最长保留 7 天，过期自动作废（免得队列无限长） */
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000

/** 已拒绝的人多久之后再允许问主人一次：30 天 */
const DENY_RETRY_MS = 30 * 24 * 60 * 60 * 1000

export class Gatekeeper {
  /**
   * @param {object} opts
   * @param {string} opts.dir      数据目录（存 gatekeeper.json）
   * @param {(lv:string,m:string)=>void} [opts.logger]
   * @param {string[]} [opts.owners] 主人 QQ 号列表（第一个是主主人）
   */
  constructor({ dir, logger = () => {}, owners = [] } = {}) {
    this.logger = logger
    this.owners = owners.map(String).filter(Boolean)
    this.file = dir ? path.join(dir, 'gatekeeper.json') : ''

    /**
     * 待审批：userId -> { userId, name, at, askedAt, lastText }
     * 用对象而不是数组，是因为按 userId 查/改是最常见的操作。
     */
    this.pending = new Map()
    /** 已放行（批准过的）：userId -> { name, at } */
    this.approved = new Map()
    /** 已拒绝：userId -> { name, at } */
    this.denied = new Map()

    this.load()
  }

  // ———————————————— 持久化 ————————————————

  load() {
    if (!this.file) return
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!j || typeof j !== 'object') return
      for (const [k, v] of Object.entries(j.pending || {})) this.pending.set(String(k), v)
      for (const [k, v] of Object.entries(j.approved || {})) this.approved.set(String(k), v)
      for (const [k, v] of Object.entries(j.denied || {})) this.denied.set(String(k), v)
      this.logger('debug', `审批状态已加载：待批 ${this.pending.size}，已放行 ${this.approved.size}，已拒 ${this.denied.size}`)
    } catch {
      /* 没文件 / 文件坏了都当全新开始——绝不能因为读配置失败让插件起不来 */
    }
  }

  save() {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const payload = {
        pending: Object.fromEntries(this.pending),
        approved: Object.fromEntries(this.approved),
        denied: Object.fromEntries(this.denied),
      }
      fs.writeFileSync(this.file, JSON.stringify(payload, null, 2), 'utf8')
    } catch (err) {
      this.logger('warn', `审批状态落盘失败：${err?.message || err}`)
    }
  }

  // ———————————————— 判定 ————————————————

  isOwner(userId) {
    return this.owners.includes(String(userId))
  }

  isApproved(userId) {
    return this.approved.has(String(userId))
  }

  isDenied(userId) {
    return this.denied.has(String(userId))
  }

  /**
   * 这人现在该不该被问。
   *
   * @returns {{ask:boolean, reason:string}}
   *   ask=true 表示：不是主人、不在白名单、也没批准过，且冷却期已过 → 该去问主人
   */
  shouldAsk(userId, now = Date.now()) {
    const id = String(userId)
    if (this.isOwner(id)) return { ask: false, reason: 'owner' }
    if (this.isApproved(id)) return { ask: false, reason: 'approved' }

    // 拒绝过的人：30 天内不再问，超过就允许再问一次（人可能会变，别一拒永拒）
    const d = this.denied.get(id)
    if (d && now - (d.at || 0) < DENY_RETRY_MS) return { ask: false, reason: 'denied-cooldown' }

    // 已经在队列里：24 小时内不再问，避免刷屏
    const p = this.pending.get(id)
    if (p) {
      if (now - (p.askedAt || p.at || 0) < ASK_COOLDOWN_MS) return { ask: false, reason: 'already-pending' }
      return { ask: true, reason: 'pending-remind' }
    }

    return { ask: true, reason: 'new' }
  }

  /**
   * 登记一条待审批请求（幂等：同一人重复来只更新最后一句和次数）。
   *
   * @returns {{isNew:boolean, entry:object}}
   */
  note(userId, { name = '', text = '', now = Date.now() } = {}) {
    const id = String(userId)
    let e = this.pending.get(id)
    const isNew = !e
    if (!e) {
      e = { userId: id, name, at: now, askedAt: 0, lastText: '', count: 0 }
      this.pending.set(id, e)
    }
    if (name) e.name = name
    if (text) e.lastText = text.slice(0, 200)
    e.count = (e.count || 0) + 1
    e.lastAt = now
    this.save()
    return { isNew, entry: e }
  }

  /** 记一下已经问过主人了（冷却计时从这里开始） */
  markAsked(userId, now = Date.now()) {
    const e = this.pending.get(String(userId))
    if (e) {
      e.askedAt = now
      this.save()
    }
  }

  /**
   * 批准。
   *
   * 分两种，别混：
   *   - chat / friend：批的是「这个人可以私聊我」→ 进 approved 名单
   *   - group：批的是「可以进这个群」→ **不能**写进 approved，
   *     否则群号会被当成 QQ 号塞进私聊白名单，等于放行了群里所有人。
   *     群聊可见性本来就由 config.allowedGroups 管，这里只负责把申请销掉。
   */
  approve(userId, now = Date.now()) {
    const id = String(userId)
    const e = this.pending.get(id) || {}
    this.pending.delete(id)
    this.denied.delete(id)
    if (e.kind !== 'group') {
      this.approved.set(id, { name: e.name || '', at: now, kind: e.kind || 'chat' })
    }
    this.save()
    return e
  }

  /** 拒绝：从待批移到已拒 */
  deny(userId, now = Date.now()) {
    const id = String(userId)
    const e = this.pending.get(id) || {}
    this.pending.delete(id)
    this.approved.delete(id)
    // 被拒的群不需要冷却期（再邀请一次还是会问主人），只销掉申请
    if (e.kind !== 'group') {
      this.denied.set(id, { name: e.name || '', at: now })
    }
    this.save()
    return e
  }

  /**
   * 清理过期数据：待批超过 7 天的作废，拒绝超过 30 天的也清掉。
   * 在每次读状态时顺手调用即可，不需要定时器。
   */
  sweep(now = Date.now()) {
    let changed = false
    for (const [k, v] of this.pending) {
      if (now - (v.at || 0) > PENDING_TTL_MS) {
        this.pending.delete(k)
        changed = true
      }
    }
    for (const [k, v] of this.denied) {
      if (now - (v.at || 0) > DENY_RETRY_MS) {
        this.denied.delete(k)
        changed = true
      }
    }
    if (changed) this.save()
  }

  /** 给挂件/状态接口用 */
  snapshot() {
    this.sweep()
    return {
      owners: this.owners,
      pending: [...this.pending.values()].map((e) => ({
        userId: e.userId,
        name: e.name || '',
        at: e.at,
        lastText: e.lastText || '',
        count: e.count || 0,
        asked: Boolean(e.askedAt),
      })),
      approved: [...this.approved.entries()].map(([userId, v]) => ({ userId, name: v.name || '', at: v.at })),
      denied: [...this.denied.entries()].map(([userId, v]) => ({ userId, name: v.name || '', at: v.at })),
    }
  }
}

/**
 * 解析主人对审批提示的回复。
 *
 * 支持的说法（都要能认，因为主人在手机上打字，不会严格按格式来）：
 *   同意 / 通过 / 好 / 行 / 可以 / ok / 1 / y / yes          → approve
 *   不同意 / 拒绝 / 不行 / 别 / 0 / n / no                   → deny
 *   同意 123456789 / 通过123456789                           → approve 指定 QQ 号
 *
 * 返回 null 表示「这不是一条审批指令」，交回给正常聊天流程。
 *
 * 为什么要单独抽出来：主人在群里或私聊里说的话也会走这里，
 * 如果匹配太宽（比如只认「好」），正常聊天里一句「好」就被当成审批了。
 * 所以**单个字的回复只有在有 pending 请求时才当审批**，由调用方控制。
 */
export function parseVerdict(text) {
  const t = String(text || '').trim()
  if (!t || t.length > 40) return null

  // 带 QQ 号的明确指令
  const m = t.match(/(?:同意|通过|放行|批准|拒(?:绝)?|不同意|拦)\D{0,4}(\d{5,12})/)
  if (m) {
    const yes = /^(?:同意|通过|放行|批准)/.test(m[0])
    return { action: yes ? 'approve' : 'deny', userId: m[1] }
  }

  const s = t.replace(/[\s。.!！~～,，、]/g, '').toLowerCase()

  /*
   * 为什么允许动词后面带尾缀（真机 m16524 教训）：
   *   主人回的是「通过审批」，而旧版正则是 `^(同意|通过|...)$` ——
   *   整串死匹配，多一个字就不认，她于是把这句话当成普通聊天回了
   *   「哦，批过了啊」。审批是主人**最不想重复第二遍**的动作，
   *   认不出来比认错更气人。
   *
   * 但尾缀必须**收得很紧**（第一版放太松，真机测试错了 3 条）：
   *   「好的呀」「可以可以」这种日常口头语一旦被吃成审批，
   *   主人随口一句「好的呀」就把陌生人放进来了 —— 这比认不出来严重得多。
   *
   * 所以规则是「一个明确的审批动词 + 至多一个**有指向的**尾缀」：
   *   允许：通过审批 / 同意他 / 同意他的申请 / 批准了 / 放行吧 / 拒绝他
   *   拒绝：好的呀 / 可以可以 / 好的好的 / 行行行（重复 = 口头语）
   *   尾缀里**不放**「可以」「好」「行」这些本身也是肯定词的字，
   *   否则「可以可以」会被解释成「可以 + 尾缀可以」。
   */
  /*
   * 尾缀允许**至多两个**（「同意他的申请」= 他的 + 申请）。
   * 之所以敢放两个还不误伤：每个尾缀单元都是**有指向性的**词，
   * 不含任何肯定词本身，所以「可以可以」「好呀好呀」这类口头重复
   * 依然拼不出来（第二个「可以」不在表里）。
   */
  const TL = '(?:他|她|ta|他的|她的|他们的|这个人|这人|这个|这位|那个|这个人|申请|的好友|好友|请求|审批|吧|了|啦|呗|嘛|就行|就好)'
  const TAIL = `(?:${TL}){0,2}`
  // 「加」「拒」单字也算：加吧 / 加他 / 同意加好友 / 拒了。它们在日常聊天里
  // 单独出现基本只有审批语境（「加油」「加个微信」后面跟的字都不在 TAIL 里）。
  const YES_VERB = '(?:同意|通过|放行|批准|可以|好的|好|行|加|ok|okay|yes|y|1|√|✓)'
  const reYes = new RegExp(`^${YES_VERB}${TAIL}$`)
  const reNo = new RegExp(`^(?:不同意|拒绝|不行|不可以|不好|拒|不|别|no|n|0|×|x)${TAIL}$`)
  // 「同意加好友」「通过加他」这种动词中嵌一个「加」的说法，单独补一条。
  // 只在前面已经有明确审批动词时才成立，所以不会把「加好友」本身当审批。
  const reYes2 = /^(?:同意|通过|批准|放行)(?:加|拉|让|收)(?:他|她|ta|这个|这人|好友|进|一下)?$/

  if (reYes.test(s) || reYes2.test(s)) {
    return { action: 'approve', userId: '' }
  }
  if (reNo.test(s)) {
    return { action: 'deny', userId: '' }
  }
  return null
}

/** 把一个人渲染成「名字（QQ 号）」，名字空就只显示 QQ 号；群申请显示成「群 123456」 */
export function personLabel(entry) {
  const name = (entry?.name || '').trim()
  const uid = String(entry?.groupId || entry?.userId || '')
  if (entry?.kind === 'group') return name ? `群 ${name}（${uid}）` : `群 ${uid}`
  if (name && name !== uid) return `${name}（${uid}）`
  return uid || '某人'
}
