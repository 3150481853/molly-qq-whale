/**
 * 关系记忆 —— 她跟每个人是怎么处的。
 *
 * 跟 memory.js 的区别很重要：
 *   memory.js 记的是**事实**（"主人不吃香菜"、"猫叫锅贴"），量大、可检索；
 *   这里记的是**关系状态**（亲密度、对每个人的印象、她自己的情绪残留），
 *   量小、按人一条、每轮都可能被微调。
 *
 * 为什么必须分开：如果把这些塞进事实库里，用关键词检索就会很别扭——
 * 你问"今天吃啥"，不该被"我对主人印象很好"这种条目挤占名额；
 * 反过来，每次聊天都要把"你俩关系怎么样"带上，但它又永远不该被
 * 当普通事实检索出来。两种东西的生命周期和作用完全不同。
 *
 * 设计原则：
 *   - **单调累积，不轻易清零**。关系是攒出来的，一次吵架不该抹掉三个月的默契。
 *   - **衰减但不清零**。久没联系会慢慢变淡（亲密度的"锈"），但有个地板。
 *   - **只记"我"视角**。写"主人喜欢被怼"，不写"主人是个喜欢被怼的人"——
 *     前者是她的观察，后者像在给人贴标签。
 */

import fs from 'node:fs'
import path from 'node:path'

import { localDateTime } from './budget.js'

/** 亲密度 0~100 的档位，只用来选称呼和腻歪程度 */
const BANDS = [
  { max: 15, label: '生人', tip: '客气但不热络，话说得短，不主动示好' },
  { max: 35, label: '认识', tip: '认得出来，愿意搭话，但不会撒娇' },
  { max: 55, label: '熟人', tip: '会开玩笑，会怼你，说话带点脾气' },
  { max: 75, label: '老朋友', tip: '很随意，会主动找你说事，会惦记你' },
  { max: 101, label: '自己人', tip: '没皮没脸的腻歪，该护短就护短，见面就撒欢' },
]

