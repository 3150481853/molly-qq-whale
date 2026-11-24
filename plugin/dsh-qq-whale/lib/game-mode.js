/**
 * 游戏模式总闸（2026-11-24）。
 *
 * 主人 m04935：「你游戏模式能不能做好了，为什么开了游戏模式实际上啥用没有」
 * 主人 m04942：「就不能把 SoVITS 这种占用大的绑在游戏模式吗」
 *
 * 以前的问题不是「没做」，是**做了一半而且互相不认**：
 *   - `/gamemode` 只翻两个内存开关（voiceEnabled / singingEnabled），DSH 一重启就没了；
 *   - 控制台和插件各写各的文件，插件重启后没人把状态推回来；
 *   - SoVITS（9GB 提交 + 显存）和嵌入 sidecar（4.8GB）根本不看游戏模式，
 *     打游戏时照旧占着，主人那边就直接闪退。
 *
 * 这个文件是**唯一真源 + 唯一收口**：
 *   1) `gameModeState()` 按 runtime → engine → 落盘文件 → 控制台 mem-config 依次找信号，
 *      3 秒缓存；所以 DSH 重启后不需要控制台补推也算数。
 *   2) `applyGameMode(on)` 一次把该关的关掉：运行时开关、watchdog 的语音保活、
 *      SoVITS 进程（走它自己的 /control?command=exit，管理员起的也能退）、嵌入 sidecar。
 *   3) `startGameModeSupervisor()` 每 5 秒对一次盘，状态一变就自己 apply ——
 *      控制台点了开关、或者手工改了文件，都算数，不依赖任何一次重启。
 */

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** `.../plugin/dsh-qq-whale/lib` → `${MOLLY_ROOT}\qq-whale` */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..')

export const GAME_MODE_FILE = 'game-mode.json'
export const SOVITS_PORT = 9880
export const EMBED_PORT = 8791
const CACHE_MS = 3000

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** 所有相关路径。config 只用来定位 dataDir，没有也能跑（退到仓库默认位置）。 */
export function gameModePaths(config = {}) {
  const dataDir = String(config?.dataDir || config?.memoryDir || '')
  const memConfigs = []
  if (process.env.MOLLY_OUT_DIR) memConfigs.push(path.join(process.env.MOLLY_OUT_DIR, 'mem-config.json'))
  memConfigs.push(path.join(REPO_ROOT, 'out', 'mem-config.json'))
  const base = {
    dataDir,
    stateFile: dataDir ? path.join(dataDir, GAME_MODE_FILE) : '',
    memConfigs,
    watchdogConfig: path.join(REPO_ROOT, 'watchdog-config.json'),
    sovitsScript: path.join(REPO_ROOT, 'tools', 'voice-sovits-start.ps1'),
  }
  // 测试用：config.gmPaths 可以整套替换（不碰真机的文件）
  const override = config?.gmPaths
  return override && typeof override === 'object' ? { ...base, ...override } : base
}

let _cache = { at: 0, on: false, source: 'default' }

/**
 * 现在到底算不算「游戏模式」。
 * 优先级：内存里的 runtime 开关（用户刚点的）→ engine.config → 落盘 game-mode.json →
 * 控制台 mem-config.json 的 gameMode → 缺省关。
 */
export function gameModeState({ config, engine, nowMs = Date.now(), fresh = false, ignoreRuntime = false } = {}) {
  if (!ignoreRuntime && config?.gameModeOn === true) return { on: true, source: 'runtime' }
  if (!ignoreRuntime && engine?.config?.gameModeOn === true) return { on: true, source: 'engine' }
  if (!fresh && nowMs - _cache.at < CACHE_MS) return { on: _cache.on, source: _cache.source, cached: true }

  const p = gameModePaths(config || engine?.config || {})
  const st = p.stateFile ? readJson(p.stateFile) : null
  if (st && typeof st.on === 'boolean') {
    _cache = { at: nowMs, on: st.on, source: 'state-file' }
    return { on: st.on, source: 'state-file' }
  }
  for (const file of p.memConfigs) {
    const j = readJson(file)
    if (j && typeof j.gameMode === 'boolean') {
      _cache = { at: nowMs, on: j.gameMode, source: 'mem-config' }
      return { on: j.gameMode, source: 'mem-config' }
    }
  }
  _cache = { at: nowMs, on: false, source: 'default' }
  return { on: false, source: 'default' }
}

