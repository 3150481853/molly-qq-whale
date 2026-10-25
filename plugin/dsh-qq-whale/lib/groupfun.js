/**
 * 群趣味：抽奖 + 新人欢迎（2026-10-25，主人 m06096）。
 *
 * 需求原话：「1.群内抽奖小插件：触发关键词例如“@Molly+空格+抽个奖/抽奖”时，
 * 发出菜单（内含一些抽奖功能，比如抽几个人之类的）2.新人欢迎小插件：群内有新人
 * 加入时自动欢迎」。
 *
 * 两个功能都**不走模型**：
 *   - 抽奖是状态机（谁发起、几个人、多久、谁报名了、什么时候开奖），
 *     模型算名额/去重/计时都不可靠，还慢；
 *   - 欢迎只要一句模板 + 冷却，走模型纯属浪费 token（而且她可能在忙）。
 *
 * 这个文件保持纯逻辑：不碰网络、不碰文件，发消息由 engine 注入 `send` 回调。
 * 这样单测可以直接 new 一个对象、塞假时钟假随机数跑完整个流程。
 */

// ---------------------------------------------------------------------------
// 配置默认值（main.js 的 DEFAULTS/schema 里有同名键；这里只做兜底）
// ---------------------------------------------------------------------------

export const GROUPFUN_DEFAULTS = {
  groupfunEnabled: true,
  // 抽奖
  lotteryEnabled: true,
  lotteryDefaultCount: 3,
  lotteryMaxCount: 10,
  lotteryDefaultSeconds: 120,
  lotteryMinSeconds: 30,
  lotteryMaxSeconds: 600,
  lotteryJoinKeyword: '参加',
  lotteryKeywordMaxChars: 16,
  // 新人欢迎
  welcomeEnabled: true,
  welcomeCooldownSeconds: 60,
  welcomeTexts:
    '欢迎 {name} 加入 {group}～我是 {molly}，有问题随时 @我|来啦来啦，群里又多了个 {name}，欢迎欢迎|欢迎新人 {name}！先看看群公告，别潜水太深呀',
}

export const LOTTERY_MENU_TIPS = `🎁 抽奖菜单（@我 + 抽奖 触发；以后小玩具统一用 @我 #）
· 开一场：  抽奖 开 3 人 60秒   （名额 1-10，时长 30-600 秒，可省略）
· 报名：    抽奖 参加   （开奖前都能报，也可以直接发「参加」）
· 口令场：  抽奖 口令 干饭 3 人 60秒   （只有发「干饭」的人才算参加）
· 提前开奖：抽奖 开奖   （只有发起人能开）
· 取消：    抽奖 取消
· 看名单：  抽奖 名单
到点会自动开奖；同一时间每群只能有一场。`

// ---------------------------------------------------------------------------
// 解析：所有识别都在这里，engine 只负责调
// ---------------------------------------------------------------------------

/**
 * 把一句群消息解析成抽奖动作。
 * 只认**整句**匹配（去掉首尾空白后），避免「上次抽奖那个活动不错」被误触发。
 *
 * @param {string} raw
 * @param {{joinKeyword?: string}} [opts]
 * @returns {{kind: 'menu'|'start'|'join'|'draw'|'cancel'|'list', count?: number, seconds?: number} | null}
 */
// ---------------------------------------------------------------------------
// 小玩具统一入口（2026-10-25 主人要求：以后的小玩具都用「@我 #」触发菜单）
// ---------------------------------------------------------------------------
export const TOY_MENU_TIPS = [
  '🧸 小玩具（@我 + 空格 + # 打开；#玩具名 直达）',
  '  抽奖 —— 发「抽奖」看抽奖菜单；口令场：抽奖 口令 干饭 3人 60秒',
  '  欢迎 —— 新人自动欢迎（本群默认开启）',
  '  以后的小玩具也会挂在这个菜单里。'
]

