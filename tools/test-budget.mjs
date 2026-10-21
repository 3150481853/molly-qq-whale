/**
 * 积分预算 + 降智接盘的离线测试。
 *
 * 目的：在不依赖 QQ / NapCat 的前提下，把「超了日上限之后会发生什么」
 * 整条路径跑通——记账、通知、切 trae、降智、以及关掉开关后的行为。
 *
 * 跑法：node test-budget.mjs
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const LIB = 'file:///${MOLLY_ROOT}/qq-whale/plugin/dsh-qq-whale/lib/'
const { CreditBudget, localDateKey } = await import(LIB + 'budget.js')
const { ChatEngine } = await import(LIB + 'engine.js')
const { PersonaStore } = await import(LIB + 'persona.js')

let pass = 0
let fail = 0
function ok(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qqw-budget-'))

// ————————————————————————————————————————————————
console.log('\n=== 1. CreditBudget 记账与阈值 ===')
{
  const b = new CreditBudget({ dir: tmp, enabled: true, dailyCap: 100 })
  ok('初始可用', b.canSpend())
  ok('初始剩余 100', b.remaining === 100, `remaining=${b.remaining}`)

  b.spend(0.05)
  b.spend(0.03)
  ok('累加 0.08', Math.abs(b.snapshot().used - 0.08) < 1e-9, `used=${b.snapshot().used}`)
  ok('calls=2', b.snapshot().calls === 2)

  b.spend(99.95)
  ok('到顶后 canSpend=false', b.canSpend() === false, `used=${b.snapshot().used}`)
  ok('exhausted=true', b.snapshot().exhausted === true)
  ok('remaining=0 不为负', b.remaining === 0, `remaining=${b.remaining}`)

  // 通知只发一次
  ok('第一次该通知', b.shouldNotifyExhausted() === true)
  ok('第二次不再通知', b.shouldNotifyExhausted() === false)
  ok('notified 已置位', b.snapshot().notified === true)

  // 落盘再读回
  const b2 = new CreditBudget({ dir: tmp, enabled: true, dailyCap: 100 })
  ok('重启后 used 不丢', Math.abs(b2.snapshot().used - 100.03) < 1e-9, `used=${b2.snapshot().used}`)
  ok('重启后 notified 不丢', b2.snapshot().notified === true)
  ok('重启后仍判定超限', b2.canSpend() === false)
}

// ————————————————————————————————————————————————
console.log('\n=== 2. 关掉开关后完全不限制 ===')
{
  const b = new CreditBudget({ dir: path.join(tmp, 'off'), enabled: false, dailyCap: 100 })
  b.spend(999)
  ok('关掉后 canSpend 恒 true', b.canSpend() === true)
  ok('关掉后 remaining=Infinity', b.remaining === Infinity, `remaining=${b.remaining}`)
  ok('关掉后不发通知', b.shouldNotifyExhausted() === false)
  ok('关掉后 snapshot.exhausted=false', b.snapshot().exhausted === false)
  // 注意：关掉时 still 会记账（used 有值），只是不拦——这是刻意的，
  // 因为用户可能想先看看用量再决定要不要开限制。
  ok('关掉时仍记录用量', b.snapshot().used === 999, `used=${b.snapshot().used}`)
}

// ————————————————————————————————————————————————
console.log('\n=== 3. 跨天归零 ===')
{
  const dir = path.join(tmp, 'roll')
  fs.mkdirSync(dir, { recursive: true })
  // 伪造一份昨天的账
  const yesterday = '2026-01-01'
  fs.writeFileSync(
    path.join(dir, 'budget.json'),
    JSON.stringify({ date: yesterday, used: 88, calls: 9, notified: true }),
    'utf8',
  )
  const b = new CreditBudget({ dir, enabled: true, dailyCap: 100 })
  ok('昨天的账不算今天', b.snapshot().used === 0, `used=${b.snapshot().used}`)
  ok('跨天后可以继续花', b.canSpend() === true)
  ok('跨天后通知可再发', b.shouldNotifyExhausted() === false) // 还没到顶
  b.spend(100)
  ok('今天到顶后再通知', b.shouldNotifyExhausted() === true)
  ok('yesterday 保留了', b.yesterday?.date === yesterday, JSON.stringify(b.yesterday))
}

// ————————————————————————————————————————————————
console.log('\n=== 4. 表情包配额被 prompt 与 splitReply 共用同一个数 ===')
{
  const persona = new PersonaStore({ dir: path.dirname(LIB.slice(8)) + '/persona' })
  const text = '这有啥<sep/>笑死<sticker>无语</sticker><sticker>翻白眼</sticker><sticker>吃白饭</sticker>'
  const parts2 = persona.splitReply(text, { maxStickersPerReply: 2 })
  const stickers2 = parts2.filter((p) => p.type === 'sticker').length
  ok('配额=2 时最多 2 张', stickers2 === 2, `实际 ${stickers2} 张`)
  const parts1 = persona.splitReply(text, { maxStickersPerReply: 1 })
  const stickers0 = parts1.filter((p) => p.type === 'sticker').length
  ok('配额=1 时最多 1 张', stickers0 === 1, `实际 ${stickers0} 张`)
}

// ————————————————————————————————————————————————
console.log('\n=== 5. 超预算后走 trae 降智（假客户端） ===')
{
  const calls = []
  const client = {
    self: { userId: '111111111', nickname: 'Molly' },
    sent: [],
    async sendPrivateMsg(uid, payload) { this.sent.push({ uid, payload }) },
    async sendGroupMsg(gid, payload) { this.sent.push({ gid, payload }) },
    async getLoginInfo() { return { user_id: '111111111', nickname: 'Molly' } },
    async getGroupInfo() { return { group_name: '测试群' } },
    async fetchImageAsBase64() { return '' },
  }

  const cfg = {
    selfId: '111111111',
    modelBackend: 'wbai',
    model: 'deepseek-v4.1-flash',
    maxTokens: 1024,
    temperature: 0.85,
    contextLimit: 40,
    personaDir: path.dirname(LIB.slice(8)) + '/persona',
    stickerDir: fs.existsSync('${MOLLY_ROOT}/qq-whale/stickers')
      ? '${MOLLY_ROOT}/qq-whale/stickers'
      : tmp,
    memoryDir: path.join(tmp, 'mem'),
    dataDir: path.join(tmp, 'data'),
    creditLimitEnabled: true,
    creditDailyCap: 0.02,
    creditFallbackTrae: true,
    traeModel: 'deepseek-v4.1-flash',
    traeProvider: 'trae',
    traeReasoningEffort: 'xhigh',
    traeMaxTokens: 512,
    traeContextLimit: 12,
    maxStickersPerReply: 2,
    blindMode: false,
    restWindows: [],
  }
  const eng = new ChatEngine({ ctx: {}, logger: (lv, m) => calls.push([lv, m]), config: cfg, client, llm: null })
  eng.client = client

  // 用假的 trae 替换掉（不真的连宿主）
  eng.trae = {
    async chat({ system, messages }) {
      eng.__traeSeen = { system, messages }
      return { ok: true, text: '脑子不够用了，就一句。', usage: { credit: 0.99 } }
    },
  }
  /*
   * 假 gateway：第一次花 0.05 分把预算打爆，之后**必须失败**。
   *
   * 为什么第二次起要失败：现在的分层是 主脑 → 备用脑(cn flash) → trae。
   * callSpare 用的就是 this.gateway.chat，如果这里一直返回成功，
   * 备用脑会把请求接住，永远走不到 trae —— 这一项就会假失败
   * （实际是"备用脑接住了"，不是"降智提示丢了"）。
   * 备用脑也烧满才是真正该走 trae 的场景，所以这里让它持续 429。
   */
  let gwCalls = 0
  eng.gateway = {
    async chat() {
      gwCalls++
      if (gwCalls === 1) return { ok: true, text: '这是免费额度说的。', usage: { credit: 0.05 } }
      return { ok: false, code: 'RATE_LIMIT', error: '429 mock' }
    },
  }

  ok('初始可用', eng.budget.canSpend() === true)
  const r1 = await eng.callWithFallback({ system: 'sys', messages: [{ role: 'user', content: 'hi' }] })
  ok('第一轮走免费额度', r1?.text === '这是免费额度说的。', r1?.text)
  ok('花掉 0.05 分', Math.abs(eng.budget.snapshot().used - 0.05) < 1e-9, `used=${eng.budget.snapshot().used}`)
  ok('现在超限了', eng.budget.canSpend() === false)

  // 造一条历史，跑 generate
  const conv = eng.getConversation('private:222222222')
  for (let i = 0; i < 20; i++) {
    eng.pushHistory(conv, { role: 'user', text: `历史消息 ${i}`, at: Date.now() })
  }
  conv.relationKey = 'private:222222222'
  const ev = { message_type: 'private', user_id: 222222222, message_id: 1 }
  const norm = { text: '还在吗', images: [] }
  const beforeTrae = eng.budget.snapshot()
  const out = await eng.generate({
    ev, norm, scene: 'private', conv, userName: '鸡哥', groupName: '', mood: null, signal: null,
  })
  ok('超限后走 trae 出结果', Boolean(out), JSON.stringify(out?.parts))
  ok('degraded=true', out?.degraded === true)
  ok('降智提示进了 system', String(eng.__traeSeen?.system || '').includes('脑子转得比平时慢'), '')
  const fed = eng.__traeSeen?.messages?.length || 0
  ok('降智只喂 ≤12 条历史', fed <= 12, `实际 ${fed} 条`)
  // task-54：trae 这次 usage 里明确带了 credit=0.99 → 照实累加；token 拿不到记 null
  const afterTrae = eng.budget.snapshot()
  ok('trae 按 usage.credit 记账（0.99）', Math.abs(afterTrae.used - (beforeTrae.used + 0.99)) < 1e-9, `used=${afterTrae.used}`)
  ok('trae 调用计入 calls', afterTrae.calls > beforeTrae.calls, `${beforeTrae.calls} → ${afterTrae.calls}`)
  ok('trae 调用计入 degraded 桶', (afterTrae.byChannel.degraded?.calls || 0) >= 1, JSON.stringify(afterTrae.byChannel))
  ok('degraded 桶 credit=0.99', Math.abs((afterTrae.byChannel.degraded?.credit || 0) - 0.99) < 1e-9, JSON.stringify(afterTrae.byChannel.degraded))
  ok('trae 这次 tokens=null（拿不到 usage 不编）', afterTrae.byChannel.degraded?.tokens === null, JSON.stringify(afterTrae.byChannel.degraded))

  // 通知只发一次
  ok('第一次 generate 已发通知', client.sent.length >= 1, `sent=${client.sent.length}`)
  const sentBefore = client.sent.length
  await eng.generate({ ev, norm, scene: 'private', conv, userName: '鸡哥', groupName: '', mood: null, signal: null })
  ok('第二次不再重复通知', client.sent.length === sentBefore, `多发了 ${client.sent.length - sentBefore} 条`)
}

