/**
 * time-rules.js —— 「分时规则」：一套按星期 + 时段的规则，管三件事（睡觉 / 语音 / 唱歌）。
 * 零依赖纯逻辑 + 一个 JSON 文件读写，方便单测钉死。
 *
 * 需求来源（2026-11-08，主人 m06924）：
 *   「干脆唱歌允许时间也放到设置里面能调整吧…我们目前只有睡觉时间吧，
 *     你想一下我们这个怎么做，列给我完整计划我看看」
 *   主人随后拍板（m06974）：一条规则可以同时管多件事；生效日先按星期；
 *   旧配置（voiceQuietStart/End、singQuiet*、sleep-window.json）保留作只读兜底。
 *
 * 数据模型（<dataDir>/time-rules.json）：
 *   {
 *     "version": 1,
 *     "rules": [
 *       { "id": "r-ab12cd", "name": "晚上睡觉", "enabled": true,
 *         "scopes": ["sleep", "voice", "sing"],
 *         "start": "23:50", "end": "09:00",
 *         "days": [1,2,3,4,5,6,7],        // 1=周一 … 7=周日（ISO）
 *         "note": "" }
 *     ]
 *   }
 *
 * 三条关键语义（写下来免得以后自己踩）：
 *  1) **文件存在即权威**：只要 time-rules.json 存在且能解析，三个 scope 就完全由规则决定；
 *     某个 scope 一条规则都没有 = 这个 scope 不限制。文件不存在才回退旧配置。
 *  2) **跨午夜的星期按「开始那天」算**：规则 23:50→09:00、生效日只有周一，
 *     那么周一 23:50 到周二 09:00 都算命中；周二晚上不命中。
 *  3) **结束 = 开始 = 整天**（00:00→00:00 表示一整天；其它相同时也按整天处理，
 *     与旧 quietHit 的「等于就永不命中」不同，因为规则里写 09:00→09:00 更自然的
 *     意思是「一整天都在管」）。
 */

export const RULES_VERSION = 1

/** 三个 scope 的展示名，UI 与日志共用。 */
export const SCOPE_LABELS = {
  sleep: '睡觉',
  voice: '语音',
  sing: '唱歌',
}

export const ALL_SCOPES = ['sleep', 'voice', 'sing']

const WEEKDAY_LABELS = ['', '周一', '周二', '周三', '周四', '周五', '周六', '周日']

const pad2 = (n) => String(n).padStart(2, '0')

