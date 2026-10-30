#!/usr/bin/env node
/**
 * 陌生人审批流的离线单测。
 *
 * 不连 QQ、不连模型、不碰生产数据 —— 数据目录隔离到 out/test-gatekeeper-<ts>/。
 * 覆盖：Gatekeeper 状态机、parseVerdict 说法识别、engine 三个入口
 * （handleStranger / tryVerdict / onRequest）的行为。
 *
 * 用法：node test-gatekeeper.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const INSTALL = 'C:/Users/example/.dsh/profiles/desktop/node_modules/dsh-qq-whale/lib'

let pass = 0
let fail = 0
const t = (name, fn) => {
  try {
    const r = fn()
    if (r === false) throw new Error('返回 false')
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ✗ ${name}  → ${e.message}`)
  }
}
const ta = async (name, fn) => {
  try {
    const r = await fn()
    if (r === false) throw new Error('返回 false')
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    console.log(`  ✗ ${name}  → ${e.message}`)
  }
}
const eq = (a, b, msg = '') => {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg} 期望 ${JSON.stringify(b)} 实得 ${JSON.stringify(a)}`)
}

const { Gatekeeper, parseVerdict, personLabel } = await import(`file:///${INSTALL}/gatekeeper.js`)

const dir = path.join(here, '..', 'out', `test-gatekeeper-${Date.now()}`)
fs.mkdirSync(dir, { recursive: true })
console.log(`数据目录：${dir}\n`)

// ─────────────────────────── 1. parseVerdict ───────────────────────────
console.log('【1】parseVerdict 说法识别')
const cases = [
  ['1', { action: 'approve', userId: '' }],
  ['0', { action: 'deny', userId: '' }],
  ['通过', { action: 'approve', userId: '' }],
  ['同意', { action: 'approve', userId: '' }],
  ['拒绝', { action: 'deny', userId: '' }],
  ['行', { action: 'approve', userId: '' }],
  ['好', { action: 'approve', userId: '' }],
  ['ok', { action: 'approve', userId: '' }],
  ['√', { action: 'approve', userId: '' }],
  ['×', { action: 'deny', userId: '' }],
  ['通过 123456789', { action: 'approve', userId: '123456789' }],
  ['拒绝123456789', { action: 'deny', userId: '123456789' }],
  ['不同意 987654321', { action: 'deny', userId: '987654321' }],
  ['通过：333333333', { action: 'approve', userId: '333333333' }],
  // 必须不误判
  ['今天天气不错', null],
  ['嗯嗯', null],
  ['哈哈', null],
  ['好的呀', null],
  ['这个可以吗', null],
  ['我通过朋友圈看到你的', null],
  ['', null],
]
for (const [input, want] of cases) t(`「${input}」→ ${want ? want.action : 'null'}`, () => eq(parseVerdict(input), want))

// ─────────────────────────── 2. Gatekeeper 状态机 ───────────────────────────
console.log('\n【2】Gatekeeper 状态机')
const OWNER = '222222222'
const gk = new Gatekeeper({ dir, logger: () => {}, owners: [OWNER] })

t('主人不排队', () => eq(gk.shouldAsk(OWNER).reason, 'owner'))
t('陌生人首次该问', () => eq(gk.shouldAsk('111111').reason, 'new'))

const r1 = gk.note('111111', { name: '小明', text: '在吗' })
t('note 建条目 count=1', () => eq([r1.isNew, r1.entry.count], [true, 1]))
gk.markAsked('111111')
t('问过之后 24h 内不再问', () => eq(gk.shouldAsk('111111').reason, 'already-pending'))

const r2 = gk.note('111111', { text: '你看得见吗' })
t('note 幂等累加 count', () => eq([r2.isNew, r2.entry.count], [false, 2]))
t('幂等更新最后一句', () => eq(r2.entry.lastText, '你看得见吗'))

gk.approve('111111')
t('批准后 shouldAsk=approved', () => eq(gk.shouldAsk('111111').reason, 'approved'))
t('批准后 pending 清空', () => eq(gk.pending.size, 0))
t('批准后 isApproved=true', () => gk.isApproved('111111'))

gk.note('222222', { name: '小王', text: '你好' })
gk.deny('222222')
t('拒绝后冷却', () => eq(gk.shouldAsk('222222').reason, 'denied-cooldown'))
t('拒绝 31 天后可再问', () => {
  const future = Date.now() + 31 * 24 * 3600 * 1000
  return eq(gk.shouldAsk('222222', future).reason, 'new')
})

t('群申请批准不污染私聊白名单', () => {
  gk.pending.set('555666', { userId: '555666', kind: 'group', name: '测试群', at: Date.now() })
  gk.approve('555666')
  return gk.isApproved('555666') === false
})

t('落盘后新实例能读回', () => {
  const g2 = new Gatekeeper({ dir, logger: () => {}, owners: [OWNER] })
  return g2.isApproved('111111') === true && g2.isDenied('222222') === true
})

t('损坏 JSON 当全新开始', () => {
  const bad = path.join(dir, 'bad')
  fs.mkdirSync(bad, { recursive: true })
  fs.writeFileSync(path.join(bad, 'gatekeeper.json'), '{不是 json')
  const g3 = new Gatekeeper({ dir: bad, logger: () => {}, owners: [OWNER] })
  return eq([g3.pending.size, g3.approved.size], [0, 0])
})

t('personLabel 人', () => eq(personLabel({ userId: '123', name: '小明' }), '小明（123）'))
t('personLabel 无名', () => eq(personLabel({ userId: '123' }), '123'))
t('personLabel 群', () => eq(personLabel({ userId: '999', groupId: '999', kind: 'group' }), '群 999'))

// ─────────────────────────── 3. engine 三个入口 ───────────────────────────
console.log('\n【3】engine 审批入口')
const engineMod = await import(`file:///${INSTALL}/engine.js`)
const ChatEngine = engineMod.ChatEngine || engineMod.default
if (!ChatEngine) throw new Error('engine.js 没导出 ChatEngine')

/*
 * 假客户端的铁律：**从真实 OneBotClient 原型上继承**，只覆写真正对外发请求的
 * `call()`，绝不自己新写一个 `callApi`。
 *
 * 2026-10-18 的加好友事故就是这么来的：这个测试原来手写了一个
 * `callApi: async () => ({status:'ok'})`，而真实的 OneBotClient 里**根本没有
 * callApi 这个方法**（只有 call）。测试一路绿，真机上 engine 的
 * `if (!this.client?.callApi) return false` 直接短路 —— 同意好友申请
 * 从上线起就没成功过一次。见 lib/onebot.js 里 callApi() 的注释。
 */
