#!/usr/bin/env node
/*
 * 语音参数「真机自测」：直连本机 GPT-SoVITS（默认 127.0.0.1:9880），
 * 用 lib/voice.js 的**新代码路径**（逐句合成 + 句间静音 + speed_factor）跑一遍，
 * 回答四个问题：
 *   1) 0.93 真的让音频变长了吗？（时长比 ≈ 1/0.93 = 1.0753，允许 ±3%）
 *   2) 拼接产物里真的插了 pauseMs 那么长的静音吗？（按字节精确比对）
 *   3) 单句输入不会被切段吧？（parts 必须 = 1）
 *   4) 同一句话第二次调用命中缓存、不再打服务端吧？（stats.cached +1）
 *
 * 和 tools/voice-param-selftest.mjs 的分工：
 *   - voice-param-selftest.mjs：假服务端，纯逻辑单测，任何机器都能跑，不进 9880。
 *   - 本文件：真服务端，验证「真实下发的请求体 + 真实产物的字节结构」，需要 9880 在线。
 *
 * 用法：
 *   node tools/voice-live-selftest.mjs                 # 参数从 cordis.patch.yml 读
 *   node tools/voice-live-selftest.mjs --pause 50      # 覆盖句间静音毫秒
 *   node tools/voice-live-selftest.mjs --speed 0.93 --pairs 5
 *   node tools/voice-live-selftest.mjs --gen           # 改测「装载副本」里的 voice.js
 *   node tools/voice-live-selftest.mjs --url http://127.0.0.1:9880
 */
import { readFileSync, mkdirSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'

const WORKSPACE = 'G:\\Molly'
const SOURCE_VOICE = path.join(WORKSPACE, 'qq-whale', 'plugin', 'dsh-qq-whale', 'lib', 'voice.js')
const PROFILE_PKG = 'C:\\Users\\example\\.dsh\\profiles\\desktop\\node_modules\\dsh-qq-whale'
const PATCH_YML = 'C:\\Users\\example\\.dsh\\profiles\\desktop\\cordis.patch.yml'
const OUT_DIR = path.join(WORKSPACE, 'out', '_voice_live')
const REPORT = path.join(WORKSPACE, 'out', 'voice-live-selftest.json')

const RATIO_TEXT =
  '主人，今天也要好好吃饭呀。晚饭别又拿泡面糊弄自己，那个东西吃多了对身体不好，我看了会担心的。'
const SINGLE_TEXT = '主人，今天也要好好吃饭呀。'
const DOUBLE_TEXT = '主人，今天也要好好吃饭呀。别忘了早点睡觉哦！'

const args = parseArgs(process.argv.slice(2))
const cfg = readPatchYml(PATCH_YML)
const result = { at: new Date().toISOString(), checks: [], ok: true }
const checks = []

function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--gen') out.gen = true
    else if (a === '--speed') out.speed = Number(argv[++i])
    else if (a === '--pause') out.pause = Number(argv[++i])
    else if (a === '--pairs') out.pairs = Number(argv[++i])
    else if (a === '--url') out.url = argv[++i]
  }
  return out
}

/** 从插件配置里读语音段（只解析需要的几个标量键，别引 yaml 依赖）。 */
function readPatchYml(file) {
  const text = readFileSync(file, 'utf8')
  const grab = (key) => {
    const m = new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, 'm').exec(text)
    if (!m) return ''
    return m[1].replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '').trim()
  }
  return {
    voiceSpeed: Number(grab('voiceSpeed')) || 1,
    voicePauseMs: Number(grab('voicePauseMs')) || 0,
    voiceSovitsUrl: grab('voiceSovitsUrl') || 'http://127.0.0.1:9880',
    voiceRefAudio: grab('voiceRefAudio') || '',
    voicePromptText: grab('voicePromptText') || '',
  }
}

