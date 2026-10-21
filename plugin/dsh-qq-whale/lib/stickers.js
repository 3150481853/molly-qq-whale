/**
 * 表情包库。
 *
 * 斗图的关键不是"有图"，是**在正确的时候掏出正确的图**。
 * 所以这个模块做三件事：
 *   1. 扫描本地图库，建索引（文件名即语义标签，中文文件名很好用）
 *   2. 给模型一份"图库目录"（只给标签，不给像素），让模型用 <sticker>标签</sticker> 点单
 *   3. 点单时按标签做加权匹配，命中率不够就退化成"用文字装作被噎到"
 *
 * 为什么不让模型看图选：一次请求几 MB 图片，QQ 场景下不划算，
 * 而且模型描述图片的能力在"这张图是不是适合这个上下文"上并不比标签好。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/*
 * 魔数判图：上传接口不能信扩展名（用户会把 .txt 改成 .jpg 传上来）。
 * `sniffImageExt` 是表情包学习器里已有的那份实现，这里直接复用，
 * 不重写第二套——两处判据不一致时最难查。
 */
import { sniffImageExt } from './sticker-learn.js'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

/**
 * 口语 → 图库用词的单向同义扩展。
 *
 * 为什么需要：模型会写「上班好累」，图库标签是「加班_累死了」，
 * 两字子串毫无交集，匹配直接落空。人来挑图不会卡在这上面，
 * 因为他知道"上班累"和"加班累死了"是一码事。
 *
 * 维护原则：只收高频、语义明确的映射；宁可少收，别收歧义词。
 * 左边是口语说法，右边是图库里真实存在的标签词。
 */
const SYNONYMS = [
  ['上班', '加班'],
  ['打工', '加班'],
  ['好累', '累死了'],
  ['累了', '累死了'],
  ['心累', '心累'],
  ['不想干活', '摆烂'],
  ['摸鱼', '摆烂'],
  ['不想动', '躺平'],
  ['躺一会', '躺平'],
  ['想睡', '困了'],
  ['好困', '困了'],
  ['晚安', '晚安'],
  ['生气', '发火'],
  ['不爽', '不服'],
  ['烦', '无语'],
  ['服了', '无语'],
  ['没话说', '无语'],
  ['难过', '想哭'],
  ['伤心', '想哭'],
  ['委屈', '想哭'],
  ['高兴', '开心'],
  ['开心', '开心'],
  ['好耶', '开心'],
  ['喜欢', '比心'],
  ['爱你', '比心'],
  ['贴贴', '贴贴'],
  ['害羞', '脸红'],
  ['不好意思', '脸红'],
  ['震惊', '震惊'],
  ['卧槽', '震惊'],
  ['厉害', '震惊'],
  ['要钱', '要token'],
  ['给钱', '要钱'],
  ['赏点', '要钱'],
  ['吃饭', '干饭'],
  ['吃白饭', '干饭'],
  ['饿了', '干饭'],
  ['早安', '早安'],
  ['早上好', '早安'],
  ['嗨', '打招呼'],
  ['你好', '打招呼'],

  /*
   * 下面这批是实测补出来的（tools/test-sticker-habit.mjs，2026-10-17）。
   *
   * 那次让模型自由写 <sticker>关键词</sticker>，它写了"抱抱"——图库里叫
   * "撒娇_求抱_贴贴"和"比心_喜欢你_贴贴_爱了"，一个字都对不上，于是
   * 图发不出去、退化成一句"找图找了半天"。这不是模型的问题，是
   * **关键词表只覆盖了用户口语，没覆盖模型自己的用词习惯**。
   *
   * 所以这里补的第一类就是模型爱说的情绪词：抱抱、安慰、摸摸、委屈巴巴…
   * 它们全都映射到图库里真实存在的标签上。
   */
  ['抱抱', '贴贴'],
  ['抱一下', '贴贴'],
  ['求抱', '贴贴'],
  ['安慰', '贴贴'],
  ['摸摸', '贴贴'],
  ['想你', '贴贴'],
  ['撒娇', '撒娇'],
  ['要吃的', '馋'],
  ['求投喂', '被投喂'],
  ['投喂', '被投喂'],
  ['没力气', '没力气'],
  ['累瘫', '累瘫'],
  ['虚弱', '虚弱'],
  ['崩溃', '崩溃'],
  ['破防', '破防'],
  ['生无可恋', '生无可恋'],
  ['摆烂', '摆烂'],
  ['躺平', '躺平'],
  ['发呆', '发呆'],
  ['看戏', '看戏'],
  ['淡定', '淡定'],
  ['无语', '无语'],
  ['翻白眼', '鄙视'],
  ['鄙视', '鄙视'],
  ['笨蛋', '笨蛋'],
  ['嫌弃', '嫌弃'],
  ['看不懂', '想不通'],
  ['懵', '想不通'],
  ['问号', '想不通'],
  ['吓一跳', '吓一跳'],
  ['哇', '哇'],
  ['看呆', '看呆了'],
  ['心动', '心动'],
  ['上头', '上头'],
  ['恋爱', '恋爱了'],
  ['花痴', '花痴'],
  ['骄傲', '骄傲'],
  ['得意', '得意'],
  ['爽', '爽'],
  ['满足', '满足'],
  ['吃饱', '吃饱了'],
  ['求饶', '求饶'],
  ['不要啊', '求饶'],
  ['装傻', '装傻'],
  ['卖萌', '卖萌'],
  ['抓狂', '抓狂'],
  ['要token', '要token'],
  ['token来', '要token'],
  ['给点吧', '给点吧'],
  ['伸手', '伸手要'],
  ['馋', '馋'],
  ['饿', '饿'],
  ['没饭吃', '没饭吃'],
  ['可怜', '可怜'],
  ['不服', '不服'],
  ['犟', '犟'],
  ['发火', '发火'],
  ['委屈', '委屈'],
]

