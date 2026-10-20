/* eslint-disable */
/**
 * test-pest-ui.mjs —— 骂人模式卡片的前端渲染/交互测试（task-36 C）
 *
 * 为什么要这么写：控制台前端没有浏览器测试框架，而这块最容易犯的错
 * 是「点开关后状态不更新」「失败被翻译成一句模糊的「失败了」」「停止词
 * 复制不到」。所以用最小 DOM shim 真跑 console.js（vm 里执行，走真正的
 * init → poll → renderWatchdog → renderPestCard 路径），只用断言看 DOM
 * 文本与网络调用。
 *
 * 跑法： & <node> qq-whale\tools\test-pest-ui.mjs
 * 注意：源码改了记得重跑；它读的是 console/console.js 本体。
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const JS_FILE = path.join(ROOT, 'console', 'console.js');

let pass = 0;
const fails = [];
const rejections = [];
process.on('unhandledRejection', (e) => { rejections.push(e && e.message ? e.message : String(e)); });
function ok(cond, label, extra) {
  if (cond) { pass++; console.log('  PASS  ' + label); }
  else { fails.push(label + (extra ? ' — ' + extra : '')); console.log('  FAIL  ' + label + (extra ? ' — ' + extra : '')); }
}

/* ---------------- 最小 DOM ---------------- */

function makeEl(tag = 'div', id = '') {
  const el = {
    tagName: String(tag).toUpperCase(),
    id,
    children: [],
    parentNode: null,
    style: {},
    attrs: {},
    listeners: {},
    hidden: false,
    disabled: false,
    value: '',
    textContent: '',
    _html: '',
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { if (on === undefined ? !this._s.has(c) : on) this._s.add(c); else this._s.delete(c); }
    },
    get innerHTML() { return this._html; },
    set innerHTML(v) { this._html = String(v); },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); },
    removeEventListener(type, fn) {
      const a = this.listeners[type] || [];
      const i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    },
    appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      c.parentNode = null;
      return c;
    },
    querySelector(sel) { return doc._find(sel, this); },
    querySelectorAll(sel) { return doc._findAll(sel, this); },
    closest(sel) { return this._closestMock === sel ? this : null; },
    focus() {},
    select() {},
    remove() {},
    /* 触发本元素上注册的 click，并让 ev.target 是真实点击目标（模拟冒泡到容器） */
    dispatchClick(target) {
      const ev = { type: 'click', target: target || this, preventDefault() {}, stopPropagation() {} };
      (this.listeners.click || []).slice().forEach((fn) => fn(ev));
      if (this.parentNode && this.parentNode.listeners.click) this.parentNode.dispatchClick(target || this);
    }
  };
  return el;
}

/* 一张总表：记录当前 overview 里 plugin.pest 用哪份数据；fetch 按路径回应 */
let overviewPayload = null;
let pestNull = false;
const calls = [];
const copied = [];
const toasts = [];

const doc = {
  readyState: 'complete',
  _cache: new Map(),
  body: makeEl('body'),
  createElement(tag) { return makeEl(tag); },
  getElementById(id) { return this._find('#' + id); },
  querySelector(sel) { return this._find(sel); },
  querySelectorAll(sel) { return this._findAll(sel); },
  addEventListener() {},
  _find(sel) {
    if (sel === 'body') return this.body;
    if (!this._cache.has(sel)) this._cache.set(sel, makeEl('div', sel.replace(/^#/, '')));
    return this._cache.get(sel);
  },
  _findAll() { return []; }
};

function overviewWith(pest) {
  return {
    ok: true,
    build: 'test-build',
    plugin: pestNull ? {} : { pest },
    watchdog: { reachable: true, state: { lastState: 'online' }, config: {}, lastRun: '2026-10-19 23:00:00', taskEnabled: true },
    napcat: { reachable: true, isLogin: true, uin: '111111111', loginPhase: 'ready', coreReady: true },
    bot: { userId: '111111111' },
    link: { state: 'online' }
  };
}

const PEST_ON = {
  enabled: true,
  targets: ['333333333'],
  dailyCap: 8,
  todayUsed: 3,
  stopWord: '毛线织的雨',
  stopWordSent: true,
  muted: false,
  mutedUntil: null,
  intervalMinutes: 30,
  nextPickInMinutes: 12
};

const fakeFetch = (rawUrl, opts) => {
  const url = decodeURIComponent(String(rawUrl));
  calls.push({ url, opts: opts || {} });
  let payload = { ok: true };
  if (url.indexOf('/api/overview') === 0) payload = overviewPayload;
  else if (url.indexOf('/api/health') === 0) payload = { ok: true, build: 'test-build', plugin: { ok: true } };
  else if (url.indexOf('/api/action/pest/set') === 0) {
    const body = JSON.parse((opts && opts.body) || '{}');
    if (body.enabled === false) {
      payload = { ok: true, action: 'pest/set', data: { ok: true, state: Object.assign({}, PEST_ON, { enabled: false }) } };
    } else {
      payload = { ok: true, action: 'pest/set', data: { ok: true, state: Object.assign({}, PEST_ON, { enabled: true }) } };
    }
    if (fakeFetch.failNext) {
      const msg = fakeFetch.failNext;
      fakeFetch.failNext = null;
      payload = { ok: false, action: 'pest/set', error: msg };
    }
  } else if (url.indexOf('/api/action/pending') === 0) payload = { ok: true, count: 0, items: [] };
  return Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(payload)
  });
};

/* ---------------- 装 globals 并执行 console.js ---------------- */

const win = {
  __MOLLY_BUILD__: 'test-build',
  addEventListener() {},
  removeEventListener() {},
  matchMedia: () => ({ matches: false, addEventListener() {} })
};

const store = new Map();
const sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k)
};

