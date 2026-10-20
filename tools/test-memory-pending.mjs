/**
 * 待核实区单测：`lib/memory-pending.js`
 *
 * 只用临时目录，不碰真库（`${HOME}\.dsh\qq-whale\memory\`）。
 * 重点验证三件事：
 *   ① add → list → approve 的字段是完整的（approve 要能把 entry 交回调用方）；
 *   ② 上限 200 条时**丢最旧**的；
 *   ③ `approve()` 只动 pending.json，`memory.json` 一个字节都不写。
 *
 * 跑法：node tools/test-memory-pending.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { PendingStore, PENDING_LIMIT } from '../plugin/dsh-qq-whale/lib/memory-pending.js'

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
const store = new PendingStore({ dir })

console.log('\n① 增删查')
const a = store.add({ kind: 'fact', who: '主人', qq: '222222222', text: '他说你是傻逼', reason: 'insult' })
check('add 返回条目且有 id', Boolean(a && a.id))
check('qq 被规整成字符串', a.qq === '222222222')
check('count 为 1', store.count() === 1)
check('list 新的在前', store.list()[0].id === a.id)
check('get 能取到', store.get(a.id)?.text === '他说你是傻逼')
check('list 按 reason 过滤', store.list({ reason: 'insult' }).length === 1)
check('list 按不存在的 reason 过滤为空', store.list({ reason: 'nope' }).length === 0)

const dup = store.add({ kind: 'fact', who: '主人', qq: '222222222', text: '他说你是傻逼', reason: 'duplicate' })
check('同一句重复拦只留一条', store.count() === 1 && dup.id === a.id)
check('重复时 reason 刷新', store.get(a.id).reason === 'duplicate')

check('空 text 返回 null', store.add({ text: '   ' }) === null)
check('qq 非法时归空串', store.add({ text: '他在福州', qq: 'abc' }).qq === '')

console.log('\n② approve / reject')

// 造假 memory.json，用来证明 approve 不碰它
const memoryFile = path.join(dir, 'memory.json')
fs.writeFileSync(memoryFile, '{"version":1,"entries":[]}', 'utf8')
const before = fs.readFileSync(memoryFile, 'utf8')

const b = store.add({ kind: 'person', who: 'D.X.X', text: '他是你爹', reason: 'insult' })
const res = store.approve(b.id)
check('approve 返回 ok:true', res.ok === true)
check('approve 交回 entry（入库由调用方做）', Boolean(res.entry && res.entry.text === '他是你爹'))
check('approve 后从待核实区移除', store.get(b.id) === null)
check('approve 不写 memory.json', fs.readFileSync(memoryFile, 'utf8') === before)
check('approve 不存在的 id 返回 ok:false', store.approve('nope').ok === false)

const c = store.add({ kind: 'fact', who: '主人', text: '垃圾玩意', reason: 'insult' })
check('reject 返回 true', store.reject(c.id) === true)
check('reject 后条目消失', store.get(c.id) === null)
check('reject 不存在的 id 返回 false', store.reject('nope') === false)

console.log('\n③ 持久化与上限')
const again = new PendingStore({ dir })
check('新实例能读回条目', again.count() === store.count())
check('落盘形状为 {updatedAt, items}', (() => {
  const j = JSON.parse(fs.readFileSync(path.join(dir, 'pending.json'), 'utf8'))
  return typeof j.updatedAt === 'number' && Array.isArray(j.items)
})())
check('没有残留 .tmp 文件', !fs.existsSync(path.join(dir, 'pending.json.tmp')))

const big = new PendingStore({ dir: path.join(dir, 'big'), limit: 5 })
for (let i = 0; i < 8; i += 1) {
  big.add({ kind: 'fact', who: 'w', text: `第${i}条内容`, reason: 'insult', at: 1000 + i })
}
check('超上限裁到 limit 条', big.count() === 5)
const texts = big.list().map((e) => e.text)
check('丢的是最旧的（保留后 5 条）', !texts.includes('第0条内容') && texts.includes('第7条内容'))
check('默认上限是 200', PENDING_LIMIT === 200)

fs.rmSync(dir, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
if (fail) {
  console.log('\n失败项：')
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
