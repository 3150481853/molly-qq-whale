/**
 * 会话回读边界测试（2026-10-20「新建干活会话首轮读不到产出」）。
 *
 * 真机现场（qq-whale-work-v2-111111111）：
 *   followup 之后宿主又插了一条 `runtime-context` 快照 user 消息，
 *   assistant 的回复落在它后面。旧边界把它当「下一条 user」，
 *   区间里没有 assistant → readLastAssistant 返回 '' → 上层报「没有产出」。
 *
 * 本测试钉两个方向：
 *   A. 元信息 user 消息（runtime-context / title-llm / 抬头可识别）**不截断**本轮，
 *      仍能读到 assistant 正文；
 *   B. 真实的另一个轮次（定时提醒，没有 source 字段）**必须截断**，
 *      返回 ''，绝不把别人那轮的回答当成本次结果（09:26 答非所问的根因）。
 *
 * 用法：node tools/test-session-readback.mjs
 *      READBACK_LIB_DIR=<安装副本 lib> node tools/test-session-readback.mjs
 */

import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB_DIR =
  process.env.READBACK_LIB_DIR || path.join(HERE, '..', 'plugin', 'dsh-qq-whale', 'lib')
const libUrl = (name) => `file:///${path.join(LIB_DIR, name).replace(/\\/g, '/')}`
const { CommandExecutor } = await import(libUrl('commands.js'))

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}
const eq = (name, a, b) => ok(name, a === b, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)

const logger = () => {}
const ex = new CommandExecutor({ ctx: null, logger, config: { selfId: '1' }, engine: null })

const TEXT = (text, extra = {}) => ({
  role: 'user',
  content: [{ type: 'text', text }],
  ...extra,
})
const ASSISTANT = (text) => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
})

const agentWith = (msgs) => ({ session: { deriveMessages: () => msgs } })

// ─── A. 元信息不截断 ───────────────────────────────────────────
console.log('\n[A] followup 之后插入元信息 user 消息 → 仍读到正文')
{
  const TASK = '只说一句：沙箱自检通过'
  const ANSWER = '沙箱自检通过。当前工作目录为 G:\\Molly\\sandbox\\qq-work……'

  // A1：真机形态 —— runtime-context 快照（source.kind/form）
  const a1 = agentWith([
    TEXT(TASK, { source: { kind: 'user' } }),
    TEXT('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent working directory: "G:\\Molly\\sandbox\\qq-work".', {
      source: { kind: 'runtime-context', form: 'snapshot' },
    }),
    ASSISTANT(ANSWER),
  ])
  eq('A1 真机形态：读回正文', ex.readLastAssistant(a1, TASK), ANSWER)

  // A2：标题生成请求（source.kind='dsh-session-title-llm'），排在 assistant 前
  const a2 = agentWith([
    TEXT(TASK, { source: { kind: 'user' } }),
    TEXT('Generate the session title from this JSON array of human messages:\n[{"seq":8,"text":"..."}]', {
      source: { kind: 'dsh-session-title-llm' },
    }),
    ASSISTANT(ANSWER),
  ])
  eq('A2 标题生成请求：读回正文', ex.readLastAssistant(a2, TASK), ANSWER)

  // A3：source 被 deriveMessages 抹掉，只剩固定抬头
  const a3 = agentWith([
    TEXT(TASK, { source: { kind: 'user' } }),
    TEXT('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.'),
    ASSISTANT(ANSWER),
  ])
  eq('A3 source 丢失、靠抬头识别：读回正文', ex.readLastAssistant(a3, TASK), ANSWER)

  // A4：元信息 + 本轮还没产出 → 仍返回 ''（不能把更早的旧结果捞出来）
  const a4 = agentWith([
    TEXT('上一条别的命令'),
    ASSISTANT('上一条的旧结果'),
    TEXT(TASK, { source: { kind: 'user' } }),
    TEXT('Current runtime context. This snapshot supersedes earlier runtime-context snapshots.', {
      source: { kind: 'runtime-context', form: 'snapshot' },
    }),
  ])
  eq('A4 本轮无产出 → 空串（不捞旧结果）', ex.readLastAssistant(a4, TASK), '')

  // A5：只有 @我 前缀的命令原文也算同一条（边界按 task 原文严格匹配，保持不变）
  const a5 = agentWith([
    TEXT(TASK, { source: { kind: 'user' } }),
    TEXT('Current runtime context. x', { source: { kind: 'runtime-context' } }),
    TEXT('补充一句', { source: { kind: 'user' } }),
    ASSISTANT('这是我另外一条命令的回答'),
  ])
  eq('A5 真实轮次仍截断 → 空串', ex.readLastAssistant(a5, TASK), '')
}

