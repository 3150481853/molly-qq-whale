/**
 * task-54 真机验收（第二版）：预算表 ↔ 网关 usage.jsonl 的**行级**对账。
 *
 * ── 第一版为什么废了 ───────────────────────────────────────────────
 * 第一版拿「budget.calls 增量」比「网关 /usage 的 requests 增量」。这个口径
 * 天生不成立：网关是 Molly + 这个 DSH 会话 + WorkBuddy 三方共用的，requests
 * 是三方总和，比值再接近也只说明"本地记的没超过总和"，没有任何归因意义。
 * 它还把宿主端口写死成 7053，而宿主端口每次重启都会变（见 STATE.md 第 4 节
 * 第 1 条），所以 10-21 这天它已经跑不通了。
 *
 * ── 第二版怎么做 ───────────────────────────────────────────────────
 * 不再碰 /usage 的全局计数，也不再需要面板密码。改为直接读网关落盘的
 * usage.jsonl，一行 = 一次真实调用，按行认领：
 *
 *   1. chat / spare 这类**走 wb-proxy** 的通道：插件把这行原样记下来；
 *      所以只要能在 JSONL 里找到"这一行"，就能逐字段比对。
 *      认领凭证是 msgs_sha —— 网关用
 *        h(obj) = sha256(json.dumps(obj, ensure_ascii=False, sort_keys=True))[:12]
 *      给整段消息算的哈希。插件侧 /dsh-qq-whale/chat/test 探针会用同一算法
 *      在本地复刻一遍并回传，于是探针和 JSONL 行可以对上号。
 *   2. degraded 走 trae、不经过 wb-proxy → JSONL 里**永远不会有**它的行。
 *      这是结构性事实（engine.js 的 degraded 分支记 provider:'trae'），
 *      不是漏记，对不上是正常的。
 *   3. work / code / research 走宿主 agent 跑，宿主**不透出 usage** →
 *      插件只记 calls，tokens 恒为 null（budget.js 的 tokensKnown 能自证）。
 *      这类通道只能对次数，不能对 token。
 *
 * ── 用法 ───────────────────────────────────────────────────────────
 *   node tools/test-budget-live.mjs state             # 打一份预算快照
 *   node tools/test-budget-live.mjs chat              # 打一发真实 chat 探针并当场对账
 *   node tools/test-budget-live.mjs chat --text "…"   # 同上，自定义探针内容
 *   node tools/test-budget-live.mjs work --task "…"   # 打一发 work，验证"只多一次、token 仍 null"
 *   node tools/test-budget-live.mjs slices --date 2026-10-21  # 按 system_sha 分组的账本切片
 *   node tools/test-budget-live.mjs verify            # 复核 out/budget-recon.jsonl 里所有探针收据
 *   node tools/test-budget-live.mjs report            # 各通道结论表（= slices + verify 的摘要）
 *
 * 选项：--base http://127.0.0.1:2160 强制指定宿主地址；--json 输出机器可读结果。
 *
 * 只读网关账本、只调插件的自检路由；**不发 QQ 消息**（work 探针固定 send:false）。
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const OUT = '${MOLLY_ROOT}/qq-whale/out'
const RECEIPT_FILE = path.join(OUT, 'budget-recon.jsonl')
// 网关账本：workbuddy2api-hub 落盘的那份 usage.jsonl
const USAGE_LOG = process.env.WB_USAGE_LOG || 'D:/workbuddy2api-hub/usage/usage.jsonl'
// 控制台（19392）自己会把宿主端口探出来放在 /api/overview 的 plugin.base
const CONSOLE = process.env.MOLLY_CONSOLE || 'http://127.0.0.1:19392'
// 控制台也挂了的时候的兜底候选（别指望它准，这只是手边几个）
const FALLBACK_BASES = ['http://127.0.0.1:2160', 'http://127.0.0.1:7053']
const USAGE_TAIL_BYTES = 4 * 1024 * 1024 // 一天二百多行，4MB 足够，不必读整份

const argv = process.argv.slice(2)
const cmd = argv[0] || 'report'
const flag = (name, dflt = '') => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const has = (name) => argv.includes(`--${name}`)
const AS_JSON = has('json')

/* ────────────────────────── HTTP ────────────────────────── */

