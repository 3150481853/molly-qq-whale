/*
 * anime-find.js —— 「搜番」：报个番名，回来处、评分、简介和磁力。
 *
 * 为什么要新写一个文件，而不是塞进 web.js / research.js：
 *   1. 这是「查资料」里最具体的一类，输入输出都很固定（番名进，结论出），
 *      放进通用检索里只会把 prompt 撑大；
 *   2. 它要自己管网络（直连 / 系统代理 / 公共中继三条腿），这套东西跟
 *      聊天主链路无关，出问题只该让这一个工具不可用；
 *   3. 零依赖、ESM——仓库的 AGENTS.md 写死了，不引 npm 包。
 *
 * 用户 2026-11-19 的原话（m03315）：
 *   「我记得之前有给Molly做一个搜图功能吧，你看看能不能把这个加进去？」
 * 截图里那个 DSH 插件（@cocofhu/anime-find）做的是同一件事：多源搜番、
 * 卡片展示 Bangumi 评分与详情、能复制磁力。QQ 里没有「复制」，所以这里的
 * 磁力直接给可点的 magnet: 链接（QQ 客户端会识别）。
 *
 * 今天这台机器的实情（2026-11-19 实测，写在这里免得下次重新踩）：
 *   - 直连：baidu 200/0.2s、github 200/8s，但 api.bgm.tv / acg.rip /
 *     nyaa.si / share.dmhy.org 的域名解析全被污染成假 IP（<REDACTED>、
 *     <REDACTED>、<REDACTED> …），Node 的 fetch 一律 TypeError；
 *   - 阿里 DoH（<REDACTED>）对这些域名同样返回假 IP，公共 DoH（<REDACTED> /
 *     dns.google / quad9）直接连不上；
 *   - 用户级代理 http://127.0.0.1:12450 当时**没在监听**（代理软件是
 *     <REDACTED>\SakuraCat，被 G 盘那场硬件故障连带搞挂了）；
 *   - 唯一还通的兜底是公共 CORS 中继 https://api.cors.lol/?url=…，但它
 *     按 IP 限速，连续几发就 429（所以下面所有结果都要落盘缓存）。
 * 结论：默认走「配置里的代理 → 直连 → 中继」三条腿，代理回来就一劳永逸。
 */

import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import https from 'node:https'
import tls from 'node:tls'
import crypto from 'node:crypto'
import { URL } from 'node:url'

/** 工具名。注册进宿主 tools 服务后，模型在聊天里就能自己调。 */
export const ANIME_TOOL_NAME = 'anime_find'

const UA = 'molly-qq-whale/1.1.8 (+https://github.com/3150481853/molly-qq-whale)'
/** 公共中继：把目标 URL 整个塞进 ?url= 。它限速，只当最后一条腿。 */
const RELAY = 'https://api.cors.lol/?url='
const DEFAULT_TIMEOUT_MS = 12000
const DEFAULT_PROXY = 'http://127.0.0.1:12450'
/** 搜索结果缓存多久（毫秒）。番名 → 结论在半小时内基本不会变。 */
const CACHE_TTL_MS = 30 * 60 * 1000

/* ───────────────────────── 小缓存（进程内 + 落盘） ───────────────────────── */

let cacheDir = ''
const memCache = new Map()

/**
 * 指定缓存目录（一般是 <dataDir>/anime）。
 * 没指定也能用，只是不落盘——插件重载就丢，别的地方都还能跑。
 */
export function setAnimeCacheDir(dir) {
  try {
    cacheDir = dir ? String(dir) : ''
    if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true })
  } catch {
    cacheDir = ''
  }
}

function cacheKey(kind, key) {
  return `${kind}:${crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 16)}`
}

function cacheRead(kind, key) {
  const k = cacheKey(kind, key)
  const hit = memCache.get(k)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value
  if (!cacheDir) return null
  try {
    const file = path.join(cacheDir, `${k.replace(':', '_')}.json`)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (raw && Date.now() - Number(raw.at || 0) < CACHE_TTL_MS) {
      memCache.set(k, { at: raw.at, value: raw.value })
      return raw.value
    }
  } catch {
    /* 缓存坏了就当没有 */
  }
  return null
}

function cacheWrite(kind, key, value) {
  const k = cacheKey(kind, key)
  const at = Date.now()
  memCache.set(k, { at, value })
  if (!cacheDir) return
  try {
    const file = path.join(cacheDir, `${k.replace(':', '_')}.json`)
    fs.writeFileSync(file, JSON.stringify({ at, value }), 'utf8')
  } catch {
    /* 写不进去不影响主链路 */
  }
}

/* ───────────────────────────── 网络：三条腿 ───────────────────────────── */

/**
 * 直连一次 https（GET）。
 *
 * @returns {Promise<{status:number, body:string, headers:object}>}
 */
function directGet(url, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, method = 'GET', body = null, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const mod = u.protocol === 'http:' ? http : https
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: `${u.pathname}${u.search}`,
        method,
        headers: {
          'User-Agent': UA,
          Accept: '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          ...headers,
          ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const buf = Buffer.concat(chunks)
          resolve({ status: res.statusCode || 0, body: binary ? buf : buf.toString('utf8'), headers: res.headers })
        })
      },
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`timeout ${timeoutMs}ms`)))
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

/**
 * 经 HTTP 代理（CONNECT 隧道）拿一次 https。
 *
 * 只支持 http:// 形式的代理（SakuraCat / Clash 默认都是这种），不折腾 SOCKS。
 */
