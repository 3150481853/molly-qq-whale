// 唱歌 OOM 兜底（2026-11-14，主人 m03582）
//
// 现场：群里收到「没弄成（退出码 1： x, _ = self.attention(q, k, v, mask=attn_mask)
// | ^^^^^^^^^^^^^^^^），换一首吧。」—— torch 注意力层分配失败，把 traceback 甩给主人。
// 这里只测纯逻辑：错误分类 + 「内存不够就砍短重跑一次」，不真起 python。

import assert from 'node:assert/strict'
import { BiliSinger, isMemoryish } from '../plugin/dsh-qq-whale/lib/bili-sing.js'

let pass = 0
let fail = 0
async function t(name, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  ok   ${name}`)
  } catch (err) {
    fail += 1
    console.log(`  FAIL ${name}\n       ${err?.message || err}`)
  }
}

console.log('isMemoryish：')

await t('torch 的 CPU 分配器报错算内存不够', () => {
  assert.equal(isMemoryish('RuntimeError: [enforce fail at alloc_cpu.cpp] data. DefaultCPUAllocator: not enough memory'), true)
})

await t('直接说 out of memory 也算', () => {
  assert.equal(isMemoryish('RuntimeError: out of memory'), true)
})

await t('Everything 的 1455 也算', () => {
  assert.equal(isMemoryish('mem_virtual_alloc(): Fatal error: out of memory, size: 000000000000040f, error: 1455'), true)
})

await t('MemoryError / bad allocation 也算', () => {
  assert.equal(isMemoryish('MemoryError'), true)
  assert.equal(isMemoryish('std::bad_alloc'), false) // 不在关键词里，别乱猜
  assert.equal(isMemoryish('bad allocation'), true)
})

await t('找不到歌、网络错误不算', () => {
  assert.equal(isMemoryish('没有找到这首歌'), false)
  assert.equal(isMemoryish('httpx.ConnectTimeout'), false)
  assert.equal(isMemoryish(''), false)
})

console.log('_singWithFallback：')

function makeSinger(results, { maxSec = 110 } = {}) {
  const s = new BiliSinger({ python: '', script: '', maxSec, timeoutMs: 1000 })
  s.calls = []
  s._run = async ({ maxSec: sec }) => {
    s.calls.push(sec)
    return results.shift()
  }
  return s
}

const oom = { ok: false, memoryHint: true, error: '内存不够，渲染崩了' }
const ok = { ok: true, file: 'C:/x.wav', seconds: 45 }

await t('内存不够：砍短到一半重跑一次，成功就带 shortened', async () => {
  const s = makeSinger([oom, ok])
  const res = await s._singWithFallback({ query: 'モス', bv: '', shift: '' })
  assert.equal(res.ok, true)
  assert.equal(res.shortened, 45)
  assert.deepEqual(s.calls, [undefined, 45])
})

await t('重跑也崩：返回失败，不无限重试', async () => {
  const s = makeSinger([oom, { ok: false, memoryHint: true, error: '内存不够，渲染崩了' }])
  const res = await s._singWithFallback({ query: 'x', bv: '', shift: '' })
  assert.equal(res.ok, false)
  assert.equal(s.calls.length, 2)
})

await t('不是内存问题：不重跑', async () => {
  const s = makeSinger([{ ok: false, error: '渲染时出错了（退出码 1）' }])
  const res = await s._singWithFallback({ query: 'x', bv: '', shift: '' })
  assert.equal(res.ok, false)
  assert.equal(s.calls.length, 1)
})

await t('本来就短（<=50 秒）：不重跑', async () => {
  const s = makeSinger([oom], { maxSec: 45 })
  const res = await s._singWithFallback({ query: 'x', bv: '', shift: '' })
  assert.equal(res.ok, false)
  assert.equal(s.calls.length, 1)
})

await t('短时长也有下限，不会砍到 0', async () => {
  const s = makeSinger([oom, { ok: false, memoryHint: true, error: '崩了' }], { maxSec: 52 })
  await s._singWithFallback({ query: 'x', bv: '', shift: '' })
  assert.equal(s.calls[1], 26)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
