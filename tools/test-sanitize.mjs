/**
 * 出站清洗测试（P6，2026-10-19）。
 *
 * 背景：用户截图里 Molly 答「这句翻译什么原理」时，把「自己是被模型/提示词驱动、
 * 分几步处理」整块讲了出来，还带 **加粗** 和有序列表——QQ 不渲染 markdown，
 * 用户看到的是满屏星号。
 *
 * 这里测两类东西，别混：
 *   A. 格式兜底（sanitizeOutbound + splitReply）：markdown 必须被洗掉，
 *      但 <sticker>/<sep/>/<br> 这些**协议标记**一个都不许少。
 *   B. 语义约束（systemPrompt）：**用提示词断言，不用文本替换**。
 *      "别讲自己的实现" 是行为约束，写成关键词过滤会把正常技术问答一起砍掉。
 *
 * 跑法：node tools\test-sanitize.mjs   （全绿 exit=0）
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sanitizeOutbound } from '../plugin/dsh-qq-whale/lib/persona-sanitize.js'
import { PersonaStore } from '../plugin/dsh-qq-whale/lib/persona.js'

let pass = 0
const fails = []

function t(name, fn) {
  try {
    fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fails.push({ name, msg: e && e.message })
    console.log('  FAIL ' + name + '\n       ' + (e && e.message))
  }
}

const has = (s, sub, name) => assert.ok(s.includes(sub), (name || '') + ' 缺少: ' + sub)
const notHas = (s, sub, name) => assert.ok(!s.includes(sub), (name || '') + ' 不应包含: ' + sub)

/* 用户截图里的原文（保留 ** 和 1. 列表，就是她真打出来的样子） */
const SCREENSHOT = `没原理，就是我自己翻的。没调翻译接口，也没外挂什么引擎——模型本身就会这个。要拆的话大概是这么几步：
1. **整段读一遍**，先知道这句话在说什么、什么语气。
2. **断句，抓主干**，把从句拆开，谁在说谁、动作是什么。
3. **按中文习惯重排**，英文的语序直译过来会很别扭。`

console.log('sanitizeOutbound')

t('1. 截图原文：没有 **、没有 #、没有围栏', () => {
  const out = sanitizeOutbound(SCREENSHOT)
  notHas(out, '**')
  notHas(out, '#')
  notHas(out, '```')
  has(out, '整段读一遍')
  has(out, '断句，抓主干')
  has(out, '没原理，就是我自己翻的')
})

t('2. 有序列表 1. → 1)（编号保住，不并成一段）', () => {
  const out = sanitizeOutbound('1. 先这样\n2. 再那样\n3. 最后')
  has(out, '1) 先这样')
  has(out, '2) 再那样')
  has(out, '3) 最后')
  notHas(out, '1. ')
})

t('3. 无序列表 - / * / + → · ，且不会把加粗的星号当列表', () => {
  const out = sanitizeOutbound('- 苹果\n* 香蕉\n+ 橘子\n**重点**在这')
  has(out, '· 苹果')
  has(out, '· 香蕉')
  has(out, '· 橘子')
  has(out, '重点在这')
  notHas(out, '**')
})

t('4. 标题 # 与引用 > 去掉标记，字留着', () => {
  const out = sanitizeOutbound('## 今天的天气\n> 据说要下雨\n### 带伞')
  notHas(out, '#')
  notHas(out, '>')
  has(out, '今天的天气')
  has(out, '据说要下雨')
  has(out, '带伞')
})

t('5. 链接 [text](url) → text（url）；纯 url 链接只留 url', () => {
  const out = sanitizeOutbound('看这个[文档](https://example.com/a)和[https://b.cn](https://b.cn)')
  has(out, '文档（https://example.com/a）')
  has(out, 'https://b.cn')
  notHas(out, '](')
})

t('6. 图片 ![alt](url) → url', () => {
  const out = sanitizeOutbound('图在这![一只猫](https://img.example/x.png)看')
  has(out, 'https://img.example/x.png')
  notHas(out, '![')
  notHas(out, '一只猫')
})

t('7. 代码围栏：内容保留，围栏和语言名去掉', () => {
  const out = sanitizeOutbound('这样写：\n```js\nconst a = 1\nconsole.log(a)\n```\n懂了吗')
  notHas(out, '```')
  notHas(out, 'js\n')
  has(out, 'const a = 1')
  has(out, 'console.log(a)')
  has(out, '懂了吗')
})

