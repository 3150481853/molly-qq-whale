/**
 * webview.js —— Molly 的「手」：搜一下、读一页、看一眼天气。
 *
 * ## 这个东西从哪来
 *
 * 思路和底层安全代码改编自开源项目 QQ-A（MIT）的 `safe-fetch.js`：
 *
 *   Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors
 *   MIT License（全文见仓库根目录 CREDITS.md）
 *
 * 原帖把它写在「第九节 · 外部链接：出门逛逛，回来带着出处」：出门看的是公开网页，
 * 回来要带原链接，只看了摘要就说只看了摘要；链接打不开你家的路由器和 NAS，
 * 也不会被一次跳转带到奇怪的地方。这里搬的就是这条底线。
 *
 * ## 我们改了什么（相对上游）
 *
 *   1. 端口白名单（只放 80/443/8080/8443）—— 上游 validateFetchUrl 不限端口，
 *      等于把内网任意端口的探测面留着。
 *   2. HTML → 纯文本正文抽取、<title> 提取、charset 处理 —— 上游只返回原始
 *      响应体，模型会直接吃一整页标签。
 *   3. 只收文本类 Content-Type；响应体按字节上限截断（2MB）+ 字符上限双保险。
 *   4. 去掉了上游为 Clash fake-IP 写死的「腾讯系域名放行 198.18/15」特例：
 *      解析到 198.18/15 一律拒（宁可这一次查不到，也不把守卫开个口子）。
 *   5. 加了配额/时段/按项开关（默认每天 30 次）、Bing RSS 搜索、wttr.in 天气。
 *
 * ## 安全模型（照抄上游，别随手改）
 *
 *   - 只允许 http/https；URL 里带用户名密码直接拒。
 *   - 域名先 `dns.lookup(all:true)`，**全部** A/AAAA 都过一遍内网判定，
 *     任一是内网就整体拒（防 DNS rebinding）。
 *   - 校验通过的 IP **直接当 hostname 去连**，Host 头和 TLS SNI 仍用原域名 ——
 *     连接阶段不会再查一次 DNS，重绑定攻击自然失效。
 *   - 重定向手动跟，最多 5 跳；**每一跳都重新做 DNS + 内网段校验**，
 *     并且不读重定向响应体（防无限正文耗死连接）。
 *
 * 这里不做「登录态浏览」。要带登录态看小红书/B站那种，走 bsk 浏览器那条线
 * （见 docs/STATE.md 的「命令」前缀），不要往这个文件里加 Cookie。
 */

import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import dns from 'node:dns'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const dnsLookup = dns.promises.lookup.bind(dns.promises)

/** 一次抓取的硬总预算（含响应体） */
const REQUEST_TIMEOUT_MS = 15000
/** 多地址时的单次尝试预算 */
const ATTEMPT_TIMEOUT_MS = 8000
/** 最多换几个解析出来的地址重试 */
const MAX_ADDRESS_ATTEMPTS = 4
/** 重定向最多跟几跳 */
const MAX_REDIRECTS = 5
/** DNS 解析超时 */
const DNS_TIMEOUT_MS = 5000
/** 单次响应体字节上限 */
const MAX_BYTES = 2 * 1024 * 1024
/** 抽出来的正文最多留多少字 */
const MAX_CHARS = 12000
/** 端口白名单（上游不限制端口，我们收紧） */
const ALLOWED_PORTS = new Set(['80', '443', '8080', '8443'])
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/<REDACTED> Safari/537.36 MollyWebview/1.0'
/** 这些后缀从来不是「公开网页」 */
const BLOCKED_SUFFIXES = ['.localhost', '.local', '.internal', '.lan', '.home.arpa', '.intranet', '.corp']

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), Math.max(1, ms))
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function normalizeHost(hostname) {
  return String(hostname || '')
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
}

/* ==========================================================================
 * 一、地址判定（移植自 QQ-A 的 safe-fetch 实现，保留原判定口径）
 * ========================================================================== */

