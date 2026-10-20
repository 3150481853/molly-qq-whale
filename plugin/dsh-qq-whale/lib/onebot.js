/**
 * OneBot 11 正向 WebSocket 客户端。
 *
 * 只做协议层：连 NapCat 的 ws server、发 action、收 event。
 * 不含任何"人设"或"回复策略"逻辑 —— 那些在 persona.js / aliveness.js。
 *
 * 为什么自己写而不是装 adapter：DSH 里没有 Koishi，装一套 OneBot SDK
 * 会把依赖和生命周期复杂化。OneBot11 正向 WS 的协议小到 500 行能覆盖。
 */

const RECONNECT_BASE_MS = 1500
const RECONNECT_MAX_MS = 30000
const ACTION_TIMEOUT_MS = 20000

/**
 * 历史消息条数的默认值（P5：用户反馈「聊天记录查询有点短」）。
 *
 * 20 条的实测问题：群里聊得快时 20 条只覆盖最近 2~4 分钟，
 * 用户说「刚才那条链接」「昨天说的那个」时根本翻不到，模型只能反复追问。
 * 50 条 ≈ 多数群 15~40 分钟的聊天量，折算 50×60 字 ≈ 3k 字，上下文完全吃得下。
 * 上限 200 是另一头：200×60 字 ≈ 12k 字，正好撞上 qqtools 输出截断线，再大纯浪费。
 */
export const HISTORY_DEFAULT_COUNT = 50

/** 事件类型判定：post_type 可能缺，按 msg/notice/request/meta 分派 */
export function classifyEvent(ev) {
  if (!ev || typeof ev !== 'object') return 'unknown'
  const pt = ev.post_type
  if (pt === 'message' || pt === 'message_sent') return 'message'
  if (pt === 'notice') return 'notice'
  if (pt === 'request') return 'request'
  if (pt === 'meta_event') return 'meta'
  // NapCat 某些推送省略 post_type，用字段兜底
  if (ev.message_type || ev.raw_message !== undefined) return 'message'
  if (ev.notice_type) return 'notice'
  if (ev.request_type) return 'request'
  if (ev.meta_event_type) return 'meta'
  return 'unknown'
}

/** CQ 码字符串兜底解析（NapCat 配了 string 格式时用） */
export function legacyStringToSegments(s) {
  const out = []
  const re = /\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g
  let last = 0
  let m
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) out.push({ type: 'text', data: { text: s.slice(last, m.index) } })
    const data = {}
    for (const kv of (m[2] || '').split(',').filter(Boolean)) {
      const eq = kv.indexOf('=')
      if (eq > 0) data[kv.slice(0, eq)] = kv.slice(eq + 1)
    }
    out.push({ type: m[1], data })
    last = m.index + m[0].length
  }
  if (last < s.length) out.push({ type: 'text', data: { text: s.slice(last) } })
  return out
}

/**
 * 把 OneBot 的 message（array 或 string）归一成纯文本 + 分段元信息。
 *
 * 返回 { text, segments, images, faces, ats, replyTo, isAtMe, hasSelfFace }
 * segments 保留原始结构，便于人设侧判断"这条是不是冲我来的"。
 */
