'use strict'

/**
 * 唱歌（B 站点歌版，2026-10-31）。
 *
 * 主人 m01736：「有人让你唱歌就去 b 站扒音乐视频的音轨来练，发语音之前要发一句
 * 参考哪个 up 主哪个视频哪个 BV 号唱的歌」。
 *
 * 老路子（lib/singing.js）是逐字 TTS 再把每个字搬到谱面音高，音色撑不住唱歌，
 * 2026-10-25 已下架。新路子是「扒一段真的演唱 → 换成 Molly 的嗓子」：
 *
 *   1. B 站搜歌 / 直接给 BV 号，取 DASH 音轨（免登录最高 30280 / 203kbps）
 *   2. pymss 把人声和伴奏分开
 *   3. 量源人声音高，决定升/降几个半音（对齐到 Molly 的中位音域）
 *   4. RVC（molly4_e200）只换音色，音高/节奏/咬字/时间轴全继承源音频
 *   5. 归一化到 -1 dBFS，可选叠回伴奏
 *
 * 具体算法在 `${MOLLY_ROOT}\data\singing\src\bili_sing.py`，这里只负责起进程、解析
 * JSON、缓存结果。一首歌（默认只做 75 秒）大约 70~90 秒，所以超时给得很宽。
 */

import { execFileSync, spawn } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export function lastJsonLine(text) {
  const lines = String(text || '').trim().split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim()
    if (!line.startsWith('{') || !line.endsWith('}')) continue
    try {
      const obj = JSON.parse(line)
      if (obj && typeof obj === 'object' && 'ok' in obj) return obj
    } catch {
      // 不是 JSON 就继续往上找
    }
  }
  return null
}

/**
 * 这次的失败像不像「内存不够」？
 *
 * 主人 m03582 报的现场：群里收到「没弄成（退出码 1： x, _ = self.attention(q, k, v,
 * mask=attn_mask) | ^^^^^^^^^^^^^^^^），换一首吧。」—— 那是 torch 在注意力层分配
 * 张量时提交内存不足崩掉，把 traceback 残句直接甩给主人看，既不像话也浪费时间。
 * 同一时刻 Everything 报 `mem_virtual_alloc(): error: 1455`（页面文件不够），
 * 说明是整机提交内存见底，不是歌的问题。这种失败砍短时长重跑一次往往就过了。
 */
export function isMemoryish(text) {
  const s = String(text || '')
  return /DefaultCPUAllocator|out of memory|not enough memory|can't allocate|cannot allocate|MemoryError|bad allocation|OutOfMemory|error: 1455|页面文件/i.test(s)
}

/**
 * 现在还剩多少「提交内存」（MB）？
 *
 * 主人 m03208 同意：开唱之前先看一眼，低于阈值就直接用短时长，别等它崩了再重跑。
 * 走 `FreeVirtualMemory`（= 提交上限 − 已提交），这才是 pymss 要不到内存的真实原因；
 * `os.freemem()` 只是物理空闲，页面文件够大时它俩能差一大截，不能替代。
 *
 * 一次 PowerShell 约 0.6~1.5 秒，换来少跑一轮三五分钟的渲染，值。结果缓存 10 秒，
 * 同一个人的连点不会反复起进程。拿不到就返回 null（当作不知道，不拦）。
 */
let _commitCache = { at: 0, mb: null }

export function freeCommitMB({ fresh = false } = {}) {
  if (process.platform !== 'win32') return null
  const now = Date.now()
  if (!fresh && now - _commitCache.at < 10000) return _commitCache.mb
  let mb = null
  try {
    const out = execFileSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      '[math]::Round((Get-CimInstance Win32_OperatingSystem).FreeVirtualMemory / 1024)',
    ], { timeout: 5000, encoding: 'utf8', windowsHide: true })
    const n = Number(String(out).trim())
    if (Number.isFinite(n) && n >= 0) mb = n
  } catch {
    mb = null
  }
  _commitCache = { at: now, mb }
  return mb
}

export class BiliSinger {
  /**
   * @param {object} opts
   * @param {string} opts.python  venv312 的 python.exe
   * @param {string} opts.script  bili_sing.py 绝对路径
   * @param {string} [opts.cacheDir]
   * @param {number} [opts.maxSec]  只做多久（秒），0 = 整首
   * @param {number} [opts.memoryGuardMB] 提交内存低于多少 MB 就先砍短（默认 3000，0 = 关闭）
   * @param {Function} [opts.probe]  测提交内存的函数（测试时可注入）
   * @param {number} [opts.timeoutMs]
   * @param {Function} [opts.logger]
   */
  constructor({ python, script, cacheDir, maxSec = 75, memoryGuardMB = 3000, probe, timeoutMs = 600000, logger } = {}) {
    this.python = python || ''
    this.script = script || ''
    this.maxSec = Number(maxSec) || 0
    this.memoryGuardMB = Number(memoryGuardMB) || 0
    this.probe = typeof probe === 'function' ? probe : freeCommitMB
    this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : 600000
    this.logger = typeof logger === 'function' ? logger : () => {}
    this.cacheDir = cacheDir || ''
    this.inflight = new Map()
  }

