/**
 * 记忆池加密（2026-10-23，主人 m00709 第 3 条）。
 *
 * 定案：**密钥不跟密文放一起**。
 *   - 密文：`<dataDir>\memory\memory.json` / `memory.md.enc`
 *   - 密钥：dataDir 的兄弟目录 `qq-whale-keys\memory.key`（作者机显式配成 `${MOLLY_ROOT}\keys\memory.key`，
 *     部署机不配也行——默认从 dataDir 推出来，**任何机器都能跑**，2026-10-26 修）
 *   - 备份：快照（密文）进备份盘 memory/；密钥单独拷到备份盘 keys/
 *
 * 为什么这么放：备份脚本每 4 小时把一个快照目录整个拷走，如果密钥躺在密文目录里，
 * 任何拿到备份的人（网盘同步、误发、家人翻文件夹）都能直接解开，加密就白做了。
 * 分开放之后，**只拿到数据 = 打不开，只拿到钥匙 = 没有数据**。
 * 代价：钥匙丢了 = 记忆池永久锁死（所以备了两份，且不和密文同目录）。
 * 威胁模型只覆盖"随手打开 / 备份外泄"，不覆盖整台机器被控。
 *
 * 部署可移植性（2026-10-26 部署者反馈）：没有 `G:` 盘的机器过去会在 mkdir 处抛 ENOENT，
 * 而这一步发生在 MemoryStore 构造函数里 → ChatEngine 构造失败 → 插件「加载成功但 OneBot 从不连接」。
 * 现在密钥路径由 dataDir 推导，且建不出来时抛 `KeyUnavailableError`、由 MemoryStore 降级明文并告警。
 *
 * 算法 AES-256-GCM：带认证标签，密文被改一个字节就解不开，不会静默读出乱码。
 * 信封格式（JSON，可直接 cat）：
 *   { version: 2, enc: "aes-256-gcm", iv: b64, tag: b64, data: b64, at: ISO }
 * 这把数据文件写成"一眼能看出是加密的"，但**没钥匙只能看到 base64 噪声**。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12
const KEY_BYTES = 32

/** 环境变量覆盖（临时救援/迁移用；不要写进配置文件，免得密钥又多一份落盘） */
export const KEY_ENV = 'MOLLY_MEMORY_KEY'
/** 作者机上的历史位置（只有用户显式配成这个值时才会用到，代码不再默认指向它） */
export const LEGACY_KEY_FILE = 'G:\\Molly\\keys\\memory.key'

/**
 * 密钥不可用（盘不存在、没权限、目录建不出来…）。
 *
 * 单独一种错误类型的意义：调用方（MemoryStore）要能**明确区分**「钥匙丢了 = 数据真的解不开」
 * 和「这台机器根本建不出钥匙目录」——前者必须炸，后者应该降级成明文继续跑，
 * 否则部署者的插件会在 ChatEngine 构造函数里整条死掉（2026-10-26 部署者实测：
 * 没有 G: 盘 → mkdir ENOENT → 插件像加载成功、实际 OneBot 从未连过）。
 */
export class KeyUnavailableError extends Error {
  constructor(message, cause) {
    super(message)
    this.name = 'KeyUnavailableError'
    this.cause = cause
  }
}

/**
 * 默认密钥位置：**从数据目录推出来，不写死盘符**。
 *
 * 规则：`<dataDir 的父目录>/qq-whale-keys/memory.key`
 *   - 作者机 dataDir=${MOLLY_ROOT}\data\qq-whale → ${MOLLY_ROOT}\data\qq-whale-keys（显式配了 memoryKeyFile 时用配置的）
 *   - 默认 dataDir=<home>/.dsh/qq-whale → <home>/.dsh/qq-whale-keys
 * 仍然满足「密钥不和密文同目录」这一条安全前提（memory/ 里只有密文）。
 *
 * @param {{baseDir?: string}} [opts] baseDir = 数据目录（config.dataDir）
 */
export function defaultKeyFile({ baseDir } = {}) {
  const base = String(baseDir || process.env.MOLLY_DATA_DIR || '').trim()
  if (base) {
    try {
      return path.join(path.dirname(path.resolve(base)), 'qq-whale-keys', 'memory.key')
    } catch {
      /* 路径解析失败就落到 home 那条，不要因为推导路径把启动打断 */
    }
  }
  return path.join(os.homedir(), '.dsh', 'qq-whale', 'keys', 'memory.key')
}

/** 进程启动时的默认值（只给「没有 dataDir 上下文」的调用方用；MemoryStore 传 baseDir 自己算） */
export const DEFAULT_KEY_FILE = defaultKeyFile()

