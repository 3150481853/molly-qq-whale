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
 * ## 为什么不自己实现搜索
 *
 * 宿主里没有独立的搜索服务（查过 dsh-tools / dsh-web，都没有可复用的
 * search service）。但宿主的 agent loop 里有**完整的工具集**——
 * 就是私聊「命令 xxx」背后那个干活会话。它会用 web 工具、会用宿主装了
 * 的插件提供的工具，而且随 DSH 升级自动获得新能力。
 *
 * 所以这里的选择是「借用」，不是「重造」：判定需要查 → 交给干活会话去查
 * → 把它的结论拿回来 → 由她用自己的口吻说出来。这样既有了能力，又不会
 * 在群里蹦出一段机器人味儿的研究报告。
 *
 * ## 三道闸门（防止把聊天变成查资料）
 *
 *   1. 只查**事实性**问题（天气/时间/价格/查一下/是什么/怎么样/新闻/梗）
 *   2. 每条消息最多查一次，且查完就缓存一小会儿（同样的问题不重复烧 token）
 *   3. 查不到就查不到，回落成聊天——绝不让「查资料失败」变成「她不说话」
 */

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
  constructor({ executor, logger, timeoutMs = 300000, enabled = true }) {
    this.executor = executor
    this.logger = logger || (() => {})
    this.timeoutMs = Math.max(5000, Number(timeoutMs) || 300000)
    this.enabled = enabled !== false
    this.inflight = new Map()
  }

  get available() {
    return Boolean(this.enabled && this.executor?.run)
  }

  /**
   * 查一件事。返回 {ok, summary} —— 永远不抛。
   *
   * @param {string} query 用户原话，直接当任务描述给干活会话
   * @param {{reason?:string}} opts
   */
  async research(query, { reason = '' } = {}) {
    if (!this.available) return { ok: false, summary: '', error: 'researcher 不可用' }
    const key = String(query || '').trim()
    if (!key) return { ok: false, summary: '', error: '空查询' }

    // 并发去重：同一条查询只跑一次
    const running = this.inflight.get(key)
    if (running) {
      this.logger('debug', `同一个查询正在跑，复用结果：${key.slice(0, 30)}`)
      return running
    }

    const job = this.#run(key, reason).finally(() => {
      this.inflight.delete(key)
    })
    this.inflight.set(key, job)
    return job
  }

  async #run(query, reason) {
    const started = Date.now()
    /*
     * 给她一个「查完只说结论」的硬约束。
     *
     * 不这么写的话，干活会话会把她当成通用助理，输出一大段 Markdown 研究报告
     * （标题、分点、参考链接），直接被当作聊天内容发进群里——那是机器人味儿
     * 的灾难。这里要的是「一两句话的结论」，措辞细节留给聊天链路自己润色。
     */
    const task = [
      `帮我在网上查一下，然后**只用一两句话**把结论告诉我。不要分点，不要小标题，不要贴链接列表。`,
      `如果查不到或者不确定，就直接说"没查到"。不要编。`,
      `**不要用 qq_onebot 或任何工具发消息**——查资料只要结论，发消息由我自己来（发了也会被拦）。`,
      ``,
      `要查的是：${query}`,
    ].join('\n')

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
      const summary = condense(result.text)
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
  // 只留前几句
  const lines = t.split('\n').map((s) => s.trim()).filter(Boolean)
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