export function normalizeMessage(raw, selfId) {
  const self = String(selfId || '')
  const segments = Array.isArray(raw) ? raw : typeof raw === 'string' ? legacyStringToSegments(raw) : []

  let text = ''
  const images = []
  const faces = []
  const ats = []
  let replyTo = null
  let isAtMe = false
  let hasSelfFace = false

  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue
    const type = seg.type
    const data = seg.data || {}
    if (type === 'text') {
      text += String(data.text ?? '')
    } else if (type === 'image') {
      // 群友发的图：只记 url，不下载（下载交给需要视觉的环节按需做）
      images.push({ url: data.url || data.file || '', summary: data.summary || '', subType: data.sub_type })
      text += '[图片]'
    } else if (type === 'face') {
      faces.push(String(data.id ?? ''))
      if (String(data.id) === self) hasSelfFace = true
      text += '[表情]'
    } else if (type === 'mface') {
      // 商城表情：emojiId/emoji_id 标记它是表情而不是普通图片，
      // 学习模块要靠这个字段决定"该不该学"。
      images.push({
        url: data.url || '',
        summary: data.summary || '',
        isMface: true,
        emojiId: String(data.emoji_id || data.emojiId || data.key || ''),
      })
      text += `[${data.summary || '表情'}]`
    } else if (type === 'at') {
      const qq = String(data.qq ?? '')
      ats.push(qq)
      if (qq === self) {
        isAtMe = true
        text += '@我'
      } else if (qq === 'all') {
        text += '@全体成员'
      } else {
        text += `@${data.name || qq}`
      }
    } else if (type === 'reply') {
      replyTo = String(data.id ?? '')
      // 引用消息不算正文，但留个标记让人和模型知道"他在回我某条"
      text += '[引用]'
    } else if (type === 'record') {
      text += '[语音]'
    } else if (type === 'video') {
      text += '[视频]'
    } else if (type === 'file') {
      text += `[文件 ${data.name || ''}]`
    } else if (type === 'json' || type === 'xml') {
      text += '[卡片]'
    } else if (type === 'forward') {
      text += '[聊天记录]'
    } else if (type === 'poke') {
      text += '[戳一戳]'
    } else if (type === 'dice') {
      text += `[骰子 ${data.result || ''}]`
    } else if (type === 'rps') {
      text += '[猜拳]'
    } else if (type === 'shake') {
      text += '[窗口抖动]'
    } else if (type === 'location') {
      text += `[位置 ${data.title || ''}]`
    } else if (type === 'contact') {
      text += '[名片]'
    } else if (type === 'music' || type === 'share') {
      text += `[${data.title || '分享'}]`
    } else if (type === 'node') {
      text += '[聊天记录]'
    } else if (type === 'markdown') {
      text += String(data.content || '[markdown]')
    } else {
      text += `[${type}]`
    }
  }

  return { text: text.trim(), segments, images, faces, ats, replyTo, isAtMe, hasSelfFace }
}

/**
 * 构造要发出去的消息段。
 * parts 里每项：{type:'text',text} | {type:'image',file} | {type:'face',id} | {type:'at',qq}
 */
export function buildMessage(parts) {
  const arr = (Array.isArray(parts) ? parts : [parts]).filter(Boolean)
  return arr.map((p) => {
    if (typeof p === 'string') return { type: 'text', data: { text: p } }
    switch (p.type) {
      case 'text':
        return { type: 'text', data: { text: String(p.text ?? '') } }
      case 'image':
        return { type: 'image', data: { file: String(p.file ?? '') } }
      case 'face':
        return { type: 'face', data: { id: String(p.id ?? '') } }
      case 'at':
        return { type: 'at', data: { qq: String(p.qq ?? '') } }
      case 'reply':
        return { type: 'reply', data: { id: String(p.id ?? '') } }
      case 'record':
        return { type: 'record', data: { file: String(p.file ?? '') } }
      default:
        return { type: 'text', data: { text: String(p.text ?? '') } }
    }
  })
}

/* ———————————————— 引用消息（P3） ————————————————
 *
 * 用户投诉：「引用的时候看不到引用的内容，导致后面问题全堆在那个模糊问题后面」。
 *
 * 根因：normalizeMessage 处理 type==='reply' 时只往正文塞一个 '[引用]'，
 * 模型只知道「他在回我某条」，不知道回的是哪条，于是只能瞎猜/反复追问。
 *
 * 这里补上真正的取回逻辑：编号在 norm.replyTo 里（normalizeMessage 已经解析好了），
 * 拿它去调 OneBot 的 get_msg，把被引用那条的正文取回来。
 *
 * 三条硬规矩：
 *   1. 3 秒超时。取不到就取不到，宁可少一条引用也不许把回复卡住；
 *   2. 绝不抛异常。上层调用点全在消息主路径上，抛一次就是一条消息失联；
 *   3. 总长截断 200 字。引用是「提示一下说的是哪条」，不是把整段搬过来，
 *      长文/多图刷屏会把真正的提问挤出上下文。
 */

