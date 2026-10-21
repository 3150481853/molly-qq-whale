/**
 * test-window-config.mjs —— 上下文/记忆窗口的「档位钉子」（task-55）。
 *
 * 为什么要这个测试：窗口大小只影响"喂多少"，改错了不会报错，只会悄悄变笨/变贵。
 * 所以把数字钉死，谁想调都必须同时改这里——逼他看见成本说明。
 *
 * 跑法：node tools/test-window-config.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MEMORY_WINDOW,
  MEMORY_WINDOW_PROFILES,
  WINDOW_PROFILE,
} from '../plugin/dsh-qq-whale/lib/memory.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB = path.join(HERE, '..', 'plugin', 'dsh-qq-whale', 'lib')
const read = (f) => fs.readFileSync(path.join(LIB, f), 'utf8')

let pass = 0
const fails = []
function t(name, fn) {
  try {
    fn()
    pass++
    console.log('  ok   ' + name)
  } catch (err) {
    fails.push({ name, msg: err?.message || String(err) })
    console.log('  FAIL ' + name)
    console.log('       ' + String(err?.message || err).split('\n').slice(0, 4).join('\n       '))
  }
}

console.log('记忆窗口（memory.js 单点定义）')

t('1. 默认档位是 balanced，三个数值钉死 32 / 12 / 12 / 6 / 240', () => {
  assert.equal(WINDOW_PROFILE, 'balanced')
  assert.deepEqual({ ...MEMORY_WINDOW }, {
    contextLimit: 32,
    queryLimit: 12,
    degradedContextLimit: 12,
    degradedQueryLimit: 6,
    entryChars: 240,
  })
})

t('2. 三档存在且单调：small < balanced < large', () => {
  const names = Object.keys(MEMORY_WINDOW_PROFILES).sort()
  assert.deepEqual(names, ['balanced', 'large', 'small'])
  const s = MEMORY_WINDOW_PROFILES.small
  const b = MEMORY_WINDOW_PROFILES.balanced
  const l = MEMORY_WINDOW_PROFILES.large
  for (const k of ['contextLimit', 'queryLimit', 'entryChars']) {
    assert.ok(s[k] < b[k], `${k}: small 应小于 balanced`)
    assert.ok(b[k] < l[k], `${k}: balanced 应小于 large`)
  }
})

t('3. 降智档必须小于主档（否则"降智"名不副实）', () => {
  for (const [name, w] of Object.entries(MEMORY_WINDOW_PROFILES)) {
    assert.ok(w.degradedContextLimit < w.contextLimit, `${name}: degradedContextLimit 应小于 contextLimit`)
    assert.ok(w.degradedQueryLimit < w.queryLimit, `${name}: degradedQueryLimit 应小于 queryLimit`)
  }
})

t('4. MEMORY_WINDOW 是冻结对象（防运行期被就地改）', () => {
  assert.equal(Object.isFrozen(MEMORY_WINDOW), true)
  assert.throws(() => {
    // 严格模式下写冻结对象会抛
    'use strict'
    MEMORY_WINDOW.contextLimit = 999
  })
})

t('5. memory.js 顶部写明「要调窗口只改这一处」', () => {
  const src = read('memory.js')
  assert.match(src, /要调窗口\*\*只改这一处\*\*/)
  assert.match(src, /MEMORY_WINDOW_PROFILES/)
  assert.match(src, /WINDOW_PROFILE/)
})

t('6. 默认召回/上下文窗口走 MEMORY_WINDOW，不是写死数字', () => {
  const src = read('memory.js')
  assert.match(src, /limit = MEMORY_WINDOW\.contextLimit/, 'contextFor 的默认 limit 应取 MEMORY_WINDOW')
  assert.equal(/limit = 24\b/.test(src), false, 'memory.js 里不该再出现写死的 24')
  // balanced 那一档必须还是 240（small 档的 200 是历史档位，允许存在）
  const balanced = /balanced: Object\.freeze\(\{[\s\S]*?\}\)/.exec(src)
  assert.ok(balanced, '源码里应有 balanced 档定义')
  assert.match(balanced[0], /entryChars: 240/, 'balanced 档的 entryChars 应为 240')
})

console.log('\n上下文 / 输出窗口（main.js DEFAULTS）')

/*
 * 这里刻意「读源码」而不是 import main.js：
 *  1) main.js 是 cordis 插件入口，import 它会连带加载 engine/web 等模块，重；
 *  2) 多人并行改 main.js 时，别人的半成品语法错不该让这个档位钉子一起红。
 * 数字都在 DEFAULTS 里唯一出现，正则够了。
 */
const mainSrc = read('main.js')
const defaultNum = (key) => {
  const m = new RegExp(`\\n {2}${key}: (\\d+),`).exec(mainSrc)
  assert.ok(m, `main.js 的 DEFAULTS 里找不到 ${key}`)
  return Number(m[1])
}

t('7. contextLimit 默认 60（原 40）', () => {
  assert.equal(defaultNum('contextLimit'), 60)
})

t('8. maxTokens 默认 1536（原 1024）', () => {
  assert.equal(defaultNum('maxTokens'), 1536)
})

t('9. DEFAULTS 里没有残留旧值（40 / 1024）', () => {
  assert.equal(/contextLimit:\s*40,/.test(mainSrc), false, '还残留 contextLimit: 40')
  assert.equal(/maxTokens:\s*1024,/.test(mainSrc), false, '还残留 maxTokens: 1024')
})

t('10. schema 从 DEFAULTS 取默认值（没有第二份数字）', () => {
  assert.match(mainSrc, /contextLimit: s\.natural\(\)\.default\(DEFAULTS\.contextLimit\)/)
  assert.match(mainSrc, /maxTokens: s\.natural\(\)\.default\(DEFAULTS\.maxTokens\)/)
})

t('11. /state 里有只读 windows 字段（档位可观测）', () => {
  assert.match(mainSrc, /get windows\(\)/)
  assert.match(mainSrc, /profile: WINDOW_PROFILE/)
  assert.match(mainSrc, /memory: \{ \.\.\.MEMORY_WINDOW \}/)
})

t('12. 引擎侧不许再写死窗口数字（只能从 MEMORY_WINDOW 取）', () => {
  const ctx = read('engine-context.js')
  assert.equal(/MEMORY_WINDOW/.test(ctx), false, 'engine-context 不该直接 import MEMORY_WINDOW，应由 deps.memoryWindow 注入')
  const eng = read('engine.js')
  assert.match(eng, /deps\.memoryWindow|memoryWindow: MEMORY_WINDOW/, 'engine 应把 MEMORY_WINDOW 作为 deps 传给上下文层')
})

console.log('')
console.log(`${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log('  - ' + f.name + ': ' + f.msg)
  process.exit(1)
}
