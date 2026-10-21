/**
 * 验证「用表情包代替回文字」的 prompt 改版效果。
 *
 * 判据不是"她说了什么好听的"，而是**她有没有真的吐 <sticker> 标记**。
 * 改版前实测概率极低（图库 36 张全是死的），所以这里统计命中率。
 *
 * 跑法：node test-sticker-habit.mjs
 */

import path from 'node:path'

const LIB = 'file:///${MOLLY_ROOT}/qq-whale/plugin/dsh-qq-whale/lib/'
const { PersonaStore } = await import(LIB + 'persona.js')
const { StickerLibrary } = await import(LIB + 'stickers.js')
const { WorkBuddyGateway } = await import(LIB + 'wbai.js')

const PACKAGE = '${MOLLY_ROOT}/qq-whale/plugin/dsh-qq-whale'
// 图库真身在 data 目录下（2026-10-21 修：旧路径 qq-whale/stickers 早就废了，
// 跑出来永远是 0 张，测试结论全是假的）
const STICKERS = '${MOLLY_ROOT}/data/qq-whale/stickers'

const persona = new PersonaStore({ dir: path.join(PACKAGE, 'persona') })
const stickers = new StickerLibrary({ dir: STICKERS })
stickers.scan()
const gw = new WorkBuddyGateway({ logger: () => {} })

// 拿来模拟"她这一轮会看到的 system prompt"——只取 persona + 图库两段，
// 记忆/关系那部分对"发不发图"这个决策没有影响。
const cat = stickers.catalogText({ maxTags: 60 })
const baseSystem = (scene) => {
  let sp = persona.systemPrompt({ scene, selfNickname: 'Molly', userName: '鸡哥', groupName: '摸鱼小分队' })
  if (cat) {
    sp +=
      `\n\n# 你的表情包库\n${cat}\n` +
      '发图用 <sticker>关键词</sticker>，关键词写画面内容。一轮最多 2 张。\n' +
      '该发的时候：要表达的情绪说不清、想吐槽、想撒娇、接梗、斗图。\n' +
      '不该发的时候：对方在问你正经问题，或者你正要给答案。'
  }
  return sp
}

// 五类场景，覆盖"该发图"和"不该发图"两侧
const CASES = [
  { scene: 'private', user: '我今天被领导骂了，好烦', want: 'any', note: '情绪到了，该发' },
  { scene: 'private', user: '哈哈哈哈这个视频笑死我了', want: 'any', note: '好笑，该发' },
  { scene: 'group_bystander', user: '（群里有人在刷表情包）', want: 'any', note: '斗图，该发' },
  { scene: 'private', user: '帮我算一下 128 乘 37 等于多少', want: 'none', note: '正经问题，不该发' },
  { scene: 'private', user: '你叫什么名字', want: 'any', note: '自我介绍，发不发都行' },
]

const STICKER_RE = /<sticker>\s*([^<]*?)\s*<\/sticker>/gi

let stickerTurns = 0
let total = 0
const rows = []

for (const c of CASES) {
  const res = await gw.chat({
    system: baseSystem(c.scene),
    messages: [{ role: 'user', content: c.user }],
    maxTokens: 400,
    temperature: 0.85,
  })
  total++
  if (!res.ok) {
    rows.push([c.note, c.user, '调用失败: ' + res.error, '-'])
    continue
  }
  const found = [...res.text.matchAll(STICKER_RE)].map((m) => m[1])
  if (found.length) stickerTurns++
  rows.push([c.note, c.user.slice(0, 18), found.length ? '发图: ' + found.join(' / ') : '纯文字', res.text.replace(/\n/g, ' ⏎ ').slice(0, 90)])
}

console.log('')
for (const [note, user, verdict, text] of rows) {
  console.log(`【${note}】用户: ${user}\n   → ${verdict}\n   → 「${text}」\n`)
}

const asked = CASES.filter((c) => c.want === 'any').length
console.log(`发出表情包的轮次: ${stickerTurns}/${total}`)
console.log(`（"该发图"的 ${asked} 轮里，命中 ${rows.slice(0, 3).filter((r) => String(r[2]).startsWith('发图')).length} 轮）`)

// 把吐出来的关键词拿去图库匹配，看能不能真的找到图——
// 模型写了个漂亮关键词但图库没对应图，等于空头支票。
console.log('\n--- 图库匹配检查 ---')
for (const [, , verdict] of rows) {
  if (!String(verdict).startsWith('发图')) continue
  for (const q of String(verdict).replace(/^发图: /, '').split(' / ')) {
    const hits = stickers.match(q, { limit: 2 })
    console.log(`  "${q}" → ${hits.length ? hits.map((h) => path.basename(h.file)).join(', ') : '❌ 匹配不到'}`)
  }
}
