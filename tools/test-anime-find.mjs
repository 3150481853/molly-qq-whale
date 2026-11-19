// 搜番（2026-11-19，主人 m03315「把这个加进去」）
//
// 现场：Molly 原来只会 #茉莉识图（图 → 出处），没有「番名 → 评分/简介/磁力」。
// 这里只测**纯逻辑**：RSS 解析、体量换算、torrent → magnet、排版、候选排序、空输入，
// 一律不联网——这台机器的域名解析正被污染，联网用例只会变成随机失败。

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import {
  parseRssItems,
  parseSize,
  humanSize,
  magnetFromTorrent,
  shortMagnet,
  formatAnimeReport,
  animeFind,
  pickAnibtAnime,
  matchRank,
  rankCandidates,
  mergeMagnets,
  dedupeMagnets,
  magnetizeItems,
  buildAnimeTool,
  registerAnimeTool,
  ANIME_TOOL_NAME,
} from '../plugin/dsh-qq-whale/lib/anime-find.js'

let pass = 0
let fail = 0
async function t(name, fn) {
  try {
    await fn()
    pass += 1
    console.log(`  ok   ${name}`)
  } catch (err) {
    fail += 1
    console.log(`  FAIL ${name}\n       ${err?.message || err}`)
  }
}

console.log('体量换算：')

await t('1.5 GiB 按 1024 进制算', () => {
  assert.equal(parseSize('1.5 GiB'), Math.round(1.5 * 1024 ** 3))
})

await t('800 MB 按 1000 进制算', () => {
  assert.equal(parseSize('800 MB'), 800 * 1e6)
})

await t('看不懂的体量回 0，别抛', () => {
  assert.equal(parseSize(''), 0)
  assert.equal(parseSize('两集'), 0)
})

await t('humanSize 110.5 GB 不会被取整成 110', () => {
  assert.equal(humanSize(118603653120), '110.5 GB')
  assert.equal(humanSize(0), '')
})

console.log('RSS 解析：')

const ACG_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:torrent="http://xmlns.ezrss.it/0.1/"><channel>
  <item>
    <title>[VCB-Studio] Shingeki no Kyojin 10-bit 1080p HEVC BDRip</title>
    <pubDate>Thu, 09 Apr 2026 21:27:00 -0700</pubDate>
    <link>https://acg.rip/t/123456</link>
    <enclosure url="https://acg.rip/123456.torrent" length="1" type="application/x-bittorrent"/>
    <torrent:contentLength>118603653120</torrent:contentLength>
  </item>
  <item>
    <title>第二集</title>
    <enclosure url="https://acg.rip/2.torrent"/>
    <torrent:contentLength>800 MB</torrent:contentLength>
  </item>
</channel></rss>`

const NYAA_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:nyaa="https://nyaa.si/xmlns/nyaa"><channel>
  <item>
    <title><![CDATA[Bocchi the Rock S01 &amp; SP]]></title>
    <nyaa:size>4.8 GiB</nyaa:size>
    <link>magnet:?xt=urn:btih:<REDACTED>&amp;dn=Bocchi</link>
  </item>
</channel></rss>`

await t('acg.rip：体量认 contentLength，也认人类可读写法', () => {
  const items = parseRssItems(ACG_XML)
  assert.equal(items.length, 2)
  assert.equal(items[0].size, 118603653120)
  assert.equal(items[1].size, 800e6)
  assert.equal(items[0].enclosure, 'https://acg.rip/123456.torrent')
  assert.equal(items[0].magnet, '', '.torrent 不算 magnet')
})

await t('nyaa：nyaa:size 与 CDATA 里的 magnet 都要认', () => {
  const items = parseRssItems(NYAA_XML)
  assert.equal(items.length, 1)
  assert.equal(items[0].size, Math.round(4.8 * 1024 ** 3))
  assert.match(items[0].magnet, /^magnet:\?xt=urn:btih:A307/)
})

await t('CDATA 与实体要还原，别把 &amp; 原样发出去', () => {
  const items = parseRssItems(NYAA_XML)
  assert.equal(items[0].title, 'Bocchi the Rock S01 & SP')
})

await t('空 XML / 垃圾输入回空数组', () => {
  assert.deepEqual(parseRssItems(''), [])
  assert.deepEqual(parseRssItems(null), [])
  assert.deepEqual(parseRssItems('<rss></rss>'), [])
})

console.log('torrent → magnet：')

