#!/usr/bin/env node
/**
 * 茉莉花控制台（Jasmine Controller）· 单进程 HTTP 服务
 *
 * 只做一件事：把 JasmineStore 的记忆库摆到浏览器里看和改。
 * 零依赖（只用 node: 内置模块），Node >= 18，只监听 127.0.0.1。
 *
 *   node controller/server.mjs --dir <数据目录> --port 19430 [--open]
 *
 * 所有写操作都是 POST + JSON body；只读走 GET。
 */

import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  ARCHIVE_IDLE_DAYS,
  DECAY_STEP,
  DECAY_STEP_DAYS,
  GRACE_ACTIVE_DAYS,
  JasmineStore,
  KINDS,
  WEIGHT_FLOOR,
  clampWeight,
  effectiveWeight,
  isArchivable,
  normalizeKind,
} from '../index.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB_DIR = path.join(HERE, 'web')
const CONFIG_FILE = path.join(HERE, 'config.json')
const MAX_TEXT_CHARS = 200
const MAX_BODY_BYTES = 16 * 1024 * 1024
const PAGE_LIMIT_MAX = 200
const DEFAULT_PORT = 19430
const SENT = Symbol('sent')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
}

const BAND_KEYS = ['full', 'high', 'mid', 'low', 'floor']
const SORTS = {
  'at-desc': (a, b) => (b.at || 0) - (a.at || 0) || String(a.id).localeCompare(String(b.id)),
  'at-asc': (a, b) => (a.at || 0) - (b.at || 0) || String(a.id).localeCompare(String(b.id)),
  'eff-desc': (a, b) => b.eff - a.eff || (b.at || 0) - (a.at || 0),
  'eff-asc': (a, b) => a.eff - b.eff || (a.at || 0) - (b.at || 0),
  'hits-desc': (a, b) => (b.hits || 0) - (a.hits || 0) || (b.at || 0) - (a.at || 0),
}

/* ------------------------------------------------------------------ 小工具 */

function parseArgs(argv) {
  const out = { dir: '', port: DEFAULT_PORT, open: false, limit: 0 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dir') out.dir = argv[++i] || ''
    else if (a.startsWith('--dir=')) out.dir = a.slice(6)
    else if (a === '--port') out.port = Number(argv[++i]) || out.port
    else if (a.startsWith('--port=')) out.port = Number(a.slice(7)) || out.port
    else if (a === '--limit') out.limit = Number(argv[++i]) || 0
    else if (a.startsWith('--limit=')) out.limit = Number(a.slice(8)) || 0
    else if (a === '--open') out.open = true
    else if (a === '--help' || a === '-h') out.help = true
  }
  return out
}

function readConfigFile() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return {}
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}
  } catch (err) {
    console.warn(`[warn] config.json 读不了，按默认走：${err.message}`)
    return {}
  }
}

function resolveDataDir(argDir) {
  if (argDir) return path.resolve(argDir)
  const conf = readConfigFile()
  if (conf.dataDir) return path.resolve(HERE, String(conf.dataDir))
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return path.join(base, 'Jasmine', 'data')
}

function fitText(value) {
  const s = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  const cps = Array.from(s)
  if (cps.length <= MAX_TEXT_CHARS) return { text: s, truncated: false }
  return { text: cps.slice(0, MAX_TEXT_CHARS).join(''), truncated: true }
}

function bandOf(eff) {
  if (eff >= 9.95) return 'full'
  if (eff >= 8) return 'high'
  if (eff >= 5) return 'mid'
  if (eff >= 3) return 'low'
  return 'floor'
}

function sameLocalDay(ts, now) {
  const a = new Date(Number(ts) || 0)
  const b = new Date(Number(now) || 0)
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  )
}

function dayBucketOf(ts, now) {
  const t = Number(ts) || 0
  const age = Math.max(0, now - t)
  if (sameLocalDay(t, now)) return 'today'
  if (age < 7 * 86_400_000) return '7d'
  if (age < 30 * 86_400_000) return '30d'
  if (age < 90 * 86_400_000) return '90d'
  return 'older'
}

