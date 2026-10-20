/**
 * 干活会话韧性测试（2026-10-18）。
 *
 * 覆盖用户 m19598 截图里的两个真机故障：
 *   1. 「任务已投递但 agent 没有启动（wakeDriver 未生效）」
 *      —— 死句柄上 followup 是空操作，不抛错也不唤醒 driver
 *   2. 「SessionAlreadyOwnedError: session "..." is already owned by an
 *      active write handle」—— 旧实例泄漏的写句柄占着 claimWrite
 *
 * 跑法：node test-commands-recovery.mjs
 */
import assert from 'node:assert'
import { CommandExecutor } from '../plugin/dsh-qq-whale/lib/commands.js'

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    pass += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    fail += 1
    console.log(`  ✗ ${name}\n    ${err?.message || err}`)
  }
}
async function checkAsync(name, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  ✓ ${name}`)
  } catch (err) {
    fail += 1
    console.log(`  ✗ ${name}\n    ${err?.message || err}`)
  }
}

function makeExecutor(agents) {
  const logs = []
  const cmds = new CommandExecutor({
    ctx: { reflect: { get: (n) => (n === 'agents' ? agents : undefined) } },
    logger: (level, msg) => logs.push(`${level}: ${msg}`),
    config: {
      selfId: '1',
      commandEnabled: true,
      commanderUsers: ['10000'],
      commandTimeoutMinutes: 1,
    },
    engine: {},
  })
  return { cmds, logs }
}

function lockedError(id) {
  return new Error(
    `SessionAlreadyOwnedError: session "${id}" is already owned by an active write handle\n` +
      '    at JsonlBackendTracker.claimWrite (file:///x/dsh-session-persistence-jsonl/lib/index.js:315:35)',
  )
}

console.log('干活会话韧性测试')

// ── 1. 写锁被占：等三轮、换 id 重开，命令不能永久卡死 ────────────────
await checkAsync('写锁被占 → 重试后换新 id 重开（不抛死）', async () => {
  const calls = []
  const agents = {
    get: () => undefined,
    create: async (o) => {
      calls.push(['create', o.sessionId])
      throw new Error(`session "${o.sessionId}" already exists`)
    },
    resume: async (o) => {
      calls.push(['resume', o.resumeSessionId])
      if (!o.resumeSessionId.endsWith('-b')) throw lockedError(o.resumeSessionId)
      return { agent: { id: o.resumeSessionId }, dispose: async () => {} }
    },
  }
  const { cmds } = makeExecutor(agents)
  const handle = await cmds.ensureHandle()
  assert.equal(handle.sessionId, 'qq-whale-work-v2-1-b', '应落到 -b 号会话')
  assert.ok(
    calls.filter((c) => c[0] === 'resume' && c[1] === 'qq-whale-work-v2-1').length >= 2,
    '基础 id 至少重试过两轮',
  )
})

// ── 2. 活表里已有同名 agent：直接接上，不再 create/resume ────────────
await checkAsync('活表里有同名 agent → 借用，不再抢写锁', async () => {
  const liveAgent = { id: 'qq-whale-work-v2-1', marker: 'live' }
  let created = 0
  const agents = {
    get: (id) => (id === 'qq-whale-work-v2-1' ? liveAgent : undefined),
    create: async () => {
      created += 1
      throw new Error('不该走到这里')
    },
    resume: async () => {
      created += 1
      throw new Error('不该走到这里')
    },
  }
  const { cmds } = makeExecutor(agents)
  const handle = await cmds.ensureHandle()
  assert.equal(created, 0, '活表里有就不该再开')
  assert.equal(handle.agent, liveAgent)
  // 借来的 agent 不能由我们拆掉
  await handle.dispose()
  assert.equal(handle.agent, liveAgent, '借用句柄的 dispose 必须是空操作')
})

// ── 3. 死句柄：run() 必须识别、清掉缓存并给出可重试的报错 ────────────
await checkAsync('死句柄 → 报「干活会话已失效」并清空 handle', async () => {
  const idle = Promise.resolve('old')
  const liveAgent = {
    id: 'qq-whale-work-v2-1',
    status: 'idle',
    activityDone: idle,
    followup: () => {},
    whenIdle: async () => {},
    session: { deriveMessages: () => [] },
  }
  let lookups = 0
  const agents = {
    // ensureHandle 查一次（活表里借到），到 run() 复查时 agent 已经"死了"
    get: () => {
      lookups += 1
      return lookups <= 1 ? liveAgent : undefined
    },
    create: async () => {
      throw new Error('不该走到这里')
    },
    resume: async () => {
      throw new Error('不该走到这里')
    },
  }
  const { cmds } = makeExecutor(agents)
  const result = await cmds.run('查一下群 777777777 的白名单')
  assert.equal(result.ok, false)
  assert.match(result.text, /干活会话已失效/)
  assert.equal(cmds.handle, null, '死句柄必须被清掉')
})

// ── 4. agent 本来就忙：followup 只排队，不能误报 wakeDriver 失败 ──────
//   ⚠️ 假 agent 必须照真 AgentLoop 的**公开**字段来写：忙不忙看 `status`，
//   不是 `activity`。旧测试写 `activity !== activityDone` 自己发明了一个字段，
//   于是把「误把忙判成死」这个真 bug 盖住了（dsh-agent-loop/lib/index.js:790）。
await checkAsync('agent 忙时投递 → 不误报，等 whenIdle 后正常返回', async () => {
  const liveAgent = {
    id: 'qq-whale-work-v2-1',
    status: 'running', // 正跑着 ⇒ followup 只排队、activityDone 不变
    activityDone: Promise.resolve('idle'),
    followup: () => {},
    whenIdle: async () => {},
    session: {
      deriveMessages: () => [
        { role: 'assistant', content: [{ type: 'text', text: '群 777777777 已经加进白名单了' }] },
      ],
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
  const { cmds } = makeExecutor(agents)
  const result = await cmds.run('把群 777777777 列入白名单')
  assert.equal(result.ok, true, result.text)
  assert.match(result.text, /白名单/)
})

// ── 5. 两条命令同时来：必须串行，各自读回自己那一轮的文本 ────────────
//   不串行的话两次 followup 排进同一个 inbox，后一条的 whenIdle 在前一条
//   结束时返回 ⇒ 两条命令读到同一段回答，用户看到同一句话被回了两遍。
await checkAsync('并发两条命令 → 串行执行，文本不串台', async () => {
  const state = { status: 'idle', activityDone: Promise.resolve(), turns: 0, msgs: [] }
  const liveAgent = {
    id: 'qq-whale-work-v2-1',
    get status() {
      return state.status
    },
    get activityDone() {
      return state.activityDone
    },
    followup() {
      state.turns += 1
      const n = state.turns
      state.status = 'running'
      state.activityDone = new Promise((resolve) => {
        setTimeout(() => {
          state.msgs.push({
            role: 'assistant',
            content: [{ type: 'text', text: `第${n}轮的回答` }],
          })
          state.status = 'idle'
          resolve()
        }, 20)
      })
    },
    async whenIdle() {
      let a
      do {
        a = state.activityDone
        await a
      } while (a !== state.activityDone)
    },
    session: { deriveMessages: () => state.msgs.slice() },
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
  const { cmds } = makeExecutor(agents)
  const [r1, r2] = await Promise.all([cmds.run('第一件事'), cmds.run('第二件事')])
  assert.equal(r1.ok, true, r1.text)
  assert.equal(r2.ok, true, r2.text)
  assert.equal(r1.text, '第1轮的回答', `第一条应拿到第1轮，实际：${r1.text}`)
  assert.equal(r2.text, '第2轮的回答', `第二条应拿到第2轮，实际：${r2.text}`)
})

console.log(`\n${pass} 通过 / ${fail} 失败`)
process.exit(fail === 0 ? 0 : 1)
