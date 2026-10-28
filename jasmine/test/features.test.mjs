import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  verifyReply,
  detectRepeat,
  detectSycophancy,
  charCosine,
  evaluateCompaction,
  buildReminder,
  estimateTokens,
  buildLetter,
  buildLetterPrompt,
  buildLetterRetryHint,
  letterQuality,
  cleanModelLetter,
  shouldWriteLetter,
  currentWeekKey,
  TokenLedger,
  scoreSignal,
  shouldSpeak,
  SIGNAL_WEIGHTS,
} from '../index.mjs'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/* ------------------------------------------------------------ 出口核对 */

test('核对：引用了没召回的编号 → source_missing', () => {
  const r = verifyReply({ reply: '你上次说的那件事（m9z8y7）我一直记着', recalledIds: ['m1a2b3c'] })
  assert.equal(r.ok, false)
  assert.ok(r.issues.some((i) => i.kind === 'source_missing'))
  assert.equal(r.constraint, '别提没发生的事')
})

test('核对：编号在召回集合里 → 放行', () => {
  const r = verifyReply({ reply: '你上次说的那件事（m1a2b3c）我一直记着', recalledIds: ['m1a2b3c'] })
  assert.equal(r.ok, true)
  assert.equal(r.issues.length, 0)
})

test('核对：说「答应过」但没有未闭合约定 → promise_missing', () => {
  const r = verifyReply({ reply: '我答应过你周末陪你去看海', promises: [] })
  assert.ok(r.issues.some((i) => i.kind === 'promise_missing'))
})

test('核对：有对应约定就放行', () => {
  const r = verifyReply({
    reply: '我答应过你周末陪你去看海',
    promises: [{ id: 'p1', text: '周末陪她去看海', status: 'open' }],
  })
  assert.equal(r.issues.some((i) => i.kind === 'promise_missing'), false)
})

test('核对：边界（替人做决定 / 绝对承诺）会被记下', () => {
  const r = verifyReply({ reply: '有我就够了，你不需要别人' })
  assert.ok(r.issues.some((i) => i.kind === 'boundary'))
  assert.ok(r.scores.relation < 1)
})

test('复读三线：同一句再说一遍能抓到', () => {
  const a = '今天西湖边上风很大，我们把外套裹紧了才走完苏堤'
  const b = '今天西湖边上风很大，我们把外套裹紧了才走完苏堤'
  const r = detectRepeat(a, [b])
  assert.equal(r.repeat, true)
  assert.ok(r.lines.includes('headIdentical'))
})

test('复读三线：不同的话不误报', () => {
  const r = detectRepeat('今天西湖边风很大', ['晚上想吃火锅还是烧烤'])
  assert.equal(r.repeat, false)
})

test('迎合：同意 + 高强度 + 没留余地 → sycophancy', () => {
  assert.equal(detectSycophancy('你说得对，就该这样对他').sycophancy, true)
  assert.equal(detectSycophancy('你说得对，不过也可能是我理解偏了').sycophancy, false)
  assert.equal(detectSycophancy('我觉得还行').sycophancy, false)
})

test('字符二元组余弦：同句为 1', () => {
  assert.equal(Math.round(charCosine('今天天气不错', '今天天气不错')), 1)
})

/* ------------------------------------------------------------ 压缩提醒 */

test('压缩：可回收不足 5000 不提醒', () => {
  const r = evaluateCompaction({ usedTokens: 900_000, limitTokens: 1_000_000, compactableTokens: 3_000 })
  assert.equal(r.tier, 'none')
})

test('压缩：75% → pressure，95% → urgent，优先紧急档', () => {
  const p = evaluateCompaction({ usedTokens: 760_000, limitTokens: 1_000_000, compactableTokens: 40_000 })
  assert.equal(p.tier, 'pressure')
  const u = evaluateCompaction({ usedTokens: 960_000, limitTokens: 1_000_000, compactableTokens: 40_000 })
  assert.equal(u.tier, 'urgent')
})

test('压缩：增长档（攒够 5 万）', () => {
  const r = evaluateCompaction({ usedTokens: 200_000, limitTokens: 1_000_000, compactableTokens: 60_000, sinceLastCompact: 55_000 })
  assert.equal(r.tier, 'growth')
})

