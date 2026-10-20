/**
 * 引擎离线联调脚本。
 *
 * 不启动 DSH，直接把 ChatEngine + OneBotClient 拉起来，用真实 QQ 消息验证全链路：
 *   连 NapCat → 收到消息 → 意愿判定 → 调 ctx.llm（打桩成真实 provider 不可用时走假模型）
 *   → 分段 → 延迟 → 发回 QQ
 *
 * 为什么要这层：DSH 里改插件要重启宿主，一次两分钟；这个脚本能秒级迭代，
 * 先把"协议能不能通""节奏对不对"调好，再接进宿主。
 */

import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// —— 假 llm：模仿 ctx.llm.stream() 的分片协议 ——
function makeFakeLlm(opts = {}) {
  const { replyText = '白饭呢？拿来。' } = opts
  return {
    stream(request) {
      const last = request.messages[request.messages.length - 1]
      const userText = typeof last.content === 'string'
        ? last.content
        : (last.content || []).map((c) => c.text || '').join('')
      console.log('[fake-llm] 收到请求 provider=%s model=%s msgs=%d', request.provider, request.model, request.messages.length)
      console.log('[fake-llm] 最后一句:', userText.slice(0, 80))
      const systemMsg = request.messages.find((m) => m.role === 'system')
      if (systemMsg) {
        const t = typeof systemMsg.content === 'string' ? systemMsg.content : systemMsg.content.map((c) => c.text || '').join('')
        console.log('[fake-llm] system prompt 长度:', t.length, '| 含"蓝色大肥鱼":', t.includes('蓝色大肥鱼'))
      }

      // 回一段带 <sep/> 的文本，验证分段
      const answer = replyText
      return (async function* gen() {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        // 逐字吐，模拟流式
        for (const ch of answer) {
          yield { type: 'text-delta', index: 0, text: ch }
        }
        yield { type: 'block-end', index: 0, block: { type: 'text', text: answer } }
        yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 20 } }
        yield { type: 'finish', reason: { kind: 'stop' } }
      })()
    },
    listProviders: () => [{ provider: 'fake' }],
  }
}

// —— 假 root：提供 logger / inject / effect / set ——
function makeFakeRoot() {
  return {
    logger: () => ({
      debug: () => {},
      info: (...a) => console.log('[info]', ...a),
      warn: (...a) => console.warn('[warn]', ...a),
      error: (...a) => console.error('[error]', ...a),
    }),
    inject: (deps, cb) => { cb({ llm: fakeLlmRef.current }); return () => {} },
    effect: (fn) => { fn(); return () => {} },
    set: () => {},
  }
}
const fakeLlmRef = { current: null }

// —— 主流程 ——
// Windows 上 ESM 动态 import 必须用 file:// URL，裸路径会被当成 d: 协议
const toUrl = (p) => new URL(`file:///${p.replace(/\\/g, '/')}`).href
const { OneBotClient } = await import(toUrl(path.join(ROOT, 'plugin/dsh-qq-whale/lib/onebot.js')))
const { ChatEngine } = await import(toUrl(path.join(ROOT, 'plugin/dsh-qq-whale/lib/engine.js')))

const TOKEN = process.env.ONEBOT_TOKEN || '${ONEBOT_TOKEN}'
const SELF = process.env.ONEBOT_SELF_ID || '111111111'
const TEST_USER = process.env.TEST_USER || '222222222'
const MODE = process.env.MODE || 'listen' // listen | send | fake

const config = {
  onebotUrl: 'ws://127.0.0.1:3001',
  onebotToken: TOKEN,
  selfId: SELF,
  modelBackend: process.env.BACKEND || 'wbai',
  provider: 'workbuddy-ai',
  model: 'deepseek-v4.1-flash',
  maxTokens: 512,
  temperature: 0.9,
  allowedUsers: [TEST_USER, SELF],
  allowedGroups: [],
  bystanderThreshold: 0.62,
  tapEmoji: false,
  debounceMs: 800,
  contextLimit: 40,
  typingBaseDelaySeconds: 0.4,
  typingCharactersPerSecond: 20,
  typingMaxDelaySeconds: 5,
  typingJitterRatio: 0.3,
  bubbleGapMinSeconds: 0.3,
  bubbleGapMaxSeconds: 0.8,
  reactionMinSeconds: 0.3,
  reactionMaxSeconds: 1,
  restWindows: [],
  proactiveEnabled: false,
  memoryLimit: 400,
  blindMode: false,
  logLevel: 'debug',
  personaDir: path.join(ROOT, 'plugin/dsh-qq-whale/persona'),
  stickerDir: path.join(ROOT, 'stickers'),
  memoryDir: path.join(ROOT, 'out/test-memory'),
}

const logger = (lv, msg) => {
  if (lv === 'debug' && process.env.VERBOSE !== '1') return
  console.log(`[${lv}]`, msg)
}

fakeLlmRef.current = makeFakeLlm({
  replyText: process.env.REPLY || '白饭呢<sep/>等了半小时了<sep/>你倒是说句话啊',
})

const engine = new ChatEngine({
  ctx: { llm: fakeLlmRef.current },
  llm: fakeLlmRef.current,
  logger,
  config,
  client: null,
})
await engine.init()
console.log('模型后端:', engine.backend, engine.gateway ? `(wbai/${config.model})` : `(${config.provider}/${config.model})`)

const client = new OneBotClient({
  url: config.onebotUrl,
  token: config.onebotToken,
  selfId: config.selfId,
  logger,
  onEvent: async (ev) => {
    console.log('[event]', ev.post_type, ev.message_type || '', 'from', ev.user_id, JSON.stringify(ev.message)?.slice(0, 160))
    if (ev.post_type === 'message' && String(ev.user_id) !== String(config.selfId)) {
      await engine.onMessage(ev)
    }
  },
  onStateChange: (s) => console.log('[state]', s),
})
engine.client = client

await client.start(15000)
console.log('=== 已连接，等待消息 ===')
console.log('用 QQ %s 给 %s 发一句话试试', TEST_USER, SELF)

if (MODE === 'send') {
  // 主动发一条，验证发送链路
  await new Promise((r) => setTimeout(r, 500))
  const msg = [{ type: 'text', data: { text: '（测试：联通性检查）' } }]
  const res = await client.sendPrivateMsg(TEST_USER, msg)
  console.log('[send result]', JSON.stringify(res))
}

// 跑 120 秒或者直到 Ctrl+C
setTimeout(() => {
  console.log('=== 超时退出 ===')
  client.stop()
  process.exit(0)
}, 120000)
