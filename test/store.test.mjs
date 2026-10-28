import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { JasmineStore, weekStart } from '../index.mjs'
import { effectiveWeight, isArchivable, weekKeyOf } from '../index.mjs'

let now = Date.UTC(2026, 10, 16, 10, 0, 0) // 2026-11-16 周一（UTC）
const clock = () => now

function open() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jasmine-'))
  return new JasmineStore({ dir, clock, logger: () => {} })
}

test('add 落盘、重开能读回来', () => {
  const s = open()
  const e = s.add({ kind: 'fact', text: '她住在杭州', who: '小明', qq: '123456789' })
  assert.ok(e?.id)
  const back = new JasmineStore({ dir: s.dir, clock })
  assert.equal(back.entries.length, 1)
  assert.equal(back.entries[0].text, '她住在杭州')
  assert.equal(back.entries[0].qq, '123456789')
})

test('近似重复 0.92 以上直接跳过', () => {
  const s = open()
  s.add({ kind: 'fact', text: '她养了一只叫团子的猫', who: '小明' })
  const again = s.add({ kind: 'fact', text: '她养了一只叫团子的猫', who: '小明' })
  assert.equal(again?.skipped, true)
  assert.equal(s.entries.length, 1)
})

test('0.70~0.92 合并进老条目', () => {
  const s = open()
  const a = s.add({ kind: 'event', text: '今天她去了西湖', who: '小明' })
  const b = s.add({ kind: 'event', text: '今天她去了西湖边上', who: '小明' })
  assert.equal(s.entries.length, 1)
  assert.equal(b.id, a.id)
  assert.equal(b.text, '今天她去了西湖边上')
})

test('冲突：两条都留，旧的打 supersededBy 且不进召回', () => {
  const s = open()
  const a = s.add({ kind: 'preference', text: '她喜欢猫', who: '小明', qq: '123456789' })
  s.add({ kind: 'preference', text: '她其实不喜欢猫', who: '小明', qq: '123456789' })
  assert.equal(s.entries.length, 2)
  assert.equal(s.byId(a.id).supersededBy, s.entries[1].id)
  const { items } = s.recall({ qq: '123456789', query: '猫' })
  assert.equal(items.length, 1)
  assert.match(items[0].text, /不喜欢/)
})

test('召回：问西湖就该西湖排第一', () => {
  const s = open()
  s.add({ kind: 'fact', text: '她讨厌下雨天', who: '小明', qq: '123456789' })
  s.add({ kind: 'event', text: '上周她去了西湖看荷花', who: '小明', qq: '123456789' })
  const { items, trace } = s.recall({ qq: '123456789', query: '西湖怎么样' })
  assert.ok(items.length >= 1)
  assert.match(items[0].text, /西湖/)
  assert.equal(trace.candidates, 2)
  assert.ok(trace.arms.keyword >= 1)
})

test('字符预算：超预算的条目被跳过，至少留一条', () => {
  const s = open()
  for (let i = 0; i < 5; i++) s.add({ kind: 'fact', text: `第${i}条：${'很长'.repeat(20)}`, who: '小明', qq: '123456789' })
  const { items } = s.recall({ qq: '123456789', query: '', charBudget: 10 })
  assert.equal(items.length, 1)
})

test('衰减：活跃天够了才掉，7 个活跃天掉 0.5', () => {
  const e = { kind: 'fact', weight: 6, lastActiveDay: 0 }
  assert.equal(effectiveWeight(e, 0), 6)
  assert.equal(effectiveWeight(e, 14), 6)
  assert.equal(effectiveWeight(e, 21), 5.5)
  assert.equal(effectiveWeight(e, 28), 5)
  // 下限：fact 掉到 3 就不再掉
  assert.equal(effectiveWeight(e, 200), 3)
  // 称谓恒定 10
  assert.equal(effectiveWeight({ kind: 'address', weight: 1 }, 999), 10)
})

test('归档：只有 event/meme 掉到底且晾够 90 活跃天才挪走', () => {
  const s = open()
  const old = s.add({ kind: 'event', text: '很久以前的一场雨', who: '小明', weight: 1 })
  s.add({ kind: 'fact', text: '她讨厌下雨天', who: '小明', weight: 3 })
  const probe = { ...old }
  assert.equal(isArchivable({ ...probe, lastActiveDay: 0 }, { activeDays: 89 }), false)
  assert.equal(isArchivable({ ...probe, lastActiveDay: 0 }, { activeDays: 90 }), true)
  s.byId(old.id).lastActiveDay = 0 // add() 会把 lastActiveDay 记成当天，这里手动退到 90 天前
  s.meta.activeDays = 90
  const moved = s.archiveStale()
  assert.equal(moved, 1)
  assert.equal(s.entries.length, 1)
  assert.equal(s.archive.length, 1)
  assert.equal(s.status().archiveCount, 1)
})

test('原始账：每步都有记录，卡删了也能重建', () => {
  const s = open()
  s.add({ kind: 'fact', text: '她喜欢茉莉花', who: '小明' })
  s.add({ kind: 'fact', text: '她喜欢茉莉花茶', who: '小明' })
  const lines = s.tailRaw(10)
  assert.ok(lines.length >= 2)
  assert.ok(lines.some((l) => l.op === 'add'))

  fs.unlinkSync(s.cardFile)
  const back = new JasmineStore({ dir: s.dir, clock })
  assert.equal(back.entries.length, 0)
  const rebuilt = back.rebuildFromRaw()
  assert.equal(rebuilt.entries, 1)
  assert.equal(back.entries[0].text, '她喜欢茉莉花茶')
})

test('活跃天：同一天多写只算一天', () => {
  const s = open()
  s.add({ kind: 'fact', text: '一' })
  s.add({ kind: 'fact', text: '二' })
  assert.equal(s.meta.activeDays, 1)
  now += 86_400_000
  s.add({ kind: 'fact', text: '三' })
  assert.equal(s.meta.activeDays, 2)
})

test('周聚合：上一周的事件压成一条 level=2，原事件 level+1', () => {
  const s = open()
  const lastWeek = now - 3 * 86_400_000 // 周六
  now = lastWeek
  s.add({ kind: 'event', text: '一起去看了海', who: '小明' })
  s.add({ kind: 'event', text: '晚上吃了火锅', who: '小明' })
  now = Date.UTC(2026, 10, 16, 10, 0, 0)
  const key = weekKeyOf(lastWeek)
  const res = s.aggregateWeek({ weekKey: key })
  assert.equal(res.facts.length, 2)
  assert.equal(res.summary.level, 2)
  assert.equal(res.summary.kind, 'event')
  assert.match(res.summary.text, /周记/)
  for (const f of res.facts) assert.equal(f.level, 1)
  assert.ok(weekStart(key) > 0)
})

test('导出/导入整包', () => {
  const a = open()
  a.add({ kind: 'fact', text: '她叫茉莉', who: '主人' })
  const bundle = a.exportBundle()
  const b = open()
  b.importBundle(bundle)
  assert.equal(b.entries.length, 1)
  assert.equal(b.entries[0].text, '她叫茉莉')
})
