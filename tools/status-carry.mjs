#!/usr/bin/env node
/**
 * 把「底层状态指令 `#molly`」回填进一棵 release 树（主人 m00525）
 * ===========================================================================
 * 背景：`#molly` 是 2026-10-26 才写进源码的功能，之前的 16 个 release zip 里都没有。
 * 主人要求：现有 release 全部补上，而且以后发版必须带着。
 *
 * 做法：**不改历史 tag，也不重新打 tag**。`release-assets.mjs` 本来就是
 * `git archive <tag>` 导出提交树再打包上传，所以只要在导出之后、打包之前
 * 往树里打三处补丁、补一个 lib/status-command.js，上传的 zip 就是带功能的。
 *
 * 为什么是「打补丁」而不是「把新版 main.js 塞回老包」：
 *   每个 tag 的 main.js 都不一样（v1.0.0 1605 行 … Hotfix.3 1848 行），整份替换
 *   会把该版本自己的修复合进去/丢掉。只插三段、且锚点文本在 16 个 tag 里逐字相同
 *   （都验过），是唯一既能带上功能、又不污染版本内容的方式。
 *
 * 三处插入（锚点全 tag 一致）：
 *   1. `const onebotMod = await loadModule('onebot', './onebot.js')` 之前 → 装载模块
 *   2. `state.events = eventRing` 那一行之后 → 造处理器（此时 config/state/metrics
 *      /pushEvent/engine 都已就位；engine 用闭包读实时值，装载时它还是 null）
 *   3. 消息分支里第一个 `if (config.blindMode) {` 之前 → 拦截并吞掉这条消息
 *      （在 blindMode 之前，所以闭眼也应答；在命令体系/模型之前，所以不花 token）
 *
 * 幂等：树里已经有 `statusHandler.handle(ev)` 就不再插，只做校验和覆盖
 * `lib/status-command.js`（版本号单一来源 = 本仓库源码）。
 *
 * 用法：
 *   node tools/status-carry.mjs --tags v1.0.0,v1.1.3      # 从发布仓库导出→回填→校验（不打包不上传）
 *   node tools/status-carry.mjs --tree out/release-assets/tree-v1.0.0   # 只回填一棵已有的树
 *   node tools/status-carry.mjs --tags all --keep          # 保留导出的树方便翻看
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const TOOL_DIR = path.dirname(fileURLToPath(import.meta.url))
export const WORKSPACE_DIR = path.resolve(TOOL_DIR, '..')
export const DEFAULT_REPO_DIR = 'G:\\Molly\\publish\\molly-qq-whale'
export const STATUS_SOURCE = path.join(WORKSPACE_DIR, 'plugin', 'dsh-qq-whale', 'lib', 'status-command.js')
export const MAIN_REL = 'plugin/dsh-qq-whale/lib/main.js'
export const STATUS_REL = 'plugin/dsh-qq-whale/lib/status-command.js'
/** 原生实现所在的文件（≥ v1.1.5-Hotfix.3 的 `#molly` 就在这里的 hash 命令表里） */
export const HASH_REL = 'plugin/dsh-qq-whale/lib/hash-commands.js'

/** 该树自己的版本号（= 这个 tag 的 package.json）；没有就返回空串。 */
export function versionOf(treeDir) {
  // 注意发布仓库的 package.json 在 `plugin/dsh-qq-whale/` 下，根目录没有。
  for (const rel of ['plugin/dsh-qq-whale/package.json', 'package.json']) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(treeDir, rel), 'utf8'))?.version
      if (v) return String(v)
    } catch {
      /* 换下一个位置 */
    }
  }
  return ''
}

/**
 * 这棵树是否**原生**支持 `#molly`（2026-10-26 之后源码把这条指令并进了 hash 命令表，
 * 不再有独立的 lib/status-command.js）。原生支持时回填是多余的：老包要补，
 * 新包只要校验，别拿「源码里没有 status-command.js」把新 tag 拦下。
 */
export function hasNativeStatus(treeDir) {
  try {
    const src = fs.readFileSync(path.join(treeDir, HASH_REL), 'utf8')
    return /molly\s*:\s*'status'/.test(src)
  } catch {
    return false
  }
}

/* ── 第 1 段：模块装载（插在 onebot 装载之前，此时 loadModule 已定义）────── */
const LOAD_BLOCK = [
  '/* 底层状态指令 `#molly`：模块装载（2026-10-26 统一回填，源码见 lib/status-command.js） */',
  "const statusCommandMod = await loadModule('statusCommand', './status-command.js', { optional: true })",
  'const createStatusHandler = statusCommandMod?.createStatusHandler || null',
]

