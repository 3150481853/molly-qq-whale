/**
 * 离线端到端自测（wb-proxy 后端版）：假网关 + 真 ChatEngine。
 *
 * 目的：验证「Molly 切到 8788 网关」这条路，不碰真网关、不碰 QQ、不碰宿主。
 * 用一个本地假 HTTP 服务器冒充网关，返回和真网关一模一样的 SSE 帧，
 * 然后跑真实的 ChatEngine，看：
 *   ① 请求体形状对不对（model / stream / stream_options.include_usage）
 *   ② 流式 delta 能不能正确拼成一条回复
 *   ③ usage.credit 有没有进预算
 *   ④ 网关 429 时能不能回退 wbai 直连（tryFallbackToWbai）
 *
 * 用法：
 *   node e2e-wbproxy.mjs            正常链路（假网关回话）
 *   node e2e-wbproxy.mjs ratelimit  假网关一律 429（测回退分支，wbai 会真连上游）
 *   node e2e-wbproxy.mjs group      群聊 @
 */
import http from 'node:http'
import path from 'node:path'
import { ChatEngine } from 'file:///C:/Users/example/.dsh/profiles/desktop/node_modules/dsh-qq-whale/lib/engine.js'

const PACKAGE_ROOT = 'C:/Users/example/.dsh/profiles/desktop/node_modules/dsh-qq-whale'
const STICKER_DIR = '${MOLLY_ROOT}/qq-whale/stickers'
// 离线 e2e 必须用**独立的临时目录**，不能指向生产数据目录。
// 教训（2026-10-17）：早先这里写死 'C:/Users/example/.dsh/qq-whale'，
// 而真实数据在 .../qq-whale/memory —— 结果每跑一次 e2e，测试条目
// （"测试用户""他今天加班到十点"）就被写进生产根目录，跟真记忆混在一起，
// 排查"为什么记住了假的人"要花很久。见 _污染备份-* 目录。
const MEMORY_DIR = 'C:/Users/example/.dsh/qq-whale/out/e2e-data'
const SELF_ID = '111111111'
const OWNER = '222222222'

const mode = process.argv[2] || 'normal'
const RATE_LIMIT_MODE = mode === 'ratelimit'
const GROUP_MODE = mode === 'group'

const sent = []
const logs = []
const t0 = Date.now()
const seenRequests = []

const logger = (level, msg) => {
  const line = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${level}: ${msg}`
  logs.push(line)
  console.log(line)
}

// ── 假网关：模仿 8788 的真实帧形状 ────────────────────────────────
const REPLIES = ['就……一条大肥鱼啊', '你忘啦？我天天在你群里蹭白饭的', 'token来！🖐😡🤚']
function startFakeGateway(port = 0) {
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      let parsed = null
      try { parsed = JSON.parse(body) } catch { /* 忽略 */ }
      seenRequests.push({ url: req.url, method: req.method, headers: req.headers, body: parsed })

      if (req.url.includes('/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-v4-pro' }] }))
        return
      }

      if (RATE_LIMIT_MODE) {
        res.writeHead(429, { 'Content-Type': 'application/json', 'retry-after': '5' })
        res.end(JSON.stringify({ error: { message: 'pool exhausted' } }))
        return
      }

      // 流式 SSE：正文帧 → 结束帧 → usage 帧（与真网关一致）
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const reply = REPLIES[Math.floor(Math.random() * REPLIES.length)]
      const chunks = reply.match(/.{1,4}/gu) || [reply]
      let i = 0
      const tick = setInterval(() => {
        if (i < chunks.length) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] })}\n\n`)
          return
        }
        clearInterval(tick)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`)
        // usage 独立帧（choices: []），真网关就是这样
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 18, total_tokens: 138, credit: 0.03 } })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      }, 8)
    })
  })
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
  })
}

// ── 假 OneBot 客户端 ─────────────────────────────────────────────
const client = {
  state: 'online',
  async sendPrivateMsg(userId, payload) {
    sent.push({ at: Date.now(), kind: 'private', target: String(userId), payload })
    return { message_id: 1000 + sent.length }
  },
  async sendGroupMsg(groupId, payload) {
    sent.push({ at: Date.now(), kind: 'group', target: String(groupId), payload })
    return { message_id: 1000 + sent.length }
  },
  async setMsgEmojiLike() {},
  async getGroupInfo() { return { group_name: '测试群' } },
  async fetchImageAsBase64() { throw new Error('offline: no image fetch') },
  async getLoginInfo() { return { user_id: Number(SELF_ID), nickname: 'Molly' } },
  async getStrangerInfo(userId) { return { user_id: Number(userId), nickname: '测试用户' } },
  async getGroupMemberInfo() { return { user_id: Number(SELF_ID), nickname: 'Molly', card: 'Molly' } },
  async setGroupCard(groupId, userId, card) {
    sent.push({ at: Date.now(), kind: 'group-card', target: String(groupId), payload: card })
    return {}
  },
}

const { server, port } = await startFakeGateway()
logger('info', `假网关跑在 127.0.0.1:${port}`)

const config = {
  selfId: SELF_ID,
  modelBackend: 'wb-proxy',
  provider: 'workbuddy-ai',
  model: 'deepseek-v4-pro',
  maxTokens: 400,
  temperature: 0.85,
  gatewayBaseUrl: `http://127.0.0.1:${port}/v1/chat/completions`,
  gatewayApiKey: 'wb-proxy-local',
  gatewayToWbaiFallback: true,
  fallbackEnabled: false,
  allowedUsers: [OWNER],
  allowedGroups: ['666666666'],
  groupAutoReply: true,
  bystanderThreshold: 0.62,
  tapEmoji: false,
  enabled: true,
  blindMode: false,
  debounceMs: 300,
  contextLimit: 40,
  thinkingBaseDelaySeconds: 0.2,
  typingCharactersPerSecond: 100,
  typingMaxDelaySeconds: 0.3,
  typingJitterRatio: 0,
  bubbleGapMinSeconds: 0.1,
  bubbleGapMaxSeconds: 0.2,
  reactionMinSeconds: 0,
  reactionMaxSeconds: 0.1,
  restWindows: [],
  commandEnabled: false,
  proactiveEnabled: false,
  progressEnabled: false,
  memoryLimit: 400,
  creditLimitEnabled: false,
  personaDir: path.join(PACKAGE_ROOT, 'persona'),
  stickerDir: STICKER_DIR,
  memoryDir: MEMORY_DIR,
  stickerLearn: false,
}

