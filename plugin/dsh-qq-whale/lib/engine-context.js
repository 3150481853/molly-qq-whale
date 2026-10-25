/**
 * engine-context.js —— 「这一轮给模型看什么」（Stage 3 Step 3 从 engine.js 抽出）。
 *
 * 四个方法都是纯组装：读会话历史、拼 system prompt、把图下载成 data URL。
 * 它们**不持有状态**，全部依赖从 deps 进来的对象/回调 —— 文件里出现任何
 * 出现 `this` 关键字都算违规（tools/test-engine-context.mjs 里有一条断言盯着）。
 *
 * 依赖契约（调用方 engine.js 的 contextDeps() 提供）：
 *   persona / memory / relations / stickers / config / logger / client
 *   pestMode        boolean，本轮是否骂人模式（persona 决定拼不拼 pest 段）
 *   memberRoster    (conv) => string      群名册文本
 *   withDegradedNote(sp) => string        降智模式提示
 *   speakerLabel    (h) => string         说话人标签
 *   pickActivity    () => string          当前活动
 *   memoryWindow    { contextLimit, queryLimit, degradedContextLimit, degradedQueryLimit }
 *   degradedContextLimit  number
 *   sniffMime       (buf) => mime         图片魔数兜底
 *   gifContactSheet (buf, opts) => sheet  动图拆帧拼图（2026-10-26，主人 m04893）。
 *                                       传 null/不传 = 不拆帧、按旧行为只发原始 GIF。
 *
 * 这三条规矩来自 lead 的拆层要求：上下文层不许 import 决策层；不许把决策
 * 函数复制回 engine；不许用 this 挂「上一轮结论」让上下文自己来取——
 * 决策产物一律由编排层算好后当参数传进来。
 */

import { clockSection } from './clock.js'

