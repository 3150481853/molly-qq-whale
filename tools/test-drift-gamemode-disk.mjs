/**
 * 闲逛 · 游戏模式落盘兜底（2026-11-22，主人 m04743「为什么又小黑盒」）。
 *
 * 为什么单独一个文件：这条线守的是「重启之后开关还在」——
 * 内存开关一重启就没了，而 DSH 重启是很日常的操作。
 * 离线跑，不联网、不碰 production 数据目录（用临时目录）。
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { Drift } from '../plugin/dsh-qq-whale/lib/drift.js'

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✔ ${name}`)
  } else {
    fail++
    console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

const mk = (over = {}) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'molly-gm-'))
  const d = new Drift({
    logger: () => {},
    config: { driftEnabled: true, ...over },
    executor: { run: async () => ({ ok: true, text: '[]' }) },
    engine: over.engine || null,
    dataDir: dir,
  })
  return { d, dir }
}
const writeGm = (dir, on) => writeFileSync(path.join(dir, 'game-mode.json'), JSON.stringify({ on, at: Date.now() }), 'utf8')

console.log('— 落盘兜底 —')
{
  const { d, dir } = mk()
  writeGm(dir, true)
  const st = d.gameModeState()
  ok('game-mode.json 说开着 → 认作开', st.on === true && st.source === 'disk', JSON.stringify(st))
  ok('getter 与 state 一致', d.gameModeOn === true)
  rmSync(dir, { recursive: true, force: true })
}
{
  const { d, dir } = mk()
  writeGm(dir, false)
  ok('game-mode.json 说关着 → 关', d.gameModeState().on === false)
  rmSync(dir, { recursive: true, force: true })
}
{
  const { d, dir } = mk()
  ok('文件不存在 → 关（不抛错）', d.gameModeState().on === false)
  rmSync(dir, { recursive: true, force: true })
}
{
  const { d, dir } = mk()
  writeFileSync(path.join(dir, 'game-mode.json'), '{坏 JSON', 'utf8')
  ok('文件坏掉 → 关（不抛错）', d.gameModeState().on === false)
  rmSync(dir, { recursive: true, force: true })
}
{
  const { d, dir } = mk({ gameModeOn: true })
  writeGm(dir, false)
  const st = d.gameModeState()
  ok('内存开关优先于落盘', st.on === true && st.source === 'runtime', JSON.stringify(st))
  rmSync(dir, { recursive: true, force: true })
}
{
  const engine = { config: { gameModeOn: true } }
  const { d, dir } = mk({ engine })
  ok('engine.config 也说开 → 开', d.gameModeState().on === true && d.gameModeState().source === 'engine')
  rmSync(dir, { recursive: true, force: true })
}
console.log('— 3 秒缓存 —')
{
  const { d, dir } = mk()
  writeGm(dir, true)
  const t = 1_000_000
  ok('首次读到开', d.gameModeState(t).on === true)
  writeGm(dir, false)
  ok('缓存窗口内仍报开（不每 tick 读盘）', d.gameModeState(t + 1000).on === true)
  ok('过了窗口读回关', d.gameModeState(t + 5000).on === false)
  rmSync(dir, { recursive: true, force: true })
}
console.log('— tick 真的会停手 —')
{
  const { d, dir } = mk()
  writeGm(dir, true)
  let ran = 0
  d.runOnce = async () => {
    ran++
    return { ok: true }
  }
  await d.tick()
  ok('游戏模式开着时 tick 不跑', ran === 0)
  rmSync(dir, { recursive: true, force: true })
}
{
  const { d, dir } = mk()
  writeGm(dir, false)
  let ran = 0
  d.runOnce = async () => {
    ran++
    return { ok: true }
  }
  // 让其它闸门都放开：时间窗内（起点 0 点、终点 24 点）、无冷却、无额度限制、够久没跑
  d.config.drift = { startHour: 0, endHour: 24, idleMinutes: 0, everyMinutes: 0, minBudgetLeft: 0, dailyCap: 8 }
  d.lastRunAt = 0
  await d.tick()
  ok('游戏模式关着时 tick 照跑', ran === 1)
  rmSync(dir, { recursive: true, force: true })
}
console.log('— status 上报 —')
{
  const { d, dir } = mk()
  writeGm(dir, true)
  const s = d.status()
  ok('status.gameMode 为 true', s.gameMode === true)
  ok('status.gameModeSource 为 disk', s.gameModeSource === 'disk', String(s.gameModeSource))
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${pass} 过 / ${fail} 挂`)
process.exit(fail ? 1 : 0)
