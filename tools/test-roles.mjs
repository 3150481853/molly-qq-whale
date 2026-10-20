/**
 * 三级角色（owner / adm / guest）测试 —— task-38 前半（用户 m25316，2026-10-19）。
 *
 * 需求来源：333333333 通过主人转达了一串要求，主人的处置是
 * 「给他一个 adm 权限（管理员，权限低于 owner）」。adm 能用工坊、能下指令、
 * 能收执行结果；但**明确不许**碰：白名单/审批人、主人记忆、预算、persona、
 * 往线上装插件、杀 QQ/NapCat、重启 DSH、改 yml。
 *
 * 这个测试要证明的东西分三层，**不许只测角色字符串**：
 *   A. 判定本身：owner / adm / guest，owner 优先，逗号串解析，去重。
 *   B. 接缝真跑：拿真的 CommandExecutor 实例，调 requireRole / requireCapability，
 *      看它到底放不放行 —— 不是拿断言比字符串常量。
 *   C. 话术：越权提示必须是正常人话，**不许出现「权限不足」这类机器词**
 *      （用户明确要求）。这一层用反向断言守住：出现一个机器词就红。
 *
 * 跑法：node tools\test-roles.mjs   （全绿 exit=0）
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

import {
  ADM_DENY,
  CAP,
  CAP_RULES,
  ROLE_ADM,
  ROLE_GUEST,
  ROLE_OWNER,
  ROLE_RANK,
  checkCapability,
  checkRole,
  createRoleGate,
  normalizeRole,
  normalizeUins,
  roleConfig,
} from '../plugin/dsh-qq-whale/lib/roles.js'
import { CommandExecutor } from '../plugin/dsh-qq-whale/lib/commands.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROLES_SRC = path.join(HERE, '..', 'plugin', 'dsh-qq-whale', 'lib', 'roles.js')

let pass = 0
const fails = []

function t(name, fn) {
  try {
    fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fails.push({ name, msg: e && e.message })
    console.log('  FAIL ' + name + '\n       ' + (e && e.message))
  }
}

const has = (s, sub, name) => assert.ok(String(s).includes(sub), (name || '') + ' 缺少: ' + sub)
const notHas = (s, sub, name) => assert.ok(!String(s).includes(sub), (name || '') + ' 不应包含: ' + sub)

/* 真实号码（跟 cordis.patch.yml 里一致，别用假的把 bug 藏起来） */
const OWNER = '222222222'
const ADM = '333333333'
const STRANGER = '1000000001'

/** 这台机器上的真实配置形状 */
const REAL = { ownerUin: OWNER, admUins: [ADM], allowedUsers: [ADM, OWNER] }

/** 造一个能真跑守卫的 CommandExecutor（ctx/engine 都不需要，守卫不碰它们） */
function makeExecutor(config) {
  const logs = []
  const ex = new CommandExecutor({
    ctx: {},
    logger: (level, msg) => logs.push(`${level}: ${msg}`),
    config: config || REAL,
    engine: {},
  })
  return { ex, logs }
}

/** 机器词黑名单：这些词一旦出现在给用户的话里就算失败 */
const ROBOT_WORDS = ['权限不足', '无权限', '没有权限', 'forbidden', 'Forbidden', 'unauthorized', 'Unauthorized', '403', '禁止访问', 'Access denied', 'access denied']

function assertHuman(msg, where) {
  const s = String(msg || '')
  assert.ok(s.trim().length > 0, (where || '') + ' 提示语不能是空串')
  for (const w of ROBOT_WORDS) {
    assert.ok(!s.includes(w), `${where || ''} 出现了机器词「${w}」：${s}`)
  }
  // 人话的标志：至少得有一句完整的中文，别是 'ERR_PERMISSION' 这种
  assert.ok(/[\u4e00-\u9fa5]/.test(s), (where || '') + ' 提示语必须是中文人话：' + s)
}

