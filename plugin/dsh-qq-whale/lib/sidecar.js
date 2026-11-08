/**
 * 本地嵌入/重排 sidecar 的客户端（2026-11-03）。
 *
 * 为什么单独一个文件、为什么是同步的：
 *   recall() 是同步的（engine-context → contextFor → recall 一路没有 await），
 *   而 HTTP 客户端只有异步的 fetch。所以这里用 `execFileSync` 调系统 curl，
 *   **阻塞但有时限**：嵌入 4s、重排 8s（2026-11-03 修：原来 2s/1.5s 太短，
 *   重排 40 条热态就要 0.8–0.9s、冷启 5s，客户端提前断开会每轮静默退回粗排）。
 *   超时直接抛，recall 里 catch 住退回关键词粗排。
 *   阻塞代价：一次召回最多多等 0.7–1.5 秒（40 条重排）。群里本来就要想几秒，可接受；
 *   真觉得慢就 `MOLLY_RERANK=0` 关掉，或把 RERANK_POOL 调小。
 *
 * sidecar 进程：检测不到 /health 就 detached 起一个（python + tools/embed-server.py），
 * 起不来也不影响插件——每次调用都会失败并静默退化，日志里只留一条 warn。
 *
 * 环境变量（都能覆盖，方便回滚/换模型）：
 *   MOLLY_EMBED_URL      默认 http://127.0.0.1:8791
 *   MOLLY_EMBED_PYTHON   默认 ${MOLLY_ROOT}\data\singing\venv312\Scripts\python.exe
 *   MOLLY_EMBED_SCRIPT   默认 <插件根>/../../tools/embed-server.py
 *   MOLLY_EMBED_MODELS   默认 ${MOLLY_ROOT}\models
 *   MOLLY_EMBED_OFF=1    整个功能关掉（连同 queryVector/重排）
 */
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DEFAULT_URL = 'http://127.0.0.1:8791'
const DEFAULT_PYTHON = 'G:\\Molly\\data\\singing\\venv312\\Scripts\\python.exe'
const DEFAULT_MODELS = 'G:\\Molly\\models'
// 2026-11-03：sidecar 的调用日志（JSONL）。主人说后期要接控制台，所以默认就落盘。
const DEFAULT_LOG = 'G:\\Molly\\data\\qq-whale\\embed-server.log.jsonl'

/** 同步小睡（ensure 在插件启动路径上，不能 await）。 */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
  } catch {
    /* 不支持就用忙等兜底 */
    const end = Date.now() + ms
    while (Date.now() < end) {}
  }
}

/**
 * 2026-11-03：优先用 pythonw.exe 起 sidecar。
 * python.exe 是控制台程序，即使 spawn 时给了 windowsHide，detached 起来也常会
 * 留下一个空的黑框（主人截图里那两个「${MOLLY_ROOT}\data\singing\venv31…」窗口就是它）。
 * pythonw.exe 没有控制台，天然不显示窗口。
 */
function preferWindowlessPython(p) {
  const w = String(p).replace(/python\.exe$/i, 'pythonw.exe')
  return w !== p && fs.existsSync(w) ? w : p
}

function curlJson(url, body, timeoutSec) {
  // body 写临时文件再传：40 条正文拼起来能到 12KB，直接上命令行会撞 Windows 参数长度上限
  const args = ['-sS', '--max-time', String(timeoutSec), '-H', 'content-type: application/json']
  let tmp = ''
  if (body) {
    tmp = path.join(os.tmpdir(), `molly-sidecar-${process.pid}-${Date.now()}.json`)
    fs.writeFileSync(tmp, JSON.stringify(body), 'utf8')
    args.push('--data-binary', `@${tmp}`)
  }
  args.push(url)
  try {
    const out = execFileSync('curl.exe', args, { encoding: 'utf8', timeout: timeoutSec * 1000 + 500, windowsHide: true })
    const trimmed = String(out || '').trim()
    if (!trimmed) throw new Error('empty response')
    return JSON.parse(trimmed)
  } finally {
    if (tmp) {
      try {
        fs.unlinkSync(tmp)
      } catch {
        /* 临时文件删不掉不影响结果 */
      }
    }
  }
}

