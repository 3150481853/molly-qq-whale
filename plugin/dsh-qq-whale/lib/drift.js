/**
 * 闲逛（drift）——2026-10-28 主人 m00634：
 * 「我想让molly能自己闲下来的时候或者聊天的时候能自己去刷一下找话题和在
 *   感兴趣的帖子评论互动」
 *
 * 守三条：
 * 1. 只服务主人：闲逛出来的话题只进她自己的上下文；评论必须先私聊主人过目，
 *    主人回「发 1」才真发（B 档）。群里任何人说的话都触发不了这条路。
 * 2. 闸门默认从严：静默时段不跑、日上限、预算余量、无消息才跑、失败静默——
 *    宁可她今天没刷，也不要半夜刷出一堆消息来。
 * 3. 不碰主人那条几百轮的干活会话：用 workSessionTag:'drift1' 单独开一条，
 *    首建时才带得上 ego_*（浏览器）工具。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'

const pad2 = (n) => String(n).padStart(2, '0')
export const localDateKey = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

const KEEP_DAYS = 3
const MAX_TOPICS = 60
const MAX_BATCHES = 20

const DEFAULTS = {
  idleMinutes: 25,
  everyMinutes: 45,
  dailyCap: 8,
  startHour: 8,
  endHour: 24,
  minBudgetLeft: 15,
  notify: true,
  // 一轮闲逛要开浏览器、点几条帖子，180s 的单轮上限不够（实测 36 步被截断），
  // 所以 drift 自己把单轮上限放宽到 8 分钟；executor 侧见 engine.js 的
  // workTurnTimeoutMs 覆盖。
  timeoutMs: 540000,
}

const TASK = [
  '你在替主人闲逛（不是干活任务：别动任何文件、别发 QQ 消息、别列计划）。',
  '用 bsk_* 工具（bsk_session start 开会话 → bsk_page navigate 打开页面 → bsk_inspect observe 读内容 → bsk_interact 操作 → 最后 bsk_session stop）。',
  '**不要用 ego_*，那个浏览器已经被小黑盒风控死了（安全验证循环）。**',
  '弹出「安全验证」/验证码时：用 bsk_assist action=request-help 请主人手动点掉（说明写「小黑盒弹了安全验证，麻烦在浏览器窗口里点一下」），等它消失再继续；等不到就直接输出 []。',
  '最多 6 步，别反复试：',
  '1) 打开 https://www.xiaoheihe.cn/app/bbs/home',
  '2) 用一次脚本/快照把页面上所有 /app/bbs/link/ 的卡片标题抓出来（别一条条看）',
  '3) 挑 2~3 条看起来有意思的（有评论数的优先），各打开一次，读标题和开头几行',
  '4) 立刻输出 JSON 数组，不要解释、不要客套、不要代码块之外的任何字：',
  '[{"title":"标题","author":"作者","link":"https://www.xiaoheihe.cn/app/bbs/link/数字id","gist":"一句话讲这帖子在说什么","why":"你为什么感兴趣（20字内）","draft":"想去评论区回一句就写这句（40字内，像人说话，别夸，具体点）；不想回就写空字符串"}]',
  '5) 收尾关浏览器（bsk_session stop）。',
  '如果浏览器打不开、弹验证码、或者页面根本读不到帖子，就直接输出 [] 结束，别硬试。',
].join('\n')

/** 兜底：模型上一轮给了人话但没给 JSON 时，让它只做一次格式整理。 */
const FORMAT_TASK = [
  '把上一轮你看到的帖子（标题/作者/链接/一句话内容）整理成 JSON 数组，',
  '格式：[{"title":"","author":"","link":"https://www.xiaoheihe.cn/app/bbs/link/数字","gist":"","why":"","draft":""}]',
  '只输出 JSON，不要解释。没有可用的就输出 []。',
].join('\n')

