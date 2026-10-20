/**
 * 「骂人模式」总开关（task-36）验收测试。
 *
 * 用户原话（2026-10-19 23:34）：「给 333333333 设计的安全词好像失效了，你在控制台
 * 加一个开关吧，开了开关就进入骂他的模式」。硬要求是**不重启插件就立即开、立即停**，
 * 所以这个测试只盯一件事：开关的状态到底有没有被所有路径当真。
 *
 * 覆盖：
 *   1. `setEnabled(false)` 之后 `get enabled === false`，且 `canPick` 恒 false
 *      （引擎里停止词拦截/注入反击/主动开团/停止词报备四处都读 `enabled`）。
 *   2. 落盘 `pest-settings.json`，`new PestKeeper` 读回仍然是关（重载/重启不失效）。
 *   3. `setEnabled(true)` 能开回来；`setTargets([])` 等价于关。
 *   4. `GET /pest` 快照字段齐全；`POST /pest` 校验与即时生效。
 *
 * 跑法（PATH 里没有 node）：
 *   & "${HOME}\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
 *     ${MOLLY_ROOT}\qq-whale\tools\test-pest-switch.mjs
 *
 * 只写 out/test-pest-data/，跑完（无论成败）整个删掉。真库不碰。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJ = path.resolve(HERE, '..')
const LIB_DIR = process.env.PEST_LIB_DIR || path.join(PROJ, 'plugin', 'dsh-qq-whale', 'lib')
const TMP = path.join(PROJ, 'out', 'test-pest-data')

const { PestKeeper, PEST_SETTINGS_FILE } = await import(
  pathToFileURL(path.join(LIB_DIR, 'pest.js')).href
)
const { WebWidget } = await import(pathToFileURL(path.join(LIB_DIR, 'web.js')).href)

let pass = 0
let fail = 0
const failures = []
function ok(cond, name, extra) {
  if (cond) {
    pass++
    console.log(`  ✔ ${name}`)
    return true
  }
  fail++
  failures.push(name)
  console.log(`  ✘ ${name}${extra === undefined ? '' : `  ← ${JSON.stringify(extra)}`}`)
  return false
}

// ── 假宿主 webServer（与 test-crud 同一套写法）────────────────────────
const routes = new Map()
const webServer = {
  register(route) {
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  },
}
function makeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.status = code
      this.headers = headers || {}
    },
    end(body) {
      this.body = body || ''
    },
  }
}
async function call(method, urlPath, body) {
  const route = routes.get(urlPath)
  if (!route) throw new Error(`路由没注册：${urlPath}`)
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from(payload ? [Buffer.from(payload, 'utf8')] : [])
  req.method = method
  req.url = urlPath
  req.headers = { host: '127.0.0.1:7053', 'sec-fetch-site': 'same-origin' }
  const res = makeRes()
  await route.handler(req, res)
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, json, raw: res.body }
}

const P = '/dsh-qq-whale'
const TARGET = '333333333'

try {
  fs.rmSync(TMP, { recursive: true, force: true })
  fs.mkdirSync(TMP, { recursive: true })
  const settingsFile = path.join(TMP, PEST_SETTINGS_FILE)
  const mk = (extra = {}) =>
    new PestKeeper({
      dir: TMP,
      logger: () => {},
      targets: [TARGET],
      dailyCap: 8,
      intervalMinutes: 45,
      restWindows: [],
      settingsFile,
      ...extra,
    })

  // ── 1. 初始状态 ──────────────────────────────────────────────────
  console.log('\n[1] 初始：配了对象就是开着的')
  const pest = mk()
  ok(pest.enabled === true, '初始 enabled=true')
  ok(pest.snapshot().enabled === true, 'snapshot.enabled=true')

  const snapFields = [
    'enabled',
    'targets',
    'dailyCap',
    'intervalMinutes',
    'autoPick',
    'todayUsed',
    'stopWord',
    'stopSentAt',
    'nextPickInMinutes',
    'used',
    'remain',
    'muted',
    'date',
  ]
  const snap0 = pest.snapshot()
  const missing = snapFields.filter((k) => !(k in snap0))
  ok(missing.length === 0, '快照字段齐全（GET /pest 要的那些）', missing)
  ok(snap0.targets[0] === TARGET, '快照带目标 QQ')
  ok(typeof snap0.stopWord === 'string' && snap0.stopWord.length > 0, '快照带今天的停止词', snap0.stopWord)
  ok(snap0.intervalMinutes === 45 && snap0.dailyCap === 8, '快照带间隔与日额度')

  // ── 2. 关掉：立即生效 ────────────────────────────────────────────
  console.log('\n[2] setEnabled(false)：立即生效、canPick 恒 false')
  const off = pest.setEnabled(false)
  ok(off === false, 'setEnabled(false) 返回 false')
  ok(pest.enabled === false, 'get enabled === false')
  const gateOff = pest.canPick(TARGET)
  ok(gateOff.ok === false, '关掉后 canPick 不放行')
  ok(gateOff.reason === '总开关已关闭', '关掉后 canPick 的理由是总开关', gateOff.reason)
  ok(pest.isStopWordHit(pest.stopWord) === false, '关掉后停止词也不再触发（整块停用）')
  ok(pest.snapshot().enabled === false, '快照同步为关')

  // ── 3. 落盘 + 重建对象仍是关 ─────────────────────────────────────
  console.log('\n[3] 落盘 pest-settings.json，重建对象读回为关')
  ok(fs.existsSync(settingsFile), 'pest-settings.json 已生成', settingsFile)
  const disk = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  ok(disk.enabled === false, '文件里 enabled=false', disk)
  ok(Array.isArray(disk.targets) && disk.targets[0] === TARGET, '文件里保留了设置过的对象')
  ok(typeof disk.updatedAt === 'number' && disk.updatedAt > 0, '文件带 updatedAt（方便排查是谁什么时候关的）')

  const reborn = mk()
  ok(reborn.enabled === false, 'new PestKeeper 读回仍然是关（重载/重启不失效）')
  ok(reborn.snapshot().enabled === false, '重建后的快照也是关')
  ok(reborn.loadSettings() === true, 'loadSettings() 报告读到过设置')

  // ── 4. 开回来 ───────────────────────────────────────────────────
  console.log('\n[4] setEnabled(true)：能开回来')
  const on = pest.setEnabled(true)
  ok(on === true, 'setEnabled(true) 返回 true')
  ok(pest.enabled === true, 'get enabled === true')
  const gateOn = pest.canPick(TARGET)
  ok(gateOn.ok === true, '开回来之后 canPick 放行', gateOn.reason)
  ok(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).enabled === true, '文件里也变成 enabled=true')

  // ── 5. setTargets([]) 等价于关 ───────────────────────────────────
  console.log('\n[5] setTargets([])：没有对象就等于关')
  pest.setTargets([])
  ok(pest.enabled === false, '对象清空后 enabled=false')
  ok(pest.canPick(TARGET).ok === false, '对象清空后 canPick 不放行')
  pest.setTargets([TARGET])
  ok(pest.enabled === true, '把对象加回来又开了')

  // ── 6. 额度/间隔可改并落盘 ───────────────────────────────────────
  console.log('\n[6] setDailyCap / setIntervalMinutes 落盘')
  ok(pest.setDailyCap(3) === 3, '日额度改成 3')
  ok(pest.setIntervalMinutes(5) === 5, '间隔改成 5 分钟')
  const disk2 = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  ok(disk2.dailyCap === 3 && disk2.intervalMinutes === 5, '两项都写进了文件', disk2)
  ok(pest.snapshot().intervalMinutes === 5, '快照跟着变')
  ok(pest.nextPickInMinutes() === 0, '没开过团时 nextPickInMinutes=0')

  // 开一次团之后，间隔期间 canPick 应拒
  pest.notePicked(TARGET)
  ok(pest.nextPickInMinutes() > 0, '开过团之后 nextPickInMinutes>0', pest.nextPickInMinutes())
  ok(pest.canPick(TARGET).reason === '离上次太近', '间隔期间不放行')
  pest.setIntervalMinutes(45)

  // ── 7. HTTP：GET /pest ─────────────────────────────────────────
  console.log('\n[7] HTTP GET /pest：状态可读')
  const engine = { pest }
  const widget = new WebWidget({
    logger: () => {},
    config: { enabled: true, memoryDir: TMP, dataDir: TMP },
    state: {},
    engineRef: () => engine,
    recheck: async () => ({}),
    refreshLogin: async () => ({}),
  })
  widget.register({ webServer })

  let r = await call('GET', `${P}/pest`)
  ok(r.status === 200 && r.json?.ok === true, 'GET /pest → 200 ok', r.status)
  ok(r.json?.state?.enabled === true, 'GET 回来的 enabled=true')
  ok(r.json?.state?.targets?.[0] === TARGET, 'GET 回来带目标 QQ')
  ok(typeof r.json?.state?.stopWord === 'string' && r.json.state.stopWord.length > 0, 'GET 回来带停止词')
  ok(r.json?.state?.dailyCap === 3, 'GET 回来的日额度是刚改的 3')
  ok(r.json?.state?.todayUsed === 1, 'GET 回来的今日已用=1', r.json?.state?.todayUsed)
  ok(r.json?.persisted === true, 'GET 标明会跨重载保留')

  // ── 8. HTTP：POST /pest 关掉 → 立刻停 ───────────────────────────
  console.log('\n[8] HTTP POST /pest {enabled:false}：一次请求就停')
  r = await call('POST', `${P}/pest`, { enabled: false })
  ok(r.status === 200 && r.json?.ok === true, 'POST 关 → 200', r)
  ok(r.json?.state?.enabled === false, '响应里的 state.enabled=false')
  ok(pest.enabled === false, '活对象的 enabled 立刻是 false（不用等 tick）')
  ok(pest.canPick(TARGET).ok === false, '关掉后 canPick 立刻不放行')
  ok(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).enabled === false, '落盘也是关')

  r = await call('POST', `${P}/pest`, { enabled: true })
  ok(r.status === 200 && pest.enabled === true, '再点一下又开了')

  // ── 9. 校验 ─────────────────────────────────────────────────────
  console.log('\n[9] POST /pest 参数校验')
  r = await call('POST', `${P}/pest`, { enabled: 'yes' })
  ok(r.status === 400 && /enabled/.test(r.json?.error || ''), 'enabled 非 boolean → 400', r.json)
  r = await call('POST', `${P}/pest`, {})
  ok(r.status === 400 && /没有要改的字段/.test(r.json?.error || ''), '空 body → 400', r.json)
  r = await call('POST', `${P}/pest`, { targets: ['abc'] })
  ok(r.status === 400 && /不合法/.test(r.json?.error || ''), 'targets 里混了非 QQ 号 → 400', r.json)
  r = await call('POST', `${P}/pest`, { dailyCap: -1 })
  ok(r.status === 400, 'dailyCap 负数 → 400')
  r = await call('POST', `${P}/pest`, { intervalMinutes: 0 })
  ok(r.status === 400, 'intervalMinutes=0 → 400')
  r = await call('GET', `${P}/pest`)
  ok(r.json?.state?.targets?.[0] === TARGET && pest.enabled === true, '校验失败没有改动任何状态')

  // 一次请求同时改对象和开关
  r = await call('POST', `${P}/pest`, { enabled: true, targets: ['333333333', '888888888'], dailyCap: 2 })
  ok(
    r.status === 200 && r.json.state.targets.length === 2 && r.json.state.dailyCap === 2,
    '一次请求可以同时改开关/对象/额度',
    r.json?.state,
  )

  // ── 10. engine 未就绪时 503，不谎报成功 ─────────────────────────
  console.log('\n[10] engine 没就绪 → 503')
  const engineRefEmpty = () => null
  const widget2 = new WebWidget({
    logger: () => {},
    config: { enabled: true, memoryDir: TMP, dataDir: TMP },
    state: {},
    engineRef: engineRefEmpty,
    recheck: async () => ({}),
    refreshLogin: async () => ({}),
  })
  // 用同一个假 webServer 会覆盖同名路由，最后再注册回来
  widget2.register({ webServer })
  r = await call('GET', `${P}/pest`)
  ok(r.status === 503 && r.json?.ok === false, 'engine 未就绪 → 503', r.status)
  widget.register({ webServer })

  // ── 11. 停止词：命中记录"什么时候喊的"，并拦主动开团 ─────────────
  console.log('\n[11] 停止词：mutedAt 可查、静音期间不主动开团')
  pest.setDailyCap(8)
  pest.setIntervalMinutes(45)
  const muteNow = Date.now()
  const word = pest.stopWord
  ok(pest.isStopWordHit(`停一下，${word}`) === true, '包含当天停止词的消息算命中')
  ok(pest.isStopWordHit('今天天气不错') === false, '普通消息不命中')
  const until = pest.mute(muteNow)
  ok(until > muteNow, '静音到一个未来时刻', until)
  const snapMuted = pest.snapshot(muteNow + 1000)
  ok(snapMuted.muted === true, '快照 muted=true')
  ok(snapMuted.mutedAt === muteNow, '快照记录了喊停的时刻（排查失效要用）', snapMuted.mutedAt)
  ok(
    pest.canPick(TARGET, muteNow + 1000).reason === '停止词静音中',
    '静音期间不主动开团',
    pest.canPick(TARGET, muteNow + 1000).reason,
  )
  pest.unmute()
  ok(pest.snapshot().muted === false && pest.snapshot().mutedAt === 0, '解除静音后 muted/mutedAt 都归零')

  /* ------------------------- [12] 静音期被动回复闸门（engine.js） -------------------------
     这一刀是给真机上「喊了停止词，转头又被骂一句」补的：mute() 以前只拦主动开团，
     被动回复链路根本没读 isMuted()。这里用 ChatEngine.prototype 造一个假引擎，
     只验闸门的三种走向，不跑整条 onMessage。 */
  console.log('\n[12] 静音期被动回复闸门')
  try {
    const { ChatEngine } = await import(pathToFileURL(path.join(LIB_DIR, 'engine.js')).href)
    const engine = Object.create(ChatEngine.prototype)
    const sent = []
    const taps = []
    engine.logger = () => {}
    engine.sayQuick = async (ev, scene, text) => { sent.push(String(text)) }
    engine.tapEmoji = async (mid) => { taps.push(mid) }

    const TARGET_EV = { user_id: '333333333', message_id: 'm-target' }
    const OTHER_EV = { user_id: '999999', message_id: 'm-other' }

    engine.pest = { enabled: true, isMuted: () => true, isTarget: (uid) => String(uid) === '333333333' }
    ok((await engine.pestMuteGate(TARGET_EV, 'private', {})) === true, '静音 + 目标 + 私聊 → 拦住')
    ok(sent.length === 1 && /不骂了/.test(sent[0]), '私聊回一句中性收场（不静默）', JSON.stringify(sent))
    ok(taps.length === 0, '私聊不贴表情')

    sent.length = 0
    ok((await engine.pestMuteGate(TARGET_EV, 'group', { isAtMe: true })) === true, '群聊里被 @ 也拦住')
    ok(sent.length === 1, '被 @ 时仍然回一句，不晾着')

    sent.length = 0; taps.length = 0
    ok((await engine.pestMuteGate(TARGET_EV, 'group', { isAtMe: false })) === true, '群里没点她名字也拦住')
    ok(sent.length === 0 && taps.length === 1, '没 @ 时只贴表情，不在群里刷屏', JSON.stringify({ sent, taps }))

    sent.length = 0; taps.length = 0
    ok((await engine.pestMuteGate(OTHER_EV, 'private', {})) === false, '静音期非目标不受影响')
    ok(sent.length === 0 && taps.length === 0, '非目标不发任何东西')

    engine.pest = { enabled: true, isMuted: () => false, isTarget: () => true }
    ok((await engine.pestMuteGate(TARGET_EV, 'private', {})) === false, '解除静音后正常走原链路')
    ok(sent.length === 0, '恢复后闸门不再代答')

    engine.pest = { enabled: false, isMuted: () => true, isTarget: () => true }
    ok((await engine.pestMuteGate(TARGET_EV, 'private', {})) === false, '总开关关掉时闸门不生效（那时本来就不许骂）')

    const engineSrc = fs.readFileSync(path.join(LIB_DIR, 'engine.js'), 'utf8')
    ok(/if \(await this\.pestMuteGate\(ev, scene, norm\)\) return/.test(engineSrc), 'onMessage 里确实接了这个闸门（防只写方法没接线）')
  } catch (err) {
    fail++
    failures.push('静音闸门测试异常：' + err.message)
    console.error('静音闸门测试异常：', err)
  }
} catch (err) {
  fail++
  failures.push('未捕获异常')
  console.error('\n未捕获异常：', err)
} finally {
  fs.rmSync(TMP, { recursive: true, force: true })
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail) {
    console.log('失败项：')
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
}
