/**
 * 命令链路三病回归（2026-10-20 task-40）。
 *
 * 真机三个现场（群 777777777）：
 *  1) 重复回复：先发「命令 今天广州天气怎么样」→ 干活链路答一次；
 *     再发「@Molly 命令 今天广州天气怎么样」→ 聊天链路又答一次。
 *     根因：normalizeMessage 把那个 at 段渲染成字面「@我」，于是
 *     norm.text = "@我 命令 …"，commands.js 的 matchPrefix 只认以
 *     「命令 」开头 → classify 判成 chat → 聊天链路接走。
 *  2) 答非所问：「命令 查询福州今天天气」那一轮还没收尾，一条 scheduled
 *     reminder 被 splice 成下一轮，答了「无新好友。」；whenIdle() 到那一轮
 *     才落定，旧 readLastAssistant 从会话末尾倒着找 → 把别人的回答当成结果。
 *  3) 无产出：投递环节抛错时以前会冲出 runCommand，被 onMessage 的 .catch
 *     吞成一行宿主日志，QQ 里没有任何提示。
 *
 * 跑法：node test-command-fixes.mjs
 * 可选：CMD_LIB_DIR=<lib 目录> 覆盖（默认安装副本，真机跑的那份）
 */
import assert from 'node:assert'
import path from 'node:path'

const LIB = process.env.CMD_LIB_DIR || 'C:/Users/example/.dsh/profiles/desktop/node_modules/dsh-qq-whale/lib'
const url = (f) => 'file:///' + path.resolve(LIB, f).replace(/\\/g, '/')

const { ChatEngine } = await import(url('engine.js'))
const { CommandExecutor } = await import(url('commands.js'))

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

console.log('命令链路三病回归（task-40）')

// ── 假引擎：只挂要测的方法 ────────────────────────────────────────────
function makeFakeEngine({ client, executor } = {}) {
  const logs = []
  const engine = Object.create(ChatEngine.prototype)
  Object.assign(engine, {
    client,
    executor,
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
    pushHistory() {},
    memory: { add() {} },
    remember: () => null,
    tapEmoji: async () => {},
    lastAgentError: null,
    logs,
  })
  return engine
}

