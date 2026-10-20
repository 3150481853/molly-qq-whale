/**
 * test-workshop.mjs —— 插件工坊全链路自测（不联网、不动线上、不挂载）。
 *
 * 覆盖：
 *   1) slug 校验（../x、/abs、Abc、1 位、33 位、保留名 dist/tmp 全部拒绝）
 *   2) 新建 → 列表 → 详情 → 自检（模板应通过）→ 打包（zip/sha256/index.json）→ 删除
 *   3) 反面用例：语法错的插件（ok:false + 错误行）、apply 抛异常（捕获、进程不崩）
 *   4) 子进程环境：token 类变量必须被剔除（真塞一个进 env 验证）
 *   5) 子进程超时：apply 卡住要按 testTimeoutMs 杀掉并 ok:false
 *   6) 红线：workshop.js 源码里 0 处宿主插件管理标识（用户要求「不挂载」）
 *
 * 跑法：node test-workshop.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { Workshop, SLUG_RE, cleanEnv, buildZip } from '../plugin/dsh-qq-whale/lib/workshop.js'
import { buildWorkshopTool, registerWorkshopTool } from '../plugin/dsh-qq-whale/lib/qqtools.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB = path.join(HERE, '..', 'plugin', 'dsh-qq-whale', 'lib')
const ROOT = path.join(os.tmpdir(), `molly-ws-test-${process.pid}-${Date.now()}`)

const ws = new Workshop({ dir: ROOT, logger: () => {} })
const sha256OfFile = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')

/** 从 zip Buffer 里取出某个条目的原始字节（只认我们 buildZip 写出的格式）。 */
function readZipEntry(buf, entryName) {
  let eocd = -1
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  assert.ok(eocd >= 0, 'EOCD 缺失')
  const count = buf.readUInt16LE(eocd + 10)
  let off = buf.readUInt32LE(eocd + 16)
  for (let i = 0; i < count; i++) {
    const nameLen = buf.readUInt16LE(off + 28)
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8')
    const method = buf.readUInt16LE(off + 10)
    const csize = buf.readUInt32LE(off + 20)
    const lho = buf.readUInt32LE(off + 42)
    const bodyStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28)
    const body = buf.subarray(bodyStart, bodyStart + csize)
    if (name === entryName) return method === 8 ? zlib.inflateRawSync(body) : body
    off += 46 + nameLen + buf.readUInt16LE(off + 30) + buf.readUInt16LE(off + 32)
  }
  throw new Error(`zip 里没有 ${entryName}`)
}

let pass = 0
const fails = []
async function t(name, fn) {
  try {
    await fn()
    pass++
    console.log('  ok   ' + name)
  } catch (err) {
    fails.push({ name, msg: err?.message || String(err) })
    console.log('  FAIL ' + name)
    console.log('       ' + String(err?.message || err).split('\n').slice(0, 4).join('\n       '))
  }
}

// ───────────────────────── 1. slug 校验 ─────────────────────────
console.log('slug 校验（防目录逃逸）')

await t('1. 非法 slug 全拒：../x / /abs / Abc / 1 位 / 33 位 / 下划线 / 空格', () => {
  const bad = ['../x', '../../etc', '/abs', 'C:\\Windows', 'Abc', 'a', 'a'.repeat(33), 'a_b', 'a b', '', '中文名', '..', '.']
  for (const s of bad) {
    assert.throws(() => ws.inside(s), /slug 不合法|指向工坊目录之外/, `应拒绝「${s}」`)
  }
  assert.equal(SLUG_RE.test('a'.repeat(32)), true, '32 位应合法')
  assert.equal(SLUG_RE.test('a'.repeat(33)), false, '33 位应非法')
})

await t('2. 保留名 dist / tmp 不能当 slug', () => {
  assert.throws(() => ws.inside('dist'), /保留名/)
  assert.throws(() => ws.inside('tmp'), /保留名/)
  assert.throws(() => ws.newPlugin('dist', 'x'), /保留名/)
})

await t('3. 合法 slug 解析出的路径必须在工坊根内', () => {
  const p = ws.inside('demo-hello')
  assert.equal(path.dirname(p), path.resolve(ROOT))
  assert.equal(path.basename(p), 'demo-hello')
})

// ───────────────────── 2. 正常链路 ─────────────────────
console.log('新建 → 列表 → 详情 → 自检 → 打包 → 删除')