function proxyGet(url, proxy, { timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const p = new URL(proxy)
    const host = target.hostname
    const port = Number(target.port || 443)

    const connectReq = http.request({
      host: p.hostname,
      port: Number(p.port || 80),
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}`, 'Proxy-Connection': 'keep-alive' },
      timeout: timeoutMs,
    })

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy()
        reject(new Error(`proxy CONNECT ${res.statusCode}`))
        return
      }
      const tlsSocket = tls.connect({ socket, servername: host }, () => {
        const head = [
          `${method} ${target.pathname}${target.search} HTTP/1.1`,
          `Host: ${host}`,
          `User-Agent: ${UA}`,
          'Accept: */*',
          'Accept-Language: zh-CN,zh;q=0.9,en;q=0.8',
          'Connection: close',
          ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
          ...(body ? [`Content-Length: ${Buffer.byteLength(body)}`] : []),
          '',
          body || '',
        ].join('\r\n')
        tlsSocket.write(head)
      })

      const chunks = []
      tlsSocket.on('data', (c) => chunks.push(c))
      tlsSocket.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        const sep = raw.indexOf('\r\n\r\n')
        if (sep < 0) {
          reject(new Error('proxy: 报文不完整'))
          return
        }
        const headText = raw.slice(0, sep)
        const status = Number((headText.match(/^HTTP\/\d\.\d (\d{3})/) || [])[1] || 0)
        const headerObj = {}
        for (const line of headText.split('\r\n').slice(1)) {
          const i = line.indexOf(':')
          if (i > 0) headerObj[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
        }
        let payload = raw.slice(sep + 4)
        // 极简 chunked 解码：真实场景里 cors/中继都会用 chunked
        if (String(headerObj['transfer-encoding'] || '').toLowerCase().includes('chunked')) {
          payload = dechunk(payload)
        }
        resolve({ status, body: payload, headers: headerObj })
      })
      tlsSocket.on('error', reject)
      tlsSocket.setTimeout(timeoutMs, () => tlsSocket.destroy(new Error(`timeout ${timeoutMs}ms`)))
    })

    connectReq.on('timeout', () => connectReq.destroy(new Error(`proxy timeout ${timeoutMs}ms`)))
    connectReq.on('error', reject)
    connectReq.end()
  })
}

/** chunked 解码（只处理十六进制长度 + CRLF 的常规形态）。 */
function dechunk(text) {
  let rest = text
  let out = ''
  for (;;) {
    const nl = rest.indexOf('\r\n')
    if (nl < 0) break
    const size = parseInt(rest.slice(0, nl).trim(), 16)
    if (!Number.isFinite(size) || size <= 0) break
    out += rest.slice(nl + 2, nl + 2 + size)
    rest = rest.slice(nl + 2 + size + 2)
  }
  return out
}

/**
 * 带三条腿的 GET：代理 → 直连 → 公共中继。
 *
 * 顺序刻意如此：用户把代理开回来时最省事，直连是理想情况，中继最慢且限速。
 * 任何一条腿抛错就换下一条，全部失败才把最后一条的错误抛出去。
 *
 * @param {string} url
 * @param {object} opts
 * @param {string} [opts.proxy]       HTTP 代理地址；空串表示不用代理
 * @param {number} [opts.timeoutMs]
 * @param {object} [opts.headers]
 * @param {string} [opts.method]
 * @param {string|null} [opts.body]
 * @returns {Promise<{status:number, body:string, via:string}>}
 */
export async function fetchAny(
  url,
  { proxy, timeoutMs = DEFAULT_TIMEOUT_MS, headers = {}, method = 'GET', body = null, preferDirect = false } = {},
) {
  const errors = []
  const direct = ['direct', () => directGet(url, { timeoutMs, headers, method, body })]
  const viaProxy = proxy ? [['proxy', () => proxyGet(url, proxy, { timeoutMs, headers, method, body })]] : []
  // 墙内的站（蜜柑、花园、AniBT）直连更快；先直连能省掉一次必然失败的握手
  const legs = preferDirect ? [direct, ...viaProxy] : [...viaProxy, direct]
  // 中继只支持 GET，而且目标必须整段编码
  if (method === 'GET') {
    legs.push([
      'relay',
      () => directGet(RELAY + encodeURIComponent(url), { timeoutMs: timeoutMs + 6000, headers }),
    ])
  }

  for (const [via, run] of legs) {
    try {
      const res = await run()
      if (res.status >= 200 && res.status < 400) return { ...res, via }
      errors.push(`${via}: HTTP ${res.status}`)
    } catch (err) {
      errors.push(`${via}: ${err?.message || err}`)
    }
  }
  const err = new Error(`取不到 ${new URL(url).host}（${errors.join('；')}）`)
  err.attempts = errors
  throw err
}

/** fetchAny + JSON 解析。 */
export async function fetchJson(url, opts = {}) {
  const res = await fetchAny(url, {
    ...opts,
    headers: { Accept: 'application/json', ...(opts.headers || {}) },
  })
  try {
    return JSON.parse(res.body)
  } catch {
    throw new Error(`返回的不是 JSON（${res.via} · HTTP ${res.status}）：${res.body.slice(0, 120)}`)
  }
}

/** 给一个可能卡住的 Promise 加硬上限：超时就算它失败，别拖着整条回复。 */
function withDeadline(promise, ms, label) {
  let timer = null
  promise.catch(() => {}) // 输了之后它自己再失败，也别变成未捕获异常
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

/* ───────────────────────────── Bangumi ───────────────────────────── */

/** Bangumi 的条目（subject）基础字段裁剪：只留下回复里用得上的。 */
function pickSubject(raw) {
  if (!raw || !raw.id) return null
  const rating = raw.rating || {}
  return {
    id: Number(raw.id),
    name: String(raw.name || ''),
    nameCn: String(raw.name_cn || raw.name_cn === '' ? raw.name_cn || '' : ''),
    date: String(raw.date || ''),
    eps: Number(raw.eps || raw.total_episodes || 0) || 0,
    platform: String(raw.platform || ''),
    summary: String(raw.summary || ''),
    score: Number(rating.score || 0) || 0,
    rank: Number(rating.rank || 0) || 0,
    votes: Number(rating.total || 0) || 0,
    tags: Array.isArray(raw.tags) ? raw.tags.slice(0, 6).map((t) => String(t?.name ?? t)).filter(Boolean) : [],
    url: `https://bgm.tv/subject/${raw.id}`,
  }
}

/**
 * 按番名搜 Bangumi，返回候选条目（已含评分/简介等详情）。
 *
 * 两套接口都试：v0 的 POST 搜索信息最全；老接口 GET 更宽松（v0 偶尔 429/404）。
 */
export async function searchBangumi(query, { proxy, timeoutMs, limit = 3 } = {}) {
  const q = String(query || '').trim()
  if (!q) return []
  const cached = cacheRead('bgm', q)
  if (cached) return cached

  const found = []
  // ① v0 搜索
  try {
    const res = await fetchAny('https://api.bgm.tv/v0/search/subjects?limit=10', {
      proxy,
      timeoutMs,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword: q, filter: { type: [2] } }),
    })
    const json = JSON.parse(res.body)
    for (const item of json?.data || []) {
      const hit = pickSubject(item)
      if (hit) found.push(hit)
      if (found.length >= limit) break
    }
  } catch {
    /* 换老接口 */
  }

  // ② 老接口（顺带兜住 v0 全挂的情况）
  if (found.length === 0) {
    try {
      const url = `https://api.bgm.tv/search/subject/${encodeURIComponent(q)}?type=2&responseGroup=small&max_results=${limit}`
      const json = await fetchJson(url, { proxy, timeoutMs })
      for (const item of json?.list || []) {
        const hit = pickSubject(item)
        if (hit) found.push(hit)
      }
    } catch {
      /* 两条都挂了就返回空，由调用方给人话 */
    }
  }

  // ①/② 给的都是列表字段，评分/简介常常缺，补一次详情
  for (let i = 0; i < found.length; i += 1) {
    if (found[i].score > 0 && found[i].summary) continue
    try {
      const detail = await fetchJson(`https://api.bgm.tv/v0/subjects/${found[i].id}`, { proxy, timeoutMs })
      const merged = pickSubject({ ...detail, id: found[i].id })
      if (merged) found[i] = merged
    } catch {
      /* 详情失败就用手上这份 */
    }
  }

  if (found.length > 0) cacheWrite('bgm', q, found)
  return found
}