function req(base, method, urlPath, body, timeoutMs = 120000) {
  return new Promise((resolve) => {
    let u
    try {
      u = new URL(urlPath, base)
    } catch (e) {
      resolve({ ok: false, error: `地址不合法：${base}${urlPath}` })
      return
    }
    const data = body === undefined ? null : JSON.stringify(body)
    const r = http.request(
      {
        host: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method,
        timeout: timeoutMs,
        headers: data
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        let b = ''
        res.on('data', (c) => (b += c))
        res.on('end', () => {
          let parsed = null
          try {
            parsed = JSON.parse(b)
          } catch {
            /* 非 JSON 交回去自己看 */
          }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, code: res.statusCode, raw: b, json: parsed })
        })
      },
    )
    r.on('timeout', () => r.destroy(new Error('timeout')))
    r.on('error', (e) => resolve({ ok: false, error: e.message }))
    if (data) r.write(data)
    r.end()
  })
}

/**
 * 找到宿主现在的地址。
 *
 * 为什么不写死端口：宿主端口每次重启都变（STATE.md 第 4 节第 1 条），上一版
 * 就是死在这里。控制台一直在探，问它最省事；控制台也挂了才退回手写候选。
 */
async function findBase() {
  const forced = flag('base', process.env.MOLLY_PLUGIN_BASE || '')
  if (forced) {
    // 手指定了就照用，连得上连不上让后面的命令自己报错，免得悄悄换端口去测别的东西
    const r = await req(forced, 'GET', '/dsh-qq-whale/state', undefined, 8000)
    const hit = Boolean(r.json)
    return {
      base: forced.replace(/\/$/, ''),
      via: '--base',
      ok: hit,
      error: hit ? '' : `指定地址连不上：${r.error || `HTTP ${r.code}`}`,
    }
  }
  const ov = await req(CONSOLE, 'GET', '/api/overview', undefined, 8000)
  const b = ov.json?.plugin?.base
  if (b) return { base: String(b).replace(/\/$/, ''), via: 'console /api/overview', ok: ov.json.plugin.reachable !== false }
  for (const cand of FALLBACK_BASES) {
    const r = await req(cand, 'GET', '/dsh-qq-whale/state', undefined, 4000)
    if (r.json?.budget) return { base: cand, via: 'fallback 候选', ok: true }
  }
  return {
    base: '',
    via: 'none',
    ok: false,
    error:
      '找不到宿主。先看控制台 http://127.0.0.1:19392/api/overview 的 plugin.base，' +
      '再用 --base 指定（别去设 MOLLY_PLUGIN_BASE，那是给别处用的）',
  }
}

/* ────────────────────────── 预算 & 账本 ────────────────────────── */

function budgetOf(state) {
  const b = state?.budget || {}
  return {
    calls: b.calls ?? 0,
    credit: b.credit ?? 0,
    tokens: b.tokens ?? 0,
    tokensKnown: b.tokensKnown ?? 0,
    date: b.date || '',
    byChannel: b.byChannel || {},
  }
}

function channelOf(budget, ch) {
  return budget.byChannel?.[ch] || { calls: 0, credit: 0, tokens: null }
}

