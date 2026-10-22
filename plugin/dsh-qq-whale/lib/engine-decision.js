/**
 * engine-decision.js —— 决策层：「要不要理、要不要查、要不要停」。
 *
 * Stage 3 Step 2 的产物。这一层只回答「是/否 + 理由」：
 *   - 不 await 网络（`pestMuteGate` 的投递也是通过注入的 `sayQuick/tapEmoji` 做，
 *     模块自己不碰 client）；
 *   - 不写聊天历史；
 *   - 不 import 任何项目内模块。
 *
 * 依赖一律显式传进来（deps），**模块里没有 `this`**：
 *   - 引擎里的同名方法保留，只做一行转发，调用点不动；
 *   - 这样以后单独测决策层时，喂一个假 deps 就能跑，不用起整个引擎。
 *
 * 注意：场景常量由引擎传入（`deps.scenes`），这里不复制 'private' 这类字符串，
 * 免得以后改协议时两处漂移。
 */

/** 她的所有称呼（昵称 / 群名片基础名 / QQ 号），去重后返回。 */
export function selfNames(deps) {
  const { selfId, nickname, groupCardBases, selfNickname, config } = deps
  const names = []
  const push = (v) => {
    const s = String(v || '').trim()
    if (s && !names.includes(s)) names.push(s)
  }
  push(selfId) // QQ 号：最稳，但客户端 @ 时通常显示名字
  push(nickname) // 昵称
  /*
   * 2026-10-22 真机：SnowLuma 刚起来时 plugin 已连上、但 get_login_info 还没就绪，
   * `client.self.nickname` 空了一整轮（/state.bot.nickname 显示纯号码），
   * 于是「Molly在吗」识别不到叫名字、只能靠问句分。
   * 这里补两个来源：显式传入的 selfNickname、配置里的 nickname，最后兜底 Molly。
   */
  push(selfNickname)
  push(config?.nickname)
  push('Molly')
  // 群名片：她自己的名片带「（在想…）」这类实时状态，基础名也要认
  try {
    for (const base of groupCardBases?.values?.() || []) push(base)
  } catch {}
  return names
}

