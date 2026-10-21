/**
 * WorkBuddy（wbai）免费模型网关。
 *
 * 为什么不用 ctx.llm：DSH 的 provider 层要经过宿主、适配器注册、凭据服务三层，
 * QQ bot 一旦跑起来就该是独立进程——宿主崩了、重启了、wbai 桌面端没开，
 * 都不该影响已经在聊的天。直连更简单也更强壮。
 *
 * 凭据从 WorkBuddy 桌面 App 里现取现用，它会自动续期，所以我们永远拿到最新 token。
 * 桌面端完全没开也不会挂：只是拿不到 atRestSecretKey，报个明确的错，等下次重试。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const LOCAL = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
const CANDIDATE_EXES = [
  'D:\\APP\\WorkBuddy\\WorkBuddy.exe',
  'D:\\APP\\WorkBuddyAI\\WorkBuddyAI.exe',
]
const CANDIDATE_INFO = [
  { file: path.join(LOCAL, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info'), flavor: 'cn' },
  { file: path.join(LOCAL, 'CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop-ai.info'), flavor: 'global' },
]

const CHAT_BASE = { cn: 'https://copilot.tencent.com', global: 'https://www.workbuddy.ai' }
const ORIGIN_BASE = { cn: 'https://www.workbuddy.cn', global: 'https://www.workbuddy.ai' }
const APP_VERSION = '5.8.3'

/** AES-GCM 的 AAD 构造，字节级对齐官方实现 */
function buildAad(keyId, suite) {
  const lp = (s) => {
    const b = Buffer.from(s, 'utf8')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(b.length, 0)
    return Buffer.concat([len, b])
  }
  const suiteBuf = Buffer.alloc(4)
  suiteBuf.writeUInt32BE(suite, 0)
  return Buffer.concat([
    Buffer.from('WB-AAD\0', 'ascii'),
    Buffer.from([1]),
    lp('WBEV1'),
    lp('sym-v1'),
    suiteBuf,
    lp(keyId),
    Buffer.from([2]),
    Buffer.from([0]),
    Buffer.from([0]),
  ])
}

function decryptEnvelope(envelopeB64, protectorKey) {
  const env = JSON.parse(Buffer.from(envelopeB64, 'base64').toString('utf8'))
  const aad = buildAad(env.keyId, env.suite)
  const d = crypto.createDecipheriv('aes-256-gcm', protectorKey, Buffer.from(env.nonce, 'base64'))
  d.setAAD(aad)
  d.setAuthTag(Buffer.from(env.authTag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(env.ciphertext, 'base64')), d.final()]).toString('utf8')
}

const maybeDecrypt = (v, key) => {
  if (typeof v === 'string') {
    if (v.startsWith('{')) {
      try {
        const o = JSON.parse(v)
        if (o?.$wbEncrypted) return decryptEnvelope(o.envelope, key)
      } catch {
        /* 不是 envelope，当明文 */
      }
    }
    return v
  }
  if (v && typeof v === 'object' && v.$wbEncrypted) return decryptEnvelope(v.envelope, key)
  return v
}

/**
 * 从桌面 App 的私有 binding 拿静态保护密钥。
 * 三种取法都试：内联脚本落盘（最稳）、-e 直接打印、报错兜底。
 */
async function readAtRestSecretKey(exe, logger) {
  const out = path.join(os.tmpdir(), `wbk-${process.pid}-${Date.now()}.json`)
  const script =
    `require('fs').writeFileSync(${JSON.stringify(out)}, ` +
    `JSON.stringify(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet()))`
  try {
    await execFileAsync(exe, ['-e', script], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 30000,
      windowsHide: true,
    })
    if (!fs.existsSync(out)) throw new Error('桌面端未产出密钥（WorkBuddy 可能没登录）')
    const raw = fs.readFileSync(out, 'utf8').trim()
    let j = JSON.parse(raw)
    if (typeof j === 'string') j = JSON.parse(j)
    if (!j?.atRestSecretKey) throw new Error('loggerGet() 里没有 atRestSecretKey')
    return j.atRestSecretKey
  } finally {
    try { fs.unlinkSync(out) } catch { /* 临时文件删不掉无所谓 */ }
  }
}

export class WorkBuddyGateway {
  /**
   * @param {object} opts
   * @param {(level: string, msg: string) => void} opts.logger
   * @param {string} [opts.model] 默认 deepseek-v4.1-flash（免费额度模型）
   * @param {number} [opts.credentialTtlMs] 凭据缓存时间，默认 10 分钟
   */
  constructor({ logger, model = 'deepseek-v4.1-flash', credentialTtlMs = 10 * 60 * 1000, exe } = {}) {
    this.logger = logger || (() => {})
    this.model = model
    this.credentialTtlMs = credentialTtlMs
    this.exe = exe
    /** flavor -> {cred, at}。两个账号分开缓存，互不顶掉 */
    this.cache = new Map()
    /** 优先用哪个 flavor（被 engine 在限流切号时改写） */
    this.preferFlavor = null
    this.lastError = null
  }

