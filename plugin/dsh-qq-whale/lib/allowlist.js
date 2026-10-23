/**
 * 白名单运行时管理（2026-10-23，主人 m00608）。
 *
 * 背景：主人想直接对 Molly 说「把群 123456789 加进白名单」，以前没人接——
 * `#code` 会把话丢给干活会话，而干活会话没有改宿主配置的权限；
 * 直接改 `cordis.patch.yml` 又会被 `plugin_manager` 在每次切换插件时整份重写
 * （手改的注释和值都会丢，见 docs/STATE.md §5）。
 *
 * 所以这里落一层**运行时覆盖**（`<dataDir>/allowlist-overrides.json`）：
 *   - 启动时 merge 进 `config.allowedUsers / allowedGroups / commandGroups`；
 *   - 谁当场加的记在 overrides 里，重启后还在，不需要重启宿主；
 *   - 要撤掉某条（包括 yml 里手写的）就记进 `removed*`，merge 时过滤掉；
 *   - yml 只当「出厂默认」，运行时的增删都在 json 里，互不覆盖。
 *
 * 这里全是纯函数（解析 / 合并 / 报告），engine 只负责写盘 + 回话；
 * 好处是 `POST /dsh-qq-whale/allowlist/test` 能不开 QQ 就把解析验一遍。
 */

import fs from 'node:fs'
import path from 'node:path'

export const ALLOWLIST_FILE = 'allowlist-overrides.json'

const LIST_OF = { group: 'groups', user: 'users', commandGroup: 'commandGroups' }
const REMOVED_OF = { group: 'removedGroups', user: 'removedUsers', commandGroup: 'removedCommandGroups' }

const KIND_LABEL = {
  group: '发言白名单（群）',
  user: '私聊白名单（人）',
  commandGroup: '命令群',
}

function emptyOverrides() {
  return {
    version: 1,
    users: [],
    groups: [],
    commandGroups: [],
    removedUsers: [],
    removedGroups: [],
    removedCommandGroups: [],
    updatedAt: 0,
  }
}

function uniqueStrings(list) {
  const out = []
  for (const raw of Array.isArray(list) ? list : []) {
    const s = String(raw ?? '').trim()
    if (!s || out.includes(s)) continue
    out.push(s)
  }
  return out
}

/** 把盘上读到的对象规整成固定形状（缺字段补空、脏值丢掉） */
export function sanitizeOverrides(input) {
  const base = emptyOverrides()
  if (!input || typeof input !== 'object') return base
  for (const key of ['users', 'groups', 'commandGroups', 'removedUsers', 'removedGroups', 'removedCommandGroups']) {
    base[key] = uniqueStrings(input[key])
  }
  base.updatedAt = Number(input.updatedAt) || 0
  return base
}

/** 读覆盖文件；不存在/坏了都当空的（写坏了不该让插件起不来） */
export function loadOverrides(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8')
    return sanitizeOverrides(JSON.parse(raw))
  } catch {
    return emptyOverrides()
  }
}

