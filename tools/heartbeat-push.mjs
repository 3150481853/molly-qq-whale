#!/usr/bin/env node
/**
 * 家里 → 服务器 心跳推送器
 *
 * 为什么要有它：Molly 跑在家里这台电脑上。电脑合盖/断网/断电时，
 * 家里这边什么都发不出来（连"我掉线了"这句话都发不出去）。所以由
 * 服务器做看守：家里定时推一次"我还活着"，服务器超时没收到就
 * 用 PushPlus 推手机。**它的价值恰恰在家里死掉的时候体现。**
 *
 * 频率（以服务器 DSH 留言 #15 为准）：白天 8–24 点每分钟一条（服务器阈值 180 秒），
 * 夜间 0–8 点每小时一条（服务器阈值 4500 秒，留 15 分钟余量）。计划任务保持 PT1M，
 * 实际节奏由脚本内节流实现（读 out/heartbeat-state.json 的 lastAt）。实时的掉线
 * 发现由本机 watchdog（1 分钟一查）+ 服务器侧阈值保证，心跳只证明「整机还活着」。
 * 注意：白天若压到 3 分钟一条，就贴着 180 秒阈值跑，边界抖动会触发假告警——不要那样调。
 *
 * 只做出站 HTTP：不需要公网 IP、不开任何端口、不动路由器。
 *
 * 宿主端口（DSH 桌面那一侧）**不写死**：auto 发现，见 resolvePluginBase()。
 * 每次运行往 out/heartbeat.log 追加一行，控制台运维页的「心跳」日志读的就是它。
 *
 * 用法（计划任务每分钟调一次；实际发送节奏由脚本内节流控制）：
 *   node tools/heartbeat-push.mjs
 *   node tools/heartbeat-push.mjs --once --verbose
 *   node tools/heartbeat-push.mjs --dry-run     只打印要发的内容，不真发
 *
 * 退出码：0 已推送 / 3 服务器不可达（本地已记录，下次继续）/ 1 参数或内部错误
 * 依赖：无（只用 node 内置模块）
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

/* ── 配置：环境变量 > 项目 config 文件 > 默认值 ───────────────── */
const CFG_FILE = process.env.MOLLY_HEARTBEAT_CONFIG || path.join(ROOT, 'out', 'heartbeat-config.json')

function readCfg() {
  try {
    return JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')) || {}
  } catch {
    return {}
  }
}

const cfg = readCfg()

const RELAY = String(
  process.env.MOLLY_RELAY_BASE || cfg.relayBase || 'http://<REDACTED>/molly'
).replace(/\/+$/, '')

const TOKEN = String(process.env.MOLLY_RELAY_TOKEN || cfg.token || '')

const HOST_LABEL = String(process.env.MOLLY_HOST_LABEL || cfg.hostLabel || os.hostname())

// 宿主端口**不能写死**：DSH 每次重启都会换端口（7053 → 2160 → …）。
// 这里只是"提示"，探不通就自动发现（见 resolvePluginBase）。写死过一次的代价：
// 心跳里 molly.link 永远是 unknown，服务器据此判 molly-offline（=QQ 掉登录），
// 半夜给主人推"去扫码"的假告警。
const PLUGIN_HINT = String(process.env.MOLLY_PLUGIN_BASE || cfg.pluginBase || '')
  .replace(/\/dsh-qq-whale\/?$/, '')
  .replace(/\/+$/, '')

// 控制台：它已经做了宿主端口探测（扫 LISTEN + 30 秒缓存），问它最省事。
const CONSOLE = String(process.env.MOLLY_CONSOLE || cfg.consoleBase || 'http://127.0.0.1:19392')
  .replace(/\/+$/, '')

const TIMEOUT_MS = Number(process.env.MOLLY_HEARTBEAT_TIMEOUT_MS || cfg.timeoutMs || 8000)
const PROBE_TIMEOUT_MS = 800

const STATE_FILE = path.join(ROOT, 'out', 'heartbeat-state.json')
// 控制台运维页「心跳」日志读的就是这个文件（console-server readLogTail）
const LOG_FILE = path.join(ROOT, 'out', 'heartbeat.log')

/* ── 小工具 ───────────────────────────────────────────────────── */
const args = new Set(process.argv.slice(2))
const VERBOSE = args.has('--verbose')
const DRY = args.has('--dry-run')