// ══════════════════════════════════════════════════════════════════
console.log('A. 角色判定')
// ══════════════════════════════════════════════════════════════════

t('A01 主人 → owner', () => {
  const g = createRoleGate(REAL)
  assert.equal(g.roleOf(OWNER), ROLE_OWNER)
  assert.equal(g.isOwner(OWNER), true)
  assert.equal(g.isAdm(OWNER), false, '主人不该同时被判成 adm')
  assert.equal(g.isGuest(OWNER), false)
})

t('A02 管理员 → adm', () => {
  const g = createRoleGate(REAL)
  assert.equal(g.roleOf(ADM), ROLE_ADM)
  assert.equal(g.isAdm(ADM), true)
  assert.equal(g.isOwner(ADM), false, 'adm 绝不能判成 owner')
  assert.equal(g.isGuest(ADM), false)
})

t('A03 陌生人 → guest', () => {
  const g = createRoleGate(REAL)
  assert.equal(g.roleOf(STRANGER), ROLE_GUEST)
  assert.equal(g.isGuest(STRANGER), true)
  assert.equal(g.isOwner(STRANGER), false)
  assert.equal(g.isAdm(STRANGER), false)
})

t('A04 空值 / null / undefined / 空串 → guest（宁可少给权）', () => {
  const g = createRoleGate(REAL)
  for (const v of ['', '   ', null, undefined]) {
    assert.equal(g.roleOf(v), ROLE_GUEST, `输入 ${JSON.stringify(v)} 应判 guest`)
  }
})

t('A05 数字型 QQ 号与字符串型等价（消息里两种都出现过）', () => {
  const g = createRoleGate(REAL)
  assert.equal(g.roleOf(Number(ADM)), ROLE_ADM)
  assert.equal(g.roleOf(Number(OWNER)), ROLE_OWNER)
  assert.equal(g.roleOf(String(ADM)), ROLE_ADM)
})

t('A06 首位 0 / 尾随空格不误伤（trim 过再比）', () => {
  const g = createRoleGate(REAL)
  assert.equal(g.roleOf('  ' + ADM + '  '), ROLE_ADM)
})

t('A07 rankOf 反映真实高低：owner > adm > guest', () => {
  const g = createRoleGate(REAL)
  assert.equal(g.rankOf(OWNER), 3)
  assert.equal(g.rankOf(ADM), 2)
  assert.equal(g.rankOf(STRANGER), 1)
  assert.ok(g.rankOf(OWNER) > g.rankOf(ADM))
  assert.ok(g.rankOf(ADM) > g.rankOf(STRANGER))
})

t('A08 normalizeRole 认大小写、认空白，认不出的当 guest', () => {
  assert.equal(normalizeRole('OWNER'), ROLE_OWNER)
  assert.equal(normalizeRole('  Adm '), ROLE_ADM)
  assert.equal(normalizeRole('guest'), ROLE_GUEST)
  assert.equal(normalizeRole('root'), ROLE_GUEST, 'root 不是我们的角色，要降成 guest 而不是放行')
  assert.equal(normalizeRole(''), ROLE_GUEST)
  assert.equal(normalizeRole(null), ROLE_GUEST)
})

t('A09 ROLE_RANK 三个角色都在，且没有漏项', () => {
  assert.deepEqual(Object.keys(ROLE_RANK).sort(), [ROLE_ADM, ROLE_GUEST, ROLE_OWNER].sort())
})

// ══════════════════════════════════════════════════════════════════
console.log('\nB. owner 优先 + 名单解析（数组 / 逗号串 / 去重）')
// ══════════════════════════════════════════════════════════════════