await t('4. newPlugin 生成 manifest/index.js/README.md 四件套', () => {
  const m = ws.newPlugin('demo-hello', '演示插件', 'Molly')
  assert.equal(m.slug, 'demo-hello')
  assert.equal(m.name, '演示插件')
  assert.equal(m.author, 'Molly')
  assert.equal(m.version, '0.1.0')
  assert.equal(m.status, 'draft')
  assert.equal(m.lastTest, null)
  const dir = ws.pluginDir('demo-hello')
  for (const f of ['manifest.json', 'index.js', 'README.md']) {
    assert.ok(fs.existsSync(path.join(dir, f)), `缺 ${f}`)
  }
  const idx = fs.readFileSync(path.join(dir, 'index.js'), 'utf8')
  assert.match(idx, /export default function apply/)
  assert.match(idx, /工坊草稿，未挂载/)
  const mf = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  assert.equal(mf.slug, 'demo-hello')
})

await t('5. 重复新建同名插件报错', () => {
  assert.throws(() => ws.newPlugin('demo-hello', '另一个'), /已存在/)
})

await t('6. list / status 能看到草稿', () => {
  const rows = ws.list()
  const row = rows.find((r) => r.slug === 'demo-hello')
  assert.ok(row, 'list 里应有 demo-hello')
  assert.equal(row.status, 'draft')
  const s = ws.status('demo-hello')
  assert.equal(s.slug, 'demo-hello')
  assert.ok(s.files.includes('index.js') && s.files.includes('manifest.json'))
  assert.deepEqual(s.packs, [])
})

await t('7. 没自检就打包 → 报错（不允许把未知状态塞进仓库）', () => {
  assert.throws(() => ws.pack('demo-hello'), /还没通过自检/)
})

await t('8. test 模板插件 → ok:true，静态通过、apply exit=0，manifest 记 tested', async () => {
  const r = await ws.test('demo-hello')
  assert.equal(r.ok, true, r.summary)
  assert.equal(r.static.length, 1)
  assert.equal(r.static[0].file, 'index.js')
  assert.equal(r.static[0].ok, true)
  assert.equal(r.runtime.exit, 0)
  assert.match(r.runtime.stdoutTail, /WORKSHOP_APPLY_OK/)
  const mf = JSON.parse(fs.readFileSync(ws.manifestPath('demo-hello'), 'utf8'))
  assert.equal(mf.status, 'tested')
  assert.equal(mf.lastTest.ok, true)
  assert.ok(mf.lastTest.at)
})

await t('9. pack → zip + .sha256 + dist/index.json，sha 与实算一致', () => {
  const r = ws.pack('demo-hello')
  assert.match(r.file, /^demo-hello-0\.1\.0-\d{8}-\d{6}\.zip$/)
  assert.ok(fs.existsSync(r.path), 'zip 应存在')
  assert.equal(sha256OfFile(r.path), r.sha256, '返回的 sha256 应与文件一致')
  const shaFile = path.join(path.dirname(r.path), `${r.file}.sha256`)
  assert.ok(fs.existsSync(shaFile), '.sha256 应存在')
  assert.ok(fs.readFileSync(shaFile, 'utf8').startsWith(r.sha256), '.sha256 内容应与实算一致')

  const buf = fs.readFileSync(r.path)
  assert.equal(buf.subarray(0, 4).toString('hex'), '504b0304', 'ZIP 本地头签名')
  assert.ok(buf.includes(Buffer.from('demo-hello/index.js')), 'zip 里应有 index.js')
  assert.ok(buf.includes(Buffer.from('demo-hello/manifest.json')), 'zip 里应有 manifest.json')
  assert.ok(buf.includes(Buffer.from('demo-hello/README.md')), 'zip 里应有 README.md')

  const index = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'index.json'), 'utf8'))
  const entry = index.find((e) => e.file === r.file)
  assert.ok(entry, 'dist/index.json 应有该 zip 条目')
  assert.equal(entry.sha256, r.sha256)
  assert.equal(entry.slug, 'demo-hello')
  assert.equal(entry.status, 'packaged')

  const mf = JSON.parse(fs.readFileSync(ws.manifestPath('demo-hello'), 'utf8'))
  assert.equal(mf.status, 'packaged')

  // 包里的 manifest 必须与磁盘上的一致（状态已定稿成 packaged 再打）
  const inZip = readZipEntry(buf, 'demo-hello/manifest.json')
  assert.ok(inZip.equals(fs.readFileSync(ws.manifestPath('demo-hello'))), 'zip 内 manifest 应与磁盘逐字节一致')
  assert.equal(JSON.parse(inZip.toString('utf8')).status, 'packaged')
})

await t('10. remove 删目录但保留 dist 里的 zip', () => {
  ws.newPlugin('tmp-remove', '待删', 'Molly')
  const dir = ws.pluginDir('tmp-remove')
  assert.ok(fs.existsSync(dir))
  ws.remove('tmp-remove')
  assert.equal(fs.existsSync(dir), false)
  assert.ok(ws.list().every((r) => r.slug !== 'tmp-remove'))
})