/** 文本里是不是在 @ 我（昵称 / 群名片基础名 / QQ 号三种写法）。 */
export function looksLikeAtMe(text, deps) {
  const t = String(text || '')
  const at = t.indexOf('@')
  if (at < 0) return false
  const names = selfNames(deps)
  const rest = t.slice(at + 1)
  /*
   * 名字之后必须是「边界」——空白、标点、括号、结尾。
   * 否则群里有人叫「Molly的粉丝」，@他时会被当成 @我。
   */
  const isBoundary = (ch) =>
    ch === undefined || ch === '' || /[\s，。！？、：；,.!?:;()（）【】\[\]"'“”‘’…~～\-—_]/.test(ch)

  const tryName = (n) => {
    if (!n) return false
    if (!rest.startsWith(n)) return false
    const after = rest.charAt(n.length)
    return isBoundary(after)
  }

  for (const n of names) {
    if (tryName(n)) return true
  }
  // 兜底：名字带状态后缀的形式（Molly（在想…））—— 去掉括号部分再试
  for (const n of names) {
    const base = n.replace(/[（(].*?[)）]$/, '').trim()
    if (base && base !== n && tryName(base)) return true
  }
  return false
}

/**
 * 文本里直接叫了她的名字（没有 @ 段）。
 *
 * 2026-10-21 真机反馈：群友打「Molly在吗」「莫莉呢」，她一声不吭，只给个赞。
 * 那条消息没有 at 段（NapCat 里用户手打名字），场景被判成「旁观」，
 * 意愿分 0.44 卡在 0.42 阈值边缘，抖动一抖就不回。
 *
 * 「叫名字」在真人聊天里就是点名，不该按旁观算。这里只排除一种情况：
 * 名字后面紧跟「的」——「Molly的粉丝」是在说第三人，不是叫她。
 */
export function callsMyName(text, deps) {
  const t = String(text || '')
  if (!t) return false
  for (const n of selfNames(deps)) {
    if (!n) continue
    if (/^\d+$/.test(n)) continue // QQ 号容易误伤（CQ 码里就有），只认名字
    const i = t.indexOf(n)
    if (i < 0) continue
    if (t.charAt(i + n.length) === '的') continue
    return true
  }
  return false
}

/**
 * 这条消息是什么场景：私聊 / 群@ / 群旁观。
 *
 * 文本兜底那段是给 NapCat 的：用户 @ 有时整条是一个 text 段、没有 at 段，
 * 只认 `norm.isAtMe` 会导致「群里 @ 她不回、私聊却好好的」（真机踩过三次）。
 */
export function decideScene(ev, norm, deps) {
  const { scenes, looksLikeAtMe: atMe, isReplyToMe } = deps
  if (ev.message_type !== 'group') return scenes.PRIVATE
  if (norm.isAtMe) return scenes.MENTION
  // 回复我的消息也算点名
  if (norm.replyTo && isReplyToMe(ev, norm.replyTo)) return scenes.MENTION
  if (atMe(norm.text)) return scenes.MENTION
  return scenes.BYSTANDER
}

/** 是不是在回复我（用来把「回复」也算成点名）。 */
export function isReplyToMe(ev, replyMessageId, deps) {
  const conv = deps.conversations.get(deps.conversationKey(ev))
  if (!conv) return false
  return conv.history.some((h) => h.messageId === replyMessageId && h.role === 'assistant')
}

/**
 * 这人能不能私聊她。
 *
 * 两个来源缺一不可：手写白名单（config.allowedUsers）+ 主人当场批过的人
 * （gatekeeper.approved）。只认白名单的话，主人批完对方下一条又掉回「陌生人」。
 */
export function isAllowedUser(userId, deps) {
  const { config, gatekeeper } = deps
  const id = String(userId)
  const list = config?.allowedUsers || []
  if (list.length === 0 && !gatekeeper) return false
  if (list.map(String).includes(id)) return true
  try {
    if (gatekeeper?.isApproved(id)) return true
  } catch {}
  return false
}

/** 这个群在不在白名单里（空名单 = 谁都不许）。 */
export function isAllowedGroup(groupId, deps) {
  const list = deps.config?.allowedGroups || []
  if (list.length === 0) return false
  return list.map(String).includes(String(groupId))
}

/**
 * 「这句话要不要去查」——零成本规则。
 *
 * 抽成方法的目的：`POST /dsh-qq-whale/research/test` 能单独调用它，
 * 不用真在 QQ 里说句话再等十几秒从措辞反推。
 */
export function decideResearch(text, deps) {
  const enabled = deps.config?.researchEnabled !== false
  const available = Boolean(deps.researcher?.available)
  if (!available) return { need: false, query: '', reason: 'researcher-unavailable' }
  return deps.needsResearch(text, { enabled })
}

/**
 * 该不该回。
 * 私聊必回（陌生人除外——返回 false 是有意的，真正的动作是转审批）；
 * 群里：非白名单不回、点名必回、明确要查事必回、其余按意愿阈值掷骰子。
 */
export function shouldRespond({ scene, ev, norm, conv }, deps) {
  const { scenes, isAllowedUser, isAllowedGroup, decideResearch, willingness, now } = deps
  if (scene === scenes.PRIVATE) {
    if (!isAllowedUser(ev.user_id)) return { yes: false, reason: '陌生人来访（转审批）' }
    return { yes: true }
  }
  // 群聊
  if (!isAllowedGroup(ev.group_id)) return { yes: false, reason: '非白名单群' }
  if (scene === scenes.MENTION) return { yes: true }

  // 「明确要她干活/查事」的旁观消息必须回——这跟闲聊意愿是两码事。
  const researchVerdict = decideResearch(norm.text)
  if (researchVerdict.need) return { yes: true, reason: '明确请求（research）' }

  /*
   * 名字被叫 = 点名（2026-10-21 用户：「还是@她了才回一句」）。
   * 群里手打「Molly在吗」「莫莉呢」没有 at 段，场景落在旁观，
   * 按意愿算只有 0.44 卡在阈值边缘 —— 这里直接放行。
   */
  const callingMyName = callsMyName(norm.text, deps)
  if (callingMyName) return { yes: true, reason: '叫名字', willingness: 0.92 }

  /*
   * 「她最近说过多少话 / 群里现在有多热」必须按**时间窗**算。
   *
   * 2026-10-21 修：原来 `recentSelf = conv.history.filter(assistant).length`
   * 数的是整段历史（上限 contextLimit 60 条）。只要聊过两轮，这个数就永久 ≥2，
   * 每句话都吃 -0.25 罚分 —— 群里普通消息的意愿上限被压到 0.5 左右，
   * 永远够不到阈值。真机表现就是用户说的「只会点赞」。
   *
   * 现在：自己说过的话看最近 10 分钟，群里的热度看最近 90 秒。
   * 窗口长度也进配置，方便以后按群调。
   */
  const nowMs = now()
  const selfWindowMs = (deps.config?.willingnessSelfWindowMinutes ?? 10) * 60000
  const heatWindowMs = (deps.config?.willingnessHeatWindowSeconds ?? 90) * 1000
  const history = Array.isArray(conv.history) ? conv.history : []
  let recentSelf = 0
  let recentOthers = 0
  let lastAssistantAt = 0
  for (const h of history) {
    const at = Number(h?.at) || 0
    if (!at) continue
    if (h.role === 'assistant' && at > lastAssistantAt) lastAssistantAt = at
    const age = nowMs - at
    if (age < 0 || age > selfWindowMs) continue
    if (h.role === 'assistant') recentSelf += 1
    else if (age <= heatWindowMs) recentOthers += 1
  }
  // 有人接着她上一句在说（2 分钟内）→ 这是对话，不是路过
  const continuesMe = Boolean(lastAssistantAt) && nowMs - lastAssistantAt <= 120000

  const lastSelfSpeakMs = conv.lastSelfAt ? nowMs - conv.lastSelfAt : Infinity
  /*
   * 轮流说话（2026-10-21 二次真机：「你咋看这个图」还是没回）。
   *
   * 现场：她刚发完一张图，用户紧接着问「你咋看这个图」，判定 w=0.171 不回。
   * 原因是她自己在 10 分钟内说过 4 次（-0.22）、且 15 秒内刚说过（-0.18），
   * 两条罚分把分数压死了 —— 可这时候明明是**用户在接她的话**，
   * 属于正常对话回合，不是她抢麦。
   *
   * 所以：她 2 分钟内说过话、且对方这条有实际内容（≥4 字，排除「嗯」「哦」）
   * 时，不按"话太多"罚分；continuesMe 的 +0.10 仍然保留。
   * 真正防刷屏的场景（她连说两句，没人接）不受影响。
   */
  const turnTaking = continuesMe && String(norm.text || '').trim().length >= 4
  const w = willingness({
    scene,
    text: norm.text,
    isAtMe: false,
    recentSelfMessages: turnTaking ? 0 : recentSelf,
    recentOthers,
    lastSelfSpeakMs: turnTaking ? Infinity : lastSelfSpeakMs,
    continuesMe,
  })
  /*
   * 阈值 0.62 → 0.42（2026-10-21）。0.62 是按旧公式配的：旧公式起手 0.18，
   * 要三四个钩子叠加才过线。新公式起手 0.32、钩子更多，同样的 0.62 会变成
   * 「只回 @」——用户要的是她主动吐槽，所以阈值也跟着降。
   * 想收回去就改配置里的 bystanderThreshold，不用动代码。
   */
  const threshold = deps.config?.bystanderThreshold ?? 0.42
  return { yes: w >= threshold, willingness: w, threshold, recentSelf, recentOthers, continuesMe }
}

/**
 * P2 死磕状态机：这条用户消息算不算「还在问同一个问题」。
 * 纯图片/表情（没有正文）不参与判定，沿用上一次的话题状态。
 */
export function noteTopic({ ev, text }, deps) {
  const { stall, conversationKey, now, coreText, similarity, containment, similarityThreshold, limit } = deps
  const key = conversationKey(ev)
  const core = coreText(String(text || ''))
  const prev = stall.get(key)
  let misses = 0
  if (prev && prev.core && core) {
    const sim = Math.max(similarity(prev.core, core), containment(prev.core, core))
    if (sim >= similarityThreshold) misses = prev.misses || 0
  }
  if (!core) {
    return { key, core: prev?.core || '', misses, hardStop: misses >= limit }
  }
  stall.set(key, { core, misses, at: now() })
  return { key, core, misses, hardStop: misses >= limit }
}

/**
 * P2：这一轮回答算不算「拿到新证据」。没有就累加，够上限下一轮收口。
 * 「没有新证据」= 没查到东西 + 回复是追问型（或自己说没找到）。
 */
export function noteOutcome({ key, core, replyText, researchFound }, deps) {
  const { stall, now, noEvidenceRe, limit } = deps
  const noEvidence = !researchFound && noEvidenceRe.test(String(replyText || ''))
  const prev = stall.get(key) || { core: core || '', misses: 0 }
  const misses = noEvidence ? (prev.misses || 0) + 1 : 0
  stall.set(key, { core: core || prev.core || '', misses, at: now() })
  return { misses, hardStop: misses >= limit, noEvidence }
}

/** P2：命中硬停止时往 system 里追加的那段（只讲这一轮怎么收口，不讲人格）。 */
export function stallStopSection(misses) {
  return [
    '# 这一轮别再问了',
    `同一个问题你已经连着问了 ${misses} 回，还是没拿到新东西。`,
    '这轮不许再查、不许再换关键词、不许再让对方「发一下 / 说清楚 / 截图给我」。',
    '直接收口：明说翻不到了，然后给出你现在能给的、最接近的说法。',
    '要对方补信息最多一句话，说完立刻给结论，不要连环追问。',
  ].join('\n')
}

/**
 * 骂街静音期的被动回复拦截。
 *
 * 注意：这里仍然**会发**一句中性收场 / 贴个表情——投递动作通过 deps 注入，
 * 模块自己不发消息。拆到 Step 4 时再把「发」挪出去，这一步只搬家不改行为。
 */
export async function pestMuteGate(ev, scene, norm, deps) {
  const { scenes, pest, logger, sayQuick, tapEmoji } = deps
  if (!pest?.enabled || !pest.isMuted() || !pest.isTarget(ev.user_id)) return false
  const direct = scene === scenes.PRIVATE || norm?.isAtMe === true
  logger('info', `骂街静音中，跳过对 ${ev.user_id} 的被动回复（${direct ? '回一句中性收场' : '只贴表情'}）`)
  if (direct) {
    await sayQuick(ev, scene, '……行吧，今天不骂了。').catch(() => {})
  } else {
    await tapEmoji(ev.message_id).catch(() => {})
  }
  return true
}

/**
 * 主动找人：权重 = 1/(1+小时数/24)，最近聊过的权重大，但不是必然。
 * `rand` 由引擎注入（默认 Math.random），快照机才能钉死。
 */
export function pickProactiveTarget(convList, now, deps) {
  if (convList.length === 0) return null
  const rand = deps?.rand || Math.random
  const weighted = convList.map((c) => {
    const hours = Math.max(0.5, (now - c.lastUserAt) / 3600000)
    return { conv: c, w: 1 / (1 + hours / 24) }
  })
  const total = weighted.reduce((s, x) => s + x.w, 0)
  let r = rand() * total
  for (const x of weighted) {
    r -= x.w
    if (r <= 0) return x.conv
  }
  return weighted[weighted.length - 1].conv
}

/** 从历史里捞最近一个「像话题」的句子。 */
export function lastTopicOf(conv) {
  const arr = conv.history || []
  for (let i = arr.length - 1; i >= 0; i--) {
    const e = arr[i]
    if (e.role !== 'user') continue
    const t = String(e.text || '').replace(/\s+/g, ' ').trim()
    if (t.length >= 4 && t.length <= 40) return t
    if (t.length > 40) return t.slice(0, 40) + '…'
  }
  return ''
}
