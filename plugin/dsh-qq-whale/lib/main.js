/**
 * dsh-qq-whale —— 让蓝色大肥鱼住进 QQ。
 *
 * 这个插件把 QQ（经 NapCat 的 OneBot11 正向 WS）接成 DSH 的一条"人格通道"：
 * 收到的消息交给 ChatEngine，引擎用 DSH 的 ctx.llm 调模型（复用 workbuddy-ai
 * 的免费额度），按真人节奏分段发回去，并把重要的东西记进持久记忆。
 *
 * 生命周期：
 *   apply() → 等 llm 服务 → 建 engine → 连 OneBot → 注册命令/定时器
 *   插件卸载 → 断开 WS、清定时器、停主动联系
 */

import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

// ── 子模块加载（热重载的关键，见 lib/index.js 顶部的说明）────────────────
// 静态 import 的 URL 永远不变，Node 会一直复用首次求值结果，改文件不重启就永远
// 跑旧代码。这里把壳传下来的 ?rev= 拼到每个子模块 URL 上，整棵依赖树一起换新。
const REV = new URL(import.meta.url).searchParams.get('rev')
const sub = (spec) => {
  const u = new URL(spec, import.meta.url)
  if (REV) u.searchParams.set('rev', REV)
  return u.href
}

/*
 * ── 模块健康登记 + 容错装配（task-51，拆包前置）────────────────────────
 *
 * 宿主对插件加载失败是**静默跳过**的。拆包之后一旦某个包没加载上，表现会是
 * 「半个 Molly 悄悄消失」。这里把所有子模块的 import 逐个 try/catch：
 * 失败就登记进 module-health 并继续装配其余模块（部分可用 > 整体不可用），
 * 绝不让一个模块的加载失败把整个插件带下去。
 *
 * 登记由**装配点统一做**（不散在各个文件里自己调），否则一定会漏。
 */
const health = await (async () => {
  try {
    return await import(sub('./module-health.js'))
  } catch (err) {
    // 连登记表都没了也不许抛：退化成 no-op，插件照常装配
    console.warn?.('[qq-whale] module-health 加载失败，自检降级为 no-op：', err?.message || err)
    return {
      MODULE_MANIFEST: [],
      registerModule() {},
      registerFailed() {},
      snapshot: () => null,
      setBuild() {},
      gapAlertText: () => '',
      notifyGaps: async () => false,
    }
  }
})()

/*
 * task-53：出气筒（pest）已拆成独立包 dsh-qq-pest，自检清单里多一项 qqPest。
 * 用 setExpected 追加而不是改 module-health.js 的 MODULE_MANIFEST：
 *   ① 拆包试点要能一键回滚 —— 期望清单跟着 main.js 走，回退 main.js 就一起回退；
 *   ② expected 里多这一项后，pest 包没加载上会在 /state.plugins 的 missing 里点名，
 *      而不是像以前那样「悄悄少一块」。
 *
 * 但「期望」必须跟着「包在不在」走：回滚时把 node_modules/dsh-qq-pest 删掉后，
 * 还硬把 qqPest 写进 expected 就会永久 missing，还会让 owner 收到一条假告警。
 */
try {
  const base = (health.MODULE_MANIFEST || []).map((m) => m.name)
  const selfRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const pestPkgPresent = fs.existsSync(path.join(path.dirname(selfRoot), 'dsh-qq-pest'))
  if (pestPkgPresent && !base.includes('qqPest') && typeof health.setExpected === 'function') {
    health.setExpected([...base, 'qqPest'])
  }
} catch {
  /* 自检清单加不上不影响聊天主链路 */
}

/** 加载一个子模块；失败只登记，不抛。 */
async function loadModule(name, spec, { optional = false } = {}) {
  const url = sub(spec)
  try {
    const mod = await import(url)
    health.registerModule({ name, exports: Object.keys(mod || {}), optional })
    return mod
  } catch (err) {
    health.registerFailed({ name, error: String(err?.stack || err) })
    console.warn?.(`[qq-whale] 模块 ${name} 加载失败（继续装配其余模块）：`, err?.message || err)
    return null
  }
}

const onebotMod = await loadModule('onebot', './onebot.js')
const OneBotClient = onebotMod?.OneBotClient || null

const engineMod = await loadModule('engine', './engine.js')
const ChatEngine = engineMod?.ChatEngine || null

const webMod = await loadModule('web', './web.js')
const WebWidget = webMod?.WebWidget || null
const Metrics = webMod?.Metrics || MetricsFallback()

const qqtoolsMod = await loadModule('qqtools', './qqtools.js', { optional: true })
const registerQqTool = qqtoolsMod?.registerQqTool || null
const registerWorkshopTool = qqtoolsMod?.registerWorkshopTool || null

/*
 * 私聊 `#` 命令通道（主人 m01007）：私聊发 `#` 直接给菜单，不经过模型。
 *
 * 为什么单独一个模块而不是塞进 commands.js：那套是「自然语言路由」，
 * 要过模型、过角色门，主人已经嫌它爱报没权限；这条通道必须是
 * 「本地直读、不花额度、不猜意图」。纯函数在 hash-commands.js 里，能离线自测。
 */
const hashMod = await loadModule('hashCommands', './hash-commands.js', { optional: true })
const createHashHandler = hashMod?.createHashHandler || null

/*
 * task-55：上下文/记忆窗口只有一处定义（memory.js 顶部的 profiles），
 * 这里只负责把「当前生效值」读出来放进 /state 的只读字段。
 * 不走 loadModule：它不是可选子模块，取不到就等于窗口算不出来，直接装配失败更诚实。
 */
const memoryMod = await import(sub('./memory.js'))
const MEMORY_WINDOW = memoryMod.MEMORY_WINDOW
const WINDOW_PROFILE = memoryMod.WINDOW_PROFILE

const workshopMod = await loadModule('workshop', './workshop.js', { optional: true })
const Workshop = workshopMod?.Workshop || null

// 三级角色（owner / adm / guest）。用户 m25316 给 333333333 一个「管理员」位，
// 权限低于主人。解析与判定全在 roles.js 里，main.js 只负责把配置喂进去、
// 把算好的映射挂到 config 上，判定本身不在这里。
const rolesMod = await loadModule('roles', './roles.js', { optional: true })
const roleConfig = rolesMod?.roleConfig || null

/** Metrics 是纯计数的落盘小工具；web.js 没加载上时用它兜底，别让整条链路断。 */
function MetricsFallback() {
  return class Metrics {
    constructor(opts = {}) {
      this.opts = opts
      this.data = {}
    }
    snapshot() {
      return this.data
    }
    bump() {}
    save() {}
  }
}

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')

// 放置期用的素材目录（qq-whale/stickers）。插件装在 profile 的 node_modules 里，
// 从这里往上找不到它，所以允许用环境变量覆盖；找不到就退回 DSH_HOME 下的空目录。
const WORKSPACE_QQ_WHALE =
  process.env.QDW_WORKSPACE ||
  path.join(os.homedir(), 'Documents', 'deepseek-harness', 'default-workspace', 'qq-whale')