t('B01 owner 优先：主人的号同时写进 admUins，仍然是 owner', () => {
  const g = createRoleGate({ ownerUin: OWNER, admUins: [ADM, OWNER] })
  assert.equal(g.roleOf(OWNER), ROLE_OWNER, '同号两处都有 → owner（不能因为命中 adm 表就降级）')
  assert.equal(g.roleOf(ADM), ROLE_ADM)
  // admUins 里应该已经把主人剔掉，否则报告里的名单会重复列出主人
  assert.ok(!g.admUins.includes(OWNER), 'admUins 应剔除主人号，实际: ' + JSON.stringify(g.admUins))
})

t('B02 admUins 支持数组', () => {
  const g = createRoleGate({ ownerUin: OWNER, admUins: [ADM, '123456'] })
  assert.equal(g.admUins.length, 2)
  assert.equal(g.roleOf('123456'), ROLE_ADM)
})

t('B03 admUins 支持英文逗号串（用户在 yml 里手敲最常见的写法）', () => {
  const g = createRoleGate({ ownerUin: OWNER, admUins: `${ADM},123456` })
  assert.equal(g.roleOf(ADM), ROLE_ADM)
  assert.equal(g.roleOf('123456'), ROLE_ADM)
  assert.equal(g.admUins.length, 2)
})

t('B04 admUins 支持中文逗号 / 顿号 / 分号 / 空白（复制粘贴混进全角符号很常见）', () => {
  const g = createRoleGate({ ownerUin: OWNER, admUins: `${ADM}，123456、654321;777777 888888` })
  for (const u of [ADM, '123456', '654321', '777777', '888888']) {
    assert.equal(g.roleOf(u), ROLE_ADM, `${u} 应被判 adm，实际 ${g.roleOf(u)}`)
  }
  assert.equal(g.admUins.length, 5)
})

t('B05 名单去重（同一个人配两遍不该出现两次）', () => {
  const g = createRoleGate({ ownerUin: OWNER, admUins: [ADM, ADM, ' ' + ADM + ' '] })
  assert.equal(g.admUins.length, 1, '实际: ' + JSON.stringify(g.admUins))
})

t('B06 normalizeUins 丢掉空项和纯空白项', () => {
  assert.deepEqual(normalizeUins([ADM, '', '  ', null, '123456']), [ADM, '123456'])
  assert.deepEqual(normalizeUins(''), [])
  assert.deepEqual(normalizeUins(null), [])
  assert.deepEqual(normalizeUins(undefined), [])
})

t('B07 admUins 空 / 缺省 → 没有任何 adm（默认值由 main.js 的 DEFAULTS 提供）', () => {
  const g = createRoleGate({ ownerUin: OWNER })
  assert.deepEqual(g.admUins, [])
  assert.equal(g.roleOf(ADM), ROLE_GUEST, '没配 admUins 时 333333333 应是 guest')
})

t('B08 ownerUin 缺省时退化用 allowedUsers[0]（老配置兼容）', () => {
  const g = createRoleGate({ allowedUsers: ['999999'], admUins: [ADM] })
  assert.equal(g.ownerUin, '999999')
  assert.equal(g.roleOf('999999'), ROLE_OWNER)
})

t('B09 roleConfig 返回 owners / admUins / roles 三件套', () => {
  const rc = roleConfig(REAL)
  assert.deepEqual(rc.owners, [OWNER])
  assert.deepEqual(rc.admUins, [ADM])
  assert.deepEqual(rc.roles, { [OWNER]: ROLE_OWNER, [ADM]: ROLE_ADM })
  assert.equal(rc.roles[STRANGER], undefined, '客人不该出现在映射表里')
})

t('B10 roleConfig 在 owner 缺省时 owners 是空数组而不是 [""]', () => {
  const rc = roleConfig({})
  assert.deepEqual(rc.owners, [])
  assert.deepEqual(rc.roles, {})
})

// ══════════════════════════════════════════════════════════════════
console.log('\nC. 能力表：adm 的越权清单必须逐条都在')
// ══════════════════════════════════════════════════════════════════

