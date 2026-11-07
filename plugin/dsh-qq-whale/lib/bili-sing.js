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

import { spawn } from 'node:child_process'
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

export class BiliSinger {
  /**
   * @param {object} opts
   * @param {string} opts.python  venv312 的 python.exe
   * @param {string} opts.script  bili_sing.py 绝对路径
   * @param {string} [opts.cacheDir]
   * @param {number} [opts.maxSec]  只做多久（秒），0 = 整首
   * @param {number} [opts.timeoutMs]
   * @param {Function} [opts.logger]
   */
  constructor({ python, script, cacheDir, maxSec = 75, timeoutMs = 600000, logger } = {}) {
    this.python = python || ''
    this.script = script || ''
    this.maxSec = Number(maxSec) || 0
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

    const job = this._run({ query: q, bv, shift })
      .then((res) => {
        if (res.ok) this._writeCache(key, res)
        return res
      })
      .finally(() => this.inflight.delete(key))
    this.inflight.set(key, job)
    return job
  }

  _run({ query, bv, shift }) {
    return new Promise((resolve) => {
      const args = ['-u', this.script]
      if (bv) args.push('--bv', bv)
      else args.push('--search', query)
      if (this.maxSec > 0) args.push('--max-sec', String(Math.round(this.maxSec)))
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
        const tail = (err || out).trim().split(/\r?\n/).slice(-6).join(' | ')
        finish({ ok: false, error: parsed?.error || `退出码 ${code}：${tail || '没有输出'}` })
      })
    })
  }
}