/** 插件配置默认值。全部可被 cordis.patch.yml 覆盖。 */
// task-55：导出出去只为一个用途——工具/测试能核对「默认档位有没有被人悄悄改小」。
// 运行期没有任何代码从外部回写它。
export const DEFAULTS = {
  // —— OneBot 连接 ——
  onebotUrl: 'ws://127.0.0.1:3001',
  onebotToken: '',
  selfId: '',

  // —— 模型 ——
  modelBackend: 'wbai',
  provider: 'workbuddy-ai',
  model: 'deepseek-v4.1-flash',
  // task-55：1024 → 1536。用户要「提高智力」但明确不动模型、不加推理强度，
  // 那就只能让回答/推理有更多余量。1536 是「能写完整段分析、又不至于跑飞」的档位：
  // 再往上（2048+）单条回复会明显变长，QQ 里读起来像小作文，成本也翻倍。
  maxTokens: 1536,
  temperature: 0.85,
  reasoningEffort: '',

  // —— 网关（wb-proxy 后端）——
  gatewayBaseUrl: 'http://127.0.0.1:8788/v1/chat/completions',
  gatewayApiKey: 'wb-proxy-local',
  // 钉死网关出口（'cn' / 'intl' / ''）。2026-10-23：国际版账号全被上游限制，
  // 用 'cn' 把整条链路压到国内积分池；留空=按模型名自动（flash→intl 免费优先）。
  gatewayRealm: '',
  gatewayToWbaiFallback: true,

  /**
   * 主脑降级模型（用户 m15210 / m15220 / m15263 定案）。
   *
   * 主脑分工：
   *   默认 deepseek-v4.1-flash —— realm 由模型名钉成 **intl**，实测 credit=0，
   *     是真免费车道。日常聊天、群里吹水都走这里，不花钱。
   *   一旦进 slowMode（免费车道被限流/打满），切 deepseek-v4-pro —— 按模型名
   *     钉成 **cn**，走国内积分池，一句 0.02~0.05 分。
   *
   * 为什么不是反过来：没被限流就先烧积分属于纯浪费。而进了 slowMode 说明
   * 免费车道已经堵了，这时再省就只剩"哑巴"，所以升 v4pro 保质量。
   * 留空 = 不降级，一直用主模型。
   */
  degradedModel: 'deepseek-v4-pro',

  /**
   * 备用脑（用户 m15210 / m15220 定案）。
   *
   * 位置：主脑两条车道（intl 免费 flash / cn v4-pro）都不通之后，
   * trae 降智接盘之前。
   *
   * 为什么是 cn flash：实测一句 0.01 分，是 v4-pro 的 1/3，且质量与主脑同款。
   * 为什么日限 500：用户原话「国内版flash限制改为500每天」。
   *   注意是 **500 积分**不是 500 次——实测 flash 一句 0.01~0.03 分，
   *   500 分大约能撑一万多句，相当于兜底车道基本不会断。
   *   关掉 spareLimitEnabled 就是不限量，一直用 cn flash。
   */
  spareEnabled: true,
  spareModel: 'deepseek-v4.1-flash',
  // 控制台切模型的令牌（task-56）：留空 = POST /model 关闭（一律 403）
  modelSwitchToken: '',
  spareLimitEnabled: true,
  spareDailyCap: 500,

  /**
   * 限流保底。
   *
   * 实测背景（2026-10-17）：DSH 主对话和 Molly 共用同一个 WorkBuddy 账号，
   * 主力会话跑得凶时 Molly 收到 429。当时降级模型配的是同一个 provider
   * 的另一个模型——没用，18 个模型共用一份额度。
   *
   * 所以顺序必须是：先重试（软限流几分钟就过），重试还不行才降级，
   * 而降级目标要指向**另一个 provider**（这里默认 DeepSeek 官方，
   * provider 名见 DSH 设置里的账户页）。填错也没事：拿不到就退回
   * 说一句人话，不会崩。
   */
  fallbackEnabled: true,
  fallbackProvider: 'deepseek',
  fallbackModel: 'deepseek-chat',
  rateLimitRetryWaits: [4000, 9000, 18000],
  /** 连续多次限流后的慢速重试（engine.js:2479 用 `?? [15000,30000]` 兜底） */
  rateLimitRetryWaitsSlow: [15000, 30000],

  // —— 谁可以聊 ——
  allowedUsers: [],
  // 主人：**只有一个号**。跟 allowedUsers 是两回事 ——
  // 白名单里可以有朋友（333333333），但陌生人审批、告状、花钱报备
  // 这些只能发给主人本人（222222222）。
  // 留空时退化为 allowedUsers[0] 兼容老配置，并打 warn 提醒补配。
  ownerUin: '',
  // 额外审批人（用户 m18721）：「把同意加好友权限放给 333333333 一份，
  // 即有人加好友同时发给我和他，有一人同意即可」。
  //
  // 跟 ownerUin 的区别：ownerUin 是**主主人**（称呼、告状、每天停电词都发给他），
  // approverUins 只是**多几双能点头的手**。两者都会收到审批请求、都能批，
  // 谁先回谁生效，另一个人会收到「已被 X 处理」的通知。
  // 之所以不直接把 approver 塞进 ownerUin：主主人只有一个，
  // 群名片判断、pest 出气筒报备这些行为依赖「唯一那个」，被稀释就乱了。
  approverUins: [],
  // 管理员（用户 m25316，2026-10-19 23:5x）。
  //
  // 333333333 提了一串要求（写通用接口 / 隔离仓库 / 他写插件 Molly 测 /
  // 白名单不用 / bug 不用 / 通过聊天调 DSH 创造模式写插件 / 写完不挂载 /
  // 以 zip 存储然后测试），主人的处置是「给他一个 adm 权限（管理员，权限低于 owner）」。
  //
  // 跟 approverUins 的区别：approver 是「多几双能点头的手」，只管审批；
  // adm 是一整个角色 —— 能用工坊、能下指令、能收执行结果，但碰不得
  // 白名单 / 主人记忆 / 预算 / persona / 装插件 / 杀进程 / 改 yml。
  // 那八条禁令写死在 roles.js 的 CAP_RULES 里，不靠提示词劝。
  admUins: ['333333333'],
  // 她在私信主人时怎么称呼他。审批这类系统口吻的消息里会在开头带上，
  // 让人一眼看出是在跟主人说话，而不是一条冰冷的系统通知。
  ownerTitle: '主人，',

  // —— 出气筒（用户 m17222）——
  // 被指定「往死里骂」的 QQ 号。空数组 = 整个模块关闭，行为跟没加它一样。
  // 单独一个配置项而不是从 allowedUsers 推断：骂谁是主人明确下令的，
  // 不是"在白名单里"的副作用。
  pestTargets: [],
  // 每天主动挑起骂街的次数上限。0 = 不限（不建议，会很吵也很费钱）
  pestDailyCap: 8,
  // 两次主动开团之间的最小间隔（分钟）
  pestIntervalMinutes: 45,
  // 是否允许她主动挑事。关掉后她只在你说话时才骂，
  // 但"每天重置额度/停止词/注入检测"照常工作。
  pestAutoPick: true,
  allowedGroups: [],
  groupAutoReply: true,
  // 围观插话的意愿阈值。2026-10-21 从 0.62 降到 0.42：
  //   旧阈值配旧意愿公式（起手 0.18）只有"问号+吃喝+情绪词"叠加才够，
  //   真机上她几乎只在被 @ 时说话，其余时候只剩点赞。
  // 想收回去就把它调高，不用改代码。
  bystanderThreshold: 0.42,
  // 引用回复（2026-10-25，主人 m02835 / m02846）：
  // 只在「同一时间说话的人特别多」/「对方只是 @ 了她、没正文」/「模型显式点名了别人」
  // 时带引用框，平时不挂。命中条件：30 秒内别人的消息 ≥3 条且说话人 ≥2 个。
  groupQuoteReply: true,
  groupQuoteWindowSeconds: 30,
  groupQuoteMinMessages: 3,
  groupQuoteMinSpeakers: 2,
  tapEmoji: true,
  // 判定不回之后点一个赞的概率（2026-10-21 从硬编码搬进配置）
  tapEmojiProbability: 0.35,
  // 不点赞的群（群号数组）。2026-10-22 主人要求：666666666 用户群里别点赞。
  // 只影响"已读回应/命令确认"这类表情赞，不影响正常开口回复。
  noLikeGroups: [],

  // —— 回复节流（2026-10-21）——
  // 0 = 不限制。用户当时明确「先不设限」，留这两个开关是为了后面能按群收紧。
  replyMinGapSeconds: 0,
  replyMaxPer10Min: 0,

  // 意愿公式的时间窗：自己说过几次话看 10 分钟，群里有多热看 90 秒
  willingnessSelfWindowMinutes: 10,
  willingnessHeatWindowSeconds: 90,

  // —— 轻回应：不开口，甩张表情包（2026-10-21）——
  // 判定"不回"时先试轻回应，再点赞，最后才彻底沉默。
  stickerLightReaction: true,
  stickerLightReactionChance: 0.25,
  // 同一个群两次轻回应的最小间隔（秒），防刷屏
  stickerLightReactionCooldownSeconds: 90,

  // —— 群名片实时状态（用户 m12520，2026-10-18 m18509 关闭）——
  // 有的 QQ bot 能在群名片上实时显示「在想事情/在回复」，用户点名要这个。
  // 但改 QQ 名会被风控，所以只在**群名片**（set_group_card）上做，且要限流。
  //
  // 为什么关掉（用户 m18509「那还是放弃改名吧」）：
  //   ① `set_group_card` 是敏感接口。每轮回复前改成「（在想…）」、回复后改回来，
  //      一天累计上百次写操作 —— 2026-10-18 11:35 Molly 被踢下线，QQ 客户端
  //      自己重启并落在登录页，本地登录凭据失效，只能重新扫码；
  //   ② 代价（掉线 = 完全不可用）远大于收益（名片上多四个字）。
  // 代码全留着，想开就把它改回 true；剥离后缀 / 还原 / 自愈的逻辑都是好的
  // （见手册 8.ae，test-groupcard.mjs 26/26）。
  groupCardStatusEnabled: false,
  groupCardThinkingSuffix: '（在想…）',
  groupCardCooldownMs: 45000, // 同一个群两次改名片的最小间隔，防风控

  // —— 开关（控制台可改，改完立即生效）——
  enabled: true,

  // —— 活人感 ——
  // 这组数字是「照着真人手机聊天实测」定的，不是性能参数。
  // 详见 lib/aliveness.js 里每个函数的注释。
  //
  // 2026-10-17 用户 m11614-2：「把回复延时调短点」。
  // 原来这一组是按"真人最自然的节奏"调的（想 1.8s、3.2 字/秒、最长打 22s），
  // 但真机上体感是"她回得太慢，聊着聊着我就干别的去了"。下面是整体收紧约
  // 60% 的新档位——还是慢于机器、还是有抖动，但不再让人等到走神。
  debounceMs: 600,
  // task-55：40 → 60。用户「先修记账，再提高上下文与记忆窗口」，明确不动模型。
  // 60 条 ≈ 一次能回看最近 50~60 句，足够把「刚才聊到哪儿、他在纠结什么」串起来；
  // 没上 80/100 是因为真机群里消息密，喂太多会让模型抓不住重点，token 也线性涨。
  contextLimit: 60,
  // 时间感知（2026-10-26，主人 m05189-1）：每轮把「现在几点」写进 system prompt。
  // 偏移默认 480（UTC+8 = 北京时间），不依赖宿主时区——算法在 lib/clock.js。
  timeContextEnabled: true,
  timeOffsetMinutes: 480,
  thinkingBaseDelaySeconds: 0.7,
  typingCharactersPerSecond: 7.5,
  typingMaxDelaySeconds: 8,
  typingJitterRatio: 0.35,
  bubbleGapMinSeconds: 0.45,
  bubbleGapMaxSeconds: 1.4,
  reactionMinSeconds: 0.8,
  reactionMaxSeconds: 2.6,
  restWindows: [{ label: '睡觉', start: '01:30', end: '09:00' }],

  // —— 指令执行（把主人的话当可执行指令）——
  // 只对 commanderUsers 里的人生效：私聊直接生效；群聊**必须**该群在
  // commandGroups 白名单里（2026-10-20 起，用户要求开放「示例测试群」）。
  commandEnabled: true,
  commanderUsers: [],
  // 允许执行「命令 」的群号白名单。空 = 群里永远不执行（原行为）。
  commandGroups: [],
  // 「命令 」开头的一切都当指令执行，不做任何分类询问。
  // 这是唯一 100% 可预测的入口：说"命令"就是命令。
  commandPrefixes: ['命令 ', '命令：', '命令:'],
  commandConfirmEmoji: 76,
  // 命令结果整段当一个气泡发（2026-10-20 用户 m03551：「命令查询的返回不用
  // 润色+拆分发送」）。以前固定按 180 字切成多条，主人收到一串碎片。
  commandSingleBubble: true,

  // —— 主动联系 ——
  // 开着的，但频次被三层闸门卡住（见 engine.maybeProactive 的注释）：
  //   全局 150 分钟一次 + ±35% 抖动 ≈ 一天 6~8 次；
  //   同一个人一天最多 3 次；
  //   上次说了没被回就收手，睡觉时间闭嘴。
  proactiveEnabled: true,
  proactiveMinGapMinutes: 150,
  proactiveGapJitterRatio: 0.35,
  proactiveDailyCap: 3,
  proactiveMinIdleMinutes: 40,
  proactiveNoReplyCooldownHours: 6,
  proactiveDuringRest: false,
  proactiveTickMinutes: 7,

  // —— 任务进度播报 ——
  // 干活期间把模型的任务清单实时推到 QQ。文字形式（用户说图片或文字都可）。
  // 节流 12 秒：模型改一次清单就发一条的话，一次活儿能刷十几条，太吵。
  progressEnabled: true,
  progressMinIntervalMs: 12000,
  progressMaxItems: 12,
  progressMaxItemChars: 42,

  // —— 记忆 ——
  memoryLimit: 800,  // 除了规则匹配（"我叫X""我喜欢Y"），每隔一阵子让模型自己判断该记什么。
  // 记忆池容量（2026-10-23 主人 m00608：400 条已经满了，要求扩到 2000）。
  // 跟上面那个「抽取节流」是两回事：这个是 memory.json 里最多存多少条，
  // 满了才会按 weight/时间剪老记忆。engine 里传给 MemoryStore，不传就退回 400。
  memoryPoolLimit: 2000,
  // 记满后自动扩容的上限（2026-10-23 主人 m00709：先扩到 2000，真记满了再扩到 1w）。
  // 0 = 不自动扩。扩容状态落在 data/memory/memory-pool.json，重启不会缩回。
  memoryPoolMax: 10000,
  // 记忆池加密（m00709 第 3 条）：整池 AES-256-GCM 落盘，memory.md 也转成 memory.md.enc。
  // 只有排查问题才该关掉——加密是主人明确要求的行为，默认开。
  memoryEncrypt: true,
  // 密钥位置：故意**不在记忆目录里**——密文和钥匙分开放，备份外泄也解不开。
  // 2026-10-26 部署可移植性：默认留空，运行期按 dataDir 推导
  // （<dataDir 兄弟目录>/qq-whale-keys/memory.key）。写死盘符会让没这盘的机器
  // 在 mkdir 处 ENOENT → ChatEngine 建不起来 → 插件「加载成功但 OneBot 从不连接」。
  memoryKeyFile: '',
  // 这是"聊着聊着就忘了我"的真正解法：人能记住的从来不只是自我介绍。
  // 节流两道：攒够 MinLines 条、且距上次抽取超过 MinGapMinutes 才调一次，
  // 否则每轮多烧一次调用，额度扛不住。
  //
  // 2026-10-17 调参：原来 MinLines=4 / MinGap=20 分钟，实测太保守 ——
  // 群里东一句西一句，很难同一个人连续 4 句，20 分钟的间隔也基本轮不到。
  // 结果 22 条记忆里只有 8 条是真的（其余全是表情包），用户的核心诉求
  // 「不要在 QQ 聊着聊着就忘了我」没兑现。现在降到 3 句 / 8 分钟。
  // 主脑走 intl 免费 flash（credit=0），多抽几次不花钱，可以放宽。
  //
  // 2026-10-21（P3）：用户要「多记日常」，再降到 2 句 / 3 分钟，上限 800 条。
  memoryExtract: true,
  memoryExtractMinLines: 2,
  memoryExtractMinGapMinutes: 3,
  // 抽取时的 maxTokens。**给少会静默失败**：reasoning 模型会先把预算
  // 全花在思维链上，正文一个字都出不来（实测 200 → content 为空）。
  // P3 上限放宽到 8 条 × 30 字，700 会被最后一条截断，提到 900。
  // 2026-10-22：每条放宽到 40~180 字（主人反馈「每条只记了一点」），
  // 8 条 × 180 字要 1500~1900 token，900 必截断，提到 1800。
  memoryExtractMaxTokens: 1800,

  // —— 免费额度的日预算 ——
  // 用户要求（m02357-1 / m03969）：wb 免费积分每天上限 100 分，超了就
  // 发条 QQ 通知然后停，改走 trae 的 v4.1-flash xhigh 降智使用；
  // 而这条限制必须能一键关掉——关掉就是纯用 wb，既不计数也不跳 trae。
  //
  // 计量口径：不是读 billing 接口（那个滞后几十秒、按批聚合，拦不住），
  // 而是自己累计每次响应里的 usage.credit。详见 lib/budget.js 文件头。
  creditLimitEnabled: true,
  creditDailyCap: 500,

  // —— 超预算后的接盘模型（trae）——
  // 「模型量和速度都很小，使用 trae 的时候要降智」(m02427-2)：
  // maxTokens 砍半、历史只喂 12 条、system prompt 里明说"说短点"。
  // trae 的用量不记账——用户说无需担心。
  creditFallbackTrae: true,
  traeProvider: 'trae',
  traeModel: 'deepseek-v4.1-flash',
  traeReasoningEffort: 'xhigh',
  traeMaxTokens: 512,
  traeTemperature: 0.8,
  traeContextLimit: 12,

  /*
   * 没超预算、只是被打成 429 时，要不要也交给 trae 接盘。
   *
   * 单独一个开关，因为和「超预算」是两件事：
   *   creditFallbackTrae 管的是「100 分用完了」——主动降级，主人点过头。
   *   rateLimitFallbackTrae 管的是「还在额度内但被限流」——被动救场。
   * 真机事故（2026-10-17）：wbai 的 soft_rate 按小时窗口重置，那次提示
   * 22:34:44 才恢复。本地那几十秒重试根本等不到，Molly 会哑几个小时。
   * 关掉它就只有「换 flavor → 重试 → 说句人话」这三层。
   */
  rateLimitFallbackTrae: true,

  // 干活会话（私聊「命令 」前缀）在哪个目录里折腾。
  // 空 = 用下面的 workSandboxDir（隔离沙箱），**不再回退宿主 cwd**。
  // 这个值会被写进 session header 的 cwd，下游用它解析相对路径，
  // 所以必须是真实存在的绝对路径（不存在会当场 mkdir）。
  workCwd: '',
  // 干活会话的默认沙箱目录（task-41：和主会话/项目源码物理分开）。
  // 部署到别的机器时改这里，或直接配 workCwd。
  // 2026-10-26 同上：留空 = 运行期推导到 <dataDir 兄弟目录>/sandbox/qq-work。
  workSandboxDir: '',
  // 单轮干活硬上限（毫秒）。task-44：原来只受 commandTimeoutMinutes（默认 15 分钟）
  // 约束，撞上「模型在等一个没人能点的弹窗」时整条命令队列陪葬。
  // 180s 足够覆盖查资料 + 写文件 + 发 QQ 的常见组合。
  workTurnTimeoutMs: 180000,

  /*
   * task-46：三会话各自的模型（主人 2026-10-20 拍板）。
   *   chat（闲聊）：网关 flash，保留降档规则（trae / degradedContextLimit）
   *   work（查询）：网关 kimi-k2.6
   *   code（改代码）：网关 flash
   * 形状统一 {provider, model, reasoningEffort?}：work/code 直接变成
   * agents.create 的 agentOptions（provider/model），chat 用于覆盖
   * gateway.chat 的 model。老写法 workModel:'kimi-k2.6'（字符串）仍兼容。
   */
  chatModel: { provider: 'wb-proxy', model: 'deepseek-v4.1-flash' },
  workModel: { provider: 'wb-proxy', model: 'deepseek-v4.1-flash' },
  codeModel: { provider: 'wb-proxy', model: 'deepseek-v4.1-flash' },

  // —— 先查再说 ——
  // 用户 m11614-1：「问啥东西都说不知道」。开了这个，她被问到事实性问题
  // 时会先让干活会话去查，查到再把结论用自己的话讲出来。
  // 关掉就退回原来的"只能瞎猜"行为（不烧额外的额度）。
  researchEnabled: true,
  // 打听一件事最多等多久（秒）。查资料不能让她在群里失联太久，
  // 超时就当没查到、照常聊天。2026-10-20 主人要求放宽到 5 分钟（原 45 秒）。
  researchTimeoutSeconds: 300,

  // —— 调试 ——
  blindMode: false,
  logLevel: 'info',

  // —— 路径 ——
  personaDir: '',
  stickerDir: '',
  memoryDir: '',
  // 插件工坊（写草稿/自测/打包，永不挂载）。空 = 工作区同级 plugin-workshop
  workshopDir: '',

  // —— 偷别人表情包 ——
  // 开关 + 两道保险：单张体积上限、每天最多学几张。
  // 2026-10-21（P2）：默认放开普通图片（allImages），否则平台侧永远学不到东西
  // （QQ 群里真正常用的"表情包"都是以普通图片发出的）；视觉闸门仍在兜底。
  stickerLearn: true,
  stickerLearnAllImages: true,
  stickerLearnMaxFileSizeMB: 5,
  stickerLearnMaxPerDay: 100,

  // —— 用表情包说话 ——
  // 用户要求（m03900）：「要让他学会用表情包代替回文字」。
  // 一轮最多几张图：1 撑不起斗图，3 以上就开始刷屏，2 是实测最像人的量。
  // 这个数同时被 splitReply（真发几张）和 system prompt（告诉她配额）读取，
  // 必须是同一个来源，否则模型写三张、代码只发两张，最后一句就对不上了。
  maxStickersPerReply: 2,

  // —— 撒图（P2，2026-10-21）——
  // 模型这轮忘了发图、回复又是短句时，替它补一张。用户明确要"允许单独甩图"。
  // 只补短回复：长回答通常是在讲正经事，中途甩图很怪。
  stickerSprinkle: true,
  stickerSprinkleChance: 0.25,
  stickerSprinkleMaxChars: 30,
  stickerSprinkleCooldownSeconds: 120,

  // —— 语音（2026-10-22，用户 m04697/m04855）——
  // 「时不时发一句语音代替说话」：默认开着，但只有一部分回复会转语音（voiceChance）。
  // 太长的回复不转——2026-10-23 用户要求「尽量接近 60 秒」，门槛从 42 字放到 220 字，
  // 再长还是文字更合适（语音条本身也不适合长篇）。
  // 音色/语速/音高是用户试听后拍板的（样本 I）：晓晓、-5%、+15Hz。
  voiceEnabled: true,
  voiceChance: 0.35,
  // 2026-10-23：42 字（≈11 秒）→ 220 字。Dania 实测约 3.9 字/秒 ⇒ 220 字 ≈ 56 秒。
  voiceMaxChars: 220,
  // 语音条时长硬闸门（秒）：合成完先按 wav 头量真实时长，超了就退回文字——
  // QQ 语音硬上限 60 秒，超了上传会失败并吞掉整条回复。0 = 不限。
  voiceMaxSeconds: 58,
  // 2026-10-24：用户拍板（本条会话）把 Molly 的语音从社区音色 Dania 换成
  // **用户自己录的 54 句微调出来的 molly_own 音色**（GPT-SoVITS v2ProPlus，HTTP 9880）。
  // backend='edge' 可退回 edge-tts（晓晓）；本地服务挂了会按 voiceFallbackEdge 自动退。
  voiceBackend: 'sovits',
  voiceSovitsUrl: 'http://127.0.0.1:9880',
  // 2026-10-26 同上：留空 = <dataDir>/voice-ref/molly-ref.wav（不存在就走 edge-tts）。
  voiceRefAudio: '',
  voicePromptText: '想的美，今天本鱼才是老大，你喝白开水去！',
  voicePromptLang: 'zh',
  voiceFallbackEdge: true,
  // 静默时段：这段时间不提供语音（用户 m05352：23:50–次日 09:00）。
  // 置空串可关闭；时间格式 HH:mm，本机时间。
  voiceQuietStart: '23:50',
  voiceQuietEnd: '09:00',
  // edge-tts 音色参数（仅 backend='edge' 或 sovits 失败退回时用）。
  voiceName: 'zh-CN-XiaoxiaoNeural',
  voiceRate: '-5%',
  voicePitch: '+15Hz',
  // 长文本合成很慢（Dania 195 字实测 41.7 秒），20 秒超时会把长语音全掐掉。
  voiceTimeoutMs: 90000,
  // 语音文件保留数量上限（按文件数淘汰最旧的），避免音频缓存无限涨。
  voiceMaxKeep: 200,
  // 2026-10-25 用户试听 5 档后拍板「E」：voiceSpeed 0.93（比默认慢 7%）+ 句间 50ms。
  // voiceSpeed 直接透传给 GPT-SoVITS speed_factor；voicePauseMs 是逐句合成后插入的静音毫秒（0 = 整段合成）。
  voiceSpeed: 0.93,
  voicePauseMs: 50,
  // 2026-10-22 用户 m05352 拍板：**取消同会话冷却**（0 = 不限制）。
  // 保留字段是为了兼容旧配置，engine.maybeVoice 已不再用它。
  voiceCooldownSeconds: 0,
  // —— 入站语音转文字（2026-10-25，主人 m04041「Molly还是不能读语音」）——
  // 别人发语音时调 SnowLuma 的 fetch_ptt_text（QQ 服务端转写，零依赖），
  // 把正文里的 `[语音]` 换成「（语音转文字：原文）」；失败留「[语音：没听清]」。
  // 关掉它就退回「只看见 [语音]」的老行为。
  voiceTranscribeEnabled: true,
  // 转写接口的超时（毫秒）：QQ 服务端转写实测 0.2–0.3 秒，6 秒足够兜住波动。
  voiceTranscribeTimeoutMs: 6000,
  // —— 本地 ASR 兜底（2026-10-25，主人 m04404「本地兜底」）——
  // 真机证据：群聊里别人发的语音，QQ 服务端 pttTrans 20 秒也不回（retcode 100），
  // 私聊却正常。这里用 SnowLuma get_record 取 wav + 本机 faster-whisper 识别。
  // 只对「QQ 拿不到 + 有音频文件」的群语音生效；私聊走上面那条，不跑本地模型。
  voiceAsrEnabled: true,
  // 常驻 Python worker 用的解释器（装了 faster-whisper 的那个 venv）
  // 2026-10-26 部署可移植性：留空 = 本机没配 Python 就自动跳过本地 ASR（不报错、不硬失败）。
  voiceAsrPython: '',
  // faster-whisper 模型（离线缓存，不联网下载）
  voiceAsrModel: 'small',
  voiceAsrThreads: 8,
  // 单次识别总超时（秒）：冷启动约 1.6 秒、2.5 秒音频约 1.6 秒识别
  voiceAsrTimeoutMs: 25000,
  // worker 空闲多久自动退出（秒），0 = 不退出
  voiceAsrIdleSeconds: 600,
  // 超过这个时长的语音不走本地 ASR（秒，0 = 不限），避免长语音把回复拖到分钟级
  voiceAsrMaxSeconds: 15,
  // —— 动图理解（2026-10-26，主人 m04893「让她看懂 GIF」）——
  // 问题：多模态模型对 image/gif 只解码第一帧，所以她一直只看到动图的封面。
  // 做法：发给模型之前把 GIF 采样成 N 帧、拼成一张带帧号的大图（lib/gif-frames.js）。
  // 依赖本机 python+Pillow（venv 里已有）；缺环境/超时自动回退原图，不耽误回复。
  gifFramesEnabled: true,
  // 采样几帧（0 = 关掉拆帧；4~9 之间信息量与体积比较平衡）
  gifFramesCount: 6,
  // 拼图列数（3 列 2 行最适合「按顺序看」）
  gifFramesColumns: 3,
  // 每帧缩放后的宽度（像素）：320 → 拼图约 976 宽，视觉得清又不太吃 token
  gifFrameWidth: 320,
  // 留空 = 没装 Pillow 就安静回退「只发首帧」。
  gifFramesPython: '',
  // 拆帧总超时（毫秒）：单张实测 0.2–1.2 秒
  gifFramesTimeoutMs: 12000,
  // 带图轮次的输出预算上限（2026-10-26）：同图思考 token 波动 250~1450，
  // 默认 1536 会被思考吃光导致正文空串（表现为「看了图却一声不响」）。
  imageMaxTokens: 3200,
  // 带图轮次的思考强度（2026-10-26）：实测图类 reasoning 934~4094 token 波动，
  // minimal 能把它压到 ~900，正文不至于被思考吃光；空串 = 不传该参数。
  imageReasoningEffort: 'minimal',
  // —— 唱歌（2026-10-25，主人 m05189-2「鱼想唱歌…让鱼能唱出歌来」）——
  // 有人私聊/群里 @ 她说「唱歌 小星星」时，逐字合成 + 音高搬移 + WSOLA 拉伸，
  // 直接发一条语音条（不走模型）。算法与曲库在 lib/singing.js。
  singingEnabled: false, // 2026-10-25 下架：音色未达标（训练数据只有 3.5 分钟），代码保留待社区歌唱模型接入
  // 渲染用 python（复用本地 ASR 那个 venv：numpy 已在，不需要新装依赖）
  // 留空 = 没配 Python 就不唱歌（不影响聊天）。
  singingPython: '',
  // 整首渲染超时（毫秒）：40 音节实测 4~20 秒
  singingTimeoutMs: 180000,
  // —— 戳一戳回应（2026-10-23，主人 m01231；2026-10-24 主人 m01908 改成模型说一句）——
  // 被 QQ 戳一戳时的反射：反戳 / 说一句 / 被连戳多次生气。
  // 反戳与计数不花模型；「说一句」默认让模型现编（pokeUseModel），失败用 lib/poke.js 的固定文案兜底。
  pokeEnabled: true,
  pokeBackChance: 0.7,
  pokeSayChance: 0.45,
  pokeAngryAfter: 4,
  pokeAngryWindowSeconds: 180,
  pokeCooldownSeconds: 8,
  pokeAngryCooldownSeconds: 90,
  pokeUseModel: true,
  pokeModelTimeoutMs: 10000,
  pokeModelMaxChars: 40,
  // 群趣味（2026-10-25，主人 m06096）：抽奖 + 新人欢迎
  groupfunEnabled: true,
  lotteryEnabled: true,
  lotteryDefaultCount: 3,
  lotteryMaxCount: 10,
  lotteryDefaultSeconds: 120,
  lotteryMinSeconds: 30,
  lotteryMaxSeconds: 3600,
  lotteryJoinKeyword: '参加',
  welcomeEnabled: true,
  welcomeCooldownSeconds: 60,
  welcomeTexts:
    '欢迎 {name} 加入 {group}～我是 {molly}，有问题随时 @我|来啦来啦，群里又多了个 {name}，欢迎欢迎|欢迎新人 {name}！先看看群公告，别潜水太深呀',
  // —— 撤回（2026-10-24，主人 m00480 需求②）——
  // 有人撤回消息后：清历史 / 作废在途回复是硬行为（不留配置）；
  // 「轻回一句」是可配置的软行为。用户 m00585 明确要求**群里也轻回一句**
  // （不要死寂），所以群/私聊都会掷骰，只是概率不高、延迟 20 秒、
  // 且对方立刻重发就不插嘴。
  recallWhisperEnabled: true,
  recallWhisperChance: 0.45,
  recallWhisperDelaySeconds: 20,
  // —— 群里照发（2026-10-24，主人 m00480 需求①）——
  // 现场：群里让人翻译东西，她回「细节我私聊你」；对方第二遍说「就在群里发」
  // 她还是推私聊。这里三件事：判定窗口、每颗气泡字数、单次总量。
  // 代码/日志和隐私/凭据仍然不能发群（那条线不跟这个开关一起放宽）。
  groupEchoEnabled: true,
  groupEchoRepeatWindowSeconds: 300,
  groupEchoMaxBubbleChars: 400,
  groupEchoMaxTotalChars: 1200,
}

