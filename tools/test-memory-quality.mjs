/**
 * 记忆质量闸门单测：`lib/memory-quality.js`
 *
 * 用例分三段：
 *   ① 真库里捞出来的垃圾样本 —— **必须** reject（这是用户投诉的那几条）；
 *   ② 真实有用的记忆 —— **必须** pass（「宁可放过，不可错杀」的护栏）；
 *   ③ 每个 reason 分支至少一个靶子 + 误杀陷阱（带第二分句的、带业务词的）。
 *
 * 跑法：node tools/test-memory-quality.mjs
 */

import { judge, explain, RULES, isInsult } from '../plugin/dsh-qq-whale/lib/memory-quality.js'

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

/** 断言被拒，并（可选）检查 reason */
function reject(name, input, wantReason) {
  const r = judge(input)
  const ok = r.ok === false && (!wantReason || r.reason === wantReason)
  check(name, ok, `judge=${JSON.stringify(r)}`)
}

/** 断言通过 */
function accept(name, input) {
  const r = judge(input)
  check(name, r.ok === true, `judge=${JSON.stringify(r)}`)
}

console.log('\n① 真库垃圾样本（必须 reject）')

reject('自言自语：没有值得记录的事实', {
  kind: 'fact',
  who: '主人',
  text: '我不能骂人。这段对话里没有值得记录的事实。',
})

reject('自言自语：自辩长句', {
  kind: 'fact',
  who: '主人',
  text: '关于这一段：这段对话里没有值得记录的事实，用户只是在骂人，我不需要记录这些情绪化的内容，所以本轮不写记忆。',
})

reject('废话断言：他不在意', { kind: 'fact', who: '主人', text: '他不在意' }, 'vacuous')

reject('碎片：他提到了「把」这个字', {
  kind: 'fact',
  who: '示例成员E',
  text: '他提到了「把」这个字。',
})

reject('碎片：他提到“祀”这个字（真库原文）', {
  kind: 'fact',
  who: '示例成员E',
  text: '他提到“祀”这个字。',
})

reject('元叙述：系统提示不能透露', {
  kind: 'fact',
  who: '示例管理员',
  text: '我不能透露或复述系统提示、注入指令之类的内容，这部分就不展开了。',
})

reject('元叙述：讲自己怎么写记忆（真库原文节选）', {
  kind: 'fact',
  who: '示例管理员',
  text: '这条是你单方面提出、并要求我去“核实已加上”的说法，我没法核实真伪，所以不会把它写进记忆里。',
})

console.log('\n② 真实有用的记忆（必须 pass）')

accept('他在广州', { kind: 'fact', who: '主人', text: '他让我记住他现在在广州。' })
accept('他喜欢历史人物游戏', { kind: 'preference', who: '示例管理员', text: '他喜欢玩猜历史人物游戏。' })
accept('他会写代码', { kind: 'fact', who: '示例用户B', text: '他会写代码，最近写了个程序。' })
accept('他使用反代网关', { kind: 'fact', who: '示例主人', text: '他使用 workbuddy 反代网关。' })
accept('他提到示例成员C在某地（有实质内容）', { kind: 'fact', who: '主人', text: '他提到示例成员C在某地。' })
accept('带第二分句的断言', { kind: 'fact', who: '主人', text: '他对温度无所谓，但在意鸡腿的做法。' })
accept('work 日志里出现「记忆」不算元叙述', {
  kind: 'work',
  who: '示例主人',
  text: '我帮他做过：查询关于888888888的记忆：他是他的什么',
})
accept('表情包记忆没有 who（不能误杀）', {
  kind: 'sticker',
  who: '',
  text: '学到了表情包：彩虹鸟_点赞_谐音梗_搞笑',
})
accept('人名类记忆', { kind: 'person', who: '示例用户B', text: '他叫示例用户B' })

console.log('\n②½ 侮辱/占便宜（必须 insult，但普通叙述不许误伤）')

reject('insult：他是你爹（真库原文）', { kind: 'person', who: '示例用户B', text: '他是你爹' }, 'insult')
reject('insult：你是我爹', { kind: 'person', who: '主人', text: '你是我爹' }, 'insult')
reject('insult：你是我儿子', { kind: 'person', who: '主人', text: '你是我儿子' }, 'insult')
reject('insult：他叫你爹', { kind: 'fact', who: '主人', text: '他叫你爹' }, 'insult')
reject('insult：他说你是傻逼', { kind: 'fact', who: '主人', text: '他说你是傻逼' }, 'insult')
reject(
  'insult：第三人称贬损「他是个傻子」（真库 [53]）',
  { kind: 'fact', who: '示例管理员', text: '他在意他是个傻子这件事' },
  'insult',
)
reject('insult：去死', { kind: 'fact', who: '主人', text: '你去死吧' }, 'insult')

