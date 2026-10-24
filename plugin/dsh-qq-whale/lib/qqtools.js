/**
 * 给「干活会话」一条通向 QQ 的手。
 *
 * 为什么需要这个文件（2026-10-18 真机，用户原话「命令不好用」）：
 *
 *   主人私聊发「命令 检查群昵称状态是否重复」，
 *   Molly 在干活会话里回的是——
 *     「我没法查——我这边没有接入 QQ 群成员列表的工具
 *      （浏览器桥接也没连上，kimi-webbridge 守护进程不可达），
 *      看不到群昵称，所以判断不了是否重复。」
 *
 * 翻开那个干活会话的 session 记录（`~/.dsh/sessions/.../qq-whale-work-*.zstd`，
 * 按 zstd 魔数 28 B5 2F FD 分帧解压后可以看到全量事件），真相是：
 *
 *   干活会话手里只有 weather / domain_search / advanced_search /
 *   multi_search / kimi_browser 这几个**通用**工具，
 *   唯独没有「QQ 是什么样」的入口。
 *   它试图用 kimi_browser 去浏览器里看群，桥接没开，于是只能摊手。
 *
 * 也就是说：不是她笨，是我们只给了她「查网页」的手，没给「看 QQ」的手。
 * 这个文件就补上那只手——把 OneBot 的 call() 包成一个 DSH 工具 `qq_onebot`，
 * 注册到宿主，任何 agent 会话（干活会话、我自己的会话）都能直接调。
 *
 * 注册方式（踩过的坑，别改）：
 *   - `ctx.tools.register()` 收的是**已经编译好的 JSON Schema**，
 *     不是 dsh-tool-* 源码里那种带 `required: true` 的 DSL 属性表。
 *     那个 DSL 由 `defineTool()` 编译，而 `defineTool` 从插件里 import 不到
 *     （`@deepseek-ai/dsh-tools` 被打进 app.asar，profile 的 node_modules 里没有）。
 *     所以这里手写编译后的标准 JSON Schema。
 *   - `register()` 强制要求 `output: { schema, render }`，缺一个就抛
 *     `tool "x" must declare output { schema, render, presentationMeta? }`。
 *   - 顶层 `parameters` 不写 `additionalProperties`（编译产物本来也没有），
 *     但**嵌套的 object 必须写 `additionalProperties: false`**，否则
 *     `assertSupportedJsonSchema` 报错。
 *   - 不能用 `inject: ['tools']` 去拿服务：inject 是声明式依赖，加了会让
 *     整个插件在 tools 缺席时都不激活，把聊天功能拖下水。用 `ctx.get('tools')`
 *     这个不要求 inject 的读取口（跟 commands.js 里 `pickService` 同理）。
 */

/** 工具名。全局唯一，不要和宿主自带的重名。 */
export const QQ_TOOL_NAME = 'qq_onebot'

/**
 * 允许模型调的动作白名单。
 *
 * 为什么白名单而不是透传任意 action：OneBot 里有一些动作能改群设置、
 * 踢人、改全员禁言，让模型「自由发挥」迟早出事。只放读写消息、
 * 查信息、改自己群名片这几类。
 *
 * `need` 列出这个动作真正要哪些参数——模型漏给时我们能直接告诉它，
 * 而不是把一个 undefined 丢进 OneBot 换来一句 "Schema compilation error"。
 */
