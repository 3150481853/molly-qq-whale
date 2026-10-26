/**
 * 干活会话的文件系统护栏（2026-10-20 task-41）。
 *
 * 用户要求（m25709）：「命令回话涉及代码改动的必须跟你这个主会话和 QQ 发送消息
 * 给我提交审核，双方同意后由你调度团队执行，不可以再在其他会话执行改动」。
 *
 * 为什么要「人设 + 代码闸门」两层：
 *   人设只约束模型的表达意愿，模型一糊涂就会去改；真正能保证「不落盘」的只有
 *   工具调用层的同步闸门。DSH 的 tools 服务提供了 `tools.guard(fn)`——它在
 *   tools/pre-execute 之后跑、返回字符串即拒绝，而且**没有任何后续监听器能
 *   把拒绝翻回允许**（见 dsh-tools README「monotonic synchronous guard」）。
 *   通过 `agent.ctx` 注册的 guard 只作用于那一个 agent，正好是干活会话。
 *
 * 设计取舍：
 *   - 只拦「写」类动作，不拦读。读源码不会有破坏性；全拦会让「帮我看看这个
 *     报错是什么意思」这类正常需求也变成哑巴。
 *   - shell 类工具（pwsh / bash / run_code）不能只看路径：`Get-Content` 和
 *     `Set-Content` 都带同一串路径。所以要求「受保护路径 + 变更性动词/重定向」
 *     同时命中才拒绝——宁可漏一点点只读探测，也不误杀正常查询。
 *   - 拒绝话术固定，不交给模型自由发挥（真机上它会把「审核」说成「做不到」）。
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

/** 插件包根（<包根>/lib/work-guard.js 往上两层）。换机器自动跟着走，不再写死盘符。 */
const PLUGIN_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

/** 这些前缀属于 Molly 自己的代码/配置/宿主数据，干活会话一律不许写。 */
export const PROTECTED_PREFIXES = [
  // 插件源码：自己所在的那份包（线上跑的是 profile 里的拷贝，这里跟着它走）
  PLUGIN_ROOT,
  // 宿主配置 / 会话数据
  path.join(os.homedir(), '.dsh', 'profiles'),
  // 老机器上的宿主工作区（存在才算，别的机器没这个盘就不列）
  ...(fs.existsSync('D:\\Documents\\deepseek-harness') ? ['D:\\Documents\\deepseek-harness'] : []),
]

/** 拦下之后对主人说的固定话术（不许改词，测试盯着）。 */
export const REVIEW_REPLY = '这类改动要先过审核：我已经把要做的事报给主人了，他点头我再动手。'

/** 给模型看的拒绝原因：明确「别重试、别换路径」，并给出该回的那句话。 */
export const DENY_REASON = (paths) =>
  `【需要人工审核】这次操作要改 Molly 自己的代码/配置（${paths.join('、')}），干活会话没有写权限，` +
  `已经拦下并报给主人了。不要重试、不要换路径或换工具绕过。直接用这句话回主人：${REVIEW_REPLY}`

/** 直接改文件的工具：只要参数里出现受保护路径就拦。 */
export const WRITE_TOOLS = new Set([
  'write',
  'write_file',
  'edit',
  'replace',
  'str_replace_editor',
  'apply_patch',
  'multi_edit',
])

/** 能间接写文件的工具：还要看命令里有没有变更动作。 */
export const SHELL_TOOLS = new Set(['pwsh', 'bash', 'run_code', 'shell', 'terminal'])

/** 变更性动词 / 重定向。只用于 shell 类工具的第二重判定。 */
const MUTATION_RE =
  /(?:>>?|Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content|Set-ItemProperty|New-ItemProperty|ni\s|rm\s|rmdir|del\s|move\s|copy\s|mv\s|cp\s|sed\s+-i|tee\s|truncate|chmod|chown|writeFile|writeFileSync|appendFile|createWriteStream|unlink|rename|mkdir|rmSync|touch\s|git\s+(?:apply|checkout|reset|clean|commit|add)|npm\s+(?:install|i)\b|pnpm\s+(?:add|install|i)\b)/i

