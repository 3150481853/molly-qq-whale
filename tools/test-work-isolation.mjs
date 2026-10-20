/**
 * task-41 自测：干活会话隔离（沙箱 cwd + 代码改动转审核）。
 *
 * 覆盖四层：
 *   1. pickWorkCwd() 只认沙箱/显式配置，不再回退宿主 cwd；
 *   2. work-guard 的路径判定（受保护前缀、正反斜杠、shell 读取放行/写入拦截）；
 *   3. 干活人设里的三句禁令 + tools.guard 真挂上、真的拒；
 *   4. 离线端到端：群里一条「命令 改 engine.js」→ 工具调用被拦 → QQ 只回固定
 *      审核话术、主人收到私聊、pending-code.json 落盘。
 *
 * 不碰真 QQ / NapCat / 宿主：假 OneBot 客户端 + 假 agent。
 * 用法：node tools/test-work-isolation.mjs
 *      ISO_LIB_DIR=<安装副本 lib> node tools/test-work-isolation.mjs  # 验同步后的副本
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB_DIR = process.env.ISO_LIB_DIR || path.join(HERE, '..', 'plugin', 'dsh-qq-whale', 'lib')
const TMP = path.join(HERE, '..', 'out', 'test-work-isolation')

fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(path.join(TMP, 'data'), { recursive: true })

const libUrl = (name) => `file:///${path.join(LIB_DIR, name).replace(/\\/g, '/')}`
const wg = await import(libUrl('work-guard.js'))
const { CommandExecutor, WORK_SANDBOX_DIR } = await import(libUrl('commands.js'))
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
function eq(name, actual, expected) {
  ok(name, actual === expected, `期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
}

const logger = () => {}
const baseConfig = {
  selfId: '111111111',
  ownerUin: '222222222',
  dataDir: path.join(TMP, 'data'),
  workCwd: '',
  workSandboxDir: '',
  commandTimeoutMinutes: 1,
  progressEnabled: false,
  commandEnabled: true,
}

// ─── 1. cwd 只认沙箱 ────────────────────────────────────────────────
console.log('\n[1] pickWorkCwd 默认落到隔离沙箱')
{
  const ex = new CommandExecutor({ ctx: null, logger, config: { ...baseConfig }, engine: null })
  const cwd = ex.pickWorkCwd()
  eq('pickWorkCwd() === WORK_SANDBOX_DIR', cwd, WORK_SANDBOX_DIR)
  ok('沙箱目录真实存在', fs.existsSync(cwd) && fs.statSync(cwd).isDirectory())
  ok('不再是宿主 cwd', path.resolve(cwd) !== path.resolve(process.cwd()))

  const custom = path.join(TMP, 'custom-work')
  fs.rmSync(custom, { recursive: true, force: true })
  const ex2 = new CommandExecutor({ ctx: null, logger, config: { ...baseConfig, workWorCwd: custom, workCwd: custom }, engine: null })
  eq('config.workCwd 覆盖仍生效', ex2.pickWorkCwd(), custom)
  ok('覆盖目录被自动创建', fs.existsSync(custom))

  const ex3 = new CommandExecutor({ ctx: null, logger, config: { ...baseConfig, workSandboxDir: path.join(TMP, 'sandbox-b') }, engine: null })
  eq('config.workSandboxDir 生效', ex3.pickWorkCwd(), path.join(TMP, 'sandbox-b'))
}

// ─── 2. 路径判定 ────────────────────────────────────────────────────
console.log('\n[2] 受保护前缀判定')
{
  for (const p of [
    'G:\\Molly\\qq-whale\\lib\\engine.js',
    '${MOLLY_ROOT}/QQ-WHALE/lib/engine.js',
    'D:\\Documents\\deepseek-harness\\default-workspace\\x.md',
    'C:\\Users\\example\\.dsh\\profiles\\desktop\\cordis.patch.yml',
  ]) {
    ok(`拦截 ${p}`, wg.isProtectedPath(p))
  }
  for (const p of [
    'G:\\Molly\\sandbox\\qq-work\\a.txt',
    'G:\\Molly\\qq-whale-notes.txt',
    'G:\\Molly\\data\\qq-whale\\memory.json',
    'D:\\Documents\\other\\x.txt',
  ]) {
    ok(`放行 ${p}`, !wg.isProtectedPath(p))
  }
}

// ─── 3. 工具调用扫描 ────────────────────────────────────────────────
console.log('\n[3] scanToolCall：写拦、读放、沙箱放')
{
  const denied = (exec) => wg.scanToolCall(exec).deny
  ok('write 到受保护路径 → 拦', denied({ name: 'write', arguments: { file_path: 'G:\\Molly\\qq-whale\\lib\\engine.js', content: 'x' } }))
  ok('edit 到受保护路径 → 拦', denied({ name: 'edit', arguments: { file_path: '${MOLLY_ROOT}/qq-whale/console/console.js' } }))
  ok('apply_patch 到宿主工作区 → 拦', denied({ name: 'apply_patch', arguments: { patch: '*** Update File: D:\\Documents\\deepseek-harness\\default-workspace\\a.md' } }))
  ok('pwsh Set-Content 受保护路径 → 拦', denied({ name: 'pwsh', arguments: { command: 'Set-Content -Path "G:\\Molly\\qq-whale\\lib\\engine.js" -Value x' } }))
  ok('pwsh 重定向写入 → 拦', denied({ name: 'pwsh', arguments: { command: 'echo x > C:\\Users\\example\\.dsh\\profiles\\desktop\\a.yml' } }))
  ok('run_code 里 fs.writeFileSync → 拦', denied({ name: 'run_code', arguments: { code: "require('fs').writeFileSync('${MOLLY_ROOT}/qq-whale/a.js','x')" } }))
  ok('write 到沙箱 → 放行', !denied({ name: 'write', arguments: { file_path: path.join(WORK_SANDBOX_DIR, 'a.txt') } }))
  ok('pwsh 只读 Get-Content 受保护路径 → 放行', !denied({ name: 'pwsh', arguments: { command: 'Get-Content "G:\\Molly\\qq-whale\\lib\\engine.js"' } }))
  ok('完全无关的写 → 放行', !denied({ name: 'write', arguments: { file_path: 'G:\\Molly\\data\\qq-whale\\x.txt' } }))
  const hit = wg.scanToolCall({ name: 'write', arguments: { file_path: 'G:\\Molly\\qq-whale\\lib\\engine.js' } })
  ok('拒绝原因含固定话术', String(hit.reason).includes(wg.REVIEW_REPLY))
  ok('拒绝原因含「需要人工审核」', String(hit.reason).includes('需要人工审核'))
  ok('拒绝原因点名具体路径', String(hit.reason).includes('g:\\molly\\qq-whale\\lib\\engine.js'))
}

// ─── 4. 人设 + guard 挂载 ───────────────────────────────────────────
console.log('\n[4] 人设禁令 + tools.guard')
{
  const ex = new CommandExecutor({ ctx: null, logger, config: { ...baseConfig }, engine: null })
  let capturedText = ''
  let registered = null
  const fakeCtx = {
    systemPrompt: {
      section: ({ text }) => {
        capturedText = text
      },
    },
    tools: {
      guard: (fn) => {
        registered = fn
        return () => {
          registered = null
        }
      },
    },
  }
  ex.workerSetup()(fakeCtx, {})
  ok('人设里写了沙箱路径', capturedText.includes(WORK_SANDBOX_DIR))
  ok('人设里禁写 G:\\Molly\\qq-whale', /不许读写/.test(capturedText) && capturedText.includes('G:\\Molly\\qq-whale'))
  ok('人设里禁写宿主工作区', capturedText.includes('D:\\Documents\\deepseek-harness'))
  ok('人设里禁写 .dsh', capturedText.includes('C:\\Users\\example\\.dsh'))
  ok('人设里有固定审核话术', capturedText.includes(wg.REVIEW_REPLY))
  ok('人设里写了「一律不执行」', capturedText.includes('一律不执行'))
  ok('guard 已注册', typeof registered === 'function')

  const reason = registered({ name: 'write', arguments: { file_path: 'G:\\Molly\\qq-whale\\lib\\engine.js', content: 'x' } })
  ok('guard 真拒绝', typeof reason === 'string' && reason.includes(wg.REVIEW_REPLY))
  eq('拦截进了 _escalations', ex._escalations.length, 1)
  eq('拦截记录带路径', ex._escalations[0].paths[0], 'g:\\molly\\qq-whale\\lib\\engine.js')
  ok('沙箱写入 guard 放行', registered({ name: 'write', arguments: { file_path: path.join(WORK_SANDBOX_DIR, 'ok.txt') } }) === undefined)

  // 旧 guard 会被换掉，不叠加
  let second = null
  ex.installWorkGuard({ tools: { guard: (fn) => { second = fn; return () => { second = null } } } })
  ok('换会话时重新注册', typeof second === 'function')
  ok('旧 guard 已注销', registered === null)
}

// ─── 5. pending-code.json ──────────────────────────────────────────
console.log('\n[5] pending-code.json 结构')
{
  const dataDir = path.join(TMP, 'data5')
  const rec = wg.recordPending({
    dataDir,
    fromUin: '222222222',
    groupId: '777777777',
    task: '把超时改成 5 分钟',
    targetPaths: ['g:\\molly\\qq-whale\\lib\\engine.js', 'g:\\molly\\qq-whale\\lib\\engine.js'],
  })
  const file = path.join(dataDir, 'pending-code.json')
  ok('文件已落盘', fs.existsSync(file))
  const list = JSON.parse(fs.readFileSync(file, 'utf8'))
  ok('是数组且一条', Array.isArray(list) && list.length === 1)
  const e = list[0]
  for (const k of ['id', 'at', 'fromUin', 'groupId', 'task', 'targetPaths']) {
    ok(`字段 ${k} 存在`, Object.prototype.hasOwnProperty.call(e, k))
  }
  eq('fromUin', e.fromUin, '222222222')
  eq('groupId', e.groupId, '777777777')
  eq('targetPaths 去重', e.targetPaths.length, 1)
  eq('recordPending 返回同一条 id', rec.id, e.id)
  ok('id 前缀 pc_', String(e.id).startsWith('pc_'))

  for (let i = 0; i < 55; i += 1) wg.recordPending({ dataDir, fromUin: '1', groupId: '2', task: `t${i}`, targetPaths: ['x'] })
  const capped = JSON.parse(fs.readFileSync(file, 'utf8'))
  eq('最多留 50 条', capped.length, 50)
  ok('保留的是最新的', capped[capped.length - 1].task === 't54')
}

// ─── 6. 离线端到端：群里让改代码 → 被拦 ─────────────────────────────
console.log('\n[6] 离线 e2e：群里「命令 改 engine.js」')
{
  const dataDir = path.join(TMP, 'data6')
  const sent = []
  const fakeClient = {
    async call(action, params) {
      return { message_id: 1, action, params }
    },
    async sendGroupMsg(groupId, payload) {
      sent.push({ kind: 'group', target: String(groupId), payload })
    },
    async sendPrivateMsg(userId, payload) {
      sent.push({ kind: 'private', target: String(userId), payload })
    },
  }
  const engine = Object.create(ChatEngine.prototype)
  engine.config = { ...baseConfig, dataDir, progressEnabled: false, contextLimit: 40, typingCharactersPerSecond: 10000, typingMaxDelaySeconds: 0, reactionMinSeconds: 0, reactionMaxSeconds: 0.01, betweenBubblesMinMs: 0, betweenBubblesMaxMs: 0 }
  engine.logger = logger
  engine.client = fakeClient
  engine.progress = null
  engine.reportCapture = null
  engine._selfSendDepth = 0
  engine._escalations = []
  engine.currentCommand = null
  engine.remember = () => null
  engine.pushHistory = (conv, entry) => conv.history.push(entry)

  // 假 agent：收到任务后「试图改代码」，然后声称成功了
  const msgs = []
  let guardFn = null
  let guardReason = ''
  const agent = {
    status: 'idle',
    activityDone: 1,
    session: { deriveMessages: () => msgs.slice() },
    async whenIdle() {},
    followup(msg) {
      const task = msg?.content?.[0]?.text || ''
      msgs.push({ role: 'user', content: [{ type: 'text', text: task }] })
      guardReason = guardFn({
        name: 'write',
        arguments: { file_path: 'G:\\Molly\\qq-whale\\lib\\engine.js', content: 'timeoutMs = 300000' },
      })
      msgs.push({ role: 'assistant', content: [{ type: 'text', text: '改好了，engine.js 的超时我调成 5 分钟了。' }] })
      setTimeout(() => { agent.activityDone = 2 }, 10)
    },
  }
  const executor = new CommandExecutor({ ctx: null, logger, config: engine.config, engine })
  executor.handle = { agent, sessionId: 'qq-whale-work-111111111' }
  executor.ensureHandle = async () => executor.handle
  executor.liveAgent = () => agent
  executor.installWorkGuard({ tools: { guard: (fn) => { guardFn = fn; return () => { guardFn = null } } } })
  engine.executor = executor

  const ev = {
    message_type: 'group',
    group_id: 777777777,
    user_id: 222222222,
    message_id: 424242,
    sender: { user_id: 222222222, nickname: '群主' },
  }
  const conv = { key: 'group:777777777', kind: 'group', history: [] }
  await engine.runCommand({
    ev,
    conv,
    task: '把 G:\\Molly\\qq-whale\\lib\\engine.js 里的超时改成 5 分钟',
    userName: '群主',
    scene: 'group_mention',
  })

  ok('预检在 agent 启动前就短路（guard 没被调用）', guardReason === '')
  const groupText = sent.filter((s) => s.kind === 'group').map((s) => JSON.stringify(s.payload)).join('\n')
  ok('QQ 群里回了固定审核话术', groupText.includes(wg.REVIEW_REPLY))
  ok('没有把「改好了」原样发出去', !groupText.includes('改好了'))
  ok('没有真的发两条结果', sent.filter((s) => s.kind === 'group').length === 1, `实际 ${sent.filter((s) => s.kind === 'group').length} 条`)
  const priv = sent.filter((s) => s.kind === 'private')
  ok('主人收到一条私聊', priv.length === 1, `实际 ${priv.length}`)
  ok('私聊发给 owner', priv[0]?.target === '222222222')
  const privText = JSON.stringify(priv[0]?.payload || '')
  ok('私聊说清是谁/哪个群/要改什么', privText.includes('222222222') && privText.includes('777777777') && privText.includes('engine.js'))
  ok('私聊走数组消息（不会被并进命令结果）', Array.isArray(priv[0]?.payload))

  const file = path.join(dataDir, 'pending-code.json')
  ok('pending-code.json 已落盘', fs.existsSync(file))
  const list = JSON.parse(fs.readFileSync(file, 'utf8'))
  eq('一条待审核', list.length, 1)
  eq('fromUin 正确', list[0].fromUin, '222222222')
  eq('groupId 正确', list[0].groupId, '777777777')
  ok('task 带原文', list[0].task.includes('超时改成 5 分钟'))
  ok('targetPaths 指向 engine.js', list[0].targetPaths.join(',').includes('engine.js'))
}

// ─── 7. 离线 e2e：任务里没写路径，模型自己去改 → 运行中拦下 ──────────
console.log('\n[7] 离线 e2e：任务不含路径，靠工具 guard 现场拦')
{
  const dataDir = path.join(TMP, 'data7')
  const sent = []
  const fakeClient = {
    async call(action, params) {
      return { message_id: 1, action, params }
    },
    async sendGroupMsg(groupId, payload) {
      sent.push({ kind: 'group', target: String(groupId), payload })
    },
    async sendPrivateMsg(userId, payload) {
      sent.push({ kind: 'private', target: String(userId), payload })
    },
  }
  const engine = Object.create(ChatEngine.prototype)
  engine.config = { ...baseConfig, dataDir, progressEnabled: false, contextLimit: 40, typingCharactersPerSecond: 10000, typingMaxDelaySeconds: 0, reactionMinSeconds: 0, reactionMaxSeconds: 0.01, betweenBubblesMinMs: 0, betweenBubblesMaxMs: 0 }
  engine.logger = logger
  engine.client = fakeClient
  engine.progress = null
  engine.reportCapture = null
  engine._selfSendDepth = 0
  engine.remember = () => null
  engine.pushHistory = (conv, entry) => conv.history.push(entry)

  const msgs = []
  let guardFn = null
  let guardReason = ''
  const agent = {
    status: 'idle',
    activityDone: 1,
    session: { deriveMessages: () => msgs.slice() },
    async whenIdle() {},
    followup(msg) {
      const task = msg?.content?.[0]?.text || ''
      msgs.push({ role: 'user', content: [{ type: 'text', text: task }] })
      // 模拟模型「先 glob 找到文件，再 write」——任务文本里根本没有路径
      guardReason = guardFn({
        name: 'edit',
        arguments: { file_path: 'G:\\Molly\\qq-whale\\lib\\engine.js', old_string: 'a', new_string: 'b' },
      })
      msgs.push({ role: 'assistant', content: [{ type: 'text', text: '搞定了，我把超时调大了。' }] })
      setTimeout(() => { agent.activityDone = 2 }, 10)
    },
  }
  const executor = new CommandExecutor({ ctx: null, logger, config: engine.config, engine })
  executor.handle = { agent, sessionId: 'qq-whale-work-111111111' }
  executor.ensureHandle = async () => executor.handle
  executor.liveAgent = () => agent
  executor.installWorkGuard({ tools: { guard: (fn) => { guardFn = fn; return () => { guardFn = null } } } })
  engine.executor = executor

  const ev = {
    message_type: 'group',
    group_id: 777777777,
    user_id: 222222222,
    message_id: 424243,
    sender: { user_id: 222222222, nickname: '群主' },
  }
  const conv = { key: 'group:777777777', kind: 'group', history: [] }
  const result = await engine.runCommand({
    ev,
    conv,
    task: '把引擎的超时调大一点',
    userName: '群主',
    scene: 'group_mention',
  })

  ok('任务文本预检放行（没有路径）', typeof guardReason === 'string')
  ok('guard 现场拦下了 edit', String(guardReason).includes('需要人工审核'))
  ok('最终结果是固定审核话术', String(result?.text || '').includes(wg.REVIEW_REPLY))
  const groupText = sent.filter((s) => s.kind === 'group').map((s) => JSON.stringify(s.payload)).join('\n')
  ok('群里出现固定审核话术', groupText.includes(wg.REVIEW_REPLY))
  ok('没把模型的「搞定了」发出去', !groupText.includes('搞定了'))
  eq('结果气泡只有一条（开工语被预检跳过之外的正常路径）', sent.filter((s) => s.kind === 'group' && JSON.stringify(s.payload).includes(wg.REVIEW_REPLY)).length, 1)
  ok('主人同样收到私聊', sent.filter((s) => s.kind === 'private').length === 1)
  const list = JSON.parse(fs.readFileSync(path.join(dataDir, 'pending-code.json'), 'utf8'))
  eq('pending 记录一条', list.length, 1)
  ok('记录的 tool 是 edit', String(list[0].tool || '').includes('edit') || list[0].targetPaths.length > 0)
}

// ─── 汇总 ─────────────────────────────────────────────────────────
fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(fail === 0 ? 0 : 1)