function resolveDirs(config) {
  // 用户 m24958 要求数据不落 C 盘：配了 dataDir 就用配置的，否则退回 DSH_HOME（老行为）
  const dataDir = config.dataDir || path.join(DSH_HOME, 'qq-whale')
  // 表情包目录默认指向工作区里已经建好的那份图库（qq-whale/stickers），
  // 而不是 DSH_HOME 下的空目录——否则默认装完"斗图"是空的，
  // 用户会以为坏了。用户配置了别的路径就听用户的。
  const bundledStickers = path.join(WORKSPACE_QQ_WHALE, 'stickers')
  let stickerDir = config.stickerDir || ''
  if (!stickerDir) {
    stickerDir = fs.existsSync(bundledStickers) ? bundledStickers : path.join(dataDir, 'stickers')
  }
  /*
   * 主人号先算出来单独存一份，因为下面有三处要用：
   *   - 返回体的 ownerUin
   *   - approverUins 去重时排除主人
   *   - roles.js 的 roleConfig 判定 owner 优先于 adm
   * 三处各自写一遍 `config.ownerUin || allowedUsers[0]` 一定会漂移，
   * 所以这里一次性算好。用 String() 统一成字符串 —— QQ 号在不同事件里
   * 有时是数字有时是字符串，混着比会判错人。
   */
  const ownerUin = String(config.ownerUin || (config.allowedUsers || [])[0] || '')

  // 三级角色（owner/adm/guest）**只在构造时算一次**。
  // 运行期谁都不许改 roles —— 改了等于运行中给人提权，属于事故。
  // roleConfig 内部会再做一遍解析与去重（并且同样保证 owner 优先于 adm），
  // 这里不重复实现，只把结果铺进 config。
  // task-51：roles.js 没加载上时退化成「只有主人」，绝不让权限模块缺失
  // 变成「谁都不是主人」（那会连锁关掉所有指令/审批能力，比不加载更难查）。
  const roleInfo = roleConfig
    ? roleConfig({ ...config, ownerUin })
    : {
        owners: ownerUin ? [ownerUin] : [],
        admUins: [],
        roles: ownerUin ? { [ownerUin]: 'owner' } : {},
      }

  return {
    ...config,
    personaDir: config.personaDir || path.join(PACKAGE_ROOT, 'persona'),
    stickerDir,
    memoryDir: config.memoryDir || path.join(dataDir, 'memory'),
    dataDir,
    /*
     * 2026-10-26 部署可移植性（照 v1.1.5 的做法）。
     *
     * 以前 DEFAULTS 里写死 `${MOLLY_ROOT}\keys\memory.key` / `${MOLLY_ROOT}\sandbox\qq-work` /
     * `${MOLLY_ROOT}\data\qq-whale\voice-ref\molly-ref.wav`：换一台没有 G 盘的机器，
     * 一 mkdir 就 ENOENT，而这步在 MemoryStore 构造函数里 → ChatEngine 建不起来 →
     * 插件「加载成功」但 OneBot 从不连接（像加载了、其实是死的）。
     *
     * 现在：显式配置（作者机 yml）> 按 dataDir 推导的兄弟目录。
     */
    memoryKeyFile: String(config.memoryKeyFile || '').trim()
      || path.join(path.dirname(dataDir), 'qq-whale-keys', 'memory.key'),
    workSandboxDir: String(config.workSandboxDir || '').trim()
      || path.join(path.dirname(dataDir), 'sandbox', 'qq-work'),
    voiceRefAudio: String(config.voiceRefAudio || '').trim()
      || path.join(dataDir, 'voice-ref', 'molly-ref.wav'),
    voiceAsrModelDir: String(config.voiceAsrModelDir || '').trim()
      || path.join(dataDir, 'asr', 'models'),
    // 工坊默认落在「数据盘根」下（当前 dataDir=${MOLLY_ROOT}\data\qq-whale →
    // ${MOLLY_ROOT}\plugin-workshop），和线上插件、用户数据都分开；用户可用
    // config.workshopDir 指到别处。dataDir 没配「\data\」这一层时退回工作区同级。
    workshopDir: config.workshopDir || (path.basename(path.dirname(dataDir)) === 'data'
      ? path.join(path.dirname(path.dirname(dataDir)), 'plugin-workshop')
      : path.join(path.dirname(WORKSPACE_QQ_WHALE), 'plugin-workshop')),
    // 主人号解析：显式配置优先；没配就退化成白名单第一个（老配置兼容）。
    // 具体值在上面的 ownerUin 常量里算好了，这里直接引用，别再算一遍。
    ownerUin,
    // 管理员名单（归一化后）。owner 优先规则由 roleConfig 保证：
    // 主人要是顺手把自己的号也填进 admUins，结果仍是 owner，不会被降成 adm。
    admUins: roleInfo.admUins,
    // 角色映射表：{'222222222':'owner', '333333333':'adm'}。
    // 只在构造时算一次，运行期只读。
    owners: roleInfo.owners,
    roles: roleInfo.roles,
    // 额外审批人：既能是数组，也容忍「333333333, 123456」这种手写字符串
    // （用户在 yml / 配置框里手敲时经常直接写逗号分隔，不写数组）。
    // 顺手去重、去掉和主主人重复的那个 —— 否则同一个人会收到两条一样的审批提示。
    approverUins: (Array.isArray(config.approverUins)
      ? config.approverUins
      : String(config.approverUins || '').split(/[\s,，、;；]+/))
      .map((x) => String(x ?? '').trim())
      .filter(Boolean)
      .filter((x, i, arr) => arr.indexOf(x) === i)
      .filter((x) => x !== ownerUin),
  }
}

