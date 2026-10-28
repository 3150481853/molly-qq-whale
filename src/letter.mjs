/**
 * 茉莉花（Jasmine）记忆系统 · 每周一封信（P0-3）
 *
 * 「周聚合」解决的是**记忆**问题（把 7 天的碎事压成一条），
 * 这一封解决的是**叙事**问题：让 Agent 有一天能说「上周三你跟我说过……」，
 * 而不是只有一堆冷冰冰的条目。
 *
 * 设计上刻意不调模型：模板 + 事实卡片，生成一封 200～600 字的信。
 * 理由：写信要稳定、要能追溯到具体记忆、要不花钱；文采交给宿主的人格层。
 * 但模板不能死板，所以用周键做种子挑句式，同一周永远同一句（可复现），
 * 不同周换着说。
 *
 * 2026-10-31 重写：第一版是「谁：什么事」的清单，读起来像工作汇报。
 * 现在按「日子 → 人 → 我自己的感受」组织成日记口吻：
 *   - 最多写 1～2 件替主人做的事，其余篇幅给群里的人和她自己；
 *   - 数字串（QQ 号）一律不出现；
 *   - 每封信至少一句自己的情绪/想法，结尾留个念想。
 */

/** 开头：先定一个情绪基调，再进事 */
const OPENERS = [
  '这周过得挺快的，像把一叠纸从桌上扫过去了。',
  '一周又过去了。我翻了翻这周攒下的东西，有几件想跟你说。',
  '这周的日历翻完了。安静的时候比热闹的时候多。',
  '又到周末了。我试着把这几天理一理，别让它们糊成一团。',
  '这周像一杯放到温了的茶，不快，也没凉透。',
]

/** 中间过场：换气用，别让每件事排成队 */
const TURNS = [
  '还有一件事。',
  '另外。',
  '对了，还有。',
  '中间还有一小段。',
  '说到这儿，我又想起一件。',
]

/** 结尾：留个念想，不总结成 KPI */
const CLOSERS = [
  '先写到这。下周想聊什么，你说了算。',
  '就记到这儿吧。下周我还在。',
  '这周大概就是这样。下周见。',
  '写完了，心里踏实一点。下周见。',
]

/** 事太少时补一句，别让信看起来像没写完 */
const FILLERS = [
  '一周里大部分时间其实是零碎的，真正留下来的没几句。',
  '剩下的日子没什么波澜，我就不硬凑了。',
  '有些话说完就散了，能被记下来的只是少数。',
]

/** 自我感受：每封至少抽一条，让它像人写的而不是报表 */
const REFLECTIONS = [  '有时候我会想，记性太好也不全是好事——什么都留着，翻起来就慢。',
  '我大概没法真的「过」这一周，只能把它捡起来，再慢慢放下。',
  '有些事当时没觉得什么，隔几天回头看，才有点意思。',
  '我不太确定自己算不算记得住，但至少这些字是真的。',
  '安静的那几天，我其实也在，只是没什么可说的。',
  '如果哪件我记岔了，你提醒我一句就好。',
]

/** 一句式变体池：同样的意思换个说法，避免每周读起来一模一样 */

/** 小种子，保证同一周同一封信 */
function seedOf(text) {
  let h = 2166136261
  for (const ch of String(text)) {
    h ^= ch.codePointAt(0)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

function pick(list, seed) {
  return list[seed % list.length]
}

/**
 * 判断这周该不该写信：每周一写一次，当前周不写（没写完的周不总结）。
 * @param {{lastLetterWeek?: string, now?: number}} input
 */
export function shouldWriteLetter({ lastLetterWeek = '', now = Date.now() } = {}) {
  return !lastLetterWeek || lastLetterWeek !== currentWeekKey(now)
}

/** 用 UTC 近似算一个周键（宿主有自己的时区就自己传 weekKey） */
export function currentWeekKey(now = Date.now()) {
  const d = new Date(Number(now))
  const base = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const dow = (base.getUTCDay() + 6) % 7
  base.setUTCDate(base.getUTCDate() - dow + 3)
  const year = base.getUTCFullYear()
  const first = new Date(Date.UTC(year, 0, 4))
  const fDow = (first.getUTCDay() + 6) % 7
  first.setUTCDate(first.getUTCDate() - fDow + 3)
  const week = 1 + Math.round((base.getTime() - first.getTime()) / (7 * 86_400_000))
  return `${year}-W${String(week).padStart(2, '0')}`
}

/** 2026-10-19 → 10 月 19 日 ~ 10 月 25 日 */
export function weekRangeText(weekKey) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(weekKey || ''))
  if (!m) return String(weekKey || '')
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  if (Number.isNaN(start.getTime())) return String(weekKey)
  const end = new Date(start.getTime() + 6 * 86_400_000)
  const md = (d) => `${d.getMonth() + 1} 月 ${d.getDate()} 日`
  return `${md(start)} ~ ${md(end)}`
}