// ————————————————————————————————————————————————
console.log('\n=== 6. 关掉限制时不跳 trae ===')
{
  const client = {
    self: { userId: '111111111', nickname: 'Molly' },
    sent: [],
    async sendPrivateMsg(uid, p) { this.sent.push(p) },
    async sendGroupMsg(gid, p) { this.sent.push(p) },
  }
  const cfg = {
    selfId: '111111111', modelBackend: 'wbai', model: 'deepseek-v4.1-flash',
    maxTokens: 1024, temperature: 0.85, contextLimit: 40,
    personaDir: path.dirname(LIB.slice(8)) + '/persona',
    stickerDir: tmp, memoryDir: path.join(tmp, 'mem2'), dataDir: path.join(tmp, 'data2'),
    creditLimitEnabled: false, creditDailyCap: 0.01,
    creditFallbackTrae: true, traeModel: 'deepseek-v4.1-flash', maxStickersPerReply: 2,
    blindMode: false, restWindows: [],
  }
  const eng = new ChatEngine({ ctx: {}, logger: () => {}, config: cfg, client, llm: null })
  eng.client = client
  eng.trae = { async chat() { eng.__traeUsed = true; return { ok: true, text: '不该走到这', usage: {} } } }
  eng.gateway = { async chat() { return { ok: true, text: '一直在用免费额度。', usage: { credit: 0.5 } } } }

  eng.budget.spend(50) // 远超 cap
  ok('关掉后仍可用', eng.budget.canSpend() === true)
  const conv = eng.getConversation('private:222222222')
  const ev = { message_type: 'private', user_id: 222222222, message_id: 2 }
  const out = await eng.generate({
    ev, norm: { text: '在吗', images: [] }, scene: 'private', conv,
    userName: '鸡哥', groupName: '', mood: null, signal: null,
  })
  ok('仍然用免费额度', out?.raw === '一直在用免费额度。', out?.raw)
  ok('没有跳到 trae', !eng.__traeUsed)
  ok('没有发额度通知', client.sent.length === 0, `sent=${client.sent.length}`)
}

