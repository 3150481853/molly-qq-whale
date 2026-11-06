/*
 * buildSystemPrompt 的「这一轮你要接的是这几条」段单测
 * （2026-11-06，主人 m00215「为什么总是回下一条」）。
 *
 *   node out\_context_turn_test.mjs
 */
import { buildSystemPrompt } from '../plugin/dsh-qq-whale/lib/engine-context.js'

const base = {
  persona: { systemPrompt: () => '# 人设\n你是 Molly。' },
  client: { self: { nickname: 'Molly' } },
  pestMode: false,
  config: {},
  withDegradedNote: (s) => s,
  memory: { addressOf: () => [], contextFor: () => '' },
  relations: { contextFor: () => '' },
  stickers: { catalogText: () => '' },
  memberRoster: () => '',
  speakerLabel: (h) => String(h?.who || ''),
  pickActivity: () => '',
  memoryWindow: { contextLimit: 40, queryLimit: 8, degradedContextLimit: 12, degradedQueryLimit: 4 },
  sniffMime: () => 'image/png',
  gifContactSheet: null,
}
const deps = new Proxy(base, {
  get(t, k) {
    if (k in t) return t[k]
    return undefined
  },
})

const now = Date.now()
const conv = { key: 'g:1', history: [] }

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++
  } else {
    fail++
    console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`)
  }
}

const turns = [
  { at: now - 41000, who: '主人', text: '为什么总是回下一条' },
  { at: now - 33000, who: '主人', text: '[图片]' },
]
let out = ''
try {
  out = buildSystemPrompt(
    { scene: 'group', userName: '主人', qq: '10086', groupName: '这是一个用户群', mood: {}, conv, thisTurn: turns },
    deps,
  )
} catch (e) {
  console.log('buildSystemPrompt threw:', e.message)
}

ok('有连发时输出「这一轮你要接的是这几条」', out.includes('这一轮你要接的是这几条'), out.slice(0, 80))
ok('按时间顺序列出两条', out.includes('1. [') && out.includes('2. ['), '')
ok('第 1 条是正题那句', /1\. \[[^\]]+\] 主人：为什么总是回下一条/.test(out), '')
ok('明确要求先答第 1 条', out.includes('先回答第 1 条'), '')
ok('只发一条时不出现该段', !buildSystemPrompt(
  { scene: 'group', userName: '主人', qq: '10086', groupName: 'g', mood: {}, conv, thisTurn: [turns[1]] },
  deps,
).includes('这一轮你要接的是这几条'), '')

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail ? 1 : 0)
