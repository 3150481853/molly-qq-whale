/**
 * `lib/qqtools.js` 的离线测试。
 *
 * 这个模块没有网络、没有宿主依赖，所以可以直接在 node 里跑，
 * 不用起 DSH、不用连 NapCat。用法：
 *     node tools/test-qqtools.mjs
 *     QQTOOLS_MODULE=<别的路径> node tools/test-qqtools.mjs
 *
 * 为什么先写测试再上线：`ctx.tools.register()` 对 schema 的要求是 DSH 私有的
 * 一套规则（嵌套 object 必须写 additionalProperties、default export 必须真存在……），
 * 一旦 schema 不合格，插件是**静默**注册不上的。schema 长什么样只能靠这里断言住。
 */
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'

const target =
  process.env.QQTOOLS_MODULE ||
  'C:/Users/example/.dsh/profiles/desktop/node_modules/dsh-qq-whale/lib/qqtools.js'

/*
 * Windows 上 `import()` 只认 file:// URL。直接写 `D:/...` 会报
 * ERR_UNSUPPORTED_ESM_URL_SCHEME（protocol 'd:'）——踩过一次，记在这儿。
 */
const spec = /^[A-Za-z]:[\\/]/.test(target) ? pathToFileURL(target).href : target
const mod = await import(spec)
const { buildQqTool, groupCardsReport, registerQqTool, QQ_TOOL_NAME, ACTIONS } = mod

let pass = 0
let fail = 0
const failures = []
function ok(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass++
    })
    .catch((err) => {
      fail++
      failures.push(`${name} :: ${err?.message || err}`)
    })
}

/** 造一个假 OneBotClient。成员列表可定制，call() 记录被调了什么。 */
function fakeClient({ members = [], state = 'online', throwOn = null } = {}) {
  const calls = []
  return {
    state,
    calls,
    getGroupMemberList(groupId) {
      calls.push(['get_group_member_list', groupId])
      return Promise.resolve(members)
    },
    call(action, params) {
      calls.push([action, params])
      if (throwOn === action) return Promise.reject(new Error('No such request'))
      return Promise.resolve({ ok: true, action })
    },
  }
}

const MEMBERS = [
  { user_id: 1001, nickname: '甲', card: 'Molly', role: 'member' },
  { user_id: 1002, nickname: '乙', card: 'Molly', role: 'member' },
  { user_id: 1003, nickname: '丙', card: '', role: 'admin' },
  { user_id: 1004, nickname: '丁', card: '丁丁', role: 'member' },
]

// ———————————————— 1. 工具定义形状 ————————————————
await ok('工具名是 qq_onebot', () => {
  const t = buildQqTool({ getClient: () => null })
  assert.equal(t.name, QQ_TOOL_NAME)
  assert.equal(t.name, 'qq_onebot')
})

await ok('parameters 是编译后的 JSON Schema（object + properties + required 数组）', () => {
  const t = buildQqTool({ getClient: () => null })
  assert.equal(t.parameters.type, 'object')
  assert.equal(typeof t.parameters.properties, 'object')
  assert.ok(Array.isArray(t.parameters.required), 'required 必须是数组，不是 property 里的 required:true')
  assert.deepEqual(t.parameters.required, ['action'])
  assert.equal(t.parameters.properties.action.type, 'string')
  assert.ok(Array.isArray(t.parameters.properties.action.enum))
  assert.deepEqual(t.parameters.properties.action.enum, Object.keys(ACTIONS))
})

await ok('output 带 schema + render，且 schema 的 required 是数组', () => {
  const t = buildQqTool({ getClient: () => null })
  assert.ok(t.output && typeof t.output.render === 'function')
  assert.equal(t.output.schema.type, 'object')
  assert.equal(t.output.schema.additionalProperties, false)
  assert.deepEqual(t.output.schema.required, ['ok', 'action', 'text'])
  const rendered = t.output.render({}, { ok: true, action: 'x', text: 'hello' })
  assert.deepEqual(rendered, [{ type: 'text', text: 'hello' }])
})

