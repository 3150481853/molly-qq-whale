/**
 * 汇报去重 + 开工语测试（2026-10-18 P1）。
 *
 * 复现的真机形态（私聊 222222222，一条「命令 回复一下未读消息」）：
 * 主人连收 4 条，内容一句润色一句原句 ——
 *   seq 530  232 字 详细版（agent 第 1 回合自己发的）
 *   seq 531  111 字 换角度重写（有唯一新信息：21 个好友）
 *   seq 532  130 字 530 的压缩版
 *   seq 533   72 字 530 末段的改写版
 * 下面用这 4 段真实文本做 fixture，断言修完之后只投一组、不留重复段。
 *
 * 跑法：node test-chat-delivery.mjs
 * 注意：import 的是**安装副本**（真机跑的那份），改完源码要同步过去再跑。
 */
import assert from 'node:assert'
import { mergeReportTexts, containment, similarity, splitBlocks } from 'file:///C:/Users/example/.dsh/profiles/desktop/node_modules/dsh-qq-whale/lib/dedupe.js'
import { ChatEngine } from 'file:///C:/Users/example/.dsh/profiles/desktop/node_modules/dsh-qq-whale/lib/engine.js'
import { CommandExecutor } from 'file:///C:/Users/example/.dsh/profiles/desktop/node_modules/dsh-qq-whale/lib/commands.js'

let pass = 0
let fail = 0
async function check(name, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    fail += 1
    console.log(`  ✗ ${name}\n    ${err?.message || err}`)
  }
}

// ── fixture：真机 4 条原文（一字未改）────────────────────────────────
const T530 = `理完了，未读就三条：

1. 示例用户B（888888888）私聊发了句「测试内容」——他前面一直缠着让我叫爹，我已经回了，让他别赖鱼身上。
2. 示例大群里示例成员C（789789789）发了张图，没带文字，没 @我，我没回。
3. 「示例测试群」群里 333333333 冒了个头（「还没修好」「但是有回应」），那边没人 @我，也没要我干啥。

另外提醒一句：定时任务从昨天下午到现在 QQ 一直 reconnecting，好友列表读不出来，那几轮都跳过了，没发消息。`
const T531 = `未读消息已处理完，顺手也把刚恢复的 QQ 好友列表对了一遍——目前 21 个好友，444444444、888888888、555555555 这三个都已经收到过那份自我介绍，没有新面孔，定时任务那几轮因掉线跳过的不用补发。`
const T532 = `三条未读的情况：示例用户B 私聊那句「测试内容」我已经回了；示例大群里示例成员C发了张图但没 @我、没带文字，我没回；「示例测试群」群里 333333333 只是冒了个头，那边没人点我干活。`
const T533 = `另外一句提醒：QQ 是刚恢复的（之前 reconnecting 卡了八个多小时），定时任务里那份「已知名单」还是旧的，好在没有新好友，所以不会重复`

const PEER = 222222222

console.log('汇报去重 + 开工语测试')

// ── 1. 纯函数：为什么必须用 containment 而不是 Jaccard ────────────────
await check('压缩版 vs 原文：containment 高、Jaccard 低（所以按 Jaccard 会漏判）', () => {
  const c = containment(T532, T530)
  const j = similarity(T532, T530)
  assert.ok(c > 0.45, `containment 应该 >0.45，实际 ${c.toFixed(3)}`)
  assert.ok(j < 0.4, `Jaccard 应该 <0.4，实际 ${j.toFixed(3)}`)
})

// ── 2. 4 条合并：只留不重复的段 ───────────────────────────────────────
await check('4 条真机文本合并 → 丢掉压缩版 532，保留 531 的新信息（21 个好友）', () => {
  const merged = mergeReportTexts([T530, T531, T532, T533])
  const dropped = mergeReportTexts.lastDropped
  assert.equal(dropped.length, 1, `应只丢 1 段，实际丢 ${dropped.length} 段`)
  assert.match(dropped[0], /三条未读的情况/, '该丢的是 532（压缩版）')
  assert.match(merged, /理完了，未读就三条/, '530 的详细版要留')
  assert.match(merged, /21 个好友/, '531 的唯一新信息（21 个好友）必须留')
  assert.match(merged, /八个多小时/, '533 的新细节（八个多小时）保留')
  assert.ok(!merged.includes('三条未读的情况'), `532 不该出现在结果里：\n${merged}`)
})