t('8. 行内反引号、删除线、下划线粗体、表格', () => {
  const out = sanitizeOutbound('用 `npm i` 装；~~旧的~~ 换成 __新的__\n| a | b |\n|---|---|\n| 1 | 2 |')
  has(out, '用 npm i 装')
  has(out, '旧的')
  has(out, '新的')
  notHas(out, '~~')
  notHas(out, '`')
  notHas(out, '|---')
  has(out, 'a · b')
})

t('9. 收敛空行 + 去掉行首尾空白', () => {
  const out = sanitizeOutbound('第一行   \n\n\n\n   缩进的一行\t\n\n\n最后')
  notHas(out, '\n\n\n')
  notHas(out, '   \n')
  has(out, '缩进的一行')
  assert.equal(out.endsWith('最后'), true, '结尾应无空白')
})

t('10. 空输入 / null / 纯空白 → 空串', () => {
  assert.equal(sanitizeOutbound(''), '')
  assert.equal(sanitizeOutbound(null), '')
  assert.equal(sanitizeOutbound('   \n\n '), '')
})

t('11. 正常技术问答（本来就没 markdown）一字不改', () => {
  const plain = '这句要用「已经」不是「曾」，因为后面跟的是完成时。你将就着看吧。'
  assert.equal(sanitizeOutbound(plain), plain)
})

console.log('协议标记保护（这条最要命，坏了表情包和分条全废）')

t('12. <sticker> 原样保留，里面的字不被当 markdown 处理', () => {
  const out = sanitizeOutbound('哈哈哈<sticker>翻白眼</sticker>真的**离谱**')
  has(out, '<sticker>翻白眼</sticker>')
  notHas(out, '**')
  has(out, '离谱')
})

t('13. <sep/> 原样保留（splitReply 靠它分条）', () => {
  const out = sanitizeOutbound('第一条<sep/>第二条**加粗**')
  has(out, '<sep/>')
  notHas(out, '**')
})

t('14. <br> 原样保留（splitReply 靠它换行）', () => {
  const out = sanitizeOutbound('上面<br>下面')
  has(out, '<br>')
})

t('15. splitReply 里：清洗 + 分条 + 表情包端到端', () => {
  const store = new PersonaStore({ dir: 'D:/__no_such_dir__/persona' })
  const parts = store.splitReply('先看**这段**：\n1. 整段读一遍\n2. 断句\n<sep/>后面<sticker>点头</sticker>')
  assert.ok(parts.length >= 2, '应该被 <sep/> 切成 >=2 条')
  const texts = parts.filter((p) => p.type === 'text').map((p) => p.text)
  const all = texts.join('\n')
  notHas(all, '**', 'splitReply 输出')
  has(all, '1) 整段读一遍')
  has(all, '2) 断句')
  const stickers = parts.filter((p) => p.type === 'sticker').map((p) => p.query)
  assert.ok(stickers.includes('点头'), '表情包应该被识别出来: ' + JSON.stringify(stickers))
})

console.log('systemPrompt 硬约束（用提示词断言，不用文本替换）')

const promptOf = (scene) =>
  new PersonaStore({ dir: 'D:/__no_such_dir__/persona' }).systemPrompt({
    scene,
    selfNickname: 'Molly',
    userName: '主人',
    groupName: '测试群',
  })

t('16. 私聊提示词含「别说自己的实现」段与「不用 markdown」段', () => {
  const p = promptOf('private')
  has(p, '# 别说自己的实现')
  has(p, '# 不用 markdown')
  has(p, '不许列成步骤清单')
  has(p, '不讲你自己是怎么运转的')
})

t('17. 群聊/被 @ 场景同样带这两段（提示词不按场景丢约束）', () => {
  for (const scene of ['group_mention', 'group_bystander']) {
    const p = promptOf(scene)
    has(p, '# 别说自己的实现', scene)
    has(p, '# 不用 markdown', scene)
  }
})