// ————————————————————————————————————————————————
console.log('\n=== 7. 唯一记账出口：无 usage 也计 calls，有 usage 才加 token/credit ===')
{
  const dir = path.join(tmp, 'b7')
  const b = new CreditBudget({ dir, logger: () => {}, enabled: true, dailyCap: 500 })
  ok('初始 calls=0', b.snapshot().calls === 0)
  b.record({ channel: 'chat' })
  ok('无 usage → calls+1', b.snapshot().calls === 1, `calls=${b.snapshot().calls}`)
  ok('无 usage → tokens=null（不编 0）', b.snapshot().tokens === null, String(b.snapshot().tokens))
  ok('无 usage → credit 不加', b.snapshot().used === 0, `used=${b.snapshot().used}`)

  b.record({ channel: 'chat', promptTokens: 100, completionTokens: 40, credit: 0.02 })
  ok('有 usage → tokens 累加', b.snapshot().tokens === 140, `tokens=${b.snapshot().tokens}`)
  ok('有 usage → credit 累加', Math.abs(b.snapshot().used - 0.02) < 1e-9, `used=${b.snapshot().used}`)
  ok('chat 桶 calls=2', b.snapshot().byChannel.chat?.calls === 2, JSON.stringify(b.snapshot().byChannel))
  ok('chat 桶 tokens=140', b.snapshot().byChannel.chat?.tokens === 140)

  b.record({ channel: 'work' })
  ok('work 桶 tokens=null（这次拿不到）', b.snapshot().byChannel.work?.tokens === null, JSON.stringify(b.snapshot().byChannel))
  ok('全天 tokens 仍是 140', b.snapshot().tokens === 140, `tokens=${b.snapshot().tokens}`)
  ok('旧字段 used/cap/remaining 仍在', b.snapshot().cap === 500 && typeof b.snapshot().remaining === 'number')
  ok('snapshot 标注 scope=local', b.snapshot().scope === 'local')

  // 兼容旧接口：spend() 仍只加 credit，但走 record 后 calls 也 +1
  const callsBefore = b.snapshot().calls
  b.spend(0.5)
  ok('spend 兼容：used+0.5', Math.abs(b.snapshot().used - 0.52) < 1e-9, `used=${b.snapshot().used}`)
  ok('spend 兼容：calls+1', b.snapshot().calls === callsBefore + 1)
  ok('spend(0) 不记调用（旧语义）', (b.spend(0), b.snapshot().calls === callsBefore + 1))

  // 跨天归零：手写一份「昨天」的账本，重建实例
  const dir2 = path.join(tmp, 'b7-cross')
  fs.mkdirSync(dir2, { recursive: true })
  fs.writeFileSync(
    path.join(dir2, 'budget.json'),
    JSON.stringify({ date: '2000-01-01', used: 9.9, calls: 88, tokens: 12345, tokensKnown: 3, byChannel: { chat: { calls: 88, credit: 9.9, tokens: 12345, tokensKnown: 3 } } }),
    'utf8',
  )
  const b3 = new CreditBudget({ dir: dir2, logger: () => {}, enabled: true, dailyCap: 500 })
  ok('跨天 calls 归零', b3.snapshot().calls === 0, `calls=${b3.snapshot().calls}`)
  ok('跨天 tokens 归零为 null', b3.snapshot().tokens === null)
  ok('跨天 used 归零', b3.snapshot().used === 0)
  ok('跨天 byChannel 清空', Object.keys(b3.snapshot().byChannel).length === 0)
}

