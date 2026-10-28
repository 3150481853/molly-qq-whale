/**
 * 茉莉花（Jasmine）记忆系统 · 群聊四档信号（P1-6）
 *
 * 群聊里最难的不是「说什么」，是「该不该说」。`@我` 必回是常识，
 * 难的是剩下 99% 的消息：有人在群里聊天，到底跟你有没有关系。
 *
 * 四档（权重就是它的重要性，也是它进上下文的分量）：
 *   called     1.00  被叫到：@我、叫我的名字
 *   aboutMe    0.50  在说我：提到关于我的事/我说过的话
 *   continuing 0.20  接我的话：45 秒内、≤24 字、明显在接上一句
 *   chatter    0.01  纯闲聊：不搭茬，只做背景
 *
 * 另外两条硬规则：
 *   - 说别人的 @（@了别人没 @我）→ 0，闭嘴
 *   - 九图刷屏之类的折叠内容不进打分（避免「图片里提到我」被当成在说我）
 */

export const SIGNAL_WEIGHTS = Object.freeze({
  called: 1,
  aboutMe: 0.5,
  continuing: 0.2,
  chatter: 0.01,
})

/** 续接窗口：45 秒内、内容不超过 24 字，才可能是「接着我的话往下说」 */
export const CONTINUE_WINDOW_MS = 45_000
export const CONTINUE_MAX_CHARS = 24

/** 折了图的占位文本 */
const FOLDED = /\[图片[×xX]?\d*\]|\[表情\]|\[动画表情\]/g

function norm(text) {
  return String(text ?? '').replace(FOLDED, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * 给一条群消息打分。
 *
 * @param {object} input
 * @param {string} input.text 消息文本
 * @param {boolean} [input.isAtMe] 是否 @ 了我
 * @param {boolean} [input.atSomeoneElse] 是否只在 @ 别人
 * @param {string[]} [input.names] 我的名字/小名列表（被直接叫到也算 called）
 * @param {string[]} [input.myTopics] 我最近说过的话题关键词（出现在消息里算 aboutMe）
 * @param {boolean} [input.continuesMe] 是否在接我上一句
 * @param {number} [input.msSinceMyLast] 距我上一条消息多久
 * @param {string} [input.text] 已归一
 * @returns {{score: number, tier: 'called'|'aboutMe'|'continuing'|'chatter', reasons: string[]}}
 */
export function scoreSignal({
  text = '',
  isAtMe = false,
  atSomeoneElse = false,
  names = [],
  myTopics = [],
  continuesMe = false,
  msSinceMyLast = Infinity,
} = {}) {
  const t = norm(text)
  const reasons = []

  if (atSomeoneElse && !isAtMe) {
    return { score: 0, tier: 'chatter', reasons: ['在叫别人'] }
  }
  if (isAtMe) return { score: SIGNAL_WEIGHTS.called, tier: 'called', reasons: ['@我'] }

  const hitName = names
    .map((n, i) => ({ n: String(n || '').trim(), i }))
    .filter((x) => x.n.length >= 2)
    .find((x) => t.includes(x.n))
  if (hitName) return { score: SIGNAL_WEIGHTS.called, tier: 'called', reasons: [`叫名字「${hitName.n}」`] }

  const topic = myTopics.map((x) => String(x || '').trim()).filter((x) => x.length >= 2).find((x) => t.includes(x))
  if (topic) return { score: SIGNAL_WEIGHTS.aboutMe, tier: 'aboutMe', reasons: [`提到「${topic}」`] }

  const short = t.length > 0 && t.length <= CONTINUE_MAX_CHARS
  if (continuesMe && short && msSinceMyLast <= CONTINUE_WINDOW_MS) {
    return { score: SIGNAL_WEIGHTS.continuing, tier: 'continuing', reasons: ['在接我上一句'] }
  }

  if (!t) reasons.push('空白内容')
  return { score: SIGNAL_WEIGHTS.chatter, tier: 'chatter', reasons }
}

/** 该不该开口：档位阈值（默认只有 called/aboutMe 才值得回话） */
export function shouldSpeak(score, threshold = SIGNAL_WEIGHTS.aboutMe) {
  return Number(score) >= threshold
}
