/**
 * 持久记忆。
 *
 * 需求很直接：「不要在 QQ 聊着聊着就忘了我」。
 *
 * 而 DSH 本身就把会话存成 jsonl.zstd 落在磁盘上，天然具备持久化。
 * 所以这里**不重新造一套记忆库**，而是：
 *   1. 把每一轮 QQ 对话映射到一条固定的 DSH 会话（每个私聊对象 / 每个群一条）
 *   2. 会话不通就自动重建，重建时用 memory.md 里的"她的记忆摘要"当种子
 *   3. 另外维护一份人读得懂的记忆文件（memory.md），记录事实与关系，
 *      供上下文压缩和跨会话召回使用
 *
 * 为什么不直接塞 vector DB：这个场景的记忆量级是「几百条事实」，
 * 结构化文件 + 命中关键词比向量检索更可控，也不会产生"记错了"的幻觉。
 */

import fs from 'node:fs'
import path from 'node:path'

import { localDateKey, localDateTime } from './budget.js'
import {
  DEFAULT_KEY_FILE,
  decryptText,
  isEnvelope,
  loadKey,
  writeEncryptedFile,
} from './memcrypt.js'

/**
 * 记忆召回窗口（P5 起点，task-55 定档）。
 *
 * ★ 要调窗口**只改这一处**：`MEMORY_WINDOW_PROFILES` + `WINDOW_PROFILE` 两个常量。
 *   其它文件（engine.js / engine-context.js / main.js）一律从这里取，不许再写死数字。
 *   改完把源码 lib 与安装副本 lib 各同步一次，再跑 tools/test-window-config.mjs。
 *
 * 数字怎么来的（2026-10-19 真实数据）：memory.md 共 60 条，单行 26~76 字，
 * 平均 42.6 字（其中「- 2026-10-19 [fact/w3] 」这类前缀约占 28 字，
 * 正文平均只有 15 字），所以一条记忆折进提示词大约 40~45 字。
 *
 *   - contextLimit 32：32 条 ≈ 1.4k 字 ≈ 950 token。原来是 24 条，
 *     在 60~100 条的规模下，第 25~32 位的「较早但高权重的偏好」会被切掉——
 *     用户抱怨的"记不住我说过的话"有一部分就是这个。再往上（48+）在
 *     当前记忆量级里重叠度高、边际收益小，先停在 32。
 *   - queryLimit 12：关键词召回要求「两字以上词命中」，精度高、条数天然偏少；
 *     同一话题常有 3~5 条相关（"猫叫团子" + "猫不爱吃湿粮" + "团子怕生"），
 *     8 条在高召回时会漏边，12 条留出余量。
 *   - degradedContextLimit 12 / degradedQueryLimit 6：降智档（trae）上下文小、
 *     响应慢，按主档 ×1.5 温和提高（8→12、4→6），仍显著小于主档，
 *     宁可少喂也不能让它想太久。
 *   - entryChars 240：单条记忆超过 240 字通常是模型自己写长的段落，会把
 *     别的条目挤掉；截断保留主干，超长内容本来就该拆成多条记
 *     （200→240 是给「一条完整的因果」留出空间）。
 *
 * 三档用途：small = 省钱/小模型，balanced = 线上默认，large = 排查
 * 「是不是喂太少」时对照用。切档只改 WINDOW_PROFILE 一个字符串，不动任何调用点。
 */
export const WINDOW_PROFILE = 'large'

export const MEMORY_WINDOW_PROFILES = Object.freeze({
  small: Object.freeze({
    contextLimit: 20,
    queryLimit: 6,
    degradedContextLimit: 8,
    degradedQueryLimit: 4,
    entryChars: 200,
  }),
  balanced: Object.freeze({
    contextLimit: 32,
    queryLimit: 12,
    degradedContextLimit: 12,
    degradedQueryLimit: 6,
    entryChars: 240,
  }),
  large: Object.freeze({
    contextLimit: 48,
    queryLimit: 16,
    degradedContextLimit: 18,
    degradedQueryLimit: 9,
    entryChars: 320,
  }),
})

export const MEMORY_WINDOW = MEMORY_WINDOW_PROFILES[WINDOW_PROFILE]