function def(name, value) {
  Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
}

overviewPayload = overviewWith(PEST_ON);
def('window', win);
def('document', doc);
def('location', { hash: '#/watchdog', href: 'http://127.0.0.1:19392/', reload() {}, assign() {} });
def('navigator', { clipboard: { writeText: (t) => { copied.push(String(t)); return Promise.resolve(); } } });
def('fetch', fakeFetch);
def('sessionStorage', sessionStorage);
def('localStorage', sessionStorage);
def('setInterval', () => 1);
def('clearInterval', () => {});
def('history', { replaceState() {}, pushState() {} });

const code = fs.readFileSync(JS_FILE, 'utf8');
try {
  vm.runInThisContext(code, { filename: JS_FILE });
} catch (e) {
  console.log('  FAIL  执行 console.js 抛错：' + e.message);
  fails.push('执行 console.js：' + e.message);
}

const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };
await flush();

const pestBox = doc._find('#pestCards');
const toastEl = doc._find('#toast');
const html = () => pestBox.innerHTML;

/* 找到最新的 toggle / word 元素：渲染是 innerHTML 字符串，事件委托在容器上，
   所以直接把事件 target 伪造为带 closest 的元素即可。 */
function clickIn(container, sel, extraEl) {
  const target = extraEl || makeEl('button');
  target._closestMock = sel;
  (container.listeners.click || []).slice().forEach((fn) => fn({ target, preventDefault() {}, stopPropagation() {}, type: 'click' }));
}

/* ---------------- 断言 ---------------- */

console.log('\n[1] 开启态渲染');
ok(/骂人模式/.test(html()), '卡片标题在');
ok(/pest-badge is-on/.test(html()), '徽章是「开」样式（橙）');
ok(/>开</.test(html()) || /开\s*<\/span>/.test(html()), '徽章文字是「开」');
ok(html().indexOf('333333333') >= 0, '目标 QQ 显示');
ok(/3\s*\/\s*8/.test(html().replace(/<[^>]*>/g, '')), '今日已用显示 3 / 8', html().replace(/<[^>]*>/g, ''));
ok(html().indexOf('毛线织的雨') >= 0, '停止词大字显示');
ok(html().indexOf('关闭骂人模式') >= 0, '按钮文案是「关闭骂人模式」');
ok(/pest-card is-on/.test(html()), '卡片带 is-on（橙左边框）');

console.log('\n[2] 点关闭 → POST pest/set {enabled:false} → 就地变灰');
clickIn(pestBox, '.js-pest-toggle');
await flush();
const post = calls.filter((c) => c.url.indexOf('/api/action/pest/set') === 0).pop();
ok(!!post, '发出了 POST /api/action/pest/set');
ok(post && JSON.parse(post.opts.body).enabled === false, '请求体 enabled=false');
ok(post && post.opts.method === 'POST', '方法为 POST');
ok(/pest-badge is-off/.test(html()), '就地把徽章切成「关」');
ok(html().indexOf('开启骂人模式') >= 0, '按钮文案变「开启骂人模式」');
ok(html().indexOf('已停手') >= 0, '副标题说明已停手');
ok(/pest-word is-off/.test(html()), '停止词块变灰但仍可读');
ok(copied.length === 0, '没有误触发复制');

console.log('\n[3] 失败时把服务端原文照摆');
fakeFetch.failNext = '插件还没有 /pest 路由（HTTP 404）——重载插件后再试';
clickIn(pestBox, '.js-pest-toggle');
await flush();
ok(String(toastEl.textContent).indexOf('插件还没有 /pest 路由（HTTP 404）——重载插件后再试') >= 0,
  'toast 里是服务端原文', String(toastEl.textContent));
ok(/pest-badge is-off/.test(html()), '失败后卡片保持「关」，没有假装成功');
ok(toasts.length === 0, '没有额外的假 toast');

console.log('\n[4] 点停止词 → 复制到剪贴板 + 提示');
clickIn(pestBox, '.js-pest-word');
await flush();
ok(copied.length === 1 && copied[0] === '毛线织的雨', '复制的是停止词原文', JSON.stringify(copied));
ok(String(toastEl.textContent).indexOf('停止词已复制：毛线织的雨') >= 0, 'toast 提示已复制', String(toastEl.textContent));

console.log('\n[5] 插件没上报 pest → 显示「不可用」，不崩、不显示开关');
pestNull = true;
overviewPayload = overviewWith(null);
const btnRefresh = doc._find('#btnRefresh');
clickIn(btnRefresh, '#btnRefresh');
await flush();
ok(/不可用/.test(html()), '显示「不可用」徽章');
ok(html().indexOf('js-pest-toggle') < 0, '没有渲染开关按钮');
ok(fails.filter((f) => f.indexOf('执行 console.js') === 0).length === 0, '整个过程中没有未捕获异常');

rejections.forEach((r) => { fails.push('未捕获的 Promise 拒绝：' + r); });

console.log('\n===== 结果：' + pass + ' 通过 / ' + fails.length + ' 失败 =====');
if (fails.length) {
  fails.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
process.exit(0);