function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':')
  if (parts.length < 2) return null
  const last = parts[parts.length - 1]
  const secondLast = parts[parts.length - 2]
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16)
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`
  }
  return null
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '')
  if (!lower.includes(':')) return null
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/)
  if (dotted) return dotted[1]
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16)
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`
  }
  // 兼容 ::ffff:0:7f00:1、::ffff:0:c0a8:101、::c0a8:101 等非规范 IPv4-mapped/compatible 写法。
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower)
    if (embedded) return embedded
  }
  // NAT64 前缀（64:ff9b::/96 与 64:ff9b:1::/48）内嵌 IPv4，例如 64:ff9b::c0a8:101 -> <REDACTED>
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower)
    if (embedded) return embedded
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i)
  if (nat64) {
    if (nat64[3]) return nat64[3]
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16)
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`
  }
  return null
}

/**
 * 这个 IP 是不是「不该让机器人替人访问」的地址。
 *
 * 口径与上游一致：私有段、环回、链路本地、CGNAT、基准测试段、组播/保留段，
 * 以及所有内嵌 IPv4 的 IPv6 写法。非法地址按「私网」处理（宁可错杀）。
 *
 * @param {string} ip
 * @returns {boolean}
 */
export function isPrivateIp(ip) {
  let h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '')
  const family = net.isIP(h)
  if (!family || h.includes('%')) return true
  if (family === 6) h = new URL(`http://[${h}]/`).hostname.slice(1, -1)

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number)
    if (parts[0] === 10) return true
    if (parts[0] === 127) return true
    if (parts[0] === 0) return true
    if (parts[0] === 169 && parts[1] === 254) return true
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true
    if (parts[0] === 192 && parts[1] === 168) return true
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true
    if (parts[0] >= 224) return true
    return false
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true
    if (h.startsWith('fc') || h.startsWith('fd')) return true
    if (/^fe[89ab]/.test(h)) return true
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true
    // 本地 NAT64 前缀的 IPv4 位布局不等同 /96；整个本地前缀均不可供公网抓取。
    if (h.startsWith('64:ff9b:1:')) return true
    const embedded = parseEmbeddedIpv4(h)
    if (embedded) return isPrivateIp(embedded)
    if (h.startsWith('2001:db8')) return true
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i)
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16)
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`
      if (isPrivateIp(ipv4)) return true
    }
    if (h.startsWith('ff')) return true
    return false
  }

  return true
}

/**
 * 把校验过的地址排成「尝试顺序」：v4 优先、两族交替。
 *
 * 上游注释里的坑：本机常只有 IPv4 出口，而很多站点同时有 AAAA/A 记录，
 * 抢到第一个 AAAA 的那次请求会一路连到超时（表现就是「有时候打得开有时候打不开」）。
 */
function orderAddresses(addresses) {
  const v4 = addresses.filter((item) => Number(item?.family) === 4).map((item) => item.address)
  const v6 = addresses.filter((item) => Number(item?.family) === 6).map((item) => item.address)
  const ordered = []
  const max = Math.max(v4.length, v6.length)
  for (let i = 0; i < max; i += 1) {
    if (v4[i]) ordered.push(v4[i])
    if (v6[i]) ordered.push(v6[i])
  }
  return ordered
}

/**
 * 解析主机名并校验**全部**解析结果，返回可尝试的地址列表（IPv4 优先）。
 *
 * @param {string} hostname
 * @returns {Promise<string[]>}
 */
export async function resolveSafeAddresses(hostname) {
  const h = normalizeHost(hostname)
  if (!h) throw new Error('主机名为空')
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) {
    throw new Error('禁止访问内网/本机地址')
  }
  if (BLOCKED_SUFFIXES.some((suffix) => h.endsWith(suffix))) {
    throw new Error('禁止访问内网/本机地址')
  }
  if (net.isIP(h)) {
    if (isPrivateIp(h)) throw new Error('禁止访问内网/本机地址')
    return [h]
  }

  let addresses
  try {
    addresses = await withTimeout(dnsLookup(h, { all: true, verbatim: true }), DNS_TIMEOUT_MS, `DNS 解析 ${h}`)
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`)
  }
  if (!Array.isArray(addresses) || !addresses.length) throw new Error('域名没有解析结果')
  for (const { address } of addresses) {
    if (isPrivateIp(address)) throw new Error('域名解析到内网/本机地址，已阻止')
  }
  const ordered = orderAddresses(addresses)
  return ordered.length ? ordered : [addresses[0].address]
}

/**
 * 校验一个待抓取的 URL，返回钉好的连接目标。
 *
 * @param {string} raw
 * @returns {Promise<{url: URL, ip: string, addresses: string[]}>}
 */
