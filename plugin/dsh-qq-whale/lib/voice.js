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
 *
 * 时长上限（2026-10-23，用户要求「接近 60 秒的语音」）：QQ 语音条硬上限 60 秒。
 * 文本侧由 engine 的 voiceMaxChars 把关（Dania 实测约 3.9 字/秒，220 字 ≈ 56 秒），
 * 这里再加一道**产物时长闸门** `maxSeconds`：从 wav 头算出真实时长，超限就返回
 * null 让调用方退回文字——不能把一条 60 秒以上的音频丢给 SnowLuma，上传失败
 * 会连整条回复一起吞掉。
 *
 * 2026-10-26（主人 m00855「和 Molly 现有的一样」）：补回**语速 / 句间静音**。
 * 配置里 voiceSpeed / voicePauseMs 从 v1.1.3-preview.1 起就传进来了，但本文件没接收，
 * speed_factor 一直写死 1.0、句间也没有额外停顿。现在：speed → speed_factor；
 * pauseMs > 0 且句子数 2..6 时逐句合成再拼 PCM（句间插静音），超过 6 句退回整段
 * 一次合成（只保语速），避免长回复多等十几秒。
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

/**
 * GPT-SoVITS 参考音频的固定参考文本。
 * 2026-10-24：音色换成「用户自己录的 54 句微调」出来的 molly_own 模型，
 * 参考音频同步换成用户本人那句（voice-ref\molly-ref.wav）。
 */
export const MOLLY_PROMPT_TEXT = '想的美，今天本鱼才是老大，你喝白开水去！'

/** 兼容旧名字：历史代码/测试里仍可能引用 DANIA_PROMPT_TEXT。 */
export const DANIA_PROMPT_TEXT = MOLLY_PROMPT_TEXT

/**
 * 逐句拼接时的句子上限。超过这个句数就退回「整段一次合成」（只保留语速，不插句间静音）：
 * 句间静音要逐句请求服务端，句数越多延迟越高，长回复不值得为了 50ms 停顿多等十几秒。
 */
const MAX_JOIN_SENTENCES = 6

/** 按句末标点切句（保留标点），过短的碎片并回前一句，避免「嗯。」单独成段反而更碎。 */
export function splitVoiceSentences(text) {
  const raw = String(text || '')
  const pieces = raw
    .split(/(?<=[。！？；…!?;])\s*/u)
    .map((s) => s.trim())
    .filter(Boolean)
  const out = []
  for (const p of pieces) {
    if (p.length < 2 && out.length) out[out.length - 1] += p
    else out.push(p)
  }
  return out
}

/** 读 wav 的 fmt 负载 + data 负载（单声道 16bit 足够，GPT-SoVITS 固定输出这种）。 */
function readWavChunks(buf) {
  if (!buf || buf.length < 44) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  let fmt = null
  let data = null
  for (let pos = 12; pos + 8 <= buf.length; ) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ') fmt = buf.subarray(pos + 8, pos + 8 + size)
    else if (id === 'data') {
      data = buf.subarray(pos + 8, pos + 8 + Math.min(size, buf.length - pos - 8))
      break
    }
    pos += 8 + size + (size & 1)
  }
  if (!fmt || !data) return null
  return { fmt, data, byteRate: fmt.readUInt32LE(8), blockAlign: fmt.readUInt16LE(12) }
}

