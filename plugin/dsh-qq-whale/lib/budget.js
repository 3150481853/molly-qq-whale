/**
 * 积分预算：WorkBuddy 免费额度的每日上限。
 *
 * 为什么需要这个模块（实测结论，2026-10-17）：
 *   - WorkBuddy **没有"每日额度"这个概念**，只有跨月周期的资源包
 *     （billing 接口返回的是 5 个包，每个包 100~1500，按周期计）。
 *   - 但每次请求的 SSE 最后一帧带 `usage.credit`，是**逐请求精确计费**的
 *     四舍五入值（deepseek-v4.1-flash 的 multiplier = 0.06，约 19000 token = 1 分）。
 *   - billing 接口的 `used` 滞后几十秒且按批聚合，**不能用来实时拦截**。
 *
 * 所以这里的口径是：自己按天累计 `usage.credit`，跟一个用户设的上限比。
 * 超了就停——这是用户明确要的「日上限 100 分，超限发通知后停止」。
 *
 * 持久化：budget.json 落盘，重启不丢当天已用量。
 * 跨天：按本地时区（Asia/Shanghai）算日期，换天自动归零。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 本地日期字符串 YYYY-MM-DD。用本地时区而不是 UTC——"日上限"是给人看的。 */
export function localDateKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/**
 * 本地时间字符串 YYYY-MM-DD HH:mm。
 *
 * 给 .md 备份文件和日志用的。不能用 toISOString()——那个是 UTC，
 * 写进 memory.md / relations.md 之后，凌晨看到的日期会比实际早一天。
 */