const onebotMod = await import(`file:///${INSTALL}/onebot.js`)
const { OneBotClient } = onebotMod
if (!OneBotClient) throw new Error('onebot.js 没导出 OneBotClient')

/** 造一个假 engine：只装审批要用的字段，不启动任何连接 */
function makeEngine(owners = [OWNER]) {
  const sent = []
  const apiCalls = []
  const eng = Object.create(ChatEngine.prototype)
  eng.config = { allowedUsers: [OWNER], allowedGroups: [], ownerTitle: '主人，' }
  eng.ownerTitle = '主人，'
  eng.logger = () => {}
  eng.selfId = '111111111'
  eng.gatekeeper = new Gatekeeper({ dir: path.join(dir, `e-${Date.now()}-${Math.random()}`), owners })
  eng.lastAskAt = 0
  eng.ASK_WINDOW_MS = 30 * 60 * 1000
  const client = Object.create(OneBotClient.prototype)
  client.state = 'online'
  client.sendPrivateMsg = async (uid, segs) => {
    sent.push({ uid: String(uid), text: segs.map((s) => s.data?.text || '').join('') })
  }
  client.call = async (action, params) => {
    apiCalls.push({ action, params })
    // 好友申请反查用的「可能认识的人」接口：默认空列表，测试里按需塞 eng._doubt。
    if (action === 'get_doubt_friends_add_request') return { data: eng._doubt || [] }
    return { ok: true }
  }
  eng.client = client
  eng.displayName = async () => '小明'
  eng._sent = sent
  eng._api = apiCalls
  eng._replies = 0
  eng.scheduleReply = async () => { eng._replies++ }
  return eng
}

