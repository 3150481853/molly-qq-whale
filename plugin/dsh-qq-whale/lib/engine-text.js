/**
 * engine-text.js —— 引擎里的「纯文本碎屑」。
 *
 * 拆出来的动机（Stage 3 Step 1）：这些东西没有 `this` 依赖，也没有副作用，
 * 只是几个字符串模板和字符串清理。它们散在 4000 行引擎里，读代码时要不停
 * 跳过，搬出来以后 `engine.js` 剩下的就全是真正的流程。
 *
 * 约定：
 *   - 全部纯函数：同样的输入 → 同样的输出（随机池用传入的 `rand`，不直接摸
 *     `Math.random`，这样快照机和单测都能钉死）；
 *   - 不 import 任何项目内模块，不读环境变量、不碰文件；
 *   - engine.js 里**保留同名方法做转发**（一行），调用点一个都不动——
 *     出问题时能立刻分辨是「搬家搬错了」还是「逻辑改了」。
 */

/**
 * 主人的称呼前缀（默认「主人，」）。
 *
 * 只给**唯一那个主人**加，审批人转发出去时用原文——以前把称呼硬拼进审批
 * 提示里，转发给审批人时对方也在被叫「主人」。
 *
 * @param {string|number} uin 收信人 QQ
 * @param {{owners?: string[], ownerTitle?: string}} ctx
 *   owners: 主人名单（第一个视为唯一主人）；ownerTitle: 配置里的称呼
 * @returns {string} 有称呼就返回它，否则空串
 */
export function titleFor(uin, { owners = [], ownerTitle = '' } = {}) {
  const list = (owners || []).map(String)
  const u = String(uin || '')
  return list[0] && list[0] === u ? String(ownerTitle ?? '') : ''
}

/** 限流兜底：用鱼的口气说一句，比沉默强。`rand` 可注入，默认 Math.random。 */
export function rateLimitLine(rand = Math.random) {
  const pool = [
    '等下……我这边嘴被堵住了，缓一会儿再跟你说',
    '白饭不够了，脑子转不动，容我歇一下',
    '唔，这会儿轮不上我说话，等会再讲',
  ]
  return pool[Math.floor(rand() * pool.length)]
}

/**
 * 模型整条链都没接住时，替她说一句（2026-10-27，主人 m02307）。
 *
 * 原话：「还是取消回不过来就不回的机制吧」。以前 `generate()` 遇到
 * ① 模型链全挂（`!res`）② 模型返回空正文（`parts.length === 0`）
 * 就直接 return null，调用方当成「这轮没话可说」→ 用户看到的是已读不回。
 *
 * 现在改成说一句短的：让她"卡了但还在"，而不是"人没了"。
 * 台词要符合人设——不道歉、不解释技术原因，就像人被打断了一下。
 * `rand` 可注入，默认 Math.random。
 */
export function modelDownLine(rand = Math.random) {
  const pool = [
    '等等，我刚刚走神了，你再说一遍？',
    '脑子卡了一下——刚那句我没接住',
    '诶？我这边断了一下，你把刚才那句再发我一次',
    '唔……让我把话咽回去再说一遍，你刚才说什么来着',
  ]
  return pool[Math.floor(rand() * pool.length)]
}

/**
 * 给 system prompt 打「降智」补丁。幂等：已经有就不重复加。
 *
 * 两个入口共用同一段话（预算超限的 buildSystemPrompt、限流转 trae 的
 * callWithFallback），以前②漏了导致降级回复被 maxTokens 从中间截断。
 */
export function withDegradedNote(system) {
  const s = String(system || '')
  if (s.includes('脑子转得比平时慢')) return s
  return (
    s +
    '\n\n# 现在的情况\n' +
    '你今天的白饭额度用完了，现在靠一点余粮撑着，脑子转得比平时慢。\n' +
    '所以：**说短一点，一句话能说完就别铺垫**。省着力气。'
  )
}

/**
 * 历史消息的说话人标签。
 *
 * 身份歧义是这里要消灭的东西，所以不做「当前说话人就不加标签」的省略：
 * 有名字和 QQ 号就都写出来，跟 system prompt 里的名册对齐。
 */
export function speakerLabel(h) {
  const who = String(h?.who || '').trim()
  const uid = String(h?.userId || '').trim()
  if (!who && !uid) return ''
  if (who && uid) return `${who}（QQ ${uid}）：`
  if (who) return `${who}：`
  return `QQ ${uid}：`
}

/** 找不到表情包时的兜底话术。`rand` 可注入，默认 Math.random。 */
export function stickerFallback(rand = Math.random) {
  const lines = [
    '（找图找了半天，没找到合适的）',
    '表情包找不到了，气死',
    '算了不发图了',
    '图库里没这张，我先记下来',
    '嗯…（翻遍图库）',
  ]
  return lines[Math.floor(rand() * lines.length)]
}

/**
 * 剥掉群名片上的「状态后缀」，拿到干净的基础名。
 *
 * 真机上出现过越叠越长的「Molly（在想…）（在想…）」——重载/崩溃后把上一次
 * 残留的后缀当成了基础名。剥到没有为止（上限 10 次防死循环）。
 *
 * @param {string} card 当前群名片
 * @param {{thinkingSuffix?: string}} [opts] 配置里的自定义后缀
 */
export function stripGroupCardSuffix(card, { thinkingSuffix } = {}) {
  const suffixes = [String(thinkingSuffix ?? '（在想…）'), '（在想…）']
  let out = String(card ?? '')
  let guard = 0
  let changed = true
  while (changed && guard < 10) {
    changed = false
    guard += 1
    for (const s of suffixes) {
      if (s && out.endsWith(s)) {
        out = out.slice(0, -s.length)
        changed = true
      }
    }
  }
  return out.trim()
}
