/**
 * DSH Web 左下角的状态挂件（宿主侧）。
 *
 * 为什么单独一个文件：这坨东西跟"聊天逻辑"完全无关，但它同时要碰
 * webServer 路由、index 注入和状态快照三件事，塞进 index.js 会把那个
 * 本就 400 行的启动流程彻底淹没。
 *
 * 三条路由（全部只读或幂等，不做任何破坏性操作）：
 *   GET  /dsh-qq-whale/state    → 状态快照，前端 4 秒轮询一次
 *   POST /dsh-qq-whale/toggle   → {"enabled": bool} 开关机器人
 *   POST /dsh-qq-whale/recheck  → 重新探一次 wbai 凭据
 *
 * 网关的坑（照抄 dsh-whale-widget 踩出来的经验）：
 *   - **绝不能写对象级 inject: ['webServer']**。桌面端的 index 注入表是宿主
 *     启动时一次性收集的，apply 一旦被推迟，注入行就永远进不了表。
 *     正确做法是 apply 里立刻挂 `webserver/index-inject`，webServer 本身用
 *     root.inject 局部等待。
 *   - 注入行必须是**内联 script**（kind:'script'），不是 script-src ——
 *     后者加载失败会 reject 掉整个 __DSH_BOOT_READY__，直接把应用搞崩。
 *   - 挂件脚本自己建 <script src> 并吞掉 onerror：路由在就加载，不在就静默。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { addLearnedHash, removeLearnedHash } from './sticker-learn.js'
// qq 是记忆的唯一身份（2026-10-19）：校验规则只写在 memory.js 一处，
// 免得控制台和引擎两边各写一套正则、慢慢就跑偏了。
import { isValidQq } from './memory.js'
// 运行时切模型（task-56）：可选清单 + override 读写都在这个小模块里
import {
  ROLES as MODEL_ROLES,
  SWITCH_HEADER,
  applyToConfig as applyModelToConfig,
  authorizeSwitch as authorizeModelSwitch,
  currentOf,
  mergeGatewayModels,
  modelsUrlOf,
  readOverride as readModelOverride,
  writeOverride as writeModelOverride,
} from './model-override.js'
// task-50：HTTP 出口也要过一遍出站清洗（ACP 标记 / markdown / 内部 id）。
// QQ 投递路径早就有 cleanForQQ(sanitizeOutbound())，这几条 HTTP 路由漏了，
// 真机上 /work/run 的 text 开头直接是 `<acp tokens="65" …>m00085</acp>`。
import { sanitizeOutbound } from './persona-sanitize.js'
// task-51：/state.plugins 的模块健康快照（main.js 装配时登记同一份 registry）
import { snapshot as moduleSnapshot } from './module-health.js'

const ROUTE_PREFIX = '/dsh-qq-whale'

/*
 * 复刻网关算消息哈希的那一行 Python（wb_proxy.py）：
 *     def h(obj):
 *         blob = json.dumps(obj, ensure_ascii=False, sort_keys=True).encode("utf-8")
 *         return hashlib.sha256(blob).hexdigest()[:12]
 *
 * 不能直接 JSON.stringify：Python 默认分隔符是 ", " 和 ": "，且 sort_keys=True
 * 会按键名排序，而 JS 的 JSON.stringify 用 "," / ":" 并且保持插入序。
 * 少一个空格哈希就全不一样，所以这两个差异必须逐字对齐。
 */
function pyJson(obj) {
  if (Array.isArray(obj)) return `[${obj.map(pyJson).join(', ')}]`
  if (obj && typeof obj === 'object') {
    const keys = Object.keys(obj).sort()
    return `{${keys.map((k) => `${JSON.stringify(k)}: ${pyJson(obj[k])}`).join(', ')}}`
  }
  return JSON.stringify(obj)
}

function pyHash(obj) {
  const blob = Buffer.from(pyJson(obj), 'utf8')
  return crypto.createHash('sha256').update(blob).digest('hex').slice(0, 12)
}


/*
 * ── 控制台 CRUD 的校验常量（契约 §2，2026-10-19）────────────────────
 *
 * 这些数都来自契约，改之前先看 docs/console-crud-contract.md：
 *   - 记忆正文 1..200 字（超长的该拆成多条，不是塞成一段）
 *   - weight 1..5，越高的越不该被上下文压缩掉
 *   - kind 是白名单，前端下拉框跟着它走
 *   - 单张表情包 ≤ 8 MB；正文上限按 base64 膨胀（约 4/3）+ JSON 外壳放宽
 */
const MEMORY_KINDS = ['fact', 'preference', 'promise', 'person', 'event', 'work', 'sticker']
const MEMORY_TEXT_MAX = 200
const MEMORY_WHO_MAX = 40
const STICKER_MAX_BYTES = 8 * 1024 * 1024
const UPLOAD_BODY_LIMIT = Math.ceil(STICKER_MAX_BYTES * 1.4) + 8192

/** 按「字」算长度：emoji 占两个 UTF-16 单元，不能按 .length 数 */
function charLen(s) {
  return [...String(s ?? '')].length
}

/** 统一失败响应：`{ok:false,error}` + 合适的状态码 */
function sendFail(res, code, error) {
  sendJson(res, code, { ok: false, error })
}

/**
 * 轻量防伪造：只认回环 Host、拒绝跨站 Sec-Fetch-Site、带 Origin 时要求同源。
 * 这不是要替代宿主的鉴权栅栏（connection.requestRejection），而是补一层
 * 兜底——这插件可能装在老宿主上，那里没有那套栅栏。
 */
function isTrustedRequest(req) {
  try {
    const host = String(req.headers?.host || '').toLowerCase()
    const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')
    const loopback =
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '::1' ||
      /^127\.\d+\.\d+\.\d+$/.test(hostname)
    if (!loopback) return false
    if (String(req.headers?.['sec-fetch-site'] || '').toLowerCase() === 'cross-site') return false
    const origin = req.headers?.origin
    if (origin) {
      try {
        if (new URL(String(origin)).host.toLowerCase() !== host) return false
      } catch {
        return false
      }
    }
    return true
  } catch {
    return false
  }
}

