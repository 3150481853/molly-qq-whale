// 2026-11-06 主人 m00667：「不要多句话揉在一起，分开回复」
// 验证 splitReply 现在把换行也当分隔符（一行一条），并且有气泡上限。
import assert from 'node:assert/strict'
import { PersonaStore } from '../plugin/dsh-qq-whale/lib/persona.js'

const split = (text, opts) => PersonaStore.prototype.splitReply.call({}, text, opts)

let pass = 0
let fail = 0
const t = (name, fn) => {
  try {
    fn()
    pass++
    console.log(`  PASS  ${name}`)
  } catch (err) {
    fail++
    console.log(`  FAIL  ${name}: ${err.message}`)
  }
}

const texts = (parts) => parts.filter((p) => p.type === 'text').map((p) => p.text)

console.log('# splitReply：一行一条')

t('换行切成两条', () => {
  const got = texts(split('发死老鼠这事我谴责一下\n鹈鹕你今晚的白饭没了'))
  assert.deepEqual(got, ['发死老鼠这事我谴责一下', '鹈鹕你今晚的白饭没了'])
})

t('<sep/> 仍然有效，且能和换行混用', () => {
  const got = texts(split('第一句<sep/>第二句\n第三句'))
  assert.deepEqual(got, ['第一句', '第二句', '第三句'])
})

t('空行丢掉，不产生空气泡', () => {
  const got = texts(split('甲\n\n\n乙\n   \n丙'))
  assert.deepEqual(got, ['甲', '乙', '丙'])
})

t('<br> 也变成分条（以前是条内换行）', () => {
  const got = texts(split('甲<br>乙'))
  assert.deepEqual(got, ['甲', '乙'])
})

t('表情包和文字各自成条', () => {
  const parts = split('<sticker>开心</sticker>\n第二句')
  assert.equal(parts.length, 2)
  assert.equal(parts[0].type, 'sticker')
  assert.equal(parts[1].type, 'text')
  assert.equal(parts[1].text, '第二句')
})

t('默认上限 5 条：多出来的并回最后一条', () => {
  const raw = ['1', '2', '3', '4', '5', '6', '7', '8'].join('\n')
  const got = texts(split(raw))
  assert.equal(got.length, 5)
  assert.equal(got[4], '5\n6\n7\n8')
})

t('上限可调：maxTextBubblesPerReply=2', () => {
  const got = texts(split('1\n2\n3\n4', { maxTextBubblesPerReply: 2 }))
  assert.equal(got.length, 2)
  assert.equal(got[1], '2\n3\n4')
})

t('不揉在一起之后，@ 目标仍挂第一条文字', () => {
  const parts = split('<at>123456789</at>第一句\n第二句')
  const firstText = parts.find((p) => p.type === 'text')
  assert.equal(firstText.atQq, '123456789')
  assert.equal(firstText.text, '第一句')
})

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail ? 1 : 0)
