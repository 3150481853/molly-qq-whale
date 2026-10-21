/**
 * 运行时模型覆盖（task-56）：把「用户自己在控制台切模型」做成一个落盘的小文件。
 *
 * 设计要点：
 *   1. **只覆盖内存**。写 `model-override.json`，启动时读出来盖在 config 上；
 *      `cordis.patch.yml` 一个字节都不改——下次重载还是 yml 说了算，除非文件还在。
 *   2. **三种形状都吃**。`chatModel` 在配置里是 `{provider, model}`，早期版本是字符串，
 *      覆盖时要保持原形状，不然下游 `chatModelName()` 会读不到。
 *   3. **写盘 tmp + rename**。写到一半断电也不会留下半个 JSON（下次启动读坏文件
 *      会让整台机器人起不来，这个代价太大）。
 */

import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/**
 * 「模型切换仅限控制台」的鉴权（2026-10-20 用户 m39817 拍板）。
 *
 * 为什么必须带 token：QQ 里的干活会话有 pwsh 工具，一句「命令 把模型切成 pro」
 * 就能 curl 到 7053——命令层的角色门拦的是**命令文本**，拦不住 HTTP。
 * 所以写接口自己上一把锁：
 *   - 配置 `modelSwitchToken` 为空 → **一律 403**（默认就是空，等于默认关闭）；
 *   - 头 `x-molly-admin` 必须与 token 定长相等（用 timingSafeEqual，别用 ===）。
 *
 * 顺带：token 绝不进日志。
 */
export const SWITCH_HEADER = 'x-molly-admin'

/** 定长比较：先各自 sha256 再 timingSafeEqual，避免长度泄漏 */
export function tokenEquals(a, b) {
  const ha = crypto.createHash('sha256').update(String(a ?? '')).digest()
  const hb = crypto.createHash('sha256').update(String(b ?? '')).digest()
  return crypto.timingSafeEqual(ha, hb) && String(a ?? '').length > 0 && String(a ?? '') === String(b ?? '')
}

/**
 * @param {string} token 配置里的 modelSwitchToken
 * @param {string} provided 请求头里的值
 * @returns {{ok:boolean, status:number, message:string}}
 */
export function authorizeSwitch(token, provided) {
  const need = String(token ?? '')
  if (!need) {
    return { ok: false, status: 403, message: '切模型只能在控制台里做（插件没配 modelSwitchToken，写接口默认关闭）。' }
  }
  if (!tokenEquals(need, provided)) {
    return { ok: false, status: 403, message: '切模型只能在控制台里做。' }
  }
  return { ok: true, status: 200, message: '' }
}

/** 覆盖文件名（落在 dataDir 下，和 memory/pending 同一个目录） */
export const OVERRIDE_FILE = 'model-override.json'

/**
 * 允许切换的模型清单。
 *
 * 拿不到网关 `/v1/models` 时就用这张表（写死但注明来源）：
 *   - `deepseek-v4.1-flash`：intl 免费车道，0 积分，日常聊天默认
 *   - `deepseek-v4-pro`：强一点，按积分计费，降智/难问题时用
 *   - `kimi-k2.6`：干活的默认模型
 *   - `glm-5.3`：备用，长上下文
 */