// 配错档位名会静默变成 undefined，进而让 engine 里 limit=undefined 变成"不限"，
// 那是灾难级 bug；这里宁可启动就炸，也不要带着错配置跑。
if (!MEMORY_WINDOW) {
  throw new Error(`WINDOW_PROFILE 配错了：「${WINDOW_PROFILE}」，可选 ${Object.keys(MEMORY_WINDOW_PROFILES).join('/')}`)
}

/**
 * 记忆条目：
 *   { id, kind: 'fact'|'preference'|'promise'|'person'|'event', who, qq, text, weight, at }
 * weight 1..5，越高越不该被压缩掉。
 *
 * `who` 与 `qq`（2026-10-19 用户需求）：
 *   - who：**名字**，给人看的（群名片/昵称，可带 emoji）
 *   - qq：**QQ 号，字符串**，唯一身份。同名不同号必须当成两个人
 *   - 老条目没有 qq → 读时补空串（不写盘），召回时退化成"只按名字认"
 * 为什么叫 qq 不叫 id：条目本身已经有 `id`（CRUD 的 update/delete 靠它），撞名。
 */
export const QQ_PATTERN = /^[1-9]\d{4,11}$/

/** 把任意输入规整成 qq 字段：合法就留字符串，不合法/空就返 ''（唯一身份缺失） */
export function normalizeQq(value) {
  const s = String(value ?? '').trim()
  return QQ_PATTERN.test(s) ? s : ''
}

/** 控制台要区分「没填」和「填错了」，所以校验单独暴露一个函数 */
export function isValidQq(value) {
  const s = String(value ?? '').trim()
  return s === '' || QQ_PATTERN.test(s)
}
export class MemoryStore {
  /**
   * @param {object} options
   * @param {string} options.dir 记忆目录
   * @param {Function} [options.logger] (level, msg) => void
   * @param {number} [options.limit] 初始容量（2026-10-23 主人 m00709：默认 2000）
   * @param {number} [options.growTo] 记满后自动扩到的上限（主人要求 10000；0=不自动扩）
   * @param {{keyFile?: string}|null} [options.crypt] 传了就加密落盘（生产用）；null=明文（测试/迁移工具）
   * @param {string} [options.poolFile] 扩容状态落盘位置，默认 dir/memory-pool.json
   */
  constructor({ dir, logger, limit = 2000, growTo = 0, crypt = null, poolFile = '' }) {
    this.dir = dir
    this.logger = logger || (() => {})
    this.crypt = crypt || null
    this.broken = false
    this.migrated = false
    this.deduped = 0
    this.mergedCount = 0
    this.baseLimit = Math.max(1, Number(limit) || 2000)
    this.maxLimit = Math.max(this.baseLimit, Number(growTo) || 0)
    this.file = path.join(dir, 'memory.json')
    this.mdFile = path.join(dir, 'memory.md')
    this.mdEncFile = path.join(dir, 'memory.md.enc')
    this.poolFile = poolFile || path.join(dir, 'memory-pool.json')
    this.entries = []
    this.limit = this.readGrownLimit() || this.baseLimit
    if (this.crypt) {
      const info = loadKey({ keyFile: this.crypt.keyFile || DEFAULT_KEY_FILE, create: true })
      this.key = info.key
      this.keyFile = info.file
      this.keySource = info.source
    }
    this.load()
  }

  /** 是否加密落盘 */
  get encrypted() {
    return Boolean(this.crypt)
  }