/** 读 usage.jsonl 的尾巴（够覆盖当天全部调用），返回解析后的行 + 文件元信息 */
function readUsageRows() {
  if (!fs.existsSync(USAGE_LOG)) return { ok: false, rows: [], error: `账本不存在：${USAGE_LOG}` }
  const size = fs.statSync(USAGE_LOG).size
  const start = Math.max(0, size - USAGE_TAIL_BYTES)
  const fd = fs.openSync(USAGE_LOG, 'r')
  const buf = Buffer.alloc(size - start)
  try {
    fs.readSync(fd, buf, 0, buf.length, start)
  } finally {
    fs.closeSync(fd)
  }
  let text = buf.toString('utf8')
  if (start > 0) text = text.slice(text.indexOf('\n') + 1) // 掐掉被切断的首行
  const rows = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      /* 半行/坏行跳过 */
    }
  }
  return {
    ok: true,
    rows,
    file: USAGE_LOG,
    size,
    truncatedFromStart: start > 0,
    from: rows.length ? rows[0].iso : null,
    to: rows.length ? rows[rows.length - 1].iso : null,
  }
}

const sameDay = (iso, date) => String(iso || '').startsWith(date)

/** 按 system_sha 分组，给 slices / 精确命中判定用 */
function groupBySystem(rows) {
  const map = new Map()
  for (const r of rows) {
    const k = r.system_sha || '(no-system)'
    let g = map.get(k)
    if (!g) {
      g = { sha: k, calls: 0, credit: 0, tokens: 0, realms: {}, models: {}, nMsgs: [], first: r.iso, last: r.iso }
      map.set(k, g)
    }
    g.calls += 1
    g.credit += Number(r.credit) || 0
    g.tokens += Number(r.total_tokens) || 0
    g.realms[r.realm || '(none)'] = (g.realms[r.realm || '(none)'] || 0) + 1
    g.models[r.model || '(none)'] = (g.models[r.model || '(none)'] || 0) + 1
    if (r.n_msgs != null && !g.nMsgs.includes(r.n_msgs)) g.nMsgs.push(r.n_msgs)
    if (r.iso > g.last) g.last = r.iso
  }
  for (const g of map.values()) {
    g.credit = Math.round(g.credit * 10000) / 10000
    g.nMsgs.sort((a, b) => a - b)
  }
  return [...map.values()].sort((a, b) => b.calls - a.calls)
}

const fmtRealms = (o) =>
  Object.entries(o)
    .map(([k, v]) => `${k}:${v}`)
    .join('/')

/** credit 换成整数万分位，避免浮点比较 */
const creditUnits = (x) => Math.round((Number(x) || 0) * 10000)

/** 子集和：找若干组，让 calls / credit / tokens 三者和恰好等于预算桶 */
function subsetSum(cands, target, start = 0, cur = null, depthLeft = 4) {
  const acc = cur || { calls: 0, credit: 0, tokens: 0, items: [] }
  if (acc.items.length && acc.calls === target.calls && acc.credit === target.credit && acc.tokens === target.tokens) {
    return acc.items
  }
  if (depthLeft === 0) return null
  for (let i = start; i < cands.length; i += 1) {
    const g = cands[i]
    const next = {
      calls: acc.calls + g.calls,
      credit: acc.credit + creditUnits(g.credit),
      tokens: acc.tokens + g.tokens,
      items: [...acc.items, g],
    }
    if (next.calls > target.calls || next.credit > target.credit || next.tokens > target.tokens) continue
    const hit = subsetSum(cands, target, i + 1, next, depthLeft - 1)
    if (hit) return hit
  }
  return null
}

/**
 * 在分组里找一个「跟某个预算桶逐字段吻合」的组，或者一组组的和。
 * 只对拿得到 tokens 的桶有意义（work 这种 tokens=null 的永远找不到，也不该找）。
 *
 * 为什么需要"几发之和"：spare / chat 每发各成一个 sha 组（系统提示不同），
 * 而 budget 桶是累计值。spare 现在是 2 发（3580+3839 token、0.10+0.11 积分），
 * 只做单组匹配必然 NONE —— 那是匹配器的毛病，不是账的毛病。
 */
