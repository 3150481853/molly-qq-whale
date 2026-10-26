/**
 * 记忆池加密（2026-10-23，主人 m00709 第 3 条）。
 *
 * 定案：**密钥不跟密文放一起**。
 *   - 密文：`${MOLLY_ROOT}\data\qq-whale\memory\memory.json` / `memory.md.enc`
 *   - 密钥：`${MOLLY_ROOT}\keys\memory.key`（单独的 G 盘文件夹，可用 config.memoryKeyFile 改）
 *   - 备份：快照（密文）进 D:\MollyBackup\memory 和 ${MOLLY_ROOT}Backup\memory；
 *     密钥单独拷到 D:\MollyBackup\keys 和 ${MOLLY_ROOT}Backup\keys
 *
 * 为什么这么放：备份脚本每 4 小时把一个快照目录整个拷走，如果密钥躺在密文目录里，
 * 任何拿到备份的人（网盘同步、误发、家人翻文件夹）都能直接解开，加密就白做了。
 * 分开放之后，**只拿到数据 = 打不开，只拿到钥匙 = 没有数据**。
 * 代价：钥匙丢了 = 记忆池永久锁死（所以备了两份，且不和密文同目录）。
 * 威胁模型只覆盖"随手打开 / 备份外泄"，不覆盖整台机器被控。
 *
 * 算法 AES-256-GCM：带认证标签，密文被改一个字节就解不开，不会静默读出乱码。
 * 信封格式（JSON，可直接 cat）：
 *   { version: 2, enc: "aes-256-gcm", iv: b64, tag: b64, data: b64, at: ISO }
 * 这把数据文件写成"一眼能看出是加密的"，但**没钥匙只能看到 base64 噪声**。
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const ALGO = 'aes-256-gcm'
const IV_BYTES = 12
const KEY_BYTES = 32

/** 环境变量覆盖（临时救援/迁移用；不要写进配置文件，免得密钥又多一份落盘） */
export const KEY_ENV = 'MOLLY_MEMORY_KEY'
/**
 * 老默认位置（本机约定，写死 G 盘）。新版本**不再用它做创建目标**——
 * 换台机器没有 G 盘时 mkdir 会 ENOENT，插件看着加载成功、实际记忆全空。
 * 只在「查找已有钥匙」时兜底，兼容老部署。
 */
export const DEFAULT_KEY_FILE = 'G:\\Molly\\keys\\memory.key'
/** 新约定：钥匙放在数据目录**同级**的这个文件夹里（和密文分开放，理由见文件头） */
export const KEY_DIR_NAME = 'qq-whale-keys'

/**
 * 按优先级列出候选密钥文件（不判断存在性）。
 * 顺序：
 *   1. `<dataDir 的父目录>/qq-whale-keys/memory.key`（1.1.5 起的新约定，也是新建时的落点）
 *   2. `<dataDir>/memory.key`（极简部署：数据目录里单独放一把）
 *   3. `${MOLLY_ROOT}\keys\memory.key`（老默认，只读兜底，绝不拿来新建）
 *
 * @param {{dataDir?: string, legacy?: string}} [options]
 * @returns {string[]}
 */
export function keyCandidates({ dataDir = '', legacy = DEFAULT_KEY_FILE } = {}) {
  const list = []
  const base = String(dataDir || '').trim()
  if (base) {
    const abs = path.resolve(base)
    list.push(path.join(path.dirname(abs), KEY_DIR_NAME, 'memory.key'))
    list.push(path.join(abs, 'memory.key'))
  }
  if (String(legacy || '').trim()) list.push(String(legacy).trim())
  return list
}

/**
 * 决定这次到底用哪把钥匙：
 *   显式配置 > 已存在的候选（按 keyCandidates 顺序）> 新约定的落点（准备新建）
 *
 * @param {{keyFile?: string, dataDir?: string, legacy?: string}} [options]
 * @returns {string}
 */
export function resolveKeyFile({ keyFile = '', dataDir = '', legacy = DEFAULT_KEY_FILE } = {}) {
  const explicit = String(keyFile || '').trim()
  if (explicit) return explicit
  const candidates = keyCandidates({ dataDir, legacy })
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return file
    } catch {
      /* 无权限读父目录时跳过这个候选，继续下一个 */
    }
  }
  return candidates[0] || DEFAULT_KEY_FILE
}

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
 */
export function loadKey({ keyFile = DEFAULT_KEY_FILE, create = false } = {}) {
  const env = process.env[KEY_ENV]
  if (env) return { key: parseKey(env), source: 'env', file: keyFile }
  try {
    return { key: parseKey(fs.readFileSync(keyFile, 'utf8')), source: 'file', file: keyFile }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
    if (!create) throw new Error(`记忆密钥文件不存在：${keyFile}（丢了钥匙，加密的记忆解不开）`)
    const key = crypto.randomBytes(KEY_BYTES)
    fs.mkdirSync(path.dirname(keyFile), { recursive: true })
    // mode 在 Windows 上只决定"只读"位，真正保护靠的是目录 ACL（用户 profile 外）
    fs.writeFileSync(keyFile, `${key.toString('hex')}\n`, { encoding: 'utf8', mode: 0o600 })
    return { key, source: 'created', file: keyFile }
  }
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