export function localDateTime(d = new Date()) {
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${localDateKey(d)} ${hh}:${mm}`
}

export class CreditBudget {
  /**
   * @param {object} p
   * @param {string} p.dir      落盘目录（一般跟 memory 同一个 dataDir）
   * @param {(lv:string,msg:string)=>void} [p.logger]
   * @param {boolean} [p.enabled] 总开关；关掉就完全不做限制也不切 trae
   * @param {number} [p.dailyCap] 每日上限（积分）
   */
  constructor({ dir, logger, enabled = true, dailyCap = 100 } = {}) {
    this.dir = dir
    this.logger = logger || (() => {})
    this.enabled = enabled !== false
    this.dailyCap = Number(dailyCap) || 0
    this.file = dir ? path.join(dir, 'budget.json') : ''
    /*
     * 开关和上限单独存一份。
     *
     * 用量（budget.json）是「今天花了多少」，开关是「主人想不想让我省钱」——
     * 两件事的生命周期完全不同：用量每天清零，开关要一直记着。早先把开关
     * 只放在内存里，重启一次就悄悄变回 yml 里的默认值，主人明明关了限制，
     * 第二天却发现它自己又开着，这种「设置会自己变」的行为最招人烦。
     */
    this.settingsFile = dir ? path.join(dir, 'budget-settings.json') : ''

    /**
     * 当天账本。
     *
     * task-54：原来只有 `used/calls`，而 calls 只在 credit>0 时才 +1 —— 主脑走
     * intl 免费 flash 时 credit 恒为 0，于是「回了 1222 条消息、只记到 5 次调用」。
     * 现在 calls/tokens 与 credit 解耦：**每次模型调用都记 calls，拿不到 usage
     * 就把 tokens 记 null，绝不编造 credit**。
     *
     *   used         今日积分（= credit 总和；旧字段，控制台在用）
     *   calls        今日模型调用次数（无论有没有 usage）
     *   tokens       今日已知 token 总和；一次 usage 都没有时保持 null
     *   tokensKnown  有多少次调用真的带来了 token 数（用于判断 tokens 是否可信）
     *   byChannel    { chat: {calls,credit,tokens,tokensKnown}, work: {...}, ... }
     *
     * @type {{date:string, used:number, calls:number, tokens:number|null, tokensKnown:number,
     *         notified:boolean, byChannel:object}}
     */
    this.day = this.emptyDay(localDateKey())
    this.load()
    this.loadSettings()
  }

  /** 一天的初始账本（跨天/首次启动共用，避免两处字段写漂）。 */
  emptyDay(date) {
    return {
      date,
      used: 0,
      calls: 0,
      tokens: null,
      tokensKnown: 0,
      notified: false,
      byChannel: {},
    }
  }

  /** 把落盘对象收敛成合法账本（旧文件没有新字段也不能崩）。 */
  normalizeDay(j, date) {
    const out = this.emptyDay(date)
    const numOrNull = (v) => {
      if (v === null || v === undefined || v === '') return null
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    if (!j || typeof j !== 'object') return out
    out.used = Number(j.used) || 0
    out.calls = Number(j.calls) || 0
    out.notified = Boolean(j.notified)
    out.tokens = numOrNull(j.tokens)
    out.tokensKnown = Number(j.tokensKnown) || 0
    if (j.byChannel && typeof j.byChannel === 'object') {
      for (const [ch, v] of Object.entries(j.byChannel)) {
        if (!v || typeof v !== 'object') continue
        out.byChannel[ch] = {
          calls: Number(v.calls) || 0,
          credit: Number(v.credit) || 0,
          tokens: numOrNull(v.tokens),
          tokensKnown: Number(v.tokensKnown) || 0,
        }
      }
    }
    return out
  }

  // ———————————————— 持久化 ————————————————

  load() {
    if (!this.file) return
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const j = JSON.parse(raw)
      if (j && typeof j === 'object') {
        const today = localDateKey()
        if (j.date === today) {
          this.day = this.normalizeDay(j, today)
        } else {
          // 跨天了：保留历史最后一条便于看，但当天从零开始
          this.yesterday = {
            date: j.date,
            used: Number(j.used) || 0,
            calls: Number(j.calls) || 0,
            tokens: Number.isFinite(Number(j.tokens)) ? Number(j.tokens) : null,
          }
        }
      }
    } catch {
      /* 文件不存在或坏了都从零开始，不值得报错 */
    }
  }

  save() {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const payload = { ...this.day }
      if (this.yesterday) payload.yesterday = this.yesterday
      fs.writeFileSync(this.file, JSON.stringify(payload, null, 2), 'utf8')
    } catch (err) {
      this.logger('debug', `预算落盘失败：${err?.message || err}`)
    }
  }

  /** 换天检查。返回 true 表示刚刚发生了跨天归零。 */
  rollover() {
    const today = localDateKey()
    if (this.day.date === today) return false
    this.yesterday = {
      date: this.day.date,
      used: this.day.used,
      calls: this.day.calls,
      tokens: this.day.tokens,
    }
    this.day = this.emptyDay(today)
    this.save()
    this.logger('info', `积分预算跨天重置（昨天用了 ${(this.yesterday.used || 0).toFixed(2)} 分、${this.yesterday.calls || 0} 次调用）`)
    return true
  }

  /**
   * 把开关状态落盘。
   *
   * 只存「主人手动改过的那两项」。如果从没改过，文件就不存在，
   * 一切按 yml 配置走 —— 配置文件仍然是可复现的基线，
   * 只有主人亲手拨过的开关才会盖过它。
   */
  saveSettings() {
    if (!this.settingsFile) return
    try {
      fs.mkdirSync(path.dirname(this.settingsFile), { recursive: true })
      fs.writeFileSync(
        this.settingsFile,
        JSON.stringify({ enabled: this.enabled, dailyCap: this.dailyCap }, null, 2),
        'utf8',
      )
    } catch (err) {
      this.logger('debug', `积分开关落盘失败：${err?.message || err}`)
    }
  }

  loadSettings() {
    if (!this.settingsFile) return
    try {
      const j = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'))
      if (!j || typeof j !== 'object') return
      if (typeof j.enabled === 'boolean') this.enabled = j.enabled
      if (Number.isFinite(Number(j.dailyCap)) && Number(j.dailyCap) > 0) {
        this.dailyCap = Number(j.dailyCap)
      }
    } catch {
      /* 没这个文件就是「主人没改过」，按配置走 */
    }
  }

  /**
   * 改开关。落盘之后再返回，保证「说的和存的一致」。
   * @param {boolean} v
   */
  setEnabled(v) {
    this.enabled = v !== false
    this.saveSettings()
    return this.enabled
  }

  /** @param {number} v */
  setCap(v) {
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0) return this.dailyCap
    this.dailyCap = n
    this.saveSettings()
    return this.dailyCap
  }

  // ———————————————— 口径 ————————————————

  /** 剩余额度。关掉限制时返回 Infinity（上层就不用判断了）。 */
  get remaining() {
    if (!this.enabled) return Infinity
    this.rollover()
    return Math.max(0, this.dailyCap - this.day.used)
  }

  /** 今天还能不能用免费额度。 */
  canSpend() {
    if (!this.enabled) return true
    this.rollover()
    if (!this.dailyCap || this.dailyCap <= 0) return true
    return this.day.used < this.dailyCap
  }

  /**
   * 记一次模型调用（task-54：**唯一记账出口**）。
   *
   * 与旧 spend() 的区别：以前 credit<=0 就直接 return，连调用次数都不记；
   * 主脑走 intl 免费 flash 时 credit 恒为 0，于是账本永远停在个位数。现在：
   *   - **每次调用都 calls +1**（按 channel 分桶也 +1）
   *   - credit 只在拿到有限正数时累加（不编造）
   *   - tokens 只在真的拿到 usage 的 token 字段时累加；这次没拿到就 tokensKnown 不动，
   *     全天一次都没拿到时 snapshot 的 tokens 是 null（宁缺勿假）
   *
   * @param {object} p
   * @param {string} [p.channel='chat'] chat|degraded|spare|work|code|research
   * @param {number|null} [p.credit] 上游 usage.credit
   * @param {number|null} [p.promptTokens]
   * @param {number|null} [p.completionTokens]
   * @param {number|null} [p.reasoningTokens]
   * @param {number|null} [p.cachedTokens]
   * @param {number|null} [p.tokens] 已知总 token（不传就由三个分项相加）
   * @param {string} [p.provider]
   * @param {string} [p.model]
   * @returns {{channel:string, credit:number|null, tokens:number|null}}
   */
  record({ channel = 'chat', credit = null, promptTokens = null, completionTokens = null, reasoningTokens = null, cachedTokens = null, tokens = null, provider = '', model = '' } = {}) {
    this.rollover()
    const ch = String(channel || 'chat') || 'chat'
    if (!this.day.byChannel[ch]) {
      this.day.byChannel[ch] = { calls: 0, credit: 0, tokens: null, tokensKnown: 0 }
    }
    const bucket = this.day.byChannel[ch]
    this.day.calls += 1
    bucket.calls += 1

    const num = (v) => {
      if (v === null || v === undefined || v === '') return null
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    }
    const c = num(credit)
    if (c !== null && c > 0) {
      this.day.used = Math.round((this.day.used + c) * 100000) / 100000
      bucket.credit = Math.round((bucket.credit + c) * 100000) / 100000
    }

    /*
     * token 口径：优先用调用方算好的 tokens；否则 prompt+completion(+reasoning)。
     * 三个分项全是 null 时视为「这次拿不到 usage」，不写 tokens、不加 tokensKnown。
     */
    let total = num(tokens)
    if (total === null) {
      const parts = [num(promptTokens), num(completionTokens), num(reasoningTokens)].filter((n) => n !== null)
      if (parts.length > 0) total = parts.reduce((a, b) => a + b, 0)
    }
    if (total !== null && total >= 0) {
      this.day.tokens = (this.day.tokens || 0) + total
      this.day.tokensKnown += 1
      bucket.tokens = (bucket.tokens || 0) + total
      bucket.tokensKnown += 1
    }

    this.save()
    if (this.enabled && this.dailyCap > 0 && this.day.used >= this.dailyCap) {
      this.logger('warn', `今日免费积分已达上限 ${this.dailyCap}（已用 ${this.day.used.toFixed(2)}）`)
    }
    return { channel: ch, credit: c, tokens: total }
  }

  /**
   * 旧接口（兼容）：只记积分。
   * 新代码请用 record()，那里才会把「没有 usage 的调用」也计入 calls。
   */
  spend(credit) {
    const c = Number(credit)
    if (!Number.isFinite(c) || c <= 0) {
      // 老语义是「没花钱就不算调用」；新语义在 record() 里，这里保持旧行为
      return
    }
    this.record({ channel: 'chat', credit: c })
  }

  /**
   * 到顶了要不要发通知。**每天只发一次**——否则每条消息都会推一条"额度用完了"，
   * 那比不说话还烦。
   *
   * @returns {boolean} true = 这次该发
   */
  shouldNotifyExhausted() {
    if (!this.enabled) return false
    this.rollover()
    if (!this.dailyCap || this.dailyCap <= 0) return false
    if (this.day.used < this.dailyCap) return false
    if (this.day.notified) return false
    this.day.notified = true
    this.save()
    return true
  }

  /** 挂件/状态接口用的快照。旧字段一个不少（控制台在用），新字段只增不改。 */
  snapshot() {
    this.rollover()
    const byChannel = {}
    for (const [ch, v] of Object.entries(this.day.byChannel || {})) {
      byChannel[ch] = {
        calls: v.calls || 0,
        credit: Math.round((v.credit || 0) * 100) / 100,
        // 该 channel 一次 usage 都没拿到时给 null，不拿 0 冒充
        tokens: v.tokensKnown > 0 ? v.tokens : null,
      }
    }
    return {
      enabled: this.enabled,
      cap: this.dailyCap,
      used: Math.round(this.day.used * 100) / 100,
      remaining: this.enabled ? Math.max(0, Math.round((this.dailyCap - this.day.used) * 100) / 100) : null,
      calls: this.day.calls,
      date: this.day.date,
      exhausted: this.enabled && this.dailyCap > 0 && this.day.used >= this.dailyCap,
      notified: this.day.notified,
      // —— task-54 新增 ——
      // credit 与 used 同值，单独给一份是为了让控制台读「今天的积分」时不用猜口径
      credit: Math.round(this.day.used * 100) / 100,
      tokens: this.day.tokensKnown > 0 ? this.day.tokens : null,
      tokensKnown: this.day.tokensKnown,
      byChannel,
      // 明确告诉 UI：这是**本地记账**，不含 DSH 主会话 / WorkBuddy 的全局用量
      scope: 'local',
      note: '本地记账，不含 DSH 主会话',
    }
  }
}
