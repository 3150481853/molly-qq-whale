/**
 * 记忆链路专项测试：验证「聊着聊着就忘了我」这个核心诉求真的修好了。
 *
 * 测什么：
 *   ① 规则层：一句话里的身份/偏好/住哪/宠物/年龄能不能当场记住
 *   ② 模型层：攒够 3 句后，模型抽取能不能真的写进记忆库
 *   ③ 抽取的 maxTokens 够不够（早先 200 会静默返回空正文）
 *
 * 为什么单独一个脚本：现有的 e2e 都只验证"能回一条消息"，
 * 而记忆是**异步落盘**的，要靠专门等它写完才能断言。
 *
 * 跑法：
 *   node tools/e2e-memory.mjs            # 用真网关（会消耗少量积分）
 *   node tools/e2e-memory.mjs --offline  # 用假网关，零消耗
 */

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PKG = 'C:/Users/example/.dsh/profiles/desktop/node_modules/dsh-qq-whale'
const SRC = path.join(__dirname, '..', 'plugin', 'dsh-qq-whale')
const LIB = fs.existsSync(path.join(PKG, 'lib', 'engine.js'))
  ? path.join(PKG, 'lib')
  : path.join(SRC, 'lib')

const OFFLINE = process.argv.includes('--offline')
const SELF_ID = '111111111'
const OWNER = '222222222'

// 隔离的临时数据目录：绝不允许碰生产数据（见 _污染备份-* 的教训）
const TMP = path.join(__dirname, '..', 'out', 'e2e-memory-' + Date.now())
const MEM_DIR = path.join(TMP, 'memory')
fs.mkdirSync(MEM_DIR, { recursive: true })

const results = []
const check = (name, cond, detail = '') => {
  results.push({ name, ok: Boolean(cond), detail })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  —  ' + detail : ''}`)
}

// ———————— 假网关（离线模式） ————————
let fakeServer = null
let fakeBaseUrl = ''
/** 假网关对「抽记忆」请求返回的内容 —— 模拟真实模型的一行一条格式 */
const FAKE_EXTRACT_REPLY = [
  '他在杭州做游戏策划',
  '他养的猫叫团子，快三岁了',
  '他一般晚上九点才吃饭',
].join('\n')

function startFakeGateway() {
  return new Promise((resolve) => {
    fakeServer = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        let payload = {}
        try { payload = JSON.parse(body) } catch {}
        const sys = (payload.messages || []).find((m) => m.role === 'system')?.content || ''
        const isExtract = /整理记忆|挑出.*用得上|你在帮一只叫 Molly/.test(sys)
        const text = isExtract ? FAKE_EXTRACT_REPLY : '嗯嗯，我记下了。'
        res.writeHead(200, { 'Content-Type': 'text/event-stream' })
        // 正文帧
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: null }] })}\n`)
        // 收尾帧
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n`)
        // usage 帧（独立 choices:[]）
        res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 30, total_tokens: 80, credit: 0 } })}\n`)
        res.write('data: [DONE]\n')
        res.end()
      })
    })
    fakeServer.listen(0, '127.0.0.1', () => {
      fakeBaseUrl = `http://127.0.0.1:${fakeServer.address().port}/v1/chat/completions`
      resolve()
    })
  })
}

// ———————— 假 OneBot 客户端 ————————
function mkClient() {
  return {
    self: { userId: SELF_ID, nickname: 'Molly' },
    sent: [],
    async start() { return true },
    async stop() {},
    get connected() { return true },
    async sendPrivateMsg(uid, msg) { this.sent.push({ to: uid, msg }); return { message_id: Math.floor(Math.random() * 1e6) } },
    async sendGroupMsg(gid, msg) { this.sent.push({ to: gid, msg }); return { message_id: Math.floor(Math.random() * 1e6) } },
    async sendGroupMsgWithAt(gid, uid, msg) { this.sent.push({ to: gid, at: uid, msg }); return { message_id: Math.floor(Math.random() * 1e6) } },
    async setMsgEmojiLike() {},
    async getGroupMemberInfo() { return { card: 'Molly', nickname: 'Molly' } },
    async setGroupCard() {},
    on() {},
  }
}