export const name = 'dsh-qq-whale'

/**
 * 为什么这里**不导出** Config：
 *
 * 早先写成 `export const Config = (Schema) => {...}`——一个工厂函数。DSH 宿主的
 * 配置投影（`@deepseek-ai/dsh-tool-cordis` 的 `liveConfig()`）会这样判定：
 *
 *     if (config === undefined || config === null) return { status: 'absent' }
 *     if (!isNativeConfigSchema(config))           return { status: 'unsupported' }
 *
 * 函数不是 native schemastery schema，于是整个插件在 Console 里显示成
 * "unsupported"，连带把插件当成半残。而 `absent` 是完全合法的正常工作状态
 * （现成的 dsh-whale-widget 就是这么干的，运行得很好）。
 *
 * 所以：直接不导出 Config，默认值全部由下面的 DEFAULTS + `{...DEFAULTS, ...rawConfig}`
 * 兜住。改动配置仍然走 cordis.patch.yml 的 config 块，那条路不受影响。
 *
 * 下面是保留下来做参考的形状说明（不导出、不执行）——真要用 schemastery
 * 校验时，把它改成 `export const Config = Schema.object({...})` 的**对象**形式，
 * 而不是工厂函数。
 */
function _configShapeReference(Schema) {
  const s = Schema?.object ? Schema : (Schema?.default ?? null)
  if (!s || typeof s?.object !== 'function') return DEFAULTS
  return s.object({
    onebotUrl: s.string().default(DEFAULTS.onebotUrl).description('NapCat OneBot11 正向 WS 地址'),
    onebotToken: s.string().default(DEFAULTS.onebotToken).description('OneBot access_token'),
    selfId: s.string().default(DEFAULTS.selfId).description('机器人 QQ 号'),
    modelBackend: s.union([s.const('wbai'), s.const('wb-proxy'), s.const('dsh')]).default('wbai').description('wbai=直连 WorkBuddy 免费额度（独立运行）；wb-proxy=走本地 8788 多账号池网关（抗限流，保留 wbai 回退）；dsh=走宿主 ctx.llm'),
    gatewayBaseUrl: s.string().default(DEFAULTS.gatewayBaseUrl).description('wb-proxy 后端用的网关地址'),
    gatewayApiKey: s.string().default(DEFAULTS.gatewayApiKey).description('wb-proxy 网关的占位 Authorization（api_key_required:false 时任意值即可）'),
  gatewayRealm: s.string().default(DEFAULTS.gatewayRealm).description("钉死网关出口（'cn' / 'intl'）；留空=按模型名自动（flash→intl 免费优先）。国际版账号被限制时填 'cn' 把链路切回国内积分池"),
    gatewayToWbaiFallback: s.boolean().default(DEFAULTS.gatewayToWbaiFallback).description('wb-proxy 网关限流/宕机时是否回退 wbai 直连'),
    provider: s.string().default(DEFAULTS.provider).description('DSH provider（modelBackend=dsh 时生效）'),
    model: s.string().default(DEFAULTS.model).description('模型 id'),
    degradedModel: s.string().default(DEFAULTS.degradedModel).description('主脑降级模型：免费车道被限流后切这个（v4-pro→cn 积分池）'),
    spareEnabled: s.boolean().default(DEFAULTS.spareEnabled).description('主脑两条车道都不通时，是否启用备用脑（cn flash）接盘'),
    spareModel: s.string().default(DEFAULTS.spareModel).description('备用脑模型 id（cn realm 的 deepseek-v4.1-flash）'),
  modelSwitchToken: s.string().default(DEFAULTS.modelSwitchToken).description('控制台切模型的 x-molly-admin 令牌；留空 = POST /model 一律 403（仅限控制台）'),
    spareLimitEnabled: s.boolean().default(DEFAULTS.spareLimitEnabled).description('备用脑是否受日积分限制'),
    spareDailyCap: s.natural().default(DEFAULTS.spareDailyCap).description('备用脑每日积分上限（默认 500 分，不是次数）'),
    maxTokens: s.natural().default(DEFAULTS.maxTokens),
    temperature: s.number().default(DEFAULTS.temperature),
    reasoningEffort: s.string().default(DEFAULTS.reasoningEffort),
    fallbackEnabled: s.boolean().default(true).description('【预留·当前未接线】engine.js 只构造了 this.fallback，全文件没有调用点，改了不生效。限流最后一层是「说一句人话」；想接着聊请用备用脑 spareModel 或 traeProvider/traeModel'),
    fallbackProvider: s.string().default(DEFAULTS.fallbackProvider).description('【预留·当前未接线】降级用的 provider（空=同 provider）'),
    fallbackModel: s.string().default(DEFAULTS.fallbackModel).description('【预留·当前未接线】降级用的模型；留空则只重试不降级'),
    rateLimitRetryWaits: s.array(s.natural()).default(DEFAULTS.rateLimitRetryWaits).description('限流后的重试等待毫秒数，按序执行'),
    rateLimitRetryWaitsSlow: s.array(s.natural()).default(DEFAULTS.rateLimitRetryWaitsSlow).description('连续多次限流后的慢速重试等待毫秒数（engine.js 里 `?? [15000,30000]` 兜底；之前缺 schema 项，UI 上没法配）'),
    allowedUsers: s.array(s.string()).default([]).description('允许私聊的 QQ 号'),
    ownerUin: s.string().default(DEFAULTS.ownerUin).description('主人 QQ 号（只有一个；留空则用 allowedUsers 第一个）'),
    approverUins: s
      .array(s.string())
      .default([])
      .description('额外审批人 QQ 号（同样收到加好友/拉群申请并且能批，有一人处理即生效）'),
    admUins: s
      .array(s.string())
      .default(DEFAULTS.admUins)
      .description('管理员 QQ 号（低于主人：能用工坊、能下指令，但碰不得白名单/记忆/预算/persona/装插件/杀进程）'),
    ownerTitle: s.string().default(DEFAULTS.ownerTitle).description('私信主人时的称呼前缀'),
    pestTargets: s.array(s.string()).default([]).description('被指定「往死里骂」的 QQ 号列表（空=关闭这个模块）'),
    pestDailyCap: s.natural().default(DEFAULTS.pestDailyCap).description('每天主动挑起骂街的次数上限（0=不限）'),
    pestIntervalMinutes: s.natural().default(DEFAULTS.pestIntervalMinutes).description('两次主动开团的最小间隔分钟数'),
    pestAutoPick: s.boolean().default(DEFAULTS.pestAutoPick).description('允许她主动挑起骂街'),
    allowedGroups: s.array(s.string()).default([]).description('允许插话的群号'),
    groupAutoReply: s.boolean().default(true).description('群里未被 @ 时是否允许主动插话'),
    bystanderThreshold: s.number().default(DEFAULTS.bystanderThreshold),
    groupQuoteReply: s.boolean().default(DEFAULTS.groupQuoteReply).description('群里多人同时说话时用引用回复锁定「在回哪条」'),
    groupQuoteWindowSeconds: s.natural().default(DEFAULTS.groupQuoteWindowSeconds).description('判定「多人同时说话」的回看秒数'),
    groupQuoteMinMessages: s.natural().default(DEFAULTS.groupQuoteMinMessages).description('判定拥挤的最少消息条数'),
    groupQuoteMinSpeakers: s.natural().default(DEFAULTS.groupQuoteMinSpeakers).description('判定拥挤的最少说话人数'),
    tapEmoji: s.boolean().default(DEFAULTS.tapEmoji),
    noLikeGroups: s.array(s.string()).default([]).description('不点赞的群号（已读回应/命令确认都不点）'),
    groupCardStatusEnabled: s.boolean().default(DEFAULTS.groupCardStatusEnabled).description('群名片实时状态：想事情/回复时把群名片改成「名字（在想…）」'),
    groupCardThinkingSuffix: s.string().default(DEFAULTS.groupCardThinkingSuffix).description('想事情时追加到群名片后的后缀'),
    groupCardCooldownMs: s.natural().default(DEFAULTS.groupCardCooldownMs).description('同一群两次改名片的最小间隔毫秒数（防风控）'),
    enabled: s.boolean().default(true).description('总开关：关掉后不再回任何消息（连接仍保持）'),
    debounceMs: s.natural().default(DEFAULTS.debounceMs),
    contextLimit: s.natural().default(DEFAULTS.contextLimit),
    timeContextEnabled: s.boolean().default(DEFAULTS.timeContextEnabled).description('是否把「现在时间」写进提示词（北京时间）'),
    timeOffsetMinutes: s.natural().default(DEFAULTS.timeOffsetMinutes).description('时间偏移（分钟），默认 480 = 北京时间 UTC+8'),
    thinkingBaseDelaySeconds: s.number().default(DEFAULTS.thinkingBaseDelaySeconds).description('看见消息到开始打字的思考时间'),
    typingCharactersPerSecond: s.number().default(DEFAULTS.typingCharactersPerSecond).description('打字速度（字/秒）。真人手机聊天 3~4，但实测那么慢会让人等走神，默认调到 7.5'),
    typingMaxDelaySeconds: s.number().default(DEFAULTS.typingMaxDelaySeconds),
    typingJitterRatio: s.number().default(DEFAULTS.typingJitterRatio).description('节奏抖动比例，越大越不规律（0.35 够用，太规律像机器人，太抖像卡顿）'),
    bubbleGapMinSeconds: s.number().default(DEFAULTS.bubbleGapMinSeconds),
    bubbleGapMaxSeconds: s.number().default(DEFAULTS.bubbleGapMaxSeconds),
    reactionMinSeconds: s.number().default(DEFAULTS.reactionMinSeconds),
    reactionMaxSeconds: s.number().default(DEFAULTS.reactionMaxSeconds),
    commandEnabled: s.boolean().default(DEFAULTS.commandEnabled).description('允许 commanderUsers 在私聊里下达可执行指令'),
    commanderUsers: s.array(s.string()).default([]).description('可以下指令的 QQ 号（私聊直接生效；群里还需该群在 commandGroups 里）'),
    commandGroups: s.array(s.string()).default([]).description('允许执行「命令 」的群号白名单（空=群里永不执行）'),
    commandPrefixes: s.array(s.string()).default(DEFAULTS.commandPrefixes).description('强制指令前缀，命中即当指令处理'),
    commandConfirmEmoji: s.natural().default(DEFAULTS.commandConfirmEmoji).description('收到指令时点的表情 ID（76=👍）'),
    commandSingleBubble: s.boolean().default(DEFAULTS.commandSingleBubble).description('命令结果整段一次发出（不按 180 字切条）'),
    proactiveEnabled: s.boolean().default(DEFAULTS.proactiveEnabled),
    proactiveMinGapMinutes: s.natural().default(DEFAULTS.proactiveMinGapMinutes),
    proactiveGapJitterRatio: s.number().min(0).max(1).default(DEFAULTS.proactiveGapJitterRatio),
    proactiveDailyCap: s.natural().default(DEFAULTS.proactiveDailyCap),
    proactiveMinIdleMinutes: s.natural().default(DEFAULTS.proactiveMinIdleMinutes),
    proactiveNoReplyCooldownHours: s.natural().default(DEFAULTS.proactiveNoReplyCooldownHours),
    proactiveDuringRest: s.boolean().default(DEFAULTS.proactiveDuringRest),
    proactiveTickMinutes: s.natural().default(DEFAULTS.proactiveTickMinutes),

    progressEnabled: s.boolean().default(DEFAULTS.progressEnabled),
    progressMinIntervalMs: s.natural().default(DEFAULTS.progressMinIntervalMs),
    progressMaxItems: s.natural().default(DEFAULTS.progressMaxItems),
    progressMaxItemChars: s.natural().default(DEFAULTS.progressMaxItemChars),
    memoryLimit: s.natural().default(DEFAULTS.memoryLimit),
    memoryPoolLimit: s.natural().default(DEFAULTS.memoryPoolLimit),
    memoryPoolMax: s.natural().default(DEFAULTS.memoryPoolMax),
    memoryEncrypt: s.boolean().default(DEFAULTS.memoryEncrypt),
    memoryKeyFile: s.string().default(DEFAULTS.memoryKeyFile),
    blindMode: s.boolean().default(DEFAULTS.blindMode),
    logLevel: s.string().default(DEFAULTS.logLevel),
    // task-41：干活会话目录。workCwd 显式配了就用它；否则用 workSandboxDir。
    workCwd: s.string().default(DEFAULTS.workCwd),
    workSandboxDir: s.string().default(DEFAULTS.workSandboxDir),
    workTurnTimeoutMs: s.natural().default(DEFAULTS.workTurnTimeoutMs).description('单轮干活硬上限（毫秒），超时取消并回一句人话'),
    // task-46：三会话各自模型（{provider, model, reasoningEffort?}）
    chatModel: s.object({
      provider: s.string().default(DEFAULTS.chatModel.provider),
      model: s.string().default(DEFAULTS.chatModel.model),
      reasoningEffort: s.string().default(''),
    }).description('聊天会话模型（默认网关 flash；降档规则不变）'),
    workModel: s.object({
      provider: s.string().default(DEFAULTS.workModel.provider),
      model: s.string().default(DEFAULTS.workModel.model),
      reasoningEffort: s.string().default(''),
    }).description('查询会话模型（默认网关 kimi-k2.6）'),
    codeModel: s.object({
      provider: s.string().default(DEFAULTS.codeModel.provider),
      model: s.string().default(DEFAULTS.codeModel.model),
      reasoningEffort: s.string().default(''),
    }).description('改代码会话模型（默认网关 flash）'),
    personaDir: s.string().default(''),
    stickerDir: s.string().default(''),
    memoryDir: s.string().default(''),
    workshopDir: s.string().default(''),
    stickerLearn: s.boolean().default(DEFAULTS.stickerLearn).description('偷学别人发的表情包（只认 QQ 动画表情/商城表情，需视觉模型）'),
    stickerLearnMaxFileSizeMB: s.natural().default(DEFAULTS.stickerLearnMaxFileSizeMB),
    stickerLearnMaxPerDay: s.natural().default(DEFAULTS.stickerLearnMaxPerDay),
    voiceEnabled: s.boolean().default(DEFAULTS.voiceEnabled).description('语音：偶尔把一条回复换成语音发出去（默认用本机 GPT-SoVITS 的社区音色 Dania）'),
    voiceChance: s.number().min(0).max(1).default(DEFAULTS.voiceChance).description('每条回复转语音的概率（0~1，默认 0.35）'),
    voiceMaxChars: s.natural().default(DEFAULTS.voiceMaxChars).description('超过这个字数的回复不转语音（默认 220 字 ≈ 56 秒；时长硬上限见 voiceMaxSeconds）'),
    voiceMaxSeconds: s.natural().default(DEFAULTS.voiceMaxSeconds).description('语音条时长上限（秒，默认 58；QQ 硬上限 60，超过就退回文字；0 = 不限）'),
    voiceBackend: s.string().default(DEFAULTS.voiceBackend).description('语音后端：sovits（本地 GPT-SoVITS，默认）或 edge（edge-tts 的晓晓）'),
    voiceSovitsUrl: s.string().default(DEFAULTS.voiceSovitsUrl).description('GPT-SoVITS api_v2 地址（默认 http://127.0.0.1:9880）'),
    voiceRefAudio: s.string().default('').description('GPT-SoVITS 参考音频路径（Dania 模型自带的那条 wav）'),
    voicePromptText: s.string().default('').description('参考音频对应的文字（参考文本，直接影响语气）'),
    voicePromptLang: s.string().default(DEFAULTS.voicePromptLang).description('参考音频/文本语言（zh / en / ja）'),
    voiceFallbackEdge: s.boolean().default(DEFAULTS.voiceFallbackEdge).description('sovits 合成失败时自动退回 edge-tts，保证语音功能不会整条消失'),
    sleepEnabled: s.boolean().default(true).description('作息：按北京时间判断该不该睡（关掉后不再有睡觉概念）'),
    sleepStart: s.string().default('23:50').description('作息：入睡时间 HH:mm（北京时间）'),
    sleepEnd: s.string().default('09:00').description('作息：起床时间 HH:mm（北京时间）'),
    voiceQuietStart: s.string().default('').description('语音静默时段开始（HH:mm，默认 23:50；置空关闭）'),
    voiceQuietEnd: s.string().default('').description('语音静默时段结束（HH:mm，默认 09:00；跨午夜自动处理）'),
    voiceName: s.string().default(DEFAULTS.voiceName).description('edge-tts 音色（backend=edge 或 sovits 失败退回时用，默认 zh-CN-XiaoxiaoNeural）'),
    voiceRate: s.string().default(DEFAULTS.voiceRate).description('edge-tts 语速（如 -5%）'),
    voicePitch: s.string().default(DEFAULTS.voicePitch).description('edge-tts 音高（如 +15Hz）'),
    voiceTimeoutMs: s.natural().default(DEFAULTS.voiceTimeoutMs).description('单次合成超时（毫秒；长文本合成要 40 秒以上，默认 90000）'),
    voiceMaxKeep: s.natural().default(DEFAULTS.voiceMaxKeep).description('语音缓存保留文件数上限'),
    voiceSpeed: s.number().min(0.5).max(2).default(DEFAULTS.voiceSpeed).description('GPT-SoVITS 语速系数（默认 0.93；>1 变快，<1 变慢）'),
    voicePauseMs: s.natural().default(DEFAULTS.voicePauseMs).description('句间刻意停顿（毫秒，默认 50；0 = 整段合成不再逐句暂停）'),
    voiceCooldownSeconds: s.natural().default(DEFAULTS.voiceCooldownSeconds).description('已废弃（用户 2026-10-22 取消冷却，保留字段兼容旧配置）'),
    voiceTranscribeEnabled: s.boolean().default(DEFAULTS.voiceTranscribeEnabled).description('入站语音转文字：别人发语音时调 QQ 服务端转写，把内容带进上下文（默认开）'),
    voiceTranscribeTimeoutMs: s.natural().default(DEFAULTS.voiceTranscribeTimeoutMs).description('语音转写超时（毫秒，默认 6000；实测转写 0.2–0.3 秒）'),
    // —— 本地 ASR 兜底（2026-10-25，主人 m04404）——
    voiceAsrEnabled: s.boolean().default(DEFAULTS.voiceAsrEnabled).description('本地 ASR 兜底：QQ 服务端转写拿不到时（群语音常见），用本机 faster-whisper 识别'),
    voiceAsrPython: s.string().default(DEFAULTS.voiceAsrPython).description('运行 faster-whisper 的 Python 解释器路径（需装 faster-whisper）'),
    voiceAsrModel: s.string().default(DEFAULTS.voiceAsrModel).description('faster-whisper 模型名/路径（默认 small，离线缓存读取）'),
    voiceAsrThreads: s.natural().default(DEFAULTS.voiceAsrThreads).description('本地识别 CPU 线程数（默认 8）'),
    voiceAsrTimeoutMs: s.natural().default(DEFAULTS.voiceAsrTimeoutMs).description('本地识别单次超时（毫秒，默认 25000，含首次模型加载）'),
    voiceAsrIdleSeconds: s.natural().default(DEFAULTS.voiceAsrIdleSeconds).description('worker 空闲自动退出（秒，默认 600；0 = 常驻）'),
    voiceAsrMaxSeconds: s.natural().default(DEFAULTS.voiceAsrMaxSeconds).description('超过这个时长的语音不走本地 ASR（秒，默认 15；0 = 不限）'),
    gifFramesEnabled: s.boolean().default(DEFAULTS.gifFramesEnabled).description('动图理解：把 GIF 采样成多帧拼图再交给模型（默认开）'),
    gifFramesCount: s.natural().default(DEFAULTS.gifFramesCount).description('动图采样帧数（4~9 较平衡；0 = 不拆帧）'),
    gifFramesColumns: s.natural().default(DEFAULTS.gifFramesColumns).description('动图拼图列数（默认 3）'),
    gifFrameWidth: s.natural().default(DEFAULTS.gifFrameWidth).description('动图每帧缩放宽度（像素，默认 320）'),
    gifFramesPython: s.string().default(DEFAULTS.gifFramesPython).description('拆 GIF 帧用的 Python 解释器（需 Pillow）'),
    gifFramesTimeoutMs: s.natural().default(DEFAULTS.gifFramesTimeoutMs).description('拆 GIF 帧超时（毫秒，默认 12000）'),
    imageMaxTokens: s.natural().default(DEFAULTS.imageMaxTokens).description('带图轮次的输出 token 上限（默认 3200；思考 token 波动大，给多了不亏）'),
    imageReasoningEffort: s.string().default(DEFAULTS.imageReasoningEffort).description('带图轮次的思考强度（minimal/空串=不传）'),
    // —— 唱歌（2026-10-25，主人 m05189-2）——
    singingEnabled: s.boolean().default(DEFAULTS.singingEnabled).description('唱歌（实验性，默认关闭）：音色未达标已下架，等训练数据够了一起换社区歌唱模型再开'),
    singingPython: s.string().default(DEFAULTS.singingPython).description('唱歌渲染用的 Python 解释器（需 numpy；默认复用本地 ASR 的 venv）'),
    singingTimeoutMs: s.natural().default(DEFAULTS.singingTimeoutMs).description('整首渲染超时（毫秒，默认 180000）'),
    // —— 戳一戳回应（2026-10-23，主人 m01231）——
    pokeEnabled: s.boolean().default(DEFAULTS.pokeEnabled).description('戳一戳回应：被戳时按概率反戳/说一句，被连戳多次会生气'),
    pokeBackChance: s.number().min(0).max(1).default(DEFAULTS.pokeBackChance).description('被戳时反戳的概率（0~1，默认 0.7）'),
    pokeSayChance: s.number().min(0).max(1).default(DEFAULTS.pokeSayChance).description('被戳时附带说一句的概率（0~1，默认 0.45，与反戳独立掷骰）'),
    pokeAngryAfter: s.natural().default(DEFAULTS.pokeAngryAfter).description('窗口期内被同一个人戳到第几次开始生气（默认 4）'),
    pokeAngryWindowSeconds: s.natural().default(DEFAULTS.pokeAngryWindowSeconds).description('生气计数的窗口（秒，默认 180）'),
    pokeCooldownSeconds: s.natural().default(DEFAULTS.pokeCooldownSeconds).description('两次戳回应的最小间隔（秒，默认 8）'),
    pokeAngryCooldownSeconds: s.natural().default(DEFAULTS.pokeAngryCooldownSeconds).description('生气之后的冷却（秒，默认 90）'),
    // —— 群趣味（2026-10-25，主人 m06096）——
    groupfunEnabled: s.boolean().default(DEFAULTS.groupfunEnabled).description('群趣味总开关（抽奖 + 新人欢迎）'),
    lotteryEnabled: s.boolean().default(DEFAULTS.lotteryEnabled).description('群内抽奖（「@我 抽奖」发菜单；「@我 抽 N 个 60 秒」开奖；参加 / 开奖 / 取消）'),
    lotteryDefaultCount: s.natural().default(DEFAULTS.lotteryDefaultCount).description('默认抽几个人（默认 3）'),
    lotteryMaxCount: s.natural().default(DEFAULTS.lotteryMaxCount).description('一次最多抽几个人（默认 10）'),
    lotteryDefaultSeconds: s.natural().default(DEFAULTS.lotteryDefaultSeconds).description('默认报名时长（秒，默认 120）'),
    lotteryMinSeconds: s.natural().default(DEFAULTS.lotteryMinSeconds).description('报名时长下限（秒，默认 30）'),
    lotteryMaxSeconds: s.natural().default(DEFAULTS.lotteryMaxSeconds).description('报名时长上限（秒，默认 3600，也就是 1 小时）'),
    lotteryJoinKeyword: s.string().default(DEFAULTS.lotteryJoinKeyword).description('报名关键词（默认「参加」）'),
    welcomeEnabled: s.boolean().default(DEFAULTS.welcomeEnabled).description('新人入群自动欢迎'),
    welcomeCooldownSeconds: s.natural().default(DEFAULTS.welcomeCooldownSeconds).description('同一群两次欢迎的最小间隔（秒，默认 60）'),
    welcomeTexts: s.string().default(DEFAULTS.welcomeTexts).description('欢迎语候选（用 | 分隔；可用 {name} {group} {molly} 占位）'),
    recallWhisperEnabled: s.boolean().default(DEFAULTS.recallWhisperEnabled).description('对方撤回消息后是否轻回一句（清历史/作废在途回复不受此开关影响）'),
    recallWhisperChance: s.number().min(0).max(1).default(DEFAULTS.recallWhisperChance).description('撤回后轻回一句的概率（0~1，默认 0.45；群聊私聊都会掷骰）'),
    recallWhisperDelaySeconds: s.natural().default(DEFAULTS.recallWhisperDelaySeconds).description('撤回后等多少秒再轻回（默认 20；期间对方重发就不插嘴）'),
    groupEchoEnabled: s.boolean().default(DEFAULTS.groupEchoEnabled).description('对方明确要求/坚持「就在群里发」时，不再推私聊、长文按句分条发（代码/日志/隐私仍然不发群）'),
    groupEchoRepeatWindowSeconds: s.natural().default(DEFAULTS.groupEchoRepeatWindowSeconds).description('她说「私聊」之后多久内的追问算「第二次坚持」（秒，默认 300）'),
    groupEchoMaxBubbleChars: s.natural().default(DEFAULTS.groupEchoMaxBubbleChars).description('群里照发时每颗气泡的字数上限（默认 400）'),
    groupEchoMaxTotalChars: s.natural().default(DEFAULTS.groupEchoMaxTotalChars).description('群里照发时一次最多发多少字（默认 1200，超了截断并说明）'),
  })
}

