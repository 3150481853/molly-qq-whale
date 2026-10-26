/**
 * gif-frames.js —— 让 Molly 看懂动图。
 *
 * 背景（2026-10-26，主人 m04893）：「Molly 面对 gif 和 gif 表情包只能看到首图」。
 * 原因不在 QQ 也不在我们下载图片这一步：多模态模型对 image/gif 只解码第一帧，
 * 后面怎么变都看不见。所以这里在把图片塞进上下文之前，先自己把 GIF 拆帧：
 *
 *   1. 采样 N 帧（默认 6 帧，均匀覆盖整段动画，不是只取开头）；
 *   2. 每帧缩到统一宽度、合成到一张拼图上（从左到右、从上到下按时间顺序）；
 *   3. 每个格子左上角标「3/6」这样的帧序号，模型可以按序号理解先后；
 *   4. 输出 PNG（单帧静态图，所有视觉模型都能整张解码）。
 *
 * 为什么用 Python 而不是纯 JS：GIF 的 LZW 解码 + disposal 合成 + 调色板是
 * 一整块容易写错的东西，装进来的依赖又得考虑版本/逃逸；而本机为了本地 ASR
 * 已经有一个装好 Pillow 的 venv（见 voiceAsrPython），直接复用最省事。
 * 没装 Python / 版本不对时**安静地返回 null**，调用方回退「只发首帧」的旧行为，
 * 功能降级但绝不把消息搞丢（这条是硬要求：图看不了可以，回复不能断）。
 *
 * 帧缓存按「图片字节 sha1 + 采样参数」做 key：群里同一条梗图被反复转发时
 * 只解码一次；上限 32 张，够覆盖一轮聊天又不会常驻吃内存。
 *
 * 对外只暴露一个函数：gifContactSheet(buf, opts) → { png, frames, gifFrames, width, height } | null
 */

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/** 动图拆帧的默认参数（配置键见 main.js 的 gif* 一组） */
export const GIF_DEFAULTS = {
  enabled: true,
  frames: 6,
  columns: 3,
  frameWidth: 320,
  timeoutMs: 9000,
  // 2026-10-26 部署可移植性：留空 = 没配 Python 就安静回退「只看首帧」，
  // 不再写死作者机的 G 盘 venv（别的机器上 spawn 会直接 ENOENT）。
  python: '',
}

/** 帧缓存：sha1(参数) -> 结果；够用又不至于无限长 */
const MAX_CACHE = 32
const cache = new Map()

/**
 * 拆帧 + 拼图的 Python 实现。
 *
 * 用 argv 传参而不是拼字符串，GIF 内容不经过命令行（避免转义/长度问题）。
 * 结果统一用一行 JSON 打到 stdout，Node 侧只解析最后一行。
 */
const PY_SOURCE = `# -*- coding: utf-8 -*-
import json, sys

def main():
    inp, outp = sys.argv[1], sys.argv[2]
    max_frames = int(sys.argv[3])
    cols = int(sys.argv[4])
    max_w = int(sys.argv[5])
    try:
        from PIL import Image, ImageDraw
    except Exception as e:
        print(json.dumps({"ok": False, "error": "no-pillow: %s" % e}))
        return
    try:
        im = Image.open(inp)
        n = int(getattr(im, "n_frames", 1) or 1)
        if n < 2:
            # 单帧 GIF 走了拆帧也没意义，直接让调用方用原图
            print(json.dumps({"ok": False, "error": "single-frame", "gifFrames": n}))
            return
        k = min(max_frames, n)
        idxs = [int(round(i * (n - 1) / (k - 1))) for i in range(k)] if k > 1 else [0]
        seen, imgs = set(), []
        for idx in idxs:
            idx = max(0, min(n - 1, idx))
            if idx in seen:
                continue
            seen.add(idx)
            im.seek(idx)
            fr = im.convert("RGBA")
            bg = Image.new("RGB", fr.size, (255, 255, 255))
            bg.paste(fr, mask=fr.split()[-1])
            if bg.width > max_w:
                h = max(1, int(round(bg.height * max_w / bg.width)))
                bg = bg.resize((max_w, h), Image.LANCZOS)
            imgs.append(bg)
        if not imgs:
            print(json.dumps({"ok": False, "error": "no-frames"}))
            return
        cols = max(1, min(cols, len(imgs)))
        rows = (len(imgs) + cols - 1) // cols
        cw = max(i.width for i in imgs)
        ch = max(i.height for i in imgs)
        pad, label_h = 4, 14
        sheet = Image.new("RGB", (cols * (cw + pad) + pad, rows * (ch + label_h + pad) + pad), (245, 245, 245))
        draw = ImageDraw.Draw(sheet)
        for i, fr in enumerate(imgs):
            r, c = divmod(i, cols)
            x = pad + c * (cw + pad)
            y = pad + r * (ch + label_h + pad)
            draw.text((x + 2, y), "%d/%d" % (i + 1, len(imgs)), fill=(60, 60, 60))
            sheet.paste(fr, (x, y + label_h))
        sheet.save(outp, "PNG", optimize=True)
        print(json.dumps({"ok": True, "frames": len(imgs), "gifFrames": n, "width": sheet.width, "height": sheet.height}))
    except Exception as e:
        print(json.dumps({"ok": False, "error": (str(e) or "unknown")[:200]}))

main()
`

