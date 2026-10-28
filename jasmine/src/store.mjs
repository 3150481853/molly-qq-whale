/**
 * 茉莉花（Jasmine）记忆系统 · 存储核心
 *
 * 设计目标：**双卡**
 *   1. 衰减卡（jasmine.json）：当前状态。可重建、可丢，丢了等于「重启记忆库」。
 *   2. 原始账（ledger.jsonl）：只追加，不修改。每次 add/update/remove/archive
 *      都落一行，事后能完整回放出「这些记忆是怎么长出来的」。
 *      它不参与召回，只用于审计、迁移和「找回来」。
 *
 * 为什么这样切：Molly 这类长期陪伴 Agent 的记忆出问题，绝大多数时候不是
 * 「检索不准」，而是「明明记过却没了」。衰减卡追求读写快、结构整齐，
 * 所以它必然是有损的（合并、覆盖、归档、裁剪都会改它）；
 * 原始账追求可复原，所以它只能追加。两者分开，互不背锅。
 *
 * 零依赖、纯 Node ESM、同步 IO：任何 Node ≥18 的宿主都能直接 import。
 */

import fs from 'node:fs'
import path from 'node:path'
import {
  ARCHIVABLE_KINDS,
  KINDS,
  WEIGHT_DEFAULT,
  applyHit,
  clampWeight,
  effectiveWeight,
  isArchivable,
  normalizeKind,
  weekKeyOf,
} from './decay.mjs'
import { applyCharBudget, fuseRecall, terms } from './recall.mjs'

const FORMAT = 'jasmine/1'
const RAW_OP_LIMIT_BYTES = 8 * 1024 * 1024

/** 两句话的字面相似度（0..1）：中文用二字组 Dice 系数，够用且不用分词 */
export function similarity(a, b) {
  const A = terms(a)
  const B = terms(b)
  if (!A.size || !B.size) return 0
  let hit = 0
  for (const t of A) if (B.has(t)) hit += 1
  return (2 * hit) / (A.size + B.size)
}

/** 否定词：用来判断「意思相反」，命中即视为冲突候选 */
const NEGATIONS = /(不|没|别|无|不是|没有|从不|不再)/

function normalizeText(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
}

function normalizeQq(qq) {
  const s = String(qq ?? '').trim()
  return /^[1-9]\d{4,11}$/.test(s) ? s : ''
}

export class JasmineStore {
  /**
   * @param {object} opts
   * @param {string} opts.dir 数据目录（会递归创建）
   * @param {string} [opts.name] 记忆系统名字（默认「茉莉花」）
   * @param {Function} [opts.logger] (level, msg) => void
   * @param {Function} [opts.clock] () => 时间戳，测试可注入
   * @param {number} [opts.limit] 热池容量，超出触发淘汰（默认 2000）
   * @param {boolean} [opts.raw] 是否写原始账（默认 true）
   */
  constructor({ dir, name = '茉莉花', logger, clock, limit = 2000, raw = true } = {}) {
    if (!dir) throw new Error('JasmineStore 需要 dir')
    this.dir = path.resolve(dir)
    fs.mkdirSync(this.dir, { recursive: true })
    this.name = name
    this.logger = logger || (() => {})
    this.clock = clock || (() => Date.now())
    this.limit = Math.max(10, Number(limit) || 2000)
    this.rawEnabled = raw !== false

    this.cardFile = path.join(this.dir, 'jasmine.json')
    this.rawFile = path.join(this.dir, 'ledger.jsonl')
    this.archiveFile = path.join(this.dir, '_archive.json')

    this.entries = []
    this.archive = []
    this.meta = {
      version: FORMAT,
      name: this.name,
      activeDays: 0,
      activeDayKey: '',
      lastCompactionAt: 0,
      createdAt: 0,
      updatedAt: 0,
    }
    this.broken = false
    this.folded = 0
    this.merged = 0
    this.load()
  }

  /* ---------------------------------------------------------------- 磁盘 */

  /** 活跃天的日历键（按本地时区，2026-10-27 起用「活跃天」而非日历天） */
  dayKeyOf(ts = this.clock()) {
    const d = new Date(Number(ts))
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  }

  load() {
    try {
      if (fs.existsSync(this.cardFile)) {
        const raw = JSON.parse(fs.readFileSync(this.cardFile, 'utf8'))
        this.meta = { ...this.meta, ...(raw?.meta || {}) }
        this.entries = Array.isArray(raw?.entries) ? raw.entries : []
      }
      if (fs.existsSync(this.archiveFile)) {
        const raw = JSON.parse(fs.readFileSync(this.archiveFile, 'utf8'))
        this.archive = Array.isArray(raw?.entries) ? raw.entries : []
      }
    } catch (err) {
      // 卡坏了别停：原始账还在，能从那里重建（见 rebuildFromRaw）
      this.broken = true
      this.logger('error', `衰减卡读取失败（可用 rebuildFromRaw 从原始账重建）: ${err.message}`)
    }
  }

