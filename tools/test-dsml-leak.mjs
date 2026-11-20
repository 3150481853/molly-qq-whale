// DSML 假调用泄漏（2026-11-20 真机事故，QQ 群 666666666）
//
// 现场：Yeats 发了张图问「打出来效果是这样」，Molly 回了三颗气泡：
//   「皮卡丘（QQ 2534545721）：[图片] </｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>」
//   「</｜｜DSML｜｜ invoke>」
//   「</｜｜DSML｜｜ calls>」
// 竖线是全角 ｜，前后空格也不固定——之前的清洗层只认半角 `</invoke>`，漏了。
//
// 这里只测清洗：任何 DSML 变体都不许原样出门。

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

const DSML = '</｜｜DSML｜｜ invoke>'

t('全角竖线的 DSML 假调用整段删掉', () => {
  const out = sanitizeOutbound(`好，我看了一下 ${DSML}`)
  assert.ok(!/DSML/i.test(out), '不许留 DSML：' + out)
  assert.match(out, /好，我看了一下/)
})

t('只有假调用的那条消息被清成空串（上层据此不发）', () => {
  assert.equal(sanitizeOutbound(DSML).trim(), '')
  assert.equal(sanitizeOutbound('</｜｜DSML｜｜ calls>').trim(), '')
})

t('半角与空格变体也要删', () => {
  for (const v of ['</||DSML||invoke>', '<| |DSML| |calls>', '</ ｜｜ DSML ｜｜ invoke >', '</||dsml||invoke>']) {
    const out = sanitizeOutbound(`嗯 ${v}`)
    assert.ok(!/dsml/i.test(out), '漏了：' + v + ' → ' + out)
  }
})

t('裸标记（没尖括号）也不许出门', () => {
  const out = sanitizeOutbound('要我说 ｜｜DSML｜｜ invoke 就这')
  assert.ok(!/DSML/i.test(out), '漏了：' + out)
})

t('那次事故的整条内容全清掉', () => {
  const raw = '皮卡丘（QQ 2534545721）：[图片] </｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>'
  const out = sanitizeOutbound(raw)
  assert.ok(!/DSML/i.test(out), '不许留 DSML：' + out)
  assert.ok(!/2534545721/.test(out), '不该带别人的 QQ 号：' + out)
})

t('行首伪造的「昵称（QQ 123）：」引用头砍掉', () => {
  const out = sanitizeOutbound('皮卡丘（QQ 2534545721）：我说这图不错')
  assert.ok(!out.startsWith('皮卡丘'), '引用头没砍掉：' + out)
  assert.match(out, /我说这图不错/)
})

t('句子中间提到 QQ 号正常保留', () => {
  const out = sanitizeOutbound('皮卡丘那个号是 2534545721，我记下了')
  assert.match(out, /2534545721/)
})

t('正常回复一个字都不该动', () => {
  const say = '这张图我看了半天，像是《明日方舟》的立绘。'
  assert.equal(sanitizeOutbound(say), say)
})

console.log(`\n${pass} 过 / ${fail} 挂`)
process.exit(fail ? 1 : 0)