await ta('handleStranger：通知主人且不回对方', async () => {
  const e = makeEngine()
  await e.handleStranger({ user_id: '111111' }, { text: '在吗', images: [] }, '小明')
  eq(e._sent.length, 1)
  eq(e._sent[0].uid, OWNER)
  return e._sent[0].text.includes('111111') && e._sent[0].text.includes('在吗')
})

await ta('handleStranger：24h 内同一人只问一次', async () => {
  const e = makeEngine()
  await e.handleStranger({ user_id: '111111' }, { text: '在吗', images: [] }, '小明')
  await e.handleStranger({ user_id: '111111' }, { text: '喂', images: [] }, '小明')
  eq(e._sent.length, 1)
})

await ta('tryVerdict：窗口内「1」= 通过', async () => {
  const e = makeEngine()
  await e.handleStranger({ user_id: '111111' }, { text: '在吗', images: [] }, '小明')
  const handled = await e.tryVerdict({ user_id: OWNER }, { text: '1' })
  return handled === true && e.gatekeeper.isApproved('111111') === true && e._sent.length === 2
})

await ta('tryVerdict：窗口外「1」不算审批（正常聊天）', async () => {
  const e = makeEngine()
  await e.handleStranger({ user_id: '111111' }, { text: '在吗', images: [] }, '小明')
  e.lastAskAt = Date.now() - 31 * 60 * 1000
  const handled = await e.tryVerdict({ user_id: OWNER }, { text: '1' })
  return handled === false && e.gatekeeper.isApproved('111111') === false
})

await ta('tryVerdict：非主人回复无效', async () => {
  const e = makeEngine()
  await e.handleStranger({ user_id: '111111' }, { text: '在吗', images: [] }, '小明')
  const handled = await e.tryVerdict({ user_id: '999999' }, { text: '1' })
  return handled === false
})

await ta('tryVerdict：多人待批 + 单字 → 让主人说清是谁', async () => {
  const e = makeEngine()
  await e.handleStranger({ user_id: '111111' }, { text: 'a', images: [] }, '小明')
  await e.handleStranger({ user_id: '222222' }, { text: 'b', images: [] }, '小红')
  const handled = await e.tryVerdict({ user_id: OWNER }, { text: '1' })
  const last = e._sent[e._sent.length - 1].text
  return handled === true && last.includes('同时在等') && e.gatekeeper.pending.size === 2
})

await ta('tryVerdict：带号指令绕过多义', async () => {
  const e = makeEngine()
  await e.handleStranger({ user_id: '111111' }, { text: 'a', images: [] }, '小明')
  await e.handleStranger({ user_id: '222222' }, { text: 'b', images: [] }, '小红')
  const handled = await e.tryVerdict({ user_id: OWNER }, { text: '通过 222222' })
  return handled === true && e.gatekeeper.isApproved('222222') && !e.gatekeeper.isApproved('111111')
})

await ta('tryVerdict：「0」= 拒绝', async () => {
  const e = makeEngine()
  await e.handleStranger({ user_id: '111111' }, { text: '在吗', images: [] }, '小明')
  const handled = await e.tryVerdict({ user_id: OWNER }, { text: '0' })
  return handled === true && e.gatekeeper.isDenied('111111') === true
})

await ta('onRequest：加好友不问就不同意的流程', async () => {
  const e = makeEngine()
  await e.onRequest({ post_type: 'request', request_type: 'friend', user_id: '333444', flag: 'flg1', comment: '我是群友' })
  const ask = e._sent.find((s) => s.text.includes('333444'))
  return Boolean(ask) && ask.text.includes('加我好友') && e._api.length === 0
})

await ta('onRequest + 通过 → 真调 set_friend_add_request', async () => {
  const e = makeEngine()
  await e.onRequest({ post_type: 'request', request_type: 'friend', user_id: '333444', flag: 'flg1', comment: '我是群友' })
  const handled = await e.tryVerdict({ user_id: OWNER }, { text: '1' })
  const call = e._api.find((c) => c.action === 'set_friend_add_request')
  return handled === true && call?.params.flag === 'flg1' && call?.params.approve === true
})

