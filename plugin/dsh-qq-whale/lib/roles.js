/**
 * 三级角色：owner / adm / guest（用户 m25316，2026-10-19）。
 *
 * 背景：333333333 通过主人转达了一串要求：
 *   「写一个通用接口 / 隔离一个仓库 / 通用 / 我有时候写点插件你去测试 /
 *    白名单不用、bug 不用 / 要通过聊天调用 dsh 创造模式写插件 /
 *    然后不挂载 / 以 zip 文件存储，然后你去测试」
 * 主人的原话：「给他一个 adm 权限（管理员，权限低于 owner）」。
 *
 * 这个文件只做三件事，全是纯函数，不碰网络、不碰磁盘、不碰插件：
 *   1. 把「谁是哪个角色」算清楚（owner 优先于 adm；数组和逗号串都吃；去重）
 *   2. 写死 adm **碰不得**什么（ADM_DENY）、能碰什么（CAP）
 *   3. 给一句人话用来挡人（checkCapability 返回的 message）
 *
 * 为什么边界写死在代码里，不写进提示词：
 *   提示词是「劝」，模型状态一飘就会自己找理由绕过；这里是「判」，
 *   requireCapability() 返回 ok:false 时调用方想干也干不成。用户要的是
 *   「白名单不用、bug 不用」——那两件事本来就只有主人能碰，靠嘴说不可靠。
 *
 * 为什么不在这里读配置文件：
 *   main.js 的 resolveDirs() 在构造时算一次（env > console.json > 默认值），
 *   传进来的已经是合并完的配置；这里再读一次磁盘，迟早两边不一致。
 *   同样的理由，角色映射也只在构造时算一次，运行期只读（见 roleConfig）。
 */

// ── 角色 ────────────────────────────────────────────────────────────────

export const ROLE_OWNER = 'owner'
export const ROLE_ADM = 'adm'
export const ROLE_GUEST = 'guest'

/** 角色高低。比大小用它，别用字符串比。 */
export const ROLE_RANK = { [ROLE_GUEST]: 1, [ROLE_ADM]: 2, [ROLE_OWNER]: 3 }

const ALL_ROLES = [ROLE_OWNER, ROLE_ADM, ROLE_GUEST]

/** 把任意输入收敛成合法角色名；认不出来的一律当 guest（宁可少给权）。 */
export function normalizeRole(role) {
  const s = String(role ?? '').trim().toLowerCase()
  return ALL_ROLES.includes(s) ? s : ROLE_GUEST
}

/**
 * QQ 号归一化：一个数组和「333333333, 123456」这种手写串都要吃。
 *
 * 为什么容忍逗号串：用户在 yml / 配置框里手敲时几乎不会写成 YAML 数组，
 * 直接敲「333333333,123456」最自然。approverUins 当年就是为这个加的归一化
 * （见 main.js resolveDirs 的注释），这里照抄同一套分隔符，免得两处行为不一致。
 *
 * 分隔符包含中英文逗号、顿号、分号、各种空白 —— 用户复制粘贴时混进全角符号很常见。
 */
export function normalizeUins(value) {
  const raw = Array.isArray(value)
    ? value
    : String(value ?? '').split(/[\s,，、;；]+/)
  const out = []
  for (const item of raw) {
    const s = String(item ?? '').trim()
    if (!s) continue
    if (out.includes(s)) continue // 去重：同一个人配两遍，日志里会冒出两条一样的
    out.push(s)
  }
  return out
}

/**
 * 角色门：把配置解析成「一个人怎么查角色」的闭包。
 *
 * owner 优先于 adm 是硬规则 —— 主人要是把 admUins 顺手填上了自己的号，
 * 结果必须是 owner，不能因为「同时命中两张表」就降成管理员。
 *
 * @param {object} config 已经合并完的插件配置
 * @returns {{ownerUin:string, admUins:string[], roleOf:(uin:any)=>string,
 *            isOwner:(uin:any)=>boolean, isAdm:(uin:any)=>boolean,
 *            isGuest:(uin:any)=>boolean, rankOf:(uin:any)=>number}}
 */
export function createRoleGate(config = {}) {
  // 主人号解析跟 resolveDirs 保持一致：显式配置优先，没配就退化白名单第一个。
  // 这里再兜一次是因为本文件也可能被测试/工具直接调用，不能假设上游已经补齐。
  const ownerUin = String(
    config.ownerUin ?? (Array.isArray(config.allowedUsers) ? config.allowedUsers[0] : '') ?? '',
  ).trim()

  const admUins = normalizeUins(config.admUins).filter((u) => u !== ownerUin)
  const admSet = new Set(admUins)

  const uinOf = (uin) => String(uin ?? '').trim()

  const roleOf = (uin) => {
    const s = uinOf(uin)
    if (!s) return ROLE_GUEST
    // 顺序就是优先级：先看主人，再看管理员，剩下的都是客人。
    if (ownerUin && s === ownerUin) return ROLE_OWNER
    if (admSet.has(s)) return ROLE_ADM
    return ROLE_GUEST
  }

  return {
    ownerUin,
    admUins,
    roleOf,
    isOwner: (uin) => roleOf(uin) === ROLE_OWNER,
    isAdm: (uin) => roleOf(uin) === ROLE_ADM,
    isGuest: (uin) => roleOf(uin) === ROLE_GUEST,
    rankOf: (uin) => ROLE_RANK[roleOf(uin)],
  }
}