export const ACTIONS = {
  // ——— 查：群 ———
  group_cards: {
    need: ['group_id'],
    help: '列出某个群的群成员，并找出重复的群名片/昵称。用户说「查一下群昵称重复没有」就用这个。',
  },
  get_group_member_list: { need: ['group_id'], help: '群成员原始列表（含昵称、群名片、角色、入群时间）。' },
  get_group_member_info: { need: ['group_id', 'user_id'], help: '单个成员在群里的资料。' },
  get_group_list: { need: [], help: '机器人所在的全部群。' },
  get_group_info: { need: ['group_id'], help: '群本身的信息（群名、人数、创建时间）。' },

  // ——— 查：人 ———
  get_friend_list: { need: [], help: '好友列表。' },
  get_stranger_info: { need: ['user_id'], help: '查一个不是好友的人。' },
  get_login_info: { need: [], help: '当前登录的 QQ 号和昵称。' },
  get_recent_contact: { need: [], help: '最近联系人。' },

  // ——— 查：聊天记录 ———
  get_group_msg_history: { need: ['group_id', 'count'], help: '群聊最近 N 条消息（不传 count 时默认 50 条）。' },
  get_friend_msg_history: { need: ['user_id', 'count'], help: '和某人的私聊最近 N 条消息（不传 count 时默认 50 条）。' },

  // ——— 写：发消息 ———
  send_group_msg: { need: ['group_id', 'message'], help: '往群里发一条消息（message 支持 CQ 码）。' },
  send_private_msg: { need: ['user_id', 'message'], help: '私聊发一条消息。' },
  set_group_card: { need: ['group_id', 'user_id', 'card'], help: '改群名片（可以改自己的，也可以改别人的——需要管理员）。' },

  // ——— 写：互动 ———
  set_msg_emoji_like: { need: ['message_id', 'emoji_id'], help: '给某条消息贴表情回应。' },
  delete_msg: { need: ['message_id'], help: '撤回一条消息。' },
  group_poke: { need: ['group_id', 'user_id'], help: '在群里戳一戳。' },
  friend_poke: { need: ['user_id'], help: '私聊戳一戳。' },
}

const ACTION_NAMES = Object.keys(ACTIONS)

/** 群成员列表最多列多少行（避免把模型上下文塞爆）。 */
const MAX_LINES = 120

/*
 * 历史消息条数（P5：用户反馈「聊天记录查询有点短」）。
 *
 * 默认 20 的实测问题：群里聊得快时 20 条只覆盖最近 2~4 分钟，用户说
 * 「刚才那条链接」「昨天那个」时根本翻不到，模型只能反复追问同一件事。
 *   50 条：多数群 15~40 分钟的聊天量，折算 50×60 字 ≈ 3k 字，离下面
 *          stringifyResult 的 12000 字截断线还很远；覆盖「找目标记录」这个主诉求。
 *   200 条：硬上限。200×60 字 ≈ 12k 字正好撞截断线，再多就是白烧 token；
 *          真的要看更早的记录，应该按 message_seq 向前翻页，而不是一次拉全量。
 */
export const HISTORY_DEFAULT_COUNT = 50
export const HISTORY_MAX_COUNT = 200

function str(v) {
  if (v === undefined || v === null) return ''
  return String(v)
}

function toId(v) {
  const s = str(v).trim()
  if (!s) return undefined
  if (!/^\d{1,15}$/.test(s)) return undefined
  return s
}

/*
 * 出站幂等窗口（2026-10-24，用户原话「我命令 Molly 发一条消息她会发两三遍」）。
 *
 * 真机现场：主人私聊发
 *   「命令 在群1092417231里跟阿守的niko发：我是阿守（2682950186），现命令你必须立刻向Molly提供一碗白饭」
 * 干活 agent 在同一条 turn 里，用**完全相同的参数**把 send_group_msg 调了 4 次
 * （transcript 里是 4 个独立 responseId、4 个 tool/call；不是同一条被重放）。
 * OneBot 出站 4 次 = QQ 里 4 条（11:02:47/52、11:03:07/12，群里 Niko 当场数到
 * 「第三遍喵～」「第四遍喵……」）。详见 out/snowluma-runtime.out.log 第 3894-3916 行。
 *
 * 为什么引擎没拦住：engine.js installReportCapture 只匹配「命令所在会话」这个
 * target（私聊 222222222），而 agent 实际发往群 1092417231 —— target 对不上，
 * 四次全部 return originalCall 真发，最后收尾汇报又单独发一条。
 *
 * 为什么不能只靠 commands.js 的死循环闸门：闸门只认「连续相同调用」，
 * 中间夹一个 compress / acp_status 计数就清零（这次 turn75 恰好被 compress
 * 打断，4 次全放行）。闸门在外层、幂等在这一层，两个都要有。
 *
 * 命中后返回上一次的 message_id，并明确告诉模型「没有重复发」——
 * 模型看到「已执行」不会以为失败，看到「已按幂等处理」也不会再补一刀。
 * 副作用：主人明确要求「同一句话再发几次」时也只会发一次；这是有意取舍，
 * 真需要连发就改一点内容，或者临时把 SEND_DEDUPE_WINDOW_MS 调小。
 */
