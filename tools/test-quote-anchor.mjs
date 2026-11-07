/*
 * lib/quote-at.js 单测（2026-10-25，主人 m02736 / m02835）。
 * 纯函数，不连 QQ、不碰配置，直接跑：
 *   node out\_quote_at_test.mjs
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  isPureNudge,
  crowdStats,
  recentSpeakers,
  lastOtherMessage,
  resolveExplicitAt,
  pickQuoteTarget,
} from '../plugin/dsh-qq-whale/lib/quote-at.js'

const SELF = '111111111'
let pass = 0
let fail = 0

function ok(name, cond, extra = '') {
  if (cond) {
    pass++
  } else {
    fail++
    console.log(`FAIL ${name}${extra ? ' :: ' + extra : ''}`)
  }
}

function ev({ segs, messageId = '900001', group = '666666666', userId = '222222222' } = {}) {
  return {
    message_type: group ? 'group' : 'private',
    message_id: messageId,
    group_id: group,
    user_id: userId,
    message: segs || [{ type: 'text', data: { text: '今天好热啊' } }],
    raw_message: '',
  }
}

/** 造一条 conv.history 记录 */
function h({ role = 'user', userId = '222222222', who = 'example', messageId = '800001', at = Date.now(), kind = 'text' } = {}) {
  return { role, userId, who, messageId, at, kind, scene: 'group_mention' }
}

// ── 1. isPureNudge ─────────────────────────────────────────
ok('纯 @ 算叫醒', isPureNudge(ev({ segs: [{ type: 'at', data: { qq: SELF } }] })))
ok('@ + 空白算叫醒', isPureNudge(ev({ segs: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: '  ' } }] })))
ok('@ + 句子不算叫醒', !isPureNudge(ev({ segs: [{ type: 'at', data: { qq: SELF } }, { type: 'text', data: { text: ' 你看这个' } }] })))
/*
 * 2026-11-07 改口：纯图片不算「叫醒」——图片本身就是内容。
 * 旧用例断言 isPureNudge(纯图片) === true，而那正是「引用挂到别人旧消息」的病根。
 */
ok('纯图片不算叫醒（2026-11-07 修正）', !isPureNudge(ev({ segs: [{ type: 'image', data: { file: 'a.jpg' } }] })))
ok('只有标点算叫醒', isPureNudge(ev({ segs: [{ type: 'text', data: { text: '？？……' } }] })))
ok('raw_message 兜底', isPureNudge({ message_id: 1, raw_message: '[CQ:at,qq=1] ' }))
ok('普通句子不算叫醒', !isPureNudge(ev({ segs: [{ type: 'text', data: { text: '今天好热' } }] })))

// ── 2. crowdStats ─────────────────────────────────────────
{
  const now = Date.now()
  const hist = [
    h({ userId: '1', messageId: 'a', at: now - 2 * 60 * 1000 }), // 窗口外
    h({ userId: '2', messageId: 'b', at: now - 20 * 1000 }),
    h({ userId: '3', messageId: 'c', at: now - 15 * 1000 }),
    h({ userId: '2', messageId: 'd', at: now - 8 * 1000 }),
    h({ role: 'assistant', userId: '', messageId: 'self-1', at: now - 5 * 1000 }), // 自己的不算
    h({ userId: '4', messageId: 'e', at: now - 3 * 1000 }),
  ]
  const c = crowdStats(hist, now, { windowSeconds: 30 })
  ok('crowdStats 只数 30 秒内别人的', c.count === 4 && c.speakers === 3, JSON.stringify(c))
  ok('crowdStats 空历史', crowdStats([], now).count === 0)
  ok('crowdStats 老消息时间戳缺失跳过', crowdStats([{ role: 'user', userId: '1' }], now).count === 0)
}

// ── 3. recentSpeakers ─────────────────────────────────────
{
  const hist = []
  for (let i = 0; i < 25; i++) hist.push(h({ userId: String(1000 + i), messageId: String(i), at: Date.now() }))
  const set = recentSpeakers(hist, 20)
  ok('recentSpeakers 只回看 20 条', set.size === 20 && !set.has('1000'), [...set].join(','))
}

// ── 4. lastOtherMessage ───────────────────────────────────
{
  const hist = [
    h({ userId: '1', messageId: '111', at: Date.now() - 9000 }),
    h({ userId: '2', messageId: '222', at: Date.now() - 8000 }),
    { role: 'assistant', userId: '', who: 'Molly', messageId: 'self-169', at: Date.now() - 7000, kind: 'text' },
  ]
  const t = lastOtherMessage(hist)
  ok('lastOtherMessage 跳过自己', t && t.messageId === '222', JSON.stringify(t))
  ok('lastOtherMessage 空历史', lastOtherMessage([]) === null)
}