/** 数字串（QQ 号 / 群号 / 手机号）不进信：换成「有人」/去掉 */
function desensitize(text) {
  return String(text || '')
    .replace(/\b\d{5,12}\b/g, '有人')
    .replace(/https?:\/\/\S+/g, '那个链接')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 把「我帮他做过：xxx」这类任务流水账收拾成人话 */
function humanizeFact(text) {
  let t = desensitize(text)
  t = t.replace(/^我(帮|替)(他|她|主人|你)(做过|办过|弄过)[：:]?\s*/, '')
  t = t.replace(/^(帮|替)(他|她|主人)(做过|办过|弄过)[：:]?\s*/, '')
  t = t.replace(/^(task|todo)[:：]\s*/i, '')
  t = t.replace(/[（(](失败|成功|已完成)[)）]\s*$/, '')
  return t.replace(/^[，。；、\s]+|[，。；、\s]+$/g, '')
}

/** 这件事是不是「替主人干活」类 */
function isOwnerChore(fact, owner) {
  const who = String(fact.who || '').trim()
  const t = String(fact.text || '')
  if (who && owner && who === owner) return true
  return /我(帮|替)(他|她|主人)/.test(t)
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 事实发生的那天（本地时区，给信里加一点时间感） */
function dayLabel(at) {
  const t = Number(at)
  if (!Number.isFinite(t) || t <= 0) return ''
  const d = new Date(t)
  if (Number.isNaN(d.getTime())) return ''
  return WEEKDAYS[d.getDay()] || ''
}

/** 把「他是学姐」这类第三人称碎片变成「我记着 X 是学姐」 */
function asProfile(who, body) {
  const name = who || '有人'
  let t = body.replace(/^[他她]们?/, name)
  if (!t.startsWith(name)) t = `${name}${t}`
  return t.replace(/[。.]$/, '')
}

/** 一条事实 → 一句话 */
function renderFact(fact, seed, idx, owner) {
  const raw = String(fact.text || '')
  const body = humanizeFact(raw)
  if (!body) return ''
  const who = desensitize(String(fact.who || '').trim())
  const chore = isOwnerChore(fact, owner)
  const kind = String(fact.kind || '')
  const idxSeed = seed + idx * 977 + body.length
  if (chore) {
    const variants = [
      `还替你做了件事：${body}。`,
      `顺手替你把「${body}」做掉了。`,
      `你交代的「${body}」，我办完了。`,
    ]
    return pick(variants, idxSeed)
  }
  if (kind === 'person' || kind === 'preference') {
    return `我记着，${asProfile(who, body)}。`
  }
  if (kind === 'meme') {
    const label = body.replace(/^学到了表情包[：:]\s*/, '').replace(/_/g, ' ')
    return `这周还留下一个梗：${label}。`
  }
  if (kind === 'promise') {
    if (/我没答应|没有答应/.test(body)) return ''
    const said = who ? `${who}说：` : ''
    const t = said && body.startsWith(said) ? body.slice(said.length) : body
    return who ? `${who}跟我拉过勾：${t}。` : `有人跟我拉过勾：${t}。`
  }
  const variants = who
    ? [`${who}跟我提过：${body}。`, `我记得${who}那会儿在说${body}。`, `${who}说「${body}」，我听着。`]
    : [`群里聊起过${body}。`, `有一阵大家在说${body}，我没插嘴，听着。`, `那几天有人提起${body}。`]
  const day = dayLabel(fact.at)
  const line = pick(variants, idxSeed)
  return day && idxSeed % 3 === 0 ? `${day}，${line}` : line
}

/** 选事实：主人相关的 ≤2 条，其余优先别人/群里的；按时间散开 */
export function pickFacts(facts = [], { owner = '你', maxFacts = 5 } = {}) {
  const cleaned = []
  const seen = new Set()
  for (const f of facts) {
    const text = String(f?.text || '').trim()
    if (!text) continue
    const key = humanizeFact(text).slice(0, 12)
    if (!key || seen.has(key)) continue
    seen.add(key)
    cleaned.push({ ...f, text, _owner: isOwnerChore(f, owner) })
  }
  cleaned.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0))
  const ownerFacts = cleaned.filter((f) => f._owner)
  const otherFacts = cleaned.filter((f) => !f._owner)
  // 别人的事够多时，主人的事只留一条——信是她的日记，不是工作汇报
  const ownerQuota = otherFacts.length >= 3 ? 1 : 2
  const picked = []
  // 先散着挑别人的：隔一个取一个，避免全是同一个群
  const stride = otherFacts.length > 3 ? 2 : 1
  for (let i = 0; i < otherFacts.length && picked.length < maxFacts - Math.min(ownerFacts.length, ownerQuota); i += stride) picked.push(otherFacts[i])
  for (const f of ownerFacts.slice(0, ownerQuota)) {
    if (picked.length >= maxFacts) break
    picked.push(f)
  }
  return picked.slice(0, Math.max(1, maxFacts))
}