export function apply(root, rawConfig = {}) {
  // 临时诊断（task-53 拆包排查）：证明「这次 apply 跑的是哪份模块、写盘是否可行」。
  // 2026-10-26 部署可移植性：路径不再写死盘符，落到 <dataDir>/out/ 下；没配 dataDir 就跳过。
  try {
    const beatDir = String(rawConfig?.dataDir || DEFAULTS.dataDir || '').trim()
    if (beatDir) {
      const outDir = path.join(beatDir, 'out')
      fs.mkdirSync(outDir, { recursive: true })
      fs.writeFileSync(
        path.join(outDir, 'main-apply-beat.txt'),
        `${new Date().toISOString()} pid=${process.pid} url=${import.meta.url}\n`,
        'utf8',
      )
    }
  } catch {}
  const config = resolveDirs({ ...DEFAULTS, ...rawConfig })

  // logger：优先用 DSH 的 logger 服务，退回 console
  const logger = makeLogger(root, config.logLevel)

  // 立刻打印启动横幅：DSH 崩溃恢复会把插件行削掉，这条日志能区分"没加载"和"加载了但连不上"
  logger('info', `dsh-qq-whale 已加载 | provider=${config.provider} model=${config.model} selfId=${config.selfId || '(待探测)'}`)

  /*
   * 运行时模型覆盖（task-56）：用户在控制台切过的模型落盘在 model-override.json，
   * 启动时盖到 config 上。**只改内存对象，不动 yml**——把文件删掉就回到 yml 的值。
   * 这里直接用 fs 读而不是 import 模块：apply() 不是 async，用不了 await import。
   * 读失败一律当没有（坏文件不能把机器人拖死）。
   */
  let modelOverride = null
  try {
    const ovFile = path.join(config.dataDir || path.join(DSH_HOME, 'qq-whale'), 'model-override.json')
    if (fs.existsSync(ovFile)) {
      const j = JSON.parse(fs.readFileSync(ovFile, 'utf8'))
      const ov = {}
      for (const role of ['chat', 'work', 'code']) if (j?.[role]) ov[role] = String(j[role])
      if (Object.keys(ov).length) {
        modelOverride = ov
        for (const role of ['chat', 'work', 'code']) {
          if (!ov[role]) continue
          const field = `${role}Model`
          const cur = config[field]
          config[field] = typeof cur === 'object' && cur ? { ...cur, model: ov[role] } : { provider: config.provider || 'wb-proxy', model: ov[role] }
        }
        logger('info', `已应用模型覆盖：${Object.entries(ov).map(([k, v]) => `${k}=${v}`).join(' ')}`)
      }
    }
  } catch (err) {
    logger('warn', `模型覆盖读取失败，按 yml 走：${err?.message || err}`)
  }

  let client = null
  let engine = null
  let proactiveTimer = null
  let pestTimer = null
  let pestKickTimer = null
  // 「已关闭」日志只打一次：pestTick 每 15 分钟一轮，关掉之后每轮都记就成刷屏了
  let pestDisabledLogged = false
  let disposers = []
  /*
   * task-53 收口：pest 只有**一份实现**（独立包 dsh-qq-pest），主包不再保留内置副本。
   *   pestSource      —— 'package' = 独立包在供货；'missing' = 包没加载，功能整体关闭。
   *   pendingPestApi  —— 独立包若比主包先 apply，会先递接口过来；这时引擎还没建，
   *                      先攥着，等 boot() 建完 engine 再接（不丢、也不盲目 new）。
   */
  let pestSource = 'missing'
  let pendingPestApi = null
  // 落盘到 dataDir：重载插件后「上次说话」「已聊几条」不该归零
  const metrics = new Metrics({ dir: config.dataDir || config.memoryDir })

  const state = {
    get enabled() {
      return config.enabled !== false
    },
    set enabled(v) {
      config.enabled = !!v
    },
    get connected() {
      return client?.state === 'online'
    },
    get engine() {
      return engine
    },
    get client() {
      return client
    },
    /*
     * task-53：独立包 dsh-qq-pest 在 apply 时会调 state.attachPest(api) 请求接管。
     * 返回 true = 这次真的把 engine.pest 换成了它造的实例；false = 没接管（继续内置）。
     * 主包不 import 该包的任何文件，双向只认这两个宿主服务名。
     */
    attachPest: (api) => attachPest(api),
    get pestSource() {
      return pestSource
    },
    /*
     * task-55：只读的「现在到底用多大窗口」。
     * 这是观察值不是配置项 —— 要调档位去 DEFAULTS（contextLimit/maxTokens）
     * 和 memory.js 的 MEMORY_WINDOW_PROFILES；这里只负责摊开给人看，
     * 免得每次想知道生效值都得读源码或猜。
     */
    get windows() {
      return {
        profile: WINDOW_PROFILE,
        contextLimit: Number(config.contextLimit) || 0,
        maxTokens: Number(config.maxTokens) || 0,
        memory: { ...MEMORY_WINDOW },
      }
    },
  }

  /**
   * 把独立包 dsh-qq-pest 的 keeper 接到活引擎上（task-53 拆包接线的核心）。
   *
   * 单实现原则：主包**不再**内置 PestKeeper，也没有「退回内置实现」这条路。
   * 拿不到包 → engine.pest = null（功能关闭）+ state.pest 给出 available:false，
   * 缺口由 /state.plugins 的 missing 点名。宁可功能不可用，也不静默跑一份旧副本。
   *
   * 参数与 engine.js 原来的内置构造一一对应（拆包前后行为必须一致），
   * 唯一新增的是给 snapshot 打一个 source:'package' 标记，验收时一眼看出谁在供货。
   */
  function attachPest(api) {
    if (!api || typeof api.createKeeper !== 'function') {
      health.registerFailed?.({ name: 'qqPest', error: '接口不完整：缺 createKeeper' })
      logger('warn', 'pest 独立包接口不完整（缺 createKeeper），出气筒功能保持关闭')
      return false
    }
    if (pestSource === 'package') return true
    if (!engine) {
      pendingPestApi = api
      logger('info', 'pest 独立包先到了：等引擎建好再接')
      return false
    }
    try {
      const keeper = makePestKeeper(api, {
        dir: config.memoryDir,
        logger,
        targets: (Array.isArray(config.pestTargets) ? config.pestTargets : [])
          .map((x) => String(x || '').trim())
          .filter((x) => /^\d{5,12}$/.test(x)),
        dailyCap: Number(config.pestDailyCap ?? 8),
        intervalMinutes: Number(config.pestIntervalMinutes ?? 45),
        restWindows: config.restWindows || [],
        isKnown: (uid) => engine?.isAllowedUser?.(uid) === true,
        // 落盘位置和历史一致：同一个 pest-settings.json，拆包不该换文件
        settingsFile: path.join(config.dataDir || config.memoryDir || dataDir, 'pest-settings.json'),
        autoPick: config.pestAutoPick !== false,
      })

      engine.pest = keeper
      pestSource = 'package'
      state.pest = keeper.snapshot()
      health.registerModule?.({
        name: 'qqPest',
        version: api.version || '',
        exports: Object.keys(api),
        optional: true,
      })
      logger(
        'info',
        `出气筒已由独立包接管（${keeper.enabled ? '开' : '关'}｜对象 ${keeper.targets.join(',') || '（空）'}｜日额度 ${keeper.dailyCap}｜状态存 pest-settings.json）`,
      )
      return true
    } catch (err) {
      health.registerFailed?.({ name: 'qqPest', error: String(err?.stack || err) })
      logger('warn', `pest 独立包接管失败（出气筒功能关闭）：${err?.message || err}`)
      return false
    }
  }

  /**
   * 包没加载时的「空壳」：让 /pest 仍能 200 并说清原因，而不是 503/500。
   *
   * 空壳里所有开关都是 false，engine 侧那些 `this.pest?.enabled` 守卫会直接跳过，
   * 所以聊天链路完全不受影响；写操作的桩会抛一句人话，避免「改了但没生效」的错觉。
   */
  function installMissingPest(reason = 'qqPest 包未加载') {
    const snap = Object.freeze({
      available: false,
      source: 'missing',
      reason,
      enabled: false,
      disabled: true,
      targets: [],
      stopWord: '',
      dailyCap: 0,
      intervalMinutes: 0,
      todayUsed: 0,
    })
    const unavailable = () => {
      throw new Error(`出气筒不可用：${reason}`)
    }
    const shell = {
      ...snap,
      settingsFile: '',
      snapshot: () => ({ ...snap }),
      loadSettings: () => false,
      saveSettings: () => {},
      setTargets: unavailable,
      setDailyCap: unavailable,
      setIntervalMinutes: unavailable,
      setEnabled: unavailable,
    }
    if (engine) engine.pest = shell
    state.pest = { ...snap }
    logger('warn', `出气筒不可用：${reason}（/state.plugins 的 missing 里能看到 qqPest）`)
    return false
  }

  /**
   * 重新探一次 wbai 凭据。挂件上的「重新检查」按钮走的也是这条路。
   * 只更新 state.model，不动连接——用户点这个按钮是想知道"现在能不能回话"，
   * 不是想把 connection 重建一遍。
   *
   * 顺便把「到底在用哪个模型」写进 state.model：挂件左下的模型标签读的就是
   * 这里（用户 m11614-3）。之前只写 ok/expiresAt，挂件没法回答"她现在是
   * 谁在跑"，只能显示个「可用」。
   */
  const recheckModel = async () => {
    // /state.model 要反映**当前生效的聊天模型**：控制台切过模型后这里不能还显示 yml 的旧值
    const chatSpec = config.chatModel
    const modelId = (typeof chatSpec === 'string' ? chatSpec : chatSpec?.model) || config.model || ''
    const fb = config.fallbackModel || ''
    if (config.modelBackend === 'dsh' || !engine?.gateway) {
      state.model = { ok: true, note: 'dsh 后端（由宿主管理凭据）', model: modelId, fallback: fb }
      return state.model
    }
    try {
      const h = await engine.gateway.health()
      if (h.ok) {
        if (config.modelBackend === 'wb-proxy') {
          // realm 要露出来：intl 出口整组不可用时会「在线但回不出话」（stage=model-null），
          // 靠这个字段一眼分辨是出口问题还是别的问题。
          state.model = {
            ok: true,
            note: config.gatewayRealm ? `网关后端（realm 已钉 ${config.gatewayRealm}）` : '网关后端',
            baseUrl: h.baseUrl || '',
            model: modelId,
            fallback: fb,
            realm: h.realm || config.gatewayRealm || '',
            realmPinned: Boolean(config.gatewayRealm),
          }
          return state.model
        }
        logger('info', `wbai 凭据就绪：uid=${h.uid || '?'} 到期=${h.expiresAt ? new Date(h.expiresAt).toLocaleString('zh-CN') : '?'}`)
        state.model = {
          ok: true,
          uid: h.uid,
          expiresAt: h.expiresAt,
          // flavor 是 wbai 的计费/限流档位（cn / global），跟模型名一起显示才有意义
          flavor: h.flavor || '',
          model: modelId,
          fallback: fb,
        }
      } else {
        logger('error', `${config.modelBackend} 不可用：${h.error} —— 消息会收到但无法回复`)
        state.model = { ok: false, error: h.error, code: h.code, model: modelId, fallback: fb }
      }
    } catch (err) {
      state.model = { ok: false, error: String(err?.message || err), model: modelId, fallback: fb }
    }
    return state.model
  }

  /**
   * 问一次 NapCat「现在登的是谁」，写进 state.bot。
   *
   * 调用点有三处：启动连上后、每次 state 变成 online 时（含重连）、
   * 以及挂件的「重新检查」。必须容错：QQ 没登录时 get_login_info
   * 会失败或返回空，这时保留上一次的值（或 null），别把已有的名字抹掉。
   */
  const refreshLoginInfo = async () => {
    const info = await client?.getLoginInfo?.().catch(() => null)
    if (!info || !info.user_id) return state.bot
    const next = { userId: String(info.user_id || ''), nickname: info.nickname || '' }
    const prev = state.bot
    state.bot = next
    if (!prev || prev.userId !== next.userId || prev.nickname !== next.nickname) {
      logger('info', `当前登录：${next.nickname || '?'}(${next.userId || '?'})`)
    }
    return state.bot
  }

  // Web 状态挂件。**必须在 apply 阶段就建好并挂注入行**：
  // 桌面端的 index 注入表是宿主启动时一次性收集的，晚一步就永远不进表。
  // task-51：web.js 没加载上时这里为 null，下面的装配全部跳过，但插件仍能挂载。
  const widget = WebWidget
    ? new WebWidget({
        logger,
        config,
        state,
        engineRef: () => engine,
        recheck: recheckModel,
        refreshLogin: refreshLoginInfo,
      })
    : null
  if (widget) {
    widget.registerIndexInjectRow(root)
    disposers.push(() => widget.dispose())
  } else {
    logger('error', 'web.js 没加载上：Web 挂件/HTTP 路由这次不可用（状态见 /state.plugins）')
  }

  /*
   * 给 agent 会话注册 `qq_onebot` 工具。
   *
   * 起因（2026-10-18 真机，用户原话「命令不好用」）：
   * 「命令 检查群昵称状态是否重复」→ Molly 回「我没有接入 QQ 群成员列表的工具」。
   * 翻 session 记录确认：干活会话手里只有 weather / *_search / kimi_browser
   * 这些通用工具，压根没有能看 QQ 的入口。不是她笨，是我们没给手。
   *
   * 注册放在 apply 阶段而不是 boot 里：QQ 还没连上时工具也该在，
   * 否则「命令」链路建立得比 OneBot 连接早，那一轮就又看不到工具了。
   * 工具内部自己判 `client.state !== 'online'` 并给出人话。
   */
  // task-51：qqtools.js 是可选的（少了就只是没有 qq_onebot 工具）
  const qqTool = registerQqTool
    ? registerQqTool({
        ctx: root,
        getClient: () => client,
        logger,
      })
    : null
  state.qqTool = qqTool ? qqTool.status : { registered: false, error: 'qqtools.js 没加载上' }
  if (qqTool?.dispose) disposers.push(qqTool.dispose)

  /*
   * 插件工坊（用户 333333333：「写个插件……然后不挂载」）。
   *
   * 它只把草稿写进 qq-whale 之外的隔离目录、自测、打 zip；**没有任何**
   * 把草稿交给宿主加载的路径，所以初始化失败也只降级成「工具不可用」，
   * 绝不能影响聊天主链路。
   */
  let workshop = null
  try {
    workshop = Workshop ? new Workshop({ dir: config.workshopDir, logger }) : null
    if (!Workshop) logger('warn', 'workshop.js 没加载上：插件工坊这次不可用')
  } catch (err) {
    logger('warn', `插件工坊初始化失败：${err?.message || err}`)
  }
  // task-51：工坊工具依赖 workshop.js 和 qqtools.js，缺一个就跳过
  const wsTool =
    registerWorkshopTool && Workshop
      ? registerWorkshopTool({ ctx: root, getWorkshop: () => workshop, logger })
      : null
  state.workshopTool = wsTool ? wsTool.status : { registered: false, error: 'workshop 模块缺失' }
  if (wsTool?.dispose) disposers.push(wsTool.dispose)

  /**
   * 启动真正的连接。
   *
   * 必须等 llm 服务就绪——否则连上了 NapCat 却调不动模型，
   * 用户会看到"在线但不回话"这种最难查的故障。
   */
  const boot = async (ctx) => {
    // task-51：engine.js 是核心；没加载上就只记日志、不抛，插件仍挂载
    if (!ChatEngine) {
      logger('error', 'engine.js 没加载上：聊天/命令全部不可用（状态见 /state.plugins）')
      return
    }
    engine = new ChatEngine({ ctx, llm: ctx.llm, logger, config, client: null })
    // 指标挂在 engine 上：web.js 的 snapshot() 是从 engineRef() 拿的，
    // 早先 metrics 只存在于 apply 的局部变量里，挂件上那两行永远是 null。
    engine.metrics = metrics
    await engine.init()

    /*
     * task-53：引擎建好之后立刻做出气筒接线。
     *
     * 三种顺序都要能活：
     *   ① pest 包先 apply → 接口已存在 pendingPestApi → 现在接管；
     *   ② 主包先 apply → 这里主动 root.get('qqPest') 取一次；
     *   ③ 包根本没装 → installMissingPest()，功能关闭但 /pest 仍 200 且说明原因。
     * 「人类决定」的开关（enabled/targets/额度）由 makePestKeeper 里的 loadSettings()
     * 从 dataDir 的 pest-settings.json 载回，重载不会把人的选择冲掉。
     */
    try {
      const earlyApi = pendingPestApi || root.get?.('qqPest') || null
      pendingPestApi = null
      if (earlyApi && pestSource !== 'package') attachPest(earlyApi)
      if (pestSource !== 'package') installMissingPest()
    } catch (err) {
      logger('warn', `出气筒接线异常（功能保持关闭）：${err?.message || err}`)
      try {
        installMissingPest()
      } catch {}
    }

    // 挂进度播报：监听 DSH 的 todos 投影，干活时实时把清单推到 QQ。
    // 宿主没装 todo 插件时会安静降级（只打一条 info）。
    try {
      engine.progress.attach(ctx)
    } catch (err) {
      logger('warn', `进度播报挂载异常：${err?.message || err}`)
    }

    // 先探一次 wbai 凭据：模型后端不通就明确报警，
    // 否则用户看到"在线但不回话"，最难查。这里只警告，不阻断连接。
    // 这一步失败绝不能把整个 boot 干掉——用户可能只是还没开 WorkBuddy，
    // 开起来之后点一下挂件上的「重新检查」就能恢复。
    await recheckModel()

    // task-51：onebot.js 没加载上就只保留 engine（离线可用），不建连接
    if (!OneBotClient) {
      logger('error', 'onebot.js 没加载上：这次不连 QQ（状态见 /state.plugins）')
      return
    }
    client = new OneBotClient({
      url: config.onebotUrl,
      token: config.onebotToken,
      selfId: config.selfId,
      logger,
      onEvent: (ev) => onOneBotEvent(ev),
      onStateChange: (s) => {
        state.link = s
        logger('debug', `OneBot 状态 → ${s}`)
        /*
         * 每次连上（含重连）都重新问一次登录号。
         *
         * 早先只在 start() 成功那一瞬间写 state.bot，可插件启动的时机往往比
         * 扫码登录早 —— 那一次 get_login_info 拿到的是空，state.bot 就永远是
         * null，挂件上「当前登录」那行一直空着，看起来像没登录，其实人已经在
         * 聊了。重连回来（断网、NapCat 重启、换号重扫）时也必须刷新，
         * 否则换了号挂件还显示着旧名字。
         */
        if (s === 'online') refreshLoginInfo()
      },
    })
    engine.client = client

    try {
      await client.start(20000)
      logger('info', `已连上 NapCat：${config.onebotUrl}`)
      await refreshLoginInfo()
      /*
       * 群名片自愈（用户 m18386「群昵称重复了」）。
       *
       * 上一轮 if「在想…」之后进程重启，busy 标记丢了，名片就永远卡在
       * 「Molly（在想…）」，而基准抓的又是这个脏值，下次改出来就是
       * 「Molly（在想…）（在想…）」。连上后扫一遍，把带后缀的改回干净名。
       * 失败只记 debug —— 改不了名片不该影响聊天。
       */
      engine.healGroupCards().catch((err) => logger('debug', `群名片自愈异常：${err?.message || err}`))
    } catch (err) {
      logger('error', `连不上 NapCat（${config.onebotUrl}）：${err?.message || err}`)
      // 不抛：内部有重连，DSH 启动不该因为这个失败
    }

    // 主动联系定时器
    if (config.proactiveEnabled) {
      proactiveTimer = setInterval(
        () => {
          if (!engine || !state.connected || !config.enabled) return
          engine.maybeProactive().catch((e) => logger('warn', `主动联系失败: ${e?.message || e}`))
        },
        Math.max(60000, config.proactiveTickMinutes * 60000),
      )
      if (typeof proactiveTimer?.unref === 'function') proactiveTimer.unref()
      logger('info', `主动联系已开启（每 ${config.proactiveTickMinutes} 分钟检查一次）`)
    }

    /*
     * 出气筒定时器（用户 m17222）。
     *
     * 跟主动联系共用心跳间隔（proactiveTickMinutes），但内部闸门完全不同：
     *   - 停止词报备：一天一次，进 tick 的第一件事，最先做
     *   - 主动开团：五道闸门（额度/间隔/休息时段/熟人/静音），见 PestKeeper.canPick
     *
     * 为什么单独一个 timer 而不塞进 proactiveTimer 的回调里：
     * 主动联系受 `proactiveEnabled` 管，而骂街是人设的一部分，主人可能
     * 关掉"主动找我"但保留"主动找他茬"。两件事的开关必须独立。
     */
    if (engine?.pest?.enabled) {
      const tick = Math.max(60000, (config.proactiveTickMinutes || 15) * 60000)
      const pestTick = async () => {
        if (!engine || !state.connected || !config.enabled) return
        /*
         * 第一件事：判总开关（控制台「骂人模式」）。
         *
         * 必须放在最前面——关闭之后停止词报备和主动开团都要停，
         * 而这两件事在 engine 里各自还判一次 enabled（那是第二道保险）。
         * timer 本身不清：关一下再开就不用重启插件，下一轮自然恢复。
         */
        if (!engine.pest?.enabled) {
          if (!pestDisabledLogged) {
            pestDisabledLogged = true
            logger('info', '出气筒已关闭（控制台），巡检跳过')
          }
          return
        }
        pestDisabledLogged = false
        // ① 报备今天的停止词（一天一次，内部幂等）
        try {
          await engine.announceStopWord()
        } catch (e) {
          logger('debug', `停止词报备失败: ${e?.message || e}`)
        }
        // ② 主动挑起骂街
        try {
          await engine.maybePickFight()
        } catch (e) {
          logger('warn', `主动开团失败: ${e?.message || e}`)
        }
      }
      pestTimer = setInterval(pestTick, tick)
      if (typeof pestTimer?.unref === 'function') pestTimer.unref()
      /*
       * 立刻先跑一次，不等第一个 tick。
       *
       * 理由：停止词是"今天"的刹车，插件重载/DSH 重启之后主人手上那个词
       * 如果还是昨天的，等于没有刹车。等 7 分钟才报，这段时间里他喊停是无效的。
       * announceStopWord 内部按 stopSentAt 幂等，重复调用不会重复发。
       *
       * 用 setTimeout 而不是直接 await：启动路径上不能因为一次网络抖动
       * 把整个插件起不来。延迟 8 秒是给 OneBot 连接留出真正的 online 窗口
       * （上面 client.start 刚返回时 state.connected 可能还没置位）。
       */
      const kick = setTimeout(() => {
        pestTick().catch(() => {})
      }, 8000)
      if (typeof kick?.unref === 'function') kick.unref()
      pestKickTimer = kick
      logger(
        'info',
        `出气筒已开启：对象 ${engine.pest.targets.join(',')}｜日额度 ${engine.pest.dailyCap}｜每 ${Math.round(tick / 60000)} 分钟检查一次`,
      )
    }
  }

  /*
   * 事件环形缓冲（用户 m16800「molly 为什么不回 333333333」）。
   *
   * 桌面版没有日志文件，logger 写到哪里看不到。真机上「消息到底有没有进来」
   * 这个问题之前只能靠猜：关系表 lastSeenAt 停在某个时刻，能反推出"没进 onMessage"，
   * 但推不出"卡在哪一道闸门"。所以把每个进过 onOneBotEvent 的事件摘要留在内存里，
   * 从 /state 的 events 字段直接读，一眼看到是没收到、被 selfId 挡了、还是被开关挡了。
   *
   * 只存最近 50 条，单条截断 120 字，绝不留原始消息体（可能有隐私）。
   */
  const EVENTS_MAX = 50
  const eventRing = []
  const pushEvent = (stage, ev, extra) => {
    try {
      const row = {
        at: new Date().toISOString(),
        stage,
        postType: ev?.post_type || '',
        msgType: ev?.message_type || ev?.request_type || '',
        user: String(ev?.user_id || ''),
        group: String(ev?.group_id || ''),
        self: String(ev?.self_id || ''),
        text: String(ev?.raw_message ?? ev?.comment ?? '').slice(0, 120),
      }
      if (extra) Object.assign(row, extra)
      eventRing.push(row)
      while (eventRing.length > EVENTS_MAX) eventRing.shift()
    } catch {
      /* 诊断代码绝不能影响主流程 */
    }
  }
  state.events = eventRing

  /*
   * 私聊 `#` 命令通道（主人 m01007）。
   *
   * 为什么建在这里：事件环刚建好（命令命中要留痕），engine / metrics 已经能
   * 用 getEnv 现取（建的时候就快照永远是 null）。发送直接用 client 的原始
   * OneBot 段格式——命令要的是「一条，立刻」，不经过分段/打字机/表情包那套。
   */
  const pluginBootedAt = Date.now()
  const hashHandler = createHashHandler
    ? createHashHandler({
        config,
        getEnv: () => ({ state, engine, metrics, bootedAt: pluginBootedAt }),
        logger,
        onEvent: (type, ev, extra) => pushEvent(type, ev, extra),
        send: async ({ scene, id, text }) => {
          if (!client) throw new Error('OneBot 还没连上')
          const message = [{ type: 'text', data: { text } }]
          if (scene === 'group') await client.sendGroupMsg(id, message)
          else await client.sendPrivateMsg(id, message)
        },
      })
    : null
  if (!hashHandler) {
    logger('warn', '私聊 # 命令通道未启用：hash-commands.js 没加载上（/state.plugins 里点了名）')
  }

  /** OneBot 事件总入口：过滤自己、过滤命令、转给引擎 */
  const onOneBotEvent = (ev) => {
    try {
      /*
       * `post_type` 缺失时先推断，别急着丢。
       *
       * NapCat 对某些推送就是不发 `post_type`（onebot.js:23 的 classifyEvent
       * 早就为这件事写了兜底注释）。这里原来是 `if (!ev.post_type) return`，
       * 于是一个不带 post_type 的**好友申请**会被当成垃圾直接扔掉 ——
       * 表现就是「有人加 Molly，永远没动静」，而且连事件环里都只留一条
       * no-post_type，看不出是哪类事件。
       *
       * 判据按 OneBot 11 的字段独占性来：request 有 request_type，
       * notice 有 notice_type，message 有 message_type/raw_message。
       */
      if (!ev || !ev.post_type) {
        if (ev?.request_type) ev = { ...ev, post_type: 'request' }
        else if (ev?.notice_type) ev = { ...ev, post_type: 'notice' }
        else if (ev?.message_type !== undefined || ev?.raw_message !== undefined) ev = { ...ev, post_type: 'message' }
        else {
          pushEvent('no-post_type', ev)
          return
        }
        pushEvent('inferred-post_type', ev, { post_type: ev.post_type })
      }
      // 心跳不记，否则 50 条环里全是 meta_event，把真正的消息挤掉
      if (ev.post_type !== 'meta_event' && ev.post_type !== 'message_sent') pushEvent('in', ev)
      const self = String(ev.self_id || config.selfId || '')
      if (config.selfId && self && String(config.selfId) !== self) {
        pushEvent('drop-selfid', ev, { expect: String(config.selfId) })
        return
      }

      // 自己的消息：用于更新"最近说过话"，但不触发回复
      if (ev.post_type === 'message_sent') return

      if (ev.post_type === 'message') {
        if (String(ev.user_id) === self) {
          pushEvent('drop-self', ev)
          return
        }
        /*
         * 私聊 `#` 命令（主人 m01007）。**必须放在闭眼模式判定之前**：
         * 命令是管理通道，不是聊天——她闭着眼也照样能回菜单和状态；
         * 但总开关关了就是「彻底闭嘴」，这一条由 handler 内部自己判。
         * 返回 true = 这条已经被吃掉，绝不能继续往下走到模型链路。
         */
        if (hashHandler && hashHandler.handle(ev)) return
        if (config.blindMode) {
          pushEvent('drop-blind', ev)
          return
        }
        if (!config.enabled) {
          logger('debug', '总开关已关闭，忽略消息')
          pushEvent('drop-disabled', ev)
          return
        }
        pushEvent('to-engine', ev)
        logger('debug', `收到消息 ${ev.message_type} from ${ev.user_id}`)
        metrics.onIncoming(`${ev.message_type}:${ev.message_type === 'group' ? ev.group_id : ev.user_id}`)
        const t0 = Date.now()
        engine
          .onMessage(ev)
          .then(() => metrics.onReplied(Date.now() - t0))
          .catch((err) => {
            pushEvent('engine-error', ev, { error: String(err?.stack || err).slice(0, 300) })
            logger('error', `onMessage 抛错: ${err?.stack || err}`)
          })
        return
      }

      /*
       * 加好友 / 加群 请求（用户 m16260）。
       *
       * 这条通道跟普通消息完全分开：post_type 是 'request'，
       * 没有 user_id 之外的上下文，也不进聊天历史。以前的代码里
       * 它被完全忽略 —— 表现就是"有人申请加 Molly，永远石沉大海"。
       *
       * 现在的处理是「不自动同意，先问主人」：
       *   - 好友请求：私信主人「XXX 想加你好友，通过吗」
       *   - 群邀请：同样问主人，但批了之后还得真调用
       *     set_group_add_request，所以直接让主人回「1」触发
       *
       * 注意：绝不 auto_approve。这是安全底线——机器人号被外挂
       * 拉进赌博群/引流群是常态，自动放行等于把号送出去。
       */
      if (ev.post_type === 'request') {
        if (!config.enabled) return
        engine
          ?.onRequest?.(ev)
          .catch((err) => logger('warn', `处理申请事件失败: ${err?.message || err}`))
        return
      }

      /*
       * 通知类事件（2026-10-23 戳一戳；2026-10-24 撤回）。
       *
       * 以前 notice 一路落到函数末尾被静默丢弃——有人戳 Molly，她毫无反应，
       * 有人撤回消息她也照旧对着撤回内容回。现在分别递给 engine，
       * 这里只负责分发，不在这里写业务。
       */
      if (ev.post_type === 'notice') {
        if (!config.enabled) return
        /*
         * 撤回（2026-10-24，主人 m00480 需求②）。
         *
         * 放在 blindMode 判断**之前**：撤回要把 history 里那条剔掉、把在途
         * 回复作废，这是内务，闭眼模式也要做（不然睁眼后还会引用撤回内容）。
         * 轻回那句由 engine.onRecall 自己再判一次 blindMode。
         */
        if (ev.notice_type === 'group_recall' || ev.notice_type === 'friend_recall') {
          engine
            ?.onRecall?.(ev)
            .catch((err) => logger('warn', `处理撤回失败: ${err?.message || err}`))
          return
        }
        if (config.blindMode) return
        /*
         * 2026-10-26（主人 m07147：「你新人欢迎又是我手动的」）。
         *
         * 这里原来只把 poke 递给 engine，group_increase 一路落到 return 被静默
         * 丢弃 —— 表现就是「新人入群从不自动欢迎，只能主人手动发一句」。
         *
         * 现在所有 notice 都交给 engine.onNotice 判：它在内部先看 group_increase
         * （新人欢迎），再处理 poke（反戳/回话），其它类型一律返回 ignored。
         */
        engine
          ?.onNotice?.(ev)
          .catch((err) => logger('warn', `处理通知事件失败: ${err?.message || err}`))
        return
      }
    } catch (err) {
      logger('error', `事件处理抛错: ${err?.stack || err}`)
    }
  }

  // 等 llm 服务就绪再启动。用 root.inject 而不是对象级 inject，
  // 避免整个 apply 被推迟（见 dsh-whale-widget 的注释）。
  // 两个 inject 平级：挂件只要 webServer，不该被 llm 拖住，
  // 也不该因为 llm 迟迟不就绪而永远不出现。
  const startDisposer = root.inject(['llm'], (ctx) => {
    boot(ctx).catch((err) => logger('error', `启动失败: ${err?.stack || err}`))
  })
  if (typeof startDisposer === 'function') disposers.push(startDisposer)

  const webDisposer = root.inject(['webServer'], (wctx) => {
    try {
      widget.register(wctx)
    } catch (err) {
      logger('warn', `挂件注册失败：${err?.message || err}`)
    }
  })
  if (typeof webDisposer === 'function') disposers.push(webDisposer)

  // 卸载清理
  // 注意：必须是 async —— 里面要 await 拆干活会话（见下方注释）。
  root.effect(() => async () => {
    logger('info', 'dsh-qq-whale 卸载中…')
    if (proactiveTimer) {
      clearInterval(proactiveTimer)
      proactiveTimer = null
    }
    if (pestTimer) {
      clearInterval(pestTimer)
      pestTimer = null
    }
    if (pestKickTimer) {
      clearTimeout(pestKickTimer)
      pestKickTimer = null
    }
    // 先停播报，避免卸载过程中还有消息往 QQ 推
    try {
      engine?.progress?.disposeAll()
    } catch {}
    // 停掉备用脑探活定时器——不停的话插件重载后会残留一个永远在跑的 timer
    try {
      engine?.stopTraeHealthLoop?.()
    } catch {}
    /*
     * 把节流攒下的关系改动落盘（用户 m17037）。
     * RelationsStore.touch() 有 5 秒节流，平时靠下一次 touch 兜底，
     * 但卸载是一条捷径——这里不 flush，最后一次聊天计数就白记了。
     */
    try {
      engine?.relations?.flush?.()
    } catch {}
    /*
     * 拆干活会话必须**等着它拆完**（2026-10-18，用户 m19598 截图）。
     *
     * 原来这里是 fire-and-forget：
     *   Promise.resolve().then(() => engine?.executor?.dispose?.()).catch(...)
     * 也就是把 handle.dispose() 扔进微任务就不管了。而 cordis 卸载 fiber 是
     * 等这个 listener 返回就继续，于是可能出现「新实例已经在 resume 同一个
     * session，旧实例的写句柄还没释放」——直接撞
     *   SessionAlreadyOwnedError: session "qq-whale-work-..." is already owned
     *   by an active write handle  (JsonlBackendTracker.claimWrite)
     * 插件每次重启（off→on、宿主崩溃恢复）都会复现一次。
     *
     * 所以这里改成 await：先拆干净会话，再断 OneBot，最后跑其余 disposer。
     */
    const closeExecutor = async () => {
      try {
        await engine?.executor?.dispose?.()
      } catch (err) {
        console.warn?.('[qq-whale] 拆干活会话失败', err?.message || err)
      }
    }
    await closeExecutor()
    try {
      client?.stop()
    } catch {}
    for (const d of disposers) {
      try {
        d()
      } catch {}
    }
    disposers = []
  })

  /*
   * task-53：独立 pest 包可能比主包先 apply（宿主对同层插件不保证顺序）。
   * 这种时候它已经把 qqPest 服务挂好了，主包主动取一次即可，谁先谁后都不会坏。
   * 必须放在下面的「模块缺口告警」之前 —— 接管成功会把 qqPest 从 missing 里划掉，
   * 否则会给主人发一条假的「pest 没加载上」私信。
   */
  try {
    const early = pendingPestApi || root.get?.('qqPest') || null
    pendingPestApi = null
    if (early && pestSource !== 'package') attachPest(early)
    // 包没来（或来了但接口坏）：留一个空壳，保证 /pest 200 且说得清为什么不可用
    if (pestSource !== 'package') installMissingPest()
  } catch (err) {
    logger('warn', `取 pest 独立包接口失败（出气筒功能关闭）：${err?.message || err}`)
  }

  /*
   * task-51：apply 结束时报一次模块缺口。
   * **只在真缺东西时发**——正常启动一句都不发（用户要求别来烦）。
   * 走数组消息 + auto_escape=true，跟 reportCapture 的工具式发送区分开，
   * 不会被当成「agent 的自发汇报」吞掉。
   */
  try {
    const snap = health.snapshot?.() || null
    const gapText = snap ? health.gapAlertText?.(snap) : ''
    if (gapText) {
      logger('warn', gapText)
      const owner = String(config.ownerUin || (config.commanderUsers || [])[0] || '')
      if (client && owner && typeof client.sendPrivateMsg === 'function') {
        client
          .sendPrivateMsg(owner, [{ type: 'text', data: { text: gapText } }], true)
          .catch((err) => logger('warn', `模块缺失告警发送失败：${err?.message || err}`))
      } else {
        logger('warn', '模块缺失告警没发出去：还没有可用连接或没配置主人号（状态已进 /state.plugins）')
      }
    }
  } catch (err) {
    logger('warn', `模块缺口检查异常（不影响运行）：${err?.message || err}`)
  }

  // 暴露给同一进程内的其他插件 / console 命令使用
  // 用 provide（不是 set）：只有 provide 注册的服务才跨插件可见，
  // dsh-qq-pest 正是靠 ctx.get('qqWhale') 反向拿到 attachPest。
  try {
    if (typeof root.provide === 'function') root.provide('qqWhale', state)
    else root.set?.('qqWhale', state)
  } catch {}

  return state
}