/** 找最新的 gen-<rev>（装载副本）。按目录名里的 rev 排不了序，按 boot-health.json 的 gen 优先。 */
function newestGenDir() {
  try {
    const health = JSON.parse(readFileSync(path.join(WORKSPACE, 'data', 'qq-whale', 'boot-health.json'), 'utf8'))
    if (health?.gen && readdirSync(PROFILE_PKG).includes(health.gen)) return path.join(PROFILE_PKG, health.gen)
  } catch {}
  const dirs = readdirSync(PROFILE_PKG)
    .filter((d) => d.startsWith('gen-') && statSync(path.join(PROFILE_PKG, d, 'voice.js'), { throwIfNoEntry: false }))
    .map((d) => ({ d, m: statSync(path.join(PROFILE_PKG, d, 'voice.js')).mtimeMs }))
    .sort((a, b) => b.m - a.m)
  return dirs.length ? path.join(PROFILE_PKG, dirs[0].d) : ''
}

/** 读 wav 的 byteRate / blockAlign / data 负载长度。 */
function wavInfo(buf) {
  if (!buf || buf.length < 44) return null
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null
  let byteRate = 0
  let blockAlign = 2
  let dataSize = 0
  for (let pos = 12; pos + 8 <= Math.min(buf.length, 8192); ) {
    const id = buf.toString('ascii', pos, pos + 4)
    const size = buf.readUInt32LE(pos + 4)
    if (id === 'fmt ' && pos + 20 <= buf.length) {
      byteRate = buf.readUInt32LE(pos + 16) // fmt 负载 +8 = byteRate
      blockAlign = buf.readUInt16LE(pos + 20) || 2 // fmt 负载 +12 = blockAlign
    } else if (id === 'data') {
      dataSize = Math.min(size, buf.length - pos - 8)
      break
    }
    pos += 8 + size + (size & 1)
  }
  return byteRate && dataSize ? { byteRate, blockAlign, dataSize, seconds: dataSize / byteRate } : null
}