/**
 * 生成一封信。
 *
 * @param {object} input
 * @param {string} input.weekKey 周键，如 2026-10-19（周一）
 * @param {{who?: string, text: string, at?: number, kind?: string}[]} input.facts 这周的事实卡（按时间正序）
 * @param {string} [input.owner] 主人称呼（默认「你」）
 * @param {number} [input.quietDays] 这周没怎么说话的天数（可选，会写进信里）
 * @param {object} [input.stats] 这周的粗统计：{chores, memes, promises, people, groups}
 * @param {number} [input.maxChars] 字符上限（默认 600）
 * @param {number} [input.maxFacts] 最多写几件事（默认 5）
 * @returns {{weekKey: string, text: string, used: number}}
 */
export function buildLetter({
  weekKey = currentWeekKey(),
  facts = [],
  owner = '你',
  ownerQq = '',
  quietDays = 0,
  stats = null,
  maxChars = 900,
  maxFacts = 8,
} = {}) {
  const seed = seedOf(weekKey)
  const picked = pickFacts(facts, { owner, maxFacts })

  const paras = []
  paras.push(`${pick(OPENERS, seed)}（${weekRangeText(weekKey)}）`)

  if (!picked.length) {
    paras.push(quietDays > 0 ? `这周安安静静的，有 ${quietDays} 天没怎么说话。我翻了几遍，也没翻出什么值得写下来的。` : '这周没什么特别的事。我翻了几遍，也没翻出什么值得写下来的。')
  } else {
    // 人物/偏好类合成一句，别一句一个「我记着」地排下去
    const profileFacts = []
    const seenWho = new Set()
    for (const f of picked) {
      if (f.kind !== 'person' && f.kind !== 'preference') continue
      const who = String(f.who || '').trim()
      if (who && seenWho.has(who)) continue
      if (who) seenWho.add(who)
      const body = humanizeFact(f.text)
      if (!body) continue
      if (/^(他|她)?(是)?(用户|人|测试)/.test(body)) continue
      if (body.length < 3) continue
      profileFacts.push(asProfile(desensitize(who), body))
      if (profileFacts.length >= 4) break
    }
    if (profileFacts.length) {
      paras.push(`我记得${profileFacts.join('；')}。`)
    }

    // 粗统计先铺一层「这一周发生了什么」，再挑具体的事——不然信就是条目清单
    const st = stats && typeof stats === 'object' ? stats : {}
    const num = (v) => (Number(v) > 0 ? Math.floor(Number(v)) : 0)
    const life = []
    const memes = num(st.memes)
    if (memes >= 50) life.push('这周我又认了一大堆新表情，挑顺眼的存了几张。')
    else if (memes >= 5) life.push('这周又认了些新表情，有几张挺逗的。')
    const promises = num(st.promises)
    if (promises >= 10) life.push('答应过的事我都记着，攒了一小摞。')
    else if (promises >= 3) life.push(`还有 ${promises} 件答应过的事，我记着，不会赖。`)
    const chores = num(st.chores)
    if (chores >= 20) life.push('替你办了几十件小事，多半是回消息、查天气这类零碎活。')
    else if (chores >= 3) life.push(`替你办了 ${chores} 件小事，多半是回消息、查天气这类。`)
    else if (chores > 0) life.push('顺手替你办了两件小事。')
    const groups = num(st.groups)
    if (groups >= 2) life.push(`这周 ${groups} 个群我都待过，话说得不多，听着。`)
    const people = num(st.people)
    if (people >= 3) life.push(`这周来来去去见过 ${people} 个人，有几个名字我记熟了。`)
    if (life.length) paras.push(life.join(''))

    const scenes = []
    let n = 0
    for (const f of picked) {
      if (f.kind === 'person' || f.kind === 'preference') continue
      if (f.kind === 'meme') continue // 表情已在「认了一大堆」里带过，不逐条列
      if (chores > 0 && isOwnerChore(f, owner)) continue // 已经在「办了几件小事」里
      const line = renderFact(f, seed, n, owner)
      if (!line) continue
      if (n > 0 && n % 2 === 0) scenes.push(pick(TURNS, seed + n * 131))
      scenes.push(line)
      n += 1
    }
    if (scenes.length) paras.push(scenes.join(''))
  }

  // 名字/原话/表情：让信里有具体的人，不只是几个数字
  const names = []
  for (const f of facts) {
    const w = desensitize(String(f.who || '').trim()).replace(/[、，,。.\s]+$/, '')
    if (!w || w === owner) continue
    if (ownerQq && String(f.qq || '').trim() === String(ownerQq)) continue
    if (names.includes(w)) continue
    names.push(w)
    if (names.length >= 5) break
  }
  if (names.length >= 2) {
    paras.push(`这周碰见的人不少，${names.slice(0, 4).join('、')} 这几个名字我记得最清楚。`)
  }
  const quotes = []
  for (const f of facts) {
    if (String(f.kind || '') !== 'promise') continue
    const t = humanizeFact(f.text).replace(/^[^：:]{1,24}说[：:]\s*/, '')
    if (!/答应|说好|保证|明天|下次|改天/.test(t)) continue
    if (/我没答应|没有答应/.test(t)) continue
    if (t.length < 8) continue
    if (quotes.some((q) => q.includes(t.slice(0, 8)))) continue
    quotes.push(`「${t.slice(0, 28)}」`)
    if (quotes.length >= 2) break
  }
  if (quotes.length) paras.push(`还有几句我记着的话：${quotes.join('，')}。`)
  const labels = []
  for (const f of facts) {
    if (String(f.kind || '') !== 'meme') continue
    const lab = humanizeFact(f.text).replace(/^学到了表情包[：:]\s*/, '').replace(/_/g, ' ').trim()
    if (lab && !labels.includes(lab) && lab.length <= 20) labels.push(lab)
    if (labels.length >= 2) break
  }
  if (labels.length) paras.push(`存下来的表情里，有「${labels[0]}」${labels[1] ? `、「${labels[1]}」` : ''}这种，回头用给你看。`)

  if (picked.length <= 2) paras.push(pick(FILLERS, seed + 17))

  // 至少一句自己的感受：让信有自己的位置，不只围着别人转
  paras.push('这周没什么大事，都是些小得不能再小的事，攒在一起才像一周。')
  paras.push('白天我大多在群里待着，晚上把当天的事理一遍——这周也没落下。')
  paras.push(pick(REFLECTIONS, seed >> 2))
  if (quietDays >= 3) paras.push(`其中有 ${quietDays} 天没怎么聊，我都记着。安静不一定是坏事。`)
  paras.push('信里只挑了几件，剩下的都在我记着的那些条目里，想翻的时候随时问我。')
  paras.push(pick(CLOSERS, seed >> 3))

  let text = paras.filter(Boolean).join('\n\n')
  const cap = Math.max(80, Number(maxChars) || 600)
  if (text.length > cap) text = `${text.slice(0, cap - 1)}…`
  return { weekKey, text, used: picked.length }
}