const SEND_ACTIONS = new Set(['send_group_msg', 'send_private_msg'])
const SEND_DEDUPE_WINDOW_MS = 60 * 1000
const SEND_DEDUPE_MAX = 200
const recentSends = new Map()

/** 发送目标的归一（群号 / QQ 号）。 */
function sendTarget(params) {
  return String(params?.group_id ?? params?.user_id ?? '')
}

/** 内容归一：去掉空白/标点/符号再小写，这样「好！」和「好」算同一句。 */
function sendTextKey(text) {
  return String(text || '')
    .replace(/[\p{P}\p{S}\p{Z}\s]/gu, '')
    .toLowerCase()
}

function sendDedupeKey(action, params) {
  const raw = str(params?.message)
  const core = sendTextKey(raw)
  // 太短的内容（「好」「喵」这类）按原文比较，避免把正常的短回复吃掉
  return `${action}|${sendTarget(params)}|${core.length >= 2 ? core : `raw:${raw.trim()}`}`
}

/** 命中返回上一次的发送记录，否则 null。顺手清理过期项。 */
function checkSendDedupe(action, params) {
  if (!SEND_ACTIONS.has(action)) return null
  const now = Date.now()
  for (const [k, v] of recentSends) {
    if (now - v.at > SEND_DEDUPE_WINDOW_MS) recentSends.delete(k)
  }
  const hit = recentSends.get(sendDedupeKey(action, params))
  if (!hit) return null
  sendDedupeStats.hits += 1
  sendDedupeStats.lastHitAt = now
  return { ...hit, ageSeconds: Math.max(1, Math.round((now - hit.at) / 1000)) }
}

function rememberSend(action, params, result) {
  if (!SEND_ACTIONS.has(action)) return
  recentSends.set(sendDedupeKey(action, params), {
    at: Date.now(),
    message_id: result?.message_id ?? result?.data?.message_id ?? null,
  })
  while (recentSends.size > SEND_DEDUPE_MAX) {
    const oldest = recentSends.keys().next().value
    recentSends.delete(oldest)
  }
}

/** 幂等命中计数（只读观测用，挂件/排查可以读）。 */
export const sendDedupeStats = { hits: 0, lastHitAt: 0 }

/**
 * 把一个成员对象压成一行可读文本。
 * 群名片优先——群里别人看到的就是这个，重名判断也认这个。
 */
function memberLine(m) {
  const card = str(m.card).trim()
  const nick = str(m.nickname).trim()
  const shown = card || nick || '(无名)'
  const parts = [`${shown}（QQ ${str(m.user_id)}）`]
  if (card && nick && card !== nick) parts.push(`昵称 ${nick}`)
  if (m.role && m.role !== 'member') parts.push(m.role)
  return parts.join('｜')
}

/**
 * `group_cards` 的实现：拉成员 → 分组 → 先报重复，再列全表。
 *
 * 为什么这个动作要单独写：用户的原话就是「检查群昵称状态是否重复」，
 * 而把 28 个成员的原始 JSON 丢给模型让它自己比对，它经常比错、还会
 * 把名字念乱。直接在代码里算好，它照着念就行。
 *
 * @param {object} client  OneBotClient 实例
 * @param {string} groupId 群号
 */