/* 用户明确点名的八条禁令，一条都不许漏 */
const REQUIRED_DENY = [
  [CAP.ALLOWLIST_MANAGE, '改白名单/审批人'],
  [CAP.MEMORY_OWNER_WRITE, '改主人记忆'],
  [CAP.BUDGET_MANAGE, '改预算'],
  [CAP.PERSONA_MANAGE, '改 persona'],
  [CAP.PLUGIN_INSTALL, '装插件到线上'],
  [CAP.PROCESS_KILL, '杀 QQ/NapCat'],
  [CAP.DSH_RESTART, '重启 DSH'],
  [CAP.CONFIG_YML, '改 yml'],
]

t('C01 ADM_DENY 覆盖用户点名的八条，一条不少', () => {
  const caps = ADM_DENY.map((r) => r.cap)
  for (const [cap, label] of REQUIRED_DENY) {
    assert.ok(caps.includes(cap), `越权清单漏了「${label}」(${cap})`)
  }
  assert.ok(ADM_DENY.length >= 8, `越权清单至少 8 条，实际 ${ADM_DENY.length}`)
})

t('C02 ADM_DENY 每条都带 label（报告要能直接列清单）', () => {
  for (const r of ADM_DENY) {
    assert.ok(r.cap && typeof r.cap === 'string')
    assert.ok(r.label && typeof r.label === 'string' && r.label.length > 0, `${r.cap} 缺 label`)
  }
})

t('C03 ADM_DENY 与 CAP_RULES 里 min=owner 的条目一致（不许两套名单漂移）', () => {
  const fromRules = CAP_RULES.filter((r) => r.min === ROLE_OWNER).map((r) => r.cap).sort()
  const fromDeny = ADM_DENY.map((r) => r.cap).sort()
  assert.deepEqual(fromDeny, fromRules)
})

t('C04 adm 明确**能**干的：工坊 / 下指令 / 收结果', () => {
  for (const cap of [CAP.WORKSHOP_USE, CAP.COMMAND_RUN, CAP.COMMAND_RESULT]) {
    const r = checkCapability(ROLE_ADM, cap)
    assert.equal(r.ok, true, `adm 应该能「${cap}」，实际被拒：${r.message}`)
  }
  // 这三条必须不在越权清单里，别自己把自己坑了
  const caps = ADM_DENY.map((x) => x.cap)
  for (const cap of [CAP.WORKSHOP_USE, CAP.COMMAND_RUN, CAP.COMMAND_RESULT]) {
    assert.ok(!caps.includes(cap), `${cap} 不该出现在 adm 越权清单里`)
  }
})

t('C05 guest 连 adm 级能力都没有', () => {
  const r = checkCapability(ROLE_GUEST, CAP.WORKSHOP_USE)
  assert.equal(r.ok, false)
  assertHuman(r.message, 'C05')
})

t('C06 owner 全部能力都通（包括那八条）', () => {
  for (const [cap, label] of REQUIRED_DENY) {
    const r = checkCapability(ROLE_OWNER, cap)
    assert.equal(r.ok, true, `主人应该能「${label}」，实际被拒`)
  }
  for (const cap of [CAP.WORKSHOP_USE, CAP.COMMAND_RUN, CAP.COMMAND_RESULT]) {
    assert.equal(checkCapability(ROLE_OWNER, cap).ok, true)
  }
})

t('C07 未登记的能力一律按 owner 处理（新增能力必须显式写 min）', () => {
  for (const role of [ROLE_GUEST, ROLE_ADM]) {
    const r = checkCapability(role, 'some.future.cap')
    assert.equal(r.ok, false, `${role} 不该能跑未登记能力`)
    assert.equal(r.need, ROLE_OWNER)
    assertHuman(r.message, 'C07 ' + role)
  }
  assert.equal(checkCapability(ROLE_OWNER, 'some.future.cap').ok, true)
})

// ══════════════════════════════════════════════════════════════════
console.log('\nD. 接缝真跑：拿真的 CommandExecutor 调守卫')
// ══════════════════════════════════════════════════════════════════