function readBody(req, limitBytes = 8192) {
  return new Promise((resolve) => {
    let size = 0
    let overflow = false
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (!overflow && size > limitBytes) {
        /*
         * 超限时**绝不能**直接 req.destroy()：客户端还在往里写，连接被我们掐断
         * 时它收到的是 ECONNRESET（控制台只能显示「网络错误」），而不是能读懂的
         * 413。实测 9 MB base64 走老代码就是这样：服务端一个字节都没回。
         *
         * 所以这里只做三件事：停止缓存、丢掉已缓存的块、把剩下的数据静默排空，
         * 等 'end' 正常到达，再由路由层按 req.__bodyOverflow 回一个干净的 413。
         * 排空也留硬上限（limit + 100 MB），真有人灌几个 G 还是得掐。
         */
        overflow = true
        req.__bodyOverflow = { limitBytes, size }
        chunks.length = 0
        return
      }
      if (overflow) {
        if (size > limitBytes + 100 * 1024 * 1024) {
          req.destroy()
          resolve('')
        }
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(overflow ? '' : Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
  })
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * 读 JSON 请求体。返回 null 表示已经回过错误响应了，调用方直接 return。
 * `limitBytes` 要传够：上传接口的 base64 正文能到 11 MB 量级。
 * `tooLarge` 是超限时的状态码与文案——上传接口给 413 + 人话，其余保持 400。
 */
async function readJson(
  req,
  res,
  limitBytes = 8192,
  tooLarge = { code: 400, message: '请求体为空或超过大小上限' },
) {
  const raw = await readBody(req, limitBytes)
  if (req.__bodyOverflow) {
    sendFail(res, tooLarge.code, tooLarge.message)
    return null
  }
  if (!raw) {
    sendFail(res, 400, '请求体为空')
    return null
  }
  try {
    const body = JSON.parse(raw)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object')
    return body
  } catch {
    sendFail(res, 400, '请求体不是合法 JSON 对象')
    return null
  }
}

export class WebWidget {
  /**
   * @param {object} opts
   * @param {object} opts.logger
   * @param {object} opts.config   插件配置（要能改 enabled）
   * @param {object} opts.state    对外状态对象（lib/index.js 里那个）
   * @param {() => object|null} opts.engineRef  拿当前 engine
   * @param {() => Promise<object>} opts.recheck 重新探 wbai
   * @param {() => Promise<object>} [opts.refreshLogin] 重新问一次 NapCat「登的是谁」
   */
  constructor({ logger, config, state, engineRef, recheck, refreshLogin }) {
    this.logger = logger
    this.config = config
    this.state = state
    this.engineRef = engineRef
    this.recheck = recheck
    this.refreshLogin = refreshLogin
    // task-51：模块健康快照函数。单独存成属性，测试里可以置 null 模拟「取不到」。
    this.moduleSnapshot = moduleSnapshot
    this.widgetJs = ''
    this.disposers = []
  }

  loadWidgetJs() {
    const p = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'assets', 'qq-widget.js')
    // 故意不缓存：挂件是纯静态文件，14KB 一次读取的开销可以忽略，而缓存会让
    // "改完 assets/qq-widget.js 刷新页面却没变化" 变成一个反复浪费时间的坑。
    // 前端那边本来就带 Cache-Control: no-store，刷新即最新。
    try {
      this.widgetJs = fs.readFileSync(p, 'utf8')
    } catch (err) {
      this.logger('warn', `挂件脚本读取失败（${p}）：${err.message}`)
      this.widgetJs = ''
    }
    return this.widgetJs
  }

  /** 把内部状态翻译成前端要的形状。字段名故意取得很直白。 */
  snapshot() {
    const e = this.engineRef()
    const s = this.state || {}
    // state.link 有两种历史写法：早期是 {ready,state} 对象，后来 index.js 的
    // onStateChange 直接把字符串（'connecting'/'online'…）赋给它。两种都要认，
    // 否则字符串没有 .ready 属性 → 永远显示「QQ 未连接」这个假故障。
    const linkState = typeof s.link === 'string' ? s.link : (s.link && s.link.state) || ''
    const linkReady =
      typeof s.link === 'string'
        ? s.link === 'online'
        : s.link
          ? !!s.link.ready
          : !!s.connected
    const out = {
      enabled: this.config.enabled !== false,
      link: { ready: linkReady, state: linkState },
      bot: s.bot || null,
      model: s.model || null,
      metrics: null,
      learner: null,
      memory: null,
      budget: null,
      stickers: null,
      plugins: null,
      // task-55：上下文/记忆窗口的生效值（contextLimit / maxTokens / 记忆条数）。
      // 之前这几个数改完没地方核，只能靠猜「到底生效没有」。
      windows: null,
    }
    /*
     * task-51：模块健康快照（哪个子模块没加载上）。取不到就整块 null，不编造。
     * 这份 registry 是进程内单例，和 main.js 装配时登记的是同一份（同一个
     * gen-<rev> 目录里的同一个 URL，ESM 只求值一次）。
     */
    try {
      out.plugins = typeof this.moduleSnapshot === 'function' ? this.moduleSnapshot() : null
    } catch {
      out.plugins = null
    }
    // 窗口值：state.windows 是 main.js 上的只读 getter，读它本身可能抛，所以单独兜一层
    try {
      out.windows = s.windows || null
    } catch {
      out.windows = null
    }
    // 这些统计都包在 try 里：任何一项挂掉都不该让整个挂件变空白
    try {
      const m = e?.metrics
      if (m) out.metrics = m.snapshot()
    } catch {}
    /*
     * 行为计数（P0，2026-10-21）：replies / lightReactions / likes /
     * stickersSent / stickerFallback / unmatched / sprinkled。
     * 进程内计数，重载归零；用来回答"她这一轮到底多说了多少"。
     */
    try {
      const s = e?.stats
      if (s) out.stats = { ...s }
    } catch {}
    /*
     * 表情包学习统计。
     *
     * 这里必须区分**累计**和**本次进程**两个数：
     *
     *   - `learner.stats`（kept/rejected/dup）是 StickerLearner 实例上的计数器，
     *     **活着的时候才存在**。DSH 一重启它就归零了。
     *   - 用户看到的现象是：图库里明明躺着 14 张学来的图，面板却写「学到表情 0 张」，
     *     第一反应是"她什么都没学到"或"数据丢了"。这是纯粹的显示口径错误，
     *     不是学习功能坏了（m15122 用户截图）。
     *
     * 所以累计数从**真正的持久来源**算：
     *   ① memory.entries 里 kind === 'sticker' 的条数（每学一张写一条）
     *   ② 学来的目录里的实际文件数
     * 两者取大——万一某次记忆写入失败，目录里的图还在，也不该显示成 0。
     * 本次进程的增量仍然保留在 learner 里，用于排查"这一轮学了没"。
     */
    try {
      const l = e?.learner?.stats
      if (l) out.learner = { kept: l.kept || 0, rejected: l.rejected || 0, dup: l.dup || 0 }
      // P0：累计/今日/拒绝原因来自 .learned-stats.json（learner.snapshot()），
      // 这是唯一跨重启的口径；上面那三个数只是本次进程的增量。
      try {
        const snap = e?.learner?.snapshot?.()
        if (snap) out.learner = { ...(out.learner || {}), ...snap }
      } catch {}
      const mem = e?.memory?.entries
      const fromMem = Array.isArray(mem) ? mem.filter((x) => x?.kind === 'sticker').length : 0
      // StickerLibrary 的 items 里，"学来的"子目录下的那部分就是学来的
      const items = e?.stickers?.items
      const fromDir = Array.isArray(items)
        ? items.filter((it) => /(^|[\\/])学来的[\\/]/.test(String(it?.file || it?.path || ''))).length
        : 0
      // learner 里在跑的那些（可能还没写进 memory）也算上，避免刚学完那一刻显示落后
      const inFlight = Math.max(0, (l?.kept || 0) - fromMem)
      const learnedTotal = Math.max(fromMem, fromDir) + (fromMem === 0 ? inFlight : 0)
      out.learner = { ...(out.learner || { kept: 0, rejected: 0, dup: 0 }), total: learnedTotal }
      // 记忆入库闸门的计数（2026-10-19）：added / rejected / pending / dup。
      // rejected 恒等于 pending + dup，见 engine.remember() 的注释。
      // `queued` 是待核实区**当前真实条数**：`pending` 是「拦截次数」，
      // 24h 内同一条重复被拦时 pending 会涨而队列不变，两个数别混着看。
      if (e?.memoryGate) {
        out.learner.memory = {
          ...e.memoryGate,
          queued: typeof e.memoryPending?.count === 'function' ? e.memoryPending.count() : null,
        }
      }
    } catch {}
    try {
      const mem = e?.memory?.entries
      if (Array.isArray(mem)) out.memory = { count: mem.length }
    } catch {}
    // 今日免费积分用量。挂件上要能直接看到剩多少——
    // 用户是看着这个数字决定要不要关掉限制的。
    try {
      const b = e?.budget
      if (b?.snapshot) out.budget = b.snapshot()
    } catch {}
    /*
     * 备用脑的日预算（cn flash，500 分/天，用户 m15210/m15220）。
     *
     * 跟 budget 分开报：budget 是「主脑还能不能花积分」，
     * spare 是「退路还能烧多久」。两个数字看的是完全不同的两件事，
     * 合在一起会让人误判。
     */
    try {
      const sp = e?.spare
      if (sp?.snapshot) out.spare = sp.snapshot()
    } catch {}
    // 图库张数：现在她主动用图了，用户会想知道"手里到底有多少张"
    try {
      const items = e?.stickers?.items
      if (Array.isArray(items)) out.stickers = { count: items.length }
    } catch {}
    /*
     * 接盘模型是否就位。
     *
     * 这个字段是给排查用的：额度烧完之后如果 trae 建不起来，她会突然沉默，
     * 而"沉默"和"额度用完"在聊天里看起来一模一样，没法区分。挂件上能一眼
     * 看到 ready=false，就知道该去查 dsh-connect-trae 的登录态，而不是
     * 怀疑她坏了。
     */
    try {
      out.trae = {
        ready: Boolean(e?.trae),
        provider: this.config.traeProvider || 'trae',
        model: this.config.traeModel || '',
        /*
         * 健康状态（用户 m15046：「备用脑应该随时更新」）。
         *
         * 由 engine.startTraeHealthLoop 定期探活写入 this.traeHealth。
         * 挂件上按 ok 三态上色：true 绿、false 红（失联）、缺省灰（还没探过）。
         * 没这个字段的话，"trae 建起来了"和"trae 真的能出词"看起来一样，
         * 等真需要它接盘时才发现是死的，那就来不及了。
         */
        health: e?.traeHealth || null,
      }
    } catch {}

    /*
     * 「此刻到底哪个模型在替她说话」。
     *
     * 用户 m11614-3 原话：「在左下角状态栏增加一个可看当前是什么模型在运行她」。
     * 之前的 snapshot 只有 model（wbai 探活结果）和 trae（备用脑），都回答
     * 不了这个问题——额度没超的时候到底用哪个 flavor，代码里散在三处配置里，
     * 肉眼看不出来。
     *
     * 所以这里算一个 effective：额度还有 → 主模型；额度烧完且 trae 就位 →
     * trae。挂件小圆点旁边直接显示它，点开还能看完整链路。
     *
     * 注意 flavor 也要带上：wbai 同一个模型有 free/soft_rate 等多个 flavor，
     * 额度和限流都按 flavor 算，只显示模型名会漏掉关键信息。
     */
    try {
      const exhausted = Boolean(e?.budget && e.budget.canSpend && !e.budget.canSpend())
      /*
       * 分层（用户 m15210 / m15220 定案）：
       *   ① 主脑 intl 免费 flash —— 默认，credit=0
       *   ② 主脑降级 cn v4-pro   —— 免费车道被限流时（slowMode）
       *   ③ 备用脑 cn flash       —— 主脑两条都不通，日限 500 分
       *   ④ trae v4-pro           —— 备用脑烧满
       * 这里只报"配置上现在是哪个档"，实际每轮走哪层由 engine 在运行时决定，
       * 真实发生的那次调用会通过 res.model / res.backend 回来，记在日志里。
       */
      const usingTrae = exhausted && Boolean(e?.trae)
      const spareOut = Boolean(e?.spare && e.spare.canSpend && !e.spare.canSpend())
      // flavor 来自 wbai 的凭据文件（cn/global），不是配置项——从探活结果里读
      const flavor = usingTrae ? '' : (e?.model?.flavor || s.model?.flavor || '')
      const modelId = usingTrae
        ? this.config.traeModel || ''
        : this.config.model || e?.model?.model || ''
      out.active = {
        degraded: usingTrae,
        provider: usingTrae ? this.config.traeProvider || 'trae' : this.config.provider || 'wbai',
        model: modelId,
        flavor,
        label: usingTrae
          ? `${this.config.traeModel || 'trae'}（降智）`
          : [modelId, flavor].filter(Boolean).join(' · ') || '未知',
        // 一句话说清"为什么是它"，省得点开面板还得猜
        reason: usingTrae
          ? '主脑与备用脑都不可用，切到 trae 降智'
          : spareOut
            ? '备用脑额度已烧满'
            : '主脑优先（intl 免费 flash）',
      }
    } catch {}
    /*
     * 三会话路由状态（task-46）：最近一次路由 + 三条会话各自的计数与模型。
     * 排查「这句话为什么进了查询/改代码会话」时不用再猜。
     */
    try {
      const rs = e?.routeState
      if (rs) {
        out.route = {
          last: rs.last ? { ...rs.last } : null,
          counts: { ...(rs.counts || {}) },
          sessions: {
            chat: {
              sessionId: `qq-whale-chat-${e?.config?.selfId || 'bot'}`,
              model: e?.config?.chatModel || null,
            },
            work: {
              sessionId: e?.executor?.workSessionId?.() || '',
              model: e?.config?.workModel || null,
              running: Boolean(e?.executor?.running),
            },
            code: {
              sessionId: e?.codeExecutor?.workSessionId?.() || '',
              model: e?.config?.codeModel || null,
              running: Boolean(e?.codeExecutor?.running),
              ready: Boolean(e?.codeExecutor?.handle),
            },
          },
        }
      }
    } catch {}
    /*
     * 干活会话（「命令 xxx」背后那个 DSH agent）的状态。
     *
     * 用户 m03864 报过「私聊命令只出开工语，永远没有结果」。那条链路的失败
     * 发生在 ensureHandle()，而桌面版根本没有常规运行日志，等于彻底隐身。
     * 这里把「建没建成 / 卡在哪一步」直接暴露成一个可 GET 的字段，
     * 排查时不用再猜，也不用让主人去翻日志目录。
     */
    try {
      const ex = e?.executor
      if (ex) {
        out.work = {
          ready: Boolean(ex.handle),
          sessionId: typeof ex.workSessionId === 'function' ? ex.workSessionId() : '',
          running: Boolean(ex.running),
          task: ex.running ? String(ex.running.task || '').slice(0, 60) : '',
          /* 最近一次失败的原因。成功时清空，避免旧错误一直挂着误导人。 */
          error: ex.lastError ? String(ex.lastError) : '',
        }
      }
    } catch {}
    /*
     * 「先查再说」的状态。
     *
     * 这一项存在的理由和 trae 那个字段一样：查网是一个**看不见的中间步骤**。
     * 她查到了，回复里就会带具体数字；她没查，回复就是"不知道"——而"不知道"
     * 也可能是真不知道、网络挂了、判定没命中、上游没给结果，四种情况在聊天
     * 里长得一模一样。挂件上能直接看到 lastNeed/lastReason，就能分清。
     */
    try {
      out.research = {
        enabled: this.config.researchEnabled !== false,
        ok: Boolean(e?.researcher?.available),
        lastAt: Number(e?.lastResearch?.at || 0),
        lastNeed: Boolean(e?.lastResearch?.need),
        lastReason: String(e?.lastResearch?.reason || ''),
        lastFound: Boolean(e?.lastResearch?.found),
        lastMs: Number(e?.lastResearch?.ms || 0),
        count: Number(e?.researchCount || 0),
      }
    } catch {}
    /*
     * 陌生人审批队列（用户 m16260）。
     *
     * 为什么要暴露：审批提示是私信发给主人的，但主人可能同时在别的设备上，
     * 或者提示被刷过去了。挂件上能看到"还有几个人在等我批"，就不用翻聊天记录。
     * 只读，不提供"直接批准"的按钮 —— 审批必须在 QQ 里回，那里才有身份。
     */
    try {
      if (e?.gatekeeper?.snapshot) {
        const g = e.gatekeeper.snapshot()
        out.gatekeeper = {
          owners: g.owners || [],
          pending: (g.pending || []).length,
          pendingList: g.pending || [],
          approved: (g.approved || []).length,
          denied: (g.denied || []).length,
        }
      }
    } catch {}
    /*
     * 出气筒快照（用户 m17222）。
     *
     * 只暴露「今天的停止词/还剩几次/有没有被静音/被塞过几次」，
     * **不暴露**任何一句被判定为注入的原文——那是别人发的内容，
     * 面板是给主人看的，没必要把垃圾话再抄一遍。感染的次数和原因足够。
     */
    try {
      if (e?.pest?.snapshot) {
        const p = e.pest.snapshot()
        out.pest = {
          enabled: p.enabled,
          targets: p.targets,
          stopWord: p.stopWord,
          stopSentAt: p.stopSentAt,
          muted: p.muted,
          mutedUntil: p.mutedUntil,
          dailyCap: p.dailyCap,
          used: p.used,
          remain: p.remain === Infinity ? -1 : p.remain,
          lastAt: p.lastAt,
          date: p.date,
          infections: p.infections || {},
        }
      }
    } catch {}
    /*
     * `qq_onebot` 工具的注册状态（用户 m18088「命令不好用」）。
     *
     * 注册失败时插件不会崩（聊天要继续），但必须能被看见——否则用户又只能
     * 靠「命令不灵」这种体感猜。挂件和 /state 都能直接读到这几行。
     */
    try {
      out.qqTool = this.state?.qqTool || { registered: false, error: '未初始化' }
    } catch {
      out.qqTool = { registered: false, error: '读取异常' }
    }
    /*
     * 事件环形缓冲（用户 m16800「molly 为什么不回 333333333」）。
     *
     * 桌面版没有日志文件，之前排查"消息到底进没进来"只能靠关系表时间戳反推。
     * 现在直接把最近 50 个进入 onOneBotEvent 的事件摘要吐出来：stage 说明它走到哪一步
     * （in / to-engine / drop-selfid / drop-blind / drop-disabled / engine-error）。
     * 只读、只保留最近 50 条、正文截断 120 字。
     */
    try {
      out.events = Array.isArray(this.state?.events) ? this.state.events.slice(-50) : []
    } catch {
      out.events = []
    }
    return out
  }

  register(ctx) {
    const ws = ctx.webServer
    if (!ws || typeof ws.register !== 'function') {
      this.logger('info', '没有 webServer 服务，左下角挂件跳过（QQ 功能不受影响）')
      return
    }

    const wrap = (handler) => ({
      handler: async (req, res) => {
        if (!isTrustedRequest(req)) {
          sendJson(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        try {
          await handler(req, res)
        } catch (err) {
          this.logger('warn', `挂件路由异常：${err?.message || err}`)
          try {
            sendJson(res, 500, { ok: false, error: String(err?.message || err) })
          } catch {}
        }
      },
    })

    const add = (route) => {
      try {
        const d = ws.register(route)
        if (typeof d === 'function') this.disposers.push(d)
      } catch (err) {
        this.logger('warn', `挂件路由注册失败 ${route.path}：${err?.message || err}`)
      }
    }

    add({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/state`,
      ...wrap(async (req, res) => {
        sendJson(res, 200, this.snapshot())
      }),
    })

    /*
     * 骂人模式总开关（用户 2026-10-19 23:34：「在控制台加一个开关，开了就进入骂他的模式」）。
     *
     * 一个路径同时干两件事，因为控制台/挂件都只关心"读现状 + 写一次"：
     *   GET  /pest → 今天的停止词、开关、对象、额度、下次可开团还有几分钟
     *   POST /pest → {enabled?, targets?, dailyCap?, intervalMinutes?} 改完**立即**作用到活对象
     *
     * 为什么不需要重启：PestKeeper.enabled 是 getter，引擎每个判断点都现读，
     * 没有缓存副本。写盘只是为了重载后还记得人关过。
     */
    add({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/pest`,
      ...wrap(async (req, res) => {
        const e = this.engineRef?.()
        const pest = e?.pest
        if (!pest) {
          sendJson(res, 503, { ok: false, error: '出气筒还没就绪（engine 未创建），稍后再试' })
          return
        }
        if (req.method === 'GET') {
          sendJson(res, 200, {
            ok: true,
            state: pest.snapshot(),
            // 会不会跨重载保留：给控制台一句人话用，不是必须字段
            persisted: Boolean(pest.settingsFile),
          })
          return
        }
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const raw = await readBody(req)
        let body
        try {
          body = JSON.parse(raw || '{}')
        } catch {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          return
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON 对象' })
          return
        }
        const fields = ['enabled', 'targets', 'dailyCap', 'intervalMinutes'].filter(
          (k) => body[k] !== undefined,
        )
        if (fields.length === 0) {
          sendJson(res, 400, { ok: false, error: '没有要改的字段' })
          return
        }
        if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
          sendJson(res, 400, { ok: false, error: 'enabled 必须是 true / false' })
          return
        }
        if (body.targets !== undefined) {
          if (!Array.isArray(body.targets)) {
            sendJson(res, 400, { ok: false, error: 'targets 必须是 QQ 号字符串数组' })
            return
          }
          const bad = body.targets.map((x) => String(x ?? '').trim()).filter((x) => !/^\d{5,12}$/.test(x))
          if (bad.length) {
            sendJson(res, 400, { ok: false, error: `targets 里有不合法的 QQ 号：${bad.join(', ')}` })
            return
          }
        }
        if (body.dailyCap !== undefined) {
          const v = Number(body.dailyCap)
          if (!Number.isInteger(v) || v < 0) {
            sendJson(res, 400, { ok: false, error: 'dailyCap 必须是 0 或正整数（0=不限）' })
            return
          }
        }
        if (body.intervalMinutes !== undefined) {
          const v = Number(body.intervalMinutes)
          if (!Number.isInteger(v) || v < 1) {
            sendJson(res, 400, { ok: false, error: 'intervalMinutes 必须是 ≥1 的整数' })
            return
          }
        }
        // 先改对象/额度，最后改开关：这样「开启并指定对象」一次请求就能到位
        if (body.targets !== undefined) pest.setTargets(body.targets)
        if (body.dailyCap !== undefined) pest.setDailyCap(body.dailyCap)
        if (body.intervalMinutes !== undefined) pest.setIntervalMinutes(body.intervalMinutes)
        if (body.enabled !== undefined) pest.setEnabled(body.enabled === true)
        const snap = pest.snapshot()
        this.logger(
          'info',
          `控制台设置骂人模式：${snap.enabled ? '开' : '关'}｜对象 ${snap.targets.join(',') || '（空）'}｜日额度 ${snap.dailyCap}｜间隔 ${snap.intervalMinutes} 分`,
        )
        sendJson(res, 200, { ok: true, state: snap })
      }),
    })

    add({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/toggle`,
      ...wrap(async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const raw = await readBody(req)
        let want
        try {
          want = JSON.parse(raw || '{}')
        } catch {
          sendJson(res, 400, { ok: false, error: 'bad json' })
          return
        }
        const next = want?.enabled
        if (typeof next !== 'boolean') {
          sendJson(res, 400, { ok: false, error: 'enabled must be boolean' })
          return
        }
        this.config.enabled = next
        this.logger(next ? 'info' : 'warn', `总开关 → ${next ? '开' : '关'}（来自 Web 挂件）`)
        sendJson(res, 200, { ok: true, state: this.snapshot() })
      }),
    })

    add({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/recheck`,
      ...wrap(async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        await readBody(req)
        try {
          await this.recheck?.()
        } catch (err) {
          this.logger('warn', `重新检查失败：${err?.message || err}`)
        }
        // 「重新检查」也要顺手把登录号问一遍：用户点这个按钮，往往是
        // QQ 刚扫码进来、或者 NapCat 刚重启，挂件上「当前登录」还空着。
        try {
          await this.refreshLogin?.()
        } catch (err) {
          this.logger('warn', `刷新登录信息失败：${err?.message || err}`)
        }
        sendJson(res, 200, { ok: true, state: this.snapshot() })
      }),
    })

    /*
     * ── 控制台 CRUD（契约 docs/console-crud-contract.md §2，2026-10-19）──
     *
     * 为什么这些写操作必须走插件、不能让前端直接改磁盘：
     *   - 记忆：`MemoryStore.entries` 是**内存数组**，`save()` 是整个数组覆写
     *     memory.json + 重渲染 memory.md。前端直接改盘上 json 的话，插件下一次
     *     `add()` 会把内存里的旧数组写回去，改动被静默吞掉。
     *   - 表情包：关键词编码在**文件名**里，`.learned.json` 只是内容哈希表。
     *     所以「改关键词」= 重命名文件，必须由持有目录状态的一方来做。
     */
    const engineOr503 = (res) => {
      let engine = null
      try {
        engine = this.engineRef()
      } catch {
        engine = null
      }
      if (!engine) sendFail(res, 503, '插件还没就绪（engine 未创建），稍后再试')
      return engine || null
    }

    const memoryOr503 = (engine, res) => {
      if (!engine) return null // 503 已经由 engineOr503 发过了，别回第二次
      const store = engine.memory
      if (!store || !Array.isArray(store.entries)) {
        sendFail(res, 503, '记忆库还没就绪')
        return null
      }
      return store
    }

    /** 记忆 weight 校验：必须是 1~5 的整数（契约 §2.1） */
    const parseWeight = (v) => {
      const w = Number(v)
      return Number.isInteger(w) && w >= 1 && w <= 5 ? w : null
    }

    // GET /memory/list —— 按 at 倒序，条数与磁盘 memory.json 一致
    add({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/memory/list`,
      ...wrap(async (req, res) => {
        if (req.method !== 'GET') return sendFail(res, 405, 'method not allowed')
        const store = memoryOr503(engineOr503(res), res)
        if (!store) return
        const entries = [...store.entries].sort((a, b) => (b.at || 0) - (a.at || 0))
        sendJson(res, 200, { ok: true, count: entries.length, entries })
      }),
    })

    // POST /memory/add —— text 1..200 字，kind 白名单，weight 1..5
    add({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/memory/add`,
      ...wrap(async (req, res) => {
        if (req.method !== 'POST') return sendFail(res, 405, 'method not allowed')
        const body = await readJson(req, res)
        if (!body) return
        const store = memoryOr503(engineOr503(res), res)
        if (!store) return
        const text = String(body.text ?? '').trim()
        if (!text) return sendFail(res, 400, 'text 不能为空')
        if (charLen(text) > MEMORY_TEXT_MAX) return sendFail(res, 400, `text 超过 ${MEMORY_TEXT_MAX} 字`)
        const kind =
          body.kind === undefined || body.kind === null || body.kind === '' ? 'fact' : String(body.kind)
        if (!MEMORY_KINDS.includes(kind)) {
          return sendFail(res, 400, `kind 只能是 ${MEMORY_KINDS.join(' / ')}`)
        }
        const who =
          body.who === undefined || body.who === null
            ? ''
            : String(body.who).trim().slice(0, MEMORY_WHO_MAX)
        // qq：唯一身份。空串合法（历史条目/系统条目没有号），填了就必须是 QQ 号格式。
        const qq = body.qq === undefined || body.qq === null ? '' : String(body.qq).trim()
        if (!isValidQq(qq)) {
          return sendFail(res, 400, 'qq 必须是 5~12 位数字的 QQ 号（不以 0 开头）')
        }
        let weight = 3
        if (body.weight !== undefined && body.weight !== null) {
          const w = parseWeight(body.weight)
          if (w === null) return sendFail(res, 400, 'weight 必须是 1~5 的整数')
          weight = w
        }
        /*
         * merged 字段（契约 §2.1「真实行为」）：MemoryStore.add() 自带相似度去重，
         * 同一个人 + 同 kind + 三元组相似度 >0.8 会并入旧条目并**返回那条旧 entry**，
         * 条数不变。用「返回的 id 在 add 之前是否已存在」判断，不做 count 差别的猜测。
         * 前端据此提示「内容相近，已合并到已有条目」，否则用户会以为没保存。
         */
        const idsBefore = new Set(store.entries.map((e) => e.id))
        const entry = store.add({ kind, who, qq, text, weight })
        if (!entry) return sendFail(res, 500, '写入失败（memory.json 写不进去）')
        const merged = idsBefore.has(entry.id)
        this.logger(
          'info',
          merged
            ? `控制台新增记忆并入已有条目 ${entry.id}（${kind}）`
            : `控制台新增记忆 ${entry.id}（${kind}）`,
        )
        sendJson(res, 200, { ok: true, entry, count: store.entries.length, merged })
      }),
    })

    // POST /memory/update —— 只改传进来的字段；at 不变（那是"记下的时间"）
    add({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/memory/update`,
      ...wrap(async (req, res) => {
        if (req.method !== 'POST') return sendFail(res, 405, 'method not allowed')
        const body = await readJson(req, res)
        if (!body) return
        const store = memoryOr503(engineOr503(res), res)
        if (!store) return
        const id = String(body.id ?? '').trim()
        if (!id) return sendFail(res, 400, '缺少 id 参数')
        // id 格式非法才是 400（空/超长/控制字符）；格式合法但查不到是 404，
        // 前端才能区分「填错了」和「这条已经被删了」。
        if (id.length > 128 || /[\u0000-\u001f]/.test(id)) {
          return sendFail(res, 400, 'id 格式不对')
        }
        if (!store.entries.some((e) => e.id === id)) {
          return sendFail(res, 404, '记忆不存在（id 找不到）')
        }
        const patch = {}
        if (body.text !== undefined) {
          const text = String(body.text ?? '').trim()
          if (!text) return sendFail(res, 400, 'text 不能为空')
          if (charLen(text) > MEMORY_TEXT_MAX) return sendFail(res, 400, `text 超过 ${MEMORY_TEXT_MAX} 字`)
          patch.text = text
        }
        if (body.kind !== undefined) {
          const kind = String(body.kind)
          if (!MEMORY_KINDS.includes(kind)) return sendFail(res, 400, `kind 只能是 ${MEMORY_KINDS.join(' / ')}`)
          patch.kind = kind
        }
        if (body.who !== undefined) patch.who = String(body.who ?? '').trim().slice(0, MEMORY_WHO_MAX)
        // qq 可改（补号、换号）；空串 = 清掉身份，非法格式 400，不静默丢
        if (body.qq !== undefined) {
          const qq = String(body.qq ?? '').trim()
          if (!isValidQq(qq)) {
            return sendFail(res, 400, 'qq 必须是 5~12 位数字的 QQ 号（不以 0 开头）')
          }
          patch.qq = qq
        }
        if (body.weight !== undefined) {
          const w = parseWeight(body.weight)
          if (w === null) return sendFail(res, 400, 'weight 必须是 1~5 的整数')
          patch.weight = w
        }
        if (Object.keys(patch).length === 0) return sendFail(res, 400, '没有要改的字段')
        const entry = store.update(id, patch)
        // 存在性上面已经查过了，这里还返回 null 只可能是 save() 写盘失败
        if (!entry) return sendFail(res, 500, '写入失败（memory.json 写不进去）')
        this.logger('info', `控制台修改记忆 ${entry.id}`)
        sendJson(res, 200, { ok: true, entry })
      }),
    })

    // POST /memory/delete —— 不存在回 404，不假装删成功
    add({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/memory/delete`,
      ...wrap(async (req, res) => {
        if (req.method !== 'POST') return sendFail(res, 405, 'method not allowed')
        const body = await readJson(req, res)
        if (!body) return
        const store = memoryOr503(engineOr503(res), res)
        if (!store) return
        const id = String(body.id ?? '').trim()
        if (!id) return sendFail(res, 400, '缺少 id 参数')
        const deleted = store.remove(id)
        if (!deleted) return sendFail(res, 404, '记忆不存在（id 找不到）')
        this.logger('warn', `控制台删除记忆 ${id}`)
        sendJson(res, 200, { ok: true, deleted, count: store.entries.length })
      }),
    })

    /* ── 待核实区（2026-10-19）：闸门拦下来的记忆在这里过一眼 ─────────────
     * 数据在 `pending.json`（PendingStore 持有），和 memory.json 同目录。
     * 三条路由的语义：
     *   - 列表是只读的，不触发任何写盘；
     *   - approve：**先入库成功、再出队**——反了就是"删了待核实区但没进正式库"，直接丢数据；
     *   - reject：只出队，不碰正式库（丢掉的原文就此没了，所以前端要二次确认）。
     */
    const pendingOr503 = (engine, res) => {
      if (!engine) return null
      const store = engine.memoryPending
      if (!store || typeof store.list !== 'function') {
        sendFail(res, 503, '待核实区还没就绪')
        return null
      }
      return store
    }

    // id 校验：空 / 超长 / 控制字符 → 400；格式合法但查不到 → 404。两条路由共用
    const parsePendingId = (body, res) => {
      const id = String(body?.id ?? '').trim()
      if (!id) {
        sendFail(res, 400, '缺少 id 参数')
        return null
      }
      if (id.length > 128 || /[\u0000-\u001f]/.test(id)) {
        sendFail(res, 400, 'id 格式不对')
        return null
      }
      return id
    }

    // GET /memory/pending —— 按 createdAt 倒序，新的在前
    add({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/memory/pending`,
      ...wrap(async (req, res) => {
        if (req.method !== 'GET') return sendFail(res, 405, 'method not allowed')
        const pending = pendingOr503(engineOr503(res), res)
        if (!pending) return
        const items = pending.list()
        sendJson(res, 200, { ok: true, count: items.length, items })
      }),
    })

    // POST /memory/pending/approve —— 放行：先入正式库，成功后再出队
    add({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/memory/pending/approve`,
      ...wrap(async (req, res) => {
        if (req.method !== 'POST') return sendFail(res, 405, 'method not allowed')
        const body = await readJson(req, res)
        if (!body) return
        const engine = engineOr503(res)
        if (!engine) return
        const pending = pendingOr503(engine, res)
        if (!pending) return
        const store = memoryOr503(engine, res)
        if (!store) return
        const id = parsePendingId(body, res)
        if (!id) return
        const item = pending.get(id)
        if (!item) return sendFail(res, 404, '待核实条目不存在（id 找不到）')
        // 入库可能被判 duplicate 而返回既有那条——那也算成功，照样出队
        const entry = store.add({
          kind: item.kind,
          who: item.who,
          qq: item.qq,
          text: item.text,
          weight: item.weight,
          at: Date.now(),
        })
        if (!entry) return sendFail(res, 500, '写入失败（memory.json 写不进去），条目仍留在待核实区')
        pending.reject(id)
        this.logger('info', `待核实区放行 ${id} → 记忆 ${entry.id}`)
        sendJson(res, 200, { ok: true, entry, count: store.entries.length, pending: pending.count() })
      }),
    })

    // POST /memory/pending/reject —— 丢掉：只出队，不碰正式库
    add({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/memory/pending/reject`,
      ...wrap(async (req, res) => {
        if (req.method !== 'POST') return sendFail(res, 405, 'method not allowed')
        const body = await readJson(req, res)
        if (!body) return
        const pending = pendingOr503(engineOr503(res), res)
        if (!pending) return
        const id = parsePendingId(body, res)
        if (!id) return
        if (!pending.get(id)) return sendFail(res, 404, '待核实条目不存在（id 找不到）')
        pending.reject(id)
        this.logger('info', `待核实区丢弃 ${id}`)
        sendJson(res, 200, { ok: true, removed: true, pending: pending.count() })
      }),
    })

    /* ── 运行时切模型（task-56）─────────────────────────────────────────
     * 用户要「自己切模型不找人」：GET 看当前、POST 换。
     * 落盘 `<dataDir>/model-override.json`（tmp+rename），**同时立刻改内存**，
     * 下次重载时 main.js 会把它重新盖到 config 上（yml 不动）。
     */
    const modelOr503 = (engine, res) => {
      if (!engine) return null
      if (!engine.config) {
        sendFail(res, 503, '配置还没就绪')
        return null
      }
      return engine.config
    }

    // 可切换模型清单（2026-10-21）：静态表打底，能连上网关就把 `/v1/models` 里多出来的补上。
    // 为什么要走网关：控制台的下拉就是拿网关清单填的，两边各写一份必然漂（原来插件只认 4 个，
    // 网关上架 kimi-k3-1 后下拉能选、一保存就 400）。
    // 缓存 60s，请求 1.5s 超时；网关抖一下不能把切模型打死 → 取不到就退回静态表（degraded）。
    const MODEL_CATALOG_TTL_MS = 60 * 1000
    let modelCatalog = { at: 0, list: null, degraded: false }
    const modelCatalogOf = async (config) => {
      const now = Date.now()
      if (modelCatalog.list && now - modelCatalog.at < MODEL_CATALOG_TTL_MS) return modelCatalog
      const url = modelsUrlOf(config?.gatewayBaseUrl)
      let rows = []
      let degraded = !url
      if (url) {
        try {
          const resp = await fetch(url, { signal: AbortSignal.timeout(1500) })
          const json = resp.ok ? await resp.json().catch(() => null) : null
          if (Array.isArray(json?.data)) rows = json.data
          degraded = rows.length === 0
        } catch {
          degraded = true
        }
      }
      modelCatalog = { at: now, list: mergeGatewayModels(rows), degraded }
      return modelCatalog
    }

    // /model —— GET 看当前，POST 切换（一个路由两种方法，router 按 path 精确匹配）
    add({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/model`,
      ...wrap(async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'POST') return sendFail(res, 405, 'method not allowed')
        const config = modelOr503(engineOr503(res), res)
        if (!config) return

        const catalog = await modelCatalogOf(config)

        if (req.method === 'GET') {
          const ov = readModelOverride(config.dataDir) || {}
          const fromFile = Object.keys(ov).some((k) => k !== 'updatedAt')
          return sendJson(res, 200, {
            ok: true,
            current: currentOf(config),
            source: fromFile ? 'override' : 'config',
            available: catalog.list,
            availableDegraded: catalog.degraded,
            override: fromFile ? ov : null,
          })
        }

        const body = await readJson(req, res)
        if (!body) return
        // 「仅限控制台」：写接口必须带 x-molly-admin，且配置了 modelSwitchToken（空 = 默认关闭）
        const gate = authorizeModelSwitch(config.modelSwitchToken, req.headers?.[SWITCH_HEADER])
        if (!gate.ok) return sendFail(res, gate.status, gate.message)
        const allowed = new Set(catalog.list.map((m) => m.id))
        const listHint = catalog.list.map((m) => m.id).join(' / ')
        const degradedHint = catalog.degraded ? '（网关 /v1/models 没取到，当前只认内置清单）' : ''
        const patch = {}
        for (const role of MODEL_ROLES) {
          const raw = body[role]
          if (raw === undefined || raw === null || raw === '') continue
          const id = String(raw).trim()
          if (!allowed.has(id)) {
            return sendFail(res, 400, `模型 id 不合法：${id}；可选 ${listHint}${degradedHint}`)
          }
          patch[role] = id
        }
        if (!Object.keys(patch).length) {
          return sendFail(res, 400, `至少给一个模型：${MODEL_ROLES.join(' / ')}（可选 ${listHint}）`)
        }
        let written
        try {
          written = writeModelOverride(config.dataDir, patch)
        } catch (err) {
          return sendFail(res, 500, `写入失败：${err?.message || err}`)
        }
        const engine = engineOr503(res)
        const current =
          typeof engine?.applyModelOverride === 'function'
            ? engine.applyModelOverride(written)
            : (applyModelToConfig(config, written), currentOf(config))
        this.logger('info', `控制台切换模型：${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(' ')}`)
        sendJson(res, 200, { ok: true, current, source: 'override', available: catalog.list, override: written })
      }),
    })

    // GET /stickers/list —— 只列「学来的」目录（可写目录，契约 §1）
    add({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/stickers/list`,
      ...wrap(async (req, res) => {
        if (req.method !== 'GET') return sendFail(res, 405, 'method not allowed')
        const engine = engineOr503(res)
        if (!engine) return
        const lib = engine.stickers
        if (!lib) return sendFail(res, 503, '表情包库还没就绪')
        const items = lib.list()
        sendJson(res, 200, { ok: true, count: items.length, items })
      }),
    })

    // POST /stickers/add —— base64 JSON（不是 multipart）；魔数判型；≤8 MB
    add({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/stickers/add`,
      ...wrap(async (req, res) => {
        if (req.method !== 'POST') return sendFail(res, 405, 'method not allowed')
        const body = await readJson(req, res, UPLOAD_BODY_LIMIT, {
          code: 413,
          message: '图片太大，单张上限 8 MB',
        })
        if (!body) return
        const engine = engineOr503(res)
        if (!engine) return
        const lib = engine.stickers
        if (!lib) return sendFail(res, 503, '表情包库还没就绪')
        const raw = String(body.dataBase64 ?? '')
          .replace(/^data:[^,]*;base64,/i, '') // 允许 data:image/jpeg;base64, 前缀
          .replace(/\s+/g, '')
        if (!raw) return sendFail(res, 400, 'dataBase64 不能为空')
        const buf = Buffer.from(raw, 'base64')
        if (!buf.length) return sendFail(res, 400, 'dataBase64 解码后为空（不是合法 base64）')
        // 正文能塞进 11.7 MB，不代表图本身合格；解码后超 8 MB 同样是「太大」，
        // 和读 body 时超限保持同一个 413 + 同一句人话。
        if (buf.length > STICKER_MAX_BYTES) {
          return sendFail(res, 413, '图片太大，单张上限 8 MB')
        }
        let added
        try {
          added = lib.add({ buffer: buf, keywords: body.keywords ?? body.keyword, filename: body.filename })
        } catch (err) {
          if (err?.status) return sendFail(res, err.status, err.message)
          throw err
        }
        /*
         * 登记内容哈希：不登记的话，这张图下次被谁发一遍又会被学习器当成
         * "新图"学一次、在「学来的」里多存一份（哈希表就是防这个的）。
         */
        try {
          addLearnedHash(lib.learnedDir(), added.sha256)
          engine.learner?.addHash?.(added.sha256)
        } catch (err) {
          this.logger('warn', `表情包哈希登记失败（图本身已落盘）: ${err?.message || err}`)
        }
        this.logger('info', `控制台上传表情包 ${added.item.file}`)
        sendJson(res, 200, { ok: true, item: added.item, count: lib.list().length })
      }),
    })

    // POST /stickers/update —— 改关键词 = 重命名文件
    add({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/stickers/update`,
      ...wrap(async (req, res) => {
        if (req.method !== 'POST') return sendFail(res, 405, 'method not allowed')
        const body = await readJson(req, res)
        if (!body) return
        const engine = engineOr503(res)
        if (!engine) return
        const lib = engine.stickers
        if (!lib) return sendFail(res, 503, '表情包库还没就绪')
        const file = String(body.file ?? '').trim()
        if (!file) return sendFail(res, 400, '缺少 file 参数')
        let out
        try {
          out = lib.rename(file, body.keywords ?? body.keyword)
        } catch (err) {
          if (err?.status) return sendFail(res, err.status, err.message)
          throw err
        }
        this.logger('info', `控制台改表情包关键词 ${out.renamed.from} → ${out.renamed.to}`)
        sendJson(res, 200, { ok: true, item: out.item, renamed: out.renamed, count: lib.list().length })
      }),
    })

    // POST /stickers/delete —— 删文件 + 从 .learned.json 摘掉它的 sha256
    add({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/stickers/delete`,
      ...wrap(async (req, res) => {
        if (req.method !== 'POST') return sendFail(res, 405, 'method not allowed')
        const body = await readJson(req, res)
        if (!body) return
        const engine = engineOr503(res)
        if (!engine) return
        const lib = engine.stickers
        if (!lib) return sendFail(res, 503, '表情包库还没就绪')
        const file = String(body.file ?? '').trim()
        if (!file) return sendFail(res, 400, '缺少 file 参数')
        let out
        try {
          out = lib.remove(file)
        } catch (err) {
          if (err?.status) return sendFail(res, err.status, err.message)
          throw err
        }
        // 摘掉哈希，这样同一张图以后还能被重新学进来
        if (out.sha256) {
          try {
            removeLearnedHash(lib.learnedDir(), out.sha256)
            engine.learner?.removeHash?.(out.sha256)
          } catch (err) {
            this.logger('warn', `表情包哈希摘除失败（文件已删）: ${err?.message || err}`)
          }
        }
        this.logger('warn', `控制台删除表情包 ${out.file}`)
        sendJson(res, 200, { ok: true, deleted: 1, count: lib.list().length })
      }),
    })

    /*
     * POST /dsh-qq-whale/work/probe —— 主动把「干活会话」建一次，把错误原文吐出来。
     *
     * 为什么需要这条：命令链路失败发生在 ensureHandle()，而桌面版没有常规运行
     * 日志，只能靠「让主人私聊发一条命令」这种方式撞运气复现。有了这条路由，
     * 排查时可以直接 POST 一下，立刻知道是 ctx.agents 不在、sessionId 占了、
     * 还是 agentOptions 被拒——不用再改代码加重启来回试。
     *
     * 只做「建会话/报告状态」，不执行任何任务，不改任何东西。
     */
    add({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/work/probe`,
      ...wrap(async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        await readBody(req)
        const e = this.engineRef()
        const ex = e?.executor
        if (!ex) {
          sendJson(res, 503, { ok: false, error: '执行器还没就绪' })
          return
        }
        try {
          const handle = await ex.ensureHandle()
          /*
           * 顺便把 agent 的「长相」也吐出来。
           *
           * 排查时最需要知道的是：这个 agent 到底有没有 followup / whenIdle /
           * activityDone 这些我们要用的成员？dsh-agent-loop 的 createAgent
           * 返回的 AgentHandle 形状随版本演进过，我们不能靠猜。
           * 这里只读属性名，不调用任何方法。
           */
          const agent = handle?.agent
          let shape = null
          if (agent) {
            try {
              shape = {
                keys: Object.keys(agent).slice(0, 40),
                hasFollowup: typeof agent.followup,
                hasWhenIdle: typeof agent.whenIdle,
                hasActivityDone: typeof agent.activityDone,
                hasStatus: typeof agent.status,
                hasSession: typeof agent.session,
                phaseKind: agent.phase?.kind ?? null,
                status: typeof agent.status === 'string' ? agent.status : null,
              }
              /*
               * 光有形状不够 —— 命令链路失败时 kick() 把异常空吞了，
               * 唯一能看见真相的地方是会话自己的事件日志。这里把会话
               * 的成员名和最近的持久化事件都抓出来，让失败能自证。
               */
              const s = agent.session
              if (s) {
                shape.sessionKeys = Object.keys(s).slice(0, 60)
                shape.sessionMethods = {}
                for (const k of ['deriveMessages', 'events', 'log', 'entries', 'journal', 'stateOf', 'history', 'replay']) {
                  shape.sessionMethods[k] = typeof s[k]
                }
                try {
                  const msgs = s.deriveMessages?.() || []
                  shape.derivedCount = msgs.length
                  shape.derivedTail = msgs.slice(-3).map((m) => ({
                    role: m?.role,
                    blocks: (Array.isArray(m?.content) ? m.content : []).map((b) => b?.type).join(','),
                    // task-50：探针吐的是模型原文，出口前先洗掉 <acp>/mNNNNN 等标记
                    text: (Array.isArray(m?.content) ? m.content : [])
                      .filter((b) => b?.type === 'text')
                      .map((b) => sanitizeOutbound(String(b.text || '')).slice(0, 200))
                      .join(' | '),
                  }))
                } catch (err3) {
                  shape.derivedError = String(err3?.message || err3)
                }
              }
            } catch (err2) {
              shape = { error: String(err2?.message || err2) }
            }
          }
          sendJson(res, 200, {
            ok: true,
            ready: Boolean(handle),
            sessionId: ex.workSessionId?.() || '',
            error: '',
            shape,
          })
        } catch (err) {
          sendJson(res, 200, {
            ok: false,
            ready: false,
            sessionId: ex.workSessionId?.() || '',
            error: String(err?.stack || err?.message || err),
          })
        }
      }),
    })

    /*
     * POST /dsh-qq-whale/work/stop（task-44）—— 释放卡住的干活会话。
     *
     * 真机事故：worker 调 ask_user_question 后永久挂住（QQ 里没人能点弹窗），
     * state.work.running 一直是 true，后面所有命令排队超时。这条路由给一个
     * 不开 GUI、不用重启的处置口子：agent.cancel({kind:'user'}) 取消当前轮，
     * **不删会话、不改名**（改名会让宿主句柄失效，上次连报 ENOENT）。
     *
     * 用法：curl -X POST http://127.0.0.1:7053/dsh-qq-whale/work/stop
     */
    add({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/work/stop`,
      ...wrap(async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        await readBody(req)
        const e = this.engineRef()
        const ex = e?.executor
        if (!ex) {
          sendJson(res, 503, { ok: false, error: '执行器还没就绪' })
          return
        }
        const wasRunning = Boolean(ex.running)
        const task = wasRunning ? String(ex.running.task || '').slice(0, 80) : ''
        let cancelled = false
        let error = ''
        try {
          cancelled = (await ex.cancelRunning?.('控制台手动释放', 5000)) === true
        } catch (err) {
          error = String(err?.message || err)
        }
        // 给 _runOnce 的 finally 一点时间把 running 清掉
        await new Promise((r) => setTimeout(r, 300))
        if (cancelled && ex.running) {
          // whenIdle 没落定（或这轮不是我们 cancel 的）时兜底清状态，
          // 否则控制台一直显示 running=true、下一条命令又会判卡死。
          ex.running = null
        }
        this.logger('warn', `控制台请求释放干活会话（wasRunning=${wasRunning}, cancelled=${cancelled}）`)
        sendJson(res, 200, {
          ok: true,
          cancelled,
          wasRunning,
          task,
          running: Boolean(ex.running),
          error,
        })
      }),
    })

    /*
     * POST /dsh-qq-whale/chat/test —— 打一发**真实的 chat 通道调用**，给账目对账用。
     *
     * 为什么非要有这个口子：预算表里 chat 是按次记账的，但它到底有没有跟网关
     * 那份 usage.jsonl 对上，一直没人验过 —— 因为 chat 只在「有人真的来搭话」
     * 时才发生，而对账又不能靠去 QQ 里戳她。这个路由走的就是聊天链路用的同一个
     * 入口 engine.callModel()（内部 resume：gateway.chat + recordUsage('chat')），
     * 所以它记的是同一本账，只是消息内容是合成的。
     *
     * 还回传 probe.msgs_sha / probe.system_sha：wb_proxy 写 usage.jsonl 时用
     *   h(obj) = sha256(json.dumps(obj, ensure_ascii=False, sort_keys=True))[:12]
     * 给整段消息和系统提示各算一个哈希。我们照同一算法在本地复刻一遍（见 pyHash），
     * 于是那一行的 msgs_sha 就是能在 JSONL 里精确认领「这一次调用」的凭证 ——
     * 不用再靠时间窗和行数瞎猜，也不用去改网关（那是三个客户端共用的）。
     *
     * body: {"text":"对账探针","system"?: "自定义系统提示"}
     */
    add({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/chat/test`,
      ...wrap(async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const raw = await readBody(req)
        let body
        try {
          body = JSON.parse(raw || '{}')
        } catch {
          sendJson(res, 400, { ok: false, error: 'bad json' })
          return
        }
        const text = String(body?.text || '').trim()
        if (!text) {
          sendJson(res, 400, { ok: false, error: 'text 不能为空' })
          return
        }
        const system =
          typeof body?.system === 'string' && body.system
            ? body.system
            : '这是一次自检调用，只用来核对记账。请只回两个字：收到'
        const e = this.engineRef()
        if (!e?.callModel) {
          sendJson(res, 503, { ok: false, error: 'engine 还没就绪' })
          return
        }
        const messages = [{ role: 'user', content: text }]
        /*
         * 线上消息的顺序必须和 gateway.chat() 里拼的一模一样（system 在前），
         * 否则本地算出来的 msgs_sha 和网关落盘的那一行对不上，凭证就失效了。
         */
        const wire = []
        if (system) wire.push({ role: 'system', content: system })
        for (const m of messages) wire.push({ role: m.role, content: m.content })
        const started = Date.now()
        try {
          // 96 而不是 32：主脑默认 reasoning_effort=max，32 个 token 会被思考吃光，
          // 回包就变成空串（账照样对得上，但看着像探针坏了）。
          const r = await e.callModel({ system, messages, maxTokens: 96 })
          const snap = e.budget?.snapshot?.() || null
          sendJson(res, 200, {
            ok: Boolean(r?.ok),
            text: String(r?.text || '').slice(0, 120),
            error: r?.error || '',
            code: r?.code || '',
            model: r?.model || '',
            usage: r?.usage || null,
            probe: {
              msgs_sha: pyHash(wire),
              system_sha: wire.length ? pyHash(wire[0]) : '',
              n_msgs: wire.length,
            },
            budgetChat: snap?.byChannel?.chat || null,
            ms: Date.now() - started,
            at: new Date().toISOString(),
          })
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String(err?.message || err) })
        }
      }),
    })

    /*
     * POST /dsh-qq-whale/work/run —— 真跑一条指令，把结果原样吐出来。
     *
     * 这是给排查和自测用的，不是给日常用的：
     *   body: {"task":"列一下今天要做的事", "send": false}
     * `send=true` 时会把结果真的发到 QQ（默认不发，避免在别人的聊天里
     * 凭空冒出一条莫名其妙的消息）。
     *
     * 有了它，「命令 xxx → 生成结果 → 发回 QQ」这条链路可以脱离 QQ 界面
     * 单独验证。之前这条链路哑火，排查全靠猜，就是因为没有这么个口子。
     */
    /*
     * POST /dsh-qq-whale/research/test —— 只跑「判定 + 查 + 收口」这一段。
     *
     * 为什么要这个口子：research 完全嵌在聊天链路里，想验证它只能去 QQ 里
     * 说句话然后等——真机上一条消息要经过 debounce、打字延迟、气泡切分，
     * 十几秒才出结果，而且查没查、查到什么都看不见。有了这个路由，
     * 「这句话该不该查」「查出来是什么」「收口成什么样」三步可以分开验。
     *
     * body: { text: "今天上海天气怎么样", speak?: boolean }
     *   speak=true 会用她的口吻润色一遍（走真实聊天模型），默认 false。
     */
    add({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/research/test`,
      ...wrap(async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const raw = await readBody(req)
        let body
        try {
          body = JSON.parse(raw || '{}')
        } catch {
          sendJson(res, 400, { ok: false, error: 'bad json' })
          return
        }
        const text = String(body?.text || '').trim()
        if (!text) {
          sendJson(res, 400, { ok: false, error: 'text 不能为空' })
          return
        }
        const e = this.engineRef()
        if (!e) {
          sendJson(res, 503, { ok: false, error: 'engine 还没就绪' })
          return
        }
        const started = Date.now()
        try {
          const verdict = e.decideResearch?.(text) || { need: false, reason: 'no-decide' }
          const out = { ok: true, text, verdict, ms: 0 }
          if (verdict.need) {
            const r = await e.researcher?.research(verdict.query || text, {
              reason: verdict.reason,
            })
            out.found = Boolean(r?.ok)
            // task-50：research 摘要是模型/网页原文，出口前先清洗（去 markdown、去内部标记）
            out.summary = sanitizeOutbound(r?.summary || '')
            out.error = r?.error || ''
            out.researchMs = r?.elapsed || 0
          }
          out.ms = Date.now() - started
          sendJson(res, 200, out)
        } catch (err) {
          sendJson(res, 500, { ok: false, error: String(err?.message || err) })
        }
      }),
    })

    add({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/work/run`,
      ...wrap(async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const raw = await readBody(req)
        let body
        try {
          body = JSON.parse(raw || '{}')
        } catch {
          sendJson(res, 400, { ok: false, error: 'bad json' })
          return
        }
        const task = String(body?.task || '').trim()
        if (!task) {
          sendJson(res, 400, { ok: false, error: 'task 不能为空' })
          return
        }
        const e = this.engineRef()
        const ex = e?.executor
        if (!ex) {
          sendJson(res, 503, { ok: false, error: '执行器还没就绪' })
          return
        }
        const started = Date.now()
        try {
          /*
           * 先挂一个会话事件探子。
           *
           * agent 的 kick() 长这样（dsh-agent-loop/lib/index.js:887-890）：
           *     try { while (await this.turn()); } catch (_error) {} finally { ... }
           * —— **异常被空 catch 吞掉了**，一律只表现为「driver 立刻结束」。
           * 于是 whenIdle() 秒回、readLastAssistant 读到空、用户看到
           * 「干完了，但没说话」。真机上这个错误到底是模型报的、工具报的
           * 还是 session 写入被拒，从外部完全看不出来。
           *
           * 唯一可靠的取错口是 session 事件流：agent/turn/start、step/start、
           * step/end、以及失败时的错误事件。这里把最近几十条抓下来原样吐出，
           * 让 work/run 能自证失败原因，不必再靠猜和重启。
           */
          const events = []
          const session = e?.executor?.workSession?.() || null
          let off = null
          if (session && typeof session.on === 'function') {
            off = session.on((evt) => {
              try {
                events.push({
                  type: evt?.type || evt?.kind || '',
                  data: JSON.stringify(evt?.data || evt || {}).slice(0, 400),
                })
                if (events.length > 40) events.shift()
              } catch {
                /* 探子自身不许出错 */
              }
            })
          }

          const result = await ex.run(task, {})
          /*
           * task-50：HTTP 出口统一清洗。真机实测这里直接吐出了
           * `<acp tokens="65" type="text">m00085</acp>\n沙箱自检通过…`
           * ——QQ 投递路径有 cleanForQQ(sanitizeOutbound())，这条口子漏了。
           */
          const cleanText = sanitizeOutbound(String(result?.text || ''))
          let sent = 0
          if (body?.send === true && e?.sendTextTo) {
            /*
             * 发给谁：优先 body.to（QQ 号），否则发给 commanderUsers 第一个人。
             * 群里不主动发 —— 自测消息不该漏到群里去。
             */
            const to = String(body?.to || this.config.commanderUsers?.[0] || '').trim()
            if (to) {
              const lines = cleanText.split('\n').filter(Boolean).slice(0, 6)
              for (const line of lines) {
                await e.sendTextTo({ user_id: to, message_type: 'private' }, line)
                sent += 1
              }
            }
          }
          sendJson(res, 200, {
            ok: Boolean(result?.ok),
            text: cleanText,
            elapsedMs: Date.now() - started,
            sentLines: sent,
            error: result?.ok ? '' : cleanText,
            events,
          })
        } catch (err) {
          sendJson(res, 200, {
            ok: false,
            text: '',
            elapsedMs: Date.now() - started,
            sentLines: 0,
            error: String(err?.stack || err?.message || err),
          })
        }
      }),
    })

    /*
     * 积分日上限的开关（用户 m03969：「那个 100 积分限制加一个开关吧，
     * 如果关了的话降级到 wb 的时候就不做限制也不跳转 trae」）。
     *
     * 为什么做成路由而不是只留在 yml 里：这是个**会临时改主意**的设定。
     * 用户可能今天想省着用、明天想让她放开聊，为此改配置文件再重载插件
     * 太重了。挂件上一键切换，改的是内存里的 config，立刻生效。
     *
     * 注意只改内存不写回 yml——重启后会回到 yml 里的值。这是刻意的：
     * 配置文件是可复现的基线，临时开关不该悄悄污染它。
     */
    add({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/budget`,
      ...wrap(async (req, res) => {
        if (req.method !== 'POST') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        const raw = await readBody(req)
        let body
        try {
          body = JSON.parse(raw || '{}')
        } catch {
          sendJson(res, 400, { ok: false, error: 'bad json' })
          return
        }
        const e = this.engineRef()
        const b = e?.budget
        if (!b) {
          sendJson(res, 503, { ok: false, error: '预算模块还没就绪' })
          return
        }
        if (typeof body?.enabled === 'boolean') {
          // setEnabled 会立刻落盘：早先只改内存，重启后悄悄变回 yml 默认值，
          // 主人明明关了限制、第二天发现它自己又开了。
          b.setEnabled ? b.setEnabled(body.enabled) : (b.enabled = body.enabled)
          this.config.creditLimitEnabled = body.enabled
          this.logger('info', `积分日上限 → ${body.enabled ? `开（${b.dailyCap} 分）` : '关（不限）'}（来自 Web 挂件）`)
        }
        if (Number.isFinite(Number(body?.cap)) && Number(body.cap) > 0) {
          b.setCap ? b.setCap(Number(body.cap)) : (b.dailyCap = Number(body.cap))
          this.config.creditDailyCap = Number(body.cap)
          this.logger('info', `积分日上限改为 ${b.dailyCap} 分（来自 Web 挂件）`)
        }
        sendJson(res, 200, { ok: true, state: this.snapshot() })
      }),
    })

    add({
      kind: 'exact',
      path: `${ROUTE_PREFIX}/widget.js`,
      ...wrap(async (req, res) => {
        const js = this.loadWidgetJs()
        if (!js) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('widget not built')
          return
        }
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(js)
      }),
    })

    // web 形态：直接往 index.html 里插一行
    if (typeof ws.tapIndex === 'function') {
      try {
        const d = ws.tapIndex((html) => {
          if (String(html).includes(`${ROUTE_PREFIX}/widget.js`)) return html
          const tag = `<script defer src="${ROUTE_PREFIX}/widget.js"></script>`
          if (html.includes('</body>')) return html.replace('</body>', tag + '</body>')
          return html + tag
        })
        if (typeof d === 'function') this.disposers.push(d)
      } catch (err) {
        this.logger('warn', `tapIndex 失败：${err?.message || err}`)
      }
    }
  }

  /** 桌面端注入行：必须在 apply 阶段就挂上，见文件头注释 */
  registerIndexInjectRow(root) {
    try {
      const d = root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          for (const row of table) {
            if (row && row.kind === 'script' && typeof row.text === 'string' && row.text.includes(`${ROUTE_PREFIX}/widget.js`)) return
          }
          const text =
            '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
            `var s=document.createElement("script");s.src="${ROUTE_PREFIX}/widget.js";` +
            's.onerror=function(){};d.appendChild(s)}catch(e){}})()'
          table.push({ kind: 'script', placement: 'body', text })
        } catch {}
      })
      if (typeof d === 'function') this.disposers.push(d)
    } catch (err) {
      this.logger('warn', `注入行注册失败：${err?.message || err}`)
    }
  }

  dispose() {
    for (const d of this.disposers) {
      try {
        d()
      } catch {}
    }
    this.disposers = []
  }
}