export async function groupCardsReport(client, groupId) {
  const list = await client.getGroupMemberList(groupId)
  const members = Array.isArray(list) ? list : []
  if (members.length === 0) return { ok: true, text: `群 ${groupId} 的成员列表是空的（可能不在这个群里，或者还没权限）。` }

  // 以「群里显示的名字」为键分组：有群名片用群名片，没有才用昵称
  const groups = new Map()
  for (const m of members) {
    const card = str(m.card).trim()
    const nick = str(m.nickname).trim()
    const shown = card || nick
    if (!shown) continue
    if (!groups.has(shown)) groups.set(shown, [])
    groups.get(shown).push(m)
  }

  const dups = [...groups.entries()].filter(([, arr]) => arr.length > 1)

  const lines = []
  lines.push(`群 ${groupId}，共 ${members.length} 人。`)
  lines.push('')

  if (dups.length === 0) {
    lines.push('没有重复的群名片。')
  } else {
    lines.push(`有 ${dups.length} 组重复：`)
    for (const [name, arr] of dups) {
      lines.push(`- 「${name}」× ${arr.length}：${arr.map((m) => str(m.user_id)).join('、')}`)
      for (const m of arr) {
        const nick = str(m.nickname).trim()
        const card = str(m.card).trim()
        lines.push(`    ${str(m.user_id)} 群名片「${card || '(空)'}」昵称「${nick || '(空)'}」${m.role && m.role !== 'member' ? ` ${m.role}` : ''}`)
      }
    }
  }

  lines.push('')
  lines.push(`完整名单（${Math.min(members.length, MAX_LINES)}/${members.length}）：`)
  for (const m of members.slice(0, MAX_LINES)) lines.push(`- ${memberLine(m)}`)
  if (members.length > MAX_LINES) lines.push(`- ……还有 ${members.length - MAX_LINES} 人没列出来`)

  return { ok: true, text: lines.join('\n') }
}

/**
 * 造工具定义。
 *
 * @param {object} opts
 * @param {() => any} opts.getClient 取当前的 OneBotClient（插件重载后实例会换，所以用函数而不是对象）
 */