  /** 读回「已经自动扩容过」的容量：记满之后重启不该缩回 2000 */
  readGrownLimit() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.poolFile, 'utf8'))
      const n = Math.round(Number(parsed?.limit))
      if (!Number.isFinite(n) || n <= 0) return 0
      if (this.maxLimit && n > this.maxLimit) return 0
      return n >= this.baseLimit ? n : 0
    } catch {
      return 0
    }
  }

  /** 扩容状态落盘（只在真正扩容时写一次，不是每条记忆都写） */
  writeGrownLimit() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(
        this.poolFile,
        `${JSON.stringify(
          { version: 1, base: this.baseLimit, limit: this.limit, grownAt: new Date().toISOString() },
          null,
          2,
        )}\n`,
        'utf8',
      )
    } catch (err) {
      this.logger('warn', `记忆池扩容状态写入失败（下次重启会退回 ${this.baseLimit} 条）: ${err.message}`)
    }
  }

  load() {
    let raw
    try {
      raw = fs.readFileSync(this.file, 'utf8')
    } catch (err) {
      if (err.code !== 'ENOENT') this.logger('warn', `memory.json 读取失败: ${err.message}`)
      this.entries = []
      return
    }
    let text = raw
    if (this.crypt) {
      let outer = null
      try {
        outer = JSON.parse(raw)
      } catch {
        outer = null
      }
      if (outer && isEnvelope(outer)) {
        try {
          text = decryptText(outer, this.key)
        } catch (err) {
          // 解不开就是解不开：宁可让整个池子停止读写，也不能覆盖唯一一份密文
          this.broken = true
          this.entries = []
          this.logger('error', `记忆池解密失败（密钥不对或文件损坏，已停止读写以免覆盖）: ${err.message}`)
          return
        }
      } else {
        // 历史明文文件：标记迁移，下面会先去重再整体加密
        this.needsMigration = true
      }
    }
    try {
      const parsed = JSON.parse(text)
      const list = Array.isArray(parsed?.entries) ? parsed.entries : []
      // 老条目没有 qq：这里补空串而不是补一个猜出来的号——
      // 猜错等于把两个人的记忆挂到同一个人身上，比"没号"更糟。
      // 只补在内存里，不写盘（下次 save() 自然会带出去）。
      this.entries = list.map((e) => ({ ...e, qq: normalizeQq(e.qq) }))
    } catch (err) {
      this.broken = true
      this.entries = []
      this.logger('error', `记忆池内容不是合法 JSON（已停止写回以免覆盖）: ${err.message}`)
      return
    }
    if (this.needsMigration && this.crypt) this.migrate()
  }

  /**
   * 明文 → 密文迁移：先去重（主人 m00709 第 2 条，历史重复一次性清掉），
   * 再整体加密写回；旧的 memory.md 转成 memory.md.enc 后删掉。
   * 不留明文副本——真要回滚，用 D:\MollyBackup 里的历史快照。
   */
  migrate() {
    const before = this.entries.length
    const rep = this.dedupeAll()
    this.deduped = rep.removed
    try {
      this.save()
      this.migrated = true
      this.logger(
        'info',
        `记忆池已加密迁移：${before} 条 → ${this.entries.length} 条（去重合并 ${rep.removed} 条）→ ${this.file}`,
      )
    } catch (err) {
      this.broken = true
      this.logger('error', `记忆池加密迁移失败（保留原明文文件，等修好再重试）: ${err.message}`)
    }
  }

  /** @returns {boolean} 是否真的写成功了（控制台 CRUD 要据此回 500，不能报假成功） */
  save() {
    if (this.broken) {
      this.logger('error', '记忆池处于 broken 状态（解密/迁移失败），拒绝写回以免覆盖唯一一份数据')
      return false
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const md = this.renderMarkdown()
      if (this.crypt) {
        writeEncryptedFile(this.file, JSON.stringify({ version: 2, entries: this.entries }, null, 2), this.key)
        writeEncryptedFile(this.mdEncFile, md, this.key)
        // 明文 md 已经加密存了，顺手删掉（否则「加密了但旁边还有一份明文」等于没加密）
        try {
          if (fs.existsSync(this.mdFile)) fs.unlinkSync(this.mdFile)
        } catch {}
      } else {
        fs.writeFileSync(this.file, JSON.stringify({ version: 1, entries: this.entries }, null, 2), 'utf8')
        fs.writeFileSync(this.mdFile, md, 'utf8')
      }
      return true
    } catch (err) {
      this.logger('error', `记忆写入失败: ${err.message}`)
      return false
    }
  }

  add({ kind = 'fact', who = '', qq = '', text = '', weight = 3 } = {}) {
    const t = String(text || '').trim()
    if (!t) return null
    const q = normalizeQq(qq)
    const name = String(who || '').trim()
    // 去重（2026-10-23 主人 m00709 第 2 条）：
    //   1. 比"人"：优先 qq（唯一身份），老条目没号时才退回比名字；
    //   2. 比"话"：**不再看 kind**——「喜欢猫」记成 fact 还是 preference 都是同一件事；
    //   3. 新的覆盖旧的：文字/时间用新的，权重取高的。
    const dup = this.findDuplicate({ who: name, qq: q, text: t, kind })
    if (dup) {
      dup.text = t
      dup.at = Date.now()
      dup.weight = Math.max(dup.weight || 3, Math.max(1, Math.min(5, weight)))
      if (kind && kind !== dup.kind) dup.kind = kind
      // 老条目这次带了号，顺手把身份补上（下次就能按 qq 找到了）
      if (q && !normalizeQq(dup.qq)) dup.qq = q
      if (name && !dup.who) dup.who = name
      this.mergedCount += 1
      this.save()
      return dup
    }
    const entry = {
      id: `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      kind,
      who: name,
      qq: q,
      text: t,
      weight: Math.max(1, Math.min(5, weight)),
      at: Date.now(),
    }
    this.entries.push(entry)
    this.prune()
    this.save()
    return entry
  }

  /**
   * 找「同一个人 + 同一件事」的老条目（找到就由调用方用新内容覆盖旧内容）。
   * @param {{who?: string, qq?: string, text?: string}} probe
   * @returns {object|null}
   */
  findDuplicate({ who = '', qq = '', text = '', kind = '' } = {}) {
    const q = normalizeQq(qq)
    const name = String(who || '').trim()
    const key = normalizeForDup(text)
    if (!key) return null
    let best = null
    let bestScore = 0
    for (const e of this.entries) {
      if (!sameIdentity({ who: name, qq: q }, e)) continue
      const exact = normalizeForDup(e.text) === key
      const score = exact ? 1 : similarity(e.text, text)
      if (score >= dupThreshold(kind, e.kind) && score > bestScore) {
        best = e
        bestScore = score
      }
    }
    return best
  }

  /**
   * 全量去重（迁移时跑一次；也留给控制台/工具手动跑）。
   * 规则与 add() 完全一致：同一个人 + 文本相似 → 只留一条，**新的覆盖旧的**。
   * @param {{threshold?: number}} [options]
   * @returns {{kept: number, removed: number}}
   */
  dedupeAll({ threshold = 0.7 } = {}) {
    const kept = []
    let removed = 0
    for (const e of this.entries) {
      const q = normalizeQq(e.qq)
      const key = normalizeForDup(e.text)
      if (!key) {
        kept.push(e)
        continue
      }
      let merged = false
      for (const k of kept) {
        if (!sameIdentity(e, k)) continue
        const exact = normalizeForDup(k.text) === key
        const score = exact ? 1 : similarity(k.text, e.text)
        const min = k.kind === 'sticker' || e.kind === 'sticker' ? 1 : threshold
        if (score < min) continue
        // 新的覆盖旧的：at 更大的算新
        const newer = e.at >= k.at ? e : k
        const older = newer === e ? k : e
        older.text = newer.text
        older.at = newer.at
        older.weight = Math.max(older.weight || 3, newer.weight || 3)
        if (newer.kind && newer.kind !== older.kind) older.kind = newer.kind
        if (normalizeQq(newer.qq) && !normalizeQq(older.qq)) older.qq = newer.qq
        if (newer.who && !older.who) older.who = newer.who
        removed += 1
        merged = true
        break
      }
      if (!merged) kept.push(e)
    }
    this.entries = kept
    return { kept: kept.length, removed }
  }

  /**
   * 给 /state 用的容量与加密状态。
   * 主人和挂件都要能一眼看到「现在多大 / 上限多少 / 加密没有 / 钥匙在哪」。
   */
  status() {
    return {
      count: this.entries.length,
      limit: this.limit,
      baseLimit: this.baseLimit,
      maxLimit: this.maxLimit,
      encrypted: Boolean(this.crypt),
      keyFile: this.crypt ? this.keyFile : '',
      keySource: this.crypt ? this.keySource : '',
      broken: this.broken,
      deduped: this.deduped,
      merged: this.mergedCount,
      migrated: this.migrated,
    }
  }

  /**
   * 按 id 改一条记忆（控制台 CRUD 用，2026-10-19）。
   *
   * 为什么必须走这个类、不能让控制台直接改盘上的 memory.json：
   * `entries` 是**内存数组**，插件下一次 `add()` 会拿内存里的旧数组整个覆写
   * 磁盘文件——控制台绕过内存的修改会被静默吞掉。所以所有写操作都从这里过，
   * 改完立刻 `save()`（它同时重写 memory.json 与 memory.md）。
   *
   * 语义：只改传进来的字段；`at` 保持不动（那是"记下的时间"，不是"改的时间"）。
   * `qq` 可改：格式合法性由路由层（web.js）先校验，这里只做规整，
   * 保证落盘的一定是 `''` 或 `/^[1-9]\d{4,11}$/`。
   * @param {string} id
   * @param {{kind?:string, who?:string, qq?:string, text?:string, weight?:number}} patch
   * @returns {object|null} 改完的 entry；id 不存在返回 null（路由层转 404）
   */
  update(id, patch = {}) {
    const target = String(id ?? '')
    const entry = this.entries.find((e) => e.id === target)
    if (!entry) return null
    if (patch.kind !== undefined) entry.kind = String(patch.kind)
    if (patch.who !== undefined) entry.who = String(patch.who ?? '').trim()
    if (patch.qq !== undefined) entry.qq = normalizeQq(patch.qq)
    if (patch.text !== undefined) entry.text = String(patch.text ?? '').trim()
    if (patch.weight !== undefined) {
      const w = Math.round(Number(patch.weight))
      entry.weight = Number.isFinite(w) ? Math.max(1, Math.min(5, w)) : entry.weight
    }
    if (!this.save()) return null
    return entry
  }

  /**
   * 按 id 删一条记忆。改完立刻落盘。
   * @returns {number} 删掉的条数（0 表示 id 不存在 → 路由层转 404）
   */
  remove(id) {
    const target = String(id ?? '')
    const idx = this.entries.findIndex((e) => e.id === target)
    if (idx < 0) return 0
    this.entries.splice(idx, 1)
    if (!this.save()) {
      // 落盘失败就把内存也回滚，避免"内存里没了、文件里还在"的鬼状态
      this.load()
      return 0
    }
    return 1
  }

  /**
   * 超量时才剪：先删低权重 + 旧的，保住高权重。
   *
   * 2026-10-23 主人 m00709 第 1 条：满了**别直接剪**，先自动扩容一次
   * （2000 → 10000，扩容状态写 memory-pool.json，重启不缩回）。
   * 换句话说：正常态是 2000，真记满了才升到 10000，升完之后才按老规则淘汰。
   */
  prune() {
    if (this.entries.length <= this.limit) return
    if (this.maxLimit > this.limit) {
      const before = this.limit
      this.limit = this.maxLimit
      this.writeGrownLimit()
      this.logger('info', `记忆池已满（${before} 条）→ 自动扩容到 ${this.limit} 条`)
      if (this.entries.length <= this.limit) return
    }
    this.entries.sort((a, b) => (b.weight - a.weight) || (b.at - a.at))
    this.entries = this.entries.slice(0, this.limit)
  }

  /**
   * 按人 + 关键词召回。
   *
   * 这里踩过一个坑：「猫」「咖啡」这种单字 query 原先是直接用
   * `q.split(/\s/).filter(w => w.length >= 2)` 取词的，单字全被过滤掉，
   * 词袋为空 → 关键词一分不计 → 排序退化成"权重最高的几条"，
   * 于是问"我家猫叫啥"会返回"记得吃药"。
   *
   * 现在改成两步：
   *   1. 分词：先按标点切块，中文块再按 2-gram 切成"子词"。
   *      这样「我家猫叫啥」→ [我家, 家猫, 猫叫, 叫啥, 猫, 啥]，单字也留一份。
   *   2. 打分：命中的词越长越值钱（3 字 3 分、2 字 2 分、单字 1 分），
   *      再乘一个 IDF 味道的系数——在所有记忆里都出现的词（如"主人"）不值钱，
   *      只在少数记忆里出现的词（"锅贴""香菜"）才值钱。
   *
   * 最后有相关性阈值：query 非空时，一分没命中的条目直接不返回。
   * 宁可"想不起来"也别答非所问——这正是用户最烦的那种失忆。
   */
  recall({ who = '', qq = '', query = '', limit = MEMORY_WINDOW.contextLimit } = {}) {
    const q = String(query || '').toLowerCase().trim()
    const words = tokenize(q)
    const qqStr = normalizeQq(qq)
    const name = String(who || '').trim()

    /*
     * 身份匹配（2026-10-19 用户需求：「who 是名字，qq 是唯一身份」）。
     *
     * 优先级：qq 完全匹配（+4）> 名字完全匹配（+2）> 名字互相包含（+1）。
     *
     * 两个细节：
     *   ① 给了 qq 时，**别的号但同名**的人不再吃名字加成——同名不同号是两个人，
     *      名字一样不代表是他，否则"小王"的记忆会串到另一个"小王"身上。
     *   ② 老条目（qq 为空）没有身份信息，给了 qq 时仍允许按名字认它——
     *      宁可让它留在候选里（可能就是这个人的历史记忆），也不要整条丢失。
     */
    const identity = (e) => {
      const eQq = normalizeQq(e.qq)
      const qqHit = Boolean(qqStr) && eQq === qqStr
      const differentPerson = Boolean(qqStr) && Boolean(eQq) && eQq !== qqStr
      const sameName = Boolean(name) && e.who === name && !differentPerson
      const nameContains =
        Boolean(name) &&
        !sameName &&
        !differentPerson &&
        Boolean(e.who) &&
        (e.who.includes(name) || name.includes(e.who))
      return { qqHit, sameName, nameContains, differentPerson }
    }

    // 词频统计，用来算 IDF
    const df = new Map()
    if (words.length) {
      for (const e of this.entries) {
        const t = e.text.toLowerCase()
        for (const w of words) {
          if (contains(t, w)) df.set(w, (df.get(w) || 0) + 1)
        }
      }
    }
    const N = Math.max(1, this.entries.length)
    const idf = (w) => {
      const d = df.get(w) || 0
      if (d === 0) return 0
      return Math.log(1 + N / d) // 越罕见的词越大
    }

    const scored = this.entries.map((e) => {
      const id = identity(e)
      let s = 0
      if (id.qqHit) s += 4 // 硬身份，比名字更值钱
      else if (id.sameName) s += 2 // 熟人优先，但不再压过相关性
      else if (id.nameContains) s += 1
      let hit = false
      let strongHit = false
      if (words.length) {
        const t = e.text.toLowerCase()
        for (const w of words) {
          if (!contains(t, w)) continue
          hit = true
          const base = w.length >= 3 ? 3 : w.length === 2 ? 2 : 1
          // 两字以上的词才算"真的命中了这个话题"，单字只做加成
          if (w.length >= 2) strongHit = true
          s += base * Math.max(0.15, idf(w))
        }
      }
      /*
       * 身份命中本身就等于"这条确实是这个人的"。
       *
       * 不把它算进 strongHit 的话，问「我喜欢什么」这种问题会因为关键词
       * 一个都对不上而被下面那层过滤整片丢掉——人明明有记忆，却被判成"想不起来"。
       */
      if (id.qqHit || id.sameName) strongHit = true
      s += (e.weight || 3) * 0.3
      // 越新越值钱，但只值一点点，避免"全是刚说的废话"
      const ageDays = (Date.now() - e.at) / 86400000
      s += Math.max(0, 2 - ageDays / 30) * 0.3
      return { e, s, hit, strongHit, id }
    })

    // query 非空时的取舍顺序：
    //   有"两字以上词"命中的条目 → 只要它们（相关性够硬）
    //   否则退一步，接受只有单字命中的 → 但此时必须是短 query（"猫"）
    //   都没有 → 空数组，宁可说想不起来，也不拿不相干的记忆凑数
    let pool
    if (!words.length) {
      pool = scored
    } else if (scored.some((x) => x.strongHit)) {
      pool = scored.filter((x) => x.strongHit)
    } else if (q.length <= 2) {
      pool = scored.filter((x) => x.hit)
    } else {
      pool = []
    }

    // 兜底：泛问召回。
    //
    // 「我喜欢什么」「我叫啥」「我生日是哪天」这类问句里**根本没有能命中记忆文本的词**
    // —— 记忆条目写的是「他养了一只猫叫团子」，问「我喜欢什么」时 2-gram 切出来
    // 一个词都不在文本里，于是上面直接返回空。可这正是最需要她记得住的时刻。
    //
    // 所以按意图分类兜底：认出问句意图后，直接回该人对应 kind 的高权重条目。
    // 只在 keyword 一分没命中时才启用，不干扰正常检索。
    if (pool.length === 0 && (name || qqStr) && q) {
      const kinds = intentKinds(q)
      if (kinds) {
        const fallback = this.entries
          .filter((e) => {
            const id = identity(e)
            return (id.qqHit || id.sameName || !e.who) && kinds.includes(e.kind)
          })
          .sort((a, b) => (b.weight - a.weight) || (b.at - a.at))
        if (fallback.length) {
          this.logger?.('debug', `泛问兜底召回：${q} → ${fallback.length} 条`)
          return fallback.slice(0, limit)
        }
      }
    }

    pool.sort((a, b) => b.s - a.s)
    return pool.slice(0, limit).map((x) => x.e)
  }

  /** 给模型看的记忆段落 */
  contextFor({ who = '', qq = '', query = '', limit = MEMORY_WINDOW.contextLimit } = {}) {
    const items = this.recall({ who, qq, query, limit })
    if (items.length === 0) return ''
    // 单条过长时截断（见 MEMORY_WINDOW.entryChars 的说明），避免一条长记忆挤掉别人
    const clip = (t) => {
      const s = String(t ?? '')
      return s.length > MEMORY_WINDOW.entryChars ? `${s.slice(0, MEMORY_WINDOW.entryChars - 1)}…` : s
    }
    const lines = items.map((e) => `- [${e.kind}]${e.who ? `（${e.who}）` : ''} ${clip(e.text)}`)
    return lines.join('\n')
  }

  renderMarkdown() {
    // who 只是显示名：同名不同号的人要分成两小节，否则 memory.md 里两家的记忆混在一块，
    // 人一眼看过去会以为记串了。只有一个人时保持老格式（不额外加 QQ，免得每行都变长）。
    const byWho = new Map()
    for (const e of this.entries) {
      const k = e.who || '_general'
      if (!byWho.has(k)) byWho.set(k, new Map())
      const byQq = byWho.get(k)
      const q = normalizeQq(e.qq)
      if (!byQq.has(q)) byQq.set(q, [])
      byQq.get(q).push(e)
    }
    const out = ['# 蓝色大肥鱼的记忆', '', `更新时间：${localDateTime()}`, '']
    for (const [who, byQq] of byWho) {
      const multi = [...byQq.keys()].filter(Boolean).length > 1
      for (const [q, list] of byQq) {
        const head = who === '_general' ? '杂项' : who
        out.push(multi ? `## ${head}${q ? `（QQ ${q}）` : '（无 QQ）'}` : `## ${head}`)
        for (const e of list.sort((a, b) => b.at - a.at)) {
          const d = localDateKey(new Date(e.at))
          out.push(`- ${d} [${e.kind}/w${e.weight}] ${e.text}`)
        }
        out.push('')
      }
    }
    return out.join('\n')
  }
}