/**
 * 轻量运行指标。挂件上显示的"已聊 N 条 / 平均 X 秒"就靠它。
 *
 * 为什么不用现成的统计：DSH 那边统计的是 token 消耗，而用户想看的是
 * "她到底活没活着、回得快不快"，两码事。
 */
export class Metrics {
  /** @param {{dir?: string}} [opts] dir 给了就落盘，不给就是纯内存（测试用） */
  constructor(opts = {}) {
    this.dir = opts.dir || ''
    this.file = this.dir ? path.join(this.dir, 'metrics.json') : ''
    this.messages = 0
    this.conversations = new Set()
    this.replyDurations = []
    this.lastReplyAt = null
    this.lastReplyMs = 0
    this.load()
  }

  /**
   * 读回上次的统计。
   *
   * `lastReplyAt` 必须落盘：插件一重载 Metrics 就重建，挂件上「上次说话」
   * 会整行消失，用户会以为坏了。读失败就当全新开始——统计丢了无所谓，
   * 绝不能让它影响启动。
   */
  load() {
    if (!this.file) return
    try {
      if (!fs.existsSync(this.file)) return
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      this.messages = Number(j.messages) || 0
      this.conversations = new Set(Array.isArray(j.conversations) ? j.conversations : [])
      this.replyDurations = Array.isArray(j.replyDurations)
        ? j.replyDurations.filter((n) => Number.isFinite(n)).slice(-50)
        : []
      this.lastReplyAt = typeof j.lastReplyAt === 'string' ? j.lastReplyAt : null
      this.lastReplyMs = Number(j.lastReplyMs) || 0
    } catch {
      /* 文件坏了就当没有，不影响聊天 */
    }
  }

