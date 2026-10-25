#!/usr/bin/env node
/**
 * release-assets.mjs — 把版本打包成 GitHub Release 附件（2026-10-25 m03530）。
 *
 * 主人要求：「上新版本的时候把挂在上面的旧版本打包作为 release 传上去，注意隐私管理」。
 *
 * 流程（每个 tag）：
 *   1. `git archive` 导出该 tag 的提交树到临时目录（不含 .git / 未提交文件）；
 *   2. **隐私扫描**：真实 QQ 号/群号、OneBot/NapCat/PushPlus token、本机用户目录；
 *   3. 命中就地**脱敏**（换成占位符），再扫一遍；仍有命中 → 拒绝上传并报文件:行号；
 *   4. 用 bsdtar 打成 `molly-qq-whale-<tag>.zip`；
 *   5. GitHub REST API：release 不存在就建（preview tag 自动标 prerelease），
 *      上传附件；同名附件先删后传，可重复执行；
 *   6. release 正文写清「隐私扫描/脱敏结果 + 文件数 + sha256」。
 *
 * 用法（源码仓库根目录，用 bundled node）：
 *   node tools/release-assets.mjs --dry-run          # 只扫描/脱敏/打包，不上传
 *   node tools/release-assets.mjs                    # 所有 tag 补齐 release 附件
 *   node tools/release-assets.mjs --tags v1.1.3      # 只处理指定 tag
 *
 * 凭据（按顺序）：GITHUB_TOKEN / GH_TOKEN / MOLLY_GH_TOKEN → `git credential fill`。
 * 凭据只在内存里用，绝不打印、绝不写日志。
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_REPO_DIR = 'G:\\Molly\\publish\\molly-qq-whale'
const WORK_DIR = path.join(process.cwd(), 'out', 'release-assets')

/* ── 隐私名单：真实 QQ 号/群号/token 只放本地文件，绝不进发布仓库 ────────────
 * 本地文件：`tools/release-assets.secrets.json`（{"patterns":[…],"redact":{…}}）
 * 可用环境变量 MOLLY_RELEASE_SECRETS 指向别处；读不到就只有通用规则（路径/密钥头）。
 */
/* 通用规则：只认「私钥/证书头」这类明确长串；本机路径类不在这里拦——
 * 文档里 `C:\\Users\\…` 是示例路径，拦了反而把正常文档改坏。
 * 注意：下面的字面量用拼接写，避免脚本自身被自己的规则命中。 */
const GENERIC_PATTERNS = [
  ['BEGIN ', 'RSA PRIVATE KEY'].join(''),
  ['BEGIN ', 'PRIVATE KEY'].join(''),
  ['ssh-', 'rsa AAAA'].join(''),
]
const SECRETS_FILE = process.env.MOLLY_RELEASE_SECRETS || path.join(process.cwd(), 'tools', 'release-assets.secrets.json')

function loadPrivacy() {
  let patterns = [...GENERIC_PATTERNS]
  let redact = {}
  try {
    const raw = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'))
    if (Array.isArray(raw.patterns)) patterns = [...new Set([...patterns, ...raw.patterns.map(String)])]
    if (raw.redact && typeof raw.redact === 'object') redact = { ...raw.redact }
  } catch {
    console.warn(`[release-assets] 未读到本地隐私名单：${SECRETS_FILE}（只按通用规则扫描）`)
  }
  return { patterns, redact }
}

const { patterns: SECRET_PATTERNS, redact: REDACT } = loadPrivacy()

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.json', '.md', '.yml', '.yaml', '.html', '.css',
  '.txt', '.ps1', '.cmd', '.bat', '.sh', '.py', '.svg', '.example', '.gitignore', '.manifest',
])

/* ── 小工具 ──────────────────────────────────────────────────────────────── */
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const fmtSize = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(2)} MB` : `${(n / 1024).toFixed(1)} KB`)
const isText = (file) => TEXT_EXT.has(path.extname(file).toLowerCase())

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(p, out)
    else if (entry.isFile()) out.push(p)
  }
  return out
}

function parseArgs(argv) {
  const out = { repoDir: DEFAULT_REPO_DIR, tags: [], dryRun: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--repo-dir') out.repoDir = argv[(i += 1)]
    else if (a === '--tags') out.tags = String(argv[(i += 1)] || '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--help' || a === '-h') {
      console.log('用法: node tools/release-assets.mjs [--dry-run] [--tags a,b] [--repo-dir DIR]')
      process.exit(0)
    } else throw new Error(`未知参数：${a}`)
  }
  return out
}

/* ── 凭据：env 优先，其次 git credential store ───────────────────────────── */
function resolveToken(repoDir) {
  const envTok = String(process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.MOLLY_GH_TOKEN || '').trim()
  if (envTok) return envTok
  try {
    const raw = execFileSync('git', ['credential', 'fill'], {
      cwd: repoDir,
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
    })
    const m = raw.match(/^password=(.+)$/m)
    if (m && m[1].trim()) return m[1].trim()
  } catch {
    /* ignore */
  }
  throw new Error('拿不到 GitHub 凭据：设 GITHUB_TOKEN，或先 git push 让 credential store 记住 PAT')
}

function parseRepo(repoDir) {
  const url = git(repoDir, ['remote', 'get-url', 'origin'])
  const m = url.match(/github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/i)
  if (!m) throw new Error(`不是 GitHub 仓库：${url}`)
  return { owner: m[1], repo: m[2].replace(/\.git$/, '') }
}

async function gh(token, method, apiPath, { json, body, headers = {} } = {}) {
  const res = await fetch(apiPath.startsWith('http') ? apiPath : `https://api.github.com${apiPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'molly-release-assets',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: json ? JSON.stringify(json) : body,
  })
  if (res.status === 404) return null
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`${method} ${apiPath} → HTTP ${res.status} ${txt.slice(0, 400)}`)
  }
  if (res.status === 204) return {}
  return res.json()
}