/* ── 第 2 段：处理器（插在 state.events = eventRing 之后）─────────────────── */
const HANDLER_BLOCK = [
  '/* ── 底层状态指令 `#molly` 的处理器（2026-10-26 统一回填）────────────────────',
  ' * 判定、冷却、文案全在 lib/status-command.js 里（纯函数，可离线自测）。',
  ' * 这里只负责把「当前的」运行时对象接进去：engine 是 let，插件装载时还是 null，',
  ' * 所以必须每次应答时现场取，不能在这里缓存。',
  ' */',
  'const statusBootedAt = Date.now()',
  'const statusHandler = createStatusHandler',
  '  ? createStatusHandler({',
  '      config,',
  '      getEnv: () => ({ state, engine, metrics, bootedAt: statusBootedAt }),',
  '      logger: (level, msg) => {',
  '        try {',
  "          const line = `[qq-whale] ${msg}`",
  "          if (level === 'warn') console.warn?.(line)",
  '          else console.log?.(line)',
  '        } catch {',
  '          /* 日志不许影响主流程 */',
  '        }',
  '      },',
  '      onEvent: (type, ev, extra) => pushEvent(type, ev, extra),',
  '      send: async ({ scene, id, text }) => {',
  '        const client = engine?.client',
  "        if (!client) throw new Error('OneBot 未连接')",
  "        const message = [{ type: 'text', data: { text } }]",
  "        if (scene === 'group') return client.sendGroupMsg(String(id), message)",
  '        return client.sendPrivateMsg(String(id), message)',
  '      },',
  '    })',
  '  : null',
  "if (!statusHandler) console.warn?.('[qq-whale] 底层状态指令未加载：status-command.js 缺失或语法错误，`#molly` 不会应答')",
]

/* ── 第 3 段：消息拦截（插在消息分支的 blindMode 判断之前）────────────────── */
const HOOK_COMMENT = '// 底层状态指令：整条消息就是触发词时，在 blindMode / 命令 / 模型之前接走（2026-10-26）'
const HOOK_LINE = 'if (statusHandler && statusHandler.handle(ev)) return'

/** 三段锚点（16 个 tag 逐字一致，已在发布仓库里逐个 tag 验过）。 */
export const ANCHORS = Object.freeze({
  load: "const onebotMod = await loadModule('onebot', './onebot.js')",
  handler: 'state.events = eventRing',
  branch: "if (ev.post_type === 'message') {",
  blind: 'if (config.blindMode) {',
})

/** 校验收到的 main.js 是否真的把功能接上了。返回问题列表（空 = 没问题）。 */
export function verifyMainSource(src) {
  const problems = []
  const text = String(src || '')
  const loadHits = (text.match(/loadModule\('statusCommand'/g) || []).length
  if (loadHits !== 1) problems.push(`statusCommand 模块装载应恰好 1 处，实际 ${loadHits}`)
  // 变量名两代都接受：回填工具插入的是 statusCommandMod，源码里后来简写成 statusMod
  if (!/const createStatusHandler = status(?:Command)?Mod\?\.createStatusHandler/.test(text)) {
    problems.push('缺少 createStatusHandler 取用')
  }
  const handlerDecl = (text.match(/const statusHandler = createStatusHandler/g) || []).length
  if (handlerDecl !== 1) problems.push(`statusHandler 装配应恰好 1 处，实际 ${handlerDecl}`)
  const hookHits = (text.match(/statusHandler\.handle\(ev\)/g) || []).length
  if (hookHits !== 1) problems.push(`消息拦截应恰好 1 处，实际 ${hookHits}`)
  // 运行时长起点：回填块自带 statusBootedAt；源码里直接用 boot() 里的 bootedAt
  const bootedOk = text.includes('statusBootedAt') || /bootedAt[)\s,]/.test(text)
  if (!bootedOk) problems.push('缺少运行时长起点（statusBootedAt / bootedAt）')
  // 拦截必须在 blindMode 之前，否则闭眼模式下不应答（主人拍板：闭眼也要能问）
  const branchAt = text.indexOf(ANCHORS.branch)
  const hookAt = text.indexOf('statusHandler.handle(ev)')
  const blindAt = branchAt >= 0 ? text.indexOf(ANCHORS.blind, branchAt) : -1
  if (branchAt < 0) problems.push('找不到消息分支锚点')
  if (blindAt < 0) problems.push('找不到 blindMode 锚点')
  if (branchAt >= 0 && hookAt >= 0 && blindAt >= 0 && !(branchAt < hookAt && hookAt < blindAt)) {
    problems.push('拦截点不在「消息分支 → blindMode」之间')
  }
  return problems
}

