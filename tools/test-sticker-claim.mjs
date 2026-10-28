/**
 * 「发图宣告被当正文」回归测试（2026-10-28，主人「表情包又开始文字了」）。
 *
 * 背景：她真发图后，history 里记的是人话「（我发了张表情包：无语）」；
 * 模型学走句式后会改写成「（我打了张打哈欠的图，先撤了）」——旧的出口护栏
 * 只认原句式，改写版就原样发成文字，群里出现"说发了图其实没发"。
 *
 * 跑法（离线，不连 QQ、不花额度）：
 *   node tools/test-sticker-claim.mjs
 */
import { PersonaStore } from '../plugin/dsh-qq-whale/lib/persona.js'

const p = new PersonaStore({
  dir: '${MOLLY_ROOT}/qq-whale/plugin/dsh-qq-whale/persona',
  logger: () => {},
})

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`)
  }
}
const kinds = (text) => p.splitReply(text, { maxStickersPerReply: 2 })
const stickers = (text) => kinds(text).filter((x) => x.type === 'sticker')
const texts = (text) => kinds(text).filter((x) => x.type === 'text').map((x) => x.text).join('')

console.log('[1] 改写式发图宣告 → 必须真的出图')
{
  const a = stickers('收到，鱼要睡了。\n（我打了张打哈欠的图，先撤了）')
  ok('「我打了张打哈欠的图」→ 出图', a.length === 1, JSON.stringify(a))
  ok('关键词抽到「打哈欠」', a[0]?.query === '打哈欠', a[0]?.query)
  ok('旁白文字没漏进正文', !texts('收到，鱼要睡了。\n（我打了张打哈欠的图，先撤了）').includes('我打了'))

  const b = stickers('（我甩了张表情包：睡觉）')
  ok('「我甩了张表情包：睡觉」→ 出图且关键词=睡觉', b[0]?.query === '睡觉', JSON.stringify(b))

  const c = stickers('给你看（我贴了张震惊的图）')
  ok('「我贴了张震惊的图」→ 关键词=震惊', c[0]?.query === '震惊', JSON.stringify(c))

  const d = stickers('（我打了张图）')
  ok('抽不到关键词也要出图（query 留空→随机）', d.length === 1 && !d[0].query, JSON.stringify(d))

  // 2026-10-28 真机追加的两种变体（主人：发语音也会带着「（我发送了一个表情：xx）」）
  const e = stickers('（发了张表情包：眯眼）')
  ok('省略主语的「（发了张表情包：眯眼）」→ 出图', e[0]?.query === '眯眼', JSON.stringify(e))
  const f = stickers('（我发送了一个表情：可爱）')
  ok('「发送」+「表情」（无"包"）→ 出图', f[0]?.query === '可爱', JSON.stringify(f))
}

console.log('[2] 原有两种写法不能被改坏')
{
  ok('「（我发了张表情包：无语）」仍出图', stickers('（我发了张表情包：无语）')[0]?.query === '无语')
  ok('「[表情包:得意]」仍出图', stickers('[表情包:得意]')[0]?.query === '得意')
}

console.log('[3] 纯旁白动作 → 删旁白，但不删正文')
{
  const t = texts('主人乖，被子捂好。晚安，明天见。\n（我闭眼了）')
  ok('正文保留', t.includes('晚安，明天见'))
  ok('旁白被删掉', !t.includes('我闭眼'))
  ok('不会整条变空（只有旁白时保留原文）', texts('（我闭眼了）').length > 0)
}

console.log('[4] 不该误伤的情况')
{
  ok('普通插入语不动', texts('这道题（我觉得）会考').includes('我觉得'))
  ok('语音宣告仍走语音', kinds('（我发了一条语音：晚安了）').some((x) => x.type === 'voice'))
  ok('正常句子原样', texts('主人早，饭吃了吗') === '主人早，饭吃了吗')
}

console.log('[5] 语音文本清洗：不许把「发了张表情包」念出来')
{
  const { cleanVoiceText } = await import('../plugin/dsh-qq-whale/lib/voice.js')
  ok('语音里夹的宣告被剔掉', cleanVoiceText('晚安（我发送了一个表情：可爱）') === '晚安', cleanVoiceText('晚安（我发送了一个表情：可爱）'))
  ok('整句都是宣告 → 清成空（出口会降级/丢弃）', cleanVoiceText('（发了张表情包：眯眼）') === '')
  ok('正常句子不动', cleanVoiceText('晚安，做个好梦') === '晚安，做个好梦')
  ok('不含图/表情的括号保留', cleanVoiceText('这张图（好好笑）') === '这张图（好好笑）', cleanVoiceText('这张图（好好笑）'))
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail ? 1 : 0)