export function buildToyMenu(config = {}) {
  const lines = [...TOY_MENU_TIPS]
  if (config && config.lotteryEnabled === false) lines[1] = '  抽奖 —— 本群未开启'
  if (config && config.welcomeEnabled === false) lines[2] = '  欢迎 —— 本群未开启'
  return lines.join('\n')
}

export function parseLotteryCommand(raw, opts = {}) {
  const joinKeyword = String(opts.joinKeyword || GROUPFUN_DEFAULTS.lotteryJoinKeyword)
  const text = String(raw || '')
    .replace(/[\u3000\s]+/gu, ' ')
    .replace(/^@我\s*/u, '')
    .trim()
  if (!text) return null

  if (text === joinKeyword || text === '报名' || text === '我要参加') return { kind: 'join' }

  // 必须落在「抽奖 / 抽个奖」开头，后面接动作
  const m = text.match(/^抽(?:个)?奖(?:\s*(.*))?$/u)
  if (!m) return null
  const rest = String(m[1] || '').trim()
  if (!rest) return { kind: 'menu' }

  if (/^(菜单|帮助|help|说明)$/i.test(rest)) return { kind: 'menu' }
  if (/^(参加|报名|加入)$/u.test(rest)) return { kind: 'join' }
  if (/^(开奖|揭晓|抽|停止|截止)$/u.test(rest)) return { kind: 'draw' }
  if (/^(取消|作废|算了|关掉)$/u.test(rest)) return { kind: 'cancel' }
  if (/^(名单|列表|情况|参加者|报名表)$/u.test(rest)) return { kind: 'list' }

  // 口令场：抽奖 口令 <口令> [N人] [M秒]
  if (/^(口令|暗号)/u.test(rest)) {
    const body = String(rest).replace(/^(?:口令|暗号)\s*/u, '').trim()
    const keyword = String(body.split(/\s+/u)[0] || '').trim()
    if (!keyword) return { kind: 'menu' }
    const tail = body.slice(body.indexOf(keyword) + keyword.length)
    const countMatch = tail.match(/(\d{1,2})\s*(?:人|位|个)/u)
    const secMatch = tail.match(/(\d{1,4})\s*(?:秒|s|S)/u)
    const minMatch = tail.match(/(\d{1,3})\s*(?:分钟|分|min)/iu)
    const count = countMatch ? Number(countMatch[1]) : undefined
    let seconds
    if (secMatch) seconds = Number(secMatch[1])
    else if (minMatch) seconds = Number(minMatch[1]) * 60
    return { kind: 'start', keyword, count, seconds }
  }

  if (/^(开|开始|发起|启动|来一场|开一场)/u.test(rest)) {
    const countMatch = rest.match(/(\d{1,2})\s*(?:人|位|个)/u)
    const secMatch = rest.match(/(\d{1,4})\s*(?:秒|s|S)/u)
    const minMatch = rest.match(/(\d{1,3})\s*(?:分钟|分|min)/iu)
    const count = countMatch ? Number(countMatch[1]) : undefined
    let seconds
    if (secMatch) seconds = Number(secMatch[1])
    else if (minMatch) seconds = Number(minMatch[1]) * 60
    const kwMatch = rest.match(/(?:口令|暗号)\s*([^\s\d]{1,16})/u)
    return { kind: 'start', count, seconds, keyword: kwMatch ? kwMatch[1] : undefined }
  }
  return null
}

/** 「参与抽奖的人 @谁」列表拼给 engine 用的纯文本（不带 @ 段）。 */
export function namesText(entries, max = 20) {
  const arr = [...entries]
  const shown = arr.slice(0, max).map((e) => e.nick || e.qq)
  const more = arr.length > max ? ` 等 ${arr.length} 人` : ''
  return shown.join('、') + more
}

/**
 * 抽奖房间（每群一个）。纯内存：宿主热重载/重启即清空——
 * 抽奖是「一分钟热度」的功能，没必要落盘；重启丢了就重开，反而干净。
 */