function fail(status, message) {
  const err = new Error(message)
  err.status = status
  return err
}

/* ------------------------------------------------------------------ 启动 */

const args = parseArgs(process.argv.slice(2))
if (args.help) {
  console.log(
    [
      '茉莉花控制台',
      '',
      '  node controller/server.mjs --dir <数据目录> --port 19430 [--open]',
      '',
      '  --dir    数据目录（缺省读 controller/config.json 的 dataDir，再退到 %LOCALAPPDATA%\\Jasmine\\data）',
      '  --port   端口，默认 19430，只监听 127.0.0.1',
      '  --limit  热池容量上限，默认 20000（控制台是浏览用途，别让上千条记忆被 prune 进归档册）',
      '  --open   启动后打开浏览器',
    ].join('\n'),
  )
  process.exit(0)
}

const dataDir = resolveDataDir(args.dir)
const port = Number(args.port) > 0 && Number(args.port) < 65536 ? Number(args.port) : DEFAULT_PORT
const storeLimit = Number(args.limit) > 0 ? Math.round(Number(args.limit)) : 20000

let store
try {
  store = new JasmineStore({ dir: dataDir, name: '茉莉花', limit: storeLimit })
} catch (err) {
  console.error(`[fatal] 数据目录打不开：${dataDir}\n        ${err.message}`)
  process.exit(1)
}

/* ------------------------------------------------------------------ 派生数据 */

function activeDaysNow() {
  return Math.max(0, Math.round(Number(store.meta.activeDays) || 0))
}

function decorate(e) {
  const activeDays = activeDaysNow()
  const kind = normalizeKind(e.kind)
  const grace = GRACE_ACTIVE_DAYS[kind]
  const base = clampWeight(e.weight)
  const eff = effectiveWeight(e, activeDays)
  const idle = Math.max(0, activeDays - Math.round(Number(e.lastActiveDay) || 0))
  return {
    ...e,
    kind,
    base,
    eff,
    idle,
    grace: Number.isFinite(grace) ? grace : null,
    graceInf: !Number.isFinite(grace),
    floor: WEIGHT_FLOOR[kind] ?? 1,
    stepDays: DECAY_STEP_DAYS,
    step: DECAY_STEP,
    dropped: Math.max(0, Math.round((base - eff) * 10) / 10),
  }
}

function statusPayload() {
  const st = store.status()
  const activeDays = activeDaysNow()
  let identified = 0
  let sum = 0
  for (const e of store.entries) {
    if (String(e.who ?? '').trim() || String(e.qq ?? '').trim()) identified += 1
    sum += effectiveWeight(e, activeDays)
  }
  return {
    ok: true,
    name: st.name,
    dir: st.dir,
    count: st.count,
    limit: st.limit,
    archiveCount: st.archiveCount,
    archiveLimitDays: ARCHIVE_IDLE_DAYS,
    activeDays: st.activeDays,
    activeDayKey: st.activeDayKey,
    lastCompactionAt: st.lastCompactionAt,
    chars: st.chars,
    counts: st.counts,
    broken: st.broken,
    identified,
    avgEff: st.count ? Math.round((sum / st.count) * 10) / 10 : 0,
    kinds: KINDS,
    floor: WEIGHT_FLOOR,
    grace: GRACE_ACTIVE_DAYS.address === Infinity ? { ...GRACE_ACTIVE_DAYS, address: null } : GRACE_ACTIVE_DAYS,
    step: DECAY_STEP,
    stepDays: DECAY_STEP_DAYS,
  }
}

function facets() {
  const kinds = {}
  for (const k of KINDS) kinds[k] = 0
  const whoMap = new Map()
  const bands = { full: 0, high: 0, mid: 0, low: 0, floor: 0 }
  const days = { today: 0, '7d': 0, '30d': 0, '90d': 0, older: 0 }
  const now = Date.now()
  for (const e of store.entries) {
    kinds[e.kind] = (kinds[e.kind] || 0) + 1
    const name = String(e.who ?? '').trim()
    if (name) whoMap.set(name, (whoMap.get(name) || 0) + 1)
    bands[bandOf(effectiveWeight(e, activeDaysNow()))] += 1
    days[dayBucketOf(e.at, now)] += 1
  }
  const who = [...whoMap.entries()]
    .map(([name, count]) => ({ who: name, count }))
    .sort((a, b) => b.count - a.count || a.who.localeCompare(b.who, 'zh'))
    .slice(0, 12)
  return { kinds, who, bands, days, whoTotal: whoMap.size }
}

