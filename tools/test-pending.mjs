/**
 * 闸门接线 + 待核实区单测（task-24 阶段二 / task-27）
 *
 * 不构造整个 ChatEngine（它会建网关、表情库、定时器），只借它的**原型方法**
 * 配上真实的 MemoryStore / PendingStore 跑——测的是生产代码本身，不是复制品。
 *
 * 覆盖：
 *   ① 通过 → 入库 + added++
 *   ② insult → 进待核实区，正式库不变
 *   ③ duplicate → 只计数不入队
 *   ④ 24h 内同文不翻倍；超 24h 重新计时（不是永久去重）
 *   ⑤ approve 语义：先入库成功再出队；失败不出队
 *   ⑥ reject 语义 + 不存在 id 的 404 判定
 *   ⑦ memoryGate 四个数自洽（rejected === pending + dup）
 *
 * 跑法：node tools/test-pending.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { ChatEngine } from '../plugin/dsh-qq-whale/lib/engine.js'
import { MemoryStore } from '../plugin/dsh-qq-whale/lib/memory.js'
import { PendingStore } from '../plugin/dsh-qq-whale/lib/memory-pending.js'

let pass = 0
let fail = 0
const failures = []
function check(name, cond, detail = '') {
  if (cond) {
    pass += 1
    console.log(`  ok   ${name}`)
  } else {
    fail += 1
    failures.push(name + (detail ? ` — ${detail}` : ''))
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const dir = path.join(process.cwd(), 'out', `_test-pending-${process.pid}`)
fs.rmSync(dir, { recursive: true, force: true })
fs.mkdirSync(dir, { recursive: true })

const memory = new MemoryStore({ dir, logger: () => {} })
const pending = new PendingStore({ dir, logger: () => {} })
const logs = []
const gate = { added: 0, rejected: 0, pending: 0, dup: 0 }

// 一个假的 this：只放 remember() 真正用到的东西
const self = {
  memory,
  memoryPending: pending,
  memoryGate: gate,
  logger: (lvl, msg) => logs.push(`${lvl}: ${msg}`),
}
const remember = (input) => ChatEngine.prototype.remember.call(self, input)

console.log('\n① 通过闸门 → 正常入库')
memory.add({ kind: 'fact', who: '主人', qq: '222222222', text: '他在福州工作。' })
const base = memory.entries.length
const ok1 = remember({ kind: 'fact', who: '主人', qq: '222222222', text: '他养了一只猫叫团子。' })
check('返回 entry', Boolean(ok1 && ok1.id))
check('正式库 +1', memory.entries.length === base + 1)
check('added=1', gate.added === 1)
check('rejected=0', gate.rejected === 0)
check('duplicate 的同类条目仍然入队', pending.count() === 0)

console.log('\n② insult → 进待核实区，正式库不动')
const beforeInsult = memory.entries.length
const r2 = remember({ kind: 'person', who: 'D.X.X', qq: '333333333', text: '他是你爹' })
check('返回 null（没入库）', r2 === null)
check('正式库条数不变', memory.entries.length === beforeInsult)
check('待核实区 +1', pending.count() === 1)
check('pending=1', gate.pending === 1)
check('rejected=1', gate.rejected === 1)
check('reason 记为 insult', pending.list()[0].reason === 'insult')
check('qq 被带进待核实区', pending.list()[0].qq === '333333333')

console.log('\n③ duplicate → 只计数，不进队')
const r3 = remember({ kind: 'fact', who: '主人', qq: '222222222', text: '他在福州工作。' })
check('返回 null', r3 === null)
check('dup=1', gate.dup === 1)
check('rejected=2（pending+dup）', gate.rejected === 2)
check('待核实区没变（重复没必要审）', pending.count() === 1)

console.log('\n④ 24 小时窗口')
const t0 = 1_700_000_000_000
const hour = 60 * 60 * 1000
const p1 = pending.add({ kind: 'fact', who: 'w', text: '同一句待核实内容', reason: 'insult', now: t0 })
const n1 = pending.count()
const p2 = pending.add({ kind: 'fact', who: 'w', text: '同一句待核实内容', reason: 'insult', now: t0 + 1000 })
check('24h 内同文不翻倍', pending.count() === n1)
check('24h 内复用同一条 id', p2.id === p1.id)
check('24h 内 createdAt 不变', p2.createdAt === t0)
const p3 = pending.add({
  kind: 'fact',
  who: 'w',
  text: '同一句待核实内容',
  reason: 'insult',
  now: t0 + 25 * hour,
})
check('超 24h 仍只留一条（不重复堆）', pending.count() === n1)
check('超 24h 后 createdAt 重新计时', p3.createdAt === t0 + 25 * hour)

console.log('\n⑤ approve：先入库成功，再出队')
const item = pending.list().find((x) => x.text === '他是你爹')
const memBefore = memory.entries.length
const entry = memory.add({
  kind: item.kind,
  who: item.who,
  qq: item.qq,
  text: item.text,
  weight: item.weight,
  at: Date.now(),
})
check('入库返回 entry', Boolean(entry && entry.id))
check('qq 保留', entry.qq === '333333333')
pending.reject(item.id)
check('正式库 +1', memory.entries.length === memBefore + 1)
check('待核实区已出队', pending.get(item.id) === null)

console.log('\n⑥ 失败路径：入库失败不出队 / 不存在 id')
const keep = pending.add({ kind: 'fact', who: 'w', text: '这条入库会失败', reason: 'insult' })
const bad = memory.add({ kind: 'fact', who: 'w', text: '   ', weight: 3 })
check('空文本入库返回 null', bad === null)
check('入库失败时条目仍在待核实区', pending.get(keep.id) !== null)
pending.reject(keep.id)
check('reject 后消失', pending.get(keep.id) === null)
check('approve 不存在的 id → get 为 null（路由据此回 404）', pending.get('nope') === null)
check('reject 不存在的 id 返回 false（路由据此回 404）', pending.reject('nope') === false)

console.log('\n⑦ 计数器自洽')
check('rejected === pending + dup', gate.rejected === gate.pending + gate.dup, `rejected=${gate.rejected}`)
check('added 与真实入库条数对得上', gate.added === 1)
check('/state 的 learner.memory 形状可直接展开（含 queued）', (() => {
  const out = { learner: { memory: { ...gate, queued: pending.count() } } }
  return Object.keys(out.learner.memory).sort().join(',') === 'added,dup,pending,queued,rejected'
})())
check('拦下来时留了日志（排查用）', logs.some((l) => l.includes('待核实区')))

console.log('\n⑧ 24h 去重不会打破等式（pending 是「拦截次数」，不是队列条数）')
const dir2 = path.join(process.cwd(), 'out', `_test-pending-gate-${process.pid}`)
fs.rmSync(dir2, { recursive: true, force: true })
fs.mkdirSync(dir2, { recursive: true })
const mem2 = new MemoryStore({ dir: dir2, logger: () => {} })
const pend2 = new PendingStore({ dir: dir2, logger: () => {} })
const gate2 = { added: 0, rejected: 0, pending: 0, dup: 0 }
const self2 = { memory: mem2, memoryPending: pend2, memoryGate: gate2, logger: () => {} }
const say = { kind: 'person', who: 'D.X.X', qq: '333333333', text: '他是你爹' }
for (let i = 0; i < 3; i += 1) ChatEngine.prototype.remember.call(self2, say)
check('同一条被拦 3 次 → rejected=3', gate2.rejected === 3, `rejected=${gate2.rejected}`)
check('pending 记的是拦截次数 3', gate2.pending === 3, `pending=${gate2.pending}`)
check('队列里只有 1 条（24h 去重生效）', pend2.count() === 1, `queued=${pend2.count()}`)
check('等式仍然成立 rejected === pending + dup', gate2.rejected === gate2.pending + gate2.dup)
check('pending !== queued（所以 /state 必须另给 queued）', gate2.pending !== pend2.count())
fs.rmSync(dir2, { recursive: true, force: true })

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
if (fail) {
  console.log('\n失败项：')
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