export class LotteryBox {
  /**
   * @param {{
   *   logger?: Function,
   *   now?: () => number,
   *   random?: () => number,
   *   send?: (gid: string, payload: {text: string, at?: string[]}) => Promise<any>,
   * }} opts
   */
  constructor({ logger = () => {}, now = Date.now, random = Math.random, send = async () => {} } = {}) {
    this.logger = logger
    this.now = now
    this.random = random
    this.send = send
    /** @type {Map<string, any>} gid → 场次 */
    this.rooms = new Map()
    // 2026-10-26：诊断与自愈（历史事故：定时器没落地/丢失时，房间永远停在待开奖）
    this.lastAuto = null
    this.lastTick = null
    this.sweeps = 0
  }

  /** 当前场次（只读） */
  room(gid) {
    return this.rooms.get(String(gid)) || null
  }

  /**
   * 开一场。
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  async start({ gid, owner, ownerName, count, seconds, keyword, config = GROUPFUN_DEFAULTS }) {
    const key = String(gid)
    const live = this.rooms.get(key)
    if (live) {
      const left = Math.max(0, Math.ceil((live.endsAt - this.now()) / 1000))
      return { ok: false, message: `本群已经有一场在进行中啦（${live.entries.size} 人报名，还剩 ${left} 秒），等它开完再说～` }
    }
    const maxCount = Math.max(1, Number(config.lotteryMaxCount) || GROUPFUN_DEFAULTS.lotteryMaxCount)
    const n = clampInt(count ?? config.lotteryDefaultCount, 1, maxCount)
    const dur = clampInt(
      seconds ?? config.lotteryDefaultSeconds,
      Number(config.lotteryMinSeconds) || GROUPFUN_DEFAULTS.lotteryMinSeconds,
      Number(config.lotteryMaxSeconds) || GROUPFUN_DEFAULTS.lotteryMaxSeconds,
    )
    const kw = String(keyword || '')
      .trim()
      .slice(0, Math.max(1, Number(config.lotteryKeywordMaxChars) || GROUPFUN_DEFAULTS.lotteryKeywordMaxChars))
    const room = {
      gid: key,
      owner: String(owner || ''),
      ownerName: String(ownerName || owner || ''),
      count: n,
      seconds: dur,
      startedAt: this.now(),
      endsAt: this.now() + dur * 1000,
      mode: kw ? 'keyword' : 'open',
      keyword: kw,
      entries: new Map(),
      timer: null,
    }
    const timer = setTimeout(() => {
      this.sweep({ config, only: key }).catch((err) => this.logger('warn', `抽奖自动开奖失败: ${err?.message || err}`))
    }, dur * 1000)
    timer?.unref?.()
    room.timer = timer
    this.rooms.set(key, room)
    const howto = kw
      ? `🎁 口令抽奖开始！在场内发「${kw}」才算参加（只认整句）。`
      : `🎁 抽奖开始！发「抽奖 参加」（或直接发「${config.lotteryJoinKeyword || '参加'}」）报名。`
    return {
      ok: true,
      message: `${howto}\n名额 ${n} 人 · 时长 ${dur} 秒 · ${dur} 秒后自动开奖`,
    }
  }

  /**
   * 口令场：窗口内发出口令即报名。返回 null 表示「这句不归口令管」。
   */
  keywordJoin({ gid, qq, nick, text }) {
    const room = this.rooms.get(String(gid))
    if (!room || room.mode !== 'keyword') return null
    const norm = String(text || '')
      .replace(/[\u3000\s]+/gu, ' ')
      .replace(/^@我\s*/u, '')
      .trim()
    if (!norm || norm !== room.keyword) return null
    return this.join({ gid, qq, nick, via: 'keyword' })
  }

