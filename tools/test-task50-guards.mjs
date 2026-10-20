/**
 * task-50 自测：工具死循环闸门 + HTTP 出口清洗 + worker 人设边界。
 *
 * 钉四件事（对应任务里的 4 条验收）：
 *   ① 同一工具同一参数连续 3 次 → 拦下并纠偏；第 4 次 → 收口（取消本轮，
 *      _runOnce 回人话，不伪造成功返回值）
 *   ② 不同参数、或中间夹了别的调用 → 不算重复
 *   ③ POST /work/run 的 text 不含 `<acp` / 裸 mNNNNN
 *   ④ worker 人设写明「work 会话没有写工具，建文件要走 code」+ 死循环禁令 + 标记禁令
 *
 * 用法：node tools/test-task50-guards.mjs
 *      T50_LIB_DIR=<安装副本 lib> node tools/test-task50-guards.mjs
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB_DIR = process.env.T50_LIB_DIR || path.join(HERE, '..', 'plugin', 'dsh-qq-whale', 'lib')
const libUrl = (name) => pathToFileURL(path.join(LIB_DIR, name)).href

const {
  CommandExecutor,
  LOOP_ABORT_REPLY,
  LOOP_WARN_AT,
  LOOP_ABORT_AT,
} = await import(libUrl('commands.js'))
const { WebWidget } = await import(libUrl('web.js'))

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}
const eq = (name, a, b) => ok(name, a === b, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)
const logger = () => {}

const WORKDIR_EXEC = { name: 'working_directory', arguments: { path: 'G:\\Molly\\sandbox' } }

// ─── 1. 死循环闸门 ─────────────────────────────────────────────
console.log('\n[1] 同一工具同一参数：3 次拦、4 次收口')
{
  const ex = new CommandExecutor({ ctx: null, logger, config: { selfId: '1' }, engine: null })
  const cancelled = []
  const agent = { cancel: (why) => cancelled.push(why?.reason || why) }
  const exec = { ...WORKDIR_EXEC, agent }

  eq('第 1 次放行', ex.checkToolLoop(exec), null)
  eq('第 2 次放行', ex.checkToolLoop(exec), null)
  const r3 = ex.checkToolLoop(exec)
  ok('第 3 次被拦（返回纠偏文案）', typeof r3 === 'string' && r3.length > 0, String(r3))
  ok('纠偏文案点名工具和次数', /working_directory/.test(String(r3)) && /3 次/.test(String(r3)), String(r3))
  ok('纠偏文案要求换办法或说做不到', /换一条完全不同的办法|走不通/.test(String(r3)), String(r3))
  eq('第 3 次还没收口', ex._loopTripped, false)

  const r4 = ex.checkToolLoop(exec)
  ok('第 4 次继续拦', typeof r4 === 'string' && r4.length > 0)
  eq('第 4 次触发收口标记', ex._loopTripped, true)
  await new Promise((r) => setTimeout(r, 20))
  eq('第 4 次调用 agent.cancel（收口）', cancelled.length, 1)
  ok('cancel 原因写明死循环', /死循环/.test(String(cancelled[0])), String(cancelled[0]))
  eq('阈值常量', `${LOOP_WARN_AT}/${LOOP_ABORT_AT}`, '3/4')
}

console.log('\n[2] 不同参数 / 中间夹别的调用 → 不算重复')
{
  const ex = new CommandExecutor({ ctx: null, logger, config: { selfId: '1' }, engine: null })
  ex.resetLoopGuard()
  const a = { name: 'working_directory', arguments: { path: 'G:\\Molly\\sandbox' } }
  const b = { name: 'working_directory', arguments: { path: 'G:\\Molly\\sandbox\\qq-work' } }
  eq('A 放行', ex.checkToolLoop(a), null)
  eq('B 放行（不同参数）', ex.checkToolLoop(b), null)
  eq('A 放行（不是连续第 3 次）', ex.checkToolLoop(a), null)
  eq('B 放行', ex.checkToolLoop(b), null)
  eq('A 放行', ex.checkToolLoop(a), null)
  eq('B 放行', ex.checkToolLoop(b), null)
  eq('交替调用始终不触发', ex._loopTripped, false)

  // 真正连续 3 次同一个 → 拦
  ex.checkToolLoop(a)
  ex.checkToolLoop(a)
  const r = ex.checkToolLoop(a)
  ok('连续 3 次同一调用 → 拦', typeof r === 'string' && r.length > 0, String(r))

  // 别的工具打断之后重新计数
  ex.resetLoopGuard()
  ex.checkToolLoop(a)
  ex.checkToolLoop(a)
  eq('被别的工具打断 → 归零', ex.checkToolLoop({ name: 'read', arguments: { path: 'x' } }), null)
  eq('之后 A 重新从 1 开始', ex.checkToolLoop(a), null)
}

console.log('\n[3] 参数键顺序无关（同一次调用的另一种写法也算同一个）')
{
  const ex = new CommandExecutor({ ctx: null, logger, config: { selfId: '1' }, engine: null })
  ex.resetLoopGuard()
  const e1 = { name: 't', arguments: { a: 1, b: 2 } }
  const e2 = { name: 't', arguments: { b: 2, a: 1 } }
  eq('第一次', ex.checkToolLoop(e1), null)
  eq('第二次（键顺序不同）', ex.checkToolLoop(e2), null)
  ok('第三次（键顺序不同）被拦', typeof ex.checkToolLoop(e1) === 'string')
}

// ─── 4. _runOnce 收口话术 ─────────────────────────────────────
console.log('\n[4] 触发收口后，_runOnce 回一句人话（不采用模型废话）')
{
  let ex2 = null
  const msgs = []
  const agent = {
    status: 'idle',
    activityDone: 0,
    async cancel() {},
    followup(msg) {
      agent.activityDone += 1
      const text = (msg?.content || []).map((b) => b?.text || '').join('')
      msgs.push({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
      msgs.push({ role: 'assistant', content: [{ type: 'text', text: '抱歉，我意识到我一直在重复相同的操作。' }] })
      // 模拟 guard 在第 4 次重复时触发收口
      ex2._loopTripped = true
    },
    async whenIdle() {},
    session: { deriveMessages: () => msgs.slice() },
  }
  ex2 = new CommandExecutor({ ctx: null, logger, config: { selfId: '1', workTurnTimeoutMs: 5000 }, engine: null })
  ex2.handle = { agent, sessionId: 'qq-whale-work-v2-1' }
  ex2.ensureHandle = async () => ex2.handle
  ex2.liveAgent = () => agent
  const result = await ex2._runOnce('在 G:\\Molly\\sandbox 下建一个 test1 文件夹')
  eq('返回收口话术', result.text, LOOP_ABORT_REPLY)
  eq('ok=false', result.ok, false)
  eq('标记 loopAborted', result.loopAborted, true)
  ok('不再是模型的「抱歉我重复了」', !String(result.text).includes('抱歉'))
  ok('话术里给出路（换说法/拆小）', /换个说法|拆小一点/.test(result.text))
}

// ─── 5. /work/run 出口清洗 ───────────────────────────────────
console.log('\n[5] POST /work/run 的 text 不含 <acp 标记')
{
  const routes = new Map()
  const webServer = {
    register(route) {
      routes.set(route.path, route)
      return () => routes.delete(route.path)
    },
  }
  const dirty =
    '<acp tokens="65" type="text">m00085</acp>\n沙箱自检通过。当前工作目录为 G:\\Molly\\sandbox\\qq-work。'
  const engine = {
    executor: {
      async run() {
        return { ok: true, text: dirty }
      },
    },
  }
  const widget = new WebWidget({
    logger,
    config: { enabled: true, selfId: '1', commanderUsers: ['222222222'] },
    state: {},
    engineRef: () => engine,
    recheck: async () => ({}),
    refreshLogin: async () => ({}),
  })
  widget.register({ webServer })

  async function callRoute(urlPath, body) {
    const route = routes.get(urlPath)
    if (!route) throw new Error('路由没注册：' + urlPath)
    const payload = JSON.stringify(body)
    const req = Readable.from([Buffer.from(payload, 'utf8')])
    req.method = 'POST'
    req.url = urlPath
    req.headers = { host: '127.0.0.1:7053', 'sec-fetch-site': 'same-origin' }
    const res = {
      status: 0,
      headers: {},
      body: '',
      writeHead(code, headers) { this.status = code; this.headers = headers || {} },
      end(b) { this.body = b || '' },
    }
    await route.handler(req, res)
    return { status: res.status, json: JSON.parse(res.body || '{}') }
  }

  const r = await callRoute('/dsh-qq-whale/work/run', { task: '只说一句：沙箱自检通过' })
  eq('HTTP 200', r.status, 200)
  eq('ok=true', r.json.ok, true)
  ok('text 不含 <acp', !String(r.json.text).includes('<acp'), String(r.json.text))
  ok('text 不含裸 m00085', !/m00085/.test(String(r.json.text)), String(r.json.text))
  ok('text 保留正文', String(r.json.text).includes('沙箱自检通过'), String(r.json.text))
  ok('响应整体（含 error/events）不含 <acp', !JSON.stringify(r.json).includes('<acp'))
}

// ─── 6. worker 人设 ─────────────────────────────────────────
console.log('\n[6] worker 人设：work 无写工具要说清 + 死循环禁令 + 标记禁令')
{
  const capture = (role) => {
    const ex = new CommandExecutor({ ctx: null, logger, config: { selfId: '1' }, engine: null, role })
    const texts = []
    const setup = ex.workerSetup(role)
    setup(
      {
        systemPrompt: { section: (s) => texts.push(String(s?.text || '')) },
        tools: { restrict() {}, guard() { return () => {} } },
      },
      { ctx: { tools: { restrict() {}, guard() { return () => {} } } } },
    )
    return texts.join('\n')
  }
  const work = capture('work')
  const code = capture('code')

  ok('work 人设写明没有写工具', /没有\*\* write \/ edit \/ apply_patch|没有\*\* write/.test(work), '')
  ok('work 人设给出 #code 出路', /#code/.test(work))
  ok('work 人设点名 test1 例子', /test1/.test(work))
  ok('work 人设禁止反复试探 working_directory', /working_directory/.test(work) && /不要试探工具/.test(work))
  ok('两边都有死循环禁令', /同一个工具、同样的参数/.test(work) && /同一个工具、同样的参数/.test(code))
  ok('两边都有 ACP 标记禁令', /<acp/.test(work) && /<acp/.test(code))
  ok('code 人设强调写盘本职 + 审核', /写文件是本会话的本职/.test(code) && /审核/.test(code))
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(fail === 0 ? 0 : 1)
