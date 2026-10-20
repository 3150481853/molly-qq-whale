/**
 * 活人感引擎。
 *
 * 机器人和真人聊天的差别，90% 不在措辞，在**时间结构**：
 *   - 真人不会在你发完 0.3 秒后回一段话
 *   - 真人打字有快有慢，长句慢、短句快，还会停下来想
 *   - 真人会一口气发三四条，也会已读不回
 *   - 真人有作息，凌晨三点不会秒回
 *   - 真人会因为"你刚才那句话"临时改主意
 *
 * 这个模块只负责时间与节奏，不懂人设、不懂 QQ。
 * 所有随机都过 jitter()，让同一份配置跑出不一样的节奏。
 */

/** 休息窗口（跨午夜安全）。返回 true 表示"现在她应该在睡觉" */
export function inRestWindow(windows, now = new Date()) {
  if (!Array.isArray(windows) || windows.length === 0) return null
  const minutes = now.getHours() * 60 + now.getMinutes()
  for (const w of windows) {
    const [sh, sm] = String(w.start || '23:00').split(':').map(Number)
    const [eh, em] = String(w.end || '07:00').split(':').map(Number)
    const s = sh * 60 + (sm || 0)
    const e = eh * 60 + (em || 0)
    if (s === e) continue
    const hit = s < e ? minutes >= s && minutes < e : minutes >= s || minutes < e
    if (hit) return w
  }
  return null
}

/**
 * 打字耗时估算。
 * 基准：thinking + 字数 / 每秒字数 + 标点停顿，再乘 (1 ± jitterRatio)。
 *
 * 为什么按"字数"而不是按"token"：真人的打字速度是自己熟悉输入法后的字速，
 * 跟内容难度关系不大；停顿感靠 thinking 和上限来造。
 *
 * 参数都是「拟人调过的」，不是性能调优过的：
 *   - thinkingBaseDelaySeconds 1.8：看见消息 → 大脑反应 → 手放上键盘。真人做不到 0.3 秒。
 *   - typingCharactersPerSecond 3.2：中文手机聊天真实速度大约 3~4 字/秒（不是 8）。
 *   - typingMaxDelaySeconds 22：打长句要真的打很久，不该被截断成"神速"。
 *   - thinkingJitterRatio 0.45：这条最关键。固定节奏比慢更假——慢而规律=机器人。
 *   - 标点停顿 320ms/个：聊天里"。"和"…"是思考的分号。
 *   - 消息越长，额外多一段"组织语言"时间（每 40 字 +0.6s，封顶 3s）。
 */
export function typingDelayMs(text, cfg = {}, rng = Math.random) {
  const thinking = (cfg.thinkingBaseDelaySeconds ?? 1.8) * 1000
  const cps = Math.max(0.5, cfg.typingCharactersPerSecond ?? 3.2)
  const maxMs = (cfg.typingMaxDelaySeconds ?? 22) * 1000
  const jitter = Math.max(0, cfg.thinkingJitterRatio ?? cfg.typingJitterRatio ?? 0.45)
  const s = String(text || '')
  const chars = s.replace(/\s+/g, '').length
  // 标点也算停顿：句号喘口气，问号/省略号多停一点
  const pauses = (s.match(/[。！？…,.!?]/g) || []).length
  // 长句还要"组织语言"：不是打字慢，是先想清楚怎么说
  const organize = Math.min(3000, Math.floor(chars / 40) * 600)
  const raw = thinking + (chars / cps) * 1000 + pauses * 320 + organize
  const factor = 1 + (rng() * 2 - 1) * jitter
  return Math.max(500, Math.min(maxMs, Math.round(raw * factor)))
}

/**
 * 分段之间的间隔。
 * 真人连着发几条时，条与条之间通常比"打完字"更快——因为已经在敲了，
 * 但也不至于瞬间刷出来（那会像脚本）。
 *
 * 故意留一个"偶尔愣一下"的长尾（8% 概率多停 2~5 秒）：
 * 真人发完一句会看一眼有没有回，然后才继续。太均匀的间隔是最明显的机器味。
 */
export function betweenBubblesMs(cfg = {}, rng = Math.random) {
  const min = (cfg.bubbleGapMinSeconds ?? 1.2) * 1000
  const max = (cfg.bubbleGapMaxSeconds ?? 3.6) * 1000
  let ms = min + rng() * Math.max(0, max - min)
  if (rng() < 0.08) ms += 2000 + rng() * 3000
  return Math.round(ms)
}

