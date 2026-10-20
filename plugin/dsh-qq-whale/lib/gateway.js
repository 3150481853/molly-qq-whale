/**
 * WorkBuddy 多账号池网关（8788）客户端。
 *
 * 为什么单独一个后端：用户用 workbuddy2api-hub 起了个本地反向代理
 * （http://127.0.0.1:8788），里面攥着 5 个账号的 token 池，做「积分池 +
 * 模型池」抗限流。它暴露标准 OpenAI 兼容接口（/v1/chat/completions），
 * 由网关按「手动权重 → 临期积分 → 剩余用量 → 轮询」分层挑号。
 *
 * 跟 wbai.js 的 WorkBuddyGateway 区别：
 *   - wbai.js 直连 WorkBuddy 上游（copilot.tencent.com / workbuddy.ai），
 *     只有桌面 App 登录的那 2 个 flavor，全打满就哑。
 *   - 这里走本地网关，5 账号轮流扛，429 概率低得多。
 *
 * 接口刻意对齐 WorkBuddyGateway（chat / describeImage / health），
 * 这样 engine.js 的 callModel 不用改，只要把 this.gateway 换成这个类即可。
 */

const CHAT_URL = 'http://127.0.0.1:8788/v1/chat/completions'

/**
 * 模型 → 该请求应该走哪个 realm（网关的「区域出口」）。
 *
 * 为什么 Molly 要自己管这件事：网关有个 `detect_model_realm()`，按模型名
 * 猜出口，规则是「只在一侧存在的模型才强制指定，两边都能跑的回落全局开关」。
 * 实测（wb_proxy.py:176）：
 *
 *   - deepseek-v4-pro 在 cn_only 名单里 → 一律走 cn（国内积分池）
 *   - deepseek-v4.1-flash 两边都能跑 → 回落到 CURRENT_REALM（当前是 cn）
 *
 * 这就出问题了：用户 m15210 要的是「主脑先榨**国外版免费的** flash，
 * 限流了再用国内积分池的 v4pro」。而 flash 在 cn 侧是**收费模型**
 * （wb_accounts.py:271 注释原文：「国内版的 deepseek-v4.1-flash 是收费模型
 * （x0.11）」），FREE_CAP_MODELS["cn"] 里根本没有它。照默认走，Molly 每说
 * 一句话都在烧国内积分——正是最不该烧的那份。
 *
 * 所以这里显式钉死：flash 一律 X-Realm: intl（实测 credit=0，真免费），
 * v4-pro 一律 cn（它本来就只在 cn 有，钉一下更保险）。
 *
 * 不这么做的后果不是报错，而是「悄悄地花钱」——最难受的一类 bug。
 */
const MODEL_REALM = [
  // flash 系列：国际版免费，国内版收费 x0.11 → 必须走 intl
  [/^deepseek-v4\.1-flash/i, 'intl'],
  [/^deepseek-v4(\.1)?-flash/i, 'intl'],
  // v4-pro 只在 cn 有服务 → 显式钉死
  [/^deepseek-v4-pro/i, 'cn'],
]

function realmForModel(model) {
  const m = String(model || '')
  for (const [re, realm] of MODEL_REALM) {
    if (re.test(m)) return realm
  }
  return ''  // 空的头 = 让网关自己按 detect_model_realm 决定
}

export class WbProxyGateway {
  /**
   * @param {object} opts
   * @param {(level: string, msg: string) => void} opts.logger
   * @param {string} [opts.model] Molly 主脑模型。默认 deepseek-v4.1-flash ——
   *   用户 m15210 的定案是「主脑先榨**国外版免费的** flash」，见 realmForModel。
   * @param {string} [opts.baseUrl] 网关地址，默认 8788
   * @param {string} [opts.apiKey] 占位 Authorization，网关 api_key_required:false
   * @param {string} [opts.realm] 兜底 realm（模型名推不出来时才用）
   */
  constructor({ logger, model = 'deepseek-v4.1-flash', baseUrl = CHAT_URL, apiKey = 'wb-proxy-local', realm = '' } = {}) {
    this.logger = logger || (() => {})
    this.model = model
    this.baseUrl = baseUrl
    this.apiKey = apiKey
    this.realm = realm
    this.lastError = null
  }

