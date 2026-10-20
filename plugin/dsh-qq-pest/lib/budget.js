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

    /** @type {{date:string, used:number, calls:number, notified:boolean}} */
    this.day = { date: localDateKey(), used: 0, calls: 0, notified: false }
    this.load()
    this.loadSettings()
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
          this.day = {
            date: today,
            used: Number(j.used) || 0,
            calls: Number(j.calls) || 0,
            notified: Boolean(j.notified),
          }
        } else {
          // 跨天了：保留历史最后一条便于看，但当天从零开始
          this.yesterday = { date: j.date, used: Number(j.used) || 0, calls: Number(j.calls) || 0 }
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
    this.yesterday = { date: this.day.date, used: this.day.used, calls: this.day.calls }
    this.day = { date: today, used: 0, calls: 0, notified: false }
    this.save()
    this.logger('info', `积分预算跨天重置（昨天用了 ${(this.yesterday.used || 0).toFixed(2)} 分）`)
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

  /** 记一笔用量。credit 来自上游 usage.credit。 */
  spend(credit) {
    const c = Number(credit)
    if (!Number.isFinite(c) || c <= 0) return
    this.rollover()
    this.day.used = Math.round((this.day.used + c) * 1000) / 1000
    this.day.calls += 1
    this.save()
    if (this.enabled && this.dailyCap > 0 && this.day.used >= this.dailyCap) {
      this.logger('warn', `今日免费积分已达上限 ${this.dailyCap}（已用 ${this.day.used.toFixed(2)}）`)
    }
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

  /** 挂件/状态接口用的快照。 */
  snapshot() {
    this.rollover()
    return {
      enabled: this.enabled,
      cap: this.dailyCap,
      used: Math.round(this.day.used * 100) / 100,
      remaining: this.enabled ? Math.max(0, Math.round((this.dailyCap - this.day.used) * 100) / 100) : null,
      calls: this.day.calls,
      date: this.day.date,
      exhausted: this.enabled && this.dailyCap > 0 && this.day.used >= this.dailyCap,
      notified: this.day.notified,
    }
  }
}