/* ───────────────────────────── AniBT ───────────────────────────── */

const ANIBT_API = 'https://anibt.net/api/seasons/anime'

/**
 * 按番名搜 AniBT（自带 Bangumi 条目号 + 评分 + 当季资源数）。
 *
 * 为什么把 AniBT 放在 Bangumi 前面：api.bgm.tv 在这台机器上被 DNS 污染，
 * 直连、公共 DoH、阿里 DoH 全拿回来假 IP；AniBT 的接口是直连可用的，
 * 而且它自己就聚合了 Bangumi 的分数，所以「评分」这件事不依赖 Bangumi 也能办成。
 */
export async function searchAnibt(query, { proxy, timeoutMs } = {}) {
  const q = String(query || '').trim()
  if (!q) return []
  const cached = cacheRead('anibt', q)
  if (cached) return cached

  const json = await fetchJson(`${ANIBT_API}?query=${encodeURIComponent(q)}`, { proxy, timeoutMs })
  const out = []
  const seen = new Set()
  for (const day of json?.data?.byWeekday || []) {
    for (const a of day?.animes || []) {
      const item = pickAnibtAnime(a)
      if (!item) continue
      const key = item.id ? `b:${item.id}` : `t:${item.nameCn || item.name}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(item)
    }
  }
  if (out.length > 0) cacheWrite('anibt', q, out)
  return out
}

/** AniBT 的一条 anime JSON → 与 Bangumi 同形的条目（丢掉「—」「空数组」这类噪音）。 */
export function pickAnibtAnime(raw) {
  if (!raw) return null
  const titleCn = String(raw?.title?.chinese || '').trim()
  const titleOrig = String(raw?.title?.primary || '').trim()
  const title = titleCn || titleOrig
  if (!title) return null
  const bgmId = Number(raw?.bgmId || 0) || 0
  return {
    id: bgmId,
    name: titleOrig || title,
    nameCn: titleCn || '',
    date: '',
    eps: 0,
    platform: String(raw?.format || ''),
    summary: '',
    score: Number(raw?.rating || 0) || 0,
    rank: 0,
    votes: 0,
    tags: [],
    cover: String(raw?.cover || ''),
    resources: Number(raw?.rssReleaseCount || 0) || 0,
    url: bgmId ? `https://bgm.tv/subject/${bgmId}` : 'https://anibt.net',
    source: 'AniBT',
  }
}

/** 这个词和这个番名有多对得上：4 完全一样、3 前缀、2 包含、1 每个字都出现。 */
export function matchRank(item, query) {
  const k = String(query || '').trim().toLowerCase()
  if (!k) return 0
  const titles = [item?.nameCn, item?.name].filter(Boolean).map((t) => String(t).toLowerCase())
  if (titles.some((t) => t === k)) return 4
  if (titles.some((t) => t.startsWith(k))) return 3
  if (titles.some((t) => t.includes(k))) return 2
  const chars = [...k].filter((c) => !/\s/.test(c))
  if (chars.length > 0 && chars.every((c) => titles.some((t) => t.includes(c)))) return 1
  return 0
}

/**
 * 把候选条目按「像不像用户问的那部」排一遍。
 *
 * 同一部番在 AniBT 上会拆成 OAD / 剧场版 / 最终季好几条，直接全列出来等于刷屏，
 * 所以先按名字贴合度、再优先 TV、再看资源数和评分。
 */
export function rankCandidates(list, query) {
  const items = Array.isArray(list) ? list.slice() : []
  const formatPref = (it) => (/^(tv|web)$/i.test(String(it?.platform || '')) ? 2 : 1)
  return items.sort((a, b) => {
    const d = matchRank(b, query) - matchRank(a, query)
    if (d !== 0) return d
    const f = formatPref(b) - formatPref(a)
    if (f !== 0) return f
    const r = (b?.resources || 0) - (a?.resources || 0)
    if (r !== 0) return r
    const s = (b?.score || 0) - (a?.score || 0)
    if (s !== 0) return s
    return String(a?.nameCn || a?.name || '').length - String(b?.nameCn || b?.name || '').length
  })
}

/**
 * AniBT 的资源组：给的是**真 magnet**，不用自己下 .torrent 再算 infohash。
 *
 * 不是每部番都有（AniBT 没收录的字幕组就没有），空数组就照旧退回 RSS 那份。
 */
/**
 * 标题相似度 + 模糊回退（2026-11-26 真机，群 666666666）：
 *
 * 群友把番名说成「我是爱上心人所托来做恋爱迷情药的魔女」，真名是
 * 「你好，我是受心上人所托来做恋爱药的魔女。」。AniBT 的搜索是**字面子串**匹配
 * （实测同一台机器：「魔女」→50 条、「恋爱药的魔女」→1 条，而错两个字就 0 条），
 * Bangumi 在这台机器上又连不上（bgm.tv 被污染），于是她只能回「没查到」。
 *
 * 所以：正路空手时，用「末段关键词」粗搜一遍，再按
 *   「候选标题里有多少字出现在提问里」（covTitle）
 * 与「提问里有多少字被候选标题覆盖」（covQuery）取平均打分，够 0.55 才认。
 */
export function titleOverlap(item, query) {
  const clean = (s) => String(s || '').replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '')
  const title = clean(item?.nameCn || item?.name || '')
  const q = clean(query)
  if (!title || !q) return 0
  const inQ = new Set([...q])
  const seen = new Set()
  let hit = 0
  for (const ch of title) {
    if (seen.has(ch)) continue
    seen.add(ch)
    if (inQ.has(ch)) hit += 1
  }
  const covTitle = seen.size ? hit / seen.size : 0
  const covQuery = inQ.size ? hit / inQ.size : 0
  return (covTitle + covQuery) / 2
}

