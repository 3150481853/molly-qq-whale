/**
 * 记忆链路专测。
 *
 * 验三件事：
 *   ① 规则层：说「我叫X」立刻入库（零成本路径）
 *   ② 模型层：连续说几句日常处境，攒够 4 句后模型自己抽出事实
 *   ③ 持久化：重新 new 一个 MemoryStore，记忆还在（这是"别聊着聊着就忘了我"的底线）
 */
import fs from 'node:fs'
import path from 'node:path'
import { ChatEngine } from 'file:///C:/Users/example/.dsh/profiles/desktop/node_modules/dsh-qq-whale/lib/engine.js'
import { MemoryStore } from 'file:///C:/Users/example/.dsh/profiles/desktop/node_modules/dsh-qq-whale/lib/memory.js'

const PACKAGE_ROOT = 'C:/Users/example/.dsh/profiles/desktop/node_modules/dsh-qq-whale'
const STICKER_DIR = '${MOLLY_ROOT}/qq-whale/stickers'
// 事故（2026-10-18 16:05）：这里原本写死 'C:/Users/example/.dsh/qq-whale'（生产数据根）。
// 本文件开头会 rmSync 掉 memory.json / memory.md / relations.json —— 生产记忆一旦放在根目录
// 就会被这个"测试"清空；实测已经把 5 条假的「测试用户」记忆写进了生产目录。
// 现在强制隔离到 out/ 下，并在运行前断言，防止再次误伤。
const MEMORY_DIR = 'C:/Users/example/.dsh/qq-whale/out/test-memory-data'
if (!/[\\/]out[\\/]/i.test(MEMORY_DIR)) {
  throw new Error(`拒绝运行：MEMORY_DIR 必须指向 out/ 下的隔离目录，当前为 ${MEMORY_DIR}`)
}
fs.mkdirSync(MEMORY_DIR, { recursive: true })
const SELF_ID = '111111111'
const OWNER = '222222222'

const logs = []
const t0 = Date.now()
const logger = (level, msg) => {
  const line = `[${((Date.now() - t0) / 1000).toFixed(1)}s] ${level}: ${msg}`
  logs.push(line)
  if (level !== 'debug') console.log(line)
}

const client = {
  state: 'online',
  async sendPrivateMsg() { return { message_id: 1 } },
  async sendGroupMsg() { return { message_id: 1 } },
  async setMsgEmojiLike() {},
  async getGroupInfo() { return { group_name: '测试群' } },
  async fetchImageAsBase64() { throw new Error('offline') },
  async getLoginInfo() { return { user_id: Number(SELF_ID), nickname: 'Molly' } },
  async getStrangerInfo() { return { nickname: '测试用户' } },
}

const config = {
  selfId: SELF_ID, modelBackend: 'wbai', provider: 'workbuddy-ai',
  model: 'deepseek-v4.1-flash', maxTokens: 500, temperature: 0.85,
  fallbackEnabled: false, allowedUsers: [OWNER], allowedGroups: ['666666666'],
  groupAutoReply: true, bystanderThreshold: 0.62, tapEmoji: false,
  enabled: true, blindMode: false, debounceMs: 100, contextLimit: 40,
  thinkingBaseDelaySeconds: 0, typingCharactersPerSecond: 1000,
  typingMaxDelaySeconds: 0, typingJitterRatio: 0,
  bubbleGapMinSeconds: 0, bubbleGapMaxSeconds: 0.05,
  reactionMinSeconds: 0, reactionMaxSeconds: 0.05, restWindows: [],
  commandEnabled: false, proactiveEnabled: false, progressEnabled: false,
  memoryLimit: 400,
  // 自测把节流门槛降到 3 句 / 0 分钟，否则要等 20 分钟
  memoryExtract: true, memoryExtractMinLines: 3, memoryExtractMinGapMinutes: 0,
  personaDir: path.join(PACKAGE_ROOT, 'persona'),
  stickerDir: STICKER_DIR, memoryDir: MEMORY_DIR, stickerLearn: false,
}

function mkEvent(text, messageId) {
  return {
    post_type: 'message', self_id: Number(SELF_ID), user_id: Number(OWNER),
    message_id: messageId, message: [{ type: 'text', data: { text } }],
    raw_message: text,
    sender: { user_id: Number(OWNER), nickname: '测试用户', card: '' },
    message_type: 'private', sub_type: 'friend',
    time: Math.floor(Date.now() / 1000),
  }
}

// 用干净的库开始，避免历史数据干扰判断
try {
  fs.rmSync(path.join(MEMORY_DIR, 'memory.json'), { force: true })
  fs.rmSync(path.join(MEMORY_DIR, 'memory.md'), { force: true })
} catch {}
try {
  fs.rmSync(path.join(MEMORY_DIR, 'relations.json'), { force: true })
} catch {}

const engine = new ChatEngine({ ctx: null, logger, config, client: null, llm: null })
engine.client = client
await engine.init()

console.log('\n=== ① 规则层：自我介绍 ===')
await engine.maybeLearn(mkEvent('我叫林岸，在杭州做游戏策划', 1), { text: '我叫林岸，在杭州做游戏策划', images: [], isAtMe: false }, '测试用户')
await new Promise((r) => setTimeout(r, 300))
console.log('当前记忆：')
for (const e of engine.memory.entries) console.log(`  [${e.kind}/w${e.weight}] ${e.text}`)

console.log('\n=== ② 模型层：日常处境（攒 3 句触发）===')
const lines = [
  '今天加班到十点，累死了',
  '领导又临时改需求，改第八遍了',
  '周末本来想去爬山的，估计要泡汤',
  '不过我家那只猫倒是挺开心的，一直在我键盘上趴着',
]
for (let i = 0; i < lines.length; i++) {
  const ev = mkEvent(lines[i], 100 + i)
  await engine.maybeLearn(ev, { text: lines[i], images: [], isAtMe: false }, '测试用户')
  await new Promise((r) => setTimeout(r, 200))
}
// 模型抽取是异步的，等它落地
await new Promise((r) => setTimeout(r, 6000))

console.log('\n最终记忆：')
for (const e of engine.memory.entries) console.log(`  [${e.kind}/w${e.weight}] ${e.text}`)

console.log('\n=== ③ 持久化：重新加载 ===')
const reloaded = new MemoryStore({ dir: MEMORY_DIR, logger })
console.log(`重新加载后：${reloaded.entries.length} 条`)
for (const e of reloaded.entries) console.log(`  [${e.kind}/w${e.weight}] ${e.text}`)

console.log('\n=== ④ 召回测试 ===')
for (const q of ['猫', '加班', '我喜欢什么', '林岸是谁']) {
  const hits = reloaded.recall({ query: q, limit: 4 })
  console.log(`  查「${q}」→ ${hits.length ? hits.map((h) => h.text).join(' | ') : '(无)'}`)
}

const md = path.join(MEMORY_DIR, 'memory.md')
if (fs.existsSync(md)) {
  console.log('\n=== memory.md ===')
  console.log(fs.readFileSync(md, 'utf8').slice(0, 800))
}

process.exit(reloaded.entries.length > 0 ? 0 : 3)