/** 写覆盖文件；返回是否成功（回话前要知道有没有真落盘） */
export function saveOverrides(file, overrides) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(sanitizeOverrides(overrides), null, 2)}\n`, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 全角数字转半角 + 去掉所有空白。
 * QQ 里全角数字、空格、换行都很常见（尤其手打），不归一化就「加 123456789」都匹配不上。
 */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/[\uFF10-\uFF19]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[\s\u3000]+/gu, '')
    .trim()
}

/** 剥掉显式覆盖前缀（`#code / #work / #chat`）和 `命令 ` 前缀 */
export function stripCommandPrefix(text) {
  let s = String(text ?? '').trim()
  for (let i = 0; i < 2; i++) {
    const next = s.replace(/^#(?:chat|work|code)\s*/iu, '').replace(/^命令\s*[:：]?\s*/u, '')
    if (next === s) break
    s = next.trim()
  }
  return s
}

/** 这条话要加/删的是哪一类名单 */
function detectKind(t) {
  if (/(?:命令群|能执行命令|可以执行命令)/u.test(t)) return 'commandGroup'
  if (/(?:群号|群聊|群)/u.test(t)) return 'group'
  if (/(?:好友|私聊|朋友|uin|qq|人)/iu.test(t)) return 'user'
  return 'unknown'
}

/**
 * 解析「白名单」指令。
 *
 * 返回 null = 不是白名单指令（原样走会话路由，不抢别人的话）；
 * 否则 { action: 'add'|'del'|'check'|'list'|'ask', kind, ids, why }
 */
export function parseAllowlistCommand(text) {
  const stripped = stripCommandPrefix(text)
  if (!stripped) return null
  const t = normalizeText(stripped)
  if (!/白名单|allowlist/iu.test(t)) return null

  const ids = uniqueStrings(t.match(/\d{5,12}/g) || [])
  const hasAdd = /(?:添加|增加|加入|放进|拉进|塞进|加)/u.test(t)
  const hasDel = /(?:删除|删掉|移除|去掉|移出|取消|踢|删)/u.test(t)
  const kind = detectKind(t)

  if (hasAdd && !hasDel) {
    if (!ids.length) return { action: 'ask', kind, ids, why: 'no-id' }
    if (kind === 'unknown') return { action: 'ask', kind, ids, why: 'no-kind' }
    return { action: 'add', kind, ids }
  }
  if (hasDel && !hasAdd) {
    if (!ids.length) return { action: 'ask', kind, ids, why: 'no-id' }
    if (kind === 'unknown') return { action: 'ask', kind, ids, why: 'no-kind' }
    return { action: 'del', kind, ids }
  }
  if (hasAdd && hasDel) return { action: 'ask', kind, ids, why: 'add-or-del' }
  if (ids.length) return { action: 'check', kind, ids }
  return { action: 'list', kind: '', ids: [] }
}

/** 把一次 add/del 落进 overrides（纯函数，返回新对象） */
export function applyChange(overrides, { action, kind, ids }) {
  const o = sanitizeOverrides(overrides)
  const listKey = LIST_OF[kind]
  const removedKey = REMOVED_OF[kind]
  if (!listKey || !Array.isArray(ids) || !ids.length) return o
  for (const raw of ids) {
    const id = String(raw ?? '').trim()
    if (!id) continue
    if (action === 'add') {
      o[removedKey] = o[removedKey].filter((x) => String(x) !== id)
      if (!o[listKey].includes(id)) o[listKey].push(id)
    } else if (action === 'del') {
      o[listKey] = o[listKey].filter((x) => String(x) !== id)
      if (!o[removedKey].includes(id)) o[removedKey].push(id)
    }
  }
  o.updatedAt = Date.now()
  return o
}

function mergeList(base, extra, removed) {
  const skip = new Set(uniqueStrings(removed))
  const out = []
  for (const raw of [...(Array.isArray(base) ? base : []), ...(Array.isArray(extra) ? extra : [])]) {
    const s = String(raw ?? '').trim()
    if (!s || skip.has(s) || out.includes(s)) continue
    out.push(s)
  }
  return out
}

/** yml 默认值 + 运行时覆盖 = 此刻真正的三份名单 */
export function mergedConfigView(config, overrides) {
  const o = sanitizeOverrides(overrides)
  return {
    users: mergeList(config?.allowedUsers, o.users, o.removedUsers),
    groups: mergeList(config?.allowedGroups, o.groups, o.removedGroups),
    commandGroups: mergeList(config?.commandGroups, o.commandGroups, o.removedCommandGroups),
  }
}

/** 给主人看的全量名单 */
export function reportAllowlist(config, overrides) {
  const o = sanitizeOverrides(overrides)
  const view = mergedConfigView(config, o)
  const block = (title, list) => {
    if (!list.length) return `${title}：空`
    return `${title}（${list.length}）：\n${list.map((x) => `· ${x}`).join('\n')}`
  }
  const lines = [
    block('群白名单（能插话的群）', view.groups),
    block('私聊白名单（能私聊我的人）', view.users),
    block('命令群（「命令 」真的执行）', view.commandGroups),
  ]
  const runtime = []
  if (o.groups.length) runtime.push(`群 +${o.groups.length}`)
  if (o.users.length) runtime.push(`人 +${o.users.length}`)
  if (o.commandGroups.length) runtime.push(`命令群 +${o.commandGroups.length}`)
  if (runtime.length) lines.push(`（其中运行时加的：${runtime.join('、')}；存在 allowlist-overrides.json，yml 没动）`)
  return lines.join('\n')
}

/** 单个「在不在」查询的回答 */
export function describeMembership(config, overrides, ids) {
  const o = sanitizeOverrides(overrides)
  const view = mergedConfigView(config, o)
  const where = [
    ['groups', '群白名单'],
    ['users', '私聊白名单'],
    ['commandGroups', '命令群'],
  ]
  const out = []
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw ?? '').trim()
    if (!id) continue
    const hit = where.filter(([key]) => view[key].includes(id)).map(([, label]) => label)
    out.push(`${id}：${hit.length ? `在 ${hit.join('、')} 里` : '不在任何白名单里'}`)
  }
  return out.join('\n')
}

/** add/del 成功后的回话 */
export function describeChange({ action, kind, ids, ok }) {
  const label = KIND_LABEL[kind] || '白名单'
  const list = ids.join('、')
  if (!ok) return `想改${label}，但写 allowlist-overrides.json 失败了，先别信这条改动——我一会儿再试。`
  if (action === 'add') {
    if (kind === 'group') return `好，已把群 ${list} 加进发言白名单。那个群里我能正常接话了。`
    if (kind === 'user') return `好，已把 ${list} 加进私聊白名单，这个人现在可以直接私聊我。`
    return `好，已把群 ${list} 加进命令群，「命令 」前缀在那会真的执行。`
  }
  if (kind === 'group') return `好，已把群 ${list} 从发言白名单里移出，那个群里我不再主动接话。`
  if (kind === 'user') return `好，已把 ${list} 从私聊白名单里移出。`
  return `好，已把群 ${list} 从命令群里移出，那边的「命令 」不再执行。`
}

/** 解析不清时的追问话术 */
export function describeAsk({ kind, ids, why }) {
  const id = ids?.[0] || 'xxx'
  if (why === 'no-id') return '听懂了，但没看到号码：把群号或 QQ 号一起发我，例如「命令 加群白名单 123456789」。'
  if (why === 'no-kind') {
    return `听懂了，但不确定 ${ids?.join('、') || id} 是群号还是 QQ 号：回「命令 加群白名单 ${id}」或「命令 加人白名单 ${id}」就行。`
  }
  if (why === 'add-or-del') return `这条同时像「加」和「删」：想加就回「命令 加群白名单 ${id}」，想删就回「命令 删群白名单 ${id}」。`
  return `没听清是哪一类名单（群 ${kind === 'group' ? '✓' : '✗'}）：把「群」或「人」写进去，例如「命令 加群白名单 ${id}」。`
}