t('18. 人设没被写没：内核八条还在，且和「不列 1234」不打架', () => {
  const p = promptOf('private')
  has(p, '蓝色大肥鱼')
  has(p, '不列 1234')
  has(p, '不解释自己在干嘛')
  // 新约束必须自己解释说清"跟不列 1234 不冲突"，否则模型会收到矛盾指令
  has(p, '这跟上面"不列 1234"不冲突')
  // 并且必须明确"正常技术问题照常答"，防止她拿这条当躲问题的借口
  has(p, '正经的翻译/语法/代码问题要正常答')
})

t('19. 机制自述不靠文本过滤：原始文本里"模型/提示词"字样不会被删', () => {
  // 这条是"反向护栏"：如果哪天有人把语义过滤加进 sanitize，这条会红。
  const s = '模型本身就会这个，提示词里没写。'
  assert.equal(sanitizeOutbound(s), s)
})

/* P2（task-16）：查不到就收口 —— 同样是提示词断言，不做文本过滤 */
t('20. 提示词含「查不到就收口」段，四条语义都在', () => {
  const p = promptOf('private')
  has(p, '# 查不到就收口')
  // ① 查不到就说查不到，不许换关键词重试同一问题
  has(p, '翻到第三遍')
  has(p, '别换个词再翻一遍')
  // ② 找不到记录/引用 → 说「翻不到了」+ 给大概或反问，不许连续追问
  has(p, '翻不到了')
  has(p, '把选择权交回去')
  has(p, '不许连着追问同一个问题')
  // ③ 一次没查成收口，别堵后面的问题
  has(p, '一次没查成就收口')
  has(p, '别让后面的事全堵在这一件上')
  // ④ 先答能答的部分
  has(p, '先把能答的那部分答了')
})

t('21. 新段自己声明"讲的是检索失败怎么收场，不跟其它规矩冲突"', () => {
  const p = promptOf('private')
  has(p, '这段讲的是检索失败怎么收场，不是格式问题')
  // 且不能变成"不许查"——该查的事实还得查（内核原句在）
  has(p, '能查到的事实')
})

t('22. 新段在三种场景都在，且人设与既有段落一个没丢', () => {
  const need = [
    '蓝色大肥鱼',
    '# 硬性约束',
    '# 别说自己的实现',
    '# 不用 markdown',
    '# 查不到就收口',
    '# 别说这些',
  ]
  for (const scene of ['private', 'group_mention', 'group_bystander']) {
    const p = promptOf(scene)
    for (const s of need) has(p, s, scene)
  }
  // 顺序护栏：内核在前、新段在后（不能把新段插进内核把人设切两半）
  const p = promptOf('private')
  assert.ok(p.indexOf('蓝色大肥鱼') < p.indexOf('# 查不到就收口'), '内核应在新增段之前')
  assert.ok(p.indexOf('# 查不到就收口') < p.indexOf('# 别说这些'), '新段应在「别说这些」之前')
})

/* ——— task-26（2026-10-19 真机 seq 591）：宿主标记 / 内部 ID 泄漏 ———
 * 用户 m24462：「查询那个会话又开始报代码了」。真机原文（私聊 seq 591）：
 *   <acp tokens="25" type="text">m02939</acp>\n发给 555555555（示例好友）了，
 *   message_id 1968616843，内容就这一句：「测试内容」。
 * 这条走的是**干活会话（命令链路）**，聊天链路的提示词管不到，只能靠
 * 出站闸门兜底 + worker 人设提前约束（下面两段分开测）。
 */
console.log('宿主标记 / 内部 ID 清洗（task-26）')

const SEQ591 =
  '<acp tokens="25" type="text">m02939</acp>\n发给 555555555（示例好友）了，message_id 1968616843，内容就这一句：「测试内容」。'

t('23. seq 591 原文：acp 块和 message_id 都没了，正文从「发给」开始', () => {
  const out = sanitizeOutbound(SEQ591)
  assert.ok(out.startsWith('发给 555555555'), '应以「发给…」开头，实际: ' + out)
  notHas(out, 'acp')
  notHas(out, 'm02939')
  notHas(out, 'message_id')
  notHas(out, '1968616843')
  notHas(out, '，，', '不能留下双逗号')
  has(out, '测试内容')
})