  save() {
    if (!this.file) return
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(
        this.file,
        JSON.stringify({
          messages: this.messages,
          conversations: [...this.conversations],
          replyDurations: this.replyDurations,
          lastReplyAt: this.lastReplyAt,
          lastReplyMs: this.lastReplyMs,
        }),
        'utf8'
      )
    } catch {
      /* 写不进去就算了，统计是锦上添花 */
    }
  }

  onIncoming(key) {
    this.messages += 1
    if (key) this.conversations.add(key)
    this.save()
  }

  onReplied(ms) {
    if (Number.isFinite(ms) && ms > 0) {
      this.replyDurations.push(ms)
      // 只留最近 50 次：平均响应应该反映"最近的体感"，不是远古的账
      if (this.replyDurations.length > 50) this.replyDurations.shift()
      this.lastReplyMs = ms
    }
    this.lastReplyAt = new Date().toISOString()
    this.save()
  }

  snapshot() {
    const avg =
      this.replyDurations.length > 0
        ? Math.round((this.replyDurations.reduce((a, b) => a + b, 0) / this.replyDurations.length / 1000) * 10) / 10
        : 0
    return {
      messages: this.messages,
      conversations: this.conversations.size,
      avgReplySeconds: avg,
      lastReplyAt: this.lastReplyAt,
      lastReplyMs: this.lastReplyMs,
    }
  }
}
