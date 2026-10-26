#!/usr/bin/env node
/**
 * 部署可移植性自测：模拟「换一台没有 G: 盘的机器」，确认插件不会因为写死路径而在启动时炸掉。
 *
 * 背景（2026-10-26 部署者反馈）：
 *   作者的机器有 G: 盘，密钥默认路径写死成 ${MOLLY_ROOT}\keys\memory.key；
 *   别人机器上 MemoryStore → loadKey 抛 ENOENT，ChatEngine 构造函数跟着抛，
 *   boot() 直接失败 —— 插件「加载成功」但 OneBot 从来没连过。
 *
 * 这个脚本只碰临时目录（os.tmpdir），不读写线上数据。跑法：
 *   node tools\path-portability-selftest.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB = path.join(HERE, '..', 'plugin', 'dsh-qq-whale', 'lib')
const load = (name) => import(pathToFileURL(path.join(LIB, name)).href)

const { defaultKeyFile, loadKey, KeyUnavailableError, isEnvelope } = await load('memcrypt.js')
const { MemoryStore } = await load('memory.js')
const { bootHealthPath } = await load('boot.js')
const { PROTECTED_PREFIXES, isProtectedPath } = await load('work-guard.js')

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'molly-portability-'))
const checks = []
function check(name, fn) {
  try {
    const detail = fn()
    checks.push({ ok: true, name, detail })
  } catch (err) {
    checks.push({ ok: false, name, detail: String(err && err.message ? err.message : err) })
  }
}
function freshDir(tag) {
  const dir = path.join(tmpRoot, tag)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/* ① 默认密钥位置从数据目录推导，不含盘符字面量 */
check('defaultKeyFile：dataDir 推导（无硬编码盘符）', () => {
  const got = defaultKeyFile({ baseDir: 'C:\\deploy\\data\\qq-whale' })
  const want = path.join('C:\\deploy\\data', 'qq-whale-keys', 'memory.key')
  assert.equal(got, want)
  assert.ok(!/[A-Za-z]:\\Molly/.test(got), '推导结果里出现了作者机路径')
  return got
})
check('defaultKeyFile：MOLLY_DATA_DIR 环境变量优先', () => {
  const saved = process.env.MOLLY_DATA_DIR
  process.env.MOLLY_DATA_DIR = 'D:\\somewhere\\qq-whale'
  try {
    const got = defaultKeyFile()
    assert.equal(got, path.join('D:\\somewhere', 'qq-whale-keys', 'memory.key'))
    return got
  } finally {
    if (saved === undefined) delete process.env.MOLLY_DATA_DIR
    else process.env.MOLLY_DATA_DIR = saved
  }
})

/* ② 机器上没有那个盘：不许抛，降级明文，记忆照常可读可写 */
check('无 G: 盘：MemoryStore 构造不抛（降级明文）', () => {
  const dir = freshDir('no-drive')
  let store
  assert.doesNotThrow(() => {
    store = new MemoryStore({
      dir,
      crypt: { keyFile: 'Z:\\no-such-drive-qa\\keys\\memory.key' },
      logger: () => {},
    })
  })
  assert.equal(store.encrypted, false)
  assert.equal(store.status().encrypted, false)
  assert.ok(store.status().keyError, 'keyError 应该写明原因（/state.memory.keyError）')
  assert.match(store.status().keyError, /不可读|建不出来/)
  const entry = store.add({ kind: 'fact', text: '可移植性自测：无盘也能写记忆' })
  assert.ok(entry && entry.id, '降级后应该还能 add')
  const raw = JSON.parse(fs.readFileSync(path.join(dir, 'memory.json'), 'utf8'))
  assert.ok(!isEnvelope(raw), '降级后不应该产出加密信封')
  assert.ok(Array.isArray(raw.entries) && raw.entries.length >= 1)
  return `keyError=${store.status().keyError.slice(0, 60)}`
})

/* ③ 钥匙文件存在但内容坏了：属于数据问题，仍然要抛（不能静默把密文冲掉） */
check('密钥内容非法：仍然抛错（不静默降级）', () => {
  const dir = freshDir('bad-key')
  const keyFile = path.join(dir, 'memory.key')
  fs.writeFileSync(keyFile, 'this-is-not-a-key\n', 'utf8')
  let threw = null
  try {
    loadKey({ keyFile, create: true })
  } catch (err) {
    threw = err
  }
  assert.ok(threw, '非法密钥应该抛错')
  assert.ok(!(threw instanceof KeyUnavailableError), '这不是环境问题，不该归为 KeyUnavailableError')
  return threw.message
})

