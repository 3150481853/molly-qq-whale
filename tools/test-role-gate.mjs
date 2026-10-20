/**
 * task-43 自测：角色门接进命令路径。
 *
 * 覆盖任务里的 8 条验收：
 *   ① owner 发「命令 重启 DSH」→ 放行
 *   ② adm 发「命令 重启 DSH」→ 被拒 + 固定话术 + denied 记录 +1
 *   ③ adm 发「命令 查明天上海天气」→ 放行
 *   ④ adm 发「命令 打开骂人模式」→ 被拒（persona.manage）
 *   ⑤ guest 发任何命令 → 拒绝（入口就不放行，回归现状）
 *   ⑥ 关键词表 8 条能力各命中一次（防漏词）
 *   ⑦ Gatekeeper.approve 落盘含 by
 *   ⑧ 老记录（无 by）能被读出来，by 当空串
 *
 * 用法：node tools/test-role-gate.mjs
 *      ROLEGATE_LIB_DIR=<安装副本 lib> node tools/test-role-gate.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB_DIR = process.env.ROLEGATE_LIB_DIR || path.join(HERE, '..', 'plugin', 'dsh-qq-whale', 'lib')
const libUrl = (name) => pathToFileURL(path.join(LIB_DIR, name)).href

const { CommandExecutor } = await import(libUrl('commands.js'))
const { ChatEngine } = await import(libUrl('engine.js'))
const { Gatekeeper } = await import(libUrl('gatekeeper.js'))
const {
  ADM_DENY,
  commandIntentOf,
  OWNER_ONLY_SAY,
  OWNER_ONLY_COMMAND_KEYWORDS,
  classifyCommandCapability,
} = await import(libUrl('roles.js'))

const OWNER = '222222222'
const ADM = '333333333'
const GUEST = '123456789'
const GROUP = '777777777'

const TMP = path.join(HERE, '..', 'out', 'test-role-gate-data')

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, extra = '') {
  if (cond) { pass += 1; console.log(`  ✓ ${name}`) }
  else { fail += 1; failures.push(name + (extra ? ` — ${extra}` : '')); console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ''}`) }
}
const eq = (name, a, b) => ok(name, a === b, `期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)

fs.rmSync(TMP, { recursive: true, force: true })

fs.mkdirSync(TMP, { recursive: true })

const config = {
  commandEnabled: true,
  commandPrefixes: ['命令 '],
  commanderUsers: [OWNER, ADM],
  commandGroups: [GROUP],
  ownerUin: OWNER,
  admUins: [ADM],
  dataDir: TMP,
}
const logs = []
const ex = new CommandExecutor({
  ctx: null,
  logger: (lv, msg) => logs.push(`${lv}: ${msg}`),
  config,
  engine: null,
})

const evOwner = { user_id: OWNER, message_type: 'group', group_id: GROUP }
const evAdm = { user_id: ADM, message_type: 'group', group_id: GROUP }
const evGuest = { user_id: GUEST, message_type: 'group', group_id: GROUP }

const deniedFile = path.join(TMP, 'denied-commands.json')
const readDenied = () => {
  try {
    const arr = JSON.parse(fs.readFileSync(deniedFile, 'utf8'))
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function makeEngine(executor) {
  const eng = Object.create(ChatEngine.prototype)
  eng.executor = executor
  eng.config = { ...config, commandConfirmEmoji: 424 }
  eng.logger = (lv, msg) => logs.push(`${lv}: ${msg}`)
  eng.tapEmoji = async () => {}
  eng.sent = []
  eng.sendTextTo = async (_ev, text) => { eng.sent.push(text) }
  return eng
}
const eng = makeEngine(ex)

// ─── 1/3/4. 关键词 → 能力 → 放行/拒绝 ───────────────────────
console.log('\n[1] owner 发「命令 重启 DSH」→ 放行')
{
  ok('owner 关键词命中 dsh.restart', classifyCommandCapability('重启 DSH') === 'dsh.restart', classifyCommandCapability('重启 DSH'))
  const gate = ex.gateCommand('重启 DSH', evOwner)
  eq('owner 放行', gate.ok, true)
  const r = await eng.tryCommand({ ev: evOwner, norm: { text: '命令 重启 DSH' }, userName: '主人' })
  eq('tryCommand handled', r.handled, true)
  eq('没有 refused 标记', Boolean(r.refused), false)
  eq('任务原样下发', r.task, '重启 DSH')
  eq('没有回拒人话术', eng.sent.length, 0)
}

console.log('\n[2] adm 发「命令 重启 DSH」→ 被拒 + 固定话术 + denied +1')
{
  const before = readDenied().length
  const r = await eng.tryCommand({ ev: evAdm, norm: { text: '命令 重启 DSH' }, userName: '管理员' })
  eq('handled=true（消息被接住）', r.handled, true)
  eq('refused=true', r.refused, true)
  eq('cap=dsh.restart', r.cap, 'dsh.restart')
  eq('固定话术', r.reason, OWNER_ONLY_SAY)
  eq('话术就是那一句', OWNER_ONLY_SAY, '这条得主人自己说，我替他做不了。')
  eq('QQ 里回了这句', eng.sent[0], OWNER_ONLY_SAY)
  const after = readDenied()
  eq('denied 记录 +1', after.length, before + 1)
  const last = after[after.length - 1]
  eq('记录 uin', last.uin, ADM)
  eq('记录 role', last.role, 'adm')
  eq('记录 cap', last.cap, 'dsh.restart')
  eq('记录文本', last.text, '重启 DSH')
  ok('记录带时间戳', Number(last.at) > 0)
  ok('有 warn 日志', logs.some((l) => l.startsWith('warn:') && l.includes('越权')), logs.slice(-3).join(' | '))
}

console.log('\n[3] adm 发「命令 查明天上海天气」→ 放行')
{
  const before = readDenied().length
  const gate = ex.gateCommand('查明天上海天气', evAdm)
  eq('无关键词 → 放行', gate.ok, true)
  eq('cap 为空', gate.cap, '')
  const r = await eng.tryCommand({ ev: evAdm, norm: { text: '命令 查明天上海天气' }, userName: '管理员' })
  eq('handled', r.handled, true)
  eq('没有 refused', Boolean(r.refused), false)
  eq('denied 没增加', readDenied().length, before)
}

console.log('\n[4] adm 发「命令 打开骂人模式」→ 被拒（persona.manage）')
{
  eq('关键词命中 persona.manage', classifyCommandCapability('打开骂人模式'), 'persona.manage', classifyCommandCapability('打开骂人模式'))
  const r = await eng.tryCommand({ ev: evAdm, norm: { text: '命令 打开骂人模式' }, userName: '管理员' })
  eq('refused', r.refused, true)
  eq('cap=persona.manage', r.cap, 'persona.manage')
  eq('固定话术', r.reason, OWNER_ONLY_SAY)
}

// ─── 5. guest ────────────────────────────────────────────────
console.log('\n[5] guest 发任何命令 → 拒绝（入口不放行）')
{
  eq('guest 不是 commander', ex.isCommander(GUEST, evGuest), false)
  const r = await eng.tryCommand({ ev: evGuest, norm: { text: '命令 重启 DSH' }, userName: '路人' })
  eq('guest 命令不执行', r.handled, false)
  // 即使绕过入口直接问门，guest 也会被拒（角色认不出来 → 最小权限）
  const gate = ex.gateCommand('重启 DSH', evGuest)
  eq('guest 直接过门也被拒', gate.ok, false)
  eq('guest 话术同样固定', gate.message, OWNER_ONLY_SAY)
}

// ─── 6. 关键词表 8 条 ───────────────────────────────────────
console.log('\n[6] 关键词表：8 条 owner 独占能力各命中一次')
{
  eq('表有 8 行', OWNER_ONLY_COMMAND_KEYWORDS.length, 8)
  eq('ADM_DENY 也是 8 条', ADM_DENY.length, 8)
  const tableCaps = new Set(OWNER_ONLY_COMMAND_KEYWORDS.map((r) => r.cap))
  const denyCaps = new Set(ADM_DENY.map((d) => d.cap))
  eq('表与 ADM_DENY 的 cap 集合一致', [...tableCaps].sort().join(','), [...denyCaps].sort().join(','))
  for (const row of OWNER_ONLY_COMMAND_KEYWORDS) {
    ok(`${row.cap} 有关键词`, Array.isArray(row.keywords) && row.keywords.length > 0)
    const hit = row.keywords.map((k) => classifyCommandCapability(k)).filter((c) => c === row.cap)
    ok(`${row.cap} 至少一个关键词能命中自己`, hit.length > 0, JSON.stringify(row.keywords))
  }
  eq('匹配不上 → 空串（默认放行）', classifyCommandCapability('今天天气怎么样'), '')
  eq('空文本 → 空串', classifyCommandCapability(''), '')
}

// ─── 7/8. Gatekeeper by ─────────────────────────────────────
console.log('\n[7] Gatekeeper.approve 落盘含 by')
{
  const dir = path.join(TMP, 'gk1')
  fs.mkdirSync(dir, { recursive: true })
  const gk = new Gatekeeper({ dir, logger: () => {}, owners: [OWNER] })
  gk.pending.set('888888888', { name: '小王', at: Date.now(), kind: 'chat' })
  gk.approve('888888888', Date.now(), OWNER)
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'gatekeeper.json'), 'utf8'))
  eq('落盘 approved.by', onDisk.approved['888888888'].by, OWNER)
  eq('落盘仍带 name', onDisk.approved['888888888'].name, '小王')
  eq('state 里也带 by', gk.snapshot().approved[0].by, OWNER)
}

console.log('\n[8] 老记录（无 by）读出来 by 为空串，不崩')
{
  const dir = path.join(TMP, 'gk-old')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'gatekeeper.json'),
    JSON.stringify({ pending: {}, approved: { '999': { name: '老记录', at: 1700000000000 } }, denied: {} }, null, 2),
    'utf8',
  )
  let threw = false
  let gk = null
  try { gk = new Gatekeeper({ dir, logger: () => {}, owners: [OWNER] }) } catch { threw = true }
  eq('读旧记录不崩', threw, false)
  eq('by 补空串', gk.snapshot().approved[0].by, '')
  eq('旧 name 保留', gk.snapshot().approved[0].name, '老记录')
  eq('isApproved 仍为 true', gk.isApproved('999'), true)
}


// ─── 9. 只读不能被误伤（task-43 补丁）────────────────────
console.log('\n[9] 只读请求放行 / 变更与含糊拦下（六条探针）')
{
  const probes = [
    { text: '查一下今天预算还剩多少', cap: 'budget.manage', deny: false },
    { text: '现在人设是什么', cap: 'persona.manage', deny: false },
    { text: '念一下你自己的白名单', cap: 'allowlist.manage', deny: false },
    { text: '帮我把预算改成 800', cap: 'budget.manage', deny: true },
    { text: '查一下预算然后改成 800', cap: 'budget.manage', deny: true },
    { text: '预算', cap: 'budget.manage', deny: true },
  ]
  for (const p of probes) {
    const intent = commandIntentOf(p.text)
    const before = readDenied().length
    const r = ex.gateCommand(p.text, evAdm)
    const mark = r.ok ? '放行' : '拒绝'
    console.log(
      '  probe: ' + p.text + ' → cap=' + (intent.cap || '(空)') + ' intent=' + intent.intent + ' allow=' + intent.allow + ' → ' + mark,
    )
    eq('「' + p.text + '」cap', intent.cap, p.cap)
    eq('「' + p.text + '」adm ' + (p.deny ? '被拒' : '放行'), r.ok, !p.deny)
    if (p.deny) {
      eq('「' + p.text + '」话术固定', r.message, OWNER_ONLY_SAY)
      eq('「' + p.text + '」denied +1', readDenied().length, before + 1)
    } else {
      eq('「' + p.text + '」denied 不增', readDenied().length, before)
    }
    const ro = ex.gateCommand(p.text, evOwner)
    eq('「' + p.text + '」owner 放行', ro.ok, true)
  }
  // 只读放行必须过「至少 adm」：guest 不能借只读混进来
  const guestRead = ex.gateCommand('查一下今天预算还剩多少', evGuest)
  eq('guest 只读也不放行（纵深防御）', guestRead.ok, false)
}

fs.rmSync(TMP, { recursive: true, force: true })

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(fail === 0 ? 0 : 1)
