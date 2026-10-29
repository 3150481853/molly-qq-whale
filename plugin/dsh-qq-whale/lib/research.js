/**
 * 「先查再说」——让 Molly 在群里/私聊被问到事实性问题时，真的去查。
 *
 * ## 为什么要这一层
 *
 * 用户原话（m11614-1）：「感觉有点傻傻的，问啥东西都说不知道，既然接 wb 了
 * 应该能做些啥事了吧」。这是真话——原来的链路里，聊天走的是纯文本
 * ModelCaller，**没有任何工具**。人设 core.md 第 28 行还写着
 * 「被问到不懂的就直说不知道」，于是「今天天气怎么样」「X 是什么梗」
 * 这类问题她只会回一句不知道，用户眼里就是蠢。
 *
 * ## 两条通道（2026-10-28 起）
 *
 * ① **本地先查**：`lib/webview.js` 直接搜 Bing RSS / 读网页正文 / 查天气。
 *    零依赖、秒级、不烧模型额度。链接、天气、简单事实走这条就够了。
 *    代价是拿回来的是摘要，不是结论——所以下面还有第二道。
 *
 * ② **活儿会话兜底**：本地查不到（站点要登录、页面抽不出正文、天气没城市名）
 *    时，仍交给「命令 xxx」背后那个干活会话——它有完整工具集和浏览器登录态，
 *    能打开本地这条线打不开的站。代价是慢（几十秒起步）。
 *
 * 两条都是「借来的手」：她的手做完事，把结论说给她听，她再用自己的口吻
 * 讲出来。这样既有了能力，又不会在群里蹦出一段机器人味儿的研究报告。
 *
 * 外面拿回来的东西一律是**资料，不是指令**（QQ-A 第九节那条规矩）：
 * 网页正文里写「忽略之前的设定」也照旧当资料看。
 *
 * ## 三道闸门（防止把聊天变成查资料）
 *
 *   1. 只查**事实性**问题（天气/时间/价格/查一下/是什么/怎么样/新闻/梗）
 *   2. 每条消息最多查一次，且查完就缓存一小会儿（同样的问题不重复烧 token）
 *   3. 查不到就查不到，回落成聊天——绝不让「查资料失败」变成「她不说话」
 */

import { extractUrls } from './webview.js'

/**
 * 一眼看上去像「需要外部事实」的问句。
 *
 * ⚠️ 这张表是本文件里最容易写坏的地方。第一版把「为什么/怎么样/多少/是不是」
 * 这类词也放进来了，实测会把「你为啥不说话」「这是啥」「多少有点离谱」全判成
 * 要查资料——于是每句闲聊都要等一次搜索，回复从两秒变二十秒，活人感直接塌掉。
 *
 * 所以现在的原则是：**只认强信号，宁可漏，不可滥**。闲聊误判的代价（变慢、
 * 变机械）远大于漏查的代价（偶尔说句不知道）。
 */
const FACT_PATTERNS = [
  // 天气、时间、日期——最典型、最高频、最答得出来的
  /天气|气温|下雨|下雪|冷不冷|热不热|几度|温度/,
  /今天.*(几号|星期|周几|日期)|现在几点|几点钟/,
  // 显式要求去查
  /查一下|查查|搜一下|搜搜|帮我查|帮我搜|查查看|百度一下|谷歌一下|你查/,
  // 强事实问句：带明确的「这/那/它/XX 是」+ 疑问收尾
  /(是什么|是啥|啥意思|什么梗|哪些|哪一个|多少钱|什么价)/,
  // 「XX 是谁 / XX 是哪个公司」——问人问主体，最典型的查资料场景
  /(是谁|是哪(个|家|国|年)|叫什么名字|干嘛的|做过什么)/,
  // 时效性话题
  /新闻|最新消息|最近.*(发生|怎么)|现在.*(价格|股价|汇率|油价|金价|比分)|上映|发布了?/,
]

/**
 * 「这就是闲聊，别查」的强否定。命中就立刻放弃查。
 *
 * 这些词在中文聊天里高得离谱，而且几乎从不携带需要外部事实的诉求。
 * 放在 FACT_PATTERNS 之前判定，优先级更高。
 */
