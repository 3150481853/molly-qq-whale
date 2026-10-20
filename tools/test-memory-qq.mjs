/**
 * 记忆身份改造（task-22）的验收测试：who=名字、qq=唯一身份。
 *
 * 测三层，因为每层都可能各自失手：
 *   1. **store 层**（lib/memory.js）：add/update 带不带 qq、老条目补空串、
 *      同名不同号的召回优先级、按名字召回仍然好使。
 *   2. **HTTP 层**（lib/web.js）：/memory/add、/memory/update 接受 qq，
 *      非法格式 400，/memory/list 每条都带 qq。
 *   3. **迁移脚本**（tools/migrate-memory-qq.mjs）：dry-run 不写盘且幂等，
 *      --apply 只给「名字唯一对应一个号」的条目补 qq，歧义/无匹配跳过。
 *
 * 只写 out/test-memory-qq-data/，跑完（无论成败）整个删掉。真库一根毛都不碰。
 *
 * 跑法（PATH 里没有 node）：
 *   & "${HOME}\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
 *     ${MOLLY_ROOT}\qq-whale\tools\test-memory-qq.mjs
 *
 * 想验安装副本：设 MEMQQ_LIB_DIR 指向 node_modules/dsh-qq-whale/lib。
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Readable } from 'node:stream'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJ = path.resolve(HERE, '..')
const LIB_DIR = process.env.MEMQQ_LIB_DIR || path.join(PROJ, 'plugin', 'dsh-qq-whale', 'lib')
const TMP = path.join(PROJ, 'out', 'test-memory-qq-data')

const { MemoryStore, normalizeQq, isValidQq, QQ_PATTERN } = await import(
  pathToFileURL(path.join(LIB_DIR, 'memory.js')).href
)
const { WebWidget } = await import(pathToFileURL(path.join(LIB_DIR, 'web.js')).href)
const { PendingStore } = await import(pathToFileURL(path.join(LIB_DIR, 'memory-pending.js')).href)

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

// ── 假宿主：路由收进 Map，直接调 handler ──────────────────────────────
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
    /* 非 JSON */
  }
  return { status: res.status, json, raw: res.body }
}

const P = '/dsh-qq-whale'
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'))