/** 引用正文的长度上限（字）。200 字 ≈ 一条正常 QQ 消息，够认出来是哪条。 */
export const QUOTE_TEXT_MAX = 200

/** get_msg 的硬超时。3 秒是「用户已经在等回复」时能接受的极限。 */
export const QUOTE_TIMEOUT_MS = 3000

/** 取不到时的统一降级文案。失败也要让模型知道「这里本来有引用」，不能装作没这回事。 */
export const QUOTE_FAIL_TEXT = '[引用：取不到内容]'

/**
 * 把 get_msg 返回的 message 段压成一行纯文本。
 *
 * 和 normalizeMessage 的区别：这里不需要 isAtMe / images 这些元信息，
 * 只需要「这条被引用的话长什么样」；而且**不递归解析**，嵌套的 reply 段直接跳过
 * （引用里套引用没有额外信息量，反而容易来回取、越取越慢）。
 */
function quoteSegmentsToText(raw) {
  const segments = Array.isArray(raw) ? raw : typeof raw === 'string' ? legacyStringToSegments(raw) : []
  let out = ''
  for (const seg of segments) {
    if (!seg || typeof seg !== 'object') continue
    const data = seg.data || {}
    switch (seg.type) {
      case 'text':
        out += String(data.text ?? '')
        break
      case 'image':
        out += '[图片]'
        break
      case 'face':
      case 'mface':
        out += '[表情]'
        break
      case 'record':
        out += '[语音]'
        break
      case 'video':
        out += '[视频]'
        break
      case 'at':
        out += `@${data.name || data.qq || ''}`
        break
      case 'file':
        out += `[文件 ${data.name || ''}]`
        break
      case 'json':
      case 'xml':
        out += '[卡片]'
        break
      case 'forward':
      case 'node':
        out += '[聊天记录]'
        break
      case 'reply':
        // 嵌套引用：只跳过，不再往下取（避免递归调用 get_msg）
        break
      default:
        // 未知类型不展开，避免把二进制/超长字段搬进上下文
        break
    }
  }
  return out
}

/** message_id 该传数字还是字符串：纯数字且在安全整数范围内就转数字，其余原样（有超长 ID）。 */
function quoteIdForApi(id) {
  const s = String(id ?? '').trim()
  if (!/^\d+$/.test(s)) return s
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : s
}

/**
 * 取回被引用消息的正文与发送者。
 *
 * @param {OneBotClient} client 已连接的客户端（只用到它的 call()）
 * @param {string|number} replyId norm.replyTo，即 OneBot 的 message_id
 * @returns {Promise<{ok:boolean, name:string, uid:string, body:string, text:string}>}
 *   - ok:true  → text 是**可以直接拼到消息正文前面**的成品：
 *                `[引用 @昵称：被引用的正文]`
 *   - ok:false → text 是降级文案 `[引用：取不到内容]`，其余字段为空串。
 *   两种情况下 text 都能无脑当前缀用，调用方不需要写分支。
 *
 * 永远 resolve，永远不 reject —— 上层在消息主路径上直接用 await 即可。
 */