// ── 3. 正常回复不受影响 ────────────────────────────────────────────────
await check('正常两行回复原样通过，不被误吞', () => {
  const normal = '行，我看过了。\n第一件事已经处理完，第二件事明天再说。'
  assert.equal(mergeReportTexts([normal]), normal)
  assert.equal(mergeReportTexts(['好的，马上办。', '搞定了，已经发给 123123123。']), '好的，马上办。\n搞定了，已经发给 123123123。')
})

await check('同一段汇报重复三遍 → 只留一份（开头短行也不重复）', () => {
  const out = mergeReportTexts([T530, T530, T530])
  assert.ok(out.length > 0, '不能返回空')
  assert.equal((out.match(/理完了，未读就三条/g) || []).length, 1, `开头短行只该留一份：\n${out}`)
  assert.equal((out.match(/另外提醒一句/g) || []).length, 1, '末段只该留一份')
  assert.equal(splitBlocks(out).length, splitBlocks(T530).length, '段数应与原文一致')
})

// ── 4. installReportCapture：命令执行期间吞掉 agent 的工具式发送 ──────
function makeFakeClient() {
  const sent = []
  const client = {
    sent,
    call(action, params) {
      sent.push({ action, params })
      return Promise.resolve({ message_id: 900 + sent.length, message_seq: sent.length })
    },
    sendPrivateMsg(userId, message, autoEscape = false) {
      return this.call('send_private_msg', { user_id: userId, message, auto_escape: autoEscape })
    },
    sendGroupMsg(groupId, message, autoEscape = false) {
      return this.call('send_group_msg', { group_id: groupId, message, auto_escape: autoEscape })
    },
  }
  return client
}

/** 只跑 runCommand 需要的零件，别把整个真引擎拉起来 */
function makeFakeEngine({ client, executor }) {
  const logs = []
  const engine = {
    client,
    executor,
    // 投递节奏调快，测试别真等几十秒（真机用默认节奏）
    config: {
      thinkingBaseDelaySeconds: 0.01,
      typingCharactersPerSecond: 5000,
      typingMaxDelaySeconds: 0.2,
      thinkingJitterRatio: 0,
      bubbleGapMinSeconds: 0.01,
      bubbleGapMaxSeconds: 0.02,
    },
    progress: { beginWatch() {}, endWatch: async () => {} },
    logger: (level, msg) => logs.push(`${level}: ${msg}`),
    // Stage 3 Step 1 把 Date.now() 换成了 this.now()（快照机可注入时钟），假引擎要跟上
    now: () => Date.now(),
    pushHistory() {},
    memory: { add() {} },
    /* runCommand 收尾会调 this.remember()（work 类记忆）。这是假引擎，不需要真落库。 */
    remember: () => null,
    logs,
  }
  engine.installReportCapture = ChatEngine.prototype.installReportCapture
  engine.runCommand = ChatEngine.prototype.runCommand
  // task-53 并发修复：capture 变成句柄，这三个方法必须一起挂
  engine.openCapture = ChatEngine.prototype.openCapture
  engine.closeCapture = ChatEngine.prototype.closeCapture
  engine.pickCaptureFor = ChatEngine.prototype.pickCaptureFor
  return engine
}

await check('工具式发送（字符串、无 auto_escape）被接下，不真发', async () => {
  const client = makeFakeClient()
  const seen = []
  const executor = {
    ensureHandle: async () => ({}),
    workSessionId: () => 'work-sid',
    async run() {
      const r = await client.call('send_private_msg', { user_id: PEER, message: '中间汇报一句' })
      seen.push({ returned: r, sentSoFar: client.sent.length, notes: engine.reportCapture?.notes.slice() })
      return { ok: true, text: '最终结果' }
    },
  }
  const engine = makeFakeEngine({ client, executor })
  await engine.runCommand({
    ev: { message_type: 'private', user_id: PEER, message_id: 1 },
    conv: {},
    task: '命令 测试',
    userName: '主人',
    scene: 'private',
  })
  assert.equal(seen[0].returned.captured, true, '返回值要带 captured:true')
  assert.equal(seen[0].sentSoFar, 0, '执行期间不能真的发出去')
  assert.deepEqual(seen[0].notes, ['中间汇报一句'])
})