export function buildSystemPrompt(input, deps) {
  const {
    scene,
    userName,
    qq = '',
    groupName,
    mood,
    conv,
    degraded = false,
    research = '',
    groupEcho = false,
  } = input
    let sp = deps.persona.systemPrompt({
      scene,
      selfNickname: deps.client?.self?.nickname || 'Molly',
      userName,
      groupName,
      mood,
      // 「骂人模式」总闸（task-37）：关掉时 persona 不会拼 pest-mode.md 那节，
      // 她对被骂对象就跟普通群友一样，不再有任何主动攻击的指令来源。
      pestMode: deps.pestMode === true,
    })

    /*
     * 刚查到的事实，塞进 system prompt。
     *
     * 措辞上刻意把它写成"你刚查到的"而不是"参考信息"——她要当成自己的
     * 知识用会自己的话说出来，而不是像念检索结果。同时还给了"查不准就
     * 别硬说"的退路：检索结果经常是过期或者答非所问，硬圆比承认不知道
     * 更难看。
     */
    if (research) {
      sp +=
        '\n\n# 你刚刚查到的\n' +
        research +
        '\n\n（这是你刚才自己上网查来的。用你自己的话讲，别原样复述，别提"搜索""资料"这些词。' +
        '如果这跟人家问的对不上、或者内容含糊，就说"这个我没查到"——' +
        '**注意：是这一个问题没查到，不是你不能查。别说"我上不了网""我没那功能"这种话。**）'
    }

    /*
     * 群发豁免（2026-10-24，主人 m00480 需求①）：对方明确要求、甚至第二次
     * 坚持「就在群里发」。core.md 那条「细节我私聊你说」这一轮要让路，但加
     * 两道约束：①长内容分条，别一坨；②隐私/凭据仍然不能贴。
     */
    if (groupEcho) {
      sp +=
        '\n\n# 这次要发在群里\n' +
        '对方明确要求、而且坚持要在这儿看到内容（不是私聊）。这次就直接在群里说，' +
        '别说"这个我私聊你""细节私聊"这种话。\n' +
        '- 内容长就拆成几条发，每条一两句，用 <sep/> 分隔——别一次塞一大段。\n' +
        '- 翻译、解释、原文照贴的活，把内容照实给出来，别省略、别只给结论。\n' +
        '- 隐私和凭据（手机号、身份证、密码、token、别人的私聊截图）仍然不能贴。'
    }

    /*
     * 降智模式（超了免费额度，走 trae）。
     *
     * 用户原话（m02427-2）：「trae 的模型量和速度都很小，你需要在使用 trae
     * 的时候降智」。所以这里不只是换模型，还要她自己知道"现在脑子不够用"——
     * 否则模型会按完整思路铺开长回复，然后被 maxTokens=512 从中间截断，
     * 发出去就是半句话，比不回复更难看。
     *
     * 明确让她**先说重点、砍长度**，是让截断发生在自然结束处而不是句子中间
     * 的唯一办法。
     */
    if (degraded) {
      sp = deps.withDegradedNote(sp)
    }

    /*
     * 现在时间（2026-10-26，主人 m05189-1「给鱼加一个能看时间的插件功能，要求北京时间」）。
     *
     * 每轮重新算、写进 system prompt：她原来只能靠猜，或者去调 engine 里那些
     * 业务时间（上班/睡觉/静默窗），被问「现在几点」时常常瞎编一个钟点。
     * 配置 timeContextEnabled=false 可以整段关掉；偏移走 timeOffsetMinutes，
     * 默认 480（UTC+8）。时区算法在 lib/clock.js 里纯函数实现，不看宿主时区。
     */
    if (deps.config?.timeContextEnabled !== false) {
      sp += `\n\n${clockSection(deps.now ? deps.now() : Date.now(), deps.config?.timeOffsetMinutes ?? 480)}`
    }

    // 记忆：这个人的 + 跟他相关关键词的
    // limit 走 memoryWindow（24/8，降智档 8/4），别在这里再写死数字——
    // 写死会让 memory.js 里的窗口调优完全失效（P5「记忆查询太短」就是这么来的）。
    const lastUserText = [...conv.history].reverse().find((h) => h.role === 'user')?.text || ''
    const memText = deps.memory.contextFor({
      who: userName,
      // qq 是唯一身份：群里有同名的人时，光靠名字会把别人的记忆读成他的
      qq,
      limit: degraded ? deps.memoryWindow.degradedContextLimit : deps.memoryWindow.contextLimit,
    })
    if (memText) {
      sp += `\n\n# 你记得的事\n${memText}`
    }
    // 关键词召回：最近说的话里有关键词，去记忆里捞相关的
    if (lastUserText) {
      const related = deps.memory
        .recall({
          qq,
          query: lastUserText.slice(0, 40),
          limit: degraded ? deps.memoryWindow.degradedQueryLimit : deps.memoryWindow.queryLimit,
        })
        .filter((e) => e.who !== userName && !(qq && String(e.qq || '') === String(qq)))
      if (related.length) {
        sp += `\n\n# 其他相关记忆\n${related.map((e) => `- ${e.text}`).join('\n')}`
      }
    }

    // 关系：你跟这人处到哪一步了。每轮都带上，它是语气的底噪。
    if (conv?.relationKey) {
      const relText = deps.relations.contextFor(conv.relationKey)
      if (relText) sp += `\n\n# 你俩的关系\n${relText}`
    }

    /*
     * 名册：谁是谁。
     *
     * 用户原话（m03865）：「让他根据 QQ 号识别成员，别把群聊当成私聊」。
     * 之前她只看到每句话前面挂个名字，名字一改就认不出来，于是说出
     * 「你们头像名字换来换去我眼花」「那我认错人了」这种话。
     * 现在把 QQ 号明明白白列出来，让她有的是硬身份可用。
     */
    const roster = deps.memberRoster(conv)
    if (roster) {
      sp +=
        '\n\n# 这里都有谁\n' +
        `${roster}\n` +
        '认人请认 QQ 号：名字（群名片/昵称）是随时会改的，QQ 号不会变。\n' +
        '有人换了名字，你可以顺口一提"你改名了？"，但别认错人。\n' +
        '同一个人在不同群可能挂不同名字，认号就行。\n' +
        /*
         * 说话人标签 + 定向回复（主人 m01935）。
         *
         * 事故形态：群里甲说了话，她回的时候把话安到乙头上，并且 @ 也落到乙身上。
         * 原因有两个——历史只标名字不标号，以及自动 @ 永远只 @ 最后一条消息的发
         * 送者。这两句就是给模型的用法说明：标签怎么读、要回别人时怎么指。
         */
        '下面群聊记录里，每句话前面写着「说话人（QQ 号）：」——那只是标明谁说的，' +
        '不是正文，你回话时别把这个前缀抄进去。\n' +
        '看记录时把话和 QQ 号对着记：谁说了什么就记在谁头上，别把甲说的话安到乙头上。\n' +
        '要回的人如果不是最后说话的那位，就在回复开头写 <at>他的QQ号</at>，代码会把它' +
        '换成真正的 @；回的就是最后说话那位时不用写，@ 会自动加上。\n' +
        /*
         * 引用回复（2026-10-25，主人 m02736 / m02835）。
         *
         * 真机事故①：一位成员发了张图，另一位成员只发了一条空的「@Molly」，她回那张图时
         * @ 却落到了后者头上——因为旧代码只会 @「触发回复的消息的发送者」。
         * 真机事故②：模型从群名册里挑错号，把甲说的那句话 @ 给了乙。
         *
         * 代码侧已经做了 @ 号校验（只认最近说过话的人）+ 条件引用（拥挤/纯叫醒时才引），
         * 这两句只是别让模型自己瞎写号、瞎编引用标记。
         */
        '如果对方只是 @ 了你、一个字没说，那不算你要回的人——你要接的是上一条你' +
        '看到的（或正被讨论的）消息，代码会自动引用那条，你不用写号。\n' +
        '引用是代码自动加的，别自己写"引用[数字]"这类东西；只有点名第三个人时才写 <at>。'
    }

    // 表情包目录
    const cat = deps.stickers.catalogText({ maxTags: 60 })
    if (cat) {
      /*
       * 这里不再写「别每句都发图」——那句话的副作用是让她基本不发图。
       * 现在图库有几十张，用户明确要求「学会用表情包代替回文字」（m03900），
       * 所以改成给一个**可执行的配额**：一轮 0~2 张，情绪到了就发。
       * 配额上限跟 splitReply 里的 maxStickersPerReply 保持一致，否则
       * 模型写了三张、代码只发两张，第三张的对白就断了。
       */
      const maxN = deps.config.maxStickersPerReply ?? 2
      sp +=
        `\n\n# 你的表情包库\n${cat}\n` +
        `发图用 <sticker>关键词</sticker>，关键词写画面内容。一轮最多 ${maxN} 张。\n` +
        /*
         * 「只能从标签里挑词」这句是实测加上的，不是啰嗦。
         *
         * tools/test-sticker-habit.mjs 第一次跑的时候，她写了 <sticker>抱抱</sticker>，
         * 而图库里那张图叫"撒娇_求抱_贴贴"——"抱抱"一个字都对不上，
         * 图发不出去，最后退化成一句"找图找了半天"。模型不知道自己
         * 造词和图库标签是两套词表，不提醒它就会一直造。
         *
         * 2026-10-21（P2）补了真实标签示例和「单独甩图也正常」：
         * 实测她只在句子后面挂图，从不单独发图；用户要的正是"随手甩一张"。
         */
        '关键词直接从上面对应的标签里挑（例如 无语、翻白眼、贴贴、震惊、离谱），别自己造词，造了会挑错图。\n' +
        '想甩图的时候不一定非得配字：单独发一张 <sticker>关键词</sticker> 也很自然，不算敷衍。\n' +
        '该发的时候：要表达的情绪说不清、想吐槽、想撒娇、接梗、斗图、别人已经在刷表情包。\n' +
        '不该发的时候：对方在问你正经问题，或者你正要给出结论和答案。'
    } else {
      sp += `\n\n# 表情包\n你的图库现在是空的，所以别用 <sticker> 标记。`
    }

    // 当前活动（给主动消息和"在干嘛"一个由头）
    sp += `\n\n# 刚刚你在\n${deps.pickActivity()}`
    return sp
}