/**
 * 给 resolveDirs 用的「一次性算好」角色映射。
 *
 * 用户要能一眼看出「谁是什么角色」，所以除了干净的 uin 列表，还多给一张
 * uin → role 的映射表。只在 main.js 构造时算一次，运行期谁都不许改它
 * （改了等于运行中给人提权，属于事故）。
 *
 * 返回的键会被展开进 config：
 *   owners: ['222222222']                       ← 主人号列表（永远只有 0 或 1 个）
 *   admUins: ['333333333']                       ← 归一化后的管理员列表
 *   roles: { '222222222': 'owner', ... }        ← 映射表
 */
export function roleConfig(config = {}) {
  const gate = createRoleGate(config)
  const roles = {}
  if (gate.ownerUin) roles[gate.ownerUin] = ROLE_OWNER
  for (const u of gate.admUins) roles[u] = ROLE_ADM
  return {
    owners: gate.ownerUin ? [gate.ownerUin] : [],
    admUins: gate.admUins,
    roles,
  }
}

// ── 能力表 ──────────────────────────────────────────────────────────────
//
// 一条能力 = 一类动作。调用方在真正动手之前问一句 checkCapability()，
// 而不是自己去比 QQ 号 —— 比号散落在十个地方，漏一处就是漏洞。
//
// min 就是这个能力的最低角色：
//   owner  → adm 和 guest 都被挡（这就是「adm 越权清单」的来源）
//   adm    → adm 和 owner 能用，guest 不行
//
// 为什么用一张表而不是两个白/黑名单：两套名单一定会漂移。这里写明 min，
// ADM_DENY 由 min===owner 的条目自动导出，加新能力时必须显式写 min，
// 不写就落到下面的「未登记能力一律按 owner 处理」，也就是默认更严。

export const CAP = Object.freeze({
  // —— 只有主人能碰（= adm 越权清单，逐条对应用户要求）——
  ALLOWLIST_MANAGE: 'allowlist.manage',
  MEMORY_OWNER_WRITE: 'memory.owner.write',
  BUDGET_MANAGE: 'budget.manage',
  PERSONA_MANAGE: 'persona.manage',
  PLUGIN_INSTALL: 'plugin.install',
  PROCESS_KILL: 'process.kill',
  DSH_RESTART: 'dsh.restart',
  CONFIG_YML: 'config.yml',
  // —— 管理员也能碰 ——
  WORKSHOP_USE: 'workshop.use',
  COMMAND_RUN: 'command.run',
  COMMAND_RESULT: 'command.result',
})

/**
 * 能力表。say 是拒人的那句话 —— 必须是正常人话，
 * 不许出现「权限不足」「无权限」「forbidden」这类机器词（用户明确要求）。
 */
export const CAP_RULES = Object.freeze([
  // ① 改白名单 / 审批人
  { cap: CAP.ALLOWLIST_MANAGE, min: ROLE_OWNER, label: '改白名单和审批人', say: '谁能跟她说话是主人定的事，这个我替你拦下了。' },
  // ② 改主人的记忆
  { cap: CAP.MEMORY_OWNER_WRITE, min: ROLE_OWNER, label: '改主人的记忆', say: '主人自己的记忆只有他能动，这个我替你拦下了。' },
  // ③ 改预算
  { cap: CAP.BUDGET_MANAGE, min: ROLE_OWNER, label: '改预算和额度', say: '花多少钱是主人说了算，这个我替你拦下了。' },
  // ④ 改 persona
  { cap: CAP.PERSONA_MANAGE, min: ROLE_OWNER, label: '改人设和提示词', say: '她的脾气只有主人能改，这个我替你拦下了。' },
  // ⑤ 装插件到线上 / 重载插件
  { cap: CAP.PLUGIN_INSTALL, min: ROLE_OWNER, label: '往线上装插件', say: '往线上装插件得主人点头，这个我替你拦下了。' },
  // ⑥ 关 QQ / 杀 NapCat
  { cap: CAP.PROCESS_KILL, min: ROLE_OWNER, label: '关 QQ 或 NapCat', say: '关 QQ 或 NapCat 只有主人能拍板，这个我替你拦下了。' },
  // ⑦ 重启 DSH 宿主
  { cap: CAP.DSH_RESTART, min: ROLE_OWNER, label: '重启 DSH', say: '重启 DSH 只有主人能拍板，这个我替你拦下了。' },
  // ⑧ 改 yml 配置
  { cap: CAP.CONFIG_YML, min: ROLE_OWNER, label: '改配置文件', say: '改配置文件只有主人能动手，这个我替你拦下了。' },
  // —— 管理员能干的：工坊全套 + 下指令 + 收结果 ——
  { cap: CAP.WORKSHOP_USE, min: ROLE_ADM, label: '用插件工坊', say: '' },
  { cap: CAP.COMMAND_RUN, min: ROLE_ADM, label: '让干活会话执行命令', say: '' },
  { cap: CAP.COMMAND_RESULT, min: ROLE_ADM, label: '接收执行结果', say: '' },
])

