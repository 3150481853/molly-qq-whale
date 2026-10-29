/**
 * test-gif-note.mjs —— 动图「拆帧拼图」的帧数与说明措辞门禁。
 *
 * 背景（2026-10-30，主人）：「准确来说她说的是『这六格』，给 molly 增加帧数（格子）
 * 并添加约束词吧」；随后定稿（2026-10-29）：**12 帧、4 列、单帧 240px**——
 * 拼图约 980 px 宽（不触发上游缩放），12 格约 1.1k 视觉 token，比 9 帧 @320 还便宜。
 *
 * 改动位置：
 *   1. `lib/gif-frames.js` 的 `GIF_DEFAULTS`：frames 12 / columns 4 / frameWidth 240；
 *   2. `lib/main.js` 的 `DEFAULTS.gifFramesCount/Columns/FrameWidth` 同上；
 *   3. `lib/engine-context.js` 的 `gifNoteText()`：写明「这是一张动图」并禁止数格子；
 *   4. `lib/persona.js` 人设里钉一句同样的约束。
 *
 * 这个测试只看「说给模型听的那句话」有没有真的带上约束，不依赖 Python/Pillow。
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { gifNoteText } from '../plugin/dsh-qq-whale/lib/engine-context.js'
import { GIF_DEFAULTS } from '../plugin/dsh-qq-whale/lib/gif-frames.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB = path.resolve(HERE, '..', 'plugin', 'dsh-qq-whale', 'lib')
const read = (name) => readFileSync(path.join(LIB, name), 'utf8')

let pass = 0
let fail = 0
function ok(name, fn) {
  try {
    fn()
    pass += 1
    console.log(`  ok   ${name}`)
  } catch (err) {
    fail += 1
    console.log(`  FAIL ${name}\n       ${err?.message || err}`)
  }
}

console.log('# 动图拼图：帧数与约束词')

ok('GIF_DEFAULTS.frames 默认 12 帧', () => {
  assert.equal(GIF_DEFAULTS.frames, 12)
})

ok('GIF_DEFAULTS.columns 是 4 列（12 帧 = 4×3）', () => {
  assert.equal(GIF_DEFAULTS.columns, 4)
})

ok('GIF_DEFAULTS.frameWidth 是 240（拼图 ≈980px 宽）', () => {
  assert.equal(GIF_DEFAULTS.frameWidth, 240)
})

ok('说明里明确「这是一张动图」', () => {
  assert.match(gifNoteText(12), /一张动图/)
})

ok('说明里带上真实的帧序号（1/12 … 12/12）', () => {
  const text = gifNoteText(12)
  assert.ok(text.includes('1/12'), '缺 1/12')
  assert.ok(text.includes('12/12'), '缺 12/12')
})

ok('说明里禁止数格子/数张数', () => {
  const text = gifNoteText(12)
  assert.match(text, /不要说/)
  for (const word of ['这几张', '这几格', '几帧', '拼图']) {
    assert.ok(text.includes(word), `缺「${word}」`)
  }
})

ok('帧数变化时序号跟着变（4 帧）', () => {
  const text = gifNoteText(4)
  assert.ok(text.includes('1/4'), '缺 1/4')
  assert.ok(text.includes('4/4'), '缺 4/4')
  assert.ok(!text.includes('12/12'), '不该出现 12/12')
})

ok('帧数非法时兜底成 1 帧而不是 NaN', () => {
  assert.ok(!gifNoteText(0).includes('NaN'))
  assert.ok(!gifNoteText('x').includes('NaN'))
})

ok('buildMessages 真的用了 gifNoteText', () => {
  const src = read('engine-context.js')
  assert.match(src, /const gifNote = gifFrames > 1 \? gifNoteText\(gifFrames\) : ''/)
})

ok('main.js 的 DEFAULTS 与 GIF_DEFAULTS 一致（12/4/240）', () => {
  const src = read('main.js')
  assert.match(src, /gifFramesCount: 12,/)
  assert.match(src, /gifFramesColumns: 4,/)
  assert.match(src, /gifFrameWidth: 240,/)
})

ok('人设里钉了「不要数几张几格」', () => {
  const src = read('persona.js')
  assert.match(src, /不要数"几张""几格"/)
})

ok('gif-frames.js 的默认帧数与 main.js 一致', () => {
  const src = read('gif-frames.js')
  assert.match(src, /frames: 12,/)
})

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
