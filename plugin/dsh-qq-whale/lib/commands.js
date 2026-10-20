/**
 * 指令层：把主人的话变成真能干活的 agent。
 *
 * 入口只有一个，而且完全可预测：**消息以「命令 」开头**。
 *
 * 为什么不做「让模型判断这是不是个任务」：
 * 试过，模型会把「你帮我记住我今天很累」这类纯情绪的话也判成任务，
 * 于是它就真的去开 agent 干活，反而更烦人。分类器的失败方向很糟——
 * 误判成命令是白烧 token 和工具调用，误判成聊天则主人以为事没办。
 * 所以宁可用一个显式的、一眼能看懂的约定。
 *
 * 安全边界：
 *   - 只有 commanderUsers 里的人能下指令
 *   - **只在私聊生效**，群里永不执行（群友一句话就能让你电脑干活，太危险）
 *   - 执行用独立的常驻 DSH session，不被 QQ 聊天的历史污染
 *   - 会话常驻复用，Molly 在「干活会话」里有连续的上下文
 */

import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { INTERACTIVE_TOOLS, prescreenTask, REVIEW_REPLY, recordPending, scanToolCall } from './work-guard.js'
import {
  ADM_DENY,
  CAP,
  checkCapability,
  checkRole,
  commandIntentOf,
  createRoleGate,
  OWNER_ONLY_SAY,
  ROLE_ADM,
} from './roles.js'

/**
 * 干活会话的**唯一**默认工作目录（2026-10-20 task-41）。
 *
 * 之前 pickWorkCwd() 的兜底是 process.cwd()，而插件跑在 DSH 宿主进程里，
 * 于是干活会话的 cwd == 宿主 cwd == ${WORKSPACE}
 * ——群里一句「命令 帮我改一下」就能直接改项目源码（真机已证实）。
 *
 * 现在默认落到 ${MOLLY_ROOT}\sandbox\qq-work：里面没源码，最坏也只是把沙箱弄脏。
 * 仍允许 config.workSandboxDir / config.workCwd 覆盖（部署到服务器时换路径）。
 */
export const WORK_SANDBOX_DIR = 'G:\\Molly\\sandbox\\qq-work'

/**
 * 单轮干活的硬上限（task-44）。
 *
 * 为什么是 180 秒：真机上一条查询/小脚本命令通常 10~60 秒跑完；180 秒足够覆盖
 * 查资料 + 写文件 + 发 QQ 的常见组合，又远小于原来 15 分钟的整体超时——
 * 后者一旦撞上「模型在等一个没人能点的弹窗」，主人要等 15 分钟才收到超时，
 * 中间所有命令全排队。可用 config.workTurnTimeoutMs 覆盖。
 */
export const WORK_TURN_TIMEOUT_MS = 180 * 1000

/** 卡死多久算「上一条命令已经没救了」，下一条命令可以主动取消它。 */
export const WORK_STUCK_MS = 270 * 1000

/** 单轮超时后发给主人的话（task-44 指定话术）。 */
export const WORK_STALL_REPLY = '这活我卡住了，先放下。你换个说法或者拆小一点再让我试。'

/**
 * 工具死循环闸门（task-50）。
 *
 * 真机 2026-10-20 16:09：用户让 work 会话建目录，模型连续 5+ 次调
 * `working_directory · ${MOLLY_ROOT}\sandbox`，中间还自己道歉「抱歉我又重复了」，
 * 然后把同一调用继续下去，把一轮预算烧光。
 *
 * 判定：同一个 `工具名 + 参数 JSON` 在一次命令执行里出现次数。
 *   - 第 3 次：拦掉（工具层返回一段纠偏人话，模型能看到）
 *   - 第 4 次：再拦一次并**收口**：取消这一轮，向用户回 LOOP_ABORT_REPLY
 * **绝不伪造成功返回值**——那会让模型以为目录建好了，骗到的是用户。
 */
export const LOOP_WARN_AT = 3
export const LOOP_ABORT_AT = 4

/** 第 3/4 次重复调用时返回给模型的纠偏文案（作为工具错误结果进上下文）。 */
export function loopCorrective(tool, count) {
  return (
    `你已经用完全相同的参数调用 ${tool} ${count} 次了，它不会给你任何新信息。` +
    '这一轮已经被闸门拦下：不要再调它（也不要换个说法调同一个工具）。' +
    '要么换一条完全不同的办法，要么直接告诉用户这条路走不通。'
  )
}

/** 死循环收口时发给用户的原话。 */
export const LOOP_ABORT_REPLY =
  '这条路我走不通：同一个工具我反复试了几次都没拿到新结果，先停下了。你换个说法，或者把这件事拆小一点再让我做。'

/**
 * 三会话工具面（task-46）。
 *
 * chat 是最小权限面：**任何**能碰到文件、shell、网络、交互的工具都不给。
 * 这里列的是宿主已注册的工具名；名字不存在时 restrict 会抛，调用方逐个 try。
 * 主人的原话是「聊天时她根本没有能力动我文件」——所以清单必须显式、可测。
 */
export const CHAT_DENY_TOOLS = Object.freeze([
  'write',
  'edit',
  'apply_patch',
  'pwsh',
  'bash',
  'run_code',
  'read',
  'glob',
  'grep',
  'web_search',
  'web_fetch',
  'research',
  'skill',
  'present',
  'ask_user_question',
  'exit_plan_mode',
])

/**
 * work（查询）会话：没有写工具，但保留 qq_onebot / 检索 / 只读文件。
 * 写盘请求会被引导去 code 会话（或在 code 会话里过审核）。
 */
export const WORK_DENY_TOOLS = Object.freeze(['write', 'edit', 'apply_patch'])

/**
 * 三级角色的**权限判定接缝**（用户 m25316）。
 *
 * 为什么只加接缝、不加命令：
 *   本轮的分工是「roles.js 的判定 + 命令层的守卫」归这里，工坊那套命令
 *   归另一个任务。所以下面只有 requireRole / requireCapability 两个守卫，
 *   以及 adm 越权清单的再导出 —— 谁要写新命令，进门先问一句这两个之一。
 *
 * 为什么守卫长在 CommandExecutor 上而不是 engine.js 里：
 *   engine.js 里散着 isOwner 的判断（L852 / L1341），那是既有的、跟
 *   「谁能收到审批/谁能私聊」绑在一起的语义，不该被这一轮改动牵连。
 *   命令执行这条链路才是 adm 需要的地盘，守卫就长在这条链路的入口。
 *
 * 越权时**只回人话**（「这个只有主人能改」），不许出现「权限不足」这种词。
 * 那类机器词用户看了一头雾水，也让人以为自己被系统拒绝而不是被规则拦住。
 *
 * ⚠ 这里用的是静态 import（不带 ?rev=），跟 web.js / pest.js / memory.js
 * 的既有写法一致。副作用：改 roles.js 后要重载插件才生效，热重载（只换
 * ?rev= 那种）到这里就断了。可以接受 —— 角色名单本来就该在重载时定下来。
 */

// 越权清单与能力表在这里再导出一次：命令层、工具层、控制台都从同一个出口
// 拿，省得各自 import roles.js 时因为 URL 不同（带不带 ?rev=）拿到两份实例。
export { ADM_DENY, CAP }

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)))

/**
 * 「读不到内容」的哨兵值。
 *
 * 单独抽成常量是因为调用方要能识别它——真机上这行占位文字如果不拦，
 * 会原样发进 QQ："（干完了，但没说话）"，比报错还让人摸不着头脑。
 */
const PLACEHOLDER_NO_TEXT = '（干完了，但没说话）'

/** 判定指令的提示词。刻意极短：这是一次分类请求，不是创作请求。 */
const ROUTER_PROMPT = `你是一个指令分类器。判断主人对 AI 助理说的话里，哪部分是需要真正执行的任务。

只输出一行 JSON，不要任何解释：
{"kind":"command"|"chat","task":"要执行的任务","reply":"如果不需要执行，用一句话回应"}

判定规则：
- 明确要求做一件有产出的事（写、查、跑、改、删、下载、整理、分析、发、建、修…）→ command
- 只是闲聊、吐槽、问感受、问"你是不是…"、发表情、打招呼 → chat
- 混合的（先闲聊再让你干活）→ command，task 只写干活那部分，不要带上闲聊
- 问"你现在在干嘛""你记得吗"这类关于你自己状态的 → chat
- 拿不准 → chat

举例：
输入「帮我查一下明天上海天气」→ {"kind":"command","task":"查明天上海的天气"}
输入「哈哈哈笑死」→ {"kind":"chat","reply":"哈啥呢"}
输入「今天好累啊，你陪我聊会」→ {"kind":"chat","reply":"累了就躺会儿"}
输入「你先睡吧，明早帮我把日报写了」→ {"kind":"command","task":"写日报"}`

