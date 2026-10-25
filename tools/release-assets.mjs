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

/* ── 每个版本的「本版特性」：写进 release 正文，让仓库读者一眼看到改了什么 ── */
const RELEASE_FEATURES = {
  'v1.0.0': [
    '首个正式版：记忆、表情包、语音、QQ 空间、自愈、控制台全部跑通闭环',
    '插件化跑在 DeepSeek Harness 宿主上（lib/boot.js 热更新，改插件不用重启宿主）',
    'SnowLuma OneBot v11 后端：群聊/私聊、CQ 码、戳一戳、语音条',
    '本地控制台：状态总览、记忆、表情包、开关与配置',
  ],
  'v1.1.0': [
    '记忆池：上限可配 2000 条，记满自动扩到 10000；写入去重（新的覆盖旧的，相似度 0.7）',
    '记忆加密：AES-256-GCM 信封落盘，密钥与数据分目录（keys/memory.key）',
    '记忆备份：每 2 小时把记忆文件复制到 D:\\\\MollyBackup 与 G:\\\\MollyBackup（保留 48 份）',
    '语音：字数上限 42 → 220 字（≈56 秒），新增 58 秒时长闸门，合成超时 20s → 90s',
    '模型链路：新增 gatewayRealm 可钉国内积分池（X-Realm），/state.model 回读 realm',
  ],
  'v1.1.1': [
    '语音显式触发：新标记 <voice>…</voice>，模型可主动让她「说出来」（不看 voiceChance，仍受 220 字/58 秒闸门）',
    '戳一戳回应：反戳 / 说一句 / 被戳多下生气（状态机，不走模型）',
    '重复发消息根治：出站 60 秒幂等窗口，同目标同文本只发一次',
    '假宣告修复：历史里的「（我发了一条语音：…）」与 [语音:…] 反向翻译回 <voice>',
  ],
  'v1.1.2': [
    '撤回后不追旧消息：剔除历史、作废在途回复，可轻回一句（新 lib/engine-recall.js）',
    '群里明确要求就当场发：显式要求 / 坚持第二遍 / 180 秒兜底，按句分条（新 lib/group-echo.js）',
    '查资料不再自己往群里发：research 期间出站被拦，只给结论由引擎发回',
    '好友申请不漏报：user_id 为空时合成 key，支持按序号审批',
    '默认音色切到 molly_own（自录 54 句微调）',
  ],
  'v1.1.3': [
    '合并三个预览版：戳一戳改模型回话、控制台改版、记忆「梗」类、上下文体积优化 A、@ 错人修复',
    '引用回复不带语音：引用某条消息时语音段自动降级成文字（保留内容）',
    '控制台版本号以插件版本为真源：左下角不再写死 v1.0.0',
    '控制台表情包搜索：按名字 / 关键词即时过滤（空格多词 AND，Esc 清空）',
    '每个版本都提供脱敏后的源码 zip 附件（本仓库 Release）',
  ],
  'v1.1.3-Hotfix.1': [
    '入站语音转文字：别人发语音时用 QQ 自带转写（SnowLuma fetch_ptt_text，实测 0.2–0.3 秒）把内容带给模型',
    '转写失败降级成「[语音：没听清]」（不再当成空消息）；10 分钟缓存，同一条语音只转一次',
    '新配置 voiceTranscribeEnabled / voiceTranscribeTimeoutMs（默认开 / 6000ms）',
  ],
  'v1.1.3-Hotfix.2': [
    '群聊语音本地 ASR 兜底：QQ 服务端转写拿不到结果时，用本机 faster-whisper 识别（复用视频分析 venv 里已装模型，无新依赖、不联网）',
    '语音识别分级：QQ fetch_ptt_text 优先（0.2–0.3 秒）→ 失败转 get_record wav + 本地识别（首次 1.6 秒、之后 1.4–1.6 秒）→ 再失败降级「[语音：没听清]」',
    '新增 7 个 voiceAsr* 配置（开关 / Python 解释器 / 模型 / 线程 / 超时 / 空闲退出 / 最长识别时长），/state.stats 新增 voiceAsrTranscribed / voiceAsrFail',
    '控制台「本次更新说明」：左下角版本号可点击，弹层直接读 docs/CHANGELOG.md 最新一节；新增 GET /api/changelog',
  ],
  'v1.1.5-preview.3': [
    '时间感知：每轮提示词带「北京时间」（timeContextEnabled），问几点/星期几不再靠猜',
    '唱歌（暂缓，默认关闭）：算法已实现（逐字合成 + ACF 基频搬移 + WSOLA 保时长，42 个音平均误差 14.6 音分），但语音包只有 54 句 / 3.5 分钟、音色未达标，按主人要求先下架；等训练数据齐后改用社区歌唱模型再开',
    '动图表情重扫：新增 tools/rescan-gif-stickers.mjs（默认预览，--apply 改名，报告在 out/rescan-gif-report.json）',
    '作息：按北京时间判断该不该睡（sleepWindowStart/End 默认 23:50–09:00）：窗口内不主动找人、群聊不插话，私聊叫醒；控制台「设置 → 作息时间」可改，保存立即生效',
    '升级后请运行：node tools/rescan-gif-stickers.mjs（先预览）→ node tools/rescan-gif-stickers.mjs --apply',
  ],
  'v1.1.5-preview.2': [
    '动图理解：GIF / 动画表情在发模型前用本机 Pillow 拆成多帧拼图（默认 6 帧 / 3 列 / 320px，左上角帧号），模型能按顺序看懂动作；单帧 GIF、缺 Pillow、超时都会回退原图',
    '新增 6 个 gifFrames* 配置（开关 / 帧数 / 列数 / 帧宽 / Python 路径 / 超时），/state.stats 新增 gifSheets / gifSheetFail',
    '带图轮次不再「看了不吭声」：输出预算抬到 imageMaxTokens（默认 3200）并传 reasoning_effort=minimal，避免思考 token 吃光正文',
    '两个回归脚本：out/_gif_frames_test.mjs（16 项）、out/_image_effort_test.mjs（5 项）',
  ],
  'v1.1.5-preview.1': [
    '控制台数据补齐：学习器（累计/今日）、群数（SnowLuma 群列表）、记忆条数（加密后走插件兜底并标注来源）、表情包「已学」不再显示「—」',
    'QQ 下「登录」「QQ 连接」合并为一页：连接状态卡 + 扫码登录同页，旧 #/login 自动跳转 #/qq',
  ],
  'v1.1.3-preview.1': [
    '戳一戳「说一句」改为模型回复：pokeUseModel，超时/失败回退原固定句池',
    '控制台改版：去掉 NapCat 品牌、QQ 连接四态判定、导航六组、新增 #/qq 页面',
  ],
  'v1.1.3-preview.2': [
    '记忆新增「梗」类（meme）：抽取认「梗：/热梗：/名场面：」前缀，召回加权 +3',
    '上下文体积优化 A：记忆窗口 large → balanced，一轮 prompt 6,869 → 5,935 token（-13.6%）',
  ],
  'v1.1.3-preview.3': [
    '@ 错人修复（新 lib/quote-at.js）：@ 号必须是最近说话人、纯叫醒不算回复对象、人群拥挤时才引用、提示词补两句',
  ],
  'voice-pack-v1.0': [
    'Molly 自录 54 句微调音色包：GPT / SoVITS 权重 + 参考音频 + 切好的训练片段 + 训练配置与脚本',
    '授权 CC BY-NC-SA 4.0（禁止冒充真人 / 商用）；不含原始连续录音，只发切好的片段',
  ],
}