/** 落盘（`/gamemode` 拨的时候调）。写失败不影响本次生效，返回 false 让调用方记日志。 */
export function persistGameMode(on, { config } = {}) {
  const p = gameModePaths(config)
  if (!p.stateFile) return false
  try {
    fs.mkdirSync(path.dirname(p.stateFile), { recursive: true })
    fs.writeFileSync(p.stateFile, JSON.stringify({ on: Boolean(on), at: Date.now() }), 'utf8')
    _cache = { at: Date.now(), on: Boolean(on), source: 'persist' }
    return true
  } catch {
    return false
  }
}

/**
 * watchdog 的语音保活开关（`watchdog-config.json` 的 `voiceKeepAlive`）。
 * 不关它，`ensureVoice()` 每分钟会把刚被我们关掉的 SoVITS 又拉起来 —— 11-24 实测过一次。
 */
export function setWatchdogVoiceKeepAlive(on, { config } = {}) {
  const p = gameModePaths(config)
  const cur = readJson(p.watchdogConfig)
  if (!cur || typeof cur !== 'object') return { ok: false, note: 'watchdog-config.json 读不到' }
  const want = Boolean(on)
  if (cur.voiceKeepAlive === want) return { ok: true, changed: false }
  try {
    fs.writeFileSync(p.watchdogConfig, JSON.stringify({ ...cur, voiceKeepAlive: want }, null, 2), 'utf8')
    return { ok: true, changed: true }
  } catch (err) {
    return { ok: false, note: String(err?.message || err).slice(0, 120) }
  }
}

/** 端口有没有人在听（用来确认服务真的退了，别只看进程名）。 */
export function portOpen(port, { timeoutMs = 800 } = {}) {
  return new Promise((resolve) => {
    const sock = net.connect({ port: Number(port), host: '127.0.0.1' })
    let done = false
    const finish = (v) => {
      if (done) return
      done = true
      try { sock.destroy() } catch {}
      resolve(v)
    }
    sock.setTimeout(timeoutMs, () => finish(false))
    sock.once('connect', () => finish(true))
    sock.once('error', () => finish(false))
  })
}

/** 按端口找进程并结束掉（同用户的进程才行；管理员进程会失败，属正常）。 */
export function killListeners(port) {
  const script = [
    `$c = Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue`,
    '$pids = @($c | Select-Object -ExpandProperty OwningProcess -Unique)',
    'foreach ($id in $pids) { try { Stop-Process -Id $id -Force -ErrorAction Stop } catch {} }',
    'Write-Output ($pids -join ",")',
  ].join('; ')
  try {
    const out = execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
    ], { encoding: 'utf8', timeout: 8000, windowsHide: true })
    return String(out || '').trim()
  } catch {
    return ''
  }
}

/**
 * 让 GPT-SoVITS 退。它常常是以管理员身份起的（11-24 实测 Stop-Process 被拒），
 * 但它自己带 `GET /control?command=exit`，优雅退出不需要权限。
 */
export async function stopSovits({ fetchImpl = fetch, waitMs = 8000 } = {}) {
  if (!(await portOpen(SOVITS_PORT))) return { ok: true, note: '本来就没在跑' }
  try {
    await fetchImpl(`http://127.0.0.1:${SOVITS_PORT}/control?command=exit`, { signal: AbortSignal.timeout(5000) })
  } catch {
    // 进程退出瞬间连接被断，属正常
  }
  const t0 = Date.now()
  while (Date.now() - t0 < waitMs) {
    if (!(await portOpen(SOVITS_PORT))) return { ok: true, note: '已优雅退出' }
    await sleep(250)
  }
  const killed = killListeners(SOVITS_PORT)
  await sleep(400)
  if (!(await portOpen(SOVITS_PORT))) return { ok: true, note: `已硬杀（pid ${killed || '?'}）` }
  return { ok: false, note: '还占着 9880（多半是管理员进程，得手工关）' }
}

/** 把 SoVITS 拉回来（关游戏模式时）。用法跟 watchdog 一模一样：cmd /c start，脱离本进程。 */
export function startSovits({ config } = {}) {
  const p = gameModePaths(config)
  if (!fs.existsSync(p.sovitsScript)) return { ok: false, note: '缺少 tools/voice-sovits-start.ps1' }
  try {
    execFileSync('C:\\Windows\\System32\\cmd.exe', [
      '/c', 'start', '""', '/b', 'powershell.exe',
      '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', p.sovitsScript,
    ], { cwd: REPO_ROOT, windowsHide: true, timeout: 15000, stdio: 'ignore' })
    return { ok: true, note: '已拉起（首次加载 20–40 秒）' }
  } catch (err) {
    return { ok: false, note: String(err?.message || err).slice(0, 120) }
  }
}

