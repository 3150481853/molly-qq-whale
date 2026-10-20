/**
 * 模块健康登记表（task-51，拆包前置）。
 *
 * 为什么需要：DSH 宿主对**插件加载失败是静默跳过的**（只写 logger.error，
 * 桌面版没有常规日志）。现在 Molly 是一个包，哪天拆成多个包，一个包没加载上
 * 的表现会是「部分功能悄悄消失」——路由 404、工具没了、定时器不跑，而且
 * 没有任何地方能看出「少了谁」。这个文件只做一件事：把「谁加载了、谁没加载、
 * 谁加载失败」记成一份可以 GET 出来的事实。
 *
 * 纪律：
 *   1. **只记事实，不做业务判断**。这里不猜「缺了它还能不能跑」，不决定降级。
 *   2. **snapshot() 绝不抛**。它是排查工具，自己崩了就没意义了。
 *   3. registry 是进程内的（模块级单例），重载插件会换一份新的。
 *      reloadAt 记录本进程这份 registry 的建立时间，用来分辨「旧快照」。
 */

/** 装配点会尝试加载的模块清单（expected 的唯一来源）。 */
export const MODULE_MANIFEST = Object.freeze([
  { name: 'onebot', required: true },
  { name: 'engine', required: true },
  { name: 'web', required: true },
  { name: 'qqtools', required: false },
  { name: 'workshop', required: false },
  { name: 'roles', required: false },
])

/** 进程内 registry（一份）。 */
const registry = {
  loaded: new Map(), // name -> { version, exports, optional, at }
  failed: new Map(), // name -> { error, at }
  reloadAt: Date.now(),
  build: null,
}

/** 让调用方可以覆盖 expected（比如测试里只期望两个模块）。 */
let expectedOverride = null

/** 装配点登记「这个模块 import 成功了」。 */
export function registerModule({ name, version = '', exports = [], optional = false } = {}) {
  if (!name) return false
  try {
    registry.loaded.set(String(name), {
      version: String(version || ''),
      exports: Array.isArray(exports) ? exports.slice(0, 64).map(String) : [],
      optional: Boolean(optional),
      at: Date.now(),
    })
    return true
  } catch {
    return false
  }
}

/** 装配点登记「这个模块 import 失败了」。 */
export function registerFailed({ name, error } = {}) {
  if (!name) return false
  try {
    registry.failed.set(String(name), {
      error: String(error == null ? 'unknown error' : error),
      at: Date.now(),
    })
    return true
  } catch {
    return false
  }
}

/** 覆盖期望清单（不给就用 MODULE_MANIFEST）。测试用。 */
export function setExpected(list) {
  if (Array.isArray(list)) expectedOverride = list.map(String)
  return expected()
}

function expected() {
  if (expectedOverride) return expectedOverride.slice()
  return MODULE_MANIFEST.map((m) => m.name)
}

/**
 * 当前健康快照。
 *
 * 形状（字段名固定，控制台/告警都按这个读）：
 *   { expected: string[], loaded: string[], missing: string[],
 *     failed: [{name, error}], reloadAt: number, build: string|null }
 *
 * missing = expected - loaded（**失败也算 missing**：没加载上就是缺）。
 */
export function snapshot() {
  try {
    const exp = expected()
    const loaded = [...registry.loaded.keys()]
    const loadedSet = new Set(loaded)
    const failed = [...registry.failed.entries()].map(([name, v]) => ({
      name,
      error: v.error,
    }))
    return {
      expected: exp,
      loaded,
      missing: exp.filter((n) => !loadedSet.has(n)),
      failed,
      reloadAt: registry.reloadAt,
      build: registry.build,
    }
  } catch {
    // 排查工具自己不许抛
    return { expected: [], loaded: [], missing: [], failed: [], reloadAt: 0, build: null }
  }
}

/** 重置 registry（只给测试用；正常装配不需要）。 */
export function _resetForTest() {
  registry.loaded.clear()
  registry.failed.clear()
  registry.reloadAt = Date.now()
  expectedOverride = null
}

/** 设置 build 标记（可选：发布/部署时写入，方便分辨是哪一版）。 */
export function setBuild(build) {
  registry.build = build == null ? null : String(build)
}

/**
 * 缺失告警文案：**只在真缺东西时**返回非空字符串。
 * 正常启动一句都不发（用户明确要求「正常启动别来烦我」）。
 */
export function gapAlertText(snap) {
  const s = snap && typeof snap === 'object' ? snap : snapshot()
  const missing = Array.isArray(s.missing) ? s.missing : []
  const failed = Array.isArray(s.failed) ? s.failed : []
  if (missing.length === 0 && failed.length === 0) return ''
  const names = [...new Set([...missing, ...failed.map((f) => f?.name).filter(Boolean)])]
  if (names.length === 0) return ''
  return `这次加载少了 ${names.length} 个模块：${names.join('、')}。功能可能不完整，我把状态挂在控制台 /state.plugins 里了。`
}

/**
 * 发缺失告警（一次）。
 *
 * @param {object} p
 * @param {(msg: string) => Promise<unknown>} p.send 发送函数（私聊 owner）
 * @param {object} [p.snapshot] 不传就现取
 * @param {(level: string, msg: string) => void} [p.logger]
 * @returns {Promise<boolean>} 是否真的发了
 */
export async function notifyGaps({ send, snapshot: snap, logger } = {}) {
  const text = gapAlertText(snap || snapshot())
  if (!text) return false
  if (typeof send !== 'function') return false
  try {
    await send(text)
    logger?.('warn', `[module-health] ${text}`)
    return true
  } catch (err) {
    logger?.('warn', `[module-health] 缺失告警发送失败：${err?.message || err}`)
    return false
  }
}

export default {
  MODULE_MANIFEST,
  registerModule,
  registerFailed,
  snapshot,
  setExpected,
  setBuild,
  gapAlertText,
  notifyGaps,
}
