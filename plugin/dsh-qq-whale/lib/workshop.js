/**
 * workshop.js —— 插件工坊：写草稿 → 自测 → 打 zip。
 *
 * 用户 333333333 的原话是「做一个插件仓库……然后不挂载」。所以这个模块的产出
 * 只有**文件**：目录、manifest、zip。它没有任何「把插件交给宿主加载」的代码路径，
 * 也不 import 任何宿主管理服务；tools/test-workshop.mjs 里有一条断言盯着源码，
 * 确保那几个宿主管理标识一个都不出现（0 命中）。
 *
 * 目录结构（根目录默认 ${MOLLY_ROOT}\plugin-workshop，可用 config.workshopDir 覆盖）：
 *   <dir>/
 *     <slug>/manifest.json     元数据 + lastTest
 *     <slug>/index.js          cordis 插件草稿
 *     <slug>/README.md
 *     dist/<slug>-<version>-<ts>.zip + 同名 .sha256 + dist/index.json
 *     tmp/                     构建临时目录（每次用完清空）
 *
 * 为什么 zip 用 node:zlib 手写、而不是 Compress-Archive：
 *   ① 不依赖 pwsh（不同 Windows 版本 Compress-Archive 行为不一致，还会把 BOM/时间戳带进去）；
 *   ② 条目顺序、时间戳、压缩级别都由我们定，同一个插件重复打包的 sha256 可复现；
 *   ③ 不装任何 npm 包，纯 node:zlib，代码短且可审。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

/** slug 规则：小写字母开头，2~32 位，只允许 a-z 0-9 -。 */
export const SLUG_RE = /^[a-z][a-z0-9-]{1,31}$/

/** 子进程调 apply 的超时。20 秒：模板插件毫秒级返回，20 秒足够跑完带 IO 的初始化。 */
export const DEFAULT_TEST_TIMEOUT_MS = 20000

/** 静态检查单个文件的超时，10 秒足够 node --check 读完任何正常源码。 */
const STATIC_TIMEOUT_MS = 10000

/** 子进程日志最多保留多少字符（避免模型/日志被一坨栈刷爆）。 */
const TAIL_CHARS = 4000

/** 目录里这些名字不算插件。 */
const RESERVED = new Set(['dist', 'tmp'])

/** 这些目录不参与静态检查与打包。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.vscode', 'dist', 'tmp'])

const TEMPLATE_INDEX = (slug, name) => `/**
 * ${name}（工坊草稿，未挂载）
 *
 * ⚠️ 这是插件工坊里的一份草稿文件，不是线上插件。工坊只会对它做两件事：
 *    静态检查 + 在隔离子进程里调一次 apply，然后打包成 zip。
 *    它不会被任何宿主加载，也不会出现在宿主的插件列表里。
 *
 * 改这个文件之后，用 molly_workshop 工具执行 test 自检、pack 打包。
 */
export const name = '${slug}'

/** 需要宿主注入的服务名（写空数组表示什么都不依赖）。 */
export const inject = []

/**
 * cordis 插件入口。
 * @param {object} ctx 宿主上下文（工坊里是 stub，只保证不崩）
 * @param {object} config 插件配置
 */