/** 给 main.js 源码打三处补丁（纯函数，方便自测）。 */
export function patchMainSource(src) {
  let out = String(src || '')
  const NL = '\n'

  const insertBeforeLine = (text, anchor, lines) => {
    const at = text.indexOf(anchor)
    if (at < 0) throw new Error(`找不到锚点：${anchor}`)
    const lineStart = text.lastIndexOf(NL, at - 1) + 1
    return text.slice(0, lineStart) + lines.join(NL) + NL + text.slice(lineStart)
  }

  const insertAfterLine = (text, anchor, lines) => {
    const at = text.indexOf(anchor)
    if (at < 0) throw new Error(`找不到锚点：${anchor}`)
    const lineEnd = text.indexOf(NL, at)
    if (lineEnd < 0) throw new Error(`锚点行没有换行：${anchor}`)
    return text.slice(0, lineEnd + 1) + lines.join(NL) + NL + text.slice(lineEnd + 1)
  }

  // 1. 模块装载
  if (!out.includes("loadModule('statusCommand'")) {
    out = insertBeforeLine(out, ANCHORS.load, LOAD_BLOCK)
  }

  // 2. 处理器
  if (!out.includes('const statusHandler = createStatusHandler')) {
    out = insertAfterLine(out, ANCHORS.handler, HANDLER_BLOCK)
  }

  // 3. 消息拦截（取消息分支之后、第一个 blindMode 判断之前的缩进）
  if (!out.includes('statusHandler.handle(ev)')) {
    const branchAt = out.indexOf(ANCHORS.branch)
    if (branchAt < 0) throw new Error('找不到消息分支锚点')
    const blindAt = out.indexOf(ANCHORS.blind, branchAt)
    if (blindAt < 0) throw new Error('消息分支里找不到 blindMode 判断')
    const lineStart = out.lastIndexOf(NL, blindAt - 1) + 1
    const indent = /^[ \t]*/.exec(out.slice(lineStart))[0]
    const lines = [`${indent}${HOOK_COMMENT}`, `${indent}${HOOK_LINE}`]
    out = out.slice(0, lineStart) + lines.join(NL) + NL + out.slice(lineStart)
  }

  return out
}

