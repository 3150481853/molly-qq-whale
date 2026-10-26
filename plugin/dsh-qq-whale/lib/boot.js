/**
 * dsh-qq-whale —— 薄壳入口。请尽量别改这个文件，实现都在 lib/*.js。
 *
 * ⚠️ 为什么需要这一层
 * ---------------------------------------------------------------------------
 * DSH 宿主用 @deepseek-ai/cordis-plugin-loader 加载插件，它的 `import(name)`
 * 在桌面端会走宿主自己的 `loader.internal.import(name, baseUrl)`（见
 * `cordis-plugin-loader/lib/index.js:218`）。这个内部加载器认的是**模块标识**，
 * 不会因为 URL 上多一个 `?rev=` 就当成新模块。实测：把 rev 挂在 query 上，
 * 宿主仍然复用第一次求值的旧实例 —— 改代码必须重启 DSH，而重启会连带掉线
 * （QQ 注入进程、网页会话全要重来，一次好几分钟）。
 *
 * 唯一可靠的办法是让**路径**变。所以每次 apply 都把 lib 下的实现文件复制到
 * 一个新目录 `<包根>/gen-<rev>/`，再从那里 import main.js：
 *
 *   - 路径不同 ⇒ 不可能命中任何按路径/标识做的缓存；
 *   - 目录放在包根下（不是 lib 下）⇒ main.js / web.js 里的
 *     `dirname(import.meta.url) + '..'` 仍然指向包根，`persona/`、`assets/`
 *     的相对解析全都还对；
 *   - 相对 import（./engine.js 等）在 gen-<rev>/ 内部自洽，整棵依赖树一起换新。
 *
 * 代价是每次重载多一份约 250KB 的副本，旧的会自动清掉（保留最近几代）。
 * 等你不再改代码时，它就是个无感的多余复制。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-qq-whale'

const LIB_DIR = path.dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = path.resolve(LIB_DIR, '..')

/** 每一代生成目录的前缀，清理时按这个匹配。 */
const GEN_PREFIX = 'gen-'
/** 保留几代，够热重载用就行，别把磁盘堆满。 */
const KEEP_GENERATIONS = 3
/** 不需要进副本的文件（薄壳自己）。 */
const SKIP_FILES = new Set(['boot.js'])

/**
 * 把实现文件复制到新一代目录。
 *
 * 任何一步失败都要让 apply 抛出来 —— 静默失败会让插件「看起来加载了但什么
 * 都没干」，那是最难查的一种状态（这个坑真踩过，见 persona.js 里那段注释）。
 */