// ── 5. resolveExplicitAt ──────────────────────────────────
{
  const now = Date.now()
  const hist = [
    h({ userId: '2048141088', who: '響爷', messageId: '501', at: now - 5000 }),
    h({ userId: '2335879786', who: '春风吹过', messageId: '502', at: now - 4000 }),
  ]
  ok('recent 说话人 → 认', resolveExplicitAt({ raw: '2048141088', history: hist, selfId: SELF })?.qq === '2048141088')
  ok('长期不在场 → 丢', resolveExplicitAt({ raw: '99999999', history: hist, selfId: SELF }) === null)
  ok('不能 @ 自己', resolveExplicitAt({ raw: SELF, history: hist, selfId: SELF }) === null)
  ok('非数字 → 丢', resolveExplicitAt({ raw: '@abc', history: hist, selfId: SELF }) === null)
  const oldHist = [h({ userId: '2048141088', who: '響爷', messageId: '777', at: now - 600000 })]
  for (let i = 0; i < 25; i++) oldHist.push(h({ userId: String(3000 + i), messageId: String(900 + i), at: now - i * 1000 }))
  ok('旧账号但正文点了名 → 认', resolveExplicitAt({
    raw: '2048141088',
    history: oldHist,
    selfId: SELF,
    text: '響爷问的那个谁强谁弱啊',
  })?.why === 'named')
  ok('旧账号但没点名 → 丢', resolveExplicitAt({
    raw: '2048141088',
    history: oldHist,
    selfId: SELF,
    text: '我觉得还行',
  }) === null)
}

// ── 6. pickQuoteTarget ────────────────────────────────────
{
  const now = Date.now()
  const idle = [
    h({ userId: '1', who: '甲', messageId: '601', at: now - 300000 }),
    h({ userId: '2', who: '乙', messageId: '602', at: now - 240000 }),
  ]
  const crowded = [
    h({ userId: '1', who: '甲', messageId: '701', at: now - 20000 }),
    h({ userId: '2', who: '乙', messageId: '702', at: now - 15000 }),
    h({ userId: '1', who: '甲', messageId: '703', at: now - 10000 }),
  ]
  const gEv = ev({ messageId: '700', group: '666666666' })
  ok('私聊不引用', pickQuoteTarget({ ev: ev({ group: null }), history: crowded, config: {}, nowMs: now }) === null)
  ok('不拥挤不引用', pickQuoteTarget({ ev: gEv, history: idle, config: {}, nowMs: now }) === null)
  const c = pickQuoteTarget({ ev: gEv, history: crowded, config: {}, nowMs: now })
  ok('拥挤 → 引触发消息', c && c.messageId === '700' && c.why.includes('crowded'), JSON.stringify(c))
  const n = pickQuoteTarget({
    ev: ev({ segs: [{ type: 'at', data: { qq: SELF } }], messageId: '710' }),
    history: idle,
    config: {},
    nowMs: now,
  })
  ok('纯叫醒 → 引上一条别人的', n && n.messageId === '602' && n.why.includes('nudge'), JSON.stringify(n))
  const e = pickQuoteTarget({ ev: gEv, history: idle, config: {}, nowMs: now, explicitAt: '1' })
  ok('显式点名 → 引用', e && e.why.includes('explicit-at'), JSON.stringify(e))
  ok('配置关闭 → 不引用', pickQuoteTarget({ ev: gEv, history: crowded, config: { groupQuoteReply: false }, nowMs: now }) === null)
  ok('阈值可调：调高后不拥挤', pickQuoteTarget({
    ev: gEv,
    history: crowded,
    config: { groupQuoteMinMessages: 10 },
    nowMs: now,
  }) === null)
}

// ── 7. anchor（2026-11-06，主人 m00215「为什么总是回下一条」）─────
{
  const now = Date.now()
  // 现场复刻：主人 18:09:46 问一句 → 18:09:54 又发一张图 → 33 秒后她回出来
  const burst = [
    h({ userId: '10086', who: '主人', messageId: '801', at: now - 41000 }), // 正题
    h({ userId: '10086', who: '主人', messageId: '802', at: now - 33000 }), // 表情图（触发这一轮）
    h({ userId: '1', who: '甲', messageId: '803', at: now - 20000 }),
    h({ userId: '2', who: '乙', messageId: '804', at: now - 10000 }),
    h({ userId: '3', who: '丙', messageId: '805', at: now - 5000 }),
  ]
  const gEv = ev({ messageId: '802', group: '666666666', userId: '10086' })
  const plain = pickQuoteTarget({ ev: gEv, history: burst, config: {}, nowMs: now })
  ok('无 anchor 时旧逻辑会引最新那条（漏洞本体）', plain && plain.messageId === '805', JSON.stringify(plain))
  const anchored = pickQuoteTarget({ ev: gEv, history: burst, config: {}, nowMs: now, anchorId: '801' })
  ok('有 anchor → 引正题那条', anchored && anchored.messageId === '801', JSON.stringify(anchored))
  ok('有 anchor → anchored=true 且 gap 如实算出', anchored && anchored.anchored === true && anchored.gap === 4, JSON.stringify(anchored))
  ok('有 anchor → why 里带 anchor', anchored && anchored.why.includes('anchor'), String(anchored?.why))
  // anchor 不在历史里（被裁剪）→ 不能因此不引用，退回原逻辑
  const missing = pickQuoteTarget({ ev: gEv, history: burst, config: {}, nowMs: now, anchorId: '999' })
  ok('anchor 失效时不崩、仍给得出目标', missing && Boolean(missing.messageId), JSON.stringify(missing))
  // explicit-at 优先级更高（模型点名的那个人才是真正要接的）
  const exp = pickQuoteTarget({ ev: gEv, history: burst, config: {}, nowMs: now, anchorId: '801', explicitAt: '3' })
  ok('explicit-at 仍压过 anchor', exp && exp.messageId === '805' && exp.anchored === false, JSON.stringify(exp))
}