/** 「23:50」→ 1430；非法返回 null。 */
export function parseHHMM(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

/** 分钟数 → 「23:50」。 */
export function fmtHHMM(minutes) {
  const m = Math.max(0, Math.min(24 * 60, Math.round(Number(minutes) || 0)))
  if (m === 24 * 60) return '24:00'
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`
}

/** clockParts() 的 weekday（0=周日…6=周六）→ ISO 星期（1=周一…7=周日）。 */
export function isoWeekday(clockParts) {
  const w = Number(clockParts?.weekday)
  if (!Number.isFinite(w)) return 1
  return w === 0 ? 7 : w
}

export function weekdayText(iso) {
  return WEEKDAY_LABELS[Number(iso)] || ''
}

/** 随机短 id（够用，不为它引入依赖）。 */
export function newRuleId() {
  return 'r-' + Math.random().toString(36).slice(2, 8)
}

/**
 * 规范化一条规则。合法返回 { ok:true, rule }，否则 { ok:false, error }。
 * 这里做完整校验（API 层直接用它，避免「写进去跑不起来」）。
 */
export function normalizeRule(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '规则必须是对象' }
  }
  const name = String(raw.name ?? '').trim().slice(0, 24) || '未命名规则'
  const start = String(raw.start ?? '').trim()
  const end = String(raw.end ?? '').trim()
  if (parseHHMM(start) === null) return { ok: false, error: `「${name}」开始时间必须是 HH:mm` }
  if (parseHHMM(end) === null) return { ok: false, error: `「${name}」结束时间必须是 HH:mm` }

  let scopes = raw.scopes
  if (typeof scopes === 'string') scopes = [scopes]
  if (!Array.isArray(scopes)) return { ok: false, error: `「${name}」scopes 必须是数组` }
  scopes = [...new Set(scopes.map((s) => String(s ?? '').trim()).filter(Boolean))]
  const bad = scopes.filter((s) => !ALL_SCOPES.includes(s))
  if (bad.length) return { ok: false, error: `「${name}」有未知 scope：${bad.join(',')}` }
  if (!scopes.length) return { ok: false, error: `「${name}」至少要管一件事（睡觉/语音/唱歌）` }

  let days = raw.days
  if (days === undefined || days === null) days = [1, 2, 3, 4, 5, 6, 7]
  if (!Array.isArray(days)) return { ok: false, error: `「${name}」days 必须是数组` }
  days = [...new Set(days.map((d) => Number(d)))].filter((d) => Number.isInteger(d) && d >= 1 && d <= 7)
  days.sort((a, b) => a - b)
  if (!days.length) return { ok: false, error: `「${name}」至少要选一天生效` }

  const rule = {
    id: String(raw.id ?? '').trim() || newRuleId(),
    name,
    enabled: raw.enabled === undefined ? true : Boolean(raw.enabled),
    scopes,
    start,
    end,
    days,
    note: String(raw.note ?? '').slice(0, 120),
  }
  return { ok: true, rule }
}

/** 规范化整个文档（用于 POST 全量替换）。 */
export function normalizeDoc(raw) {
  const src = raw && typeof raw === 'object' && Array.isArray(raw.rules) ? raw.rules : null
  if (!src) return { ok: false, error: 'body.rules 必须是数组' }
  const rules = []
  const seen = new Set()
  for (const r of src) {
    const n = normalizeRule(r)
    if (!n.ok) return { ok: false, error: n.error }
    if (seen.has(n.rule.id)) n.rule.id = newRuleId()
    seen.add(n.rule.id)
    rules.push(n.rule)
  }
  return { ok: true, doc: { version: RULES_VERSION, rules } }
}

/**
 * 一条规则在某个时刻是否命中。
 * @param {object} rule 已规范化的规则
 * @param {{hour:number,minute:number,weekday:number}} parts clockParts 输出
 */
export function ruleHit(rule, parts) {
  if (!rule || rule.enabled === false) return false
  const s = parseHHMM(rule.start)
  const e = parseHHMM(rule.end)
  if (s === null || e === null) return false
  const days = Array.isArray(rule.days) && rule.days.length ? rule.days : [1, 2, 3, 4, 5, 6, 7]
  const cur = Number(parts?.hour) * 60 + Number(parts?.minute)
  if (!Number.isFinite(cur)) return false
  const today = isoWeekday(parts)

  const dayOk = (iso) => days.includes(iso)
  const prevDay = (iso) => (iso === 1 ? 7 : iso - 1)

  // 整天：开始 == 结束
  if (s === e) return dayOk(today)

  if (s < e) {
    // 同一天内：[s, e)
    if (cur < s || cur >= e) return false
    return dayOk(today)
  }

  // 跨午夜：[s, 24:00) 属于今天；[00:00, e) 属于「昨天开始」的那条
  if (cur >= s) return dayOk(today)
  if (cur < e) return dayOk(prevDay(today))
  return false
}

/** 某个 scope 在当前（或指定）时刻命中的规则列表。 */
export function hitRules(doc, scope, parts) {
  const rules = Array.isArray(doc?.rules) ? doc.rules : []
  return rules.filter((r) => Array.isArray(r.scopes) && r.scopes.includes(scope) && ruleHit(r, parts))
}

/** 三个 scope 一次性求值，给 /time/rules GET 与 /time/preview 用。 */
export function evalAll(doc, parts) {
  const out = { sleep: [], voice: [], sing: [] }
  for (const scope of ALL_SCOPES) {
    out[scope] = hitRules(doc, scope, parts).map((r) => ({ id: r.id, name: r.name, start: r.start, end: r.end }))
  }
  return out
}

/** 把规则压成一句人话，例如「晚上睡觉（睡觉、语音、唱歌 23:50–09:00）」。 */
export function describeRule(rule) {
  const scopes = (rule.scopes || []).map((s) => SCOPE_LABELS[s] || s).join('、')
  const days = Array.isArray(rule.days) && rule.days.length === 7
    ? '每天'
    : (rule.days || []).map(weekdayText).join('')
  return `${rule.name}（${scopes} ${rule.start}–${rule.end} ${days}）`
}