export async function validateFetchUrl(raw) {
  let url
  try {
    url = new URL(String(raw ?? '').trim())
  } catch {
    throw new Error('URL 无效')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https')
  if (url.username || url.password) throw new Error('URL 不能包含凭据')
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  if (!ALLOWED_PORTS.has(String(port))) {
    throw new Error(`端口 ${port} 不在白名单（只放 80/443/8080/8443）`)
  }
  const addresses = await resolveSafeAddresses(url.hostname)
  return { url, ip: addresses[0], addresses }
}

/* ==========================================================================
 * 二、抓取主体（移植自 safe-fetch.js:233-390；改成只抓文本 + 字节上限）
 * ========================================================================== */

function decodeEncoding(buffer, encoding) {
  const enc = String(encoding || '').toLowerCase()
  if (!Buffer.isBuffer(buffer) || !buffer.length) return buffer
  try {
    if (enc.includes('gzip')) return zlib.gunzipSync(buffer)
    if (enc.includes('deflate')) return zlib.inflateSync(buffer)
    if (enc.includes('br')) return zlib.brotliDecompressSync(buffer)
  } catch {
    return buffer
  }
  return buffer
}

/**
 * 用**一个**已校验的地址发起一次尝试，保留原始 Host/SNI（禁止重新解析 DNS）。
 *
 * @param {URL} url
 * @param {string} address
 * @param {{maxBytes?:number, timeoutMs?:number}} opts
 * @returns {Promise<{ok:boolean, result?:object, error?:Error, retryable?:boolean}>}
 */
function attemptOnce(url, address, { maxBytes = MAX_BYTES, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false
    let req = null
    let response = null
    const settle = (outcome) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(outcome)
    }
    const fail = (error, retryable) => settle({ ok: false, error, retryable: retryable === true })
    const done = (result) => settle({ ok: true, result })
    const timer = setTimeout(() => {
      const error = new Error(`请求超时：${url.hostname}`)
      fail(error, true)
      req?.destroy(error)
      response?.destroy()
    }, Math.max(1, timeoutMs))
    const mod = url.protocol === 'https:' ? https : http
    const hostname = url.hostname.replace(/^\[|\]$/g, '')
    try {
      req = mod.request(
        {
          hostname: address,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname + url.search,
          method: 'GET',
          headers: {
            host: url.host,
            'user-agent': UA,
            accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
            'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6',
            'accept-encoding': 'identity',
          },
          servername: url.protocol === 'https:' && !net.isIP(hostname) ? hostname : undefined,
          rejectUnauthorized: url.protocol === 'https:',
          timeout: Math.max(1, timeoutMs),
        },
        (res) => {
          response = res
          res.on('error', (error) => fail(error, true))
          res.on('aborted', () => fail(new Error('响应体读取中断'), true))
          if (settled) {
            res.destroy()
            return
          }
          const statusCode = res.statusCode || 0
          if (REDIRECT_STATUSES.has(statusCode)) {
            done({ statusCode, redirect: String(res.headers.location || '') })
            // 不下载重定向正文：攻击者可以发送无限正文消耗连接和带宽。
            res.destroy()
            return
          }
          const chunks = []
          let size = 0
          const flush = (truncated) =>
            done({
              statusCode,
              buffer: Buffer.concat(chunks),
              truncated,
              contentType: String(res.headers['content-type'] || ''),
              contentEncoding: String(res.headers['content-encoding'] || ''),
            })
          res.on('data', (chunk) => {
            if (settled) return
            const remain = maxBytes - size
            if (chunk.length >= remain) {
              chunks.push(chunk.subarray(0, Math.max(0, remain)))
              size = maxBytes
              flush(true)
              res.destroy()
              return
            }
            chunks.push(chunk)
            size += chunk.length
          })
          res.on('end', () => {
            if (!settled) flush(false)
          })
          res.on('close', () => {
            if (!settled) flush(false)
          })
        },
      )
      req.on('timeout', () => {
        const error = new Error(`请求超时：${url.hostname}`)
        fail(error, true)
        req.destroy(error)
        response?.destroy()
      })
      req.on('error', (error) => fail(error, true))
      req.end()
    } catch (error) {
      fail(error, true)
      req?.destroy()
    }
  })
}

/**
 * 依次尝试已校验的地址（v4 优先）。单地址时用整个总预算，多地址时才启用
 * 单次尝试预算与失败切换。
 */