function makeFakeClient({ failFirstGroupSend = false } = {}) {
  const sent = []
  let groupSends = 0
  const client = {
    sent,
    call(action, params) {
      if (action === 'send_group_msg') {
        groupSends += 1
        if (failFirstGroupSend && groupSends === 1) return Promise.reject(new Error('ws 断了'))
      }
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

// ── 1. @ 前缀不再挡住命令 ────────────────────────────────────────────
function makeCommander(engine, calls) {
  return {
    isCommander: () => true,
    async classify(text) {
      calls.push(text)
      const p = ['命令：', '命令:', '命令 '].find((x) => text.startsWith(x))
      if (!p) return { kind: 'chat', reply: '' }
      return { kind: 'command', task: text.slice(p.length).trim(), forced: true }
    },
  }
}

await check('@我 命令 … → 仍按命令处理（不再掉进聊天链路）', async () => {
  const calls = []
  const engine = makeFakeEngine()
  engine.executor = makeCommander(engine, calls)
  const r = await engine.tryCommand({
    ev: { user_id: 222222222, message_id: 1 },
    norm: { text: '@我 命令 今天广州天气怎么样' },
    userName: '示例主人',
  })
  assert.equal(r.handled, true, `必须当命令处理，实际 ${JSON.stringify(r)}`)
  assert.equal(r.task, '今天广州天气怎么样')
  assert.equal(calls[0], '命令 今天广州天气怎么样', `交给 classify 的文本要摘掉 @我，实际：${calls[0]}`)
})

await check('@全体成员 命令 … 同样能识别', async () => {
  const calls = []
  const engine = makeFakeEngine()
  engine.executor = makeCommander(engine, calls)
  const r = await engine.tryCommand({
    ev: { user_id: 333333333, message_id: 2 },
    norm: { text: '@全体成员 命令 用HTML生成一场烟花' },
    userName: '示例管理员',
  })
  assert.equal(r.handled, true)
  assert.equal(r.task, '用HTML生成一场烟花')
})

await check('正文里的 @ 不能被吃掉（那是指令内容的一部分）', async () => {
  const calls = []
  const engine = makeFakeEngine()
  engine.executor = makeCommander(engine, calls)
  const r = await engine.tryCommand({
    ev: { user_id: 222222222, message_id: 3 },
    norm: { text: '@我 命令 查询福州今天天气，并且@333333333' },
    userName: '示例主人',
  })
  assert.equal(r.handled, true)
  assert.equal(r.task, '查询福州今天天气，并且@333333333', `尾部 @ 丢了：${r.task}`)
})

await check('@我 但没有「命令」前缀 → 不算命令（照常聊天）', async () => {
  const calls = []
  const engine = makeFakeEngine()
  engine.executor = makeCommander(engine, calls)
  const r = await engine.tryCommand({
    ev: { user_id: 222222222, message_id: 4 },
    norm: { text: '@我 今天广州天气怎么样' },
    userName: '示例主人',
  })
  assert.equal(r.handled, false)
})

// ── 2. readLastAssistant 必须锁到自己那一轮 ──────────────────────────
function makeAgent(messages) {
  return { session: { deriveMessages: () => messages } }
}
const U = (t) => ({ role: 'user', content: [{ type: 'text', text: t }] })
const A = (t) => ({ role: 'assistant', content: [{ type: 'text', text: t }] })

await check('福州现场：自己的 followup 后面才是结果，不读后面那轮的「无新好友。」', () => {
  const ex = new CommandExecutor({ ctx: {}, logger: () => {}, config: { selfId: '111111111' }, engine: {} })
  const agent = makeAgent([
    U('今天广州天气怎么样'),
    A('广州今天阴天，25~34.1°C，降水概率 2%。'),
    U('查询福州今天天气，并且@333333333'),
    A('福州今天有雾，23.6~34.3°C，我在群里 @333333333 发过了。'),
    U('[SCHEDULE REMINDER BATCH] reminders_json: [...]'),
    A('无新好友。'),
  ])
  const text = ex.readLastAssistant(agent, '查询福州今天天气，并且@333333333')
  assert.match(text, /福州今天有雾/, `读到了别人的回答：${text}`)
  assert.ok(!text.includes('无新好友'), `不能读成 reminder 的回答：${text}`)
})

await check('自己那一轮还没产出 → 返回空串，交给调用方继续等（而不是读别人的）', () => {
  const ex = new CommandExecutor({ ctx: {}, logger: () => {}, config: { selfId: '111111111' }, engine: {} })
  const agent = makeAgent([
    U('用HTML生成一场烟花'),
    U('[SCHEDULE REMINDER BATCH] reminders_json: [...]'),
    A('无新好友。'),
  ])
  assert.equal(ex.readLastAssistant(agent, '用HTML生成一场烟花'), '')
})

await check('会话里找不到自己的 followup（旧会话被裁剪）→ 退回旧行为，读最后一条', () => {
  const ex = new CommandExecutor({ ctx: {}, logger: () => {}, config: { selfId: '111111111' }, engine: {} })
  const agent = makeAgent([A('很久以前的一句'), U('别的任务'), A('最近的一句')])
  assert.equal(ex.readLastAssistant(agent, '这条根本没进过会话'), '最近的一句')
})

await check('不传 task 时行为不变（兼容调用方）', () => {
  const ex = new CommandExecutor({ ctx: {}, logger: () => {}, config: { selfId: '111111111' }, engine: {} })
  assert.equal(ex.readLastAssistant(makeAgent([U('a'), A('b')])), 'b')
})

// ── 3. 引擎自己的投递不能被自己（或并发的另一条命令）吞掉 ────────────
await check('_selfSendDepth > 0 时 client.call 直通，不进 notes', async () => {
  const client = makeFakeClient()
  const engine = makeFakeEngine({ client })
  engine.installReportCapture()
  engine.reportCapture = { active: true, target: '777777777', notes: [] }
  engine._selfSendDepth = 1
  const r = await client.call('send_group_msg', { group_id: '777777777', message: '前一条命令的结果' })
  assert.equal(r.captured, undefined, '自己的投递不能被当成 agent 自发汇报')
  assert.equal(engine.reportCapture.notes.length, 0)
  assert.equal(client.sent.length, 1, '必须真的发出去')
  engine._selfSendDepth = 0
})

await check('深度归零后，工具式发送照旧被捕获', async () => {
  const client = makeFakeClient()
  const engine = makeFakeEngine({ client })
  engine.installReportCapture()
  engine.reportCapture = { active: true, target: '777777777', notes: [] }
  const r = await client.call('send_group_msg', { group_id: '777777777', message: 'agent 自己发的总结' })
  assert.equal(r.captured, true)
  assert.deepEqual(engine.reportCapture.notes, ['agent 自己发的总结'])
  assert.equal(client.sent.length, 0)
})

// ── 4. 投递失败必须留一句人话，不能静默 ─────────────────────────────
await check('首发送失败 → 补一条「这边出了点岔子，结果没发出去。」', async () => {
  const client = makeFakeClient({ failFirstGroupSend: true })
  const engine = makeFakeEngine({ client })
  engine.executor = {
    ensureHandle: async () => ({}),
    workSessionId: () => 'work-sid',
    run: async () => ({ ok: true, text: '福州今天有雾，23.6~34.3°C。' }),
  }
  await engine.runCommand({
    ev: { message_type: 'group', group_id: 777777777, user_id: 222222222, message_id: 5 },
    conv: {},
    task: '命令 查询福州今天天气',
    userName: '示例主人',
    scene: 'group',
  })
  const texts = client.sent.map((s) => (Array.isArray(s.params.message) ? s.params.message[0]?.data?.text : s.params.message))
  assert.ok(
    texts.some((t) => String(t).includes('出了点岔子')),
    `必须补一句人话，实际发送：${JSON.stringify(texts)}`,
  )
})

await check('正常投递：一组气泡，且不含重复内容', async () => {
  const client = makeFakeClient()
  const engine = makeFakeEngine({ client })
  engine.executor = {
    ensureHandle: async () => ({}),
    workSessionId: () => 'work-sid',
    run: async () => ({ ok: true, text: '广州今天阴天，25~34.1°C。' }),
  }
  await engine.runCommand({
    ev: { message_type: 'group', group_id: 777777777, user_id: 222222222, message_id: 6 },
    conv: {},
    task: '命令 今天广州天气怎么样',
    userName: '示例主人',
    scene: 'group',
  })
  const texts = client.sent.map((s) => s.params.message[0]?.data?.text).filter(Boolean)
  assert.equal(texts.length, 1, `应只发一条，实际 ${JSON.stringify(texts)}`)
  assert.match(texts[0], /广州今天阴天/)
})

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
