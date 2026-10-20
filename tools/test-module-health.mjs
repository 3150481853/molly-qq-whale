/**
 * task-51 自测：模块健康登记表 + /state.plugins + 缺失告警。
 *
 * 覆盖（对应任务里的验收）：
 *   ① 登记齐全 → missing=[]、failed=[]
 *   ② 一个模块失败 → 进 failed，且 missing 里也有它；snapshot() 不抛
 *   ③ /state 的 plugins 字段存在且形状对；registry 取不到时整块 null
 *   ④ 缺失告警只在 missing>0（或 failed>0）时发出；正常启动 0 次
 *
 * 用法：node tools/test-module-health.mjs
 *      HEALTH_LIB_DIR=<安装副本 lib> node tools/test-module-health.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB_DIR = process.env.HEALTH_LIB_DIR || path.join(HERE, '..', 'plugin', 'dsh-qq-whale', 'lib')
const libUrl = (name) => pathToFileURL(path.join(LIB_DIR, name)).href

const health = await import(libUrl('module-health.js'))
const { WebWidget } = await import(libUrl('web.js'))
const {
  MODULE_MANIFEST,
  registerModule,
  registerFailed,
  snapshot,
  setExpected,
  _resetForTest,
  gapAlertText,
  notifyGaps,
} = health

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}
const eq = (name, a, b) => ok(name, a === b, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)
const logger = () => {}

// ─── 1. 登记齐全 ──────────────────────────────────────────────
console.log('\n[1] 登记齐全 → missing=[]、failed=[]')
{
  _resetForTest()
  const names = MODULE_MANIFEST.map((m) => m.name)
  setExpected(names)
  for (const m of MODULE_MANIFEST) registerModule({ name: m.name, exports: ['x'], optional: !m.required })
  const s = snapshot()
  eq('expected 条数', s.expected.length, names.length)
  eq('loaded 条数', s.loaded.length, names.length)
  eq('missing 为空', s.missing.length, 0)
  eq('failed 为空', s.failed.length, 0)
  ok('reloadAt 是数字', typeof s.reloadAt === 'number' && s.reloadAt > 0)
  ok('build 字段存在（可为 null）', 'build' in s)
  eq('正常启动不出告警文案', gapAlertText(s), '')
}

// ─── 2. 失败登记 ─────────────────────────────────────────────
console.log('\n[2] 一个模块失败 → failed + missing，snapshot 不抛')
{
  _resetForTest()
  setExpected(['onebot', 'engine', 'web'])
  registerModule({ name: 'onebot', exports: ['OneBotClient'] })
  registerModule({ name: 'web', exports: ['WebWidget'] })
  registerFailed({ name: 'engine', error: 'SyntaxError: boom' })

  let s = null
  let threw = false
  try { s = snapshot() } catch { threw = true }
  eq('snapshot 不抛', threw, false)
  eq('failed 里有 engine', s.failed[0]?.name, 'engine')
  ok('failed 里带错误原文', String(s.failed[0]?.error).includes('boom'), String(s.failed[0]?.error))
  ok('missing 里也有 engine', s.missing.includes('engine'), JSON.stringify(s.missing))
  ok('已加载的不算 missing', !s.missing.includes('onebot') && !s.missing.includes('web'))

  const text = gapAlertText(s)
  ok('告警文案点名缺失模块', text.includes('engine'), text)
  ok('告警文案给出 /state.plugins 指引', text.includes('/state.plugins'), text)

  // 空 registry / 奇怪输入也不许抛
  ok('gapAlertText(undefined) 用现取快照、不抛', typeof gapAlertText(undefined) === 'string')
  let badThrew = false
  try { health.snapshot.call(null) } catch { badThrew = true }
  eq('snapshot 脱开 this 也不抛', badThrew, false)
}

// ─── 3. /state.plugins ───────────────────────────────────────
console.log('\n[3] GET /state 带 plugins 字段；取不到时整块 null')
{
  _resetForTest()
  setExpected(['onebot', 'engine'])
  registerModule({ name: 'onebot', exports: [] })
  registerFailed({ name: 'engine', error: 'import failed' })

  const routes = new Map()
  const webServer = {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const widget = new WebWidget({
    logger,
    config: { enabled: true, selfId: '1' },
    state: {},
    engineRef: () => null,
    recheck: async () => ({}),
    refreshLogin: async () => ({}),
  })
  widget.register({ webServer })

  async function getState() {
    const route = routes.get('/dsh-qq-whale/state')
    if (!route) throw new Error('state 路由没注册')
    const req = Readable.from([])
    req.method = 'GET'
    req.url = '/dsh-qq-whale/state'
    req.headers = { host: '127.0.0.1:7053', 'sec-fetch-site': 'same-origin' }
    const res = {
      status: 0,
      headers: {},
      body: '',
      writeHead(code, headers) { this.status = code; this.headers = headers || {} },
      end(b) { this.body = b || '' },
    }
    await route.handler(req, res)
    return { status: res.status, json: JSON.parse(res.body || '{}') }
  }

  const r = await getState()
  eq('HTTP 200', r.status, 200)
  ok('/state 有 plugins 字段', r.json.plugins !== undefined, JSON.stringify(Object.keys(r.json)))
  const p = r.json.plugins
  ok('plugins 是对象', p && typeof p === 'object', String(p))
  for (const k of ['expected', 'loaded', 'missing', 'failed', 'reloadAt', 'build']) {
    ok(`plugins.${k} 存在`, k in p, JSON.stringify(Object.keys(p || {})))
  }
  ok('plugins.missing 含 engine', p.missing.includes('engine'), JSON.stringify(p.missing))
  eq('plugins.failed 长度', p.failed.length, 1)

  // 取不到 registry → 整块 null（不编造）
  widget.moduleSnapshot = null
  const r2 = await getState()
  eq('registry 拿不到时 plugins=null', r2.json.plugins, null)
}

// ─── 4. 只在缺失时告警 ───────────────────────────────────────
console.log('\n[4] 缺失告警只在 missing>0 / failed>0 时发出')
{
  // 正常：0 次
  _resetForTest()
  setExpected(['a', 'b'])
  registerModule({ name: 'a' })
  registerModule({ name: 'b' })
  const calls = []
  const sent0 = await notifyGaps({ send: async (t) => calls.push(t), logger })
  eq('齐全时不发', sent0, false)
  eq('齐全时 send 调用 0 次', calls.length, 0)

  // 有缺失：1 次
  _resetForTest()
  setExpected(['a', 'b', 'c'])
  registerModule({ name: 'a' })
  const sent1 = await notifyGaps({ send: async (t) => calls.push(t), logger })
  eq('缺失时发 1 次', sent1, true)
  eq('send 调用 1 次', calls.length, 1)
  ok('告警点名 c', calls[0].includes('c'), calls[0])
  ok('告警含条数', /少了 2 个模块/.test(calls[0]), calls[0])

  // 只有 failed：也发
  _resetForTest()
  setExpected(['a'])
  registerFailed({ name: 'a', error: 'boom' })
  const calls2 = []
  const sent2 = await notifyGaps({ send: async (t) => calls2.push(t), logger })
  eq('只有 failed 也发', sent2, true)
  eq('send 调用 1 次', calls2.length, 1)
}

// ─── 5. boot-health.json 落盘 ─────────────────────────────────
console.log('\n[5] boot-health.json：成功写 ok:true，失败写 ok:false+error+gen，写盘抛错不崩')
{
  const boot = await import(libUrl('boot.js'))
  const TMP = path.join(HERE, '..', 'out', 'test-module-health-data')
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(TMP, { recursive: true })
  const file = path.join(TMP, 'boot-health.json')

  // ① 成功路径
  eq('写成功返回 true', boot.writeBootHealth({ file, ok: true, reason: '', gen: 'gen-abc' }), true)
  const raw1 = fs.readFileSync(file)
  const rec1 = JSON.parse(raw1.toString('utf8'))
  eq('ok=true', rec1.ok, true)
  eq('reason 为空', rec1.reason, '')
  eq('gen 正确', rec1.gen, 'gen-abc')
  ok('at 是 ISO 时间', /^\d{4}-\d{2}-\d{2}T/.test(String(rec1.at)), String(rec1.at))
  ok('UTF-8 无 BOM', !(raw1[0] === 0xef && raw1[1] === 0xbb && raw1[2] === 0xbf), raw1.subarray(0, 3).toString('hex'))
  ok('成功记录不带 error', !('error' in rec1))

  // ② 失败分支（覆盖上次成功记录）
  eq('写失败记录返回 true', boot.writeBootHealth({
    file,
    ok: false,
    reason: 'main-load-failed',
    error: 'Error: boom\n    at main.js:1:1',
    gen: 'gen-def',
  }), true)
  const rec2 = JSON.parse(fs.readFileSync(file, 'utf8'))
  eq('ok=false', rec2.ok, false)
  eq('reason=main-load-failed', rec2.reason, 'main-load-failed')
  ok('error 原文保留', String(rec2.error).includes('boom') && String(rec2.error).includes('at main.js'), String(rec2.error))
  eq('gen 正确', rec2.gen, 'gen-def')

  // ③ fs 抛错：只 warn，不崩、返回 false
  const warns = []
  const boomFs = {
    mkdirSync() { throw new Error('EACCES: 无权限') },
    writeFileSync() {},
    renameSync() {},
    unlinkSync() {},
  }
  let threw = false
  let ret = null
  try {
    ret = boot.writeBootHealth({ file, ok: true, gen: 'gen-x' }, { fsImpl: boomFs, logger: (lv, m) => warns.push([lv, m]) })
  } catch {
    threw = true
  }
  eq('写盘抛错时不崩', threw, false)
  eq('写盘抛错返回 false', ret, false)
  ok('写盘抛错时 warn 一条', warns.length === 1 && /写盘失败/.test(warns[0][1]), JSON.stringify(warns))

  // ④ 路径解析：config.dataDir 优先，环境变量整路径覆盖，绝不落到 C 盘
  const p1 = boot.bootHealthPath({ dataDir: 'G:\\Molly\\data\\qq-whale' })
  eq('dataDir 优先', p1, path.join('G:\\Molly\\data\\qq-whale', 'boot-health.json'))
  const prevEnv = process.env.MOLLY_BOOT_HEALTH
  process.env.MOLLY_BOOT_HEALTH = path.join(TMP, 'custom.json')
  const p2 = boot.bootHealthPath({ dataDir: 'G:\\whatever' })
  process.env.MOLLY_BOOT_HEALTH = prevEnv
  eq('环境变量整路径覆盖', p2, path.join(TMP, 'custom.json'))
  const p3 = boot.bootHealthPath({})
  ok('默认不落 C 盘', !/^C:/i.test(p3), p3)

  fs.rmSync(TMP, { recursive: true, force: true })
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(fail === 0 ? 0 : 1)
