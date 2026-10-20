/**
 * 出站文本清洗：把模型吐出来的 markdown 压成 QQ 能看的纯文本。
 *
 * 为什么单独一层（用户投诉 P6，2026-10-19）：QQ 不渲染 markdown。她一说
 * 「**整段读一遍**」「1. 断句」这种，用户看到的就是满屏星号和井号。
 * 提示词里已经写了「不用 markdown」（persona.js 的「不用 markdown」段），
 * 但模型不听话时得有兜底——这一层就是兜底，挂在 splitReply 的最前面，
 * 因为 engine 里三条出站路径（私聊/群聊/命令）**都**走 splitReply。
 *
 * 三条边界，改之前先读：
 *   1. 只动**格式**，不动内容。除列表前缀的符号外，不删句子、不改字词。
 *   2. 协议标记 `<sticker>…</sticker>` / `<sep/>` / `<br>` 必须原样活下来：
 *      它们在 splitReply 里是有语义的（发表情包、分条、换行），洗掉等于功能失效。
 *   3. 「她在讲自己怎么运转的」是**语义**问题，不归这里管——那是提示词的活。
 *      这里绝不能按关键词砍句子（会把正常技术问答一起砍掉）。
 */

/* 协议标记：先摘出来，最后放回去，中间所有 markdown 处理都碰不到它们 */
/* <at>QQ号</at> 是定向回复标记（主人 m01935），同属协议，必须原样活下来 */
const PROTOCOL_RE = /<sticker>[\s\S]*?<\/sticker>|<at>\s*\d{5,12}\s*<\/at>|<sep\s*\/?>|<br\s*\/?>/gi
const PH = '\u0001'

function protect(text, keep) {
  return text.replace(PROTOCOL_RE, (m) => {
    keep.push(m)
    return PH + (keep.length - 1) + PH
  })
}

function restore(text, keep) {
  return text.replace(/\u0001(\d+)\u0001/g, (m, i) => {
    const v = keep[Number(i)]
    return v == null ? '' : v
  })
}

/**
 * 列表前缀改写：有序 `1.` → `1)`，无序 `-` / `*` / `+` → `·`。
 *
 * 两种方案都试过：
 *   A. 全删前缀（纯换行）——最干净，但用户明确说「能不能列表解释一下」时，
 *      答案就变成一串没编号的句子，"第 3 条"这种指代全废。
 *   B. `1)` + `· `——保住编号和层级，视觉上也不像 markdown 源码。
 * 选了 B：格式问题要修，但不能把人家真要列的东西搞没。
 */
function fixListMarkers(line) {
  // 有序：1. / 1、/ 1)（1) 已经是干净写法，不再动）
  let l = line.replace(/^(\s*)(\d{1,2})[.、]\s+/, '$1$2) ')
  // 无序：- / * / + 后跟空格
  l = l.replace(/^(\s*)[-*+]\s+/, '$1· ')
  return l
}

/* ——— 宿主内部标记（2026-10-19 真机泄漏，seq 591）———
 * 主人收到的原文开头是：
 *   <acp tokens="25" type="text">m02939</acp>\n发给 555555555（示例好友）了，message_id 1968616843，…
 * 即：宿主喂给模型的「事件引用 / 工具回执」被她当正文搬到 QQ 上了。
 * 这些是**协议**不是内容，必须在最前面剥掉，且顺序有讲究：
 *   先剥标记再做 protect()，否则 <acp> 里若有 <br>，protect 会先把它变成
 *   占位符，acp 外层剥掉后占位符恢复，反而把标记又拼回文本里。
 *
 * 替换成 \u0002 占位而不是直接删空，是为了把「，message_id 123，」这种
 * 前后逗号一起去掉——不然用户会看到「发给 X 了，，内容就这一句」。
 * 注意 \u0002 与下面 protect 用的 \u0001 不能撞。
 */
const SENTINEL = '\u0002'