/**
 * 泛问意图分类。返回该问题应该信任的 kind 列表，认不出来就返回 null。
 *
 * 存在的理由：关键词召回对「我喜欢什么」这种问题天然失效——记忆条目里
 * 压根没有"喜欢"两个字。可这类问题恰恰是用户检验"你到底记不记得我"的首选。
 */
function intentKinds(q) {
  const s = String(q || '')
  // 先摘掉问句外壳，只看实义部分
  if (/(喜欢|爱吃|爱喝|爱好|口味|讨厌|受不了|雷点|忌口)/.test(s)) {
    return ['preference', 'fact']
  }
  if (/(我是谁|我叫什么|我叫啥|我名字|我的名字|猜猜我是)/.test(s)) {
    return ['person']
  }
  if (/(生日|几岁|多大|年龄)/.test(s)) {
    return ['person', 'event']
  }
  if (/(答应|说好|约好|承诺|计划|打算)/.test(s)) {
    return ['promise', 'event']
  }
  // 「最近怎么样」必须带自我指代，否则「今天天气怎么样」也会被当成问自己的近况
  if (/((我|俺|咱).{0,4}(最近|怎么样|还好吗|忙什么|在干嘛|过得))|^(最近|最近在)/.test(s)) {
    return ['event', 'fact']
  }
  return null
}

