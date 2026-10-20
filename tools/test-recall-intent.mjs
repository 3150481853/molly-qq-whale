/** 验泛问兜底召回：不需要模型，直接构造记忆库 */
import fs from 'node:fs'
import path from 'node:path'
import { MemoryStore } from 'file:///C:/Users/example/.dsh/profiles/desktop/node_modules/dsh-qq-whale/lib/memory.js'

const DIR = 'C:/Users/example/.dsh/qq-whale-intent-test'
try { fs.rmSync(DIR, { recursive: true, force: true }) } catch {}

const logger = (level, msg) => console.log(`${level}: ${msg}`)
const mem = new MemoryStore({ dir: DIR, logger })

const OWNER = '老王'
const seed = [
  ['person', '他自称叫「林岸，在杭州做游戏策划」', 4],
  ['preference', '他爱吃锅贴，讨厌香菜', 4],
  ['preference', '他喜欢喝冰美式，不加糖', 3],
  ['promise', '他说好周末陪我一起打游戏', 3],
  ['event', '他下周三要面试，很紧张', 3],
  ['person', '他养了一只猫叫团子，快三岁', 3],
  ['fact', '他今天加班到十点', 3],
  ['fact', '他领导又临时改需求，改第八遍了', 3],
]
for (const [kind, text, weight] of seed) mem.add({ kind, who: OWNER, text, weight })

console.log('\n=== 逐条召回（应命中具体条目）===')
for (const q of ['猫', '团子', '加班', '锅贴', '香菜', '面试', '生日', '林岸']) {
  const hits = mem.recall({ who: OWNER, query: q, limit: 4 })
  console.log(`  查「${q}」→ ${hits.length ? hits.map((h) => `[${h.kind}]${h.text}`).join(' | ') : '(无)'}`)
}

console.log('\n=== 泛问兜底（关键词一分不可能命中，只能靠意图分类）===')
const generic = [
  '我叫什么来着',
  '我喜欢什么',
  '我爱吃什么',
  '我讨厌什么',
  '我生日是哪天',
  '我答应过你什么',
  '我最近怎么样',
  '猜猜我是谁',
]
let pass = 0
for (const q of generic) {
  const hits = mem.recall({ who: OWNER, query: q, limit: 4 })
  const ok = hits.length > 0
  if (ok) pass++
  console.log(`  ${ok ? '✅' : '❌'} 查「${q}」→ ${hits.length ? hits.map((h) => `[${h.kind}]${h.text}`).join(' | ') : '(无)'}`)
}
console.log(`\n泛问兜底：${pass}/${generic.length} 有结果`)

console.log('\n=== 不许串味：不相关的泛问不该乱答 ===')
for (const q of ['今天天气怎么样', '你会唱歌吗']) {
  const hits = mem.recall({ who: OWNER, query: q, limit: 4 })
  console.log(`  查「${q}」→ ${hits.length ? hits.map((h) => h.text).join(' | ') : '(无)'}`)
}

process.exit(pass >= generic.length - 2 ? 0 : 3)
