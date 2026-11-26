#!/usr/bin/env node
/*
 * 搜番：模糊回退 + 触发口径（2026-11-27，主人 m05816「排查：1.搜番功能」）。
 *
 * 真机现场（群 666666666，23:51）：
 *   主人发「@Molly 搜番 我是爱上心人所托来做恋爱迷情药的魔女」
 *   她压根没搜 —— 因为 OneBot 把 at 段剥掉后文本以空格开头，或者手打 @ 时整段还在，
 *   两种都和原来的 ^(?:搜番|找番) 对不上；就算对上了，AniBT 是字面子串匹配，
 *   名字差一两个字也必然空手（同一句原样查询 0 命中，改成「受心上人所托来做恋爱药的魔女」就命中）。
 *
 * 这里只测纯函数 + 源码口径（不联网）：真正跑网络的是 probe-anime-wire3.mjs / probe-anime-fuzzy.mjs。
 */
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  titleOverlap,
  fuzzyKeywords,
  fuzzyAnibt,
} from '../plugin/dsh-qq-whale/lib/anime-find.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB = path.join(HERE, '..', 'plugin', 'dsh-qq-whale', 'lib')
const engineSrc = fs.readFileSync(path.join(LIB, 'engine.js'), 'utf8')
const animeSrc = fs.readFileSync(path.join(LIB, 'anime-find.js'), 'utf8')

let pass = 0
let fail = 0
async function t(name, fn) {
  try {
    await fn()
    pass++
    console.log(`  PASS  ${name}`)
  } catch (err) {
    fail++
    console.log(`  FAIL  ${name}`)
    console.log(`        ${err?.message || err}`)
  }
}

const REAL_TITLE = '你好，我是受心上人所托来做恋爱药的魔女。'
const REAL_QUERY = '我是爱上心人所托来做恋爱迷情药的魔女'

await t('titleOverlap：真机那句（心上人/恋爱药）能过线 ≥0.55', () => {
  const v = titleOverlap({ name: REAL_TITLE, nameCn: '' }, REAL_QUERY)
  assert.ok(v >= 0.55, `实际 ${v}`)
})

await t('titleOverlap：完全无关的查询必须在 0.55 以下', () => {
  const v = titleOverlap({ name: REAL_TITLE, nameCn: '' }, '进击的巨人')
  assert.ok(v < 0.55, `实际 ${v}`)
})

await t('titleOverlap：一模一样就是 1', () => {
  assert.equal(titleOverlap({ name: REAL_TITLE, nameCn: '' }, REAL_TITLE), 1)
})

await t('titleOverlap：nameCn 也参与（中文名命中不输原名）', () => {
  const v = titleOverlap({ name: 'Majo', nameCn: '恋爱药的魔女' }, '魔女')
  assert.ok(v > 0, `实际 ${v}`)
})

await t('fuzzyKeywords：长句会切出含「魔女」的关键词，最多 3 个', () => {
  const kw = fuzzyKeywords(REAL_QUERY)
  assert.ok(kw.length > 0 && kw.length <= 3, `实际 ${kw.length} 个`)
  assert.ok(kw.some((k) => k.includes('魔女')), `实际 ${JSON.stringify(kw)}`)
})

await t('fuzzyKeywords：短词原样保留', () => {
  assert.deepEqual(fuzzyKeywords('魔女'), ['魔女'])
})

await t('fuzzyKeywords：空串 / 纯空白返回空数组', () => {
  assert.deepEqual(fuzzyKeywords(''), [])
  assert.deepEqual(fuzzyKeywords('   '), [])
})

await t('fuzzyAnibt 是个函数（形参 shape 没变，测试里不联网）', () => {
  assert.equal(typeof fuzzyAnibt, 'function')
})

await t('engine：maybeAnimeFind 先剥 @昵称 / 前导空白，再判断命令', () => {
  assert.ok(engineSrc.includes('const head = textStr'), '缺少 head 归一化')
  assert.ok(engineSrc.includes('.replace(/^[\\s\\u3000]+/u, \'\')'), '缺少前导空白剥离')
  assert.ok(engineSrc.includes('const hashCmd = /^[#＃]\\s*(?:茉莉)?\\s*(?:搜番|找番|番剧)/iu.test(head)'), 'hashCmd 没测 head')
  assert.ok(engineSrc.includes('const bare = /^(?:搜番|找番)\\s*\\S/u.test(head)'), 'bare 没测 head')
})

await t('engine：默认超时放到 20000（冷启动 13~22 秒）', () => {
  assert.ok(engineSrc.includes(': 20000'), '没找到 20000 的兜底')
  assert.ok(!/animeFindTimeoutMs\) > 0 \? Number\(this\.config\.animeFindTimeoutMs\) : 8000/.test(engineSrc), '还是 8000')
})

await t('engine：没有 carry 时把触发消息本身钉成引用锚点（纯 @ 除外）', () => {
  assert.ok(engineSrc.includes("isPureNudge(ev) ? '' : String(ev?.message_id ?? '')"), '锚点兜底没接上')
})

await t('anime-find：模糊回退接在 infoJob 里，且带 deadline', () => {
  assert.ok(animeSrc.includes('export async function fuzzyAnibt'), '没导出 fuzzyAnibt')
  assert.ok(animeSrc.includes("withDeadline(fuzzyAnibt("), '没接到 withDeadline')
  assert.ok(animeSrc.includes("'模糊回退'"), '没标名字')
})

await t('anime-find：模糊结果不再被 rankCandidates 打散', () => {
  assert.ok(animeSrc.includes('rawHits[0]?._fuzzy ? rawHits'), '排序分支缺失')
})

console.log(`\n${pass} 过 / ${fail} 挂`)
process.exit(fail === 0 ? 0 : 1)
