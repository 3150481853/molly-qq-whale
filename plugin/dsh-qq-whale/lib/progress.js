/**
 * 任务进度播报：把 agent 的任务清单实时变成 QQ 消息。
 *
 * 需求原文：「在我用qq发命令时，molly也要给我实时更新任务清单并发我
 * （图片或者文字都可）」。
 *
 * 设计要点：
 *
 * 1. **数据从哪来**。不自己维护一份清单——那必然和真实状态脱节。
 *    DSH 的 `dsh-tool-todo-plus` 已经注册了一个 `todos` 会话投影，
 *    `ctx.sessionProjections.stateOf(session, 'todos')` 能读到模型当前的
 *    完整任务列表。所以这里只做「读」和「渲染」，不碰状态。
 *
 * 2. **为什么不用图片**。生成图片要 Canvas/截图库，跨平台麻烦，而且
 *    用户明确说「文字也可」。纯文字反而在手机上更好读、可复制、可搜索。
 *    用 emoji 方框和进度条做视觉层级，观感接近图片但零依赖。
 *
 * 3. **防刷屏**。模型每改一次清单就推一条，一次活儿能推十几条，
 *    主人会被烦死。所以做了三件事：
 *      - 节流：同一会话最快 `minIntervalMs` 推一次，中间的合并
 *      - 只在进度真的变了才推（集合相同就不发）
 *      - 只在「她正在替主人干活」期间推，日常聊天不推
 *
 * 4. **像人话**。不写「任务状态已更新：3/7」，写「搞定了 3 个，还剩 4 个」。
 *    偶尔顺手夸自己一句或抱怨一句，但不能每次都来，所以是概率性的。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, Math.max(0, ms)))

/** 状态图标。用 emoji 而不是 ✓✗，因为 QQ 的字体渲染对 emoji 更友好 */
const ICON = {
  completed: '✅',
  in_progress: '🔄',
  pending: '⬜',
}

/** 进度条：10 格。纯字符，任何客户端都能正常显示 */
function bar(done, total, width = 10) {
  if (total <= 0) return ''
  const filled = Math.round((done / total) * width)
  return '▰'.repeat(filled) + '▱'.repeat(Math.max(0, width - filled))
}

/** 一句话概括现状，带点她的语气 */
function summarize(done, total) {
  if (total === 0) return '清单还是空的'
  if (done === total) return '全都搞定了！'
  const left = total - done
  if (done === 0) return `一共 ${total} 件事，还没开动`
  if (left === 1) return `差最后一件了`
  return `${done}/${total}，还剩 ${left} 件`
}

/** 收尾时的自夸/抱怨，概率触发，避免每次都一样 */
const FINISH_LINES = [
  '干完了，累死我了。',
  '搞定。白饭呢？',
  '好了。下一件吧，趁我还有劲。',
  '全部搞定，给我记一功。',
  '完事了。我要趴一会儿。',
]

/**
 * 把一个 todos 数组渲染成适合 QQ 的纯文本。
 *
 * @param {Array<{content:string,status:string,priority?:string}>} todos
 * @param {{maxItems?:number, maxLen?:number, finished?:boolean}} opts
 * @returns {string|''} 空字符串表示没什么可发的
 */
export function renderTodoList(todos, opts = {}) {
  if (!Array.isArray(todos) || todos.length === 0) return ''
  const maxItems = opts.maxItems ?? 12
  const maxLen = opts.maxLen ?? 42
  const total = todos.length
  const done = todos.filter((t) => t.status === 'completed').length
  const active = todos.filter((t) => t.status === 'in_progress')

  const lines = []
  // 标题行：进度条 + 一句话
  lines.push(`${bar(done, total)} ${summarize(done, total)}`)
  if (active.length > 0) {
    lines.push(`现在在弄：${active.map((t) => clip(t.content, maxLen)).join('、')}`)
  }
  lines.push('')

  // 列表：进行中的排前面（真人也是先看正在干嘛的）
  const ordered = [
    ...todos.filter((t) => t.status === 'in_progress'),
    ...todos.filter((t) => t.status === 'pending'),
    ...todos.filter((t) => t.status === 'completed'),
  ]
  const shown = ordered.slice(0, maxItems)
  for (const t of shown) {
    const icon = ICON[t.status] || '⬜'
    const pri = t.priority === 'high' && t.status !== 'completed' ? '❗' : ''
    lines.push(`${icon} ${pri}${clip(t.content, maxLen)}`)
  }
  if (ordered.length > maxItems) {
    lines.push(`…还有 ${ordered.length - maxItems} 件没显示`)
  }

  if (done === total && total > 0) {
    lines.push('')
    lines.push(FINISH_LINES[Math.floor(Math.random() * FINISH_LINES.length)])
  }
  return lines.join('\n')
}