await ta('onRequest + 拒绝 → 真调 reject', async () => {
  const e = makeEngine()
  await e.onRequest({ post_type: 'request', request_type: 'friend', user_id: '333444', flag: 'flg2' })
  await e.tryVerdict({ user_id: OWNER }, { text: '0' })
  const call = e._api.find((c) => c.action === 'set_friend_add_request')
  return call?.params.approve === false
})

await ta('onRequest：群邀请走 set_group_add_request', async () => {
  const e = makeEngine()
  await e.onRequest({ post_type: 'request', request_type: 'group', user_id: '333444', group_id: '888999', flag: 'flg3', sub_type: 'invite' })
  const asked = e._sent.some((s) => s.text.includes('888999'))
  await e.tryVerdict({ user_id: OWNER }, { text: '1' })
  const call = e._api.find((c) => c.action === 'set_group_add_request')
  return asked && call?.params.flag === 'flg3' && e.gatekeeper.isApproved('888999') === false
})

/*
 * ── 回归守卫：给「加好友从上线起就没成功过」这个事故上三道锁 ──
 *
 * 事故链条：engine 调 `this.client.callApi(...)` → OneBotClient 上根本没有
 * 这个名字（只有 call）→ `if (!this.client?.callApi)` 短路 → 返回裸 false →
 * 主人收到「想同意 XXX，但没成功 · QQ 没接受这次操作（）」，括号里是空的。
 * 而本文件的假客户端自己写了 callApi，把这个洞盖得严严实实。
 */
t('OneBotClient 上必须有 callApi（engine 的审批走这个名字）', () => {
  eq(typeof OneBotClient.prototype.callApi, 'function')
})

await ta('callApi 真的转调 call，并且把 data 原样返回', async () => {
  const c = Object.create(OneBotClient.prototype)
  c.state = 'online'
  const seen = []
  c.call = async (action, params, timeoutMs) => {
    seen.push({ action, params, timeoutMs })
    return { message_id: 42 }
  }
  const r = await c.callApi('set_friend_add_request', { flag: 'x', approve: true })
  eq(seen.length, 1)
  eq(seen[0].action, 'set_friend_add_request')
  eq(seen[0].params.flag, 'x')
  if (seen[0].timeoutMs === undefined) throw new Error('没把默认超时传下去')
  eq(r.message_id, 42)
})

await ta('客户端没有 callApi 时：返回 {ok:false,reason:"no-client"} 而不是裸 false', async () => {
  const e = makeEngine()
  // 故意用一个「老版本」客户端：只会发消息，没有改申请的接口
  e.client = { sendPrivateMsg: async () => {} }
  const r = await e.approveRequest({ kind: 'friend', userId: '333444', flag: 'flg1' })
  eq(r?.ok, false)
  eq(r?.reason, 'no-client')
})

await ta('客户端没有 callApi 时：主人收到的提示不是空括号', async () => {
  const e = makeEngine()
  e.client = {
    sendPrivateMsg: async (uid, segs) => {
      e._sent.push({ uid: String(uid), text: segs.map((s) => s.data?.text || '').join('') })
    },
  }
  await e.onRequest({ post_type: 'request', request_type: 'friend', user_id: '333444', flag: 'flg1' })
  await e.tryVerdict({ user_id: OWNER }, { text: '1' })
  const fail = e._sent.find((s) => s.text.includes('没成功'))
  if (!fail) throw new Error('没有发出失败提示')
  if (/操作（）/.test(fail.text)) throw new Error('提示里还是空括号')
  return fail.text.includes('没就绪') || fail.text.includes('没连上')
})

/*
 * ── 多审批人（用户 m18721 / m18742）──
 *
 * 需求原话：「把同意加好友权限放给 333333333 一份，即有人加好友同时发给我和
 * 他，有一人同意即可」+「有一方同意后记得告知另一方已被处理」。
 *
 * 实现是把 approverUins 并进 Gatekeeper.owners（owners[0] 仍是主主人），
 * 所以这里要盯住四件事：
 *   ① 申请提示**两个人**都收到（少发一个 = 那个人形同没有权限）；
 *   ② 副审批人回「1」也**真的生效**（isOwner 认不认他）；
 *   ③ 动手的人收到正常回执，**另一个人**收到「已被处理」；
 *   ④ 只有一个人时不多发这条废话。
 */