  /** 有没有配好（python 和脚本都在）。 */
  get enabled() {
    if (!this.python || !this.script) return false
    try {
      return fs.existsSync(this.python) && fs.existsSync(this.script)
    } catch {
      return false
    }
  }

  _cachePath(query) {
    if (!this.cacheDir) return ''
    /*
     * 2026-10-31：缓存键里带上 bili_sing.py 的 mtime。
     * 以前只有 v5|query|maxSec —— 我改了 python 的选歌逻辑，旧缓存照样命中，
     * 主人点《山楂树之恋》又收到同一首日文歌（还得手动去删 json）。
     * 现在改脚本就自动失效；v6 是手动清过一次的那版。
     */
    let stamp = 0
    try {
      stamp = Math.floor(fs.statSync(this.script).mtimeMs)
    } catch {
      stamp = 0
    }
    const h = crypto.createHash('sha1').update(`v6|${query}|${this.maxSec}|${stamp}`).digest('hex').slice(0, 16)
    return path.join(this.cacheDir, `bili-${h}.json`)
  }

  _readCache(query) {
    const p = this._cachePath(query)
    if (!p) return null
    try {
      const obj = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (obj && obj.ok && obj.file && fs.existsSync(obj.file)) return obj
    } catch {
      // 没缓存/坏了都当没有
    }
    return null
  }