await ok('render 对空值不炸', () => {
  const t = buildQqTool({ getClient: () => null })
  assert.deepEqual(t.output.render({}, null), [{ type: 'text', text: '' }])
})

// ———————————————— 2. groupCardsReport ————————————————
await ok('groupCardsReport 能找出重复群名片', async () => {
  const c = fakeClient({ members: MEMBERS })
  const r = await groupCardsReport(c, '666666666')
  assert.equal(r.ok, true)
  assert.match(r.text, /共 4 人/)
  assert.match(r.text, /有 1 组重复/)
  assert.match(r.text, /「Molly」× 2：1001、1002/)
  assert.match(r.text, /完整名单/)
})

await ok('groupCardsReport 没重复时说没重复', async () => {
  const c = fakeClient({ members: [MEMBERS[0], MEMBERS[3]] })
  const r = await groupCardsReport(c, '1')
  assert.match(r.text, /没有重复的群名片/)
})

await ok('groupCardsReport 没群名片时退化成昵称比对', async () => {
  const members = [
    { user_id: 1, nickname: '同名', card: '' },
    { user_id: 2, nickname: '同名', card: '' },
  ]
  const r = await groupCardsReport(fakeClient({ members }), '1')
  assert.match(r.text, /「同名」× 2/)
})

await ok('groupCardsReport 空列表给明确说明', async () => {
  const r = await groupCardsReport(fakeClient({ members: [] }), '1')
  assert.match(r.text, /成员列表是空的/)
})

await ok('groupCardsReport 超长列表会截断', async () => {
  const members = Array.from({ length: 150 }, (_, i) => ({ user_id: 10000 + i, nickname: `n${i}`, card: '' }))
  const r = await groupCardsReport(fakeClient({ members }), '1')
  assert.match(r.text, /还有 30 人没列出来/)
})

// ———————————————— 3. execute 的失败路径（都必须给人话） ————————————————
const offline = buildQqTool({ getClient: () => null })
await ok('没客户端时说不清楚而不是崩', async () => {
  const r = await offline.execute({ action: 'get_login_info' })
  assert.equal(r.ok, false)
  assert.match(r.text, /还没建起来/)
})

await ok('QQ 掉线时说是掉线，不是「我没这能力」', async () => {
  const t = buildQqTool({ getClient: () => fakeClient({ state: 'reconnecting' }) })
  const r = await t.execute({ action: 'get_login_info' })
  assert.equal(r.ok, false)
  assert.match(r.text, /没连上/)
})

await ok('不支持的动作列出可用动作', async () => {
  const t = buildQqTool({ getClient: () => fakeClient() })
  const r = await t.execute({ action: 'set_group_ban' })
  assert.equal(r.ok, false)
  assert.match(r.text, /不支持的动作/)
  assert.match(r.text, /group_cards/)
})

await ok('漏参数明确点名缺哪个', async () => {
  const t = buildQqTool({ getClient: () => fakeClient() })
  const r = await t.execute({ action: 'get_group_member_info', group_id: '123' })
  assert.equal(r.ok, false)
  assert.match(r.text, /缺少参数：user_id/)
})

await ok('非数字群号被拦下', async () => {
  const t = buildQqTool({ getClient: () => fakeClient() })
  const r = await t.execute({ action: 'get_group_member_list', group_id: 'abc' })
  assert.match(r.text, /必须是一串数字/)
})

await ok('card 允许空字符串（清空群名片）', async () => {
  const c = fakeClient()
  const t = buildQqTool({ getClient: () => c })
  const r = await t.execute({ action: 'set_group_card', group_id: '1', user_id: '2', card: '' })
  assert.equal(r.ok, true)
  assert.deepEqual(c.calls[0], ['set_group_card', { group_id: '1', user_id: '2', card: '' }])
})