const RULE_BY_CAP = new Map(CAP_RULES.map((r) => [r.cap, r]))

/**
 * adm 明确碰不得的东西 —— 由 CAP_RULES 里 min===owner 的条目导出。
 * 单独导出一份是为了让测试/报告能直接列清单，不用在别处再抄一遍（抄就一定漂移）。
 */
export const ADM_DENY = Object.freeze(
  CAP_RULES.filter((r) => r.min === ROLE_OWNER).map((r) => Object.freeze({ cap: r.cap, label: r.label })),
)

/** guest 连 adm 级能力都没有时可用的兜底话术。 */
const GUEST_SAY = '这个得主人或管理员才使得动，我替你拦下了。'

/** 未登记能力：宁可严，按 owner 处理（新增能力时必须显式写 min）。 */
const UNKNOWN_RULE = Object.freeze({ min: ROLE_OWNER, label: '没登记的动作', say: '这个动作我还没搞清楚该谁说了算，先当只有主人能动。' })

/**
 * 能力判定。
 *
 * @param {string} role  normalizeRole 能认的角色名
 * @param {string} cap   CAP 里的能力 id
 * @returns {{ok:boolean, role:string, cap:string, need:string, message:string}}
 *          ok=false 时 message 是给用户看的人话，直接回给发消息的人即可。
 */
export function checkCapability(role, cap) {
  const r = normalizeRole(role)
  const id = String(cap ?? '').trim()
  const rule = RULE_BY_CAP.get(id) || UNKNOWN_RULE
  const need = rule.min
  const mine = ROLE_RANK[r] ?? ROLE_RANK[ROLE_GUEST]
  const required = ROLE_RANK[need] ?? ROLE_RANK[ROLE_OWNER]

  if (mine >= required) {
    return { ok: true, role: r, cap: id, need, message: '' }
  }

  // 挡人的话按「差在哪儿」分三种，别都回同一句：
  //   guest 想干 adm 的活 → 让他去找主人或管理员
  //   adm/guest 想干 owner 的活 → 明确说只有主人能改（并带上具体是哪件事）
  const say = r === ROLE_GUEST && required <= ROLE_RANK[ROLE_ADM] ? GUEST_SAY : rule.say || GUEST_SAY
  return { ok: false, role: r, cap: id, need, message: say }
}

/**
 * 粗粒度闸门：只要「至少是这个角色」。
 *
 * 跟 checkCapability 的分工：这个用在「整条入口只有主人/管理员能进」的地方，
 * 那个用在「具体某个动作碰不得」的地方。两个都写清楚，读代码时不用猜。
 *
 * need 写错（拼错角色名、传了 null）时**按 owner 处理**，不是按 guest。
 * 这里的区别是安全性的关键：normalizeRole 把认不出的值降成 guest，
 * 要是拿降级后的结果去比 rank，`adm >= guest` 恒真 —— 一次手滑的
 * requireRole('admin') 就变成了对所有人放行。宁可让拼错的人自己被拒，
 * 也不能让拼错变成一道敞开的大门。
 */
export function checkRole(role, need) {
  const r = normalizeRole(role)
  const rawNeed = String(need ?? '')
    .trim()
    .toLowerCase()
  const n = ALL_ROLES.includes(rawNeed) ? rawNeed : ROLE_OWNER
  const ok = (ROLE_RANK[r] ?? ROLE_RANK[ROLE_GUEST]) >= ROLE_RANK[n]
  if (ok) return { ok: true, role: r, need: n, message: '' }
  if (r === ROLE_GUEST && n === ROLE_ADM) return { ok: false, role: r, need: n, message: GUEST_SAY }
  return {
    ok: false,
    role: r,
    need: n,
    message: n === ROLE_OWNER ? '这个只有主人能改，我替你拦下了。' : GUEST_SAY,
  }
}