await check('引擎自己的发送（数组 message + auto_escape）照常放行', async () => {
  const client = makeFakeClient()
  const executor = {
    ensureHandle: async () => ({}),
    workSessionId: () => 'work-sid',
    async run() {
      await client.call('send_private_msg', {
        user_id: PEER,
        message: [{ type: 'text', data: { text: '进度播报' } }],
        auto_escape: false,
      })
      return { ok: true, text: '最终结果' }
    },
  }
  const engine = makeFakeEngine({ client, executor })
  await engine.runCommand({
    ev: { message_type: 'private', user_id: PEER, message_id: 1 },
    conv: {},
    task: '命令 测试',
    userName: '主人',
    scene: 'private',
  })
  const progressBubble = client.sent.find((s) => Array.isArray(s.params.message) && s.params.message[0]?.data?.text === '进度播报')
  assert.ok(progressBubble, `进度播报必须真发出去，实际发送：${JSON.stringify(client.sent)}`)
})

await check('发到**别的会话**的不吞（主人让 agent 给第三方发消息时要真发）', async () => {
  const client = makeFakeClient()
  const executor = {
    ensureHandle: async () => ({}),
    workSessionId: () => 'work-sid',
    async run() {
      await client.call('send_private_msg', { user_id: 123123123, message: '自我介绍' })
      return { ok: true, text: '已发给 123123123。' }
    },
  }
  const engine = makeFakeEngine({ client, executor })
  await engine.runCommand({
    ev: { message_type: 'private', user_id: PEER, message_id: 1 },
    conv: {},
    task: '命令 向123123123发送自我介绍',
    userName: '主人',
    scene: 'private',
  })
  assert.ok(
    client.sent.some((s) => String(s.params.user_id) === '123123123'),
    `第三方消息必须真发，实际：${JSON.stringify(client.sent)}`,
  )
})

await check('带 CQ 码的（图片/表情）不接，照常真发', async () => {
  const client = makeFakeClient()
  const executor = {
    ensureHandle: async () => ({}),
    workSessionId: () => 'work-sid',
    async run() {
      await client.call('send_private_msg', { user_id: PEER, message: '图来了 [CQ:image,file=abc.image]' })
      return { ok: true, text: '发好了' }
    },
  }
  const engine = makeFakeEngine({ client, executor })
  await engine.runCommand({
    ev: { message_type: 'private', user_id: PEER, message_id: 1 },
    conv: {},
    task: '命令 发张图',
    userName: '主人',
    scene: 'private',
  })
  assert.ok(
    client.sent.some((s) => typeof s.params.message === 'string' && s.params.message.includes('[CQ:image')),
    `图片消息必须原样发出，实际：${JSON.stringify(client.sent.map((s) => s.params.message))}`,
  )
})

// ── 5. 端到端：agent 在 4 个回合里各发一条 = 真机现场 ─────────────────
await check('端到端：4 条自发汇报 + 最终结果 → 只投一组，不出现重复段', async () => {
  const client = makeFakeClient()
  const duringRun = {}
  const executor = {
    ensureHandle: async () => ({}),
    workSessionId: () => 'work-sid',
    async run() {
      for (const t of [T530, T531, T532, T533]) {
        // qq_onebot 工具的发送形态：字符串 message、没有 auto_escape
        await client.call('send_private_msg', { user_id: PEER, message: t })
      }
      duringRun.sentDuringRun = client.sent.length
      duringRun.notes = engine.reportCapture?.notes.length
      return { ok: true, text: T533 }
    },
  }
  const engine = makeFakeEngine({ client, executor })
  const result = await engine.runCommand({
    ev: { message_type: 'private', user_id: PEER, message_id: 1 },
    conv: {},
    task: '命令 回复一下未读消息',
    userName: '主人',
    scene: 'private',
  })

  assert.equal(result.ok, true)
  assert.equal(duringRun.sentDuringRun, 0, '执行期间一条都不该真发')
  assert.equal(duringRun.notes, 4, '4 条都应被接下')

  const bubbles = client.sent.filter((s) => Array.isArray(s.params.message))
  assert.ok(bubbles.length >= 1, '至少要发一条')
  const text = bubbles.map((b) => b.params.message.map((p) => p.data.text).join('')).join('\n')
  assert.match(text, /理完了，未读就三条/, '详细版要发')
  assert.match(text, /21 个好友/, '531 的新信息要发')
  assert.ok(!text.includes('三条未读的情况'), `532 压缩版被去掉了，实际发出：\n${text}`)
  assert.ok(!text.includes('收到，我列一下要干啥。'), '不该有开工语气泡')
  console.log(`    （合并后 ${text.length} 字，切成 ${bubbles.length} 条气泡）`)
})

