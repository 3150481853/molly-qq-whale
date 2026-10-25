/*
 * 本地语音识别（fallback，2026-10-25 主人 m04404 选「本地 ASR 兜底」）
 *
 * 为什么需要它：
 *   QQ 服务端的 pttTrans 只在**私聊**稳定返回结果；群聊里别人发的语音，
 *   `fetch_ptt_text` 20 秒超时（SnowLuma 回 retcode 100），我们只能降级成
 *   「[语音：没听清]」。群里一句「行行行，说就一句，别催了」她就听不懂。
 *
 * 方案（零新依赖）：
 *   - 音频转码用 SnowLuma 自带的 `get_record {file, out_format:'wav'}`（它自己
 *     就是 ffmpeg addon，本机没有 ffmpeg 也能拿到 24k/16bit/mono 的 wav）。
 *   - 识别用本机 Python venv 里**已经装好**的 faster-whisper（
 *     `${MOLLY_ROOT}\data\video\venv`，模型缓存在 `${MOLLY_ROOT}\data\video\models`），
 *     不下载新模型、不引入 npm 依赖。
 *   - Python 进程常驻（模型只加载一次 ~1.5s），空闲 10 分钟自动退出；
 *     识别失败/超时永远只返回空串，调用方保持「[语音：没听清]」降级。
 *
 * 实测（32 核 CPU，small/int8/8 线程）：
 *   2.3 s 语音 ≈ 1.6 s 出字；2.6 s 语音 ≈ 1.65 s。私聊真机样本转写正确。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import crypto from 'node:crypto'

/** 默认配置（会被 main.js 的 DEFAULTS 与 yml 覆盖）。 */
export const ASR_DEFAULTS = {
  enabled: true,
  python: 'G:\\Molly\\data\\video\\venv\\Scripts\\python.exe',
  modelDir: 'G:\\Molly\\data\\video\\models',
  model: 'small',
  threads: 8,
  timeoutMs: 20000,
  idleSeconds: 600,
  maxSeconds: 15,
  maxBytes: 8 * 1024 * 1024,
}

/** get_record 的硬超时（转码也要几秒）。 */
export const RECORD_TIMEOUT_MS = 12000

/**
 * 常驻 Python worker。
 *
 * 注意：这里必须是「同步消费 generator」——faster-whisper 的 transcribe()
 * 返回的是生成器，真正的解码发生在取文本时。2026-10-25 写这个文件时踩过：
 * 只计时 transcribe() 会得到 0.01 s 的假数据。
 */
const WORKER_SOURCE = String.raw`
# -*- coding: utf-8 -*-
# Molly 本地语音识别 worker（由 lib/local-asr.js 生成，勿手改）
import json
import sys
import wave

import numpy as np

def log(msg):
    sys.stderr.write(str(msg) + "\n")
    sys.stderr.flush()

def main():
    cfg = json.loads(sys.argv[1])
    from faster_whisper import WhisperModel

    try:
        model = WhisperModel(
            cfg["model"],
            device="cpu",
            compute_type="int8",
            download_root=cfg["model_dir"],
            local_files_only=True,
            cpu_threads=int(cfg["threads"]),
        )
    except Exception as err:  # 模型目录不对 / venv 不完整
        log("load failed: %s" % err)
        print(json.dumps({"ready": False, "error": str(err)}), flush=True)
        return

    print(json.dumps({"ready": True}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue
        rid = req.get("id")
        wav = req.get("wav") or ""
        try:
            with wave.open(wav, "rb") as fh:
                sr = fh.getframerate()
                ch = fh.getnchannels()
                width = fh.getsampwidth()
                raw = fh.readframes(fh.getnframes())
            if width != 2:
                raise ValueError("unsupported sample width %d" % width)
            audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
            if ch > 1:
                audio = audio.reshape(-1, ch).mean(axis=1)
            segs, _info = model.transcribe(
                audio,
                language="zh",
                vad_filter=False,
                beam_size=5,
                condition_on_previous_text=False,
            )
            text = "".join(s.text for s in segs).strip()
            print(json.dumps({"id": rid, "ok": True, "text": text}, ensure_ascii=False), flush=True)
        except Exception as err:
            print(json.dumps({"id": rid, "ok": False, "error": str(err)}, ensure_ascii=False), flush=True)

if __name__ == "__main__":
    main()
`

/** 读 wav 头，返回 { sampleRate, seconds }（解析失败给 0）。 */
export function wavSeconds(buf) {
  try {
    if (!Buffer.isBuffer(buf) || buf.length < 44) return 0
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return 0
    const byteRate = buf.readUInt32LE(28)
    const dataBytes = buf.length - 44
    if (!byteRate) return 0
    return dataBytes / byteRate
  } catch {
    return 0
  }
}