/**
 * 检索词是否出现在文本中。
 *
 * 单字要额外小心：中文 2-gram 切词会切出「啡」「什」这种碎片，
 * 它们能在完全无关的句子里命中（"咖啡" 的 "啡" 命中 "睡午觉" 里的片段）。
 * 但也不能一刀切否掉单字——用户问"猫"时，"主人的猫叫锅贴" 必须命中。
 *
 * 折中：单字命中时要求它**前后至少有一侧是汉字**，也就是"这个字确实是
 * 某个词的一部分"，而不是被标点孤立的残渣。再配合 recall 里的规则
 * （有整词命中时只取整词），碎片噪声就被压住了。
 */
function contains(text, w) {
  if (!w) return false
  if (w.length >= 2) return text.includes(w)
  const hanNum = (c) => (c && /[\p{Script=Han}a-z0-9]/u.test(c) ? 1 : 0)
  let from = 0
  while (from <= text.length - 1) {
    const idx = text.indexOf(w, from)
    if (idx < 0) return false
    // 两侧至少一侧连着汉字 → 这个字在句子里是个真词的一部分
    if (hanNum(text[idx - 1]) + hanNum(text[idx + 1]) >= 1) return true
    from = idx + 1
  }
  return false
}

/**
 * 把一句话切成检索词。
 *
 * 中文没有空格，"我家猫叫啥" 直接 includes 匹配不到 "猫叫锅贴"。
 * 所以按 2-gram 切：先按标点分成若干块，每块再取连续两字 + 补充单字。
 * 「我家猫叫啥」→ [我家, 家猫, 猫叫, 叫啥] + [猫, 啥]
 * 一个字的块（"猫"）就只留单字。
 */