/** 从模型输出里抠出帖子列表：先整段 JSON，再逐行兜底。 */
export function parseTopics(text) {
  const raw = String(text || '')
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : raw
  const norm = (x) => ({
    title: String(x?.title || '').slice(0, 80),
    author: String(x?.author || '').slice(0, 24),
    link: String(x?.link || ''),
    gist: String(x?.gist || '').slice(0, 120),
    why: String(x?.why || '').slice(0, 40),
    draft: String(x?.draft || '').slice(0, 60),
  })
  const usable = (x) => Boolean(x.title) && /^https?:\/\//i.test(x.link)
  // 1) 整段数组（最常见的形状）
  const arr = body.match(/\[[\s\S]*\]/)
  if (arr) {
    try {
      const v = JSON.parse(arr[0])
      const list = (Array.isArray(v) ? v : [v]).map(norm).filter(usable)
      if (list.length) return list.slice(0, 6)
    } catch {}
  }
  // 2) 一行一个对象（模型偶尔会拆开写）
  const out = []
  for (const line of body.split('\n')) {
    const t = line.trim().replace(/^[,\s]+/, '').replace(/,+$/, '')
    if (!(t.startsWith('{') && t.endsWith('}'))) continue
    try {
      out.push(...[JSON.parse(t)].flat().map(norm))
    } catch {}
  }
  return out.filter(usable).slice(0, 6)
}