export async function fetchQuoted(client, replyId) {
  const fail = { ok: false, name: '', uid: '', body: '', text: QUOTE_FAIL_TEXT }
  const id = String(replyId ?? '').trim()
  if (!id) return fail
  if (!client || typeof client.call !== 'function') return fail

  let data
  try {
    // 显式传 3 秒超时：不靠 ACTION_TIMEOUT_MS（20s 对「等一条引用」来说太长了）
    data = await client.call('get_msg', { message_id: quoteIdForApi(id) }, QUOTE_TIMEOUT_MS)
  } catch {
    // 超时 / 未连接 / retcode 非 0 / 消息已撤回，全都走这条降级路径
    return fail
  }

  try {
    if (!data || typeof data !== 'object') return fail
    const sender = data.sender || {}
    const uid = String(sender.user_id ?? data.user_id ?? '')
    // 群里优先用群名片（sender.card），私聊/无名片时退回昵称，再不行用号
    const name = String(sender.card || sender.nickname || data.nickname || '').trim() || (uid ? `QQ${uid}` : '某人')
    let body = quoteSegmentsToText(data.message ?? data.raw_message ?? '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!body) body = '[空消息]'
    if (body.length > QUOTE_TEXT_MAX) body = `${body.slice(0, QUOTE_TEXT_MAX - 1)}…`
    return { ok: true, name, uid, body, text: `[引用 @${name}：${body}]` }
  } catch {
    // 结构不符合预期（NapCat 版本差异）也算取不到，别让脏数据把主流程带崩
    return fail
  }
}

export class OneBotError extends Error {
  constructor(retcode, message, payload) {
    super(message)
    this.name = 'OneBotError'
    this.retcode = retcode
    this.payload = payload
  }
}

export class OneBotClient {
  constructor({ url, token, selfId, logger, onEvent, onStateChange }) {
    this.url = url
    this.token = token
    this.selfId = String(selfId || '')
    this.logger = logger || (() => {})
    this.onEvent = onEvent || (() => {})
    this.onStateChange = onStateChange || (() => {})
    this.ws = null
    this.state = 'stopped'
    this.stopped = true
    this.pending = new Map()
    this.echoSeq = 0
    this.reconnectDelay = RECONNECT_BASE_MS
    this.reconnectTimer = null
    this.readyTimer = null
    this.onReady = null
    this.connectedAt = 0
    this.lastHeartbeat = 0
    this.self = { userId: Number(this.selfId) || 0, nickname: '' }
  }

  setState(s) {
    if (this.state === s) return
    this.state = s
    try {
      this.onStateChange(s)
    } catch (err) {
      this.logger('error', `onStateChange 抛错: ${err?.message || err}`)
    }
  }

  buildUrl() {
    const u = new URL(this.url)
    if (this.token) u.searchParams.set('access_token', this.token)
    return u.toString()
  }

  /**
   * 启动并等待真正连上。
   *
   * 早先的版本这里直接 fire-and-forget，导致调用方拿到 start() 的返回就
   * 立刻发 action，而此时 ws.readyState 还是 0，必然报"未连接（connecting）"。
   * 现在返回一个在 open 事件（或超时/停止）时才 settle 的 Promise。
   */
  start(timeoutMs = 15000) {
    if (!this.stopped && this.state === 'online') return Promise.resolve()
    this.stopped = false
    return new Promise((resolve, reject) => {
      this.onReady = { resolve, reject }
      const timer = setTimeout(() => {
        const h = this.onReady
        this.onReady = null
        this.readyTimer = null
        if (h) reject(new OneBotError(-4, `连接超时 ${timeoutMs}ms`, null))
      }, timeoutMs)
      if (typeof timer?.unref === 'function') timer.unref()
      this.readyTimer = timer
      this.connect()
    })
  }

  /** 内部：通知等待者连接已就绪（或失败） */
  settleReady(err) {
    const h = this.onReady
    this.onReady = null
    if (this.readyTimer) {
      clearTimeout(this.readyTimer)
      this.readyTimer = null
    }
    if (!h) return
    if (err) h.reject(err)
    else h.resolve()
  }

  connect() {
    if (this.stopped) return
    this.setState('connecting')
    let ws
    try {
      ws = new WebSocket(this.buildUrl())
    } catch (err) {
      this.logger('error', `WebSocket 构造失败: ${err?.message || err}`)
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.addEventListener('open', () => this.handleOpen())
    ws.addEventListener('message', (e) => this.handleMessage(e))
    ws.addEventListener('error', () => {
      // error 之后一定会有 close，这里只记一行避免刷屏
      if (this.logger) this.logger('debug', 'WebSocket error')
    })
    ws.addEventListener('close', (e) => this.handleClose(e))
  }

  handleOpen() {
    this.reconnectDelay = RECONNECT_BASE_MS
    this.connectedAt = Date.now()
    this.setState('handshaking')
    // 连上就算就绪：后续 get_login_info 失败不该拦住整个启动
    this.settleReady()
    // 立刻问一次登录号：这里拿到 selfId 才能判定"是不是在说我"
    this.getLoginInfo()
      .then((info) => {
        if (info && info.user_id) {
          this.self = { userId: Number(info.user_id), nickname: String(info.nickname || '') }
          this.setState('online')
          this.logger('info', `bot 在线: ${this.self.nickname}(${this.self.userId})`)
        } else {
          this.setState('online')
        }
      })
      .catch((err) => {
        // 拿不到也不致命：可能是还没登录 QQ
        this.logger('warn', `get_login_info 失败（QQ 可能未登录）: ${err?.message || err}`)
        this.setState('online')
      })
  }

  handleMessage(e) {
    let payload
    try {
      payload = JSON.parse(typeof e.data === 'string' ? e.data : String(e.data))
    } catch {
      this.logger('warn', '收到非 JSON 帧，忽略')
      return
    }
    // action 响应：有 echo 字段
    if (payload && Object.prototype.hasOwnProperty.call(payload, 'echo')) {
      const echo = String(payload.echo)
      const p = this.pending.get(echo)
      if (p) {
        this.pending.delete(echo)
        clearTimeout(p.timer)
        if (payload.status === 'failed' || payload.retcode !== 0) {
          p.reject(new OneBotError(payload.retcode, payload.wording || payload.message || 'action failed', payload))
        } else {
          p.resolve(payload.data)
        }
      }
      return
    }
    const kind = classifyEvent(payload)
    if (kind === 'meta') {
      if (payload.meta_event_type === 'heartbeat') {
        this.lastHeartbeat = Date.now()
        if (payload.status && payload.self_id) {
          this.self = { userId: Number(payload.self_id), nickname: this.self.nickname }
        }
      }
      return
    }
    try {
      this.onEvent(payload)
    } catch (err) {
      this.logger('error', `onEvent 抛错: ${err?.stack || err}`)
    }
  }

  handleClose(e) {
    this.ws = null
    // 未完成请求全部 reject，避免上层无限 await
    for (const [echo, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new OneBotError(-1, '连接已断开', null))
      this.pending.delete(echo)
    }
    // 没等到 open 就断开了：让 start() 的等待者拿到错误而不是干等超时
    this.settleReady(new OneBotError(-1, `连接失败 (code=${e?.code})`, null))
    if (this.stopped) {
      this.setState('stopped')
      return
    }
    this.logger('warn', `NapCat 连接断开 (code=${e?.code})，${Math.round(this.reconnectDelay / 1000)}s 后重连`)
    this.setState('reconnecting')
    this.scheduleReconnect()
  }

  scheduleReconnect() {
    if (this.stopped) return
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (!this.stopped) this.connect()
    }, this.reconnectDelay)
    if (typeof this.reconnectTimer?.unref === 'function') this.reconnectTimer.unref()
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.7, RECONNECT_MAX_MS)
  }

  stop() {
    this.settleReady(new OneBotError(-1, '已手动停止', null))
    this.stopped = true
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.ws) {
      try {
        this.ws.close()
      } catch {}
      this.ws = null
    }
    this.setState('stopped')
  }

  /**
   * 发一个 action，等它的响应。
   * 超时不代表没发出去（QQ 可能已经收到了），所以上层要按"可能成功"处理。
   */
  call(action, params = {}, timeoutMs = ACTION_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) {
        reject(new OneBotError(-1, `未连接（${this.state}）`, null))
        return
      }
      const echo = `dsh-qq-whale-${++this.echoSeq}`
      const timer = setTimeout(() => {
        this.pending.delete(echo)
        reject(new OneBotError(-2, `action 超时 ${action}`, null))
      }, timeoutMs)
      if (typeof timer?.unref === 'function') timer.unref()
      this.pending.set(echo, { resolve, reject, timer })
      try {
        this.ws.send(JSON.stringify({ action, params, echo }))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(echo)
        reject(new OneBotError(-3, `发送失败: ${err?.message || err}`, null))
      }
    })
  }

  // ——— 常用 action 的薄封装 ———

  /**
   * `call()` 的别名。**不能删**。
   *
   * engine.js 里所有审批相关的落地动作（同意好友申请 / 同意群邀请 /
   * 拒绝申请）都写成 `this.client.callApi(...)`，而本类只有 `call(...)`。
   * 也就是说这些调用一直是 **undefined 函数调用**：
   *
   *   - `approveRequest()` 开头的 `if (!this.client?.callApi) return false`
   *     直接短路，返回一个裸 `false`；
   *   - 调用方 `if (!approved || !approved.ok)` 命中，主人收到
   *     「想同意 XXX，但没成功 · QQ 没接受这次操作（）」——括号里是空的。
   *
   * 于是「加好友」从上线那天起就没成功过一次，而 test-gatekeeper.mjs
   * 里的假客户端**自己实现了一个 callApi**，把这个问题彻底盖住了。
   *
   * 教训：测试里的假客户端不能自创接口，要继承真实类的原型（见
   * tools/test-gatekeeper.mjs 里的 makeClient()）。
   *
   * @param {string} action OneBot action 名
   * @param {object} [params]
   * @param {number} [timeoutMs]
   */
  callApi(action, params = {}, timeoutMs = ACTION_TIMEOUT_MS) {
    return this.call(action, params, timeoutMs)
  }

  getLoginInfo() {
    return this.call('get_login_info')
  }

  sendPrivateMsg(userId, message, autoEscape = false) {
    return this.call('send_private_msg', { user_id: userId, message, auto_escape: autoEscape })
  }

  sendGroupMsg(groupId, message, autoEscape = false) {
    return this.call('send_group_msg', { group_id: groupId, message, auto_escape: autoEscape })
  }

  deleteMsg(messageId) {
    return this.call('delete_msg', { message_id: messageId })
  }

  setMsgEmojiLike(messageId, emojiId, set = true) {
    return this.call('set_msg_emoji_like', { message_id: messageId, emoji_id: String(emojiId), set })
  }

  getGroupInfo(groupId) {
    return this.call('get_group_info', { group_id: groupId })
  }

  getGroupMemberList(groupId) {
    return this.call('get_group_member_list', { group_id: groupId })
  }

  getGroupMemberInfo(groupId, userId) {
    return this.call('get_group_member_info', { group_id: groupId, user_id: userId })
  }

  getFriendList() {
    return this.call('get_friend_list')
  }

  getGroupList() {
    return this.call('get_group_list')
  }

  getStrangerInfo(userId) {
    return this.call('get_stranger_info', { user_id: userId })
  }

  getGroupMsgHistory(groupId, count = HISTORY_DEFAULT_COUNT) {
    return this.call('get_group_msg_history', { group_id: groupId, count })
  }

  getFriendMsgHistory(userId, count = HISTORY_DEFAULT_COUNT, messageSeq) {
    const params = { user_id: userId, count }
    if (messageSeq !== undefined) params.message_seq = messageSeq
    return this.call('get_friend_msg_history', params)
  }

  getRecentContact() {
    return this.call('get_recent_contact')
  }

  setGroupCard(groupId, userId, card) {
    return this.call('set_group_card', { group_id: groupId, user_id: userId, card })
  }

  sendGroupPoke(groupId, userId) {
    return this.call('group_poke', { group_id: groupId, user_id: userId })
  }

  sendPrivatePoke(userId) {
    return this.call('friend_poke', { user_id: userId })
  }

  /** 把网络图片取成 base64，供视觉模型使用。失败返回 null，不抛。 */
  async fetchImageAsBase64(url, maxBytes = 8 * 1024 * 1024) {
    if (!url) return null
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
      if (!res.ok) return null
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > maxBytes) return null
      return buf.toString('base64')
    } catch {
      return null
    }
  }
}