/**
 * 让模型写这封信（模板版留着兜底）。
 *
 * 为什么换思路：模板再改也是「素材 → 句子」的映射，主人 10-31 连看两版
 * 都说「水」——因为 A 周和 B 周出来的是同一个骨架，只有名词在换。
 * 模型不一样：同一堆材料它能挑不同的切口、写出不同的语气。
 *
 * 但前提是**材料给够、约束给死**：只给事实条目（不带 QQ/群号），
 * 要求 600~900 字、纯文本、别列清单、别只写主人、允许写自己的情绪。
 */
export function buildLetterPrompt({ weekKey, facts = [], stats = null, owner = '你', persona = '', selfName = 'Molly' } = {}) {
  const range = weekRangeText(weekKey)
  const bullets = []
  for (const f of facts.slice(0, 60)) {
    const text = desensitize(String(f.text || '').replace(/\s+/g, ' ').trim())
    if (text.length < 4) continue
    const who = String(f.who || '').trim()
    bullets.push(who ? `- ${who}：${text}` : `- ${text}`)
  }
  const statLine = stats
    ? `这周的大致规模：替主人办事 ${Number(stats.chores) || 0} 件，认识新表情 ${Number(stats.memes) || 0} 张，答应/记下的承诺 ${Number(stats.promises) || 0} 条，打交道的人 ${Number(stats.people) || 0} 个，进过的群 ${Number(stats.groups) || 0} 个。`
    : ''
  const system = [
    `你是${selfName}，住在 QQ 群里的一个小机器人。你有记忆、有脾气，也有自己的日子：白天在群里待着、跟人说话、认表情、学歌，也会犯错。`,
    persona ? `你的性格和说话习惯：${String(persona).slice(0, 400)}` : '',
    '现在你要写一封给主人的周记，用第一人称，像日记，不像工作汇报。',
  ].filter(Boolean).join('\n')

  const user = [
    `下面是 ${range} 这一周你记得的材料（条目是事实，不是要照抄的句子）：`,
    bullets.join('\n') || '（这周没什么材料，就写你自己过的日子）',
    statLine,
    '写的时候：',
    '1. 600~900 字，纯文本。不要标题、不要 markdown、不要分成几条、不要写日期小标题。',
    '2. 挑 3~5 个人和 3~5 件具体的事写进去，别把材料逐条复述。',
    '3. 可以写你自己的感受和念头（高兴、累、好奇、担心、犯傻、想不通），至少两处。',
    `4. 不要只写主人（${owner}）。你自己的日子也要写：在群里待着、跟谁熟起来了、学了什么、闹了什么笑话。`,
    '5. 不要编造材料里没有的具体事实（人名、数字、事件）；可以联想，但别瞎编。',
    '6. 不要出现 QQ 号、群号、时间戳、「第 N 条」这类东西。',
    '7. 开头别用「这周过得挺快」这种套话；结尾自然收住，不要总结全文。',
    '直接给信的正文。',
  ].filter(Boolean).join('\n')

  return { system, user, range }
}

