#!/usr/bin/env node
/**
 * watchdog.mjs —— Molly 掉线守护（用户 m21975 的需求）
 *
 * 用户原话：「重新登录，做一个定时任务，定期检查是否掉登录，但是每天的晚上 0-9 点不检查」
 *
 * 设计要点（为什么这么做）：
 *  ① 用「状态机 + 落盘」而不是「每次检查都发消息」。
 *     QQ 掉线一次可能持续几小时，如果每 10 分钟推一条，你会把通知关掉，
 *     真出事时反而看不到。所以只在 **正常→掉线** 那一刻推一条，
 *     之后每小时最多提醒一次（可配），恢复时再推一条「回来了」。
 *
 *  ② 安静时段（默认 00:00–09:00）**只跳过通知，不跳过检查**。
 *     理由：掉线本身要立刻知道并尝试抢修，但凌晨把你吵醒没有意义；
 *     早上 9 点后的第一个检查窗口会把「昨夜掉过线」补报给你。
 *
 *  ③ 退出码约定（给 Windows 计划任务用）：
 *     0 = 已登录且没问题；1 = 掉线（已通知）；2 = 掉线但在安静时段（未通知）；
 *     3 = WebUI 不可达（NapCat 挂了）；4 = 配置错误。
 *
 * 用法：
 *   node watchdog.mjs --once          检查一次（计划任务用这个）
 *   node watchdog.mjs --loop          常驻循环
 *   node watchdog.mjs --test-notify   发一条测试通知，验证 webhook 通不通
 *   node watchdog.mjs --status        只看状态，不通知不改状态
 *   node watchdog.mjs --config        打印当前配置
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

// ── 路径 ────────────────────────────────────────────────────────────────────
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const ROOT = path.resolve(HERE, '..')
const OUT = path.join(ROOT, 'out')
const CONFIG_FILE = path.join(ROOT, 'watchdog-config.json')
const STATE_FILE = path.join(OUT, 'watchdog-state.json')
const LOG_FILE = path.join(OUT, 'watchdog.log')

const NODE = process.execPath
const LOGIN_DOCTOR = path.join(HERE, 'login-doctor.mjs')

// ── 默认配置 ────────────────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  enabled: true,
  // 检查间隔（分钟）。计划任务也按这个频率触发，两边要一致。
  intervalMinutes: 10,
  // 安静时段：这些小时整点内不推送通知（0 到 9 表示 00:00–09:59）
  quietHours: [0, 9],
  // 掉线后重复提醒的最短间隔（分钟）；0 = 只在状态变化时提醒一次
  repeatMinutes: 60,
  // 掉线时自动尝试抢修（拉起进程 / 刷新二维码）
  autoRecover: true,
  // 自动抢修最多连续尝试几次，超过就只提醒不再折腾
  maxAutoRecoverAttempts: 3,
  // 通知配置：可以同时开多个渠道，任何一个成功就算通知成功（不互斥）
  //
  //   toast     —— Windows 原生通知中心（零配置、离线可用、不需要账号）
  //   pushplus  —— POST https://www.pushplus.plus/send   {token}
  //   serverchan—— POST https://sctapi.ftqq.com/<token>.send
  //   wecom     —— POST https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<token>
  //   dingtalk  —— POST https://oapi.dingtalk.com/robot/send?access_token=<token>
  //   generic   —— POST <url>  直接发 {title, text}
  notify: {
    enabled: false,
    type: 'generic',
    token: '',
    url: '',
    // 额外渠道：toast 是否始终发送（即使 type 是 pushplus）
    toastAlways: true,
    toastScript: '',
  },
  // 恢复时也发一条（默认开）
  notifyOnRecover: true,
}

// ── 小工具 ──────────────────────────────────────────────────────────────────
function nowMs() { return Date.now() }

// 本地时间（不能用 toISOString —— 那是 UTC，会让安静时段整体偏 8 小时）
function localParts(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return {
    date: `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`,
    time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
    hour: d.getHours(),
  }
}

function stamp() {
  const p = localParts()
  return `${p.date} ${p.time}`
}

function log(...a) {
  const line = `${stamp()} ${a.join(' ')}`
  console.log(line)
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    // 日志超过 2MB 就轮转一次，避免无限增长
    try {
      const st = fs.statSync(LOG_FILE)
      if (st.size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.1')
    } catch { /* 不存在就跳过 */ }
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8')
  } catch { /* 日志写不了不能影响主流程 */ }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
  } catch (e) { log('WRITE_FAIL', file, e.message) }
}