/** 从一整句描述里抠几个「末段关键词」候选（越靠后的词越有辨识度） */
export function fuzzyKeywords(query) {
  const q = String(query || '')
  const runs = q.match(/[\p{Script=Han}]{2,}/gu) || []
  const out = []
  const push = (s) => {
    const v = String(s || '').trim()
    if (v.length >= 2 && !out.includes(v)) out.push(v)
  }
  for (const r of runs) {
    for (const len of [4, 3, 2]) if (r.length >= len) push(r.slice(-len))
    if (r.length > 4) push(r.slice(0, 4))
  }
  return out.slice(0, 3)
}

/** 模糊回退：拿关键词粗搜 AniBT，再按相似度筛，返回带 _fuzzy 标记的条目 */
export async function fuzzyAnibt(query, { proxy, timeoutMs, minScore = 0.55 } = {}) {
  const seen = new Set()
  const pool = []
  for (const kw of fuzzyKeywords(query)) {
    let hits = []
    try {
      hits = await searchAnibt(kw, { proxy, timeoutMs: Math.min(timeoutMs || DEFAULT_TIMEOUT_MS, 8000) })
    } catch {
      continue
    }
    for (const h of hits) {
      const key = String(h?.id || h?.name || '')
      if (!key || seen.has(key)) continue
      seen.add(key)
      const score = titleOverlap(h, query)
      if (score >= minScore) pool.push({ ...h, _score: score, _fuzzy: true })
    }
  }
  return pool
    .sort((a, b) => (b._score - a._score) || ((b.resources || 0) - (a.resources || 0)))
    .slice(0, 6)
}

export async function searchAnibtMagnets(bgmId, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const id = String(bgmId || '').trim()
  if (!/^\d+$/.test(id)) return []
  const cached = cacheRead('anibt-magnet', id)
  if (cached) return cached

  const json = await fetchJson(`https://anibt.net/api/anime/groups?bgmId=${encodeURIComponent(id)}`, {
    timeoutMs,
    preferDirect: true,
  })
  const items = []
  for (const g of json?.data?.groups || []) {
    for (const it of g?.items || []) {
      const magnet = String(it?.magnet || '')
      const title = String(it?.title || '')
      if (!magnet || !title) continue
      items.push({
        source: 'AniBT',
        subgroup: String(g?.name || ''),
        title,
        magnet,
        torrent: '',
        page: '',
        size: it?.formatSize ? parseSize(it.formatSize) : Number(it?.size || 0) || 0,
        date: it?.publishedAt || '',
      })
    }
  }
  if (items.length > 0) cacheWrite('anibt-magnet', id, items)
  return items
}

/**
 * 把几份磁力结果拼成一份：按 infohash 去重（同一个种子两个源都有，别列两遍），
 * 再按体积从大到小排。
 */
