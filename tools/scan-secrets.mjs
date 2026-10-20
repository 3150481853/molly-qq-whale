/**
 * 开源前敏感信息盘点（只读，零依赖）。
 *
 * 扫 ${MOLLY_ROOT}\qq-whale，按六类打标签，输出 JSON 摘要 + 可粘贴的 Markdown 片段。
 * 排除：out/、node_modules/、restore-points/、dist/、*.log、*.bak-*、.git/
 *
 * 跑法：node tools/scan-secrets.mjs           # 人读摘要
 *       node tools/scan-secrets.mjs --json    # 机器读
 *
 * 原则：**宁可多报**。所有输出一律遮一半（保留前 3-4 位 + 后 4 位），
 * 这份结果本身可能会被直接发出去。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 本文件在 <root>/tools/ 下 → 根目录 = 上一级（别用 argv[1] 拼，容易落到 ${MOLLY_ROOT} 全盘）
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_DIR = new Set(['out', 'node_modules', 'restore-points', 'dist', '.git', 'sessions'])
const SKIP_FILE = [/\.log$/i, /\.bak(-|$)/i, /\.png$|\.jpg$|\.jpeg$|\.gif$|\.webp$|\.ico$|\.exe$|\.zip$/i]

/** 遮一半：保留头 4 + 尾 4 */
const mask = (s) => {
  const t = String(s)
  if (t.length <= 8) return t.slice(0, 2) + '***'
  return `${t.slice(0, 4)}...${t.slice(-4)}`
}

const CATS = [
  {
    id: 'qq',
    name: 'QQ 号 / 数字身份',
    re: /\b([1-9]\d{4,11})\b/g,
    // 明确的号先高亮，其余当「可能是 QQ 的数字串」，时间戳（10 位且以 1[6-8] 开头）标注误报
    classify: (v) => {
      const known = { '111111111': 'Molly', '222222222': '主人', '333333333': '管理员', '444444444': '小号' }
      if (known[v]) return `已知账号（${known[v]}）`
      if (/^1[6-8]\d{8}$/.test(v)) return '疑似时间戳（Unix 秒）'
      if (v.length >= 10) return '疑似 epoch 毫秒'
      return '疑似 QQ/群号'
    },
  },
  { id: 'token', name: '令牌 / 密钥', re: /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|[A-Fa-f0-9]{32,}|[0-9]{6}[a-z]{6,}\d{8,})/g, classify: () => '疑似 token/secret' },
  { id: 'secretkw', name: 'secret 赋值', re: /(token|secret|password|api[_-]?key|jwt)\s*[:=]\s*["']?([^\s"',}]{6,})/gi, classify: () => '配置里硬编码的凭据' },
  { id: 'path', name: '本机绝对路径', re: /([A-Za-z]:[\\/](?:Users|Molly|Documents|workbuddy|APP|Program Files)[^\s"'`),;]{0,120})/gi, classify: () => '本机路径（含用户名/盘符）' },
  { id: 'net', name: '网络地址', re: /\b((?:(?:10|127|192\.168|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d{2,5})?)|(?:(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?))\b/g, classify: (v) => (/^127\.|^10\.|^192\.168|^172\./.test(v) ? '私有/回环地址' : '公网 IP') },
  { id: 'personal', name: '真实个人内容', re: /([\u4e00-\u9fa5]{2,8}<REDACTED>|示例用户|ExampleUser|ExampleUser|群名片)/g, classify: () => '个人/群昵称描述' },
]

const counts = Object.fromEntries(CATS.map((c) => [c.id, 0]))
const files = new Map() // rel -> { bytes, hits: {cat: n}, samples: [..] }
let scanned = 0
let skipped = 0
let totalHits = 0

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    const rel = path.relative(ROOT, p).replace(/\\/g, '/')
    if (e.isDirectory()) {
      if (SKIP_DIR.has(e.name)) {
        skipped += 1
        continue
      }
      walk(p)
      continue
    }
    if (SKIP_FILE.some((r) => r.test(e.name))) {
      skipped += 1
      continue
    }
    let buf
    try {
      buf = fs.readFileSync(p)
    } catch {
      skipped += 1
      continue
    }
    // 二进制跳过（含 NUL 前 4KB）
    if (buf.subarray(0, 4096).includes(0)) {
      skipped += 1
      continue
    }
    scanned += 1
    if (scanned % 200 === 0) console.error(`  …已扫 ${scanned} 个文件`)
    if (buf.length > 1024 * 1024) {
      // 超过 1MB 的单文件跳过（本项目里是 console.js 这类打包产物，行太长会拖死正则）
      skipped += 1
      scanned -= 1
      continue
    }
    const text = buf.toString('utf8')
    const lines = text.split('\n')
    const hit = {}
    const samples = []
    lines.forEach((line, i) => {
      for (const c of CATS) {
        c.re.lastIndex = 0
        let m
        while ((m = c.re.exec(line))) {
          const val = m[1] || m[0]
          hit[c.id] = (hit[c.id] || 0) + 1
          counts[c.id] += 1
          totalHits += 1
          if (samples.length < 40) {
            samples.push({ cat: c.id, line: i + 1, note: c.classify(val), masked: mask(val) })
          }
        }
      }
    })
    if (Object.keys(hit).length) files.set(rel, { bytes: buf.length, hits: hit, samples })
  }
}

walk(ROOT)

const summary = {
  root: ROOT.replace(/\\/g, '/'),
  scanned,
  skipped,
  hitFiles: files.size,
  totalHits,
  byCategory: CATS.map((c) => ({ id: c.id, name: c.name, hits: counts[c.id], files: [...files.values()].filter((f) => f.hits[c.id]).length })),
  byFile: [...files.entries()]
    .map(([f, v]) => ({ file: f, bytes: v.bytes, hits: Object.values(v.hits).reduce((a, b) => a + b, 0), cats: v.hits, samples: v.samples.slice(0, 3) }))
    .sort((a, b) => b.hits - a.hits),
}

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(summary, null, 2))
  process.exit(0)
}

console.log(`扫描 ${summary.scanned} 文件 / 跳过 ${summary.skipped} / 命中 ${summary.hitFiles} / 命中总数 ${summary.totalHits}`)
console.log('\n按类别：')
for (const c of summary.byCategory) console.log(`  ${c.id.padEnd(9)} ${String(c.hits).padStart(5)} 处 / ${String(c.files).padStart(3)} 文件  ${c.name}`)
console.log('\n命中最多的 20 个文件：')
for (const f of summary.byFile.slice(0, 20)) console.log(`  ${String(f.hits).padStart(4)}  ${f.file}`)
console.log('\n样例（已脱敏，前 12 条）：')
for (const f of summary.byFile.slice(0, 6)) for (const s of f.samples) console.log(`  ${f.file}:${s.line}  [${s.cat}] ${s.masked}  — ${s.note}`)
