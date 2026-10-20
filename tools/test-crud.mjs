/**
 * 控制台 CRUD 的验收测试（契约 docs/console-crud-contract.md §2，A 端）。
 *
 * 两条线一起测，因为它们各自会漏：
 *   1. **store 层**：MemoryStore.update/remove 是否真的落盘、at 是否不变；
 *      StickerLibrary.add/rename/remove 是否真的动文件、重扫后 match() 能不能看到。
 *   2. **HTTP 层**：web.js 那 8 条路由的状态码（400/404）与响应形状——
 *      这层才是前端和 console-server 代理实际打交道的表面。
 *
 * 刻意测的三件"事故复现"：
 *   - 控制台改完记忆后再调一次 `store.add()`（模拟插件正常聊天时的写入），
 *     改动必须还在——这正是"必须走内存对象"的原因。
 *   - `file="../../memory/memory.json"` 必须 400，且目标文件一个字节都不能变。
 *   - 把文本改名成 .jpg 传上来必须被魔数拦下（不信扩展名）。
 *
 * 跑法（PATH 里没有 node）：
 *   & "${HOME}\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
 *     ${MOLLY_ROOT}\qq-whale\tools\test-crud.mjs
 *
 * 只写 out/test-crud-data/，跑完（无论成败）整个删掉。真库一根毛都不碰。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJ = path.resolve(HERE, '..')
// 默认测源码；同步后想验安装副本，设 CRUD_LIB_DIR 指向 node_modules/dsh-qq-whale/lib
const LIB_DIR =
  process.env.CRUD_LIB_DIR || path.join(PROJ, 'plugin', 'dsh-qq-whale', 'lib')
const TMP = path.join(PROJ, 'out', 'test-crud-data')

const { WebWidget } = await import(pathToFileURL(path.join(LIB_DIR, 'web.js')).href)
const { MemoryStore } = await import(pathToFileURL(path.join(LIB_DIR, 'memory.js')).href)
const {
  StickerLibrary,
  cleanKeywords,
  STICKER_MAX_BYTES,
} = await import(pathToFileURL(path.join(LIB_DIR, 'stickers.js')).href)
const {
  readLearnedHashes,
  addLearnedHash,
} = await import(pathToFileURL(path.join(LIB_DIR, 'sticker-learn.js')).href)

let pass = 0
let fail = 0
const failures = []
function ok(cond, name, extra) {
  if (cond) {
    pass++
    console.log(`  ✔ ${name}`)
    return true
  }
  fail++
  failures.push(name)
  console.log(`  ✘ ${name}${extra === undefined ? '' : `  ← ${JSON.stringify(extra)}`}`)
  return false
}

/** 1x1 透明 PNG（真实图片字节，魔数能认出来） */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
)

// ── 假的宿主 webServer：只把路由收进 Map，方便直接调 handler ──────────────
const routes = new Map()
const webServer = {
  register(route) {
    routes.set(route.path, route)
    return () => routes.delete(route.path)
  },
}

function makeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(code, headers) {
      this.status = code
      this.headers = headers || {}
    },
    end(body) {
      this.body = body || ''
    },
  }
}

async function call(method, urlPath, body) {
  const route = routes.get(urlPath)
  if (!route) throw new Error(`路由没注册：${urlPath}`)
  const payload = body === undefined ? '' : JSON.stringify(body)
  const req = Readable.from(payload ? [Buffer.from(payload, 'utf8')] : [])
  req.method = method
  req.url = urlPath
  req.headers = { host: '127.0.0.1:7053', 'sec-fetch-site': 'same-origin' }
  const res = makeRes()
  await route.handler(req, res)
  let json = null
  try {
    json = JSON.parse(res.body)
  } catch {
    /* 非 JSON 响应，保留原文 */
  }
  return { status: res.status, json, raw: res.body }
}

const P = '/dsh-qq-whale'