export function mergeMagnets(...lists) {
  const items = []
  const failed = []
  const seen = new Set()
  for (const list of lists) {
    for (const it of list?.items || []) {
      const hash = /urn:btih:([0-9a-z]+)/i.exec(it?.magnet || '')?.[1]?.toLowerCase()
      const key = hash || String(it?.magnet || it?.torrent || it?.title || '').slice(0, 80)
      if (seen.has(key)) continue
      seen.add(key)
      items.push(it)
    }
    for (const f of list?.failed || []) failed.push(f)
  }
  items.sort((a, b) => (b.size || 0) - (a.size || 0))
  return { items, failed }
}

/* ───────────────────────────── 磁力源 ───────────────────────────── */

/** 把 12.3 GB / 800 MB 这种人类可读的体量算成数字（字节）。 */
export function parseSize(text) {
  const m = String(text || '').match(/([\d.]+)\s*(TiB|GiB|MiB|KiB|TB|GB|MB|KB|B)/i)
  if (!m) return 0
  const n = Number(m[1])
  const unit = m[2].toUpperCase()
  const scale = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 }
  return Math.round(n * (scale[unit] || 0))
}

/** 字节数 → 「12.3 GB」。 */
export function humanSize(bytes) {
  const n = Number(bytes) || 0
  if (n <= 0) return ''
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  // 整数就不显示小数点（800 MB），否则一位小数（110.5 GB）
  return `${Number.isInteger(v) ? v : v.toFixed(1)} ${units[i]}`
}

/** 从一段 RSS/XML 里抠 <item>，只做正则级的解析（零依赖，够用）。 */
export function parseRssItems(xml) {
  const items = []
  const re = /<item\b[\s\S]*?<\/item>/gi
  let m
  while ((m = re.exec(String(xml || '')))) {
    const block = m[0]
    const pick = (tag) => {
      const r = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(block)
      return r ? decodeEntities(stripCdata(r[1])) : ''
    }
    const enclosure = (/<enclosure\b[^>]*url=["']([^"']+)["']/i.exec(block) || [])[1] || ''
    const link = pick('link')
    const sizeText = pick('nyaa:size') || pick('torrent:contentLength') || ''
    items.push({
      title: pick('title'),
      link,
      enclosure,
      pubDate: pick('pubDate'),
      size: Number(sizeText) > 1000 ? Number(sizeText) : parseSize(sizeText),
      magnet: /^magnet:/i.test(enclosure) ? enclosure : /^magnet:/i.test(link) ? link : '',
    })
  }
  return items
}

function stripCdata(s) {
  return String(s).replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '')
}

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

/**
 * 跳过一段 bencode，返回它结束后的下标。
 *
 * 只做「跳过」，不解析内容——算 infohash 只需要 info 字典的原始字节。
 * 必须区分字典/列表/整数/字符串四种前缀：整数的数字串后面跟 `e`，
 * 字符串的数字串后面跟 `:`，混在一起就会把 `i12345e` 当成字符串读飞。
 */
function skipBencode(data, i) {
  const c = data[i]
  if (c === 0x64 /* d */ || c === 0x6c /* l */) {
    i += 1
    for (;;) {
      if (i >= data.length) return data.length
      if (data[i] === 0x65 /* e */) return i + 1
      const next = skipBencode(data, i)
      if (next <= i) return data.length
      i = next
    }
  }
  if (c === 0x69 /* i */) {
    i += 1
    while (i < data.length && data[i] !== 0x65) i += 1
    return i + 1
  }
  let j = i
  while (j < data.length && data[j] !== 0x3a /* : */) j += 1
  const len = Number(data.slice(i, j).toString('utf8'))
  if (!Number.isFinite(len) || len < 0) return data.length
  return j + 1 + len
}

/**
 * 从 .torrent 字节里算 infohash，拼出 magnet。
 *
 * acg.rip 的 RSS 只给 .torrent 下载地址，不给 magnet；但 QQ 里发 .torrent
 * 附件不如直接发 magnet 好点。info 字典的 sha1 就是 infohash。
 */
export function magnetFromTorrent(buf) {
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf), 'binary')
  const start = data.indexOf(Buffer.from('4:infod'))
  if (start < 0) return ''
  // "4:info" 后面紧跟的就是 info 的 bencode 值
  const begin = start + '4:info'.length
  const end = skipBencode(data, begin)
  if (end <= begin) return ''
  const slice = data.slice(begin, end)
  const hash = crypto.createHash('sha1').update(slice).digest('hex')
  return `magnet:?xt=urn:btih:${hash}`
}

/** 各站的 RSS 入口。想加源就加一行，`parse` 负责从 XML 里抠条目。 */
const MAGNET_SOURCES = [
  {
    id: 'acg.rip',
    label: 'ACG.RIP',
    url: (q) => `https://acg.rip/.xml?term=${encodeURIComponent(q)}`,
  },
  {
    id: 'mikan',
    label: '蜜柑计划',
    url: (q) => `https://mikanime.tv/RSS/Search?searchstr=${encodeURIComponent(q)}`,
  },
  {
    id: 'dmhy',
    label: '动漫花园',
    url: (q) => `https://share.dmhy.org/topics/rss/rss.xml?keyword=${encodeURIComponent(q)}`,
  },
  {
    id: 'nyaa',
    label: 'Nyaa',
    url: (q) => `https://nyaa.si/?page=rss&q=${encodeURIComponent(q)}`,
  },
]

/**
 * 多源搜磁力，按体量从大到小排（选 BDRip / 合集的人多）。
 *
 * @returns {Promise<{items: Array, failed: string[]}>}
 */