function mkEvent(text, { group = false, at = false } = {}) {
  const message = []
  if (at) message.push({ type: 'at', data: { qq: SELF_ID } })
  message.push({ type: 'text', data: { text } })
  const base = {
    post_type: 'message',
    self_id: Number(SELF_ID),
    user_id: Number(OWNER),
    message_id: Math.floor(Math.random() * 1e6),
    message,
    raw_message: (at ? `[CQ:at,qq=${SELF_ID}] ` : '') + text,
    sender: { user_id: Number(OWNER), nickname: '测试用户', card: '' },
    time: Math.floor(Date.now() / 1000),
  }
  if (group) return { ...base, message_type: 'group', group_id: 666666666 }
  return { ...base, message_type: 'private', sub_type: 'friend' }
}

function render(payload) {
  const segs = payload?.message ?? payload ?? []
  const arr = Array.isArray(segs) ? segs : [segs]
  return arr.map((s) => {
    if (typeof s === 'string') return s
    if (s.type === 'text') return s.data?.text ?? ''
    if (s.type === 'image') return `[图片 ${s.data?.file || s.data?.url || ''}]`
    if (s.type === 'face') return `[表情 ${s.data?.id}]`
    return `[${s.type}]`
  }).join('')
}

const engine = new ChatEngine({ ctx: null, logger, config, client: null, llm: null })
engine.client = client
engine.metrics = { onIncoming() {}, onReplied() {}, snapshot: () => null }

await engine.init()
logger('info', `后端 = ${engine.backend}；主 gateway = ${engine.gateway?.constructor?.name}；回退 wbai = ${engine.wbai?.constructor?.name}`)

// ── 断言 1：back-end 装配正确 ──────────────────────────────────
const assert = []
const check = (name, cond, detail = '') => {
  assert.push({ name, ok: !!cond, detail })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —  ' + detail : ''}`)
}
check('backend 是 wb-proxy', engine.backend === 'wb-proxy')
check('主 gateway 是 WbProxyGateway', engine.gateway?.constructor?.name === 'WbProxyGateway')
check('保留 wbai 直连作为回退', engine.wbai?.constructor?.name === 'WorkBuddyGateway')
check('stickerLearn 关着时 learner 为 null', engine.learner === null)

// ── 触发一轮对话 ─────────────────────────────────────────────
if (GROUP_MODE) {
  await engine.onMessage(mkEvent('今天吃啥好呢', { group: true, at: true }))
} else {
  await engine.onMessage(mkEvent('你好呀，你是谁来着？'))
}

const deadline = Date.now() + 30000
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 200))
  const busy = sent.length > 0 && Date.now() - sent[sent.length - 1].at < 1500
  if (sent.length > 0 && !busy) break
  if (sent.length === 0 && Date.now() - t0 > 15000) break
}

console.log('\n=== 出站消息 ===')
if (sent.length === 0) console.log('(一条都没发)')
else {
  const base = sent[0].at
  for (const s of sent) {
    console.log(`+${((s.at - base) / 1000).toFixed(2)}s  ${s.kind}->${s.target}  ${JSON.stringify(render(s.payload))}`)
  }
}

console.log('\n=== 网关收到的请求 ===')
for (const r of seenRequests) {
  console.log(`${r.method} ${r.url}`)
  if (r.body) {
    console.log(`  model=${r.body.model} stream=${r.body.stream} include_usage=${JSON.stringify(r.body.stream_options)}`)
    console.log(`  messages=${r.body.messages?.length} max_tokens=${r.body.max_tokens}`)
  }
}

// ── 断言 2：请求形状 ─────────────────────────────────────────
const chatReqs = seenRequests.filter((r) => r.url.includes('chat/completions'))
if (!RATE_LIMIT_MODE) {
  check('网关收到了 chat/completions 请求', chatReqs.length > 0)
  const b = chatReqs[0]?.body
  check('请求带 model', !!b?.model, b?.model)
  check('请求是流式', b?.stream === true)
  check('请求要 usage 帧', b?.stream_options?.include_usage === true)
  check('system prompt 已注入', b?.messages?.[0]?.role === 'system')
  check('有正文回复发出', sent.some((s) => s.kind === 'private' || s.kind === 'group'))
  const budget = engine.budget.snapshot()
  check('usage.credit 进了预算', budget.used >= 0.03, `used=${budget.used}`)
} else {
  check('网关确实回了 429（限流模式）', chatReqs.length > 0)
  console.log('\n注意：限流模式下会真的去连 wbai 直连上游，日志里看「回退 wbai 直连」这一行。')
}

console.log('\n=== 记忆 ===')
console.log('memory entries:', engine.memory.entries.length)

server.close()
const failed = assert.filter((a) => !a.ok)
console.log(`\n=== 结果：${assert.length - failed.length}/${assert.length} 通过 ===`)
if (failed.length) {
  console.log('失败的：')
  for (const f of failed) console.log(`  - ${f.name} ${f.detail}`)
}
process.exit(failed.length === 0 ? 0 : 4)
