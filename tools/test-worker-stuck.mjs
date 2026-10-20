/**
 * task-44 自测：干活会话不能卡死。
 *
 * 背景（真机 2026-10-20）：worker 调 ask_user_question 想确认「改哪个超时」，
 * 但 QQ 后台没有人能点那个弹窗 → turn 永久挂起 → state.work.running 一直是 true
 * → 后面所有命令排队超时。本测试钉四件事：
 *   1. 工具面里真的没有 ask_user_question（tools.restrict deny）
 *   2. 即使宿主没生效，guard 也会立刻以「这里没人能回答」拒绝，模型能继续
 *   3. 单轮超过上限 → cancel 当前轮 + 回固定人话 + running 归位
 *   4. 上一条命令卡死超阈值 → 下一条命令先取消它再自己跑
 * 全程假 agent / 假客户端，不碰 QQ / NapCat / 宿主。
 *
 * 用法：node tools/test-worker-stuck.mjs
 *      STUCK_LIB_DIR=<安装副本 lib> node tools/test-worker-stuck.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB_DIR = process.env.STUCK_LIB_DIR || path.join(HERE, '..', 'plugin', 'dsh-qq-whale', 'lib')
const TMP = path.join(HERE, '..', 'out', 'test-worker-stuck')

fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

const libUrl = (name) => `file:///${path.join(LIB_DIR, name).replace(/\\/g, '/')}`
const wg = await import(libUrl('work-guard.js'))
const {
  CommandExecutor,
  WORK_STALL_REPLY,
  WORK_TURN_TIMEOUT_MS,
  WORK_STUCK_MS,
} = await import(libUrl('commands.js'))
const { ChatEngine } = await import(libUrl('engine.js'))

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    fail += 1
    failures.push(name + (extra ? ` — ${extra}` : ''))
    console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`)
  }
}
const eq = (name, a, b) => ok(name, a === b, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)
const logger = () => {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const baseConfig = { selfId: '111111111', ownerUin: '222222222', dataDir: path.join(TMP, 'data'), progressEnabled: false }

// ─── 1. 工具面屏蔽 ───────────────────────────────────────────────
console.log('\n[1] workerSetup 从工具面移除交互式提问')
{
  const ex = new CommandExecutor({ ctx: null, logger, config: { ...baseConfig }, engine: null })
  const restricted = []
  let guardFn = null
  let promptText = ''
  const fakeCtx = {
    systemPrompt: { section: ({ text }) => { promptText = text } },
    tools: {
      restrict: (spec) => { restricted.push(spec) },
      guard: (fn) => { guardFn = fn; return () => { guardFn = null } },
    },
  }
  ex.workerSetup()(fakeCtx, {})
  const denied = restricted.flatMap((s) => s.deny || [])
  ok('restrict 被调用', restricted.length > 0)
  ok('ask_user_question 被 deny', denied.includes('ask_user_question'), JSON.stringify(restricted))
  ok('人设写明「你没有人可问」', promptText.includes('你没有人可问'))
  ok('人设禁止 ask_user_question', promptText.includes('ask_user_question'))
  ok('人设要求说明假设', promptText.includes('说明你的假设'))
  ok('guard 仍然挂在同一 ctx 上', typeof guardFn === 'function')
}

// ─── 2. guard 兜底 ──────────────────────────────────────────────
console.log('\n[2] guard 现场拒绝提问（宿主没 restrict 时的兜底）')
{
  const hit = wg.scanToolCall({ name: 'ask_user_question', arguments: { questions: [{ id: 'q', question: '改哪个超时？' }] } })
  ok('ask_user_question 被拦', hit.deny === true)
  ok('标记为 interactive', hit.interactive === true)
  ok('原因说清「没有人能回答」', String(hit.reason).includes('没有人能回答'))
  ok('原因要求自己决定', String(hit.reason).includes('直接做完'))
  const allow = wg.scanToolCall({ name: 'todo_write', arguments: { todos: [] } })
  ok('普通工具不受影响', allow.deny === false)
  const exitPlan = wg.scanToolCall({ name: 'exit_plan_mode', arguments: { plan: 'x' } })
  ok('exit_plan_mode 也被拦', exitPlan.deny === true)
}

// ─── 3. 单轮超时 ───────────────────────────────────────────────
console.log('\n[3] 单轮超时：取消 + 人话 + running 归位')
{
  let cancelCalls = 0
  let idleResolvers = []
  const agent = {
    status: 'idle',
    activityDone: 0,
    cancel(cause) {
      cancelCalls += 1
      // 模拟 abort：whenIdle 落定
      for (const r of idleResolvers) r()
      idleResolvers = []
    },
    followup() {
      agent.activityDone += 1
    },
    whenIdle() {
      return new Promise((resolve) => idleResolvers.push(resolve))
    },
    session: { deriveMessages: () => [] },
  }
  const ex = new CommandExecutor({
    ctx: null,
    logger,
    config: { ...baseConfig, workTurnTimeoutMs: 5000, commandTimeoutMinutes: 15 },
    engine: null,
  })
  ex.handle = { agent, sessionId: 'qq-whale-work-111111111' }
  ex.ensureHandle = async () => ex.handle
  ex.liveAgent = () => agent
  const t0 = Date.now()
  const result = await ex._runOnce('做个会卡住的任务')
  const took = Date.now() - t0
  eq('返回固定卡住话术', result.text, WORK_STALL_REPLY)
  ok('标记 timedOut', result.timedOut === true)
  ok('agent.cancel 被调用一次', cancelCalls === 1, `实际 ${cancelCalls}`)
  ok('running 已归位', ex.running === null, JSON.stringify(ex.running))
  ok('耗时受 5s 上限约束（<12s）', took < 12000, `${took}ms`)
}

// ─── 4. 卡死会话的自动释放 ─────────────────────────────────────
console.log('\n[4] 上一条命令卡死 → 下一条先取消它')
{
  let cancelCalls = 0
  const msgs = []
  const agent = {
    status: 'idle',
    activityDone: 0,
    cancel() { cancelCalls += 1 },
    followup(msg) {
      agent.activityDone += 1
      msgs.push({ role: 'user', content: [{ type: 'text', text: msg.content[0].text }] })
      msgs.push({ role: 'assistant', content: [{ type: 'text', text: '沙箱里写好了 a.txt' }] })
    },
    async whenIdle() {},
    session: { deriveMessages: () => msgs.slice() },
  }
  const ex = new CommandExecutor({ ctx: null, logger, config: { ...baseConfig, workTurnTimeoutMs: 5000 }, engine: null })
  ex.handle = { agent, sessionId: 'qq-whale-work-111111111' }
  ex.ensureHandle = async () => ex.handle
  ex.liveAgent = () => agent
  ex.running = { id: 'stuck-old', task: '改 engine.js 超时', startedAt: Date.now() - (WORK_STUCK_MS + 5000) }
  const result = await ex._runOnce('在沙箱写个 a.txt')
  eq('新命令正常完成', result.text, '沙箱里写好了 a.txt')
  eq('旧轮被 cancel 一次', cancelCalls, 1)
  ok('新命令没有误报卡住', !String(result.text).includes('卡住了'))
}

// ─── 5. 离线 e2e：asks 场景不再挂死 ────────────────────────────
console.log('\n[5] 离线 e2e：一条「有歧义」的命令不会再挂住')
{
  const sent = []
  const fakeClient = {
    async call(action, params) { return { message_id: 1, action, params } },
    async sendGroupMsg(groupId, payload) { sent.push({ kind: 'group', target: String(groupId), payload }) },
    async sendPrivateMsg(userId, payload) { sent.push({ kind: 'private', target: String(userId), payload }) },
  }
  const engine = Object.create(ChatEngine.prototype)
  engine.config = {
    ...baseConfig,
    workTurnTimeoutMs: 5000,
    commandTimeoutMinutes: 15,
    contextLimit: 40,
    typingCharactersPerSecond: 10000,
    typingMaxDelaySeconds: 0,
    reactionMinSeconds: 0,
    reactionMaxSeconds: 0.01,
    betweenBubblesMinMs: 0,
    betweenBubblesMaxMs: 0,
  }
  engine.logger = logger
  engine.client = fakeClient
  engine.progress = null
  engine.reportCapture = null
  engine._selfSendDepth = 0
  engine.remember = () => null
  engine.pushHistory = (conv, entry) => conv.history.push(entry)

  // 这个 agent 模拟「发了 ask_user_question 之后永远等下去」
  const agent = {
    status: 'idle',
    activityDone: 0,
    cancel() { /* 取消后仍然不产出：最坏情况 */ },
    followup() { agent.activityDone += 1 },
    whenIdle() { return new Promise(() => {}) },
    session: { deriveMessages: () => [] },
  }
  const executor = new CommandExecutor({ ctx: null, logger, config: engine.config, engine })
  executor.handle = { agent, sessionId: 'qq-whale-work-111111111' }
  executor.ensureHandle = async () => executor.handle
  executor.liveAgent = () => agent
  engine.executor = executor

  const t0 = Date.now()
  const result = await engine.runCommand({
    ev: { message_type: 'group', group_id: 777777777, user_id: 222222222, message_id: 9, sender: { user_id: 222222222 } },
    conv: { key: 'group:777777777', kind: 'group', history: [] },
    task: '把超时改成 5 分钟',
    userName: '群主',
    scene: 'group_mention',
  })
  const took = Date.now() - t0
  eq('最终结果是卡住话术', result.text, WORK_STALL_REPLY)
  const text = sent.filter((s) => s.kind === 'group').map((s) => JSON.stringify(s.payload)).join('\n')
  ok('QQ 里收到卡住话术', text.includes(WORK_STALL_REPLY))
  ok('没有人在等弹窗（没出现 ask 相关文案）', !text.includes('你要改哪一个'))
  ok('限时内结束（<15s）', took < 15000, `${took}ms`)
  eq('executor.running 归位', executor.running, null)
  ok('默认单轮上限是 180s', WORK_TURN_TIMEOUT_MS === 180000, String(WORK_TURN_TIMEOUT_MS))
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(fail === 0 ? 0 : 1)