t('D01 CommandExecutor 构造时就算好角色门（不用等第一次调用）', () => {
  const { ex } = makeExecutor(REAL)
  assert.ok(ex.roleGate, '没建 roleGate')
  assert.equal(ex.roleOf(OWNER), ROLE_OWNER)
  assert.equal(ex.roleOf(ADM), ROLE_ADM)
  assert.equal(ex.roleOf(STRANGER), ROLE_GUEST)
})

t('D02 adm 越权清单逐条被**真入口**拒掉（八条，一条一条跑）', () => {
  const { ex, logs } = makeExecutor(REAL)
  for (const [cap, label] of REQUIRED_DENY) {
    const r = ex.requireCapability(cap, { user_id: ADM })
    assert.equal(r.ok, false, `adm 竟然能「${label}」(${cap}) —— 这是安全漏洞`)
    assert.equal(r.role, ROLE_ADM)
    assert.equal(r.need, ROLE_OWNER)
    assertHuman(r.message, `D02 ${label}`)
  }
  // 八条都该留下审计日志（出事能查是谁试的）
  const denyLogs = logs.filter((l) => l.includes('拦下一次越权'))
  assert.equal(denyLogs.length, REQUIRED_DENY.length, `应记 ${REQUIRED_DENY.length} 条越权日志，实际 ${denyLogs.length}`)
})

t('D03 同一份清单，主人全部放行（对照实验：证明拒的是角色不是能力）', () => {
  const { ex } = makeExecutor(REAL)
  for (const [cap, label] of REQUIRED_DENY) {
    const r = ex.requireCapability(cap, { user_id: OWNER })
    assert.equal(r.ok, true, `主人竟然不能「${label}」—— 把权限写反了`)
    assert.equal(r.message, '')
  }
})

t('D04 陌生人碰主人的活 → 被拒，且话术是人话', () => {
  const { ex } = makeExecutor(REAL)
  const r = ex.requireCapability(CAP.BUDGET_MANAGE, { user_id: STRANGER })
  assert.equal(r.ok, false)
  assertHuman(r.message, 'D04')
})

t('D05 adm 能进工坊（requireCapability 放行）', () => {
  const { ex } = makeExecutor(REAL)
  assert.equal(ex.requireCapability(CAP.WORKSHOP_USE, { user_id: ADM }).ok, true)
})

t('D06 adm 能下指令（requireRole("adm") 放行）', () => {
  const { ex } = makeExecutor(REAL)
  const r = ex.requireRole(ROLE_ADM, { user_id: ADM })
  assert.equal(r.ok, true)
  assert.equal(r.message, '')
})

t('D07 adm 不能干主人的活（requireRole("owner") 拒绝 + 人话）', () => {
  const { ex } = makeExecutor(REAL)
  const r = ex.requireRole(ROLE_OWNER, { user_id: ADM })
  assert.equal(r.ok, false)
  assertHuman(r.message, 'D07')
})

t('D08 guest 不能下指令（requireRole("adm") 拒绝）', () => {
  const { ex } = makeExecutor(REAL)
  const r = ex.requireRole(ROLE_ADM, { user_id: STRANGER })
  assert.equal(r.ok, false)
  assertHuman(r.message, 'D08')
})

t('D09 owner 两个档位都过', () => {
  const { ex } = makeExecutor(REAL)
  assert.equal(ex.requireRole(ROLE_ADM, { user_id: OWNER }).ok, true)
  assert.equal(ex.requireRole(ROLE_OWNER, { user_id: OWNER }).ok, true)
  assert.equal(ex.requireRole(ROLE_GUEST, { user_id: OWNER }).ok, true)
})

t('D10 拿不到发送人的消息一律当 guest（判不清身份时放行才是真漏洞）', () => {
  const { ex } = makeExecutor(REAL)
  for (const ev of [undefined, null, {}, { user_id: '' }, { user_id: null }]) {
    assert.equal(ex.requireRole(ROLE_ADM, ev).ok, false, `${JSON.stringify(ev)} 竟被放行`)
    assert.equal(ex.requireCapability(CAP.WORKSHOP_USE, ev).ok, false)
  }
})