/* ── 节流：白天每分钟一条、夜间每小时一条（服务器 DSH 留言 #15 / /molly/status 为准）──
 * 计划任务仍是 PT1M（改触发器要提权，且任务本身很便宜），这里按
 * out/heartbeat-state.json 的 lastAt 做最小间隔节流：
 *   - 白天 8–24 点：lastAt 距今 < 45 秒就跳过（任务 PT1M + 抖动，正常约每分钟一条，
 *     服务器阈值 180 秒，留足余量；不要调大到 170 秒，否则贴着阈值会触发假告警）；
 *   - 夜间 0–8 点：距上次成功超过 55 分钟才发 → 约每小时一条（服务器阈值 4500 秒）。
 * 上一次发送失败（state.ok === false）时不节流，立刻重试。
 */
const HIGH_FREQ_START_HOUR = Number(
  process.env.MOLLY_HIGH_FREQ_START_HOUR || cfg.highFreqStartHour || 8
)
const NIGHT_MIN_GAP_MINUTES = Math.max(
  1,
  Number(process.env.MOLLY_NIGHT_MIN_GAP_MINUTES || cfg.nightMinGapMinutes || 55)
)
const DAY_MIN_GAP_SECONDS = Math.max(
  1,
  Number(process.env.MOLLY_DAY_MIN_GAP_SECONDS || cfg.dayMinGapSeconds || 45)
)
{
  const d = new Date()
  let st = {}
  try {
    st = readState() || {}
  } catch {
    st = {}
  }
  const lastAt = Number(st.lastAt || 0)
  const gapSec = lastAt ? (Date.now() - lastAt) / 1000 : Infinity
  const lastOk = st.ok !== false
  if (d.getHours() < HIGH_FREQ_START_HOUR) {
    if (lastAt && lastOk && gapSec < NIGHT_MIN_GAP_MINUTES * 60) {
      if (VERBOSE) console.log('[heartbeat] 夜间节流：距上次', Math.round(gapSec / 60), '分钟，本次跳过')
      process.exit(0)
    }
  } else if (lastAt && lastOk && gapSec < DAY_MIN_GAP_SECONDS) {
    if (VERBOSE) console.log('[heartbeat] 白天节流：距上次', Math.round(gapSec), '秒，本次跳过')
    process.exit(0)
  }
}

function log(...a) {
  if (VERBOSE) console.log('[heartbeat]', ...a)
}

function nowIso() {
  // 一律用本地时间给日志看；发给服务器的 at 用毫秒时间戳，避免时区歧义
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) || {}
  } catch {
    return {}
  }
}

function writeState(obj) {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true })
    const tmp = `${STATE_FILE}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8')
    fs.renameSync(tmp, STATE_FILE)
  } catch (err) {
    log(`状态写不进去（不影响推送）：${err?.message || err}`)
  }
}

/** 往 out/heartbeat.log 追加一行（控制台运维页的「心跳」日志源）。只追加、只留尾部一个备份。 */
function appendLog(line) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    try {
      if (fs.statSync(LOG_FILE).size > 256 * 1024) {
        fs.rmSync(`${LOG_FILE}.1`, { force: true })
        fs.renameSync(LOG_FILE, `${LOG_FILE}.1`)
      }
    } catch {
      /* 文件还不存在，正常 */
    }
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8')
  } catch (err) {
    log(`日志写不进去（不影响推送）：${err?.message || err}`)
  }
}

/* ── 宿主端口自动发现 ──────────────────────────────────────────────
 * 顺序：env/config 提示 → 上次探到的（状态文件自愈）→ 控制台 /api/overview
 *      → 7053 老位置 → 并发扫 LISTEN 端口（1024-65535）。
 * 与 console-server.mjs 的 probeHost 同一套判定：必须真的返回 /state JSON，
 * 不能只看 HTTP 200 —— 宿主端口上还跑着别的服务。
 */
let pluginCache = { base: '', source: '' }

function portOf(base) {
  const m = /^https?:\/\/[^/]+:(\d+)/.exec(String(base || ''))
  return m ? Number(m[1]) : 0
}

async function probeHost(port) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS)
  try {
    const r = await fetch(`http://127.0.0.1:${port}/dsh-qq-whale/state`, { signal: ctl.signal })
    if (!r.ok) return null
    const d = await r.json()
    if (!d || typeof d !== 'object') return null
    if (!d.link && d.enabled === undefined) return null // 不是 DSH 宿主
    return `http://127.0.0.1:${port}`
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