/** `node --check`：语法错误必须在这一步挡住，绝不能把坏包传上去。 */
export function checkSyntax(source, label = 'main.js') {
  const tmpDir = path.join(WORKSPACE_DIR, 'out', 'carry-check')
  fs.mkdirSync(tmpDir, { recursive: true })
  const tmp = path.join(tmpDir, `${label.replace(/[^\w.-]/g, '_')}-${process.pid}.mjs`)
  fs.writeFileSync(tmp, source, 'utf8')
  try {
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' })
    return null
  } catch (err) {
    const detail = [err?.stderr, err?.stdout].filter(Boolean).map(String).join('\n').trim()
    return detail || String(err?.message || err)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
}

/**
 * 往一棵 release 树里回填 `#molly`。
 *
 * @param {string} treeDir 树根（含 plugin/dsh-qq-whale/lib/main.js）
 * @param {{log?: Function, sourceStatus?: string}} [opts]
 * @returns {{ok: boolean, changed: boolean, already: boolean, problems: string[], manifest: object}}
 */
export function applyStatusCarry(treeDir, { log = () => {}, sourceStatus = STATUS_SOURCE } = {}) {
  const mainPath = path.join(treeDir, MAIN_REL)
  const statusPath = path.join(treeDir, STATUS_REL)
  const problems = []

  if (!fs.existsSync(mainPath)) {
    return { ok: false, changed: false, already: false, problems: [`树里没有 ${MAIN_REL}`], manifest: {} }
  }

  // 原生支持：源码已经不需要 status-command.js，只校验、不回填。
  if (hasNativeStatus(treeDir)) {
    const manifest = {
      mainBytes: fs.statSync(mainPath).size,
      statusBytes: 0,
      addedLines: 0,
      version: versionOf(treeDir),
      native: true,
    }
    log(`已是原生 #molly（hash-commands 别名），跳过回填：main.js ${manifest.mainBytes} B，version ${manifest.version}`)
    return { ok: true, changed: false, already: true, problems: [], manifest }
  }

  if (!fs.existsSync(sourceStatus)) {
    return { ok: false, changed: false, already: false, problems: [`源码里没有 ${sourceStatus}`], manifest: {} }
  }

  const before = fs.readFileSync(mainPath, 'utf8')
  const already = before.includes('statusHandler.handle(ev)')
  let after = before
  try {
    after = patchMainSource(before)
  } catch (err) {
    return {
      ok: false,
      changed: false,
      already,
      problems: [`打补丁失败：${err?.message || err}`],
      manifest: {},
    }
  }
  const changed = after !== before
  if (changed) fs.writeFileSync(mainPath, after, 'utf8')

  // status-command.js 永远以本仓库源码为准（报告版本号的唯一来源）
  fs.copyFileSync(sourceStatus, statusPath)

  const syntax = checkSyntax(after, 'main.js')
  if (syntax) problems.push(`语法检查不通过：\n${syntax}`)
  problems.push(...verifyMainSource(after))

  // 该树自己的版本号（= 这个 tag 的 package.json），report / release 正文都用它。
  // 注意发布仓库的 package.json 在 `plugin/dsh-qq-whale/` 下，根目录没有。
  let version = ''
  for (const rel of ['plugin/dsh-qq-whale/package.json', 'package.json']) {
    try {
      const v = JSON.parse(fs.readFileSync(path.join(treeDir, rel), 'utf8'))?.version
      if (v) {
        version = String(v)
        break
      }
    } catch {
      /* 换下一个位置 */
    }
  }

  const manifest = {
    mainBytes: Buffer.byteLength(after, 'utf8'),
    statusBytes: fs.statSync(statusPath).size,
    addedLines: after.split('\n').length - before.split('\n').length,
    version,
  }
  log(
    `${changed ? '已回填' : already ? '已存在（校验）' : '未改动'}：main.js +${manifest.addedLines} 行，` +
      `status-command.js ${manifest.statusBytes} B，问题 ${problems.length} 个`,
  )
  return { ok: problems.length === 0, changed, already, problems, manifest }
}

/* ── CLI：从发布仓库导出 tag 树 → 回填 → 校验 ────────────────────────────── */
function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

function parseArgs(argv) {
  const out = { repoDir: DEFAULT_REPO_DIR, tags: [], tree: '', keep: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--repo-dir') out.repoDir = argv[(i += 1)]
    else if (a === '--tags') out.tags = String(argv[(i += 1)] || '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--tree') out.tree = argv[(i += 1)]
    else if (a === '--keep') out.keep = true
    else if (a === '--help' || a === '-h') {
      console.log('用法: node tools/status-carry.mjs [--tree DIR] [--tags a,b|all] [--repo-dir DIR] [--keep]')
      process.exit(0)
    } else throw new Error(`未知参数：${a}`)
  }
  return out
}

function exportTag(repoDir, tag, workDir) {
  const dir = path.join(workDir, `tree-${tag}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const tarFile = path.join(workDir, `${tag}.tar`)
  execFileSync('git', ['archive', '--format=tar', '-o', tarFile, tag], { cwd: repoDir })
  execFileSync('tar', ['-x', '-f', tarFile, '-C', dir])
  fs.rmSync(tarFile, { force: true })
  return dir
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.tree) {
    const res = applyStatusCarry(path.resolve(args.tree), { log: console.log })
    if (!res.ok) {
      console.error('\n❌ 回填未通过：')
      for (const p of res.problems) console.error(`   - ${p}`)
      process.exitCode = 1
    }
    return
  }
  if (!fs.existsSync(path.join(args.repoDir, '.git'))) throw new Error(`不是 git 仓库：${args.repoDir}`)
  const all = git(args.repoDir, ['tag', '--list', '--sort=v:refname']).split(/\r?\n/).filter(Boolean)
  const tags = !args.tags.length || args.tags.includes('all') ? all : args.tags
  const workDir = path.join(WORKSPACE_DIR, 'out', 'carry-rehearsal')
  fs.mkdirSync(workDir, { recursive: true })

  let bad = 0
  for (const tag of tags) {
    if (!all.includes(tag)) throw new Error(`tag 不存在：${tag}`)
    const dir = exportTag(args.repoDir, tag, workDir)
    const res = applyStatusCarry(dir, { log: console.log })
    if (!res.ok) {
      bad += 1
      console.error(`\n❌ ${tag} 回填未通过：`)
      for (const p of res.problems) console.error(`   - ${p}`)
    }
    if (!args.keep) fs.rmSync(dir, { recursive: true, force: true })
  }
  console.log(`\n=== 回填演练：${tags.length - bad}/${tags.length} 通过${bad ? `，${bad} 个失败` : ''} ===`)
  if (bad) process.exitCode = 1
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    console.error(`\n[status-carry] 失败：${err?.message || err}`)
    process.exitCode = 1
  }
}