function matchBucket(groups, bucket) {
  if (!bucket || bucket.tokens == null) return { kind: 'no-tokens' }
  const hits = groups.filter(
    (g) => g.calls === bucket.calls && Math.abs(g.credit - bucket.credit) < 1e-6 && g.tokens === bucket.tokens,
  )
  if (hits.length === 1) return { kind: 'exact', group: hits[0] }
  if (hits.length > 1) return { kind: 'ambiguous', groups: hits }
  // 再试"几发之和"。只在小桶上做（calls>6 组合爆炸，且真对上了也说服不了人）。
  if (bucket.calls > 6) return { kind: 'none' }
  const target = { calls: bucket.calls, credit: creditUnits(bucket.credit), tokens: bucket.tokens }
  const cands = groups
    .filter((g) => g.calls <= bucket.calls && g.tokens > 0 && g.tokens <= bucket.tokens && creditUnits(g.credit) <= target.credit)
    .sort((a, b) => b.calls - a.calls || b.tokens - a.tokens)
  const found = subsetSum(cands, target)
  if (found) return { kind: 'sum', groups: found }
  return { kind: 'none' }
}

/* ────────────────────────── 探针 ────────────────────────── */

function appendReceipt(rec) {
  fs.mkdirSync(OUT, { recursive: true })
  fs.appendFileSync(RECEIPT_FILE, JSON.stringify(rec) + '\n', 'utf8')
}