await check('端到端：没有自发汇报时，结果照旧（不额外加工）', async () => {
  const client = makeFakeClient()
  const executor = {
    ensureHandle: async () => ({}),
    workSessionId: () => 'work-sid',
    async run() {
      return { ok: true, text: '群 777777777 已经加进白名单了' }
    },
  }
  const engine = makeFakeEngine({ client, executor })
  const result = await engine.runCommand({
    ev: { message_type: 'private', user_id: PEER, message_id: 1 },
    conv: {},
    task: '命令 把群 777777777 列入白名单',
    userName: '主人',
    scene: 'private',
  })
  assert.equal(result.text, '群 777777777 已经加进白名单了')
  const bubbles = client.sent.filter((s) => Array.isArray(s.params.message))
  assert.equal(bubbles.length, 1)
  assert.equal(bubbles[0].params.message[0].data.text, '群 777777777 已经加进白名单了')
})

// ── 6. 开工语：默认不发，config.commandAck 才恢复旧行为 ────────────────
function makeCommandExecutor(extraConfig = {}) {
  const liveAgent = {
    id: 'qq-whale-work-1',
    status: 'running',
    activityDone: Promise.resolve('idle'),
    followup: () => {},
    whenIdle: async () => {},
    session: {
      deriveMessages: () => [{ role: 'assistant', content: [{ type: 'text', text: '已经在办了' }] }],
    },
  }
  const agents = {
    get: () => liveAgent,
    create: async () => {
      throw new Error('不该走到这里')
    },
    resume: async () => {
      throw new Error('不该走到这里')
    },
  }
  const logs = []
  const cmds = new CommandExecutor({
    ctx: { reflect: { get: (n) => (n === 'agents' ? agents : undefined) } },
    logger: (level, msg) => logs.push(`${level}: ${msg}`),
    config: {
      selfId: '1',
      commandEnabled: true,
      commanderUsers: ['10000'],
      commandTimeoutMinutes: 1,
      ...extraConfig,
    },
    engine: {},
  })
  return { cmds, logs }
}

await check('默认不发「收到，我列一下要干啥。」', async () => {
  const { cmds } = makeCommandExecutor()
  const got = []
  const result = await cmds.run('把群 777777777 列入白名单', { onProgress: async (t) => got.push(t) })
  assert.equal(result.ok, true, result.text)
  assert.deepEqual(got, [], `不该有开工语，实际：${JSON.stringify(got)}`)
})

await check('config.commandAck=true 时恢复旧行为（留着可回滚）', async () => {
  const { cmds } = makeCommandExecutor({ commandAck: true })
  const got = []
  await cmds.run('把群 777777777 列入白名单', { onProgress: async (t) => got.push(t) })
  assert.deepEqual(got, ['收到，我列一下要干啥。'])
})

// ── 7. P6：三条绕过 splitReply 的直发路径也要洗 markdown ───────────────
await check('P6 sendTextTo / sayQuick：星号井号不外漏，列表前缀改成 1)', async () => {
  const client = makeFakeClient()
  const engine = { client, logger() {}, config: {}, memory: { add() {} }, pushHistory() {} }
  engine.sendTextTo = ChatEngine.prototype.sendTextTo
  engine.sayQuick = ChatEngine.prototype.sayQuick
  await engine.sayQuick({ message_type: 'private', user_id: PEER }, 'private', '**整段读一遍**\n\n1. 断句\n\n# 总结')
  assert.equal(client.sent.length, 1)
  const txt = client.sent[0].params.message[0].data.text
  assert.ok(!txt.includes('**'), `不能有星号：\n${txt}`)
  assert.ok(!txt.includes('#'), `不能有井号：\n${txt}`)
  assert.match(txt, /整段读一遍/)
  assert.match(txt, /1\) 断句/, `列表前缀应改成 1)：\n${txt}`)
})

await check('P6 sayQuick：洗完是空串就不发空气泡', async () => {
  const client = makeFakeClient()
  const engine = { client, logger() {}, config: {}, memory: { add() {} }, pushHistory() {} }
  engine.sendTextTo = ChatEngine.prototype.sendTextTo
  engine.sayQuick = ChatEngine.prototype.sayQuick
  await engine.sayQuick({ message_type: 'private', user_id: PEER }, 'private', '```\n```')
  assert.equal(client.sent.length, 0, '不该发空消息')
})