  /** 报名；无进行中场次时返回 null（engine 据此安静忽略这俩字）。 */
  join({ gid, qq, nick, via = 'command' }) {
    const key = String(gid)
    const room = this.rooms.get(key)
    if (!room) return null
    if (room.mode === 'keyword' && via !== 'keyword') {
      return { ok: false, message: `本场是口令抽奖，发「${room.keyword}」才算报名哦` }
    }

    if (room.entries.has(String(qq))) {
      return { ok: false, message: `${nick || qq} 已经在名单里啦` }
    }
    room.entries.set(String(qq), { qq: String(qq), nick: String(nick || qq), at: this.now() })
    return { ok: true, message: `✅ ${nick || qq} 报名成功（第 ${room.entries.size} 位）` }
  }

  /**
   * 开奖。by = owner / auto；其他人调用返回拒绝。
   * @returns {Promise<{ok: boolean, message: string, winners?: any[]}>}
   */
  async draw({ gid, by = 'auto', config = {} }) {
    const key = String(gid)
    const room = this.rooms.get(key)
    if (!room) return { ok: false, message: '现在没有进行中的抽奖，先发「抽奖 开 3 人 60秒」开一场吧' }
    if (by !== 'auto' && String(by) !== room.owner) {
      return { ok: false, message: '只有发起人能开奖哦（等时间到也会自动开）' }
    }
    if (room.timer) clearTimeout(room.timer)
    this.rooms.delete(key)
    const entries = [...room.entries.values()]
    if (!entries.length) {
      const empty = room.mode === 'keyword'
        ? `🎁 时间到，不过没人发出口令「${room.keyword}」，抽奖取消～`
        : '🎁 时间到，不过这局没人报名，抽奖取消～下次再来'
      return { ok: true, message: empty, winners: [] }
    }
    const winners = this.pick(entries, room.count)
    const list = winners.map((w) => ({ qq: w.qq, nick: w.nick }))
    const title = room.mode === 'keyword'
      ? `🎉 口令开奖（口令：${room.keyword}）！共 ${entries.length} 人参加，抽 ${room.count} 位：\n`
      : `🎉 抽奖开奖！共 ${entries.length} 人报名，抽 ${room.count} 位：\n`
    const msg =
      title +
      list.map((w, i) => `${i + 1}. @${w.nick}`).join('\n') +
      '\n恭喜以上朋友～'
    return { ok: true, message: msg, winners: list, entries: entries.length }
  }

  /**
   * 开奖兜底：把已到期的场次开掉并通知。
   * 主路径是 start() 的定时器；这里再做一层，任何群消息/心跳都会兜住
   * （历史事故：23:22 到点后什么都没发生，房间却被删了——说明定时器路径不可靠）。
   */
  async sweep({ config = {}, only = '' } = {}) {
    const onlyKey = only ? String(only) : ''
    const due = [...this.rooms.values()].filter(
      (room) => (!onlyKey || room.gid === onlyKey) && Number(room.endsAt) <= this.now(),
    )
    const out = []
    for (const room of due) {
      const gid = room.gid
      try {
        const res = await this.draw({ gid, by: 'auto', config })
        let sent = false
        if (res?.ok) {
          await this.send(gid, { text: res.message, at: (res.winners || []).map((w) => String(w.qq)) })
          sent = true
        }
        this.lastAuto = {
          at: new Date().toISOString(),
          gid,
          ok: !!res?.ok,
          sent,
          winners: (res?.winners || []).length,
        }
        out.push(this.lastAuto)
      } catch (err) {
        this.lastAuto = { at: new Date().toISOString(), gid, ok: false, error: String(err?.message || err) }
        this.logger('warn', `抽奖兜底开奖失败：${err?.message || err}`)
        out.push(this.lastAuto)
      }
    }
    if (due.length) this.sweeps += 1
    return out
  }