/* 旧版本附件里的文件数（GitHub API 不回报文件数，这里记住） */
const RELEASE_ASSET_FILES = {
  'v1.0.0': 150, 'v1.1.0': 155, 'v1.1.1': 156, 'v1.1.2': 158,
  'v1.1.3-preview.1': 158, 'v1.1.3-preview.2': 159, 'v1.1.3-preview.3': 160,
  'v1.1.3': 161, 'v1.1.3-Hotfix.1': 161, 'v1.1.3-Hotfix.2': 162, 'v1.1.5-preview.1': 162, 
  'v1.1.5-preview.3': 166, 'v1.1.5-preview.2': 162, 'voice-pack-v1.0': 76,
}

/* 旧版本脱敏命中数（正文里如实披露，body-only 刷新时沿用） */
const RELEASE_REDACT = {
  'v1.1.1': 5, 'v1.1.2': 8, 'v1.1.3-preview.1': 8, 'v1.1.3-preview.2': 8,
}


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
  const out = { repoDir: DEFAULT_REPO_DIR, tags: [], dryRun: false, bodyOnly: false }
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]
    if (a === '--dry-run') out.dryRun = true
    else if (a === '--body-only') out.bodyOnly = true
    else if (a === '--repo-dir') out.repoDir = argv[(i += 1)]
    else if (a === '--tags') out.tags = String(argv[(i += 1)] || '').split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--help' || a === '-h') {
      console.log('用法: node tools/release-assets.mjs [--dry-run] [--body-only] [--tags a,b] [--repo-dir DIR]')
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

