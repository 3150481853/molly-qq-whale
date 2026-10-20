/**
 * engine.js 三处接线测试（2026-10-19，P2 / P3 / P5）：
 *
 *   P3 引用接线   —— 带 reply 段的消息，进模型/进历史的正文要含被引用那条的内容
 *   P5 记忆窗口   —— contextFor / recall 的 limit 必须走 memory.js 的 MEMORY_WINDOW
 *   P2 死磕硬停止 —— 同一话题连续没新证据够 2 轮后，下一轮不查网、提示词收口、
 *                    模型还追问就换成固定收口文案
 *
 * 跑法：node test-quote-wire.mjs
 * 注意：import 的是**安装副本**（真机跑的那份），改完源码要同步过去再跑。
 */
import assert from 'node:assert'
import { ChatEngine } from 'file:///C:/Users/example/.dsh/profiles/desktop/node_modules/dsh-qq-whale/lib/engine.js'

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

const SELF = '111111111'

// ── 假引擎：只带 onMessage 跑到「回不回」判断为止需要的零件 ─────────────
function makeQuoteEngine({ quoteData, quoteFails = false } = {}) {
  const pushed = []
  const calls = []
  const conv = { history: [], relationKey: 'private:111' }
  const engine = Object.create(ChatEngine.prototype)
  Object.assign(engine, {
    selfId: SELF,
    config: { restWindows: [] },
    logger: () => {},
    client: {
      self: { nickname: 'Molly' },
      call: async (action, params, timeout) => {
        calls.push({ action, params, timeout })
        if (action !== 'get_msg') throw new Error(`unexpected action ${action}`)
        if (quoteFails) throw new Error('get_msg 超时')
        return quoteData
      },
    },
    decideScene: () => 'private',
    getConversation: () => conv,
    conversationKey: () => 'private:111',
    noteMember: () => {},
    relations: { touch: () => {} },
    pushHistory: (c, item) => pushed.push(item),
    maybeLearn: async () => {},
    learner: null,
    gatekeeper: null,
    pest: null,
    displayName: async () => '张三',
    groupName: async () => '',
    shouldRespond: () => ({ yes: false, reason: '测试：故意不回' }),
    tapEmoji: async () => {},
    tryCommand: async () => ({ handled: false }),
    scheduleReply: async () => { throw new Error('不该走到回复') },
  })
  return { engine, pushed, calls }
}

function makeQuotedEvent(segments) {
  return {
    post_type: 'message',
    message_type: 'private',
    user_id: 111,
    message_id: 'm1',
    message: segments,
  }
}

const QUOTE_DATA = {
  sender: { user_id: 222, nickname: '张三' },
  message: [{ type: 'text', data: { text: '昨天说的那个报错是 ENOENT' } }],
}

console.log('engine.js 三处接线测试（P2 / P3 / P5）')

// ── 1. P3：引用正文 ───────────────────────────────────────────────────
await check('带 reply 段的消息：历史正文含被引用内容，且只多出一次 get_msg', async () => {
  const { engine, pushed, calls } = makeQuoteEngine({ quoteData: QUOTE_DATA })
  await engine.onMessage(
    makeQuotedEvent([
      { type: 'reply', data: { id: '777' } },
      { type: 'text', data: { text: '这个问题啥意思' } },
    ]),
  )
  const text = pushed[0]?.text || ''
  assert.match(text, /\[引用 @张三：昨天说的那个报错是 ENOENT\]/, `正文里没有引用内容：${text}`)
  assert.match(text, /这个问题啥意思/, '自己的正文不能丢')
  assert.ok(!text.includes('[引用][引用 @'), `出现了两个引用头：${text}`)
  assert.equal(calls.length, 1, `get_msg 应该只调 1 次，实际 ${calls.length}`)
  assert.equal(String(calls[0].params.message_id), '777', '拿错 message_id 了')
  assert.equal(calls[0].timeout, 3000, 'get_msg 要显式传 3 秒超时')
})

await check('只引用、不打字的消息也活下来（不再被空消息 return 掉）', async () => {
  const { engine, pushed } = makeQuoteEngine({ quoteData: QUOTE_DATA })
  await engine.onMessage(makeQuotedEvent([{ type: 'reply', data: { id: '888' } }]))
  assert.equal(pushed.length, 1, '只引用没正文的消息应该照常进历史')
  assert.match(pushed[0].text, /ENOENT/)
})

