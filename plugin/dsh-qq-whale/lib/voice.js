/**
 * 语音合成（TTS）—— 2026-10-22，用户拍板（m04855）。
 *
 * 为什么是这么个方案：
 * - 用户要 Molly「时不时发一句语音代替说话」。音色是他一对一听样本选的：
 *   晓晓（zh-CN-XiaoxiaoNeural）+ rate -5% + pitch +15Hz（试听编号 I）。
 * - 转码不用我们管：SnowLuma 的 record codec 拿到本地路径后会自己用内置
 *   native ffmpeg 转 NT silk 再上传（2026-10-22 已真机发通一条 5 秒语音）。
 *   所以这里只负责「文字 → mp3 文件」。
 * - TTS 用 edge-tts（pip --user 已装，python 3.10），它走微软在线接口，
 *   比 Windows SAPI 的 Huihui 自然得多；离线不可用时整体降级成纯文字。
 *
 * 失败策略：任何一步出错都返回 null。语音属于加分项，不能因为它把整条
 * 回复吞掉——调用方（engine.deliver）拿到 null 会原样发文字。
 */
import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'

/** 本机已知的 python 位置，按顺序探测；都找不到就用 PATH 里的 python。 */
const PY_CANDIDATES = [
  'D:\\Python3.10\\Python\\Python310\\python.exe',
  'D:\\Python3.10\\Python\\python.exe',
]

/** 语音文本清洗：去掉 CQ 码、尖括号标签、表情符号、多余空白。 */
export function cleanVoiceText(text) {
  let s = String(text || '')
  s = s.replace(/\[CQ:[^\]]*\]/g, ' ')
  s = s.replace(/<[^>\n]{1,20}>/g, ' ')
  s = s.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
  s = s.replace(/[「」“”"'‘’]/g, '')
  s = s.replace(/[*_`~]+/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

export class VoiceMaker {
  constructor({
    dir,
    pythonPath = '',
    voiceName = 'zh-CN-XiaoxiaoNeural',
    rate = '-5%',
    pitch = '+15Hz',
    timeoutMs = 12000,
    maxChars = 160,
    maxKeep = 200,
    logger = () => {},
  } = {}) {
    this.dir = dir
    this.pythonPath = String(pythonPath || process.env.MOLLY_VOICE_PYTHON || '').trim()
    this.voiceName = voiceName
    this.rate = rate
    this.pitch = pitch
    this.timeoutMs = Number(timeoutMs) || 12000
    this.maxChars = Number(maxChars) || 160
    this.maxKeep = Number(maxKeep) || 200
    this.logger = logger
    this._python = ''
    this._ready = false
    this.stats = { ok: 0, fail: 0, cached: 0, lastMs: 0, lastError: '' }
  }

  /** 探测 python：优先配置值，其次本机候选路径，最后 PATH 里的 python。 */
  findPython() {
    if (this._python) return this._python
    const list = []
    if (this.pythonPath) list.push(this.pythonPath)
    for (const p of PY_CANDIDATES) list.push(p)
    list.push('python')
    for (const p of list) {
      if (p !== 'python') {
        try {
          if (!fs.existsSync(p)) continue
        } catch {
          continue
        }
      }
      this._python = p
      return p
    }
    return 'python'
  }

  async ensureDir() {
    if (this._ready) return
    await fsp.mkdir(this.dir, { recursive: true }).catch(() => {})
    this._ready = true
  }

  /** 合成一句语音；返回 `{file, bytes, ms, cached}` 或 null（失败/文本不可用）。 */
  async synthesize(text, { signal } = {}) {
    const clean = cleanVoiceText(text).slice(0, this.maxChars)
    if (clean.length < 2) return null
    if (signal?.aborted) return null
    await this.ensureDir()
    const hash = crypto
      .createHash('sha1')
      .update(`${this.voiceName}|${this.rate}|${this.pitch}|${clean}`)
      .digest('hex')
      .slice(0, 16)
    const file = path.join(this.dir, `${hash}.mp3`)
    try {
      const st = await fsp.stat(file)
      if (st.size > 1000) {
        this.stats.cached++
        return { file, bytes: st.size, ms: 0, cached: true }
      }
    } catch {
      /* 没缓存，继续合成 */
    }
    const python = this.findPython()
    const startedAt = Date.now()
    const args = [
      '-m',
      'edge_tts',
      '--voice',
      this.voiceName,
      // 注意：rate/pitch 的值以 '-'/'+' 开头（如 -5% / +15Hz），
      // 用空格分隔时 argparse 会把它当成选项名，所以必须写成 --rate=-5%。
      // 2026-10-22 首测就是卡在这里（exit=2，无 mp3 产出）。
      `--rate=${this.rate}`,
      `--pitch=${this.pitch}`,
      `--text=${clean}`,
      '--write-media',
      file,
    ]
    const run = () =>
      new Promise((resolve) => {
        execFile(
          python,
          args,
          { timeout: this.timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
          (err) => resolve(err || null),
        )
      })
    let err = await run()
    if (err && python !== 'python') {
      // 配置的 python 不行时退回 PATH 里的 python，给部署环境留一条活路
      this.logger('warn', `语音合成失败（${python}）：${String(err.message || err).slice(0, 160)}，改用 python`)
      const err2 = await new Promise((resolve) => {
        execFile('python', args, { timeout: this.timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (e) => resolve(e || null))
      })
      if (!err2) err = null
    }
    const ms = Date.now() - startedAt
    this.stats.lastMs = ms
    if (err) {
      this.stats.fail++
      this.stats.lastError = String(err.message || err).slice(0, 200)
      this.logger('warn', `语音合成失败：${this.stats.lastError}`)
      return null
    }
    let bytes = 0
    try {
      const st = await fsp.stat(file)
      bytes = st.size
    } catch {
      bytes = 0
    }
    if (bytes < 1000) {
      this.stats.fail++
      this.stats.lastError = `产物过小 ${bytes}B`
      this.logger('warn', `语音合成产物异常（${bytes}B），丢弃`)
      return null
    }
    this.stats.ok++
    this.prune().catch(() => {})
    return { file, bytes, ms, cached: false }
  }

  /** 缓存只留最近 maxKeep 个文件，避免无限膨胀。 */
  async prune() {
    try {
      const names = await fsp.readdir(this.dir)
      const files = []
      for (const n of names) {
        if (!n.endsWith('.mp3')) continue
        const full = path.join(this.dir, n)
        try {
          const st = await fsp.stat(full)
          files.push({ full, at: st.mtimeMs })
        } catch {
          /* ignore */
        }
      }
      if (files.length <= this.maxKeep) return
      files.sort((a, b) => a.at - b.at)
      for (const f of files.slice(0, files.length - this.maxKeep)) {
        await fsp.unlink(f.full).catch(() => {})
      }
    } catch {
      /* ignore */
    }
  }
}