const APPROVER = '333333333'
const TWO = [OWNER, APPROVER]

await ta('双审批人：陌生人请求同时发给两个人', async () => {
  const e = makeEngine(TWO)
  await e.handleStranger({ user_id: '111111' }, { text: '在吗', images: [] }, '小明')
  const uids = e._sent.map((s) => s.uid).sort()
  eq(uids.length, 2, `应该发 2 条，实际 ${uids.length}`)
  eq(uids[0], APPROVER)
  eq(uids[1], OWNER)
  return e._sent.every((s) => s.text.includes('111111'))
})

await ta('双审批人：主主人批了，另一个收到「已被处理」', async () => {
  const e = makeEngine(TWO)
  await e.handleStranger({ user_id: '111111' }, { text: '在吗', images: [] }, '小明')
  e._sent.length = 0
  const handled = await e.tryVerdict({ user_id: OWNER }, { text: '1' })
  eq(handled, true)
  eq(e.gatekeeper.isApproved('111111'), true)
  const toOwner = e._sent.filter((s) => s.uid === OWNER)
  const toApprover = e._sent.filter((s) => s.uid === APPROVER)
  eq(toOwner.length, 1, `主主人应收到 1 条回执，实际 ${toOwner.length}`)
  eq(toApprover.length, 1, `副审批人应收到 1 条「已被处理」，实际 ${toApprover.length}`)
  if (!toApprover[0].text.includes('已被处理')) throw new Error('副审批人收到的不是「已被处理」：' + toApprover[0].text)
  // 「已被处理」里不能出现让对方以为还要回复的话
  return !/回「1」/.test(toApprover[0].text)
})

await ta('双审批人：副审批人自己批也生效，主主人收到「已被处理」', async () => {
  const e = makeEngine(TWO)
  await e.handleStranger({ user_id: '222222' }, { text: '你好', images: [] }, '小红')
  e._sent.length = 0
  const handled = await e.tryVerdict({ user_id: APPROVER }, { text: '通过' })
  eq(handled, true)
  eq(e.gatekeeper.isApproved('222222'), true)
  const toOwner = e._sent.filter((s) => s.uid === OWNER)
  eq(toOwner.length, 1, `主主人应收到 1 条「已被处理」，实际 ${toOwner.length}`)
  return toOwner[0].text.includes('已被处理')
})

await ta('双审批人：加好友申请也同时发给两个人', async () => {
  const e = makeEngine(TWO)
  await e.onRequest({ post_type: 'request', request_type: 'friend', user_id: '333444', flag: 'flg9' })
  const uids = e._sent.map((s) => s.uid).sort()
  eq(uids.length, 2, `应该发 2 条，实际 ${uids.length}`)
  return e._sent.every((s) => s.text.includes('333444'))
})

await ta('只有一个人有审批权时，不额外发「已被处理」', async () => {
  const e = makeEngine([OWNER])
  await e.handleStranger({ user_id: '111111' }, { text: '在吗', images: [] }, '小明')
  e._sent.length = 0
  await e.tryVerdict({ user_id: OWNER }, { text: '1' })
  eq(e._sent.length, 1, `只该有 1 条回执，实际 ${e._sent.length}`)
  return !e._sent.some((s) => s.text.includes('已被处理'))
})

await ta('双审批人：无关的第三个人回「1」无效', async () => {
  const e = makeEngine(TWO)
  await e.handleStranger({ user_id: '111111' }, { text: '在吗', images: [] }, '小明')
  const handled = await e.tryVerdict({ user_id: '999999' }, { text: '1' })
  return handled === false && e.gatekeeper.isApproved('111111') === false
})

await ta('双审批人：A 处理完后 B 再回「1」被吃掉，不掉进正常聊天', async () => {
  const e = makeEngine(TWO)
  await e.handleStranger({ user_id: '111111' }, { text: '在吗', images: [] }, '小明')
  await e.tryVerdict({ user_id: OWNER }, { text: '1' })
  e._sent.length = 0
  const handled = await e.tryVerdict({ user_id: APPROVER }, { text: '1' })
  eq(handled, true, '应该被视为审批尾巴而不是正常聊天')
  eq(e._sent.length, 1)
  return e._sent[0].text.includes('已经有人处理过')
})