// 配置：文件不存在就写一份默认的，方便用户直接编辑
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    writeJson(CONFIG_FILE, DEFAULT_CONFIG)
    log('已生成默认配置', CONFIG_FILE)
    return { ...DEFAULT_CONFIG }
  }
  const user = readJson(CONFIG_FILE, {})
  // 浅合并：notify 单独处理，避免用户只写了 token 就把 type 冲掉
  const cfg = { ...DEFAULT_CONFIG, ...user }
  cfg.notify = { ...DEFAULT_CONFIG.notify, ...(user.notify || {}) }
  return cfg
}

function inQuietHours(cfg) {
  const [from, to] = cfg.quietHours || [0, 9]
  const h = new Date().getHours()
  // 支持跨零点，例如 [22, 8]
  return from <= to ? (h >= from && h < to) : (h >= from || h < to)
}

// ── 通知发送 ────────────────────────────────────────────────────────────────
/**
 * 按 type 拼不同的 payload —— 这几家的 JSON 结构完全不兼容，
 * 用一个「标准中间格式」再转换是最省心的做法。
 */
function buildRequest(cfg, title, text) {
  const n = cfg.notify || {}
  const t = String(n.token || '').trim()
  const u = String(n.url || '').trim()

  if (n.type === 'pushplus') {
    return {
      url: 'https://www.pushplus.plus/send',
      body: { token: t, title, content: text.replace(/\n/g, '<br>'), template: 'html' },
    }
  }
  if (n.type === 'serverchan') {
    // token 可能给的是完整 URL，也可能只给 SCTxxxx 部分
    const url = /^https?:\/\//i.test(t) ? t : `https://sctapi.ftqq.com/${t}.send`
    return { url, body: { title, desp: text } }
  }
  if (n.type === 'wecom') {
    const url = /^https?:\/\//i.test(u) ? u : `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${encodeURIComponent(t)}`
    return { url, body: { msgtype: 'text', text: { content: `${title}\n${text}` } } }
  }
  if (n.type === 'dingtalk') {
    const url = /^https?:\/\//i.test(u) ? u : `https://oapi.dingtalk.com/robot/send?access_token=${encodeURIComponent(t)}`
    return { url, body: { msgtype: 'text', text: { content: `${title}\n${text}` } } }
  }
  // generic：直连自己的 webhook，发最朴素的 JSON
  return { url: u, body: { title, text, source: 'molly-watchdog', at: stamp() } }
}

async function sendNotify(cfg, title, text) {
  const n = cfg.notify || {}
  if (!n.enabled) {
    log('通知未启用，跳过:', title)
    return { ok: false, reason: 'disabled' }
  }
  let req
  try { req = buildRequest(cfg, title, text) } catch (e) {
    log('NOTIFY_BUILD_FAIL', e.message)
    return { ok: false, reason: e.message }
  }
  if (!req.url) {
    log('NOTIFY_NO_URL —— notify.type=' + n.type + ' 但没给 url/token')
    return { ok: false, reason: 'no-url' }
  }
  try {
    const r = await fetch(req.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(15000),
    })
    const raw = await r.text()
    const body = raw.slice(0, 400)
    log('NOTIFY', r.status, body)

    /*
     * 不能只看 HTTP 状态码 —— 实测踩过：
     * PushPlus 返回 HTTP 200 + {"code":905,"msg":"账户未进行实名认证"}，
     * 用户那边一条都没收到，这边却记成「已送达」。
     * 这几家都是「HTTP 200 + 业务码」的套路，必须解析 body 里的业务码。
     */
    const verdict = classifyNotifyResult(n.type, r.status, raw)
    if (!verdict.ok) log('NOTIFY_REJECTED', verdict.reason)
    return { ok: verdict.ok, status: r.status, body, reason: verdict.reason }
  } catch (e) {
    log('NOTIFY_FAIL', e.message)
    return { ok: false, reason: e.message }
  }
}