function mkEvent(text) {
  return {
    post_type: 'message',
    self_id: Number(SELF_ID),
    user_id: Number(OWNER),
    message_id: Math.floor(Math.random() * 1e6),
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
    sender: { user_id: Number(OWNER), nickname: '测试用户', card: '' },
    time: Math.floor(Date.now() / 1000),
    message_type: 'private',
    sub_type: 'friend',
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ———————— 主流程 ————————
async function main() {
  console.log('数据集目录：', TMP)
  console.log('模块来源：', LIB)
  console.log('模式：', OFFLINE ? '离线（假网关，零消耗）' : '真网关')
  console.log('')

  if (OFFLINE) await startFakeGateway()

  const { ChatEngine } = await import('file:///' + path.join(LIB, 'engine.js').replace(/\\/g, '/'))
  const { MemoryStore } = await import('file:///' + path.join(LIB, 'memory.js').replace(/\\/g, '/'))

  const logger = (lv, msg) => {
    if (['info', 'warn', 'error'].includes(lv)) console.log(`[${lv}] ${msg}`)
  }

  const config = {
    selfId: SELF_ID,
    modelBackend: 'wb-proxy',
    model: 'deepseek-v4.1-flash',
    degradedModel: 'deepseek-v4-pro',
    spareEnabled: true,
    spareModel: 'deepseek-v4.1-flash',
    spareLimitEnabled: true,
    spareDailyCap: 500,
    gatewayBaseUrl: OFFLINE ? fakeBaseUrl : 'http://127.0.0.1:8788/v1/chat/completions',
    gatewayApiKey: 'wb-proxy-local',
    gatewayToWbaiFallback: false,
    maxTokens: 400,
    temperature: 0.8,
    contextLimit: 40,
    debounceMs: 100,
    thinkingBaseDelaySeconds: 0.05,
    typingCharactersPerSecond: 200,
    typingMaxDelaySeconds: 0.1,
    typingJitterRatio: 0,
    bubbleGapMinSeconds: 0.05,
    bubbleGapMaxSeconds: 0.1,
    reactionMinSeconds: 0,
    reactionMaxSeconds: 0.05,
    restWindows: [],
    commandEnabled: false,
    proactiveEnabled: false,
    progressEnabled: false,
    researchEnabled: false,
    memoryLimit: 400,
    memoryExtract: true,
    // 测试里把门槛调到能立刻触发，否则要等 8 分钟
    memoryExtractMinLines: 3,
    memoryExtractMinGapMinutes: 0,
    memoryExtractMaxTokens: 700,
    creditLimitEnabled: false,
    stickerLearn: false,
    personaDir: path.join(SRC, 'persona'),
    stickerDir: path.join(__dirname, '..', 'stickers'),
    memoryDir: MEM_DIR,
    dataDir: path.join(TMP, 'data'),
  }
  fs.mkdirSync(config.dataDir, { recursive: true })

  const client = mkClient()
  const engine = new ChatEngine({ config, logger, client, ctx: null, llm: null })
  await engine.init?.()

  check('引擎初始化成功', Boolean(engine.gateway), engine.gateway?.constructor?.name)
  check('备用脑预算就绪', Boolean(engine.spare), `cap=${engine.spare?.dailyCap}`)

  // ——— ① 规则层：一句话立刻记住 ———
  const ruleCases = [
    ['我在杭州做游戏策划', '他在杭州'],
    ['我家养了只猫叫团子', '宠物'],
    ['我喜欢吃火锅', '他喜欢吃火锅'],
  ]
  let ruleHit = 0
  for (const [said, expect] of ruleCases) {
    await engine.maybeLearn(mkEvent(said), { text: said }, '测试用户')
    const entries = engine.memory.entries || []
    const found = entries.some((e) => String(e.text || '').includes(expect))
    if (found) ruleHit++
  }
  check('规则层当场记住身份/宠物/偏好', ruleHit >= 2, `${ruleHit}/${ruleCases.length} 命中`)

  // ——— ② 模型层：攒够 3 句后抽取 ———
  const before = (engine.memory.entries || []).length
  const batch = [
    '今天加班到十点，累死了',
    '周末本来想去爬山，现在估计泡汤了',
    '我一般晚上九点才吃饭',
  ]
  for (const s of batch) {
    await engine.maybeLearn(mkEvent(s), { text: s }, '测试用户')
  }
  // 抽取是异步的，等它写完
  await sleep(OFFLINE ? 1200 : 15000)

  const after = (engine.memory.entries || []).length
  check('模型层抽出新记忆', after > before, `${before} → ${after} 条`)

  // ——— ③ 落盘验证 ———
  await sleep(300)
  const file = path.join(MEM_DIR, 'memory.json')
  let onDisk = []
  try {
    onDisk = JSON.parse(fs.readFileSync(file, 'utf8')).entries || []
  } catch (err) {
    check('记忆落盘', false, err.message)
  }
  check('记忆已落盘', onDisk.length > 0, `${onDisk.length} 条 @ ${file}`)

  // ——— ④ 新引擎能读回来（重启不丢） ———
  const store2 = new MemoryStore({ dir: MEM_DIR, logger: () => {} })
  check('新实例能读回记忆（重启不丢）', (store2.entries || []).length === onDisk.length, `${(store2.entries || []).length} 条`)

  // ——— ⑤ 记忆能进 system prompt（真的会被用到） ———
  const conv = engine.getConversation?.({ key: 'private:' + OWNER, scene: 'private', ev: mkEvent('hi') }) || {
    key: 'private:' + OWNER,
    history: [{ role: 'user', text: 'hi', at: Date.now() }],
    relationKey: 'private:' + OWNER,
  }
  const sp = engine.buildSystemPrompt({
    scene: 'private',
    userName: '测试用户',
    groupName: '',
    mood: 'normal',
    conv,
  })
  const spHasMemory = /你记得的事/.test(sp) || (store2.entries || []).some((e) => sp.includes(String(e.text || '').slice(0, 6)))
  check('记忆进入 system prompt', spHasMemory, `prompt ${sp.length} 字`)

  // ——— 汇总 ———
  console.log('')
  const passed = results.filter((r) => r.ok).length
  console.log(`=== 结果：${passed}/${results.length} 通过 ===`)
  if (passed < results.length) {
    for (const r of results.filter((x) => !x.ok)) console.log(`  未通过：${r.name} ${r.detail}`)
  }

  try { await engine.dispose?.() } catch {}
  if (fakeServer) fakeServer.close()
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((err) => {
  console.error('运行失败：', err)
  if (fakeServer) fakeServer.close()
  process.exit(1)
})
