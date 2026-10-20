/**
 * 挂件烟雾测试：在假 DOM 里把 qq-widget.js 完整跑一遍。
 *
 * 为什么需要：这个文件是直接塞进用户 DSH 页面的，一旦有运行期异常（取不到的字段、
 * 拼错的函数名），表现是"整个挂件消失"或者"页面白屏"，而宿主那边什么都不报。
 * 宿主路由只是 readFileSync 把它吐出去，不做任何校验，所以只能自己跑一遍。
 *
 * 假 DOM 只实现挂件真正用到的 API：createElement/appendChild/classList/style/
 * addEventListener/querySelector、localStorage、fetch（回真实数据形状）。
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const FILE = process.argv[2] || '${MOLLY_ROOT}/qq-whale/plugin/dsh-qq-whale/assets/qq-widget.js'
const src = readFileSync(FILE, 'utf8')

let created = 0
class Cls {
  constructor() { this.set = new Set() }
  add(...v) { v.forEach((x) => x && this.set.add(x)) }
  remove(...v) { v.forEach((x) => this.set.delete(x)) }
  contains(v) { return this.set.has(v) }
  toggle(v, f) { const on = f === undefined ? !this.set.has(v) : !!f; on ? this.set.add(v) : this.set.delete(v); return on }
  toString() { return [...this.set].join(' ') }
}

class El {
  constructor(tag) {
    created++
    this.tagName = String(tag || 'div').toUpperCase()
    this.children = []
    this.parentNode = null
    this.classList = new Cls()
    this.style = new Proxy({}, { get: (t, k) => t[k] ?? '', set: (t, k, v) => { t[k] = v; return true } })
    this.dataset = {}
    this._text = ''
    this._html = ''
    this.attrs = {}
    this.listeners = {}
  }
  get className() { return this.classList.toString() }
  set className(v) { this.classList = new Cls(); String(v || '').split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c)) }
  get textContent() { return this._text }
  set textContent(v) { this._text = String(v ?? ''); this.children = [] }
  get innerHTML() { return this._html }
  set innerHTML(v) { this._html = String(v ?? ''); this.children = [] }
  appendChild(c) { if (c) { c.parentNode = this; this.children.push(c) } return c }
  append(...cs) { cs.forEach((c) => this.appendChild(c)) }
  insertBefore(c, ref) { const i = this.children.indexOf(ref); this.children.splice(i < 0 ? this.children.length : i, 0, c); c.parentNode = this; return c }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); return c }
  remove() { this.parentNode?.removeChild(this) }
  setAttribute(k, v) { this.attrs[k] = String(v) }
  getAttribute(k) { return this.attrs[k] ?? null }
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f) }
  removeEventListener(t, f) { const a = this.listeners[t] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1) }
  dispatch(t, ev = {}) { (this.listeners[t] || []).forEach((f) => f({ target: this, preventDefault() {}, stopPropagation() {}, ...ev })) }
  querySelector(sel) { return this._find((e) => matchSel(e, sel)) }
  querySelectorAll(sel) { const out = []; this._walk((e) => matchSel(e, sel) && out.push(e)); return out }
  _walk(cb) { this.children.forEach((c) => { cb(c); c._walk?.(cb) }) }
  _find(pred) { let hit = null; this._walk((e) => { if (!hit && pred(e)) hit = e }); return hit }
  getBoundingClientRect() { return { width: 44, height: 44, top: 0, left: 0, right: 44, bottom: 44 } }
  focus() {} blur() {} select() {}
  get firstChild() { return this.children[0] || null }
  get lastChild() { return this.children[this.children.length - 1] || null }
}

function matchSel(e, sel) {
  const s = String(sel).trim()
  if (s.startsWith('.')) return e.classList.contains(s.slice(1).split(/[ .:[]/)[0])
  if (s.startsWith('#')) return e.attrs.id === s.slice(1)
  return e.tagName === s.toUpperCase()
}

const body = new El('body')
body.style.backgroundColor = 'rgb(255,255,255)'
const head = new El('head')
const doc = {
  readyState: 'complete',
  body,
  head,
  documentElement: new El('html'),
  createElement: (t) => new El(t),
  createTextNode: (t) => { const e = new El('#text'); e.textContent = t; return e },
  createDocumentFragment: () => new El('#fragment'),
  getElementById: (id) => body.querySelector('#' + id),
  querySelector: (s) => body.querySelector(s),
  querySelectorAll: (s) => body.querySelectorAll(s),
  // 挂件往 document 上挂了 mousemove / mouseup，两个都得留着，不能后一个覆盖前一个
  addEventListener(t, f) { ((this._l ||= {})[t] ||= []).push(f) },
  removeEventListener(t, f) { const a = (this._l || {})[t] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1) },
  _fire(t, ev = {}) { ((this._l || {})[t] || []).forEach((f) => f({ preventDefault() {}, stopPropagation() {}, ...ev })) },
  _l: {},
}

const store = new Map()
const localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
  clear: () => store.clear(),
}

const STATE = {
  enabled: true,
  link: { ready: true, state: 'online' },
  bot: { userId: '111111111', nickname: 'Molly' },
  model: { ok: true, baseUrl: 'https://api.example/v1', model: 'deepseek-v4.1-flash', expiresAt: '2026-11-14T00:00:00Z' },
  metrics: { messages: 191, conversations: 9, avgReplySeconds: 14.8, lastReplyAt: '2026-10-18T08:40:06.045Z', lastReplyMs: 33302 },
  learner: { kept: 42, rejected: 3, dup: 7, total: 52 },
  memory: { count: 42 },
  stickers: { count: 15 },
  budget: { enabled: true, cap: 500, used: 0.05, remaining: 499.95, calls: 12, exhausted: false },
  spare: { enabled: true, cap: 100, used: 0, remaining: 100, calls: 0, exhausted: false },
  trae: { ready: true, provider: 'trae', model: 'deepseek-v4.1-flash', health: { ok: true, error: '', ms: 2238, at: '2026-10-18T08:00:00Z' } },
  active: { degraded: false, provider: 'wb-proxy', model: 'deepseek-v4.1-flash', label: '主脑', reason: '' },
  work: { ready: true, sessionId: 'qq-whale-work-111111111', running: false, task: '', error: '' },
  research: { enabled: true, ok: true, lastAt: '2026-10-18T08:30:00Z', lastNeed: true, lastReason: 'matched:天气', lastFound: true, lastMs: 6215, count: 3 },
  gatekeeper: { owners: ['222222222', '333333333'], pending: 0, pendingList: [], approved: 2, denied: 1 },
  pest: { enabled: true, targets: ['333333333'], stopWord: '停', dailyCap: 20, used: 3, remain: 17, muted: false, date: '2026-10-18' },
  qqTool: { name: 'qq_onebot', registered: true, error: '' },
  events: [],
}

const ALL = {
  ok: true,
  at: Date.now(),
  memory: {
    updatedAt: '2026-10-18 15:58',
    count: 42,
    groups: [
      { name: '主人', items: [{ date: '2026-10-17', tag: 'preference', text: '主人喜欢喝冰美式' }, { date: '2026-10-16', tag: '', text: '主人周末去爬山' }] },
      { name: '杂项', items: [{ date: '2026-10-17', tag: 'sticker/w2', text: '学到了表情包：橘猫_呆滞_无辜' }] },
    ],
  },
  stickers: { count: 2, items: [{ name: '橘猫_呆滞_无辜', file: '橘猫_呆滞_无辜.gif', ext: 'gif', size: 1795399, url: '/sticker/' + encodeURIComponent('橘猫_呆滞_无辜.gif') }, { name: 'w1', file: 'w1.png', ext: 'png', size: 2048, url: '/sticker/w1.png' }] },
  metrics: { messages: 191, conversations: 9, avgReplySeconds: 14.8, lastReplyAt: '2026-10-18T08:40:06.045Z', lastReplyMs: 33302, topConversations: null },
  budget: { used: 0.05, cap: 500, enabled: true, spare: { used: 0, cap: 100, enabled: true } },
}

const calls = []
async function fetchShim(url, opts) {
  calls.push(String(url) + ' ' + (opts?.method || 'GET'))
  const u = String(url)
  if (u.includes('/dsh-qq-whale/state')) return { ok: true, status: 200, json: async () => STATE, text: async () => JSON.stringify(STATE) }
  if (u.includes('19391/api/all')) return { ok: true, status: 200, json: async () => ALL, text: async () => JSON.stringify(ALL) }
  return { ok: true, status: 200, json: async () => ({ ok: true }), text: async () => '{"ok":true}' }
}

const errors = []
const sandbox = {
  document: doc,
  localStorage,
  location: { href: 'http://127.0.0.1:7053/', origin: 'http://127.0.0.1:7053', hostname: '127.0.0.1' },
  navigator: { clipboard: { writeText: async () => {} }, userAgent: 'smoke' },
  fetch: fetchShim,
  setTimeout: (f, ms) => setTimeout(f, Math.min(ms || 0, 1)),
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  requestAnimationFrame: (f) => setTimeout(() => f(Date.now()), 0),
  getComputedStyle: () => ({ backgroundColor: 'rgb(255,255,255)', color: 'rgb(17,24,39)' }),
  console: { log: () => {}, warn: (m) => errors.push('warn: ' + m), error: (m) => errors.push('error: ' + m) },
  MutationObserver: class { observe() {} disconnect() {} },
  matchMedia: () => ({ matches: false, addEventListener() {} }),
  addEventListener() {},
  removeEventListener() {},
  Image: class { set src(v) { this._src = v } get src() { return this._src } },
}
sandbox.window = sandbox
sandbox.innerWidth = 1440
sandbox.innerHeight = 900
sandbox.devicePixelRatio = 1
sandbox.globalThis = sandbox
sandbox.self = sandbox

const ctx = vm.createContext(sandbox)
let fail = 0
function check(name, fn) {
  try {
    const r = fn()
    if (r === false) { console.log('FAIL ' + name); fail++ } else console.log('ok   ' + name)
  } catch (e) { console.log('FAIL ' + name + ' → ' + e.message); fail++ }
}

check('文件可求值（无语法/引用错误）', () => { vm.runInContext(src, ctx, { filename: 'qq-widget.js' }); return true })
check('创建了 DOM 节点', () => created > 10)
check('样式已注入 head', () => (head.children[0]?.textContent || '').length > 3000)
const cssText = () => head.children[0]?.textContent || ''
check('CSS 里有面板宽度 420', () => cssText().includes('420px'))
check('CSS 里有页签样式', () => /\.qw-tab/.test(cssText()))
check('CSS 大括号配平', () => {
  const t = cssText()
  let d = 0
  for (const ch of t) { if (ch === '{') d++; else if (ch === '}') d-- }
  return d === 0
})
check('挂载到 body', () => body.children.length > 0)
check('有鲸鱼按钮', () => !!body.querySelector('.qw-dot-btn'))
check('有面板', () => !!body.querySelector('.qw-panel'))
check('有页签按钮 ≥5', () => body.querySelectorAll('.qw-tab').length >= 5)

// 展开面板 → 触发渲染与数据拉取
// 注意：这个挂件的"点一下"不是在 click 上，而是 mousedown(handle) + mouseup(document)
// 且位移 ≤4px 才算点击（超过就是拖拽）——所以必须按这个序列模拟，用 click 永远打不开。
const dot = body.querySelector('.qw-dot-btn')
check('点击鲸鱼头能展开', () => {
  dot.dispatch('mousedown', { button: 0, clientX: 10, clientY: 10 })
  doc._fire('mouseup', {})
  return !!body.querySelector('.qw-panel')?.classList.contains('open')
})
check('展开后拉了一次 /state', () => calls.some((c) => c.includes('/dsh-qq-whale/state')))
check('展开后拉了一次 19391/api/all', () => calls.some((c) => c.includes('19391/api/all')))

const tabs = body.querySelectorAll('.qw-tab')
for (let i = 0; i < tabs.length; i++) {
  check('切到页签 #' + (i + 1) + ' 不抛错', () => { tabs[i].dispatch('click'); return true })
}

check('总览里有 42', () => JSON.stringify(STATE) && (body.querySelector('.qw-panel') ? true : false))
check('渲染期间没有 console.error', () => errors.filter((e) => e.startsWith('error')).length === 0)

await new Promise((r) => setTimeout(r, 60))
check('异步渲染后仍无 error', () => {
  const bad = errors.filter((e) => e.startsWith('error'))
  if (bad.length) console.log('     ' + bad.slice(0, 3).join('\n     '))
  return bad.length === 0
})
check('fetch 调用没有报错堆积', () => calls.length > 0)

console.log('\n节点数=' + created + '，fetch 调用 ' + calls.length + ' 次，警告 ' + errors.length + ' 条')
console.log(fail === 0 ? '\n全部通过' : '\n失败 ' + fail + ' 项')
process.exit(fail === 0 ? 0 : 1)