export default function apply(ctx, config = {}) {
  ctx.logger?.info?.(\`[${slug}] 草稿已加载（仅自检用）\`)
  return () => {
    // 卸载时清理自己注册的东西
  }
}
`

const TEMPLATE_README = (slug, name) => `# ${name}

> 插件工坊草稿：只在本地仓库里，**不挂载**。

- slug：\`${slug}\`
- 入口：\`index.js\`（默认导出 \`apply(ctx, config)\`）
- 自检：\`molly_workshop action=test slug=${slug}\`
- 打包：\`molly_workshop action=pack slug=${slug}\`

## 做什么

（一句话说清楚这个插件解决什么问题）

## 依赖

（依赖哪些宿主服务；没有就写「无」）

## 备注

工坊只在隔离子进程里调一次 apply，调用失败会写进 manifest.lastTest，
不会影响线上 Molly。
`

/** 生成给子进程跑的 runner 源码（每次 test 写一份到 tmp/）。 */
const RUNNER_SOURCE = `// 工坊自检 runner（临时文件，test 结束即删）
const dir = process.argv[2]
const { pathToFileURL } = await import('node:url')
const { join } = await import('node:path')
const noop = () => {}
const svc = new Proxy({}, { get: () => noop })
const hooks = []
const ctx = {
  logger: Object.assign((...a) => {}, { info: noop, warn: noop, error: noop, debug: noop }),
  // 宿主服务一律给空壳：草稿碰不到真实的网络/模型/工具
  get: () => svc,
  on: (n) => { hooks.push(n); return noop },
  once: (n) => { hooks.push(n); return noop },
  emit: noop,
  effect: () => noop,
  setTimeout: () => 0,
  setInterval: () => 0,
  clearTimeout: noop,
  clearInterval: noop,
  tools: { register: () => noop },
  llm: svc,
}
const mod = await import(pathToFileURL(join(dir, 'index.js')).href)
const applyFn =
  typeof mod.default === 'function'
    ? mod.default
    : mod.default && typeof mod.default.apply === 'function'
      ? mod.default.apply
      : mod.apply
if (typeof applyFn !== 'function') {
  console.error('WORKSHOP_NO_APPLY: index.js 没有默认导出的 apply 函数')
  process.exit(2)
}
const config = (mod.default && mod.default.config) || mod.config || {}
const ret = await applyFn(ctx, config)
if (typeof ret === 'function') {
  try {
    ret()
  } catch (err) {
    console.error('WORKSHOP_DISPOSE_ERROR: ' + (err && err.message))
  }
}
console.log('WORKSHOP_APPLY_OK hooks=' + hooks.join(','))
`

/* ─────────────────────────── 小工具 ─────────────────────────── */

function tailText(text, n = TAIL_CHARS) {
  const s = String(text ?? '')
  return s.length > n ? `…(已截断)…\n${s.slice(-n)}` : s
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

/** 20261019-235512，用于 zip 文件名（同一秒重复打包靠 -1/-2 兜底）。 */
function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${p(d.getFullYear(), 4)}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/**
 * 子进程环境：把任何像凭据的变量全部剔掉。
 *
 * 为什么按「键名」而不是按值：值可能是任意字符串，没法判断；而凭据的键名
 * 在这台机器上都是固定套路（NAPCAT_*、PUSHPLUS_*、*_TOKEN、*_SECRET、*_KEY）。
 * 插件草稿是模型写的，不能给它任何能读到真实凭据的机会。
 */
export function cleanEnv(env = process.env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) {
    if (/TOKEN|SECRET|PASSWORD|PASSWD|APIKEY|API_KEY|_KEY\b|NAPCAT|PUSHPLUS|CONSOLE_TOKEN/i.test(k)) continue
    out[k] = v
  }
  return out
}

/* ────────────────────────── zip（手写） ────────────────────────── */

let CRC_TABLE = null
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256)
    for (let i = 0; i < 256; i++) {
      let c = i
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      CRC_TABLE[i] = c
    }
  }
  let crc = -1
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff]
  return (crc ^ -1) >>> 0
}