t('D11 ev 里给 userId（驼峰）也认，不认就静默降权', () => {
  const { ex } = makeExecutor(REAL)
  assert.equal(ex.requireRole(ROLE_ADM, { userId: ADM }).ok, true)
  assert.equal(ex.requireRole(ROLE_ADM, { userId: OWNER }).ok, true)
})

t('D12 ex.admDeny 与 roles.ADM_DENY 是同一份（命令层和工具层看到的是同一清单）', () => {
  const { ex } = makeExecutor(REAL)
  assert.deepEqual(
    ex.admDeny.map((r) => r.cap).sort(),
    ADM_DENY.map((r) => r.cap).sort(),
  )
})

t('D13 配置换了角色门跟着换（不是写死 333333333）', () => {
  // 换个 adm：333333333 应该降回 guest，新号才是 adm
  const { ex } = makeExecutor({ ownerUin: OWNER, admUins: ['555555'] })
  assert.equal(ex.roleOf(ADM), ROLE_GUEST, '333333333 不在名单里就该是 guest')
  assert.equal(ex.roleOf('555555'), ROLE_ADM)
  assert.equal(ex.requireCapability(CAP.WORKSHOP_USE, { user_id: ADM }).ok, false)
  assert.equal(ex.requireCapability(CAP.WORKSHOP_USE, { user_id: '555555' }).ok, true)
})

t('D14 配置文件里主人号也塞进 admUins 时，主人仍是 owner（接缝这层也守住）', () => {
  const { ex } = makeExecutor({ ownerUin: OWNER, admUins: [OWNER, ADM] })
  assert.equal(ex.roleOf(OWNER), ROLE_OWNER)
  // 主人对「只有主人能做」的能力必须放行 —— 要是被降成 adm 这条会红
  assert.equal(ex.requireCapability(CAP.CONFIG_YML, { user_id: OWNER }).ok, true)
})

// ══════════════════════════════════════════════════════════════════
console.log('\nE. 话术：必须是正常人话，不许出现机器词')
// ══════════════════════════════════════════════════════════════════

t('E01 adm 撞主人的八条禁令，提示语逐条都是人话', () => {
  for (const [cap, label] of REQUIRED_DENY) {
    const r = checkCapability(ROLE_ADM, cap)
    assertHuman(r.message, `E01 ${label}`)
    // 人话的标志之二：得说清楚「这个我替你拦下了」这类态度，而不是甩个错误码
    assert.ok(/拦下|不能|只有|别/.test(r.message), `${label} 的话术太生硬：${r.message}`)
  }
})

t('E02 guest 撞 adm 能力 → 让他去找主人或管理员，不是甩脸色', () => {
  const r = checkCapability(ROLE_GUEST, CAP.WORKSHOP_USE)
  assertHuman(r.message, 'E02')
  assert.ok(/主人|管理员/.test(r.message), '应该告诉客人该找谁：' + r.message)
})

t('E03 checkRole 两个档位的提示语都是人话', () => {
  assertHuman(checkRole(ROLE_ADM, ROLE_OWNER).message, 'E03 owner 档')
  assertHuman(checkRole(ROLE_GUEST, ROLE_ADM).message, 'E03 adm 档')
})

t('E04 全库扫一遍：任何越权提示都不含机器词（穷举角色 × 能力）', () => {
  const caps = CAP_RULES.map((r) => r.cap).concat(['未登记的.api'])
  for (const role of [ROLE_OWNER, ROLE_ADM, ROLE_GUEST, 'weird']) {
    for (const cap of caps) {
      const r = checkCapability(role, cap)
      if (!r.ok) assertHuman(r.message, `E04 ${role}/${cap}`)
    }
  }
  for (const a of [ROLE_OWNER, ROLE_ADM, ROLE_GUEST]) {
    for (const b of [ROLE_OWNER, ROLE_ADM, ROLE_GUEST]) {
      const r = checkRole(a, b)
      if (!r.ok) assertHuman(r.message, `E04 role ${a}->${b}`)
    }
  }
})