function withTimeout(p, ms, tag = 'drift') {
  let timer = null
  return Promise.race([
    Promise.resolve(p),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${tag} 超时（${Math.round(ms / 1000)}s）`)), ms)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}

export class Drift {
  constructor({ logger, config = {}, executor, engine, client, dataDir } = {}) {
    this.logger = logger || (() => {})
    this.config = config || {}
    this.executor = executor
    this.engine = engine
    this.client = client
    this.dir = path.join(String(dataDir || '.'), 'drift')
    this.topics = []
    this.batches = []
    this.running = false
    this.started = false
    this.startedAt = Date.now()
    this.lastRunAt = 0
    this.lastOkAt = 0
    this.lastError = ''
    this.count = 0
    this.countDate = ''
    this.lastSay = null
    this._timer = null
  }

  /**
   * 拿 OneBot 客户端。
   *
   * 坑（2026-10-28 实测，主人「没收到🐟」）：main.js 建 engine 时传的是
   * `client: null`，OneBotClient 是之后才创建、再 `engine.client = client` 挂上去的。
   * 构造时把 client 存下来的话，这里永远是 null，say() 会静默 return ——
   * 日志里连报错都没有，看着像「发了」。所以每次发消息都现取。
   */
  get onebot() {
    if (this.client?.sendPrivateMsg) return this.client
    const c = this.engine?.client
    if (c?.sendPrivateMsg) return c
    return null
  }

  get cfg() {
    const c = this.config || {}
    const over = c.drift && typeof c.drift === 'object' ? c.drift : {}
    return { ...DEFAULTS, ...over }
  }

  get available() {
    return this.config.driftEnabled !== false && Boolean(this.executor?.run)
  }

  get ownerUin() {
    const u = this.config.commanderUsers
    if (Array.isArray(u) && u.length) return String(u[0])
    return ''
  }

  inWindow(d = new Date()) {
    const { startHour, endHour } = this.cfg
    const h = d.getHours() + d.getMinutes() / 60
    return h >= Number(startHour) && h < Number(endHour)
  }

  budgetLeft() {
    const b = this.engine?.budget || this.engine?.gateway?.budget
    if (!b) return Infinity
    let v = b.remaining
    if (v == null && typeof b.snapshot === 'function') {
      try { v = b.snapshot()?.remaining } catch { v = null }
    }
    const n = Number(v)
    return Number.isFinite(n) ? n : Infinity
  }

  idleMs() {
    const last = Math.max(Number(this.engine?.lastInboundAt || 0), this.startedAt)
    return Date.now() - last
  }

  start() {
    if (this.started) return
    this.started = true
    this.load().catch((err) => this.logger('warn', `闲逛话题库读取失败：${err?.message || err}`))
    this._timer = setInterval(() => {
      this.tick().catch((err) => this.logger('warn', `闲逛 tick 失败：${err?.message || err}`))
    }, 60 * 1000)
    this._timer.unref?.()
  }

  stop() {
    if (this._timer) clearInterval(this._timer)
    this._timer = null
    this.started = false
  }

  async load() {
    try {
      const text = await fs.readFile(path.join(this.dir, 'topics.jsonl'), 'utf8')
      const cutoff = Date.now() - KEEP_DAYS * 86400000
      this.topics = text.split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l) } catch { return null }
      }).filter((x) => x && x.at > cutoff)
    } catch {}
    try {
      const b = JSON.parse(await fs.readFile(path.join(this.dir, 'batches.json'), 'utf8'))
      if (Array.isArray(b)) this.batches = b.slice(-MAX_BATCHES)
    } catch {}
  }

  async save() {
    try {
      await fs.mkdir(this.dir, { recursive: true })
      const cutoff = Date.now() - KEEP_DAYS * 86400000
      this.topics = this.topics.filter((x) => x.at > cutoff).slice(-MAX_TOPICS)
      await fs.writeFile(path.join(this.dir, 'topics.jsonl'), this.topics.map((x) => JSON.stringify(x)).join('\n') + '\n', 'utf8')
      this.batches = this.batches.slice(-MAX_BATCHES)
      await fs.writeFile(path.join(this.dir, 'batches.json'), JSON.stringify(this.batches, null, 2), 'utf8')
    } catch (err) {
      this.logger('warn', `闲逛落盘失败：${err?.message || err}`)
    }
  }

  async say(text) {
    const uin = this.ownerUin
    if (!uin) {
      this.lastSay = { at: Date.now(), ok: false, error: '没有 commanderUsers' }
      this.logger('warn', '闲逛想私聊，但没配 commanderUsers')
      return false
    }
    const ob = this.onebot
    if (!ob) {
      this.lastSay = { at: Date.now(), ok: false, error: 'OneBot 还没连上（client 为空）' }
      this.logger('warn', '闲逛想私聊，但 OneBot 还没连上')
      return false
    }
    try {
      const r = await ob.sendPrivateMsg(uin, [{ type: 'text', data: { text: String(text) } }])
      const id = r?.message_id ?? r?.data?.message_id ?? null
      this.lastSay = { at: Date.now(), ok: true, messageId: id }
      this.logger('info', `闲逛私聊已发出（${uin}，message_id=${id ?? '?'}）`)
      return true
    } catch (err) {
      const msg = String(err?.message || err).slice(0, 120)
      this.lastSay = { at: Date.now(), ok: false, error: msg }
      this.logger('warn', `闲逛私聊发送失败：${msg}`)
      return false
    }
  }

  async runTask(task) {
    const res = await withTimeout(this.executor.run(task, {}), Number(this.cfg.timeoutMs) || 300000)
    const text = String(res?.text || '')
    return { ok: Boolean(text) && Boolean(res?.ok !== false), text }
  }

  async tick() {
    if (!this.available || this.running) return
    const d = new Date()
    if (!this.inWindow(d)) return
    if (this.countDate !== localDateKey(d)) {
      this.countDate = localDateKey(d)
      this.count = 0
    }
    const cfg = this.cfg
    if (this.count >= Number(cfg.dailyCap)) return
    if (this.idleMs() < Number(cfg.idleMinutes) * 60000) return
    if (Date.now() - this.lastRunAt < Number(cfg.everyMinutes) * 60000) return
    if (this.budgetLeft() < Number(cfg.minBudgetLeft)) return
    await this.runOnce({ reason: 'idle' })
  }

  /** 跑一轮：刷帖 → 存话题 → 给主人过目（有想回的才问）。 */
  async runOnce({ reason = 'manual', notify = null } = {}) {
    if (!this.available) return { ok: false, error: '闲逛不可用（没开或没有执行器）' }
    if (this.running) return { ok: false, error: '上一轮还没跑完' }
    this.running = true
    this.lastRunAt = Date.now()
    {
      const today = localDateKey()
      if (this.countDate !== today) {
        this.countDate = today
        this.count = 0
      }
    }
    try {
      let res = await this.runTask(TASK)
      let items = parseTopics(res.text)
      if (!items.length) {
        /*
         * 2026-10-28（实测）：模型常常「逛完了但忘了吐 JSON」——上一轮 36 步、
         * 帖子标题都读到了，最后一句是「挑 3 条候选：…」，再问它就死。
         * 这里不重开一轮（重开又要从头刷），直接让同一个会话把刚才看到的东西
         * 整理成 JSON，一次很便宜的对话就够。
         */
        const first = String(res?.text || '')
        if (first.trim()) {
          this.logger('info', `闲逛没给 JSON（${first.length} 字），让会话整理一次`)
          res = await this.runTask(FORMAT_TASK)
          items = parseTopics(res.text)
        }
        if (!items.length) {
          this.lastError = '没解析到帖子（模型输出不是 JSON）'
          const raw = String(res.text || '').slice(0, 400)
          this.logger('warn', `闲逛没产出：${raw.slice(0, 160)}`)
          return { ok: false, error: this.lastError, raw }
        }
      }
      const at = Date.now()
      for (const it of items) {
        if (this.topics.some((t) => t.link === it.link)) continue
        this.topics.push({ at, ...it })
      }
      const batch = {
        at,
        items: items.map((it) => ({ title: it.title, author: it.author, link: it.link, gist: it.gist, why: it.why })),
        drafts: items
          .map((it, i) => ({ index: i + 1, title: it.title, link: it.link, draft: it.draft, status: 'pending' }))
          .filter((d) => d.draft),
      }
      this.batches.push(batch)
      await this.save()
      if (reason === 'idle') this.count += 1
      this.lastOkAt = at
      this.lastError = ''
      this.logger('info', `闲逛完成（${reason}）：${items.length} 条，想回 ${batch.drafts.length} 条`)
      const shouldNotify = notify == null ? this.cfg.notify !== false : notify
      if (shouldNotify) await this.say(this.composeNotice(batch))
      return { ok: true, items: items.length, drafts: batch.drafts.length }
    } catch (err) {
      this.lastError = String(err?.message || err).slice(0, 160)
      this.logger('warn', `闲逛失败：${this.lastError}`)
      return { ok: false, error: this.lastError }
    } finally {
      this.running = false
    }
  }

  composeNotice(batch) {
    const lines = ['🐟 刷了会儿小黑盒，看到这几条：']
    batch.items.forEach((it, i) => {
      const by = it.author ? `｜${it.author}` : ''
      const gist = it.gist ? ` —— ${it.gist}` : ''
      lines.push(`${i + 1}. ${it.title}${by}${gist}`)
    })
    lines.push('', '回「细节 2」我把那条讲给你。')
    const drafts = batch.drafts || []
    if (drafts.length) {
      lines.push('', '有几条我想去回一句：')
      drafts.forEach((d) => lines.push(`${d.index}. ${d.title}`, `   我想回：${d.draft}`))
      lines.push('', '回「发 1」我就去发；回「不发 1」就算了。都不回我就不动。')
    }
    return lines.join('\n')
  }

  /** 主人回执：「细节 N」「发 N」「不发 N」。命中返回 true（已处理）。 */
  async handleOwnerReply({ ev, text, isCommander } = {}) {
    if (!this.available) return false
    if (ev?.message_type !== 'private') return false
    if (!isCommander) return false
    const t = String(text || '').trim()
    const m = t.match(/^(细节|发|不发)\s*([1-9]\d?)$/u)
    if (!m) return false
    const kind = m[1]
    const n = Number(m[2])
    const batch = this.batches[this.batches.length - 1]
    if (!batch) {
      await this.say('最近还没刷到东西，没得看。')
      return true
    }
    if (kind === '细节') {
      const it = batch.items[n - 1]
      if (!it) {
        await this.say(`这一轮只有 ${batch.items.length} 条，没有第 ${n} 条。`)
        return true
      }
      const why = it.why ? `\n为什么注意到：${it.why}` : ''
      await this.say(`【${n}】${it.title}${it.author ? `｜${it.author}` : ''}\n${it.gist || ''}${why}\n${it.link}`)
      return true
    }
    const d = (batch.drafts || []).find((x) => Number(x.index) === n)
    if (!d) {
      await this.say(`第 ${n} 条我没有想回的话（能回的是 ${(batch.drafts || []).map((x) => x.index).join('、') || '没有'}）。`)
      return true
    }
    if (kind === '不发') {
      d.status = 'skipped'
      await this.save()
      await this.say('行，这条不回了。')
      return true
    }
    if (d.status === 'sent') {
      await this.say('这条已经回过了。')
      return true
    }
    d.status = 'sending'
    const task = [
      `打开这个帖子：${d.link}`,
      `在评论区发这一句（就用这句，别改意思，可以加个表情）：${d.draft}`,
      '用 bsk_* 工具（bsk_session start → bsk_page navigate → bsk_inspect observe → bsk_interact 输入/点击 → bsk_session stop）：等正文渲染出来，找到评论框，输入这句话，点「发送」。',
      '不要用 ego_*（已被小黑盒风控）。发送后回到评论区确认这句话真的出现了，再回结果。',
      '如果页面出现登录弹窗、二维码、验证码、滑块、「安全验证」「操作过于频繁」「访问异常」这类拦截，',
      '先用 bsk_assist action=request-help 请主人手动点掉（说明写「小黑盒弹了安全验证，麻烦在浏览器窗口里点一下」），等 60 秒再继续；',
      '主人没点掉、或点掉后仍然被拦，就不要反复重试、不要刷新页面——直接回一句「被拦：<页面上具体写了什么>」。',
      '最多 10 步。完成后只回一句：「已发」或者「没发成：原因」或者「被拦：…」。不要自己发 QQ 消息。',
    ].join('\n')
    await this.say('好，我去回。')
    /*
     * 不 await：发评论要开浏览器、可能几分钟。若在这里阻塞，主人在等结果的
     * 这几分钟里，别人发的消息也会一起卡住（onMessage 是串行 await 的）。
     * 所以丢到后台跑，结果回来再回一句话。
     */
    void this.postComment(d, task)
    return true
  }

  /** 后台执行一条评论；结果写回 drafts 并回主人一句。 */
  async postComment(d, task) {
    let lastErr = ''
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await this.runTask(task)
        const text = String(res?.text || '').trim()
        if (!text) {
          /*
           * 空结果的两大来源（2026-10-28 实测都遇到过）：
           * ①插件被重载/宿主重启 → 会话中途被 dispose，回来是一句空话；
           * ②模型把这一轮跑成了纯工具轮，没留一句话。
           * 两种情况重试一次都比直接报失败靠谱；第二次还空才算失败。
           */
          lastErr = '会话没有产出任何内容（被重启打断，或者模型没留话）'
          if (attempt === 1) {
            this.logger('warn', `闲逛评论空跑，10 秒后重试一次：${d.link}`)
            await new Promise((r) => setTimeout(r, 10000))
            continue
          }
          d.status = 'failed'
          d.result = lastErr
          break
        }
        d.result = text.slice(0, 120)
        if (/被拦/.test(text)) d.status = 'blocked'
        else if (/已发/.test(text)) d.status = 'sent'
        else d.status = 'failed'
        break
      } catch (err) {
        lastErr = String(err?.message || err).slice(0, 120)
        d.status = 'failed'
        d.result = lastErr
        break
      }
    }
    try {
      await this.save()
    } catch (err) {
      this.logger('warn', `闲逛草稿落盘失败：${err?.message || err}`)
    }
    const msg =
      d.status === 'sent'
        ? '发出去了。'
        : d.status === 'blocked'
          ? `被拦了：${d.result || '页面上弹了验证'}`
          : `没发成：${d.result || '不知道为啥'}`
    await this.say(msg).catch(() => {})
  }

  /** 给聊天用的「最近刷到的」。 */
  contextText({ hours = 24, limit = 3 } = {}) {
    const cutoff = Date.now() - hours * 3600000
    const list = this.topics.filter((t) => t.at > cutoff).slice(-limit)
    if (!list.length) return ''
    return list.map((t) => `- ${t.title}${t.author ? `（${t.author}）` : ''}：${t.gist || ''}`).join('\n')
  }

  status() {
    const pending = this.batches.flatMap((b) => b.drafts || []).filter((d) => d.status === 'pending')
    return {
      enabled: this.config.driftEnabled !== false,
      ok: this.available,
      running: this.running,
      count: this.count,
      dailyCap: Number(this.cfg.dailyCap),
      lastRunAt: this.lastRunAt,
      lastOkAt: this.lastOkAt,
      lastError: this.lastError,
      topics: this.topics.length,
      pendingDrafts: pending.length,
      budgetLeft: this.budgetLeft(),
      lastSay: this.lastSay,
      sayReady: Boolean(this.onebot),
    }
  }
}

export default Drift
