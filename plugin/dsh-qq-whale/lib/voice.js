/**
 * 语音合成（TTS）—— 2026-10-22，用户拍板（m04697 / m04855 / m05352）。
 *
 * 方案演进：
 * - 第一版用 edge-tts（晓晓 + rate -5% + pitch +15Hz），试听由用户选定；
 * - 2026-10-22 22:5x 用户听完社区音色「Dania」后拍板：**改用社区模型**，
 *   即本机 GPT-SoVITS v2ProPlus + `villia/dania` 权重（ModelScope）。
 *   语音条件也按用户新要求改：**取消冷却**；**23:50–09:00 不提供语音**
 *   （静默时段判断在 engine.maybeVoice，这里只管「文字 → 音频文件」）。
 *
 * 转码不用我们管：SnowLuma 的 record codec 拿到本地路径后会自己用内置
 * native ffmpeg 转 NT silk 再上传（2026-10-22 已真机发通多条语音）。
 * 所以这里只负责产出 wav（sovits）或 mp3（edge）。
 *
 * 失败策略：任何一步出错都返回 null。语音属于加分项，不能因为它把整条
 * 回复吞掉——调用方（engine.deliver）拿到 null 会原样发文字。
 * backend='sovits' 时若本机服务不可用，会自动退回 edge-tts（可关）。
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

/** GPT-SoVITS 参考音频的固定参考文本（Dania 模型 readme.txt 指定）。 */
export const DANIA_PROMPT_TEXT = '怎么啊？如果有你在也不放心，那就干脆给我也装个限制器或者炸弹喽。'

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
    backend = 'sovits',
    sovitsUrl = 'http://127.0.0.1:9880',
    refAudio = '',
    promptText = DANIA_PROMPT_TEXT,
    promptLang = 'zh',
    fallbackEdge = true,
    pythonPath = '',
    voiceName = 'zh-CN-XiaoxiaoNeural',
    rate = '-5%',
    pitch = '+15Hz',
    timeoutMs = 20000,
    maxChars = 160,
    maxKeep = 200,
    logger = () => {},
  } = {}) {
    this.dir = dir
    this.backend = String(backend || 'sovits').toLowerCase() === 'edge' ? 'edge' : 'sovits'
    this.sovitsUrl = String(sovitsUrl || 'http://127.0.0.1:9880').replace(/\/+$/, '')
    this.refAudio = String(refAudio || '').trim()
    this.promptText = String(promptText || DANIA_PROMPT_TEXT)
    this.promptLang = promptLang || 'zh'
    this.fallbackEdge = fallbackEdge !== false
    this.pythonPath = String(pythonPath || process.env.MOLLY_VOICE_PYTHON || '').trim()
    this.voiceName = voiceName
    this.rate = rate
    this.pitch = pitch
    this.timeoutMs = Number(timeoutMs) || 20000
    this.maxChars = Number(maxChars) || 160
    this.maxKeep = Number(maxKeep) || 200
    this.logger = logger
    this._python = ''
    this._ready = false
    this.stats = { ok: 0, fail: 0, cached: 0, lastMs: 0, lastError: '', lastBackend: '' }
  }

  /** 探测 python（edge-tts 兜底时用）：优先配置值，其次本机候选路径，最后 PATH。 */
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

  /** 合成一句语音；返回 `{file, bytes, ms, cached, backend}` 或 null（失败/文本不可用）。 */
  async synthesize(text, { signal } = {}) {
    const clean = cleanVoiceText(text).slice(0, this.maxChars)
    if (clean.length < 2) return null
    if (signal?.aborted) return null
    await this.ensureDir()
    const useBackend = this.backend
    const ext = useBackend === 'sovits' ? 'wav' : 'mp3'
    const hash = crypto
      .createHash('sha1')
      .update(`${useBackend}|${this.voiceName}|${this.rate}|${this.pitch}|${clean}`)
      .digest('hex')
      .slice(0, 16)
    const file = path.join(this.dir, `${hash}.${ext}`)
    try {
      const st = await fsp.stat(file)
      if (st.size > 1000) {
        this.stats.cached++
        this.stats.lastBackend = useBackend
        return { file, bytes: st.size, ms: 0, cached: true, backend: useBackend }
      }
    } catch {
      /* 没缓存，继续合成 */
    }

    const startedAt = Date.now()
    let err = null
    if (useBackend === 'sovits') {
      err = await this._sovits(clean, file, { signal })
      if (err && this.fallbackEdge) {
        this.logger('warn', `Dania 语音合成失败（${String(err.message || err).slice(0, 120)}），改用 edge-tts`)
        const edgeFile = path.join(this.dir, `${hash}.mp3`)
        const edgeErr = await this._edge(clean, edgeFile)
        if (!edgeErr) return this._finish(edgeFile, startedAt, 'edge')
        err = edgeErr
      }
    } else {
      err = await this._edge(clean, file)
    }
    const ms = Date.now() - startedAt
    this.stats.lastMs = ms
    if (err) {
      this.stats.fail++
      this.stats.lastError = String(err.message || err).slice(0, 200)
      this.logger('warn', `语音合成失败：${this.stats.lastError}`)
      return null
    }
    return this._finish(file, startedAt, useBackend)
  }

  /** 收尾：校验产物、更新统计、清理旧缓存。 */
  async _finish(file, startedAt, backend) {
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
    this.stats.lastMs = Date.now() - startedAt
    this.stats.lastBackend = backend
    this.prune().catch(() => {})
    return { file, bytes, ms: this.stats.lastMs, cached: false, backend }
  }

  /** GPT-SoVITS 本地 HTTP（api_v2.py）：文字 → wav。返回 Error 或 null。 */
  async _sovits(clean, file, { signal } = {}) {
    if (!this.refAudio) return new Error('未配置参考音频 refAudio')
    const body = {
      text: clean,
      text_lang: this.promptLang || 'zh',
      ref_audio_path: this.refAudio,
      prompt_text: this.promptText,
      prompt_lang: this.promptLang || 'zh',
      text_split_method: 'cut5',
      batch_size: 1,
      speed_factor: 1.0,
      media_type: 'wav',
      streaming_mode: false,
    }
    try {
      const url = `${this.sovitsUrl}/tts`
      const timeout = AbortSignal.timeout(this.timeoutMs)
      const merged = signal ? AbortSignal.any([signal, timeout]) : timeout
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        signal: merged,
      })
      if (!resp.ok) return new Error(`HTTP ${resp.status} ${(await resp.text().catch(() => '')).slice(0, 120)}`)
      const buf = Buffer.from(await resp.arrayBuffer())
      if (buf.length < 1000) return new Error(`响应过小 ${buf.length}B`)
      await fsp.writeFile(file, buf)
      return null
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    }
  }

  /** edge-tts：文字 → mp3。返回 Error 或 null。 */
  async _edge(clean, file) {
    const python = this.findPython()
    const args = [
      '-m',
      'edge_tts',
      '--voice',
      this.voiceName,
      // rate/pitch 的值以 '-'/'+' 开头（如 -5% / +15Hz），空格分隔会被 argparse
      // 当成选项名，所以必须写成 --rate=-5%（2026-10-22 首测栽过）。
      `--rate=${this.rate}`,
      `--pitch=${this.pitch}`,
      `--text=${clean}`,
      '--write-media',
      file,
    ]
    const run = (exe) =>
      new Promise((resolve) => {
        execFile(
          exe,
          args,
          { timeout: this.timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
          (err) => resolve(err || null),
        )
      })
    let err = await run(python)
    if (err && python !== 'python') {
      const err2 = await run('python')
      if (!err2) err = null
    }
    return err
  }

  /** 缓存只留最近 maxKeep 个文件，避免无限膨胀（同时清 mp3/wav）。 */
  async prune() {
    try {
      const names = await fsp.readdir(this.dir)
      const files = []
      for (const n of names) {
        if (!n.endsWith('.mp3') && !n.endsWith('.wav')) continue
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