export function createSidecar({ logger = () => {}, root = '' } = {}) {
  const off = process.env.MOLLY_EMBED_OFF === '1'
  const base = String(process.env.MOLLY_EMBED_URL || DEFAULT_URL).replace(/\/+$/, '')
  const python = String(process.env.MOLLY_EMBED_PYTHON || DEFAULT_PYTHON)
  const script = String(
    process.env.MOLLY_EMBED_SCRIPT || 'G:\\Molly\\qq-whale\\tools\\embed-server.py',
  )
  const models = String(process.env.MOLLY_EMBED_MODELS || DEFAULT_MODELS)
  const logFile = String(process.env.MOLLY_EMBED_LOG || DEFAULT_LOG)

  let lastSpawnAt = 0
  let healthy = false

  const health = () => {
    try {
      const j = curlJson(`${base}/health`, null, 1)
      healthy = Boolean(j && j.ok)
      return healthy
    } catch {
      healthy = false
      return false
    }
  }

  /**
   * 起 sidecar（只尝试一次）。detached + unref：插件退出不带着它死，
   * 它自己会因为空闲 30 分钟退出。
   */
  const ensure = () => {
    if (off) return false
    /*
     * 2026-11-08（线上实测）：原来的 `spawned` 是一次性开关，起过一次就再也不问服务端。
     * 可 sidecar 空闲 30 分钟会自己退出，于是插件活着的剩下时间里向量与重排全部
     * 静默退回关键词——日志里只有一条 boot、一条 stop，之后 recall 再无嵌入调用。
     * 现在每次都先问 /health，真不在才考虑拉起；中间留 60 秒冷却，避免崩塌式重拉。
     */
    if (health()) return true
    if (Date.now() - lastSpawnAt < 60_000) return false
    lastSpawnAt = Date.now()
    if (!fs.existsSync(python) || !fs.existsSync(script)) {
      logger('warn', `嵌入 sidecar 起不来：python=${python} script=${script}（退回纯关键词）`)
      return false
    }
    const exe = preferWindowlessPython(python)
    const args = [script, '--port', new URL(base).port || '8791', '--models', models]
    if (logFile) args.push('--log', logFile)
    try {
      const child = spawn(exe, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
        cwd: path.dirname(exe),
      })
      child.unref()
      /*
       * 2026-11-03：spawn 完等它真的应答再算数。
       * 不等的话，插件启停两次就会各 spawn 一个——服务端虽然加了端口守卫会自己退出，
       * 但那是「起两个、死一个」，不如这里就等它 ready，第二次直接看到 health 通过。
       */
      for (let i = 0; i < 10; i += 1) {
        sleepSync(700)
        if (health()) {
          logger('info', `已拉起嵌入 sidecar（${exe}，${base}，模型 ${models}）`)
          return true
        }
      }
      logger('warn', '嵌入 sidecar 已拉起但 7 秒内没应答（首次加载模型可能更慢，先按纯关键词跑）')
    } catch (err) {
      logger('warn', `拉起嵌入 sidecar 失败：${err?.message || err}（退回纯关键词）`)
    }
    return false
  }

  /**
   * 发请求 + 自愈：服务端可能刚因空闲退出，拉起来再试一次。
   * 只在真的失败时才动 ensure，正常路径零额外开销。
   */
  const callApi = (pathname, body, timeoutSec) => {
    try {
      return curlJson(`${base}${pathname}`, body, timeoutSec)
    } catch (err) {
      if (!ensure()) throw err
      return curlJson(`${base}${pathname}`, body, timeoutSec)
    }
  }

  /** 单条文本 → Float32Array（已归一化）；失败返回 null，不抛 */
  const embed = (text) => {
    if (off) return null
    try {
      const j = callApi('/embed', { texts: [String(text || '')], query: true }, 4)
      const v = j?.vectors?.[0]
      return Array.isArray(v) ? Float32Array.from(v) : null
    } catch (err) {
      logger('debug', `取向量失败（退回关键词）：${err?.message || err}`)
      return null
    }
  }

  /** query + 候选正文 → 分数数组；失败返回 null，不抛 */
  const rerank = (query, texts) => {
    if (off) return null
    try {
      const j = callApi('/rerank', { query: String(query || ''), texts }, 8)
      return Array.isArray(j?.scores) ? j.scores : null
    } catch (err) {
      logger('debug', `重排失败（退回粗排）：${err?.message || err}`)
      return null
    }
  }

  /** 条目向量批量写库用（离线工具/迁移）：不阻塞聊天，失败返回 null */
  const embedBatch = (texts) => {
    if (off) return null
    try {
      const j = callApi('/embed', { texts: texts.map((t) => String(t || '')), query: false }, 120)
      return Array.isArray(j?.vectors) ? j.vectors : null
    } catch {
      return null
    }
  }

  /**
   * 服务端统计快照（给控制台用）。
   * 控制台以后只要 `GET http://127.0.0.1:8791/stats` 就能拿到调用次数、平均/最慢耗时、
   * 最近 10 次调用和日志路径，不用去 tail 日志文件。失败返回 null，调用方自行兜底。
   */
  const stats = () => {
    try {
      return curlJson(`${base}/stats`, null, 2)
    } catch {
      return null
    }
  }

  return {
    off,
    base,
    embed,
    rerank,
    embedBatch,
    health,
    ensure,
    stats,
    logFile,
    get healthy() {
      return healthy
    },
  }
}
