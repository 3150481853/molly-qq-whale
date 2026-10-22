/**
 * Molly 登录体检 / 抢修工具（统一入口，替代零散的 watch-login / wait-login）。
 *
 * 为什么收敛成一个：NapCat 的登录有四种状态（已登录、等扫码、身份失效要密码、
 * 进程根本没起来），每种要的动作都不一样；散着写容易拿错剧本。这里按状态分支。
 *
 * 子命令：
 *   status              打印当前状态 JSON（不碰任何会改变登录态的东西）
 *   qr                  把**当前最新**二维码渲染成 PNG，打印路径
 *   wait [秒]           轮询等登录成功（不换码、不调 RefreshQRcode）
 *   quicklogin          试一次 SetQuickLogin（身份失效时会失败，别反复试）
 *   recover             进程级抢修：没进程/没端口就拉起来，然后报状态
 *
 * 铁律（手册 8.ag）：
 *   ① 绝不自动 RefreshQRcode —— 每换一次就把用户手上那张弄死；
 *   ② SetQuickLogin 失败不要连试 —— 会升级风控；
 *   ③ 二维码只在需要时渲染一次，渲染完立刻贴给用户扫。
 */

import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const WEBUI = process.env.MOLLY_WEBUI || 'http://127.0.0.1:6099'
const TOKEN = process.env.MOLLY_WEBUI_TOKEN || '${NAPCAT_TOKEN}'
const UIN = '111111111'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const ROOT = path.resolve(HERE, '..')
const OUT = path.join(ROOT, 'out')
const PY = 'D:\\Python3.10\\Python\\Python310\\python.exe'
const QR_SCRIPT = path.join(HERE, 'qr.py')

function log(...a) { console.log(new Date().toLocaleString('sv-SE'), ...a) }

/*
 * Credential 必须缓存 —— 2026-10-18 19:45 实测踩过：
 * 每轮轮询都去 POST /api/auth/login 会撞 `{"code":-1,"message":"login rate limit"}`，
 * 一撞就是几分钟不可用，看起来像"WebUI 挂了"。
 * NapCat 签发的 Credential 有效期足够长，落盘复用，只有收到 401 才重新登录。
 */
const CRED_CACHE = path.join(ROOT, 'out', '.webui-cred.json')

function readCachedCred() {
  try {
    const j = JSON.parse(fs.readFileSync(CRED_CACHE, 'utf8'))
    if (j.webui === WEBUI && j.cred && Date.now() - j.at < 6 * 3600 * 1000) return j.cred
  } catch { /* 没有缓存或坏了就走登录 */ }
  return ''
}

function writeCachedCred(cred) {
  fs.mkdirSync(path.dirname(CRED_CACHE), { recursive: true })
  fs.writeFileSync(CRED_CACHE, JSON.stringify({ webui: WEBUI, cred, at: Date.now() }), 'utf8')
}

let credMemo = readCachedCred()

async function login() {
  const hash = crypto.createHash('sha256').update(TOKEN + '.napcat').digest('hex')
  const r = await fetch(`${WEBUI}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hash }),
    signal: AbortSignal.timeout(10000),
  })
  const j = await r.json()
  const cred = j?.data?.Credential
  if (!cred) throw new Error('WebUI 登录失败：' + JSON.stringify(j).slice(0, 200))
  credMemo = cred
  writeCachedCred(cred)
  return cred
}

async function credential() {
  return credMemo || (await login())
}

async function api(cred, p, body = {}) {
  try {
    return await apiOnce(cred, p, body)
  } catch (e) {
    // 401 才值得重新登录一次；其它错误（限流、网络）直接上抛，别把限流放大成登录风暴
    if (!/401/.test(String(e?.message || ''))) throw e
    const fresh = await login()
    return apiOnce(fresh, p, body)
  }
}

async function apiOnce(cred, p, body) {
  const r = await fetch(WEBUI + p, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cred, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  })
  const text = await r.text()
  let j
  try { j = JSON.parse(text) } catch { throw new Error('HTTP ' + r.status + ' 非 JSON: ' + text.slice(0, 120)) }
  if (j?.code === -1 && /unauthorized/i.test(String(j?.message || ''))) throw new Error('HTTP 401 ' + text.slice(0, 120))
  return j
}

export async function status() {
  const cred = await credential()
  const j = await api(cred, '/api/QQLogin/CheckLoginStatus')
  const d = j?.data || {}
  return {
    ok: true,
    isLogin: !!d.isLogin,
    isOffline: !!d.isOffline,
    loginPhase: d.loginPhase || '',
    coreReady: !!d.coreReady,
    loginError: d.loginError || '',
    qrcodeurl: d.qrcodeurl || d.qrcode || '',
  }
}

function renderQR(url, outPng) {
  fs.mkdirSync(path.dirname(outPng), { recursive: true })
  execFileSync(PY, [QR_SCRIPT, url, outPng], { timeout: 30000 })
  return outPng
}

async function main() {
  const cmd = process.argv[2] || 'status'

  if (cmd === 'status') {
    const s = await status()
    console.log(JSON.stringify(s, null, 2))
    // 退出码约定：0=已登录，1=等扫码/未登录，2=WebUI 不可达
    process.exit(s.isLogin ? 0 : 1)
  }

  if (cmd === 'qr') {
    const outPng = process.argv[3] || path.join(OUT, 'Molly-login-qrcode.png')
    const s = await status()
    if (s.isLogin) { console.log('ALREADY_LOGGED_IN'); process.exit(0) }
    if (!s.qrcodeurl) { console.log('NO_QRCODE_URL phase=' + s.loginPhase); process.exit(1) }
    renderQR(s.qrcodeurl, outPng)
    const st = fs.statSync(outPng)
    console.log(JSON.stringify({ png: outPng, bytes: st.size, phase: s.loginPhase, at: Date.now() }, null, 2))
    process.exit(0)
  }

  if (cmd === 'wait') {
    const sec = Number(process.argv[3] || 300)
    const t0 = Date.now()
    let last = ''
    while (Date.now() - t0 < sec * 1000) {
      let s
      try { s = await status() } catch (e) { log('POLL_ERROR', e.message); await sleep(3000); continue }
      if (s.isLogin) { console.log('LOGIN_OK', UIN, 'phase=' + s.loginPhase); process.exit(0) }
      if (s.loginPhase !== last) { last = s.loginPhase; log('phase=' + s.loginPhase) }
      await sleep(3000)
    }
    console.log('TIMEOUT')
    process.exit(2)
  }

  if (cmd === 'quicklogin') {
    const cred = await credential()
    const r = await api(cred, '/api/QQLogin/SetQuickLogin', { uin: UIN })
    console.log(JSON.stringify(r, null, 2))
    await sleep(3000)
    const s = await status()
    console.log(JSON.stringify(s, null, 2))
    process.exit(s.isLogin ? 0 : 1)
  }

  if (cmd === 'recover') {
    // 只做「进程级」抢修：不换码、不试快速登录。要不要拉起由调用方决定。
    let s
    try { s = await status() }
    catch (e) {
      console.error('STATUS_FAIL', e.message)
      process.exit(2)
    }
    console.log(JSON.stringify(s, null, 2))
    process.exit(s.isLogin ? 0 : 1)
  }

  console.error('未知子命令: ' + cmd)
  process.exit(64)
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

main().catch((e) => { console.error('FATAL', e?.message || e); process.exit(3) })