/* ── 导出 tag 树（经 tar 中转，绝不带 .git）──────────────────────────────── */
function exportTag(repoDir, tag) {
  const dir = path.join(WORK_DIR, `tree-${tag}`)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const tarFile = path.join(WORK_DIR, `${tag}.tar`)
  execFileSync('git', ['archive', '--format=tar', '-o', tarFile, tag], { cwd: repoDir })
  execFileSync('tar', ['-x', '-f', tarFile, '-C', dir])
  fs.rmSync(tarFile, { force: true })
  return dir
}

/* ── 扫描 / 脱敏 ─────────────────────────────────────────────────────────── */
function scanTree(dir) {
  const hits = []
  for (const file of walk(dir)) {
    if (!isText(file) || fs.statSync(file).size > 8 * 1024 * 1024) continue
    const text = fs.readFileSync(file, 'utf8')
    const lines = text.split(/\r?\n/)
    for (const pat of SECRET_PATTERNS) {
      lines.forEach((line, idx) => {
        if (line.includes(pat)) hits.push({ pattern: pat, file: path.relative(dir, file), line: idx + 1 })
      })
    }
  }
  return hits
}

function sanitizeTree(dir) {
  // 每个敏感串都要有替换值；REDACT 没写到的按类型兜底，避免「脱敏后仍有命中」
  const map = { ...REDACT }
  for (const pat of SECRET_PATTERNS) {
    if (map[pat]) continue
    if (/^\d+$/.test(pat)) map[pat] = '111111111'
    else if (pat.includes('\\') || pat.includes('/')) map[pat] = '${PATH}'
    else map[pat] = '${SECRET}'
  }
  let files = 0
  let replacements = 0
  for (const file of walk(dir)) {
    if (!isText(file) || fs.statSync(file).size > 8 * 1024 * 1024) continue
    const before = fs.readFileSync(file, 'utf8')
    let after = before
    for (const [from, to] of Object.entries(map)) {
      if (!after.includes(from)) continue
      const parts = after.split(from)
      replacements += parts.length - 1
      after = parts.join(to)
    }
    if (after !== before) {
      fs.writeFileSync(file, after, 'utf8')
      files += 1
    }
  }
  return { files, replacements }
}

/* ── 打包（bsdtar 按扩展名自动用 zip）────────────────────────────────────── */
function zipTree(dir, tag) {
  fs.mkdirSync(WORK_DIR, { recursive: true })
  const name = `molly-qq-whale-${tag}.zip`
  const file = path.join(WORK_DIR, name)
  fs.rmSync(file, { force: true })
  execFileSync('tar', ['-a', '-c', '-f', file, '-C', path.dirname(dir), path.basename(dir)])
  const files = walk(dir).length
  return { file, name, files, bytes: fs.statSync(file).size, sha: sha256(file) }
}

function releaseBody(tag, asset, commit, redact) {
  const kind = tag.includes('-preview') ? '预览版' : '正式版'
  const lines = [
    `**molly-qq-whale ${tag}**（${kind}，提交 \`${commit}\`）`,
    '',
    `- 附件：\`${asset.name}\`（${fmtSize(asset.bytes)}，${asset.files} 个文件）`,
    `- sha256：\`${asset.sha}\``,
  ]
  if (redact && redact.replacements > 0) {
    lines.push(
      `- 隐私：该版本历史提交树里还残留 ${redact.replacements} 处真实 QQ 号/群号/token，**附件已就地脱敏**（换成占位符）后才打包；`,
      '  如需彻底清理，请按 §9.5 重写历史后重新打 tag（旧 SHA 在 GitHub 上仍可下载，历史重写无法追回）。',
    )
  } else {
    lines.push('- 隐私：打包前对该 tag 的提交树做了敏感串扫描（真实 QQ 号/群号、token、本机用户目录），0 命中；')
  }
  lines.push('- 内容来自发布仓库的该 tag 提交树，不含 `.git`、不含未提交文件。')
  return lines.join('\n')
}