/* ------------------------------------------------------------------ HTTP */

function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8')
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
  })
  res.end(body)
}

function sendText(res, status, buf, type) {
  res.writeHead(status, {
    'content-type': type || 'text/plain; charset=utf-8',
    'content-length': buf.length,
    'cache-control': 'no-store',
  })
  res.end(buf)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(fail(413, '请求体太大（上限 16MB）'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return resolve({})
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(fail(400, '请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function saveArchiveFile() {
  try {
    fs.writeFileSync(
      store.archiveFile,
      JSON.stringify({ meta: { name: store.name }, entries: store.archive }),
      'utf8',
    )
  } catch (err) {
    console.warn(`[warn] 归档簿写入失败：${err.message}`)
  }
}

function listPayload(body) {
  const q = String(body.q ?? '').trim()
  const kinds = Array.isArray(body.kinds) ? body.kinds.map(normalizeKind) : []
  const who = Array.isArray(body.who)
    ? body.who.map((s) => String(s ?? '').trim()).filter(Boolean)
    : []
  const bands = Array.isArray(body.bands) ? body.bands.map(String).filter((b) => BAND_KEYS.includes(b)) : []
  const day = String(body.day ?? '')
  const sort = SORTS[body.sort] ? String(body.sort) : 'at-desc'
  const offset = Math.max(0, Math.round(Number(body.offset) || 0))
  const limit = Math.min(PAGE_LIMIT_MAX, Math.max(1, Math.round(Number(body.limit) || 60)))
  const tokens = q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)

  let rows = store.entries.map(decorate)
  if (tokens.length) {
    rows = rows.filter((r) => {
      const hay = `${r.text} ${r.who ?? ''} ${r.qq ?? ''}`.toLowerCase()
      return tokens.every((t) => hay.includes(t))
    })
  }
  if (kinds.length) rows = rows.filter((r) => kinds.includes(r.kind))
  if (who.length) rows = rows.filter((r) => who.includes(String(r.who ?? '').trim()))
  if (bands.length) rows = rows.filter((r) => bands.includes(bandOf(r.eff)))
  if (day) rows = rows.filter((r) => dayBucketOf(r.at, Date.now()) === day)

  rows.sort(SORTS[sort])
  const total = rows.length
  const entries = rows.slice(offset, offset + limit)
  return {
    ok: true,
    total,
    offset,
    limit,
    tokens,
    sort,
    entries,
    facets: facets(),
    status: statusPayload(),
  }
}

function sanitizeImportedEntry(raw) {
  if (!raw || typeof raw !== 'object') return null
  const body = fitText(raw.text)
  if (!body.text) return null
  const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `j${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
  const out = {
    id,
    kind: normalizeKind(raw.kind),
    who: String(raw.who ?? '').trim(),
    qq: String(raw.qq ?? '').trim(),
    text: body.text,
    weight: clampWeight(raw.weight),
    source: ['user', 'assistant', 'system'].includes(raw.source) ? raw.source : 'user',
    level: Math.max(0, Math.min(3, Math.round(Number(raw.level) || 0))),
    hits: Math.max(0, Math.round(Number(raw.hits) || 0)),
    lastActiveDay: Math.max(0, Math.round(Number(raw.lastActiveDay) || 0)),
    at: Number(raw.at) || Date.now(),
  }
  if (String(raw.group ?? '').trim()) out.group = String(raw.group).trim()
  if (String(raw.messageId ?? '').trim()) out.messageId = String(raw.messageId).trim()
  return out
}

function importPayload(body) {
  const bundle = body.bundle && typeof body.bundle === 'object' ? body.bundle : null
  // 三种形状都收：jasmine bundle:{entries[]}、纯数组、Molly 控制台 /api/action/memory/list 的 {ok,data:{entries[]}}
  const source = [
    bundle && Array.isArray(bundle.entries) ? bundle.entries : null,
    bundle && bundle.data && Array.isArray(bundle.data.entries) ? bundle.data.entries : null,
    Array.isArray(body.entries) ? body.entries : null,
    body.data && Array.isArray(body.data.entries) ? body.data.entries : null,
  ].find((v) => Array.isArray(v)) || null
  if (!source) throw fail(400, '导入需要 bundle:{entries[]}、entries[]，或 Molly 的 {data:{entries[]}}')

  const dryRun = body.dryRun !== false
  const have = new Map(store.entries.map((e) => [e.id, e]))
  const seen = new Set()
  const incoming = []
  let skipped = 0
  for (const raw of source) {
    const entry = sanitizeImportedEntry(raw)
    if (!entry) {
      skipped += 1
      continue
    }
    if (seen.has(entry.id)) {
      skipped += 1
      continue
    }
    seen.add(entry.id)
    incoming.push(entry)
  }
  const addedList = incoming.filter((e) => !have.has(e.id))
  const mergedList = incoming.filter((e) => have.has(e.id))
  const archivedIn = bundle && Array.isArray(bundle.archived) ? bundle.archived.filter((e) => e && e.id && !store.archive.some((a) => a.id === e.id)) : []

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      added: addedList.length,
      merged: mergedList.length,
      skipped,
      archiveAdded: archivedIn.length,
      sample: incoming.slice(0, 3).map((e) => ({ id: e.id, kind: e.kind, text: e.text, weight: e.weight })),
      countBefore: store.entries.length,
    }
  }

  for (const entry of addedList) store.entries.push(entry)
  for (const entry of mergedList) {
    const local = have.get(entry.id)
    if (local && (Number(entry.at) || 0) >= (Number(local.at) || 0)) {
      Object.assign(local, entry)
    } else if (local) {
      local.hits = Math.max(Number(local.hits) || 0, Number(entry.hits) || 0)
      local.lastActiveDay = Math.max(Number(local.lastActiveDay) || 0, Number(entry.lastActiveDay) || 0)
    }
  }
  for (const raw of archivedIn) {
    const entry = sanitizeImportedEntry(raw)
    if (entry) store.archive.push({ ...entry, _archivedAt: Number(raw._archivedAt) || Date.now(), _reason: String(raw._reason || 'import') })
  }
  // bundle 里的 meta 也要带回来：否则空库导入后活跃天归零，权重全都变回基础值
  const bmeta = bundle && bundle.meta && typeof bundle.meta === 'object' ? bundle.meta : null
  if (bmeta) {
    const days = Math.max(0, Math.round(Number(bmeta.activeDays) || 0))
    if (days > (Number(store.meta.activeDays) || 0)) store.meta.activeDays = days
    if (!store.meta.activeDayKey && bmeta.activeDayKey) store.meta.activeDayKey = String(bmeta.activeDayKey)
    const lc = Number(bmeta.lastCompactionAt) || 0
    if (lc > (Number(store.meta.lastCompactionAt) || 0)) store.meta.lastCompactionAt = lc
  }
  // 从 Molly 那种「只有条目、没有 meta」的导出导入时，活跃天会缺；
  // 用 max(lastActiveDay) 兜底，否则空闲天数恒为负、所有记忆看起来都没衰减。
  if (!(Number(store.meta.activeDays) > 0)) {
    const maxDay = store.entries.reduce((m, e) => Math.max(m, Math.max(0, Math.round(Number(e.lastActiveDay) || 0))), 0)
    if (maxDay > 0) store.meta.activeDays = maxDay
  }
  // 只有条目、没有 meta 的导出会把 activeDayKey 留空：补成今天，
  // 否则第一次写入时 touchActiveDay 认为「同一天」，活跃天永远不往上走。
  if (!store.meta.activeDayKey) store.meta.activeDayKey = store.dayKeyOf()
  store.save()
  saveArchiveFile()
  store.appendRaw({
    t: Date.now(),
    op: 'import',
    mode: 'merge',
    count: addedList.length + mergedList.length,
    added: addedList.length,
    merged: mergedList.length,
    skipped,
  })
  return {
    ok: true,
    dryRun: false,
    added: addedList.length,
    merged: mergedList.length,
    skipped,
    archiveAdded: archivedIn.length,
    count: store.entries.length,
    status: statusPayload(),
  }
}

function curvesPayload() {
  const activeDays = activeDaysNow()
  const baseBands = new Array(10).fill(0)
  const effBands = new Array(10).fill(0)
  for (const e of store.entries) {
    baseBands[clampWeight(e.weight) - 1] += 1
    const bucket = Math.max(1, Math.min(10, Math.round(effectiveWeight(e, activeDays))))
    effBands[bucket - 1] += 1
  }
  const kinds = KINDS.map((kind) => {
    const list = store.entries.filter((e) => e.kind === kind)
    let idleMax = null
    let idleSum = 0
    for (const e of list) {
      const idle = Math.max(0, activeDays - Math.round(Number(e.lastActiveDay) || 0))
      idleSum += idle
      if (idleMax === null || idle > idleMax) idleMax = idle
    }
    const grace = GRACE_ACTIVE_DAYS[kind]
    return {
      kind,
      count: list.length,
      grace: Number.isFinite(grace) ? grace : null,
      graceInf: !Number.isFinite(grace),
      floor: WEIGHT_FLOOR[kind] ?? 1,
      step: DECAY_STEP,
      stepDays: DECAY_STEP_DAYS,
      idleMax,
      idleAvg: list.length ? Math.round((idleSum / list.length) * 10) / 10 : null,
      archivable: list.filter((e) => isArchivable(e, { activeDays })).length,
    }
  })
  const archive = store.archive
    .slice()
    .sort((a, b) => (Number(b._archivedAt) || 0) - (Number(a._archivedAt) || 0))
    .map((e) => ({
      id: e.id,
      kind: normalizeKind(e.kind),
      text: String(e.text ?? ''),
      who: e.who || '',
      qq: e.qq || '',
      weight: clampWeight(e.weight),
      at: Number(e.at) || 0,
      archivedAt: Number(e._archivedAt) || 0,
      reason: String(e._reason || ''),
    }))
  return { ok: true, activeDays, baseBands, effBands, kinds, archive }
}

/* ------------------------------------------------------------------ 接口表 */

const API = {
  '/api/status': { method: 'GET', run: () => statusPayload() },

  '/api/list': { method: 'POST', run: (ctx) => listPayload(ctx.body) },

  '/api/item': {
    method: 'GET',
    run: (ctx) => {
      const id = String(ctx.url.searchParams.get('id') ?? '')
      if (!id) throw fail(400, '缺 id')
      const entry = store.byId(id)
      if (!entry) throw fail(404, '没有这条记忆（可能已被删除或归档）')
      const item = decorate(entry)
      const edges = []
      if (item.supersededBy) {
        const target = store.byId(item.supersededBy)
        if (target) edges.push({ rel: 'supersededBy', id: target.id, kind: target.kind, text: target.text })
      }
      for (const e of store.entries) {
        if (e.supersededBy === item.id) edges.push({ rel: 'supersedes', id: e.id, kind: e.kind, text: e.text })
        if (edges.length >= 6) break
      }
      return { ok: true, entry: item, edges }
    },
  },

  '/api/add': {
    method: 'POST',
    run: (ctx) => {
      const body = ctx.body
      const fitted = fitText(body.text)
      if (!fitted.text) throw fail(400, '正文不能为空')
      const entry = store.add({
        kind: normalizeKind(body.kind),
        who: String(body.who ?? '').trim(),
        qq: String(body.qq ?? '').trim(),
        text: fitted.text,
        weight: clampWeight(body.weight),
        source: 'user',
      })
      if (!entry) throw fail(400, '这条记忆没写进去（正文为空或被合并）')
      const payload = { ok: true, entry: decorate(entry), status: statusPayload() }
      if (fitted.truncated) payload.truncated = true
      if (entry.skipped) payload.merged = true
      return payload
    },
  },

  '/api/update': {
    method: 'POST',
    run: (ctx) => {
      const id = String(ctx.body.id ?? '')
      if (!id) throw fail(400, '缺 id')
      if (!store.byId(id)) throw fail(404, '没有这条记忆')
      const patchIn = ctx.body.patch && typeof ctx.body.patch === 'object' ? ctx.body.patch : {}
      const patch = {}
      let truncated = false
      if ('text' in patchIn) {
        const fitted = fitText(patchIn.text)
        if (!fitted.text) throw fail(400, '正文不能为空')
        patch.text = fitted.text
        truncated = fitted.truncated
      }
      if ('kind' in patchIn) patch.kind = normalizeKind(patchIn.kind)
      if ('who' in patchIn) patch.who = String(patchIn.who ?? '').trim()
      if ('qq' in patchIn) patch.qq = String(patchIn.qq ?? '').trim()
      if ('weight' in patchIn) patch.weight = clampWeight(patchIn.weight)
      if ('level' in patchIn) patch.level = Math.max(0, Math.min(3, Math.round(Number(patchIn.level) || 0)))
      const entry = store.update(id, patch)
      if (!entry) throw fail(404, '没有这条记忆')
      const payload = { ok: true, entry: decorate(entry), status: statusPayload() }
      if (truncated) payload.truncated = true
      return payload
    },
  },

  '/api/remove': {
    method: 'POST',
    run: (ctx) => {
      const id = String(ctx.body.id ?? '')
      const entry = store.byId(id)
      if (!entry) throw fail(404, '没有这条记忆')
      const gone = { ...entry, _archivedAt: Date.now(), _reason: 'removed' }
      if (!store.remove(id, { reason: String(ctx.body.reason ?? '') })) throw fail(500, '删除失败')
      store.archive.push(gone)
      saveArchiveFile()
      return { ok: true, removed: true, id, count: store.entries.length, status: statusPayload() }
    },
  },

  '/api/restore': {
    method: 'POST',
    run: (ctx) => {
      const id = String(ctx.body.id ?? '')
      const i = store.archive.findIndex((e) => e.id === id)
      if (i < 0) throw fail(404, '归档簿里没有这条')
      if (store.byId(id)) throw fail(409, '记忆库里已经有这条了')
      const [raw] = store.archive.splice(i, 1)
      const entry = { ...raw }
      delete entry._archivedAt
      delete entry._reason
      store.entries.push(entry)
      store.save()
      saveArchiveFile()
      store.appendRaw({ t: Date.now(), op: 'restore', id })
      return { ok: true, entry: decorate(entry), count: store.entries.length, status: statusPayload() }
    },
  },

  '/api/archive-stale': {
    method: 'POST',
    run: (ctx) => {
      const activeDays = activeDaysNow()
      const wouldMove = store.entries.filter((e) => isArchivable(e, { activeDays })).length
      if (ctx.body.dryRun !== false) {
        return { ok: true, dryRun: true, wouldMove, threshold: ARCHIVE_IDLE_DAYS, activeDays }
      }
      const moved = store.archiveStale()
      saveArchiveFile()
      return { ok: true, dryRun: false, moved, status: statusPayload() }
    },
  },

  '/api/rebuild': {
    method: 'POST',
    run: () => {
      const res = store.rebuildFromRaw()
      return { ok: true, count: res.entries, archive: res.archive, scanned: res.scanned, status: statusPayload() }
    },
  },

  '/api/raw': {
    method: 'GET',
    run: (ctx) => {
      const limit = Math.min(1000, Math.max(1, Math.round(Number(ctx.url.searchParams.get('limit')) || 200)))
      return { ok: true, limit, lines: store.tailRaw(limit) }
    },
  },

  '/api/export': {
    method: 'GET',
    run: (ctx) => {
      const bundle = store.exportBundle()
      const body = Buffer.from(JSON.stringify(bundle, null, 2), 'utf8')
      const d = new Date()
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
      ctx.res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="jasmine-bundle-${stamp}.json"`,
        'content-length': body.length,
        'cache-control': 'no-store',
      })
      ctx.res.end(body)
      return SENT
    },
  },

  '/api/import': { method: 'POST', run: (ctx) => importPayload(ctx.body) },

  '/api/curves': { method: 'GET', run: () => curvesPayload() },
}

