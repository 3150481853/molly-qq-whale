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
/** `.../plugin/dsh-qq-whale/lib` → `${MOLLY_ROOT}\qq-whale`（**只在源码树里成立**，见 findRepoRoot） */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..')

const isRepoRoot = (dir) => {
  try {
    return Boolean(dir) && fs.existsSync(path.join(dir, 'tools')) && fs.existsSync(path.join(dir, 'plugin'))
  } catch {
    return false
  }
}

/**
 * 真正的仓库根目录。
 *
 * 2026-11-24 踩过：插件装到 `${HOME}\.dsh\profiles\desktop\node_modules\dsh-qq-whale\lib` 之后，
 * `path.resolve(HERE,'..','..','..')` 是 `node_modules`，于是 `watchdog-config.json` 和
 * `tools\voice-sovits-start.ps1` 全都「读不到 / 缺少」——开关拨了却什么也没发生。
 *
 * 所以按顺序找：env `MOLLY_REPO_ROOT` → `config.gmRepoRoot` / `config.repoRoot` → 源码树的
 * `HERE/../../..` → 从 dataDir 逐级往上（每一级试它自己和它的 `qq-whale` 子目录）。
 * 判据：这个目录里同时有 `tools/` 与 `plugin/`。
 */
export function findRepoRoot(config = {}) {
  const cands = []
  const push = (d) => { if (d && !cands.includes(d)) cands.push(d) }
  push(process.env.MOLLY_REPO_ROOT)
  push(config?.gmRepoRoot)
  push(config?.repoRoot)
  // dataDir 是「真机上的地址」，比源码树相对路径更可信，所以排在它前面
  const dataDir = String(config?.dataDir || config?.memoryDir || '')
  if (dataDir) {
    let cur = path.resolve(dataDir)
    for (let i = 0; i < 5; i++) {
      push(path.join(cur, 'qq-whale'))
      push(cur)
      const up = path.dirname(cur)
      if (up === cur) break
      cur = up
    }
  }
  push(REPO_ROOT)
  for (const c of cands) if (isRepoRoot(c)) return c
  return REPO_ROOT
}

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

/**
 * 所有相关路径。config 只用来定位 dataDir / 仓库根，没有也能跑（退到源码树位置）。
 * `config.gmPaths` 可整套覆盖（测试用；进程内也一样能覆盖）。
 */
export function gameModePaths(config = {}) {
  const dataDir = String(config?.dataDir || config?.memoryDir || '')
  const root = findRepoRoot(config)
  const memConfigs = []
  if (process.env.MOLLY_OUT_DIR) memConfigs.push(path.join(process.env.MOLLY_OUT_DIR, 'mem-config.json'))
  memConfigs.push(path.join(root, 'out', 'mem-config.json'))
  const base = {
    dataDir,
    root,
    stateFile: dataDir ? path.join(dataDir, GAME_MODE_FILE) : '',
    memConfigs,
    watchdogConfig: path.join(root, 'watchdog-config.json'),
    sovitsScript: path.join(root, 'tools', 'voice-sovits-start.ps1'),
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

/** 上次「拉起 SoVITS」的时刻。用于「刚点开又点关」时别急着判「本来就没在跑」。 */
let lastStartAt = 0
const START_GRACE_MS = 90_000

/**
 * 让 GPT-SoVITS 退。它常常是以管理员身份起的（11-24 实测 Stop-Process 被拒），
 * 但它自己带 `GET /control?command=exit`，优雅退出不需要权限。
 *
 * 2026-11-24（主人 m05133「如果我快速连续开关会不会出问题」）：
 * `startSovits` 只是把脚本 detach 出去，**9880 要 20–40 秒后才监听**。如果紧接着点「关」，
 * 旧代码看到端口没开就回「本来就没在跑」直接走人 —— 于是 SoVITS 过一会儿自己就起来了，
 * 开关却显示「开」。所以刚拉起来过就先等它监听（最多 `startGraceMs`），再发 exit。
 */
export async function stopSovits({ fetchImpl = fetch, waitMs = 8000, startGraceMs = 20000, portOpenImpl = portOpen, nowFn = Date.now, startedAt = lastStartAt } = {}) {
  if (!(await portOpenImpl(SOVITS_PORT))) {
    const sinceStart = nowFn() - startedAt
    if (!startedAt || sinceStart >= START_GRACE_MS) return { ok: true, note: '本来就没在跑' }
    const t = nowFn()
    let up = false
    while (nowFn() - t < startGraceMs) {
      await sleep(250)
      if (await portOpenImpl(SOVITS_PORT)) { up = true; break }
    }
    if (!up) return { ok: true, note: '刚拉起来的那个没等到，先当它没在跑' }
  }
  try {
    await fetchImpl(`http://127.0.0.1:${SOVITS_PORT}/control?command=exit`, { signal: AbortSignal.timeout(5000) })
  } catch {
    // 进程退出瞬间连接被断，属正常
  }
  const t0 = Date.now()
  while (Date.now() - t0 < waitMs) {
    if (!(await portOpenImpl(SOVITS_PORT))) return { ok: true, note: '已优雅退出' }
    await sleep(250)
  }
  const killed = killListeners(SOVITS_PORT)
  await sleep(400)
  if (!(await portOpenImpl(SOVITS_PORT))) return { ok: true, note: `已硬杀（pid ${killed || '?'}）` }
  return { ok: false, note: '还占着 9880（多半是管理员进程，得手工关）' }
}

/** 把 SoVITS 拉回来（关游戏模式时）。用法跟 watchdog 一模一样：cmd /c start，脱离本进程。 */
export function startSovits({ config } = {}) {
  const p = gameModePaths(config)
  if (!fs.existsSync(p.sovitsScript)) return { ok: false, note: '缺少 tools/voice-sovits-start.ps1（' + p.sovitsScript + '）' }
  try {
    execFileSync('C:\\Windows\\System32\\cmd.exe', [
      '/c', 'start', '""', '/b', 'powershell.exe',
      '-NoProfile', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', p.sovitsScript,
    ], { cwd: p.root, windowsHide: true, timeout: 15000, stdio: 'ignore' })
    lastStartAt = Date.now()
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
 * 一次把游戏模式拨到位 —— **串行 + 后来居上**。
 *
 * 2026-11-24（主人 m05133「如果我快速连续开关会不会出问题」）：
 * 原来并发进来两个 POST 就会同时跑 applyGameMode，`__gmBackup` 互相覆盖、
 * 「停 SoVITS」和「起 SoVITS」互相插队，最后可能变成「开关显示开着但 SoVITS 还在吃 9GB」，
 * 或者「开关关了、语音保活却被写成 false，语音再也回不来」。
 *
 * 现在所有拨动走一条队列；排队期间又有新请求时，旧的那次直接标记 `superseded` 并让位 ——
 * 最终落地的永远是**最后一次**的意图，中间那几下不会真的去启停进程。
 */
let _seq = 0
let _latestSeq = 0
let _applyChain = Promise.resolve()

export function applyGameMode(opts = {}) {
  const seq = ++_seq
  _latestSeq = seq
  const run = async () => {
    if (_latestSeq !== seq) {
      const st = gameModeState({ config: opts.config, engine: opts.engine, fresh: true })
      return { on: st.on, superseded: true, flags: {}, reclaimed: {}, note: '被后来的拨动顶掉了，这一轮不折腾进程' }
    }
    return runApplyGameMode(opts)
  }
  _applyChain = _applyChain.then(run, run)
  return _applyChain
}
async function runApplyGameMode({ on, config, engine, logger = () => {}, quiet = false, deps = {} } = {}) {
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