await check('被引用那条取不到：降级文案上场，消息不丢、主流程不抛', async () => {
  const { engine, pushed } = makeQuoteEngine({ quoteFails: true })
  await engine.onMessage(
    makeQuotedEvent([
      { type: 'reply', data: { id: '999' } },
      { type: 'text', data: { text: '在吗' } },
    ]),
  )
  const text = pushed[0]?.text || ''
  assert.match(text, /取不到内容/, `降级文案没出现：${text}`)
  assert.match(text, /在吗/)
})

// ── 2. P5：记忆窗口 ───────────────────────────────────────────────────
function makeMemoryProbe() {
  const seen = { context: [], recall: [] }
  return {
    seen,
    memory: {
      contextFor(o) {
        seen.context.push(o)
        return ''
      },
      recall(o) {
        seen.recall.push(o)
        return []
      },
    },
  }
}

function makePromptEngine(memory) {
  const engine = Object.create(ChatEngine.prototype)
  Object.assign(engine, {
    client: { self: { nickname: 'Molly' } },
    config: {},
    logger: () => {},
    memory,
    relations: { contextFor: () => '' },
    memberRoster: () => '',
    stickers: { catalogText: () => '' },
    persona: { systemPrompt: () => 'SYS' },
  })
  return engine
}

const PROMPT_CONV = {
  history: [{ role: 'user', text: '你还记得我上次说的事吗', who: '张三' }],
  relationKey: 'private:111',
}

await check('正常档：contextFor limit=24、recall limit=8（走 MEMORY_WINDOW，不是写死 16/6）', () => {
  const { seen, memory } = makeMemoryProbe()
  makePromptEngine(memory).buildSystemPrompt({
    scene: 'private',
    userName: '张三',
    groupName: '',
    mood: null,
    conv: PROMPT_CONV,
  })
  assert.equal(seen.context[0].limit, 24, `contextFor limit 实际 ${seen.context[0].limit}`)
  assert.equal(seen.recall[0].limit, 8, `recall limit 实际 ${seen.recall[0].limit}`)
})

await check('降智档：contextFor limit=8、recall limit=4（MEMORY_WINDOW 的 degraded 档）', () => {
  const { seen, memory } = makeMemoryProbe()
  makePromptEngine(memory).buildSystemPrompt({
    scene: 'private',
    userName: '张三',
    groupName: '',
    mood: null,
    conv: PROMPT_CONV,
    degraded: true,
  })
  assert.equal(seen.context[0].limit, 8, `contextFor limit 实际 ${seen.context[0].limit}`)
  assert.equal(seen.recall[0].limit, 4, `recall limit 实际 ${seen.recall[0].limit}`)
})

// ── 3. P2：死磕硬停止 ─────────────────────────────────────────────────
function makeStallEngine({ replyText = '你指的是哪一条？', researchFound = false } = {}) {
  const captured = { system: '', researchCalls: 0 }
  const researcher = {
    available: true,
    research: async () => {
      captured.researchCalls += 1
      return researchFound ? { ok: true, summary: '查到的东西' } : { ok: false }
    },
  }
  const engine = Object.create(ChatEngine.prototype)
  Object.assign(engine, {
    selfId: SELF,
    config: {},
    logger: () => {},
    client: { self: { nickname: 'Molly' } },
    conversationKey: () => 'private:111',
    budget: { canSpend: () => true, shouldNotifyExhausted: () => false },
    spare: { canSpend: () => true, shouldNotifyExhausted: () => false },
    researcher,
    decideResearch: () => ({ need: true, query: '那个报错', reason: '测试' }),
    buildSystemPrompt: () => 'SYS',
    buildMessages: async () => [],
    callWithFallback: async ({ system }) => {
      captured.system = system
      return { text: replyText }
    },
    persona: { splitReply: (t) => [t], systemPrompt: () => 'SYS' },
    pushHistory: () => {},
  })
  return { engine, captured }
}

const STALL_EV = { message_type: 'private', user_id: 111, message_id: 'm1' }