/**
 * 各家的「成功」定义都不一样，统一在这里判定。
 * 返回 { ok, reason }，reason 是给人看的中文原因。
 */
function classifyNotifyResult(type, httpStatus, raw) {
  if (httpStatus < 200 || httpStatus >= 300) return { ok: false, reason: `HTTP ${httpStatus}` }
  let j = null
  try { j = JSON.parse(raw) } catch { /* 有的服务返回纯文本，交给下面的默认分支 */ }

  if (type === 'pushplus') {
    // 成功是 {"code":200,...}；905=未实名，903=token 错，999=限流
    const code = j?.code
    if (code === 200) return { ok: true }
    const map = {
      903: 'token 无效',
      905: '账号未实名认证（去 https://verify.pushplus.plus 认证）',
      999: '推送被限流或参数错误',
    }
    return { ok: false, reason: `${map[code] || j?.msg || '业务码 ' + code}` }
  }

  if (type === 'serverchan') {
    // 成功是 {"code":0,...}
    if (j?.code === 0) return { ok: true }
    return { ok: false, reason: j?.message || j?.info || 'Server酱返回失败' }
  }

  if (type === 'wecom') {
    if (j?.errcode === 0) return { ok: true }
    return { ok: false, reason: j?.errmsg || '企业微信返回失败' }
  }

  if (type === 'dingtalk') {
    if (j?.errcode === 0) return { ok: true }
    return { ok: false, reason: j?.errmsg || '钉钉返回失败' }
  }

  // generic：没有约定，HTTP 2xx 就算成功
  return { ok: true }
}

// ── Windows 原生通知（离线兜底通道）────────────────────────────────────────
/**
 * 为什么要这个：PushPlus 之类的 webhook 全都要联网、要账号、要实名，
 * 而「Molly 掉线」恰恰可能发生在断网、账号出问题的时候 —— 最需要通知的时候
 * 第三方通道最不可靠。Windows 通知中心是本机的，永远能用。
 */
function sendToast(cfg, title, text) {
  const script = (cfg.notify && cfg.notify.toastScript) || path.join(HERE, 'toast.ps1')
  if (!fs.existsSync(script)) return Promise.resolve({ ok: false, reason: 'toast.ps1 不存在' })
  // 正文压成一行：Toast 的第二行显示不了多行
  const oneLine = String(text).replace(/\s*\n\s*/g, ' ｜ ').slice(0, 240)
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Title', title, '-Message', oneLine],
      { timeout: 20000, windowsHide: true },
      (err, stdout, stderr) => {
        const ok = /TOAST_OK/.test(String(stdout || ''))
        if (!ok) log('TOAST_FAIL', String(stderr || err?.message || '').slice(0, 160))
        resolve({ ok, reason: ok ? '' : String(stderr || stdout || '').slice(0, 160) })
      })
  })
}

/**
 * 多渠道通知：任何一个成功就算通知成功。
 * 之所以不互斥，是因为「通知没送到」比「通知送两遍」严重得多。
 */
async function notifyAll(cfg, title, text) {
  const n = cfg.notify || {}
  const results = {}

  // Windows 通知：只要开了 toastAlways 就发，与 webhook 是否配置无关
  if (n.toastAlways !== false) {
    results.toast = await sendToast(cfg, title, text)
  }

  if (n.enabled && (n.token || n.url)) {
    results.remote = await sendNotify(cfg, title, text)
  } else if (!n.enabled) {
    log('远程通知未启用（notify.enabled=false），只发 Windows 通知')
  } else {
    log('远程通知没配 token/url，只发 Windows 通知')
  }

  const ok = Object.values(results).some((r) => r && r.ok)
  return { ok, results }
}
/**
 * 直接调 login-doctor 的子进程，而不是 import。
 * 理由：login-doctor 的 main() 会 process.exit()，import 过来会把 watchdog 一起干掉。
 */
function runLoginDoctor(args) {
  return new Promise((resolve) => {
    execFile(NODE, [LOGIN_DOCTOR, ...args], { timeout: 60000, windowsHide: true },
      (err, stdout, stderr) => {
        const out = String(stdout || '').trim()
        let parsed = null
        try { parsed = JSON.parse(out) } catch { /* wait/quicklogin 会输出非 JSON */ }
        resolve({ code: err?.code ?? 0, out, err: String(stderr || '').trim(), parsed })
      })
  })
}