  _writeCache(query, obj) {
    const p = this._cachePath(query)
    if (!p) return
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, JSON.stringify(obj), 'utf8')
    } catch (err) {
      this.logger('warn', `唱歌缓存写不进去：${err?.message || err}`)
    }
  }

  /**
   * 点一首。query 可以是歌名（走搜索），也可以是 BV 号。
   * @returns {Promise<{ok:boolean, file?:string, creditLine?:string, seconds?:number, bvid?:string, cached?:boolean, error?:string}>}
   */
  async sing(query, { bv = '', shift = '' } = {}) {
    const q = String(query || '').trim()
    if (!q && !bv) return { ok: false, error: '没给歌名' }
    if (!this.enabled) return { ok: false, error: '扒音轨的 python 或脚本没配好' }

    const key = bv || q
    const cacheHit = this._readCache(key)
    if (cacheHit) {
      this.logger('info', `唱歌命中缓存：${key}`)
      return { ...cacheHit, cached: true }
    }
    const running = this.inflight.get(key)
    if (running) return running

    // 开唱前先看提交内存（主人 m03208 批的）：不够就这次直接用短时长，别等崩了再重跑
    const pre = this._precheckMaxSec()

    const job = this._singWithFallback({ query: q, bv, shift, maxSec: pre.maxSec })
      .then((res) => {
        if (res.ok && !pre.shortened) this._writeCache(key, res)
        if (pre.shortened && res.ok) return { ...res, preShortened: pre.maxSec, freeCommitMB: pre.freeMB }
        return res
      })
      .finally(() => this.inflight.delete(key))
    this.inflight.set(key, job)
    return job
  }

  /**
   * 提交内存够不够？够就照常，不够就把这一轮的时长压到 45 秒以内。
   * 探针失败（拿不到数字）时一律照常跑 —— 宁可按原时长试一次，也不要凭猜测砍歌。
   * @returns {{maxSec:number, freeMB:number|null, shortened:boolean}}
   */
  _precheckMaxSec() {
    const maxSec = this.maxSec
    if (!(this.memoryGuardMB > 0)) return { maxSec, freeMB: null, shortened: false }
    let free = null
    try {
      free = this.probe()
    } catch {
      free = null
    }
    if (free == null || !Number.isFinite(Number(free))) return { maxSec, freeMB: null, shortened: false }
    const freeMB = Math.round(Number(free))
    if (freeMB >= this.memoryGuardMB) return { maxSec, freeMB, shortened: false }
    const short = Math.round(Math.min(45, maxSec > 0 ? maxSec : 45))
    this.logger('warn', `唱歌：提交内存只剩 ${freeMB}MB（低于 ${this.memoryGuardMB}MB），这次只唱 ${short} 秒`)
    return { maxSec: short, freeMB, shortened: true }
  }

  /**
   * 跑一次；如果是内存不够崩的，砍短时长再来一次（m03582）。
   * 主人等一次三五分钟已经够久了，所以只重试一次，且只在原时长够长时才有意义。
   */
  async _singWithFallback({ query, bv, shift, maxSec }) {
    const first = maxSec == null ? this.maxSec : Number(maxSec) || 0
    const res = await this._run({ query, bv, shift, maxSec: first })
    if (res.ok || !res.memoryHint || !(first > 50)) return res
    const shorter = Math.max(20, Math.min(45, Math.round(first / 2)))
    this.logger('warn', `唱歌：内存不够，改成 ${shorter} 秒重跑一次（原来是 ${Math.round(first)} 秒）`)
    const again = await this._run({ query, bv, shift, maxSec: shorter })
    if (again.ok) return { ...again, shortened: shorter }
    return { ...again, error: again.error || res.error }
  }

  _run({ query, bv, shift, maxSec }) {
    return new Promise((resolve) => {
      const args = ['-u', this.script]
      if (bv) args.push('--bv', bv)
      else args.push('--search', query)
      const secs = maxSec == null ? this.maxSec : Number(maxSec) || 0
      if (secs > 0) args.push('--max-sec', String(Math.round(secs)))
      args.push('--mix')
      if (shift !== '' && shift != null) args.push('--shift', String(shift))

      this.logger('info', `唱歌：跑 ${path.basename(this.python)} ${args.slice(1).join(' ')}`)
      let out = ''
      let err = ''
      let done = false
      const child = spawn(this.python, args, {
        cwd: path.dirname(this.script),
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      })

      const finish = (res) => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(res)
      }

      const timer = setTimeout(() => {
        this.logger('warn', `唱歌超时（${this.timeoutMs}ms），杀掉进程`)
        try { child.kill('SIGKILL') } catch { /* ignore */ }
        finish({ ok: false, error: `渲染超时（${Math.round(this.timeoutMs / 1000)}s）` })
      }, this.timeoutMs)

      child.stdout.on('data', (b) => { out += b.toString('utf8') })
      child.stderr.on('data', (b) => { err += b.toString('utf8') })
      child.on('error', (e) => finish({ ok: false, error: `起进程失败：${e.message}` }))
      child.on('close', (code) => {
        const parsed = lastJsonLine(out)
        if (parsed && parsed.ok && parsed.molly_vocal) {
          finish({
            ok: true,
            file: parsed.molly_vocal,
            mix: parsed.mix || '',
            creditLine: parsed.credit_line || '',
            seconds: Number(parsed.seconds) || 0,
            bvid: parsed.bvid || bv || '',
            title: parsed.title || '',
            author: parsed.author || '',
            pitchShift: Number(parsed.pitch_shift) || 0,
            card: parsed.card || '',
          })
          return
        }
        // 一首歌有好几个歌手的版本：python 退出码 3 + need_artist 让我先问主人要谁的版本
        if (parsed && parsed.need_artist) {
          finish({
            ok: false,
            needArtist: true,
            keyword: parsed.keyword || query,
            artist: parsed.artist || '',
            options: Array.isArray(parsed.options) ? parsed.options : [],
            error: parsed.error || '这首歌有好几个版本，要谁的？',
          })
          return
        }
        // 两边都有货、平台没指定：python 以退出码 3 + need_platform 让我先问主人去哪边
        if (parsed && parsed.need_platform) {
          finish({
            ok: false,
            needPlatform: true,
            kind: parsed.kind || 'platform',
            keyword: parsed.keyword || query,
            artist: parsed.artist || '',
            netease: parsed.netease || null,
            bili: parsed.bili || null,
            options: Array.isArray(parsed.options) ? parsed.options : [],
            error: parsed.error || '要去网易云还是 B 站？',
          })
          return
        }
        // 没有原唱版本：python 以退出码 3 + need_choice 告诉我「去问主人要哪个」
        if (parsed && parsed.need_choice) {
          finish({
            ok: false,
            needChoice: true,
            keyword: parsed.keyword || query,
            options: Array.isArray(parsed.options) ? parsed.options : [],
            error: parsed.error || '没有找到原唱版本',
          })
          return
        }
        // 失败时说人话：traceback 只写日志，群里别看到「^^^^」这种东西（m03582）
        const raw = `${err}\n${out}`
        if (isMemoryish(raw)) {
          this.logger('warn', `唱歌：内存不够崩了（退出码 ${code}），尾段：${raw.trim().split(/\r?\n/).slice(-4).join(' | ')}`)
          finish({ ok: false, memoryHint: true, error: '内存不够，渲染崩了' })
          return
        }
        const tail = (err || out).trim().split(/\r?\n/).filter((l) => {
          const t = l.trim()
          return t && !/^\^+$/.test(t)
        }).slice(-3).join(' | ')
        this.logger('warn', `唱歌：退出码 ${code}，尾段：${tail || '没有输出'}`)
        finish({ ok: false, error: parsed?.error || `渲染时出错了（退出码 ${code}）` })
      })
    })
  }
}