export async function buildMessages(conv, norm, userName, { degraded = false } = {}, deps) {
    const msgs = []
    /*
     * 降智模式只喂最近若干条。
     *
     * 这不只是省钱：trae 那档模型上下文小、速度慢，喂满 40 条历史会让它
     * 想很久还答偏。砍到 12 条反而更像"刚聊到哪儿接得上"。
     */
    const start = degraded ? Math.max(0, conv.history.length - deps.degradedContextLimit) : 0

    /*
     * 哪几条历史带图？
     *
     * 旧实现是「只看最后一条」，且图来自 `norm`（本轮那条消息的参数）。
     * 这在真实使用里会丢图：群聊中 debounce 期间又来一条新消息时，
     * scheduleReply 会 abort 旧 job 用新的 norm 重来，新 norm 没有图 ——
     * 用户精心发的图就这么没了。现在改成从 history 条目自带的 images 取。
     *
     * 但也不能全带上：每张图都是真金白银的视觉 token，历史 40 条全塞图
     * 会让请求又慢又贵。折中方案：
     *   - 只取**最近 3 条**带图的历史；
     *   - 再往前的一律折成 [图片] 文字。
     * 这样一个图上连发几张、或者连着几轮都有图的场景都覆盖到了。
     */
    const MAX_IMAGE_ENTRIES = 3
    const imageIdx = []
    for (let i = conv.history.length - 1; i >= start && imageIdx.length < MAX_IMAGE_ENTRIES; i--) {
      const h = conv.history[i]
      if (h.role === 'user' && Array.isArray(h.images) && h.images.length > 0) imageIdx.push(i)
    }
    const wantImages = new Set(imageIdx)

    for (let i = start; i < conv.history.length; i++) {
      const h = conv.history[i]
      if (h.role === 'user') {
        // 说话人标签带上 QQ 号（见 speakerLabel 的注释）
        const label = deps.speakerLabel(h)
        const imgs = wantImages.has(i) ? await deps.loadImages(h.images) : []
        if (imgs.length > 0) {
          const parts = []
          // 图在前、文字在后：上游对「先看图再看问题」的识别率明显更高
          for (const im of imgs) parts.push({ type: 'image_url', image_url: { url: im.url } })
          // 动图拆过帧的话补一句说明，模型才知道这张大图是「按时间排的帧」。
          const gifNote = imgs.some((im) => im.gifFrames > 1)
            ? '（图中动图已拆成多帧拼成一张：每格左上角「n/N」是第几帧，按顺序看就是完整动作）'
            : ''
          // 纯图片消息也得带上标签，否则模型不知道这张图是谁发的
          parts.push({ type: 'text', text: label + (h.text || '[图片]') + gifNote })
          msgs.push({ role: 'user', content: parts })
        } else {
          msgs.push({ role: 'user', content: label + (h.text || '[图片]') })
        }
      } else {
        msgs.push({ role: 'assistant', content: h.text })
      }
    }
    return msgs
}

