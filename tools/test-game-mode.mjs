/**
 * 游戏模式总闸的离线测试（不联网、不碰真机文件、不起真进程）。
 * 主人 m04935「开了游戏模式实际上啥用没有」/ m04942「把 SoVITS 这种占用大的绑在游戏模式」。
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  applyGameMode,
  gameModePaths,
  gameModeState,
  persistGameMode,
  setWatchdogVoiceKeepAlive,
  startGameModeSupervisor,
} from '../plugin/dsh-qq-whale/lib/game-mode.js'

const HERE = path.resolve(path.dirname(decodeURIComponent(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))), '..')

// ---- 临时沙箱：所有路径都指向 %TEMP%，绝不碰真机 ----
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-test-'))
const stateFile = path.join(tmp, 'game-mode.json')
const memConfig = path.join(tmp, 'mem-config.json')
const watchdogConfig = path.join(tmp, 'watchdog-config.json')
const sovitsScript = path.join(tmp, 'voice-sovits-start.ps1')
fs.writeFileSync(sovitsScript, '# stub\n', 'utf8')

const mkCfg = (extra = {}) => ({
  dataDir: tmp,
  gmPaths: { stateFile, memConfigs: [memConfig], watchdogConfig, sovitsScript },
  ...extra,
})
const writeState = (on) => fs.writeFileSync(stateFile, JSON.stringify({ on, at: Date.now() }), 'utf8')
const rmState = () => { try { fs.rmSync(stateFile) } catch {} }
const rmMem = () => { try { fs.rmSync(memConfig) } catch {} }
const writeMem = (gameMode) => fs.writeFileSync(memConfig, JSON.stringify({ gameMode }), 'utf8')
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))

let pass = 0
const fails = []
function t(name, fn) {
  return (async () => {
    try {
      await fn()
      pass++
      console.log('PASS ' + name)
    } catch (err) {
      fails.push(name + ' :: ' + (err?.message || err))
      console.log('FAIL ' + name + ' :: ' + (err?.message || err))
    }
  })()
}

await t('路径覆盖：config.gmPaths 整套生效', () => {
  const p = gameModePaths(mkCfg())
  assert.equal(p.stateFile, stateFile)
  assert.deepEqual(p.memConfigs, [memConfig])
  assert.equal(p.watchdogConfig, watchdogConfig)
})

await t('什么信号都没有 → 关，来源 default', () => {
  rmState(); rmMem()
  assert.deepEqual(gameModeState({ config: mkCfg(), fresh: true }), { on: false, source: 'default' })
})

await t('落盘文件说开 → state-file', () => {
  writeState(true)
  const st = gameModeState({ config: mkCfg(), fresh: true })
  assert.equal(st.on, true)
  assert.equal(st.source, 'state-file')
})

await t('落盘文件说关 → 关（不是「有文件就算开」）', () => {
  writeState(false)
  assert.equal(gameModeState({ config: mkCfg(), fresh: true }).on, false)
})

await t('没有 game-mode.json 时退到控制台 mem-config', () => {
  rmState(); writeMem(true)
  const st = gameModeState({ config: mkCfg(), fresh: true })
  assert.equal(st.on, true)
  assert.equal(st.source, 'mem-config')
  rmMem()
})

await t('runtime 开关优先于磁盘', () => {
  writeState(false)
  const st = gameModeState({ config: mkCfg({ gameModeOn: true }), fresh: true })
  assert.equal(st.on, true)
  assert.equal(st.source, 'runtime')
  rmState()
})

await t('engine.config 也能给信号', () => {
  const st = gameModeState({ engine: { config: mkCfg({ gameModeOn: true }) }, fresh: true })
  assert.equal(st.on, true)
  assert.equal(st.source, 'engine')
})

await t('坏 JSON 不抛，当没有', () => {
  fs.writeFileSync(stateFile, '{ 这不是 json', 'utf8')
  assert.equal(gameModeState({ config: mkCfg(), fresh: true }).on, false)
  rmState()
})

await t('3 秒缓存：窗口内不重读盘，fresh 能穿透', () => {
  writeState(true)
  const cfg = mkCfg()
  assert.equal(gameModeState({ config: cfg, fresh: true }).on, true)
  writeState(false)
  const cached = gameModeState({ config: cfg })
  assert.equal(cached.on, true)
  assert.equal(cached.cached, true)
  assert.equal(gameModeState({ config: cfg, fresh: true }).on, false)
})

await t('persistGameMode 落盘 on/at', () => {
  rmState()
  assert.equal(persistGameMode(true, { config: mkCfg() }), true)
  const j = readJson(stateFile)
  assert.equal(j.on, true)
  assert.equal(typeof j.at, 'number')
  assert.equal(gameModeState({ config: mkCfg(), fresh: true }).on, true)
})

await t('watchdog 保活：关掉它，且保留其它键', () => {
  fs.writeFileSync(watchdogConfig, JSON.stringify({ someOther: 42, voiceKeepAlive: true }), 'utf8')
  const r = setWatchdogVoiceKeepAlive(false, { config: mkCfg() })
  assert.equal(r.ok, true)
  assert.equal(r.changed, true)
  const j = readJson(watchdogConfig)
  assert.equal(j.voiceKeepAlive, false)
  assert.equal(j.someOther, 42)
  assert.equal(setWatchdogVoiceKeepAlive(false, { config: mkCfg() }).changed, false)
})

await t('watchdog 保活：关模式时改回来', () => {
  const r = setWatchdogVoiceKeepAlive(true, { config: mkCfg() })
  assert.equal(r.changed, true)
  assert.equal(readJson(watchdogConfig).voiceKeepAlive, true)
})

await t('applyGameMode 开：开关到位 + 重活全收', async () => {
  const cfg = mkCfg({ voiceEnabled: true, singingEnabled: true })
  const calls = []
  const deps = {
    setWatchdogVoiceKeepAlive: (on) => { calls.push(['keepAlive', on]); return { ok: true, changed: true } },
    stopSovits: async () => { calls.push(['stopSovits']); return { ok: true, note: '已优雅退出' } },
    stopEmbed: async () => { calls.push(['stopEmbed']); return { ok: true, note: '已停' } },
  }
  const facts = await applyGameMode({ on: true, config: cfg, deps })
  assert.equal(cfg.voiceEnabled, false)
  assert.equal(cfg.singingEnabled, false)
  assert.equal(cfg.gameModeOn, true)
  assert.deepEqual(cfg.__gmBackup, { voiceEnabled: true, singingEnabled: true })
  assert.deepEqual(calls, [['keepAlive', false], ['stopSovits'], ['stopEmbed']])
  assert.equal(facts.reclaimed.sovits.note, '已优雅退出')
  assert.equal(facts.flags.gameModeOn, true)
})

await t('applyGameMode 关：按开启前的 backup 还原，不硬开', async () => {
  const cfg = mkCfg({ voiceEnabled: false, singingEnabled: false })
  const deps = {
    setWatchdogVoiceKeepAlive: () => ({ ok: true, changed: true }),
    stopSovits: async () => ({ ok: true }),
    stopEmbed: async () => ({ ok: true }),
    startSovits: () => ({ ok: true, note: '已拉起' }),
  }
  await applyGameMode({ on: true, config: cfg, deps })
  await applyGameMode({ on: false, config: cfg, deps })
  assert.equal(cfg.voiceEnabled, false, '本来是关的，就不能趁关游戏模式偷偷打开')
  assert.equal(cfg.gameModeOn, false)
  assert.equal(cfg.__gmBackup, null)
})

await t('看门狗：起来时磁盘说开着 → 立刻静默收活；变了才动', async () => {
  writeState(true)
  const cfg = mkCfg({ voiceEnabled: true })
  const calls = []
  const deps = {
    setWatchdogVoiceKeepAlive: () => ({ ok: true, changed: true }),
    stopSovits: async () => { calls.push('stop'); return { ok: true } },
    stopEmbed: async () => { calls.push('embed'); return { ok: true } },
    startSovits: () => { calls.push('start'); return { ok: true } },
  }
  const sup = startGameModeSupervisor({ config: cfg, deps, intervalMs: 60_000, logger: () => {} })
  await sup.tick()
  assert.deepEqual(calls, ['stop', 'embed'])
  assert.equal(cfg.gameModeOn, true)
  await sup.tick()
  assert.deepEqual(calls, ['stop', 'embed'], '状态没变就不该重复干活')
  writeState(false)
  await sup.tick()
  assert.deepEqual(calls, ['stop', 'embed', 'start'])
  assert.equal(cfg.gameModeOn, false)
  sup.stop()
})

await t('仓库根：从 dataDir 往上找（装进 node_modules 的情况）', () => {
  // 造一个「仓库 + data 子目录」的形状：lib 在别处时只有 dataDir 指得回来
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), 'gm-root-'))
  const repo = path.join(fake, 'qq-whale')
  fs.mkdirSync(path.join(repo, 'tools'), { recursive: true })
  fs.mkdirSync(path.join(repo, 'plugin'), { recursive: true })
  fs.writeFileSync(path.join(repo, 'watchdog-config.json'), JSON.stringify({ voiceKeepAlive: true }), 'utf8')
  fs.writeFileSync(path.join(repo, 'tools', 'voice-sovits-start.ps1'), '# stub\n', 'utf8')
  const dataDir = path.join(repo, 'data', 'qq-whale')
  fs.mkdirSync(dataDir, { recursive: true })
  const p = gameModePaths({ dataDir })
  assert.equal(p.root, repo, '应该找到那个同时有 tools/ 与 plugin/ 的目录')
  assert.equal(p.watchdogConfig, path.join(repo, 'watchdog-config.json'))
  assert.equal(p.sovitsScript, path.join(repo, 'tools', 'voice-sovits-start.ps1'))
  // 真机同款：${MOLLY_ROOT}\data\qq-whale → ${MOLLY_ROOT}\qq-whale
  if (fs.existsSync('G:\\Molly\\qq-whale\\tools')) {
    const real = gameModePaths({ dataDir: 'G:\\Molly\\data\\qq-whale' })
    assert.equal(real.root, 'G:\\Molly\\qq-whale')
    assert.equal(real.stateFile, 'G:\\Molly\\data\\qq-whale\\game-mode.json')
  }
  fs.rmSync(fake, { recursive: true, force: true })
})

await t('sidecar 认这个闸（源码断言）', () => {
  const src = fs.readFileSync(path.join(HERE, 'plugin', 'dsh-qq-whale', 'lib', 'sidecar.js'), 'utf8')
  assert.match(src, /import \{ gameModeState \} from '\.\/game-mode\.js'/)
  assert.match(src, /if \(gameModeState\(\)\.on\) return false/)
})

await t('web.js 已经接到 game-mode.js（源码断言）', () => {
  const src = fs.readFileSync(path.join(HERE, 'plugin', 'dsh-qq-whale', 'lib', 'web.js'), 'utf8')
  assert.match(src, /from '\.\/game-mode\.js'/)
  assert.match(src, /applyGameMode\(\{/)
  assert.match(src, /startGameModeSupervisor\(\)/)
  assert.match(src, /reclaimed: facts\.reclaimed/)
  assert.doesNotMatch(src, /readGameModeFile/, '老的本地落盘助手应该已经删掉')
})

try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}

console.log('')
console.log(`${pass} 过 / ${fails.length} 挂`)
if (fails.length) {
  for (const f of fails) console.log('  ✗ ' + f)
  process.exit(1)
}