/** 是否是本模块产出的加密信封 */
export function isEnvelope(value) {
  return Boolean(
    value &&
      typeof value === 'object' &&
      value.enc === ALGO &&
      typeof value.iv === 'string' &&
      typeof value.tag === 'string' &&
      typeof value.data === 'string',
  )
}

/**
 * 解析密钥文本：接受 64 位 hex 或 base64（含 urlsafe）。
 * @param {string} raw
 * @returns {Buffer} 32 字节
 */
export function parseKey(raw) {
  const text = String(raw ?? '').trim()
  if (!text) throw new Error('记忆密钥为空')
  let buf = null
  if (/^[0-9a-fA-F]{64}$/.test(text)) {
    buf = Buffer.from(text, 'hex')
  } else {
    const compact = text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
    if (compact.length >= 40) {
      const pad = compact.length % 4 ? '='.repeat(4 - (compact.length % 4)) : ''
      buf = Buffer.from(compact + pad, 'base64')
    }
  }
  if (!buf || buf.length !== KEY_BYTES) {
    throw new Error(`记忆密钥长度不对（要 32 字节，即 64 位 hex），实际 ${buf ? buf.length : 0} 字节`)
  }
  return buf
}

/**
 * 读/建密钥。
 * @param {{keyFile?: string, create?: boolean}} options
 * @returns {{key: Buffer, source: string, file: string}}
 * @throws {KeyUnavailableError} 这台机器建不出 / 读不了密钥文件（调用方应降级明文）
 */
export function loadKey({ keyFile = DEFAULT_KEY_FILE, create = false } = {}) {
  const env = process.env[KEY_ENV]
  if (env) return { key: parseKey(env), source: 'env', file: keyFile }

  // ① 读文件：读不到是「环境问题」（盘不存在/权限/目录），降级明文，不炸启动
  let raw = ''
  try {
    raw = fs.readFileSync(keyFile, 'utf8')
  } catch (err) {
    if (err.code !== 'ENOENT') {
      // EACCES / EPERM / ENOTDIR / 盘符不存在 都归到这里：环境问题，不是数据问题
      throw new KeyUnavailableError(`记忆密钥不可读：${keyFile}（${err.code || err.message}）`, err)
    }
    if (!create) throw new Error(`记忆密钥文件不存在：${keyFile}（丢了钥匙，加密的记忆解不开）`)
    const key = crypto.randomBytes(KEY_BYTES)
    try {
      fs.mkdirSync(path.dirname(keyFile), { recursive: true })
      // mode 在 Windows 上只决定"只读"位，真正保护靠的是目录 ACL（用户 profile 外）
      fs.writeFileSync(keyFile, `${key.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 })
    } catch (err2) {
      throw new KeyUnavailableError(`记忆密钥目录建不出来：${keyFile}（${err2.code || err2.message}）`, err2)
    }
    return { key, source: 'created', file: keyFile }
  }

  // ② 解析：文件在但内容坏了属于「数据问题」，必须原样抛出 —— 静默降级会拿明文覆盖唯一一份密文
  return { key: parseKey(raw), source: 'file', file: keyFile }
}

/** @param {string} plainText @param {Buffer} key @returns {object} 信封 */
export function encryptText(plainText, key) {
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv(ALGO, key, iv)
  const data = Buffer.concat([cipher.update(Buffer.from(String(plainText), 'utf8')), cipher.final()])
  return {
    version: 2,
    enc: ALGO,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
    at: new Date().toISOString(),
  }
}

/** @param {object} envelope @param {Buffer} key @returns {string} 明文 */
export function decryptText(envelope, key) {
  if (!isEnvelope(envelope)) throw new Error('不是加密信封（可能还是旧的明文文件）')
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(envelope.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
  const out = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, 'base64')),
    decipher.final(),
  ])
  return out.toString('utf8')
}

/**
 * 原子写加密文件：先写 .tmp → 自检能解回原文 → rename。
 * 自检的意义：密钥/算法配错时宁可当场报错，也不要把 memory.json 写成一坨解不开的东西。
 * @param {string} file
 * @param {string} plainText
 * @param {Buffer} key
 */
export function writeEncryptedFile(file, plainText, key) {
  const envelope = encryptText(plainText, key)
  if (decryptText(envelope, key) !== plainText) throw new Error('加密自检失败：解不回原文')
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

/**
 * 读加密文件；不存在返回 null。
 * @param {string} file @param {Buffer} key
 */
export function readEncryptedFile(file, key) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (err) {
    if (err.code === 'ENOENT') return null
    throw err
  }
  const envelope = JSON.parse(raw)
  return decryptText(envelope, key)
}