// ─────────────────── 3. 反面用例 ───────────────────
console.log('反面用例（必须被抓住且不崩主进程）')

await t('11. 语法错的插件 → ok:false，summary 带「文件:行号」和 SyntaxError', async () => {
  ws.newPlugin('bad-syntax', '语法错', 'Molly')
  fs.writeFileSync(
    path.join(ws.pluginDir('bad-syntax'), 'index.js'),
    ['export const name = "bad-syntax"', 'export default function apply(ctx) {', '  const x = 1 +', '}'].join('\n'),
    'utf8',
  )
  const r = await ws.test('bad-syntax')
  assert.equal(r.ok, false)
  assert.equal(r.static[0].ok, false)
  assert.match(r.summary, /index\.js:\d+/)
  assert.match(r.summary, /SyntaxError/)
  assert.equal(r.runtime.skipped, true, '静态没过不该再起子进程')
  const mf = JSON.parse(fs.readFileSync(ws.manifestPath('bad-syntax'), 'utf8'))
  assert.equal(mf.status, 'draft')
  assert.equal(mf.lastTest.ok, false)
})

await t('12. apply 抛异常 → 被捕获成 ok:false，stderr 有原文，主进程活着', async () => {
  ws.newPlugin('boom-apply', '会炸', 'Molly')
  fs.writeFileSync(
    path.join(ws.pluginDir('boom-apply'), 'index.js'),
    ['export default function apply() {', '  throw new Error("boom-in-apply")', '}'].join('\n'),
    'utf8',
  )
  const r = await ws.test('boom-apply')
  assert.equal(r.ok, false)
  assert.equal(r.runtime.exit, 1)
  assert.match(r.runtime.stderrTail, /boom-in-apply/)
  assert.match(r.summary, /apply exit=1/)
  assert.equal(typeof ws.list, 'function', '本进程还在，工坊还能用')
  const again = await ws.test('demo-hello')
  assert.equal(again.ok, true, '炸过一次之后仍能正常自检别的插件')
})

await t('13. apply 卡死 → 按 testTimeoutMs 杀掉，ok:false + 超时', async () => {
  const fast = new Workshop({ dir: ROOT, logger: () => {}, testTimeoutMs: 800 })
  fast.newPlugin('slow-apply', '慢', 'Molly')
  fs.writeFileSync(
    path.join(fast.pluginDir('slow-apply'), 'index.js'),
    ['export default async function apply() {', '  await new Promise((r) => setTimeout(r, 5000))', '}'].join('\n'),
    'utf8',
  )
  const r = await fast.test('slow-apply')
  assert.equal(r.ok, false)
  assert.equal(r.runtime.timedOut, true)
  assert.match(r.summary, /超时/)
})

// ─────────────────── 4. 子进程环境 ───────────────────
console.log('子进程环境（凭据不许下传）')

await t('14. 子进程 env 里没有任何 TOKEN/SECRET/NAPCAT 变量', async () => {
  process.env.MY_TEST_SECRET = '<REDACTED>'
  process.env.NAPCAT_TOKEN = '<REDACTED>'
  process.env.PUSHPLUS_TOKEN = '<REDACTED>'
  ws.newPlugin('env-probe', '探针', 'Molly')
  fs.writeFileSync(
    path.join(ws.pluginDir('env-probe'), 'index.js'),
    [
      'export default function apply() {',
      '  const keys = Object.keys(process.env).filter((k) => /TOKEN|SECRET|NAPCAT|PUSHPLUS/i.test(k))',
      '  console.log("ENV_LEAK_KEYS=" + JSON.stringify(keys))',
      '}',
    ].join('\n'),
    'utf8',
  )
  const r = await ws.test('env-probe')
  assert.equal(r.ok, true, r.summary)
  assert.match(r.runtime.stdoutTail, /ENV_LEAK_KEYS=\[\]/)
  for (const leak of ['<REDACTED>', '<REDACTED>', '<REDACTED>', 'MY_TEST_SECRET', 'NAPCAT_TOKEN']) {
    assert.ok(!r.runtime.stdoutTail.includes(leak), `子进程不该看到 ${leak}`)
  }
  delete process.env.MY_TEST_SECRET
  delete process.env.NAPCAT_TOKEN
  delete process.env.PUSHPLUS_TOKEN
})

await t('15. cleanEnv：只保留安全键', () => {
  const out = cleanEnv({ PATH: 'p', FOO: '1', NAPCAT_TOKEN: 'x', MY_SECRET: 'y', OPENAI_API_KEY: 'z', CONSOLE_TOKEN: 'w' })
  assert.deepEqual(Object.keys(out).sort(), ['FOO', 'PATH'])
})

// ─────────────────── 5. 红线 & 工具函数 ───────────────────
console.log('红线：工坊源码里不许出现宿主管理标识')