async function handleApi(req, res, pathname, url) {
  const route = API[pathname]
  if (!route) return sendJson(res, 404, { ok: false, error: `没有这个接口：${pathname}` })
  if (route.method !== req.method) {
    res.setHeader('allow', route.method)
    return sendJson(res, 405, { ok: false, error: `${pathname} 只接受 ${route.method}` })
  }
  let body = {}
  if (req.method === 'POST') body = await readBody(req)
  // 每次请求都从盘上重新读一遍：别的进程/脚本改了库，这里也能立刻看到
  try {
    const hadState = store.entries.length > 0 || store.archive.length > 0
    store.load()
    // 卡被整个删掉了（比如「清空目录再导入」）：内存里的旧状态一起丢掉，
    // 否则删了文件还假装有 300 条，导入就只会「合并」不会「新增」。
    if (hadState && !fs.existsSync(store.cardFile)) {
      store.entries = []
      store.archive = []
      store.meta.activeDays = 0
      store.meta.activeDayKey = ''
      store.meta.lastCompactionAt = 0
    }
    // 库文件里没有活跃天（Molly 直接导出来的那种）：用 max(lastActiveDay) 兜底
    if (store.entries.length && !(Number(store.meta.activeDays) > 0)) {
      const maxDay = store.entries.reduce((m, e) => Math.max(m, Math.max(0, Math.round(Number(e.lastActiveDay) || 0))), 0)
      if (maxDay > 0) store.meta.activeDays = maxDay
    }
  } catch (err) {
    console.warn(`[warn] 重新读盘失败：${err.message}`)
  }
  const out = await route.run({ body, url, req, res })
  if (out === SENT) return
  sendJson(res, 200, out)
}