/**
 * task-53：用独立包给的 `qqPest` 接口造一个 keeper 实例（导出给测试直接调）。
 *
 * 与 engine.js 原来的内置构造的唯一差别：① 参数由调用方显式传齐（不再读 config），
 * 方便测试；② snapshot() 多一个 `source:'package'` 标记，用来在控制台区分
 * 「现在是谁在供货」。
 *
 * 失败一律抛 —— 由 attachPest 捕获并把功能整体关掉（主包不再有内置副本可退），
 * 绝不让包级问题冒到聊天链路。
 */
export function makePestKeeper(
  api,
  { dir, logger, targets, dailyCap, intervalMinutes, restWindows, isKnown, settingsFile, autoPick = true } = {},
) {
  if (!api || typeof api.createKeeper !== 'function') {
    throw new Error('qqPest 接口不完整：缺 createKeeper')
  }
  const keeper = api.createKeeper({
    dir,
    logger,
    targets,
    dailyCap,
    intervalMinutes,
    restWindows,
    isKnown,
    settingsFile,
  })
  if (!keeper || typeof keeper.snapshot !== 'function') {
    throw new Error('createKeeper 没返回可用的 keeper（缺 snapshot）')
  }
  keeper.autoPick = autoPick
  // 把盘上「人关过」的决定载回来，否则独立包一接管就自己开了
  if (typeof keeper.loadSettings === 'function') keeper.loadSettings()
  // engine 的反击判定走 `this.pest.detectInjection?.(text)`，检测函数也由包提供
  keeper.detectInjection = typeof api.detectInjection === 'function'
    ? api.detectInjection
    : () => ({ hit: false })
  const snapshotOf = keeper.snapshot.bind(keeper)
  /*
   * 快照字段口径统一（lead 验收要求）：
   * 「包在供货」和「包没加载」两种状态都必须带 `available`，否则前端/文档两头
   * 一个有一个没有。package 态 available:true，missing 态 available:false。
   */
  keeper.snapshot = () => ({ ...snapshotOf(), available: true, source: 'package' })
  return keeper
}

/** 日志：优先用 DSH logger，否则用 console 并按级别过滤 */
function makeLogger(root, level) {
  const order = { debug: 10, info: 20, warn: 30, error: 40 }
  const min = order[level] ?? 20
  let base = null
  try {
    base = root?.logger?.('qq-whale')
  } catch {}

  return (lv, msg) => {
    const l = String(lv || 'info')
    if ((order[l] ?? 20) < min) return
    const text = String(msg ?? '')
    if (base && typeof base[l] === 'function') {
      try {
        base[l](text)
        return
      } catch {}
    }
    const tag = `[qq-whale/${l}]`
    if (l === 'error') console.error(tag, text)
    else if (l === 'warn') console.warn(tag, text)
    else console.log(tag, text)
  }
}

// 默认导出必须跟上面保持一致：不导出 Config（理由见 `_configShapeReference` 上方那段注释）。
// 这里多写一个不存在的符号会让整个模块在加载期就 ReferenceError —— 而宿主对插件
// 加载失败的处理是「静默跳过」，表现就是路由 404、日志里什么都没有，极难排查。
export default { name, apply }