/** 用同一份 fmt 拼出 wav（head 长度随 fmt 负载长度走，别写死 44）。 */
function buildWav(fmt, data) {
  const head = Buffer.alloc(20 + fmt.length + 8)
  head.write('RIFF', 0, 'ascii')
  head.writeUInt32LE(head.length - 8 + data.length, 4)
  head.write('WAVEfmt ', 8, 'ascii')
  head.writeUInt32LE(fmt.length, 16)
  fmt.copy(head, 20)
  head.write('data', 20 + fmt.length, 'ascii')
  head.writeUInt32LE(data.length, 20 + fmt.length + 4)
  return Buffer.concat([head, data])
}

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
    promptText = MOLLY_PROMPT_TEXT,
    promptLang = 'zh',
    fallbackEdge = true,
    pythonPath = '',
    voiceName = 'zh-CN-XiaoxiaoNeural',
    rate = '-5%',
    pitch = '+15Hz',
    timeoutMs = 20000,
    maxChars = 160,
    maxSeconds = 0,
    maxKeep = 200,
    // 2026-10-26（主人 m00855 拍板）：把「语速 / 句间静音」真正接上。
    // 之前 engine 一直在传 voiceSpeed / voicePauseMs，但这里没接收，speed_factor 永远 1.0。
    speed = 1.0,
    pauseMs = 0,
    logger = () => {},
  } = {}) {
    this.dir = dir
    this.backend = String(backend || 'sovits').toLowerCase() === 'edge' ? 'edge' : 'sovits'
    this.sovitsUrl = String(sovitsUrl || 'http://127.0.0.1:9880').replace(/\/+$/, '')
    this.refAudio = String(refAudio || '').trim()
    this.promptText = String(promptText || MOLLY_PROMPT_TEXT)
    this.promptLang = promptLang || 'zh'
    this.fallbackEdge = fallbackEdge !== false
    this.pythonPath = String(pythonPath || process.env.MOLLY_VOICE_PYTHON || '').trim()
    this.voiceName = voiceName
    this.rate = rate
    this.pitch = pitch
    this.timeoutMs = Number(timeoutMs) || 20000
    this.maxChars = Number(maxChars) || 160
    // 0 / 非正数 = 不限时长（老行为）；配了值就按秒卡（QQ 硬上限 60，默认配 58）。
    this.maxSeconds = Number(maxSeconds) || 0
    this.maxKeep = Number(maxKeep) || 200
    // speed：GPT-SoVITS 的 speed_factor（0.93 = 比模型默认慢 7%，1.0 = 原速）。
    // pauseMs：多句时逐句合成后插在句间的静音毫秒数（0 = 不插，退回整段一次合成）。
    this.speed = Number(speed) > 0 ? Number(speed) : 1.0
    this.pauseMs = Number(pauseMs) > 0 ? Number(pauseMs) : 0
    this.logger = logger
    this._python = ''
    this._ready = false
    // over：产物超时长的次数（不是失败，是主动放弃发语音）
    this.stats = { ok: 0, fail: 0, over: 0, cached: 0, lastMs: 0, lastError: '', lastBackend: '', lastParts: 0, lastSpeed: 0 }
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
      .update(`${useBackend}|${this.voiceName}|${this.rate}|${this.pitch}|${this.speed}|${this.pauseMs}|${clean}`)
      .digest('hex')
      .slice(0, 16)
    const file = path.join(this.dir, `${hash}.${ext}`)
    try {
      const st = await fsp.stat(file)
      if (st.size > 1000) {
        // 缓存命中也过时长闸门：配置调小 maxSeconds 之后，老缓存同样不能再发。
        const cachedSeconds = await this._durationGuard(file)
        if (cachedSeconds === -1) return null
        this.stats.cached++
        this.stats.lastBackend = useBackend
        this.stats.lastSpeed = this.speed
        return { file, bytes: st.size, ms: 0, cached: true, backend: useBackend, seconds: cachedSeconds }
      }
    } catch {
      /* 没缓存，继续合成 */
    }

    const startedAt = Date.now()
    let err = null
    if (useBackend === 'sovits') {
      err = await this._sovitsSynth(clean, file, { signal })
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
    // 时长闸门：超限就当没合成出来（engine 会原样发文字），别让 60+ 秒的音频去撞 QQ 上限。
    const seconds = await this._durationGuard(file)
    if (seconds === -1) return null
    this.stats.ok++
    this.stats.lastMs = Date.now() - startedAt
    this.stats.lastSpeed = this.speed
    this.stats.lastBackend = backend
    this.prune().catch(() => {})
    return { file, bytes, ms: this.stats.lastMs, cached: false, backend, seconds }
  }

  /**
   * 读音频时长（秒）：只解析 wav 的 RIFF 头（fmt 的 byteRate + data 大小）。
   * 不是 wav（比如 edge 退回的 mp3）或头不全时返回 null —— 调用方按「不限」处理。
   */
  async _probeSeconds(file) {
    let fh = null
    try {
      fh = await fsp.open(file, 'r')
      const buf = Buffer.alloc(4096)
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0)
      const b = buf.subarray(0, bytesRead)
      if (b.length < 44) return null
      if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null
      let byteRate = 0
      let dataSize = 0
      // 遍历 chunk：fmt 里取 byteRate（fmt 负载第 8 字节处），data 里取字节数。
      for (let pos = 12; pos + 8 <= b.length; ) {
        const id = b.toString('ascii', pos, pos + 4)
        const size = b.readUInt32LE(pos + 4)
        if (id === 'fmt ' && pos + 20 <= b.length) {
          byteRate = b.readUInt32LE(pos + 16)
        } else if (id === 'data') {
          dataSize = size
          break
        }
        pos += 8 + size + (size & 1)
      }
      if (!byteRate || !dataSize) return null
      return dataSize / byteRate
    } catch {
      return null
    } finally {
      await fh?.close().catch(() => {})
    }
  }

  /**
   * 时长闸门。返回：
   *   - 大于 0：时长（秒），放行；
   *   - null：读不出时长（mp3 / 头不全），按不限放行；
   *   - -1：超限，调用方必须退回文字。
   */
  async _durationGuard(file) {
    const cap = Number(this.maxSeconds) || 0
    if (cap <= 0) return null
    const seconds = await this._probeSeconds(file)
    if (seconds == null) return null
    if (seconds <= cap + 0.05) return seconds
    this.stats.over++
    this.logger('warn', `语音 ${seconds.toFixed(1)}s 超过上限 ${cap}s，这条改发文字`)
    return -1
  }

  /**
   * sovits 合成入口：单句 / 关静音 / 句数超限 → 整段一次合成；
   * 多句且 pauseMs > 0 → 逐句合成再按 PCM 拼接，句间插 pauseMs 静音。
   * 拼接用首句的 fmt（GPT-SoVITS 每次输出格式固定），静态清零即静音，不用额外库。
   */
  async _sovitsSynth(clean, file, { signal } = {}) {
    const sentences = this.pauseMs > 0 ? splitVoiceSentences(clean) : []
    if (sentences.length < 2 || sentences.length > MAX_JOIN_SENTENCES) {
      const err = await this._sovits(clean, file, { signal })
      // 没走拼接也记成 1 段：/state 和自测靠它区分「单段」与「压根没合成」。
      if (!err) this.stats.lastParts = 1
      return err
    }
    const tmpDir = await fsp.mkdtemp(path.join(this.dir, '.join-')).catch(() => null)
    if (!tmpDir) {
      const err = await this._sovits(clean, file, { signal })
      if (!err) this.stats.lastParts = 1
      return err
    }
    try {
      const parts = []
      for (const s of sentences) {
        if (signal?.aborted) return new Error('已中止')
        const part = path.join(tmpDir, `p${parts.length}.wav`)
        const err = await this._sovits(s, part, { signal })
        if (err) return err
        const chunks = readWavChunks(await fsp.readFile(part))
        if (!chunks) return new Error('拼接失败：子句不是可解析的 wav')
        parts.push(chunks)
      }
      const first = parts[0]
      const align = Math.max(2, first.blockAlign || 2)
      const silenceBytes = Math.max(align, Math.round((first.byteRate * this.pauseMs) / 1000 / align) * align)
      const silence = Buffer.alloc(silenceBytes)
      const datas = []
      parts.forEach((p, i) => {
        if (i > 0) datas.push(silence)
        datas.push(p.data)
      })
      await fsp.writeFile(file, buildWav(first.fmt, Buffer.concat(datas)))
      this.stats.lastParts = parts.length
      return null
    } catch (e) {
      return e instanceof Error ? e : new Error(String(e))
    } finally {
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }
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
      speed_factor: this.speed,
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