/** 从文件名里拆标签：去掉扩展名、序号、常见分隔符 */
function tagsFromFilename(file) {
  const base = path.basename(file, path.extname(file))
  return base
    .replace(/[_\-–—.]/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .split(' ')
    .filter(Boolean)
}

/**
 * 纯分类词：它们只说明"这张图归在哪一类"，不携带任何可搜的语义。
 *
 * 这类词混进标签表会排在很前面（因为它覆盖整个目录），模型看到就去用了，
 * 结果匹配到半屏不相干的图。目录名那套已经能挡住「大肥鱼」这种大目录，
 * 但小目录（11 张的「心情」）还不够格被覆盖率的规则挡下，所以单独列出来。
 */
const GENERIC_DIR_WORDS = new Set(['心情', '表情', '分类', '其他', '其它', '默认', '杂图', '表情包', '日常'])

/**
 * 控制台 CRUD 的「可写目录」：只有 `<stickerDir>/学来的/`。
 *
 * 为什么不给全图库写权限：别的目录是人工整理的（「表情_心情」那种），
 * 控制台上的增删改如果误伤到它们，用户没有任何撤销手段；而「学来的」
 * 本来就是自动/半自动堆积出来的，删错了也能重新学。
 */
export const LEARNED_DIR_NAME = '学来的'

/** 带 HTTP 状态码的错，路由层据此回 400/404，不用猜错误文案 */
export class StickerError extends Error {
  constructor(message, status = 400) {
    super(message)
    this.name = 'StickerError'
    this.status = status
  }
}

/**
 * 关键词清洗（契约 §2.2）：`_` 是文件名里的**分隔符**，所以单个关键词里的
 * `_` 必须换成 `-`，否则「鲸鱼_娘」会变成两个关键词。
 * 其余非法字符（路径分隔符、Windows 保留符号）一律换成 `-`。
 *
 * @param {string[]|string} input 数组，或「逗号/空格」分隔的字符串
 * @returns {string[]} 清洗后的关键词（最多 8 个，去重、保序）
 */
export function cleanKeywords(input) {
  const raw = Array.isArray(input) ? input : String(input ?? '').split(/[,，、;；\s]+/)
  const out = []
  for (const item of raw) {
    let s = String(item ?? '').trim()
    if (!s) continue
    s = s
      .replace(/[\\/*?"<>|:]|_/g, '-') // `_` 是分隔符，非法字符换 -
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
    if (!s) continue
    if ([...s].length > 20) s = [...s].slice(0, 20).join('')
    if (out.includes(s)) continue
    out.push(s)
    if (out.length >= 8) break
  }
  return out
}

/** 单张表情包上限（契约 §2.2：8 MB） */
export const STICKER_MAX_BYTES = 8 * 1024 * 1024

export class StickerLibrary {
  constructor({ dir, logger, maxFileSizeMB = 5 }) {
    this.dir = dir
    this.logger = logger || (() => {})
    this.maxBytes = Math.max(1, maxFileSizeMB) * 1024 * 1024
    this.items = []
    this.byTag = new Map()
    this.lastScanAt = 0
  }

  /** 扫描图库。目录不存在不报错——表情包是可选能力。 */
  scan() {
    const items = []
    const byTag = new Map()
    if (!this.dir || !fs.existsSync(this.dir)) {
      this.items = []
      this.byTag = byTag
      this.lastScanAt = Date.now()
      return { count: 0, skipped: 0 }
    }
    let skipped = 0
    const walk = (d) => {
      let entries
      try {
        entries = fs.readdirSync(d, { withFileTypes: true })
      } catch (err) {
        this.logger('warn', `表情包目录读取失败 ${d}: ${err.message}`)
        return
      }
      for (const e of entries) {
        const full = path.join(d, e.name)
        if (e.isDirectory()) {
          walk(full)
          continue
        }
        if (!e.isFile()) continue
        if (!IMAGE_EXT.has(path.extname(e.name).toLowerCase())) continue
        let st
        try {
          st = fs.statSync(full)
        } catch {
          continue
        }
        if (st.size > this.maxBytes) {
          skipped++
          continue
        }
        // 目录名也算标签：「生气/翻白眼.gif」既有"生气"也有"翻白眼"
        // 但「表情_心情」这类纯归类目录名是给人类看的，不该进标签——
        // 它们会在目录清单里占满席位，把真正有用的标签挤掉。
        const dirTags = path
          .relative(this.dir, path.dirname(full))
          .split(/[\\/]/)
          .filter((s) => s && s !== '.' && !/^表情$|^sticker/i.test(s))
          .flatMap((s) => s.split(/[_\-–—.]|表情/).filter(Boolean))
          .filter((s) => s && !GENERIC_DIR_WORDS.has(s))
        const tags = [...new Set([...dirTags, ...tagsFromFilename(full)])].filter(
          (t) => t && !GENERIC_DIR_WORDS.has(t),
        )
        const item = { path: full, file: path.relative(this.dir, full), tags, size: st.size }
        items.push(item)
        for (const t of tags) {
          if (!byTag.has(t)) byTag.set(t, [])
          byTag.get(t).push(item)
        }
      }
    }
    walk(this.dir)
    this.items = items
    this.byTag = byTag
    this.lastScanAt = Date.now()
    return { count: items.length, skipped }
  }

  /** 距上次扫描超过 intervalMs 才重扫，避免每条消息都 IO */
  maybeRescan(intervalMs = 5 * 60 * 1000) {
    if (Date.now() - this.lastScanAt < intervalMs) return false
    this.scan()
    return true
  }

  /*
   * ── 控制台 CRUD（2026-10-19，契约 §2.2）────────────────────────────
   *
   * 为什么关键词只能靠"重命名文件"来改：这个库没有独立的元数据表，
   * 关键词就编码在文件名里（`动漫少女_震惊.jpg` → 动漫少女 / 震惊）。
   * `.learned.json` 只是内容哈希，防止同一张图被重复学，**不是关键词表**。
   *
   * 所有写操作都只允许落在 `学来的/` 下：别的目录是人工整理的，
   * 控制台误删没有撤销手段；「学来的」本来就是半自动堆积的，删了还能重学。
   */

  /** 可写目录（`<stickerDir>/学来的`）的绝对路径 */
  learnedDir() {
    return path.join(this.dir || '.', LEARNED_DIR_NAME)
  }

  /** 把一个绝对路径整理成控制台要的 item 形状（`web.js` 直接吐给前端） */
  itemFor(full) {
    const st = fs.statSync(full)
    const file = path.basename(full)
    const ext = path.extname(file)
    const name = path.basename(file, ext)
    return {
      name,
      ext,
      file,
      size: st.size,
      keywords: name.split('_').map((s) => s.trim()).filter(Boolean),
      mtime: Math.round(st.mtimeMs),
    }
  }

  /**
   * `学来的/` 目录清单。**只列这个目录**——契约 §1 的「表情包 = 学来的 15 张」
   * 和 §2.2 的 `file` 参数都以它为准，列表里给的文件名能直接拿去做 update/delete。
   */
  list() {
    const dir = this.learnedDir()
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return [] // 目录还不存在：返回空列表，不报错
    }
    const out = []
    for (const e of entries) {
      if (!e.isFile()) continue
      if (e.name.startsWith('.')) continue // .learned.json 不是表情包
      if (!IMAGE_EXT.has(path.extname(e.name).toLowerCase())) continue
      try {
        out.push(this.itemFor(path.join(dir, e.name)))
      } catch {
        /* 文件刚好被删，跳过 */
      }
    }
    out.sort((a, b) => a.file.localeCompare(b.file, 'zh'))
    return out
  }

  /**
   * 把前端给的 `file` 解析成绝对路径，顺带挡路径穿越。
   *
   * 只接受两种写法：`xxx.jpg` 或 `学来的/xxx.jpg`。任何 `..`、绝对路径、
   * 带子目录的写法一律 400——包括 `../../memory/memory.json` 这种。
   * @throws {StickerError} 400
   */
  resolveLearned(file) {
    const raw = String(file ?? '').trim()
    if (!raw) throw new StickerError('缺少 file 参数')
    if (raw.includes('\0') || raw.includes('..')) throw new StickerError('file 不合法：禁止路径穿越')
    if (/^[\\/]/.test(raw) || /^[A-Za-z]:/.test(raw)) throw new StickerError('file 不合法：不允许绝对路径')
    const stripped = raw.replace(/^\.\//, '').replace(new RegExp(`^${LEARNED_DIR_NAME}[\\\\/]`), '')
    const base = path.basename(stripped)
    if (!base || base !== stripped) throw new StickerError('file 只能是「学来的」目录下的文件名')
    const dir = path.resolve(this.learnedDir())
    const full = path.resolve(dir, base)
    if (!full.startsWith(dir + path.sep)) throw new StickerError('file 不在「学来的」目录内')
    return { full, name: base, dir }
  }

  /**
   * 新增一张：写盘 → 重扫 → 返回 item 与内容 sha256（由调用方写进
   * `.learned.json`，避免它被当成"新图"再学一遍）。
   * @throws {StickerError} 400
   */
  add({ buffer, keywords, filename } = {}) {
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || [])
    if (!buf.length) throw new StickerError('图片内容为空')
    if (buf.length > STICKER_MAX_BYTES) {
      throw new StickerError(`图片超过 ${Math.round(STICKER_MAX_BYTES / 1024 / 1024)} MB 上限`)
    }
    // 魔数判型：扩展名只用来拼落盘文件名，绝不用来判断"是不是图片"
    const kind = sniffImageExt(buf)
    if (!kind) throw new StickerError('不是支持的图片：按魔数识别失败（只收 jpg/png/gif/webp）')
    let kws = cleanKeywords(keywords)
    if (kws.length === 0 && filename) {
      const base = path.basename(String(filename), path.extname(String(filename)))
      kws = cleanKeywords(base)
    }
    if (kws.length === 0) throw new StickerError('关键词不能为空')
    const dir = this.learnedDir()
    fs.mkdirSync(dir, { recursive: true })
    const baseName = kws.join('_').slice(0, 120)
    let target = path.join(dir, `${baseName}.${kind}`)
    // 重名不覆盖：追加 _2、_3……（契约 §2.2）
    for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${baseName}_${i}.${kind}`)
    fs.writeFileSync(target, buf)
    // 必须立刻重扫，否则本轮对话看不到新表情（match/catalogText 读的是 this.items）
    this.scan()
    return { item: this.itemFor(target), sha256: crypto.createHash('sha256').update(buf).digest('hex') }
  }

  /**
   * 改关键词 = 重命名文件（关键词编码在文件名里）。
   * 扩展名保持不变；新名撞车同样追加 `_2`。
   * @throws {StickerError} 400 / 404
   */
  rename(file, keywords) {
    const { full, name, dir } = this.resolveLearned(file)
    if (!fs.existsSync(full)) throw new StickerError('file 不存在', 404)
    const ext = path.extname(name).toLowerCase()
    if (!IMAGE_EXT.has(ext)) throw new StickerError('不是图片文件')
    const kws = cleanKeywords(keywords)
    if (kws.length === 0) throw new StickerError('关键词不能为空')
    const baseName = kws.join('_').slice(0, 120)
    const oldBase = path.basename(name, path.extname(name))
    if (baseName === oldBase) {
      // 关键词没变：不碰文件，直接回现状（幂等）
      return { item: this.itemFor(full), renamed: { from: name, to: name } }
    }
    let target = path.join(dir, `${baseName}${ext}`)
    for (let i = 2; fs.existsSync(target); i++) target = path.join(dir, `${baseName}_${i}${ext}`)
    fs.renameSync(full, target)
    this.scan()
    return { item: this.itemFor(target), renamed: { from: name, to: path.basename(target) } }
  }

  /**
   * 删一张：先算内容 sha256（调用方要拿它去 `.learned.json` 里摘掉），
   * 再删文件、重扫。
   * @throws {StickerError} 400 / 404
   */
  remove(file) {
    const { full, name } = this.resolveLearned(file)
    if (!fs.existsSync(full)) throw new StickerError('file 不存在', 404)
    const item = this.itemFor(full)
    let sha256 = ''
    try {
      sha256 = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')
    } catch {
      /* 读不出来就只删文件，索引里留个孤儿哈希（下次学同一张图会被判重，可手动清） */
    }
    fs.unlinkSync(full)
    this.scan()
    return { item, sha256, file: name }
  }

  /**
   * 模型点单。
   * query 可能是一句话（"翻白眼"），也可能带多个词。做分词后打分：
   *   - 完整短语等于标签：+6（最可信）
   *   - 该词是某个标签的完整内容：+3
   *   - 双向子串只给很低的分数（+1 封顶）。
   *     这里踩过坑：原先后面的 `tag.includes(w) || w.includes(tag)` 还会
   *     按标签长度加分，导致「伸手要」这个短标签因为被 query 包含而
   *     压过「要吃的」——挑出来的图跟情绪完全不对。子串只负责兜底。
   */
  match(query, { limit = 3 } = {}) {
    const raw = String(query || '').toLowerCase().trim()
    if (!raw || this.items.length === 0) return []

    // 同义词扩展：用户/模型说的是「上班好累」，标签写的是「加班_累死了」，
    // 两字子串完全对不上。中文表情包的语义靠情绪词传递，所以先把它翻译成
    // 图库里真正会出现的词，再走原来的打分。
    // 注意只做单向扩展（口语 → 标签词），不反过来，免得噪声翻倍。
    const expanded = [raw]
    for (const [from, to] of SYNONYMS) {
      if (raw.includes(from)) expanded.push(to)
    }

    const words = new Set()
    for (const q of expanded) {
      words.add(q)
      /*
       * 2026-10-21：分隔符补上 `_ - / ・`。
       * 模型按提示词写出来的关键词经常是「无语_翻白眼」「猫猫-无语」这种
       * 带分隔符的复合词，原来只按标点/空白拆，整串拿去比标签永远对不上，
       * 于是命中率极低、只能退化到随机图。拆成单词后才有得分。
       */
      for (const w of q.split(/[\s,，。.!！?？、_\-/・]+/).map((s) => s.trim()).filter(Boolean)) words.add(w)
    }

    const scored = []
    /*
     * 分类目录的标签要降权。
     *
     * 实测踩坑（tools/test-sticker-habit.mjs）：图库按「表情_大肥鱼」「表情_蹭人」
     * 分目录，而目录名也被当成标签（这是有意为之，「生气」目录确实该能搜到）。
     * 但「大肥鱼」这个目录名出现在全部 24 张图上——模型写 <sticker>大肥鱼</sticker>
     * 时，24 张图全都拿到同样的分，排序退化成随机，最后挑出一张"加班烧CPU"。
     *
     * 判据：一个标签覆盖了这个图库超过 60% 的图，它就只是"分类"，不携带情绪。
     * 给它的权重压到 0，让它彻底退出竞争，而不是靠微弱分差碰运气。
     */
    const total = this.items.length
    for (const item of this.items) {
      let score = 0
      for (const tag of item.tags) {
        const cover = (this.byTag.get(tag) || []).length
        const isCategory = total >= 5 && cover / total > 0.6
        if (isCategory) continue
        for (const q of expanded) {
          if (q === tag) score += 6
          else if (q.includes(tag) && tag.length >= 2) score += 3
        }
        for (const w of words) {
          if (w === tag) score += 3
          // 单字词几乎总是噪声（「哭」会把一堆不相干的标签捞出来），
          // 中文表情包语义靠双字以上才站得住，所以单字只做完全匹配。
          else if (w.length >= 2 && (tag.includes(w) || w.includes(tag))) score += 1
        }
      }
      /*
       * 2026-10-21：+1 的双向子串只是兜底噪声，单独出现时不构成"命中"。
       * 实测「伸手要」这种短标签能靠子串把不相干的图捞上来，所以门槛
       * 提到 ≥2：要么完整词相等(+3/+6)，要么子串叠加到两分以上。
       */
      if (score >= 2) scored.push({ item, score })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit).map((s) => s.item)
  }

  /**
   * 随机抽一张——斗图实在接不上时用，总比文字强。
   *
   * @param {function} rng
   * @param {object} [opts]
   * @param {Set<string>|null} [opts.exclude] 最近发过的文件名，尽量不重样
   */
  random(rng = Math.random, { exclude = null } = {}) {
    if (this.items.length === 0) return null
    let pool = this.items
    if (exclude && typeof exclude.has === 'function' && exclude.size > 0) {
      const fresh = this.items.filter((it) => !exclude.has(it.file))
      // 排除光会兜回全集（图库只有一张时不该返回 null）
      if (fresh.length > 0) pool = fresh
    }
    return pool[Math.floor(rng() * pool.length)]
  }

  /**
   * 给模型的图库目录。**只给标签，不给路径**——模型不需要知道磁盘结构，
   * 而且给路径会让它写出奇怪的文件名。
   */
  catalogText({ maxTags = 80 } = {}) {
    if (this.items.length === 0) return ''
    const freq = new Map()
    for (const item of this.items) for (const t of item.tags) freq.set(t, (freq.get(t) || 0) + 1)
    /*
     * 目录名（「大肥鱼」「心情」这类）覆盖率太高，不能出现在给模型的标签表里。
     *
     * 两重害处：① 它会排在最前面，模型以为这是最常用的词，于是写
     * <sticker>大肥鱼</sticker>，结果匹配到全部图片、等于随机；
     * ② 它占掉了本该给情绪词的席位。所以这里跟 match 用同一个阈值筛掉。
     */
    const total = this.items.length
    const tags = [...freq.entries()]
      .filter(([t, n]) => !(total >= 5 && n / total > 0.6))
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxTags)
      .map(([t]) => t)
    return `图库共 ${this.items.length} 张。可用标签（按出现频率）：${tags.join('、')}`
  }
}