await ta('单审批人：队列空时回「1」照常当聊天，不塞系统话', async () => {
  const e = makeEngine([OWNER])
  await e.handleStranger({ user_id: '111111' }, { text: '在吗', images: [] }, '小明')
  await e.tryVerdict({ user_id: OWNER }, { text: '1' })
  e._sent.length = 0
  const handled = await e.tryVerdict({ user_id: OWNER }, { text: '1' })
  return handled === false && e._sent.length === 0
})

/*
 * ── 称呼只属于主主人（用户 m18893）──
 *
 * 「为什么 333333333 你也是叫鸡哥」——`ownerTitle` 原先是硬拼进审批提示的，
 * 转发给审批人时他也在被叫「主人」。现在按收件人渲染。
 */
await ta('titleFor：主主人拿称呼，其他人一律空串', () => {
  const e = makeEngine(TWO)
  eq(e.titleFor(OWNER), '主人，')
  eq(e.titleFor(APPROVER), '')
  eq(e.titleFor('999999'), '')
  const single = makeEngine([OWNER])
  eq(single.titleFor(OWNER), '主人，')
})

await ta('双审批人：只有主主人被叫「主人」，副审批人收到的是原文', async () => {
  const e = makeEngine(TWO)
  await e.onRequest({ post_type: 'request', request_type: 'friend', user_id: '333444', flag: 'f1' })
  const toOwner = e._sent.find((s) => s.uid === OWNER)
  const toApprover = e._sent.find((s) => s.uid === APPROVER)
  if (!toOwner || !toApprover) throw new Error('两个人没有都收到')
  eq(/^主人，/.test(toOwner.text), true, '主主人那条应以「主人，」开头：' + toOwner.text)
  eq(toApprover.text.includes('主人'), false, '副审批人那条不该出现「主人」：' + toApprover.text)
  return toApprover.text.startsWith('有个不认识的想加我好友')
})

await ta('陌生人审批那条从头到尾不出现「主人」', async () => {
  const e = makeEngine(TWO)
  await e.handleStranger({ user_id: '111111' }, { text: '在吗', images: [] }, '小明')
  return e._sent.every((s) => !s.text.includes('主人'))
})

await ta('群邀请提示也不给副审批人挂称呼', async () => {
  const e = makeEngine(TWO)
  await e.onRequest({ post_type: 'request', request_type: 'group', user_id: '333444', group_id: '888999', flag: 'g1', sub_type: 'invite' })
  const toApprover = e._sent.find((s) => s.uid === APPROVER)
  const toOwner = e._sent.find((s) => s.uid === OWNER)
  eq(/^主人，/.test(toOwner.text), true)
  return toApprover.text.startsWith('有人想把我拉进群')
})

/*
 * ── 好友申请拿不到 QQ 号（2026-10-30 真机）──
 *
 * SnowLuma 的 friend_request 里 user_id 是 resolveUidToUin(uid, 0)，陌生人
 * 还没进好友表时它就是 0；但 get_doubt_friends_add_request 同时返回 uid 和
 * 真实 user_id，按 flag（uid）对回去就能把 QQ 号补出来。
 */
await ta('onRequest：user_id=0 时用 get_doubt 反查出 QQ 号', async () => {
  const e = makeEngine()
  e._doubt = [{ uid: 'u_test', user_id: 3070838421, nick: '添真', msg: '你好，我叫某某' }]
  await e.onRequest({
    post_type: 'request',
    request_type: 'friend',
    user_id: 0,
    flag: 'u_test',
    comment: '你好，我叫某某',
  })
  const ask = e._sent.find((s) => s.uid === OWNER)
  if (!ask) throw new Error('主人没收到申请提示')
  eq(ask.text.includes('3070838421'), true, '提示里应出现真实 QQ 号：' + ask.text)
  eq(ask.text.includes('添真'), true, '提示里应出现反查到的昵称：' + ask.text)
  return e.gatekeeper.pending.has('3070838421')
})

