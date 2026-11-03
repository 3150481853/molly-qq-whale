/**
 * 本地嵌入/重排 sidecar 的客户端（2026-11-03）。
 *
 * 为什么单独一个文件、为什么是同步的：
 *   recall() 是同步的（engine-context → contextFor → recall 一路没有 await），
 *   而 HTTP 客户端只有异步的 fetch。所以这里用 `execFileSync` 调系统 curl，
 *   **阻塞但有时限**：嵌入 2s、重排 1.5s，超时直接抛，recall 里 catch 住退回关键词粗排。
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

  let spawned = false
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
    if (off || spawned) return
    spawned = true
    if (health()) {
      logger('info', `嵌入 sidecar 已在运行（${base}）`)
      return
    }
    if (!fs.existsSync(python) || !fs.existsSync(script)) {
      logger('warn', `嵌入 sidecar 起不来：python=${python} script=${script}（退回纯关键词）`)
      return
    }
    const args = [script, '--port', new URL(base).port || '8791', '--models', models]
    try {
      const child = spawn(python, args, { detached: true, stdio: 'ignore', windowsHide: true })
      child.unref()
      logger('info', `已拉起嵌入 sidecar（${base}，模型目录 ${models}），首次调用可能要等几秒加载`)
    } catch (err) {
      logger('warn', `拉起嵌入 sidecar 失败：${err?.message || err}（退回纯关键词）`)
    }
  }

  /** 单条文本 → Float32Array（已归一化）；失败返回 null，不抛 */
  const embed = (text) => {
    if (off) return null
    try {
      const j = curlJson(`${base}/embed`, { texts: [String(text || '')], query: true }, 4)
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
      const j = curlJson(`${base}/rerank`, { query: String(query || ''), texts }, 8)
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
      const j = curlJson(`${base}/embed`, { texts: texts.map((t) => String(t || '')), query: false }, 120)
      return Array.isArray(j?.vectors) ? j.vectors : null
    } catch {
      return null
    }
  }

  return { off, base, embed, rerank, embedBatch, health, ensure, get healthy() { return healthy } }
}