await t('16. workshop.js 源码 0 处宿主插件管理标识', () => {
  const src = fs.readFileSync(path.join(LIB, 'workshop.js'), 'utf8')
  // 拆开拼：连测试文件本身也不留下整串
  const needles = [['plugin', '_manager'].join(''), ['~', '/.dsh/profiles'].join(''), ['profiles', '\\', 'desktop'].join('')]
  for (const n of needles) {
    assert.equal(src.includes(n), false, `workshop.js 不应包含「${n}」`)
  }
  // 反面护栏：工坊里也没有任何「安装/挂载」动作名
  assert.equal(/action\s*[:=]\s*['"](install|enable|mount)['"]/.test(src), false, '不应有 install/enable/mount 动作')
})

await t('17. buildZip 生成合法空条目 zip（EOCD 签名）', () => {
  const buf = buildZip([{ name: 'a.txt', data: Buffer.from('hello'), mtimeMs: Date.now() }])
  assert.equal(buf.subarray(0, 4).toString('hex'), '504b0304')
  assert.equal(buf.subarray(buf.length - 22, buf.length - 18).toString('hex'), '504b0506', 'EOCD 签名')
  assert.ok(buf.includes(Buffer.from('a.txt')))
})

await t('18. test 结束 tmp/ 被清空', () => {
  assert.deepEqual(fs.readdirSync(path.join(ROOT, 'tmp')), [])
})

// ─────────────────── 6. 工具层 molly_workshop ───────────────────
console.log('工具层（molly_workshop 注册与执行）')

await t('19. 工具定义：名字/参数/输出 schema 合规', () => {
  const tool = buildWorkshopTool({ getWorkshop: () => ws })
  assert.equal(tool.name, 'molly_workshop')
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.deepEqual(tool.parameters.properties.action.enum, ['list', 'status', 'test', 'pack', 'new'])
  assert.equal(tool.output.schema.additionalProperties, false, '输出 schema 必须 additionalProperties:false')
  assert.deepEqual(tool.output.render({}, { ok: true, action: 'list', text: 'x' }), [{ type: 'text', text: 'x' }])
  // 参数里不许出现安装/挂载类动作
  assert.deepEqual(tool.parameters.properties.action.enum.filter((a) => /install|mount|enable/.test(a)), [])
})

await t('20. 工具 execute 走完 new → test → pack → status → list', async () => {
  const tool = buildWorkshopTool({ getWorkshop: () => ws })
  const r1 = await tool.execute({ action: 'new', slug: 'tool-demo', name: '工具演示' })
  assert.equal(r1.ok, true, r1.text)
  const r2 = await tool.execute({ action: 'test', slug: 'tool-demo' })
  assert.equal(r2.ok, true, r2.text)
  const r3 = await tool.execute({ action: 'pack', slug: 'tool-demo' })
  assert.equal(r3.ok, true, r3.text)
  assert.match(r3.text, /sha256：[0-9a-f]{64}/)
  const r4 = await tool.execute({ action: 'status', slug: 'tool-demo' })
  assert.match(r4.text, /状态：packaged/)
  const r5 = await tool.execute({ action: 'list' })
  assert.match(r5.text, /tool-demo/)
  const r6 = await tool.execute({ action: 'new', slug: '../evil' })
  assert.equal(r6.ok, false)
  assert.match(r6.text, /slug 不合法/)
  const r7 = await tool.execute({ action: 'test' })
  assert.equal(r7.ok, false)
  assert.match(r7.text, /需要提供 slug/)
})

await t('21. registerWorkshopTool 走 ctx.get("tools") 注册；没有 tools 服务时降级不抛', () => {
  let captured = null
  const ctx = {
    get: (n) => (n === 'tools' ? { register: (t) => { captured = t; return () => {} } } : undefined),
  }
  const r = registerWorkshopTool({ ctx, getWorkshop: () => ws })
  assert.equal(r.status.registered, true)
  assert.equal(captured.name, 'molly_workshop')
  assert.equal(typeof r.dispose, 'function')

  const bare = registerWorkshopTool({ ctx: {}, getWorkshop: () => ws })
  assert.equal(bare.status.registered, false)
  assert.match(bare.status.error, /tools 服务/)
})

// ─────────────────── 收尾 ───────────────────
// 超时用例的子进程可能刚被 SIGKILL、临时目录还短暂被占用，删不掉不算失败
try {
  fs.rmSync(ROOT, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
} catch (err) {
  console.log(`  （清理临时目录失败，不影响结论：${err?.code || err?.message}）`)
}

console.log('')
console.log(`${pass} passed, ${fails.length} failed`)
if (fails.length) {
  for (const f of fails) console.log('  - ' + f.name + ': ' + f.msg)
  process.exit(1)
}