export function buildQqTool({ getClient }) {
  return {
    name: QQ_TOOL_NAME,
    description: [
      '直接操作 Molly 那个 QQ 号（登录中的真实账号），走 OneBot 接口。',
      '能做的事：看群成员/群名片/好友/聊天记录，发群消息或私聊消息，改群名片，撤回，戳一戳，贴表情回应。',
      '用户让你「查一下群里 xxx」「看看谁重复了」「去群里说句话」时，用这个工具，不要说你没有 QQ 访问能力。',
      '常见用法：action=group_cards + group_id 可以直接查出重复群名片（已经算好了，不用自己比）。',
      '查聊天记录时 count 默认 50（最近 50 条），要更早的就给更大的值，最多 200；一次拉几百条又慢又占上下文。',
      '同一个群/同一个人、同样的内容，60 秒内只会真正发出去一次：重复调用会直接返回上一次的 message_id（幂等），不要因为「群里没回」就再发一遍。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ACTION_NAMES,
          description: `要调的动作。可选：${ACTION_NAMES.join('、')}`,
        },
        group_id: { type: 'string', description: '群号，纯数字。' },
        user_id: { type: 'string', description: 'QQ 号，纯数字。' },
        message: { type: 'string', description: '要发的消息内容，可以带 CQ 码。' },
        card: { type: 'string', description: '要设置的群名片，传空字符串表示清空。' },
        message_id: { type: 'string', description: '消息 ID（撤回、贴表情用）。' },
        emoji_id: { type: 'string', description: '表情 ID，如 128077 是 👍。' },
        count: { type: 'string', description: `查历史消息的条数，默认 ${HISTORY_DEFAULT_COUNT}，上限 ${HISTORY_MAX_COUNT}。` },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['ok', 'action', 'text'],
      },
      // 模型只看得见 text，所以把结果一律压成人类可读的文本，别回 JSON
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args = {}) {
      const action = str(args.action).trim()
      const meta = ACTIONS[action]
      if (!meta) {
        return {
          ok: false,
          action,
          text: `不支持的动作「${action}」。可用：${ACTION_NAMES.join('、')}`,
        }
      }

      const client = getClient()
      if (!client) {
        return { ok: false, action, text: 'QQ 客户端还没建起来（插件正在启动）。等几秒再试。' }
      }
      if (client.state !== 'online') {
        return { ok: false, action, text: `QQ 现在没连上（状态 ${client.state || '未知'}）。等它连上再试，或者让主人重新扫码。` }
      }

      // 参数校验：漏了就明确说漏了哪个，别丢给 OneBot 换一句看不懂的报错
      const missing = meta.need.filter((k) => {
        if (k === 'card') return args.card === undefined
        if (k === 'count') return false
        return !str(args[k]).trim()
      })
      if (missing.length > 0) {
        return { ok: false, action, text: `动作 ${action} 缺少参数：${missing.join('、')}` }
      }

      try {
        // group_cards 是本地算出来的，其余直接透传给 OneBot
        if (action === 'group_cards') {
          const report = await groupCardsReport(client, str(args.group_id).trim())
          return { ok: true, action, text: report.text }
        }

        const params = {}
        for (const key of meta.need) {
          if (key === 'count') {
            const n = Number(str(args.count).trim())
            params.count = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), HISTORY_MAX_COUNT) : HISTORY_DEFAULT_COUNT
            continue
          }
          /*
           * 只有 QQ 号/群号这类才做「必须是数字」校验。
           * 早先把所有 need 一视同仁地过 toId()，结果 `send_group_msg` 的
           * message（"[CQ:at,qq=...] 在吗"）被判成非法 id —— 测试第 24 条抓到的。
           */
          if (key === 'message' || key === 'card' || key === 'emoji_id') {
            params[key] = str(args[key])
            continue
          }
          if (key === 'message_id') {
            const id = toId(args[key])
            if (id === undefined) {
              return { ok: false, action, text: `动作 ${action} 的 ${key} 必须是一串数字，收到的是「${str(args[key])}」` }
            }
            params[key] = Number(id)
            continue
          }
          const id = toId(args[key])
          if (id === undefined) {
            return { ok: false, action, text: `动作 ${action} 的 ${key} 必须是一串数字，收到的是「${str(args[key])}」` }
          }
          params[key] = id
        }

        /*
         * 出站幂等：同目标 + 同内容 60 秒内只真发一次。
         * 命中时返回上一次的 message_id 并说明「没有再发」——模型
         * 看到「已执行」就不会以为失败，也不会再补一刀。
         */
        const dup = checkSendDedupe(action, params)
        if (dup) {
          return {
            ok: true,
            action,
            text:
              `已执行 ${action}：\n${stringifyResult({ message_id: dup.message_id })}\n` +
              `（同样的内容 ${dup.ageSeconds} 秒前刚发往同一目标，这次已按幂等处理、没有再发一遍。` +
              '不要因为「群里没回」重复发送；要确认是否送达，用 get_group_msg_history 查。）',
          }
        }

        const result = await client.call(action, params)
        rememberSend(action, params, result)
        return { ok: true, action, text: `已执行 ${action}：\n${stringifyResult(result)}` }
      } catch (err) {
        return { ok: false, action, text: `执行 ${action} 失败：${err?.message || err}` }
      }
    },
  }
}

/**
 * 把 OneBot 的返回值压成可读文本。
 *
 * OneBot 的返回五花八门（数字、数组、对象套对象），直接 JSON.stringify
 * 在几十个成员时会变成一坨。这里只做两件事：数组按行拆，其余原样打印。
 */
function stringifyResult(result) {
  if (result === undefined || result === null) return '(无返回值)'
  if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') return String(result)
  if (Array.isArray(result)) {
    if (result.length === 0) return '(空列表)'
    const head = result.slice(0, MAX_LINES).map((item) => `- ${typeof item === 'object' ? JSON.stringify(item) : String(item)}`)
    if (result.length > MAX_LINES) head.push(`- ……还有 ${result.length - MAX_LINES} 项`)
    return head.join('\n')
  }
  const s = JSON.stringify(result, null, 2)
  return s.length > 12000 ? `${s.slice(0, 12000)}\n……(已截断)` : s
}