const CHAT_PATTERNS = [
  /^(在吗|在不在|在干嘛|干嘛呢|睡了没|睡了吗|吃了吗|吃了没|早安|晚安|早上好|晚上好|你好|哈+|草+|笑死|绷不住|6+|牛|绝了)/,
  /你(觉得|喜欢|开心|难过|累|想吃|在想|记不记得|还记得|说|讲|发|回|看|听)/,
  /(无语|离谱|服了|确实|也是|好家伙|不是吧|真的假的|绷|难崩|逆天|抽象)/,
  // 句尾拖着一串「哈/嘿/呵/草」的，基本是笑，不是问。
  // 反例「这是啥啊哈哈哈哈」就是这么被误判成要查资料的——真去查了也答不出
  // 任何有意义的东西，白白让她沉默十几秒。
  /(哈{2,}|嘿{2,}|呵{2,}|草{2,}|[?？!！~～。.…]*哈{2,})[?？!！~～。.…]*$/,
]

/**
 * 「她就是她自己」的话题，不需要查。
 * 这类问题问的是她的感受/记忆，查了反而奇怪。
 */
const SELF_PATTERNS = [
  /你(觉得|喜欢|开心|难过|累|想吃|在想|记不记得|还记)/,
  /^(在吗|在干嘛|睡了吗|吃了吗|你好|早上好|晚安|哈哈+|草+|笑死|绷不住)/,
]

/**
 * 判定一条消息需不需要外部事实。
 *
 * @param {string} text 用户原话（已去掉 @ 和前缀）
 * @returns {{need:boolean, query:string, reason:string}}
 */
export function needsResearch(text, { enabled = true } = {}) {
  const t = String(text || '').trim()
  if (!enabled) return { need: false, query: '', reason: 'disabled' }
  if (t.length < 3) return { need: false, query: '', reason: 'too-short' }
  // 纯表情 / 纯标点
  if (!/[\u4e00-\u9fa5a-zA-Z0-9]/.test(t)) return { need: false, query: '', reason: 'no-content' }

  // 先排除「这就是闲聊」的——优先级最高，命中就闭嘴
  for (const p of CHAT_PATTERNS) {
    if (p.test(t)) return { need: false, query: '', reason: 'chat-only' }
  }

  // 再排除「关于她自己」的
  for (const p of SELF_PATTERNS) {
    if (p.test(t)) return { need: false, query: '', reason: 'about-self' }
  }

  /*
   * 链接优先：别人甩来一个帖子，她要真的打开看看（2026-10-28，QQ-A 第九节）。
   *
   * 这一条必须放在长度闸门**前面**——URL 本身就三四十个字符，前面再带一句
   * 「看看这个」，轻松超过 40 字。按长度毙掉的话，她就永远只会说「我打不开链接」。
   */
  const urls = extractUrls(t)
  if (urls.length) return { need: true, query: t, reason: `url:${urls.length}` }

  // 太长的消息多半是在讲话，不是在问事实——超过 40 字基本是吐槽/聊天
  if (t.length > 40) return { need: false, query: '', reason: 'too-long' }

  for (const p of FACT_PATTERNS) {
    if (p.test(t)) return { need: true, query: buildQuery(t), reason: `matched:${p.source.slice(0, 20)}` }
  }

  return { need: false, query: '', reason: 'not-factual' }
}

/**
 * 把用户原话改写成一句**真正查得动**的查询。
 *
 * 起因（2026-10-17 真机）：「示例成员C那边天气咋样」── 判定命中「天气」，
 * 原话原样丢给干活会话，它去查"示例成员C的天气"，查回一堆
 * 「没查到关于示例成员C是那个梦里面的角色…不晓得」。她照着这段答，
 * 用户在群里看到的就是「某地的天气我是真查不了，我这没这本事」。
 *
 * 问题不在判定，在**原话不是查询**。人问天气时说的是"那边"、"这儿"，
 * 模型没有对话上下文根本不知道指哪。所以这里做两件小事：
 *
 *   ① 把时间词补实：她说"咋样/怎么样"，查的时候要的是"今天"的天气
 *   ② 地点识别不出来时，明确告诉干活会话「地点不明确」，
 *      让它自己决定是问一句还是按对方可能说的地点试
 *
 * 刻意**不**在这里猜地点：猜错比不猜更糟（查了北京的天气答某地的问题）。
 */