test('压缩：同一回合只提醒一次', () => {
  const r = evaluateCompaction({ usedTokens: 990_000, limitTokens: 1_000_000, compactableTokens: 60_000, remindedThisTurn: true })
  assert.equal(r.tier, 'none')
})

test('压缩：提醒文本一行、带量级', () => {
  const msg = buildReminder({ tier: 'pressure', reclaim: 42_000 })
  assert.match(msg, /42K/)
  assert.equal(msg.includes('\n'), false)
  assert.equal(buildReminder({ tier: 'none' }), '')
})

test('token 粗估：中文按字近似', () => {
  assert.ok(estimateTokens('一二三四五六七八九十') >= 7)
  assert.ok(estimateTokens('hello world') <= 4)
})

/* ------------------------------------------------------------ 每周一封信 */

test('周信：像日记，不像工作汇报（替主人做的事最多两条）', () => {
  const owner = 'example'
  const { text, used } = buildLetter({
    weekKey: '2026-10-19',
    owner,
    facts: [
      { who: owner, text: '我帮他做过：回复一下未读消息', at: 1 },
      { who: owner, text: '我帮他做过：发送自我介绍', at: 2 },
      { who: owner, text: '我帮他做过：检查群里的天气', at: 3 },
      { who: '小满', text: '今天群里聊到桂花开了', at: 4 },
      { who: '阿澈', text: '说下周要去海边', at: 5 },
    ],
  })
  assert.equal(used >= 2, true)
  assert.doesNotMatch(text, /我帮他做过/)
  assert.match(text, /替你/)
  // 「替你」类句子最多两条
  assert.ok((text.match(/替你/g) || []).length <= 2)
  // 不能整封都是主人的事：别人的内容至少出现一次
  assert.match(text, /桂花|海边/)
})

test('周信：不把 QQ 号写进信里', () => {
  const { text } = buildLetter({
    weekKey: '2026-10-19',
    facts: [{ who: '小满', text: '向 123123123 发送自我介绍', at: 1 }],
  })
  assert.doesNotMatch(text, /\d{5,}/)
  assert.match(text, /有人/)
})

test('周信：有自己的感受句和念想', () => {
  const { text } = buildLetter({ weekKey: '2026-10-19', facts: [{ who: '小满', text: '聊到桂花', at: 1 }] })
  assert.ok(text.length > 120, `信太短：${text.length}`)
  assert.ok((text.match(/。/g) || []).length >= 3)
  assert.match(text, /下周|记到这儿|写完了/)
})

test('周信：没事实也不空信', () => {
  const { text } = buildLetter({ weekKey: '2026-W46', facts: [], quietDays: 4 })
  assert.ok(text.length > 10)
  assert.match(text, /4 天/)
})

test('周信：同一周同一封（可复现）', () => {
  const a = buildLetter({ weekKey: '2026-W45', facts: [] }).text
  const b = buildLetter({ weekKey: '2026-W45', facts: [] }).text
  assert.equal(a, b)
})

test('周信：本周不写（上次写的就是本周）', () => {
  const key = currentWeekKey()
  assert.equal(shouldWriteLetter({ lastLetterWeek: key }), false)
  assert.equal(shouldWriteLetter({ lastLetterWeek: '2000-W01' }), true)
})

test('周信：流水账判不合格，有感受判合格', () => {
  const chore = '这周我帮主人查了天气，回复了消息，发了表情包，记了三条记忆，提醒了他开会，处理了两张图。'
  const feel = '这周有一次，被人叫了名字，我心里忽然一紧，有点高兴又有点不好意思。其实我后来想，我大概是怕被忘掉。那天下午很无聊，我盯着屏幕发呆，好奇他们都在忙什么。'
  assert.equal(letterQuality(chore).ok, false)
  const q = letterQuality(feel)
  assert.equal(q.ok, true)
  assert.ok(q.feeling >= 3)
})

test('周信：重写提示要求多写感受、少罗列', () => {
  const hint = buildLetterRetryHint()
  assert.match(hint, /感受/)
  assert.match(hint, /流水账|罗列/)
})

/* ------------------------------------------------------------ token 账本 */

