/**
 * test-quote.mjs — 验证 P3「引用消息取回被引用正文」。
 *
 * 用 node 全路径跑（PATH 里没有 node）：
 *   ${HOME}\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe \
 *     qq-whale\tools\test-quote.mjs
 *
 * 测试原则（踩过的坑，别改）：假客户端必须是 `Object.create(OneBotClient.prototype)`。
 * 早前 test-gatekeeper.mjs 用自造接口的假客户端，把「engine 调 callApi 而类里没有」这个
 * 真实 bug 盖了半年。这里同理：可以替换 `ws`（网络层），但**不伪造 call() 本身的语义**，
 * 这样测的才是真代码路径。
 */

import { OneBotClient, normalizeMessage, fetchQuoted, QUOTE_TEXT_MAX, QUOTE_TIMEOUT_MS, QUOTE_FAIL_TEXT } from '../plugin/dsh-qq-whale/lib/onebot.js'

let pass = 0
let fail = 0
const failures = []

function eq(actual, expected, label) {
  if (Object.is(actual, expected)) {
    pass++
  } else {
    fail++
    failures.push(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}
function ok(cond, label) {
  eq(Boolean(cond), true, label)
}
function section(name) {
  console.log(`\n— ${name}`)
}

/**
 * 造一个"连着"的客户端：真原型 + 假 ws。
 * ws.send 收到 action 后，用 handleMessage 回一帧真响应 —— 走的是真实 call() 逻辑
 * （echo 匹配、pending 登记、retcode 判定、超时定时器），不是手搓接口。
 */
function makeClient({ data, retcode = 0, status = 'ok', hang = false, onSend } = {}) {
  const c = Object.create(OneBotClient.prototype)
  c.state = 'online'
  c.pending = new Map()
  c.echoSeq = 0
  c.logger = () => {}
  c.ws = {
    readyState: 1,
    send(raw) {
      const req = JSON.parse(raw)
      if (onSend) onSend(req)
      if (hang) return // 故意不回：测 3 秒超时
      const frame = JSON.stringify({
        status,
        retcode,
        echo: req.echo,
        ...(retcode === 0 ? { data } : { wording: '消息不存在' }),
      })
      setImmediate(() => c.handleMessage({ data: frame }))
    },
  }
  return c
}

/** NapCat get_msg 的真实形状（group 场景） */
function getMsgFixture(over = {}) {
  return {
    message_id: 987654,
    message_type: 'group',
    group_id: 666666666,
    raw_message: '',
    sender: { user_id: 123456789, nickname: '小明', card: '群里的明哥' },
    message: [
      { type: 'reply', data: { id: '111222' } }, // 嵌套引用，取回时应跳过
      { type: 'text', data: { text: '这个链接里有你要的答案' } },
      { type: 'image', data: { file: 'abc.jpg' } },
      { type: 'face', data: { id: '178' } },
      { type: 'record', data: { file: 'x.amr' } },
    ],
    ...over,
  }
}

// ─────────────────────────────────────────────────────────────
section('1. normalizeMessage 保留 replyTo（接线的输入）')
{
  const norm = normalizeMessage(
    [
      { type: 'reply', data: { id: '987654' } },
      { type: 'text', data: { text: '你看这个' } },
    ],
    '111111111',
  )
  eq(norm.replyTo, '987654', 'replyTo 取出 message_id')
  ok(norm.text.includes('[引用]'), '正文里有 [引用] 标记（旧行为，保留）')
}

// ─────────────────────────────────────────────────────────────
section('2. fetchQuoted 走真实 call() 取回正文')
{
  const sent = []
  const c = makeClient({ data: getMsgFixture(), onSend: (r) => sent.push(r) })
  const q = await fetchQuoted(c, '987654')
  eq(sent.length, 1, '只发了一次 action')
  eq(sent[0].action, 'get_msg', '调的是 get_msg')
  eq(sent[0].params.message_id, 987654, 'message_id 传成数字（OneBot 要 int）')
  eq(q.ok, true, 'ok=true')
  eq(q.name, '群里的明哥', '群名片优先于昵称')
  eq(q.uid, '123456789', '带回发送者 QQ 号')
  eq(q.body, '这个链接里有你要的答案[图片][表情][语音]', '文本+图片/表情/语音占位，嵌套 reply 跳过')
  eq(q.text, '[引用 @群里的明哥：这个链接里有你要的答案[图片][表情][语音]]', 'text 可直接当前缀用')
}

section('3. 私聊无群名片 → 退回昵称；无名片无昵称 → QQ号')
{
  const c1 = makeClient({
    data: getMsgFixture({ sender: { user_id: 42, nickname: '阿呆', card: '' }, message: [{ type: 'text', data: { text: '在吗' } }] }),
  })
  const q1 = await fetchQuoted(c1, 1)
  eq(q1.name, '阿呆', 'card 为空串时用 nickname')

  const c2 = makeClient({
    data: getMsgFixture({ sender: { user_id: 42, nickname: '' }, message: [{ type: 'text', data: { text: '在吗' } }] }),
  })
  const q2 = await fetchQuoted(c2, 1)
  eq(q2.name, 'QQ42', '两个名字都没有时用 QQ 号兜底')
}

section('4. 超长正文截断到 200 字')
{
  const long = '啊'.repeat(500)
  const c = makeClient({ data: getMsgFixture({ message: [{ type: 'text', data: { text: long } }] }) })
  const q = await fetchQuoted(c, 1)
  eq(q.body.length, QUOTE_TEXT_MAX, `body 长度 = ${QUOTE_TEXT_MAX}`)
  ok(q.body.endsWith('…'), '截断处有省略号')
  ok(q.text.length <= QUOTE_TEXT_MAX + 20, '整条引用文本没有失控')
}

section('5. get_msg 失败（retcode≠0）→ 降级文案，不抛')
{
  const c = makeClient({ retcode: 1200, status: 'failed' })
  let threw = null
  let q
  try {
    q = await fetchQuoted(c, '123')
  } catch (e) {
    threw = e
  }
  eq(threw, null, '没有抛异常')
  eq(q.ok, false, 'ok=false')
  eq(q.text, QUOTE_FAIL_TEXT, '文案是中约定的降级文案')
}

section('6. get_msg 抛异常 → 同样降级，不抛')
{
  const c = Object.create(OneBotClient.prototype)
  c.state = 'online'
  c.call = async () => {
    throw new Error('boom')
  }
  let threw = null
  let q
  try {
    q = await fetchQuoted(c, '123')
  } catch (e) {
    threw = e
  }
  eq(threw, null, '没有抛异常')
  eq(q.ok, false, 'ok=false')
  eq(q.text, QUOTE_FAIL_TEXT, '降级文案一致')
}

section('7. 3 秒超时 → 降级，不无限等')
{
  const c = makeClient({ hang: true })
  // call() 的超时定时器是 unref 的（线上有 ws 撑着事件循环，测试里没有），
  // 不挂一个 ref 定时器的话 node 会以为没活干直接退出，测不到超时分支。
  const keepAlive = setInterval(() => {}, 250)
  const t0 = Date.now()
  let q
  try {
    q = await fetchQuoted(c, '123')
  } finally {
    clearInterval(keepAlive)
  }
  const dt = Date.now() - t0
  eq(q.ok, false, '超时后 ok=false')
  ok(dt >= QUOTE_TIMEOUT_MS - 200, `等了约 ${QUOTE_TIMEOUT_MS}ms（实际 ${dt}ms）`)
  ok(dt < QUOTE_TIMEOUT_MS + 1500, '没有拖到 20 秒的 ACTION_TIMEOUT')
}

section('8. 参数非法时不发请求')
{
  let calls = 0
  const c = makeClient({ data: getMsgFixture(), onSend: () => calls++ })
  eq((await fetchQuoted(c, '')).ok, false, '空 id → 降级')
  eq(calls, 0, '空 id 不调 get_msg')
  eq((await fetchQuoted(null, '123')).ok, false, 'client 为空 → 降级')
  eq((await fetchQuoted({}, '123')).ok, false, 'client 没有 call() → 降级')
}

section('9. 字符串形式的 message（NapCat string 格式）也能解析')
{
  const c = makeClient({
    data: getMsgFixture({ message: '看[CQ:image,file=a.jpg]这个[CQ:face,id=1]' }),
  })
  const q = await fetchQuoted(c, 1)
  eq(q.body, '看[图片]这个[表情]', 'CQ 码转占位')
}

section('10. 空消息 / 脏返回不崩')
{
  const c1 = makeClient({ data: getMsgFixture({ message: [] }) })
  eq((await fetchQuoted(c1, 1)).body, '[空消息]', '空 message → [空消息]')

  const c2 = makeClient({ data: null })
  const q = await fetchQuoted(c2, 1)
  eq(q.ok, false, 'data=null → 降级')
  eq(q.text, QUOTE_FAIL_TEXT, '降级文案')
}

// ─────────────────────────────────────────────────────────────
console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (failures.length) {
  console.log('\n失败明细：')
  for (const f of failures) console.log('  ✗ ' + f)
  process.exitCode = 1
} else {
  console.log('全部通过 ✓')
}