export class CommandExecutor {
  /**
   * @param {'work'|'code'} [opts.role]
   *   task-46：三会话隔离。role 决定三件事——
   *     ① sessionId：`qq-whale-work-<selfId>`（沿用，绝不改名/重建）或 `qq-whale-code-<selfId>`
   *     ② 模型：config.workModel / config.codeModel（形状 {provider, model, reasoningEffort?}）
   *     ③ 工具面：work 无写工具，code 全套（写盘仍过 work-guard）
   *   缺省 'work'，保证老调用点行为不变。
   */
  constructor({ ctx, logger, config, engine, role = 'work' }) {
    this.ctx = ctx
    this.logger = logger
    this.config = config
    this.engine = engine
    /** 'work'（查询）| 'code'（改代码） */
    this.role = role === 'code' ? 'code' : 'work'
    /** 常驻的「干活会话」，懒创建 */
    this.handle = null
    /** 进行中的任务，便于打断/查询 */
    this.running = null
    /** 上一次执行结果，供聊天侧引用 */
    this.lastResult = null
    /**
     * 最近一次建会话/执行失败的原因。
     *
     * 桌面版没有常规运行日志（logger.error 写的地方不是文件），所以
     * ensureHandle() 抛错时如果只写日志，外界完全看不见 —— 用户看到的就是
     * 「只出一句开工语，永远没下文」。留一份给 /dsh-qq-whale/state 的 work 字段读。
     */
    this.lastError = ''
    /**
     * 三级角色的判定门（owner / adm / guest）。
     *
     * 构造时算一次、运行期只读：角色是「人的身份」，不是「一次请求的参数」，
     * 每个动作都重新解析一遍既慢又给不一致留了口子。
     * config 里已经有 main.js resolveDirs() 算好的 ownerUin/admUins，
     * createRoleGate 只做归一化 + owner 优先，不读磁盘。
     */
    this.roleGate = createRoleGate(config || {})
    /** adm 越权清单（只读，给命令层和测试直接列清单用）。 */
    this.admDeny = ADM_DENY
    /*
     * 本轮命令被护栏拦下的记录（task-41）。
     *
     * guard 是同步的，只能往这个数组里塞；真正落盘 pending-code.json、
     * 私聊通知主人、把固定话术替换成最终结果，都在 _runOnce 里做。
     * runCommand 每条命令开始时清空，防止上一条的拦截串到下一条。
     */
    this._escalations = []
    /** 当前正在执行的命令上下文（guard 拒绝时要用它写清「谁要改什么」）。 */
    this.currentCommand = null
    /** 工具护栏的注销函数（换会话时先注销旧的，避免一个 agent 挂两道）。 */
    this._workGuardDispose = null
    /** task-50：本轮「工具名+参数」调用计数（每次 _runOnce 清零） */
    this._loopCounts = new Map()
    /** task-50：本轮是否已经触发了死循环收口 */
    this._loopTripped = false
  }

  // ———————————————— 权限 ————————————————

  /** 每次命令开始前清零死循环计数（task-50）。 */
  resetLoopGuard() {
    this._loopCounts = new Map()
    this._loopStreak = { key: '', n: 0 }
    this._loopTripped = false
  }

  /** 参数稳定序列化：同样的对象不管键顺序都算同一个 key。 */
  stableArgsKey(args) {
    const canon = (v, depth = 0) => {
      if (depth > 4) return '…'
      if (v === null || typeof v !== 'object') return v
      if (Array.isArray(v)) return v.map((x) => canon(x, depth + 1))
      const out = {}
      for (const k of Object.keys(v).sort()) out[k] = canon(v[k], depth + 1)
      return out
    }
    try {
      return JSON.stringify(canon(args ?? {}))
    } catch {
      return String(args)
    }
  }

  /**
   * 工具死循环闸门（task-50）：同工具同参数**连续** ≥3 次就拦，≥4 次收口。
   *
   * 只认「连续」：中间夹了别的工具/参数就重新计数——模型在正常推进
   * （A→B→A→B 是两条路交替试，不是原地打转）；原地打转的定义是
   * 「同一个调用一遍又一遍，中间什么都没有」。
   *
   * 返回 null 表示放行；返回字符串表示拒绝理由（DSH 的 tools.guard 约定：
   * 返回非空字符串即 deny，该字符串会作为工具错误结果回到模型上下文）。
   */
  checkToolLoop(exec) {
    const tool = String(exec?.name || exec?.tool || '')
    const args = exec?.arguments ?? exec?.args ?? {}
    const key = `${tool}|${this.stableArgsKey(args)}`
    if (!this._loopStreak || this._loopStreak.key !== key) {
      this._loopStreak = { key, n: 0 }
    }
    this._loopStreak.n += 1
    const count = this._loopStreak.n
    this._loopCounts.set(key, (this._loopCounts.get(key) || 0) + 1)
    if (count < LOOP_WARN_AT) return null
    if (count === LOOP_WARN_AT) {
      this.logger('warn', `工具死循环闸门：${tool} 相同参数连续第 ${count} 次，已拦下并纠偏`)
      return loopCorrective(tool, count)
    }
    /*
     * 纠偏后还在原地打转 → 这一轮没救了，直接收口。
     * agent.cancel 是异步副作用，guard 必须同步返回，所以用 setTimeout(0) 甩出去；
     * 这里绝不伪造工具返回值（不能让模型以为成功了）。
     */
    this._loopTripped = true
    this.logger('warn', `工具死循环收口：${tool} 相同参数连续第 ${count} 次，取消本轮`)
    const agent = exec?.agent
    setTimeout(() => {
      try {
        agent?.cancel?.({ kind: 'user', reason: '工具死循环（同一调用反复出现）' })
      } catch (err) {
        this.logger('warn', `取消死循环轮次失败：${err?.message || err}`)
      }
    }, 0)
    return loopCorrective(tool, count)
  }

  /**
   * 这个角色的会话该屏蔽哪些工具（task-46）。
   * code 只需要屏蔽交互式提问（写盘由 work-guard 管），work 额外屏蔽写工具。
   */
  denyToolsForRole(role = this.role) {
    if (role === 'code') return []
    return WORK_DENY_TOOLS
  }

  /**
   * 解析某个会话的模型配置（task-46）。
   *
   * 配置形状 `{ provider, model, reasoningEffort? }`；同时兼容老写法
   * `workModel: 'kimi-k2.6'`（字符串）与 `workProvider`。返回的是**直接喂给
   * agents.create 的 agentOptions**，所以只放 DSH 认识的键。
   */
  modelSpec(role = this.role) {
    const raw = this.config?.[`${role}Model`]
    const spec = raw && typeof raw === 'object' ? raw : {}
    const legacyModel = typeof raw === 'string' ? raw : ''
    const provider =
      spec.provider ||
      (role === 'work' ? this.config?.workProvider : '') ||
      this.config?.provider ||
      ''
    const model =
      spec.model ||
      legacyModel ||
      (role === 'work' ? this.config?.workModel || (typeof this.config?.workModel === 'string' ? this.config.workModel : '') : '') ||
      this.config?.model ||
      ''
    const out = {}
    if (provider) out.provider = provider
    if (model) out.model = model
    if (spec.reasoningEffort) out.reasoningEffort = spec.reasoningEffort
    return out
  }

  /** 这个 QQ 号是什么角色：'owner' | 'adm' | 'guest'。 */
  roleOf(userId) {
    return this.roleGate.roleOf(userId)
  }

  /**
   * 粗粒度守卫：这次操作至少要有 need 这个角色。
   *
   * 用法（新命令进门第一句）：
   *     const gate = this.requireRole('adm', ev)
   *     if (!gate.ok) return { text: gate.message }   // message 已经是人话
   *
   * ev 里取发起人：私聊/群消息都是 ev.user_id。拿不到就当 guest，
   * 宁可少给权 —— 判不清身份时放行才是真漏洞。
   */
  requireRole(need, ev) {
    const role = this.roleOf(ev?.user_id ?? ev?.userId)
    const res = checkRole(role, need)
    if (!res.ok) {
      this.logger?.(
        'info',
        `拦下一次越权：uin=${ev?.user_id ?? '(未知)'} 角色=${role} 需要=${res.need} 动作=${ev?.__cap || '(未标注)'}`,
      )
    }
    return res
  }

  /**
   * 细粒度守卫：这次操作是不是 cap 这个能力。
   *
   * 跟 requireRole 的分工：requireRole 管「整条入口谁能进」，
   * requireCapability 管「具体某个动作碰不得」。adm 的八条禁令就在
   * roles.js 的 CAP_RULES 里（min=owner），加新能力时必须显式写 min。
   */
  requireCapability(cap, ev) {
    const role = this.roleOf(ev?.user_id ?? ev?.userId)
    const res = checkCapability(role, cap)
    if (!res.ok) {
      this.logger?.(
        'info',
        `拦下一次越权：uin=${ev?.user_id ?? '(未知)'} 角色=${role} 能力=${res.cap} 需要=${res.need}`,
      )
    }
    return res
  }

  /**
   * 命令角色门（task-43）：这条命令文本是不是只有主人能做的事。
   *
   * 为什么要它：`requireCapability` 写好了但**命令路径从没调用过**，于是
   * adm（333333333）和 owner 在命令权限上完全等价——他能让 Molly「重启 DSH」
   * 「打开骂人模式」。现在把关键词表（roles.js 的
   * `OWNER_ONLY_COMMAND_KEYWORDS`）接到命令入口。
   *
   * 判定顺序（错向权限最小）：
   *   1. 关键词匹配不上 → 放行（说明不是 owner 独占操作，不能一刀切拒绝）
   *   2. 匹配上 → `checkCapability(role, cap)`；角色认不出来（guest）时它必拒
   *   3. 拒绝时用固定一句人话，并把这次越权留痕到 denied-commands.json
   *
   * @returns {{ok:boolean, role:string, cap:string, message:string}}
   */
  gateCommand(text, ev) {
    const role = this.roleOf(ev?.user_id ?? ev?.userId)
    /*
     * 先分意图（task-43 补丁）：
     *   - cap 匹配不上 → 放行
     *   - 只读（查/看/念…且没有变更词）→ adm 及以上放行只读查询
     *   - 变更 / 含糊 → 走角色判定
     * 只读放行必须过「至少 adm」这道：guest 即使在命令群里，也不能因为
     * 「查预算还剩多少」被放进来（入口层通常已经拦了，这里是纵深）。
     */
    const intent = commandIntentOf(text)
    const cap = intent.cap
    if (!cap) return { ok: true, role, cap: '', message: '', intent: intent.intent }
    if (intent.allow && checkRole(role, ROLE_ADM).ok) {
      return { ok: true, role, cap, message: '', intent: intent.intent, readOnly: true }
    }
    const res = checkCapability(role, cap)
    if (res.ok) return { ok: true, role, cap, message: '', intent: intent.intent }
    this.recordDeniedCommand({ uin: String(ev?.user_id ?? ''), role, text, cap })
    this.logger?.(
      'warn',
      `越权命令被拒：uin=${ev?.user_id ?? '(未知)'} 角色=${role} 能力=${cap} 意图=${intent.intent} 命令=${String(text || '').slice(0, 80)}`,
    )
    return { ok: false, role, cap, message: OWNER_ONLY_SAY, intent: intent.intent }
  }

