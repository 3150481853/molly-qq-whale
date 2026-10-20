/**
 * test-pest-package.mjs —— task-53 拆包试点自测（pest 独立成包）
 *
 * 只测「跨包接线」这件事，不重复测 PestKeeper 的业务逻辑（那是 test-pest* 的事）：
 *   1) 包侧：ctx.set('qqPest', api) 暴露了什么、没有主包时是否安全待命
 *   2) 主包侧：makePestKeeper 造实例、snapshot 打 source:'package'、坏接口要抛给上层
 *   3) 两种加载顺序（pest 先 / 主包先）都能接上 —— 宿主不保证同层插件顺序
 *   4) 降级：接口坏 / attachPest 抛错 / 完全没有 ctx 服务口，主包都不能崩
 *   5) 单实现边界：主包 lib/pest.js 必须不存在（不许双写源），实现只在独立包；
 *      缺包时 /pest 走 available:false + source:'missing' 的缺失态（不是 503、不是内置副本）
 *
 * 跑法：node test-pest-package.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import * as pestPkg from '../plugin/dsh-qq-pest/lib/boot.js'
import { makePestKeeper } from '../plugin/dsh-qq-whale/lib/main.js'

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const PEST_LIB = path.join(HERE, '..', 'plugin', 'dsh-qq-pest', 'lib')
const WHALE_LIB = path.join(HERE, '..', 'plugin', 'dsh-qq-whale', 'lib')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pest-pkg-'))
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

let pass = 0
const fails = []
async function t(name, fn) {
  try {
    await fn()
    pass++
    console.log('  ok   ' + name)
  } catch (err) {
    fails.push({ name, msg: err?.message || String(err) })
    console.log('  FAIL ' + name)
    console.log('       ' + String(err?.message || err).split('\n').slice(0, 4).join('\n       '))
  }
}

/** 假宿主：实现 ctx.provide/get/set/logger，够 boot.js 用。 */
function makeHost({ withProvide = true } = {}) {
  const services = new Map()
  const logs = []
  const provideCalls = []
  const ctx = {
    set(k, v) {
      if (v === undefined) services.delete(k)
      else services.set(k, v)
    },
    get(k) {
      return services.get(k)
    },
    logger(level, msg) {
      logs.push({ level, msg: String(msg) })
    },
  }
  if (withProvide) {
    // DSH 里跨插件服务只认 provide（cordis 官方口），set 只是老宿主兜底
    ctx.provide = (k, v) => {
      provideCalls.push(k)
      services.set(k, v)
      return () => services.delete(k)
    }
  }
  return {
    services,
    logs,
    provideCalls,
    ctx,
    text(level) {
      return logs.filter((l) => !level || l.level === level).map((l) => l.msg).join('\n')
    },
  }
}

console.log('包侧：暴露与待命')

await t('1. 没有主包时照样暴露 qqPest，接口字段齐全，日志说「待命」', () => {
  const host = makeHost()
  const dispose = pestPkg.apply(host.ctx, {})
  const api = host.services.get('qqPest')
  assert.ok(api, 'qqPest 服务应已挂上')
  assert.equal(api.package, 'dsh-qq-pest')
  for (const k of [
    'PestKeeper',
    'detectInjection',
    'isStopWord',
    'pickStopWord',
    'readPestSettings',
    'writePestSettings',
    'STOP_WORD_POOL',
    'PEST_SETTINGS_FILE',
    'createKeeper',
  ]) {
    assert.ok(k in api, `api 缺 ${k}`)
  }
  assert.equal(api.STOP_WORD_POOL.includes(api.STOP_WORD_POOL[0]), true, '停止词池应是数组')
  assert.match(host.text('info'), /待命/, '应写明待命、不挂 tick')
  assert.equal(typeof dispose, 'function')
  // 真实 DSH 里 ctx.set 不算服务注册，必须走 provide
  assert.deepEqual(host.provideCalls, ['qqPest'], '应优先用 ctx.provide 注册 qqPest')
})

await t('2. 主包已在：attachPest 立刻收到同一个 api 对象', () => {
  const host = makeHost()
  const seen = []
  host.services.set('qqWhale', {
    attachPest(api) {
      seen.push(api)
      return true
    },
  })
  pestPkg.apply(host.ctx, {})
  assert.equal(seen.length, 1, '应调用一次 attachPest')
  assert.equal(seen[0], host.services.get('qqPest'), '给主包的 api 与 ctx 上的应是同一个')
  assert.match(host.text('info'), /已接管/)
})

await t('3. attachPest 抛异常：包不抛、服务还在、日志提示主包会接管失败', () => {
  const host = makeHost()
  host.services.set('qqWhale', {
    attachPest() {
      throw new Error('boom-in-attach')
    },
  })
  const dispose = pestPkg.apply(host.ctx, {})
  assert.equal(typeof dispose, 'function')
  assert.ok(host.services.get('qqPest'), '服务不能因为接管失败就没了')
  assert.match(host.text('warn'), /boom-in-attach|内置实现/)
})