await t('infohash 等于 sha1(info 字典)', () => {
  const info = 'd6:lengthi12345e4:name4:teste'
  const torrent = Buffer.from(`d4:info${info}e`, 'binary')
  const magnet = magnetFromTorrent(torrent)
  const expect = crypto.createHash('sha1').update(info).digest('hex')
  assert.equal(magnet, `magnet:?xt=urn:btih:${expect}`)
})

await t('不是 torrent 就回空串，别编一个假 hash', () => {
  assert.equal(magnetFromTorrent(Buffer.from('hello world')), '')
})

console.log('压缩 magnet：')

await t('长 magnet 只留 infohash + 短 dn，几十个 tracker 全去掉', () => {
  const long =
    'magnet:?xt=urn:btih:<REDACTED>&dn=%5BBDrip%5D%20Bocchi%20the%20Rock%20S01%20%5Bktnbytes%5D&xl=5151058836&tr=udp%3A%2F%2Ftracker.one%3A1337&tr=udp%3A%2F%2Ftracker.two%3A1337'
  const short = shortMagnet(long)
  assert.match(short, /^magnet:\?xt=urn:btih:<REDACTED>/)
  assert.ok(short.length < 160, '别超过 160 字')
  assert.ok(!short.includes('tr='), 'tracker 全部去掉')
})

await t('压短：不是 magnet 就原样返回，别改坏普通链接', () => {
  const url = 'https://mikanime.tv/Download/x.torrent'
  assert.equal(shortMagnet(url), url)
  assert.equal(shortMagnet(''), '')
})

console.log('AniBT 条目（Bangumi 的备用腿）：')

await t('chinese/primary/rating/format 映射成同形条目', () => {
  const item = pickAnibtAnime({
    bgmId: 415779,
    title: { chinese: '进击的巨人 最终季 完结篇 后篇', primary: '進撃の巨人 The Final Season 完結編 後編' },
    rating: 7.6,
    format: 'TV',
    rssReleaseCount: 12,
    cover: 'https://anibt.net/x.jpg',
  })
  assert.equal(item.id, 415779)
  assert.equal(item.nameCn, '进击的巨人 最终季 完结篇 后篇')
  assert.equal(item.name, '進撃の巨人 The Final Season 完結編 後編')
  assert.equal(item.score, 7.6)
  assert.equal(item.platform, 'TV')
  assert.equal(item.resources, 12)
  assert.equal(item.votes, 0, 'AniBT 不给评分人数，别编一个')
  assert.equal(item.url, 'https://bgm.tv/subject/415779')
})

await t('没有标题的条目直接丢掉', () => {
  assert.equal(pickAnibtAnime(null), null)
  assert.equal(pickAnibtAnime({ title: {} }), null)
})

await t('只给 primary 时拿它当标题，没有 bgmId 就不拼假链接', () => {
  const item = pickAnibtAnime({ title: { primary: 'Shingeki no Kyojin' }, rating: 8 })
  assert.equal(item.nameCn, '')
  assert.equal(item.name, 'Shingeki no Kyojin')
  assert.ok(!String(item.url).includes('undefined'), '不能拼出 undefined')
})

console.log('候选排序：')

await t('matchRank：一模一样 > 前缀 > 包含 > 字都在 > 无关', () => {
  const it = { nameCn: '进击的巨人', name: '進撃の巨人' }
  assert.equal(matchRank(it, '进击的巨人'), 4)
  assert.equal(matchRank(it, '进击'), 3)
  assert.equal(matchRank(it, '巨人'), 2)
  assert.equal(matchRank({ nameCn: '进击的巨人传' }, '进击巨人'), 1)
  assert.equal(matchRank({ nameCn: '鬼灭之刃' }, '进击的巨人'), 0)
  assert.equal(matchRank(it, '   '), 0)
})

await t('rankCandidates：名字贴合的在前，TV 优先于 OAD', () => {
  const ranked = rankCandidates(
    [
      { nameCn: '进击的巨人 OAD', name: '', platform: 'OVA', score: 7.2 },
      { nameCn: '进击的巨人', name: '進撃の巨人', platform: 'TV', score: 8.9 },
      { nameCn: '鬼灭之刃', name: '', platform: 'TV', score: 8.1 },
    ],
    '进击的巨人',
  )
  assert.equal(ranked[0].nameCn, '进击的巨人')
  assert.equal(ranked[1].nameCn, '进击的巨人 OAD')
  assert.equal(ranked[2].nameCn, '鬼灭之刃')
})

