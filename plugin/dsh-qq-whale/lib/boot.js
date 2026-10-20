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
    // 必须显式抛：宿主会把 apply 抛出的错误记进 fiber._error。
    // 模块级错误只会静默跳过，排查起来极其痛苦。
    throw new Error(`dsh-qq-whale: 加载实现层失败（${url}）：${err?.stack || err}`)
  }

  if (typeof mod.apply !== 'function') {
    throw new Error('dsh-qq-whale: main.js 没有导出 apply')
  }

  // 不返回 state：cordis 会把 apply 的返回值当 effect 校验，普通对象会触发
  // `Invalid effect`。state 已经通过 root.set('qqWhale', state) 暴露出去了。
  await mod.apply(root, rawConfig)
}

export default { name, apply }