function serveStatic(res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname
  if (!path.extname(rel)) rel = '/index.html'
  const target = path.normalize(path.join(WEB_DIR, rel))
  if (target !== WEB_DIR && !target.startsWith(WEB_DIR + path.sep)) {
    return sendJson(res, 403, { ok: false, error: 'forbidden' })
  }
  fs.readFile(target, (err, buf) => {
    if (err) {
      fs.readFile(path.join(WEB_DIR, 'index.html'), (err2, indexBuf) => {
        if (err2) return sendJson(res, 404, { ok: false, error: 'not found' })
        sendText(res, 200, indexBuf, MIME['.html'])
      })
      return
    }
    sendText(res, 200, buf, MIME[path.extname(target).toLowerCase()] || 'application/octet-stream')
  })
}

const server = http.createServer((req, res) => {
  let url
  try {
    url = new URL(req.url || '/', `http://127.0.0.1:${port}`)
  } catch {
    return sendJson(res, 400, { ok: false, error: 'bad url' })
  }
  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    pathname = url.pathname
  }
  if (pathname.startsWith('/api/')) {
    handleApi(req, res, pathname, url).catch((err) => {
      const status = err && err.status ? err.status : 500
      if (!res.headersSent) sendJson(res, status, { ok: false, error: String((err && err.message) || err) })
    })
    return
  }
  serveStatic(res, pathname)
})

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[fatal] 端口 ${port} 被占用了，换一个：--port 19431`)
  } else {
    console.error(`[fatal] 服务起不来：${err.message}`)
  }
  process.exit(1)
})

server.listen(port, '127.0.0.1', () => {
  const st = store.status()
  console.log(
    `茉莉花控制台 http://127.0.0.1:${port} · 数据目录 ${st.dir} · ${st.count.toLocaleString('en-US')} 条`,
  )
  if (args.open) {
    try {
      const child = spawn('cmd', ['/c', 'start', '', `http://127.0.0.1:${port}`], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
    } catch (err) {
      console.warn(`[warn] 打不开浏览器：${err.message}`)
    }
  }
})

function shutdown(signal) {
  console.log(`\n收到 ${signal}，关掉 127.0.0.1:${port}`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 800).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