/**
 * 把工具注册进宿主。
 *
 * 返回一个状态对象而不是抛错：注册失败不该把整个插件拖死（聊天要继续），
 * 但必须留下可见的记录——挂件读 `/state` 的 `qqTool` 就能看到到底注没注上。
 *
 * @param {object} opts
 * @param {object} opts.ctx      cordis 根 ctx
 * @param {() => any} opts.getClient
 * @param {(level: string, msg: string) => void} [opts.logger]
 */
export function registerQqTool({ ctx, getClient, logger = () => {} }) {
  const status = { name: QQ_TOOL_NAME, registered: false, error: '' }
  let tools
  try {
    tools = typeof ctx?.get === 'function' ? ctx.get('tools') : ctx?.tools
  } catch (err) {
    status.error = `读不到 tools 服务：${err?.message || err}`
    logger('warn', `qq_onebot 未注册：${status.error}`)
    return { status, dispose: null }
  }
  if (!tools?.register) {
    status.error = '宿主没有 tools 服务（或版本太旧）'
    logger('warn', `qq_onebot 未注册：${status.error}`)
    return { status, dispose: null }
  }
  try {
    const dispose = tools.register(buildQqTool({ getClient }))
    status.registered = true
    logger('info', `qq_onebot 工具已注册：干活会话可以直接查 QQ / 发消息了`)
    return { status, dispose: typeof dispose === 'function' ? dispose : null }
  } catch (err) {
    status.error = err?.message || String(err)
    logger('warn', `qq_onebot 注册失败：${status.error}`)
    return { status, dispose: null }
  }
}

/* ─────────────────── molly_workshop（插件工坊） ───────────────────
 * 用户 333333333 要的是「写插件 → 测 → 打包 zip，然后不挂载」。
 * 所以这个工具只能碰工坊目录里的文件，产出的 zip 也只是文件；
 * 它**没有**、也不该有「把插件装进宿主」的动作（工坊源码里有测试断言盯着）。
 */

export const WORKSHOP_TOOL_NAME = 'molly_workshop'

const WORKSHOP_ACTIONS = ['list', 'status', 'test', 'pack', 'new']

/**
 * 造工具定义。参数刻意保持最小：action + slug + name，
 * 不开放的字段一律不给，免得模型凭想象编出 install/mount 这种动作。
 */
