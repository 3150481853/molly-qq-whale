/*
 * 唱歌（2026-10-25，主人 m05189-2「鱼想唱歌…让鱼能唱出歌来」）。
 *
 * 思路（算法细节见文件末尾 RENDER_SOURCE_B64 里的 python）：
 *   1. 每个字先用同一副嗓子单独念一遍（GPT-SoVITS，音高自然但只是「说」）；
 *   2. 量出这段语音实际基频（YIN），算出需要移多少音分；
 *   3. 重采样搬音高 → WSOLA 把时长拉回音符时值 → 再用 YIN 逐帧精修一次音高；
 *   4. 按小节拼起来，段间 8ms 交叉淡化，长音用循环铺（避免把 0.4 秒的字拉成 3 倍变形）。
 * 这样不需要 SVC/歌声合成模型，也不下载新依赖，纯 numpy + wave。
 *
 * 依赖：python 解释器（复用本地 ASR 那个 venv：numpy / Pillow 都在里面）+ 本机
 * GPT-SoVITS。python 源码以 base64 内嵌（部署只需复制 lib/*.js，脚本运行时落盘到 tmp）。
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const SING_DEFAULTS = {
  enabled: true,
  // 2026-10-26 部署可移植性：留空 = 没配就报「唱歌环境未配置」（本来也是关闭状态），
  // 不再写死作者机的 G 盘 venv。
  python: '',
  timeoutMs: 180000,
  maxSyllables: 48,
  vibratoCents: 14,
  vibratoHz: 5.2,
}

// 简谱 → MIDI：1=C4(60) … 7=B4(71)，后缀 ^ 升八度
const JIANPU = {
  1: 60, 2: 62, 3: 64, 4: 65, 5: 67, 6: 69, 7: 71,
}

function midiFromToken(tok) {
  const m = /^([1-7])(\^+)?$/.exec(String(tok))
  if (!m) return null
  let midi = JIANPU[Number(m[1])]
  const ups = m[2] ? m[2].length : 0
  return midi + 12 * ups
}

// 曲库：notes 用简谱记号，durs 是每音时值（秒）。字符数必须和音符数一致。
export const SONGS = {
  小星星: {
    title: '小星星',
    lyrics: '一闪一闪亮晶晶满天都是小星星挂在天上放光明好像许多小眼睛一闪一闪亮晶晶满天都是小星星',
    notes: '1 1 5 5 6 6 5 4 4 3 3 2 2 1 5 5 4 4 3 3 2 5 5 4 4 3 3 2 1 1 5 5 6 6 5 4 4 3 3 2 2 1',
    durs: '0.52 0.52 0.52 0.52 0.52 0.52 0.86 0.52 0.52 0.52 0.52 0.52 0.52 0.86 0.52 0.52 0.52 0.52 0.52 0.52 0.86 0.52 0.52 0.52 0.52 0.52 0.52 0.86 0.52 0.52 0.52 0.52 0.52 0.52 0.86 0.52 0.52 0.52 0.52 0.52 0.52 0.86',
  },
  两只老虎: {
    title: '两只老虎',
    lyrics: '两只老虎两只老虎跑得快跑得快一只没有眼睛一只没有尾巴真奇怪真奇怪',
    notes: '1 2 3 1 1 2 3 1 3 4 5 3 4 5 5 6 5 4 3 1 5 6 5 4 3 1 1 5 1 1 5 1',
    durs: '0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 0.5 1.0 0.5 0.5 1.0 0.42 0.42 0.42 0.42 0.42 0.84 0.42 0.42 0.42 0.42 0.42 0.84 0.5 0.5 0.5 0.5 0.5 1.0',
  },
  生日快乐: {
    title: '生日快乐',
    lyrics: '祝你生日快乐祝你生日快乐祝你生日快乐祝你永远快乐啊',
    notes: '5 5 6 5 1^ 7 5 5 6 5 2^ 1^ 5 5 5^ 3^ 2^ 1^ 7 6 4^ 4^ 3^ 2^ 1^',
    durs: '0.45 0.45 0.9 0.9 0.9 1.4 0.45 0.45 0.9 0.9 0.9 1.4 0.45 0.45 0.9 0.9 0.9 1.4 0.45 0.45 0.9 0.9 0.9 1.4 1.6',
  },
}

export function songNames() {
  return Object.keys(SONGS)
}

/** 把「唱歌 小星星」这类请求拆出来；不是唱歌请求返回 null。 */
export function parseSingRequest(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim()
  if (!raw) return null
  const m = /^(?:麻烦|请|给我|快)?\s*(?:唱歌|唱一首|唱一个|唱个|唱一段|来一首|来一个|来段|唱)\s*([\s\S]*)$/u.exec(raw)
  if (!m) return null
  const rest = String(m[1] || '').replace(/^[了个一首段,，。.、\s]+/u, '').replace(/[。！!？?]+$/u, '').trim()
  const songName = rest.replace(/^歌\s*/u, '').trim()
  if (!songName) return { song: SONGS.小星星 ? '小星星' : songNames()[0], requested: '' }
  if (SONGS[songName]) return { song: songName, requested: songName }
  // 名字带了书名号/引号也能认
  const bare = songName.replace(/^[《「『"]+|[》」』"]+$/gu, '').trim()
  if (SONGS[bare]) return { song: bare, requested: songName }
  return { song: '', requested: songName }
}

/** 歌词 → 逐字（去掉标点/空白；英文数字按单字符保留一个音节）。 */
export function splitLyrics(lyrics) {
  const out = []
  for (const ch of String(lyrics || '')) {
    if (/[\s，。！？、,.!?;；:：'"“”‘’()（）【】《》「」…—-]/u.test(ch)) continue
    out.push(ch)
  }
  return out
}

function b64ToTmp(dir) {
  const file = path.join(dir, 'sing-render.py')
  const buf = Buffer.from(RENDER_SOURCE_B64, 'base64')
  let same = false
  try {
    same = fs.existsSync(file) && fs.readFileSync(file).equals(buf)
  } catch { /* ignore */ }
  if (!same) fs.writeFileSync(file, buf)
  return file
}

function runPy(python, args, { timeoutMs = 180000, cwd } = {}) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(python, args, {
        cwd: cwd || undefined,
        windowsHide: true,
        env: { ...process.env, OPENBLAS_NUM_THREADS: '1', OMP_NUM_THREADS: '1', PYTHONIOENCODING: 'utf-8' },
      })
    } catch (err) {
      resolve({ ok: false, error: err?.message || String(err) })
      return
    }
    const chunks = []
    const errs = []
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      resolve({ ok: false, error: `python 超时（${timeoutMs}ms）` })
    }, timeoutMs)
    child.stdout.on('data', (b) => chunks.push(b))
    child.stderr.on('data', (b) => errs.push(b))
    child.on('error', (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({ ok: false, error: err?.message || String(err) })
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve({
        ok: code === 0,
        code,
        stdout: Buffer.concat(chunks).toString('utf8'),
        stderr: Buffer.concat(errs).toString('utf8').slice(-1200),
      })
    })
  })
}

export class Singer {
  /**
   * @param {object} opts
   * @param {string} opts.dir 缓存目录（Molly 数据目录下 sing/）
   * @param {(text: string) => Promise<string>} opts.tts 逐字合成：文本 → wav 路径
   * @param {string} [opts.python]
   * @param {(level: string, msg: string) => void} [opts.logger]
   */
  constructor({ dir, tts, python, timeoutMs, logger } = {}) {
    this.dir = dir ? path.resolve(dir) : ''
    this.tts = tts
    this.python = python || SING_DEFAULTS.python
    this.timeoutMs = Number(timeoutMs) || SING_DEFAULTS.timeoutMs
    this.logger = logger || (() => {})
    this.tmpDir = this.dir ? path.join(this.dir, 'tmp') : ''
    this.stats = { ok: 0, fail: 0, cache: 0, lastMs: 0, lastError: '' }
    this._cache = new Map()
  }

  available() {
    return Boolean(this.tts && this.dir)
  }