export function buildHistoryMessages(conv, userName = '', deps) {
    const msgs = []
    for (const h of conv.history || []) {
      if (h.role === 'user') {
        const label = deps.speakerLabel(h)
        msgs.push({ role: 'user', content: label + (h.text || '[图片]') })
      } else {
        msgs.push({ role: 'assistant', content: h.text })
      }
    }
    return msgs
}

export async function loadImages(images, deps) {
    const out = []
    for (const img of images.slice(0, 4)) {
      const url = img?.url || img?.file
      if (!url) continue
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 15000)
        const resp = await fetch(url, { signal: ctrl.signal })
        clearTimeout(timer)
        if (!resp.ok) continue
        const buf = Buffer.from(await resp.arrayBuffer())
        if (buf.length === 0 || buf.length > 8 * 1024 * 1024) {
          deps.logger('debug', `图片过大或为空，跳过（${buf.length}B）`)
          continue
        }
        // 从 content-type 推 mime；QQ 有时不返回，用魔数兜底
        let mime = resp.headers.get('content-type')?.split(';')[0] || ''
        if (!mime.startsWith('image/')) mime = deps.sniffMime(buf)

        /*
         * 动图（2026-10-26，主人 m04893）：她之前对 GIF/动画表情「只能看到首图」。
         * 不是 QQ 的问题，也不是下载的问题——多模态模型对 image/gif 本来就只
         * 解码第一帧。这里在发给模型之前把 GIF 采样成一张多帧拼图（PNG），
         * 一帧都不丢信息：模型能按帧号顺序看完整个动作。
         *
         * 拆帧放在 deps 里（engine 提供实现），本文件保持「只组装、不 import 能力」；
         * 没装 Python/Pillow 时 deps.gifContactSheet 自己返回 null，这里回退原图，
         * 降级但绝不影响这轮回复。
         */
        const cfg = deps.config || {}
        if (
          mime === 'image/gif' &&
          cfg.gifFramesEnabled !== false &&
          typeof deps.gifContactSheet === 'function'
        ) {
          const sheet = await deps.gifContactSheet(buf, {
            frames: cfg.gifFramesCount,
            columns: cfg.gifFramesColumns,
            frameWidth: cfg.gifFrameWidth,
            python: cfg.gifFramesPython,
            timeoutMs: cfg.gifFramesTimeoutMs,
          })
          if (sheet && sheet.png && sheet.png.length > 0) {
            out.push({
              url: `data:image/png;base64,${sheet.png.toString('base64')}`,
              frames: sheet.frames,
              gifFrames: sheet.gifFrames,
            })
            deps.logger('debug', `动图拆帧：共 ${sheet.gifFrames} 帧，取 ${sheet.frames} 帧拼成 ${sheet.width}x${sheet.height}`)
            continue
          }
        }

        out.push({ url: `data:${mime};base64,${buf.toString('base64')}`, frames: 1 })
      } catch (e) {
        deps.logger('debug', `图片下载失败，跳过：${e?.message || e}`)
      }
    }
    return out
}

/* 附：为什么 norm 参数没被删
 * buildMessages 的 norm 体内不使用（历史图来自 h.images），删了要改 6 个调用点。
 * 「调用点一个不改」优先于顺手清理，等编排层收尾时单独做。 */
