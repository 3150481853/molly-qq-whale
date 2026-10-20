#!/usr/bin/env node
/**
 * 群名片实时状态的离线单测。
 *
 * 起因（用户 m18386「群昵称重复了」）：
 *   群 666666666 里她的群名片一直停在「Molly（在想…）」，其它群都是空名片。
 *   而 getGroupCardBase() 抓基准时读到的是这个**脏值**，下一次改就成了
 *   「Molly（在想…）（在想…）」—— 后缀越叠越多。
 *
 * 两条根因：
 *   ① 抓基准不剥后缀 → 污染基准；
 *   ② 插件重载后 groupCardBusy 清空 → restoreGroupCard 直接 return → 永远卡住。
 *
 * 用法：node test-groupcard.mjs
 * 数据不落盘、不连 QQ、不调模型。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const INSTALL = process.env.QQWHALE_LIB || 'C:/Users/example/.dsh/profiles/desktop/node_modules/dsh-qq-whale/lib'

let pass = 0
let fail = 0
const failures = []
const t = (name, fn) => {
  try {
    const r = fn()
    if (r === false) throw new Error('返回 false')
    pass++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    fail++
    failures.push(`${name} :: ${e.message}`)
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
    failures.push(`${name} :: ${e.message}`)
    console.log(`  ✗ ${name}  → ${e.message}`)
  }
}
const eq = (a, b, msg = '') => {
  if (String(a) !== String(b)) throw new Error(`${msg} 期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}`)
}

const engineMod = await import(`file:///${INSTALL}/engine.js`)
const ChatEngine = engineMod.ChatEngine || engineMod.default
if (!ChatEngine) throw new Error('engine.js 没导出 ChatEngine')
const onebotMod = await import(`file:///${INSTALL}/onebot.js`)
const { OneBotClient } = onebotMod

const SELF = '111111111'

/**
 * 造一个只装群名片逻辑的假 engine。
 * 客户端**继承真实 OneBotClient 原型**（只覆写 set/call 这类真发请求的方法），
 * 免得又出现「测试自己发明接口」把 bug 盖住。
 *
 * @param {object} opts
 * @param {object} opts.cards   { groupId: 当前群名片 }
 * @param {string[]} opts.groups 群号列表
 * @param {boolean} [opts.failSet] 改名片时抛错
 */
function makeEngine({ cards = {}, groups = Object.keys(cards), failSet = false, config = {} } = {}) {
  const eng = Object.create(ChatEngine.prototype)
  eng.config = { groupCardStatusEnabled: true, groupCardThinkingSuffix: '（在想…）', groupCardCooldownMs: 0, ...config }
  eng.selfId = SELF
  eng.logger = () => {}
  eng.groupCardBase = new Map()
  eng.groupCardLastChange = new Map()
  eng.groupCardBusy = new Map()

  const client = Object.create(OneBotClient.prototype)
  client.state = 'online'
  client.self = { userId: Number(SELF), nickname: 'Molly' }
  client.getGroupList = async () => groups.map((g) => ({ group_id: Number(g), group_name: `群${g}` }))
  client.getGroupMemberInfo = async (gid) => ({ user_id: Number(SELF), nickname: 'Molly', card: cards[gid] ?? '' })
  client.setGroupCard = async (gid, uid, card) => {
    if (failSet) throw new Error('boom')
    cards[gid] = card
    return { ok: true }
  }
  eng.client = client
  eng._cards = cards
  return eng
}

console.log('\n【1】stripGroupCardSuffix 剥后缀')
const e0 = makeEngine()
t('单个后缀', () => eq(e0.stripGroupCardSuffix('Molly（在想…）'), 'Molly'))
t('叠了两个后缀', () => eq(e0.stripGroupCardSuffix('Molly（在想…）（在想…）'), 'Molly'))
t('叠了四个后缀', () => eq(e0.stripGroupCardSuffix('Molly（在想…）（在想…）（在想…）（在想…）'), 'Molly'))
t('没有后缀原样返回', () => eq(e0.stripGroupCardSuffix('Molly'), 'Molly'))
t('空字符串', () => eq(e0.stripGroupCardSuffix(''), ''))
t('null/undefined 不炸', () => eq(e0.stripGroupCardSuffix(null), '') || eq(e0.stripGroupCardSuffix(undefined), ''))
t('其它括号内容不动', () => eq(e0.stripGroupCardSuffix('Molly（鲸鱼）'), 'Molly（鲸鱼）'))
t('自定义后缀', () => {
  const e = makeEngine({ config: { groupCardThinkingSuffix: '（忙）' } })
  eq(e.stripGroupCardSuffix('Molly（忙）（忙）'), 'Molly')
})
t('自定义后缀时内置后缀也认', () => {
  const e = makeEngine({ config: { groupCardThinkingSuffix: '（忙）' } })
  eq(e.stripGroupCardSuffix('Molly（在想…）'), 'Molly')
})