await t('4. 退化 ctx（没有 set/get）：apply 不抛，仍返回 disposer', () => {
  const bare = { logger: () => {} }
  const dispose = pestPkg.apply(bare, {})
  assert.equal(typeof dispose, 'function')
  dispose() // 卸载也不能抛
})

await t('5. disposer 撤掉 qqPest 服务', () => {
  const host = makeHost()
  const dispose = pestPkg.apply(host.ctx, {})
  assert.ok(host.services.get('qqPest'))
  dispose()
  assert.equal(host.services.get('qqPest'), undefined)
})

console.log('包侧：createKeeper 与落盘（和内置实现同一个文件）')

await t('6. createKeeper 造的是真 PestKeeper，snapshot 有 /pest 要的字段', () => {
  const api = pestPkg.createApi()
  const dir = path.join(TMP, 'k1')
  fs.mkdirSync(dir, { recursive: true })
  const keeper = api.createKeeper({ dir, targets: ['1234567'], dailyCap: 5, intervalMinutes: 30 })
  assert.ok(keeper instanceof api.PestKeeper)
  const snap = keeper.snapshot()
  for (const k of ['enabled', 'targets', 'dailyCap', 'todayUsed', 'stopWord']) {
    assert.ok(k in snap, `snapshot 缺 ${k}（/pest 验收要这几个）`)
  }
  assert.deepEqual(snap.targets, ['1234567'])
  assert.equal(snap.dailyCap, 5)
})

await t('7. 独立包写盘 → 重建后 loadSettings 读回（验收 A 的「落盘生效」）', () => {
  const api = pestPkg.createApi()
  const dir = path.join(TMP, 'k2')
  fs.mkdirSync(dir, { recursive: true })
  const settingsFile = path.join(dir, 'pest-settings.json')
  const k1 = api.createKeeper({ dir, targets: [], settingsFile })
  k1.setEnabled(false)
  k1.setTargets(['7654321'])
  k1.setDailyCap(3)
  assert.ok(fs.existsSync(settingsFile), '应写到 settingsFile')
  const onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  assert.equal(onDisk.enabled, false)

  const k2 = api.createKeeper({ dir, targets: [], settingsFile })
  assert.equal(k2.loadSettings(), true)
  assert.equal(k2.enabled, false, '关掉的选择必须跨重建保留')
  assert.deepEqual(k2.snapshot().targets, ['7654321'])
  assert.equal(k2.snapshot().dailyCap, 3)
})

console.log('主包侧：makePestKeeper（降级由 attachPest 的 try/catch 兜住）')

await t('8. makePestKeeper 打 source/available、透传 autoPick、调用 loadSettings', () => {
  let loadCalls = 0
  const fakeApi = {
    createKeeper(opts) {
      return {
        opts,
        autoPick: true,
        loadSettings() {
          loadCalls++
          return true
        },
        snapshot: () => ({ enabled: true, targets: ['1234567'], dailyCap: 8, todayUsed: 0, stopWord: '喵' }),
      }
    },
  }
  const keeper = makePestKeeper(fakeApi, {
    dir: path.join(TMP, 'k3'),
    targets: ['1234567'],
    dailyCap: 8,
    autoPick: false,
    settingsFile: path.join(TMP, 'k3', 'pest-settings.json'),
  })
  assert.equal(loadCalls, 1, '接管时必须读一次盘上的开关')
  assert.equal(keeper.autoPick, false)
  const snap = keeper.snapshot()
  assert.equal(snap.source, 'package')
  // 口径统一：两种状态都要有 available（package=true / missing=false）
  assert.equal(snap.available, true, 'package 态必须给 available:true')
  for (const k of ['enabled', 'targets', 'dailyCap', 'todayUsed', 'stopWord']) assert.ok(k in snap)
})

await t('9. 坏接口要抛（交给 attachPest 捕获降级），不能返回半成品', () => {
  assert.throws(() => makePestKeeper(null, {}), /缺 createKeeper/)
  assert.throws(() => makePestKeeper({}, {}), /缺 createKeeper/)
  assert.throws(() => makePestKeeper({ createKeeper: () => null }, {}), /没返回可用的 keeper/)
  assert.throws(
    () =>
      makePestKeeper(
        {
          createKeeper() {
            throw new Error('keeper-boom')
          },
        },
        {},
      ),
    /keeper-boom/,
  )
})

console.log('两种加载顺序 + 降级链路')

await t('10. 主包先加载 → pest 后 apply → 引擎上的 pest 立刻被替换', () => {
  const host = makeHost()
  const engine = { pest: { builtin: true }, isAllowedUser: () => true }
  const state = {
    attachPest(api) {
      try {
        engine.pest = makePestKeeper(api, {
          dir: path.join(TMP, 'k4'),
          targets: [],
          dailyCap: 8,
          settingsFile: path.join(TMP, 'k4', 'pest-settings.json'),
        })
        return true
      } catch {
        return false
      }
    },
  }
  host.services.set('qqWhale', state)
  pestPkg.apply(host.ctx, {})
  const snap = engine.pest.snapshot()
  assert.equal(snap.source, 'package')
  assert.equal(host.services.get('qqPest').package, 'dsh-qq-pest')
})