function tokenize(q) {
  if (!q) return []
  const out = new Set()
  // 停用词：句子里出现但跟记忆无关的高频虚词，留着重罚
  const stop = new Set(['什么', '怎么', '为什', '是不', '不是', '有没', '没有', '我的', '你的', '他叫', '她叫'])
  for (const chunk of q.split(/[^\p{Script=Han}a-z0-9]+/u)) {
    if (!chunk) continue
    if (/\p{Script=Han}/u.test(chunk)) {
      if (chunk.length === 1) out.add(chunk)
      else {
        for (let i = 0; i + 2 <= chunk.length; i++) {
          const g = chunk.slice(i, i + 2)
          if (!stop.has(g)) out.add(g)
        }
        // 三字以上的块再补一个整体，防止「锅贴」被切碎后漏掉
        if (chunk.length >= 3) out.add(chunk)
        // 单字也留：短词查询（"猫"）全靠它
        for (const ch of chunk) out.add(ch)
      }
    } else {
      out.add(chunk)
    }
  }
  return [...out].filter((w) => w.length >= 1)
}

/** 去重前先抹平"格式差异"：空白、标点、emoji、大小写都不该让同一句话变成两条 */
function normalizeForDup(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
}

/** 粗糙相似度：字符 trigram 重合率。够用来去重，不用上编辑距离。 */
function similarity(a, b) {
  const A = String(a || '')
  const B = String(b || '')
  if (!A || !B) return 0
  if (A === B) return 1
  const grams = (s) => {
    const set = new Set()
    for (let i = 0; i < s.length - 2; i++) set.add(s.slice(i, i + 3))
    if (s.length < 3) set.add(s)
    return set
  }
  const ga = grams(A)
  const gb = grams(B)
  let inter = 0
  for (const g of ga) if (gb.has(g)) inter++
  return inter / Math.max(ga.size, gb.size)
}

