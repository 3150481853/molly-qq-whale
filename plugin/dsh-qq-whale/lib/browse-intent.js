/**
 * 浏览意图识别（2026-10-28，主人拍板方案 A）。
 *
 * 背景：Molly 的聊天链路没有工具，只有「命令 」前缀进干活会话。主人要的是
 * 「不带命令也能让她去看看」——但**不能**把任意闲聊都送进干活会话：
 * 干活会话每次要几十秒、要花 token，还会污染长会话。所以这里只认两种
 * 「确定在看东西」的句式：
 *
 *   1. 消息里带 URL（且带看/读/讲/总结之类的词，或者整条消息基本就是链接）
 *   2. 提到具体站点（小黑盒/B站/抖音/小红书）+ 看/瞅/逛/刷/搜 之类的动词
 *
 * 判不出来一律返回 null，让消息照旧走聊天——宁可漏，不可错。
 *
 * 这个文件不依赖任何运行时，方便 `node --input-type=module` 直接单测。
 */

/** 站点表：名字、别名、首页、站内搜索模板。 */
export const BROWSE_SITES = [
  {
    name: '小黑盒',
    tags: ['小黑盒', 'xiaoheihe', 'xhh', '盒友', '小黑盒社区'],
    home: 'https://www.xiaoheihe.cn/app/bbs/home',
    search: (kw) => `https://www.xiaoheihe.cn/app/search/list?q=${encodeURIComponent(kw)}`,
  },
  {
    name: 'B站',
    tags: ['b站', 'bilibili', '哔哩哔哩', '小破站'],
    home: 'https://www.bilibili.com',
    search: (kw) => `https://search.bilibili.com/all?keyword=${encodeURIComponent(kw)}`,
  },
  {
    name: '抖音',
    tags: ['抖音', 'douyin', 'tiktok'],
    home: 'https://www.douyin.com',
    search: (kw) => `https://www.douyin.com/search/${encodeURIComponent(kw)}`,
  },
  {
    name: '小红书',
    tags: ['小红书', 'xhs', 'redbook'],
    home: 'https://www.xiaohongshu.com/explore',
    search: (kw) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(kw)}`,
  },
]

/** 看一眼/读一下这类动词。没有它就不算浏览意图（光提站名可能是闲聊）。 */
const LOOK_VERB_RE =
  /(看|读|瞧|瞅|打开|逛逛|逛一下|转转|刷|搜|查|找|总结|讲讲|说说|介绍|念一下|翻译|内容|标题|评论|说了啥|说啥|讲什么|讲了什么|写了啥|有什么|有啥)/u

/** 问她「自己能不能上网」不算让她上网。 */
const SELF_CAP_RE =
  /你(?:自己|这边)?(?:会不会|能不能|可不可以|是不是|有没有办法|有办法|有没网|有网没|有网吗)|你(?:能|会|可以)(?:上网|联网|看网页)|你能上网吗?/u

/**
 * 「发给别人/转出去」类动词：出现它们就说明这条消息不是让她看，
 * 而是让她转交，不能再抢（否则「把这个链接发给我妈」会被她拿去开浏览器）。
 */
const SEND_VERB_RE = /(发给|发到|转发|转给|分享给|传给|贴给|念给|读给|存一下|收藏)/u

/** 太长的消息（家常话/贴一大堆）不当作浏览意图。 */
const MAX_LEN = 120

/** 从消息里剥出第一个 http(s) 链接。 */
export function pickUrl(text) {
  const m = String(text || '').match(/https?:\/\/[^\s<>"'）)，。；、!?！？]+/i)
  return m ? m[0] : ''
}

/** 残余信息量够不够当关键词（太少就逛首页）。 */
const VAGUE_RE =
  /^(?:有|有什么|有啥|啥|什么|有意思|好玩|新鲜|热闹|最近|现在|当前|热门|推荐|帖子|视频|内容|东西|一下|看看|了|的|吧|呗|吗|呢|啊|呀|这|那|个|点)+$/u

/**
 * 从「去小黑盒搜一下 XX」这类句子里抠出关键词。
 * 抠不出来（只剩「有什么好玩的」这种）就返回空串 → 逛首页。
 *
 * 中文句子里的空格不可靠（「搜一下 抖音去水印」），所以先全部去掉，
 * 再用「循环剥掉开头/结尾的功能词」的办法逼近真正的关键词。
 */
export function extractKeyword(text, site) {
  let s = String(text || '')
  const aliases = [site.name, ...(site.tags || [])]
  for (const a of aliases) {
    if (!a) continue
    s = s.replace(new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ')
  }
  s = s
    .replace(/https?:\/\/[^\s<>"'）)，。；、!?！？]+/gi, ' ')
    .replace(/[\p{P}\p{S}\s]/gu, '')
    .trim()

  const LEAD_RE =
    /^(?:帮我|给我|麻烦|请|你|去|用|打开|看看|瞅瞅|瞅|瞧瞧|瞧|逛逛|逛|转转|刷刷|刷|搜一下|搜搜|搜索|搜|查一下|查查|查询|查|找一下|找找|找|读一读|读|念|总结|讲讲|讲|说说|说|关于|一下|今天|最近|现在|当前|有什么|有啥|什么|啥|有没有|有|首页|帖子|视频|内容|的|个|吧)/u
  const TAIL_RE = /(?:一下|一眼|看看|吧|呗|啊|呀|呢|嘛|吗|了|的|帖子|视频|首页|内容|东西)$/u
  for (let i = 0; i < 6; i += 1) {
    const before = s
    s = s.replace(LEAD_RE, '').replace(TAIL_RE, '')
    if (s === before) break
  }

  if (!s || s.length < 2 || s.length > 24) return ''
  if (VAGUE_RE.test(s)) return ''
  return s
}

/** 组装成给干活会话的任务文本（它会照这个去开浏览器）。 */
export function buildBrowseTask({ url, siteName, keyword }) {
  const head = [
    '用浏览器（bsk_session + bsk_page）打开下面这个页面，读完再回答。',
    `地址：${url}`,
  ].join('\n')
  const body = keyword
    ? [
        `这是${siteName}里搜「${keyword}」的结果页。`,
        '把前 5 条结果按「标题｜作者」一行一条列给我，不要链接、不要分点符号。',
        '如果页面要求登录或者内容没加载出来，先说一句「没打开/要登录」，再补上你看到的东西。',
      ].join('\n')
    : siteName === '链接'
      ? [
          '用你自己的话讲讲这页讲了什么：3 到 6 句，控制在 200 字以内。',
          '不要贴链接、不要分点、不要提「我搜索了/我查了」。',
          '如果页面要登录或者打不开，就直说打不开。',
        ].join('\n')
      : [
          `把${siteName}首页第一屏里的帖子/视频挑 5 条给我，每条「标题｜作者」，一行一条。`,
          '不要链接、不要分点符号；要等页面加载完（必要时往下滚一屏再读）。',
          '如果首页要求登录，先说一句要登录，再补上你能看到的东西。',
        ].join('\n')
  return [
    head,
    body,
    '结果直接说给我就行，不用你自己发 QQ；别用 qq_onebot。',
    '说完记得把浏览器关掉（bsk_session stop），别留窗口在那儿开着。',
  ].join('\n')
}

/**
 * 主入口：判断这条消息是不是「让她去看看」。
 * @returns {null | {task: string, why: string, url: string, siteName: string, keyword: string}}
 */
export function detectBrowseIntent(text) {
  const raw = String(text || '').trim()
  if (!raw || raw.length > MAX_LEN) return null
  if (SELF_CAP_RE.test(raw)) return null

  const url = pickUrl(raw)
  if (url) {
    const rest = raw.replace(url, '').trim()
    // 让她转交/存起来的链接不是「让她看」
    if (SEND_VERB_RE.test(raw)) return null
    // 只发一个链接（或链接 + 很短的话）也算；带了别的正经事就不抢
    if (!LOOK_VERB_RE.test(raw) && rest.length > 3) return null
    return {
      task: buildBrowseTask({ url, siteName: '链接', keyword: '' }),
      why: '消息里带链接',
      url,
      siteName: '链接',
      keyword: '',
    }
  }

  const low = raw.toLowerCase()
  const site = BROWSE_SITES.find((s) =>
    [s.name, ...(s.tags || [])].some((t) => t && low.includes(String(t).toLowerCase())),
  )
  if (!site) return null
  if (!LOOK_VERB_RE.test(raw)) return null

  const keyword = extractKeyword(raw, site)
  const url2 = keyword ? site.search(keyword) : site.home
  return {
    task: buildBrowseTask({ url: url2, siteName: site.name, keyword }),
    why: keyword ? `提到${site.name} + 关键词「${keyword}」` : `提到${site.name} + 看/逛类动词`,
    url: url2,
    siteName: site.name,
    keyword,
  }
}