  /**
   * 越权留痕：追加一行到 `<dataDir>/denied-commands.json`（最多 50 条）。
   * 只是证据，写失败只 warn——留痕坏了不该影响拒人。
   */
  recordDeniedCommand({ uin, role, text, cap }) {
    try {
      const dir = String(this.config?.dataDir || this.config?.memoryDir || '').trim()
      if (!dir) {
        this.logger?.('warn', '越权记录没落盘：没配置 dataDir')
        return false
      }
      const file = path.join(dir, 'denied-commands.json')
      let arr = []
      try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (Array.isArray(parsed)) arr = parsed
      } catch {
        /* 文件不存在/坏了都从空数组开始 */
      }
      arr.push({
        at: Date.now(),
        uin: String(uin || ''),
        role: String(role || ''),
        text: String(text || '').slice(0, 200),
        cap: String(cap || ''),
      })
      while (arr.length > 50) arr.shift()
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(file, JSON.stringify(arr, null, 2), 'utf8')
      return true
    } catch (err) {
      this.logger?.('warn', `越权记录写盘失败（不影响拒绝）：${err?.message || err}`)
      return false
    }
  }

  /**
   * 这个群允许执行「命令 」吗（config.commandGroups 白名单）。
   *
   * 2026-10-20 用户要求「把测试群开放命令模式」。原来群里是**一刀切禁止**的
   * （硬边界，防止群友误触让 agent 干活）。现在改成白名单：只有显式列进
   * commandGroups 的群才放行，其它群行为完全不变。
   */
  isCommandGroup(ev) {
    if (!this.config.commandEnabled) return false
    if (ev?.message_type !== 'group') return false
    const groups = (this.config.commandGroups || []).map(String)
    if (!groups.length) return false
    return groups.includes(String(ev.group_id))
  }

  isCommander(userId, ev) {
    if (!this.config.commandEnabled) return false
    const list = (this.config.commanderUsers || []).map(String)
    if (!list.includes(String(userId))) return false
    // 群里：除了「这个人是指挥官」，还得「这个群开了命令模式」。
    if (ev?.message_type === 'group') return this.isCommandGroup(ev)
    return true
  }

  /** 前缀匹配：命中则强制当指令 */
  matchPrefix(text) {
    const prefixes = this.config.commandPrefixes || []
    for (const p of prefixes) {
      if (p && text.startsWith(p)) {
        return text.slice(p.length).trim()
      }
    }
    return null
  }

  /**
   * 判定这条消息是不是指令。
   * 返回 { kind: 'command'|'chat', task?, reply?, forced? }
   *
   * 现在的规则（按用户要求改的）：只有「命令 xxx」这种显式前缀才算指令。
   * 闲聊里的自然语言一律不执行——宁可漏，不可错。
   * 曾经试过让模型分类"这是不是个任务"，但它会把"你帮我记住我今天很累"
   * 这种纯情绪宣泄也判成任务，反而更烦人，所以砍掉了这一路。
   */
  async classify(text) {
    const forced = this.matchPrefix(text)
    if (forced) {
      return { kind: 'command', task: forced, forced: true }
    }
    return { kind: 'chat', reply: '' }
  }

  // ———————————————— 执行 ————————————————

  /**
   * 取一个 cordis 服务，绕开 inject 检查。
   *
   * 为什么不能直接写 `this.ctx.agents`：cordis 的 ctx 是代理，读一个没在
   * `inject` 里声明过的服务会抛 `cannot get property "agents" without inject`。
   * 我们的 apply 只 inject 了 llm / webServer，拿不到 agents，于是
   * 「命令 xxx」永远建不出干活会话 —— 这就是用户 m03864 报的
   * 「私聊命令只出开工语，永远没有结果」的真根因（早先一直被当成
   * 「ensureHandle 抛错被吞」，那只是表象）。
   *
   * `ctx.reflect.get(name)` 是 cordis 官方提供的、不要求 inject 的读取口
   * （见 cordis/lib/index.js:763 `get(name, strict = true)`，注释原文
   * "Read a service from the store without the inject requirement"）。
   * 用它读 agents 是正路，比为了让代理放行而去改 apply 的 inject 数组更稳：
   * inject 是声明式依赖，加进去会让整个插件在 agents 缺席时都不激活，
   * 而我们的聊天功能不该被「干活会话」绑死。
   */
  pickService(name) {
    const ctx = this.ctx
    if (!ctx) return undefined
    try {
      const viaReflect = ctx.reflect?.get?.(name)
      if (viaReflect) return viaReflect
    } catch {
      /* 退回直接读 */
    }
    try {
      return ctx[name]
    } catch {
      return undefined
    }
  }

  /**
   * 干活会话的固定人设。
   *
   * 挂在 setup 里、由 create/resume 各自调用一次。抽出来是因为「建」和「接上
   * 旧会话」两条路都要挂同一段人设，抄两份迟早会改漏一处。
   */
  workerSetup(role = this.role) {
    const isCode = role === 'code'
    return (agentCtx, agent) => {
      // 给干活会话一段固定人设：她是 Molly，在替主人干活。
      // 这里不挂完整的聊天人格——干活时不需要卖萌，需要的是靠谱。
      try {
        agentCtx.systemPrompt?.section?.({
          name: 'qq-whale-worker',
          order: 900,
          text: [
            '你是 Molly（蓝色大肥鱼），正在通过 QQ 替主人干活。',
            isCode
              ? '这条会话专门接「改代码 / 改配置 / 写插件」的活：写盘前先确认路径，仓库里的文件改动会被护栏拦下转人工审核。'
              : '这条会话专门接「查询 / 跑只读操作 / 发消息」的活：查清楚再回答，别写文件（写盘请走改代码会话）。',
            '干活时保持专业、简洁：把事做完，说清楚结果，不要卖萌，不要跑题。',
            '任务来自 QQ 消息，可能很口语。你自己补全必要的细节。',
            '做完之后，用一两句话总结你做了什么；有产出文件就说路径。',
            '做不到就直说做不到，不要编。',
            /*
             * 这一段是 2026-10-18 真机事故的补丁（用户原话「命令不好用」）：
             * 「命令 检查群昵称状态是否重复」→ 她回「我没有接入 QQ 群成员列表的工具」。
             * 翻 session 记录确认她当时只有 weather / *_search / kimi_browser，
             * 于是老老实实摊手。现在宿主注册了 qq_onebot 工具，必须明确告诉她
             * 「你有这只手」，否则她照样会去翻浏览器桥接。
             */
            '',
            '## 你有 QQ 的手',
            '宿主注册了一个叫 `qq_onebot` 的工具，调的是 Molly 那个真实登录中的 QQ 号。',
            '要查群、查人、查聊天记录、发消息、改群名片，**一律用这个工具**，不要说「我没有 QQ 访问能力」。',
            '常用：',
            '- 查群名片有没有重复：action=group_cards，group_id 填群号（这个动作已经把重复算好了，直接念结果）。',
            '- 看群成员：action=get_group_member_list；看某人：get_group_member_info。',
            '- 看聊天记录：get_group_msg_history / get_friend_msg_history，count 给 20~50。',
            '- 发消息：send_group_msg / send_private_msg；改群名片：set_group_card。',
            '只有 `qq_onebot` 拿不到结果（比如 QQ 掉线）时，才如实说连不上，别说自己没这个能力。',
            /*
             * 2026-10-20 真机（群 777777777）：agent 图省事，自己 write 一个
             * gm.cjs / qqws.cjs 然后 pwsh 跑，直接连 NapCat 的 6099 用 WebSocket
             * 发消息。那条路径绕开了引擎在 client.call 上的捕获层
             * （engine.js 的 installReportCapture），于是「发出去的问候」和
             * 「引擎最后那条总结」变成两个气泡，同一条命令主人收到两条。
             * 而且它还会在宿主目录里留一堆临时脚本。
             */
            '',
            '## 不要自己造发消息的轮子',
            '绝对不要自己写脚本（.cjs / .js / curl / WebSocket）去连 NapCat 或 OneBot 接口发消息、拉记录。',
            '发消息只用 `qq_onebot`（send_group_msg / send_private_msg）。引擎会把这些发送收进本次结果里统一投递，',
            '自己直连发出去的消息不受管理，会让主人收到重复的气泡，也可能重复发给同一个人。',
            '需要批量发（比如给白名单群发同一句话）：先用 qq_onebot 的 get_group_list / get_friend_list 拿到名单，',
            '再逐个 send_group_msg / send_private_msg，最后用一两句话汇报「发了几个、都成功了没」。',
            // 进度播报靠这条：任务一多就先列清单，主人在 QQ 里能看到她在干嘛。
            // 不要求每件小事都列，只要求"多步骤任务先列"，否则会变成刷屏。
            '如果这个任务有两步以上，**先调用 todo 工具列一份清单**（把每步写清楚），',
            '然后每完成一步就更新一次状态。主人会在 QQ 里实时看到这份清单。',
            '一句话就能办完的小事不要列清单。',
            /*
             * 2026-10-19 真机泄漏（私聊 seq 591 / seq 589）：干活会话把
             * `<acp tokens="25" type="text">m02939</acp>` 原样发给主人，紧跟
             * `message_id 1968616843`；另一条张口就是「代码里根本不读头像」。
             * 根因是上面几行只教了「有产出文件就说路径」，没有一句管
             * 「你打的字会直接进 QQ」——出站清洗是兜底，这里要把话讲在前面。
             */
            '',
            '## 你说的话会原样发到 QQ',
            '所以：不贴代码块、不贴 JSON、不贴命令输出原文，也别提 message_id / user_id / 工具名这类内部字段。',
            '<acp> 这种尖括号标记是系统内部的东西，绝对不能出现在你的话里。',
            '汇报用聊天口吻，一两句话说清「做了什么、结果咋样」。文件路径最多给一个，别把路径刷屏。',
            /*
             * 2026-10-20 用户 m03551：「命令查询的返回不用润色+拆分发送」。
             * 她要的是查到的那个东西本身，不是 Molly 嚼过一遍的版本。
             */
            '例外：**查询类**的（查天气、查人、查群、查资料、这是什么）——把查到的东西原样摆出来，',
            '不要加开场白、不要加感想、不要改写成卖萌口吻，也不要替她总结成一句俏皮话。',
            '多长都一次说完，别自己拆成好几条。',
            '讲原理就讲人话，别张口「代码里…」——那是在念实现，不是在回主人的问题。',
            /*
             * task-41（2026-10-20）：干活会话和主会话原本共用宿主工作区，
             * 群里一句「命令 帮我改一下」就能直接改项目源码。现在 cwd 锁到
             * ${MOLLY_ROOT}\sandbox\qq-work，人设这半段把边界讲死；代码层还有
             * installWorkGuard() 的 tools.guard 兜底，不靠模型自觉。
             */
            '',
            '## 你的工作目录只有沙箱',
            '你唯一的工作目录是 `G:\\Molly\\sandbox\\qq-work`。要建文件、写脚本、放产物，都放这里。',
            '**不许读写**这三个地方：`G:\\Molly\\qq-whale`（Molly 自己的插件源码）、',
            '`D:\\Documents\\deepseek-harness`（宿主/项目工作区）、`C:\\Users\\example\\.dsh`（宿主配置和会话数据）。',
            '你的产物可以随便读写，但那是沙箱里的路径。',
            '',
            '## 改 Molly 自己的代码 → 一律不执行',
            '任何「改 Molly 的代码 / 插件 / 配置 / 人设 / 提示词」的请求，**不要动手**，也不要试图用别的工具绕过去。',
            /*
             * bug2（2026-10-20）：原来这里写「真实情况是：已经被拦下并私聊报给主人了」，
             * 模型就照念这句话，可它一次工具都没调、护栏压根没触发 ⇒ 主人什么也没收到。
             * 现在只把「如实说什么」讲清楚，是否真上报由代码判定（见 _runOnce 兜底）。
             */
            `如果工具层已经拒了你（会明确告诉你"已拦下"），就直接回它给你的那句：${REVIEW_REPLY}`,
            '否则（你压根没动手）就说人话：这属于改 Molly 自己的代码，我做不了，得主人点头——不要说你已经报给主人了。',
            '说「已上报给主人」这句话之前先想一遍：你是不是真的被工具层拦下了。没被拦下就别这么说。',
            /*
             * task-44（2026-10-20）：worker 调 ask_user_question 后整个 session
             * 永久挂住——QQ 后台没有人能点那个弹窗，后面的命令全部排队超时。
             * 能力层已经用 tools.restrict 把这个工具从工具面里拿掉，这里再讲一遍
             * 行为准则：遇到歧义自己做决定，别等人回答。
             */
            '',
            '## 你没有人可问',
            '你跑在 QQ 后台，**没有任何界面能让主人回答你的提问**。',
            '所以：永远不要调用 ask_user_question（以及任何需要人点确认的工具）。',
            '遇到歧义就按你认为最合理的理解直接干，干完在结果里用一句话说明你的假设，',
            '比如「我按 A 方案做的，因为 B 需要你确认」。宁可做错一个可回滚的小步，也不要停下来等人。',
            /*
             * task-50（2026-10-20 真机）：用户在控制台对 work 会话说「在
             * ${MOLLY_ROOT}\sandbox 下建一个文件夹 test1」，模型连续调了 5+ 次
             * working_directory ${MOLLY_ROOT}\sandbox，一边道歉一边继续调同一个。
             * 根因不是它不想换，是它不知道「这条会话没有写工具」。
             */
            '',
            isCode
              ? '## 写文件是本会话的本职'
              : '## 这条会话没有写工具——要写文件请让用户走改代码那条',
            ...(isCode
              ? [
                  '沙箱里的文件你可以直接写；`G:\\Molly\\qq-whale` 等项目源码受审核保护，',
                  '被拦下时把工具给的审核话术原样回给用户，不要换个工具再试。',
                ]
              : [
                  '你**没有** write / edit / apply_patch，也就没有任何办法建目录、写文件、改文件。',
                  '遇到「建文件夹 / 建文件 / 改文件 / 写脚本 / 装依赖」这类请求，**不要试探工具**',
                  '（working_directory、read、glob、pwsh 都不是写工具，试多少次都不会成功），',
                  '直接用一句话告诉用户：',
                  '「这个得走改代码那条——把消息写成 `#code 在 G:\\Molly\\sandbox 下建一个 test1 文件夹`，',
                  '那条会话才有写权限。」',
                  '说过就停，不要反复解释，也不要假装已经建好了。',
                ]),
            '',
            '## 工具用法：不许死循环',
            '同一个工具、同样的参数，**最多试两次**。第二次没给你新信息就换办法。',
            '第三次开始系统会直接拦你；被拦后不要换个说法再试同一个工具，要么换一条完全不同的路，',
            '要么直接告诉用户「这条路我走不通」。',
            '',
            '## 正文里不许出现宿主标记',
            '`<acp tokens="…" type="text">m00085</acp>`、裸的 `m00085` 这类是宿主内部的事件引用，',
            '不是给人看的内容。你的回复正文里出现它们＝格式错误，会被系统剥掉。',
            '只输出自然语言。工具回执里的 id（message_id 等）也不要往正文里抄。',
          ].join('\n'),
        })
      } catch (err) {
        this.logger('debug', `挂 worker 人设失败（不影响执行）：${err?.message || err}`)
      }
      /*
       * task-44/46：从工具面里拿掉不该出现的工具（能力层，不只是提示词）。
       * - work（查询）：**无写工具**。写盘必须走 code 会话；查询只需要 qq_onebot、
       *   检索、只读文件工具。
       * - code（改代码）：全套工具，但写盘仍受 work-guard 的受保护路径 DENY。
       * tools.restrict 只影响这一个 agent 的可见工具面，名字不存在会抛错
       * （不同宿主版本工具面不同），所以逐个试、失败只 debug。
       */
      try {
        const toolsApi = agent?.ctx?.tools || agentCtx?.tools
        if (toolsApi?.restrict) {
          const deny = new Set(INTERACTIVE_TOOLS)
          for (const name of this.denyToolsForRole(role)) deny.add(name)
          const blocked = []
          for (const name of deny) {
            try {
              toolsApi.restrict({ deny: [name] })
              blocked.push(name)
            } catch (err) {
              this.logger('debug', `屏蔽工具 ${name} 失败（可能本宿主没有它）：${err?.message || err}`)
            }
          }
          if (blocked.length > 0) {
            this.logger('info', `干活会话(${role})已从工具面移除：${blocked.join('、')}`)
          }
        }
      } catch (err) {
        this.logger('debug', `工具面屏蔽失败（有 guard 兜底）：${err?.message || err}`)
      }
      // 人设之外的第二道：工具调用层的同步护栏（写受保护前缀直接拒绝）。
      // 优先挂在 agent 自己的 ctx 上：DSH 文档明确「通过 agent.ctx 注册的 guard
      // 只作用于那一个 agent」，这样主会话/其它 agent 完全不受影响。
      this.installWorkGuard(agent?.ctx || agentCtx)
    }
  }

  /**
   * 拿（或建）那个常驻的干活会话。
   *
   * 为什么复用而不是每条命令新开：Molly 需要记得「我上次给他做的是什么」。
   * 新开 session 每次都从零开始，会变成只会执行单条命令的工具人。
   *
   * 为什么还要 resume：会话是落盘的（`~/.dsh/sessions/<workspace>/qq-whale-work-*`）。
   * 插件重载、DSH 重启之后，那个 sessionId 在存储里**依然存在**，这时再
   * create 会直接抛 `session "..." already exists` —— 于是命令链路静默变成
   * 「执行失败」，而且每次重启后都会复现。所以先 create，撞到"已存在"就
   * 改用 resume 把旧会话接上，这样"记得上次干过什么"才真的成立。
   */
  async ensureHandle() {
    const ctx = this.ctx
    const agents = this.pickService('agents')
    if (!agents?.create) {
      throw new Error('DSH 没有 agents 服务，无法执行指令')
    }
    if (!ctx) throw new Error('拿不到 cordis ctx，无法执行指令')

    const sessionId = this.workSessionId()
    this.lastSessionId = sessionId

    /*
     * ⚠️ 缓存的句柄必须先验活（2026-10-18 真机，用户 m19598 截图）。
     *
     * 症状一：QQ 里先蹦出「执行失败：任务已投递但 agent 没有启动（wakeDriver 未生效）」。
     * 症状二：下一句变成
     *   SessionAlreadyOwnedError: session "qq-whale-work-111111111"
     *   is already owned by an active write handle
     *   at JsonlBackendTracker.claimWrite
     *      (.../dsh-session-persistence-jsonl/lib/index.js:315:35)
     *
     * 两个症状是同一个根：`this.handle` 指向的 agent 已经被拆掉了，字段还留着。
     * 死句柄上 followup() 是**空操作**——不抛错、也不唤醒 driver，于是
     * activityDone 永远不变，被误判成「wakeDriver 没生效」；等插件重载换了实例，
     * 新实例 resume 同一个 session 时，旧实例泄漏的写句柄仍然占着 claimWrite，
     * 于是抛 SessionAlreadyOwnedError。
     *
     * 所以：**agents 注册表才是唯一权威**，`this.handle` 只是缓存。插件重载、
     * 宿主崩溃恢复之后，它随时可能是幽灵。句柄里的 agent 还在活表里才复用。
     */
    const liveNow = this.liveAgent(agents, sessionId)
    if (this.handle) {
      if (liveNow && liveNow === this.handle.agent) return this.handle
      this.logger('warn', `干活会话句柄已失效（${sessionId} 不在活 agent 表里），丢弃重建`)
      this.handle = null
    }
    /*
     * 同名会话已经有活 agent（上次卸载没拆干净，或另一个实例建的）：
     * 直接接上，别再 create/resume 一次把写锁撞飞。dispose 给个空函数——
     * 这个 agent 不是我们建的，我们没资格拆它。
     */
    if (liveNow) {
      this.handle = { agent: liveNow, dispose: async () => {} }
      this.lastError = ''
      this.installErrorTap(this.handle)
      this.logger('info', `接上已在运行的干活会话：${sessionId}`)
      return this.handle
    }
    /*
     * 会话用哪个模型（task-46：每会话独立）。
     *
     * 配置形状（main.js DEFAULTS / schema）：
     *   chatModel / workModel / codeModel: { provider, model, reasoningEffort? }
     * 兼容老配置：workModel 以前是**字符串**（只写模型名），这里两种都认；
     * workProvider 也继续兜底。形状统一交给 modelSpec()。
     */
    const agentOptions = this.modelSpec(this.role)
    if (this.config.maxTokens) agentOptions.maxTokens = this.config.maxTokens
    const setup = this.workerSetup(this.role)

    /*
     * meta.cwd 是必须的，别省。
     *
     * 踩坑记录（2026-10-17，真机报错原文）：
     *     prompt variable "{{cwd}}" has no value for this assembly
     *     (section "deployment:persona-suffix")
     *
     * dsh-agent-loop 装配系统提示词时注册三个变量（lib/index.js:1564-1566）：
     *     provider ← context.agent?.options.provider
     *     model    ← context.agent?.options.model
     *     cwd      ← context.agent?.session.header.cwd
     * 而 header.cwd 只从 create 的 meta 进来：sessions.prepare(id, { meta })
     * （lib/index.js:1788）。我们原来调 agents.create({sessionId, agentOptions,
     * setup}) 时 **meta 是 undefined**，于是 header.cwd 也是 undefined，
     * 装配那一刻 {{cwd}} 直接抛错。这个错误又被 kick() 的空 catch 吞掉
     * （lib/index.js:887-890），QQ 里只剩一句「干完了，但没说话」。
     */
    const workCwd = this.pickWorkCwd()

    this.logger(
      'info',
      `创建干活会话 ${sessionId}（${agentOptions.provider}/${agentOptions.model} @ ${workCwd}）`,
    )
    try {
      this.handle = await this.openWorkSession(agents, {
        sessionId,
        agentOptions,
        setup,
        workCwd,
      })
      this.lastError = ''
      this.installErrorTap(this.handle)
      this.logger('info', `干活会话已就绪：${this.handle.sessionId || sessionId}`)
      return this.handle
    } catch (err) {
      this.lastError = String(err?.stack || err?.message || err)
      this.logger('warn', `建干活会话失败：${this.lastError}`)
      throw err
    }
  }

  /**
   * 活 agent 表里有没有这个 session。
   *
   * 这是判断「句柄还作不作数」的**唯一权威**：`this.handle` 是我们自己的缓存，
   * 插件重载、宿主崩溃恢复之后它可能指向一个早就被拆掉的 agent，
   * 而这种死句柄不会抛错——只会在 followup 时安静地什么也不做。
   */
  liveAgent(agents, sessionId) {
    try {
      const get = agents?.get
      if (typeof get !== 'function') return undefined
      return get.call(agents, sessionId) || undefined
    } catch {
      return undefined
    }
  }

  /**
   * 开会话：create → 已存在就 resume；写锁被占就等一会儿重试；
   * 三轮都抢不到（旧实例泄漏了写句柄，进程内已经没人能释放它）就换一个
   * 新 sessionId 重开，保证**命令至少还能用**，不会永久卡死。
   */
  async openWorkSession(agents, { sessionId, agentOptions, setup, workCwd }) {
    const isWriteLocked = (err) =>
      /already owned by an active write handle|claimWrite|SessionAlreadyOwned/i.test(
        String(err?.message || err),
      )
    const base = sessionId
    /*
     * task-46：work 会话（`qq-whale-work-<selfId>`）里有 200+ 轮历史，**绝不
     * rename/delete/重建**。所以先只试原 id；万一写锁被一个泄漏的旧句柄占死
     * （重试 3 次都拿不到），才退到 `<id>-b` 重开一个新会话保命令链路不死。
     * 这是**降级**：原会话文件和历史原样留在磁盘上，只是这一轮接不上它——
     * 日志里会明确写「降级到 xxx」，方便排查。
     * code 是新建会话，本来就没有历史，允许 `-b`/`-c`。
     */
    const candidates = [base, `${base}-b`, `${base}-c`]
    let lastErr = null
    for (let ci = 0; ci < candidates.length; ci += 1) {
      const id = candidates[ci]
      if (ci > 0) {
        this.logger(
          'warn',
          `会话 ${base} 抢不到写锁（${lastErr?.message || lastErr}），降级到 ${id} 继续跑；` +
            `${base} 的历史原样留在磁盘上，没有改名也没有删除`,
        )
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const live = this.liveAgent(agents, id)
        if (live) return { agent: live, dispose: async () => {}, sessionId: id }
        try {
          const handle = await agents.create({
            sessionId: id,
            agentOptions,
            setup,
            meta: { cwd: workCwd },
          })
          return Object.assign(handle, { sessionId: id })
        } catch (err) {
          lastErr = err
          if (isWriteLocked(err)) {
            this.logger('warn', `会话 ${id} 写锁被占（第 ${attempt + 1} 次），等待后重试`)
            await sleep(400 * (attempt + 1))
            continue
          }
          if (!/already exists/i.test(String(err?.message || err))) throw err
          // 旧会话还在磁盘上：接上它，别把它当故障
          try {
            const handle = await agents.resume({
              resumeSessionId: id,
              agentOptions,
              setup,
            })
            return Object.assign(handle, { sessionId: id })
          } catch (err2) {
            lastErr = err2
            if (isWriteLocked(err2)) {
              this.logger('warn', `会话 ${id} 恢复时写锁被占（第 ${attempt + 1} 次），等待后重试`)
              await sleep(400 * (attempt + 1))
              continue
            }
            throw err2
          }
        }
      }
      if (ci < candidates.length - 1) {
        this.logger('warn', `会话 ${id} 的写锁释放不掉，改用新 id 重开`)
      }
    }
    throw lastErr || new Error('干活会话开不出来')
  }

  /**
   * 挑一个真实存在的干活目录。
   *
   * 顺序：主人显式配置的 workCwd → 宿主进程 cwd → 用户主目录。
   * 必须**真实存在**：session header 里的 cwd 会被下游用于解析相对路径，
   * 给个不存在的目录只会在后面别的环节炸，更难查。
   */
  /**
   * 给干活会话挂工具护栏（task-41 的 B 项）。
   *
   * 用的是 DSH 的 `tools.guard(fn)`：同步、单调、返回字符串即拒绝，且
   * 后续没有任何监听器能把拒绝翻回允许。通过 agent 的 ctx 注册 → 只作用于
   * 这个 agent，不会影响主会话和其它插件。
   *
   * 为什么不在 web/engine 层做字符串检查：那样只能拦「任务描述里写了路径」
   * 的情况；agent 完全可以第一轮先 glob 找到文件、第二轮再 write。只有
   * 工具调用本身知道它到底要写哪个路径。
   */
  installWorkGuard(agentCtx) {
    try {
      this._workGuardDispose?.()
    } catch {
      /* 旧 agent 已经没了，注销失败无所谓 */
    }
    this._workGuardDispose = null
    let tools = null
    try {
      tools = agentCtx?.tools || (typeof agentCtx?.get === 'function' ? agentCtx.get('tools') : null)
    } catch {
      tools = null
    }
    if (!tools?.guard) {
      this.logger('warn', '工具护栏没装上（宿主没有 tools.guard），只剩人设约束')
      return false
    }
    try {
      const workId = String(this.lastSessionId || '')
      this._workGuardDispose = tools.guard((exec) => {
        /*
         * 纵深防御：万一把 guard 挂成了全局的（宿主版本差异），这里再按会话
         * 兜一层——不是干活会话就一律放行，主会话写自己的代码不受影响。
         */
        const ag = exec?.agent
        if (workId && ag) {
          const sid = String(ag?.session?.id || ag?.sessionId || ag?.id || '')
          if (sid && !sid.startsWith(workId)) return undefined
        }
        // task-50：先查死循环（同一工具同参数反复出现），再查受保护路径
        const loop = this.checkToolLoop(exec)
        if (loop) return loop
        const hit = scanToolCall(exec)
        if (!hit.deny) return undefined
        const cmd = this.currentCommand || {}
        this._escalations.push({
          task: String(cmd.task || ''),
          fromUin: String(cmd.fromUin || ''),
          groupId: String(cmd.groupId || ''),
          paths: hit.paths,
          tool: hit.tool || '',
        })
        this.logger(
          'warn',
          `拦截写受保护路径：tool=${hit.tool || '?'} paths=${hit.paths.join(',')} task=${String(cmd.task || '').slice(0, 60)}`,
        )
        return hit.reason
      })
      this.logger('info', '干活会话工具护栏已挂上（受保护前缀的写操作会被拦下转审核）')
      return true
    } catch (err) {
      this.logger('warn', `工具护栏挂载失败：${err?.message || err}`)
      return false
    }
  }

  /**
   * 命令预检：这条任务明显要改受保护路径吗？
   * 命中就不必启动 agent（省几十秒、也避免先发一句开工语）。
   */
  prescreenTask(task) {
    return prescreenTask(task)
  }

  /** 预检命中后的上报：落 pending-code + 私聊主人，返回该回的固定话术。 */
  async escalateTask(task, hit = {}) {
    this._escalations.push({
      task: String(task || ''),
      fromUin: String(this.currentCommand?.fromUin || ''),
      groupId: String(this.currentCommand?.groupId || ''),
      paths: hit.paths || [],
      tool: hit.tool || 'task-text',
    })
    await this.handleEscalations()
    return REVIEW_REPLY
  }

  /**
   * 把本轮被拦下的请求落进 pending-code.json 并私聊通知主人。
   * 只做「报告」，不自动放行 —— 放行必须由主会话/控制台里的人决定。
   */
  async handleEscalations() {
    if (!Array.isArray(this._escalations) || this._escalations.length === 0) return false
    const items = this._escalations.slice()
    this._escalations = []
    const paths = [...new Set(items.flatMap((x) => x.paths || []))]
    const first = items[0] || {}
    const dataDir = this.config?.dataDir || this.config?.memoryDir || ''
    let entry = null
    try {
      entry = recordPending({
        dataDir,
        fromUin: first.fromUin,
        groupId: first.groupId,
        task: first.task,
        targetPaths: paths,
        logger: this.logger,
      })
    } catch (err) {
      this.logger('warn', `待审核记录落盘失败：${err?.message || err}`)
    }
    await this.notifyOwnerEscalation({ ...first, paths, id: entry?.id || '' })
    return true
  }

  /** 私聊主人：谁、在哪、想改什么、被拦下的路径。失败只记日志。 */
  async notifyOwnerEscalation({ fromUin, groupId, task, paths = [], id = '' } = {}) {
    const owner = String(this.config?.ownerUin || '')
    const client = this.engine?.client
    if (!owner || !client?.sendPrivateMsg) {
      this.logger('warn', `护栏拦下请求，但没有可用的私聊通道通知主人（owner=${owner || '未配置'}）`)
      return false
    }
    const where = groupId ? `群 ${groupId}` : '私聊'
    const text =
      `【代码改动待审核】${fromUin || '有人'} 在${where}让我改 Molly 自己的代码，我拦下了。\n` +
      `任务：${String(task || '').slice(0, 300)}\n` +
      `目标：${paths.slice(0, 5).join('、') || '(未识别到具体文件)'}` +
      (id ? `\n待办编号：${id}（控制台 pending-code.json）` : '')
    try {
      /*
       * 用数组消息 + auto_escape=true：installReportCapture 只接「字符串且无
       * auto_escape」的工具式发送，这条审核通知不能被并进命令结果里。
       */
      await client.sendPrivateMsg(owner, [{ type: 'text', data: { text } }], true)
      this.logger('info', `已私聊通知主人有一条代码改动待审核（${id || '无编号'}）`)
      return true
    } catch (err) {
      this.logger('warn', `通知主人失败（不影响拦截）：${err?.message || err}`)
      return false
    }
  }

  pickWorkCwd() {
    /*
     * 顺序很重要：
     *   显式 config.workCwd（老配置，服从用户）
     *   → config.workSandboxDir（新配置键）
     *   → WORK_SANDBOX_DIR（默认沙箱）
     * **不再有 process.cwd() / homedir() 兜底**：那正是干活会话跑到宿主
     * 工作区（项目源码目录）的原因。目录不存在就当场建出来。
     */
    const candidates = [this.config.workCwd, this.config.workSandboxDir, WORK_SANDBOX_DIR]
    for (const c of candidates) {
      if (!c) continue
      try {
        fs.mkdirSync(c, { recursive: true })
        if (fs.statSync(c).isDirectory()) return c
      } catch (err) {
        this.logger('warn', `干活目录不可用（${c}）：${err?.message || err}`)
      }
    }
    // 连沙箱都建不出来时才退到这，至少能跑；日志会留痕。
    this.logger('warn', `沙箱目录全部不可用，干活会话退到临时目录：${os.tmpdir()}`)
    return os.tmpdir()
  }

  /**
   * 在 agent 上装一个「错误探针」。
   *
   * 为什么必须这么做（这一段是本项目最贵的一课）：
   * dsh-agent-loop 的 kick() 长这样（lib/index.js:887-890）——
   *
   *     async kick() {
   *       try { while (await this.turn()); }
   *       catch (_error) {}        // ← 异常被空 catch 吞掉
   *       finally { ...setPhase('idle')... }
   *     }
   *
   * 也就是说，模型报错、工具报错、请求头被拒……全都只会表现为
   * 「driver 立刻回到 idle」。外部看到的症状是 whenIdle() 秒回、
   * readLastAssistant 读到空，最后发出去一句「干完了，但没说话」。
   * 会话日志里也什么都没有（实测 derivedCount: 0）。
   *
   * 唯一在吞掉之前会经过的地方是 throwError()：
   *     throwError(error) { this.dispatch.emit('agent/error', {...}); throw error }
   * 它 emit 的事件是异步派发、自己也会被包一层 catch，而这条事件
   * 在本进程里没人监听 —— 于是错误彻底蒸发。
   *
   * 这里就是那个监听者：把错误原文记到 this.lastAgentError，
   * 让失败能一路报回 QQ，而不是变成一句"没说话"。
   */
  installErrorTap(handle) {
    const agent = handle?.agent
    if (!agent || agent.__qqWhaleTapped) return
    const original = agent.throwError
    if (typeof original !== 'function') return
    const self = this
    agent.__qqWhaleTapped = true
    agent.throwError = function tappedThrowError(error) {
      try {
        self.lastAgentError = {
          at: Date.now(),
          message: String(error?.message || error),
          stack: String(error?.stack || '').slice(0, 2000),
        }
        self.logger('warn', `干活会话内部报错：${self.lastAgentError.message}`)
      } catch {
        /* 探针自身不许出错 */
      }
      return original.call(this, error)
    }
  }

  /**
   * 跑一个任务，返回最终文本。
   * 会阻塞到 agent 空闲为止（whenIdle）。
   *
   * 传了 `onProgress(sendFn)` 时会在执行期间盯这个会话的 todos 投影，
   * 清单一变就往 QQ 推一条——这是"实时更新任务清单"的实现点。
   */
  /**
   * 命令入口：同一个干活会话**串行**跑。
   *
   * 为什么必须串（真机实测，2026-10-18 16:12）：
   * 两条命令几乎同时进来时，两次 followup 都排进同一个 inbox，
   * 后一条的 whenIdle() 会在**前一条**那一轮结束时返回 —— 于是两条命令
   * 都 readLastAssistant() 读到同一段回答，用户看到同一句话被回了两次。
   * 串行化之后每条命令对应自己那一轮，文本才对得上。
   */
  async run(task, opts = {}) {
    const prev = this._chain || Promise.resolve()
    const next = prev.then(
      () => this._runOnce(task, opts),
      () => this._runOnce(task, opts),
    )
    // 队列不能因为某一条失败而断掉
    this._chain = next.then(
      () => {},
      () => {},
    )
    return next
  }

  async _runOnce(task, { onProgress, meta = null } = {}) {
    // task-43：本次请求来自谁（工具层拿不到身份，这里只留痕 + 供人设/排查用）
    this.lastCommandMeta = meta && typeof meta === 'object' ? { ...meta } : null
    const id = randomUUID()
    const started = Date.now()
    /*
     * task-44：上一条命令如果已经卡死太久（典型是卡在没人能回答的弹窗上），
     * 这一条在开始前先把它取消掉。不这样做的话，_chain 上挂着的那个 Promise
     * 永远不会 settle，后面每条命令都会排在它后面一路超时。
     */
    await this.releaseStuckRun()
    // task-50：每条命令一个干净的死循环账本
    this.resetLoopGuard()
    this.running = { id, task, startedAt: started }

    /*
     * ensureHandle() 必须在 try 里面。
     *
     * 这里踩过一个很难查的坑（用户 m03864：「私聊命令只出开工语，永远没有结果」）：
     * 原先是
     *     const handle = await this.ensureHandle()   // ← 在 try 外面
     *     try { ... } catch { return {ok:false, ...} }
     * 于是 ensureHandle 抛错时 run() 直接 throw，压根走不到 catch，
     * 也就不可能返回那条「执行失败：xxx」的消息。而调用方 runCommand()
     * 当时只有 try/finally 没有 catch，异常一路上浮被 .catch 吞成一行日志。
     * 用户在 QQ 里看到的就只剩那句随机开工语——永远等不到下文。
     *
     * 现在建会话失败会被包成正常的失败结果，能一路发到 QQ 里。
     */
    try {
      const handle = await this.ensureHandle()
      const agent = handle.agent

      /*
       * 开工语：默认**不发**。
       *
       * 原先这里无条件先发一句「收到，我列一下要干啥。」，真机上造成两种毛病：
       *   1. 主人收到两个气泡：先是这句（seq 529），几十秒后才是结果（seq 530）；
       *      现场还有 seq 543 → 544 隔了 63 秒才补上真正结果；
       *   2. 有些命令只出了这句就再没下文（真正的失败原因被吞，见下面 readLastAssistant）。
       *
       * 「收到了」这件事已经由 tryCommand 里的 👌 表情回应（tapEmoji）做了；
       * 干活过程中的清单更新由 progress.js 节流推送。这句纯属噪音，所以默认关掉。
       * 想看旧行为：config.commandAck = true。
       */
      if (typeof onProgress === 'function' && this.config?.commandAck === true) {
        try {
          await onProgress(`收到，我列一下要干啥。`)
        } catch {
          // 播报失败不影响干活
        }
      }

      /*
       * 投递前先判断 agent 是不是**本来就忙**。
       *
       * 旧代码写的是 `agent.activity !== agent.activityDone`，但 AgentLoop 上
       * 根本没有 `activity` 这个字段（只有 `activityDone`），于是 wasBusy
       * 永远是 false —— 把「在忙」误判成「死了」，用户就看到那句
       * 「wakeDriver 未生效」。真正的公开状态是 `status`：
       *
       *   - 'running'：正跑着（含 maintenance）。followup 只会把消息插进
       *     inbox 并锁存 wakeRequested（dsh-agent-loop/lib/index.js:854-857），
       *     activityDone **不会变**，等这一轮 kick() 结束才接力起新 driver。
       *     —— 这不是故障，是正常的排队。
       *   - 'idle'：wakeDriver 同步装上新 promise（:859-868），activityDone 变。
       *
       * 而且必须在 followup **之前**取，投递后再看就已经晚了。
       */
      const busyBefore = agent.status === 'running'
      /*
       * 再记下「投递前」的 activityDone。
       *
       * whenIdle() 是 `do await activityDone while (activity !== activityDone)`：
       * 它等的是**此刻**挂着的那个 driver promise。如果 agent 已经空闲，
       * 这个 promise 是早已 resolve 的旧值 —— 于是 followup 一进去、
       * wakeDriver 还没来得及把新 promise 装上，whenIdle 就已经返回了。
       * 实测症状就是 24ms 就"干完了，但没说话"。
       *
       * 所以这里先拿旧值，投递后**轮询等它变**，变了再等它落定。
       */
      const before = agent.activityDone

      /*
       * ⚠️ role 不能省。
       *
       * followup() 的消息会被原样 append 成 `user/message` 事件的 data，
       * 而 dsh-session 的 adoptSessionEvent 会按事件类型校验 role：
       *   MESSAGE_ROLE_BY_TYPE = { "user/message": "user", ... }
       * 缺了 role 的那条照样能写进日志（写入时不做这项校验），但**下次
       * resume 读回来时**校验失败：
       *   stored session "..." failed validation:
       *   session event at seq 8 message must have role "user"
       * 于是整个干活会话永久损坏，只能删掉重建。
       *
       * 之前这里只有 { id, content, source }，正好踩中。顺着 DSH 自己写的
       * runtime-context 消息抄结构最稳 —— 它的 data 是
       *   { content, source, role: "user", id }
       */
      agent.followup({
        role: 'user',
        id,
        content: [{ type: 'text', text: task }],
        source: { kind: 'user' },
      })

      const timeoutMs = Math.max(60000, (this.config.commandTimeoutMinutes ?? 15) * 60000)
      /*
       * task-44：单轮硬上限。原来只受 commandTimeoutMinutes（默认 15 分钟）约束，
       * 撞上「模型在等一个没有人能点的弹窗」时，主人要等 15 分钟、期间所有命令
       * 排队。取 min(整体超时, 180s) 之后，最坏 3 分钟就能拿到一句人话并释放会话。
       */
      const turnTimeoutMs = this.turnTimeoutMs()
      const deadline = Math.min(started + timeoutMs, Date.now() + turnTimeoutMs)

      if (!busyBefore) {
        // 等 driver 换上新 promise（wakeDriver 是同步的，但给一点余量）
        let spins = 0
        while (agent.activityDone === before && Date.now() < deadline && spins < 200) {
          await sleep(25)
          spins += 1
        }
        if (agent.activityDone === before) {
          /*
           * 空闲状态下投递了却没唤醒 driver —— 这才是真的没启动。
           * 先分清两种可能：句柄已经死了（agent 被拆掉，followup 是空操作），
           * 还是活着但 driver 没接上。
           */
          const live = this.liveAgent(this.pickService('agents'), this.lastSessionId)
          if (!live || live !== agent) {
            /*
             * 死句柄：agent 已经被拆掉，followup 是空操作。
             * 关键动作是**把句柄清掉**，否则后面每条命令都会撞同一具尸体，
             * 而且下次 resume 会撞上旧实例泄漏的写锁（SessionAlreadyOwnedError）。
             */
            this.handle = null
            throw new Error('干活会话已失效（agent 不在运行中），我已经重置，你再发一次命令就好')
          }
          throw new Error(
            `任务已投递但 agent 没有启动（wakeDriver 未生效，status=${agent.status}）`,
          )
        }
      }
      /*
       * busyBefore=true 时不轮询：消息已经排进 inbox 并锁存了 wakeRequested，
       * 当前这一轮 kick() 结束时会自动接力。whenIdle() 的 do/while 会盯住
       * activityDone 的换代，所以直接等它落定就够了。
       */
      let timedOut = false
      try {
        await Promise.race([
          agent.whenIdle(),
          sleep(Math.max(1000, deadline - Date.now())).then(() => {
            throw new Error(`执行超时（${Math.max(1, Math.round(turnTimeoutMs / 60000))} 分钟）`)
          }),
        ])
      } catch (err) {
        if (!/超时/.test(String(err?.message || ''))) throw err
        timedOut = true
      }

      if (timedOut) {
        /*
         * task-44：超时不能只抛错让上层回「执行失败」——那一轮 agent 还在跑，
         * 会话依然被占着。必须 cancel 掉这一轮（agent.cancel 会 abort 当前 phase，
         * 卡在 ask_user_question 上也能解开），然后回一句人话。
         */
        const cancelled = await this.cancelRunning('单轮超时，取消这一轮')
        const elapsed = Date.now() - started
        this.lastResult = { id, task, text: WORK_STALL_REPLY, elapsed, ok: false, timedOut: true }
        this.logger(
          'warn',
          `命令超时（${Math.round(turnTimeoutMs / 1000)}s，cancel=${cancelled ? 'ok' : 'fail'}），已放出卡住提示`,
        )
        return this.lastResult
      }

      /*
       * task-50：本轮触发过工具死循环收口（同调用连续第 4 次）→ 不再读模型
       * 那些「抱歉我又重复了」的废话，直接回一句人话。
       */
      if (this._loopTripped) {
        const elapsed = Date.now() - started
        this._loopTripped = false
        this.lastResult = { id, task, text: LOOP_ABORT_REPLY, elapsed, ok: false, loopAborted: true }
        this.logger('warn', `工具死循环收口（${(elapsed / 1000).toFixed(1)}s），已回「走不通」`)
        return this.lastResult
      }

      let text = this.readLastAssistant(agent, task)
      /*
       * 定位到自己的 followup、但它那一轮还没产出时，再给一点时间，
       * 不要立刻退回「随便读最后一条 assistant」——那正是答非所问的来源。
       * 上限 20 秒（远小于 commandTimeoutMinutes 的整体超时）。
       */
      if (!text) {
        const settleUntil = Math.min(deadline, Date.now() + 20000)
        while (!text && Date.now() < settleUntil) {
          await sleep(200)
          text = this.readLastAssistant(agent, task)
        }
      }
      /*
       * task-41：本轮只要有工具调用被护栏拦下，对外就用固定审核话术，
       * 不采用模型临场编的解释（真机上它会把「要过审核」说成「我做不到」）。
       * handleEscalations 同时落 pending-code.json 并私聊主人，失败不影响答复。
       */
      /*
       * bug2 兜底：模型可能只念了审核话术、没真的被拦下（人设里那句话原本就教它这么讲）。
       * 既然已经对外承诺「报给主人了」，就必须真的报一次——落 pending-code.json + 私聊主人，
       * 否则主人永远收不到（真机实测 pending-code.json 从来不存在）。
       */
      if (
        (!Array.isArray(this._escalations) || this._escalations.length === 0) &&
        text && String(text).includes(REVIEW_REPLY.slice(0, 8))
      ) {
        this._escalations = [
          {
            task: String(task || ''),
            fromUin: String(this.currentCommand?.fromUin || ''),
            groupId: String(this.currentCommand?.groupId || ''),
            paths: [],
            tool: 'model-claim',
          },
        ]
      }
      if (Array.isArray(this._escalations) && this._escalations.length > 0) {
        try {
          await this.handleEscalations()
        } catch (err) {
          this.logger('warn', `审核上报失败（不影响拦截）：${err?.message || err}`)
        }
        text = REVIEW_REPLY
      }
      if (!text) text = PLACEHOLDER_NO_TEXT
      const elapsed = Date.now() - started
      /*
       * 「干完了但没说话」不能算成功。
       *
       * 真机上这条占位文字会被原样发到 QQ 里，用户看到的就是机器人
       * 说"（干完了，但没说话）"——比报错还莫名其妙。真正的原因
       * 基本都在 driver 里被 kick() 的空 catch 吞了，而我们刚装的
       * errorTap 把原文留在了 lastAgentError 里，这里把它翻出来。
       */
      if (text === PLACEHOLDER_NO_TEXT) {
        const why = this.lastAgentError?.message || ''
        this.lastResult = {
          id,
          task,
          text: why
            ? `执行失败：${why}`
            : '执行失败：会话没有产出任何内容（可能是模型或工具报错，但错误没有留下来）',
          elapsed,
          ok: false,
        }
        this.logger('warn', `指令没有产出文本：${why || '原因未知'}`)
        return this.lastResult
      }
      this.lastResult = { id, task, text, elapsed, ok: true }
      this.logger('info', `指令执行完毕（${(elapsed / 1000).toFixed(1)}s）：${task.slice(0, 40)}`)
      return this.lastResult
    } catch (err) {
      const elapsed = Date.now() - started
      const msg = err?.message || String(err)
      this.lastResult = { id, task, text: `执行失败：${msg}`, elapsed, ok: false }
      // 用 warn 而不是 debug：这类失败必须能在宿主日志里看见，
      // 否则又会变成"只出一句开工语就没了"的哑巴故障。
      this.logger('warn', `指令执行失败：${msg}`)
      return this.lastResult
    } finally {
      // task-44：被下一条命令「接管」时（running 已经换成新的 id），不能把它清掉。
      if (this.running?.id === id) this.running = null
    }
  }

  /**
   * 这条 user 消息是不是「宿主自己塞进来的元信息」，而不是一个真实轮次。
   *
   * 真机 2026-10-20（qq-whale-work-v2-111111111）：followup 之后宿主立刻插了
   * 一条 runtime-context 快照 user 消息（source.kind='runtime-context'，
   * form='snapshot'），assistant 的实际回复落在它后面。旧边界把它当成
   * 「下一条 user」，区间 (mine, nextUser) 里没有 assistant → 返回 '' →
   * 上层报「会话没有产出任何内容」。
   *
   * **不能**把所有 source 非 'user' 的都当元信息：定时提醒（scheduled
   * reminder）的 user 消息根本没有 source 字段，它是货真价实的另一个轮次，
   * 必须继续当边界（否则 2026-10-20 09:26 的「答非所问」会复发）。
   * 只认明确的白名单 + 宿主固定抬头。
   */
  isMetaUserMessage(msg) {
    if (msg?.role !== 'user') return false
    const src = msg.source && typeof msg.source === 'object' ? msg.source : {}
    const kind = String(src.kind || '')
    if (kind === 'runtime-context' || kind === 'dsh-session-title-llm') return true
    if (String(src.form || '') === 'snapshot') return true
    const blocks = Array.isArray(msg.content) ? msg.content : []
    const head = blocks
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim()
      .slice(0, 80)
    if (/^Current runtime context\./.test(head)) return true
    if (/^Generate the session title from this JSON array/.test(head)) return true
    return false
  }

  /**
   * 从会话日志里捞最后一条 assistant 文本。
   *
   * 为什么不用流式回调拼：agent 的流是进程本地事件，形状随版本变。
   * 会话日志是稳定的公开接口（deriveMessages），更耐升级。
   */
  readLastAssistant(agent, task) {
    try {
      const session = agent?.session
      const msgs = session?.deriveMessages?.() || []

      /*
       * 先按「这是哪条命令」定位：followup 的 content 就是 task 原文
       * （见 _runOnce 里的 agent.followup），deriveMessages 会把它原样带出来。
       *
       * 为什么必须定位：真机 2026-10-20 09:26，群 777777777 两条相邻消息——
       *   「命令 查询福州今天天气，并且@333333333」→ turn 191 答了福州天气；
       *   还没收尾时，一条 scheduled reminder 被 splice 成 turn 192，答了
       *   「无新好友。」。whenIdle() 到 turn 192 才落定，而旧代码从会话末尾
       *   倒着找 assistant —— 于是把「无新好友。」当成福州命令的结果发了出去，
       * 主人看到的就是「答非所问」，福州那条真回答其实一个字都没发出去。
       */
      if (task) {
        const want = String(task).trim()
        let mine = -1
        for (let i = msgs.length - 1; i >= 0; i--) {
          const m = msgs[i]
          if (m?.role !== 'user') continue
          if (this.isMetaUserMessage(m)) continue
          const t = (Array.isArray(m.content) ? m.content : [])
            .filter((b) => b?.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text)
            .join('\n')
            .trim()
          if (t === want) {
            mine = i
            break
          }
        }
        if (mine >= 0) {
          /*
           * 自己那一轮的范围是 (mine, 下一条**真实轮次**的 user 消息)。
           *
           * 2026-10-20 修正：跳过宿主塞进来的元信息 user 消息（运行时上下文
           * 快照、标题生成请求）——它们不是轮次边界。真实轮次（用户命令、
           * 定时提醒、聊天链路的 research 包装任务）仍然截断，保证不会把
           * 别人那轮的回答当成本次结果。
           */
          let nextUser = msgs.length
          for (let i = mine + 1; i < msgs.length; i++) {
            if (msgs[i]?.role === 'user' && !this.isMetaUserMessage(msgs[i])) {
              nextUser = i
              break
            }
          }
          for (let i = nextUser - 1; i > mine; i--) {
            const m = msgs[i]
            if (m?.role !== 'assistant') continue
            const blocks = Array.isArray(m.content) ? m.content : []
            const text = blocks
              .filter((b) => b?.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text)
              .join('\n')
              .trim()
            if (text) return text
          }
          // 找到了自己那条 followup，但这一轮还没产出 —— 交给调用方继续等
          return ''
        }
      }

      /* 没有 task（或会话里找不到那条 followup，比如旧会话被裁剪过）→ 退回旧行为 */
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (m?.role !== 'assistant') continue
        const blocks = Array.isArray(m.content) ? m.content : []
        const text = blocks
          .filter((b) => b?.type === 'text' && typeof b.text === 'string')
          .map((b) => b.text)
          .join('\n')
          .trim()
        if (text) return text
      }
      return PLACEHOLDER_NO_TEXT
    } catch (err) {
      this.logger('warn', `读取执行结果失败：${err?.message || err}`)
      return '（执行了，但结果读不出来）'
    }
  }

  /**
   * 本执行器负责的 sessionId。
   *
   * task-46：work 沿用原 id、绝不改名/重建（改名会让宿主持老路径 → ENOENT）。
   * 2026-10-20 修正：会话 header 里的 `cwd` 在**创建时写死**，之后 resume 只是
   * 克隆旧 header，`meta.cwd` 不再生效 —— 老的 `qq-whale-work-111111111` 建于
   * 沙箱改造之前，cwd 一直是 `${HOME}\.dsh\profiles\desktop`，于是
   * 「在控制台里直接对这条会话打字」会往 profile 目录写文件（用户报的「越权」）。
   * 解法：id 带版本戳（config.workSessionTag，默认 v2），换一条新会话，让
   * pickWorkCwd() 的沙箱 cwd 真正落到 header 上；旧会话留在盘上不删不改名。
   */
  workSessionId() {
    const role = this.role === 'code' ? 'code' : 'work'
    const tag = String(this.config?.workSessionTag || 'v2').trim() || 'v2'
    return `qq-whale-${role}-${tag}-${this.config.selfId || 'bot'}`
  }

  /** 干活会话的 session 对象（投影读取要它） */
  workSession() {
    return this.handle?.agent?.session ?? null
  }

  /** 单轮硬上限（config.workTurnTimeoutMs 可覆盖，测试里会设小值）。 */
  turnTimeoutMs() {
    const raw = Number(this.config?.workTurnTimeoutMs)
    if (Number.isFinite(raw) && raw >= 5000) return raw
    return WORK_TURN_TIMEOUT_MS
  }

  /**
   * 取消当前这一轮并等它落定（task-44）。
   *
   * agent.cancel({kind:'user'}) 会 abort 当前 phase：卡在 ask_user_question 上的
   * 工具调用会带着 AbortError 结束，whenIdle 随之 resolve。这里再给 3 秒余量，
   * 免得紧接着的 followup 撞上一个还没完全停下来的 driver。
   */
  async cancelRunning(reason = '主人叫停', waitMs = 3000) {
    const agent = this.handle?.agent
    if (!agent) return false
    try {
      agent.cancel?.({ kind: 'user', reason })
    } catch (err) {
      this.logger('warn', `取消当前轮失败：${err?.message || err}`)
      return false
    }
    try {
      await Promise.race([agent.whenIdle?.() ?? Promise.resolve(), sleep(waitMs)])
    } catch {
      /* whenIdle 抛错也当作已结束 */
    }
    return true
  }

  /**
   * 上一条命令卡死太久时强制释放（task-44）。
   *
   * 判据：this.running 还在，且已经超过 WORK_STUCK_MS（默认 270s，比单轮上限
   * 180s 多留一轮余量，不会被正常长任务误伤）。释放手段只有一个：
   * agent.cancel —— 不删会话、不改名（改名会让宿主句柄失效，上次踩过）。
   */
  async releaseStuckRun() {
    const r = this.running
    if (!r) return false
    const age = Date.now() - (r.startedAt || 0)
    if (age < WORK_STUCK_MS) return false
    this.logger('warn', `检测到上一条命令卡死 ${Math.round(age / 1000)}s，主动取消并释放会话：${String(r.task || '').slice(0, 40)}`)
    await this.cancelRunning('上一条命令卡住，自动释放', 5000)
    return true
  }

  /** 打断正在跑的任务 */
  async interrupt() {
    if (!this.handle || !this.running) return false
    try {
      this.handle.agent.cancel({ kind: 'user', reason: '主人叫停' })
      return true
    } catch {
      return false
    }
  }

  /** 插件卸载时拆掉会话 */
  async dispose() {
    if (!this.handle) return
    try {
      await this.handle.dispose()
    } catch (err) {
      this.logger('debug', `拆除干活会话失败：${err?.message || err}`)
    }
    this.handle = null
  }
}

/** 从模型回复里抠出第一个 JSON 对象，容忍前后废话和代码围栏 */
function extractJson(text) {
  const s = String(text || '')
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = fence ? fence[1] : s
  const start = body.indexOf('{')
  if (start < 0) return null
  // 从第一个 { 开始做括号配平，避免贪婪匹配吃掉后面的东西
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < body.length; i++) {
    const c = body[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) {
        try {
          return JSON.parse(body.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}