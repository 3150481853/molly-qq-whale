/**
 * 表情包学习。
 *
 * 用户想要的是「Molly 会偷别人的表情包自己用」。这件事的难点不在下载，
 * 在**判断这张图适不适合她**：
 *
 *   - 群里有人发「你这傻逼」配一张骂人的图 → 学来就完了。
 *   - 有人发自己的自拍/证件/聊天截图截图 → 那是隐私，绝不能学。
 *   - 有人发一张正经的图表/PPT 截图 → 那不是表情包。
 *
 * 所以流程是四道闸门，宁可少学不可学错：
 *   1. **来源闸门**：只从白名单用户/白名单群里学；只认 QQ 动画表情(sub_type=1)
 *      和商城表情(mface)，普通图片一律不学（普通图片里藏着太多不该存的东西）。
 *   2. **体积闸门**：超过 maxFileSizeMB 不学（QQ 表情包通常几十 KB，
 *      几 MB 的八成是原图/长图）。
 *   3. **视觉闸门**：交给多模态模型看一眼，让它回答「这是不是表情包」「这张图
 *      带不带人身攻击/色情/隐私信息」「一句话描述画面」。判不合格就丢掉。
 *   4. **描述闸门**：模型给的描述必须干净（长度合适、不是拒答、不含敏感词），
 *      然后用它当文件名——文件名就是检索标签，这跟 StickerLibrary 的约定一致。
 *
 * 学到的图落在 `<stickerDir>/学来的/` 下，文件名 `<描述>.gif`。
 * 这样它和手工图库共用一套索引，无需特殊对待。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

/*
 * 本地日期，跟 budget.js 共用一份实现。
 * 这里原来写的是 new Date().toISOString().slice(0, 10)，是 UTC 日期，
 * 于是"每天学几张"的配额在北京时间早上 8 点才重置，而不是半夜。
 */
import { localDateKey } from './budget.js'