// ─── B. 真实轮次必须截断 ───────────────────────────────────────
console.log('\n[B] 定时提醒/别的真实轮次 → 仍然返回空串（09:26 保护不回退）')
{
  const TASK = '查询福州今天天气，并且@333333333'
  const REMINDER =
    '[SCHEDULE REMINDER BATCH]\nThis is a scheduled message from the user\nreminders_json: [...]'

  // B1：提醒轮次在 followup 之后，并且答了别的话 → 不能当成命令结果
  const b1 = agentWith([
    TEXT(TASK, { source: { kind: 'user' } }),
    TEXT(REMINDER), // 真机形态：没有 source 字段
    ASSISTANT('无新好友。'),
  ])
  eq('B1 定时提醒的回答不被当结果', ex.readLastAssistant(b1, TASK), '')

  // B2：本轮自己的回答在提醒之前 → 取自己那条，不取提醒那条
  const b2 = agentWith([
    TEXT(TASK, { source: { kind: 'user' } }),
    ASSISTANT('福州今天有雾，25~31 度。'),
    TEXT(REMINDER),
    ASSISTANT('无新好友。'),
  ])
  eq('B2 取本轮自己的回答，不取提醒的', ex.readLastAssistant(b2, TASK), '福州今天有雾，25~31 度。')

  // B3：reminder 之后又来一条普通用户消息 → 仍然以最近的 user 为界
  const b3 = agentWith([
    TEXT(TASK, { source: { kind: 'user' } }),
    TEXT('别人的闲聊'),
    ASSISTANT('闲聊回答'),
  ])
  eq('B3 别人的轮次不越界', ex.readLastAssistant(b3, TASK), '')

  // B4：没有 task（旧会话被裁剪）→ 退回旧行为，取最后一条 assistant
  const b4 = agentWith([TEXT('随便'), ASSISTANT('最后一条')])
  eq('B4 无 task 退回旧行为', ex.readLastAssistant(b4, ''), '最后一条')
}

// ─── C. isMetaUserMessage 的白名单边界 ────────────────────────
console.log('\n[C] isMetaUserMessage 只认白名单')
{
  ok('runtime-context 是元信息', ex.isMetaUserMessage({ role: 'user', source: { kind: 'runtime-context' }, content: [] }))
  ok('title-llm 是元信息', ex.isMetaUserMessage({ role: 'user', source: { kind: 'dsh-session-title-llm' }, content: [] }))
  ok('form=snapshot 是元信息', ex.isMetaUserMessage({ role: 'user', source: { form: 'snapshot' }, content: [] }))
  ok(
    '定时提醒（无 source）不是元信息',
    ex.isMetaUserMessage({ role: 'user', content: [{ type: 'text', text: '[SCHEDULE REMINDER BATCH] ...' }] }) === false,
  )
  ok(
    '普通用户消息不是元信息',
    ex.isMetaUserMessage({ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '你好' }] }) === false,
  )
  ok('assistant 不是元信息', ex.isMetaUserMessage(ASSISTANT('x')) === false)
}

// ─── D. _runOnce 集成：元信息插入不再变成「没有产出」──────────
console.log('\n[D] _runOnce 集成：首轮带元信息也能拿到正文')
{
  const TASK = '只说一句：沙箱自检通过'
  const ANSWER = '沙箱自检通过。'
  const msgs = []
  const agent = {
    status: 'idle',
    activityDone: 0,
    async cancel() {},
    followup(msg) {
      agent.activityDone += 1
      const text = (msg?.content || []).map((b) => b?.text || '').join('')
      msgs.push({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
      // 真机顺序：followup → runtime-context 快照 → assistant
      msgs.push({
        role: 'user',
        content: [{ type: 'text', text: 'Current runtime context. This snapshot supersedes earlier runtime-context snapshots.' }],
        source: { kind: 'runtime-context', form: 'snapshot' },
      })
      msgs.push({ role: 'assistant', content: [{ type: 'text', text: ANSWER }] })
    },
    async whenIdle() {},
    session: { deriveMessages: () => msgs.slice() },
  }
  const ex2 = new CommandExecutor({ ctx: null, logger, config: { selfId: '1', workTurnTimeoutMs: 5000 }, engine: null })
  ex2.handle = { agent, sessionId: 'qq-whale-work-v2-1' }
  ex2.ensureHandle = async () => ex2.handle
  ex2.liveAgent = () => agent
  const result = await ex2._runOnce(TASK)
  eq('D1 结果正文正确', result.text, ANSWER)
  ok('D2 不是「没有产出」', !String(result.text).includes('没有产出'))
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(fail === 0 ? 0 : 1)