export async function searchMagnets(query, { proxy, timeoutMs = DEFAULT_TIMEOUT_MS, perSource = 3, deadlineMs } = {}) {
  const q = String(query || '').trim()
  if (!q) return { items: [], failed: [] }
  const cached = cacheRead('magnet', q)
  if (cached) return cached

  const items = []
  const failed = []
  const seen = new Set()

  // 四家 RSS 并发拉：串着来一轮就是十几秒，并发之后整体只等最慢的那家；
  // 再给每家一个硬上限——acg.rip 这种连不上的，不能让用户等它三腿都超时。
  const budget = Math.max(2000, Math.min(deadlineMs || 6000, timeoutMs * 2))
  const results = await Promise.allSettled(
    MAGNET_SOURCES.map(async (src) => {
      const res = await withDeadline(
        fetchAny(src.url(q), {
          proxy,
          timeoutMs: Math.min(timeoutMs, budget),
          headers: { Accept: 'application/rss+xml,text/xml,*/*' },
          preferDirect: true,
        }),
        budget,
        src.label,
      )
      return { src, body: res.body }
    }),
  )

  for (let i = 0; i < results.length; i += 1) {
    const src = MAGNET_SOURCES[i]
    const r = results[i]
    if (r.status !== 'fulfilled') {
      failed.push(`${src.label}（${r.reason?.message?.slice(0, 40) || '失败'}）`)
      continue
    }
    try {
      const parsed = parseRssItems(r.value.body).slice(0, perSource)
      for (const it of parsed) {
        const key = (it.magnet || it.enclosure || it.link || it.title).slice(0, 80)
        if (seen.has(key)) continue
        seen.add(key)
        items.push({
          source: src.label,
          title: it.title,
          magnet: it.magnet,
          torrent: /^https?:/i.test(it.enclosure) ? it.enclosure : '',
          page: it.link,
          size: it.size,
          date: it.pubDate,
        })
      }
    } catch (err) {
      failed.push(`${src.label}（${err?.message?.slice(0, 40) || '失败'}）`)
    }
  }

  items.sort((a, b) => (b.size || 0) - (a.size || 0))
  const out = { items, failed }
  if (items.length > 0) cacheWrite('magnet', q, out)
  return out
}

/* ───────────────────────────── 组回复文本 ───────────────────────────── */

/** 简介太长就截断——QQ 气泡里塞三千字没人看。 */
function clip(text, n = 120) {
  const s = String(text || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n)}…` : s
}

function fmtDate(date) {
  const m = String(date || '').match(/^(\d{4})-(\d{2})-(\d{2})/)
  return m ? `${m[1]} 年` : ''
}

/**
 * 把 AniBT 那种几十个 tracker 的长 magnet 压短。
 *
 * 群里贴一条 1500 字的 magnet 等于刷屏；`xt=urn:btih:` 加个短 dn 就够点了，
 * 剩下的 tracker 客户端会自己补。
 */
export function shortMagnet(magnet, { dnMax = 40 } = {}) {
  const text = String(magnet || '').trim()
  const hash = /urn:btih:([0-9a-z]+)/i.exec(text)
  if (!hash) return text
  let out = `magnet:?xt=urn:btih:${hash[1]}`
  const dn = /[?&]dn=([^&]*)/.exec(text)
  if (dn) {
    let name = ''
    try {
      name = decodeURIComponent(dn[1].replace(/\+/g, ' '))
    } catch {
      name = ''
    }
    name = name.replace(/\s+/g, ' ').trim()
    if (name) out += `&dn=${encodeURIComponent(name.slice(0, dnMax))}`
  }
  return out
}

/**
 * 把「条目 + 磁力」拼成一条给人看的话。
 *
 * @param {object} subject searchBangumi 的第一条
 * @param {object} magnets searchMagnets 的结果
 * @param {object} [opts]
 * @param {number} [opts.maxMagnets=3]
 */
export function formatAnimeReport(subject, magnets, { maxMagnets = 3 } = {}) {
  const lines = []
  if (!subject) {
    lines.push('没找到这个番的条目。换个正式点的名字（日文原名、或者带「第几季」）再试一次？')
  } else {
    // 中文名和原名常常一模一样，别排成「《进击的巨人 / 进击的巨人》」
    const names = [...new Set([subject.nameCn, subject.name].filter(Boolean))]
    const title = names.length ? names.join(' / ') : `subject ${subject.id || ''}`
    const year = fmtDate(subject.date)
    const res = subject.resources ? `资源 ${subject.resources} 个` : ''
    const meta = [year, subject.platform, subject.eps ? `${subject.eps} 话` : '', res].filter(Boolean).join(' · ')
    lines.push(`《${title}》${meta ? `　${meta}` : ''}`)
    if (subject.score > 0) {
      if (subject.votes > 0) {
        lines.push(
          `Bangumi ${subject.score.toFixed(1)} 分（${subject.votes} 人评分${subject.rank ? ` · 排名 #${subject.rank}` : ''}）`,
        )
      } else {
        // AniBT 只转述分数，没有评分人数，别硬编一个「0 人评分」
        lines.push(`评分 ${subject.score.toFixed(1)}${subject.source ? `（${subject.source}）` : ''}`)
      }
    }
    if (subject.tags.length) lines.push(`标签：${subject.tags.join(' / ')}`)
    if (subject.summary) lines.push(`简介：${clip(subject.summary, 140)}`)
    lines.push(subject.url)

    const alts = Array.isArray(subject.alternatives) ? subject.alternatives.slice(0, 3) : []
    if (alts.length) {
      const text = alts
        .map((it) => {
          const name = it.nameCn || it.name || '（无题）'
          const bits = [it.platform, it.score ? `${it.score.toFixed(1)} 分` : '', it.resources ? `${it.resources} 个资源` : '']
            .filter(Boolean)
            .join(' · ')
          return bits ? `《${name}》（${bits}）` : `《${name}》`
        })
        .join(' · ')
      lines.push(`另外还有：${text}`)
    }
  }

  const list = Array.isArray(magnets?.items) ? magnets.items.slice(0, maxMagnets) : []
  if (list.length) {
    lines.push('')
    lines.push(`磁力（${list[0].source} 等，按体积排）：`)
    list.forEach((it, i) => {
      const size = humanSize(it.size)
      lines.push(`${i + 1}. ${clip(it.title, 70)}${size ? `（${size}）` : ''}`)
      if (it.magnet) lines.push(`   ${shortMagnet(it.magnet)}`)
      else if (it.torrent) lines.push(`   ${it.torrent}`)
      else if (it.page) lines.push(`   ${it.page}`)
    })
  } else if (Array.isArray(magnets?.failed) && magnets.failed.length) {
    lines.push(`磁力没搜到：${magnets.failed.join('、')}`)
  }

  return lines.join('\n')
}

/**
 * 直连取二进制（.torrent 这类）。中继只给文本，所以这里不挂中继腿。
 *
 * @returns {Promise<Buffer|null>} 取不到就 null，绝不抛
 */
export async function fetchBinary(url, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (!url) return null
  try {
    const res = await directGet(url, { timeoutMs, binary: true })
    if (res.status !== 200 || !Buffer.isBuffer(res.body) || res.body.length === 0) return null
    return res.body
  } catch {
    return null
  }
}

/** 标题归一：只留字与数字，去掉字幕组括号之类，用来去重。 */
function normTitle(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
}

/**
 * 磁力去重：同一条种子（同标题同体积）只留一条，优先留有 magnet 的那条。
 *
 * @param {Array<object>} items
 * @returns {Array<object>}
 */
export function dedupeMagnets(items) {
  const seen = new Map()
  for (const it of Array.isArray(items) ? items : []) {
    if (!it) continue
    const key = `${normTitle(it.title)}|${Number(it.size) || 0}`
    const prev = seen.get(key)
    if (!prev) {
      seen.set(key, it)
      continue
    }
    if (it.magnet && !prev.magnet) seen.set(key, it)
  }
  return [...seen.values()]
}

/**
 * 把 RSS 里只给 `.torrent` 链接的条目补成真 magnet。
 *
 * 为什么要多这一步：QQ 里发一条 `https://…/xxx.torrent` 对方点开还得下载，
 * 而 `magnet:?xt=urn:btih:…` 点一下就进下载器；acg.rip 与蜜柑基本都只给 .torrent。
 * 只转前几条（默认 3 条），并发转、各给 6 秒，转不出来就保留原链接。
 */