// ———————————————— 4. execute 的正常路径 ————————————————
await ok('group_cards 走本地计算，不往 OneBot 透传', async () => {
  const c = fakeClient({ members: MEMBERS })
  const t = buildQqTool({ getClient: () => c })
  const r = await t.execute({ action: 'group_cards', group_id: '666666666' })
  assert.equal(r.ok, true)
  assert.match(r.text, /「Molly」× 2/)
  assert.deepEqual(c.calls, [['get_group_member_list', '666666666']])
})

await ok('get_group_member_list 正确拼参数', async () => {
  const c = fakeClient({ members: MEMBERS })
  const t = buildQqTool({ getClient: () => c })
  await t.execute({ action: 'get_group_member_list', group_id: '666666666' })
  assert.deepEqual(c.calls[0], ['get_group_member_list', { group_id: '666666666' }])
})

await ok('count 默认 50、上限 200（P5 把默认从 20 提到 50）', async () => {
  const c = fakeClient()
  const t = buildQqTool({ getClient: () => c })
  await t.execute({ action: 'get_group_msg_history', group_id: '1' })
  assert.equal(c.calls[0][1].count, 50)
  await t.execute({ action: 'get_group_msg_history', group_id: '1', count: '9999' })
  assert.equal(c.calls[1][1].count, 200)
  await t.execute({ action: 'get_group_msg_history', group_id: '1', count: '30' })
  assert.equal(c.calls[2][1].count, 30, '调用方显式传的 count 要生效')
})

await ok('message_id 转成数字（撤回要数字）', async () => {
  const c = fakeClient()
  const t = buildQqTool({ getClient: () => c })
  await t.execute({ action: 'delete_msg', message_id: '123456' })
  assert.equal(c.calls[0][1].message_id, 123456)
})

await ok('发消息带 CQ 码原样传', async () => {
  const c = fakeClient()
  const t = buildQqTool({ getClient: () => c })
  await t.execute({ action: 'send_group_msg', group_id: '1', message: '[CQ:at,qq=222222222] 在吗' })
  assert.equal(c.calls[0][1].message, '[CQ:at,qq=222222222] 在吗')
})

await ok('OneBot 报错时把它的话带出来', async () => {
  const t = buildQqTool({ getClient: () => fakeClient({ throwOn: 'delete_msg' }) })
  const r = await t.execute({ action: 'delete_msg', message_id: '1' })
  assert.equal(r.ok, false)
  assert.match(r.text, /No such request/)
})

// ———————————————— 5. registerQqTool 的容错 ————————————————
await ok('registerQqTool 没有 tools 服务时返回状态而不是抛错', () => {
  const { status, dispose } = registerQqTool({ ctx: {}, getClient: () => null })
  assert.equal(status.registered, false)
  assert.match(status.error, /tools/)
  assert.equal(dispose, null)
})

await ok('registerQqTool 注册成功时把 disposer 交出来', () => {
  const registered = []
  const ctx = {
    get(name) {
      if (name !== 'tools') return undefined
      return { register: (def) => { registered.push(def.name); return () => {} } }
    },
  }
  const { status, dispose } = registerQqTool({ ctx, getClient: () => null })
  assert.equal(status.registered, true)
  assert.deepEqual(registered, ['qq_onebot'])
  assert.equal(typeof dispose, 'function')
})

await ok('registerQqTool 捕获注册异常并记进状态', () => {
  const ctx = { get: () => ({ register() { throw new Error('bad schema') } }) }
  const { status, dispose } = registerQqTool({ ctx, getClient: () => null })
  assert.equal(status.registered, false)
  assert.match(status.error, /bad schema/)
  assert.equal(dispose, null)
})

console.log(`\nqqtools: ${pass} passed, ${fail} failed`)
if (fail > 0) {
  for (const f of failures) console.log('  ✗ ' + f)
  process.exit(1)
}