// ── 8. nudge 不能落到「下一条」上（2026-11-06）─────────────
{
  const now = Date.now()
  const hist = [
    h({ userId: '10086', who: '主人', messageId: '811', at: now - 30000 }),
    h({ userId: '10086', who: '主人', messageId: '812', at: now - 20000 }), // 纯 @（叫醒那条，也在历史里）
    h({ userId: '2', who: '乙', messageId: '813', at: now - 5000 }),        // 之后别人又说一句
  ]
  const n = pickQuoteTarget({
    ev: ev({ segs: [{ type: 'at', data: { qq: SELF } }], messageId: '812', userId: '10086' }),
    history: hist,
    config: {},
    nowMs: now,
  })
  ok('叫醒 → 引叫他那个人自己上一条（不是乙的下一条）', n && n.messageId === '811', JSON.stringify(n))
}

// ── 9. 纯图片/语音触发不能引到「上一条别人的消息」（2026-11-07，主人 m01382）──
{
  const now = Date.now()
  // 现场复刻（群 666666666）：17:18:52 主人发了张动图；17:20:49 管理员只发一张截图触发这一轮。
  // 旧逻辑把这张截图当「空叫醒」→ 引到 17:18:52 别人那张动图上，答的和引的对不上。
  const hist = [
    h({ userId: '222222222', who: '主人', messageId: '821', at: now - 120000 }),
    h({ userId: '222222222', who: '主人', messageId: '822', at: now - 110000 }), // 别人的旧动图
    h({ userId: '208197338', who: '管理员', messageId: '823', at: now - 2000 }), // 截图（触发这条）
  ]
  const shot = ev({
    segs: [{ type: 'image', data: { file: 'shot.jpg', sub_type: 0 } }],
    messageId: '823',
    userId: '208197338',
  })
  ok('纯图片不算叫醒', !isPureNudge(shot))
  const t = pickQuoteTarget({ ev: shot, history: hist, config: {}, nowMs: now })
  ok('纯图片触发 → 引这张图本身，不引别人两分钟前的动图', t && t.messageId === '823' && t.why.includes('media'), JSON.stringify(t))
  ok('纯图片触发的 why 里没有 nudge', t && !t.why.includes('nudge'), String(t && t.why))
  // 语音 / 文件 / 转发 / 动画表情同理，都算「有内容」
  ok('语音算有内容', !isPureNudge(ev({ segs: [{ type: 'record', data: { file: 'a.amr' } }] })))
  ok('文件算有内容', !isPureNudge(ev({ segs: [{ type: 'file', data: { file: 'a.pdf' } }] })))
  ok('转发算有内容', !isPureNudge(ev({ segs: [{ type: 'forward', data: { id: '1' } }] })))
  ok('动画表情（image sub_type=1）算有内容', !isPureNudge(ev({ segs: [{ type: 'image', data: { file: 'st.gif', sub_type: 1 } }] })))
  // 只有小表情、只有 @ 仍然算叫醒（老行为不变）
  ok('只有表情仍是叫醒', isPureNudge(ev({ segs: [{ type: 'face', data: { id: '12' } }] })))
  // raw_message 兜底也要认图片
  ok('raw_message 里是图片 → 不算叫醒', !isPureNudge({ message_id: 2, raw_message: '[CQ:image,file=abc.jpg,subType=0]' }))
  // 图片已经被刷过去两条以上 → 退回最新那条（作答时读的就是最新历史）
  const late = [
    h({ userId: '1', who: '甲', messageId: '831', at: now - 20000 }),
    h({ userId: '208197338', who: '管理员', messageId: '832', at: now - 15000 }), // 截图
    h({ userId: '2', who: '乙', messageId: '833', at: now - 10000 }),
    h({ userId: '3', who: '丙', messageId: '834', at: now - 2000 }),
  ]
  const lateT = pickQuoteTarget({
    ev: ev({ segs: [{ type: 'image', data: { file: 's.jpg' } }], messageId: '832', userId: '208197338' }),
    history: late,
    config: {},
    nowMs: now,
  })
  ok('图片被刷过去多条 → 引最新那条', lateT && lateT.messageId === '834', JSON.stringify(lateT))
}

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail ? 1 : 0)