await t('mergeMagnets：同一个 infohash 只留一条，按体积从大到小', () => {
  const a = { items: [{ title: 'A', magnet: 'magnet:?xt=urn:btih:AAAA&dn=a', size: 3e9 }], failed: ['源甲挂了'] }
  const b = {
    items: [
      { title: 'A 重复', magnet: 'magnet:?xt=urn:btih:aaaa&dn=a2', size: 3e9 },
      { title: 'B', magnet: 'magnet:?xt=urn:btih:BBBB', size: 8e9 },
    ],
    failed: [],
  }
  const merged = mergeMagnets(a, b)
  assert.equal(merged.items.length, 2)
  assert.equal(merged.items[0].title, 'B')
  assert.deepEqual(merged.failed, ['源甲挂了'])
})

console.log('排版：')

const SUBJECT = {
  id: 253,
  name: '進撃の巨人',
  nameCn: '进击的巨人',
  date: '2013-04-07',
  platform: 'TV',
  eps: 25,
  score: 9.04,
  votes: 41234,
  rank: 12,
  tags: ['热血', '战斗', '剧情'],
  summary: '一百多年前，世界上突然出现了人类的天敌「巨人」。'.repeat(12),
  url: 'https://bgm.tv/subject/253',
}

await t('条目 + 磁力：该有的行都在，简介被截断', () => {
  const text = formatAnimeReport(SUBJECT, {
    items: [{ source: 'ACG.RIP', title: '[VCB-Studio] Shingeki no Kyojin 1080p', size: 118603653120, magnet: 'magnet:?xt=urn:btih:DEAD' }],
    failed: [],
  })
  assert.match(text, /进击的巨人/)
  assert.match(text, /2013 年 · TV · 25 话/)
  assert.match(text, /Bangumi 9(\.0)? 分/)
  assert.match(text, /41234 人评分/)
  assert.match(text, /排名 #12/)
  assert.match(text, /简介：[\s\S]{100,}…/)
  assert.match(text, /magnet:\?xt=urn:btih:DEAD/)
})

await t('没条目时给的是人话，不是空白', () => {
  const text = formatAnimeReport(null, { items: [], failed: [] })
  assert.ok(text.length > 6, '不能是空串')
  assert.match(text, /没|找不到|没有/)
})

await t('磁力全挂时说明是哪些源挂了', () => {
  const text = formatAnimeReport(SUBJECT, { items: [], failed: ['动漫花园（timeout）'] })
  assert.match(text, /磁力/)
  assert.match(text, /动漫花园/)
})

await t('磁力最多给三条，别刷屏', () => {
  const items = Array.from({ length: 6 }, (_, i) => ({
    source: 'ACG.RIP',
    title: `资源 ${i}`,
    size: 1e9,
    magnet: `magnet:?xt=urn:btih:${i}`,
  }))
  const text = formatAnimeReport(SUBJECT, { items, failed: [] })
  assert.equal((text.match(/magnet:\?xt=urn:btih:/g) || []).length, 3)
})

await t('排版：AniBT 的分数不带「0 人评分」', () => {
  const text = formatAnimeReport(
    { nameCn: '进击的巨人 最终季', name: '進撃の巨人', platform: 'TV', score: 7.6, votes: 0, tags: [], url: 'https://bgm.tv/subject/1', source: 'AniBT' },
    { items: [], failed: [] },
  )
  assert.ok(!text.includes('0 人评分'), '不能写「0 人评分」')
  assert.match(text, /7\.6/)
})

await t('排版：同名候选收在「另外还有」一行', () => {
  const subject = {
    ...SUBJECT,
    alternatives: [
      { nameCn: '进击的巨人 OAD', platform: 'OVA', score: 7.2, resources: 3 },
      { nameCn: '进击的巨人 编年史', platform: 'MOVIE', score: 6.7, resources: 0 },
    ],
  }
  const text = formatAnimeReport(subject, { items: [], failed: [] })
  assert.match(text, /另外还有/)
  assert.match(text, /进击的巨人 OAD/)
  assert.match(text, /进击的巨人 编年史/)
})

console.log('入口：')

await t('空番名直接要名字，不联网', async () => {
  const res = await animeFind('   ')
  assert.equal(res.ok, false)
  assert.match(res.text, /番|名字/)
})

await t('工具名与参数形状对得上 qqtools 的约定', () => {
  const tool = buildAnimeTool({ getConfig: () => ({}) })
  assert.equal(tool.name, ANIME_TOOL_NAME)
  assert.equal(tool.name, 'anime_find')
  assert.deepEqual(tool.parameters.required, ['query'])
  assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['query', 'scope'])
  assert.equal(typeof tool.execute, 'function')
  assert.equal(typeof tool.output.render, 'function')
})