/**
 * 首次回复前的"反应延迟"。
 * 这条决定第一印象：太快显得是机器，太慢显得失礼。
 * 群体场景额外加一点——她要"看到"了才接话。
 *
 * 参数覆盖真人的分布：多数时候 2~7 秒（看见、读完、想一下），
 * 10% 的概率走神（多 5~15 秒），5% 的概率正在忙别的事（多 20~50 秒）。
 * 这比"永远 3 秒"真实得多。
 */
export function reactionDelayMs(scene, cfg = {}, rng = Math.random) {
  const min = (cfg.reactionMinSeconds ?? 2) * 1000
  const max = (cfg.reactionMaxSeconds ?? 7) * 1000
  let ms = min + rng() * Math.max(0, max - min)
  const roll = rng()
  if (roll < 0.05) ms += 20000 + rng() * 30000 // 在忙
  else if (roll < 0.15) ms += 5000 + rng() * 10000 // 走神
  if (scene === 'group_bystander') ms *= 2.4 // 群消息多，看到得晚
  if (scene === 'group_mention') ms *= 1.3
  return Math.round(ms)
}

/**
 * 一次性算出"这一轮要花多久、分几条发"。
 * 返回计划，由调用方按 plan 逐条 sleep + send。
 */
export function planDelivery(parts, scene, cfg = {}, rng = Math.random) {
  const plan = []
  let t = reactionDelayMs(scene, cfg, rng)
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]
    if (p.type === 'sticker') {
      // 发表情包比打字快：找图 + 点发送
      t += Math.round(700 + rng() * 900)
      plan.push({ at: t, part: p })
      continue
    }
    t += typingDelayMs(p.text, cfg, rng)
    plan.push({ at: t, part: p })
    if (i < parts.length - 1) t += betweenBubblesMs(cfg, rng)
  }
  return plan
}

/**
 * 愿不愿意接话。群聊里不是每条都该回。
 *
 * 返回 0..1 的"意愿分"，调用方拿它跟阈值比。
 * 设计原则：
 *   - 私聊基本必回（除非在睡觉）
 *   - 群里被 @ 基本必回
 *   - 群聊围观要看"这话有没有钩子"：提问、情绪、叫名字、在聊吃的
 */
export function willingness({ scene, text, isAtMe, recentSelfMessages = 0, lastSelfSpeakMs = Infinity }, rng = Math.random) {
  if (scene === 'private') return 1
  if (isAtMe) return 0.95
  let w = 0.18
  const s = String(text || '')
  if (/[?？]/.test(s)) w += 0.22
  if (/(白饭|吃|饿|投喂|token|肥鱼|鲸鱼|鱼)/.test(s)) w += 0.3
  if (/(哈哈|草|笑死|绷|离谱|绝了)/.test(s)) w += 0.15
  if (s.length > 60) w += 0.08 // 有人认真说话，值得接
  if (s.length < 6) w -= 0.1 // 太短的"嗯""哦"，接了显得傻
  // 刚说过话就让一下，别抢麦
  if (recentSelfMessages >= 2) w -= 0.25
  if (lastSelfSpeakMs < 20000) w -= 0.2
  w += (rng() - 0.5) * 0.12
  return Math.max(0, Math.min(1, w))
}

/** 已读不回时的"最小反应"：偶尔点个表情赞，而不是彻底消失 */
export function shouldTapEmoji(cfg = {}, rng = Math.random) {
  return rng() < (cfg.tapEmojiProbability ?? 0.35)
}

/**
 * 主动联系的时间点。
 * 真人的主动不是定时任务，是"想起来了"。所以用窗口 + 随机，
 * 而不是 cron。
 */
export function nextProactiveAt(cfg = {}, now = Date.now(), rng = Math.random) {
  const minMin = cfg.proactiveMinMinutes ?? 45
  const maxMin = cfg.proactiveMaxMinutes ?? 240
  const gap = (minMin + rng() * Math.max(0, maxMin - minMin)) * 60000
  return now + Math.round(gap)
}

/** 简单的"她在干嘛"状态机，用来给主动消息找个由头 */
export const ACTIVITIES = [
  '在啃白饭',
  '趴着发呆',
  '翻聊天记录',
  '偷偷看群里吵架',
  '在算今天还剩多少 token',
  '刚睡醒，头发乱',
  '给自己量体重，然后沉默了',
  '在研究怎么把群友的猫骗过来',
  '假装很忙',
  '在窗台上晒太阳',
]

export function pickActivity(rng = Math.random) {
  return ACTIVITIES[Math.floor(rng() * ACTIVITIES.length)]
}