await t('11. pest 先加载 → 主包后启动时主动取 qqPest（谁先谁后都不坏）', () => {
  const host = makeHost()
  pestPkg.apply(host.ctx, {}) // 这时没有 qqWhale，包进入待命
  assert.ok(host.services.get('qqPest'))
  assert.equal(host.services.get('qqWhale'), undefined)

  // 模拟主包 apply 末尾的「主动取一次」
  const engine = { pest: { builtin: true } }
  const early = host.services.get('qqPest')
  engine.pest = makePestKeeper(early, {
    dir: path.join(TMP, 'k5'),
    targets: [],
    dailyCap: 8,
    settingsFile: path.join(TMP, 'k5', 'pest-settings.json'),
  })
  assert.equal(engine.pest.snapshot().source, 'package')
})

await t('12. 单实现：坏接口 → 不接管，主包不保留任何内置副本', () => {
  const engine = { pest: null }
  // 与 main.js attachPest 同一套语义：造失败就返回 false，engine.pest 保持 null
  const attachPest = (api) => {
    try {
      engine.pest = makePestKeeper(api, {})
      return true
    } catch {
      return false
    }
  }
  const attached = attachPest({ createKeeper: () => { throw new Error('bad-api') } })
  assert.equal(attached, false, '坏接口必须返回 false 而不是抛')
  assert.equal(engine.pest, null, '单实现：失败后不能有内置实现顶上')

  // 真·接口要给 true，证明这条降级不是「永远 false」
  const real = pestPkg.createApi()
  assert.equal(attachPest(real), true)
  assert.equal(engine.pest.snapshot().source, 'package')
})

await t('13. 缺失态约定：包不在时 /pest 用 available:false + source:missing 说明原因', () => {
  // installMissingPest 在 apply 内部（不导出），这里盯源码约定：
  // 状态必须带 available/source/reason 三个键，且不许再出现 'builtin' 兜底路径。
  const src = fs.readFileSync(path.join(WHALE_LIB, 'main.js'), 'utf8')
  assert.match(src, /available: false/, '/pest 的缺失态要给出 available:false')
  assert.match(src, /available: true/, 'package 态也要给 available:true（两种态同一个字段）')
  assert.match(src, /source: 'missing'/, '缺失态 source 必须是 missing')
  assert.match(src, /reason/, '缺失态要带 reason（告诉人为什么不可用）')
  assert.equal(/source: 'builtin'/.test(src), false, '单实现后不该再有 builtin 兜底标记')
  assert.equal(/builtinSnapshot/.test(src), false, '内置 snapshot 打标代码应已删除')
  assert.match(src, /installMissingPest/, '缺包时要装空壳，而不是让 /pest 503')
})

console.log('边界：拆包 = 搬家，不是改写')

await t('14. 单实现：主包里不存在 pest.js，实现只在独立包', () => {
  assert.equal(fs.existsSync(path.join(WHALE_LIB, 'pest.js')), false, '主包 lib/pest.js 必须已删除（否则又是双写源）')
  assert.ok(fs.existsSync(path.join(PEST_LIB, 'pest.js')), '独立包里必须有 pest.js')
  // budget.js 主包还要用（预算模块），保留
  assert.ok(fs.existsSync(path.join(WHALE_LIB, 'budget.js')), '主包 lib/budget.js 应保留')
})

await t('15. 新包源码里没有 import 主包文件（跨包只走 ctx）', () => {
  for (const f of ['boot.js', 'pest.js', 'budget.js']) {
    const src = fs.readFileSync(path.join(PEST_LIB, f), 'utf8')
    const imports = [...src.matchAll(/^\s*(?:import|export)\s[\s\S]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1])
    for (const spec of imports) {
      assert.equal(
        /dsh-qq-whale|\.\.\//.test(spec),
        false,
        `${f} 直接 import 了主包路径「${spec}」——跨包必须走 ctx.set/ctx.get`,
      )
    }
  }
})

await t('16. 老宿主没有 provide 时退回 ctx.set，仍能暴露服务', () => {
  const host = makeHost({ withProvide: false })
  pestPkg.apply(host.ctx, {})
  const api = host.services.get('qqPest')
  assert.ok(api, '没有 provide 时应退回 set 暴露')
  assert.equal(api.package, 'dsh-qq-pest')
  assert.deepEqual(host.provideCalls, [])
})

await t('17. disposer 卸载后服务消失（provide 注销路径）', () => {
  const host = makeHost()
  const dispose = pestPkg.apply(host.ctx, {})
  assert.ok(host.services.get('qqPest'))
  dispose()
  assert.equal(host.services.get('qqPest'), undefined, '卸载后 qqPest 应被撤掉')
  assert.match(host.text('info'), /已卸载/)
})

fs.rmSync(TMP, { recursive: true, force: true })
console.log('')
console.log(`${pass} passed, ${fails.length} failed`)
if (fails.length) process.exit(1)