test('账本：按 purpose 聚合，价格缺省记 0', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jasmine-ledger-'))
  const file = path.join(dir, 'ledger.jsonl')
  const led = new TokenLedger({ file, prices: { 'model-a': { in: 1, cachedIn: 0.2, out: 2 } }, clock: () => 1_700_000_000_000 })
  led.record({ model: 'model-a', purpose: 'chat', inTokens: 1_000_000, outTokens: 100_000, cachedIn: 500_000 })
  led.record({ model: 'model-a', purpose: 'proactive', inTokens: 1_000_000 })
  const s = led.summary({ byDay: false })
  assert.equal(s.total.calls, 2)
  assert.equal(s.byPurpose.chat.calls, 1)
  assert.ok(s.byPurpose.proactive.in === 1_000_000)
  // chat: (0.5M*1 + 0.5M*0.2 + 0.1M*2)/1M = 0.5+0.1+0.2 = 0.8
  assert.ok(Math.abs(s.byPurpose.chat.cost - 0.8) < 1e-9)
  assert.equal(s.total.cached, 500_000)
})

test('账本：坏行跳过，不整本报废', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jasmine-ledger-'))
  const file = path.join(dir, 'ledger.jsonl')
  fs.writeFileSync(file, '{"t":1,"model":"m","purpose":"chat","in":10,"out":2,"cached":0}\nnot-json\n', 'utf8')
  const led = new TokenLedger({ file })
  assert.equal(led.summary().total.calls, 1)
})

/* ------------------------------------------------------------ 群聊信号 */

test('信号：@我 → called 1.0', () => {
  const r = scoreSignal({ text: '在吗', isAtMe: true })
  assert.equal(r.tier, 'called')
  assert.equal(r.score, SIGNAL_WEIGHTS.called)
})

test('信号：叫名字 → called', () => {
  const r = scoreSignal({ text: '茉莉你今天怎么不说话', names: ['茉莉'] })
  assert.equal(r.tier, 'called')
})

test('信号：只 @ 别人 → 闭嘴', () => {
  const r = scoreSignal({ text: '@小王 你看这个', atSomeoneElse: true })
  assert.equal(r.score, 0)
})

test('信号：在说我 → aboutMe', () => {
  const r = scoreSignal({ text: '上次茉莉说的那个梗真好笑', myTopics: ['那个梗'] })
  assert.equal(r.tier, 'aboutMe')
})

test('信号：45 秒内接话 → continuing', () => {
  const r = scoreSignal({ text: '对对对', continuesMe: true, msSinceMyLast: 10_000 })
  assert.equal(r.tier, 'continuing')
})

test('信号：纯闲聊 → chatter，且默认不回', () => {
  const r = scoreSignal({ text: '哈哈哈笑死我了' })
  assert.equal(r.tier, 'chatter')
  assert.equal(shouldSpeak(r.score), false)
  assert.equal(shouldSpeak(SIGNAL_WEIGHTS.aboutMe), true)
})

/* ------------------------------------------------------------ 模型写信的提示词与清洗 */

test('提示词：材料里的人名会进 user，QQ 号被抹掉', () => {
  const p = buildLetterPrompt({
    weekKey: '2026-10-19',
    facts: [
      { who: '小张', text: '说他这周在赶论文', at: 1 },
      { who: '', text: '群里有人问了 888888888 这个号', at: 2 },
    ],
    stats: { chores: 3, memes: 5, promises: 1, people: 2, groups: 1 },
  })
  assert.match(p.user, /小张/)
  assert.doesNotMatch(p.user, /888888888/)
  assert.match(p.user, /10 月 19 日/)
  assert.match(p.system, /第一人称/)
})

test('提示词：没有材料也能给一份空材料提示', () => {
  const p = buildLetterPrompt({ weekKey: '2026-10-19', facts: [] })
  assert.match(p.user, /没什么材料/)
})

test('清洗：去掉标题/列表/加粗/长数字，保留正文', () => {
  const raw = `# 周记\n\n- 第一件事：帮他查天气\n1. 第二件事\n**重点**：她笑了\n编号 123456789 别出现\n\n\n继续写。`
  const text = cleanModelLetter(raw)
  assert.doesNotMatch(text, /#/)
  assert.doesNotMatch(text, /^[-*]/m)
  assert.doesNotMatch(text, /123456789/)
  assert.doesNotMatch(text, /\*\*/)
  assert.match(text, /继续写/)
})

test('清洗：超长按句子截断，不硬切半个字', () => {
  const raw = `${'这是一句话。'.repeat(200)}`
  const text = cleanModelLetter(raw, { maxChars: 100 })
  assert.ok(text.length <= 101)
  assert.ok(text.endsWith('。'))
})
