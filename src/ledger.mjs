/**
 * 茉莉花（Jasmine）记忆系统 · token 账本（P1-5）
 *
 * 为什么要单独一本账：陪伴型 Agent 的 token 花销跟「聊天多少」不成正比——
 * 一次走神、一次回滚、一次压缩都可能顶几十轮闲聊。只看总量根本看不出
 * 「钱花在哪个动作上」。所以账本按 **purpose** 分组：chat / proactive /
 * summary / verify / compaction / tool。有了这一维，才知道该省哪一刀。
 *
 * 只追加、不重算：每行一条 JSON，按天滚动；金额由宿主提供的价格表算，
 * 项目本身不内置任何价格（价格会变，写死就是过时数据）。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 允许分组的花费去向 */
export const PURPOSES = Object.freeze(['chat', 'proactive', 'summary', 'verify', 'compaction', 'tool', 'other'])

/** 价格表格式：{ [model]: { in: 元/百万token, cachedIn?: 同左, out: 同左 } } */
export const EMPTY_PRICES = Object.freeze({})

function round(n, digits = 4) {
  const p = 10 ** digits
  return Math.round(n * p) / p
}

function dayKeyOf(ts) {
  const d = new Date(Number(ts) || Date.now())
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export class TokenLedger {
  /**
   * @param {object} opts
   * @param {string} opts.file 账本文件（jsonl）
   * @param {object} [opts.prices] 价格表（元/百万 token）
   * @param {Function} [opts.clock]
   * @param {Function} [opts.logger]
   */
  constructor({ file, prices = EMPTY_PRICES, clock, logger } = {}) {
    if (!file) throw new Error('TokenLedger 需要 file')
    this.file = path.resolve(file)
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    this.prices = { ...prices }
    this.clock = clock || (() => Date.now())
    this.logger = logger || (() => {})
    this.cache = null
  }

  /** 记一次调用。tokens 全部是整数，缓存命中单独算 */
  record({ model = 'unknown', purpose = 'chat', inTokens = 0, outTokens = 0, cachedIn = 0, at = null } = {}) {
    const row = {
      t: at || this.clock(),
      model: String(model || 'unknown'),
      purpose: PURPOSES.includes(purpose) ? purpose : 'other',
      in: Math.max(0, Math.round(Number(inTokens) || 0)),
      out: Math.max(0, Math.round(Number(outTokens) || 0)),
      cached: Math.max(0, Math.round(Number(cachedIn) || 0)),
    }
    row.cost = this.costOf(row)
    try {
      fs.appendFileSync(this.file, `${JSON.stringify(row)}\n`, 'utf8')
      this.cache = null
    } catch (err) {
      this.logger('warn', `账本写入失败: ${err.message}`)
    }
    return row
  }

  /** 单条金额：未命中输入 + 缓存命中的输入 + 输出，价格缺省按 0 */
  costOf(row) {
    const price = this.prices[row.model]
    if (!price) return 0
    const miss = Math.max(0, (row.in || 0) - (row.cached || 0))
    const inCost = ((miss * (price.in || 0)) + ((row.cached || 0) * (price.cachedIn ?? price.in ?? 0))) / 1_000_000
    const outCost = ((row.out || 0) * (price.out || 0)) / 1_000_000
    return round(inCost + outCost, 6)
  }

  /** 读全量（有缓存；文件被外部改动时用 reload() 重置） */
  rows() {
    if (this.cache) return this.cache
    const out = []
    try {
      if (fs.existsSync(this.file)) {
        for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
          if (!line.trim()) continue
          try {
            out.push(JSON.parse(line))
          } catch {
            /* 坏行跳过：账本不能因为一行坏掉就整本不可用 */
          }
        }
      }
    } catch (err) {
      this.logger('warn', `账本读取失败: ${err.message}`)
    }
    this.cache = out
    return out
  }

  reload() {
    this.cache = null
    return this.rows()
  }

  /**
   * 汇总。可按 since/until（时间戳）和字节标签过滤。
   * @param {{since?: number, until?: number, byDay?: boolean}} [opts]
   */
  summary({ since = 0, until = Number.MAX_SAFE_INTEGER, byDay = true } = {}) {
    const rows = this.rows().filter((r) => r.t >= since && r.t <= until)
    const total = { calls: rows.length, in: 0, out: 0, cached: 0, cost: 0 }
    const byPurpose = {}
    const byModel = {}
    const days = {}
    for (const r of rows) {
      total.in += r.in || 0
      total.out += r.out || 0
      total.cached += r.cached || 0
      total.cost = round(total.cost + (r.cost || 0), 6)
      const p = (byPurpose[r.purpose] ||= { calls: 0, in: 0, out: 0, cost: 0 })
      p.calls += 1
      p.in += r.in || 0
      p.out += r.out || 0
      p.cost = round(p.cost + (r.cost || 0), 6)
      const m = (byModel[r.model] ||= { calls: 0, in: 0, out: 0, cost: 0 })
      m.calls += 1
      m.in += r.in || 0
      m.out += r.out || 0
      m.cost = round(m.cost + (r.cost || 0), 6)
      if (byDay) {
        const d = (days[dayKeyOf(r.t)] ||= { calls: 0, in: 0, out: 0, cached: 0, cost: 0 })
        d.calls += 1
        d.in += r.in || 0
        d.out += r.out || 0
        d.cached += r.cached || 0
        d.cost = round(d.cost + (r.cost || 0), 6)
      }
    }
    total.cachedRatio = total.in > 0 ? round(total.cached / total.in, 4) : 0
    return { total, byPurpose, byModel, ...(byDay ? { byDay: days } : {}) }
  }

  /** 最近 n 条 */
  tail(n = 20) {
    return this.rows().slice(-Math.max(1, n))
  }
}
