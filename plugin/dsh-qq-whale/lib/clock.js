/**
 * clock.js —— 「现在几点」（纯函数，零依赖）。
 *
 * 需求来源（2026-10-26，主人 m05189-1）：「给鱼加一个能看时间的插件功能，要求北京时间」。
 *
 * 为什么不用 `new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })`：
 *  - 宿主是 Windows，`Intl` 的时区数据依赖 ICU/系统时区库，换机器或精简 Node 构建
 *    下可能直接抛 RangeError，或者悄悄退回宿主本地时区（不是北京时间）。
 *  - 北京时间 = UTC+8，**没有夏令时**（1986–1991 之外都没有），用固定偏移算就够了，
 *    结果与机器时区无关，也方便单测钉死。
 *
 * 所以：一律 `nowMs + offsetMinutes * 60000` 之后用 `getUTC*()` 读字段。
 * 显示上明确写「北京时间（UTC+8）」，让她别把时区说错。
 */

/** 北京时间偏移（分钟）。UTC+8 = 480。 */
export const DEFAULT_OFFSET_MINUTES = 480

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const pad2 = (n) => String(n).padStart(2, '0')

/**
 * 把时间戳拆成「某个偏移下」的日历字段。
 * @param {number} [nowMs] 毫秒时间戳，默认现在
 * @param {number} [offsetMinutes] 相对 UTC 的偏移（分钟），默认北京时间
 */
export function clockParts(nowMs = Date.now(), offsetMinutes = DEFAULT_OFFSET_MINUTES) {
  const offset = Number.isFinite(Number(offsetMinutes)) ? Number(offsetMinutes) : DEFAULT_OFFSET_MINUTES
  const ms = Number.isFinite(Number(nowMs)) ? Number(nowMs) : Date.now()
  const d = new Date(ms + offset * 60000)
  const weekday = d.getUTCDay()
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    weekday,
    weekdayText: WEEKDAYS[weekday],
    offsetMinutes: offset,
    dateText: `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`,
    timeText: `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`,
  }
}

/** 时区名：480 → 「北京时间」，其它偏移 → 「UTC+8:00」这种。 */
export function zoneLabel(offsetMinutes = DEFAULT_OFFSET_MINUTES) {
  const offset = Number.isFinite(Number(offsetMinutes)) ? Number(offsetMinutes) : DEFAULT_OFFSET_MINUTES
  if (offset === DEFAULT_OFFSET_MINUTES) return '北京时间（UTC+8）'
  const sign = offset < 0 ? '-' : '+'
  const abs = Math.abs(offset)
  return `UTC${sign}${Math.floor(abs / 60)}:${pad2(abs % 60)}`
}

/** 「2026-10-26 周一 14:23」 */
export function clockText(nowMs = Date.now(), offsetMinutes = DEFAULT_OFFSET_MINUTES) {
  const p = clockParts(nowMs, offsetMinutes)
  return `${p.dateText} ${p.weekdayText} ${p.timeText}`
}

/** 「2026-10-26 周一」 */
export function dateText(nowMs = Date.now(), offsetMinutes = DEFAULT_OFFSET_MINUTES) {
  const p = clockParts(nowMs, offsetMinutes)
  return `${p.dateText} ${p.weekdayText}`
}

/**
 * 拼进 system prompt 的「现在时间」段。
 * 措辞要求：让她知道该按这个答，但也别主动报时。
 */
export function clockSection(nowMs = Date.now(), offsetMinutes = DEFAULT_OFFSET_MINUTES) {
  const text = clockText(nowMs, offsetMinutes)
  const zone = zoneLabel(offsetMinutes)
  return (
    `# 现在时间\n` +
    `现在是 ${text}（${zone}）。\n` +
    `- 有人问几点、今天几号、星期几，就按这个答，别猜，也别编「我看看表」这种动作。\n` +
    `- 「明天下午三点」「半小时后」这类相对时间，以这个为基准去算；跨天要换日期。\n` +
    `- 别主动报时，除非对方问、或者话题正好需要。`
  )
}

/**
 * 把 "HH:mm" 解析成当天分钟数；不合法返回 null。
 * 作息窗口（睡觉）用它，跨午夜由 inClockWindow 处理。
 */
export function parseHHMM(text) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? '').trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (!(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59)) return null
  return h * 60 + mi
}

/**
 * 当前时刻（clockParts 结果）是否落在 [start, end) 窗口里。跨午夜安全。
 * start === end 视为空窗（永不命中）。
 */
export function inClockWindow(parts, startText, endText) {
  const s = parseHHMM(startText)
  const e = parseHHMM(endText)
  if (s === null || e === null || s === e) return false
  const cur = Number(parts?.hour) * 60 + Number(parts?.minute)
  if (!Number.isFinite(cur)) return false
  if (s > e) return cur >= s || cur < e
  return cur >= s && cur < e
}

/**
 * 分钟的 HH:mm 文案（给提示词/接口回显用）。
 */
export function minutesText(minutes) {
  const n = Number(minutes)
  if (!Number.isFinite(n)) return ''
  const h = Math.floor(n / 60) % 24
  const mi = Math.floor(n % 60)
  return String(h).padStart(2, '0') + ':' + String(mi).padStart(2, '0')
}

export default { clockParts, clockText, dateText, clockSection, zoneLabel, parseHHMM, inClockWindow, minutesText, DEFAULT_OFFSET_MINUTES }
