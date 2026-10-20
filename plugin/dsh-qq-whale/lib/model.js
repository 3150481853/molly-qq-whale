/**
 * 模型调用封装。
 *
 * 不自己拼 HTTP 请求，而是走 DSH 的 `ctx.llm.stream()`——
 * 这样 QQ 里说话的"她"和 DSH 里干活的"她"用的是同一个 provider、
 * 同一个模型、同一份免费额度（workbuddy-ai / deepseek-v4.1-flash）。
 *
 * 为什么这很重要：用户明确要求「复用 wbai 的免费模型」。自己实现一套
 * wbai 网关意味着要复刻加密凭据解密、token 刷新、十几个必需请求头，
 * 而且 WorkBuddy 一升级就全废。走 ctx.llm 是唯一不会腐烂的路径。
 */

/** 把 DSH 的流式分片收成完整文本 */
export async function collectStream(stream, { onDelta } = {}) {
  let text = ''
  let reasoning = ''
  let finish = null
  let usage = null
  const toolCalls = []

  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'text-delta':
        text += chunk.text
        if (onDelta) onDelta(chunk.text)
        break
      case 'reasoning-delta':
        reasoning += chunk.text
        break
      case 'tool-call-delta':
        // QQ 场景不用工具，但记录下来便于排查
        toolCalls.push(chunk)
        break
      case 'usage':
        usage = chunk.usage
        break
      case 'finish':
        finish = chunk.reason
        break
      default:
        break
    }
  }

  return { text, reasoning, finish, usage, toolCalls }
}

/** 判断这次调用是否真的拿到了内容 */
export function isOk({ text, finish }) {
  if (finish && finish.kind !== 'stop') {
    // 有些适配器把正常结束报成 finish.kind='stop'，其余都算失败
    if (finish.kind === 'error') return false
    if (finish.kind === 'aborted') return false
  }
  return String(text || '').trim().length > 0
}

export function failureText({ finish }) {
  if (!finish) return '没有收到结束信号'
  if (finish.kind === 'error') {
    const f = finish.failure || {}
    return `模型调用失败: ${f.code || 'UNKNOWN'} ${f.message || ''}`.trim()
  }
  if (finish.kind === 'aborted') return '模型调用被取消'
  return `非正常结束: ${finish.kind}`
}

/**
 * QQ 对话用的模型调用器。
 *
 * 设计取舍：
 *   - 不用 ctx.llm 的高层封装（agent loop），因为 QQ 场景不需要工具调用、
 *     不需要持久会话、也不需要 persona 之外的 system prompt 注入顺序。
 *   - 直接 stream() + 自己拼 messages，最可控。
 *   - 失败不抛，返回 {ok:false, error}，让上层决定是重试还是沉默。
 */
export class ModelCaller {
  constructor({ ctx, logger, provider, model, maxTokens = 1024, temperature, reasoningEffort }) {
    this.ctx = ctx
    this.logger = logger || (() => {})
    this.provider = provider
    this.model = model
    this.maxTokens = maxTokens
    this.temperature = temperature
    this.reasoningEffort = reasoningEffort
  }

  get available() {
    return Boolean(this.ctx?.llm)
  }

  /** 有哪些 provider 可用（调试用） */
  listProviders() {
    try {
      return this.ctx?.llm?.listProviders?.() ?? []
    } catch {
      return []
    }
  }

  /**
   * 发一次对话请求。
   *
   * messages 是 [{role:'user'|'assistant', content:[{type:'text',text}]}]，
   * system 单独传，因为 DSH 的 session 级 system prompt 和这里的临时人设
   * 是两套东西，不能混在 messages 里（会被某些适配器当对话历史）。
   */
  async chat({ system, messages, signal, maxTokens, temperature, model }) {
    if (!this.available) return { ok: false, error: 'ctx.llm 不可用（DSH 未挂载 llm 服务）' }

    const opts = {
      provider: this.provider,
      model: model || this.model,
      messages: messages.map((m) => ({
        role: m.role,
        content: typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content,
      })),
      maxTokens: maxTokens ?? this.maxTokens,
    }
    if (system) {
      // 持久 Message 形状要求有 id/source；这里用"仅请求"的 system 字段
      // 走 messages 最前面的 system 消息，兼容性最好
      opts.messages = [{ role: 'system', content: [{ type: 'text', text: system }] }, ...opts.messages]
    }
    const temp = temperature ?? this.temperature
    if (typeof temp === 'number') opts.temperature = temp
    if (this.reasoningEffort) opts.reasoningEffort = this.reasoningEffort
    if (signal) opts.signal = signal

    try {
      const result = await collectStream(this.ctx.llm.stream(opts))
      if (!isOk(result)) {
        return { ok: false, error: failureText(result), raw: result }
      }
      return { ok: true, text: result.text.trim(), usage: result.usage, finish: result.finish }
    } catch (err) {
      return { ok: false, error: err?.message || String(err) }
    }
  }

  /**
   * 轻量探活：发一个极短的请求，只为确认「这个模型现在还能不能用」。
   *
   * 为什么要单独一个方法而不是直接复用 chat()：
   *   - chat() 用的是接盘那套参数（maxTokens 512 + xhigh 推理），
   *     xhigh 会让它先憋一大段思维链，探活要等十几秒，白白烧用量。
   *   - 探活只关心「通不通」，不关心「答得好不好」，所以 maxTokens 压到 16、
   *     不给 temperature、不指定 reasoningEffort，让适配器走最快的那条路。
   *
   * 用户 m15166 选的就是「只要健康检查」——定期确认备用脑活着，
   * 而不是把对话同步过去。所以这里刻意不碰上下文，保持无副作用。
   *
   * @returns {Promise<{ok:boolean, error?:string, ms:number}>}
   */
  async probe({ signal } = {}) {
    const started = Date.now()
    if (!this.available) {
      return { ok: false, error: 'ctx.llm 不可用', ms: 0 }
    }
    const opts = {
      provider: this.provider,
      model: this.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: '在吗' }] }],
      maxTokens: 16,
    }
    if (signal) opts.signal = signal
    try {
      const result = await collectStream(this.ctx.llm.stream(opts))
      const ms = Date.now() - started
      if (!isOk(result)) return { ok: false, error: failureText(result), ms }
      return { ok: true, ms }
    } catch (err) {
      return { ok: false, error: err?.message || String(err), ms: Date.now() - started }
    }
  }
}