t('E05 roles.js 的**代码行**里没有「权限不足」这种词（注释里写明规矩可以，写进提示语不行）', () => {
  const src = readFileSync(ROLES_SRC, 'utf8')
  // 只扫代码行：注释里专门写了「不许说权限不足」，那是规约本身，不该被这条断言误伤。
  const codeOnly = src
    .split(/\r?\n/)
    .filter((line) => {
      const s = line.trim()
      return s && !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*')
    })
    .join('\n')
  for (const w of ['权限不足', 'Access denied', 'access denied', 'forbidden']) {
    notHas(codeOnly, w, 'roles.js 代码行')
  }
})

// ══════════════════════════════════════════════════════════════════
console.log('\nF. 接缝的两个语义细节')
// ══════════════════════════════════════════════════════════════════

t('F01 checkRole 允许「降级要求」：要 guest 的活 adm/owner 都能干', () => {
  assert.equal(checkRole(ROLE_ADM, ROLE_GUEST).ok, true)
  assert.equal(checkRole(ROLE_OWNER, ROLE_GUEST).ok, true)
  assert.equal(checkRole(ROLE_GUEST, ROLE_GUEST).ok, true)
})

t('F02 checkRole 的 need 写错（非法角色）时按 owner 处理，不会意外放行', () => {
  const r = checkRole(ROLE_ADM, 'root')
  assert.equal(r.ok, false, 'need 写错不该等于「谁都能进」')
})

t('F03 checkCapability 返回值形状稳定（调用方按字段解包，改形状会全线崩）', () => {
  const ok = checkCapability(ROLE_OWNER, CAP.CONFIG_YML)
  const no = checkCapability(ROLE_ADM, CAP.CONFIG_YML)
  for (const r of [ok, no]) {
    assert.deepEqual(Object.keys(r).sort(), ['cap', 'message', 'need', 'ok', 'role'])
  }
})

t('F04 CommandExecutor 的守卫不会改写 config（运行期角色只读）', () => {
  const cfg = { ownerUin: OWNER, admUins: [ADM] }
  const snapshot = JSON.stringify(cfg)
  const { ex } = makeExecutor(cfg)
  ex.requireRole(ROLE_OWNER, { user_id: ADM })
  ex.requireCapability(CAP.BUDGET_MANAGE, { user_id: ADM })
  assert.equal(JSON.stringify(cfg), snapshot, '守卫不该动 config')
})

// ══════════════════════════════════════════════════════════════════
console.log('\nG. main.js 接线（只读源码断言：resolveDirs 没导出，不能在进程外跑）')
// ══════════════════════════════════════════════════════════════════

const MAIN_SRC = readFileSync(path.join(HERE, '..', 'plugin', 'dsh-qq-whale', 'lib', 'main.js'), 'utf8')
const CMD_SRC = readFileSync(path.join(HERE, '..', 'plugin', 'dsh-qq-whale', 'lib', 'commands.js'), 'utf8')

t('G01 DEFAULTS 里写了 admUins 默认值（用户要的是「给他一个 adm」，默认就该是他）', () => {
  has(MAIN_SRC, "admUins: ['333333333']", 'main.js DEFAULTS')
})

t('G02 schema 里也有 admUins（不然配置框里改不了、宿主投影里看不到）', () => {
  // schema 行形如 admUins: s.array(s.string()).default(DEFAULTS.admUins)
  assert.ok(/admUins:\s*s\s*\n?\s*\.array\(s\.string\(\)\)/.test(MAIN_SRC), 'schema 里没找到 admUins 的 s.array(s.string())')
  has(MAIN_SRC, 'DEFAULTS.admUins', 'schema 的 default 应指向 DEFAULTS')
})