t('24. 单独一句带 message_id：剥字段不伤句子、不留双标点', () => {
  const out = sanitizeOutbound('发给 222222222 了，message_id 1968616843，内容就这一句：「好」。')
  assert.equal(out, '发给 222222222 了，内容就这一句：「好」。')
})

t('25. 裸的 mXXXXX 引用号（没有标签）也剥', () => {
  const out = sanitizeOutbound('他说 m02939 这条我回过了')
  notHas(out, 'm02939')
  has(out, '他说')
  has(out, '这条我回过了')
})

t('26. 整条只有标记 → 返回空串（上层「空就不发」才拦得住）', () => {
  assert.equal(sanitizeOutbound('<acp tokens="25" type="text">m02939</acp>'), '')
  assert.equal(sanitizeOutbound('  <acp/>  '), '')
  assert.equal(sanitizeOutbound('m02939'), '')
  assert.equal(sanitizeOutbound('{{user_name}}'), '')
})

t('27. 模板变量 {{}} 与 function_calls/invoke/parameter 标签残渣', () => {
  const out = sanitizeOutbound('{{user.name}} 你好 <function_calls>中间</function_calls><invoke name="x"><parameter name="a">1</parameter>')
  notHas(out, '{{')
  notHas(out, 'function_calls')
  notHas(out, '<invoke')
  notHas(out, '<parameter')
  has(out, '你好')
  has(out, '中间')
})

t('28. CQ 码剥掉，且不吞后面的正常文字', () => {
  const out = sanitizeOutbound('发了[CQ:at,qq=123]和 CQ:image,file=a.jpg 就走了')
  notHas(out, 'CQ:')
  has(out, '就走了')
})

t('29. 纯路径行 → 「（路径见文件）」；句中顺带提的路径不动', () => {
  assert.equal(sanitizeOutbound('C:\\Users\\example\\out\\report.md'), '（路径见文件）')
  assert.equal(sanitizeOutbound('  D:\\work\\a b\\x.png  '), '  D:\\work\\a b\\x.png  '.trim())
  const inline = '文件在 C:\\temp\\a.txt 里'
  assert.equal(sanitizeOutbound(inline), inline, '句中路径不该被换成占位')
})

t('30. acp + 代码围栏 + sticker 混排：围栏内容留、acp 死、sticker 活', () => {
  const out = sanitizeOutbound('看：\n```js\nconst a = 1\n```\n<acp tokens="1">m00001</acp>做完了<sticker>点头</sticker>')
  has(out, 'const a = 1')
  notHas(out, '```')
  notHas(out, 'acp')
  notHas(out, 'm00001')
  has(out, '<sticker>点头</sticker>')
  has(out, '做完了')
})

t('31. 正常中文照样一字不改（清洗闸门不能误伤）', () => {
  const plain = '他说明天不行，后天可以。就这样，别催。'
  assert.equal(sanitizeOutbound(plain), plain)
})

/* 干活人设：静态断言 commands.js 里有这条硬规则（不 import，避免拉起 ctx 依赖） */
console.log('worker 人设硬规则（task-26）')

const commandsSrc = readFileSync(new URL('../plugin/dsh-qq-whale/lib/commands.js', import.meta.url), 'utf8')

t('32. workerSetup 里写明「原样发到 QQ」+ 禁贴清单 + <acp> 禁令', () => {
  has(commandsSrc, '你说的话会原样发到 QQ')
  has(commandsSrc, '不贴代码块、不贴 JSON、不贴命令输出原文')
  has(commandsSrc, 'message_id / user_id')
  has(commandsSrc, '<acp> 这种尖括号标记是系统内部的东西')
  has(commandsSrc, '文件路径最多给一个')
})

t('33. 原有段落没被删：你有 QQ 的手 / 先列 todo / 有产出文件就说路径', () => {
  has(commandsSrc, '## 你有 QQ 的手')
  has(commandsSrc, '先调用 todo 工具列一份清单')
  has(commandsSrc, '有产出文件就说路径')
  // 顺序：新段在人设末尾，不把人设切两半
  assert.ok(
    commandsSrc.indexOf('## 你有 QQ 的手') < commandsSrc.indexOf('你说的话会原样发到 QQ'),
    '新段应在「你有 QQ 的手」之后',
  )
})

console.log('')
console.log(`${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log('  - ' + f.name + ': ' + f.msg)
  process.exit(1)
}