/* ④ 盘上是密文、但这台机器没有钥匙：拒绝写回，避免用明文覆盖唯一一份数据 */
check('密文 + 无钥匙：broken 且 save 拒绝', () => {
  const dir = freshDir('envelope-no-key')
  const file = path.join(dir, 'memory.json')
  const envelope = { enc: 'aes-256-gcm', iv: 'aXY=', tag: 'dGFn', data: 'ZGF0YQ==' }
  fs.writeFileSync(file, JSON.stringify(envelope), 'utf8')
  const before = fs.readFileSync(file, 'utf8')
  const store = new MemoryStore({ dir, crypt: null, logger: () => {} })
  assert.equal(store.broken, true)
  assert.equal(store.save(), false)
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'broken 状态不许改动盘上文件')
  return 'broken=true, save()=false'
})

/* ⑤ boot-health 路径：跟着 dataDir 走，写死 C: 的情况已消除 */
check('bootHealthPath：dataDir / 环境变量推导', () => {
  const got = bootHealthPath({ dataDir: 'Z:\\nope\\data\\qq-whale' })
  assert.equal(got, path.join('Z:\\nope\\data\\qq-whale', 'boot-health.json'))
  const saved = process.env.MOLLY_BOOT_HEALTH
  process.env.MOLLY_BOOT_HEALTH = path.join(tmpRoot, 'health.json')
  try {
    assert.equal(bootHealthPath({ dataDir: 'Z:\\x' }), process.env.MOLLY_BOOT_HEALTH)
  } finally {
    if (saved === undefined) delete process.env.MOLLY_BOOT_HEALTH
    else process.env.MOLLY_BOOT_HEALTH = saved
  }
  return got
})

/* ⑥ 干活会话护栏：能拦本机插件源码，且不再依赖作者机路径 */
check('work-guard：受保护前缀本机推导 + 能拦住源码', () => {
  assert.ok(PROTECTED_PREFIXES.length >= 3, '受保护前缀太少')
  assert.equal(new Set(PROTECTED_PREFIXES.map((x) => x.toLowerCase())).size, PROTECTED_PREFIXES.length, '前缀有重复')
  for (const p of PROTECTED_PREFIXES) assert.ok(path.isAbsolute(p), `不是绝对路径：${p}`)
  assert.equal(isProtectedPath(path.join(LIB, 'main.js')), true, '本机插件源码没被保护')
  assert.equal(isProtectedPath(path.join(tmpRoot, 'scratch', 'x.txt')), false, '临时目录不应该被保护')
  return PROTECTED_PREFIXES.join(' | ')
})

/* ⑦ 静态扫描：运行期代码里不许再有写死的 Molly 绝对路径 */
check('lib 静态扫描：无写死盘符（白名单除外）', () => {
  const allowed = new Map([
    ['memcrypt.js', 1], // LEGACY_KEY_FILE 常量（只做文档/回退参考）
    ['work-guard.js', 3], // 作者机历史三条前缀（本机行为不变）
  ])
  const files = fs
    .readdirSync(LIB)
    .filter((f) => f.endsWith('.js') && !f.includes('.bak'))
  const offenders = []
  for (const f of files) {
    const text = fs.readFileSync(path.join(LIB, f), 'utf8')
    const hits = text.match(/[A-Za-z]:\\\\Molly/g) || []
    const limit = allowed.get(f) ?? 0
    if (hits.length > limit) offenders.push(`${f}(${hits.length}>${limit})`)
  }
  assert.deepEqual(offenders, [], `仍有写死路径：${offenders.join(', ')}`)
  return `${files.length} 个文件扫描通过`
})

try {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
} catch {
  /* 清理失败不影响结论 */
}

const failed = checks.filter((c) => !c.ok)
for (const c of checks) console.log(`${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail && c.ok ? `  → ${c.detail}` : ''}`)
if (failed.length) {
  console.error(`\n${failed.length} 项失败：`)
  for (const c of failed) console.error(`  - ${c.name}: ${c.detail}`)
  process.exit(1)
}
console.log(`\n全部 ${checks.length} 项通过`)