async function requestOnce(url, addresses, { maxBytes = MAX_BYTES, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const list = (Array.isArray(addresses) ? addresses : [addresses]).filter(Boolean)
  if (!list.length) throw new Error(`没有可用地址：${url.hostname}`)
  const deadline = Date.now() + timeoutMs
  let lastError = null
  const attempts = Math.min(list.length, MAX_ADDRESS_ATTEMPTS)
  for (let i = 0; i < attempts; i += 1) {
    const remaining = deadline - Date.now()
    if (remaining <= 250) break
    const budget = list.length === 1 ? timeoutMs : Math.min(ATTEMPT_TIMEOUT_MS, remaining)
    const outcome = await attemptOnce(url, list[i], { maxBytes, timeoutMs: budget })
    if (outcome.ok) return outcome.result
    lastError = outcome.error
    if (!outcome.retryable) throw outcome.error
    if (i < attempts - 1) {
      // 换地址重试：只换连接目标，Host/SNI/路径全部不变（同一个站点）。
      continue
    }
  }
  if (lastError && attempts > 1) {
    lastError.message = `${lastError.message}（已尝试 ${attempts} 个地址）`
  }
  throw lastError ?? new Error(`请求失败：${url.hostname}`)
}

/**
 * 安全抓取：逐跳校验 + 手动重定向。
 *
 * @param {string} urlString
 * @param {{maxBytes?:number, timeoutMs?:number, authorize?:(url:string)=>Promise<void>|void}} opts
 */
export async function safeFetch(urlString, { maxBytes = MAX_BYTES, timeoutMs = REQUEST_TIMEOUT_MS, authorize = null } = {}) {
  if (typeof authorize === 'function') await authorize(urlString)
  const started = Date.now()
  const redirects = []
  let { url, addresses } = await validateFetchUrl(urlString)
  for (let i = 0; i <= MAX_REDIRECTS; i += 1) {
    const result = await requestOnce(url, addresses, { maxBytes, timeoutMs: Math.max(1000, timeoutMs - (Date.now() - started)) })
    if (REDIRECT_STATUSES.has(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`)
      const next = new URL(result.redirect, url).toString()
      redirects.push(next)
      if (typeof authorize === 'function') await authorize(next)
      // 每一跳都重新做 DNS + 内网段校验，这是上游最值得抄的一行。
      ;({ url, addresses } = await validateFetchUrl(next))
      continue
    }
    return {
      url: url.toString(),
      statusCode: result.statusCode,
      truncated: Boolean(result.truncated),
      buffer: result.buffer,
      contentType: result.contentType,
      contentEncoding: result.contentEncoding,
      redirects,
      ms: Date.now() - started,
    }
  }
  throw new Error('重定向次数过多，已停止')
}

/* ==========================================================================
 * 三、正文抽取（上游没有这一层，是我们补的最大缺口）
 * ========================================================================== */

const ENTITIES = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  middot: '·',
  laquo: '«',
  raquo: '»',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  copy: '©',
  reg: '®',
  trade: '™',
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-z][a-z0-9]+);/gi, (m, name) => (ENTITIES[name.toLowerCase()] !== undefined ? ENTITIES[name.toLowerCase()] : m))
}

function safeCodePoint(num) {
  if (!Number.isFinite(num) || num <= 0 || num > 0x10ffff) return ''
  // 控制字符直接丢掉：网页正文里的它们只会污染模型输入。
  if (num < 9 || (num > 10 && num < 13) || (num > 13 && num < 32) || num === 0x7f) return ''
  try {
    return String.fromCodePoint(num)
  } catch {
    return ''
  }
}

function detectCharset(buffer, contentType) {
  const fromHeader = /charset\s*=\s*["']?([\w-]+)/i.exec(String(contentType || ''))
  if (fromHeader) return fromHeader[1].toLowerCase()
  const head = Buffer.isBuffer(buffer) ? buffer.subarray(0, 4096).toString('latin1') : ''
  const fromMeta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)
  return fromMeta ? fromMeta[1].toLowerCase() : 'utf-8'
}

function decodeBody(buffer, contentType) {
  if (!Buffer.isBuffer(buffer)) return String(buffer ?? '')
  const charset = detectCharset(buffer, contentType)
  try {
    return new TextDecoder(charset, { fatal: false }).decode(buffer)
  } catch {
    // Node 没带这个编码（少见，比如某些 GB 变体）——退回 utf-8，至少不乱码到崩。
    try {
      return new TextDecoder('utf-8', { fatal: false }).decode(buffer)
    } catch {
      return buffer.toString('utf8')
    }
  }
}

function isTextual(contentType) {
  const t = String(contentType || '').toLowerCase()
  if (!t) return true // 有些站不给 Content-Type，抓回来按文本试一次
  return /^text\//.test(t) || /(xhtml\+xml|application\/xml|application\/json|application\/rss\+xml|application\/atom\+xml|application\/ld\+json)/.test(t)
}

/**
 * HTML → 纯文本。
 *
 * 先剥 script/style/注释，块级标签换行，再解实体、折叠空白。
 * 正文优先取 <article> / <main>：很多站的 <body> 前面全是导航和广告。
 *
 * @param {string} html
 * @returns {{title:string, text:string}}
 */
export function htmlToText(html) {
  const raw = String(html || '')
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])).replace(/\s+/g, ' ').trim() : ''

  const article = /<article\b[^>]*>([\s\S]*?)<\/article>/i.exec(raw) || /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(raw)
  let body = article ? article[1] : raw
  body = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|head)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|header|footer|blockquote|pre|dd|dt|figcaption)\s*>/gi, '\n')
    .replace(/<(li|tr)\b[^>]*>/gi, '\n· ')
    .replace(/<\/(td|th)\s*>/gi, ' ')
  const stripped = stripTags(body)
  const text = decodeEntities(stripped)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\u00a0\u3000]+/g, ' ')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    // 太短的行多半是「首页 / 登录 / 更多」这类导航残留
    .filter((line) => line.length > 1)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, text }
}

function stripTags(html) {
  return String(html || '').replace(/<[^>]*>/g, ' ')
}

/**
 * 抓一个公开网页，返回抽好的正文。
 *
 * @param {string} rawUrl
 * @param {{maxChars?:number, maxBytes?:number, timeoutMs?:number, authorize?:Function}} opts
 */
export async function fetchPage(rawUrl, { maxChars = 4000, maxBytes = MAX_BYTES, timeoutMs = REQUEST_TIMEOUT_MS, authorize = null } = {}) {
  const res = await safeFetch(rawUrl, { maxBytes, timeoutMs, authorize })
  const contentType = res.contentType || ''
  if (!isTextual(contentType)) {
    throw new Error(`不是网页内容（Content-Type: ${contentType || '未知'}），这里只读文章`)
  }
  const decoded = decodeEncoding(res.buffer, res.contentEncoding)
  const raw = decodeBody(decoded, contentType)
  const looksHtml = /html|xml/i.test(contentType) || /<html|<body|<div|<p[\s>]/i.test(raw.slice(0, 2000))
  const extracted = looksHtml ? htmlToText(raw) : { title: '', text: raw.trim() }
  const limit = Math.min(MAX_CHARS, Math.max(200, Number(maxChars) || 4000))
  const text = extracted.text.length > limit ? extracted.text.slice(0, limit) : extracted.text
  return {
    ok: true,
    url: String(rawUrl),
    finalUrl: res.url,
    status: res.statusCode,
    title: extracted.title,
    text,
    chars: text.length,
    fullChars: extracted.text.length,
    truncated: Boolean(res.truncated) || extracted.text.length > limit,
    bytes: decoded.length || 0,
    contentType,
    redirects: res.redirects,
    ms: res.ms,
    untrusted: true,
  }
}

/* ==========================================================================
 * 四、搜索（Bing RSS）与天气（wttr.in，失败退 open-meteo）
 * ========================================================================== */

function pickTag(block, tag) {
  const re = new RegExp(`<${tag}\\b[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`, 'i')
  const m = re.exec(String(block || ''))
  return m ? m[1] : ''
}

function plainText(html) {
  // RSS 的 description 常把 HTML 转义成 &lt;div&gt;：先剥一遍标签，解码后
  // 又会冒出真标签（百度百科、网易云的摘要都这样），所以解码后再剥一遍。
  const decoded = decodeEntities(stripTags(html))
  return stripTags(decoded).replace(/\s+/g, ' ').trim()
}

// Bing 有时把页面自己的模板语法当成摘要塞进 RSS（网易云那条就是
// `{if suggests.length == 0} 轻敲空格完成输入 {else} …`）。这些不是内容，
// 嵌进聊天里像乱码，直接抹掉。
function stripTemplate(text) {
  return String(text || '')
    .replace(/\{\s*(?:if|else|\/if|each|\/each|include|block)\b[^{}]{0,160}\}/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 用 Bing 的 RSS 出口搜（国内直连、无 key、<1s）。
 *
 * 为什么不是 Google/DuckDuckGo：本机实测这两个域名 12 秒超时，根本连不上。
 *
 * @param {string} query
 * @param {{limit?:number, timeoutMs?:number}} opts
 */
export async function searchBing(query, { limit = 5, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const started = Date.now()
  const q = String(query || '').trim()
  if (!q) throw new Error('空查询')
  const url = `https://cn.bing.com/search?q=${encodeURIComponent(q)}&format=rss&mkt=zh-CN&setlang=zh-CN`
  const res = await safeFetch(url, { maxBytes: 512 * 1024, timeoutMs })
  const body = decodeBody(decodeEncoding(res.buffer, res.contentEncoding), res.contentType)
  const max = Math.min(10, Math.max(1, Number(limit) || 5))
  const results = []
  for (const m of body.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item>/gi)) {
    const block = m[1]
    const link = plainText(pickTag(block, 'link'))
    if (!/^https?:\/\//i.test(link)) continue
    const title = plainText(pickTag(block, 'title')) || link
    const snippetRaw = stripTemplate(plainText(pickTag(block, 'description')))
    results.push({
      title: title.slice(0, 160),
      url: link,
      snippet: snippetRaw.slice(0, 220),
      publishedAt: plainText(pickTag(block, 'pubDate')),
    })
    if (results.length >= max) break
  }
  if (!results.length) throw new Error('搜索没有结果（Bing RSS 返回为空）')
  return { ok: true, query: q, provider: 'bing-rss', results, ms: Date.now() - started, untrusted: true }
}

const WMO = {
  0: '晴',
  1: '晴间多云',
  2: '多云',
  3: '阴',
  45: '有雾',
  48: '雾凇',
  51: '小毛毛雨',
  53: '毛毛雨',
  55: '大毛毛雨',
  56: '冻毛毛雨',
  57: '强冻毛毛雨',
  61: '小雨',
  63: '中雨',
  65: '大雨',
  66: '冻雨',
  67: '强冻雨',
  71: '小雪',
  73: '中雪',
  75: '大雪',
  77: '雪粒',
  80: '小阵雨',
  81: '阵雨',
  82: '强阵雨',
  85: '小阵雪',
  86: '大阵雪',
  95: '雷阵雨',
  96: '雷阵雨伴冰雹',
  99: '强雷阵雨伴冰雹',
}

/** wttr.in 的中文只在部分地区返回 lang_zh；常见的英文天气词在这里兜底翻一下 */
const CN_DESC = {
  sunny: '晴',
  clear: '晴',
  'partly cloudy': '晴间多云',
  'partly cloudy ': '晴间多云',
  cloudy: '多云',
  overcast: '阴',
  mist: '薄雾',
  fog: '雾',
  haze: '霾',
  'smoky haze': '烟霾',
  'patchy rain nearby': '局部有雨',
  'patchy rain possible': '局部可能有雨',
  'light rain': '小雨',
  'moderate rain': '中雨',
  'heavy rain': '大雨',
  'light drizzle': '毛毛雨',
  'patchy light drizzle': '零星毛毛雨',
  'light rain shower': '小阵雨',
  'moderate or heavy rain shower': '强阵雨',
  'thundery outbreaks in nearby': '附近有雷阵雨',
  'thundery outbreaks possible': '可能有雷阵雨',
  'patchy light rain with thunder': '局部雷阵雨',
  'moderate or heavy rain with thunder': '强雷阵雨',
  'light snow': '小雪',
  'moderate snow': '中雪',
  'heavy snow': '大雪',
  'patchy light snow': '零星小雪',
  'patchy moderate snow': '局部中雪',
  'patchy heavy snow': '局部大雪',
  'blowing snow': '风吹雪',
  'light freezing rain': '小冻雨',
  'moderate or heavy freezing rain': '强冻雨',
  'light sleet': '小雨夹雪',
  'moderate or heavy sleet': '强雨夹雪',
}

function cnDesc(desc) {
  const raw = String(desc || '').trim()
  if (!raw) return ''
  // 已经是中文（wttr.in 的 lang_zh 生效时）就直接用
  if (/[\u4e00-\u9fa5]/.test(raw)) return raw
  return CN_DESC[raw.toLowerCase()] || raw
}

function weatherText({ area, tempC, desc, feelsC, humidity, windKmph, source }) {
  const bits = [`${area}现在 ${tempC}°C，${desc || '天气不明'}`]
  const extra = []
  if (Number.isFinite(feelsC) && Number(feelsC) !== tempC) extra.push(`体感 ${feelsC}°C`)
  if (Number.isFinite(humidity)) extra.push(`湿度 ${humidity}%`)
  if (Number.isFinite(windKmph)) extra.push(`风速 ${windKmph}km/h`)
  if (extra.length) bits.push(`（${extra.join('，')}）`)
  return `${bits.join('')}。来源：${source}`
}

/**
 * 查天气。首选 wttr.in（认中文城市名、免 key），失败退 open-meteo。
 *
 * @param {string} city
 * @param {{timeoutMs?:number}} opts
 */
export async function fetchWeather(city, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const started = Date.now()
  const name = String(city || '').trim()
  if (!name) throw new Error('没给城市名')
  const errors = []

  try {
    const res = await safeFetch(`https://wttr.in/${encodeURIComponent(name)}?format=j1&lang=zh`, {
      maxBytes: 512 * 1024,
      timeoutMs,
    })
    const json = JSON.parse(decodeBody(decodeEncoding(res.buffer, res.contentEncoding), res.contentType))
    const cur = json?.current_condition?.[0]
    if (cur) {
      const area = json?.nearest_area?.[0]?.areaName?.[0]?.value || name
      // 中文城市名优先用查询时那句（wttr 的 areaName 是拼音 Hangzhou，读起来很怪）
      const label = /[\u4e00-\u9fa5]/.test(name) ? name : area
      const tempC = Number(cur.temp_C)
      const feelsC = Number(cur.FeelsLikeC)
      const desc = cnDesc(cur?.lang_zh?.[0]?.value || cur?.weatherDesc?.[0]?.value || '')
      const humidity = Number(cur.humidity)
      const windKmph = Number(cur.windspeedKmph)
      return {
        ok: true,
        city: name,
        area,
        tempC,
        feelsC,
        desc,
        humidity,
        windKmph,
        provider: 'wttr.in',
        text: weatherText({ area: label, tempC, desc, feelsC, humidity, windKmph, source: 'wttr.in' }),
        ms: Date.now() - started,
        untrusted: true,
      }
    }
    errors.push('wttr.in 返回里没有当前天气')
  } catch (error) {
    errors.push(`wttr.in：${error?.message || error}`)
  }

  try {
    const geo = await safeFetch(
      `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=zh&format=json`,
      { maxBytes: 256 * 1024, timeoutMs },
    )
    const geoJson = JSON.parse(decodeBody(decodeEncoding(geo.buffer, geo.contentEncoding), geo.contentType))
    const place = geoJson?.results?.[0]
    if (!place) throw new Error('地理编码没找到这个城市')
    const area = [place.name, place.admin1].filter(Boolean).join('·') || name
    const label = /[\u4e00-\u9fa5]/.test(name) ? name : area
    const fc = await safeFetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
        '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m&timezone=Asia%2FShanghai',
      { maxBytes: 256 * 1024, timeoutMs },
    )
    const fcJson = JSON.parse(decodeBody(decodeEncoding(fc.buffer, fc.contentEncoding), fc.contentType))
    const cur = fcJson?.current
    if (!cur) throw new Error('open-meteo 没有当前天气')
    const tempC = Number(cur.temperature_2m)
    const feelsC = Number(cur.apparent_temperature)
    const humidity = Number(cur.relative_humidity_2m)
    const windKmph = Math.round(Number(cur.wind_speed_10m) || 0)
    const desc = WMO[Number(cur.weather_code)] || ''
    return {
      ok: true,
      city: name,
      area,
      tempC,
      feelsC,
      desc,
      humidity,
      windKmph,
      provider: 'open-meteo',
      text: weatherText({ area: label, tempC, desc, feelsC, humidity, windKmph, source: 'open-meteo' }),
      ms: Date.now() - started,
      untrusted: true,
    }
  } catch (error) {
    errors.push(`open-meteo：${error?.message || error}`)
  }

  throw new Error(`天气没查到（${errors.join('；')}）`)
}

/**
 * 从一句话里抠出网址（最多 3 条）。
 * @param {string} text
 * @returns {string[]}
 */
export function extractUrls(text) {
  const out = []
  const re = /https?:\/\/[^\s<>"'`）)】\]，。！？、；：]+/gi
  let m
  while ((m = re.exec(String(text || '')))) {
    /*
     * 链接后面常紧跟中文，中间没有空格：「…new_post_share_style_v2=1讲了啥」。
     * 正则的排除集只有中文标点，会把「讲了啥」一起吞进 URL，抓出来的地址
     * 就变成 …=1%E8%AE%B2%E4%BA%86%E5%95%A5（2026-10-29 真机：群里发小黑盒
     * 分享链接 + 「讲了啥」，浏览器打开的其实是被污染的地址）。所以先按首个
     * CJK 字符截断，再去掉尾部标点。
     */
    const cjk = m[0].search(/[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/)
    const url = (cjk >= 0 ? m[0].slice(0, cjk) : m[0]).replace(/[.,;:!?]+$/, '')
    if (url && !out.includes(url)) out.push(url)
    if (out.length >= 3) break
  }
  return out
}

/* ==========================================================================
 * 五、配额 / 时段 / 开关（照 QQ-A 的三段式：权限→时段→预算）
 * ========================================================================== */

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function localDate(now) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function localClock(now) {
  const d = new Date(now)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 'HH:mm-HH:mm'；空串 = 全天；跨午夜自动处理 */
function inHoursWindow(hours, now) {
  const spec = String(hours || '').trim()
  if (!spec) return true
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(spec)
  if (!m) return true
  const start = `${String(m[1]).padStart(2, '0')}:${m[2]}`
  const end = `${String(m[3]).padStart(2, '0')}:${m[4]}`
  if (start === end) return true
  const clock = localClock(now)
  return start < end ? clock >= start && clock < end : clock >= start || clock < end
}

/**
 * 今天的上网次数账本。按本地日期重置，落在 `<dataDir>/webview-usage.json`。
 * 写盘失败不致命（只在 stats.lastError 里留痕），绝不因为记账失败就不让查。
 */
export class WebviewQuota {
  constructor({ file = '', dailyLimit = 30, hours = '', now = () => Date.now() } = {}) {
    this.file = String(file || '')
    this.dailyLimit = Math.max(0, Number(dailyLimit) || 0)
    this.hours = String(hours || '').trim()
    this.now = typeof now === 'function' ? now : () => Date.now()
    this.lastError = ''
    this.state = { date: localDate(this.now()), counts: { search: 0, fetch: 0, weather: 0 } }
    this.#load()
  }

  #load() {
    if (!this.file) return
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      const counts = raw?.counts && typeof raw.counts === 'object' ? raw.counts : {}
      this.state = {
        date: String(raw?.date || localDate(this.now())),
        counts: { search: num(counts.search), fetch: num(counts.fetch), weather: num(counts.weather) },
      }
    } catch {
      /* 文件不存在/坏了：从零开始，不算错误 */
    }
    this.#roll()
  }

  #save() {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.state), 'utf8')
      fs.renameSync(tmp, this.file)
      this.lastError = ''
    } catch (error) {
      this.lastError = String(error?.message || error)
    }
  }

  #roll() {
    const today = localDate(this.now())
    if (this.state.date !== today) {
      this.state = { date: today, counts: { search: 0, fetch: 0, weather: 0 } }
      this.#save()
    }
  }

  used() {
    this.#roll()
    return Object.values(this.state.counts).reduce((sum, n) => sum + num(n), 0)
  }

  /** 只读检查，不记账（给 /state 和 probe 用） */
  check() {
    this.#roll()
    if (!inHoursWindow(this.hours, this.now())) {
      return { ok: false, reason: 'quota/hours', error: `现在不在允许上网的时段（${this.hours}）` }
    }
    if (this.dailyLimit > 0 && this.used() >= this.dailyLimit) {
      return { ok: false, reason: 'quota/exceeded', error: `今天的上网次数用完了（${this.used()}/${this.dailyLimit}）` }
    }
    return { ok: true }
  }

  /** 记账一次；返回 {ok:true, used, limit} 或 {ok:false, reason, error} */
  spend(kind) {
    const gate = this.check()
    if (!gate.ok) return gate
    this.state.counts[kind] = num(this.state.counts[kind]) + 1
    this.#save()
    return { ok: true, used: this.used(), limit: this.dailyLimit }
  }

  stats() {
    this.#roll()
    const used = this.used()
    return {
      date: this.state.date,
      used,
      limit: this.dailyLimit,
      remaining: this.dailyLimit > 0 ? Math.max(0, this.dailyLimit - used) : null,
      counts: { ...this.state.counts },
      hours: this.hours,
      lastError: this.lastError,
    }
  }
}

/* ==========================================================================
 * 六、对外门面：Webview
 * ========================================================================== */

/**
 * Molly 的上网门面。engine 建一个实例，research.js 拿它当「本地先查」的通道。
 *
 * 所有方法都不抛：失败返回 `{ok:false, reason, error}`，让上层当「没查到」处理。
 * 所有成功结果都带 `untrusted:true` —— 外部内容只当资料，不当指令。
 */
export class Webview {
  constructor({
    dir = '',
    logger = null,
    enabled = true,
    searchEnabled = true,
    fetchEnabled = true,
    weatherEnabled = true,
    dailyLimit = 30,
    hours = '',
    timeoutMs = 15000,
    maxChars = 4000,
    maxSearchResults = 5,
  } = {}) {
    this.dir = String(dir || '')
    this.logger = typeof logger === 'function' ? logger : () => {}
    this.enabled = enabled !== false
    this.searchEnabled = searchEnabled !== false
    this.fetchEnabled = fetchEnabled !== false
    this.weatherEnabled = weatherEnabled !== false
    this.timeoutMs = Math.min(60000, Math.max(3000, Number(timeoutMs) || 15000))
    this.maxChars = Math.min(MAX_CHARS, Math.max(200, Number(maxChars) || 4000))
    this.maxSearchResults = Math.min(10, Math.max(1, Number(maxSearchResults) || 5))
    this.quota = new WebviewQuota({
      file: this.dir ? path.join(this.dir, 'webview-usage.json') : '',
      dailyLimit,
      hours,
    })
    this.count = 0
    this.last = null
  }

  get available() {
    return Boolean(this.enabled && (this.searchEnabled || this.fetchEnabled || this.weatherEnabled))
  }

  stats() {
    return {
      enabled: this.enabled,
      ok: this.available,
      search: this.searchEnabled,
      fetch: this.fetchEnabled,
      weather: this.weatherEnabled,
      count: this.count,
      quota: this.quota.stats(),
      last: this.last,
    }
  }

  #gate(kind, skipQuota = false) {
    if (!this.enabled) return { ok: false, reason: 'webview/disabled', error: '上网模块没开（webviewEnabled=false）' }
    const enabled = kind === 'search' ? this.searchEnabled : kind === 'weather' ? this.weatherEnabled : this.fetchEnabled
    if (!enabled) {
      const key = kind === 'search' ? 'webviewSearchEnabled' : kind === 'weather' ? 'webviewWeatherEnabled' : 'webviewFetchEnabled'
      return { ok: false, reason: `webview/${kind}-off`, error: `这一项没开（${key}=false）` }
    }
    if (skipQuota) return { ok: true }
    return this.quota.spend(kind)
  }

  #record(kind, out) {
    this.last = {
      at: Date.now(),
      kind,
      ok: Boolean(out?.ok),
      reason: String(out?.reason || ''),
      ms: Number(out?.ms || 0),
      summary: String(out?.ok ? out.text || out.summary || '' : out?.error || '').slice(0, 160),
    }
    if (out?.ok) this.count += 1
    return out
  }

  /**
   * 搜一下。返回 `{ok, query, results:[{title,url,snippet}], provider, ms, untrusted}`。
   * @param {string} query
   * @param {{limit?:number, skipQuota?:boolean}} opts
   */
  async search(query, { limit = this.maxSearchResults, skipQuota = false } = {}) {
    const gate = this.#gate('search', skipQuota)
    if (!gate.ok) return this.#record('search', { ...gate, untrusted: true })
    try {
      const out = await searchBing(query, { limit, timeoutMs: this.timeoutMs })
      this.logger('info', `上网搜索「${String(query).slice(0, 40)}」→ ${out.results.length} 条（${out.ms}ms）`)
      return this.#record('search', out)
    } catch (error) {
      const msg = String(error?.message || error)
      this.logger('warn', `上网搜索失败：${msg}`)
      return this.#record('search', { ok: false, reason: 'webview/search-failed', error: msg, untrusted: true })
    }
  }

  /**
   * 读一页。返回 `{ok, url, finalUrl, status, title, text, truncated, ms, untrusted}`。
   * @param {string} url
   * @param {{maxChars?:number, skipQuota?:boolean}} opts
   */
  async fetchPage(url, { maxChars = this.maxChars, skipQuota = false } = {}) {
    const gate = this.#gate('fetch', skipQuota)
    if (!gate.ok) return this.#record('fetch', { ...gate, untrusted: true, url: String(url || '') })
    try {
      const out = await fetchPage(url, { maxChars, timeoutMs: this.timeoutMs })
      this.logger('info', `上网读页「${out.finalUrl}」→ ${out.chars} 字（${out.ms}ms）`)
      return this.#record('fetch', out)
    } catch (error) {
      const msg = String(error?.message || error)
      this.logger('warn', `上网读页失败：${msg}`)
      return this.#record('fetch', { ok: false, reason: 'webview/fetch-failed', error: msg, url: String(url || ''), untrusted: true })
    }
  }

  /**
   * 查天气。返回 `{ok, city, area, tempC, desc, text, provider, ms, untrusted}`。
   * @param {string} city
   * @param {{skipQuota?:boolean}} opts
   */
  async weather(city, { skipQuota = false } = {}) {
    const gate = this.#gate('weather', skipQuota)
    if (!gate.ok) return this.#record('weather', { ...gate, untrusted: true, city: String(city || '') })
    try {
      const out = await fetchWeather(city, { timeoutMs: this.timeoutMs })
      this.logger('info', `上网查天气「${city}」→ ${out.tempC}°C（${out.ms}ms）`)
      return this.#record('weather', out)
    } catch (error) {
      const msg = String(error?.message || error)
      this.logger('warn', `上网查天气失败：${msg}`)
      return this.#record('weather', { ok: false, reason: 'webview/weather-failed', error: msg, untrusted: true })
    }
  }

  /**
   * 取证入口：跳过配额，直接试一次。只给 /web/probe 用。
   * @param {{url?:string, query?:string, city?:string}} req
   */
  async probe({ url = '', query = '', city = '' } = {}) {
    // 不要在这里再包一层 #record：search/fetchPage/weather 自己已经记过一次，
    // 再包会让 count 涨两次、面板上的「查了几次」翻倍。
    if (url) return this.fetchPage(url, { skipQuota: true })
    if (query) return this.search(query, { skipQuota: true })
    if (city) return this.weather(city, { skipQuota: true })
    return { ok: false, reason: 'webview/bad-probe', error: '给 url / query / city 之一', ms: 0 }
  }
}

export { inHoursWindow, localDate as localDateOf }