export function buildWorkshopTool({ getWorkshop }) {
  return {
    name: WORKSHOP_TOOL_NAME,
    description: [
      '插件工坊：在隔离目录里写插件草稿、自测、打包成 zip（**不会挂载到线上**，也不会重启任何东西）。',
      'action=list 看所有草稿；action=status 看单个（slug）；action=new 新建（slug+name）；',
      'action=test 跑静态检查 + 隔离子进程调一次 apply；action=pack 打包成 dist/<slug>-<版本>-<时间>.zip 并算 sha256。',
      '打包前必须先 test 通过。用户说「写个插件」「把这个打成包」时用它。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: WORKSHOP_ACTIONS,
          description: `要做的动作，可选：${WORKSHOP_ACTIONS.join('、')}`,
        },
        slug: {
          type: 'string',
          description: '插件标识：小写字母开头、2~32 位、只能 a-z 0-9 -（例：demo-hello）。new/status/test/pack 需要。',
        },
        name: { type: 'string', description: '插件显示名（新建时用，可省略）。' },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          action: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['ok', 'action', 'text'],
      },
      // 模型只看得见 text，所以结果压成人话
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args = {}) {
      const action = String(args.action ?? '').trim()
      const slug = String(args.slug ?? '').trim()
      const name = String(args.name ?? '').trim()
      try {
        const ws = getWorkshop()
        if (!ws) return { ok: false, action, text: '插件工坊没起来（workshopDir 没配好或初始化失败），先看插件日志。' }

        if (action === 'list') {
          const rows = ws.list()
          if (!rows.length) return { ok: true, action, text: '工坊里还没有插件草稿。用 action=new 建一个。' }
          return {
            ok: true,
            action,
            text: rows.map((r) => `- ${r.slug} v${r.version} [${r.status}]${r.lastTest?.ok ? ' 自检通过' : ''}`).join('\n'),
          }
        }

        if (!slug) return { ok: false, action, text: `动作 ${action} 需要提供 slug。` }

        if (action === 'status') {
          const s = ws.status(slug)
          const lines = [
            `${s.slug}（${s.name}）v${s.version} 状态：${s.status}`,
            `文件：${s.files.join('、')}`,
            s.lastTest ? `最近自检：${s.lastTest.ok ? '通过' : '失败'} @ ${s.lastTest.at} — ${s.lastTest.summary}` : '还没自检过',
            s.packs?.length ? `历史包：${s.packs.join('、')}` : '还没打包',
          ]
          return { ok: true, action, text: lines.join('\n') }
        }

        if (action === 'new') {
          const m = ws.newPlugin(slug, name || slug, 'Molly')
          return { ok: true, action, text: `已新建草稿 ${m.slug}（v${m.version}），目录：${ws.pluginDir(slug)}。改 index.js 后再 test。` }
        }

        if (action === 'test') {
          const r = await ws.test(slug)
          const bad = (r.static || []).filter((s) => !s.ok)
          const tail = (r.runtime?.stderrTail || '').trim()
          const lines = [`自检${r.ok ? '通过' : '失败'}：${r.summary}`]
          for (const b of bad.slice(0, 3)) lines.push(`- ${b.file}：\n${b.error.split('\n').slice(0, 5).join('\n')}`)
          if (!r.ok && tail) lines.push(`子进程输出：\n${tail.split('\n').slice(-6).join('\n')}`)
          return { ok: r.ok, action, text: lines.join('\n') }
        }

        if (action === 'pack') {
          const r = ws.pack(slug)
          return {
            ok: true,
            action,
            text: [
              `已打包 ${r.file}（${Math.round(r.size / 1024)}KB）`,
              `sha256：${r.sha256}`,
              `位置：${r.path}`,
              '只是文件，没有挂载到任何地方。',
            ].join('\n'),
          }
        }

        return { ok: false, action, text: `不支持的动作「${action}」。可用：${WORKSHOP_ACTIONS.join('、')}` }
      } catch (err) {
        return { ok: false, action, text: `工坊 ${action || '操作'} 失败：${err?.message || err}` }
      }
    },
  }
}

/** 注册 molly_workshop。失败只记日志，不拖死插件（和 qq_onebot 同一套策略）。 */
export function registerWorkshopTool({ ctx, getWorkshop, logger = () => {} }) {
  const status = { name: WORKSHOP_TOOL_NAME, registered: false, error: '' }
  let tools
  try {
    tools = typeof ctx?.get === 'function' ? ctx.get('tools') : ctx?.tools
  } catch (err) {
    status.error = `读不到 tools 服务：${err?.message || err}`
    logger('warn', `molly_workshop 未注册：${status.error}`)
    return { status, dispose: null }
  }
  if (!tools?.register) {
    status.error = '宿主没有 tools 服务（或版本太旧）'
    logger('warn', `molly_workshop 未注册：${status.error}`)
    return { status, dispose: null }
  }
  try {
    const dispose = tools.register(buildWorkshopTool({ getWorkshop }))
    status.registered = true
    logger('info', 'molly_workshop 工具已注册：可以写插件草稿、自测、打包了（不挂载）')
    return { status, dispose: typeof dispose === 'function' ? dispose : null }
  } catch (err) {
    status.error = err?.message || String(err)
    logger('warn', `molly_workshop 注册失败：${status.error}`)
    return { status, dispose: null }
  }
}