export class RelationStore {
  constructor({ dir, logger, dailyDecay = 0.35, floor = 8 }) {
    this.dir = dir
    this.logger = logger || (() => {})
    this.file = path.join(dir, 'relations.json')
    this.mdFile = path.join(dir, 'relations.md')
    /**
     * touch() 的落盘节流窗口。
     * 5 秒：群里再吵也不会写盘风暴；插件重载/崩溃最多丢最后 5 秒的聊天计数。
     */
    this.SAVE_THROTTLE_MS = 5000
    this._dirty = false
    this._lastSavedAt = 0
    // 每天没联系掉多少亲密度。0.35 意味着放着不管三个月也就掉 30 出头，
    // 不会把"老朋友"打成"生人"——真朋友是放不坏的，只是会想念。
    this.dailyDecay = dailyDecay
    // 地板：再怎么不理她，也不会真当陌生人
    this.floor = floor
    this.data = {}
    this.load()
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      this.data = parsed && typeof parsed === 'object' ? parsed.relations || {} : {}
    } catch (err) {
      if (err.code !== 'ENOENT') this.logger('warn', `relations.json 读取失败: ${err.message}`)
      this.data = {}
    }
  }

  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify({ version: 1, relations: this.data }, null, 2), 'utf8')
      fs.writeFileSync(this.mdFile, this.renderMarkdown(), 'utf8')
    } catch (err) {
      this.logger('error', `关系写入失败: ${err.message}`)
    }
  }

  /** 取一条，不存在就建。key 用 "private:QQ号" / "group:群号:QQ号" */
  get(key, who = '') {
    if (!this.data[key]) {
      this.data[key] = {
        key,
        who,
        closeness: 20, // 刚认识：算"认识"档，不是零——被加到白名单本身就有点交情
        impression: [],
        insideJokes: [],
        grievances: [],
        lastSeenAt: 0,
        lastDecayAt: Date.now(),
        talkCount: 0,
      }
    }
    return this.data[key]
  }

  /**
   * 每聊一次就累一点。
   * 加得很少（+0.4）：亲密度该是几百次对话攒出来的，不该聊两句就"自己人"。
   * 但有上限，且递减——越熟，每次加的越少，这才符合真实关系。
   */
  touch(key, who) {
    const r = this.get(key, who)
    if (who) r.who = who
    const now = Date.now()
    this.applyDecay(r, now)
    r.talkCount = (r.talkCount || 0) + 1
    // 递减曲线：20 档每次 +0.8，80 档每次 +0.15
    const gain = Math.max(0.15, 0.9 - r.closeness * 0.009)
    r.closeness = Math.min(100, r.closeness + gain)
    r.lastSeenAt = now
    /*
     * 必须落盘（用户 m17037 查出来的）。
     *
     * 之前这里只改内存不写盘，而带 save() 的只有 setImpression / addInsideJoke /
     * addGrievance 那几个"抽到印象/梗/生气"才走的路径。后果：
     *   正常聊天 → talkCount、lastSeenAt、closeness 全在内存 → 插件一重载就归零。
     * 表现就是"聊着聊着就忘了我"——她记不住跟你聊过多少次、有多熟。
     *
     * 但不能每条消息都同步写盘（QQ 群里高频，会拖慢回声）。
     * 用节流：距上次落盘超过 SAVE_THROTTLE_MS 才写一次，其余靠 dirty 标记，
     * 由 flush()（插件卸载时调）兜底。
     */
    if (now - (this._lastSavedAt || 0) > this.SAVE_THROTTLE_MS) {
      this.save()
      this._lastSavedAt = now
      this._dirty = false
    } else {
      this._dirty = true
    }
    return r
  }

  /**
   * 把攒着没写的改动落盘。插件卸载 / 进程退出前调。
   * 不调也不会丢太多（下次 touch 撞过节流窗口就写了），但优雅关闭时该调。
   */
  flush() {
    if (!this._dirty) return
    try {
      this.save()
      this._dirty = false
      this._lastSavedAt = Date.now()
    } catch (err) {
      this.logger('warn', `关系落盘失败：${err?.message || err}`)
    }
  }

  /** 亲密度随时间"生锈" */
  applyDecay(r, now = Date.now()) {
    const last = r.lastDecayAt || now
    const days = (now - last) / 86400000
    if (days < 1) return r
    r.closeness = Math.max(this.floor, r.closeness - days * this.dailyDecay)
    r.lastDecayAt = now
    return r
  }

  /**
   * 记一条印象。同类旧条目会被新的顶掉（印象是会变的），
   * 所以用 category 做槽位，而不是无限追加。
   */
  setImpression(key, { category = 'general', text = '', delta = 0 } = {}) {
    const t = String(text || '').trim()
    if (!t) return null
    const r = this.get(key)
    r.impression = (r.impression || []).filter((x) => x.category !== category)
    r.impression.push({ category, text: t, at: Date.now() })
    // 留最近 8 条
    if (r.impression.length > 8) r.impression = r.impression.slice(-8)
    if (Number.isFinite(delta) && delta !== 0) {
      r.closeness = Math.max(0, Math.min(100, r.closeness + delta))
    }
    this.save()
    return r
  }

  /** 你们的梗。这个必须留着——梗是关系里最像"活人"的东西 */
  addInsideJoke(key, text) {
    const t = String(text || '').trim()
    if (!t || t.length > 60) return
    const r = this.get(key)
    r.insideJokes = r.insideJokes || []
    if (r.insideJokes.some((j) => j.text === t)) return
    r.insideJokes.push({ text: t, at: Date.now() })
    if (r.insideJokes.length > 6) r.insideJokes = r.insideJokes.slice(-6)
    this.save()
  }

  /**
   * 记一笔"气"。她生过的气不该被忘掉——不然下次装没事会很假。
   * 但也要会消：被哄好了就清掉。
   */
  addGrievance(key, text, intensity = 1) {
    const t = String(text || '').trim()
    if (!t) return
    const r = this.get(key)
    r.grievances = r.grievances || []
    r.grievances.push({ text: t, intensity, at: Date.now() })
    if (r.grievances.length > 4) r.grievances = r.grievances.slice(-4)
    r.closeness = Math.max(0, r.closeness - 0.5 * intensity)
    this.save()
  }

  clearGrievances(key) {
    const r = this.get(key)
    r.grievances = []
    this.save()
  }

  band(closeness = 0) {
    const c = Number(closeness) || 0
    return BANDS.find((b) => c < b.max) || BANDS[BANDS.length - 1]
  }

  /** 给模型看的关系段落。没有记录时返回空串，别让 prompt 里出现空的"关系：" */
  contextFor(key) {
    const r = this.data[key]
    if (!r) return ''
    this.applyDecay(r)
    const b = this.band(r.closeness)
    const lines = []
    lines.push(`你和这个人的关系：${b.label}（亲密度 ${Math.round(r.closeness)}/100，聊过 ${r.talkCount || 0} 次）`)
    lines.push(`相处方式：${b.tip}`)
    if (r.impression?.length) {
      lines.push('你对他的印象：')
      for (const it of r.impression.slice(-5)) lines.push(`- ${it.text}`)
    }
    if (r.insideJokes?.length) {
      lines.push('你们之间的梗（可以自然地拿出来用，别硬塞）：')
      for (const j of r.insideJokes.slice(-4)) lines.push(`- ${j.text}`)
    }
    if (r.grievances?.length) {
      lines.push('你还记着的气（别装没事，但也别揪着不放）：')
      for (const g of r.grievances.slice(-3)) lines.push(`- ${g.text}`)
    }
    if (r.lastSeenAt) {
      const gapH = (Date.now() - r.lastSeenAt) / 3600000
      if (gapH > 24) lines.push(`距离上次说话已经过去 ${Math.floor(gapH / 24)} 天了。`)
      else if (gapH > 3) lines.push(`距离上次说话过去了 ${Math.round(gapH)} 个小时。`)
    }
    return lines.join('\n')
  }

  renderMarkdown() {
    const out = ['# 蓝色大肥鱼的关系簿', '', `更新时间：${localDateTime()}`, '']
    const list = Object.values(this.data).sort((a, b) => b.closeness - a.closeness)
    for (const r of list) {
      const b = this.band(r.closeness)
      out.push(`## ${r.who || r.key} — ${b.label}（${Math.round(r.closeness)}/100）`)
      if (r.lastSeenAt) out.push(`- 最后说话：${localDateTime(new Date(r.lastSeenAt))}`)
      for (const it of r.impression || []) out.push(`- 印象：${it.text}`)
      for (const j of r.insideJokes || []) out.push(`- 梗：${j.text}`)
      for (const g of r.grievances || []) out.push(`- 还在气：${g.text}`)
      out.push('')
    }
    return out.join('\n')
  }
}
