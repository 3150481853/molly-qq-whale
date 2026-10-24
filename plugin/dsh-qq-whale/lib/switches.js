/**
 * 发言开关（2026-10-22，用户 m03759 / m03849）。
 *
 * 目标：控制台能**实时**开关「私聊 / 群聊」里的各项发言能力，改完立刻生效、
 * 不重载插件、重启后保持。原先这些能力散在配置里（tapEmoji、noLikeGroups、
 * stickerLightReaction…），改一次要重启；这里统一成一份运行时状态。
 *
 * 能力（capability）共五项：
 *   reply     正常回复
 *   sticker   表情包（回复里的图 + 撒图）
 *   light     不开口时的轻回应（甩一张图）
 *   like      点个表情赞（QQ 的「回应」）
 *   proactive 主动搭话（定时找人聊天）
 *
 * 解析优先级（get 的顺序）：
 *   1. master=false  → 全关（**包括 @ / 叫名字**，用户第 3 条：总开关=全静默）
 *   2. temporaryMutes → 命中 scope 则关（@/叫名字可穿透，见 penetrate()）
 *   3. groups[gid]    → 群级覆盖（用户第 3 条：每个群独立）
 *   4. group / private → 场景默认
 *   5. 兜底 true（行为与上线前一致）
 *
 * 审计：最近 20 条留在内存 + 追加写 out/switches-audit.log，含操作人/来源 IP。
 */

import fs from 'node:fs'
import path from 'node:path'

export const CAPABILITIES = ['reply', 'sticker', 'light', 'like', 'proactive', 'voice']
export const CAPABILITY_LABEL = {
  reply: '回复',
  sticker: '表情包',
  light: '轻回应',
  like: '点赞',
  proactive: '主动搭话',
  voice: '语音',
}

const DEFAULT_CAPABILITIES = () => ({
  reply: true,
  sticker: true,
  light: true,
  like: true,
  proactive: true,
  // 语音（2026-10-22 用户 m04697/m04855 要求）：开着才可能把某条回复换成一条语音；
  // 关掉后退回纯文字，不影响其它几项。
  voice: true,
})

/** 一份「全开」的默认状态。 */
export function defaultSwitches() {
  return {
    version: 1,
    master: true,
    private: DEFAULT_CAPABILITIES(),
    group: DEFAULT_CAPABILITIES(),
    groups: {},
    contentFilter: { enabled: true, mode: 'shorten', maxChars: 180 },
    temporaryMutes: [],
    updatedAt: Date.now(),
  }
}

const SCOPES = new Set(['private'])

function scopeKey(scene, gid) {
  if (scene === 'private') return 'private'
  return gid ? `group:${gid}` : 'group'
}

/**
 * 把控制台/接口传进来的 scope 归一成 scopeKey 的写法。
 * 用户在页面上按提示填的是裸群号（例如 666666666），早期 addMute 原样存了裸号，
 * 而 activeMute 找的是 group:<gid>，两边对不上 —— 静音显示已加、实际没拦住（用户 m04474 报障）。
 */
function normalizeScope(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (/^\d+$/.test(s)) return `group:${s}`
  if (s === 'private') return 'private'
  if (s === 'group') return 'group'
  if (/^group:\d+$/.test(s)) return s
  return ''
}

function cleanCaps(obj, base = {}) {
  const out = { ...base }
  if (!obj || typeof obj !== 'object') return out
  for (const k of CAPABILITIES) {
    if (typeof obj[k] === 'boolean') out[k] = obj[k]
  }
  return out
}

