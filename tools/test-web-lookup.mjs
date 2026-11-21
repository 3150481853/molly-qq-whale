// 「查一下」工具（web_lookup）的离线单测：不发网络，全靠注入的 stub。
//
// 起因（主人 m04129–m04132 转来的群截图）：她断言「Anthropic 还没上市吧」，
// 而它 11-19 就上市了、发行价正好 83 美元。聊天面此前把 web_search 全禁掉了，
// 这一层补的是只读搜索；测试要盯住的是「别把失败/空结果说成答案」。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WEB_LOOKUP_TOOL_NAME,
  DEFAULT_LIMIT,
  normalizeQuery,
  clampLimit,
  formatLookupText,
  webLookup,
  buildWebLookupTool,
  registerWebLookupTool,
} from '../plugin/dsh-qq-whale/lib/web-lookup.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
let pass = 0
let fail = 0
function ok(label, cond, extra = '') {
  if (cond) {
    pass += 1
    console.log(`PASS ${label}`)
  } else {
    fail += 1
    console.log(`FAIL ${label}${extra ? `  (${extra})` : ''}`)
  }
}

/* ── ① 关键词与条数 ───────────────────────────────────────────── */
ok('工具名是 web_lookup', WEB_LOOKUP_TOOL_NAME === 'web_lookup')
ok('默认 3 条', DEFAULT_LIMIT === 3)
ok('空值 → 空串', normalizeQuery(undefined) === '' && normalizeQuery(null) === '')
ok('换行/空格压缩成一行', normalizeQuery('  Anthropic\n\n 上市   发行价 ') === 'Anthropic 上市 发行价')
ok('超长截到 120 字', normalizeQuery('鱼'.repeat(300)).length === 120)
ok('limit 缺省 3', clampLimit(undefined) === 3 && clampLimit('abc') === 3)
ok('limit 下限 1', clampLimit(0) === 1 && clampLimit(-5) === 1)
ok('limit 上限 5', clampLimit(99) === 5)
ok('limit 字符串数字', clampLimit('2') === 2)

/* ── ② 排版 ──────────────────────────────────────────────────── */
const sample = [
  { title: 'Anthropic 上市全解析：83 美元定价', url: 'https://example.com/a', snippet: '11 月 19 日在纳斯达克上市' },
  { title: '发行价定在每股 83 美元', url: 'https://example.com/b', snippet: '估值 1.5 万亿美元' },
]
const text2 = formatLookupText('Anthropic 上市', sample, { ms: 294 })
ok('排版含查询词', text2.includes('Anthropic 上市'))
ok('排版含两条标题', text2.includes('Anthropic 上市全解析') && text2.includes('发行价定在每股 83 美元'))
ok('排版带序号 1. / 2.', text2.includes('1. ') && text2.includes('2. '))
ok('排版带链接', text2.includes('https://example.com/a'))
ok('排版声明是摘要', text2.includes('网页摘要'))
ok('空结果给收口话', formatLookupText('莫须有', []).includes('没搜到'))

/* ── ③ 执行体：成功 / 空 / 抛错 ─────────────────────────────────── */
const okSearch = async (q, { limit }) => ({
  ok: true,
  query: q,
  provider: 'bing-rss',
  ms: 300,
  results: sample.slice(0, limit),
})
{
  const r = await webLookup('Anthropic 上市 发行价', { search: okSearch })
  ok('正常查询 ok=true', r.ok === true && r.query === 'Anthropic 上市 发行价')
  ok('正常查询含标题', r.text.includes('83 美元'))
}
{
  let seenLimit = null
  await webLookup('x', { limit: 9, search: async (q, o) => ((seenLimit = o.limit), { results: [] }) })
  ok('越界 limit 被收成 5', seenLimit === 5)
}
{
  const r = await webLookup('   ', { search: okSearch })
  ok('空查询不发网络且给提示', r.ok === false && r.text.includes('查什么'))
}
{
  const r = await webLookup('x', { search: async () => ({ results: [] }) })
  ok('搜到 0 条也算查过（ok=true 但提示没搜到）', r.ok === true && r.text.includes('没搜到'))
}
{
  const r = await webLookup('x', {
    search: async () => {
      throw new Error('TypeError: fetch failed')
    },
  })
  ok('搜索抛错 → ok=false', r.ok === false)
  ok('失败文案不超 90 字（群里不能刷屏）', r.text.length <= 90, `len=${r.text.length}`)
  ok('失败文案叫人别编', r.text.includes('没查到') || r.text.includes('别编'))
}