function materialize(rev) {
  const genDir = path.join(PKG_ROOT, `${GEN_PREFIX}${rev}`)
  fs.mkdirSync(genDir, { recursive: true })

  for (const file of fs.readdirSync(LIB_DIR)) {
    if (!file.endsWith('.js')) continue
    if (SKIP_FILES.has(file)) continue
    fs.copyFileSync(path.join(LIB_DIR, file), path.join(genDir, file))
  }

  // 清理旧代：按修改时间倒序，留下最近几代。
  try {
    const gens = fs
      .readdirSync(PKG_ROOT)
      .filter((n) => n.startsWith(GEN_PREFIX))
      .map((n) => ({ n, t: fs.statSync(path.join(PKG_ROOT, n)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
    for (const g of gens.slice(KEEP_GENERATIONS)) {
      fs.rmSync(path.join(PKG_ROOT, g.n), { recursive: true, force: true })
    }
  } catch {
    // 清理失败不影响本次加载
  }

  return genDir
}

/** 落盘失败时退回的数据目录（部署到别的机器用 MOLLY_DATA_DIR / config.dataDir 覆盖）。 */
const BOOT_HEALTH_FALLBACK_DIR = 'G:\\Molly\\data\\qq-whale'

/**
 * boot-health.json 的路径（task-51 追加）。
 *
 * 为什么落盘：main.js 挂了的时候 web.js 也不在，`/state` 根本打不开，
 * `root.set('qqWhaleHealth')` 又只在进程内存里——桌面版还没有常规日志，
 * 「为什么这次启动是半死」就没有任何证据。写到磁盘上，看门狗/计划任务/人
 * 都能直接读。
 *
 * 覆盖顺序：环境变量 `MOLLY_BOOT_HEALTH`（整路径） > `config.dataDir` >
 * `MOLLY_DATA_DIR` > 默认数据目录。**不许硬编码 C 盘**。
 */
export function bootHealthPath(rawConfig = {}) {
  const envFile = String(process.env.MOLLY_BOOT_HEALTH || '').trim()
  if (envFile) return envFile
  const dataDir =
    String(rawConfig?.dataDir || process.env.MOLLY_DATA_DIR || '').trim() || BOOT_HEALTH_FALLBACK_DIR
  return path.join(dataDir, 'boot-health.json')
}

/**
 * 写一次启动健康记录（tmp + rename 原子替换，UTF-8 无 BOM）。
 *
 * 永不抛：写盘失败只 warn——自检文件不该影响启动。
 * fsImpl 可注入，测试用它模拟「写盘直接抛错」。
 */
export function writeBootHealth(payload = {}, { fsImpl = fs, logger } = {}) {
  const file = String(payload.file || '').trim()
  if (!file) return false
  const record = {
    at: new Date().toISOString(),
    ok: Boolean(payload.ok),
    reason: String(payload.reason || ''),
    gen: String(payload.gen || ''),
  }
  if (payload.error) record.error = String(payload.error)
  const body = JSON.stringify(record, null, 2)
  const tmp = `${file}.tmp-${process.pid}`
  try {
    fsImpl.mkdirSync(path.dirname(file), { recursive: true })
    fsImpl.writeFileSync(tmp, body, { encoding: 'utf8' })
    fsImpl.renameSync(tmp, file)
    return true
  } catch (err) {
    try {
      fsImpl.unlinkSync(tmp)
    } catch {}
    logger?.('warn', `boot-health.json 写盘失败（不影响启动）：${err?.message || err}`)
    return false
  }
}

/** boot 阶段的日志：优先宿主 logger，退回 console。 */
function bootLog(root, level, msg) {
  try {
    const lg = root?.logger?.('qq-whale')
    if (lg && typeof lg[level] === 'function') return lg[level](msg)
    if (typeof lg === 'function') return lg(level, msg)
  } catch {}
  const fn = level === 'error' ? console.error : console.warn
  try {
    fn?.(`[qq-whale] ${msg}`)
  } catch {}
}

export async function apply(root, rawConfig = {}) {
  const rev = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

  let genDir
  try {
    genDir = materialize(rev)
  } catch (err) {
    throw new Error(`dsh-qq-whale: 生成实现副本失败（rev=${rev}）：${err?.stack || err}`)
  }

  const entry = path.join(genDir, 'main.js')
  const url = new URL(`file://${entry.replace(/\\/g, '/')}`).href

  let mod
  try {
    mod = await import(url)
  } catch (err) {
    /*
     * task-51：装配点容错。
     *
     * 这里是「实现层整体加载失败」——一个模块的错误都不许让宿主把整个插件
     * 静默跳过。做法：把失败登记进这一代的 module-health（materialize 已经
     * 把 module-health.js 一起复制过来了），写死一条错误日志，然后把状态挂到
     * root 上供同进程排查，**不再往外抛**（抛了宿主会记 fiber._error，
     * 但整个插件也不激活，连 /state 都看不到）。
     *
     * 代价要说清：main.js 挂了的话，插件会「挂载但什么也不做」。这仍然比
     * 「静默跳过 + 没有任何登记」可查——root.get('qqWhaleHealth') 能看到
     * failed 里的完整堆栈。要拆分阶段真正的固定做法是把 main 的装配拆成
     * 多个独立模块，届时这里只剩下薄薄一层。
     */
    let health = null
    try {
      health = await import(new URL(`file://${path.join(genDir, 'module-health.js').replace(/\\/g, '/')}`).href)
    } catch {
      health = null
    }
    try {
      health?.registerFailed?.({ name: 'main', error: String(err?.stack || err) })
      const snap = health?.snapshot?.() || { expected: ['main'], loaded: [], missing: ['main'], failed: [{ name: 'main', error: String(err?.stack || err) }], reloadAt: Date.now(), build: null }
      root?.set?.('qqWhaleHealth', snap)
      root?.logger?.('qq-whale')?.error?.(`dsh-qq-whale 实现层加载失败（${url}）：${err?.stack || err}`)
    } catch {}
    // 落盘：web.js 都没加载上时 /state 打不开，磁盘上的这份就是唯一证据
    writeBootHealth(
      {
        file: bootHealthPath(rawConfig),
        ok: false,
        reason: 'main-load-failed',
        error: String(err?.stack || err),
        gen: path.basename(genDir),
      },
      { logger: (level, msg) => bootLog(root, level, msg) },
    )
    console.error(`[qq-whale] 实现层加载失败（${url}），已登记到 /state.plugins 并继续挂载`, err?.message || err)
    return { degraded: true, reason: 'main-load-failed' }
  }

  if (typeof mod.apply !== 'function') {
    throw new Error('dsh-qq-whale: main.js 没有导出 apply')
  }

  // 不返回 state：cordis 会把 apply 的返回值当 effect 校验，普通对象会触发
  // `Invalid effect`。state 已经通过 root.set('qqWhale', state) 暴露出去了。
  await mod.apply(root, rawConfig)

  // 成功启动也写一次：把上次的失败记录覆盖掉，否则磁盘上永远是脏状态
  writeBootHealth(
    { file: bootHealthPath(rawConfig), ok: true, reason: '', gen: path.basename(genDir) },
    { logger: (level, msg) => bootLog(root, level, msg) },
  )
}

export default { name, apply }
