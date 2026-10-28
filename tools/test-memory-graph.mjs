/**
 * 识海图（edges 图扩散）+ tag 抽象 专测。
 *
 * 背景（2026-10-28）：对照小黑盒那篇「四层记忆框架」，Molly 的记忆库缺两件事——
 *   ① 事实节点之间没有边：同一件事的几条记忆不会互相「带出来」；
 *   ② 同一个 tag 下攒了一堆同类事实，没人把它们压成一条规律。
 * 这两个功能各有开关（memoryGraph / memoryAbstract），默认关；
 * 本文件既验「开着时的行为」，也验「关掉时和改动前逐条一致」。
 *
 * 只碰 ${MOLLY_ROOT}\out 下的临时目录，绝不读写生产记忆。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemoryStore, GRAPH_DECAY, GRAPH_HOPS, GRAPH_EDGE_MAX, GRAPH_EDGE_IDLE_DAYS, ABSTRACT_MIN_COUNT } from 'file:///${MOLLY_ROOT}/qq-whale/plugin/dsh-qq-whale/lib/memory.js'

const ROOT = '${MOLLY_ROOT}/out/test-memory-graph-data'
if (!/out/i.test(ROOT)) throw new Error(`拒绝运行：临时目录必须在 out/ 下，当前 ${ROOT}`)
fs.rmSync(ROOT, { recursive: true, force: true })
fs.mkdirSync(ROOT, { recursive: true })

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`  ✔ ${name}`)
  } else {
    fail += 1
    console.log(`  ✘ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}
function makeStore(tag, opts = {}) {
  const dir = path.join(ROOT, tag)
  fs.mkdirSync(dir, { recursive: true })
  const logs = []
  const store = new MemoryStore({ dir, logger: (l, m) => logs.push(`${l}: ${m}`), limit: 200, ...opts })
  return { store, logs, dir }
}
const fakePool = (items) => items.map((x) => ({ e: { id: x.id, edges: x.edges || [] }, rrf: x.rrf }))

console.log('\n[1] 图扩散：一条边就能把关联条目抬到前面')
{
  const { store } = makeStore('diffuse', { graph: true })
  store.entries = [
    { id: 'A', kind: 'fact', text: 'a', weight: 6, hits: 0 },
    { id: 'B', kind: 'fact', text: 'b', weight: 6, hits: 0 },
    { id: 'C', kind: 'fact', text: 'c', weight: 6, hits: 0, edges: [['B', 1, Date.now()]] },
  ]
  const pool = fakePool([
    { id: 'A', rrf: 0.0166 },
    { id: 'C', rrf: 0.0166, edges: [['B', 1, Date.now()]] },
    { id: 'B', rrf: 0.0083, edges: [['A', 1, Date.now()], ['C', 1, Date.now()]] },
  ])
  const boost = store.graphBoost(pool)
  ok('B 拿到扩散增益（1 跳）', (boost.get('B') || 0) > 0, `boost=${boost.get('B')}`)
  ok('增益 = 种子 rrf × 0.6 × 边权', Math.abs((boost.get('B') || 0) - 0.0166 * GRAPH_DECAY) < 1e-9)
  const ranked = [...pool].map((x) => ({ id: x.e.id, s: x.rrf + (boost.get(x.e.id) || 0) })).sort((a, b) => b.s - a.s)
  ok('加了增益后 B 排进前三（原本最后）', ranked.findIndex((x) => x.id === 'B') <= 2, JSON.stringify(ranked))
}

console.log('\n[2] 只扩两跳：第三跳够不到')
{
  const { store } = makeStore('hops', { graph: true })
  store.entries = ['A', 'B', 'C', 'D'].map((id) => ({ id, kind: 'fact', text: id, weight: 6, hits: 0 }))
  const now = Date.now()
  const pool = fakePool([
    { id: 'A', rrf: 0.0166, edges: [['B', 1, now]] },
    { id: 'B', rrf: 0.0083, edges: [['A', 1, now], ['C', 1, now]] },
    { id: 'C', rrf: 0.0041, edges: [['B', 1, now], ['D', 1, now]] },
    { id: 'D', rrf: 0.002, edges: [['C', 1, now]] },
  ])
  // seeds=1：只让最强的那条当种子，这样「第几跳」才有确定的含义
  const boost = store.graphBoost(pool, { seeds: 1 })
  ok('1 跳 B 有增益', (boost.get('B') || 0) > 0)
  ok('2 跳 C 有增益', (boost.get('C') || 0) > 0)
  ok(`3 跳 D 没有增益（题目只允许 ${GRAPH_HOPS} 跳）`, !boost.has('D'), `boost=${boost.get('D')}`)
  const twoHop = (0.0166 * GRAPH_DECAY || 0) * GRAPH_DECAY
  ok('2 跳按 ×0.6 再打一次折', Math.abs((boost.get('C') || 0) - twoHop) < 1e-6, `C=${boost.get('C')} twoHop=${twoHop}`)
}

console.log('\n[3] 边老化：老边、悬空边、弱边都要清掉，新边留下')
{
  const { store } = makeStore('prune', { graph: true })
  const now = Date.now()
  const a = { id: 'A', kind: 'fact', text: 'a', weight: 6, hits: 0 }
  const b = { id: 'B', kind: 'fact', text: 'b', weight: 6, hits: 0 }
  store.entries = [a, b]
  a.edges = [
    ['B', 0.9, now], // 新边，留
    ['ghost', 0.9, now], // 悬空，删
    ['B2', 0.9, now - (GRAPH_EDGE_IDLE_DAYS + 1) * 86400000], // 老边（B2 也不存在）→ 删
    ['B', 0.01, now], // 弱边（同一目标的一条）→ 删
  ]
  const dropped = store.pruneEdges()
  ok('清掉了 3 条不该留的边', dropped === 3, `dropped=${dropped}`)
  ok('新边还在', JSON.stringify(a.edges).includes('"B"') && a.edges.length === 1, JSON.stringify(a.edges))
}

console.log('\n[4] 单节点边数上限')
{
  const { store } = makeStore('cap', { graph: true })
  const a = { id: 'A', kind: 'fact', text: 'a', weight: 6, hits: 0 }
  store.entries = [a]
  for (let i = 0; i < GRAPH_EDGE_MAX + 4; i += 1) {
    const other = { id: `N${i}`, kind: 'fact', text: 'x', weight: 6, hits: 0 }
    store.entries.push(other)
    store.addEdge(a, other)
  }
  ok(`边数被裁到 ${GRAPH_EDGE_MAX} 条`, a.edges.length === GRAPH_EDGE_MAX, `len=${a.edges.length}`)
}

console.log('\n[5] tag 抽象：攒够 3 条 + 被问过 → 生成一条规律节点，且不重复生成')
{
  // 先关着攒数据（add() 会顺手 prune，开着的话边加边抽象就看不清"这一跑生成了几条"）
  const { store } = makeStore('abstract', { abstractTags: false })
  const mk = (text, tag, hits = 0) => {
    const e = store.add({ kind: 'fact', who: '甲', text, weight: 6 })
    e.tags = [tag]
    e.hits = hits
    return e
  }
  const a = mk('他养了一只猫叫团子', '猫', 2)
  const b = mk('周末他给猫买了新猫爬架', '猫')
  const c = mk('猫把他键盘踩坏了', '猫')
  mk('他喜欢喝冰美式', '咖啡', 1) // 只有 2 条同类，不该抽象
  store.abstractTagsEnabled = true
  const n1 = store.abstractTags()
  ok('生成 1 条抽象节点', n1 === 1, `n=${n1}`)
  const abstractNodes = store.entries.filter((e) => e.abstractOf === '猫')
  ok('抽象节点正文以「关于猫：」开头', abstractNodes.length === 1 && abstractNodes[0].text.startsWith('关于猫：'))
  ok('抽象节点带 abstract 标签', abstractNodes[0]?.tags?.includes('abstract'))
  ok('原条目各降一级（level 1）', [a, b, c].every((e) => e.level === 1), JSON.stringify([a.level, b.level, c.level]))
  ok('咖啡 tag 没到 3 条，不抽象', !store.entries.some((e) => e.abstractOf === '咖啡'))
  const n2 = store.abstractTags()
  ok('再跑一次不新增', n2 === 0 && store.entries.filter((e) => e.abstractOf === '猫').length === 1)
  ok('原条目不会无限降级', [a, b, c].every((e) => e.level === 1))
  ok(`ABSTRACT_MIN_COUNT 是 ${ABSTRACT_MIN_COUNT}`, ABSTRACT_MIN_COUNT === 3)
}

console.log('\n[6] 召回接线：graph 开着时，一起被想起来的条目自动连边')
{
  const { store } = makeStore('recall-on', { graph: true })
  store.add({ kind: 'fact', who: '甲', qq: '10001', text: '他养了一只猫叫团子', weight: 6 })
  store.add({ kind: 'fact', who: '甲', qq: '10001', text: '他住在杭州', weight: 6 })
  store.add({ kind: 'event', who: '甲', qq: '10001', text: '昨天一起吃了火锅', weight: 6 })
  const picked = store.recall({ who: '甲', qq: '10001', query: '' })
  const linked = picked.filter((e) => Array.isArray(e.edges) && e.edges.length)
  ok('召回后头部条目之间连出了边', linked.length >= 2, `linked=${linked.length}/${picked.length}`)
  ok('边是双向的（两端都记着对方）', linked.every((e) => e.edges.some(([id]) => picked.some((p) => p.id === id))))
}

console.log('\n[7] 关掉开关：行为与改动前一致（不连边、不扩散、不抽象）')
{
  const { store } = makeStore('recall-off', { graph: false, abstractTags: false })
  store.add({ kind: 'fact', who: '乙', qq: '10002', text: '他养了一只狗叫豆豆', weight: 6 })
  store.add({ kind: 'fact', who: '乙', qq: '10002', text: '他住在成都', weight: 6 })
  store.add({ kind: 'event', who: '乙', qq: '10002', text: '昨天一起看了电影', weight: 6 })
  const picked = store.recall({ who: '乙', qq: '10002', query: '' })
  ok('召回结果里没有任何 edges 字段', picked.every((e) => e.edges === undefined), JSON.stringify(picked.map((e) => !!e.edges)))
  ok('lastRecall 里 graph 增益恒为 0', (store.lastRecall?.top || []).every((t) => t.graph === 0))
  ok('graphBoost 在关闭时直接空转', store.graphBoost(fakePool([{ id: 'A', rrf: 1 }, { id: 'B', rrf: 1 }])).size === 0)
  for (const e of store.entries) e.tags = ['狗']
  ok('abstractTags 在关闭时返回 0', store.abstractTags() === 0)
  store.prune()
  ok('prune 不产生抽象节点', !store.entries.some((e) => e.abstractOf))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
fs.rmSync(ROOT, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