/** 截断单条任务描述，超出加省略号 */
function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
  return t.length <= n ? t : t.slice(0, n - 1) + '…'
}

/**
 * 进度播报器。
 *
 * 用法：
 *   const rep = new ProgressReporter({ logger, config, engine })
 *   rep.attach(ctx)                        // 订阅 sessionProjections
 *   rep.beginWatch(sessionId, {send})      // 开始盯这个会话
 *   rep.endWatch(sessionId)                // 停止
 */
export class ProgressReporter {
  constructor({ logger, config, engine }) {
    this.logger = logger
    this.config = config
    this.engine = engine
    /**
     * sessionId -> { send, lastSentAt, lastKey, timer, pendingTodos, stopped }
     * 只对正在被盯的会话推消息，其余会话的投影变化一律忽略。
     */
    this.watching = new Map()
    this.dispose = null
  }

  /** 订阅投影变化。没装 todo 插件时安静跳过。 */
  attach(ctx) {
    if (!ctx?.sessionProjections || this.config.progressEnabled === false) {
      this.logger('info', '进度播报：宿主没有 sessionProjections 服务，跳过')
      return
    }
    try {
      this.dispose = ctx.sessionProjections.onChanged((session, key, value) => {
        if (key !== 'todos') return
        const sid = session?.id ?? session?.sessionId
        if (!sid) return
        this.onTodosChanged(String(sid), value)
      })
      this.logger('info', '进度播报已挂载（监听 todos 投影）')
    } catch (err) {
      this.logger('warn', `进度播报挂载失败：${err?.message || err}`)
    }
  }

  /** 开始盯某个会话（一般是干活会话） */
  beginWatch(sessionId, { send }) {
    const id = String(sessionId)
    this.watching.set(id, {
      send,
      lastSentAt: 0,
      lastKey: '',
      timer: null,
      pendingTodos: null,
      stopped: false,
    })
    this.logger('debug', `进度播报开始盯 ${id}`)
  }

  /** 停止盯，并把最后的状态冲出去 */
  async endWatch(sessionId) {
    const id = String(sessionId)
    const w = this.watching.get(id)
    if (!w) return
    w.stopped = true
    if (w.timer) clearTimeout(w.timer)
    this.watching.delete(id)
    this.logger('debug', `进度播报停止盯 ${id}`)
  }

  /** 投影变化回调：节流 + 去重后发出 */
  onTodosChanged(sessionId, todos) {
    const w = this.watching.get(sessionId)
    if (!w || w.stopped) return
    if (!Array.isArray(todos) || todos.length === 0) return

    // 去重键：内容+状态拼起来。状态没变就完全不发。
    const keyOf = (list) => list.map((t) => `${t.status}|${t.content}`).join('\n')
    const newKey = keyOf(todos)
    if (newKey === w.lastKey) return

    const now = Date.now()
    const gap = this.config.progressMinIntervalMs ?? 12000

    if (now - w.lastSentAt >= gap) {
      w.lastKey = newKey
      w.lastSentAt = now
      this.push(w, todos)
      return
    }

    // 还在冷却期：存下最新的，等定时器到点一次性发出去。
    // 只保留最后一次，中间的中间态没有播报价值。
    w.pendingTodos = todos
    if (!w.timer) {
      const wait = gap - (now - w.lastSentAt)
      w.timer = setTimeout(() => {
        w.timer = null
        const t = w.pendingTodos
        w.pendingTodos = null
        if (!t || w.stopped) return
        const k = keyOf(t)
        if (k === w.lastKey) return
        w.lastKey = k
        w.lastSentAt = Date.now()
        this.push(w, t)
      }, wait)
      if (typeof w.timer?.unref === 'function') w.timer.unref()
    }
  }

  /** 真正发出去。失败只记日志，绝不影响干活。 */
  async push(w, todos) {
    const text = renderTodoList(todos, {
      maxItems: this.config.progressMaxItems ?? 12,
      maxLen: this.config.progressMaxItemChars ?? 42,
    })
    if (!text) return
    try {
      await w.send(text)
    } catch (err) {
      this.logger('warn', `进度播报发送失败：${err?.message || err}`)
    }
  }

  /** 插件卸载时清理 */
  disposeAll() {
    for (const w of this.watching.values()) {
      w.stopped = true
      if (w.timer) clearTimeout(w.timer)
    }
    this.watching.clear()
    try {
      this.dispose?.()
    } catch {
      // 忽略
    }
    this.dispose = null
  }
}

/**
 * 从会话投影里读当前清单（给"现在进度咋样"这类查询用）。
 * 不订阅，纯读。
 */
export function readTodos(ctx, session) {
  try {
    const todos = ctx?.sessionProjections?.stateOf?.(session, 'todos')
    return Array.isArray(todos) ? todos : null
  } catch {
    return null
  }
}

export { sleep }