/* ── ④ 工具定义形状 ──────────────────────────────────────────── */
const tool = buildWebLookupTool({ search: okSearch })
ok('工具名一致', tool.name === 'web_lookup')
ok('参数只要 query 必填', tool.parameters.required.join(',') === 'query')
ok('参数有 limit', !!tool.parameters.properties.limit)
ok('描述教你主动查', tool.description.includes('该主动用'))
ok('描述写了不该查什么', tool.description.includes('不该用的'))
ok('描述点了「Anthropic 还没上市吧」这句事故', tool.description.includes('还没上市'))
ok('render 回 text 块', Array.isArray(tool.output.render({}, { text: 'hi' })) && tool.output.render({}, { text: 'hi' })[0].type === 'text')
{
  const r = await tool.execute({ query: 'x' })
  ok('execute 正常', r.ok === true && typeof r.text === 'string')
}
{
  const r = await tool.execute({})
  ok('execute 空参数不炸', r.ok === false && r.text.includes('查什么'))
}
{
  const bad = buildWebLookupTool({
    getConfig: () => {
      throw new Error('boom')
    },
    search: okSearch,
  })
  const r = await bad.execute({ query: 'x' })
  ok('getConfig 抛错也能查', r.ok === true)
}

/* ── ⑤ 注册降级 ──────────────────────────────────────────────── */
{
  const res = registerWebLookupTool({ ctx: {}, logger() {} })
  ok('没有 tools 服务 → 不注册也不抛', res.status.registered === false && res.status.error.length > 0)
  ok('没有 dispose', res.dispose === null)
}
{
  const disposeSpy = { called: 0 }
  const res = registerWebLookupTool({
    ctx: { get: () => ({ register: () => () => (disposeSpy.called += 1) }) },
    logger() {},
  })
  ok('注册成功', res.status.registered === true)
  ok('回 dispose 函数', typeof res.dispose === 'function')
  res.dispose()
  ok('dispose 真的调到了', disposeSpy.called === 1)
}
{
  const res = registerWebLookupTool({
    ctx: { get: () => ({ register: () => { throw new Error('name taken') } }) },
    logger() {},
  })
  ok('注册抛错也不炸', res.status.registered === false && res.status.error.includes('name taken'))
}

/* ── ⑥ 聊天面 deny 清单里不能有这个名字 ────────────────────────── */
{
  const src = fs.readFileSync(path.join(HERE, '..', 'plugin', 'dsh-qq-whale', 'lib', 'commands.js'), 'utf8')
  const m = /CHAT_DENY_TOOLS\s*=\s*Object\.freeze\(\[([\s\S]*?)\]\)/.exec(src)
  const denied = m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []
  ok('能读到 CHAT_DENY_TOOLS', denied.length > 0, `n=${denied.length}`)
  ok('web_lookup 没被 deny（否则注册了也看不见）', !denied.includes('web_lookup'))
  ok('宿主的 web_search 仍被 deny（文件/整页那套照旧禁）', denied.includes('web_search'))
}

/* ── ⑦ persona 里要有这两条规矩 ───────────────────────────────── */
{
  const src = fs.readFileSync(path.join(HERE, '..', 'plugin', 'dsh-qq-whale', 'lib', 'persona.js'), 'utf8')
  ok('persona 有「事实先查再答」', src.includes('# 事实先查再答'))
  ok('persona 有「被指正的时候」', src.includes('# 被指正的时候'))
  ok('persona 点名 web_lookup', src.includes('web_lookup'))
  ok('persona 禁了「行，那我闭嘴」', src.includes('行，那我闭嘴'))
}

console.log(`\n${pass} 过 / ${fail} 挂`)
process.exit(fail ? 1 : 0)