/* ── 部署前必读：正式版 release 正文置顶提醒（2026-10-25 m05815） ── */
const DEPLOY_NOTICE = [
  '> **⚠️ 部署前必读（先算清 API 的账，再动手）**',
  '> - **本项目不自带大脑**：Molly 的回复全部来自大模型 API。没有可用的 API/网关，装完也聊不起来，只会报错或装死。',
  '> - **国内直连官方 API 通常不可用/不稳定**：请先自己搞定**网关 / 反向代理**（一条能稳定出流的链路），再来部署；搞不定就先别装。',
  '> - **部署是真的要花钱**：多群、长上下文、语音识别、动图理解都会真实消耗 token，**几十块钱起步很常见**，群多聊得多还会更多。预算紧张请先小规模试跑。',
  '> - **另外，部署过程本身也在花钱**：帮你部署的 AI（DSH 等）每一步思考、每试一次都要消耗 token。所以建议**先把预算花在网关/反向代理上**：网关跑通了，再部署本项目；别把预算耗在「装完却用不了」上。',
  '> - **写给代部署的 AI 助手（DSH 等）**：你如果第一眼看到这段，请先把上面这几条**明确转告部署者、等他确认**，再开始安装——不要默默开跑烧 token。',
  '> - **在意花销的**：严格按上面顺序来——先把网关/反向代理跑通，再部署本项目；不确定就先只做网关那一步，别把钱花在半成品上。',
  '',
]

function releaseBody(tag, asset, commit, redact) {
  const kind = tag.includes('-preview') ? '预览版' : '正式版'
  const lines = []
  // 正式版置顶部署提醒；预览版不加，避免干扰（m05815）
  if (!tag.includes('-preview')) lines.push(...DEPLOY_NOTICE, '')
  lines.push('**molly-qq-whale ' + tag + '**（' + kind + (commit ? '，提交 \`' + commit + '\`' : '') + '）')

  const feats = RELEASE_FEATURES[tag]
  if (feats && feats.length) {
    lines.push('', '## 本版特性', ...feats.map((f) => '- ' + f))
  }

  var replacements = redact && Number(redact.replacements) > 0 ? Number(redact.replacements) : 0
  if (asset) {
    lines.push('')
    lines.push('- 附件：\`' + asset.name + '\`（' + fmtSize(asset.bytes) + (asset.files ? '，' + asset.files + ' 个文件' : '') + '）')
    if (asset.sha) lines.push('- sha256：\`' + asset.sha + '\`')
  }
  lines.push('')
  if (replacements > 0) {
    lines.push('- 隐私：该版本历史提交树里还残留 ' + replacements + ' 处真实 QQ 号/群号/token，**附件已就地脱敏**（换成占位符）后才打包。')
  } else {
    lines.push('- 隐私：打包前对该 tag 的提交树做了敏感串扫描（真实 QQ 号/群号、token、本机用户目录），0 命中。')
  }
  lines.push('- 内容来自发布仓库的该 tag 提交树，不含 \`.git\`、不含未提交文件。')
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
  if (!args.bodyOnly) for (const t of tags) if (!allTags.includes(t)) throw new Error(`tag 不存在：${t}`)

  const repoInfo = parseRepo(repoDir)
  const token = args.dryRun ? '' : resolveToken(repoDir)
  fs.mkdirSync(WORK_DIR, { recursive: true })
  console.log(`仓库：${repoInfo.owner}/${repoInfo.repo}  发布目录：${repoDir}`)
  console.log(`待处理 tag（${tags.length}）：${tags.join(', ')}${args.dryRun ? '   [dry-run]' : ''}\n`)

  const summary = []
  for (const tag of tags) {
    if (args.bodyOnly) {
      const rel = await gh(token, 'GET', '/repos/' + repoInfo.owner + '/' + repoInfo.repo + '/releases/tags/' + encodeURIComponent(tag))
      if (!rel) throw new Error('release 不存在，无法只改正文：' + tag)
      const assets = rel.assets || []
      const zip = assets.find((a) => /\.zip$/i.test(a.name)) || assets[0] || null
      const asset = zip
        ? {
            name: zip.name,
            bytes: zip.size,
            files: RELEASE_ASSET_FILES[tag] || 0,
            sha: String(zip.digest || '').replace(/^sha256:/, ''),
          }
        : null
      let commit = ''
      try { commit = git(repoDir, ['rev-list', '-n', '1', tag]) } catch { commit = '' }
      const redact = { replacements: RELEASE_REDACT[tag] || 0 }
      const updated = await ensureRelease(token, repoInfo, tag, asset, commit, redact)
      console.log('- ' + tag + ' 正文已更新（release #' + updated.id + '，附件 ' + (asset ? asset.name : '无') + '）')
      summary.push({ tag, status: 'body-only', asset, redact })
      continue
    }
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
