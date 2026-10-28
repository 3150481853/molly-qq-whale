/**
 * 茉莉花（Jasmine）记忆系统 · Molly 侧桥接
 *
 * 为什么要有这一层，而不是在 engine.js 里直接 `import '../../../jasmine/index.mjs'`：
 *   1. 插件在宿主里是以「单文件包」被加载的，仓库相对路径不一定成立
 *      （dev 目录 / publish 目录 / 别人 fork 后的目录层级都可能不同），
 *      所以候选路径要按优先级挨个试，全失败就**安静地降级**，不能拖垮引擎。
 *   2. 茉莉花是独立分支维护的组件，Molly 只是它的第一个宿主。
 *      接缝留在这里，以后移植到别的架构时，别人改这一个文件就够了。
 *   3. 加载是异步的（ESM 动态 import），引擎的发送路径是同步的：
 *      首次预热一次，之后就是同步读缓存；首轮没热上就跳过核对，不影响发消息。
 */

import path from 'node:path'
import fs from 'node:fs'

/**
 * 候选路径（相对本文件 lib/ 目录）：
 *   ../jasmine             → 插件包内自带一份（发布 zip 里的兜底）
 *   ../../jasmine          → plugin/jasmine
 *   ../../../jasmine       → 仓库根 jasmine（dev 与 publish 的正常位置）
 */
const CANDIDATES = ['../jasmine/index.mjs', '../../jasmine/index.mjs', '../../../jasmine/index.mjs']

let cachedMod = null
let loadPromise = null
let loadError = ''

/** 预热：返回 Promise<模块|null>，失败也只记一次日志，不抛。 */
export function preloadJasmine(logger) {
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    for (const rel of CANDIDATES) {
      const url = new URL(rel, import.meta.url)
      try {
        const mod = await import(url.href)
        if (mod && typeof mod.verifyReply === 'function') {
          cachedMod = mod
          logger?.('info', `茉莉花记忆系统已加载：${rel}`)
          return mod
        }
      } catch (err) {
        loadError = String(err?.message || err)
      }
    }
    logger?.('debug', `茉莉花记忆系统未加载（可选组件）：${loadError || '未找到 index.mjs'}`)
    return null
  })()
  return loadPromise
}

/** 同步取已预热的模块；没热上返回 null。 */
export function jasmine() {
  return cachedMod
}

/** 本进程里能用的溯源信息（给控制台/状态页用）。 */
export function jasmineLoaderStatus() {
  return { loaded: Boolean(cachedMod), error: loadError, candidates: CANDIDATES }
}

/**
 * 出口核对：把 verifyReply 包成「永远不抛」的形状。
 * 只做记录，不拦发送——拦不拦由调用方决定（P0-1 先只记 trace）。
 *
 * @param {object} mod loadJasmine 返回的模块
 * @param {object} input 见 verifyReply 签名
 * @returns {{ok:boolean,constraint:string,issues:any[],scores:any}|null}
 */
export function verifyOutgoing(mod, input) {
  if (!mod || typeof mod.verifyReply !== 'function') return null
  try {
    return mod.verifyReply(input)
  } catch {
    return null
  }
}

/**
 * 往 trace 文件追加一行。超过 5MB 轮转一次（只留上一份），避免无限长。
 * @param {string} dir out/jasmine 之类的目录
 */
export function appendTrace(dir, record) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'trace.jsonl')
    let size = 0
    try {
      size = fs.statSync(file).size
    } catch {
      size = 0
    }
    if (size > 5 * 1024 * 1024) {
      try {
        fs.renameSync(file, path.join(dir, 'trace.1.jsonl'))
      } catch {
        /* 轮转失败就接着追加，别因为日志丢了影响主流程 */
      }
    }
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/** 茉莉花自己的小状态文件（周信上次写到哪周之类），坏了就当空。 */
export function readState(dir) {
  try {
    const file = path.join(dir, 'state.json')
    const raw = fs.readFileSync(file, 'utf8')
    const obj = JSON.parse(raw)
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {}
  }
}

/** 合并写回状态文件（tmp + rename，永不抛）。 */
export function writeState(dir, patch = {}) {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'state.json')
    const next = { ...readState(dir), ...patch }
    const tmp = `${file}.tmp-${process.pid}`
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
    fs.renameSync(tmp, file)
    return next
  } catch {
    return null
  }
}