async function checkStatus() {
  const r = await runLoginDoctor(['status'])
  if (r.parsed) return { reachable: true, status: r.parsed }
  // status 子命令一定会输出 JSON；解析失败说明 WebUI 真的不可达了
  return { reachable: false, status: null, raw: r.out || r.err, exit: r.code }
}

// ── 通知文案 ────────────────────────────────────────────────────────────────
function offlineText(info, cfg, extra) {
  const lines = []
  lines.push('Molly 掉线了。')
  lines.push('')
  lines.push(`时间：${stamp()}`)
  lines.push(`阶段：${info.loginPhase || '未知'}`)
  if (info.loginError) lines.push(`错误：${info.loginError}`)
  lines.push('')
  lines.push('怎么救：')
  lines.push('1. 打开 DSH 跟我说「Molly 掉线了」')
  lines.push('2. 我给你一张新二维码，你扫码')
  if (extra) { lines.push(''); lines.push(extra) }
  return lines.join('\n')
}

// ── 离线取证（D 项）─────────────────────────────────────────────────────────
//
// 为什么需要：掉线时最想知道的是「那一刻机器上是什么样」——NapCat 端口还在不在、
// QQ 进程是不是还活着、启动日志里最后几句说了什么。但这些信息**掉线之后就再也
// 取不回来了**（进程重启、日志被新内容覆盖），等第二天再看 wd 状态只剩一个
// lastState='offline'，等于什么都没有。
// 所以在 online→非在线 的跃变瞬间（写 state 之前）抓一份快照落盘。
//
// 约束：取证是旁路功能，任何失败都只 log，绝不能影响巡检结论、通知与退出码。

const OFFLINE_KEEP = 10          // 只保留最近 10 份，避免 out\ 无限膨胀

function fileStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

// 跑一句 PowerShell 拿文本（Node 没有跨平台的端口/进程查询接口）
function psOnce(command, timeout = 10000) {
  return new Promise((resolve) => {
    execFile('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
      { timeout, windowsHide: true, encoding: 'utf8' },
      (err, stdout, stderr) => {
        resolve({
          ok: !err,
          out: String(stdout || ''),
          err: String(stderr || (err && err.message) || '').trim(),
        })
      })
  })
}

// true/false = 明确查到；null = 查不出来（PowerShell 失败），不要谎报 false
async function portListening(port) {
  const r = await psOnce(
    `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count`,
  )
  if (!r.ok) return null
  const n = Number(r.out.trim())
  return Number.isFinite(n) ? n > 0 : null
}

async function qqProcessList() {
  const cmd = "Get-Process QQ -ErrorAction SilentlyContinue | Select-Object Id,ProcessName," +
    "@{n='memMB';e={[int]($_.WorkingSet64/1MB)}}" +
    ",@{n='startTime';e={try{ $_.StartTime.ToString('yyyy-MM-dd HH:mm:ss') }catch{ '' }}} " +
    '| ConvertTo-Json -Compress -Depth 3'
  const r = await psOnce(cmd)
  if (!r.ok) return [{ error: 'Get-Process 失败：' + r.err.slice(0, 300) }]
  const out = r.out.trim()
  if (!out) return []
  try {
    const p = JSON.parse(out)
    return Array.isArray(p) ? p : [p]
  } catch (e) {
    return [{ error: '进程列表 JSON 解析失败：' + e.message, raw: out.slice(0, 200) }]
  }
}