  save() {
    this.meta.updatedAt = this.clock()
    const body = JSON.stringify({ meta: this.meta, entries: this.entries })
    const tmp = `${this.cardFile}.tmp`
    fs.writeFileSync(tmp, body, 'utf8')
    fs.renameSync(tmp, this.cardFile)
    return true
  }

  /** 追加一行原始账；超过上限轮转成 ledger.1.jsonl（只留一代，够回滚） */
  appendRaw(record) {
    if (!this.rawEnabled) return
    const line = `${JSON.stringify(record)}\n`
    try {
      fs.appendFileSync(this.rawFile, line, 'utf8')
      const st = fs.statSync(this.rawFile)
      if (st.size > RAW_OP_LIMIT_BYTES) fs.renameSync(this.rawFile, path.join(this.dir, 'ledger.1.jsonl'))
    } catch (err) {
      this.logger('warn', `原始账写入失败: ${err.message}`)
    }
  }

  /* ---------------------------------------------------------------- 写入 */

  /**
   * 记一条。返回条目；近似重复时返回 {...prev, skipped:true}。
   * @param {object} input
   * @param {string} [input.kind]
   * @param {string} [input.who]
   * @param {string} [input.qq]
   * @param {string} [input.text]
   * @param {number} [input.weight]
   * @param {string} [input.source] user / assistant / system
   * @param {number} [input.level] 压缩等级 0..3
   * @param {string} [input.messageId]
   * @param {string} [input.group] 群号（群聊记忆用，person 记忆留空）
   */
  add({
    kind = 'fact',
    who = '',
    qq = '',
    text = '',
    weight = WEIGHT_DEFAULT,
    source = 'user',
    level = 0,
    messageId = '',
    group = '',
  } = {}) {
    const body = normalizeText(text)
    if (!body) return null
    const k = normalizeKind(kind)
    const q = normalizeQq(qq)
    const name = String(who ?? '').trim()
    this.touch()

    const dup = this.findSimilar({ who: name, qq: q, text: body })
    const conflict = this.findConflict({ who: name, qq: q, text: body })

    if (dup && !conflict) {
      const prev = dup.entry
      if (dup.score >= 0.92) {
        prev.lastActiveDay = this.meta.activeDays
        prev.at = this.clock()
        this.merged += 1
        this.save()
        this.appendRaw({ t: Date.now(), op: 'merge', id: prev.id, score: round2(dup.score) })
        return { ...prev, skipped: true }
      }
      prev.text = body
      prev.at = this.clock()
      prev.weight = Math.max(clampWeight(prev.weight), clampWeight(weight))
      prev.lastActiveDay = this.meta.activeDays
      if (q && !prev.qq) prev.qq = q
      if (name && !prev.who) prev.who = name
      this.merged += 1
      this.save()
      this.appendRaw({ t: Date.now(), op: 'merge', id: prev.id, score: round2(dup.score), text: body })
      return prev
    }

    const entry = {
      id: `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      kind: k,
      who: name,
      qq: q,
      text: body,
      weight: clampWeight(weight),
      source: ['user', 'assistant', 'system'].includes(source) ? source : 'user',
      level: Math.max(0, Math.min(3, Math.round(Number(level) || 0))),
      hits: 0,
      lastActiveDay: this.meta.activeDays,
      at: this.clock(),
      ...(String(messageId ?? '').trim() ? { messageId: String(messageId).trim() } : {}),
      ...(String(group ?? '').trim() ? { group: String(group).trim() } : {}),
    }
    this.entries.push(entry)
    if (conflict) {
      conflict.supersededBy = entry.id
      conflict.supersededAt = Date.now()
    }
    this.prune()
    this.save()
    this.appendRaw({ t: Date.now(), op: 'add', id: entry.id, entry })
    return entry
  }

  update(id, patch = {}) {
    const e = this.byId(id)
    if (!e) return null
    for (const key of ['text', 'kind', 'who', 'qq', 'weight', 'level']) {
      if (!(key in patch)) continue
      if (key === 'kind') e.kind = normalizeKind(patch[key])
      else if (key === 'weight') e.weight = clampWeight(patch[key])
      else if (key === 'level') e.level = Math.max(0, Math.min(3, Math.round(Number(patch[key]) || 0)))
      else if (key === 'qq') e.qq = normalizeQq(patch[key])
      else e[key] = normalizeText(patch[key]) || e[key]
    }
    e.at = this.clock()
    this.save()
    this.appendRaw({ t: Date.now(), op: 'update', id: e.id, patch })
    return e
  }

  remove(id, { reason = '' } = {}) {
    const i = this.entries.findIndex((e) => e.id === id)
    if (i < 0) return false
    const [gone] = this.entries.splice(i, 1)
    this.save()
    this.appendRaw({ t: Date.now(), op: 'remove', id, reason, entry: gone })
    return true
  }

  /* ---------------------------------------------------------------- 查询 */

  byId(id) {
    return this.entries.find((e) => e.id === id) || null
  }

  markHits(ids = []) {
    const set = new Set(ids)
    let n = 0
    for (const e of this.entries) {
      if (!set.has(e.id)) continue
      applyHit(e, this.meta.activeDays)
      n += 1
    }
    if (n) {
      this.save()
      this.appendRaw({ t: Date.now(), op: 'hits', ids: [...set] })
    }
    return n
  }

  list({ kind = '', who = '', qq = '', group = '' } = {}) {
    const q = normalizeQq(qq)
    return this.entries.filter((e) => {
      if (kind && e.kind !== normalizeKind(kind)) return false
      if (q && e.qq !== q) return false
      if (who && e.who !== String(who).trim()) return false
      if (group && e.group !== String(group).trim()) return false
      return true
    })
  }

  /** 记一次活跃天：同一天多次调用只 +1 */
  touch() {
    const key = this.dayKeyOf()
    if (this.meta.activeDayKey === key) return this.meta.activeDays
    this.meta.activeDayKey = key
    this.meta.activeDays += 1
    return this.meta.activeDays
  }

  /**
   * 召回：个人 + 全局（+ 可选群记忆），两路 RRF 融合。
   * @param {object} opts
   * @param {string} [opts.who]
   * @param {string} [opts.qq]
   * @param {string} [opts.query]
   * @param {string} [opts.group]
   * @param {number} [opts.limit]
   * @param {number} [opts.charBudget]
   * @param {boolean} [opts.includeSuperseded]
   * @returns {{items: object[], trace: object}}
   */
  recall({
    who = '',
    qq = '',
    query = '',
    group = '',
    limit = 12,
    charBudget = 0,
    includeSuperseded = false,
  } = {}) {
    const q = normalizeQq(qq)
    const name = String(who ?? '').trim()
    const g = String(group ?? '').trim()
    const candidates = this.entries.filter((e) => {
      if (e.supersededBy && !includeSuperseded) return false
      if (g && e.group === g) return true
      if (q && e.qq === q) return true
      if (!q && name && e.who === name) return true
      if (!e.qq && !e.who && !e.group) return true
      return false
    })
    const activeDays = this.meta.activeDays
    const { items, arms } = fuseRecall(candidates, {
      query,
      activeDays,
      now: this.clock(),
      weightOf: (e) => effectiveWeight(e, activeDays),
    })
    const top = applyCharBudget(items, charBudget).slice(0, Math.max(1, Number(limit) || 12))
    this.markHits(top.map((x) => x.entry.id))
    const trace = {
      at: Date.now(),
      query,
      scope: { qq: q, who: name, group: g },
      candidates: candidates.length,
      arms,
      kept: top.length,
    }
    return { items: top.map((x) => ({ ...x.entry, score: round4(x.score), ranks: x.ranks })), trace }
  }

  /** 统计信息（控制台/状态接口用） */
  status() {
    const counts = {}
    for (const k of KINDS) counts[k] = 0
    let chars = 0
    for (const e of this.entries) {
      counts[e.kind] = (counts[e.kind] || 0) + 1
      chars += String(e.text || '').length
    }
    return {
      name: this.meta.name,
      dir: this.dir,
      count: this.entries.length,
      limit: this.limit,
      archiveCount: this.archive.length,
      activeDays: this.meta.activeDays,
      activeDayKey: this.meta.activeDayKey,
      lastCompactionAt: this.meta.lastCompactionAt,
      chars,
      counts,
      broken: this.broken,
    }
  }

  /* ------------------------------------------------------- 去重 / 冲突 / 淘汰 */

  /** 找「同一个人 + 同一件事」的老条目，带相似度 */
  findSimilar({ who = '', qq = '', text = '' } = {}) {
    const q = normalizeQq(qq)
    const name = String(who ?? '').trim()
    const body = normalizeText(text)
    if (!body) return null
    let best = null
    for (const e of this.entries) {
      if (e.supersededBy) continue
      const samePerson = (q && e.qq === q) || (!q && name && e.who === name)
      const bothGlobal = !e.qq && !e.who && !q && !name
      if (!samePerson && !bothGlobal) continue
      const score = similarity(body, e.text)
      if (score >= 0.70 && (!best || score > best.score)) best = { entry: e, score }
    }
    return best
  }

  /** 找意思相反的老条目（「喜欢猫」vs「不喜欢猫」），字面相似度进不了去重门槛 */
  findConflict({ who = '', qq = '', text = '' } = {}) {
    const q = normalizeQq(qq)
    const name = String(who ?? '').trim()
    const body = normalizeText(text)
    if (!body) return null
    const neg = NEGATIONS.test(body)
    for (const e of this.entries) {
      if (e.supersededBy) continue
      const samePerson = (q && e.qq === q) || (!q && name && e.who === name)
      if (!samePerson) continue
      if (NEGATIONS.test(String(e.text)) === neg) continue
      // 去掉否定词再比，相似度够高才认定是「同一个话题的正反两面」
      const a = body.replace(NEGATIONS, '')
      const b = String(e.text).replace(NEGATIONS, '')
      if (similarity(a, b) >= 0.45) return e
    }
    return null
  }

  /** 超容量时淘汰：先归档可归档的，再按「有效权重 + 最近性」从低到高移出热池 */
  prune() {
    if (this.entries.length <= this.limit) return 0
    const removable = this.entries
      .filter((e) => ARCHIVABLE_KINDS.includes(e.kind))
      .sort((a, b) => effectiveWeight(a, this.meta.activeDays) - effectiveWeight(b, this.meta.activeDays))
    let moved = 0
    for (const e of removable) {
      if (this.entries.length <= this.limit) break
      this.moveToArchive(e, 'prune')
      moved += 1
    }
    return moved
  }

  /** 把够老的 event/meme 挪进归档簿（不物理删除，人工可复原） */
  archiveStale() {
    let moved = 0
    for (const e of [...this.entries]) {
      if (!isArchivable(e, { activeDays: this.meta.activeDays })) continue
      this.moveToArchive(e, 'stale')
      moved += 1
    }
    if (moved) this.save()
    return moved
  }

  moveToArchive(entry, reason) {
    const i = this.entries.indexOf(entry)
    if (i < 0) return false
    this.entries.splice(i, 1)
    this.archive.push({ ...entry, _archivedAt: Date.now(), _reason: reason })
    this.appendRaw({ t: Date.now(), op: 'archive', id: entry.id, reason })
    return true
  }

  /* ---------------------------------------------------------------- 周聚合 */

  /**
   * 把某一周的事件聚合成一条 level=2 的摘要，原事件 level+1。
   * @param {object} opts
   * @param {string} [opts.weekKey] 不传就取上一周
   * @param {Function} [opts.write] 自定义写摘要的方式（默认用 add 写 kind=event、level=2）
   * @returns {{weekKey: string, facts: object[], summary: object|null, chars: number}}
   */
  aggregateWeek({ weekKey = '', write = null } = {}) {
    const key = weekKey || weekKeyOf(this.clock() - 7 * 86_400_000)
    const from = weekStart(key)
    const to = from + 7 * 86_400_000
    const facts = this.entries.filter((e) => {
      if (e.kind !== 'event' || e.level >= 2) return false
      if (e.weekSummaryFor) return false
      const t = Number(e.at) || 0
      return t >= from && t < to
    })
    if (!facts.length) return { weekKey: key, facts: [], summary: null, chars: 0 }
    const lines = facts.map((e) => `- ${e.who || '某人'}：${e.text}`)
    const chars = lines.join('\n').length
    const summary =
      write?.(key, lines, facts) ??
      this.add({
        kind: 'event',
        text: `【${key} 周记】\n${lines.join('\n')}`,
        weight: 8,
        level: 2,
        source: 'system',
      })
    for (const e of facts) {
      e.level = Math.min(3, (Number(e.level) || 0) + 1)
      e.weekSummaryFor = key
    }
    this.meta.lastCompactionAt = Date.now()
    this.save()
    this.appendRaw({ t: Date.now(), op: 'week', weekKey: key, ids: facts.map((e) => e.id), chars })
    return { weekKey: key, facts, summary, chars }
  }

  /** 上一周有没有聚合过；没有就返回缺的周（最多 lookback 周，当前周不算） */
  missingWeeks({ lookback = 2 } = {}) {
    const out = []
    const done = new Set(this.entries.filter((e) => e.weekSummaryFor).map((e) => e.weekSummaryFor))
    for (let i = 1; i <= Math.max(1, lookback); i++) {
      const key = weekKeyOf(this.clock() - i * 7 * 86_400_000)
      if (!done.has(key)) out.push(key)
    }
    return out.reverse()
  }

  /* ---------------------------------------------------------------- 账本 */

  /** 最近 n 行原始账（审计/调试用） */
  tailRaw(n = 20) {
    try {
      if (!fs.existsSync(this.rawFile)) return []
      const lines = fs.readFileSync(this.rawFile, 'utf8').trim().split('\n').filter(Boolean)
      return lines.slice(-Math.max(1, n)).map((l) => JSON.parse(l))
    } catch {
      return []
    }
  }

  /** 从原始账重建衰减卡（卡坏了、或换宿主时用） */
  rebuildFromRaw() {
    const lines = []
    for (const file of [path.join(this.dir, 'ledger.1.jsonl'), this.rawFile]) {
      try {
        if (fs.existsSync(file)) lines.push(...fs.readFileSync(file, 'utf8').split('\n').filter(Boolean))
      } catch {}
    }
    const entries = new Map()
    const archive = new Map()
    for (const line of lines) {
      let rec
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      if (rec.op === 'add' && rec.entry) entries.set(rec.id, rec.entry)
      else if (rec.op === 'merge' && entries.has(rec.id) && rec.text) entries.get(rec.id).text = rec.text
      else if (rec.op === 'update' && entries.has(rec.id)) Object.assign(entries.get(rec.id), rec.patch || {})
      else if (rec.op === 'remove') entries.delete(rec.id)
      else if (rec.op === 'archive' && entries.has(rec.id)) {
        archive.set(rec.id, entries.get(rec.id))
        entries.delete(rec.id)
      } else if (rec.op === 'hits' && Array.isArray(rec.ids)) {
        for (const id of rec.ids) if (entries.has(id)) entries.get(id).hits = (Number(entries.get(id).hits) || 0) + 1
      } else if (rec.op === 'week' && rec.weekKey) {
        // 周聚合只是记账，条目本身已经在 add 时进过 entries
      }
    }
    this.entries = [...entries.values()]
    this.archive = [...archive.values()]
    // 活跃天总数没法从原始账精确回放，取条目里的最大值兜底（只会偏小，不会偏大）
    this.meta.activeDays = this.entries.reduce(
      (max, e) => Math.max(max, Number(e.lastActiveDay) || 0),
      this.meta.activeDays,
    )
    this.save()
    fs.writeFileSync(this.archiveFile, JSON.stringify({ meta: { name: this.name }, entries: this.archive }), 'utf8')
    return { entries: this.entries.length, archive: this.archive.length, scanned: lines.length }
  }

  /* ---------------------------------------------------------------- 搬运 */

  /** 导出整包（衰减卡 + 归档 + 元信息），用于换宿主/备份 */
  exportBundle() {
    return { format: FORMAT, meta: { ...this.meta }, entries: this.entries, archived: this.archive }
  }

  /** 导入整包；mode=merge 时按 id 去重并保留本地更新的那条 */
  importBundle(bundle, { mode = 'replace' } = {}) {
    if (!bundle || !Array.isArray(bundle.entries)) throw new Error('importBundle: 不是合法的茉莉花包')
    if (mode === 'replace') {
      this.entries = bundle.entries.map((e) => ({ ...e }))
      this.archive = Array.isArray(bundle.archived) ? bundle.archived.map((e) => ({ ...e })) : []
      this.meta = { ...this.meta, ...(bundle.meta || {}), name: bundle.meta?.name || this.name }
    } else {
      const have = new Set(this.entries.map((e) => e.id))
      for (const e of bundle.entries) if (!have.has(e.id)) this.entries.push({ ...e })
    }
    this.save()
    fs.writeFileSync(this.archiveFile, JSON.stringify({ meta: { name: this.name }, entries: this.archive }), 'utf8')
    this.appendRaw({ t: Date.now(), op: 'import', mode, count: bundle.entries.length })
    return this.status()
  }
}

/** 某一周的周一 00:00 时间戳（按周键） */
export function weekStart(weekKey) {
  const m = /^(\d{4})-W(\d{2})$/.exec(String(weekKey))
  if (!m) return 0
  const year = Number(m[1])
  const week = Number(m[2])
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const dow = (jan4.getUTCDay() + 6) % 7
  const monday = new Date(jan4.getTime() - dow * 86_400_000 + (week - 1) * 7 * 86_400_000)
  return monday.getTime()
}

function round2(n) {
  return Math.round(n * 100) / 100
}

function round4(n) {
  return Math.round(n * 10000) / 10000
}