  async _ensureTmp() {
    if (!this.tmpDir) throw new Error('Singer 没有 dir')
    fs.mkdirSync(this.tmpDir, { recursive: true })
    return b64ToTmp(this.tmpDir)
  }

  _songNotes(song) {
    const midis = String(song.notes || '').trim().split(/\s+/).map(midiFromToken)
    const durs = String(song.durs || '').trim().split(/\s+/).map(Number)
    if (midis.some((m) => !m) || midis.length !== durs.length) {
      throw new Error(`歌曲音符表不合法：${song.title || '?'}`)
    }
    return { midis, durs }
  }

  /** 读缓存的音准自检数据（渲染时写在 wav 旁边）；坏文件当没有。 */
  _readDetail(cachedFile) {
    try {
      const raw = fs.readFileSync(cachedFile + '.detail.json', 'utf8')
      const j = JSON.parse(raw)
      return Array.isArray(j?.detail) ? j.detail : []
    } catch {
      return []
    }
  }

  /**
   * 把渲染器给的 detail（每音 post_hz / dst_midi）折算成音准统计：
   * meanAbsCents / maxAbsCents / offNotes（偏超过 50 音分的音序号，从 1 起）。
   * 目的是让「有没有真的唱到调上」可被测试断言，而不是只看渲染成功。
   */
  _centsSummary(detail, midis) {
    const rows = []
    const list = Array.isArray(detail) ? detail : []
    for (let i = 0; i < list.length; i += 1) {
      const post = Number(list[i]?.post_hz)
      const dst = Number(list[i]?.dst_midi)
      if (!(post > 20) || !Number.isFinite(dst)) continue
      const actualMidi = 69 + 12 * Math.log2(post / 440)
      rows.push({ index: i + 1, dst, actual: Math.round(actualMidi * 100) / 100, cents: Math.round((actualMidi - dst) * 100) })
    }
    const abs = rows.map((r) => Math.abs(r.cents))
    const offNotes = rows.filter((r) => Math.abs(r.cents) > 50).map((r) => r.index)
    return {
      detail: rows,
      meanAbsCents: abs.length ? Math.round((abs.reduce((a, b) => a + b, 0) / abs.length) * 10) / 10 : null,
      maxAbsCents: abs.length ? Math.max(...abs) : null,
      offNotes,
      totalNotes: Array.isArray(midis) ? midis.length : rows.length,
    }
  }

  /** 唱歌：song 可以是曲库名字，也可以是 {lyrics, notes, durs} 自定义。 */
  async sing(song, { signal } = {}) {
    if (!this.available()) return { ok: false, error: '未配置 Singer（tts/dir 缺失）' }
    const startedAt = Date.now()
    try {
      const def = typeof song === 'string' ? SONGS[song] : song
      if (!def) throw new Error(`不会这首：${song}`)
      const syllables = splitLyrics(def.lyrics)
      const { midis, durs } = this._songNotes(def)
      if (!syllables.length) throw new Error('没有歌词')
      if (syllables.length !== midis.length) {
        throw new Error(`歌词字数(${syllables.length})和音符数(${midis.length})不一致`)
      }
      if (syllables.length > (Number(SING_DEFAULTS.maxSyllables) || 48)) {
        throw new Error(`歌词太长（${syllables.length} > 48 音节）`)
      }
      const python = await this._ensureTmp()
      const workDir = path.join(this.tmpDir, `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`)
      fs.mkdirSync(workDir, { recursive: true })

      // 同名曲子 + 同一副嗓子 → 直接复用缓存
      const cacheKey = crypto.createHash('sha1')
        .update(`${def.title || ''}|${def.lyrics}|${def.notes}|${def.durs}|${python}|${this.python}`)
        .digest('hex')
        .slice(0, 16)
      const cachedFile = path.join(this.dir, `${cacheKey}.wav`)
      if (fs.existsSync(cachedFile) && fs.statSync(cachedFile).size > 4000) {
        this.stats.cache += 1
        const seconds = Math.max(0.2, (fs.statSync(cachedFile).size - 44) / 2 / 24000)
        const detail = this._readDetail(cachedFile)
        return { ok: true, file: cachedFile, seconds, notes: midis.length, syllables: syllables.length, cached: true, ...this._centsSummary(detail, midis) }
      }

      // 1) 逐字合成（同一个字只合成一次）
      const files = new Map()
      const wanted = [...new Set(syllables)]
      const tasks = wanted.slice()
      const worker = async () => {
        while (tasks.length) {
          if (signal?.aborted) throw new Error('aborted')
          const ch = tasks.shift()
          const wav = await this.tts(ch)
          const p = String(wav || '')
          if (!p || !fs.existsSync(p)) throw new Error(`TTS 没有产出「${ch}」的音频`)
          files.set(ch, p)
        }
      }
      await Promise.all([worker(), worker()])

      // 2) 生成 manifest → python 渲染
      const notes = syllables.map((ch, i) => ({ file: files.get(ch), midi: midis[i], dur: durs[i] }))
      const outPath = path.join(workDir, 'song.wav')
      const manifest = {
        sr: 24000,
        out: outPath,
        notes,
        vibrato: { cents: SING_DEFAULTS.vibratoCents, hz: SING_DEFAULTS.vibratoHz },
      }
      const manPath = path.join(workDir, 'manifest.json')
      fs.writeFileSync(manPath, JSON.stringify(manifest), 'utf8')
      const r = await runPy(this.python, [python, manPath], { timeoutMs: this.timeoutMs, cwd: workDir })
      if (!r.ok) {
        throw new Error(`渲染失败：${(r.stderr || r.error || '').slice(0, 300)}`)
      }
      const last = String(r.stdout || '').trim().split('\n').pop() || '{}'
      const res = JSON.parse(last)
      if (!res.ok || !res.out || !fs.existsSync(res.out)) throw new Error('渲染没有输出 wav')
      // 3) 归档到缓存目录
      fs.copyFileSync(res.out, cachedFile)
      // 音准自检数据留在缓存旁边（测试/排障用：每音的目标 vs 实测音高）
      try { fs.writeFileSync(cachedFile + '.detail.json', JSON.stringify({ at: Date.now(), detail: res.detail || [], midis })) } catch { /* ignore */ }
      try { fs.rmSync(workDir, { recursive: true, force: true }) } catch { /* ignore */ }
      this.stats.ok += 1
      this.stats.lastMs = Date.now() - startedAt
      return {
        ok: true,
        file: cachedFile,
        seconds: Number(res.seconds) || 0,
        notes: Number(res.notes) || midis.length,
        syllables: syllables.length,
        cached: false,
        ...this._centsSummary(res.detail || [], midis),
      }
    } catch (err) {
      this.stats.fail += 1
      this.stats.lastError = err?.message || String(err)
      this.stats.lastMs = Date.now() - startedAt
      this.logger('warn', `唱歌失败：${this.stats.lastError}`)
      return { ok: false, error: this.stats.lastError }
    }
  }
}