/** JS Date → ZIP 的 DOS 时间/日期（2 秒精度，1980 起算）。 */
function dosDateTime(ms) {
  const d = new Date(ms || Date.now())
  const year = Math.max(1980, d.getFullYear())
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const date = ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

/**
 * 生成 zip。entries: [{ name, data, mtimeMs }]
 * 每条优先 deflate；压不动就 store（method=0），保证小文件不会越压越大。
 */
export function buildZip(entries) {
  const locals = []
  const centrals = []
  let offset = 0

  for (const e of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8')
    const deflated = zlib.deflateRawSync(raw, { level: 9 })
    const useDeflate = deflated.length < raw.length
    const body = useDeflate ? deflated : raw
    const method = useDeflate ? 8 : 0
    const crc = crc32(raw)
    const { time, date } = dosDateTime(e.mtimeMs)

    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0) // 本地文件头签名
    lh.writeUInt16LE(20, 4) // 解压所需版本
    lh.writeUInt16LE(0x0800, 6) // bit11：文件名 UTF-8
    lh.writeUInt16LE(method, 8)
    lh.writeUInt16LE(time, 10)
    lh.writeUInt16LE(date, 12)
    lh.writeUInt32LE(crc, 14)
    lh.writeUInt32LE(body.length, 18)
    lh.writeUInt32LE(raw.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28)
    locals.push(lh, nameBuf, body)

    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0) // 中央目录条目签名
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0x0800, 8)
    ch.writeUInt16LE(method, 10)
    ch.writeUInt16LE(time, 12)
    ch.writeUInt16LE(date, 14)
    ch.writeUInt32LE(crc, 16)
    ch.writeUInt32LE(body.length, 20)
    ch.writeUInt32LE(raw.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt32LE(0, 30) // extra
    ch.writeUInt32LE(0, 32) // comment
    ch.writeUInt16LE(0, 34) // 起始磁盘
    ch.writeUInt16LE(0, 36) // 内部属性
    ch.writeUInt32LE(0, 38) // 外部属性
    ch.writeUInt32LE(offset, 42) // 本地头偏移
    centrals.push(ch, nameBuf)

    offset += lh.length + nameBuf.length + body.length
  }

  const central = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // 中央目录结束签名
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(central.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, central, eocd])
}

/* ─────────────────────────── Workshop ─────────────────────────── */

export class Workshop {
  /**
   * @param {object} opts
   * @param {string} opts.dir       工坊根目录（main.js 传 config.workshopDir）
   * @param {(level:string,msg:string)=>void} [opts.logger]
   * @param {number} [opts.testTimeoutMs] 子进程超时（测试里调小，默认 20 秒）
   * @param {string} [opts.nodePath]  node 可执行文件（默认当前进程）
   */
  constructor({ dir, logger, testTimeoutMs = DEFAULT_TEST_TIMEOUT_MS, nodePath } = {}) {
    if (!dir) throw new Error('Workshop 需要一个目录')
    this.dir = path.resolve(dir)
    this.distDir = path.join(this.dir, 'dist')
    this.tmpDir = path.join(this.dir, 'tmp')
    this.testTimeoutMs = testTimeoutMs
    this.nodePath = nodePath || process.execPath
    this.log = typeof logger === 'function' ? logger : () => {}
    ensureDir(this.dir)
    ensureDir(this.distDir)
    ensureDir(this.tmpDir)
  }