  buildHeaders(realmOverride) {
    const h = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.apiKey}`,
    }
    /*
     * X-Realm 决定网关用哪一组账号接单。
     *
     * 优先级：调用方显式给 > 按模型名推断 > 不给（让网关自己决定）。
     * engine 在「主脑 flash」「降级 v4pro」「备用脑」这几个角色之间切换时
     * 会把 realm 一路传下来，所以这里必须能覆盖，不能写死成构造时那一个。
     */
    const realm = realmOverride !== undefined ? realmOverride : this.realm
    if (realm) h['X-Realm'] = realm
    return h
  }

  /**
   * 这个模型该走哪个 realm —— 供 engine 决定分层时的日志与预判。
   * 不传模型就用实例默认模型。
   */
  realmOf(model) {
    return realmForModel(model || this.model) || this.realm || ''
  }

  /**
   * 发一次对话请求，流式收集成整段文本。
   * 返回形状对齐 WorkBuddyGateway.chat：{ok, text, usage?, error?, code?}
   *
   * @param {object} p
   * @param {Array<{role:string, content:string|Array}>} p.messages
   * @param {string} [p.system]
   * @param {number} [p.maxTokens]
   * @param {number} [p.temperature]
   * @param {AbortSignal} [p.signal]
   * @param {(t:string)=>void} [p.onDelta]
   * @param {string} [p.model] 覆盖本次请求的模型（主脑/降级/备用脑各用各的）
   * @param {string} [p.realm] 覆盖本次请求的 realm
   */
  async chat({ messages, system, maxTokens = 1024, temperature = 0.85, signal, onDelta, model, realm }) {
    const msgs = []
    if (system) msgs.push({ role: 'system', content: system })
    for (const m of messages) msgs.push({ role: m.role, content: m.content })
    return this.request({ messages: msgs, maxTokens, temperature, signal, onDelta, model, realm })
  }

  /**
   * 看一眼图片，返回一句画面描述（给表情包学习器用）。
   * 与 WorkBuddyGateway.describeImage 同签名、同返回。
   */
  async describeImage(buffer, mime = 'image/png') {
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`
    const res = await this.request({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                '判断这张图能不能当聊天表情包用，能就给出中文描述。\n' +
                '规则：\n' +
                '1. 如果图里是界面、表格、文档、代码、图表、网页、账单、设置页等"截图类"内容，只输出「不适合」。\n' +
                '2. 如果图里是真人照片、证件、聊天记录、含辱骂性文字，只输出「不适合」。\n' +
                '3. 否则输出一行描述：用「_」连接 2~4 个中文词，写画面和情绪，例如：猫猫_无语_翻白眼。\n' +
                '只输出那一行，不要解释，不要出现人名、ID、账号。',
            },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      maxTokens: 120,
      temperature: 0.2,
    })
    if (!res.ok) throw new Error(res.error || res.code || '描述失败')
    return String(res.text || '').trim().split('\n')[0].trim()
  }

  /** 健康检查：探一下网关在不在，不发模型请求 */
  async health() {
    try {
      const resp = await fetch(this.baseUrl.replace(/\/chat\/completions$/, '/models'), {
        headers: this.buildHeaders(),
      })
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '')
        this.lastError = new Error(`网关不可用：HTTP ${resp.status} ${txt.slice(0, 200)}`)
        return { ok: false, error: this.lastError.message, code: `HTTP_${resp.status}` }
      }
      return { ok: true, baseUrl: this.baseUrl, model: this.model }
    } catch (e) {
      this.lastError = e
      return { ok: false, error: `网关连不上：${e.message}`, code: 'NETWORK' }
    }
  }

  /**
   * 底层请求。chat / describeImage 都走这里。
   * @private
   */
  async request({ messages, maxTokens = 1024, temperature = 0.85, signal, onDelta, model, realm }) {
    const useModel = model || this.model
    // 显式给的 realm 优先；没给就按模型名推（flash→intl / v4pro→cn）；都推不出来才放开
    const useRealm = realm !== undefined ? realm : (realmForModel(useModel) || this.realm || '')
    const body = {
      model: useModel,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: true,
      stream_options: { include_usage: true },
    }

    let resp
    try {
      resp = await fetch(this.baseUrl, {
        method: 'POST',
        headers: this.buildHeaders(useRealm),
        body: JSON.stringify(body),
        signal,
      })
    } catch (e) {
      if (e?.name === 'AbortError') return { ok: false, error: 'aborted', code: 'ABORTED' }
      this.lastError = e
      return { ok: false, error: `网关请求失败：${e.message}`, code: 'NETWORK' }
    }

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '')
      if (resp.status === 429) {
        return {
          ok: false,
          error: '网关账号池被限流（429）',
          code: 'RATE_LIMIT',
          retryAfter: Number(resp.headers.get('retry-after')) || null,
        }
      }
      return {
        ok: false,
        error: `HTTP ${resp.status} ${txt.slice(0, 300)}`,
        code: resp.status === 401 || resp.status === 403 ? 'AUTH' : `HTTP_${resp.status}`,
      }
    }

    const ctype = resp.headers.get('content-type') || ''
    // 非流式（网关一般不会，但兜一下）
    if (!ctype.includes('event-stream')) {
      try {
        const j = await resp.json()
        const text = j.choices?.[0]?.message?.content ?? j.choices?.[0]?.delta?.content ?? ''
        if (onDelta && text) onDelta(text)
        return { ok: true, text, usage: j.usage, finishReason: j.choices?.[0]?.finish_reason || '' }
      } catch (e) {
        return { ok: false, error: `响应解析失败：${e.message}`, code: 'PARSE' }
      }
    }

    let text = ''
    let buf = ''
    let usage = null
    /**
     * finish_reason 必须往外传。
     *
     * 教训（2026-10-17 记忆抽取）：reasoning 模型会先把 max_tokens 预算
     * 花在思维链上，正文一个字都没出来就 `finish_reason: "length"` 收尾。
     * 上游是 200、ok:true、text:'' —— 看起来像"模型说无事可记"，
     * 实际是被截断了。不把 finish_reason 传出去，这种静默失败查不出来。
     */
    let finishReason = ''
    const dec = new TextDecoder()
    try {
      for await (const chunk of resp.body) {
        buf += dec.decode(chunk, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data || data === '[DONE]') continue
          try {
            const j = JSON.parse(data)
            const delta = j.choices?.[0]?.delta?.content
            if (delta) {
              text += delta
              if (onDelta) onDelta(delta)
            }
            const fr = j.choices?.[0]?.finish_reason
            if (fr) finishReason = fr
            if (j.usage) usage = j.usage
          } catch {
            /* 分片跨包，忽略 */
          }
        }
      }
    } catch (e) {
      if (e?.name === 'AbortError') return { ok: false, error: 'aborted', code: 'ABORTED' }
      return { ok: false, error: `流读取失败：${e.message}`, code: 'STREAM' }
    }

    return { ok: true, text, usage, finishReason }
  }
}
