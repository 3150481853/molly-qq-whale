/**
 * task-46 自测：三会话隔离 + 自动路由 + 每会话独立模型。
 *
 * 钉住这些事：
 *   1. 路由规则表（8 条）：#chat/#code 覆盖、命令→work、改代码+文件→code、
 *      只有意图词→模型兜底、闲聊/空/表情/长文→chat
 *   2. 三条会话的模型 / 工具面 / cwd（读 agents.create 的入参，不真起 agent）
 *   3. chat 的工具面不含 write/edit/pwsh/apply_patch/ask_user_question
 *   4. code 会话里写受保护路径 → work-guard DENY
 *   5. 路由计数与 #override 生效
 *   6. 离线 e2e：「命令 今天气温」进 work（kimi-k2.6），
 *      「帮我把 engine.js 改一下」进 code（flash）且写盘被 guard 拦
 *
 * 用法：node tools/test-session-router.mjs
 *      ROUTER_LIB_DIR=<安装副本 lib> node tools/test-session-router.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB_DIR = process.env.ROUTER_LIB_DIR || path.join(HERE, '..', 'plugin', 'dsh-qq-whale', 'lib')
const TMP = path.join(HERE, '..', 'out', 'test-session-router')
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(path.join(TMP, 'pending'), { recursive: true })

const libUrl = (name) => `file:///${path.join(LIB_DIR, name).replace(/\\/g, '/')}`
const R = await import(libUrl('session-router.js'))
const { CommandExecutor, CHAT_DENY_TOOLS } = await import(libUrl('commands.js'))
const { ChatEngine } = await import(libUrl('engine.js'))
const wg = await import(libUrl('work-guard.js'))

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}
const eq = (name, a, b) => ok(name, a === b, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)
const logger = () => {}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const PREFIXES = ['命令 ', '命令：', '命令:']
const rule = (text, classify) => R.routeMessage({ text, prefixes: PREFIXES, classify })

// ─── 1. 规则表 8 条 ─────────────────────────────────────────────
console.log('\n[1] 路由规则表')
{
  let r = R.ruleRoute({ text: '#code 把超时改成 5 分钟', prefixes: PREFIXES })
  eq('#code 覆盖 → code', r.route, 'code'); eq('  by=override', r.by, 'override')
  eq('  前缀被剥掉', r.text, '把超时改成 5 分钟')

  r = R.ruleRoute({ text: '#chat 把 engine.js 改一下', prefixes: PREFIXES })
  eq('#chat 覆盖压过代码意图 → chat', r.route, 'chat')

  r = R.ruleRoute({ text: '命令 今天气温多少', prefixes: PREFIXES })
  eq('命令 → work', r.route, 'work'); eq('  命令前缀剥掉', r.text, '今天气温多少')

  r = R.ruleRoute({ text: '把 engine.js 的超时改掉', prefixes: PREFIXES })
  eq('意图+文件 → code', r.route, 'code')

  r = R.ruleRoute({ text: '你会改代码吗', prefixes: PREFIXES })
  eq('只有意图词 → 交模型（route=null）', r.route, null); eq('  by=model', r.by, 'model')

  r = R.ruleRoute({ text: '今天天气怎么样', prefixes: PREFIXES })
  eq('闲聊 → chat', r.route, 'chat')

  r = R.ruleRoute({ text: '', prefixes: PREFIXES })
  eq('空消息 → chat', r.route, 'chat')
  r = R.ruleRoute({ text: '😀🎉', prefixes: PREFIXES })
  eq('纯表情 → chat', r.route, 'chat')
  r = R.ruleRoute({ text: '哈哈'.repeat(400), prefixes: PREFIXES })
  eq('超长正文（无意图）→ chat', r.route, 'chat')

  // 模型兜底：返回 work 就 work；返回垃圾/抛错 → chat
  const viaModel = await rule('你会改代码吗', async () => 'work')
  eq('模型兜底返回 work', viaModel.route, 'work'); eq('  by=model', viaModel.by, 'model')
  const badModel = await rule('你会改代码吗', async () => { throw new Error('boom') })
  eq('模型兜底抛错 → chat（权限最小）', badModel.route, 'chat')
  eq('parseRouteAnswer 解析失败 → chat', R.parseRouteAnswer('我不知道'), 'chat')
}

// ─── 2/3. 三会话的模型 / 工具面 / cwd ──────────────────────────
console.log('\n[2] 三会话的模型 / 工具面 / cwd（读 agents.create 入参）')
const config = {
  selfId: '111111111',
  commanderUsers: ['222222222'],
  commandGroups: ['777777777'],
  commandEnabled: true,
  workTurnTimeoutMs: 60 * 1000,
  chatModel: { provider: 'wb-proxy', model: 'deepseek-v4.1-flash' },
  workModel: { provider: 'wb-proxy', model: 'kimi-k2.6' },
  codeModel: { provider: 'wb-proxy', model: 'deepseek-v4.1-flash' },
  provider: 'wb-proxy',
  model: 'deepseek-v4.1-flash',
  dataDir: path.join(TMP, 'pending'),
}

function makeAgent() {
  const msgs = []
  return {
    status: 'idle',
    activityDone: 0,
    msgs,
    cancel() {},
    followup(msg) {
      agent.activityDone += 1
      const text = (msg?.content || []).map((b) => b?.text || '').join('')
      msgs.push({ role: 'user', content: [{ type: 'text', text }] })
      msgs.push({ role: 'assistant', content: [{ type: 'text', text: '干完了' }] })
    },
    async whenIdle() {},
    session: { deriveMessages: () => msgs.slice() },
  }
}

function makeContext() {
  const created = []
  const restricts = []
  const guards = []
  const agent = makeAgent()
  const ctx = {
    agents: {
      get: () => undefined,
      async create(opts) {
        created.push(opts)
        // setup 必须被真实调用一次（人设 + restrict + guard 都挂在这里）
        opts.setup?.({
          systemPrompt: { section: () => {} },
          tools: {
            restrict: (spec) => restricts.push(spec),
            guard: (fn) => { guards.push(fn); return () => {} },
          },
        }, agent)
        return { agent, dispose: async () => {} }
      },
      async resume(opts) { return ctx.agents.create(opts) },
    },
  }
  return { ctx, created, restricts, guards, agent }
}

{
  const { ctx, created, restricts, guards } = makeContext()
  const work = new CommandExecutor({ ctx, logger, config, engine: null, role: 'work' })
  await work.ensureHandle()
  const w = created[0]
  eq('work sessionId 沿用现有 id', w.sessionId, 'qq-whale-work-111111111')
  eq('work 模型 provider', w.agentOptions.provider, 'wb-proxy')
  eq('work 模型 model=kimi-k2.6', w.agentOptions.model, 'kimi-k2.6')
  ok('work cwd=沙箱', String(w.meta?.cwd || '').replace(/\//g, '\\').toLowerCase() === 'g:\\molly\\sandbox\\qq-work', String(w.meta?.cwd))
  const denied = restricts.flatMap((s) => s.deny || [])
  ok('work 屏蔽 write', denied.includes('write'))
  ok('work 屏蔽 edit', denied.includes('edit'))
  ok('work 屏蔽 apply_patch', denied.includes('apply_patch'))
  ok('work 屏蔽 ask_user_question', denied.includes('ask_user_question'))
  ok('work 没屏蔽 qq_onebot（能力还在）', !denied.includes('qq_onebot'))
  ok('work 挂上了 guard', guards.length === 1)

  // 4. code 会话 + 受保护路径 DENY
  const c = makeContext()
  const code = new CommandExecutor({ ctx: c.ctx, logger, config, engine: null, role: 'code' })
  await code.ensureHandle()
  const cd = c.created[0]
  eq('code sessionId', cd.sessionId, 'qq-whale-code-111111111')
  eq('code 模型=flash', cd.agentOptions.model, 'deepseek-v4.1-flash')
  ok('code cwd=沙箱', String(cd.meta?.cwd || '').replace(/\//g, '\\').toLowerCase() === 'g:\\molly\\sandbox\\qq-work')
  const codeDenied = c.restricts.flatMap((s) => s.deny || [])
  ok('code 不屏蔽 write（写盘由 guard 管）', !codeDenied.includes('write'))
  ok('code 也屏蔽 ask_user_question', codeDenied.includes('ask_user_question'))
  // guard 是同步的：直接喂一个写受保护路径的 exec
  const denial = c.guards[0]({
    name: 'write',
    arguments: { path: 'G:\\Molly\\qq-whale\\plugin\\dsh-qq-whale\\lib\\engine.js', content: 'x' },
    agent: { session: { id: 'qq-whale-code-111111111' } },
  })
  ok('code 写受保护路径 → DENY', typeof denial === 'string' && denial.length > 0, String(denial))
  ok('DENY 文案包含「需要人工审核」或「审核」', /审核/.test(String(denial)), String(denial))
  // 反过来：沙箱写入要放行
  const allowSandbox = c.guards[0]({
    name: 'write',
    arguments: { path: 'G:\\Molly\\sandbox\\qq-work\\a.txt', content: 'x' },
    agent: { session: { id: 'qq-whale-code-111111111' } },
  })
  ok('code 写沙箱 → 放行', allowSandbox === undefined || allowSandbox === null, String(allowSandbox))

  // 3. chat 工具面
  ok('chat deny 含 write', CHAT_DENY_TOOLS.includes('write'))
  for (const t of ['edit', 'apply_patch', 'pwsh', 'bash', 'run_code', 'ask_user_question']) {
    ok(`chat deny 含 ${t}`, CHAT_DENY_TOOLS.includes(t))
  }
  ok('chat deny 不含 qq_onebot', !CHAT_DENY_TOOLS.includes('qq_onebot'))
}

// ─── 5. 计数 + 离线 e2e ────────────────────────────────────────
console.log('\n[5] 路由计数 + 离线 e2e（命令→work，改代码→code）')
{
  const sent = []
  const ctxEnv = makeContext()
  const engine = Object.create(ChatEngine.prototype)
  engine.config = config
  engine.logger = logger
  engine.ctx = ctxEnv.ctx
  engine.client = {
    async call() { return { message_id: 1 } },
    async sendGroupMsg(gid, payload) { sent.push({ gid: String(gid), payload }) },
    async sendPrivateMsg(uid, payload) { sent.push({ uid: String(uid), payload }) },
  }
  engine.progress = null
  engine.reportCapture = null
  engine._selfSendDepth = 0
  engine.remember = () => null
  engine.pushHistory = (conv, entry) => conv.history.push(entry)
  engine.executor = new CommandExecutor({ ctx: ctxEnv.ctx, logger, config, engine, role: 'work' })
  engine.codeExecutor = new CommandExecutor({ ctx: ctxEnv.ctx, logger, config, engine, role: 'code' })
  engine.routeState = { last: null, counts: { chat: 0, work: 0, code: 0 } }
  engine.callWithFallback = async () => ({ ok: true, text: '{"route":"chat"}' })

  const ev = { message_type: 'group', group_id: 777777777, user_id: 222222222, message_id: 7 }
  const conv = { key: 'group:777777777', kind: 'group', history: [] }

  // chat：不建会话
  let r = await engine.routeAndDispatch({ ev, conv, norm: { text: '今天天气怎么样' }, userName: '群主', scene: 'group_mention' })
  eq('闲聊 handled=false', r.handled, false)
  eq('闲聊 route=chat', r.route.route, 'chat')

  // 命令 → work
  r = await engine.routeAndDispatch({ ev, conv, norm: { text: '命令 今天气温多少' }, userName: '群主', scene: 'group_mention' })
  eq('命令 handled=true', r.handled, true)
  eq('命令 route=work', r.route.route, 'work')
  // runCommand 里没有 progress 时先发一句随机开工语（0.8~2.3s），再建会话
  await sleep(3200)
  eq('建了 work 会话', ctxEnv.created[0].sessionId, 'qq-whale-work-111111111')
  eq('work 用 kimi-k2.6', ctxEnv.created[0].agentOptions.model, 'kimi-k2.6')

  // 改代码 → code
  r = await engine.routeAndDispatch({ ev, conv, norm: { text: '帮我把 engine.js 改一下' }, userName: '群主', scene: 'group_mention' })
  eq('改代码 route=code', r.route.route, 'code')
  await sleep(3600)
  const codeCreate = ctxEnv.created.find((c) => c.sessionId === 'qq-whale-code-111111111')
  ok('建了 code 会话', Boolean(codeCreate))
  eq('code 用 flash', codeCreate?.agentOptions.model, 'deepseek-v4.1-flash')

  // 计数
  eq('counts.chat', engine.routeState.counts.chat, 1)
  ok('counts.work >= 1', engine.routeState.counts.work >= 1, String(engine.routeState.counts.work))
  ok('counts.code >= 1', engine.routeState.counts.code >= 1, String(engine.routeState.counts.code))
  eq('last.route=code', engine.routeState.last.route, 'code')

  // #override 生效并剥前缀
  r = await engine.routeAndDispatch({ ev, conv, norm: { text: '#work 查一下明天天气' }, userName: '群主', scene: 'group_mention' })
  eq('#work 覆盖 → work', r.route.route, 'work'); eq('  by=override', r.route.by, 'override')
  eq('  前缀剥掉', r.route.text, '查一下明天天气')

  // 没有指令权限的人：路由到 work 也降级 chat
  const r2 = await engine.routeAndDispatch({
    ev: { ...ev, user_id: 999999999 },
    conv,
    norm: { text: '命令 查一下' },
    userName: '路人',
    scene: 'group_mention',
  })
  eq('非指令者 → 降级 chat', r2.handled, false)
  ok('  标记 downgradedToChat', engine.routeState.last.downgradedToChat === true)
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
fs.rmSync(TMP, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
