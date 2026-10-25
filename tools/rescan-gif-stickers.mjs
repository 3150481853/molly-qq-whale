#!/usr/bin/env node
/**
 * 重扫表情包库里的 GIF：用「动图多帧拼图 + 视觉模型」重新打 tag，并把 tag 写回文件名。
 *
 * 背景（2026-10-26，v1.1.5-preview.3）：
 *   以前 Molly 看 GIF 只能看到首帧，表情包库里的动图 tag 也是按首帧/人工起的，
 *   经常抓不到真正的动作（比如掀衣服、反复灌水、抖动这种只有连续帧才看得出的）。
 *   preview.3 起她能看懂动图了，于是提供一个脚本把现有 GIF 重新扫一遍：
 *     拆帧拼图 → 视觉模型概括「角色/画面/动作/情绪」→ 生成新文件名 → 替换旧名。
 *
 * 关键设计：
 *   - 默认 **dry-run**：只打印「准备怎么改」，不碰任何文件。确认后加 --apply 才改名。
 *   - 文件名就是 tag（`stickers.js` 用下划线拆关键词，`.learned.json` 只存内容哈希），
 *     所以「重新打 tag」= 「重命名文件」，不需要改任何索引文件。
 *   - 单帧 GIF（其实是静图）跳过，只用第一帧的判断没有意义。
 *   - 全程串行 + 秒级限速，避免把网关打满；任何一张失败都不影响其它张。
 *   - 每一张的旧名/新名都写进 `out/rescan-gif-report.json`，改错了可以照着改回去。
 *
 * 用法：
 *   node tools/rescan-gif-stickers.mjs                 # 预览（不改文件）
 *   node tools/rescan-gif-stickers.mjs --apply         # 真的重命名
 *   node tools/rescan-gif-stickers.mjs --limit 10      # 先拿 10 张试水
 *   node tools/rescan-gif-stickers.mjs --dir D:\\path  # 指定别的表情包目录
 *   node tools/rescan-gif-stickers.mjs --model deepseek-v4.1-pro
 *
 * 参数：
 *   --apply              真的写盘（默认 dry-run）
 *   --limit N            最多处理多少张 GIF
 *   --dir PATH           表情包「学来的」目录（默认读 MOLLY_STICKER_DIR 或 G:\\Molly\\data\\qq-whale\\stickers\\学来的）
 *   --force              同名也重打一遍（默认：模型给的名字和现名一样就跳过）
 *   --concurrency N      并发数（默认 2；不要超过 4）
 *   --timeout-ms N       单张超时（默认 60000）
 *   --model NAME         视觉模型（默认 deepseek-v4.1-flash）
 *   --url URL            网关地址（默认 http://127.0.0.1:8788/v1/chat/completions）
 *   --key KEY            网关 key（默认 wb-proxy-local）
 *   --quiet              只打汇总
 *
 * 退出码：0 全部成功/无待办；1 有失败项（详情看报告）；2 参数/环境错误。
 */