  /** 心跳：记录插件进程内的定时器是否还活着，并顺带扫尾。 */
  async tick({ config = {} } = {}) {
    this.lastTick = new Date().toISOString()
    return this.sweep({ config })
  }

  /** 取消（只有发起人）。 */
  async cancel({ gid, by }) {
    const key = String(gid)
    const room = this.rooms.get(key)
    if (!room) return { ok: false, message: '现在没有进行中的抽奖' }
    if (String(by) !== room.owner) return { ok: false, message: '只有发起人能取消这场抽奖' }
    if (room.timer) clearTimeout(room.timer)
    this.rooms.delete(key)
    return { ok: true, message: `这场抽奖已取消（原本 ${room.entries.size} 人报名）` }
  }

  /** 名单。 */
  status({ gid }) {
    const room = this.rooms.get(String(gid))
    if (!room) return { ok: false, message: '本群当前没有进行中的抽奖，发「抽奖 开 3 人 60秒」开一场吧' }
    const left = Math.max(0, Math.ceil((room.endsAt - this.now()) / 1000))
    const entries = [...room.entries.values()]
    const mode = room.mode === 'keyword' ? `口令「${room.keyword}」 · ` : ''
    const head = `🎁 进行中：${mode}名额 ${room.count} 人 · 还剩 ${left} 秒 · 报名 ${entries.length} 人`
    if (!entries.length) return { ok: true, message: `${head}\n（还没人报名，发「抽奖 参加」）` }
    return { ok: true, message: `${head}\n${entries.map((e, i) => `${i + 1}. ${e.nick}`).join('\n')}` }
  }

  /** 真正的抽签：不放回随机 + 均匀（random() 由外部注入，方便单测）。 */
  pick(list, count) {
    const pool = [...list]
    const n = Math.min(count, pool.length)
    const out = []
    for (let i = 0; i < n; i += 1) {
      const idx = Math.min(pool.length - 1, Math.floor(this.random() * pool.length))
      out.push(pool.splice(idx, 1)[0])
    }
    return out
  }

  /** 宿主卸载时清掉所有计时器（engine.dispose 调用）。 */
  dispose() {
    for (const room of this.rooms.values()) if (room.timer) clearTimeout(room.timer)
    this.rooms.clear()
  }
}

function clampInt(value, min, max) {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return min
  return Math.min(max, Math.max(min, n))
}

// ---------------------------------------------------------------------------
// 新人欢迎
// ---------------------------------------------------------------------------

/**
 * 生成欢迎语。模板里 `{name}` / `{group}` / `{molly}` 会被替换；
 * 传多个模板用 `|` 分隔，按 random 挑一个。
 */
export function buildWelcome({
  texts = GROUPFUN_DEFAULTS.welcomeTexts,
  nickname = '',
  groupName = '',
  mollyName = 'Molly',
  random = Math.random,
} = {}) {
  const list = String(texts || '')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean)
  if (!list.length) return ''
  const idx = Math.min(list.length - 1, Math.floor(random() * list.length))
  return list[idx]
    .replace(/\{name\}/gu, nickname || '新朋友')
    .replace(/\{group\}/gu, groupName || '本群')
    .replace(/\{molly\}/gu, mollyName)
}

/**
 * 取出入群事件里的「新人 qq / 群号」。
 * SnowLuma / OneBot 两种字段都兼容（notice_type=group_increase 或 sub_type=increase）。
 */
export function parseGroupIncrease(ev) {
  const nt = String(ev?.notice_type || '')
  const st = String(ev?.sub_type || '')
  const isIncrease =
    nt === 'group_increase' ||
    (nt === 'notice' && (st === 'increase' || st === 'group_increase')) ||
    (nt === 'notify' && st === 'group_increase')
  if (!isIncrease) return null
  const gid = ev?.group_id ? String(ev.group_id) : ''
  const qq = String(ev?.user_id ?? ev?.uid ?? '')
  if (!gid || !qq) return null
  return { gid, qq }
}