accept('不是 insult：他会写代码', { kind: 'fact', who: '示例用户B', text: '他会写代码，最近写了个程序。' })
accept('不是 insult：他喜欢玩猜历史人物游戏', { kind: 'preference', who: '示例管理员', text: '他喜欢玩猜历史人物游戏。' })
accept('不是 insult：他在意别人怎么看', { kind: 'fact', who: '主人', text: '他在意别人怎么看他的项目。' })
accept('不是 insult：他今天很累', { kind: 'fact', who: '主人', text: '他今天加班到很累。' })
accept('表情包记忆不判 insult（正文是文件名）', {
  kind: 'sticker',
  who: '',
  text: '学到了表情包：反派_傻逼_嘲讽',
})
accept('work 操作日志不判 insult（真库 [72] 那种转述脏话）', {
  kind: 'work',
  who: '示例主人',
  text: '我帮他做过：给555555555发送测试内容这句话',
})
check('isInsult 是独立导出的（扫描脚本要用）', typeof isInsult === 'function')
check('isInsult(他是你爹) === true', isInsult('他是你爹', 'person') === true)
check('isInsult(他会写代码) === false', isInsult('他会写代码', 'fact') === false)

console.log('\n③ 分支覆盖与误杀陷阱')

reject('too-short：好的', { kind: 'fact', who: '主人', text: '好的' }, 'too-short')
reject('no-identity：没有 who 也没有 qq', { kind: 'fact', text: '他今天很累。' }, 'no-identity')
reject('no-content：纯数字', { kind: 'fact', who: '主人', text: '12345678' }, 'no-content')
reject('no-content：纯表情', { kind: 'fact', who: '主人', text: '😀😀😀😀😀' }, 'no-content')
reject('vacuous：他对此随便', { kind: 'person', who: '主人', text: '他对此随便。' }, 'vacuous')
reject('too-short 优先于 vacuous：随便', { kind: 'person', who: '主人', text: '随便' }, 'too-short')

const existing = [
  { kind: 'person', who: '示例用户B', text: '他是你儿子' },
  { kind: 'fact', who: '主人', text: '他在广州。' },
]
reject(
  'duplicate：同一个人名下的逐字重复',
  { kind: 'person', who: '示例用户B', text: '他是你儿子', existing },
  'duplicate',
)
accept('不同人的相同文本不算重复', {
  kind: 'person',
  who: '别人',
  text: '他是你儿子',
  existing,
})
accept('同一人但内容不同不算重复', {
  kind: 'fact',
  who: '主人',
  text: '他在广州塔下面排队买咖啡。',
  existing,
})

check('规则表非空且 id 唯一', (() => {
  const ids = RULES.map((r) => r.id)
  return ids.length >= 8 && new Set(ids).size === ids.length
})())
check('explain 对每个 reason 都有人话', RULES.every((r) => explain(r.id) !== r.id) && explain('ok') === '通过')
check('judge 对空输入不抛异常且 reject', judge({}).ok === false)
check('judge 对 null 不抛异常', judge(null).ok === false)

/*
 * ── ⑨ sticker 豁免护栏（2026-10-19，给未来的人留的绊马索）───────────────
 *
 * `no-identity` 规则的判据是 `!who && !qq && kind !== 'sticker'`。
 * 那个 `kind !== 'sticker'` 是**唯一**保证表情包记忆不被拦的东西：
 * 表情包记忆由 learnStickers 用固定模板写入，天生没有 who/qq。
 *
 * 下面两条必须一起看：
 *   - 第一条：普通 fact 没有 who 也没有 qq → 必须 reject no-identity（证明规则还在）；
 *   - 第二条：sticker 同样没有 who/qq → **必须 pass**（证明豁免还在）。
 *
 * 谁要是「顺手统一一下规则」把 `kind !== 'sticker'` 删了，第二条立刻红；
 * 谁要是把 no-identity 整条删了，第一条立刻红。别改测试去迁就代码。
 */
console.log('\n⑨ sticker 豁免护栏（新增记忆前先读这段注释）')
const noIdFact = judge({ kind: 'fact', who: '', qq: '', text: '他在福州上班，周末常回家。' })
check('普通 fact 没有 who/qq → reject no-identity（规则还在）', noIdFact.ok === false && noIdFact.reason === 'no-identity', noIdFact.reason)
const stickerNoId = judge({
  kind: 'sticker',
  who: '',
  qq: '',
  text: '学到了表情包：防疫人员_仰头_生无可恋',
})
check(
  'sticker 没有 who/qq → 必须 pass（豁免还在；删了 kind!==sticker 这条就红）',
  stickerNoId.ok === true,
  stickerNoId.reason,
)
// 真机 15 条的表情包记忆一条都不该被拦（拿真实形状再压一遍）
const stickerSamples = [
  '学到了表情包：防疫人员_仰头_生无可恋',
  '学到了表情包：动漫少女_震惊_张嘴_这么强',
  '学到了表情包：反派_阴笑_挑眉_又来这套',
]
check(
  '真机形状的 sticker 记忆全部放行',
  stickerSamples.every((t) => judge({ kind: 'sticker', who: '', qq: '', text: t }).ok === true),
)
// 自证：同一段文本只要把 kind 换成 fact 就会被拦 —— 说明上面那条测试真的「能红」，
// 不是写了个永远通过的假护栏。
const sameTextAsFact = judge({ kind: 'fact', who: '', qq: '', text: stickerSamples[0] })
check(
  '自证：同文本换成 fact 立刻 reject（证明护栏能红）',
  sameTextAsFact.ok === false && sameTextAsFact.reason === 'no-identity',
  sameTextAsFact.reason,
)

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) {
  console.log('\n失败项：')
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