/** 嵌入 sidecar（4.8GB）。停掉之后检索退回纯关键词，等关游戏模式再由 sidecar.ensure() 拉起。 */
export async function stopEmbed({ waitMs = 5000 } = {}) {
  if (!(await portOpen(EMBED_PORT))) return { ok: true, note: '本来就没在跑' }
  const killed = killListeners(EMBED_PORT)
  const t0 = Date.now()
  while (Date.now() - t0 < waitMs) {
    if (!(await portOpen(EMBED_PORT))) return { ok: true, note: `已停（pid ${killed || '?'}）` }
    await sleep(250)
  }
  return { ok: false, note: '还占着 8791' }
}

/**
 * 一次把游戏模式拨到位。开着的时候顺带把重活收掉；
 * 关的时候把开关还原（按开启前记下的 backup，不硬把本来关着的东西打开）。
 */
export async function applyGameMode({ on, config, engine, logger = () => {}, quiet = false, deps = {} } = {}) {
  const cfg = config || engine?.config || {}
  const want = Boolean(on)
  const facts = { on: want, source: quiet ? 'restore' : 'switch', flags: {}, reclaimed: {} }

  if (want) {
    if (!cfg.__gmBackup) {
      cfg.__gmBackup = {
        voiceEnabled: cfg.voiceEnabled !== false,
        singingEnabled: cfg.singingEnabled !== false,
      }
    }
    cfg.voiceEnabled = false
    cfg.singingEnabled = false
    cfg.gameModeOn = true
    facts.flags = { voiceEnabled: false, singingEnabled: false, gameModeOn: true }

    facts.reclaimed.voiceKeepAlive = (deps.setWatchdogVoiceKeepAlive || setWatchdogVoiceKeepAlive)(false, { config: cfg })
    facts.reclaimed.sovits = await (deps.stopSovits || stopSovits)()
    facts.reclaimed.embed = await (deps.stopEmbed || stopEmbed)()
    if (!quiet) {
      logger('warn', `游戏模式 → 开：语音/点歌禁用，SoVITS ${facts.reclaimed.sovits?.note || '?'}，嵌入 ${facts.reclaimed.embed?.note || '?'}`)
    }
    return facts
  }

  const b = cfg.__gmBackup || {}
  cfg.voiceEnabled = b.voiceEnabled !== false
  cfg.singingEnabled = b.singingEnabled !== false
  cfg.gameModeOn = false
  cfg.__gmBackup = null
  facts.flags = { voiceEnabled: cfg.voiceEnabled, singingEnabled: cfg.singingEnabled, gameModeOn: false }

  facts.reclaimed.voiceKeepAlive = (deps.setWatchdogVoiceKeepAlive || setWatchdogVoiceKeepAlive)(true, { config: cfg })
  facts.reclaimed.sovits = (deps.startSovits || startSovits)({ config: cfg })
  if (!quiet) {
    logger('info', `游戏模式 → 关：语音/点歌恢复，SoVITS ${facts.reclaimed.sovits?.note || '?'}`)
  }
  return facts
}

/**
 * 看门狗循环：每 5 秒对一次盘。状态一变就 apply；
 * 插件刚起来时如果磁盘说「开着」，也立刻把重活收掉（这就是「重启后照样算数」）。
 */
export function startGameModeSupervisor({ config, engine, logger = () => {}, intervalMs = 5000, deps = {} } = {}) {
  let last = null
  /** 串行化：并发 tick 排队而不是被丢掉（丢掉会让「刚改的文件」漏一拍）。 */
  let chain = Promise.resolve()

  const runOnce = async () => {
    // 看门狗认「盘上的真话」：applyGameMode 自己会写 runtime 开关，
    // 不忽略它的话，外部改文件（或控制台改 mem-config）永远看不出来。
    const disk = gameModeState({ config, engine, fresh: true, ignoreRuntime: true })
    const st = disk.source === 'default'
      ? gameModeState({ config, engine, fresh: true })
      : disk
    if (last === null) {
      last = st.on
      if (st.on) await applyGameMode({ on: true, config, engine, logger, quiet: true, deps })
      return st
    }
    if (st.on !== last) {
      last = st.on
      await applyGameMode({ on: st.on, config, engine, logger, deps })
    }
    return st
  }

  const tick = () => {
    chain = chain.then(runOnce, runOnce)
    return chain
  }

  tick().catch(() => {})
  const timer = setInterval(() => { tick().catch(() => {}) }, intervalMs)
  if (timer.unref) timer.unref()
  return {
    tick,
    stop() {
      clearInterval(timer)
    },
  }
}
