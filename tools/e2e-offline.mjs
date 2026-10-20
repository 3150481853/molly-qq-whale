/**
 * 离线端到端自测：不碰 QQ、不碰宿主，只用真实 ChatEngine + 假 OneBot 客户端。
 *
 * 目的：改完代码要重启宿主才能生效，而重启一次成本很高（要用户动手）。
 * 所以在重启前先用这条路把「收到消息 → 调 wbai → 生成回复 → 分段发」跑一遍，
 * 一次把能查的 bug 全查出来。
 *
 * 用法：
 *   node e2e-offline.mjs            默认私聊一句
 *   node e2e-offline.mjs group      群聊 @ 一句
 *   node e2e-offline.mjs multi      连发两条（测防抖合并/打断）
 */
import path from 'node:path'
import { ChatEngine } from 'file:///C:/Users/example/.dsh/profiles/desktop/node_modules/dsh-qq-whale/lib/engine.js'

const LIB = 'C:/Users/example/.dsh/profiles/desktop/node_modules/dsh-qq-whale/lib'
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

const mode = process.argv[2] || 'private'
const sent = []
const logs = []
const t0 = Date.now()

const logger = (level, msg) => {
  const line = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${level}: ${msg}`
  logs.push(line)
  console.log(line)
}

/** 假 OneBot 客户端：把所有出站消息按时间戳记下来 */
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
  async getGroupInfo() {
    return { group_name: '测试群' }
  },
  async fetchImageAsBase64() {
    throw new Error('offline: no image fetch')
  },
  async getLoginInfo() {
    return { user_id: Number(SELF_ID), nickname: 'Molly' }
  },
  async getStrangerInfo(userId) {
    return { user_id: Number(userId), nickname: '测试用户' }
  },
  async getGroupMemberInfo(groupId, userId) {
    return { user_id: Number(userId), nickname: 'Molly', card: 'Molly' }
  },
  async setGroupCard(groupId, userId, card) {
    sent.push({ at: Date.now(), kind: 'group-card', target: String(groupId), payload: card })
    return {}
  },
}

const config = {
  selfId: SELF_ID,
  modelBackend: 'wbai',
  provider: 'workbuddy-ai',
  model: 'deepseek-v4.1-flash',
  maxTokens: 400,
  temperature: 0.85,
  fallbackEnabled: false,
  allowedUsers: [OWNER],
  allowedGroups: ['666666666'],
  groupAutoReply: true,
  bystanderThreshold: 0.62,
  tapEmoji: false,
  enabled: true,
  blindMode: false,
  debounceMs: 300, // 自测缩短，别等 1.5 秒
  contextLimit: 40,
  thinkingBaseDelaySeconds: 0.2,
  typingCharactersPerSecond: 100, // 自测不真等打字
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
  return arr
    .map((s) => {
      if (typeof s === 'string') return s
      if (s.type === 'text') return s.data?.text ?? ''
      if (s.type === 'image') return `[图片 ${s.data?.file || s.data?.url || ''}]`
      if (s.type === 'face') return `[表情 ${s.data?.id}]`
      return `[${s.type}]`
    })
    .join('')
}

const engine = new ChatEngine({ ctx: null, logger, config, client: null, llm: null })
engine.client = client
engine.metrics = { onIncoming() {}, onReplied() {}, snapshot: () => null }

await engine.init()
logger('info', `模型后端 = ${engine.backend}，gateway = ${engine.gateway ? 'ok' : 'null'}`)

const health = await engine.gateway.health()
logger('info', `wbai health: ${JSON.stringify(health).slice(0, 200)}`)

if (mode === 'group') {
  await engine.onMessage(mkEvent('今天吃啥好呢', { group: true, at: true }))
} else if (mode === 'multi') {
  const p1 = engine.onMessage(mkEvent('在吗'))
  await new Promise((r) => setTimeout(r, 600))
  const p2 = engine.onMessage(mkEvent('我想问你个事'))
  await Promise.all([p1, p2])
} else {
  await engine.onMessage(mkEvent('你好呀，你是谁来着？'))
}

// 等所有延迟发送完成（planDelivery 是异步的，onMessage 返回时可能还没发完）
const deadline = Date.now() + 30000
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 200))
  const busy = sent.length > 0 && Date.now() - sent[sent.length - 1].at < 1500
  if (sent.length > 0 && !busy) break
  if (sent.length === 0 && Date.now() - t0 > 12000) break
}

console.log('\n=== 出站消息 ===')
if (sent.length === 0) {
  console.log('(一条都没发)')
} else {
  const base = sent[0].at
  for (const s of sent) {
    console.log(`+${((s.at - base) / 1000).toFixed(2)}s  ${s.kind}->${s.target}  ${JSON.stringify(render(s.payload))}`)
  }
}

console.log('\n=== 记忆/关系 ===')
console.log('memory entries:', engine.memory.entries.length)
try {
  engine.memory.save?.()
} catch {}

process.exit(sent.length > 0 ? 0 : 3)