// 内嵌的 python 渲染器（源码见 out/sing_render.py；base64 避免任何转义问题）
const RENDER_SOURCE_B64 = "IyEvdXNyL2Jpbi9lbnYgcHl0aG9uCiMgLSotIGNvZGluZzogdXRmLTggLSotCiIiInNpbmdfcmVuZGVyLnB5IOKAlOKAlCDmiorjgIzpgJDlrZcgVFRTICsg6Z+z56ym44CN5ou85oiQ6IO95ZCs55qE5peL5b6L77yI5Y6f5Z6L77yJ44CCCgrmgJ3ot6/vvJoKICAxKSDmr4/kuKrlrZflhYjnlJ/miJDkuIDmrrXor63pn7PvvIjlkIzkuIDkuKrkurrlo7Dpn7PoibLvvIzmnaXoh6ogR1BULVNvVklUUyAvIGVkZ2UtdHRz77yJ77ybCiAgMikg5YWI6YeP5Ye66L+Z5q616K+t6Z+z55qE5a6e6ZmF5Z+66aKR77yIWUlO77yJ77yM5b6X5YiwIHNyY19taWRp77ybCiAgMykg5oyJ55uu5qCH6Z+z56ym566X6aKR546H5q+UIHIgPSAyXigoZHN0IC0gc3JjKS8xMinvvIzph43ph4fmoLfmiorpn7Ppq5jmkKzliLDnm67moIfpn7MKICAgICDvvIjph43ph4fmoLflkIzml7bmiorml7bplb/lj5jmiJAgMS9y77yM5omA5Lul56ysIDQg5q2l6KaB5ouJ5Zue5p2l77yJ77ybCiAgNCkgV1NPTEEg5oqK5q+P5q615ouJ6ZW/L+WOi+efreWIsOmfs+espuaXtuWAvO+8jOmfs+mrmOS4jeWPmO+8mwogIDUpIOmhuuW6j+aLvOaOpe+8jOautemXtCA4bXMg5Lqk5Y+J5reh5YyWICsg5q+P5q616aaW5bC+IGZhZGXvvIzpgb/lhY3niIbpn7PjgIIKCuWPqueUqCBudW1weSArIOagh+WHhuW6kyB3YXZl77yM5LiN5L6d6LWWIGxpYnJvc2EvZmZtcGVn44CCCgrnlKjms5XvvJoKICBweXRob24gc2luZ19yZW5kZXIucHkgPG1hbmlmZXN0Lmpzb24+CiAgcHl0aG9uIHNpbmdfcmVuZGVyLnB5IC0tcHJvYmUgPHdhdj4gPHNlZ21lbnRzLmpzb24+ICAgIyDmr4/mrrXnmoTln7rpopHkuK3kvY3mlbAKbWFuaWZlc3Q6IHsic3IiOjI0MDAwLCJvdXQiOiJvdXQud2F2Iiwibm90ZXMiOlt7ImZpbGUiOiJhLndhdiIsIm1pZGkiOjYwLCJkdXIiOjAuNX1dLCJ2aWJyYXRvIjp7ImNlbnRzIjoxNSwiaHoiOjUuMn19CiIiIgoKaW1wb3J0IGpzb24KaW1wb3J0IG1hdGgKaW1wb3J0IHN5cwppbXBvcnQgd2F2ZQoKaW1wb3J0IG51bXB5IGFzIG5wCgpGUkFNRSA9IDEwMjQKSE9QID0gMjU2ClhGQURFID0gMC4wMDgKCgpkZWYgcmVhZF93YXYocGF0aCk6CiAgICB3aXRoIHdhdmUub3BlbihwYXRoLCAncmInKSBhcyB3OgogICAgICAgIHNyID0gdy5nZXRmcmFtZXJhdGUoKQogICAgICAgIGNoID0gdy5nZXRuY2hhbm5lbHMoKQogICAgICAgIHN3ID0gdy5nZXRzYW1wd2lkdGgoKQogICAgICAgIHJhdyA9IHcucmVhZGZyYW1lcyh3LmdldG5mcmFtZXMoKSkKICAgIGlmIHN3ICE9IDI6CiAgICAgICAgcmFpc2UgVmFsdWVFcnJvcihmJ+WPquaUr+aMgSAxNmJpdCBQQ03vvJp7cGF0aH0gc3c9e3N3fScpCiAgICB4ID0gbnAuZnJvbWJ1ZmZlcihyYXcsIGR0eXBlPSc8aTInKS5hc3R5cGUobnAuZmxvYXQzMikgLyAzMjc2OC4wCiAgICBpZiBjaCA+IDE6CiAgICAgICAgeCA9IHgucmVzaGFwZSgtMSwgY2gpLm1lYW4oYXhpcz0xKQogICAgcmV0dXJuIHNyLCB4CgoKZGVmIHdyaXRlX3dhdihwYXRoLCBzciwgeCk6CiAgICB4ID0gbnAuY2xpcCh4LCAtMS4wLCAxLjApCiAgICB3aXRoIHdhdmUub3BlbihwYXRoLCAnd2InKSBhcyB3OgogICAgICAgIHcuc2V0bmNoYW5uZWxzKDEpCiAgICAgICAgdy5zZXRzYW1wd2lkdGgoMikKICAgICAgICB3LnNldGZyYW1lcmF0ZShzcikKICAgICAgICB3LndyaXRlZnJhbWVzKCh4ICogMzI3NjcuMCkuYXN0eXBlKCc8aTInKS50b2J5dGVzKCkpCgoKZGVmIHRyaW1fc2lsZW5jZSh4LCBzciwgcmVsPTAuMDYsIHBhZD0wLjAxKToKICAgICIiIuijgeaOiemmluWwvumdmemfs++8iOmAkOWtlyBUVFMg5bi45bim5LiA54K55bC+5be077yb5LiN6KOB5Lya5bmy5omw6Z+z6auY5rWL6YeP5LiO6LS05pe26ZW/77yJ44CCCgogICAgcmVs77ya6Zeo6ZmQ5Y+W5pW05q615bOw5YC855qE5q+U5L6L77yI6buY6K6kIDYl77yM5L2O5Yiw5LiN6K+v5Lyk5rCU5aOw77yJ77yMcGFk77ya5Lik56uv5ZCE55WZ5LiA54K544CCCiAgICAiIiIKICAgIGlmIGxlbih4KSA9PSAwOgogICAgICAgIHJldHVybiB4CiAgICBob3AgPSBtYXgoMSwgaW50KHNyICogMC4wMSkpCiAgICBuID0gbGVuKHgpIC8vIGhvcAogICAgaWYgbiA9PSAwOgogICAgICAgIHJldHVybiB4CiAgICBlbnYgPSBucC5hYnMoeFs6biAqIGhvcF0ucmVzaGFwZShuLCBob3ApKS5tYXgoYXhpcz0xKQogICAgdGhyID0gbWF4KGZsb2F0KGVudi5tYXgoKSkgKiByZWwsIDFlLTQpCiAgICBpZHggPSBucC53aGVyZShlbnYgPiB0aHIpWzBdCiAgICBpZiBsZW4oaWR4KSA9PSAwOgogICAgICAgIHJldHVybiB4CiAgICBzdGFydCA9IG1heCgwLCBpbnQocm91bmQoKGlkeFswXSAtIDEpICogaG9wIC0gcGFkICogc3IpKSkKICAgIGVuZCA9IG1pbihsZW4oeCksIGludChyb3VuZCgoaWR4Wy0xXSArIDIpICogaG9wICsgcGFkICogc3IpKSkKICAgIHJldHVybiB4W3N0YXJ0OmVuZF0KCgpkZWYgcmVzYW1wbGVfbGluZWFyKHgsIHJhdGlvKToKICAgIGlmIGFicyhyYXRpbyAtIDEuMCkgPCAxZS02OgogICAgICAgIHJldHVybiB4LmNvcHkoKQogICAgbl9vdXQgPSBtYXgoMSwgaW50KHJvdW5kKGxlbih4KSAvIHJhdGlvKSkpCiAgICBwb3MgPSBucC5hcmFuZ2Uobl9vdXQsIGR0eXBlPW5wLmZsb2F0NjQpICogcmF0aW8KICAgIGkwID0gbnAuZmxvb3IocG9zKS5hc3R5cGUobnAuaW50NjQpCiAgICBpMSA9IG5wLm1pbmltdW0oaTAgKyAxLCBsZW4oeCkgLSAxKQogICAgZnJhYyA9IHBvcyAtIGkwCiAgICByZXR1cm4gKHhbaTBdICogKDEuMCAtIGZyYWMpICsgeFtpMV0gKiBmcmFjKS5hc3R5cGUobnAuZmxvYXQzMikKCgpkZWYgd3NvbGFfc3RyZXRjaCh4LCB0YXJnZXRfbGVuLCBzciwgZnJhbWU9RlJBTUUsIGhvcD1IT1ApOgogICAgdGFyZ2V0X2xlbiA9IGludCh0YXJnZXRfbGVuKQogICAgaWYgdGFyZ2V0X2xlbiA8PSAwIG9yIGxlbih4KSA9PSAwOgogICAgICAgIHJldHVybiBucC56ZXJvcyhtYXgoMCwgdGFyZ2V0X2xlbiksIGR0eXBlPW5wLmZsb2F0MzIpCiAgICBpZiBhYnModGFyZ2V0X2xlbiAtIGxlbih4KSkgPD0gZnJhbWU6CiAgICAgICAgeSA9IG5wLnplcm9zKHRhcmdldF9sZW4sIGR0eXBlPW5wLmZsb2F0MzIpCiAgICAgICAgbiA9IG1pbihsZW4oeCksIHRhcmdldF9sZW4pCiAgICAgICAgeVs6bl0gPSB4WzpuXQogICAgICAgIHJldHVybiB5CiAgICByYXRpbyA9IGxlbih4KSAvIHRhcmdldF9sZW4gICMg6L6T5YWl5q+P6L6T5Ye65qC35pys55qE5q+U5L6LCiAgICB3aW4gPSBucC5oYW5uaW5nKGZyYW1lKS5hc3R5cGUobnAuZmxvYXQzMikKICAgIGhvcF9pbiA9IG1heChIT1AgLy8gNCwgaW50KHJvdW5kKEhPUCAqIHJhdGlvKSkpCiAgICB0b2wgPSBtYXgoOCwgSE9QIC8vIDIpCiAgICBvdXQgPSBucC56ZXJvcyh0YXJnZXRfbGVuICsgZnJhbWUgKiAyLCBkdHlwZT1ucC5mbG9hdDMyKQogICAgaW5fcG9zID0gMC4wCiAgICBvdXRfcG9zID0gMAogICAgcHJldl90YWlsID0gTm9uZQogICAgd2hpbGUgb3V0X3BvcyA8IHRhcmdldF9sZW4gKyBmcmFtZToKICAgICAgICBpID0gaW50KHJvdW5kKGluX3BvcykpCiAgICAgICAgaWYgaSArIGZyYW1lID4gbGVuKHgpOgogICAgICAgICAgICBicmVhawogICAgICAgIGlmIHByZXZfdGFpbCBpcyBub3QgTm9uZToKICAgICAgICAgICAgbG8gPSBtYXgoMCwgaSAtIHRvbCkKICAgICAgICAgICAgaGkgPSBtaW4obGVuKHgpIC0gZnJhbWUsIGkgKyB0b2wpCiAgICAgICAgICAgIGlmIGhpID4gbG86CiAgICAgICAgICAgICAgICBiZXN0ID0gTm9uZQogICAgICAgICAgICAgICAgYmVzdF9zY29yZSA9IC0xZTMwCiAgICAgICAgICAgICAgICBmb3IgY2FuZCBpbiByYW5nZShsbywgaGkgKyAxLCAxNik6CiAgICAgICAgICAgICAgICAgICAgY29yciA9IGZsb2F0KG5wLmRvdCh4W2NhbmQ6Y2FuZCArIGZyYW1lXSAqIHdpbiwgcHJldl90YWlsKSkKICAgICAgICAgICAgICAgICAgICBpZiBjb3JyID4gYmVzdF9zY29yZToKICAgICAgICAgICAgICAgICAgICAgICAgYmVzdF9zY29yZSA9IGNvcnIKICAgICAgICAgICAgICAgICAgICAgICAgYmVzdCA9IGNhbmQKICAgICAgICAgICAgICAgIGlmIGJlc3QgaXMgbm90IE5vbmU6CiAgICAgICAgICAgICAgICAgICAgaSA9IGJlc3QKICAgICAgICBvdXRbb3V0X3BvczpvdXRfcG9zICsgZnJhbWVdICs9IHhbaTppICsgZnJhbWVdICogd2luCiAgICAgICAgcHJldl90YWlsID0gKHhbaSArIEhPUDppICsgSE9QICsgZnJhbWVdICogd2luKSBpZiBpICsgSE9QICsgZnJhbWUgPD0gbGVuKHgpIGVsc2UgTm9uZQogICAgICAgIGluX3BvcyArPSBob3BfaW4KICAgICAgICBvdXRfcG9zICs9IEhPUAogICAgcmV0dXJuIG5wLmNsaXAob3V0Wzp0YXJnZXRfbGVuXSwgLTEuMCwgMS4wKQoKCmRlZiBtaWRpX3RvX2h6KG0pOgogICAgcmV0dXJuIDQ0MC4wICogKDIuMCAqKiAoKGZsb2F0KG0pIC0gNjkuMCkgLyAxMi4wKSkKCgpkZWYgaHpfdG9fbWlkaShoeik6CiAgICByZXR1cm4gNjkuMCArIDEyLjAgKiBtYXRoLmxvZzIobWF4KDFlLTksIGZsb2F0KGh6KSkgLyA0NDAuMCkKCgpkZWYgeWluX2YwKHgsIHNyLCBmcmFtZT0xMDI0LCBob3A9MjU2LCBmbWluPTY1LjAsIGZtYXg9MTAwMC4wLCB0aHJlc2hvbGQ9MC4xNik6CiAgICB0YXVfbWluID0gbWF4KDIsIGludChzciAvIGZtYXgpKQogICAgdGF1X21heCA9IG1pbihmcmFtZSAtIDIsIGludChzciAvIGZtaW4pKQogICAgaWYgdGF1X21heCA8PSB0YXVfbWluIG9yIGxlbih4KSA8IGZyYW1lICsgdGF1X21heDoKICAgICAgICByZXR1cm4gW10KICAgIG91dCA9IFtdCiAgICBmb3Igc3RhcnQgaW4gcmFuZ2UoMCwgbGVuKHgpIC0gZnJhbWUgLSB0YXVfbWF4LCBob3ApOgogICAgICAgIHNlZyA9IHhbc3RhcnQ6c3RhcnQgKyBmcmFtZSArIHRhdV9tYXhdLmFzdHlwZShucC5mbG9hdDY0KQogICAgICAgIGEgPSBzZWdbMDpmcmFtZV0KICAgICAgICBkID0gbnAuZW1wdHkodGF1X21heCArIDEsIGR0eXBlPW5wLmZsb2F0NjQpCiAgICAgICAgZFs6XSA9IG5wLmluZgogICAgICAgIGZvciB0YXUgaW4gcmFuZ2UodGF1X21pbiwgdGF1X21heCArIDEpOgogICAgICAgICAgICBkaWZmID0gYSAtIHNlZ1t0YXU6dGF1ICsgZnJhbWVdCiAgICAgICAgICAgIGRbdGF1XSA9IGZsb2F0KG5wLmRvdChkaWZmLCBkaWZmKSkKICAgICAgICBjbW5kID0gbnAub25lcyh0YXVfbWF4ICsgMSwgZHR5cGU9bnAuZmxvYXQ2NCkKICAgICAgICBydW4gPSAwLjAKICAgICAgICBmb3IgdGF1IGluIHJhbmdlKDEsIHRhdV9tYXggKyAxKToKICAgICAgICAgICAgcnVuICs9IGRbdGF1XSBpZiBucC5pc2Zpbml0ZShkW3RhdV0pIGVsc2UgMC4wCiAgICAgICAgICAgIGNtbmRbdGF1XSA9IChkW3RhdV0gKiB0YXUgLyBydW4pIGlmIHJ1biA+IDAgZWxzZSAxLjAKICAgICAgICBwaWNrID0gLTEKICAgICAgICBmb3IgdGF1IGluIHJhbmdlKHRhdV9taW4gKyAxLCB0YXVfbWF4KToKICAgICAgICAgICAgaWYgY21uZFt0YXVdIDwgdGhyZXNob2xkIGFuZCBjbW5kW3RhdV0gPD0gY21uZFt0YXUgLSAxXSBhbmQgY21uZFt0YXVdIDw9IGNtbmRbdGF1ICsgMV06CiAgICAgICAgICAgICAgICBwaWNrID0gdGF1CiAgICAgICAgICAgICAgICBicmVhawogICAgICAgIGlmIHBpY2sgPCAwOgogICAgICAgICAgICBzdWIgPSBjbW5kW3RhdV9taW46dGF1X21heF0KICAgICAgICAgICAgaWYgc3ViLnNpemUgPT0gMDoKICAgICAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAgICAgIHBpY2sgPSB0YXVfbWluICsgaW50KG5wLmFyZ21pbihzdWIpKQogICAgICAgICAgICBpZiBjbW5kW3BpY2tdID4gMC41OgogICAgICAgICAgICAgICAgY29udGludWUKICAgICAgICB0MCwgdDEsIHQyID0gcGljayAtIDEsIHBpY2ssIHBpY2sgKyAxCiAgICAgICAgZGVub20gPSBjbW5kW3QwXSAtIDIgKiBjbW5kW3QxXSArIGNtbmRbdDJdCiAgICAgICAgZGVsdGEgPSAwLjUgKiAoY21uZFt0MF0gLSBjbW5kW3QyXSkgLyBkZW5vbSBpZiBhYnMoZGVub20pID4gMWUtMTIgZWxzZSAwLjAKICAgICAgICB0YXUgPSB0MSArIGRlbHRhCiAgICAgICAgaWYgdGF1IDw9IDA6CiAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAgZiA9IHNyIC8gdGF1CiAgICAgICAgaWYgZm1pbiA8PSBmIDw9IGZtYXg6CiAgICAgICAgICAgIG91dC5hcHBlbmQoW3N0YXJ0IC8gc3IsIGZdKQogICAgcmV0dXJuIG91dAoKCmRlZiBhY2ZfZjAoeCwgc3IsIGZyYW1lPTEwMjQsIGhvcD0yNTYsIGZtaW49MTIwLjAsIGZtYXg9ODAwLjApOgogICAgIiIi6Ieq55u45YWz5Z+66aKR5Lyw6K6h77yI5q+UIFlJTiDmipfkvY7lhavluqbor6/liKTvvInjgIIKCiAgICDmr4/luKfnrpflvZLkuIDljJboh6rnm7jlhbPvvIzlnKggW3NyL2ZtYXgsIHNyL2ZtaW5dIOmHjOWPluacgOW8uuWxgOmDqOWzsO+8mwogICAg5YaN5qOA5p+lIDEvMuOAgTEvMyDlu7bov5/lpITmmK/lkKblkIzmoLflvLrvvIjlvLrliJnmjaLmm7Tnn63lu7bov5/vvIzpgb/lhY3pgInliLDmrKHosJDms6LvvInjgIIKICAgIOi/lOWbniBbKHRfc2VjLCBmX2h6KV3vvJvluKfog73ph4/ov4fkvY7miJbls7DlpKrlvLHliJnot7Pov4fjgIIKICAgICIiIgogICAgaWYgbGVuKHgpIDwgZnJhbWU6CiAgICAgICAgcmV0dXJuIFtdCiAgICBsb19sYWcgPSBtYXgoMiwgaW50KG1hdGguZmxvb3Ioc3IgLyBmbWF4KSkpCiAgICBoaV9sYWcgPSBpbnQobWF0aC5jZWlsKHNyIC8gZm1pbikpCiAgICBvdXQgPSBbXQogICAgZm9yIHN0YXJ0IGluIHJhbmdlKDAsIGxlbih4KSAtIGZyYW1lLCBob3ApOgogICAgICAgIHNlZyA9IHhbc3RhcnQ6c3RhcnQgKyBmcmFtZV0uYXN0eXBlKG5wLmZsb2F0NjQpCiAgICAgICAgaWYgZmxvYXQobnAuc3FydChucC5tZWFuKHNlZyAqIHNlZykpKSA8IDAuMDA4OgogICAgICAgICAgICBjb250aW51ZQogICAgICAgIHNlZyA9IHNlZyAtIHNlZy5tZWFuKCkKICAgICAgICBuID0gZnJhbWUKICAgICAgICBzcGVjID0gbnAuZmZ0LnJmZnQoc2VnLCBuICogMikKICAgICAgICBhY2YgPSBucC5mZnQuaXJmZnQoc3BlYyAqIG5wLmNvbmooc3BlYyksIG4gKiAyKVs6bl0KICAgICAgICBpZiBhY2ZbMF0gPD0gMDoKICAgICAgICAgICAgY29udGludWUKICAgICAgICBhY2YgPSBhY2YgLyBhY2ZbMF0KICAgICAgICBoaSA9IG1pbihoaV9sYWcsIG4gLSAzKQogICAgICAgIGlmIGhpIDw9IGxvX2xhZyArIDI6CiAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAgYmVzdCA9IC0xLjAKICAgICAgICBiZXN0X2xhZyA9IDAKICAgICAgICBmb3IgbGFnIGluIHJhbmdlKGxvX2xhZyArIDEsIGhpKToKICAgICAgICAgICAgdiA9IGZsb2F0KGFjZltsYWddKQogICAgICAgICAgICBpZiB2ID4gYWNmW2xhZyAtIDFdIGFuZCB2ID49IGFjZltsYWcgKyAxXSBhbmQgdiA+IGJlc3Q6CiAgICAgICAgICAgICAgICBiZXN0ID0gdgogICAgICAgICAgICAgICAgYmVzdF9sYWcgPSBsYWcKICAgICAgICBpZiBiZXN0X2xhZyA9PSAwIG9yIGJlc3QgPCAwLjI1OgogICAgICAgICAgICBjb250aW51ZQogICAgICAgIGZvciBkaXYgaW4gKDIsIDMpOgogICAgICAgICAgICBjYW5kID0gYmVzdF9sYWcgLyBmbG9hdChkaXYpCiAgICAgICAgICAgIGlmIGNhbmQgPCBsb19sYWc6CiAgICAgICAgICAgICAgICBjb250aW51ZQogICAgICAgICAgICBjMCA9IGludChtYXRoLmZsb29yKGNhbmQpKQogICAgICAgICAgICBjMSA9IG1pbihuIC0gMiwgYzAgKyAxKQogICAgICAgICAgICBpZiBjMSA8PSBjMDoKICAgICAgICAgICAgICAgIGNvbnRpbnVlCiAgICAgICAgICAgIHN1YiA9IGFjZltjMDpjMSArIDFdCiAgICAgICAgICAgIGsgPSBpbnQobnAuYXJnbWF4KHN1YikpCiAgICAgICAgICAgIGlmIGZsb2F0KHN1YltrXSkgPj0gYmVzdCAqIDAuOTI6CiAgICAgICAgICAgICAgICBiZXN0X2xhZyA9IGMwICsgawogICAgICAgICAgICAgICAgYnJlYWsKICAgICAgICBmID0gc3IgLyBmbG9hdChiZXN0X2xhZykKICAgICAgICBpZiBmbWluIDw9IGYgPD0gZm1heDoKICAgICAgICAgICAgb3V0LmFwcGVuZCgoc3RhcnQgLyBzciwgZikpCiAgICByZXR1cm4gb3V0Cg0KDQpkZWYgbWVkaWFuX2YwKHgsIHNyLCBsbz0wLjAsIGhpPU5vbmUpOg0KICAgIGhpdHMgPSBhY2ZfZjAoeCwgc3IpCiAgICBpZiBoaSBpcyBOb25lOgogICAgICAgIGhpID0gbGVuKHgpIC8gc3IKICAgIGZyZXFzID0gW2YgZm9yICh0LCBmKSBpbiBoaXRzIGlmIGxvIDw9IHQgPCBoaV0KICAgIHJldHVybiBmbG9hdChucC5tZWRpYW4oZnJlcXMpKSBpZiBmcmVxcyBlbHNlIDAuMAoKCmRlZiBzbmFwX3BpdGNoKHksIHNyLCBkc3RfbWlkaSwgdmlicmF0bz1Ob25lLCBob3A9MTI4LCBmcmFtZT0xMDI0LCBjbGlwPTAuOTQpOgogICAgIiIi5oqKIHkg55qE5bGA6YOo6Z+z6auY5o6w5YiwIGRzdF9taWRp77yIwrE4JSDku6XlhoXvvInvvIzlho3lj6DliqDkuIDkuKrovbvlvq7poqTpn7PjgIIKCiAgICDlgZrms5XvvJrmr48gaG9wIOeUqCBZSU4g6YeP5LiA5qyh5bGA6YOo5Z+66aKR77yM566X5L+u5q2j57O75pWwIHIgPSDnm67moIcv5a6e5rWL77yMCiAgICDlubPmu5HlkI7nlKjml7bpl7Tlj5jljJbph43ph4fmoLfmiafooYzvvJvov5nkuIDmi5vog73mioogwrExNTAgY2VudHMg55qE5YGP5beu5Y6L5YiwIMKxMjAgY2VudHPjgIIKICAgICIiIgogICAgaWYgbGVuKHkpIDwgZnJhbWUgKiAyOgogICAgICAgIHJldHVybiB5CiAgICB0YXJnZXRfaHogPSBtaWRpX3RvX2h6KGRzdF9taWRpKQogICAgIyDlj6rlnKjnm67moIfpn7Ppq5jpmYTov5Hmib7vvIjnqoTluKboh6rnm7jlhbPvvInvvJrpgb/lhY3mioogMiDmrKHosJDms6Iv5qyh6LCQ5rOi5b2T5oiQ5Z+66aKRCiAgICBoaXRzID0gYWNmX2YwKHksIHNyLCBmcmFtZT1mcmFtZSwgaG9wPWhvcCwKICAgICAgICAgICAgICAgICAgZm1pbj1tYXgoODAuMCwgdGFyZ2V0X2h6ICogMC41NSksIGZtYXg9bWluKDEyMDAuMCwgdGFyZ2V0X2h6ICogMS45KSkKICAgIGlmIG5vdCBoaXRzOgogICAgICAgIHJldHVybiB5CiAgICBuX291dCA9IGxlbih5KQogICAgcG9zID0gbnAuYXJhbmdlKG5fb3V0LCBkdHlwZT1ucC5mbG9hdDY0KQogICAgY29yciA9IG5wLm9uZXMobl9vdXQsIGR0eXBlPW5wLmZsb2F0NjQpCiAgICBpZiBoaXRzOgogICAgICAgIHRzID0gbnAuYXJyYXkoW2hbMF0gZm9yIGggaW4gaGl0c10sIGR0eXBlPW5wLmZsb2F0NjQpCiAgICAgICAgaHMgPSBucC5hcnJheShbaFsxXSBmb3IgaCBpbiBoaXRzXSwgZHR5cGU9bnAuZmxvYXQ2NCkKICAgICAgICAjIOaKl+WAjemike+8muaKiuavj+S4quW4p+eahOWunua1i+mfs+mrmOaKmOWPoOWIsOS4reS9jeaVsOmZhOi/ke+8iMKxMC41OCDlgI3ku6XlhoXvvIkKICAgICAgICBtZWQgPSBmbG9hdChucC5tZWRpYW4oaHMpKQogICAgICAgIGZvbGRlZCA9IG5wLmVtcHR5X2xpa2UoaHMpCiAgICAgICAgZm9yIGlkeCBpbiByYW5nZShsZW4oaHMpKToKICAgICAgICAgICAgaCA9IGZsb2F0KGhzW2lkeF0pCiAgICAgICAgICAgIHdoaWxlIGggPiBtZWQgKiAxLjU1OgogICAgICAgICAgICAgICAgaCAvPSAyLjAKICAgICAgICAgICAgd2hpbGUgaCA8IG1lZCAvIDEuNTU6CiAgICAgICAgICAgICAgICBoICo9IDIuMAogICAgICAgICAgICBmb2xkZWRbaWR4XSA9IGgKICAgICAgICByYXRpbyA9IHRhcmdldF9oeiAvIG5wLmNsaXAoZm9sZGVkLCA1NS4wLCAxMTAwLjApCiAgICAgICAgcmF0aW8gPSBucC5jbGlwKHJhdGlvLCAxLjAgLSBjbGlwLCAxLjAgKyBjbGlwKSAgIyDljZXmrKHkv67mraPkuIrpmZAKICAgICAgICAjIOS4reWAvOa7pOazou+8jOaKueaOiea1i+mHj+avm+WIugogICAgICAgIGsgPSA1CiAgICAgICAgcGFkZGVkID0gbnAucGFkKHJhdGlvLCAoayAvLyAyLCBrIC8vIDIpLCBtb2RlPSdlZGdlJykKICAgICAgICBzbW9vdGggPSBucC5hcnJheShbbnAubWVkaWFuKHBhZGRlZFtpOmkgKyBrXSkgZm9yIGkgaW4gcmFuZ2UobGVuKHJhdGlvKSldKQogICAgICAgIGNvcnIgPSBucC5pbnRlcnAocG9zIC8gc3IsIHRzLCBzbW9vdGgsIGxlZnQ9c21vb3RoWzBdLCByaWdodD1zbW9vdGhbLTFdKQogICAgIyDml7bpl7Tlj5jljJbph43ph4fmoLfvvJror7vlj5bmraXplb8gPSBjb3Jy77yI5q2l6ZW/PjEgPSDor7vlvpflv6sgPSDpn7PljYfpq5jvvIkKICAgIHN0ZXAgPSBucC5jbGlwKGNvcnIsIDAuODUsIDEuMTgpCiAgICBpZiB2aWJyYXRvIGFuZCB2aWJyYXRvLmdldCgnY2VudHMnKToKICAgICAgICBkZXB0aCA9IDIuMCAqKiAoZmxvYXQodmlicmF0b1snY2VudHMnXSkgLyAxMjAwLjApIC0gMS4wCiAgICAgICAgaHogPSBmbG9hdCh2aWJyYXRvLmdldCgnaHonKSBvciA1LjIpCiAgICAgICAgdCA9IG5wLmFyYW5nZShuX291dCkgLyBzcgogICAgICAgIHN0ZXAgPSBzdGVwICogKDEuMCArIGRlcHRoICogbnAuc2luKDIgKiBtYXRoLnBpICogaHogKiB0KSkKICAgIGFjYyA9IG5wLmN1bXN1bShzdGVwKQogICAgYWNjID0gbnAuY2xpcChhY2MsIDAuMCwgZmxvYXQobl9vdXQgLSAxKSkKICAgIGkwID0gbnAuZmxvb3IoYWNjKS5hc3R5cGUobnAuaW50NjQpCiAgICBpMSA9IG5wLm1pbmltdW0oaTAgKyAxLCBuX291dCAtIDEpCiAgICBmcmFjID0gYWNjIC0gaTAKICAgIHJldHVybiAoeVtpMF0gKiAoMS4wIC0gZnJhYykgKyB5W2kxXSAqIGZyYWMpLmFzdHlwZShucC5mbG9hdDMyKQoKCmRlZiB0aWxlX3RvKHgsIHRhcmdldF9sZW4sIHNyLCBvdmVybGFwPTAuMDEyKToKICAgICIiIuaKiuS4gOS4quefremfs+iKguW+queOr+mTuuWIsOebruagh+mVv+W6pu+8iOmVv+mfs+eUqO+8ie+8jOihlOaOpeWkhOWBmuetieWKn+eOh+S6pOWPiea3oeWMluOAgiIiIgogICAgaWYgbGVuKHgpID09IDA6CiAgICAgICAgcmV0dXJuIHgKICAgIGlmIHRhcmdldF9sZW4gPD0gbGVuKHgpICogMS42OgogICAgICAgIHJldHVybiB4CiAgICBvdiA9IG1heCgxNiwgaW50KG92ZXJsYXAgKiBzcikpCiAgICBob3AgPSBtYXgoNjQsIGxlbih4KSAtIG92KQogICAgcmVwcyA9IGludChtYXRoLmNlaWwodGFyZ2V0X2xlbiAvIGhvcCkpICsgMQogICAgb3V0ID0gbnAuemVyb3MoaG9wICogcmVwcyArIG92ICsgMTYsIGR0eXBlPW5wLmZsb2F0MzIpCiAgICB3aW4gPSBucC5saW5zcGFjZSgwLjAsIDEuMCwgb3YsIGR0eXBlPW5wLmZsb2F0MzIpCiAgICBmb3IgciBpbiByYW5nZShyZXBzKToKICAgICAgICBzID0gciAqIGhvcAogICAgICAgIHNlZyA9IHgKICAgICAgICBpZiByID4gMDoKICAgICAgICAgICAgc2VnID0gbnAuY29uY2F0ZW5hdGUoW25wLnplcm9zKG92LCBkdHlwZT1ucC5mbG9hdDMyKSwgeFtvdjpdXSkgaWYgbGVuKHgpID4gb3YgZWxzZSB4CiAgICAgICAgICAgIG91dFtzOnMgKyBvdl0gPSBvdXRbczpzICsgb3ZdICogKDEgLSB3aW4pICsgeFs6b3ZdICogd2luCiAgICAgICAgICAgIG91dFtzICsgb3Y6cyArIGxlbihzZWcpXSArPSBzZWdbb3Y6XQogICAgICAgIGVsc2U6CiAgICAgICAgICAgIG91dFtzOnMgKyBsZW4oc2VnKV0gKz0gc2VnCiAgICAgICAgaWYgbGVuKHNlZykgPCBob3A6CiAgICAgICAgICAgIGJyZWFrCiAgICBvdXQgPSBvdXRbOm1heCh0YXJnZXRfbGVuLCBsZW4oeCkpXQogICAgcmV0dXJuIG91dAoKCmRlZiBub3RlX3NlZ21lbnQoeCwgc3IsIHNyY19taWRpLCBkc3RfbWlkaSwgZHVyX3NlYywgdmlicmF0bz1Ob25lKToKICAgIHJhdGlvID0gbWlkaV90b19oeihkc3RfbWlkaSkgLyBtaWRpX3RvX2h6KHNyY19taWRpKQogICAgeSA9IHJlc2FtcGxlX2xpbmVhcih4LCByYXRpbykKICAgIHRhcmdldCA9IGludChyb3VuZChkdXJfc2VjICogc3IpKQogICAgeSA9IHRpbGVfdG8oeSwgdGFyZ2V0LCBzcikKICAgIHkgPSB3c29sYV9zdHJldGNoKHksIHRhcmdldCwgc3IpCiAgICAjIOi/reS7o+eyvuS/rumfs+mrmO+8muWFiOeyl++8iMKxMTIl77yJ77yM5YaN57uG77yIwrE0Je+8ie+8jOS4gOiIrOS4pOi9ruWwseWknwogICAgeSA9IHNuYXBfcGl0Y2goeSwgc3IsIGRzdF9taWRpLCBOb25lLCBjbGlwPTAuMTIpDQogICAgeSA9IHNuYXBfcGl0Y2goeSwgc3IsIGRzdF9taWRpLCBOb25lLCBjbGlwPTAuMDQpDQogICAgeSA9IHNuYXBfcGl0Y2goeSwgc3IsIGRzdF9taWRpLCBOb25lLCBjbGlwPTAuMDIpCiAgICAjIOWFnOW6le+8muaVtOS9k+a1i+mHjy3nuqDmraPkuKTova7vvIjkuKrliKvlrZfnmoTmsJTlj6Mv5YWx5oyv5Lya6K6p6YCQ5bin6Lef6Liq6LeR5YGP77yMCiAgICAjIOi/meS4gOatpeaMieOAjOaVtOauteS4reS9jemfs+mrmOOAjeWGjeaQrOS4gOasoe+8jOaQrOWujOeUqCBXU09MQSDmi4nlm57nm67moIfml7bplb/vvInjgIIKICAgIHRhcmdldF9oel8yID0gbWlkaV90b19oeihkc3RfbWlkaSkKICAgIGZvciBfIGluIHJhbmdlKDIpOgogICAgICAgIHBvc3QgPSBtZWRpYW5fZjAoeSwgc3IsIGxlbih5KSAvIHNyICogMC4xNSwgbGVuKHkpIC8gc3IgKiAwLjg1KQogICAgICAgIGlmIHBvc3QgPD0gMDoKICAgICAgICAgICAgYnJlYWsKICAgICAgICBjZW50cyA9IDEyMDAuMCAqIG1hdGgubG9nMih0YXJnZXRfaHpfMiAvIHBvc3QpCiAgICAgICAgaWYgYWJzKGNlbnRzKSA8IDM1OgogICAgICAgICAgICBicmVhawogICAgICAgIHJhdGlvID0gbWF4KDAuOCwgbWluKDEuMjUsIHRhcmdldF9oel8yIC8gcG9zdCkpCiAgICAgICAgeSA9IHJlc2FtcGxlX2xpbmVhcih5LCByYXRpbykKICAgICAgICB5ID0gd3NvbGFfc3RyZXRjaCh5LCB0YXJnZXQsIHNyKQogICAgaWYgdmlicmF0byBhbmQgdmlicmF0by5nZXQoJ2NlbnRzJyk6CiAgICAgICAgZGVwdGggPSAyLjAgKiogKGZsb2F0KHZpYnJhdG9bJ2NlbnRzJ10pIC8gMTIwMC4wKSAtIDEuMAogICAgICAgIGh6ID0gZmxvYXQodmlicmF0by5nZXQoJ2h6Jykgb3IgNS4yKQogICAgICAgIG4gPSBsZW4oeSkKICAgICAgICB0ID0gbnAuYXJhbmdlKG4pIC8gc3IKICAgICAgICBzdGVwID0gMS4wICsgZGVwdGggKiBucC5zaW4oMiAqIG1hdGgucGkgKiBoeiAqIHQpCiAgICAgICAgc3RlcCA9IHN0ZXAgLSAoZmxvYXQobnAubWVhbihzdGVwKSkgLSAxLjApCiAgICAgICAgYWNjID0gbnAubWF4aW11bS5hY2N1bXVsYXRlKG5wLmNsaXAobnAuY3Vtc3VtKHN0ZXApLCAwLjAsIGZsb2F0KG4gLSAxKSkpCiAgICAgICAgaTAgPSBucC5mbG9vcihhY2MpLmFzdHlwZShucC5pbnQ2NCkKICAgICAgICBpMSA9IG5wLm1pbmltdW0oaTAgKyAxLCBuIC0gMSkKICAgICAgICBmcmFjID0gYWNjIC0gaTAKICAgICAgICB5ID0gKHlbaTBdICogKDEuMCAtIGZyYWMpICsgeVtpMV0gKiBmcmFjKS5hc3R5cGUobnAuZmxvYXQzMikKICAgIGZhZGUgPSBtaW4oaW50KDAuMDA2ICogc3IpLCBsZW4oeSkgLy8gNCkKICAgIGlmIGZhZGUgPiAwOgogICAgICAgIHJhbXAgPSBucC5saW5zcGFjZSgwLjAsIDEuMCwgZmFkZSwgZHR5cGU9bnAuZmxvYXQzMikKICAgICAgICB5WzpmYWRlXSAqPSByYW1wCiAgICAgICAgeVstZmFkZTpdICo9IHJhbXBbOjotMV0KICAgIHJldHVybiB5CgoKZGVmIGNtZF9wcm9iZSh3YXZfcGF0aCwgc2VnX3BhdGgpOgogICAgc3IsIHggPSByZWFkX3dhdih3YXZfcGF0aCkKICAgIHggPSB0cmltX3NpbGVuY2UoeCwgc3IpCiAgICB3aXRoIG9wZW4oc2VnX3BhdGgsICdyJywgZW5jb2Rpbmc9J3V0Zi04JykgYXMgZjoKICAgICAgICBzZWdzID0ganNvbi5sb2FkKGYpCiAgICByb3dzID0gW10KICAgIGZvciBzIGluIHNlZ3M6CiAgICAgICAgaHogPSBtZWRpYW5fZjAoeCwgc3IsIGZsb2F0KHMuZ2V0KCdsbycsIDAuMCkpLCBmbG9hdChzLmdldCgnaGknLCBsZW4oeCkgLyBzcikpKQogICAgICAgIHJvd3MuYXBwZW5kKHsnaHonOiByb3VuZChoeiwgMiksICdtaWRpJzogcm91bmQoaHpfdG9fbWlkaShoeiksIDIpIGlmIGh6ID4gMCBlbHNlIDB9KQogICAgcHJpbnQoanNvbi5kdW1wcyh7J29rJzogVHJ1ZSwgJ3NyJzogc3IsICdzZWNvbmRzJzogcm91bmQobGVuKHgpIC8gc3IsIDMpLCAncm93cyc6IHJvd3N9KSkKICAgIHJldHVybiAwCgoKZGVmIGNtZF9yZW5kZXIobWFuX3BhdGgpOgogICAgd2l0aCBvcGVuKG1hbl9wYXRoLCAncicsIGVuY29kaW5nPSd1dGYtOCcpIGFzIGY6CiAgICAgICAgbWFuID0ganNvbi5sb2FkKGYpCiAgICBzcl9vdXQgPSBpbnQobWFuLmdldCgnc3InKSBvciAyNDAwMCkKICAgIHZpYnJhdG8gPSBtYW4uZ2V0KCd2aWJyYXRvJykgb3Ige30KICAgIHBpZWNlcyA9IFtdCiAgICBkZXQgPSBbXQogICAgZm9yIG5vdGUgaW4gbWFuWydub3RlcyddOgogICAgICAgIHNyLCB4ID0gcmVhZF93YXYobm90ZVsnZmlsZSddKQogICAgICAgIHggPSB0cmltX3NpbGVuY2UoeCwgc3IpCiAgICAgICAgaWYgc3IgIT0gc3Jfb3V0OgogICAgICAgICAgICB4ID0gcmVzYW1wbGVfbGluZWFyKHgsIHNyIC8gc3Jfb3V0KQogICAgICAgIGR1ciA9IGxlbih4KSAvIHNyX291dAogICAgICAgICMg6YeP5Ye66L+Z5q616K+t6Z+z55qE5a6e6ZmF6Z+z6auY77yI6Lez6L+H6aaW5bC+55qE6Z2Z6Z+zL+awlOWPo++8iQogICAgICAgIG1lYXN1cmVkID0gbWVkaWFuX2YwKHgsIHNyX291dCwgZHVyICogMC4xMiwgZHVyICogMC45MikKICAgICAgICBzcmNfbWlkaSA9IGh6X3RvX21pZGkobWVhc3VyZWQpIGlmIG1lYXN1cmVkID4gMCBlbHNlIGZsb2F0KG5vdGUuZ2V0KCdzcmNfbWlkaScpIG9yIDU3LjApCiAgICAgICAgc2VnID0gbm90ZV9zZWdtZW50KHgsIHNyX291dCwgc3JjX21pZGksIGZsb2F0KG5vdGVbJ21pZGknXSksIGZsb2F0KG5vdGVbJ2R1ciddKSwgdmlicmF0bykKICAgICAgICBwZWFrID0gZmxvYXQobnAubWF4KG5wLmFicyhzZWcpKSBvciAxZS05KQogICAgICAgIHNlZyA9IHNlZyAvIG1heChwZWFrLCAxZS02KSAqIDAuODUKICAgICAgICBwaWVjZXMuYXBwZW5kKHNlZykKICAgICAgICAjIOWHuuauteWQjuWGjemHj+S4gOasoe+8jOS+v+S6juiwg+ivlemfs+mrmOaYr+WQpuecn+WIsOS9je+8iOi3s+i/h+mmluWwvua3oeWMluWMuu+8iQogICAgICAgIHBvc3QgPSBtZWRpYW5fZjAoc2VnLCBzcl9vdXQsIGxlbihzZWcpIC8gc3Jfb3V0ICogMC4xNSwgbGVuKHNlZykgLyBzcl9vdXQgKiAwLjg1KQogICAgICAgIGRldC5hcHBlbmQoeydmaWxlJzogbm90ZVsnZmlsZSddLCAnbWVhc3VyZWRfaHonOiByb3VuZChtZWFzdXJlZCwgMiksICdzcmNfbWlkaSc6IHJvdW5kKHNyY19taWRpLCAyKSwKICAgICAgICAgICAgICAgICAgICAnZHN0X21pZGknOiBmbG9hdChub3RlWydtaWRpJ10pLCAncG9zdF9oeic6IHJvdW5kKHBvc3QsIDIpfSkKICAgIGlmIG5vdCBwaWVjZXM6CiAgICAgICAgcHJpbnQoanNvbi5kdW1wcyh7J29rJzogRmFsc2UsICdlcnJvcic6ICdubyBub3Rlcyd9KSkKICAgICAgICByZXR1cm4gMQogICAgeGYgPSBpbnQoWEZBREUgKiBzcl9vdXQpCiAgICB0b3RhbCA9IHN1bShsZW4ocCkgZm9yIHAgaW4gcGllY2VzKSAtIHhmICogKGxlbihwaWVjZXMpIC0gMSkKICAgIG91dCA9IG5wLnplcm9zKG1heCgwLCB0b3RhbCksIGR0eXBlPW5wLmZsb2F0MzIpCiAgICBwb3MgPSAwCiAgICBmb3IgaWR4LCBwIGluIGVudW1lcmF0ZShwaWVjZXMpOgogICAgICAgIG4gPSBsZW4ocCkKICAgICAgICBpZiBpZHggPT0gMDoKICAgICAgICAgICAgb3V0WzpuXSArPSBwCiAgICAgICAgICAgIHBvcyArPSBuIC0geGYKICAgICAgICBlbHNlOgogICAgICAgICAgICBoZWFkID0gbWluKHhmLCBuKQogICAgICAgICAgICB3ID0gbnAubGluc3BhY2UoMC4wLCAxLjAsIGhlYWQsIGR0eXBlPW5wLmZsb2F0MzIpCiAgICAgICAgICAgIG91dFtwb3M6cG9zICsgaGVhZF0gPSBvdXRbcG9zOnBvcyArIGhlYWRdICogKDEgLSB3KSArIHBbOmhlYWRdICogdwogICAgICAgICAgICBvdXRbcG9zICsgaGVhZDpwb3MgKyBuXSArPSBwW2hlYWQ6XQogICAgICAgICAgICBwb3MgKz0gbiAtIHhmCiAgICBvdXRfcGF0aCA9IG1hbi5nZXQoJ291dCcpIG9yICdzaW5nLndhdicKICAgIHdyaXRlX3dhdihvdXRfcGF0aCwgc3Jfb3V0LCBvdXQpCiAgICBwcmludChqc29uLmR1bXBzKHsnb2snOiBUcnVlLCAnb3V0Jzogb3V0X3BhdGgsICdzcic6IHNyX291dCwgJ3NlY29uZHMnOiByb3VuZChsZW4ob3V0KSAvIHNyX291dCwgMyksCiAgICAgICAgICAgICAgICAgICAgICAnbm90ZXMnOiBsZW4ocGllY2VzKSwgJ2RldGFpbCc6IGRldH0sIGVuc3VyZV9hc2NpaT1GYWxzZSkpCiAgICByZXR1cm4gMAoKCmRlZiBtYWluKCk6CiAgICBpZiBsZW4oc3lzLmFyZ3YpID49IDIgYW5kIHN5cy5hcmd2WzFdID09ICctLXByb2JlJzoKICAgICAgICByZXR1cm4gY21kX3Byb2JlKHN5cy5hcmd2WzJdLCBzeXMuYXJndlszXSkKICAgIGlmIGxlbihzeXMuYXJndikgPCAyOgogICAgICAgIHByaW50KGpzb24uZHVtcHMoeydvayc6IEZhbHNlLCAnZXJyb3InOiAnbmVlZCBtYW5pZmVzdCBwYXRoJ30pKQogICAgICAgIHJldHVybiAxCiAgICByZXR1cm4gY21kX3JlbmRlcihzeXMuYXJndlsxXSkKCgppZiBfX25hbWVfXyA9PSAnX19tYWluX18nOgogICAgc3lzLmV4aXQobWFpbigpKQo="

export default Singer
