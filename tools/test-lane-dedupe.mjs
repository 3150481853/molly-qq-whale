/*
 * 双泳道去重单测（2026-11-07，主人 m01078「还是有问题」）。
 *
 * 现场：同一个人在几秒内先闲扯一句、再 @ 她一句，targeted / ambient 两条道
 * 各生成各发 —— 群里同一件事回两遍，引用各挂一条。
 * 这里测三件纯状态的东西（借 prototype 调用，不构造 engine）：
 *   · laneMergeDecision()：两条道撞上同一个人时谁答；
 *   · rememberAnswered() / alreadyAnswered()：这几条答过没有；
 *   · stashCarry()/takeCarry() 换成按会话攒以后，跨泳道还能不能接到。
 *   node tools\test-lane-dedupe.mjs
 */
import { ChatEngine } from '../plugin/dsh-qq-whale/lib/engine.js'

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

const P = ChatEngine.prototype
const now = Date.now()

/* ---------- 1. 两条道撞上同一个人 ---------- */
const thinking = (uid, at) => ({ phase: 'thinking', trigger: { ev: { user_id: uid }, at } })

ok(
  '@我 进来时，闲聊那条还在想 → 并进来（merge）',
  P.laneMergeDecision.call({}, { lane: 'targeted', otherJob: thinking('10086', now - 2000), ev: { user_id: '10086' }, nowMs: now }) === 'merge',
)
ok(
  '闲聊进来时，@我 那条还在想 → 让位（yield）',
  P.laneMergeDecision.call({}, { lane: 'ambient', otherJob: thinking('10086', now - 2000), ev: { user_id: '10086' }, nowMs: now }) === 'yield',
)
ok(
  '不同人 → 各答各的',
  P.laneMergeDecision.call({}, { lane: 'targeted', otherJob: thinking('20000', now - 2000), ev: { user_id: '10086' }, nowMs: now }) === '',
)
ok(
  '隔了 9 秒还在想 → 仍并（真机就是 8 秒间隔，见 12:58:02 / 12:58:10 两条 start）',
  P.laneMergeDecision.call({}, { lane: 'targeted', otherJob: thinking('10086', now - 9000), ev: { user_id: '10086' }, nowMs: now }) === 'merge',
)
ok(
  '隔了 40 秒 → 不并（各答各的）',
  P.laneMergeDecision.call({}, { lane: 'targeted', otherJob: thinking('10086', now - 40000), ev: { user_id: '10086' }, nowMs: now }) === '',
)
ok(
  '对方不在想（已经发完了）→ 不并',
  P.laneMergeDecision.call({}, { lane: 'targeted', otherJob: { phase: 'sending', trigger: { ev: { user_id: '10086' }, at: now } }, ev: { user_id: '10086' }, nowMs: now }) === '',
)
ok(
  '没有另一条道 → 不并',
  P.laneMergeDecision.call({}, { lane: 'targeted', otherJob: undefined, ev: { user_id: '10086' }, nowMs: now }) === '',
)

/* ---------- 2. 答过的别再答 ---------- */
const e = { _answered: new Map() }
P.rememberAnswered.call(e, 'group:1', ['801', '802'])
ok('全答过 → 认定为重复', P.alreadyAnswered.call(e, 'group:1', ['801', '802']) === '801,802')
ok('有一条新的 → 得开口', P.alreadyAnswered.call(e, 'group:1', ['801', '803']) === '')
ok('单条答过 → 认定为重复', P.alreadyAnswered.call(e, 'group:1', '802') === '802')
ok('没答过 → 空', P.alreadyAnswered.call(e, 'group:1', ['999']) === '')
ok('别的会话互不影响', P.alreadyAnswered.call(e, 'group:2', ['801']) === '')
ok('空输入不炸', P.alreadyAnswered.call(e, '', []) === '' && P.alreadyAnswered.call({}, 'x', ['1']) === '')
ok(
  '超过 45 秒的记录不算数',
  P.alreadyAnswered.call({ _answered: new Map([['group:1', { at: now - 60000, ids: new Set(['801']) }]]) }, 'group:1', ['801']) === '',
)
ok(
  '累计记多轮（上一轮的 id 还在）',
  (P.rememberAnswered.call(e, 'group:1', ['803']),
  P.alreadyAnswered.call(e, 'group:1', ['801', '803']) === '801,803'),
)

/* ---------- 3. carry 改成按会话攒，跨泳道能接上 ---------- */
const c = { _carry: new Map() }
const mk = (id, uid, at = now) => ({ ev: { message_id: id, user_id: uid }, norm: { text: 't' + id }, at })
const CONV = 'group:666666666'

// 闲聊道被打断的那条，@ 道来取也得看得见（key 是会话，不是 jobId）
P.stashCarry.call(c, CONV, mk('801', '640344215'))
ok(
  '跨泳道能接到被打断的那条',
  P.takeCarry.call(c, CONV, { user_id: '640344215' }).map((t) => t.ev.message_id).join(',') === '801',
)

// 一次塞两条（abort 时连它自己揽下的 carry 一起交回去）
P.stashCarry.call(c, CONV, [mk('802', '640344215'), mk('803', '640344215')])
ok(
  '一次性塞一串也接得上',
  P.takeCarry.call(c, CONV, { user_id: '640344215' }).map((t) => t.ev.message_id).join(',') === '802,803',
)

// 同一条被塞两次（闲聊道让位 + 后面又被打断）不该答两遍
P.stashCarry.call(c, CONV, [mk('804', '640344215'), mk('804', '640344215')])
ok(
  '同一条去重',
  P.takeCarry.call(c, CONV, { user_id: '640344215' }).map((t) => t.ev.message_id).join(',') === '804',
)

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail ? 1 : 0)