t('G03 main.js 通过 sub() 动态加载 roles.js（热重载树里，带 ?rev=）', () => {
  has(MAIN_SRC, "await import(sub('./roles.js'))", 'main.js')
  has(MAIN_SRC, 'roleConfig', 'main.js 应引用 roleConfig')
})

t('G04 resolveDirs 把 owners / roles / admUins 铺进 config（三件套一处算完）', () => {
  has(MAIN_SRC, 'owners: roleInfo.owners', 'resolveDirs')
  has(MAIN_SRC, 'roles: roleInfo.roles', 'resolveDirs')
  has(MAIN_SRC, 'admUins: roleInfo.admUins', 'resolveDirs')
})

t('G05 resolveDirs 只算一次角色（在 return 之前，不是每次调用现算映射）', () => {
  const callIdx = MAIN_SRC.indexOf('roleConfig({ ...config, ownerUin })')
  const retIdx = MAIN_SRC.indexOf('owners: roleInfo.owners')
  assert.ok(callIdx > 0, '没找到 roleConfig(...) 调用')
  assert.ok(retIdx > callIdx, 'roleConfig 的结果应在 return 之前算好')
  // 全文件只该有一处调用 roleConfig —— 多处调用就是「算了两遍」，迟早不一致
  const count = (MAIN_SRC.match(/roleConfig\(/g) || []).length
  assert.equal(count, 1, `roleConfig 被调了 ${count} 次，应恰好 1 次`)
})

t('G06 commands.js 从 roles.js 静态导入三个判定 + 再导出越权清单', () => {
  has(CMD_SRC, "from './roles.js'", 'commands.js')
  for (const sym of ['createRoleGate', 'checkRole', 'checkCapability', 'ADM_DENY', 'CAP']) {
    has(CMD_SRC, sym, 'commands.js import')
  }
  has(CMD_SRC, 'export { ADM_DENY, CAP }', 'commands.js 应把清单和能力表再导出一次')
})

t('G07 CommandExecutor 上有三个公开入口：roleOf / requireRole / requireCapability', () => {
  for (const m of ['roleOf(userId)', 'requireRole(need, ev)', 'requireCapability(cap, ev)']) {
    has(CMD_SRC, m, 'commands.js 方法定义')
  }
  has(CMD_SRC, 'this.roleGate = createRoleGate(config || {})', '构造时算一次')
})

t('G08 守卫在拦下时记审计日志（出事能查是谁试的）', () => {
  has(CMD_SRC, '拦下一次越权', 'commands.js')
})

t('G09 角色不写死在代码里（只从 config 来；注释里举例子可以，代码行里出现号码不行）', () => {
  // 避免有人图省事在命令层写 if (userId === '333333333') —— 那是第二个真相源。
  // roles.js 的注释里有 '222222222' 当例子（说明 owners 长什么样），那是文档，
  // 所以这里跟 E05 一样只扫代码行。
  const codeOnly = (src) =>
    src
      .split(/\r?\n/)
      .filter((line) => {
        const s = line.trim()
        return s && !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*') && !s.startsWith('```')
      })
      .join('\n')
  for (const uin of [OWNER, ADM]) {
    notHas(codeOnly(CMD_SRC), uin, 'commands.js 代码行不该出现具体 QQ 号')
    notHas(codeOnly(readFileSync(ROLES_SRC, 'utf8')), uin, 'roles.js 代码行不该出现具体 QQ 号')
  }
})

t('G10 commands.js 的守卫注释写明了「不许说权限不足」这条约定', () => {
  has(CMD_SRC, '不许出现「权限不足」', 'commands.js 注释')
})


// ══════════════════════════════════════════════════════════════════
console.log('')
console.log(`${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log('  - ' + f.name + ': ' + f.msg)
  process.exit(1)
}