export const AVAILABLE = Object.freeze([
  { id: 'deepseek-v4.1-flash', label: 'DeepSeek V4.1 Flash', costHint: '免费（intl 车道）' },
  { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', costHint: '按积分计费' },
  { id: 'kimi-k2.6', label: 'Kimi K2.6', costHint: '按积分计费' },
  { id: 'glm-5.3', label: 'GLM 5.3', costHint: '按积分计费' },
])

export const ROLES = Object.freeze(['chat', 'work', 'code'])

export function isAvailable(id) {
  return AVAILABLE.some((m) => m.id === id)
}

/**
 * 网关 `/v1/models` 拿到的清单 → 可切换模型表（2026-10-21 修「下拉能选、保存 400」）。
 *
 * 背景：控制台的下拉是**拿网关 `/v1/models` 填的**（console-server 的 `gateway/models`），
 * 而插件这边原来只认写死的 `AVAILABLE` 四个。网关上架新模型（kimi-k3-1、kimi-k2.8-preview…）
 * 后，下拉看得见、一保存就 400「模型 id 不合法」。所以校验改成「静态表打底 + 网关多出来的补后面」：
 *   - 静态表在前，保证常用模型的 label/说明不变，也保证网关连不上时功能不塌；
 *   - 网关新增的补在后面，去重（同名保留静态项）；
 *   - 纯函数、不碰网络，`web.js` 负责取数据 + 缓存，`test-model-switch.mjs` 直接单测这里。
 *
 * @param {Array<{id?:string,name?:string,credits?:string}>|string[]} models 网关返回的 `data` 数组
 * @returns {Array<{id:string,label:string,costHint:string,fromGateway?:boolean}>}
 */
export function mergeGatewayModels(models = []) {
  const out = AVAILABLE.map((m) => ({ ...m }))
  const seen = new Set(out.map((m) => m.id))
  for (const raw of Array.isArray(models) ? models : []) {
    const id = String((raw && typeof raw === 'object' ? raw.id : raw) ?? '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    const name = String((raw && typeof raw === 'object' ? raw.name : '') ?? '').trim()
    const credits = String((raw && typeof raw === 'object' ? raw.credits : '') ?? '').trim()
    out.push({ id, label: name || id, costHint: credits ? `网关计费 ${credits}` : '', fromGateway: true })
  }
  return out
}

/**
 * 由配置里的 `gatewayBaseUrl` 推网关模型清单地址。
 *
 * 配置里是 `http://127.0.0.1:8788/v1/chat/completions`；也兼容填到 `/v1`、填完整 models
 * 地址、甚至只填裸 base 的情况——别让一个结尾斜杠把切模型功能弄挂。
 */
export function modelsUrlOf(gatewayBaseUrl) {
  const base = String(gatewayBaseUrl ?? '').trim().replace(/\/+$/, '')
  if (!base) return ''
  const chat = base.match(/^(.*)\/v1\/chat\/completions$/i)
  if (chat) return `${chat[1]}/v1/models`
  const chat2 = base.match(/^(.*)\/chat\/completions$/i)
  if (chat2) return `${chat2[1]}/models`
  if (/\/v1\/models$/i.test(base)) return base
  if (/\/v1$/i.test(base)) return `${base}/models`
  return `${base}/v1/models`
}

/** 读覆盖文件。不存在 / 解析失败都返回 null（坏文件不能把机器人拖死） */
export function readOverride(dir) {
  if (!dir) return null
  const file = path.join(dir, OVERRIDE_FILE)
  try {
    const raw = fs.readFileSync(file, 'utf8')
    const j = JSON.parse(raw)
    const out = {}
    for (const r of ROLES) if (j?.[r]) out[r] = String(j[r])
    if (!Object.keys(out).length) return null
    if (j?.updatedAt) out.updatedAt = Number(j.updatedAt)
    return out
  } catch {
    return null
  }
}

/**
 * 写覆盖文件（tmp + rename）。
 * 传进来的 patch 会**合并**到已有覆盖上：只改 chat 时不该把之前的 work 覆盖清掉。
 */
export function writeOverride(dir, patch, now = Date.now()) {
  if (!dir) throw new Error('dataDir 未配置')
  const file = path.join(dir, OVERRIDE_FILE)
  const prev = readOverride(dir) || {}
  const next = { ...prev }
  for (const r of ROLES) if (patch?.[r]) next[r] = String(patch[r])
  next.updatedAt = now
  fs.mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
  return next
}

/** 把 `{chat, work, code}` 盖到 config 的三个字段上（保持原有形状） */
export function applyToConfig(config, ov = {}) {
  if (!config || !ov) return config
  for (const role of ROLES) {
    const id = ov[role]
    if (!id) continue
    const field = `${role}Model`
    const cur = config[field]
    if (typeof cur === 'string' || cur === undefined || cur === null) {
      config[field] = { provider: config.provider || 'wb-proxy', model: id }
    } else if (typeof cur === 'object') {
      config[field] = { ...cur, model: id }
    } else {
      config[field] = { provider: config.provider || 'wb-proxy', model: id }
    }
  }
  return config
}

/** 取当前生效值（给 GET /model 用） */
export function currentOf(config = {}) {
  const pick = (v) => (typeof v === 'string' ? v : (v?.model ?? ''))
  return {
    chat: pick(config.chatModel) || pick(config.model),
    work: pick(config.workModel),
    code: pick(config.codeModel),
    degraded: pick(config.degradedModel),
    spare: pick(config.spareModel),
  }
}