import { readdir, readFile, rename, writeFile, mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

import { gifContactSheet } from '../plugin/dsh-qq-whale/lib/gif-frames.js'

const DEFAULTS = {
  dir: process.env.MOLLY_STICKER_DIR || 'G:\\Molly\\data\\qq-whale\\stickers\\学来的',
  reportDir: process.env.MOLLY_REPORT_DIR || 'G:\\Molly\\qq-whale\\out',
  url: process.env.MOLLY_GATEWAY_URL || 'http://127.0.0.1:8788/v1/chat/completions',
  key: process.env.MOLLY_GATEWAY_KEY || 'wb-proxy-local',
  model: 'deepseek-v4.1-flash',
  timeoutMs: 60000,
  concurrency: 2,
  limit: 0,
  frames: 6,
  columns: 3,
  frameWidth: 320,
}

const TAG_PROMPT = `这是 QQ 表情包库里的一个动图（GIF），已经把动画拆成多帧拼在一张图里：每格左上角标了「n/N」的帧号，按从左到右、从上到下的顺序排列。

请只输出一行：用 2~6 个中文词概括这个表情包的角色 / 画面 / 主要动作 / 情绪，词与词之间用下划线 _ 连接。
要求：
- 只输出这一行，不要标点、不要解释、不要编号、不要引号、不要代码块。
- 必须抓住「动作」和「情绪」，不要只写「二次元」「表情包」这种废话词。
- 每个词 2~6 个字，总长不超过 30 字。

示例输出：黑猫_歪头_疑惑_眨眼`

function parseArgs(argv) {
  const out = { ...DEFAULTS, apply: false, force: false, quiet: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} 后面缺参数`)
      return v
    }
    switch (a) {
      case '--apply': out.apply = true; break
      case '--dry-run': out.apply = false; break
      case '--force': out.force = true; break
      case '--quiet': out.quiet = true; break
      case '--limit': out.limit = Number(next()); break
      case '--dir': out.dir = next(); break
      case '--report-dir': out.reportDir = next(); break
      case '--concurrency': out.concurrency = Math.max(1, Math.min(4, Number(next()) || 2)); break
      case '--timeout-ms': out.timeoutMs = Number(next()); break
      case '--model': out.model = next(); break
      case '--url': out.url = next(); break
      case '--key': out.key = next(); break
      case '-h': case '--help': out.help = true; break
      default: throw new Error(`未知参数：${a}`)
    }
  }
  return out
}

function usage() {
  console.log('用法：node tools/rescan-gif-stickers.mjs [--apply] [--limit N] [--dir PATH] [--force] [--concurrency N] [--model NAME]')
  console.log('默认 dry-run（只预览不改名）；加 --apply 才真正重命名。报告写到 out/rescan-gif-report.json。')
}

/** 清洗模型输出 → 文件名安全的下划线 tag 串 */
export function sanitizeTags(raw, maxWords = 6) {
  let text = String(raw || '')
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/^\s*[:：\-\d.、]+\s*/g, '')
  const firstLine = text.split(/\r?\n/).map((s) => s.trim()).find(Boolean) || ''
  const words = firstLine
    .replace(/[，,、;；。.!！?？"'“”‘’（）()【】\[\]<>《》|/\\]/g, ' ')
    .replace(/\s+/g, '_')
    .split('_')
    .map((w) => w.trim())
    .filter((w) => w && w.length <= 8 && w.length >= 1)
    .filter((w) => !/^\d+$/.test(w))
  const seen = new Set()
  const out = []
  for (const w of words) {
    if (seen.has(w)) continue
    seen.add(w)
    out.push(w)
    if (out.length >= maxWords) break
  }
  return out
}

async function callVision(opts, dataUrl, frameCount) {
  const body = {
    model: opts.model,
    messages: [
      { role: 'system', content: TAG_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'text', text: `这张拼图一共 ${frameCount} 帧。请按上面要求输出一行 tag。` },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
    // 带图请求的思考 token 波动很大（实测 900~4000），预算给小了就会「只思考不说话」。
    // 1600 是 preview.2 实测的稳妥值；万一还是空，下面会自动重试一次更大的预算。
    max_tokens: 1600,
    temperature: 0.2,
    reasoning_effort: 'minimal',
    stream: false,
  }
  const send = async (b) => {
    const res = await fetch(opts.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.key}` },
      body: JSON.stringify(b),
      signal: AbortSignal.timeout(opts.timeoutMs),
    })
    if (!res.ok) throw new Error(`网关 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`)
    const json = await res.json()
    return String(json?.choices?.[0]?.message?.content ?? '')
  }
  let text = await send(body)
  if (!text.trim()) {
    // 思考吃光预算：去掉 reasoning_effort、把预算抬到 3200 再试一次
    const retry = { ...body, max_tokens: 3200 }
    delete retry.reasoning_effort
    text = await send(retry)
  }
  if (!text.trim()) throw new Error('模型返回空内容（思考把预算吃光了）')
  return String(text)
}