await check('P6 命令结果：markdown 表格/标题洗掉再投递', async () => {
  const client = makeFakeClient()
  const executor = {
    ensureHandle: async () => ({}),
    workSessionId: () => 'work-sid',
    async run() {
      return { ok: true, text: '## 进度\n\n| 项目 | 状态 |\n|---|---|\n| 白名单 | **已加** |' }
    },
  }
  const engine = makeFakeEngine({ client, executor })
  await engine.runCommand({
    ev: { message_type: 'private', user_id: PEER, message_id: 1 },
    conv: {},
    task: '命令 把群列入白名单',
    userName: '主人',
    scene: 'private',
  })
  const bubbles = client.sent.filter((s) => Array.isArray(s.params.message))
  const text = bubbles.map((b) => b.params.message.map((p) => p.data.text).join('')).join('\n')
  assert.ok(!text.includes('**'), `不能有星号：\n${text}`)
  assert.ok(!text.includes('|'), `不能有竖线：\n${text}`)
  assert.ok(!text.includes('#'), `不能有井号：\n${text}`)
  assert.match(text, /白名单.*已加/s, `内容要留下：\n${text}`)
  console.log(`    （投出去的样子：${JSON.stringify(text)}）`)
})

// ── 5. 并发两条命令：捕获句柄互不覆盖（task-53 reportCapture 修复）──
await check('并发两条命令：各自 notes 独立、各自收尾都投递，不串到对方', async () => {
  const client = makeFakeClient()
  const gates = {}
  const executor = {
    ensureHandle: async () => ({}),
    workSessionId: () => 'work-sid',
    async run(task) {
      const first = String(task).includes('第一')
      const group = first ? '1001' : '2002'
      await client.call('send_group_msg', { group_id: group, message: `汇报：${task}` })
      // 两条都卡住，制造"真并发"
      await new Promise((r) => (gates[first ? 'first' : 'second'] = r))
      return { ok: true, text: `结果：${task}` }
    },
  }
  const engine = makeFakeEngine({ client, executor })
  const args = (group, task, mid) => ({
    ev: { message_type: 'group', group_id: group, user_id: PEER, message_id: mid },
    conv: {},
    task,
    userName: '主人',
    scene: 'group_mention',
  })
  const a = engine.runCommand(args('1001', '命令 第一件事', 1))
  await new Promise((r) => setTimeout(r, 30))
  const b = engine.runCommand(args('2002', '命令 第二件事', 2))
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(
    engine._captures.length,
    2,
    `并发期间应有两份捕获，实际 ${engine._captures.length}：${JSON.stringify(engine._captures.map((c) => ({ t: c.target, a: c.active })))}`,
  )
  assert.deepEqual(engine._captures.map((c) => c.target).sort(), ['1001', '2002'])

  // 先放第二条：它关闭自己的句柄，不能把第一条的也关掉
  gates.second()
  await b
  assert.equal(engine._captures.length, 1, '关掉第二条后，第一条的捕获必须还在')
  assert.equal(engine._captures[0].target, '1001')

  gates.first()
  await a
  assert.equal(engine._captures.length, 0, '收尾后捕获必须全部关闭')
  assert.equal(engine.reportCapture, null, 'reportCapture 应回到 null')

  const bubbles = client.sent
    .filter((s) => Array.isArray(s.params.message))
    .map((s) => s.params.message.map((p) => p.data?.text || '').join(''))
  const joined = bubbles.join('\n')
  assert.match(joined, /汇报：命令 第一件事/, `第一条的汇报要投出去：\n${joined}`)
  assert.match(joined, /结果：命令 第一件事/, `第一条的结果要投出去：\n${joined}`)
  assert.match(joined, /汇报：命令 第二件事/, `第二条的汇报要投出去：\n${joined}`)
  assert.match(joined, /结果：命令 第二件事/, `第二条的结果要投出去：\n${joined}`)
  const aText = bubbles.find((t) => t.includes('第一件事')) || ''
  assert.ok(!aText.includes('第二件事'), `第一条的气泡里不能混进第二条：\n${aText}`)
  console.log(`    （两条命令各自的投递：${JSON.stringify(bubbles)}）`)
})

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
