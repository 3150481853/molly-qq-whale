/**
 * 备用脑的每日积分预算。
 *
 * 为什么和 budget.js 分开（用户 m15210 / m15220 定案）：
 *
 *   主脑走的车道是「intl 免费 flash」。它 credit 恒为 0，所以主脑**不需要**
 *   日预算——唯一的问题是免费车道被限流，那时切 cn 的 v4-pro（按积分计费），
 *   这条由 callWithFallback 的 slowMode 处理。
 *
 *   备用脑是另一回事：主脑两条车道（intl 免费、cn 积分池 v4-pro）都不可用时，
 *   退到 **cn 的 deepseek-v4.1-flash**。它便宜（实测一句 0.01 分，v4-pro 的
 *   1/3）但不免费，所以用户要求「限制改为 500 每天」——不是 500 次，是
 *   **500 积分**。烧满 500 分之后，备用脑也断供，再往下才是 trae 的 v4-pro。
 *
 * 为什么不能复用 CreditBudget：
 *   两者的语义完全不同。CreditBudget 管的是「主脑还能不能花积分」，
 *   它一旦耗尽就整体降级到 trae；而备用脑预算是「退路还能烧多久」，
 *   它耗尽了才降级。混用一个计数器会导致：主脑正常时把备用脑的额度扣光，
 *   真需要退路时已经没额度了。
 *
 * 口径：还是自己累计 usage.credit（理由同 budget.js 文件头——billing 接口滞后）。
 * 持久化：spare-budget.json，重启不丢当天已用。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 本地日期 YYYY-MM-DD，跟 budget.js 保持同一口径。 */
function localDateKey(d = new Date()) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export class SpareBudget {
  /**
   * @param {object} p
   * @param {string} p.dir          落盘目录
   * @param {(lv:string,msg:string)=>void} [p.logger]
   * @param {boolean} [p.enabled]   总开关；关掉 = 备用脑不限量，一直用 cn flash
   * @param {number}  [p.dailyCap]  每日上限（积分），用户定的是 500
   */
  constructor({ dir, logger, enabled = true, dailyCap = 500 } = {}) {
    this.dir = dir
    this.logger = logger || (() => {})
    this.enabled = enabled !== false
    this.dailyCap = Number(dailyCap) || 0
    this.file = dir ? path.join(dir, 'spare-budget.json') : ''

    /** @type {{date:string, used:number, calls:number, notified:boolean}} */
    this.day = { date: localDateKey(), used: 0, calls: 0, notified: false }
    this.load()
  }

  load() {
    if (!this.file) return
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (!j || typeof j !== 'object') return
      const today = localDateKey()
      if (j.date === today) {
        this.day = {
          date: today,
          used: Number(j.used) || 0,
          calls: Number(j.calls) || 0,
          notified: Boolean(j.notified),
        }
      } else {
        this.yesterday = { date: j.date, used: Number(j.used) || 0, calls: Number(j.calls) || 0 }
      }
    } catch {
      /* 没有或坏了都从零开始 */
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
      this.logger('debug', `备用脑预算落盘失败：${err?.message || err}`)
    }
  }

  /** 换天归零。返回 true 表示刚跨天。 */
  rollover() {
    const today = localDateKey()
    if (this.day.date === today) return false
    this.yesterday = { date: this.day.date, used: this.day.used, calls: this.day.calls }
    this.day = { date: today, used: 0, calls: 0, notified: false }
    this.save()
    this.logger('info', `备用脑预算跨天重置（昨天用了 ${(this.yesterday.used || 0).toFixed(2)} 分）`)
    return true
  }

  /** 备用脑还能不能烧。关掉限制时永远 true。 */
  canSpend() {
    if (!this.enabled) return true
    this.rollover()
    if (!this.dailyCap || this.dailyCap <= 0) return true
    return this.day.used < this.dailyCap
  }

  /** 记一笔。credit 来自上游 usage.credit。 */
  spend(credit) {
    const c = Number(credit)
    if (!Number.isFinite(c) || c <= 0) return
    this.rollover()
    this.day.used = Math.round((this.day.used + c) * 1000) / 1000
    this.day.calls += 1
    this.save()
    if (this.enabled && this.dailyCap > 0 && this.day.used >= this.dailyCap) {
      this.logger('warn', `备用脑今日积分已达上限 ${this.dailyCap}（已用 ${this.day.used.toFixed(2)}）`)
    }
  }

  /**
   * 烧满了要不要在 QQ 上说一声。**每天只说一次**——理由同
   * CreditBudget.shouldNotifyExhausted：每条都推一遍比不说还烦。
   *
   * @returns {boolean} true = 这次该说
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

  /** 挂件/状态接口用的快照。 */
  snapshot() {    this.rollover()
    return {
      enabled: this.enabled,
      cap: this.dailyCap,
      used: Math.round(this.day.used * 100) / 100,
      remaining: this.enabled
        ? Math.max(0, Math.round((this.dailyCap - this.day.used) * 100) / 100)
        : null,
      calls: this.day.calls,
      date: this.day.date,
      exhausted: this.enabled && this.dailyCap > 0 && this.day.used >= this.dailyCap,
    }
  }
}