function readReceipts() {
  if (!fs.existsSync(RECEIPT_FILE)) return []
  return fs
    .readFileSync(RECEIPT_FILE, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

async function probeChat(base, text) {
  const before = await req(base, 'GET', '/dsh-qq-whale/state', undefined, 10000)
  if (!before.json?.budget) return { ok: false, error: `读不到预算：${before.error || before.code || ''}` }
  const b0 = budgetOf(before.json)

  const body = { text: text || '对账探针-请只回两个字' }
  const r = await req(base, 'POST', '/dsh-qq-whale/chat/test', body, 120000)
  if (!r.json) return { ok: false, error: `探针无响应：${r.error || r.code}` }

  const after = await req(base, 'GET', '/dsh-qq-whale/state', undefined, 10000)
  const b1 = budgetOf(after.json)
  const c0 = channelOf(b0, 'chat')
  const c1 = channelOf(b1, 'chat')

  const rec = {
    kind: 'chat',
    at: new Date().toISOString(),
    base,
    ok: Boolean(r.json.ok),
    text: String(r.json.text ?? ''),
    error: r.json.error || '',
    model: r.json.model || '',
    probe: r.json.probe || null,
    usage: r.json.usage || null,
    ms: r.json.ms,
    budgetBefore: c0,
    budgetAfter: c1,
    delta: { calls: c1.calls - c0.calls, tokens: (c1.tokens || 0) - (c0.tokens || 0) },
  }
  return rec
}

/** 拿探针收据去 usage.jsonl 里认领那一行，并逐字段比对 */
function reconcileChat(rec, usage) {
  const out = { probe: rec.probe, checks: [], row: null }
  const sha = rec.probe?.msgs_sha
  if (!sha) {
    out.checks.push({ name: '探针回执里有 msgs_sha', pass: false, detail: '探针没回 msgs_sha，无法认领' })
    return out
  }
  const hits = usage.rows.filter((r) => r.msgs_sha === sha)
  if (!hits.length) {
    out.checks.push({
      name: '按 msgs_sha 在 usage.jsonl 里找到这一次调用',
      pass: false,
      detail: `${sha} 在账本里找不到（账本只读了尾部 ${Math.round(USAGE_TAIL_BYTES / 1024 / 1024)}MB，确认没超出）`,
    })
    return out
  }
  if (hits.length > 1) {
    out.checks.push({
      name: 'msgs_sha 唯一',
      pass: false,
      detail: `${sha} 命中 ${hits.length} 行 —— 同样的消息被发过不止一次，取最后一行比对`,
    })
  }
  const row = hits[hits.length - 1]
  out.row = row
  const u = rec.usage || {}
  const eq = (a, b) => Number(a ?? 0) === Number(b ?? 0)
  out.checks.push({
    name: 'prompt/completion/total/credit 与网关行一致',
    pass:
      eq(u.prompt_tokens, row.prompt_tokens) &&
      eq(u.completion_tokens, row.completion_tokens) &&
      eq(u.total_tokens, row.total_tokens) &&
      eq(u.credit, row.credit),
    detail: `插件 ${u.prompt_tokens ?? '-'}/${u.completion_tokens ?? '-'}/${u.total_tokens ?? '-'}/${u.credit ?? '-'} · 网关 ${row.prompt_tokens}/${row.completion_tokens}/${row.total_tokens}/${row.credit}`,
  })
  out.checks.push({
    name: 'budget.chat 次数 +1',
    pass: rec.delta?.calls === 1,
    detail: `calls ${rec.budgetBefore?.calls} → ${rec.budgetAfter?.calls}`,
  })
  out.checks.push({
    name: 'budget.chat token 增量 = 网关 total_tokens',
    pass: Number(rec.delta?.tokens) === Number(row.total_tokens),
    detail: `插件 +${rec.delta?.tokens} · 网关 ${row.total_tokens}`,
  })
  out.checks.push({
    name: 'budget.chat credit 增量 = 网关 credit',
    pass: Number((rec.budgetAfter?.credit ?? 0) - (rec.budgetBefore?.credit ?? 0)) === Number(row.credit),
    detail: `插件 +${((rec.budgetAfter?.credit ?? 0) - (rec.budgetBefore?.credit ?? 0)).toFixed(4)} · 网关 ${row.credit}`,
  })
  out.checks.push({
    name: 'n_msgs 一致（探针复刻的拼接顺序对）',
    pass: Number(rec.probe?.n_msgs) === Number(row.n_msgs),
    detail: `探针 ${rec.probe?.n_msgs} · 网关 ${row.n_msgs}`,
  })
  out.checks.push({
    name: 'system_sha 一致（同一段系统提示）',
    pass: String(rec.probe?.system_sha || '') === String(row.system_sha || ''),
    detail: `探针 ${rec.probe?.system_sha || '-'} · 网关 ${row.system_sha || '-'}`,
  })
  return out
}

/* ────────────────────────── 输出 ────────────────────────── */

const okMark = (b) => (b ? 'PASS' : 'FAIL')
// 收据里存的是 UTC（toISOString），打给人看要换回本地，不然和网关的 iso 差 8 小时对不上眼
const localStamp = (iso) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? String(iso || '') : d.toLocaleString('sv-SE', { hour12: false })
}
const line = (s = '') => console.log(s)
const bar = () => line('─'.repeat(72))

function printChecks(title, checks) {
  line(title)
  for (const c of checks) line(`  ${okMark(c.pass).padEnd(5)} ${c.name}${c.detail ? `\n        ${c.detail}` : ''}`)
}

/* ────────────────────────── 命令 ────────────────────────── */

async function main() {
  const found = await findBase()
  if (!found.base) {
    line(`✗ ${found.error}`)
    process.exit(2)
  }
  const base = found.base

  if (cmd === 'state') {
    const s = await req(base, 'GET', '/dsh-qq-whale/state', undefined, 10000)
    if (AS_JSON) return line(JSON.stringify({ base, via: found.via, budget: s.json?.budget }, null, 2))
    line(`宿主 ${base}  （来源：${found.via}）`)
    line(JSON.stringify(s.json?.budget, null, 2))
    return
  }

  if (cmd === 'chat') {
    line(`宿主 ${base}  （来源：${found.via}）`)
    const rec = await probeChat(base, flag('text', ''))
    if (rec.error) {
      line(`✗ ${rec.error}`)
      process.exit(1)
    }
    const usage = readUsageRows()
    if (!usage.ok) {
      line(`✗ ${usage.error}`)
      line(`  探针本身已发出，但没法对账：插件 chat calls ${rec.budgetBefore?.calls} → ${rec.budgetAfter?.calls}`)
      process.exit(1)
    }
    const res = reconcileChat(rec, usage)
    if (AS_JSON) {
      line(JSON.stringify({ rec, ...res }, null, 2))
    } else {
      bar()
      line(`chat 探针：ok=${rec.ok}  model=${rec.model}  ${rec.ms}ms  回包=${JSON.stringify(rec.text)}`)
      if (rec.error) line(`  错误：${rec.error}`)
      line(`  网关行：${res.row ? `${res.row.iso}  ${res.row.realm}  ${res.row.model}  credit=${res.row.credit}` : '未认领到'}`)
      bar()
      printChecks('对账检查', res.checks)
    }
    const pass = res.checks.length > 0 && res.checks.every((c) => c.pass)
    appendReceipt({ ...rec, reconciled: pass, row: res.row, checks: res.checks })
    line('')
    line(pass ? `✓ chat 通道对账通过（收据已写 ${RECEIPT_FILE}）` : `✗ chat 通道对账没通过（收据已写 ${RECEIPT_FILE}）`)
    process.exit(pass ? 0 : 1)
  }

  if (cmd === 'work') {
    const task = flag('task', '对账探针：只回复"好"两个字，不要做别的事')
    line(`宿主 ${base}  （来源：${found.via}）`)
    const before = budgetOf((await req(base, 'GET', '/dsh-qq-whale/state', undefined, 10000)).json)
    line(`work 前：calls=${channelOf(before, 'work').calls} tokens=${JSON.stringify(channelOf(before, 'work').tokens)}`)
    const startedAt = Date.now()
    const r = await req(base, 'POST', '/dsh-qq-whale/work/run', { task, send: false }, 300000)
    const elapsed = Date.now() - startedAt
    const after = budgetOf((await req(base, 'GET', '/dsh-qq-whale/state', undefined, 10000)).json)
    const w0 = channelOf(before, 'work')
    const w1 = channelOf(after, 'work')
    bar()
    line(`work 回包：ok=${r.json?.ok}  ${elapsed}ms  ${String(r.json?.text || r.json?.error || '').slice(0, 160)}`)
    const checks = [
      {
        name: 'work 次数 +1',
        pass: w1.calls - w0.calls === 1,
        detail: `calls ${w0.calls} → ${w1.calls}`,
      },
      {
        name: 'work 的 tokens 仍然是 null（宿主不透出 usage → 只能对次数）',
        pass: w1.tokens === null,
        detail: `tokens=${JSON.stringify(w1.tokens)}  tokensKnown=${after.tokensKnown}`,
      },
    ]
    printChecks('对账检查', checks)
    const pass = checks.every((c) => c.pass)
    appendReceipt({ kind: 'work', at: new Date().toISOString(), base, task, ok: Boolean(r.json?.ok), budgetBefore: w0, budgetAfter: w1, checks })
    line('')
    line(
      pass
        ? '✓ work 通道确认：只记次数。网关那一侧的行没法归因到这条 work（宿主 agent 走的是 DSH 自己的会话），所以 token 对不了 —— 这是结构性限制。'
        : '✗ work 通道的行为和预期不符',
    )
    process.exit(pass ? 0 : 1)
  }

  if (cmd === 'slices' || cmd === 'report') {
    const date = flag('date', new Date().toLocaleDateString('sv-SE')) // sv-SE == YYYY-MM-DD
    const usage = readUsageRows()
    if (!usage.ok) {
      line(`✗ ${usage.error}`)
      process.exit(1)
    }
    const todays = usage.rows.filter((r) => sameDay(r.iso, date))
    const groups = groupBySystem(todays)
    const st = await req(base, 'GET', '/dsh-qq-whale/state', undefined, 10000)
    const budget = budgetOf(st.json)

    if (AS_JSON) {
      line(JSON.stringify({ base, date, budget, groups, header: { from: usage.from, to: usage.to } }, null, 2))
      return
    }

    line(`宿主 ${base}  （来源：${found.via}）`)
    line(`网关账本 ${usage.file}  ${date} 共 ${todays.length} 行 / ${groups.length} 组系统提示`)
    /*
     * outcome 分布必须打出来：失败的调用（429/超时）在账本里也占一行，但**没有**
     * token 字段；本地那边同样是 calls+1、tokens=null。两边口径一致，所以
     * 「本地 calls 比 completed 行数多」不是丢账，是失败也计数。
     */
    const outcomes = {}
    for (const r of todays) outcomes[r.outcome || '(none)'] = (outcomes[r.outcome || '(none)'] || 0) + 1
    const oc = Object.entries(outcomes)
      .map(([k, v]) => `${k}:${v}`)
      .join('  ')
    line(`outcome 分布：${oc}    （failed / client_aborted 行没有 token 字段）`)
    bar()
    line('按 system_sha 分组（同一段系统提示 = 同一类调用方）')
    line('  sha           次数   积分       token       realm         n_msgs')
    for (const g of groups.slice(0, 15)) {
      line(
        `  ${g.sha.padEnd(13)} ${String(g.calls).padStart(4)}  ${String(g.credit).padStart(8)}  ${String(g.tokens).padStart(9)}  ` +
          `${fmtRealms(g.realms).padEnd(12)}  ${g.nMsgs.length ? `${g.nMsgs[0]}~${g.nMsgs[g.nMsgs.length - 1]}` : '-'}`,
      )
    }
    if (groups.length > 15) line(`  … 另有 ${groups.length - 15} 组（都是零散几行）`)

    bar()
    line('预算桶 ↔ 账本分组 精确命中检查')
    // 探针自己的调用走的就是 chat 通道（callModel → recordUsage channel:'chat'），
    // 所以它们也算在 budget.chat 里 —— 这部分能被 msgs_sha 逐发认领，先从桶里摘出来再谈"剩下的"。
    const probeShas = new Set(readReceipts().map((r) => r.probe?.system_sha).filter(Boolean))
    for (const ch of Object.keys(budget.byChannel)) {
      const bucket = channelOf(budget, ch)
      const m = matchBucket(groups, bucket)
      let verdict
      let detail = ''
      if (m.kind === 'exact') {
        verdict = 'PASS 逐字段吻合'
        const g = m.group
        detail = `sha=${g.sha} realm=${fmtRealms(g.realms)} n_msgs=${g.nMsgs.join(',')}`
      } else if (m.kind === 'sum') {
        verdict = `PASS ${m.groups.length} 发之和逐字段吻合`
        detail = m.groups.map((g) => `${g.sha}(${g.tokens}/${g.credit})`).join(' + ')
      } else if (m.kind === 'ambiguous') {
        verdict = `WARN ${m.groups.length} 组都能对上`
        detail = m.groups.map((g) => g.sha).join(' ')
      } else if (m.kind === 'no-tokens') {
        verdict = 'SKIP 该通道没有 token（结构性：宿主不透出 usage）'
      } else {
        verdict = 'NONE 单靠哈希分组对不上'
        detail = '系统提示随会话/时间变化，每次调用各成一个 sha 组 —— 用 chat 探针做行级认领'
      }
      line(`  ${ch.padEnd(9)} calls=${String(bucket.calls).padStart(3)} credit=${String(bucket.credit).padStart(6)} tokens=${String(bucket.tokens).padStart(7)}  →  ${verdict}`)
      if (detail) line(`             ${detail}`)
      if (ch === 'chat' && probeShas.size) {
        const claimed = groups.filter((g) => probeShas.has(g.sha))
        if (claimed.length) {
          const cc = claimed.reduce((s, g) => s + g.calls, 0)
          const ct = claimed.reduce((s, g) => s + g.tokens, 0)
          line(`             其中 ${cc} 次 / ${ct} token 已被探针逐发认领（sha=${claimed.map((g) => g.sha).join(',')}）`)
          line(`             剩下 ${bucket.calls - cc} 次 / ${(bucket.tokens || 0) - ct} token 混在真实聊天里，每发各成一个 sha 组`)
        }
      }
    }
    const deg = channelOf(budget, 'degraded')
    line(`  degraded  calls=${deg.calls}  →  SKIP 永不落 wb-proxy 账本（走 trae，engine.js 记 provider:'trae'）`)

    if (cmd === 'report') {
      bar()
      const receipts = readReceipts()
      line(`探针收据 ${RECEIPT_FILE}：共 ${receipts.length} 条`)
      let bad = 0
      for (const r of receipts.slice(-8)) {
        const pass = r.checks ? r.checks.every((c) => c.pass) : Boolean(r.reconciled)
        if (!pass) bad += 1
        const id = r.kind === 'chat' ? `chat ${r.probe?.msgs_sha || '-'}` : 'work'
        line(`  ${okMark(pass).padEnd(5)} ${localStamp(r.at).padEnd(19)}  ${id.padEnd(18)} ${r.row ? r.row.iso : ''}`)
      }
      if (receipts.length > 8) line(`  … 只显示最近 8 条`)
      bar()
      line('结论（写进 STATE.md 的是这一版）')
      line('  · spare   ：结构上走 wb-proxy，逐字段可对（credit/tokens/calls 三项全中即 PASS）')
      line('  · chat    ：走 wb-proxy，可用 chat 探针按 msgs_sha 行级认领，能对 token 和积分')
      line('  · work    ：宿主 agent 不透出 usage → 只对次数，token 恒 null')
      line('  · degraded：走 trae（ctx.llm 的 trae 适配器，engine.js:316-331），不经 wb-proxy，账本里永远没有它')
      line('  · 失败调用：账本落 outcome=failed 行（无 token 字段），本地 calls+1 且 tokens=null —— 口径一致，')
      line('             所以 budget.tokens 是**下限**，budget.calls 才是完整次数')
      line('  · 第一版的「budget.calls vs 网关 /usage.requests」作废：三条腿共用一个网关，比值无归因意义')
      if (bad) {
        line('')
        line(`✗ 有 ${bad} 条收据没通过`)
        process.exit(1)
      }
    }
    return
  }

  if (cmd === 'verify') {
    const usage = readUsageRows()
    if (!usage.ok) {
      line(`✗ ${usage.error}`)
      process.exit(1)
    }
    const receipts = readReceipts().filter((r) => r.kind === 'chat' && r.probe?.msgs_sha)
    if (!receipts.length) {
      line(`没有 chat 探针收据（${RECEIPT_FILE}）。先跑：node tools/test-budget-live.mjs chat`)
      process.exit(0)
    }
    let bad = 0
    for (const rec of receipts) {
      const res = reconcileChat(rec, usage)
      const pass = res.checks.every((c) => c.pass)
      if (!pass) bad += 1
      line(`${okMark(pass)}  ${localStamp(rec.at).padEnd(19)}  msgs_sha=${rec.probe.msgs_sha}  ${res.row ? `${res.row.iso} total=${res.row.total_tokens}` : '未认领'}`)
      if (!pass) for (const c of res.checks.filter((c) => !c.pass)) line(`       ✗ ${c.name}：${c.detail || ''}`)
    }
    line('')
    line(bad ? `✗ ${bad}/${receipts.length} 条收据复核失败` : `✓ ${receipts.length} 条收据全部复核通过`)
    process.exit(bad ? 1 : 0)
  }

  line(`未知命令：${cmd}`)
  line('可用：state | chat | work | slices | verify | report')
  process.exit(2)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
