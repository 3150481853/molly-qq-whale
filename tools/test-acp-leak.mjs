// acp_status 回执泄漏（2026-11-26 真机事故，QQ 群 666666666）
//
// 现场：群友说了句「这谁绷得住」，Molly 连发 5 颗气泡，把上下文统计整块贴了出来：
//   「📊 [ACP] acp_status result:」
//   「[acp-status]」
//   「ACTIVE SURFACE: pack=default | host=billion-context 0.1.216 (6a641f378)」
//   「CONTEXT BREAKDOWN」
//   「0 tool (0%) | 2.5K text (100%) | 0 summaries (0%)Top tools: text (100%)（细节不在这儿刷了，要的话我私聊你）」
//
// 原来的清洗层只认「行首就是 [ACP]」，这回头上还挂着 📊 表情，于是整块漏出门。
// 这里只测清洗：这些回执/统计不许原样发进群，正常聊天一个字都不许动。

import assert from 'node:assert/strict'
import { sanitizeOutbound } from '../plugin/dsh-qq-whale/lib/persona-sanitize.js'

let pass = 0
let fail = 0
function t(name, fn) {
  try {
    fn()
    pass++
    console.log('  ok   ' + name)
  } catch (err) {
    fail++
    console.log('  FAIL ' + name + ' → ' + err.message)
  }
}

t('📊 开头的 [ACP] 回执也要删（那次漏的就是它）', () => {
  assert.equal(sanitizeOutbound('📊 [ACP] acp_status result:').trim(), '')
  assert.equal(sanitizeOutbound('📊 [ACP] acp_status result:\n[CQ:face,id=1]').trim(), '')
})

t('裸的 [acp-status] 标记删掉', () => {
  assert.equal(sanitizeOutbound('[acp-status]').trim(), '')
})

t('ACTIVE SURFACE 那行（含 host=billion-context 版本号）删掉', () => {
  assert.equal(sanitizeOutbound('ACTIVE SURFACE: pack=default | host=billion-context 0.1.216 (6a641f378)').trim(), '')
  assert.equal(sanitizeOutbound('pack=default | host=billion-context 0.1.216').trim(), '')
})

t('CONTEXT BREAKDOWN 标题删掉', () => {
  assert.equal(sanitizeOutbound('CONTEXT BREAKDOWN').trim(), '')
})

t('占比行整行删掉（含黏在同一行的 Top tools 与解释）', () => {
  const raw = '0 tool (0%) | 2.5K text (100%) | 0 summaries (0%)Top tools: text (100%)（细节不在这儿刷了，要的话我私聊你）'
  const out = sanitizeOutbound(raw)
  assert.equal(out.trim(), '', '漏了：' + JSON.stringify(out))
})

t('Top tools 单独一行也删', () => {
  assert.equal(sanitizeOutbound('Top tools: text (100%)').trim(), '')
})

t('那一整块五连发全喂进去 → 一个字都不剩', () => {
  const block = [
    '📊 [ACP] acp_status result:',
    '[acp-status]',
    'ACTIVE SURFACE: pack=default | host=billion-context 0.1.216 (6a641f378)',
    'CONTEXT BREAKDOWN',
    '0 tool (0%) | 2.5K text (100%) | 0 summaries (0%)Top tools: text (100%)',
  ].join('\n')
  assert.equal(sanitizeOutbound(block).trim(), '')
})

t('前后有正常话时只删回执，正常话留着', () => {
  const out = sanitizeOutbound('这谁绷得住\n📊 [ACP] acp_status result:\n我也绷不住')
  assert.match(out, /这谁绷得住/)
  assert.match(out, /我也绷不住/)
  assert.ok(!/ACP|acp_status/.test(out), '还留着回执：' + out)
})

t('正常聊天一个字都不该动（含提到 "tool" 的日常句子）', () => {
  const says = [
    '这图我看了半天，像是《明日方舟》的立绘。',
    '我这边 tool 链没接上，等会儿再试。',
    '2.5K 个字我也不嫌多，你慢慢说。',
    'ACTIVE 那个开关我关了。',
  ]
  for (const s of says) assert.equal(sanitizeOutbound(s), s)
})

console.log(`\n${pass} 过 / ${fail} 挂`)
process.exit(fail ? 1 : 0)
