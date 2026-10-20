/**
 * 待核实区（2026-10-19，用户需求）：入库闸门拦下来的记忆，和带侮辱性的记录，
 * 先存在这里等人工过一眼，不直接进正式库、也不直接丢。
 *
 * 用户原话：「控制台要一个待核实区，放被你拦下来的记忆 + 带侮辱性的，
 * 比如说是你爹，说你是傻逼」。
 *
 * 落盘：`${HOME}\.dsh\qq-whale\memory\pending.json`
 * 形状：`{ updatedAt, items: [{ id, kind, who, qq, text, weight, at, reason, createdAt }] }`
 * 上限：200 条，超了丢**最旧**的（宁可丢旧的，也别把新拦的挤掉）。
 *
 * 三条设计约束（改之前先读）：
 *   1. **这个模块不写 memory.json**。`approve()` 只把条目**交回调用方**，
 *      入库由 engine 用 `MemoryStore.add()` 做——全项目只有 `memory.js:save()`
 *      一个内存→磁盘的写盘点，多一个就会互相覆盖。
 *   2. **写盘用 tmp + rename**。pending.json 不重要，但半截 JSON 会让控制台整页崩，
 *      而 `load()` 一旦抛异常，后面的 add 就会把整库覆盖成一条。
 *   3. **同一句话反复被拦只记一次**（同 who/qq + 同 text），只把 `at` 刷新。
 *      不然一个走火的模型能把 200 条上限一天内刷满。
 */

import fs from 'node:fs'
import path from 'node:path'
import { normalizeQq } from './memory.js'

/** 上限：超了丢最旧的 */
export const PENDING_LIMIT = 200

/** 控制台/engine 想给条目补字段时，允许透传的最大长度，防止有人把整段对话塞进来 */
const TEXT_MAX = 400

/** 同一条文本的「不重复入队」窗口：24 小时（过了窗口再出现，会重新计时，不是永久去重） */
const REQUEUE_MS = 24 * 60 * 60 * 1000