/** 是不是 GIF（只看魔数，不看是否能解码） */
export function isGif(buf) {
  if (!buf || buf.length < 6) return false
  const sig = buf.toString('latin1', 0, 6)
  return sig === 'GIF87a' || sig === 'GIF89a'
}

/** 读 GIF 逻辑屏幕宽高（给日志/测试用，够判断"是不是大图"） */
export function gifSize(buf) {
  if (!isGif(buf) || buf.length < 10) return { width: 0, height: 0 }
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
}

/**
 * 起一个 Python 子进程跑拆帧脚本，把最后一行业 JSON 解出来。
 * 超时就 kill，不让一张坏图拖住整轮回复。
 */
function runPython(python, scriptPath, args, timeoutMs) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(python, [scriptPath, ...args], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch {
      resolve(null)
      return
    }
    let out = ''
    let err = ''
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {}
      finish(null)
    }, Math.max(1000, timeoutMs))
    child.stdout.on('data', (d) => {
      out += d.toString('utf8')
    })
    child.stderr.on('data', (d) => {
      err = (err + d.toString('utf8')).slice(-400)
    })
    child.on('error', () => finish(null))
    child.on('close', () => {
      const lines = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          finish(JSON.parse(lines[i]))
          return
        } catch {}
      }
      finish({ ok: false, error: err || 'no-output' })
    })
  })
}

/**
 * 把动图拆成一张多帧拼图。
 *
 * @param {Buffer} buf GIF 原始字节
 * @param {object} [opts] 覆盖 GIF_DEFAULTS 的字段（frames/columns/frameWidth/python/timeoutMs）
 * @returns {Promise<null|{png:Buffer,frames:number,gifFrames:number,width:number,height:number}>}
 *          不是 GIF、单帧、或 Python/Pillow 不可用时返回 null（调用方回退原图）
 */
export async function gifContactSheet(buf, opts = {}) {
  if (!isGif(buf)) return null
  const o = { ...GIF_DEFAULTS, ...opts }
  if (o.enabled === false) return null
  // 没配 Python 解释器就直接回退（调用方只看首帧），不要 spawn('') 白等一个超时
  if (!String(o.python || '').trim()) return null
  const key =
    createHash('sha1').update(buf).digest('hex') + `|${o.frames}|${o.columns}|${o.frameWidth}`
  if (cache.has(key)) return cache.get(key)

  let dir = ''
  try {
    dir = await mkdtemp(path.join(tmpdir(), 'molly-gif-'))
    const gifPath = path.join(dir, 'in.gif')
    const pyPath = path.join(dir, 'sheet.py')
    const pngPath = path.join(dir, 'sheet.png')
    await writeFile(gifPath, buf)
    await writeFile(pyPath, PY_SOURCE, 'utf8')
    const res = await runPython(
      o.python,
      pyPath,
      [gifPath, pngPath, String(o.frames), String(o.columns), String(o.frameWidth)],
      o.timeoutMs,
    )
    if (!res || res.ok !== true) return null
    const png = await readFile(pngPath)
    if (!png || png.length === 0) return null
    const out = { png, frames: res.frames, gifFrames: res.gifFrames, width: res.width, height: res.height }
    if (cache.size >= MAX_CACHE) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    cache.set(key, out)
    return out
  } catch {
    return null
  } finally {
    if (dir) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }
}

/** 测试/诊断用：清掉帧缓存 */
export function clearGifCache() {
  cache.clear()
}

/** 测试/诊断用：当前缓存条数 */
export function gifCacheSize() {
  return cache.size
}