function stripInternalMarks(s) {
  // ① ACP 事件引用：成对的整块删（连同里面的 m02939），落单标签单独删
  s = s.replace(/<acp\b[^>]*>[\s\S]*?<\/acp>/gi, SENTINEL)
  s = s.replace(/<\/?acp\b[^>]*>/gi, '')
  // ② 裸的事件引用号（m + 5 位，如 m02939）：没带标签时也会漏
  s = s.replace(/\bm\d{5}\b/g, SENTINEL)
  // ③ 模板变量残留 {{x}} 与工具调用标签残留
  s = s.replace(/\{\{[\s\S]*?\}\}/g, '')
  s = s.replace(/<\/?(?:function_calls|invoke|parameter)\b[^>]*>/gi, '')
  // ④ 内部字段：message_id 1968616843 / user_id: 123 / group_id=456
  s = s.replace(/(?:message_id|user_id|group_id|msg_id|event_id)\s*[:=]?\s*\d+/gi, SENTINEL)
  // ⑤ CQ 码：[CQ:at,qq=123] 或 CQ:image,file=a.jpg（参数止于空白/右括号，
  //    不能吞掉后面的正常文字）
  s = s.replace(/\[?CQ:[a-z_]+(?:,[^\s\]]*)?\]?/gi, SENTINEL)
  // 占位清理：连同前面那个分隔符一起删，避免留下「，，」
  s = s.replace(/[，,、；;：:]?\s*\u0002\s*/g, '')
  s = s.replace(/\u0002/g, '')
  // 删完可能留一串空格
  s = s.replace(/[ \t]{2,}/g, ' ')
  return s
}

/* 纯路径行：整行只有一个盘符路径（主人说过不爱看路径刷屏） */
const PATH_LINE_RE = /^[A-Za-z]:[\\/]\S*$/

function fixTableLine(line) {
  const t = line.trim()
  if (!t.startsWith('|')) return line
  // 分隔行（|---|:--:|）整行丢掉
  if (/^\|?[\s:|-]+\|?$/.test(t) && t.includes('-')) return ''
  const cells = t
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim())
    .filter(Boolean)
  return cells.length ? cells.join(' · ') : ''
}

/**
 * @param {string} input 模型原始输出
 * @returns {string} 可以直接发到 QQ 的纯文本
 */
export function sanitizeOutbound(input) {
  let s = String(input == null ? '' : input)
  if (!s.trim()) return ''

  // P3 复发（task-26）：先剥宿主协议标记 / 内部 ID，再走 markdown 清理
  s = stripInternalMarks(s)
  if (!s.trim()) return ''

  const keep = []
  s = protect(s, keep)

  // 零宽字符：从网页/记忆里带进来的，肉眼看不出但会让"空格"串味
  s = s.replace(/[\u200b-\u200f\u2028\u2029\ufeff]/g, '')

  // 代码围栏：```js … ``` → 内容（保留换行，不保留语言名和围栏）
  s = s.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (m, body) => '\n' + body.replace(/\s+$/, '') + '\n')
  // 没闭合的围栏：只去围栏本身，内容留着
  s = s.replace(/^\s*```[^\n]*$/gm, '')
  s = s.replace(/```/g, '')

  // 行内代码 `x` → x（先去成对的，再去剩下的单个反引号）
  s = s.replace(/`([^`\n]+)`/g, '$1')
  s = s.replace(/`/g, '')

  // 图片 ![alt](url) → url（alt 对用户没意义）；必须在链接之前处理
  s = s.replace(/!\[([^\]\n]*)\]\(\s*([^)\s]+)\s*\)/g, (m, alt, url) => url)

  // 链接 [text](url) → text（url），text 与 url 相同时只留 url
  s = s.replace(/\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?\s*\)/g, (m, text, url) => {
    const t = String(text || '').trim()
    if (!t || t === url) return url
    return t + '（' + url + '）'
  })

  // 粗体 / 下划线粗体 / 删除线
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '$1')
  s = s.replace(/__([^_\n]+)__/g, '$1')
  s = s.replace(/~~([^~\n]+)~~/g, '$1')
  // 成对的单星号斜体（QQ 里 * 是纯噪声，宁可去掉）
  s = s.replace(/\*([^*\n]+)\*/g, '$1')

  // 行级清理
  s = s
    .split('\n')
    .map((raw) => {
      let l = raw.replace(/\s+$/, '')
      // 纯路径行 → 占位（只认「整行就一个盘符路径」，句子里顺带提一句的路径不动）
      if (PATH_LINE_RE.test(l.trim())) return '（路径见文件）'
      l = l.replace(/^\s{0,3}#{1,6}\s*/, '') // # 标题
      l = l.replace(/^\s{0,3}>\s?/, '') // > 引用
      if (l.includes('|')) l = fixTableLine(l) // 表格
      l = fixListMarkers(l) // 列表前缀
      return l.replace(/^\s+/, '') // 行首缩进（QQ 里没意义，且会留一串空格）
    })
    .join('\n')

  // 收敛空行：三行以上压成一行空行；首尾空白去掉
  s = s.replace(/\n{3,}/g, '\n\n')
  s = s.replace(/[ \t]+\n/g, '\n')
  s = s.trim()

  s = restore(s, keep)
  return s
}

export default sanitizeOutbound