  /**
   * slug 合法性 + 目录逃逸防护。
   *
   * 两道都要：正则挡住 `../x`、`/abs`、`Abc`、33 位；resolve 之后再确认
   * 结果仍在工坊根目录内——正则哪天被放宽，第二道还能兜住。
   */
  inside(slug) {
    const s = String(slug ?? '')
    if (!SLUG_RE.test(s)) {
      throw new Error(`slug 不合法「${s}」：只能是小写字母开头、2~32 位、a-z 0-9 -`)
    }
    // dist/ tmp/ 是工坊自己的目录，不能被插件占用
    if (RESERVED.has(s)) throw new Error(`slug 不能用保留名「${s}」`)
    const p = path.resolve(this.dir, s)
    const rel = path.relative(this.dir, p)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`slug 指向工坊目录之外「${s}」`)
    }
    return p
  }

  pluginDir(slug) {
    return this.inside(slug)
  }

  manifestPath(slug) {
    return path.join(this.inside(slug), 'manifest.json')
  }

  /** 新建草稿：目录 + manifest + index.js + README.md。 */
  newPlugin(slug, name, author) {
    const p = this.inside(slug)
    if (fs.existsSync(p)) throw new Error(`插件已存在：${slug}`)
    fs.mkdirSync(p, { recursive: true })
    const at = new Date().toISOString()
    const display = String(name || slug).trim() || slug
    const manifest = {
      slug,
      name: display,
      author: String(author || 'Molly').trim() || 'Molly',
      createdAt: at,
      updatedAt: at,
      version: '0.1.0',
      status: 'draft',
      lastTest: null,
    }
    writeJson(path.join(p, 'manifest.json'), manifest)
    fs.writeFileSync(path.join(p, 'index.js'), TEMPLATE_INDEX(slug, display), 'utf8')
    fs.writeFileSync(path.join(p, 'README.md'), TEMPLATE_README(slug, display), 'utf8')
    this.log('info', `工坊：新建草稿 ${slug}`)
    return manifest
  }

  /** 列出所有草稿（按 slug 排序）；dist/ tmp/ 这类保留目录不算。 */
  list() {
    const out = []
    for (const ent of fs.readdirSync(this.dir, { withFileTypes: true })) {
      if (!ent.isDirectory() || RESERVED.has(ent.name) || !SLUG_RE.test(ent.name)) continue
      const mf = path.join(this.dir, ent.name, 'manifest.json')
      if (!fs.existsSync(mf)) continue
      try {
        const m = readJson(mf)
        out.push({
          slug: m.slug || ent.name,
          name: m.name || ent.name,
          version: m.version || '',
          status: m.status || 'draft',
          lastTest: m.lastTest || null,
          updatedAt: m.updatedAt || '',
        })
      } catch {
        out.push({ slug: ent.name, name: ent.name, version: '', status: 'broken', lastTest: null, updatedAt: '' })
      }
    }
    return out.sort((a, b) => (a.slug < b.slug ? -1 : 1))
  }

  /** 单个草稿详情：manifest + 文件清单 + 该 slug 的历史 zip。 */
  status(slug) {
    const p = this.inside(slug)
    const mf = path.join(p, 'manifest.json')
    if (!fs.existsSync(mf)) throw new Error(`插件不存在：${slug}`)
    const manifest = readJson(mf)
    const files = fs.readdirSync(p).filter((f) => fs.statSync(path.join(p, f)).isFile())
    const packs = fs
      .readdirSync(this.distDir)
      .filter((f) => f.startsWith(`${slug}-`) && f.endsWith('.zip'))
      .sort()
    return { ...manifest, files, packs, dir: p }
  }

  /**
   * 自检：静态 node --check + 隔离子进程调 apply。
   * 结果写回 manifest.lastTest；通过则 status=tested，不通过退回 draft。
   */
  async test(slug) {
    const p = this.inside(slug)
    const mf = path.join(p, 'manifest.json')
    if (!fs.existsSync(mf)) throw new Error(`插件不存在：${slug}`)
    const manifest = readJson(mf)

    // ① 静态：全目录 .js 逐个 node --check（语法错会带出「文件:行号」）
    const staticResults = []
    for (const rel of this.walkFiles(p, (f) => f.endsWith('.js'))) {
      const abs = path.join(p, rel)
      const r = await this.runChecked(this.nodePath, ['--check', abs], { cwd: p, timeoutMs: STATIC_TIMEOUT_MS })
      staticResults.push({ file: rel, ok: r.code === 0, error: r.code === 0 ? '' : tailText(r.stderr || r.stdout, 1200) })
    }

    // ② 运行时：语法都过了才值得起子进程（否则肯定同样的错，白等 20 秒）
    let runtime
    if (staticResults.every((s) => s.ok)) {
      runtime = await this.runApply(p)
    } else {
      runtime = { exit: null, timedOut: false, skipped: true, stdoutTail: '', stderrTail: '（静态检查未通过，跳过运行时）' }
    }

    const staticOk = staticResults.length > 0 && staticResults.every((s) => s.ok)
    const runtimeOk = runtime.exit === 0 && !runtime.timedOut
    const ok = staticOk && runtimeOk
    const summary = ok
      ? `静态检查 ${staticResults.length} 个文件通过；apply 运行正常（exit=0）`
      : [
          staticOk ? `静态检查 ${staticResults.length} 个文件通过` : '静态检查失败',
          runtime.timedOut ? `apply 超时（>${this.testTimeoutMs}ms）` : `apply exit=${runtime.exit}`,
          firstErrorLine(staticResults, runtime),
        ]
          .filter(Boolean)
          .join('；')

    const at = new Date().toISOString()
    manifest.lastTest = { at, ok, summary }
    manifest.updatedAt = at
    manifest.status = ok ? 'tested' : 'draft'
    writeJson(mf, manifest)

    this.log(ok ? 'info' : 'warn', `工坊：${slug} 自检 ${ok ? '通过' : '失败'} — ${summary}`)
    return { slug, ok, summary, static: staticResults, runtime }
  }

  /**
   * 打包：zip + sha256 + dist/index.json，manifest.status=packaged。
   * 前提是最近一次自检通过——没测过就打包等于把未知状态塞进仓库。
   */
  pack(slug) {
    const p = this.inside(slug)
    const mf = path.join(p, 'manifest.json')
    if (!fs.existsSync(mf)) throw new Error(`插件不存在：${slug}`)
    const manifest = readJson(mf)
    if (!manifest.lastTest || !manifest.lastTest.ok) {
      throw new Error(`「${slug}」还没通过自检，先 test 再 pack`)
    }

    /*
     * 先把 manifest 定稿成 packaged、再打包。
     * 顺序很重要：反过来的话，zip 里的 manifest 还写着 tested，而 dist/index.json
     * 已经记成 packaged，同一个插件在包内包外两种状态，回查时必吵架。
     */
    const at = new Date().toISOString()
    const prevStatus = manifest.status
    const prevUpdatedAt = manifest.updatedAt
    manifest.status = 'packaged'
    manifest.updatedAt = at
    writeJson(mf, manifest)

    let entries = []
    let buf
    let file = ''
    let zipPath = ''
    try {
      entries = this.walkFiles(p).map((rel) => {
        const abs = path.join(p, rel)
        return {
          name: `${slug}/${rel.split(path.sep).join('/')}`,
          data: fs.readFileSync(abs),
          mtimeMs: fs.statSync(abs).mtimeMs,
        }
      })
      if (!entries.length) throw new Error(`「${slug}」目录是空的`)

      buf = buildZip(entries)
      const base = `${slug}-${manifest.version || '0.0.0'}-${stamp()}`
      file = `${base}.zip`
      for (let i = 2; fs.existsSync(path.join(this.distDir, file)); i++) file = `${base}-${i}.zip`
      zipPath = path.join(this.distDir, file)
      fs.writeFileSync(zipPath, buf)
    } catch (err) {
      // 打包失败：状态退回原样，别留一个假的 packaged
      manifest.status = prevStatus
      manifest.updatedAt = prevUpdatedAt
      writeJson(mf, manifest)
      throw err
    }

    const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
    fs.writeFileSync(path.join(this.distDir, `${file}.sha256`), `${sha256}  ${file}\n`, 'utf8')

    const indexPath = path.join(this.distDir, 'index.json')
    const index = fs.existsSync(indexPath) ? readJson(indexPath) : []
    const list = Array.isArray(index) ? index : []
    list.push({ slug, version: manifest.version || '', file, sha256, size: buf.length, at, status: 'packaged' })
    writeJson(indexPath, list)

    this.cleanTmp()

    this.log('info', `工坊：${slug} 已打包 ${file}（${buf.length}B, sha256=${sha256.slice(0, 12)}…）`)
    return { slug, file, path: zipPath, sha256, size: buf.length, at, files: entries.map((e) => e.name) }
  }

  /** 删除草稿目录（dist 里的 zip 保留，方便回查历史）。 */
  remove(slug) {
    const p = this.inside(slug)
    if (!fs.existsSync(p)) throw new Error(`插件不存在：${slug}`)
    fs.rmSync(p, { recursive: true, force: true })
    this.log('info', `工坊：已删除草稿 ${slug}（历史 zip 保留在 dist/）`)
    return { slug, removed: true, dir: p }
  }

  /** 清空 tmp/（保留目录本身）。 */
  cleanTmp() {
    if (!fs.existsSync(this.tmpDir)) return 0
    let n = 0
    for (const name of fs.readdirSync(this.tmpDir)) {
      fs.rmSync(path.join(this.tmpDir, name), { recursive: true, force: true })
      n++
    }
    return n
  }

  /** 递归列文件（相对路径），自动跳过 node_modules/.git/dist/tmp 与隐藏目录。 */
  walkFiles(root, filter = null, prefix = '') {
    const out = []
    for (const ent of fs.readdirSync(path.join(root, prefix), { withFileTypes: true })) {
      if (ent.name.startsWith('.')) continue
      const rel = prefix ? path.join(prefix, ent.name) : ent.name
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue
        out.push(...this.walkFiles(root, filter, rel))
      } else if (ent.isFile()) {
        if (!filter || filter(rel)) out.push(rel)
      }
    }
    return out.sort()
  }

  /** 起子进程：清环境、限时、回收输出。 */
  runChecked(cmd, args, { cwd, timeoutMs, env = cleanEnv() } = {}) {
    return new Promise((resolve) => {
      let child
      try {
        child = spawn(cmd, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (err) {
        resolve({ code: -1, timedOut: false, stdout: '', stderr: String(err?.message || err) })
        return
      }
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        try {
          child.kill('SIGKILL')
        } catch {
          /* 进程可能已退出 */
        }
      }, timeoutMs)
      child.stdout.on('data', (d) => {
        if (stdout.length < 200000) stdout += d
      })
      child.stderr.on('data', (d) => {
        if (stderr.length < 200000) stderr += d
      })
      const done = (code) => {
        clearTimeout(timer)
        resolve({ code, timedOut, stdout: tailText(stdout), stderr: tailText(stderr) })
      }
      child.on('error', (err) => {
        stderr += String(err?.message || err)
        done(-1)
      })
      child.on('close', (code) => done(timedOut ? -1 : code))
    })
  }

  /** 起 runner 子进程调 apply。 */
  async runApply(pluginPath) {
    ensureDir(this.tmpDir)
    const runner = path.join(this.tmpDir, `run-${path.basename(pluginPath)}-${process.pid}-${Date.now()}.mjs`)
    fs.writeFileSync(runner, RUNNER_SOURCE, 'utf8')
    try {
      const r = await this.runChecked(this.nodePath, [runner, pluginPath], {
        cwd: pluginPath,
        timeoutMs: this.testTimeoutMs,
      })
      return { exit: r.code, timedOut: r.timedOut, skipped: false, stdoutTail: r.stdout, stderrTail: r.stderr }
    } finally {
      try {
        fs.rmSync(runner, { force: true })
      } catch {
        /* 清理失败不影响结论 */
      }
    }
  }
}

/** 失败时挑一条最能说明问题的错误行（优先静态检查的「文件:行号」+ SyntaxError）。 */
function firstErrorLine(staticResults, runtime) {
  const bad = staticResults.find((s) => !s.ok)
  if (bad) {
    const text = bad.error || ''
    const loc = /([^\s:()]+\.js):(\d+)/.exec(text)
    const syn = text
      .split('\n')
      .map((s) => s.trim())
      .find((s) => /^SyntaxError/.test(s))
    const where = loc ? `${loc[1]}:${loc[2]}` : bad.file
    return `${where} ${syn || '语法错误'}`.trim()
  }
  const err = (runtime?.stderrTail || '').split('\n').filter(Boolean).slice(-1)[0]
  return err || ''
}

export default Workshop