export async function magnetizeItems(magnets, { timeoutMs = DEFAULT_TIMEOUT_MS, maxConvert = 3, fetchImpl = fetchBinary } = {}) {
  const items = dedupeMagnets(magnets?.items)
  const targets = items.filter((it) => !it.magnet && it.torrent).slice(0, maxConvert)
  await Promise.all(
    targets.map(async (it) => {
      try {
        const buf = await withDeadline(fetchImpl(it.torrent, { timeoutMs: Math.min(timeoutMs, 6000) }), 6500, 'torrent')
        const m = buf ? magnetFromTorrent(buf) : ''
        if (m) it.magnet = m
      } catch {
        /* 转不出来就留着链接 */
      }
    }),
  )
  return { ...magnets, items }
}

/**
 * 一次完整的搜番：Bangumi 条目 + 多源磁力 + 排版。
 *
 * 这是工具、命令、私有钩子三个入口共用的唯一实现。
 *
 * @param {string} query 番名
 * @param {object} [opts]
 * @param {string} [opts.proxy]
 * @param {'all'|'info'|'magnet'} [opts.scope='all']
 * @param {number} [opts.timeoutMs]
 */
export async function animeFind(query, { proxy, scope = 'all', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const q = String(query || '').trim()
  if (!q) return { ok: false, text: '要搜哪个番？给我个名字。', query: q }

  const wantInfo = scope !== 'magnet'
  const wantMagnet = scope !== 'info'
  const errors = []

  const infoJob = async () => {
    // 先 AniBT：直连能通，还自带 Bangumi 条目号和分数；它挂了再退 Bangumi
    try {
      const hits = await searchAnibt(q, { proxy, timeoutMs })
      if (hits.length > 0) return hits
    } catch (err) {
      errors.push(`AniBT：${err?.message || err}`)
    }
    try {
      const hits = await searchBangumi(q, { proxy, timeoutMs })
      if (hits.length > 0) return hits
    } catch (err) {
      errors.push(`Bangumi：${err?.message || err}`)
    }
    // 两条正路都空手：再拿末段关键词粗搜一次（见 fuzzyAnibt 注释里的真机事故）
    try {
      const fuzzy = await withDeadline(fuzzyAnibt(q, { proxy, timeoutMs }), 9000, '模糊回退')
      if (fuzzy.length > 0) return fuzzy
    } catch (err) {
      errors.push(`模糊回退：${err?.message || err}`)
    }
    return []
  }

  const magnetJob = async () => {
    try {
      return await searchMagnets(q, { proxy, timeoutMs })
    } catch (err) {
      errors.push(`磁力：${err?.message || err}`)
      return { items: [], failed: [] }
    }
  }

  // 条目和磁力互不依赖，一起发车：串着来的话用户要等两份超时
  const magnetPromise = wantMagnet ? magnetJob() : Promise.resolve({ items: [], failed: [] })
  const rawHits = await (wantInfo ? infoJob() : Promise.resolve([]))

  const ranked = rawHits.length > 0 && rawHits[0]?._fuzzy ? rawHits : rankCandidates(rawHits, q)
  const subject = ranked[0] || null
  if (subject) subject.alternatives = ranked.slice(1, 4)

  // 有了 bgmId 再问 AniBT 要一份真 magnet（通常 0.3–3 秒，比 RSS 里的 .torrent 好用）
  let fromAnibt = []
  if (wantMagnet && subject?.id) {
    try {
      fromAnibt = await withDeadline(
        searchAnibtMagnets(subject.id, { timeoutMs: Math.min(timeoutMs, 5000) }),
        5000,
        'AniBT 磁力',
      )
    } catch {
      /* 拿不到就算了，RSS 那边还有 */
    }
  }

  const merged = mergeMagnets({ items: fromAnibt }, await magnetPromise)
  // RSS 只给 .torrent 链接的，顺手换成真 magnet（只转前 3 条，转不出来就留链接）
  const magnets = wantMagnet ? await magnetizeItems(merged, { timeoutMs: Math.min(timeoutMs, 6000) }) : merged

  if (!subject && magnets.items.length === 0) {
    const why = errors.length ? `（${errors.slice(0, 2).join('；').slice(0, 200)}）` : ''
    return {
      ok: false,
      query: q,
      text: `没搜到「${q}」${why}。这台机器上 Bangumi 连不上，我只能拿 AniBT 的片单去对，名字差一两个字就会空手——换个说法或者只给我关键词再试一次（比如只给「魔女」两个字）。`,
    }
  }

  return { ok: true, query: q, subject, magnets, text: formatAnimeReport(subject, magnets) }
}

/* ───────────────────────────── 工具定义 ───────────────────────────── */

/**
 * 造 `anime_find` 工具。
 *
 * 描述里刻意写清「什么时候该用」，因为主人要的是**模糊触发**：用户发张图
 * 问「这是哪部」、或者顺口说「有资源吗」，都由模型自己判断要不要调，
 * 而不是非得打 #茉莉搜番。
 *
 * @param {object} opts
 * @param {() => object} [opts.getConfig] 取当前配置（代理、超时可能热改）
 */
export function buildAnimeTool({ getConfig = () => ({}) } = {}) {
  const cfg = () => {
    try {
      return getConfig() || {}
    } catch {
      return {}
    }
  }

  return {
    name: ANIME_TOOL_NAME,
    description: [
      '搜番：给个番名，回来处（Bangumi 条目）、评分、简介、标签，以及几个磁力/种子链接。',
      '该主动用的情况：有人问某部番「怎么样 / 值不值得看 / 讲什么 / 多少分」；有人问「有没有资源 / 磁力 / 种子 / 在哪下」；',
      '有人提到一个你不确定是哪部的番名，先搜一下再答，别凭印象编评分和集数。',
      '有人发图问「这是哪个番 / 出处」：先用识图（#茉莉识图）认出名字，再拿名字调这个工具补评分和资源。',
      '不要用它查真人剧、电影、漫画；也不要一次搜五个番——一次一个，结论直接说人话。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '番名，中文/日文/英文都行。' },
        scope: {
          type: 'string',
          enum: ['all', 'info', 'magnet'],
          description: 'all=条目+磁力（默认）；info=只要评分简介；magnet=只要资源。',
        },
      },
      required: ['query'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          query: { type: 'string' },
          text: { type: 'string' },
        },
        required: ['ok', 'text'],
      },
      render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
    },
    async execute(args = {}) {
      const c = cfg()
      const scope = ['all', 'info', 'magnet'].includes(String(args.scope || '')) ? String(args.scope) : 'all'
      try {
        const res = await animeFind(args.query, {
          proxy: c.animeFindProxy === undefined ? DEFAULT_PROXY : String(c.animeFindProxy || ''),
          scope,
          timeoutMs: Number(c.animeFindTimeoutMs) > 0 ? Number(c.animeFindTimeoutMs) : DEFAULT_TIMEOUT_MS,
        })
        return { ok: !!res.ok, query: String(res.query || ''), text: res.text }
      } catch (err) {
        return { ok: false, query: String(args.query || ''), text: `搜番出错了：${err?.message || err}` }
      }
    },
  }
}

/**
 * 注册进宿主 tools 服务。跟 qqtools.js 一样：注册失败只降级，绝不抛。
 */
export function registerAnimeTool({ ctx, getConfig = () => ({}), logger = () => {} }) {
  const status = { name: ANIME_TOOL_NAME, registered: false, error: '' }
  let tools
  try {
    tools = typeof ctx?.get === 'function' ? ctx.get('tools') : ctx?.tools
  } catch (err) {
    status.error = `读不到 tools 服务：${err?.message || err}`
    logger('warn', `anime_find 未注册：${status.error}`)
    return { status, dispose: null }
  }
  if (!tools?.register) {
    status.error = '宿主没有 tools 服务（或版本太旧）'
    logger('warn', `anime_find 未注册：${status.error}`)
    return { status, dispose: null }
  }
  try {
    const dispose = tools.register(buildAnimeTool({ getConfig }))
    status.registered = true
    logger('info', 'anime_find 工具已注册：聊天里能自己搜番了')
    return { status, dispose: typeof dispose === 'function' ? dispose : null }
  } catch (err) {
    status.error = err?.message || String(err)
    logger('warn', `anime_find 注册失败：${status.error}`)
    return { status, dispose: null }
  }
}