/**
 * 用 OneBot 的 get_record 把语音转成 wav（SnowLuma 自带解码）。
 *
 * @param {import('./onebot.js').OneBotClient} client
 * @param {string} file 语音段的 file 名（record.data.file）
 * @param {{timeoutMs?:number, maxBytes?:number}} [opts]
 * @returns {Promise<{ok:boolean, buffer?:Buffer, error?:string}>} 永远 resolve
 */
export async function fetchRecordWav(client, file, opts = {}) {
  const id = String(file ?? '').trim()
  if (!id) return { ok: false, error: 'no-file' }
  if (!client || typeof client.call !== 'function') return { ok: false, error: 'no-client' }
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : RECORD_TIMEOUT_MS
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : ASR_DEFAULTS.maxBytes
  try {
    const data = await client.call('get_record', { file: id, out_format: 'wav' }, timeoutMs)
    const b64 = String(data?.base64 || '')
    if (!b64) return { ok: false, error: 'no-base64' }
    if (b64.length * 0.75 > maxBytes) return { ok: false, error: 'too-large' }
    const buffer = Buffer.from(b64, 'base64')
    if (buffer.length < 44) return { ok: false, error: 'empty' }
    return { ok: true, buffer }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export class LocalAsr {
  /**
   * @param {{ config?: Record<string, any>, dataDir?: string, logger?: Function }} [opts]
   */
  constructor(opts = {}) {
    const config = opts.config || {}
    this.logger = typeof opts.logger === 'function' ? opts.logger : () => {}
    this.enabled = config.voiceAsrEnabled !== false
    this.python = String(config.voiceAsrPython || ASR_DEFAULTS.python)
    this.modelDir = String(config.voiceAsrModelDir || ASR_DEFAULTS.modelDir)
    this.model = String(config.voiceAsrModel || ASR_DEFAULTS.model)
    this.threads = Number(config.voiceAsrThreads) || ASR_DEFAULTS.threads
    this.timeoutMs = Number(config.voiceAsrTimeoutMs) || ASR_DEFAULTS.timeoutMs
    this.idleSeconds = Number(config.voiceAsrIdleSeconds) || ASR_DEFAULTS.idleSeconds
    this.maxSeconds = Number(config.voiceAsrMaxSeconds) || ASR_DEFAULTS.maxSeconds
    this.dataDir = String(opts.dataDir || config.dataDir || '').trim()
    this.dir = this.dataDir ? path.join(this.dataDir, 'asr') : ''
    this.workerFile = this.dir ? path.join(this.dir, 'asr_worker.py') : ''
    this.tmpDir = this.dir ? path.join(this.dir, 'tmp') : ''
    this.stats = { transcribed: 0, fail: 0, lastMs: 0, lastError: '' }
    this._child = null
    this._ready = false
    this._seq = 0
    this._pending = new Map()
    this._idleTimer = null
    this._queue = Promise.resolve()
    this._stdoutBuf = ''
    this._stderrTail = ''
  }

  get available() {
    return this.enabled && Boolean(this.dir)
  }

  /** 把 worker 脚本写盘（内容哈希变了才重写）。 */
  _ensureScript() {
    fs.mkdirSync(this.dir, { recursive: true })
    fs.mkdirSync(this.tmpDir, { recursive: true })
    const want = Buffer.from(WORKER_SOURCE, 'utf8')
    let same = false
    try {
      const have = fs.readFileSync(this.workerFile)
      same = have.equals(want)
    } catch {
      same = false
    }
    if (!same) fs.writeFileSync(this.workerFile, want)
    return this.workerFile
  }

  _cfgJson() {
    return JSON.stringify({
      model: this.model,
      model_dir: this.modelDir,
      threads: this.threads,
    })
  }

  /** 启动常驻 worker（幂等）。 */
  async _start() {
    if (this._child && this._ready) return
    this._ensureScript()
    if (!fs.existsSync(this.python)) throw new Error(`python 不存在：${this.python}`)
    const cfg = this._cfgJson()
    const child = spawn(this.python, ['-u', this.workerFile, cfg], {
      cwd: this.tmpDir || undefined,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' },
    })
    this._child = child
    this._ready = false
    this._stdoutBuf = ''
    this._stderrTail = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this._onStdout(chunk))
    child.stderr.on('data', (chunk) => {
      this._stderrTail = (this._stderrTail + String(chunk)).slice(-2000)
    })
    child.on('error', (err) => {
      // 旧 worker 被 dispose 后迟到的 error/exit 不能影响新 worker（2026-10-25 实测）
      if (this._child !== child) return
      this._failAll(err instanceof Error ? err : new Error(String(err)))
    })
    child.on('exit', (code) => {
      if (this._child !== child) return
      this._child = null
      this._ready = false
      this._failAll(new Error(`asr worker exited (code=${code}) ${this._stderrTail.slice(-300)}`))
    })

    const ready = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), Math.max(3000, this.timeoutMs))
      this._readyWaiters = this._readyWaiters || []
      this._readyWaiters.push((ok) => {
        clearTimeout(timer)
        resolve(ok)
      })
      child.once('error', () => resolve(false))
      child.once('exit', () => resolve(false))
    })
    if (!ready) {
      const tail = this._stderrTail.slice(-300)
      this._kill()
      throw new Error(`asr worker 未就绪 ${tail}`)
    }
    this._touchIdle()
  }

  _onStdout(chunk) {
    this._stdoutBuf += chunk
    for (;;) {
      const idx = this._stdoutBuf.indexOf('\n')
      if (idx < 0) return
      const line = this._stdoutBuf.slice(0, idx).trim()
      this._stdoutBuf = this._stdoutBuf.slice(idx + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        continue
      }
      if (msg.ready === true) {
        this._ready = true
        for (const fn of this._readyWaiters || []) fn(true)
        this._readyWaiters = []
        continue
      }
      if (msg.ready === false) {
        this._readyWaiters = []
        continue
      }
      const waiter = this._pending.get(msg.id)
      if (!waiter) continue
      this._pending.delete(msg.id)
      if (msg.ok) waiter.resolve(String(msg.text || '').trim())
      else waiter.reject(new Error(String(msg.error || 'asr-failed')))
    }
  }

  _failAll(err) {
    for (const [, waiter] of this._pending) waiter.reject(err)
    this._pending.clear()
    for (const fn of this._readyWaiters || []) fn(false)
    this._readyWaiters = []
  }

  _touchIdle() {
    if (this._idleTimer) clearTimeout(this._idleTimer)
    if (this.idleSeconds <= 0) return
    this._idleTimer = setTimeout(() => this._kill(), this.idleSeconds * 1000)
    this._idleTimer.unref?.()
  }

  _kill() {
    const child = this._child
    this._child = null
    this._ready = false
    this._failAll(new Error('asr worker stopped'))
    if (child) {
      try {
        child.kill()
      } catch {
        /* ignore */
      }
    }
  }

  /** 空闲/关机时主动释放。 */
  dispose() {
    if (this._idleTimer) clearTimeout(this._idleTimer)
    this._kill()
  }

  /**
   * 识别一段 wav（16-bit PCM，任意声道数，任意采样率——whisper 内部会重采样）。
   *
   * @param {Buffer} wavBuffer
   * @param {{timeoutMs?:number}} [opts]
   * @returns {Promise<string>} 识别正文；失败返回空串（永不抛）
   */
  async transcribe(wavBuffer, opts = {}) {
    if (!this.available) return ''
    if (!Buffer.isBuffer(wavBuffer) || wavBuffer.length < 44) {
      this.stats.fail += 1
      this.stats.lastError = 'bad-buffer'
      return ''
    }
    this._queue = this._queue.then(() => this._transcribeOne(wavBuffer, opts)).catch(() => '')
    return this._queue
  }

  async _transcribeOne(wavBuffer, opts = {}) {
    const startedAt = Date.now()
    const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : this.timeoutMs
    let tmpFile = ''
    try {
      await this._start()
      tmpFile = path.join(this.tmpDir, `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.wav`)
      fs.writeFileSync(tmpFile, wavBuffer)
      const id = ++this._seq
      this.stats.lastMs = 0
      const text = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this._pending.delete(id)
          reject(new Error('asr-timeout'))
          this._kill()
        }, timeoutMs)
        this._pending.set(id, {
          resolve: (value) => {
            clearTimeout(timer)
            resolve(value)
          },
          reject: (err) => {
            clearTimeout(timer)
            reject(err)
          },
        })
        this._child?.stdin?.write(`${JSON.stringify({ id, wav: tmpFile })}\n`)
      })
      this._touchIdle()
      if (!text) {
        this.stats.fail += 1
        this.stats.lastError = 'empty-text'
        return ''
      }
      this.stats.transcribed += 1
      this.stats.lastMs = Date.now() - startedAt
      return text
    } catch (err) {
      this.stats.fail += 1
      this.stats.lastError = err instanceof Error ? err.message : String(err)
      this.logger('debug', `本地语音识别失败：${this.stats.lastError}`)
      return ''
    } finally {
      if (tmpFile) {
        try {
          fs.unlinkSync(tmpFile)
        } catch {
          /* ignore */
        }
      }
    }
  }
}