console.log('\n【2】getGroupCardBase 抓到的基准必须干净')
await ta('脏名片 → 干净基准（事故重现）', async () => {
  const e = makeEngine({ cards: { '666666666': 'Molly（在想…）' } })
  eq(await e.getGroupCardBase('666666666'), 'Molly')
})
await ta('空名片 → 用昵称当基准', async () => {
  const e = makeEngine({ cards: { '1': '' } })
  eq(await e.getGroupCardBase('1'), 'Molly')
})
await ta('自定义名片保留（鲸鱼娘）', async () => {
  const e = makeEngine({ cards: { '1': '鲸鱼娘' } })
  eq(await e.getGroupCardBase('1'), '鲸鱼娘')
})
await ta('查不到成员资料 → 昵称兜底', async () => {
  const e = makeEngine({ cards: { '1': '' } })
  e.client.getGroupMemberInfo = async () => {
    throw new Error('nope')
  }
  eq(await e.getGroupCardBase('1'), 'Molly')
})
await ta('基准只抓一次（第二次走缓存）', async () => {
  const e = makeEngine({ cards: { '1': '鲸鱼娘' } })
  let n = 0
  const orig = e.client.getGroupMemberInfo
  e.client.getGroupMemberInfo = async (...a) => {
    n += 1
    return orig(...a)
  }
  await e.getGroupCardBase('1')
  await e.getGroupCardBase('1')
  eq(n, 1)
})

console.log('\n【3】setGroupCardThinking / restoreGroupCard')
await ta('进入「在想」把后缀加上去', async () => {
  const e = makeEngine({ cards: { '1': 'Molly' } })
  await e.setGroupCardThinking('1')
  eq(e._cards['1'], 'Molly（在想…）')
})
await ta('已经在想时不会重复叠加（第二次被 busy 拦）', async () => {
  const e = makeEngine({ cards: { '1': 'Molly' } })
  await e.setGroupCardThinking('1')
  await e.setGroupCardThinking('1')
  eq(e._cards['1'], 'Molly（在想…）')
})
await ta('基准是脏值也不会叠成两个后缀（事故重现）', async () => {
  const e = makeEngine({ cards: { '1': 'Molly（在想…）' } })
  await e.setGroupCardThinking('1')
  eq(e._cards['1'], 'Molly（在想…）')
})
await ta('改名片失败后 busy 复位，下次还能再试', async () => {
  const e = makeEngine({ cards: { '1': 'Molly' }, failSet: true })
  await e.setGroupCardThinking('1')
  eq(e.groupCardBusy.get('1'), false)
})
await ta('restore 还原成干净名（而不是带着后缀）', async () => {
  const e = makeEngine({ cards: { '1': 'Molly' } })
  await e.setGroupCardThinking('1')
  await e.restoreGroupCard('1')
  eq(e._cards['1'], 'Molly')
})
await ta('restore 对没改过的群不白写', async () => {
  const e = makeEngine({ cards: { '1': '鲸鱼娘' } })
  let writes = 0
  const orig = e.client.setGroupCard
  e.client.setGroupCard = async (...a) => {
    writes += 1
    return orig(...a)
  }
  await e.restoreGroupCard('1')
  eq(writes, 0)
  eq(e._cards['1'], '鲸鱼娘')
})

console.log('\n【4】healGroupCards 自愈（重载后卡住的名片）')
await ta('卡住的群被改回干净名，正常群不动', async () => {
  const e = makeEngine({
    cards: { '666666666': 'Molly（在想…）', '756490367': 'Molly', '626021236': '' },
  })
  await e.healGroupCards()
  eq(e._cards['666666666'], 'Molly', '卡住的')
  eq(e._cards['756490367'], 'Molly', '正常的')
  eq(e._cards['626021236'], '', '空名片的不被动')
})
await ta('叠了三个后缀也能修回一个干净名', async () => {
  const e = makeEngine({ cards: { '1': 'Molly（在想…）（在想…）（在想…）' } })
  await e.healGroupCards()
  eq(e._cards['1'], 'Molly')
})
await ta('自定义名片（鲸鱼娘）带后缀被修回鲸鱼娘', async () => {
  const e = makeEngine({ cards: { '1': '鲸鱼娘（在想…）' } })
  await e.healGroupCards()
  eq(e._cards['1'], '鲸鱼娘')
})
await ta('自愈顺手把基准写进缓存，省一次查', async () => {
  const e = makeEngine({ cards: { '1': 'Molly（在想…）' } })
  await e.healGroupCards()
  eq(e.groupCardBase.get('1'), 'Molly')
})
await ta('开关关闭时自愈什么都不做', async () => {
  const e = makeEngine({ cards: { '1': 'Molly（在想…）' }, config: { groupCardStatusEnabled: false } })
  await e.healGroupCards()
  eq(e._cards['1'], 'Molly（在想…）')
})
await ta('改名片失败不会让自愈整体抛错', async () => {
  const e = makeEngine({ cards: { '1': 'Molly（在想…）', '2': 'Molly（在想…）' } })
  let first = true
  e.client.setGroupCard = async (gid, uid, card) => {
    if (first) {
      first = false
      throw new Error('boom')
    }
    e._cards[gid] = card
  }
  await e.healGroupCards()
  eq(e._cards['2'], 'Molly', '第二个还是修好了')
})

console.log(`\n${fail === 0 ? '全部通过' : '有失败'}：${pass} 通过 / ${fail} 失败`)
if (fail > 0) for (const f of failures) console.log('  - ' + f)
process.exit(fail === 0 ? 0 : 1)