// ————————————————————————————————————————————————
console.log('\n=== 8. engine.recordUsage 解析两套 usage 字段 ===')
{
  const captured = []
  const fakeBudget = { record: (p) => captured.push(p), snapshot: () => ({}) }
  const eng = Object.create(ChatEngine.prototype)
  eng.budget = fakeBudget
  eng.logger = () => {}
  const budgetBak = eng.budget

  eng.recordUsage({
    channel: 'chat',
    usage: {
      prompt_tokens: 10,
      completion_tokens: 5,
      completion_tokens_details: { reasoning_tokens: 3 },
      prompt_tokens_details: { cached_tokens: 2 },
      credit: 0.1,
    },
    provider: 'wb-proxy',
    model: 'm',
  })
  const a = captured[0] || {}
  ok('解析 prompt_tokens', a.promptTokens === 10, JSON.stringify(a))
  ok('解析 completion_tokens', a.completionTokens === 5)
  ok('解析 reasoning_tokens', a.reasoningTokens === 3)
  ok('解析 cached_tokens', a.cachedTokens === 2)
  ok('解析 credit', a.credit === 0.1)
  ok('tokens=prompt+completion=15', a.tokens === 15, String(a.tokens))
  ok('channel/ provider/ model 透传', a.channel === 'chat' && a.provider === 'wb-proxy' && a.model === 'm')

  eng.recordUsage({ channel: 'work', usage: { promptTokens: 7, completionTokens: 3, credit: 0 } })
  const b = captured[1] || {}
  ok('camelCase 简写也认', b.promptTokens === 7 && b.completionTokens === 3, JSON.stringify(b))
  ok('credit=0 保持 0（不编造）', b.credit === 0)

  eng.recordUsage({ channel: 'research', usage: null })
  const c = captured[2] || {}
  ok('usage=null → tokens=null', c.tokens === null, JSON.stringify(c))
  ok('usage=null 仍然记 channel', c.channel === 'research')

  // 记账失败不能打断聊天
  eng.budget = { record: () => { throw new Error('disk full') } }
  let threw = false
  try { eng.recordUsage({ channel: 'chat', usage: null }) } catch { threw = true }
  ok('记账抛错被吞掉（不影响主流程）', threw === false)
  eng.budget = budgetBak
}

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`)
try { fs.rmSync(tmp, { recursive: true, force: true }) } catch {}
process.exit(fail === 0 ? 0 : 1)