/** 判断这条消息里有没有"可学"的表情包 */
export function findLearnableStickers(norm) {
  const out = []
  for (const img of norm?.images || []) {
    const url = img?.url || ''
    if (!/^https?:\/\//i.test(url)) continue
    // sub_type === 1 是 QQ 动画表情；mface 是商城表情。
    // 普通图片（sub_type 为 0 或缺失）不学——见文件头第 1 条闸门。
    const isMarketFace = Boolean(img?.emojiId) || Boolean(img?.isMface)
    if (Number(img?.subType) === 1 || isMarketFace) {
      out.push({ url, summary: String(img?.summary || ''), kind: isMarketFace ? 'mface' : 'image' })
    }
  }
  return out
}

/** 按魔数认格式，扩展名不可信（QQ 的 file 字段经常是乱码 id） */
export function sniffImageExt(buf) {
  if (!buf || buf.length < 12) return null
  const b = buf
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'jpg'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif'
  if (b.toString('ascii', 8, 12) === 'WEBP') return 'webp'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return 'webp'
  return null
}

/*
 * ── `.learned.json` 哈希表（控制台 CRUD 用）──────────────────────────
 *
 * 这张表是「这张图已经学过了」的**内容哈希**清单，目的是防止同一张图被
 * 反复存进图库（群里转一遍就多一份）。它**不是关键词表**——关键词在文件名里。
 *
 * 控制台的上传/删除也要维护它：
 *   - 上传后不登记 → 这张刚加进去的图，下次谁发一遍又会被当成新图"学"一次
 *   - 删除后不摘掉 → 以后同一张图再也学不进来（哈希永远命中"已学过"）
 *
 * 抽成模块级函数是给 `web.js` 用的：那边手里只有目录路径，不一定有
 * `StickerLearner` 实例（教学开关关掉时 `engine.learner` 是 null）。
 */
export function learnedIndexFile(dir) {
  return path.join(dir || '.', '.learned.json')
}

export function readLearnedHashes(dir) {
  try {
    const arr = JSON.parse(fs.readFileSync(learnedIndexFile(dir), 'utf8'))
    return Array.isArray(arr) ? arr.map((h) => String(h)).filter(Boolean) : []
  } catch {
    return [] // 首次运行没有索引，正常
  }
}

export function writeLearnedHashes(dir, hashes) {
  const file = learnedIndexFile(dir)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const uniq = [...new Set((hashes || []).map((h) => String(h)).filter(Boolean))]
  fs.writeFileSync(file, JSON.stringify(uniq), 'utf8')
  return uniq
}

/** 登记一个内容哈希（已存在则不动）。返回写后的完整数组。 */
export function addLearnedHash(dir, hash) {
  const h = String(hash || '').trim()
  const cur = readLearnedHashes(dir)
  if (!h || cur.includes(h)) return cur
  cur.push(h)
  return writeLearnedHashes(dir, cur)
}

/** 摘掉一个内容哈希（不存在则不动）。返回写后的完整数组。 */
export function removeLearnedHash(dir, hash) {
  const h = String(hash || '').trim()
  const cur = readLearnedHashes(dir)
  const next = cur.filter((x) => x !== h)
  if (next.length === cur.length) return cur
  return writeLearnedHashes(dir, next)
}

/** 把模型给的描述洗成能当文件名的样子 */
export function sanitizeDescription(text) {
  let s = String(text || '')
    .replace(/^["'「『]|["'」』]$/g, '')
    .replace(/[\\/:*?"<>|\r\n\t]/g, ' ')
    .replace(/\s+/g, '_')
    .replace(/[。，、；！？.,;!?]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .trim()
  if (s.length > 40) s = s.slice(0, 40)
  return s
}

/** 描述是否干净可用 */
function descriptionOk(desc, raw) {
  const d = String(desc || '').trim()
  if (d.length < 2 || d.length > 40) return { ok: false, why: '描述长度不合适' }
  // 模型明确判了不合规
  if (/不适合/.test(d)) return { ok: false, why: '模型判定不适合' }
  // 模型拒答/跑题
  if (/无法|不能|抱歉|对不起|作为|sorry|cannot|unable/i.test(d)) return { ok: false, why: '描述像拒答' }
  // 明显不该进图库的东西（人身攻击/色情/隐私）
  const banned = /(辱骂|骂人|色情|裸|傻逼|煞笔|去死|操你|隐私|身份证|手机号|密码)/i
  if (banned.test(d) || banned.test(String(raw || ''))) return { ok: false, why: '描述含敏感内容' }
  // 界面/文档类：这类描述说明原图是截图、表格、PPT。
  // 光靠 prompt 不可靠（实测"计费规则_峰谷时段_配置界面"照样被当成表情包标签），
  // 所以在代码里再兜一层。真正的手绘图库不会出现这些词。
  const uiWords = /(界面|截图|文档|表格|菜单|设置|配置|按钮|面板|代码|图表|列表|窗口|对话框|输入框|官网|页面|仪表|账单|计费|规则|条款|\bUI\b)/i
  const hits = d.match(uiWords)
  if (hits) return { ok: false, why: `描述像界面截图（命中「${hits[0]}」）` }
  // 至少要能表达情绪或形象，纯名词堆砌（"蓝色_矩形"）不像表情包
  if (d.split(/[_\s]+/).filter(Boolean).length < 2) return { ok: false, why: '描述词太少' }
  return { ok: true, why: '' }
}

export class StickerLearner {
  /**
   * @param {object} o
   * @param {string} o.dir            学来的图放这里（一般是 <stickerDir>/学来的）
   * @param {object} o.vision         {describe(buffer, mime) -> Promise<string>} 视觉描述器
   * @param {object} o.library        StickerLibrary 实例，学完要重扫
   * @param {function} o.logger
   * @param {number} o.maxFileSizeMB
   * @param {function} o.isAllowedFrom ({userId, groupId}) => boolean
   * @param {number} o.maxPerDay      每天最多学几张，防止被刷库
   */
  constructor({ dir, vision, library, logger, maxFileSizeMB = 2, isAllowedFrom, maxPerDay = 20 }) {
    this.dir = dir
    this.vision = vision
    this.library = library
    this.logger = logger || (() => {})
    this.maxBytes = Math.max(1, maxFileSizeMB) * 1024 * 1024
    this.isAllowedFrom = isAllowedFrom || (() => true)
    this.maxPerDay = Math.max(1, maxPerDay)
    this.learned = new Set() // 已学内容的 sha256，避免同一张图反复存
    this.hashesFile = path.join(dir || '.', '.learned.json')
    this.dayKey = ''
    this.dayCount = 0
    this.stats = { seen: 0, kept: 0, rejected: 0, dup: 0 }
    this.loadIndex()
  }

  loadIndex() {
    try {
      const raw = fs.readFileSync(this.hashesFile, 'utf8')
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) for (const h of arr) this.learned.add(String(h))
    } catch {
      /* 首次运行没有索引，正常 */
    }
  }

  async saveIndex() {
    try {
      await fsp.mkdir(this.dir, { recursive: true })
      await fsp.writeFile(this.hashesFile, JSON.stringify([...this.learned]), 'utf8')
    } catch (err) {
      this.logger('debug', `表情包索引保存失败: ${err?.message || err}`)
    }
  }

  /**
   * 控制台新加一张表情包后登记内容哈希（内存 + `.learned.json` 一起）。
   * 不登记的话，这张图下次被人发一遍又会被当成"新图"学一次、重复存盘。
   * @param {string} hash 图片内容 sha256
   */
  addHash(hash) {
    const h = String(hash || '').trim()
    if (!h) return
    this.learned.add(h)
    try {
      addLearnedHash(this.dir, h)
    } catch (err) {
      this.logger('debug', `表情包索引写入失败（不影响图库）: ${err?.message || err}`)
    }
  }

  /**
   * 控制台删掉一张表情包后摘掉它的内容哈希。
   * 不摘的话以后同一张图永远学不进来（哈希一直命中"已学过"）。
   * @param {string} hash 图片内容 sha256
   */
  removeHash(hash) {
    const h = String(hash || '').trim()
    if (!h) return
    this.learned.delete(h)
    try {
      removeLearnedHash(this.dir, h)
    } catch (err) {
      this.logger('debug', `表情包索引写入失败（不影响图库）: ${err?.message || err}`)
    }
  }

  /** 每天学几张的配额。跨天自动重置。 */
  budgetOk() {
    const today = localDateKey()
    if (today !== this.dayKey) {
      this.dayKey = today
      this.dayCount = 0
    }
    return this.dayCount < this.maxPerDay
  }

  /**
   * 处理一条收到的消息，把里面值得学的表情包存下来。
   * 返回 { kept: [...], rejected: n }。**永不抛异常**——学习失败不能影响聊天。
   */
  async consider(norm, { userId, groupId, download }) {
    const result = { kept: [], rejected: 0, skipped: 0 }
    const cands = findLearnableStickers(norm)
    if (cands.length === 0) return result
    if (!this.isAllowedFrom({ userId, groupId })) {
      this.logger('debug', '表情包学习：来源不在白名单，跳过')
      return result
    }
    for (const c of cands) {
      this.stats.seen++
      if (!this.budgetOk()) {
        result.skipped++
        continue
      }
      try {
        const buf = await download(c.url)
        if (!buf || buf.length === 0) {
          result.skipped++
          continue
        }
        if (buf.length > this.maxBytes) {
          this.logger('debug', `表情包学习：体积 ${(buf.length / 1024).toFixed(0)}KB 超限，跳过`)
          result.skipped++
          continue
        }
        const ext = sniffImageExt(buf)
        if (!ext) {
          this.logger('debug', '表情包学习：认不出图片格式，跳过')
          result.skipped++
          continue
        }
        // 以内容哈希去重，同一张图被转发 N 次也只存一份
        const hash = crypto.createHash('sha256').update(buf).digest('hex')
        if (this.learned.has(hash)) {
          this.stats.dup++
          result.skipped++
          continue
        }

        // 视觉闸门：让模型看一眼，顺便给出描述（描述将来当检索标签）
        let desc = ''
        try {
          desc = await this.vision.describe(buf, `image/${ext}`)
        } catch (err) {
          this.logger('debug', `表情包学习：视觉描述失败，跳过（${err?.message || err}）`)
          result.skipped++
          continue
        }
        const verdict = descriptionOk(desc, c.summary)
        if (!verdict.ok) {
          this.logger('debug', `表情包学习：拒绝（${verdict.why}）desc="${String(desc).slice(0, 40)}"`)
          this.stats.rejected++
          result.rejected++
          continue
        }

        const name = sanitizeDescription(desc)
        if (!name) {
          result.rejected++
          continue
        }
        await fsp.mkdir(this.dir, { recursive: true })
        // 同名不覆盖：加短哈希后缀
        let target = path.join(this.dir, `${name}.${ext}`)
        if (fs.existsSync(target)) target = path.join(this.dir, `${name}_${hash.slice(0, 6)}.${ext}`)
        await fsp.writeFile(target, buf)

        this.learned.add(hash)
        this.dayCount++
        this.stats.kept++
        result.kept.push({ file: path.basename(target), desc: name })
        this.logger('info', `学到一张表情包：${path.basename(target)}`)
      } catch (err) {
        this.logger('debug', `表情包学习异常（忽略）: ${err?.message || err}`)
        result.skipped++
      }
    }
    if (result.kept.length > 0) {
      await this.saveIndex()
      // 让新图立刻能被她用上，不用等 5 分钟重扫
      try {
        this.library?.scan()
      } catch {}
    }
    return result
  }

  describe() {
    const s = this.stats
    return `看过 ${s.seen} 张，学下 ${s.kept} 张，拒绝 ${s.rejected} 张，重复 ${s.dup} 张`
  }
}