function tailLines(file, n) {
  const text = fs.readFileSync(file, 'utf8')
  const lines = text.split(/\r?\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  return lines.slice(-n)
}

// 只保留最近 keep 份 offline-*.json（文件名里的时间戳字典序 = 时间序）
function pruneOfflineSnapshots(keep = OFFLINE_KEEP) {
  try {
    const files = fs.readdirSync(OUT)
      .filter((f) => /^offline-\d{8}-\d{6}\.json$/.test(f))
      .sort()
    const extra = files.slice(0, Math.max(0, files.length - keep))
    for (const f of extra) {
      try { fs.unlinkSync(path.join(OUT, f)) } catch (e) { log('取证清理失败', f, e?.message || e) }
    }
    if (extra.length) log(`取证清理：删掉 ${extra.length} 份旧快照，保留最近 ${keep} 份`)
  } catch (e) {
    log('取证清理失败（忽略）:', e?.message || e)
  }
}

async function captureOfflineSnapshot({ prev, current, state, cfg }) {
  try {
    const at = new Date()
    const file = path.join(OUT, `offline-${fileStamp(at)}.json`)

    const [p3001, p6099, qq] = await Promise.all([
      portListening(3001),
      portListening(6099),
      qqProcessList(),
    ])

    let napcatLogTail
    try {
      napcatLogTail = tailLines(path.join(OUT, 'napcat-boot.log'), 60)
    } catch (e) {
      napcatLogTail = [`（读不到 napcat-boot.log：${e?.message || e}）`]
    }

    const snap = {
      at: at.toISOString(),
      from: prev,
      to: current,
      ports: { 3001: p3001, 6099: p6099 },
      qqProcs: qq,
      napcatLogTail,
      stateBefore: JSON.parse(JSON.stringify(state)),
      config: cfg,
    }

    fs.mkdirSync(OUT, { recursive: true })
    fs.writeFileSync(file, JSON.stringify(snap, null, 2), 'utf8')
    log('离线取证已写入', path.basename(file))
    pruneOfflineSnapshots()
    return file
  } catch (e) {
    log('离线取证失败（不影响巡检）:', e?.message || e)
    return null
  }
}

// ── 主流程：单次检查 ────────────────────────────────────────────────────────
export async function checkOnce(cfg, opts = {}) {
  const state = readJson(STATE_FILE, {
    lastState: 'unknown',        // online | offline | unreachable | unknown
    lastChangeAt: 0,
    lastNotifyAt: 0,
    lastCheckAt: 0,
    lastOnlineAt: 0,
    consecutiveFails: 0,
    offlineSince: 0,
    recoverAttempts: 0,
    pendingQuietReport: false,   // 安静时段掉线，等白天补报
  })

  const res = await checkStatus()
  state.lastCheckAt = nowMs()

  let current
  if (!res.reachable) current = 'unreachable'
  else if (res.status?.isLogin) current = 'online'
  else current = 'offline'

  const quiet = inQuietHours(cfg)
  const prev = state.lastState
  const changed = current !== prev
  const wasOnline = prev === 'online'

  log(`检查: ${prev} -> ${current}` + (res.status ? ` phase=${res.status.loginPhase}` : '') + (quiet ? ' [安静时段]' : ''))

  // ── D 项：online → 非在线 是掉线事故的第一现场 ──
  // 必须放在写 state 之前：这里 state 还是「掉线前」的原始内容（stateBefore），
  // 一过下面几个分支就被改写了。取证内部自己 try/catch，失败只 log，
  // 不影响巡检结论、通知和退出码。
  if (prev === 'online' && current !== 'online') {
    await captureOfflineSnapshot({ prev, current, state, cfg })
  }

  // ── 在线：一切正常 ──
  if (current === 'online') {
    state.lastOnlineAt = nowMs()
    state.consecutiveFails = 0
    state.recoverAttempts = 0
    state.offlineSince = 0
    if (changed) {
      state.lastChangeAt = nowMs()
      // 如果是「夜间掉线过，白天恢复了」，也该告诉用户一声
      if (state.pendingQuietReport) {
        state.pendingQuietReport = false
        if (!quiet) {
          await notifyAll(cfg, '【Molly】已恢复在线', `掉线后已自动/手动恢复。\n恢复时间：${stamp()}\n掉线开始：${state.offlineSince ? new Date(state.offlineSince).toLocaleString('sv-SE') : '未知'}`)
          state.lastNotifyAt = nowMs()
        }
      } else if (cfg.notifyOnRecover && wasOnline === false && !quiet) {
        await notifyAll(cfg, '【Molly】已恢复在线', `Molly 重新上线了。\n恢复时间：${stamp()}`)
        state.lastNotifyAt = nowMs()
      }
    }
    state.lastState = 'online'
    writeJson(STATE_FILE, state)
    return { code: 0, current, prev, quiet, notified: false }
  }

  // ── 不在线 ──
  //
  // 风控静默期判定必须放在重置之前，且基准是「现在 - 最后一次在线」：
  //   state.offlineSince 在 online 分支里被清成 0，拿它算差值会恒等于 0，
  //   静默期就永远不触发（这里踩过一次）。
  // 语义：上一轮在线只维持了不到 settleMinutes 就又掉了 = 在反复横跳，
  //   这时候重启只会让 QQ 更警觉。
  const settleMin = cfg.settleMinutesAfterRecover ?? 30
  const settleMs = settleMin * 60000
  const onlineSpan = state.lastOnlineAt > 0 ? nowMs() - state.lastOnlineAt : 0
  const inSettleWindow = settleMs > 0 && onlineSpan > 0 && onlineSpan < settleMs

  if (changed) {
    state.lastChangeAt = nowMs()
    state.offlineSince = nowMs()
    state.recoverAttempts = 0
  }
  state.consecutiveFails = (state.consecutiveFails || 0) + 1
  if (!state.offlineSince) state.offlineSince = nowMs()

  // 自动抢修：快重试 N 次，之后降频（不是永久放弃）
  //
  // 为什么不能有硬上限（2026-10-18 断网事故）：
  //   原实现 `recoverAttempts < maxAutoRecoverAttempts` 在掉线期间**从不重置**，
  //   网络断 30 分钟就把 3 次额度耗光，之后整个夜间再怎么掉线都只发通知不抢修。
  //   真实场景里「断网」正是最需要它一直重试的时候。
  //   现在改成：前 N 次每轮都试，用完之后退化成每 slowRecoverMinutes 分钟试一次。
  let recoverNote = ''
  const maxFast = cfg.maxAutoRecoverAttempts || 3
  const usedFast = state.recoverAttempts || 0
  const fastPhase = usedFast < maxFast
  const slowMs = (cfg.slowRecoverMinutes || 30) * 60000
  const sinceRecover = nowMs() - (state.lastRecoverAt || 0)
  const allowedByPhase = fastPhase || sinceRecover >= slowMs

  // 风控静默期（2026-10-18 事故：一晚上连着重启 4 次 + 扫 5 次码，QQ 把登录态踢了）
  //
  // 判定依据：QQ 对「新号 + 短时间反复重启/异地扫码」非常敏感。实测那晚
  // 21:39 到 22:00 之间连续重启/扫码，之后登录态反复被服务器踢掉。
  // 所以「刚恢复在线」之后的 settleMinutes 内，即使又掉线也只发通知、不动进程——
  // 宁可多等一会儿，也不要刺激风控把它踢得更狠。
  //
  // 注意：这里只拦「重启/刷新二维码」这类有副作用的操作，**通知照常发**。
  const allowedNow = allowedByPhase && !inSettleWindow

  if (cfg.autoRecover && !quiet && inSettleWindow) {
    log(`风控静默期：上次只在线了 ${Math.round(onlineSpan / 60000)} 分钟（< ${settleMin}），本轮不抢修，只通知`)
    recoverNote = '（刚恢复又掉，为免刺激 QQ 风控，本轮暂不自动重启，观察一下）'
  }

  if (cfg.autoRecover && !quiet && allowedNow) {
    state.recoverAttempts = usedFast + 1
    state.lastRecoverAt = nowMs()
    log(`自动抢修第 ${state.recoverAttempts} 次` + (fastPhase ? '' : `（已进入降频阶段，每 ${cfg.slowRecoverMinutes || 30} 分钟一次）`))
    if (current === 'unreachable') {
      // NapCat 进程/端口没了 → 拉起来
      recoverNote = await tryStartNapCat()
    } else {
      // 进程在但没登录 → 抓一张新二维码，通知里告诉用户去扫
      const qr = await runLoginDoctor(['qr', path.join(OUT, 'watchdog-qr.png')])
      if (/ALREADY_LOGGED_IN/.test(qr.out)) {
        log('抢修时发现已登录（状态检查有延迟），等下一轮')
        state.lastState = 'online'
        writeJson(STATE_FILE, state)
        return { code: 0, current: 'online', prev, quiet, notified: false }
      }
      if (/NO_QRCODE_URL/.test(qr.out)) {
        recoverNote = '（NapCat 还没生成二维码，可能要重新登录）'
      } else if (qr.code === 0) {
        recoverNote = `二维码已刷新到：${path.join(OUT, 'watchdog-qr.png')}`
      }
    }
    log('抢修结果:', recoverNote || '(无)')
  }

  // 通知：状态变化时立刻发；否则按 repeatMinutes 节流
  const now = nowMs()
  const sinceNotify = now - (state.lastNotifyAt || 0)
  const repeatMs = (cfg.repeatMinutes || 0) * 60000
  const shouldNotifyByChange = changed && !quiet
  const shouldNotifyByRepeat = !quiet && repeatMs > 0 && sinceNotify >= repeatMs
  const shouldNotify = shouldNotifyByChange || shouldNotifyByRepeat

  let notified = false
  if (shouldNotify) {
    const info = res.status || { loginPhase: 'WebUI 不可达', loginError: '' }
    const title = current === 'unreachable' ? '【Molly】NapCat 挂了' : '【Molly】掉线了'
    const r = await notifyAll(cfg, title, offlineText(info, cfg, recoverNote))
    notified = !!r.ok
    state.lastNotifyAt = now
  } else if (quiet && changed) {
    // 安静时段发生了状态变化 → 记一笔，等白天补报
    state.pendingQuietReport = true
    log('安静时段掉线，已记录，白天补报')
  }

  state.lastState = current
  writeJson(STATE_FILE, state)
  return { code: quiet ? 2 : 1, current, prev, quiet, notified, recoverNote }
}

// ── 抢修：把 NapCat 拉起来 ──────────────────────────────────────────────────
async function tryStartNapCat() {
  const script = path.join(HERE, 'start-molly.ps1')
  if (!fs.existsSync(script)) return '（start-molly.ps1 不存在，无法自动拉起）'
  return await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Restart'],
      { timeout: 180000, windowsHide: true },
      (err, stdout, stderr) => {
        const tail = String(stdout || stderr || '').slice(-300)
        log('start-molly 退出码', err?.code ?? 0, tail)
        resolve(err ? `（自动拉起失败：${String(stderr || err.message).slice(0, 120)}）` : '（已自动执行 start-molly -Restart）')
      })
  })
}