function listListenPorts() {
  return new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      resolve(v)
    }
    let ps
    try {
      ps = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
          'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ' +
          'Select-Object -ExpandProperty LocalPort'],
        { windowsHide: true }
      )
    } catch {
      return finish([])
    }
    const timer = setTimeout(() => {
      try { ps.kill() } catch { /* ignore */ }
      finish([])
    }, 4000)
    ps.stdout.on('data', (b) => { out += b.toString('utf8') })
    ps.on('error', () => { clearTimeout(timer); finish([]) })
    ps.on('exit', () => {
      clearTimeout(timer)
      const ports = out
        .split(/\r?\n/)
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n >= 1024 && n <= 65535)
      finish([...new Set(ports)].sort((a, b) => a - b))
    })
  })
}

async function fromConsole() {
  try {
    const r = await fetch(`${CONSOLE}/api/overview`, { signal: AbortSignal.timeout(2500) })
    if (!r.ok) return ''
    const d = await r.json()
    const base = d?.plugin?.base
    return typeof base === 'string' ? base.replace(/\/+$/, '') : ''
  } catch {
    return ''
  }
}

async function resolvePluginBase() {
  const tried = new Set()
  for (const [source, hint] of [['hint', PLUGIN_HINT], ['cached', readState().pluginBase]]) {
    const port = portOf(hint)
    if (!port || tried.has(port)) continue
    tried.add(port)
    const hit = await probeHost(port)
    if (hit) return (pluginCache = { base: hit, source })
  }
  const ctlBase = await fromConsole()
  const ctlPort = portOf(ctlBase)
  if (ctlPort && !tried.has(ctlPort)) {
    tried.add(ctlPort)
    const hit = await probeHost(ctlPort)
    if (hit) return (pluginCache = { base: hit, source: 'console' })
  }
  if (!tried.has(7053)) {
    tried.add(7053)
    const hit = await probeHost(7053) // 契约里的老位置
    if (hit) return (pluginCache = { base: hit, source: '7053' })
  }
  const ports = (await listListenPorts()).filter((p) => !tried.has(p))
  if (ports.length) {
    const hits = await Promise.all(ports.map((p) => probeHost(p)))
    const i = hits.findIndex(Boolean)
    if (i >= 0) return (pluginCache = { base: hits[i], source: 'scan' })
  }
  return (pluginCache = { base: '', source: 'none' })
}

const WD_STATE_FILE =
  process.env.MOLLY_WD_STATE || path.join(ROOT, 'out', 'watchdog-state.json')

/** 守护状态（磁盘 JSON，读不到就返回空对象，绝不抛） */
function readWatchdog() {
  try {
    const s = JSON.parse(fs.readFileSync(WD_STATE_FILE, 'utf8')) || {}
    return {
      state: String(s.lastState || ''),
      lastCheckAt: Number(s.lastCheckAt || 0),
      lastOnlineAt: Number(s.lastOnlineAt || 0),
      consecutiveFails: Number(s.consecutiveFails || 0),
      recoverAttempts: Number(s.recoverAttempts || 0),
      offlineSince: Number(s.offlineSince || 0),
    }
  } catch {
    return { state: '', lastCheckAt: 0 }
  }
}

/** 读插件状态；失败不抛，返回 {ok:false}，心跳照发（服务器至少知道机器活着）。 */
async function readPlugin(base) {
  if (!base) return { ok: false, reason: '没探到 DSH 宿主端口（1024-65535）' }
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), Math.min(TIMEOUT_MS, 5000))
  try {
    const r = await fetch(`${base}/dsh-qq-whale/state`, { signal: ctl.signal })
    if (!r.ok) return { ok: false, reason: `plugin HTTP ${r.status}` }
    const s = await r.json()
    return {
      ok: true,
      link: s?.link?.state || '',
      ready: s?.link?.ready === true,
      bot: s?.bot?.userId ? String(s.bot.userId) : '',
      nick: s?.bot?.nickname || '',
      memory: Number(s?.memory?.count || 0),
      stickers: Number(s?.stickers?.count || 0),
      budget: {
        used: Number(s?.budget?.used ?? s?.budget?.credit ?? 0),
        cap: Number(s?.budget?.cap ?? s?.budget?.dailyCap ?? 0),
      },
      // /state 里没有 watchdog 块（插件只暴露上面那些键），守护状态在磁盘上，
      // 直接读文件比让插件加字段省一次改动。
      watchdog: readWatchdog(),
      plugins: {
        expected: Number(s?.plugins?.expected?.length || 0),
        loaded: Number(s?.plugins?.loaded?.length || 0),
        missing: Array.isArray(s?.plugins?.missing) ? s.plugins.missing : [],
      },
      pest: { enabled: s?.pest?.enabled === true },
      work: { running: s?.work?.running === true },
    }
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) }
  } finally {
    clearTimeout(t)
  }
}