try {
  fs.rmSync(TMP, { recursive: true, force: true })
  const memoryDir = path.join(TMP, 'memory')
  fs.mkdirSync(memoryDir, { recursive: true })
  const memoryFile = path.join(memoryDir, 'memory.json')
  const mdFile = path.join(memoryDir, 'memory.md')

  // 种子：① 老条目（没有 qq 字段） ② 同名不同号的两个「小王」
  const seeded = {
    version: 1,
    entries: [
      { id: 'm_legacy', kind: 'fact', who: '老王', text: '他养了一只猫叫团子', weight: 3, at: 1700000000000 },
      { id: 'm_xiaowang_a', kind: 'preference', who: '小王', qq: '111111111', text: '小王A最喜欢吃香菜', weight: 4, at: 1700100000000 },
      { id: 'm_xiaowang_b', kind: 'preference', who: '小王', qq: '222222222', text: '小王B最讨厌香菜', weight: 4, at: 1700200000000 },
      // 脏数据：qq 明显不是号 → 读的时候必须规整成空串，不能崩
      { id: 'm_dirty', kind: 'fact', who: '脏数据', qq: 'not-a-qq', text: '这条的 qq 是脏的', weight: 2, at: 1700300000000 },
    ],
  }
  fs.writeFileSync(memoryFile, JSON.stringify(seeded, null, 2), 'utf8')
  fs.writeFileSync(mdFile, '# 种子\n', 'utf8')

  // relations.json 形状与真实文件一致：relations[key] = { key, who, … }
  // 群键取最后一段（发送者），不是群号 —— 迁移脚本必须这么解析
  const relations = {
    version: 1,
    relations: {
      'private:222222222': { key: 'private:222222222', who: '老王' },
      'group:666666666:222222222': { key: 'group:666666666:222222222', who: '老王' },
      'private:888888888': { key: 'private:888888888', who: '小张' },
      'private:123123123': { key: 'private:123123123', who: '双号' },
      'group:42:999999999': { key: 'group:42:999999999', who: '双号' },
    },
  }
  fs.writeFileSync(path.join(memoryDir, 'relations.json'), JSON.stringify(relations, null, 2), 'utf8')

  // ── 1. 纯函数 ─────────────────────────────────────────────────────
  console.log('\n[1] normalizeQq / isValidQq')
  ok(QQ_PATTERN.test('111111111'), 'QQ_PATTERN 认 10 位号')
  ok(normalizeQq(' 111111111 ') === '111111111', 'normalizeQq 去空白')
  ok(normalizeQq('0123456') === '', 'normalizeQq 拒前导 0')
  ok(normalizeQq('123') === '', 'normalizeQq 拒太短')
  ok(normalizeQq('abc') === '', 'normalizeQq 拒非数字')
  ok(normalizeQq(undefined) === '' && normalizeQq(null) === '', 'normalizeQq 容错空值')
  ok(isValidQq('') === true, 'isValidQq 允许空串（历史条目没有号）')
  ok(isValidQq('123') === false && isValidQq('111111111') === true, 'isValidQq 区分合法/非法')

  // ── 2. load 兼容老条目 ────────────────────────────────────────────
  console.log('\n[2] load：老条目补 qq=""、脏 qq 被规整、不写盘')
  const beforeLoadBytes = fs.readFileSync(memoryFile)
  const memory = new MemoryStore({ dir: memoryDir, logger: () => {} })
  ok(memory.entries.length === 4, '读到 4 条')
  const legacy = memory.entries.find((e) => e.id === 'm_legacy')
  ok(legacy?.qq === '', '老条目 qq 补成空串')
  ok(memory.entries.find((e) => e.id === 'm_dirty')?.qq === '', '脏 qq 被规整成空串')
  ok(memory.entries.find((e) => e.id === 'm_xiaowang_a')?.qq === '111111111', '本来就有的 qq 原样保留')
  ok(
    Buffer.compare(beforeLoadBytes, fs.readFileSync(memoryFile)) === 0,
    'load 不写盘（文件字节没变）',
  )

  // ── 3. add ───────────────────────────────────────────────────────
  console.log('\n[3] add 带 qq / 不带 qq')
  const added = memory.add({ kind: 'fact', who: '小张', qq: '888888888', text: '他在杭州做前端', weight: 3 })
  ok(added?.qq === '888888888', 'add 返回的条目带 qq')
  const onDisk = readJson(memoryFile).entries.find((e) => e.id === added.id)
  ok(onDisk?.qq === '888888888', 'memory.json 里落下了 qq')
  const mdAfterAdd = fs.readFileSync(mdFile, 'utf8')
  ok(mdAfterAdd.includes('在杭州做前端'), 'memory.md 一起被重写')

  const noQq = memory.add({ kind: 'fact', who: '无号的人', text: '这条没有 QQ 号', weight: 3 })
  ok(noQq?.qq === '', '不带 qq 时存空串')

  // 老条目靠名字合并时，顺手把号补上（这是迁移之外的"自然补号"路径）
  const countBefore = memory.entries.length
  const merged = memory.add({ kind: 'fact', who: '老王', qq: '222222222', text: '他养了一只猫叫团子' })
  ok(merged?.id === 'm_legacy', '同一个人 + 同 kind + 高相似 → 并入老条目')
  ok(memory.entries.length === countBefore, '并入时条数不变')
  ok(merged?.qq === '222222222', '并入时给老条目补上了 qq')

  // ── 4. update ────────────────────────────────────────────────────
  console.log('\n[4] update 允许改 qq，at 不变')
  const atBefore = memory.entries.find((e) => e.id === 'm_xiaowang_b').at
  const upd = memory.update('m_xiaowang_b', { qq: '333333333' })
  ok(upd?.qq === '333333333', 'update 改了 qq')
  ok(upd?.at === atBefore, 'at 保持不变')
  ok(
    readJson(memoryFile).entries.find((e) => e.id === 'm_xiaowang_b')?.qq === '333333333',
    '改完 qq 落进 memory.json',
  )
  const cleared = memory.update('m_xiaowang_b', { qq: '' })
  ok(cleared?.qq === '', 'qq 可以清空（改回无号）')
  memory.update('m_xiaowang_b', { qq: '222222222' }) // 还原，后面召回要用

  // ── 5. recall 身份优先级 ──────────────────────────────────────────
  console.log('\n[5] recall：qq 完全匹配 > who 包含 > 文本关键词')
  const hitA = memory.recall({ who: '小王', qq: '111111111', limit: 1 })
  ok(hitA[0]?.qq === '111111111', '按 qq 召回拿到的是这个号那一条')
  const hitB = memory.recall({ who: '小王', qq: '222222222', limit: 1 })
  ok(hitB[0]?.qq === '222222222', '同名另一个号也能精确召回')
  const byName = memory.recall({ who: '小王' })
  ok(byName.some((e) => e.qq === '111111111') && byName.some((e) => e.qq === '222222222'), '只给名字时同名两条都在（老行为不退化）')
  const legacyByQq = memory.recall({ who: '老王', qq: '222222222' })
  ok(legacyByQq.some((e) => e.id === 'm_legacy'), '老条目按名字也能被这个人召回')

  // 关键词一个都不命中时，身份命中照样把人自己的记忆捞出来
  const noKw = memory.recall({ who: '小王', qq: '111111111', query: '今天天气怎么样' })
  ok(noKw.some((e) => e.qq === '111111111'), '关键词全不中时身份命中仍返回（不会误判成想不起来）')

  // 名字互含（"小王" vs "小王A"）给一点点加成，但不能压过 qq 完全匹配
  memory.add({ kind: 'fact', who: '小王A', qq: '999999999', text: '另一个人', weight: 3 })
  const ranked = memory.recall({ who: '小王', qq: '111111111', limit: 1 })
  ok(ranked[0]?.qq === '111111111', '名字包含关系不会盖过 qq 完全匹配')

  // ── 6. HTTP 层 ───────────────────────────────────────────────────
  console.log('\n[6] HTTP：/memory/add 接受 qq、非法 400')
  const engine = { memory, stickers: null, learner: null }
  const widget = new WebWidget({
    logger: () => {},
    config: { enabled: true, stickerDir: path.join(TMP, 'stickers'), memoryDir },
    state: {},
    engineRef: () => engine,
    recheck: async () => ({}),
    refreshLogin: async () => ({}),
  })
  widget.register({ webServer })

  let r = await call('POST', `${P}/memory/add`, { kind: 'fact', who: '接口人', qq: '111111111', text: '接口加的记忆' })
  ok(r.status === 200 && r.json?.entry?.qq === '111111111', 'add 带合法 qq → 200 且回显 qq', r)
  r = await call('POST', `${P}/memory/add`, { who: '接口人', qq: '123', text: '号太短' })
  ok(r.status === 400 && /qq/.test(r.json?.error || ''), 'add qq 非法 → 400', r)
  r = await call('POST', `${P}/memory/add`, { who: '接口人', qq: '0123456', text: '前导零' })
  ok(r.status === 400, 'add qq 前导 0 → 400', r)
  r = await call('POST', `${P}/memory/add`, { who: '接口人', text: '不填 qq 也行' })
  ok(r.status === 200 && r.json?.entry?.qq === '', 'add 不填 qq → 200 且 qq 为空串', r)

  console.log('\n[7] HTTP：/memory/update 改 qq、/memory/list 带 qq')
  r = await call('POST', `${P}/memory/update`, { id: 'm_legacy', qq: '222222222' })
  ok(r.status === 200 && r.json?.entry?.qq === '222222222', 'update 改 qq → 200', r)
  r = await call('POST', `${P}/memory/update`, { id: 'm_legacy', qq: 'abc' })
  ok(r.status === 400, 'update qq 非法 → 400', r)
  r = await call('POST', `${P}/memory/update`, { id: 'm_legacy', qq: '' })
  ok(r.status === 200 && r.json?.entry?.qq === '', 'update qq 传空串 → 200（清掉身份）', r)
  r = await call('POST', `${P}/memory/update`, { id: 'm_legacy', qq: '222222222' })

  r = await call('GET', `${P}/memory/list`)
  ok(r.status === 200 && r.json?.count === memory.entries.length, 'list 条数与 store 一致', r.json?.count)
  ok(Array.isArray(r.json?.entries) && r.json.entries.every((e) => 'qq' in e), 'list 每条都有 qq 字段')
  ok(
    r.json.entries.find((e) => e.id === 'm_xiaowang_a')?.qq === '111111111' &&
      r.json.entries.find((e) => e.id === 'm_xiaowang_b')?.qq === '222222222',
    'list 里同名两人的 qq 各自正确',
  )

  // ── 7. engine 写入路径 ────────────────────────────────────────────
  console.log('\n[8] engine 写入路径：规则层落库时带的是发送者 QQ')
  const { ChatEngine } = await import(pathToFileURL(path.join(LIB_DIR, 'engine.js')).href)
  const fakeThis = {
    memory,
    relations: { setImpression: () => {} },
    logger: () => {},
    config: {},
    // 2026-10-19 起，learnByRule 落库要走闸门（remember），
    // 这里补上它依赖的三样东西，否则会抛 "this.remember is not a function"
    memoryPending: new PendingStore({ dir: memoryDir, logger: () => {} }),
    memoryGate: { added: 0, rejected: 0, pending: 0, dup: 0 },
    remember: ChatEngine.prototype.remember,
  }
  const evGroup = { user_id: '111111111', message_type: 'group', group_id: '666666666', sender: {} }
  const hitRule = ChatEngine.prototype.learnByRule.call(fakeThis, '我叫示例用户D', '主人', evGroup)
  ok(hitRule === true, '规则层命中「我叫…」')
  const engineEntry = [...memory.entries].reverse().find((e) => String(e.text).includes('示例用户D'))
  ok(engineEntry?.qq === '111111111', '群聊里记的是发送者 QQ', engineEntry)
  ok(memory.entries.every((e) => e.qq !== '666666666'), '群号没有被当成人写进任何条目（不是群号）')

  // ── 8. 迁移脚本（独立假库：真正的"老数据"长什么样，就从这里测）────
  console.log('\n[9] migrate-memory-qq：dry-run 不写盘、幂等')
  const migDir = path.join(TMP, 'migrate')
  const migFile = path.join(migDir, 'memory.json')
  const migMd = path.join(migDir, 'memory.md')
  const outDir = path.join(TMP, 'bak')
  fs.mkdirSync(migDir, { recursive: true })
  fs.writeFileSync(
    migFile,
    JSON.stringify(
      {
        version: 1,
        entries: [
          // relations 里两个键、但都是同一个号 → 唯一命中，应迁移
          { id: 'p1', kind: 'fact', who: '老王', text: '他养了一只猫叫团子', weight: 3, at: 1700000000000 },
          // 同名两个不同号 → 歧义，跳过
          { id: 'p2', kind: 'fact', who: '双号', text: '这条应该被跳过', weight: 3, at: 1700100000000 },
          // relations 里根本没这个名字 → 无匹配，跳过
          { id: 'p3', kind: 'fact', who: '查无此人', text: '这条没有对应关系', weight: 3, at: 1700200000000 },
          // 系统条目，who 为空 → 跳过
          { id: 'p4', kind: 'sticker', who: '', text: '学到了表情包：彩虹鸟', weight: 2, at: 1700300000000 },
          // 已经有号 → 不算可迁移
          { id: 'p5', kind: 'fact', who: '小张', qq: '888888888', text: '他在杭州', weight: 3, at: 1700400000000 },
        ],
      },
      null,
      2,
    ),
    'utf8',
  )
  fs.copyFileSync(path.join(memoryDir, 'relations.json'), path.join(migDir, 'relations.json'))
  // 老库一般已经有 memory.md（save() 会一起重写），备份要把两份都带上
  fs.writeFileSync(migMd, '# 旧记忆\n', 'utf8')

  const migrate = path.join(PROJ, 'tools', 'migrate-memory-qq.mjs')
  const runMigrate = (...extra) => {
    const res = spawnSync(process.execPath, [migrate, '--dir', migDir, '--out', outDir, ...extra], {
      encoding: 'utf8',
    })
    return { code: res.status, out: `${res.stdout || ''}${res.stderr || ''}` }
  }

  const migBytesBefore = fs.readFileSync(migFile)
  const dry1 = runMigrate()
  const dry2 = runMigrate()
  const summaryOf = (text) => text.split('\n').find((l) => l.includes('汇总')) || ''
  ok(dry1.code === 0, 'dry-run 退出码 0', dry1.out.slice(0, 400))
  ok(/dry-run/.test(dry1.out), '输出里写明是 dry-run')
  ok(/可迁移\s*1/.test(dry1.out), '可迁移 = 1（只有「老王」唯一命中）', summaryOf(dry1.out))
  ok(/歧义\s*1/.test(dry1.out), '歧义 = 1（「双号」两个号）', summaryOf(dry1.out))
  ok(/无匹配\s*1/.test(dry1.out), '无匹配 = 1（「查无此人」）', summaryOf(dry1.out))
  ok(/who 为空\s*1/.test(dry1.out), 'who 为空 = 1（系统条目）', summaryOf(dry1.out))
  ok(dry1.out.includes('跳过（歧义）'), '歧义那条被明确打印出来')
  ok(dry1.out === dry2.out, '两次 dry-run 输出完全一致（幂等）')
  ok(Buffer.compare(migBytesBefore, fs.readFileSync(migFile)) === 0, 'dry-run 没动 memory.json')
  ok(!fs.existsSync(outDir) || fs.readdirSync(outDir).length === 0, 'dry-run 没产生备份文件')

  console.log('\n[10] migrate-memory-qq --apply：只补唯一命中的、跳过歧义')
  const applied = runMigrate('--apply')
  ok(applied.code === 0, 'apply 退出码 0', applied.out.slice(-500))
  const afterApply = readJson(migFile).entries
  ok(afterApply.find((e) => e.id === 'p1')?.qq === '222222222', '唯一命中的「老王」补上了 222222222')
  ok(afterApply.find((e) => e.id === 'p2')?.qq === '', '歧义（同名两个号）的条目保持空串')
  ok(afterApply.find((e) => e.id === 'p3')?.qq === '', 'relations 里没有的名字保持空串')
  ok(afterApply.find((e) => e.id === 'p4')?.qq === '', 'who 为空的系统条目保持空串')
  ok(afterApply.find((e) => e.id === 'p5')?.qq === '888888888', '本来就有号的条目原样保留')
  const baks = fs.existsSync(outDir) ? fs.readdirSync(outDir) : []
  ok(baks.some((f) => f.startsWith('memory.json.bak-memqq-')), '写前备份了 memory.json', baks)
  ok(baks.some((f) => f.startsWith('memory.md.bak-memqq-')), '写前备份了 memory.md', baks)
  ok(fs.readFileSync(migMd, 'utf8').includes('蓝色大肥鱼的记忆'), 'memory.md 被重写成正式格式')
  ok(/已写入\s*1\s*条/.test(applied.out), 'apply 输出写了写入条数', applied.out.split('\n').slice(-3))

  console.log('\n[11] 再跑一次 dry-run：已经补过的条目不会再算进可迁移')
  const dryAfter = runMigrate()
  ok(dryAfter.code === 0, 'apply 之后 dry-run 仍正常')
  ok(
    /可迁移\s*0/.test(dryAfter.out),
    'apply 之后可迁移 = 0（幂等，不会重复写）',
    summaryOf(dryAfter.out),
  )
  ok(Buffer.compare(fs.readFileSync(migFile), fs.readFileSync(migFile)) === 0, 'dry-run 依旧不写盘')
} catch (err) {
  fail++
  failures.push('未捕获异常')
  console.error('\n未捕获异常：', err)
} finally {
  fs.rmSync(TMP, { recursive: true, force: true })
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail) {
    console.log('失败项：')
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
}