await ta('parseReplyToPending：四种「回复他」说法都能取出正文', () => {
  const e = makeEngine()
  eq(e.parseReplyToPending("回复他 '艹尼玛'"), '艹尼玛')
  eq(e.parseReplyToPending('回复她「你好」'), '你好')
  eq(e.parseReplyToPending('回复对方：在吗'), '在吗')
  eq(e.parseReplyToPending('回复一下申请人：测试'), '测试')
  eq(e.parseReplyToPending('帮我回复他一下'), '')
  eq(e.parseReplyToPending('回复'), '')
})

await ta('tryDirectReplyToPending：回复他 → 发给申请人，不发回主人', async () => {
  const e = makeEngine()
  e.gatekeeper.pending.set('3070838421', {
    userId: '3070838421',
    kind: 'friend',
    name: '添真',
    at: Date.now(),
    lastAt: Date.now(),
    flag: 'u_test',
  })
  const handled = await e.tryDirectReplyToPending({
    ev: { user_id: OWNER },
    task: "回复他 '艹尼玛'",
    key: OWNER,
  })
  const toApplicant = e._sent.find((s) => s.uid === '3070838421')
  const toOwner = e._sent.find((s) => s.uid === OWNER)
  eq(handled, true)
  eq(toApplicant?.text, '艹尼玛', '申请人应收到正文')
  eq(/已经私聊发给他了/.test(toOwner?.text || ''), true, '主人应只收到一条回执')
  eq(toOwner?.text.includes('艹尼玛'), false, '回执里不该复述辱骂内容')
  return true
})

await ta('tryDirectReplyToPending：待批只存 friend:<flag> 时先反查再发', async () => {
  const e = makeEngine()
  e._doubt = [{ uid: 'u_test', user_id: 3070838421, nick: '添真', msg: '你好' }]
  e.gatekeeper.pending.set('friend:u_test', {
    userId: 'friend:u_test',
    kind: 'friend',
    name: '',
    lastText: '你好',
    flag: 'u_test',
    at: Date.now(),
    lastAt: Date.now(),
  })
  const handled = await e.tryDirectReplyToPending({
    ev: { user_id: OWNER },
    task: '回复他「你好呀」',
    key: OWNER,
  })
  const toApplicant = e._sent.find((s) => s.uid === '3070838421')
  eq(handled, true)
  eq(toApplicant?.text, '你好呀')
  return e.gatekeeper.pending.has('3070838421')
})

await ta('tryVerdict：反查出 QQ 号后回「1」仍能通过这条申请', async () => {
  const e = makeEngine()
  e._doubt = [{ uid: 'u_test', user_id: 3070838421, nick: '添真', msg: '你好' }]
  await e.onRequest({
    post_type: 'request',
    request_type: 'friend',
    user_id: 0,
    flag: 'u_test',
    comment: '你好',
  })
  e.lastAskAt = Date.now()
  const handled = await e.tryVerdict({ user_id: OWNER }, { text: '1' })
  const approveCall = e._api.find((x) => x.action === 'set_friend_add_request')
  eq(handled, true)
  eq(approveCall?.params?.flag, 'u_test', '同意时要用申请原始的 flag')
  eq(approveCall?.params?.approve, true)
  return true
})

await ta('tryDirectReplyToPending：多个待批申请先问清楚，不瞎发', async () => {
  const e = makeEngine()
  const at = Date.now()
  e.gatekeeper.pending.set('111111', { userId: '111111', kind: 'friend', name: '甲', at, lastAt: at })
  e.gatekeeper.pending.set('222222', { userId: '222222', kind: 'friend', name: '乙', at, lastAt: at })
  const handled = await e.tryDirectReplyToPending({
    ev: { user_id: OWNER },
    task: '回复他「在吗」',
    key: OWNER,
  })
  const toOwner = e._sent.find((s) => s.uid === OWNER)
  eq(handled, true)
  eq(e._sent.some((s) => s.uid === '111111' || s.uid === '222222'), false, '不确定时不能发')
  eq(/2 个待批好友申请/.test(toOwner?.text || ''), true)
  return true
})

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`)
try {
  fs.rmSync(dir, { recursive: true, force: true })
} catch {}
process.exit(fail === 0 ? 0 : 1)