await check('话题计数：同一问题连问两次后 hardStop，换话题立刻归零', () => {
  const { engine } = makeStallEngine()
  const first = engine.noteTopic({ ev: STALL_EV, text: '那个报错是啥意思' })
  assert.equal(first.hardStop, false)
  engine.noteOutcome({
    key: first.key,
    core: first.core,
    replyText: '你指的是哪一条消息？',
    researchFound: false,
  })
  const second = engine.noteTopic({ ev: STALL_EV, text: '那个报错是啥意思啊' })
  assert.equal(second.misses, 1, `第二次应该继承 1 次未命中，实际 ${second.misses}`)
  engine.noteOutcome({
    key: second.key,
    core: second.core,
    replyText: '你再说一遍？',
    researchFound: false,
  })
  const third = engine.noteTopic({ ev: STALL_EV, text: '那个报错是啥意思啊' })
  assert.equal(third.hardStop, true, '连续两轮无新证据后应该停')
  const other = engine.noteTopic({ ev: STALL_EV, text: '今天晚饭吃什么' })
  assert.equal(other.hardStop, false, '换话题必须归零')
  assert.equal(other.misses, 0)
})

await check('拿到答案（不是追问）会清零，不会被后面冤枉地按住', () => {
  const { engine } = makeStallEngine()
  const t = engine.noteTopic({ ev: STALL_EV, text: '那个报错是啥意思' })
  engine.noteOutcome({ key: t.key, core: t.core, replyText: 'ENOENT 是文件没找到。', researchFound: true })
  const again = engine.noteTopic({ ev: STALL_EV, text: '那个报错是啥意思' })
  assert.equal(again.misses, 0, `有证据的一轮应该清零，实际 ${again.misses}`)
})

await check('硬停止这一轮：不查网、system 带收口指令、还在追问就换固定收口文案', async () => {
  const { engine, captured } = makeStallEngine({ replyText: '你指的是哪一条消息？' })
  // 预置：同一话题已经连续两轮没新证据
  const core = engine.noteTopic({ ev: STALL_EV, text: '那个报错是啥意思' }).core
  engine.stall.set('private:111', { core, misses: 2, at: Date.now() })
  const res = await engine.generate({
    ev: STALL_EV,
    norm: { text: '那个报错是啥意思' },
    scene: 'private',
    conv: { history: [] },
    userName: '张三',
    groupName: '',
    mood: null,
  })
  assert.equal(captured.researchCalls, 0, '硬停止这一轮不许再查网')
  assert.match(captured.system, /# 这一轮别再问了/, `system 缺收口指令：\n${captured.system}`)
  assert.match(res.raw, /翻不到了/, `模型还在追问，应该换成收口文案，实际：${res.raw}`)
  assert.match(res.raw, /贴过来/, '收口文案要给用户一条能走的路')
  assert.equal(engine.stall.get('private:111').misses, 0, '收口后计数要归零')
})

await check('硬停止但模型这轮直接给了结论：保留原话，不硬塞收口文案', async () => {
  const { engine } = makeStallEngine({ replyText: '那个报错就是路径写错了，改成绝对路径就行。' })
  const core = engine.noteTopic({ ev: STALL_EV, text: '那个报错是啥意思' }).core
  engine.stall.set('private:111', { core, misses: 2, at: Date.now() })
  const res = await engine.generate({
    ev: STALL_EV,
    norm: { text: '那个报错是啥意思' },
    scene: 'private',
    conv: { history: [] },
    userName: '张三',
    groupName: '',
    mood: null,
  })
  assert.match(res.raw, /路径写错了/, '有答案就该原样保留')
  assert.ok(!/翻不到了/.test(res.raw), '不该误伤正常回答')
})

await check('没收口时照常查网（硬停止只针对死磕话题）', async () => {
  const { engine, captured } = makeStallEngine({ replyText: '查到了，是文件没找到。', researchFound: true })
  await engine.generate({
    ev: STALL_EV,
    norm: { text: 'ENOENT 报错怎么修' },
    scene: 'private',
    conv: { history: [] },
    userName: '张三',
    groupName: '',
    mood: null,
  })
  assert.equal(captured.researchCalls, 1, '正常轮次应该查 1 次')
  assert.ok(!/# 这一轮别再问了/.test(captured.system), '正常轮次不该带收口指令')
})

console.log(`\n${pass} 通过 / ${fail} 失败`)
if (fail > 0) process.exitCode = 1
