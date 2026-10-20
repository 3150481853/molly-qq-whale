/**
 * 汇报去重：同一件事别用两种说法各发一遍。
 *
 * 真机现场（2026-10-18，私聊 222222222，real_seq 530~533，一条「命令 回复一下未读消息」）：
 *
 *   seq 530  理完了，未读就三条：……（232 字，完整详细版）
 *   seq 531  未读消息已处理完，顺手也把刚恢复的 QQ 好友列表对了一遍……（111 字，换角度重写）
 *   seq 532  三条未读的情况：……（130 字，同一内容的压缩版）
 *   seq 533  另外一句提醒：QQ 是刚恢复的……（72 字，和 530 末段几乎逐字重复）
 *
 * 这四条**不是**引擎切的段（引擎按 180 字切，530 有 232 字，切不出来），
 * 而是干活 agent 在多个回合里各自调了一次 `qq_onebot send_private_msg`——
 * 每个回合的收尾总结都自己发了一条。主人看到的就是「回几句，一句润色一句原句」。
 *
 * 修法分两层：
 *   1. engine.js 在命令执行期间把 agent 自己发给主人的消息**接下来**，不直接发（见 installReportCapture）；
 *   2. 收尾时用这里的 mergeReportTexts() 把「接下的那几条 + 最终结果」合并成一段，
 *      段一级去重 —— 同一件事的第二个说法直接丢掉，只留第一次说的那份。
 *
 * 为什么不按整条消息比：530 的四段里只有「另外提醒一句」那段和 533 重复，
 * 按整条比会把 533 判成 0.2 相似而漏掉；按段比才抓得住。
 */

/** 从 OneBot 的 message 参数里抠出纯文本（字符串或分段数组都吃） */
export function messageText(message) {
  if (typeof message === 'string') return message.trim()
  if (!Array.isArray(message)) return ''
  return message
    .filter((p) => p && p.type === 'text' && typeof p.data?.text === 'string')
    .map((p) => p.data.text)
    .join('')
    .trim()
}

/**
 * 比较用的「核」：去掉空白、标点、符号、emoji，只留字和数字。
 *
 * 不这么做的话，同样的内容加个换行、换个句号，相似度就掉下去了。
 */
export function coreText(s) {
  return String(s || '')
    // 标点/符号/emoji 全去掉：Unicode 的 P（标点）、S（符号）、Z（分隔）
    .replace(/[\p{P}\p{S}\p{Z}\s]/gu, '')
    .toLowerCase()
}

/** 字符二元组集合。中文按「字」而不是按词，省掉分词依赖 */
function bigrams(s) {
  const set = new Set()
  const t = coreText(s)
  if (t.length === 1) set.add(t)
  for (let i = 0; i + 1 < t.length; i += 1) set.add(t.slice(i, i + 2))
  return set
}

/**
 * 两个文本的 Jaccard 相似度（交集 / 并集）。
 * 适合判断「两段各自独立、但讲的是不是同一件事」。
 */
export function similarity(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  let inter = 0
  for (const x of A) if (B.has(x)) inter += 1
  return inter / (A.size + B.size - inter)
}

/**
 * 覆盖率（交集 / 较小的那个集合）。
 *
 * 这个才是「润色版 vs 压缩版」该用的尺子：532 是 530 的压缩版，
 * 它的二元组几乎全被 530 包住，所以 containment 高、Jaccard 低。
 * 用 Jaccard 会漏判，实测 530↔532 只有 0.2 出头。
 */
export function containment(a, b) {
  const A = bigrams(a)
  const B = bigrams(b)
  if (A.size === 0 || B.size === 0) return 0
  const [small, big] = A.size <= B.size ? [A, B] : [B, A]
  let inter = 0
  for (const x of small) if (big.has(x)) inter += 1
  return inter / small.size
}

/**
 * 把一段文本切成「段」：空行优先，单换行也算（汇报里一条一行的情况很常见）。
 * 太短的段（编号、标点残渣）不参与判断，见 mergeReportTexts。
 */
export function splitBlocks(text) {
  return String(text || '')
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * 合并多条汇报文本，段级去重，返回一段。
 *
 * 规则：
 *   - 按入参顺序处理（先到的先留，通常就是最早、最详细那一版）；
 *   - 每一段跟「已保留的每一段」比一遍：覆盖率或相似度任一超阈值就丢掉；
 *   - 再跟「已保留段拼起来的全文」比一遍 —— 这是为了抓住
 *     532 这种「把 530 的几条揉成一段重说」的压缩版（它跟任何单独一段都不像，
 *     但整段被 530 的全文覆盖）；
 *   - 段太短（< minLen）不判断，直接留：汇报里的短行往往是新增的一句提醒；
 *   - 兜底：全被判成重复时，保留最后一条原文，绝不把要说的东西全吞掉。
 */
export function mergeReportTexts(texts, opts = {}) {
  const threshold = opts.threshold ?? 0.62
  const minLen = opts.minLen ?? 12
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t || '')).filter((t) => t.trim())
  if (list.length === 0) return ''

  const kept = []
  const dropped = []
  for (const text of list) {
    for (const block of splitBlocks(text)) {
      const key = coreText(block)
      if (key.length < minLen) {
        /*
         * 短段（标题行、编号、"另外"之类）不参与相似度判断 —— 它们本来就没几个字，
         * 一比就全是噪音。但**逐字重复**的短段还是要丢：
         * 同一段汇报说了三遍时，"理完了，未读就三条：" 这种开头会被留下三份。
         */
        if (key && kept.some((k) => coreText(k) === key)) {
          dropped.push(block)
          continue
        }
        kept.push(block)
        continue
      }
      const fullSoFar = kept.join('\n')
      const dupOfBlock = kept.some(
        (k) => coreText(k).length >= minLen && (containment(block, k) >= threshold || similarity(block, k) >= threshold),
      )
      const dupOfFull = coreText(fullSoFar).length >= minLen && containment(block, fullSoFar) >= threshold
      if (dupOfBlock || dupOfFull) {
        dropped.push(block)
        continue
      }
      kept.push(block)
    }
  }

  if (kept.length === 0) {
    // 全删光了：宁可重复也不能让主人什么都收不到
    return list[list.length - 1]
  }
  const out = kept.join('\n')
  // 去重结果给调用方留着观测用（真机上出问题时能知道吞了什么）
  mergeReportTexts.lastDropped = dropped
  return out
}

/** 上一次合并丢掉的段（只用于观测/日志，别拿去做业务判断） */
mergeReportTexts.lastDropped = []