  /**
   * 找一个能用的凭据文件。
   *
   * @param {string} [flavor] 限定 'cn' 或 'global'；不传则按 CANDIDATE_INFO 顺序取第一个存在的
   *
   * 为什么要能按 flavor 挑：429 是**按账号**限的，国内版和国际版是两份独立额度
   * （实测 2026-10-17：cn 能聊的同时 global 报 429，反之亦然）。
   * 所以主力账号被限流时，切到另一个 flavor 是真正有效的备路——
   * 这比降级到付费 API 划算得多，用户明确要求不要碰付费额度。
   */
  findInfo(flavor) {
    for (const c of CANDIDATE_INFO) {
      if (flavor && c.flavor !== flavor) continue
      if (fs.existsSync(c.file)) return c
    }
    return null
  }

  /** 当前还有哪些 flavor 的凭据文件存在 */
  availableFlavors() {
    return CANDIDATE_INFO.filter((c) => fs.existsSync(c.file)).map((c) => c.flavor)
  }

  /** 找桌面端可执行文件 */
  findExe() {
    if (this.exe) return this.exe
    for (const p of CANDIDATE_EXES) {
      if (fs.existsSync(p)) return p
    }
    return null
  }

  /**
   * 拿一份可用凭据（带缓存）。
   * 返回 {accessToken, uid, domain, flavor, headers 里要用的东西}
   *
   * @param {object} [p]
   * @param {boolean} [p.forceRefresh]
   * @param {string} [p.flavor] 指定 'cn'/'global'，不传则用 this.preferFlavor（再回退默认顺序）
   *
   * 缓存是**按 flavor 分开**的：两个账号的 token 不能互相顶掉。
   */
  async credential({ forceRefresh = false, flavor } = {}) {
    const want = flavor || this.preferFlavor || null
    const ck = want || 'default'
    const slot = this.cache.get(ck)
    const fresh = slot && Date.now() - slot.at < this.credentialTtlMs
    if (slot && fresh && !forceRefresh) return slot.cred

    const info = this.findInfo(want)
    if (!info) {
      const err = new Error(
        want
          ? `未找到 ${want} 版 WorkBuddy 凭据（${want === 'cn' ? 'workbuddy-desktop.info' : 'workbuddy-desktop-ai.info'}），该版本桌面端是否登录过？`
          : '未找到 WorkBuddy 凭据文件，请先登录 WorkBuddy 桌面端',
      )
      err.code = 'NO_CREDENTIAL_FILE'
      err.flavor = want || undefined
      this.lastError = err
      throw err
    }
    const exe = this.findExe()
    if (!exe) {
      const err = new Error('未找到 WorkBuddy 桌面端程序（D:\\APP\\WorkBuddy\\WorkBuddy.exe）')
      err.code = 'NO_DESKTOP_APP'
      this.lastError = err
      throw err
    }

    const raw = JSON.parse(fs.readFileSync(info.file, 'utf8'))
    const auth = raw.auth || {}
    const account = raw.account || {}

    let secret
    try {
      secret = await readAtRestSecretKey(exe, this.logger)
    } catch (e) {
      const err = new Error(`读取 WorkBuddy 密钥失败：${e.message}（桌面端是否已登录并对本机可用？）`)
      err.code = 'NO_SECRET'
      this.lastError = err
      throw err
    }

    const protectorKey = crypto.createHash('sha256').update(secret, 'utf8').digest()
    let accessToken, refreshToken
    try {
      accessToken = maybeDecrypt(auth.accessToken, protectorKey)
      refreshToken = maybeDecrypt(auth.refreshToken, protectorKey)
    } catch (e) {
      const err = new Error(`解密 token 失败：${e.message}`)
      err.code = 'DECRYPT_FAILED'
      this.lastError = err
      throw err
    }
    if (!accessToken) {
      const err = new Error('凭据里没有 accessToken，请重新登录 WorkBuddy')
      err.code = 'NO_ACCESS_TOKEN'
      this.lastError = err
      throw err
    }

    const cred = {
      accessToken,
      refreshToken,
      uid: account.uid,
      enterpriseId: account.enterpriseId || account.enterprise_id,
      domain: auth.domain,
      flavor: info.flavor,
      infoFile: info.file,
      expiresAt: auth.expiresAt,
    }
    this.cache.set(ck, { cred, at: Date.now() })
    this.lastError = null
    this.logger('debug', `凭据已加载：${path.basename(info.file)} flavor=${cred.flavor} uid=${cred.uid || '?'} 到期=${cred.expiresAt ? new Date(cred.expiresAt).toISOString() : '?'}`)
    return cred
  }

