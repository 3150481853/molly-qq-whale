/**
 * 专门验一件事：抽取 async 期间新进来的消息，不能被 `buf.lines = []` 抹掉。
 *
 * 场景复现：
 *   1. 连发 3 句 → 触发抽取（minLines=3）
 *   2. 抽取等模型的这 2 秒里，再塞进第 4 句「我家养了只猫」
 *   3. 抽取完成后，检查缓冲区里第 4 句还在不在
 *   4. 再补 2 句凑够 3 条，触发第二次抽取，确认「猫」最终进了记忆库
 */
import fs from 'node:fs'
import path from 'node:path'
import { ChatEngine } from 'file:///C:/Users/example/.dsh/profiles/desktop/node_modules/dsh-qq-whale/lib/engine.js'
import { MemoryStore } from 'file:///C:/Users/example/.dsh/profiles/desktop/node_modules/dsh-qq-whale/lib/memory.js'

const PACKAGE_ROOT = 'C:/Users/example/.dsh/profiles/desktop/node_modules/dsh-qq-whale'
// 事故（2026-10-18 16:05）：同 test-memory.mjs —— 原本写死生产数据根，
// 开头 rmSync 掉 memory.json/relations.json，把假记忆写进了生产。强制隔离到 out/ 下。
const MEMORY_DIR = 'C:/Users/example/.dsh/qq-whale/out/test-memory-data-race'
if (!/[\\/]out[\\/]/i.test(MEMORY_DIR)) {
  throw new Error(`拒绝运行：MEMORY_DIR 必须指向 out/ 下的隔离目录，当前为 ${MEMORY_DIR}`)
}
fs.mkdirSync(MEMORY_DIR, { recursive: true })
const SELF_ID = '111111111'
const OWNER = '222222222'

const logger = (level, msg) => {
  if (level !== 'debug') console.log(`${level}: ${msg}`)
}

const client = {
  state: 'online',
  async sendPrivateMsg() { return { message_id: 1 } },
  async sendGroupMsg() { return { message_id: 1 } },
  async getStrangerInfo() { return { nickname: '测试用户' } },
}

const config = {
  selfId: SELF_ID, modelBackend: 'wbai', provider: 'workbuddy-ai',
  model: 'deepseek-v4.1-flash', maxTokens: 500, temperature: 0.85,
  fallbackEnabled: false, allowedUsers: [OWNER], allowedGroups: [],
  enabled: true, blindMode: false, debounceMs: 100, contextLimit: 40,
  commandEnabled: false, proactiveEnabled: false, progressEnabled: false,
  memoryLimit: 400, stickerLearn: false, tapEmoji: false,
  memoryExtract: true, memoryExtractMinLines: 3, memoryExtractMinGapMinutes: 0,
  personaDir: path.join(PACKAGE_ROOT, 'persona'),
  stickerDir: '${MOLLY_ROOT}/qq-whale/stickers',
  memoryDir: MEMORY_DIR,
}

function mkEvent(text, id) {
  return {
    post_type: 'message', self_id: Number(SELF_ID), user_id: Number(OWNER),
    message_id: id, message: [{ type: 'text', data: { text } }],
    raw_message: text,
    sender: { user_id: Number(OWNER), nickname: '测试用户', card: '' },
    message_type: 'private', sub_type: 'friend',
    time: Math.floor(Date.now() / 1000),
  }
}

for (const f of ['memory.json', 'memory.md', 'relations.json']) {
  try { fs.rmSync(path.join(MEMORY_DIR, f), { force: true }) } catch {}
}

const engine = new ChatEngine({ ctx: null, logger, config, client: null, llm: null })
engine.client = client
await engine.init()

const bufKey = `private:${OWNER}`
const showBuf = (tag) => {
  const b = engine._learnBuf?.get(bufKey)
  console.log(`  ${tag} 缓冲区 ${b ? b.lines.length : 0} 句：${b ? JSON.stringify(b.lines) : '[]'}`)
}

console.log('\n=== ① 连发 3 句，触发抽取（不 await，让它跑起来）===')
const first = ['今天加班到十点，累死了', '领导又临时改需求，改第八遍了', '周末本来想去爬山的，估计要泡汤']
const pending = []
for (let i = 0; i < first.length; i++) {
  pending.push(engine.maybeLearn(mkEvent(first[i], 10 + i), { text: first[i], images: [], isAtMe: false }, '测试用户'))
}
await Promise.all(pending)
showBuf('抽取刚触发后')

console.log('\n=== ② 抽取进行中，塞进第 4 句「猫」===')
const catLine = '不过我家那只猫倒是挺开心的，一直在我键盘上趴着'
const p2 = engine.maybeLearn(mkEvent(catLine, 20), { text: catLine, images: [], isAtMe: false }, '测试用户')
await p2
showBuf('第 4 句进来后')

// 等第一次抽取彻底落地
await new Promise((r) => setTimeout(r, 8000))
showBuf('第一次抽取落地后')
console.log('  记忆里现在有：')
for (const e of engine.memory.entries) console.log(`    [${e.kind}] ${e.text}`)

console.log('\n=== ③ 再补 2 句凑够 3 条，触发第二次抽取 ===')
const more = ['它叫团子，快三岁了', '我一般晚上九点才吃饭']
for (let i = 0; i < more.length; i++) {
  await engine.maybeLearn(mkEvent(more[i], 30 + i), { text: more[i], images: [], isAtMe: false }, '测试用户')
}
await new Promise((r) => setTimeout(r, 8000))

console.log('\n=== ④ 最终记忆 ===')
const reloaded = new MemoryStore({ dir: MEMORY_DIR, logger })
for (const e of reloaded.entries) console.log(`  [${e.kind}/w${e.weight}] ${e.text}`)

console.log('\n=== ⑤ 关键召回 ===')
for (const q of ['猫', '团子', '加班']) {
  const hits = reloaded.recall({ query: q, limit: 4 })
  console.log(`  查「${q}」→ ${hits.length ? hits.map((h) => h.text).join(' | ') : '(无)'}`)
}

const catOk = reloaded.recall({ query: '猫', limit: 4 }).length > 0 || reloaded.entries.some((e) => /猫|团子/.test(e.text))
console.log(`\n结论：抽取期间新消息保住了吗 → ${catOk ? '是 ✅' : '否 ❌'}`)
process.exit(catOk ? 0 : 3)