/** 把任意写法的路径归一成小写、分隔符统一、去尾部反斜杠的 Windows 形式。 */
export function normalizePath(p) {
  let s = String(p || '').trim()
  if (!s) return ''
  // 路径常被引号/反引号/括号包着（`Set-Content "G:\..."`、`'G:/x'`），先剥掉
  s = s.replace(/^["'`(<]+/, '').replace(/[)"'`>,;]+$/, '')
  s = s.replace(/\//g, '\\')
  // 去掉 \\?\ 前缀与重复分隔符
  s = s.replace(/^\\\\\?\\/, '').replace(/\\{2,}/g, '\\')
  // 去掉尾部分隔符（根盘符 X:\ 例外）
  if (!/^[a-z]:\\$/i.test(s)) s = s.replace(/\\+$/, '')
  return s.toLowerCase()
}

/** 这个路径（或命令文本）是否落在受保护前缀里。 */
export function isProtectedPath(value) {
  const n = normalizePath(value)
  if (!n) return false
  return PROTECTED_PREFIXES.some((prefix) => {
    const p = normalizePath(prefix)
    return n === p || n.startsWith(p + '\\')
  })
}

/** 受保护前缀的出现位置（用于从命令/代码字符串里抠出路径，不管有没有空格）。 */
const PROTECTED_RE =
  /(?:g:[\\/]+molly[\\/]+qq-whale|d:[\\/]+documents[\\/]+deepseek-harness|c:[\\/]+users[\\/]+example[\\/]+\.dsh[\\/]+profiles)/gi

/**
 * 从一段可能很乱的文本（shell 命令、run_code 源码）里抠出受保护路径。
 * 从前缀命中处往后一直读到分隔符，这样 pending-code 里记的是具体文件而不是根目录。
 */
export function protectedHitsInText(text) {
  const out = new Set()
  const s = String(text || '')
  for (const m of s.matchAll(PROTECTED_RE)) {
    let tail = s.slice(m.index, m.index + 400)
    const stop = tail.search(/["'`),\s;>|]/)
    if (stop > 0) tail = tail.slice(0, stop)
    out.add(normalizePath(tail))
  }
  return [...out]
}

/** 从工具参数里递归摘出所有字符串（路径可能埋在 content/command 里）。 */
export function stringsOf(value, out = [], depth = 0) {
  if (depth > 6 || value === null || value === undefined) return out
  if (typeof value === 'string') {
    out.push(value)
    return out
  }
  if (Array.isArray(value)) {
    for (const v of value) stringsOf(v, out, depth + 1)
    return out
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value)) stringsOf(v, out, depth + 1)
  }
  return out
}

/** 「想改动」的意图词。预检要求「受保护路径 + 变更意图」同时命中，避免把只读提问也拦成审核。 */
const MUTATION_INTENT_RE =
  /(改|修|删|写|替换|新增|插入|移除|重命名|部署|打补丁|更新|调整|调大|调小|改成|改掉|接上|启用|禁用|patch|edit|update|write|delete|remove|rename|deploy|fix|install|upgrade)/i

/**
 * 任务文本预检：**在执行 agent 之前**先看一眼这条命令要不要碰 Molly 自己的代码。
 *
 * 为什么还要这一层（工具 guard 已经能拦）：
 *   guard 要等模型真的发起 write 才会拒绝，代价是主人先等几十秒、还会先收到
 *   一句开工语。预检能把「明显要改源码」的命令直接短路成一句审核话术。
 *   guard 仍然是必需的兜底——模型可以第一轮 glob、第二轮才知道要写哪个文件。
 */
export function prescreenTask(task) {
  const text = String(task || '')
  const paths = protectedHitsInText(text)
  if (paths.length === 0) return { deny: false, paths: [], tool: 'task-text' }
  if (!MUTATION_INTENT_RE.test(text)) return { deny: false, paths, tool: 'task-text' }
  return { deny: true, paths, reason: DENY_REASON(paths), tool: 'task-text' }
}

/**
 * 需要「人在界面前回答」的工具。干活会话跑在 QQ 里，**根本没有人能点这个弹窗**，
 * 一旦模型调它就会永久挂住（task-44 真机事故：2026-10-20 11:33 turn 211 step 8
 * 调 ask_user_question 后整个 session 再也不写一个字节，后面所有命令排队超时）。
 *
 * 正常情况这一层不该被触发：workerSetup 会用 tools.restrict({deny}) 从工具面里
 * 直接拿掉它们。这里是兜底——万一某个宿主版本 restrict 没生效，guard 也必须
 * 立刻回一条「别问，自己做决定」的结果，让模型继续往下走，而不是挂死。
 */
export const INTERACTIVE_TOOLS = new Set(['ask_user_question', 'exit_plan_mode'])

/** 拦下交互式提问时回给模型的话（会作为工具错误结果回到对话里）。 */
export const NO_ASK_REASON =
  '这里没有人能回答你的提问（干活会话在 QQ 后台，没有可交互的界面）。不要问，按你认为最合理的理解直接做完，并在结果里用一句话说明你的假设。'

/** 判断一次工具调用该不该被拦。
 *
 * @param {{name?: string, arguments?: unknown, args?: unknown}} exec  DSH 的 ToolExecution
 * @returns {{deny: boolean, reason?: string, paths: string[], tool?: string}}
 */
export function scanToolCall(exec) {
  const tool = String(exec?.name || exec?.tool || '')
  const raw = exec?.arguments ?? exec?.args ?? {}
  if (INTERACTIVE_TOOLS.has(tool)) {
    return { deny: true, reason: NO_ASK_REASON, paths: [], tool, interactive: true }
  }
  const strings = stringsOf(raw)
  const hits = new Set()
  for (const s of strings) {
    if (/[\\/]/.test(s) && isProtectedPath(s)) hits.add(normalizePath(s))
    // 命令/代码里路径可能和别的字符黏在一起，用正则再抠一遍
    for (const p of protectedHitsInText(s)) hits.add(p)
  }
  if (hits.size === 0) return { deny: false, paths: [], tool }
  const all = [...hits]

  const name = tool.toLowerCase()
  if (WRITE_TOOLS.has(name)) {
    return { deny: true, reason: DENY_REASON(all), paths: all, tool }
  }
  if (SHELL_TOOLS.has(name)) {
    const text = strings.join('\n')
    if (MUTATION_RE.test(text)) {
      return { deny: true, reason: DENY_REASON(all), paths: all, tool }
    }
    return { deny: false, paths: all, tool }
  }
  // 未知工具的保守策略：只要它同时提到受保护路径和变更动作就拦
  const text = strings.join('\n')
  if (MUTATION_RE.test(text)) return { deny: true, reason: DENY_REASON(all), paths: all, tool }
  return { deny: false, paths: all, tool }
}

/** pending-code.json 的位置：数据目录下（默认 dataDir）。 */
export function pendingFile(dataDir) {
  const dir = dataDir || path.join(os.homedir(), '.dsh', 'qq-whale')
  return path.join(dir, 'pending-code.json')
}

/** 读 pending-code.json（坏文件当空数组，绝不因为读到半截而崩）。 */
export function readPending(dataDir) {
  try {
    const raw = fs.readFileSync(pendingFile(dataDir), 'utf8')
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

/**
 * 追加一条待审核记录（最多 50 条，新的在最后）。
 * 用「临时文件 + rename」落盘，避免控制台读到写了一半的 JSON。
 */
export function recordPending({ dataDir, fromUin, groupId, task, targetPaths, logger = () => {} } = {}) {
  const entry = {
    id: `pc_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`,
    at: Date.now(),
    fromUin: String(fromUin || ''),
    groupId: String(groupId || ''),
    task: String(task || '').slice(0, 2000),
    targetPaths: [...new Set((targetPaths || []).map(String))].slice(0, 20),
  }
  try {
    const file = pendingFile(dataDir)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const list = readPending(dataDir)
    list.push(entry)
    while (list.length > 50) list.shift()
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(list, null, 2), 'utf8')
    fs.renameSync(tmp, file)
    return entry
  } catch (err) {
    logger('warn', `待审核记录写不进去（不影响拦截）：${err?.message || err}`)
    return entry
  }
}
