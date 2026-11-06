/*
 * ChatEngine.stashCarry / takeCarry 单测（2026-11-06，主人 m00215「为什么总是回下一条」）。
 *
 * 只测这两个纯状态方法：借 prototype 调用，不构造整个 engine（构造要连一堆依赖）。
 *   node out\_carry_test.mjs
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

const e = { _carry: new Map() }
const stash = (jobId, t) => ChatEngine.prototype.stashCarry.call(e, jobId, t)
const take = (jobId, ev) => ChatEngine.prototype.takeCarry.call(e, jobId, ev)

const now = Date.now()
const mk = (id, uid, at = now) => ({ ev: { message_id: id, user_id: uid }, norm: { text: 't' + id }, at })

const JOB = 'g:1\u0000targeted'
stash(JOB, mk('801', '10086'))
const got = take(JOB, { user_id: '10086' })
ok('取出被打断的那条', got.length === 1 && got[0].ev.message_id === '801', JSON.stringify(got.length))
ok('取过一次就清空', take(JOB, { user_id: '10086' }).length === 0)

stash(JOB, mk('802', '10086'))
ok('不同人连发不合并', take(JOB, { user_id: '20000' }).length === 0)

stash(JOB, mk('803', '10086', now - 60000))
ok('超过 20 秒不合并', take(JOB, { user_id: '10086' }).length === 0)

stash(JOB, mk('804', '10086'))
stash(JOB, mk('805', '10086'))
stash(JOB, mk('806', '10086'))
stash(JOB, mk('807', '10086'))
const capped = take(JOB, { user_id: '10086' })
ok('最多攒 3 条', capped.length === 3, String(capped.length))
ok('攒的是最近 3 条（顺序不变）', capped.map((t) => t.ev.message_id).join(',') === '805,806,807', capped.map((t) => t.ev.message_id).join(','))

ok('空 map 不炸', take('nope', { user_id: '1' }).length === 0 && take('nope', undefined).length === 0)

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail ? 1 : 0)