const APPEND = (name, ok, detail) => {
  checks.push({ name, ok, detail })
  result.checks = checks
  if (!ok) result.ok = false
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name} — ${detail}`)
}

/** 拦 global.fetch，记录每次 /tts 的请求体与响应字节。 */
function interceptFetch(sink) {
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const resp = await real(url, init)
    const buf = Buffer.from(await resp.arrayBuffer())
    let body = null
    try { body = init?.body ? JSON.parse(init.body) : null } catch {}
    sink.push({ url: String(url), body, bytes: buf.length, info: wavInfo(buf), status: resp.status })
    return new Response(buf, { status: resp.status, headers: { 'content-type': resp.headers.get('content-type') || 'audio/wav' } })
  }
  return () => { globalThis.fetch = real }
}

async function makeMaker(VoiceMaker, MOLLY_PROMPT_TEXT, name, { speed, pauseMs }) {
  const dir = path.join(OUT_DIR, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return new VoiceMaker({
    dir,
    backend: 'sovits',
    sovitsUrl: SOVITS_URL,
    refAudio: REF_AUDIO,
    promptText: cfg.voicePromptText || MOLLY_PROMPT_TEXT,
    promptLang: 'zh',
    fallbackEdge: false, // 兜底关掉：失败就是失败，别混进 edge 产物
    timeoutMs: 120000,
    maxChars: 300,
    maxSeconds: 0, // 不限时长，方便测比例
    speed,
    pauseMs,
    logger: () => {},
  })
}

async function synth(vm, text) {
  const started = Date.now()
  const r = await vm.synthesize(text)
  const ms = Date.now() - started
  if (!r?.file) return { ...(r || {}), ms }
  // maxSeconds=0 时 _durationGuard 返回 null，seconds 会是 null —— 自测自己从 wav 头算。
  let seconds = r.seconds
  if (seconds == null) {
    try { seconds = wavInfo(readFileSync(r.file))?.seconds ?? null } catch {}
  }
  return { ...r, ms, seconds }
}

const mean = (x) => (x.length ? x.reduce((s, v) => s + v, 0) / x.length : 0)

const VOICE_PATH = args.gen ? path.join(newestGenDir(), 'voice.js') : SOURCE_VOICE
const SOVITS_URL = String(args.url || cfg.voiceSovitsUrl || 'http://127.0.0.1:9880').replace(/\/+$/, '')
const REF_AUDIO = cfg.voiceRefAudio

console.log(`voice.js   : ${VOICE_PATH}${args.gen ? '（装载副本）' : '（源码）'}`)
console.log(`服务端     : ${SOVITS_URL}`)
console.log(`参考音频   : ${REF_AUDIO}`)
console.log(`参数       : speed=${args.speed ?? cfg.voiceSpeed} pauseMs=${args.pause ?? cfg.voicePauseMs}\n`)

if (!REF_AUDIO) {
  console.error('配置里没读到 voiceRefAudio，先在 cordis.patch.yml 配好参考音频再跑。')
  process.exit(2)
}
if (!VOICE_PATH || !readFileSync(VOICE_PATH, { throwIfNoEntry: false })) {
  console.error(`找不到 voice.js：${VOICE_PATH}`)
  process.exit(2)
}

const mod = await import('file:///' + VOICE_PATH.replace(/\\/g, '/'))
const { VoiceMaker, MOLLY_PROMPT_TEXT, splitVoiceSentences } = mod
const SPEED = Number(args.speed ?? cfg.voiceSpeed ?? 0.93)
const PAUSE = Number(args.pause ?? cfg.voicePauseMs ?? 0)
const PAIRS = Math.max(2, Number(args.pairs) || 5)
const TARGET_RATIO = 1 / SPEED
const LO = TARGET_RATIO * 0.97
const HI = TARGET_RATIO * 1.03

// —— 0. 服务端活着吗 ——
try {
  const ping = await fetch(`${SOVITS_URL}/`)
  APPEND('服务端可达', true, `${SOVITS_URL} → HTTP ${ping.status}`)
} catch (e) {
  APPEND('服务端可达', false, `${SOVITS_URL} 连接失败：${e.message}`)
  writeReport()
  process.exit(1)
}

// —— 1. 时长比：1.0 vs 配置的 speed ——
const batches = []
let ratioOk = false
for (let attempt = 0; attempt < 2 && !ratioOk; attempt++) {
  const slow = []
  const fast = []
  const bodies = []
  const sink = []
  const restore = interceptFetch(sink)
  try {
    for (let i = 0; i < PAIRS; i++) {
      // 交替跑：同一条文本，一次 1.0、一次 SPEED，噪声在两边均摊
      const vmFast = await makeMaker(VoiceMaker, MOLLY_PROMPT_TEXT, `ratio-${attempt}-${i}-fast`, { speed: 1.0, pauseMs: 0 })
      const a = await synth(vmFast, RATIO_TEXT)
      const vmSlow = await makeMaker(VoiceMaker, MOLLY_PROMPT_TEXT, `ratio-${attempt}-${i}-slow`, { speed: SPEED, pauseMs: 0 })
      const b = await synth(vmSlow, RATIO_TEXT)
      if (!a.file || !b.file) throw new Error(`合成失败 fast=${JSON.stringify(a)} slow=${JSON.stringify(b)}`)
      fast.push(a.seconds)
      slow.push(b.seconds)
    }
  } finally {
    restore()
  }
  for (const c of sink) if (c.body) bodies.push(c.body.speed_factor)
  const ratio = mean(slow) / mean(fast)
  batches.push({ attempt, fast, slow, ratio })
  ratioOk = ratio >= LO && ratio <= HI
  console.log(
    `        批次${attempt + 1}: 1.0 → ${fast.map((v) => v.toFixed(2)).join('/')}s | ` +
      `${SPEED} → ${slow.map((v) => v.toFixed(2)).join('/')}s | ratio=${ratio.toFixed(4)}（目标 ${TARGET_RATIO.toFixed(4)}，容许 ${LO.toFixed(4)}–${HI.toFixed(4)}）`,
  )
  const wantFast = bodies.filter((v) => v === 1).length
  const wantSlow = bodies.filter((v) => Math.abs(v - SPEED) < 1e-9).length
  APPEND(
    `请求体里的 speed_factor 与实例一致（批次${attempt + 1}）`,
    wantFast === PAIRS && wantSlow === PAIRS,
    `1.0 出现 ${wantFast} 次、${SPEED} 出现 ${wantSlow} 次（各应为 ${PAIRS} 次）`,
  )
}
const best = batches.find((b) => b.ratio >= LO && b.ratio <= HI) || batches[batches.length - 1]
APPEND(
  '0.93 时长比 ≈ 1.0753 ±3%',
  ratioOk,
  `实测 ratio=${(best.ratio || 0).toFixed(4)}（${best.attempt + 1}/${batches.length} 批次达标；目标 ${TARGET_RATIO.toFixed(4)}）`,
)

// —— 2. 单句不裂 ——
{
  const sink = []
  const restore = interceptFetch(sink)
  let parts = 0
  let result1 = null
  try {
    const vm = await makeMaker(VoiceMaker, MOLLY_PROMPT_TEXT, 'single', { speed: SPEED, pauseMs: PAUSE })
    result1 = await synth(vm, SINGLE_TEXT)
    parts = vm.stats.lastParts
  } finally {
    restore()
  }
  const sentences = splitVoiceSentences(SINGLE_TEXT)
  APPEND(
    '单句输入不裂成多段',
    Boolean(result1?.file) && parts === 1 && sink.length === 1 && sentences.length === 1,
    `parts=${parts}，请求 ${sink.length} 次，切句结果 ${JSON.stringify(sentences)}`,
  )
}

// —— 3. 拼接静音：字节级精确 ——
{
  const sink = []
  const restore = interceptFetch(sink)
  let out = null
  let parts = 0
  try {
    const vm = await makeMaker(VoiceMaker, MOLLY_PROMPT_TEXT, 'double', { speed: SPEED, pauseMs: PAUSE })
    out = await synth(vm, DOUBLE_TEXT)
    parts = vm.stats.lastParts
  } finally {
    restore()
  }
  const info = out?.file ? wavInfo(readFileSync(out.file)) : null
  const partsData = sink.map((c) => c.info?.dataSize || 0)
  const firstByteRate = sink[0]?.info?.byteRate || 0
  const align = Math.max(2, sink[0]?.info?.blockAlign || 2)
  const wantSilence = PAUSE > 0 ? Math.max(align, Math.round((firstByteRate * PAUSE) / 1000 / align) * align) : 0
  const sumParts = partsData.reduce((s, v) => s + v, 0)
  const expected = sumParts + wantSilence * (sink.length - 1)
  APPEND(
    `拼接产物含 ${PAUSE}ms 静音（${wantSilence} 字节）`,
    Boolean(info) && parts === sink.length && sink.length >= 2 && info.dataSize === expected,
    `parts=${parts}，请求 ${sink.length} 次，子段 ${partsData.join('+')} B + 静音 ${wantSilence}×(n-1) = 期望 ${expected} B，实际 dataSize=${info?.dataSize} B`,
  )
}

// —— 4. 缓存命中 ——
{
  const sink = []
  const restore = interceptFetch(sink)
  let second = null
  let cachedBefore = 0
  let cachedAfter = 0
  let callsSecond = 0
  try {
    const vm = await makeMaker(VoiceMaker, MOLLY_PROMPT_TEXT, 'cache', { speed: SPEED, pauseMs: PAUSE })
    await synth(vm, DOUBLE_TEXT)
    cachedBefore = vm.stats.cached
    const callsBefore = sink.length
    second = await synth(vm, DOUBLE_TEXT)
    callsSecond = sink.length - callsBefore
    cachedAfter = vm.stats.cached
  } finally {
    restore()
  }
  APPEND(
    '同文本二次调用命中缓存',
    Boolean(second?.cached) && cachedAfter === cachedBefore + 1 && callsSecond === 0,
    `第二次 cached=${second?.cached}，stats.cached ${cachedBefore} → ${cachedAfter}，新增请求 ${callsSecond} 次`,
  )
}

console.log(`\n结果：${result.ok ? '全部通过' : '有检查项未通过'}`)
writeReport()
process.exit(result.ok ? 0 : 1)

function writeReport() {
  try {
    mkdirSync(path.dirname(REPORT), { recursive: true })
    writeFileSync(
      REPORT,
      JSON.stringify(
        {
          ...result,
          voicePath: VOICE_PATH,
          url: SOVITS_URL,
          speed: SPEED,
          pauseMs: PAUSE,
          pairs: PAIRS,
          targetRatio: TARGET_RATIO,
          batches: batches.map((b) => ({ attempt: b.attempt, ratio: b.ratio, fast: b.fast, slow: b.slow })),
        },
        null,
        2,
      ) + '\n',
      'utf8',
    )
    console.log(`报告：${REPORT}`)
  } catch (e) {
    console.error(`写报告失败：${e.message}`)
  }
}