export class PendingStore {
  /**
   * @param {object} opts
   * @param {string} opts.dir   记忆目录（和 memory.json 同一个目录）
   * @param {(level: string, msg: string) => void} [opts.logger]
   * @param {number} [opts.limit]
   */
  constructor({ dir, logger, limit = PENDING_LIMIT } = {}) {
    this.dir = dir || ''
    this.logger = logger || (() => {})
    this.limit = limit
    this.file = path.join(this.dir, 'pending.json')
    this.items = []
    this.load()
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      const list = Array.isArray(parsed?.items) ? parsed.items : []
      this.items = list
        .filter((e) => e && typeof e.text === 'string' && e.text.trim())
        .map((e) => ({
          id: String(e.id || ''),
          kind: String(e.kind || 'fact'),
          who: String(e.who || '').trim(),
          qq: normalizeQq(e.qq),
          text: String(e.text).trim(),
          weight: Math.max(1, Math.min(5, Number(e.weight) || 3)),
          at: Number(e.at) || Date.now(),
          reason: String(e.reason || 'unknown'),
          createdAt: Number(e.createdAt) || Number(e.at) || Date.now(),
        }))
    } catch (err) {
      // 文件不存在是正常的（第一次启动）；真坏了只报警、不当场清空
      if (err.code !== 'ENOENT') this.logger('warn', `pending.json 读取失败: ${err.message}`)
      this.items = []
    }
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const body = JSON.stringify({ updatedAt: Date.now(), items: this.items }, null, 2)
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, body, 'utf8')
      fs.renameSync(tmp, this.file)
      return true
    } catch (err) {
      this.logger('error', `pending.json 写入失败: ${err.message}`)
      return false
    }
  }

  /** 超上限丢最旧的（createdAt 最小） */
  prune() {
    if (this.items.length <= this.limit) return 0
    const sorted = [...this.items].sort((a, b) => a.createdAt - b.createdAt)
    const drop = sorted.slice(0, this.items.length - this.limit)
    const dropIds = new Set(drop.map((d) => d.id))
    this.items = this.items.filter((e) => !dropIds.has(e.id))
    return drop.length
  }

  /**
   * 收一条待核实记忆。
   *
   * 同一句（同 text + who + qq）**24 小时内**重复只刷新 `at`，不重复堆——
   * 一个走火的模型能在一天内把 200 条上限刷满。超过 24 小时再出现，
   * `createdAt` 重新计时（等于「重新被拦了一次」），所以不是永久去重，
   * 一条长期赖着的垃圾不会永远排在队尾看不见。
   *
   * @param {object} input
   * @param {number} [input.now] 测试用：注入当前时间
   * @returns {object|null} 条目；text 为空返回 null
   */
  add({ kind = 'fact', who = '', qq = '', text = '', weight = 3, at = Date.now(), reason = 'unknown', now } = {}) {
    const t = String(text || '').trim().slice(0, TEXT_MAX)
    if (!t) return null
    const clock = Number(now) || Date.now()
    const q = normalizeQq(qq)
    const name = String(who || '').trim()
    const same = this.items.find((e) => e.text === t && e.who === name && e.qq === q)
    if (same) {
      same.at = Number(at) || clock
      same.reason = reason
      if (clock - same.createdAt >= REQUEUE_MS) {
        same.createdAt = clock
        this.logger('debug', `待核实区条目超 24 小时重新入队：${t.slice(0, 30)}`)
      }
      this.save()
      return same
    }
    const item = {
      id: `p${clock.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      kind: String(kind || 'fact'),
      who: name,
      qq: q,
      text: t,
      weight: Math.max(1, Math.min(5, Number(weight) || 3)),
      at: Number(at) || clock,
      reason: String(reason || 'unknown'),
      createdAt: clock,
    }
    this.items.push(item)
    const dropped = this.prune()
    if (dropped) this.logger('debug', `待核实区超上限，丢弃最旧 ${dropped} 条`)
    this.save()
    return item
  }

  /**
   * 列表：新的在前。可用 reason / who 过滤。
   * @returns {object[]}
   */
  list({ limit = 0, reason = '', who = '' } = {}) {
    let out = [...this.items].sort((a, b) => b.createdAt - a.createdAt)
    if (reason) out = out.filter((e) => e.reason === reason)
    if (who) out = out.filter((e) => e.who === who)
    return limit > 0 ? out.slice(0, limit) : out
  }

  get(id) {
    return this.items.find((e) => e.id === id) || null
  }

  count() {
    return this.items.length
  }

  /**
   * 通过一条：**只从待核实区拿掉**，把内容交回调用方入库。
   *
   * 为什么不在这里直接写 memory.json：内存数组在 `MemoryStore` 里，
   * 这里写盘会被它下一次 `save()` 整库覆写；而且 pending.json 和 memory.json
   * 的写顺序没协调过，两处独立写必然打架。
   *
   * @returns {{ok: boolean, entry?: object, item?: object, error?: string}}
   */
  approve(id) {
    const i = this.items.findIndex((e) => e.id === id)
    if (i < 0) return { ok: false, error: '待核实条目不存在' }
    const it = this.items[i]
    this.items.splice(i, 1)
    this.save()
    // 交给调用方去 MemoryStore.add()——这里只负责"放行"这件事本身
    return {
      ok: true,
      item: it,
      entry: { kind: it.kind, who: it.who, qq: it.qq, text: it.text, weight: it.weight, at: it.at },
    }
  }

  /** 直接丢掉一条 */
  reject(id) {
    const i = this.items.findIndex((e) => e.id === id)
    if (i < 0) return false
    this.items.splice(i, 1)
    this.save()
    return true
  }

  /** 全清（控制台「清空待核实区」用；返回清掉几条） */
  clear() {
    const n = this.items.length
    this.items = []
    if (n) this.save()
    return n
  }
}

export default PendingStore