// ── 入口 ────────────────────────────────────────────────────────────────────
async function main() {
  const arg = process.argv[2] || '--once'
  const cfg = loadConfig()

  if (arg === '--config') {
    console.log(JSON.stringify(cfg, null, 2))
    process.exit(0)
  }

  if (arg === '--status') {
    const res = await checkStatus()
    const state = readJson(STATE_FILE, {})
    console.log(JSON.stringify({ now: stamp(), quiet: inQuietHours(cfg), check: res, state }, null, 2))
    process.exit(res.reachable && res.status?.isLogin ? 0 : 1)
  }

  if (arg === '--test-notify') {
    const r = await notifyAll(cfg, '【Molly】测试通知', `这是一条测试消息，说明通知通道配好了。\n发送时间：${stamp()}\n远程渠道：${cfg.notify?.enabled ? cfg.notify?.type : '未启用'}`)
    console.log(JSON.stringify(r, null, 2))
    process.exit(r.ok ? 0 : 1)
  }

  if (arg === '--once') {
    if (!cfg.enabled) { log('watchdog 已禁用（配置 enabled:false）'); process.exit(0) }
    const r = await checkOnce(cfg)
    process.exit(r.code)
  }

  if (arg === '--loop') {
    log(`watchdog 常驻，间隔 ${cfg.intervalMinutes} 分钟，安静时段 ${JSON.stringify(cfg.quietHours)}`)
    let stopping = false
    const stop = () => { stopping = true; log('收到退出信号'); process.exit(0) }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
    while (!stopping) {
      try { await checkOnce(cfg) } catch (e) { log('CHECK_CRASH', e?.message || e) }
      await sleep((cfg.intervalMinutes || 10) * 60000)
    }
    return
  }

  console.error('未知参数: ' + arg)
  console.error('可用: --once | --loop | --status | --test-notify | --config')
  process.exit(64)
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

main().catch((e) => {
  console.error('FATAL', e?.stack || e)
  process.exit(3)
})