await t('工具描述里写清了「什么时候该主动调」——这是模糊触发的前提', () => {
  const tool = buildAnimeTool({})
  assert.match(tool.description, /怎么样/)
  assert.match(tool.description, /有没有资源/)
  assert.match(tool.description, /这是哪个番/)
})

await t('getConfig 抛错时工具不该跟着炸', () => {
  const tool = buildAnimeTool({
    getConfig: () => {
      throw new Error('boom')
    },
  })
  assert.equal(tool.name, 'anime_find')
})

await t('宿主没有 tools 服务：注册失败但不抛', () => {
  const res = registerAnimeTool({ ctx: {}, getConfig: () => ({}) })
  assert.equal(res.status.registered, false)
  assert.equal(res.dispose, null)
})

await t('注册成功后把 dispose 交回去', () => {
  let registered = null
  let disposed = false
  const ctx = {
    get: (name) =>
      name === 'tools'
        ? {
            register: (tool) => {
              registered = tool
              return () => {
                disposed = true
              }
            },
          }
        : null,
  }
  const res = registerAnimeTool({ ctx, getConfig: () => ({}) })
  assert.equal(res.status.registered, true)
  assert.equal(registered.name, 'anime_find')
  assert.equal(typeof res.dispose, 'function', 'register 给了 dispose 就要原样交回去')
  res.dispose()
  assert.equal(disposed, true)
})

console.log('磁力去重 / .torrent 换 magnet：')

await t('dedupeMagnets：同标题同体积只留一条，优先留带 magnet 的', () => {
  const out = dedupeMagnets([
    { title: '[A] 进击 1080p', size: 1e9, torrent: 'https://x/1.torrent' },
    { title: '[A] 进击 1080p', size: 1e9, magnet: 'magnet:?xt=urn:btih:AA' },
    { title: '[B] 进击 720p', size: 2e8, torrent: 'https://x/2.torrent' },
  ])
  assert.equal(out.length, 2, '重复那条要并掉')
  assert.match(out[0].magnet, /btih:AA/, '留下带 magnet 的那条')
})

await t('magnetizeItems：.torrent 换成真 magnet，转不出来就留链接', async () => {
  const info = 'd6:lengthi999e4:name3:abce'
  const torrentBuf = Buffer.from(`d4:info${info}e`, 'binary')
  const good = 'https://x/good.torrent'
  const bad = 'https://x/bad.torrent'
  const res = await magnetizeItems(
    {
      items: [
        { title: '好种子', size: 3e9, torrent: good },
        { title: '坏种子', size: 2e9, torrent: bad },
        { title: '本来就是 magnet', size: 1e9, magnet: 'magnet:?xt=urn:btih:FEED' },
      ],
      failed: [],
    },
    {
      fetchImpl: async (url) => {
        if (url === good) return torrentBuf
        throw new Error('404')
      },
    },
  )
  const expect = crypto.createHash('sha1').update(info).digest('hex')
  assert.equal(res.items.find((i) => i.title === '好种子').magnet, `magnet:?xt=urn:btih:${expect}`)
  const badItem = res.items.find((i) => i.title === '坏种子')
  assert.equal(badItem.magnet, undefined, '转不出来就别编')
  assert.equal(badItem.torrent, bad, '原链接要留着')
  assert.equal(res.items.find((i) => i.title === '本来就是 magnet').magnet, 'magnet:?xt=urn:btih:FEED')
})

await t('排版：中文名和原名一样时只写一遍，不排「《X / X》」', () => {
  const text = formatAnimeReport(
    { nameCn: '进击的巨人', name: '进击的巨人', score: 8.2, votes: 0, tags: [], url: 'https://bgm.tv/subject/55770', source: 'AniBT' },
    { items: [], failed: [] },
  )
  assert.match(text, /《进击的巨人》/)
  assert.ok(!text.includes('进击的巨人 / 进击的巨人'), '不许重复')
})

console.log(`\n${pass} 过 / ${fail} 挂`)
process.exit(fail === 0 ? 0 : 1)