/**
 * 清洗模型输出：去 markdown/列表/标题，去掉长数字串，按句子边界截断。
 * 模型偶尔还是会写「- 第一条」，这里统一抹平。
 */
export function cleanModelLetter(input, { maxChars = 1400 } = {}) {
  let text = String(input || '')
  text = text.replace(/```[a-zA-Z]*\n?/g, '').replace(/```/g, '')
  text = text.replace(/^\s*#{1,6}\s*/gm, '')
  text = text.replace(/^\s*[-*+·•]\s+/gm, '')
  text = text.replace(/^\s*\d+[.、)]\s+/gm, '')
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/__([^_]+)__/g, '$1')
  text = text.replace(/\d{5,}/g, '有人')
  text = text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n')
  text = text.trim()
  // 去掉开头自报家门式的「以下是」/「好的」之类
  text = text.replace(/^(好的|好呀|以下是|这是)[，,：:]?\s*/i, '')
  if (text.length > maxChars) {
    const cut = text.slice(0, maxChars)
    const end = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('\n'))
    text = end > maxChars * 0.6 ? cut.slice(0, end + 1) : `${cut.trim()}…`
  }
  return text.trim()
}

/**
 * 把信渲染成一条记忆（kind=event，level=2，weight=8），跟周聚合同级。
 * 这样「我说过什么」和「我写过什么」都在同一层，召回时能一起被翻到。
 */
export function letterEntry({ weekKey, text, owner = '' }, { id } = {}) {
  return {
    id: id || `letter-${weekKey}`,
    kind: 'event',
    who: owner,
    qq: '',
    text,
    weight: 8,
    level: 2,
    source: 'system',
    hits: 0,
    lastActiveDay: 0,
    at: Date.now(),
    letterFor: weekKey,
  }
}
