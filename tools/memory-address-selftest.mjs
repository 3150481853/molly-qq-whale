/**
 * 记忆「称谓」自测（kind = 'address'）。
 *
 * 背景（主人 m01649 / m01672）：
 *   - 子房有礼了（888888888）反复说「不是说好叫我宝宝吗」，她照旧不叫；
 *   - 给出的规矩：称谓单独成类、并且**不受记忆权重/窗口限制**。
 *
 * 这个脚本离线验证三件事：
 *   1. addressOf() 按 QQ 直取、不看 weight、不被窗口条数挤掉；
 *   2. 普通记忆段（contextFor）不再重复放称谓，避免 prompt 里出现两种叫法；
 *   3. buildSystemPrompt() 真的把「# 怎么称呼」拼进去，且排在「# 你记得的事」前面。
 *
 * 用法：node tools/memory-address-selftest.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore, intentKinds } from '../plugin/dsh-qq-whale/lib/memory.js'
import { buildSystemPrompt } from '../plugin/dsh-qq-whale/lib/engine-context.js'

let passed = 0
let failed = 0
const fails = []

function check(name, ok, detail = '') {
  if (ok) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    fails.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'molly-addr-'))
const logger = () => {}
const store = new MemoryStore({ dir, logger, limit: 2000 })

const ZIFANG = '888888888'
const OTHER = '2928194582'

console.log('1) 写入：称谓语 + 一堆普通记忆')
store.add({ kind: 'address', who: '子房有礼了', qq: ZIFANG, text: '他希望你叫他「宝宝」，要主动叫，不用他开口', weight: 1 })
store.add({ kind: 'address', who: '子房有礼了', qq: ZIFANG, text: '他自报的称呼是「你宝宝呢」', weight: 1 })
store.add({ kind: 'address', who: 'Chihiro', qq: OTHER, text: '他希望被叫「宝宝」', weight: 5 })
for (let i = 0; i < 40; i++) {
  store.add({ kind: 'fact', who: '子房有礼了', qq: ZIFANG, text: `普通事实第 ${i} 条：他昨天在忙一件不太重要的事`, weight: 5 })
}

console.log('2) addressOf：不受权重限制')
const addr = store.addressOf({ who: '子房有礼了', qq: ZIFANG })
check('两条都取到（weight=1 也没被丢掉）', addr.length === 2, `实际 ${addr.length} 条`)
check('不串号：没有 Chihiro 那条', addr.every((e) => String(e.qq) === ZIFANG))
check('按时间新→旧返回', String(addr[0]?.text || '').includes('你宝宝呢'), addr[0]?.text)
check('别的 QQ 查只拿到自己的', store.addressOf({ who: 'Chihiro', qq: OTHER }).length === 1)

console.log('3) 普通记忆段不再重复称谓')
const plain = store.contextFor({ who: '子房有礼了', qq: ZIFANG, limit: 24 })
check('contextFor 里有普通事实', plain.includes('普通事实第'), plain.slice(0, 60))
check('contextFor 里没有 address 条目', !plain.includes('他希望你叫他'), plain.slice(0, 120))
check('窗口塞满 40 条普通事实后称谓仍在 addressOf', store.addressOf({ who: '子房有礼了', qq: ZIFANG }).length === 2)

console.log('4) 意图兜底')
check('「你该叫我什么」→ address 优先', (intentKinds('你该叫我什么') || []).includes('address'))
check('「我该叫你啥」→ address 优先', (intentKinds('我该叫你啥来着') || []).includes('address'))

console.log('5) system prompt 注入')
const baseConv = { history: [{ role: 'user', text: '在吗' }], relationKey: '' }
const stubDeps = (addressItems) => ({
  persona: { systemPrompt: () => '你是一条肥鱼' },
  client: { self: { nickname: 'Molly' } },
  config: { timeContextEnabled: false, sleepEnabled: false, maxStickersPerReply: 2 },
  withDegradedNote: (s) => s,
  now: () => Date.parse('2026-10-26T12:00:00+08:00'),
  memoryWindow: { contextLimit: 24, queryLimit: 8, degradedContextLimit: 8, degradedQueryLimit: 4 },
  memory: {
    contextFor: () => '- [fact]（子房有礼了） 他昨天在忙',
    recall: () => [],
    addressOf: () => addressItems,
  },
  relations: { contextFor: () => '' },
  memberRoster: () => '',
  stickers: { catalogText: () => '' },
  pickActivity: () => '',
})

const sp = buildSystemPrompt(
  { scene: 'group', userName: '子房有礼了', qq: ZIFANG, groupName: '用户群', mood: '', conv: baseConv },
  stubDeps([{ text: '他希望你叫他「宝宝」' }]),
)
check('有「# 怎么称呼」段', sp.includes('# 怎么称呼'))
check('段内有称谓原文', sp.includes('他希望你叫他「宝宝」'))
check('写明了不用等对方提醒', sp.includes('不用等对方再提醒'))
check('排在「# 你记得的事」前面', sp.indexOf('# 怎么称呼') < sp.indexOf('# 你记得的事'))

const spEmpty = buildSystemPrompt(
  { scene: 'group', userName: '陌生人', qq: '999999999', groupName: '用户群', mood: '', conv: baseConv },
  stubDeps([]),
)
check('没称谓时不出现空段', !spEmpty.includes('# 怎么称呼'))

console.log('6) 规则层抽取（engine.learnByRule 的正则契约）')
// learnByRule 是 ChatEngine 的实例方法，重依赖；这里只校验"同一批正则"能被引擎源码接受。
// 真正跑规则层的回归放在上线后真机验收，避免为了测试把整个 engine 拖起来。
const engineSrc = fs.readFileSync(new URL('../plugin/dsh-qq-whale/lib/engine.js', import.meta.url), 'utf8')
check("规则层存在 address 模式", /kind: 'address'/.test(engineSrc))
check('称谓规则排在「我叫」之前', engineSrc.indexOf("kind: 'address'") < engineSrc.indexOf('{ re: /我叫(.{1,12})/'))
check('guessKind 先认称谓', /希望你叫他[\s\S]{0,80}return 'address'/.test(engineSrc))
check('模型输出支持「称谓：」前缀', /称谓\|称呼\|叫法\|address/.test(engineSrc))

console.log(`\n结果：${passed} 通过，${failed} 失败`)
if (failed) {
  for (const f of fails) console.log(`  - ${f}`)
  process.exitCode = 1
}
fs.rmSync(dir, { recursive: true, force: true })