async function postJson(url, body, headers = {}) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
      body: Buffer.from(JSON.stringify(body), 'utf8'),
      signal: ctl.signal,
    })
    const text = await r.text()
    return { ok: r.ok, status: r.status, text }
  } catch (err) {
    return { ok: false, status: 0, text: String(err?.message || err) }
  } finally {
    clearTimeout(t)
  }
}

/* ── 主流程 ───────────────────────────────────────────────────── */
async function main() {
  if (!TOKEN) {
    console.error('[heartbeat] 缺少令牌：设置环境变量 MOLLY_RELAY_TOKEN，或写进 ' + CFG_FILE)
    process.exit(1)
  }

  const startedAt = Date.now()
  const pluginBase = await resolvePluginBase()
  log(`宿主 ${pluginBase.base || '(没探到)'} 来源=${pluginBase.source}`)
  const plugin = await readPlugin(pluginBase.base)
  const at = Date.now()
  const link = plugin.ok ? plugin.link || 'unknown' : 'unknown'

  const payload = {
    at,
    host: HOST_LABEL,
    // 机器层面的"活着"和 Molly 的"在线"是两件事，分开报：
    // 机器活着但 QQ 掉线，服务器应该提醒"Molly 掉登录了"，而不是"失联"。
    alive: true,
    molly: plugin.ok
      ? {
          link: plugin.link,
          ready: plugin.ready,
          bot: plugin.bot,
          nick: plugin.nick,
          memory: plugin.memory,
          stickers: plugin.stickers,
          budget: plugin.budget,
          watchdog: plugin.watchdog,
          plugins: plugin.plugins,
          pest: plugin.pest,
          work: plugin.work,
        }
      : { link: 'unknown', reason: plugin.reason || 'plugin unreachable' },
    version: '1.0.0',
  }

  if (DRY) {
    console.log(JSON.stringify(payload, null, 2))
    return 0
  }

  const res = await postJson(`${RELAY}/heartbeat`, payload, { 'x-molly-token': TOKEN })

  const prev = readState()
  const next = {
    lastAt: at,
    lastLocal: nowIso(),
    lastStatus: res.status,
    ok: res.ok,
    fails: res.ok ? 0 : Number(prev.fails || 0) + 1,
    relay: RELAY,
    host: HOST_LABEL,
    // 探到的宿主端口记下来：下次优先试它，不用再问控制台/扫端口（自愈缓存）。
    pluginBase: pluginBase.base,
    pluginBaseVia: pluginBase.source,
    link,
  }
  writeState(next)

  // 运维页「日志中心 → 心跳」读 out/heartbeat.log。推送器原来只在 --verbose 打控制台，
  // 文件永远不存在，页面只能显示"该日志不存在"；这里每次运行留一行，够看也够查。
  appendLog(
    `${next.lastLocal} | ${res.ok ? 'ok' : 'fail'} | ${res.status} | ` +
      `link=${link} | base=${pluginBase.base || '-'}(${pluginBase.source}) | ${Date.now() - startedAt}ms`
  )

  if (res.ok) {
    log(`已推送 ${nowIso()} → ${res.status}`)
    return 0
  }

  // 推不上去不算致命：服务器那边超时自然会标 stale 并发告警。
  // 但连续失败要留痕，方便以后判断是"服务器挂了"还是"家里网络挂了"。
  log(`推送失败 ${res.status} ${res.text.slice(0, 200)}（连续 ${next.fails} 次）`)
  if (next.fails === 5 || next.fails % 20 === 0) {
    console.error(`[heartbeat] 连续 ${next.fails} 次推送失败：${res.text.slice(0, 200)}`)
  }
  return 3
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('[heartbeat] 未捕获异常：', err?.stack || err)
    process.exit(1)
  })