async function safeFileName(dir, base, ext, taken) {
  let name = `${base}${ext}`
  let n = 2
  while (taken.has(name.toLowerCase())) {
    name = `${base}_${n}${ext}`
    n += 1
  }
  taken.add(name.toLowerCase())
  return path.join(dir, name)
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let idx = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = idx++
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

async function main() {
  const opts = parseArgs(process.argv)
  if (opts.help) { usage(); return 0 }

  let entries
  try {
    entries = await readdir(opts.dir)
  } catch (err) {
    console.error(`读不到表情包目录：${opts.dir}（${err.message}）`)
    return 2
  }
  const gifs = entries.filter((f) => /\.gif$/i.test(f)).sort()
  const targets = opts.limit > 0 ? gifs.slice(0, opts.limit) : gifs

  if (!opts.quiet) {
    console.log(`目录：${opts.dir}`)
    console.log(`动图 ${gifs.length} 张，本次处理 ${targets.length} 张${opts.apply ? '（会改文件名）' : '（dry-run，不改名）'}`)
  }

  await mkdir(opts.reportDir, { recursive: true })
  const taken = new Set(entries.map((f) => f.toLowerCase()))
  const report = { at: new Date().toISOString(), dir: opts.dir, apply: opts.apply, model: opts.model, total: targets.length, retagged: 0, unchanged: 0, skipped: 0, failed: 0, items: [] }

  const results = await mapLimit(targets, opts.concurrency, async (file) => {
    const full = path.join(opts.dir, file)
    try {
      const buf = await readFile(full)
      const sheet = await gifContactSheet(buf, { frames: opts.frames, columns: opts.columns, frameWidth: opts.frameWidth })
      if (!sheet) return { file, status: 'skipped', reason: '单帧 GIF / 拆帧不可用' }
      const dataUrl = `data:image/png;base64,${sheet.png.toString('base64')}`
      const raw = await callVision(opts, dataUrl, sheet.frames)
      const words = sanitizeTags(raw)
      if (words.length < 2) return { file, status: 'failed', reason: `模型 tag 太少：${JSON.stringify(words)}` }
      const base = path.basename(file, path.extname(file))
      const newBase = words.join('_')
      if (newBase === base) return { file, status: 'unchanged', frames: sheet.frames, words }
      const newFull = await safeFileName(opts.dir, newBase, path.extname(file), taken)
      const entry = { file, old: file, new: path.basename(newFull), frames: sheet.frames, words, raw: raw.trim().slice(0, 120) }
      if (opts.apply) {
        await rename(full, newFull)
        taken.delete(file.toLowerCase())
        entry.status = 'retagged'
      } else {
        entry.status = 'would-retag'
        taken.delete(file.toLowerCase())
      }
      return entry
    } catch (err) {
      return { file, status: 'failed', reason: err.message }
    }
  })

  for (const r of results) {
    report.items.push(r)
    if (r.status === 'retagged' || r.status === 'would-retag') report.retagged += 1
    else if (r.status === 'unchanged') report.unchanged += 1
    else if (r.status === 'skipped') report.skipped += 1
    else report.failed += 1
    if (!opts.quiet) {
      const mark = r.status === 'retagged' ? '✓ 改名' : r.status === 'would-retag' ? '· 改名(dry)' : r.status === 'unchanged' ? '= 未变' : '✗ 失败'
      const detail = r.new ? `${r.old}  →  ${r.new}` : `${r.file}  (${r.reason || r.status})`
      console.log(`${mark}  ${detail}`)
    }
  }

  const reportFile = path.join(opts.reportDir, 'rescan-gif-report.json')
  await writeFile(reportFile, JSON.stringify(report, null, 2), 'utf8')
  console.log(`\n汇总：待改 ${report.retagged} · 未变 ${report.unchanged} · 跳过 ${report.skipped} · 失败 ${report.failed}`)
  console.log(`报告：${reportFile}`)
  if (!opts.apply) console.log('这是 dry-run；确认无误后加 --apply 真正重命名。')
  return report.failed > 0 ? 1 : 0
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err?.stack || String(err))
    process.exit(2)
  })