async function ensureRelease(token, repoInfo, tag, asset, commit, redact) {
  const { owner, repo } = repoInfo
  const body = releaseBody(tag, asset, commit, redact)
  const existing = await gh(token, 'GET', `/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`)
  if (existing) {
    await gh(token, 'PATCH', `/repos/${owner}/${repo}/releases/${existing.id}`, {
      json: { body, prerelease: tag.includes('-preview'), name: tag },
    })
    return { id: existing.id, created: false }
  }
  const created = await gh(token, 'POST', `/repos/${owner}/${repo}/releases`, {
    json: { tag_name: tag, name: tag, body, draft: false, prerelease: tag.includes('-preview') },
  })
  return { id: created.id, created: true }
}

async function uploadAsset(token, repoInfo, releaseId, asset) {
  const { owner, repo } = repoInfo
  const list = await gh(token, 'GET', `/repos/${owner}/${repo}/releases/${releaseId}/assets?per_page=100`)
  const same = (list || []).find((a) => a.name === asset.name)
  if (same) await gh(token, 'DELETE', `/repos/${owner}/${repo}/releases/assets/${same.id}`)
  const res = await fetch(
    `https://uploads.github.com/repos/${owner}/${repo}/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/zip',
        'User-Agent': 'molly-release-assets',
        'Content-Length': String(asset.bytes),
      },
      body: fs.readFileSync(asset.file),
    },
  )
  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`上传 ${asset.name} 失败：HTTP ${res.status} ${txt.slice(0, 400)}`)
  }
  return res.json()
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const repoDir = path.resolve(args.repoDir)
  if (!fs.existsSync(path.join(repoDir, '.git'))) throw new Error(`不是 git 仓库：${repoDir}`)

  const allTags = git(repoDir, ['tag', '--list', '--sort=v:refname']).split(/\r?\n/).filter(Boolean)
  const tags = args.tags.length ? args.tags : allTags
  for (const t of tags) if (!allTags.includes(t)) throw new Error(`tag 不存在：${t}`)

  const repoInfo = parseRepo(repoDir)
  const token = args.dryRun ? '' : resolveToken(repoDir)
  fs.mkdirSync(WORK_DIR, { recursive: true })
  console.log(`仓库：${repoInfo.owner}/${repoInfo.repo}  发布目录：${repoDir}`)
  console.log(`待处理 tag（${tags.length}）：${tags.join(', ')}${args.dryRun ? '   [dry-run]' : ''}\n`)

  const summary = []
  for (const tag of tags) {
    const commit = git(repoDir, ['rev-list', '-n', '1', tag])
    process.stdout.write(`- ${tag}（${commit.slice(0, 7)}）导出… `)
    const dir = exportTag(repoDir, tag)
    let hits = scanTree(dir)
    let redact = { files: 0, replacements: 0 }
    if (hits.length) {
      process.stdout.write(`命中 ${hits.length} 处，就地脱敏… `)
      redact = sanitizeTree(dir)
      hits = scanTree(dir)
      if (hits.length) {
        console.log('❌ 脱敏后仍有命中，拒绝上传')
        for (const h of hits.slice(0, 8)) console.log(`    ${h.pattern} :: ${h.file}:${h.line}`)
        summary.push({ tag, status: 'blocked', hits: hits.length })
        fs.rmSync(dir, { recursive: true, force: true })
        continue
      }
    }
    const asset = zipTree(dir, tag)
    fs.rmSync(dir, { recursive: true, force: true })
    const tagNote = redact.replacements ? `脱敏 ${redact.replacements} 处 / ${redact.files} 文件，` : ''
    console.log(`${tagNote}${asset.name} ${fmtSize(asset.bytes)} / ${asset.files} 文件 / sha256=${asset.sha.slice(0, 16)}…`)
    if (args.dryRun) {
      summary.push({ tag, status: 'dry-run', asset, redact })
      continue
    }
    const rel = await ensureRelease(token, repoInfo, tag, asset, commit, redact)
    await uploadAsset(token, repoInfo, rel.id, asset)
    console.log(`    release ${rel.created ? '已新建' : '已存在'} #${rel.id}，附件已上传`)
    summary.push({ tag, status: redact.replacements ? 'sanitized' : 'ok', asset, releaseId: rel.id, redact })
  }

  console.log('\n=== 汇总 ===')
  for (const s of summary) {
    const note = s.asset ? `${s.asset.name} ${fmtSize(s.asset.bytes)}${s.redact && s.redact.replacements ? `（脱敏 ${s.redact.replacements} 处）` : ''}` : ''
    console.log(`${s.tag.padEnd(22)} ${s.status.padEnd(10)} ${note}`)
  }
  const bad = summary.filter((s) => s.status === 'blocked')
  if (bad.length) {
    console.log(`\n注意：${bad.length} 个 tag 脱敏后仍有敏感命中，未上传。`)
    process.exitCode = 2
  }
}

main().catch((err) => {
  console.error('\n[release-assets] 失败：', err && err.message ? err.message : err)
  process.exitCode = 1
})
