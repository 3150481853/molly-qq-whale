/*
 * 称谓解析自测（2026-10-26，主人 m02960）。
 *
 * 背景：第一条「称谓」功能上线后她仍然不叫「宝宝」。回查发现库里混进了
 * `他希望你叫他「什」`（把「你叫我什么」抽成了称呼），而且自称句也被当成
 * 硬要求并列——三段互相矛盾，模型就退回群名片叫法。
 *
 * 现在 memory.addressName() 只认第二人称指令句式，这里把真实条目和反例都钉住。
 *
 *   node tools\memory-address-parse-selftest.mjs
 *
 * 退出码 0 = 全过。
 */
import { addressName } from '../plugin/dsh-qq-whale/lib/memory.js'

const cases = [
  // 事故原文：反问被抽成称呼，必须拒绝
  ['他希望你叫他「什」', ''],
  // 真正的称呼要求
  ['他希望你叫他「宝宝」，每次开口就要叫，不用等他提醒', '宝宝'],
  // 自称句：没有「叫他」，不算称呼要求
  ['他自称「你宝宝呢」——急了会拿这句当自称', ''],
  // 主人
  ['他是主人本人，你叫他「主人」', '主人'],
  // 否定 + 改口
  ['他不要「主人」这个称呼，叫他「老大」', '老大'],
  // 只有「认下…叫法」，没有明确指令 → 不抽
  ['他认下了「哦鲸鲸」这个叫法', ''],
  // 自称 + 明确叫他
  ['他自称「茶茶」，可以直接叫他茶茶', '茶茶'],
  // 习惯叫你
  ['他习惯叫你「Niki」，要答应', 'Niki'],
  // 英文名
  ['他希望你叫他「Fuy」', 'Fuy'],
  // 空格
  ['他自称「example-friend」，叫他 example-friend 就行', 'example-friend'],
  // 昵称说明（认错人的那类）不是称呼要求
  ['他的 QQ 昵称是「子房有礼了」（QQ 888888888），是他自己用的名字，可以这样称呼他。', ''],
  // 原话反问
  ['你叫我什么', ''],
  ['叫我出来', ''],
  // 同一条里混着别的事实
  ['他希望你叫他「宝宝」；他喜欢跟你撒娇', '宝宝'],
  // 只有自称、没有指令
  ['他自称「chovy」，原话是「我chovy」，习惯用这个外号自称。', ''],
]

let failed = 0
for (const [text, want] of cases) {
  const got = addressName(text)
  const ok = got === want
  if (!ok) failed += 1
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${text.slice(0, 40)} → ${JSON.stringify(got)}${ok ? '' : `（期望 ${JSON.stringify(want)}）`}`)
}
console.log(failed ? `\n${failed} 项失败` : `\n全部通过（${cases.length} 项）`)
process.exitCode = failed ? 1 : 0