/** 代码/日志长文的特征行。命中 ≥2 条，或长度超限，就认为「不适合发群里」。 */
const CODE_LOG_PATTERNS = [
  /\b(ERROR|WARN|FATAL|Traceback|TypeError|SyntaxError)\b/,
  /\b(revision|rev|sha256|commit|fallback)\b\s*[:=]/i,
  /\b[\w.-]+\.(md|js|mjs|ts|json|py|log|yml|yaml|ps1|bat)\b/,
  /\b[A-Za-z_]+=(\S+)/, // NAME=value 形式的配置行
  /^\s*(at\s+\S+\s+\(|\[[0-9]{2}:[0-9]{2}:[0-9]{2}\])/, // 堆栈 / 日志前缀
  /```/,
  /=>\s*\{/,
  /;\s*$/m,
]

/**
 * 命中代码/日志特征的行数。
 *
 * 2026-10-24 抽出来：群发豁免（lib/group-echo.js）放行「明确要求发群里」的长文时，
 * 长度可以放宽，但**真代码/日志仍然不该贴到群里**——那条安全线不能跟着放宽。
 */
export function countCodeLogLines(text) {
  const lines = String(text || '').split(/\r?\n/)
  let hits = 0
  for (const line of lines) {
    if (CODE_LOG_PATTERNS.some((re) => re.test(line))) hits++
  }
  return hits
}

/** 这段文本是不是「代码/日志味」重到不该发群（默认 ≥2 行特征）。 */
export function looksLikeCodeOrLog(text, minHits = 2) {
  return countCodeLogLines(text) >= minHits
}

/**
 * 群聊内容过滤（用户 m03846：群里别发代码/日志长文）。
 *
 * @param {string} text 模型生成的一条文本
 * @param {{enabled?:boolean, mode?:'shorten'|'drop', maxChars?:number}} cfg
 * @returns {{text:string, changed:boolean, dropped:boolean, reason:string}}
 */
export function sanitizeGroupText(text, cfg = {}) {
  const raw = String(text || '')
  const enabled = cfg.enabled !== false
  const maxChars = Math.max(60, Number(cfg.maxChars) || 180)
  const mode = cfg.mode === 'drop' ? 'drop' : 'shorten'
  if (!enabled || !raw) return { text: raw, changed: false, dropped: false, reason: '' }

  const hits = countCodeLogLines(raw)
  const tooLong = raw.length > maxChars
  if (hits < 2 && !tooLong) return { text: raw, changed: false, dropped: false, reason: '' }

  if (mode === 'drop') {
    return { text: '', changed: true, dropped: true, reason: `代码/日志特征 ${hits} 行，长度 ${raw.length}` }
  }

  // 缩短：取前一两句，压到 maxChars 以内，再补一句「细节私聊」。
  const sentences = raw
    .replace(/```[\s\S]*?```/g, '')
    .split(/(?<=[。！？!?~～])|\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
  let head = sentences[0] || raw.slice(0, 60)
  if (sentences[1] && head.length + sentences[1].length < maxChars - 20) head += sentences[1]
  const suffix = '（细节不在这儿刷了，要的话我私聊你）'
  const keep = Math.max(20, maxChars - suffix.length)
  if (head.length > keep) head = head.slice(0, keep) + '…'
  return {
    text: head + suffix,
    changed: true,
    dropped: false,
    reason: `代码/日志特征 ${hits} 行，长度 ${raw.length}`,
  }
}

/** 把 a.b.c 路径写进对象；只允许已存在的键名（防手滑写脏数据）。 */
function setByPath(obj, parts, value) {
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i]
    if (cur == null || typeof cur !== 'object') return false
    // groups.<gid> 这种动态键：不存在就建
    if (cur[k] == null) {
      if (i === 0 && k === 'groups') cur[k] = {}
      else return false
    }
    cur = cur[k]
  }
  const last = parts[parts.length - 1]
  if (cur == null || typeof cur !== 'object') return false
  cur[last] = value
  return true
}

export class SwitchBoard {
  /**
   * @param {object} opts
   * @param {string} opts.file        switches.json 路径
   * @param {string} [opts.auditFile] 审计日志路径
   * @param {object} [opts.logger]
   * @param {string[]} [opts.noLikeGroups] 兼容旧配置：这些群默认 like=false
   */
  constructor({ file, auditFile, logger, noLikeGroups = [] }) {
    this.file = file || path.join(process.cwd(), 'switches.json')
    this.auditFile = auditFile || path.join(path.dirname(this.file), 'switches-audit.log')
    this.logger = logger || (() => {})
    this.audit = []
    this.state = defaultSwitches()
    // 旧配置迁移：noLikeGroups 里的群 → groups[gid].like=false
    for (const gid of noLikeGroups || []) {
      const k = String(gid)
      if (!k) continue
      this.state.groups[k] = { ...(this.state.groups[k] || DEFAULT_CAPABILITIES()), like: false }
    }
    this.load()
  }

  load() {
    try {
      if (!fs.existsSync(this.file)) {
        this.save()
        return
      }
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      const d = defaultSwitches()
      const next = {
        ...d,
        ...raw,
        master: typeof raw.master === 'boolean' ? raw.master : true,
        private: cleanCaps(raw.private, d.private),
        group: cleanCaps(raw.group, d.group),
        groups: {},
        contentFilter: {
          enabled: raw?.contentFilter?.enabled !== false,
          mode: raw?.contentFilter?.mode === 'drop' ? 'drop' : 'shorten',
          maxChars: Math.max(60, Number(raw?.contentFilter?.maxChars) || 180),
        },
        temporaryMutes: Array.isArray(raw.temporaryMutes)
          ? raw.temporaryMutes
              .filter((m) => m && typeof m.scope === 'string' && Number(m.until) > 0)
              .map((m) => ({
                scope: normalizeScope(m.scope) || m.scope,
                until: Number(m.until),
                note: String(m.note || ''),
              }))
              .filter((m) => m.scope)
          : [],
        audit: undefined,
      }
      for (const [gid, caps] of Object.entries(raw.groups || {})) {
        if (!/^\d+$/.test(gid)) continue
        next.groups[gid] = cleanCaps(caps, d.group)
      }
      this.state = next
      this.pruneMutes()
    } catch (err) {
      this.logger('warn', `读 switches.json 失败，先用默认值：${err?.message || err}`)
      this.state = defaultSwitches()
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      this.state.updatedAt = Date.now()
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2))
      return true
    } catch (err) {
      this.logger('warn', `写 switches.json 失败：${err?.message || err}`)
      return false
    }
  }

  pruneMutes(nowMs = Date.now()) {
    const before = this.state.temporaryMutes.length
    this.state.temporaryMutes = this.state.temporaryMutes.filter((m) => Number(m.until) > nowMs / 1000)
    return before !== this.state.temporaryMutes.length
  }

  /** 当前生效的临时静音（没有则 null）。 */
  activeMute(scene, gid) {
    this.pruneMutes()
    const keys = new Set([scopeKey(scene, gid)])
    if (scene !== 'private' && gid) keys.add('group')
    for (const m of this.state.temporaryMutes) {
      if (keys.has(m.scope)) return m
    }
    return null
  }

  /**
   * 某项能力在当前场景/群是否允许。
   * @param {string} capability reply|sticker|light|like|proactive
   * @param {{scene:string, gid?:string}} ctx
   */
  allow(capability, { scene, gid } = {}) {
    if (!CAPABILITIES.includes(capability)) return true
    if (this.state.master === false) return false
    if (this.activeMute(scene, gid)) return false
    const g = scene === 'private' ? null : gid ? String(gid) : null
    if (g && this.state.groups[g] && typeof this.state.groups[g][capability] === 'boolean') {
      return this.state.groups[g][capability]
    }
    const scope = scene === 'private' ? this.state.private : this.state.group
    return scope[capability] !== false
  }

  /**
   * 「回复」能力的完整判定：能不能回、要不要穿透、穿透时用什么前缀。
   *
   * 用户第 2 条：@ / 叫名字允许穿透群静音，但回复要带状态前缀。
   * 用户第 3 条：master=false 时连 @ 也不回。
   */
  replyDecision({ scene, gid, mention = false }) {
    const meta = { scene, gid }
    const allowed = this.allow('reply', meta)
    if (allowed) return { allowed: true, penetrate: false, reason: '', prefix: '' }
    if (this.state.master === false) return { allowed: false, penetrate: false, reason: '总开关已关闭', prefix: '' }
    const mute = this.activeMute(scene, gid)
    if (!mention) {
      return { allowed: false, penetrate: false, reason: mute ? `临时静音（到 ${new Date(mute.until * 1000).toLocaleString('sv-SE')}）` : '回复开关已关闭', prefix: '' }
    }
    const prefix = mute
      ? '我在静音呢，不过你都点我名了。'
      : '本来没打算说话的，但你都叫我了。'
    return { allowed: false, penetrate: true, reason: mute ? '临时静音+点名穿透' : '回复关闭+点名穿透', prefix }
  }

  /** 群聊内容过滤配置（engine.deliver 用；用户 m03846）。 */
  contentFilterCfg() {
    return this.state.contentFilter || { enabled: true, mode: 'shorten', maxChars: 180 }
  }

  /**
   * 改一个开关，例如 ('group.like', false) / ('groups.666666666.reply', false)。
   * @returns {{ok:boolean, error?:string, oldValue?:any, value?:any}}
   */
  set(pathStr, value, { actor = '', ip = '' } = {}) {
    const parts = String(pathStr || '').split('.').filter(Boolean)
    if (parts.length === 0) return { ok: false, error: 'path 不能为空' }
    if (parts[0] === 'master') {
      const oldValue = this.state.master
      this.state.master = Boolean(value)
      this.save()
      this.pushAudit({ actor, ip, path: 'master', oldValue, value: this.state.master })
      return { ok: true, oldValue, value: this.state.master }
    }
    if (parts[0] === 'contentFilter') {
      const key = parts[1]
      if (!['enabled', 'mode', 'maxChars'].includes(key)) return { ok: false, error: `不认识的过滤字段 ${key}` }
      const oldValue = this.state.contentFilter[key]
      const v =
        key === 'enabled'
          ? Boolean(value)
          : key === 'mode'
            ? (value === 'drop' ? 'drop' : 'shorten')
            : Math.max(60, Math.min(2000, Number(value) || 180))
      this.state.contentFilter[key] = v
      this.save()
      this.pushAudit({ actor, ip, path: pathStr, oldValue, value: v })
      return { ok: true, oldValue, value: v }
    }
    if (parts[0] === 'groups' && parts.length === 3) {
      const gid = parts[1]
      const cap = parts[2]
      if (!/^\d+$/.test(gid)) return { ok: false, error: '群号不合法' }
      if (!CAPABILITIES.includes(cap)) return { ok: false, error: `不认识的能力 ${cap}` }
      if (!this.state.groups[gid]) this.state.groups[gid] = { ...DEFAULT_CAPABILITIES() }
      const oldValue = this.state.groups[gid][cap]
      this.state.groups[gid][cap] = Boolean(value)
      this.save()
      this.pushAudit({ actor, ip, path: pathStr, oldValue, value: Boolean(value) })
      return { ok: true, oldValue, value: Boolean(value) }
    }
    if ((parts[0] === 'private' || parts[0] === 'group') && parts.length === 2) {
      const cap = parts[1]
      if (!CAPABILITIES.includes(cap)) return { ok: false, error: `不认识的能力 ${cap}` }
      const oldValue = this.state[parts[0]][cap]
      this.state[parts[0]][cap] = Boolean(value)
      this.save()
      this.pushAudit({ actor, ip, path: pathStr, oldValue, value: Boolean(value) })
      return { ok: true, oldValue, value: Boolean(value) }
    }
    return { ok: false, error: `不支持直接修改 ${pathStr}（群级请用 groups.<gid>.<capability>）` }
  }

  /**
   * 整组清掉某个群的覆盖（控制台「清除该群覆盖」用）。
   * set() 只支持三段的 groups.<gid>.<cap>，删除整组走这里。
   */
  removeGroup(gid, { actor = '', ip = '' } = {}) {
    const g = String(gid || '')
    if (!/^\d+$/.test(g)) return { ok: false, error: '群号不合法' }
    if (!this.state.groups || !this.state.groups[g]) return { ok: false, error: '这个群没有覆盖' }
    const oldValue = this.state.groups[g]
    delete this.state.groups[g]
    this.save()
    this.pushAudit({ actor, ip, path: `groups.${g}`, oldValue, value: null })
    return { ok: true, group: g }
  }

  /**
   * 加临时静音；scope 接受 `private` / 裸群号 / `group` / `group:<gid>`（都会归一成 scopeKey 写法）。
   */
  addMute(scope, minutes = 30, note = '') {
    const key = normalizeScope(scope)
    if (!key) throw new Error('scope 要填 private、群号或 group:<群号>')
    const until = Date.now() / 1000 + Math.max(1, Number(minutes) || 30) * 60
    this.state.temporaryMutes = this.state.temporaryMutes
      .filter((m) => m.scope !== key)
    this.state.temporaryMutes.push({ scope: key, until, note: String(note || '') })
    this.save()
    this.pushAudit({ path: `mute.${key}`, oldValue: null, value: new Date(until * 1000).toLocaleString('sv-SE'), note: '临时静音' })
    return { ok: true, scope: key, until }
  }

  removeMute(scope) {
    const key = normalizeScope(scope)
    if (!key) return { ok: false, error: 'scope 要填 private、群号或 group:<群号>' }
    const before = this.state.temporaryMutes.length
    this.state.temporaryMutes = this.state.temporaryMutes.filter((m) => m.scope !== key)
    if (before === this.state.temporaryMutes.length) return { ok: false, error: '没有这条静音' }
    this.save()
    this.pushAudit({ path: `unmute.${key}`, oldValue: before, value: Math.max(0, before - 1) })
    return { ok: true, scope: key }
  }

  reset() {
    const old = this.state
    this.state = defaultSwitches()
    this.save()
    this.pushAudit({ path: 'reset', oldValue: 'custom', value: 'default' })
    return { ok: true, switches: this.snapshot(), oldMaster: old.master }
  }

  pushAudit(entry) {
    const item = {
      at: new Date().toISOString(),
      actor: entry.actor || '',
      ip: entry.ip || '',
      path: entry.path || '',
      oldValue: entry.oldValue,
      value: entry.value,
      note: entry.note || '',
    }
    this.audit.push(item)
    if (this.audit.length > 20) this.audit.splice(0, this.audit.length - 20)
    try {
      fs.appendFileSync(this.auditFile, JSON.stringify(item) + '\n')
    } catch {
      /* 审计写盘失败不影响开关 */
    }
  }

  snapshot() {
    this.pruneMutes()
    return JSON.parse(JSON.stringify(this.state))
  }

  /** 给控制台的一次性视图：状态 + 当前解析结果 + 审计 + 静音。 */
  view({ gid = null } = {}) {
    const sw = this.snapshot()
    const eff = {}
    for (const cap of CAPABILITIES) {
      eff[cap] = this.allow(cap, { scene: gid ? 'group' : 'group', gid })
    }
    return {
      switches: sw,
      audit: this.audit.slice(-20),
      mutes: sw.temporaryMutes,
      effectiveGroup: eff,
      file: this.file,
    }
  }
}

export default SwitchBoard