try {
  // ── 0. 干净临时目录 ────────────────────────────────────────────────
  fs.rmSync(TMP, { recursive: true, force: true })
  const memoryDir = path.join(TMP, 'memory')
  const stickerDir = path.join(TMP, 'stickers')
  const learnedDir = path.join(stickerDir, '学来的')
  fs.mkdirSync(memoryDir, { recursive: true })
  fs.mkdirSync(learnedDir, { recursive: true })

  // 种子记忆：两条，at 相差一天，用来验证 list 的倒序
  const seeded = {
    version: 1,
    entries: [
      { id: 'm_old', kind: 'fact', who: '测试', text: '旧的一条记忆', weight: 3, at: 1700000000000 },
      { id: 'm_new', kind: 'person', who: '测试', text: '新的一条记忆', weight: 4, at: 1700086400000 },
    ],
  }
  fs.writeFileSync(path.join(memoryDir, 'memory.json'), JSON.stringify(seeded, null, 2), 'utf8')
  fs.writeFileSync(path.join(memoryDir, 'memory.md'), '# 种子\n', 'utf8')

  // 种一个哈希，供删除时验证"摘掉自己那一个、别的不动"
  const seededHash = crypto.createHash('sha256').update('seed-image').digest('hex')
  fs.writeFileSync(path.join(learnedDir, '.learned.json'), JSON.stringify([seededHash]), 'utf8')

  const memory = new MemoryStore({ dir: memoryDir, logger: () => {} })
  const stickers = new StickerLibrary({ dir: stickerDir, logger: () => {} })
  stickers.scan()
  const engine = { memory, stickers, learner: null }

  const widget = new WebWidget({
    logger: () => {},
    config: { enabled: true, stickerDir, memoryDir },
    state: {},
    engineRef: () => engine,
    recheck: async () => ({}),
    refreshLogin: async () => ({}),
  })
  widget.register({ webServer })

  console.log('\n[1] 路由注册')
  for (const p of [
    'memory/list',
    'memory/add',
    'memory/update',
    'memory/delete',
    'stickers/list',
    'stickers/add',
    'stickers/update',
    'stickers/delete',
  ]) {
    ok(routes.has(`${P}/${p}`), `注册了 ${P}/${p}`)
  }

  // ── 记忆 ─────────────────────────────────────────────────────────
  console.log('\n[2] 记忆 GET /memory/list')
  let r = await call('GET', `${P}/memory/list`)
  ok(r.status === 200 && r.json?.ok === true, 'list 200 且 ok:true', r.json)
  ok(r.json?.count === 2, 'count=2', r.json?.count)
  ok(r.json?.entries?.[0]?.id === 'm_new', '按 at 倒序（新的在前）', r.json?.entries?.map((e) => e.id))
  ok(r.json?.entries?.[0]?.at === 1700086400000, 'entry 带 at 字段')

  console.log('\n[3] 记忆 POST /memory/add')
  r = await call('POST', `${P}/memory/add`, { kind: 'fact', who: '控制台', text: '控制台加的一条', weight: 5 })
  ok(r.status === 200 && r.json?.ok === true, 'add 200', r.json)
  ok(r.json?.count === 3, 'count=3', r.json?.count)
  const addedId = r.json?.entry?.id
  ok(typeof addedId === 'string' && addedId.length > 0, '返回了 entry.id', addedId)
  ok(r.json?.entry?.weight === 5, 'weight=5 生效')
  ok(r.json?.merged === false, '新建时 merged=false')
  // 再加一条一模一样的话：MemoryStore 自带相似度去重会并入旧条目，条数不变
  const dupR = await call('POST', `${P}/memory/add`, {
    kind: 'fact',
    who: '控制台',
    text: '控制台加的一条',
    weight: 4,
  })
  ok(dupR.status === 200 && dupR.json?.merged === true, '相似内容重复加 → merged=true', dupR.json?.merged)
  ok(dupR.json?.entry?.id === addedId, 'merged 时返回的是已有条目的 id', [dupR.json?.entry?.id, addedId])
  ok(dupR.json?.count === 3, 'merged 时 count 不变', dupR.json?.count)
  const onDisk = JSON.parse(fs.readFileSync(path.join(memoryDir, 'memory.json'), 'utf8'))
  ok(onDisk.entries.length === 3, 'memory.json 里也是 3 条', onDisk.entries.length)
  const md = fs.readFileSync(path.join(memoryDir, 'memory.md'), 'utf8')
  ok(md.includes('控制台加的一条'), 'memory.md 同步出现新记忆')
  ok(md.includes('控制台'), 'memory.md 里出现了 who 分组')

  console.log('\n[4] 记忆 add 的参数校验')
  r = await call('POST', `${P}/memory/add`, { text: '' })
  ok(r.status === 400, 'text 为空 → 400', r.status)
  r = await call('POST', `${P}/memory/add`, { text: 'x'.repeat(201) })
  ok(r.status === 400, 'text 201 字 → 400', r.status)
  r = await call('POST', `${P}/memory/add`, { text: '合法', kind: 'bogus' })
  ok(r.status === 400, 'kind 白名单外 → 400', r.status)
  r = await call('POST', `${P}/memory/add`, { text: '合法', weight: 9 })
  ok(r.status === 400, 'weight=9 → 400', r.status)
  r = await call('POST', `${P}/memory/add`, { text: '合法', weight: 2.5 })
  ok(r.status === 400, 'weight=2.5（非整数）→ 400', r.status)
  r = await call('POST', `${P}/memory/add`, { text: '边界200字'.padEnd(200, '字') })
  ok(r.status === 200, 'text 正好 200 字 → 200', r.status)

  console.log('\n[5] 记忆 POST /memory/update')
  const beforeAt = memory.entries.find((e) => e.id === addedId).at
  r = await call('POST', `${P}/memory/update`, { id: addedId, text: '控制台改过的一条', weight: 2 })
  ok(r.status === 200 && r.json?.ok === true, 'update 200', r.json)
  ok(r.json?.entry?.text === '控制台改过的一条', 'text 已改', r.json?.entry?.text)
  ok(r.json?.entry?.weight === 2, 'weight 已改', r.json?.entry?.weight)
  ok(r.json?.entry?.at === beforeAt, 'at 不变（契约：at 是记下的时间）', r.json?.entry?.at)
  const disk2 = JSON.parse(fs.readFileSync(path.join(memoryDir, 'memory.json'), 'utf8'))
  ok(disk2.entries.some((e) => e.id === addedId && e.text === '控制台改过的一条'), 'memory.json 已同步')
  const md2 = fs.readFileSync(path.join(memoryDir, 'memory.md'), 'utf8')
  ok(md2.includes('控制台改过的一条'), 'memory.md 已同步')

  // 关键回归：控制台改完，插件下一次 add() 不能把改动吞掉
  memory.add({ kind: 'fact', who: '聊天', text: '插件自己又记了一条' })
  const afterPluginAdd = JSON.parse(fs.readFileSync(path.join(memoryDir, 'memory.json'), 'utf8'))
  ok(
    afterPluginAdd.entries.some((e) => e.id === addedId && e.text === '控制台改过的一条'),
    '插件再 add() 之后，控制台的修改仍在（核心需求）',
  )

  r = await call('POST', `${P}/memory/update`, { id: '不存在的id', text: 'x' })
  ok(r.status === 404, 'update 不存在的 id → 404', r.status)
  // 只传一个查不到的 id（没有别的字段）：契约要求 404，不能先按"没有要改的字段"回 400
  r = await call('POST', `${P}/memory/update`, { id: 'no-such-id-xyz' })
  ok(r.status === 404, '只传不存在的 id（无其他字段）→ 404', r.status)
  r = await call('POST', `${P}/memory/update`, { id: 'bad\u0000id', text: 'x' })
  ok(r.status === 400, 'id 含控制字符（格式非法）→ 400', r.status)
  r = await call('POST', `${P}/memory/update`, { id: addedId })
  ok(r.status === 400, 'update 不带任何字段 → 400', r.status)

  console.log('\n[6] 记忆 POST /memory/delete')
  const countBefore = memory.entries.length
  r = await call('POST', `${P}/memory/delete`, { id: addedId })
  ok(r.status === 200 && r.json?.ok === true, 'delete 200', r.json)
  ok(r.json?.deleted === 1, 'deleted=1')
  ok(r.json?.count === countBefore - 1, 'count -1', [countBefore, r.json?.count])
  const disk3 = JSON.parse(fs.readFileSync(path.join(memoryDir, 'memory.json'), 'utf8'))
  ok(!disk3.entries.some((e) => e.id === addedId), 'memory.json 里真的没了')
  ok(!fs.readFileSync(path.join(memoryDir, 'memory.md'), 'utf8').includes('控制台改过的一条'), 'memory.md 里也没了')
  r = await call('POST', `${P}/memory/delete`, { id: addedId })
  ok(r.status === 404, '重复删 → 404', r.status)
  r = await call('POST', `${P}/memory/delete`, {})
  ok(r.status === 400, '不带 id → 400', r.status)

  // ── 表情包 ───────────────────────────────────────────────────────
  console.log('\n[7] 表情包 GET /stickers/list（空目录）')
  r = await call('GET', `${P}/stickers/list`)
  ok(r.status === 200 && r.json?.ok === true, 'list 200', r.json)
  ok(r.json?.count === 0, '空目录 count=0', r.json?.count)

  console.log('\n[8] 表情包 POST /stickers/add（base64 + 关键词清洗）')
  const learnedBefore = readLearnedHashes(learnedDir).length
  r = await call('POST', `${P}/stickers/add`, {
    dataBase64: `data:image/png;base64,${PNG_1PX.toString('base64')}`,
    keywords: ['测试_关键词', '鲸鱼', '鲸鱼', '  '],
  })
  ok(r.status === 200 && r.json?.ok === true, 'add 200', r.json)
  ok(r.json?.count === 1, 'count=1', r.json?.count)
  const item1 = r.json?.item
  ok(item1?.file === '测试-关键词_鲸鱼.png', '文件名 = 关键词用_拼（单关键词里的 _ 变 -）', item1?.file)
  ok(JSON.stringify(item1?.keywords) === JSON.stringify(['测试-关键词', '鲸鱼']), 'keywords 数组正确且去重', item1?.keywords)
  ok(fs.existsSync(path.join(learnedDir, item1.file)), '文件真的落盘了')
  const learnedAfterAdd = readLearnedHashes(learnedDir)
  ok(learnedAfterAdd.length === learnedBefore + 1, `.learned.json 多一个哈希（${learnedBefore} → ${learnedAfterAdd.length}）`)
  ok(
    learnedAfterAdd.includes(crypto.createHash('sha256').update(PNG_1PX).digest('hex')),
    '登记的是图片内容的 sha256',
  )
  ok(
    learnedAfterAdd.includes(seededHash),
    '原有哈希没被动过',
  )
  const matched = stickers.match('鲸鱼')
  ok(matched.length === 1 && matched[0].file.includes('鲸鱼'), '重扫后 match() 立刻能看到新图')
  ok(stickers.catalogText().includes('鲸鱼'), 'catalogText() 立刻包含新标签')

  console.log('\n[9] 表情包 add 的拦截')
  r = await call('POST', `${P}/stickers/add`, {
    dataBase64: Buffer.from('这其实是一段文本，不是图片').toString('base64'),
    keywords: ['假图'],
  })
  ok(r.status === 400, '文本冒充图片 → 400（魔数拦下）', r.status)
  ok(!fs.existsSync(path.join(learnedDir, '假图.png')), '假图没有落盘')
  r = await call('POST', `${P}/stickers/add`, {
    dataBase64: Buffer.alloc(STICKER_MAX_BYTES + 1, 0).toString('base64'),
    keywords: ['超大'],
  })
  ok(r.status === 413, `>8MB（${STICKER_MAX_BYTES + 1} B）→ 413`, r.status)
  ok(r.json?.error === '图片太大，单张上限 8 MB', '超限文案是人话（控制台能直接显示）', r.json?.error)
  r = await call('POST', `${P}/stickers/add`, { dataBase64: '', keywords: ['空'] })
  ok(r.status === 400, 'dataBase64 为空 → 400', r.status)
  r = await call('POST', `${P}/stickers/add`, {
    dataBase64: PNG_1PX.toString('base64'),
    keywords: [],
  })
  ok(r.status === 400, '关键词为空 → 400', r.status)

  console.log('\n[10] 重名追加 _2')
  r = await call('POST', `${P}/stickers/add`, {
    dataBase64: `data:image/png;base64,${PNG_1PX.toString('base64')}`,
    keywords: ['测试-关键词', '鲸鱼'],
  })
  ok(r.status === 200 && r.json?.item?.file === '测试-关键词_鲸鱼_2.png', '重名 → 追加 _2', r.json?.item?.file)
  ok(r.json?.count === 2, 'count=2', r.json?.count)

  console.log('\n[11] 表情包 POST /stickers/update（改关键词 = 重命名）')
  r = await call('POST', `${P}/stickers/update`, { file: '测试-关键词_鲸鱼.png', keywords: ['新名', '第二个'] })
  ok(r.status === 200 && r.json?.ok === true, 'update 200', r.json)
  ok(r.json?.renamed?.from === '测试-关键词_鲸鱼.png', 'renamed.from 正确', r.json?.renamed)
  ok(r.json?.item?.file === '新名_第二个.png', '新文件名 = 新关键词', r.json?.item?.file)
  ok(!fs.existsSync(path.join(learnedDir, '测试-关键词_鲸鱼.png')), '旧文件已消失')
  ok(fs.existsSync(path.join(learnedDir, '新名_第二个.png')), '新文件存在')
  ok(JSON.stringify(r.json?.item?.keywords) === JSON.stringify(['新名', '第二个']), 'keywords 已更新', r.json?.item?.keywords)
  ok(r.json?.count === 2, '改关键词不改数量', r.json?.count)
  ok((await call('GET', `${P}/stickers/list`)).json?.count === 2, 'list 里数量不变')
  r = await call('POST', `${P}/stickers/update`, { file: '不存在.png', keywords: ['x'] })
  ok(r.status === 404, '改不存在的文件 → 404', r.status)

  console.log('\n[12] 路径穿越 / 绝对路径')
  const memoryJsonPath = path.join(memoryDir, 'memory.json')
  const memoryBytesBefore = fs.readFileSync(memoryJsonPath)
  for (const evil of [
    '../../memory/memory.json',
    '..\\..\\memory\\memory.json',
    '学来的/../../memory/memory.json',
    'C:\\Windows\\win.ini',
    '/etc/passwd',
    'sub/子目录.png',
  ]) {
    r = await call('POST', `${P}/stickers/delete`, { file: evil })
    ok(r.status === 400, `delete file="${evil}" → 400`, r.status)
  }
  r = await call('POST', `${P}/stickers/update`, { file: '../../memory/memory.json', keywords: ['x'] })
  ok(r.status === 400, 'update 路径穿越 → 400', r.status)
  ok(
    Buffer.compare(fs.readFileSync(memoryJsonPath), memoryBytesBefore) === 0,
    '路径穿越被挡后 memory.json 一个字节都没变',
  )

  console.log('\n[13] 表情包 POST /stickers/delete')
  const hash2 = crypto
    .createHash('sha256')
    .update(PNG_1PX)
    .digest('hex')
  // 两张图的字节一样，哈希也只有一个；先确认表里就它一个（加上种子）
  ok(readLearnedHashes(learnedDir).filter((h) => h === hash2).length === 1, '同一内容只登记一个哈希')
  r = await call('POST', `${P}/stickers/delete`, { file: '新名_第二个.png' })
  ok(r.status === 200 && r.json?.ok === true, 'delete 200', r.json)
  ok(r.json?.deleted === 1 && r.json?.count === 1, 'deleted=1、count=1', r.json)
  ok(!fs.existsSync(path.join(learnedDir, '新名_第二个.png')), '文件已删')
  const learnedAfterDelete = readLearnedHashes(learnedDir)
  ok(!learnedAfterDelete.includes(hash2), '.learned.json 里那个哈希被移除')
  ok(learnedAfterDelete.includes(seededHash), '别的哈希没被误删')
  r = await call('POST', `${P}/stickers/delete`, { file: '新名_第二个.png' })
  ok(r.status === 404, '重复删 → 404', r.status)

  // 清掉剩下那张（同样内容，第二个哈希在第一次删时就没了——这里只删文件）
  r = await call('POST', `${P}/stickers/delete`, { file: '测试-关键词_鲸鱼_2.png' })
  ok(r.status === 200 && r.json?.count === 0, '删到空 → count=0', r.json)

  console.log('\n[14] cleanKeywords 单元')
  ok(
    JSON.stringify(cleanKeywords(['a_b', 'c/d', '  ', 'a_b'])) === JSON.stringify(['a-b', 'c-d']),
    '清洗 + 去重 + 丢空',
  )
  ok(cleanKeywords(Array.from({ length: 12 }, (_, i) => `词${i}`)).length === 8, '最多 8 个')
  ok(cleanKeywords('逗号,分隔 的').length >= 2, '字符串也能按逗号/空格切开')

  console.log('\n[15] 405 / 空体 / 坏 JSON')
  r = await call('GET', `${P}/memory/add`)
  ok(r.status === 405, 'GET 打 POST 路由 → 405', r.status)
  r = await call('POST', `${P}/stickers/add`, {})
  ok(r.status === 400, '空对象（无 dataBase64）→ 400', r.status)

  console.log('\n[16] 未就绪（engine 为 null）')
  const deadWidget = new WebWidget({
    logger: () => {},
    config: { enabled: true },
    state: {},
    engineRef: () => null,
    recheck: async () => ({}),
    refreshLogin: async () => ({}),
  })
  const deadRoutes = new Map()
  deadWidget.register({
    webServer: { register: (route) => (deadRoutes.set(route.path, route), () => {}) },
  })
  const res = makeRes()
  const req = Readable.from([])
  req.method = 'GET'
  req.headers = { host: '127.0.0.1:7053' }
  await deadRoutes.get(`${P}/memory/list`).handler(req, res)
  ok(res.status === 503, 'engine 未就绪 → 503', res.status)

  console.log('\n[17] learned.json 信息')
  console.log(`  种子哈希 ${seededHash.slice(0, 12)}…`)
  console.log(`  增删后剩余 ${readLearnedHashes(learnedDir).length} 个（应为 1：只剩种子）`)
  ok(readLearnedHashes(learnedDir).length === 1, '增删循环结束后哈希表回到初始长度')
  // 顺带验证模块级 helper 与实例方法写的是同一张表
  addLearnedHash(learnedDir, 'deadbeef')
  ok(readLearnedHashes(learnedDir).includes('deadbeef'), 'addLearnedHash 能写进同一张表')

  console.log('\n[18] 扫描上限对齐 8 MB（engine.js 传 maxFileSizeMB:8）')
  const bigDir = path.join(stickerDir, '大图')
  fs.mkdirSync(bigDir, { recursive: true })
  const bigFile = path.join(bigDir, '六兆_测试.png')
  // 6 MB：内容不必是真图片，scan() 只按扩展名 + 体积筛（魔数校验在 add() 那一层）
  fs.writeFileSync(bigFile, Buffer.alloc(6 * 1024 * 1024, 1))
  const lib5 = new StickerLibrary({ dir: stickerDir, logger: () => {} })
  lib5.scan()
  ok(
    !lib5.items.some((it) => it.file.endsWith('六兆_测试.png')),
    '默认 5 MB 上限：6 MB 的图被 skip()（这就是原来的坑）',
  )
  const lib8 = new StickerLibrary({ dir: stickerDir, logger: () => {}, maxFileSizeMB: 8 })
  lib8.scan()
  ok(
    lib8.items.some((it) => it.file.endsWith('六兆_测试.png')),
    '8 MB 上限：6 MB 的图能被 scan() 到（engine.js:154 新配置）',
  )
  fs.rmSync(bigDir, { recursive: true, force: true })
  lib8.scan()

  /*
   * [19] 真 HTTP 上验证「超大正文」不会被拖成 ECONNRESET。
   *
   * 这是 lead 真机踩到的坑：9 MB 的图 → base64 正文 ~12 MB → 老 readBody 在
   * 超限时直接 req.destroy()，客户端还在写，于是只拿到 fetch failed / ECONNRESET，
   * 服务端一个字节的响应都没有，控制台只能显示「网络错误」。
   * 现在必须先排空请求、再回 413 + 人话。
   */
  console.log('\n[19] 12 MB 正文走真 HTTP：必须是干净 413，不是 ECONNRESET')
  const routesForHttp = routes
  const server = http.createServer(async (req, res) => {
    const route = routesForHttp.get(String(req.url || '').split('?')[0])
    if (!route) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end('{"ok":false,"error":"no route"}')
      return
    }
    try {
      await route.handler(req, res)
    } catch (err) {
      try {
        res.writeHead(500, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: String(err?.message || err) }))
      } catch {
        /* 已经发过了 */
      }
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  // 12 MB 的 base64 正文，明显超过 11.7 MB 的读入上限
  const hugeJson = JSON.stringify({
    dataBase64: 'A'.repeat(12 * 1024 * 1024),
    keywords: ['太大'],
  })
  const httpRes = await new Promise((resolve) => {
    const outbound = http.request(
      {
        host: '127.0.0.1',
        port,
        path: `${P}/stickers/add`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(hugeJson),
        },
      },
      (inbound) => {
        let text = ''
        inbound.setEncoding('utf8')
        inbound.on('data', (c) => (text += c))
        inbound.on('end', () => resolve({ status: inbound.statusCode, body: text, err: null }))
      },
    )
    outbound.on('error', (err) => resolve({ status: 0, body: '', err }))
    // 分块写，模拟浏览器边编码边上传
    const step = 256 * 1024
    for (let i = 0; i < hugeJson.length; i += step) {
      outbound.write(hugeJson.slice(i, i + step))
    }
    outbound.end()
  })
  ok(httpRes.err === null, '客户端没有 ECONNRESET / socket hang up', httpRes.err?.message || 'no error')
  ok(httpRes.status === 413, 'HTTP 413（是响应，不是断连）', httpRes.status)
  ok(httpRes.body.includes('图片太大，单张上限 8 MB'), '413 正文带人话文案', httpRes.body.slice(0, 120))
  await new Promise((resolve) => server.close(resolve))
} catch (err) {
  fail++
  failures.push(`未捕获异常：${err?.stack || err}`)
  console.error('\n[FATAL]', err?.stack || err)
} finally {
  try {
    fs.rmSync(TMP, { recursive: true, force: true })
    console.log(`\n临时目录已清理：${TMP}`)
  } catch (err) {
    console.log(`\n临时目录清理失败（手动删）：${TMP} —— ${err?.message || err}`)
  }
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
if (fail > 0) {
  console.log('失败项：')
  for (const f of failures) console.log('  - ' + f)
}
process.exit(fail > 0 ? 1 : 0)