/**
 * 两条记忆是不是「同一个人」。
 *
 * 为什么单独抽出来：2026-10-23 主人要求「每一条记忆都去重，新的覆盖旧的」，
 * 而原来的判断只认「两条都有 qq 且相等」或「两条都有名字且相等」，
 * 两边都没有身份的条目（群里没登记的陌生人，who 为空、qq 为空）永远判「不是同一人」，
 * 于是 dedupeAll 在生产上一次只能合 0 条——主人听到的「去重没生效」就是这个。
 * 现在的规则：
 *   1) 两边都有 qq → 只认 qq；
 *   2) 否则两边都有名字 → 认名字；
 *   3) 只有一边有身份 → 不敢说同一人（名字对不上就不合）；
 *   4) 两边都没有身份 → 只能靠文本判重（和无名条目合并要保守，靠 similarity 阈值兜底）。
 */
function sameIdentity(a, b) {
  const aQq = normalizeQq(a?.qq)
  const bQq = normalizeQq(b?.qq)
  if (aQq && bQq) return aQq === bQq
  const aWho = String(a?.who ?? '').trim()
  const bWho = String(b?.who ?? '').trim()
  if (aWho && bWho) return aWho === bWho
  if (aQq || bQq || aWho || bWho) return false
  return true
}

/**
 * 去重阈值。
 * 表情包是「一张图一条」，名字差一个字就是另一张图（生产里 0.72 相似的两条其实是不同图），
 * 所以 sticker **只认去掉格式后完全一样**；其余语义文本给 0.70 的模糊阈值。
 */
function dupThreshold(kindA, kindB) {
  return kindA === 'sticker' || kindB === 'sticker' ? 1 : 0.7
}
