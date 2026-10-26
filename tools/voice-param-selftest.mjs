#!/usr/bin/env node
/**
 * 语音参数自测（2026-10-26，主人 m00855 要求「0.93 倍速 + 句间 0.05 秒，和 Molly 现有一致」）。
 *
 * 目的：证明 lib/voice.js 里补回的 speed / pauseMs 真的生效、且没把老行为搞坏。
 * 直连本机 GPT-SoVITS（默认 http://127.0.0.1:9880），只写 ${MOLLY_ROOT}\out\_voice_param_test\。
 *
 * 用法：
 *   node tools\voice-param-selftest.mjs            # 默认连本机 9880
 *   node tools\voice-param-selftest.mjs --url http://127.0.0.1:9880 --dir ${MOLLY_ROOT}\out\_voice_param_test
 *
 * 断言（任一条不满足即 exit 1）：
 *   1) speed 0.93 与 1.0 的产物时长比 ≈ 1/0.93（±3%）；
 *   2) pauseMs=50 + 多句 → 产物里出现 >= 句数-1 段 50ms 的 PCM 全零静音；
 *   3) 单句输入不触发拼接（stats.lastParts 不增长），产物仍是可解析 wav；
 *   4) 超过 6 句退回整段合成（lastParts 不增长）；
 *   5) 同一文本二次调用命中缓存（stats.cached 增加）。
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { VoiceMaker, splitVoiceSentences, normalizeSpeakText } from '../plugin/dsh-qq-whale/lib/voice.js'

const DEFAULTS = {
  url: process.env.MOLLY_SOVITS_URL || 'http://127.0.0.1:9880',
  dir: 'G:\\Molly\\out\\_voice_param_test',
  ref: 'G:\\Molly\\data\\qq-whale\\voice-ref\\molly-ref.wav',
  prompt: '想的美，今天本鱼才是老大，你喝白开水去！',
}

function parseArgs(argv) {
  const out = { ...DEFAULTS }
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i]
    const v = argv[i + 1]
    if (k === '--url' && v) out.url = v
    else if (k === '--dir' && v) out.dir = v
    else if (k === '--ref' && v) out.ref = v
    else if (k === '--prompt' && v) out.prompt = v
    else continue
    i++
  }
  return out
}

const opts = parseArgs(process.argv)
const failures = []
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? `  ${detail}` : ''}`)
  if (!ok) failures.push(name)
}

/** 读 wav 的 fmt/data（与 voice.js 同口径的最小实现，避免测试和实现互相掩盖）。 */
function readWav(buf) {
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

function secondsOf(wav) {
  const w = readWav(wav)
  return w ? w.data.length / w.byteRate : null
}

/** 最长的连续全零段（字节数）与「达到某个长度的零段」个数。 */
function zeroRuns(data, atLeast) {
  let cur = 0
  let longest = 0
  let hits = 0
  for (let i = 0; i < data.length; i++) {
    if (data[i] === 0) {
      cur++
      if (cur === atLeast) hits++
      if (cur > longest) longest = cur
    } else cur = 0
  }
  return { longest, hits }
}

function maker({ speed, pauseMs }) {
  return new VoiceMaker({
    dir: opts.dir,
    backend: 'sovits',
    sovitsUrl: opts.url,
    refAudio: opts.ref,
    promptText: opts.prompt,
    promptLang: 'zh',
    speed,
    pauseMs,
    timeoutMs: 120000,
    maxChars: 220,
    maxSeconds: 0,
    logger: (lvl, msg) => console.log(`    [voice:${lvl}] ${msg}`),
  })
}

async function synthOf(vm, text) {
  const t0 = Date.now()
  const r = await vm.synthesize(text)
  const wall = (Date.now() - t0) / 1000
  if (!r) throw new Error(`合成失败：${text.slice(0, 20)}…（${vm.stats.lastError || '无产物'}）`)
  const buf = await fs.readFile(r.file)
  return { r, buf, seconds: secondsOf(buf), wall }
}

const TEXT3 = '主人，大半夜不睡觉刷手机，明天起不来别怪我。我先说好，早上叫你三次。起不来就没早饭了。'
const TEXT1 = '主人，今天也要好好吃饭呀。'
const TEXT8 = Array.from({ length: 8 }, (_, i) => `这是第${i + 1}句用来测超限退回的话`).join('。') + '。'

async function main() {
  // 每次从干净目录开始：否则上一轮留下的缓存会让「是否真的合成了」这类断言失真（2026-10-26 栽过）。
  await fs.rm(opts.dir, { recursive: true, force: true }).catch(() => {})
  await fs.mkdir(opts.dir, { recursive: true })
  console.log(`GPT-SoVITS: ${opts.url}`)
  console.log(`语音目录: ${opts.dir}`)
  console.log(`参考音频: ${opts.ref}`)
  console.log(`切句预览: ${JSON.stringify(splitVoiceSentences(TEXT3))}\n`)

  // 1) 语速：分两步验，避开「随机韵律」这个坑
  //  (a) 拦 fetch 看请求体里 speed_factor 是否为配置值 —— 最硬，不受采样影响；
  //  (b) 端到端用 0.7（期望 +43%）证明服务端真的照着做了 —— 0.93 只有 ~7%，
  //      而 GPT-SoVITS 同文本每次合成时长会随机漂 ±4~7%（2026-10-26 实测：
  //      T1 在 1.0 下 10.38/10.62s，0.93 下 10.30/9.94s，噪声足以淹没 7%），
  //      所以 0.93 的单次时长比**不能**当断言用。
  console.log('[1] speed_factor 请求体 / 端到端生效性')
  const captured = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('/tts') && init?.body) {
      try { captured.push(JSON.parse(init.body).speed_factor) } catch { captured.push('bad-json') }
    }
    return realFetch(url, init)
  }
  try {
    const at093 = await synthOf(maker({ speed: 0.93, pauseMs: 0 }), TEXT1)
    check('请求体 speed_factor 按配置发出', captured.includes(0.93), `捕获到 ${JSON.stringify(captured)}`)
    const base = await synthOf(maker({ speed: 1.0, pauseMs: 0 }), TEXT1)
    const slow = await synthOf(maker({ speed: 0.7, pauseMs: 0 }), TEXT1)
    const ratio = slow.seconds / base.seconds
    console.log(`    1.00 → ${base.seconds.toFixed(2)}s，0.93 → ${at093.seconds.toFixed(2)}s，0.70 → ${slow.seconds.toFixed(2)}s`)
    console.log(`    0.7/1.0 时长比 ${ratio.toFixed(3)}（期望 ≈1.43）`)
    check('0.7 端到端明显更慢', ratio >= 1.25, `实际比 ${ratio.toFixed(3)}`)
  } finally {
    globalThis.fetch = realFetch
  }

  // 2) 句间静音
  console.log('[2] pauseMs=50 多句拼接是否真的插了静音')
  const vm2 = maker({ speed: 0.93, pauseMs: 50 })
  const c = await synthOf(vm2, TEXT3)
  const w = readWav(c.buf)
  const align = Math.max(2, w.blockAlign || 2)
  const silenceBytes = Math.max(align, Math.round((w.byteRate * 50) / 1000 / align) * align)
  const runs = zeroRuns(w.data, silenceBytes)
  const parts = splitVoiceSentences(TEXT3).length
  console.log(`    产物 ${c.seconds.toFixed(2)}s，${c.buf.length}B，byteRate=${w.byteRate}，块对齐=${align}`)
  console.log(`    50ms 静音应为 ${silenceBytes}B；最长零段 ${runs.longest}B，达到该长度的零段 ${runs.hits} 处（需 ≥ ${parts - 1}）`)
  check('句间静音段数达标', runs.hits >= parts - 1)
  check('拼接分数被记录', vm2.stats.lastParts === parts, `lastParts=${vm2.stats.lastParts}`)

  // 2b) 拼接逻辑的精确单测：用假 _sovits 产出已知长度的 wav，
  //     断言「拼接后 data 长度 = 各句之和 + (句数-1)×静音字节」且静音落在正确边界上。
  //     端到端那一步只能证明「有很多零」，证明不了是我们插的；这一步才是硬证据。
  console.log('[2b] 拼接逻辑精确单测（假 _sovits，不连服务）')
  const SEG = Buffer.alloc(12800, 0x11) // 0.2s @ 64k/2
  const fakeWav = () => {
    const head = Buffer.alloc(44)
    head.write('RIFF', 0, 'ascii')
    head.writeUInt32LE(36 + SEG.length, 4)
    head.write('WAVEfmt ', 8, 'ascii')
    head.writeUInt32LE(16, 16)
    head.writeUInt16LE(1, 20)
    head.writeUInt16LE(1, 22)
    head.writeUInt32LE(64000, 24)
    head.writeUInt32LE(64000, 28)
    head.writeUInt16LE(2, 32)
    head.writeUInt16LE(16, 34)
    head.write('data', 36, 'ascii')
    head.writeUInt32LE(SEG.length, 40)
    return Buffer.concat([head, SEG])
  }
  const vmFake = maker({ speed: 0.93, pauseMs: 50 })
  const calls = []
  vmFake._sovits = async (text, file) => {
    calls.push(text)
    await fs.writeFile(file, fakeWav())
    return null
  }
  const fakeOut = path.join(opts.dir, 'fake-join.wav')
  const fakeErr = await vmFake._sovitsSynth(TEXT3, fakeOut)
  const fakeBuf = await fs.readFile(fakeOut)
  const silence = Math.round((64000 * 50) / 1000) // 3200B，块对齐 2 正好整除
  const expectBytes = SEG.length * calls.length + silence * (calls.length - 1)
  console.log(`    子句数=${calls.length}，data 期望 ${expectBytes}B，实际 ${readWav(fakeBuf).data.length}B，静音每段 ${silence}B`)
  check('假合成无报错', fakeErr === null)
  check('data 长度精确等于 各句之和+静音', readWav(fakeBuf).data.length === expectBytes)
  const d2 = readWav(fakeBuf).data
  let boundariesOk = true
  for (let i = 1; i < calls.length; i++) {
    const at = i * SEG.length + (i - 1) * silence
    const seg = d2.subarray(at, at + silence)
    if (seg.length !== silence || seg.some((x) => x !== 0)) boundariesOk = false
  }
  check('静音段恰好落在句间边界', boundariesOk)
  await fs.rm(fakeOut, { force: true })

  // 3) 单句不拼接
  console.log('[3] 单句输入不触发拼接')
  const vm3 = maker({ speed: 0.93, pauseMs: 50 })
  const d = await synthOf(vm3, TEXT1)
  console.log(`    ${d.seconds.toFixed(2)}s，lastParts=${vm3.stats.lastParts}，切句数=${splitVoiceSentences(TEXT1).length}`)
  // lastParts=1 表示「只请求了一次、没有拼接」（见 voice.js 注释：没走拼接也记 1 段）
  check('单句未裂成多段', vm3.stats.lastParts === 1 && splitVoiceSentences(TEXT1).length === 1)
  check('单句产物可解析', d.seconds > 0.2)

  // 4) 超限退回
  console.log('[4] 8 句 > 上限 6 → 退回整段合成')
  const vm4 = maker({ speed: 0.93, pauseMs: 50 })
  const e = await synthOf(vm4, TEXT8)
  console.log(`    ${e.seconds.toFixed(2)}s，lastParts=${vm4.stats.lastParts}，切句数=${splitVoiceSentences(TEXT8).length}`)
  check('超限未走拼接', vm4.stats.lastParts === 1)

  // 5) 缓存
  console.log('[5] 同文本二次调用命中缓存')
  const before = vm2.stats.cached
  const again = await vm2.synthesize(TEXT3)
  check('命中缓存', !!again?.cached && vm2.stats.cached === before + 1, `cached ${before} → ${vm2.stats.cached}`)

  // 6) 语音文本规范化（英文腔修复，2026-10-26 主人截图：`2K 60Hz` 被整句念成英文）
  console.log('[6] 语音文本规范化（只改念出来的那份）')
  const normCases = [
    ['但你都叫了我2K 60Hz', '但你都叫了我两K 六十赫兹'],
    ['1080P 的屏，16GB 内存', '一零八零P 的屏，十六个G 内存'],
    ['60~90Hz 之间', '六十到九十赫兹 之间'],
    ['30-144fps', '三十到一百四十四帧'],
    ['下载 50ms，跑 3min，30℃', '下载 五十毫秒，跑 三分钟，三十摄氏度'],
    ['分辨率2k，2.5K，4K', '分辨率两K，二点五K，四K'],
    ['没问题，就是不想说话', '没问题，就是不想说话'],
  ]
  for (const [raw, want] of normCases) {
    const got = normalizeSpeakText(raw)
    check(`规范化 ${JSON.stringify(raw)}`, got === want, got === want ? '' : `→ ${JSON.stringify(got)}（期望 ${JSON.stringify(want)}）`)
  }
  const urlCase = normalizeSpeakText('看 https://linux.do/t/topic/1 这个')
  check('网址被剔除', !/http/.test(urlCase), `→ ${JSON.stringify(urlCase)}`)

  // 6b) 端到端证明 synthesize() 送出去的是规范化后的文本（拦 _sovits，不连服务）
  const vm6 = maker({ speed: 0.93, pauseMs: 0 })
  const seen = []
  vm6._sovits = async (text, file) => {
    seen.push(text)
    await fs.writeFile(file, Buffer.concat([Buffer.alloc(44), Buffer.alloc(6400, 0x22)]))
    return null
  }
  await vm6.synthesize('但你都叫了我2K 60Hz')
  check('送进 TTS 的文本已规范化', seen.length === 1 && seen[0].includes('两K') && !seen[0].includes('2K'), `实际 ${JSON.stringify(seen[0] || null)}`)

  console.log('')
  if (failures.length) {
    console.error(`失败 ${failures.length} 项：${failures.join('、')}`)
    process.exit(1)
  }
  console.log('全部通过。产物在 ' + opts.dir)
}

main().catch((e) => {
  console.error('自测异常：', e?.stack || e?.message || e)
  process.exit(1)
})