  buildHeaders(cred) {
    const origin = ORIGIN_BASE[cred.flavor] || ORIGIN_BASE.cn
    const h = {
      Accept: 'application/json, text/plain, */*',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: origin,
      Referer: origin + '/',
      'User-Agent': `WorkBuddy/${APP_VERSION} WorkBuddy/${APP_VERSION}`,
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cred.accessToken}`,
      'X-IDE-Type': 'WorkBuddy',
      'X-IDE-Name': 'WorkBuddy',
      'X-IDE-Version': APP_VERSION,
      'X-Product': 'SaaS',
      'X-Conversation-ID': crypto.randomUUID(),
      'X-Conversation-Request-ID': crypto.randomUUID(),
      'X-Conversation-Message-ID': crypto.randomUUID(),
    }
    if (cred.uid) h['X-User-Id'] = cred.uid
    else h['X-No-User-Id'] = '1'
    if (cred.enterpriseId) h['X-Enterprise-Id'] = cred.enterpriseId
    else h['X-No-Enterprise-Id'] = '1'
    if (cred.domain) h['X-Domain'] = cred.domain
    else h['X-No-Department-Info'] = '1'
    return h
  }

  /**
   * 发一次对话请求，流式收集成整段文本。
   *
   * @param {object} p
   * @param {Array<{role:string, content:string}>} p.messages
   * @param {string} [p.system]
   * @param {number} [p.maxTokens]
   * @param {number} [p.temperature]
   * @param {AbortSignal} [p.signal]
   * @param {(t:string)=>void} [p.onDelta] 流式回调
   * @returns {Promise<{ok:boolean, text:string, error?:string, code?:string, usage?:object}>}
   */
  async chat({ messages, system, maxTokens = 1024, temperature = 0.85, signal, onDelta, flavor }) {
    const msgs = []
    if (system) msgs.push({ role: 'system', content: system })
    // content 既可以是字符串（纯文本），也可以是块数组（带图的多模态）。
    // 原样透传，不做转换——上游就是 OpenAI 兼容格式。
    for (const m of messages) msgs.push({ role: m.role, content: m.content })
    return this.request({ messages: msgs, maxTokens, temperature, signal, onDelta, flavor })
  }

  /**
   * 看一眼图片，返回一句画面描述。
   *
   * 专门给「学习表情包」用：它要的不是聊天，是一个能当文件名/检索标签的短描述，
   * 所以温度压到 0.2、maxTokens 压到 120，并要求它只输出描述本身。
   *
   * @param {Buffer} buffer
   * @param {string} mime
   * @returns {Promise<string>}
   */
  async describeImage(buffer, mime = 'image/png') {
    const dataUrl = `data:${mime};base64,${buffer.toString('base64')}`
    const res = await this.request({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text:
                '判断这张图能不能当聊天表情包用，能就给出中文描述。\n' +
                '规则：\n' +
                '1. 如果图里是界面、表格、文档、代码、图表、网页、账单、设置页等"截图类"内容，只输出「不适合」。\n' +
                '2. 如果图里是真人照片、证件、聊天记录、含辱骂性文字，只输出「不适合」。\n' +
                '3. 否则输出一行描述：用「_」连接 2~5 个中文词，写画面、情绪、动作，例如：猫猫_无语_翻白眼。\n' +
                '只输出那一行，不要解释，不要出现人名、ID、账号。',
            },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
      // 2026-10-21：120 → 300，理由同 gateway.js（reasoning 会吃掉小预算）。
      maxTokens: 300,
      temperature: 0.2,
    })
    if (!res.ok) throw new Error(res.error || res.code || '描述失败')
    return String(res.text || '').trim().split('\n')[0].trim()
  }

  /**
   * 底层请求。chat / describeImage 都走这里。
   * @private
   */
  async request({ messages, maxTokens = 1024, temperature = 0.85, signal, onDelta, flavor }) {
    const cred = await this.credential({ flavor })
    const base = CHAT_BASE[cred.flavor] || CHAT_BASE.cn
    const url = `${base}/v2/chat/completions`

    const body = {
      model: this.model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: true,
      // 要 usage 帧：最后一帧带 usage.credit，是**逐请求精确计费值**。
      // 没有它就只能靠 billing 接口反推，而那个接口滞后几十秒且按批聚合，
      // 做不了"超了就停"的实时拦截（实测过，见 lib/budget.js 文件头）。
      stream_options: { include_usage: true },
    }

    let resp
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: this.buildHeaders(cred),
        body: JSON.stringify(body),
        signal,
      })
    } catch (e) {
      if (e?.name === 'AbortError') return { ok: false, error: 'aborted', code: 'ABORTED' }
      // 凭据可能过期了：清这个 flavor 的缓存，下一次会重新读
      this.cache.delete(cred.flavor || 'default')
      return { ok: false, error: `网络请求失败：${e.message}`, code: 'NETWORK' }
    }

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '')
      // 401/403 通常是 token 失效，清缓存让下次重取
      if (resp.status === 401 || resp.status === 403) {
        this.cache.delete(cred.flavor || 'default')
      }

      /**
       * 429 单独拎出来：它跟"token 坏了"不是一类问题，不能混着处理。
       *
       * 这是实测踩过的：DSH 主对话和 Molly 共用同一个 WorkBuddy 账号，
       * 主力对话把频率额度打满时，Molly 这边收到的也是 429。
       * 上游回复里会带重置时间（reset at ... UTC+8），能解析就解析出来。
       *
       * 关键：429 是**按账号**限的。国内版和国际版是两份独立额度
       * （实测同一时刻 cn 能聊、global 报 429）。所以上层拿到 RATE_LIMIT 后
       * 应该先换 flavor 再试，而不是去动付费 API。
       */
      if (resp.status === 429) {
        const m = txt.match(/reset at\s+(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2})/i)
        return {
          ok: false,
          error: '免费额度被限流了（429）',
          code: 'RATE_LIMIT',
          flavor: cred.flavor,
          retryAt: m ? m[1] : null,
          retryAfter: Number(resp.headers.get('retry-after')) || null,
        }
      }

      return {
        ok: false,
        error: `HTTP ${resp.status} ${txt.slice(0, 300)}`,
        code: resp.status === 401 || resp.status === 403 ? 'AUTH' : `HTTP_${resp.status}`,
      }
    }

    const ctype = resp.headers.get('content-type') || ''
    // 非流式（服务端偶尔会降级）
    if (!ctype.includes('event-stream')) {
      try {
        const j = await resp.json()
        const text = j.choices?.[0]?.message?.content ?? j.choices?.[0]?.delta?.content ?? ''
        if (onDelta && text) onDelta(text)
        return { ok: true, text, usage: j.usage }
      } catch (e) {
        return { ok: false, error: `响应解析失败：${e.message}`, code: 'PARSE' }
      }
    }

    let text = ''
    let buf = ''
    let usage = null
    const dec = new TextDecoder()
    try {
      for await (const chunk of resp.body) {
        buf += dec.decode(chunk, { stream: true })
        let idx
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim()
          buf = buf.slice(idx + 1)
          if (!line.startsWith('data:')) continue
          const data = line.slice(5).trim()
          if (!data || data === '[DONE]') continue
          try {
            const j = JSON.parse(data)
            const delta = j.choices?.[0]?.delta?.content
            if (delta) {
              text += delta
              if (onDelta) onDelta(delta)
            }
            // include_usage 让带 usage 的那一帧跟 delta 帧分开来。
            // 它可能是 choices:[] 的独立帧，所以不能挂在 delta 判断里。
            if (j.usage) usage = j.usage
          } catch {
            /* 分片跨包，忽略 */
          }
        }
      }
    } catch (e) {
      if (e?.name === 'AbortError') return { ok: false, error: 'aborted', code: 'ABORTED' }
      return { ok: false, error: `流读取失败：${e.message}`, code: 'STREAM' }
    }

    return { ok: true, text, usage }
  }

  /**
   * 健康检查：只验证凭据能拿到并解密成功，不发模型请求（省钱省时间）。
   * 给状态指示灯用。
   *
   * @param {string} [flavor] 想查哪个版本；不传则查当前 preferFlavor / 默认顺序第一个
   */
  async health(flavor) {
    try {
      const cred = await this.credential({ flavor })
      return {
        ok: true,
        uid: cred.uid,
        flavor: cred.flavor,
        expiresAt: cred.expiresAt,
        infoFile: path.basename(cred.infoFile),
        available: this.availableFlavors(),
      }
    } catch (e) {
      return { ok: false, error: e.message, code: e.code || 'UNKNOWN', available: this.availableFlavors() }
    }
  }

  /** 两个 flavor 各自的凭据状态，给挂件展示「两份额度都在不在」 */
  async healthAll() {
    const out = {}
    for (const f of CANDIDATE_INFO) {
      if (!fs.existsSync(f.file)) { out[f.flavor] = { ok: false, error: '未登录', code: 'NO_CREDENTIAL_FILE' }; continue }
      out[f.flavor] = await this.health(f.flavor)
    }
    return out
  }
}