export function buildQuery(text) {
  const t = String(text || '').trim()
  if (!t) return t

  const isWeather = /天气|气温|下雨|下雪|冷不冷|热不热|几度|温度/.test(t)
  if (!isWeather) return t

  // 已经是完整查询的（带"今天/明天/现在"和时间）就别动它
  if (/今天|明天|昨天|现在|当前|现在几点/.test(t)) return t

  return `${t}（今天）`
}

/** 天气类问题（本地天气接口只认这些问法；不含「几号/周几」这类）。 */
const WEATHER_RE = /天气|气温|几度|多少度|温度|下雨|下雪|冷不冷|热不热/

/**
 * 从一句「XX 天气怎么样」里抠出城市名。
 *
 * 2026-10-28 接本地天气接口时加的。抠不出来就返回空串——上层据此交回干活
 * 会话，绝不拿「那边」去查。猜错地点比不猜更糟（查了北京的天气答某地的问题）。
 */
export function extractCity(text) {
  let t = String(text || '').trim()
  if (!t) return ''
  t = t.replace(/[?？!！。~～…，,、]+/g, ' ')
  // 「帮我查一下」「看看」这类动词不算地名
  t = t.replace(/(帮我|请你|请|给我|麻烦|你)?\s*(查一下|查查|搜一下|搜搜|查查看|百度一下|谷歌一下|看看|看一下)\s*/g, ' ')
  t = t.replace(/[（(]?(今天|明天|后天|现在|当前|最近)[）)]?/g, ' ')
  t = t.replace(/(的)?(天气预报|天气情况|天气|气温|温度|下雨|下雪|冷不冷|热不热|几度|多少度)(怎么样|咋样|如何|好不好|好么)?/g, ' ')
  t = t.replace(/(那边|这儿|这里|那边儿|咋样|怎么样|如何|呢|啊|呀|吗|的)/g, ' ')
  t = t.replace(/\s+/g, ' ').trim()
  // 只认「2~8 个汉字」或「英文地名」——再多就是句子，不是地名
  const m = t.match(/^([\u4e00-\u9fa5]{2,8}|[A-Za-z][A-Za-z\s.'-]{1,24})$/)
  return m ? m[1].trim() : ''
}

/** 把「帮我查一下X」还原成「X」再丢给搜索引擎，省得搜回来一堆「如何查」。 */
export function normalizeQuery(text) {
  const raw = String(text || '').trim()
  const t = raw
    .replace(/[?？!！。~～…，,]+$/g, '')
    .replace(/^(帮我|请你|请|给我|麻烦|你能|能不能|可以)?\s*(查一下|查查|搜一下|搜搜|查查看|百度一下|谷歌一下|你查|看看|看一下)\s*/, '')
    .replace(/^(请问|想问一下|想问|问一下|我想知道|我想问)\s*[，,]?\s*/, '')
    // 「最近有什么 X」→「X」：Bing 会把「最近」当词条本身（回李圣杰那首《最近》），
    // 实测「人工智能 新闻」的前三条全是 AI 快讯，「最近 人工智能新闻」全是词条解释 —— 直接丢掉
    .replace(/^(最近|现在|目前|如今|这几天)\s*(有没有|有什么|有啥|有些什么|有什么新|有啥新)\s*/, '')
    // 语气词收尾（「什么/怎么/贴吧/酒吧」里的那个字不算语气词）
    .replace(/(?<![什怎那这多贴酒])(吗|呢|啊|呀|吧)\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return t || raw
}

/** 压成一行、限长。喂给聊天上下文的必须是「能说出口」的一段话。 */
export function trimForChat(text, maxChars = 420) {
  const t = String(text || '').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  return t.length > maxChars ? `${t.slice(0, maxChars)}…` : t
}

/**
 * 剥掉宿主协议标记（2026-10-29 真机）。
 *
 * 干活会话的最终回答前面会挂一串事件引用：
 *   <acp tokens="114" type="text">m01283</acp>
 *   <acp tokens="112" type="text">m01186</acp> …
 * 这些是协议不是内容。以前它们一路走到 `condense()` 里：四个标记各自占掉
 * 小半行，220 字预算被它们吃光，正文那行根本没进 `out` —— 于是面板显示
 * 「查到了」（found=true，因为标记串非空），聊天里她一个字都没拿到。
 *
 * 顺序很要紧：**先剥标记再压字数**，否则压缩阶段就已经把正文截没了。
 */
export function stripHostMarks(text) {
  return String(text || '')
    .replace(/<acp\b[^>]*>[\s\S]*?<\/acp>/gi, ' ')
    .replace(/<\/?acp\b[^>]*>/gi, ' ')
    .replace(/\bm\d{5}\b/g, ' ')
    .replace(/\{\{[\s\S]*?\}\}/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/**
 * RSS 的 pubDate → 本地日期 `2026-10-28`。查新闻时把日期带上，她才不会把
 * 两年前的旧闻当成今天的讲。Bing 走 mkt=zh-CN 时给的是「周四, 29 10月 2026
 * 05:33:00 GMT」这种中文格式，Date.parse 认不出，得自己拆。解析不了就不带。
 */
export function formatDate(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  let t = Date.parse(s)
  if (!Number.isFinite(t)) {
    const m = /(\d{1,2})\s+([^\s,]+?)\s+(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(s)
    if (m) {
      const day = Number(m[1])
      const year = Number(m[3])
      const cn = /^(\d{1,2})月$/.exec(m[2])
      const idx = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(String(m[2]).slice(0, 3).toLowerCase())
      const mon = cn ? Number(cn[1]) : idx + 1
      if (mon >= 1 && mon <= 12 && day >= 1 && day <= 31) {
        t = Date.UTC(year, mon - 1, day, Number(m[4]) || 0, Number(m[5]) || 0, Number(m[6]) || 0)
      }
    }
  }
  if (!Number.isFinite(t)) return ''
  const d = new Date(t)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * 把「查」这个动作包成一次小事务。
 *
 * 设计要点：
 *   - 有超时。查资料不能让她在群里失联两分钟，超时就当没查到。
 *   - 有并发去重。同一条消息被两个人同时问，只查一次。
 *   - 结果有长度上限。喂回聊天上下文的必须是"能直接说出口"的摘要，
 *     不是原始 HTML——不然她会原样吐一段网页，反而更怪。
 */
export class Researcher {
  constructor({ executor, logger, timeoutMs = 300000, enabled = true, webview = null }) {
    this.executor = executor
    this.logger = logger || (() => {})
    this.timeoutMs = Math.max(5000, Number(timeoutMs) || 300000)
    this.enabled = enabled !== false
    // 本地通道（lib/webview.js）。没有它也能跑：退回只用干活会话。
    this.webview = webview || null
    this.inflight = new Map()
  }

  get available() {
    return Boolean(this.enabled && (this.executor?.run || this.webview?.available))
  }

  /**
   * 查一件事。返回 {ok, summary} —— 永远不抛。
   *
   * @param {string} query 用户原话，直接当任务描述给干活会话
   * @param {{reason?:string}} opts
   */
  async research(query, { reason = '', localOnly = false } = {}) {
    if (!this.available) return { ok: false, summary: '', error: 'researcher 不可用' }
    const key = String(query || '').trim()
    if (!key) return { ok: false, summary: '', error: '空查询' }

    // 并发去重：同一条查询只跑一次
    const running = this.inflight.get(key)
    if (running) {
      this.logger('debug', `同一个查询正在跑，复用结果：${key.slice(0, 30)}`)
      return running
    }

    const job = this.#run(key, reason, { localOnly }).finally(() => {
      this.inflight.delete(key)
    })
    this.inflight.set(key, job)
    return job
  }

  async #run(query, reason, { localOnly = false } = {}) {
    const started = Date.now()

    /*
     * ① 本地通道先试（2026-10-28）：链接抓正文、天气查 wttr/open-meteo、
     * 其余事实问题搜 Bing RSS。一到两秒，不占干活会话、不烧模型额度。
     */
    const local = await this.#local(query, reason)
    if (local?.ok) return { ...local, elapsed: Date.now() - started }

    /*
     * 主脑额度用尽（budgetOut）时只走本地通道（2026-10-29）。
     *
     * 本地通道是纯 HTTP 取数，不花模型钱；干活会话那条兜底要起一轮模型，
     * 额度没了就不该再开——但也不该像以前那样整条 research 直接跳过，
     * 否则「今天杭州天气」「这个链接讲了啥」在主脑没额度时全部哑火，
     * 主人看到的就是「我没打开 / 我不知道」（用户 m01002「还是不行」）。
     */
    if (localOnly) {
      return {
        ok: false,
        summary: '',
        error: local?.error || '本地通道没查到（主脑额度已用尽，这一轮不开干活会话）',
        elapsed: Date.now() - started,
      }
    }

    if (!this.executor?.run) {
      return {
        ok: false,
        summary: '',
        error: local?.error || '没有可用的查询通道（本地通道与干活会话都不可用）',
        elapsed: Date.now() - started,
      }
    }
    if (local) {
      this.logger('debug', `本地通道没查着（${local.error || '没信息量'}），交给干活会话：${query.slice(0, 30)}`)
    }

    /*
     * 被安全策略拦下来的链接（内网/本机端口/带凭据/非 http(s)）**不再交给干活会话**。
     * 干活会话手里的浏览器工具没有那层白名单校验，转过去等于把 SSRF 防线绕开；
     * 宁可这次不查，让她按平常聊天回。
     */
    const guarded = /(禁止访问|不在白名单|不能包含凭据|仅允许 http)/.test(String(local?.error || ''))
    if (guarded) {
      return { ok: false, summary: '', error: local?.error || '链接被安全策略拦下', elapsed: Date.now() - started }
    }

    /*
     * 给她一个「查完只说结论」的硬约束。
     *
     * 不这么写的话，干活会话会把她当成通用助理，输出一大段 Markdown 研究报告
     * （标题、分点、参考链接），直接被当作聊天内容发进群里——那是机器人味儿
     * 的灾难。这里要的是「一两句话的结论」，措辞细节留给聊天链路自己润色。
     */
    const lines = [
      `帮我在网上查一下，然后**只用一两句话**把结论告诉我。不要分点，不要小标题，不要贴链接列表。`,
      `如果查不到或者不确定，就直接说"没查到"。不要编。`,
      `**不要用 qq_onebot 或任何工具发消息**——查资料只要结论，发消息由我自己来（发了也会被拦）。`,
    ]
    /*
     * 2026-10-29：主人群里发小黑盒分享链接（`api.xiaoheihe.cn/.../web/share?link_id=…`），
     * 本地抓到的是一层空壳（HTTP 200、title「小黑盒 - 玩家高能聚集地」、正文 0 字），
     * 干活会话那边也只试了普通抓取 → 回了「这条我没打开」。分享页正文是 JS 渲染的，
     * 这里必须明确要求「用浏览器」，并把跳转后的真实地址一并给出，否则它还会白试一遍。
     * （被 SSRF 守卫挡下的链接在上面的 guarded 分支就已经提前返回了，走不到这里。）
     */
    if (local?.shell || extractUrls(query).length) {
      lines.push(`提示：普通抓取拿不到正文的页面（动态渲染、分享页），改用 bsk_* 浏览器工具打开一次再读；不要凭 URL 猜内容。`)
      if (local?.url) lines.push(`这个链接跳转后的真实地址是：${local.url}`)
    }
    lines.push(``, `要查的是：${query}`)
    const task = lines.join('\n')

    try {
      const result = await withTimeout(
        this.executor.run(task, {}),
        this.timeoutMs,
        () => new Error(`查资料超时（${Math.round(this.timeoutMs / 1000)} 秒）`),
      )
      const elapsed = Date.now() - started
      if (!result?.ok) {
        this.logger('warn', `查资料失败（${reason}）：${result?.text || '未知'}`)
        return { ok: false, summary: '', error: result?.text || '查询失败', elapsed }
      }
      const summary = condense(stripHostMarks(result.text))
      /*
       * 查回来是一堆"我不晓得"，跟没查一样。
       *
       * 返回 ok:false 而不是 ok:true + 废话 —— 上层看到 ok:false 就不往
       * system prompt 里塞背景，她就当这问题没查过、按正常聊天回。
       * 让她拿到一段"查不到"，她一定会说"我查不了"，那才是真正的灾难。
       */
      if (looksEmpty(summary)) {
        this.logger('warn', `查资料回来是空的（${(elapsed / 1000).toFixed(1)}s）：${query.slice(0, 30)}`)
        return { ok: false, summary: '', error: '查回来的内容没有信息量', elapsed }
      }
      this.logger('info', `查资料完成（${(elapsed / 1000).toFixed(1)}s）：${query.slice(0, 30)}`)
      return { ok: true, summary, raw: result.text, elapsed }
    } catch (err) {
      const msg = err?.message || String(err)
      this.logger('warn', `查资料抛错（${reason}）：${msg}`)
      return { ok: false, summary: '', error: msg, elapsed: Date.now() - started }
    }
  }

  /**
   * 本地通道：不经过模型，直接用 lib/webview.js 拿资料。
   *
   * 返回 null = 没配本地通道；返回 {ok:false,error} = 本地试过了但没拿到，
   * 可以交回干活会话。**永远不抛**——查资料失败不能把她整条回复拖垮。
   */
  async #local(query, reason) {
    const wv = this.webview
    if (!wv?.available) return null
    const started = Date.now()
    try {
      const urls = extractUrls(query)
      if (urls.length) return await this.#localPage(wv, urls[0], started)

      if (WEATHER_RE.test(query)) {
        const city = extractCity(query)
        // 没识别出城市（「那边天气咋样」）就别瞎猜——猜错比不猜更糟，交回干活会话
        if (!city) return { ok: false, error: '天气问题里没识别出城市' }
        const w = await wv.weather(city)
        if (w?.ok) {
          this.logger('info', `查天气（本地）：${city} → ${w.text}`)
          return { ok: true, source: 'webview/weather', summary: w.text, raw: JSON.stringify(w), url: '', elapsed: Date.now() - started }
        }
        return { ok: false, error: w?.error || '天气接口没返回' }
      }

      const q = normalizeQuery(query)
      const s = await wv.search(q, { limit: 5 })
      if (!s?.ok) return { ok: false, error: s?.error || '搜索没返回' }
      const picked = (s.results || []).filter((r) => r?.title || r?.snippet).slice(0, 3)
      if (!picked.length) return { ok: false, error: '搜索结果为空' }
      const body = trimForChat(picked.map((r) => `${r.title}${r.snippet ? `：${r.snippet}` : ''}`).join('；'), 320)
      if (looksEmpty(body)) return { ok: false, error: '搜索结果没信息量' }
      const when = formatDate(picked[0]?.publishedAt)
      const summary = `${body}（来源：${picked[0].url || ''}${when ? `，${when}` : ''}）`
      this.logger('info', `搜到了（本地）：${q.slice(0, 30)} → ${picked.length} 条`)
      return {
        ok: true,
        source: 'webview/search',
        summary,
        raw: JSON.stringify(s.results),
        url: picked[0].url || '',
        elapsed: Date.now() - started,
      }
    } catch (err) {
      this.logger('warn', `本地通道抛错（${reason}）：${err?.message || err}`)
      return { ok: false, error: err?.message || String(err) }
    }
  }

  async #localPage(wv, url, started) {
    const page = await wv.fetchPage(url, { maxChars: 2000 })
    if (!page?.ok) return { ok: false, error: page?.error || '抓不到这个网页' }
    const body = trimForChat(page.text, 420)
    /*
     * 分享页/SPA 只有一层壳：HTTP 200、title 是站点名、正文 0 字。
     * 典型是小黑盒 `api.xiaoheihe.cn/.../web/share` 一跳转到 `www.xiaoheihe.cn/app/bbs/link/…`，
     * 正文全靠 JS 渲染。这种必须交给干活会话用浏览器打开（见 #run 的提示），
     * 不能骗自己说「读到了」。
     */
    if (!body || looksEmpty(body)) {
      return {
        ok: false,
        error: '网页没读到正文（需要浏览器渲染的动态页/分享页）',
        url: page.finalUrl || url,
        shell: true,
      }
    }
    const title = page.title ? `《${trimForChat(page.title, 40)}》` : '网页'
    const summary = `${title}${body}（原链接：${page.finalUrl || url}）`
    this.logger('info', `读了网页（本地）：${page.finalUrl || url} → ${body.length} 字`)
    return {
      ok: true,
      source: 'webview/page',
      summary,
      raw: page.text,
      url: page.finalUrl || url,
      elapsed: Date.now() - started,
    }
  }
}

/**
 * 这段话里有没有真东西。
 *
 * 干活会话查不到的时候不会老实说"没查到"，而是会吐一长串自我辩解：
 * 「没查到关于示例成员C是那个梦里面的角色/作品查不到重点，而且没有说他哪边的
 * 那个天气我最近都不知道，不晓得」。这种文字**塞回聊天反而更糟**——
 * 她会照着这段说"我查不了"，用户看到的就是一个废柴。
 *
 * 所以判据很简单：开头就认输的直接当没查到，宁可不给她背景。
 */
export function looksEmpty(summary) {
  const t = String(summary || '').trim()
  if (!t) return true
  if (t.length < 4) return true
  // 开头就"没查到/查不到/不知道/不晓得/无法"——当没查到
  if (/^(没查到|查不到|没有查到|查了一下没|未查到|无法|不能查|不知道|不晓得|不详)/.test(t)) return true
  // 通篇都在说"不知道/不晓得/查不到"，且没有任何数字或具体名词的影子
  const vague = (t.match(/不知道|不晓得|查不到|没查到|不确定|不清楚/g) || []).length
  if (vague >= 2 && !/\d/.test(t)) return true
  return false
}

/**
 * 把干活会话的输出压成"能直接说出口"的一两句话。
 *
 * 干活会话再怎么被要求简短，也可能吐出清单或链接。这里做的是**防御性
 * 收口**：去掉 Markdown 痕迹、去掉参考链接、砍到前几句话。
 */
export function condense(text, { maxChars = 220 } = {}) {
  let t = String(text || '').trim()
  if (!t) return ''
  // 去掉代码块和表格
  t = t.replace(/```[\s\S]*?```/g, ' ')
  t = t.replace(/^\s*\|.*\|\s*$/gm, ' ')
  // 去掉 Markdown 标题/加粗/列表符号
  t = t.replace(/^#{1,6}\s*/gm, '')
  t = t.replace(/\*\*(.+?)\*\*/g, '$1')
  t = t.replace(/^\s*[-*+]\s+/gm, '')
  t = t.replace(/^\s*\d+[.、)]\s+/gm, '')
  // 去掉裸链接（保留正文）
  t = t.replace(/https?:\/\/\S+/g, ' ')
  // 折叠空白
  t = t.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim()
  // 只留前几句（纯符号/纯标记行不算句子——它们会白占字数预算，把正文挤掉）
  // 只留前几句（纯符号/纯标记行不算句子——它们会白占字数预算，把正文挤掉）
  const lines = t.split('\n').map((s) => s.trim()).filter((s) => s && /[\p{L}\p{N}]/u.test(s))
  let out = ''
  for (const line of lines) {
    if ((out + line).length > maxChars && out) break
    out += line
    if (/[。！？!?]$/.test(line) && out.length > 40) break
  }
  if (!out) out = t
  return out.length > maxChars ? `${out.slice(0, maxChars)}…` : out
}

/** Promise.race 的超时包装，超时会中断等待（不中断底层任务） */
function withTimeout(promise, ms, makeError) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(makeError()), Math.max(1, ms))
    Promise.resolve(promise).then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}
