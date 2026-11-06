/* ==========================================================================
   Molly 控制台 —— 前端逻辑（原生 JS，零依赖）
   契约见 docs/console-contract.md，视觉 token 见 docs/console-design.md。
   原则：任何异常都吞掉并 console.warn，绝不让控制台白屏。
   ========================================================================== */
(function () {
  'use strict';

  var POLL_MS = 4000;      /* 契约 §5.2：默认 4 秒 */
  var LOG_POLL_MS = 5000;  /* 日志抽屉只在展开时轮询 */
  var PEND_POLL_MS = 15000;   /* 待核实计数：15 秒一次，只走轻量 GET，不动列表 DOM */
  var QR_POLL_MS = 3000;      /* 等待扫码时每 3 秒读一次 overview，扫上就停 */
  var ONLINE_POLL_MS = 30000; /* 在线时间页：页签可见时 30 秒自刷，与后端缓存对齐 */
  var QR_MAX_AUTO = 3;        /* 过期自动换码最多连换 3 次，之后交回人手，免得无限刷 */
  /* 二维码有效期只是本地展示：约 2 分钟，不假装与 QQ 客户端内部计时精确一致。
     测试里用 window.__QR_TTL_MS__ 缩短，免得等两分钟。 */
  var QR_TTL_MS = (typeof window !== 'undefined' && typeof window.__QR_TTL_MS__ === 'number' && window.__QR_TTL_MS__ > 0)
    ? window.__QR_TTL_MS__
    : 120000;
  var PAGES = ['overview', 'chats', 'online', 'memory', 'pending', 'stickers', 'switches', 'budget', 'work', 'watchdog', 'ops', 'external', 'qq', 'exec', 'settings', 'about'];

  /* 关于页「检查更新」的基准（2026-11-04）：页面这一份前端文件加载时，服务端在
     index.html 里注入了 window.__MOLLY_BUILD__（tools/console-server.mjs 静态页改写）。
     检查更新时拿 /api/health 的 build 跟它比：一样＝已是最新，不一样＝服务端换了前端文件。
     直接开文件（没有注入）时这里是空串，只提示「以服务端为准」，不瞎判。 */
  var PAGE_BUILD = (typeof window !== 'undefined' && window.__MOLLY_BUILD__)
    ? String(window.__MOLLY_BUILD__)
    : '';

  /* 桌面窗口契约（docs/console-glass-v3.md §B6）：窗口加载页面时 URL 会带 ?shell=desktop。
     那种情况下窗口顶部 44px 是 WPF 自绘的拖动条，页面必须把这一带留空（见 console.css §27.3）。
     浏览器直接访问没有这个参数，就不写 data-shell，表现完全不变 —— 否则移动端/普通浏览器
     会被切掉一条。只看 location.search：路由 hash（#/overview）排在后面，不影响判断。 */
  try {
    if (/(?:^|[?&])shell=desktop(?:&|$)/.test(location.search)) {
      document.documentElement.setAttribute('data-shell', 'desktop');
    }
  } catch (err) { /* 取不到 location 也不能让控制台白屏 */ }

  /* 记忆七类（2026-10-27 主人 m01748）：值和插件端 lib/memory.js 的 MEMORY_KINDS
     一一对应，顺序即页面分组顺序。老的 work / sticker 已并入 event / meme，
     后端读旧值时会自动折成新类（KIND_ALIASES），这里不再单列。 */
  var MEM_KINDS = [
    ['fact', '事实'],
    ['preference', '偏好'],
    ['promise', '约定'],
    ['person', '人物'],
    ['event', '事件'],
    ['meme', '梗与表情'],
    /* 称谓（2026-10-26）：主人 m01649 要求单独成类。
       memory.js 的 addressOf() 按 QQ 直取、不吃权重窗口，页面放最后是因为它一般条数最少，
       但排序不影响上面的分组顺序（顺序即页面分组顺序，放最后就是最后一组）。 */
    ['address', '称谓']
  ];

  /* 入队原因：插件端 lib/memory.js 的 reason 字符串，只做展示。
     insult 排第一位不是依赖顺序，而是页面上它要最显眼。 */
  var PEND_REASONS = [
    ['insult', '带侮辱性'],
    ['too-short', '太短'],
    ['self-talk', '自言自语'],
    ['fragment', '碎片'],
    ['no-content', '没内容'],
    ['vacuous', '空话'],
    ['no-identity', '不知道是谁'],
    ['meta-narration', '元叙述']
  ];

  var STK_MAX_BYTES = 8 * 1024 * 1024;
  var STK_TYPES = /^image\/(jpeg|png|gif|webp)$/i;

  var state = {
    overview: null,
    lastOkAt: 0,
    lastError: null,
    page: 'overview',
    health: null,
    memory: null,         /* 只读兜底视图：/api/memory 的 groups */
    memoryError: null,
    memEntries: null,     /* 可写视图：/api/action/memory/list 的 entries（带 id） */
    memCrudReady: null,   /* null=还没探完 / true=写接口可用 / false=404 只读降级 */
    memCrudError: null,
    pendingItems: null,   /* null=还没拉过 / 数组=列表；null 与空数组要区分「未加载」和「空态」 */
    pendingError: null,
    pendingReady: null,   /* null=未知 / true=接口可用 / false=未上线或连不上 */
    pendingCount: 0,
    pendingBusy: false,   /* 有操作在飞：轮询不许重绘列表，避免点按钮点空 */
    pendingHint: false,   /* 轮询发现条数变了但列表没重绘，显示「有新条目」提示 */
    stickers: null,
    stickerError: null,
    stkQuery: '',         /* 表情包搜索词：只影响渲染，不触发请求 */
    /* 扫码登录页：生成的码、有效期、等待状态全放这儿，重绘不会丢 */
    login: {
      generating: false,
      genStartedAt: 0,
      png: '',
      url: '',
      imgSrc: '',
      qrAt: 0,
      expiresAt: 0,
      autoSwaps: 0,      /* 上一张手动码之后，自动换过几次 */
      waiting: false,
      triggered: false,  /* SnowLuma 后端：已触发计划任务重启 QQ，等窗口弹出扫码 */
      triggeredAt: 0,
      success: '',       /* 非空=已登录横幅要显示，值是「Molly 345…」 */
      successNote: '',   /* 已登录横幅的副标题：扫码成功 / 本来就在线 */
      error: '',
      hint: ''
    },
    /*
     * 运维 / 外部服务（task-58）。
     * 心跳、网关用量、模型清单都**不进** 4 秒的 overview 轮询：它们各自要
     * 走一次外部请求（网关面板登录、远端 /health），挂在轮询里会把一台
     * 不在的服务器变成整页的延迟。进页拉一次 + 手动刷新就够。
     */
    ops: { hb: null, hbError: null, hbAt: 0, push: null },
    ext: {
      usage: null, usageError: null,
      models: null, modelsError: null,
      hb: null, hbError: null,
      at: 0, loading: false
    },
    /* 发言开关：data 是 /api/plugin/switches 返回的整包（master/private/group/groups/contentFilter/temporaryMutes/audit） */
    /* form：输入框草稿值缓存。页面每 4 秒被 poll 重渲染一次，不缓存的话
     「临时静音」里刚输入的群号/分钟会被清空（2026-10-22 用户报障 m04335）。 */
  sw: { data: null, error: '', loading: false, group: '', busy: false, form: {} },
    /* 关于页（2026-11-04）：只放「检查更新」与「更新日志」的就地状态。
       按钮和容器都在静态 HTML 里，4 秒轮询只重写数据容器，所以点「检查更新」
       之后焦点不会被重渲染抢走。 */
    about: { checking: false, chg: null, chgError: null, chgTitle: '' },
    /* 在线时间（2026-11-06）：一次拉 days=30 的统计，切「今天/昨天/近 7 天」只重绘分时区，
       不再请求；数据最多 60 秒旧一次（spec §3.2）。 */
    online: { data: null, error: '', at: 0, loading: false, days: 7, tab: 'today' },
    reloading: false   /* 前端版本不一致时只自动 reload 一次 */
  };

  var pollTimer = null;
  var tickTimer = null;
  var logTimer = null;
  var pendTimer = null;
  var toastTimer = null;
  var qrPollTimer = null;    /* 等待扫码的 3 秒轮询 */
  var qrCountTimer = null;   /* 二维码倒计时 */
  var qrGenTimer = null;     /* 生成中的「已等待 N 秒」进度 */
  var onlineTimer = null;    /* 在线时间页：30 秒自刷 */

  /* ---------------- 基础工具 ---------------- */

  function $(sel, root) {
    return (root || document).querySelector(sel);
  }

  function $$(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function num(v, digits) {
    var n = Number(v);
    if (v === null || v === undefined || v === '' || !isFinite(n)) return '—';
    return n.toLocaleString('en-US', {
      minimumFractionDigits: 0,
      maximumFractionDigits: digits === undefined ? 0 : digits
    });
  }

  function val(v) {
    if (v === null || v === undefined || v === '') return '—';
    if (typeof v === 'boolean') return v ? '是' : '否';
    return esc(String(v));
  }

  function mono(v, digits) {
    return '<span class="mono">' + num(v, digits) + '</span>';
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function asDate(v) {
    if (!v) return null;
    if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
    if (typeof v === 'number') {
      var d1 = new Date(v);
      return isNaN(d1.getTime()) ? null : d1;
    }
    var d2 = new Date(String(v).replace(' ', 'T'));
    return isNaN(d2.getTime()) ? null : d2;
  }

  function fmtClock(v) {
    var d = asDate(v);
    if (!d) return v ? esc(String(v)) : '—';
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function fmtStamp(v) {
    var d = asDate(v);
    if (!d) return v ? esc(String(v)) : '—';
    return (d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function fmtSeconds(sec) {
    var n = Number(sec);
    if (!isFinite(n) || n < 0) return '—';
    if (n < 60) return n.toFixed(n < 10 ? 1 : 0) + ' 秒';
    var m = Math.floor(n / 60);
    var s = Math.round(n % 60);
    return m + ' 分 ' + s + ' 秒';
  }

  function fmtMs(ms) {
    var n = Number(ms);
    if (!isFinite(n)) return '—';
    if (n < 1000) return n + ' ms';
    return (n / 1000).toFixed(1) + ' 秒';
  }

  /* 「多久以前」：接受毫秒时间戳，也接受 0/空 */
  function agoText(v) {
    var n = Number(v);
    if (!isFinite(n) || n <= 0) return '—';
    var sec = Math.max(0, Math.round((Date.now() - n) / 1000));
    if (sec < 60) return sec + ' 秒前';
    if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
    if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前';
    return Math.floor(sec / 86400) + ' 天前';
  }

  function pill(kind, text) {
    return '<span class="pill pill-' + kind + '"><i class="dot"></i>' + esc(text) + '</span>';
  }

  function kv(k, valueHtml, cls) {
    return '<div class="kv"><span class="kv-k">' + esc(k) + '</span><span class="kv-v ' + (cls || '') + '">' + valueHtml + '</span></div>';
  }

  function card(title, inner, extraClass) {
    return '<article class="card ' + (extraClass || '') + '">' +
      '<h2 class="card-title">' + esc(title) + '</h2>' + inner + '</article>';
  }

  function setHtml(node, html) {
    if (node) node.innerHTML = html;
  }

  /* ------- 渲染错误可见化 ---------------------------------------------------
     为什么要这个：safe() 以前只 console.warn，渲染异常在页面上完全不可见。
     曾经的真实事故——renderOverview 里 wdRows/ncRows 引用了未声明的 wd/nc 抛
     ReferenceError，被 safe() 静默吞掉，统计卡已经 setHtml 成功、卡片区却永远
     停在「等待数据 / 正在连接控制台服务…」，根因藏了很久没人发现。
     现在：任何渲染异常都会在页面顶部弹一条红色错误条（同一个 message 只报一次，
     避免 4 秒轮询刷屏），点击 × 关闭。
     ------------------------------------------------------------------------ */
  var barSeen = {};   /* 已报过的错误，去重 */
  var barEl = null;

  function ensureErrorBar() {
    if (barEl && barEl.parentNode) return barEl;
    var exist = document.getElementById('mollyRenderErrBar');
    if (exist) { barEl = exist; return barEl; }

    var bar = document.createElement('div');
    bar.id = 'mollyRenderErrBar';
    bar.style.position = 'fixed';
    bar.style.top = '0';
    bar.style.left = '0';
    bar.style.right = '0';
    bar.style.zIndex = '9999';
    bar.style.boxSizing = 'border-box';
    bar.style.padding = '8px 34px 8px 12px';
    bar.style.background = '#fff5f5';
    bar.style.color = '#c0392b';
    bar.style.borderBottom = '2px solid #c0392b';
    bar.style.font = '12px/1.6 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    bar.style.whiteSpace = 'pre-wrap';
    bar.style.maxHeight = '32vh';
    bar.style.overflow = 'auto';
    bar.style.textAlign = 'left';

    var body = document.createElement('div');
    body.className = 'js-render-err-body';
    bar.appendChild(body);

    var close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.title = '关闭';
    close.setAttribute('aria-label', '关闭错误提示');
    close.style.position = 'absolute';
    close.style.top = '0';
    close.style.right = '2px';
    close.style.width = '28px';
    close.style.height = '28px';
    close.style.border = '0';
    close.style.background = 'transparent';
    close.style.color = '#c0392b';
    close.style.font = '20px/1 ui-monospace, Menlo, Consolas, monospace';
    close.style.cursor = 'pointer';
    close.addEventListener('click', function () {
      bar.hidden = true;
      barSeen = {};   /* 关闭后允许重新报 */
    });
    bar.appendChild(close);

    document.body.appendChild(bar);
    barEl = bar;
    return bar;
  }

  /* 函数名 + ': ' + message；同一个 message 只报一次 */
  function showErrorBar(fnName, err) {
    var msg = err && err.message ? err.message : String(err);
    var line = String(fnName || '未知函数') + ': ' + msg;
    if (barSeen[line]) return;
    barSeen[line] = true;
    try {
      var bar = ensureErrorBar();
      var body = bar.querySelector('.js-render-err-body');
      if (!body) return;
      body.textContent = body.textContent ? body.textContent + '\n' + line : line;
      bar.hidden = false;
    } catch (e) {
      /* 连错误条都建不出来就别再抛了 */
    }
  }

  function safe(fn) {
    try {
      fn();
    } catch (err) {
      /* 渲染错误不能连累整个页面，但也绝不许静默：console + 页面顶部红条 双写 */
      console.warn('[molly-console] 渲染失败：', err);
      showErrorBar((fn && fn.name) || 'safe', err);
    }
  }

  function toast(msg) {
    var t = $('#toast');
    if (!t) return;
    t.textContent = msg;
    t.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, 2600);
  }

  function emptyHtml(text, retryLabel) {
    return '<div class="empty"><div>' + text + '</div>' +
      (retryLabel ? '<button class="btn btn-ghost btn-sm js-retry" type="button">' + esc(retryLabel) + '</button>' : '') +
      '</div>';
  }

  function bindRetry(box, fn) {
    $$('.js-retry', box).forEach(function (btn) {
      btn.addEventListener('click', fn);
    });
  }

  function progressHtml(pct) {
    var p = Math.max(0, Math.min(100, Number(pct) || 0));
    var cls = p >= 90 ? ' is-bad' : (p >= 70 ? ' is-warn' : '');
    return '<div class="progress"><div class="progress-fill' + cls + '" style="width:' + p.toFixed(1) + '%"></div></div>';
  }

  /* ---------------- 写操作通用底座（记忆 / 表情包 CRUD） ----------------
     为什么不用 runAction：runAction 是给「执行块」卡片的，它把结果画进卡片里的
     .action-result；CRUD 需要的是「错误留在弹层里、成功才关弹层并刷新列表」，
     生命周期不同。这里单独一套，但请求格式与 console-contract 保持一致。 */

  /* 统一 POST /api/action/<id>：永不 reject，失败信息统一放进 {ok:false,error}。
     这样调用方只需要 if (!res.ok) throw new Error(res.error)，不用每处都写 catch。 */
  function apiPost(actionId, body) {
    return fetch('/api/action/' + encodeURIComponent(actionId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () {
        return { ok: false, error: '服务端返回的不是 JSON（HTTP ' + r.status + '）' };
      }).then(function (j) {
        if (!j || typeof j !== 'object') j = { ok: false, error: '响应为空' };
        j.__http = r.status;
        return j;
      });
    }).catch(function (err) {
      return {
        ok: false,
        error: '请求失败：' + (err && err.message ? err.message : String(err)),
        __http: 0
      };
    });
  }

  /* 当前打开的弹层状态。同一时刻只允许一个，打开新的会覆盖旧的。 */
  var crud = null;

  function crudEls() {
    return {
      modal: $('#crudModal'),
      title: $('#crudTitle'),
      body: $('#crudBody'),
      err: $('#crudError'),
      hint: $('#crudHint'),
      ok: $('#crudOk'),
      cancel: $('#crudCancel')
    };
  }

  function openCrud(opts) {
    var e = crudEls();
    if (!e.modal) return;
    opts = opts || {};
    crud = {
      mode: opts.mode || 'edit',
      item: opts.item || null,
      chips: Array.isArray(opts.chips) ? opts.chips.slice() : [],
      file: null,
      dataUrl: '',
      busy: false,
      onOk: opts.onOk || null
    };
    e.title.textContent = opts.title || '编辑';
    e.body.innerHTML = opts.body || '';
    e.err.hidden = true;
    e.err.textContent = '';
    e.err.style.borderColor = '';
    e.hint.textContent = opts.hint || '';
    e.ok.textContent = opts.okText || '保存';
    e.ok.className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary');
    e.ok.removeAttribute('data-label');
    e.ok.classList.remove('is-loading');
    e.ok.disabled = false;
    e.cancel.disabled = false;
    e.modal.hidden = false;

    if (opts.afterOpen) {
      try { opts.afterOpen(); } catch (err) {
        console.warn('[molly-console] 弹层初始化失败：', err);
        showCrudError(err && err.message ? err.message : String(err));
      }
    }
    /* 自动聚焦第一个可输入项：键盘用户不用先点一下 */
    var first = e.body.querySelector('input:not([type=hidden]),textarea,select');
    if (first) {
      try { first.focus(); } catch (err) { /* 某些环境下 disabled 的输入框不能 focus */ }
    }
  }

  function closeCrud() {
    var e = crudEls();
    if (!e.modal) return;
    if (crud && crud.busy) return;   /* 保存中不许关：关了会看不见失败原因 */
    e.modal.hidden = true;
    e.body.innerHTML = '';
    e.err.hidden = true;
    e.err.textContent = '';
    crud = null;
  }

  function showCrudError(msg) {
    var e = crudEls();
    if (!e.err) return;
    e.err.textContent = String(msg === null || msg === undefined ? '' : msg);
    e.err.hidden = false;
  }

  /* 保存按钮：onOk 可以同步抛错（校验失败），也可以返回 Promise（请求中）。
     两种失败都只把原文写进弹层，绝不关闭。 */
  function submitCrud() {
    if (!crud || crud.busy) return;
    var e = crudEls();
    e.err.hidden = true;
    var fn = crud.onOk;
    if (!fn) { closeCrud(); return; }

    var out;
    try {
      out = fn();
    } catch (err) {
      showCrudError(err && err.message ? err.message : String(err));
      return;
    }
    if (!out || typeof out.then !== 'function') {
      closeCrud();
      return;
    }

    crud.busy = true;
    e.cancel.disabled = true;
    setBusy(e.ok, true);
    out.then(function () {
      if (!crud) return;
      crud.busy = false;
      closeCrud();
    }).catch(function (err) {
      if (!crud) return;
      crud.busy = false;
      e.cancel.disabled = false;
      setBusy(e.ok, false);
      showCrudError(err && err.message ? err.message : String(err));
    });
  }

  /* 文件名层面的关键词清洗：与插件端 stickers/add 的规则保持一致，前端先做一遍，
     用户能立刻看到自己要保存的名字；真正的权威校验仍然在服务端。 */
  function cleanKeyword(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/_/g, '-')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function memKindLabel(kind) {
    for (var i = 0; i < MEM_KINDS.length; i++) {
      if (MEM_KINDS[i][0] === kind) return MEM_KINDS[i][1];
    }
    return kind || '未分类';
  }

  function memDate(at) {
    var d = asDate(at);
    if (!d) return '—';
    return (d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /* ---------------- QQ 链路状态（统一口径，2026-10-25） ----------------
     主依据 = 插件桥接：plugin.link.state === 'online' ⇒ Molly 已经连上 OneBot，
     QQ 链路就是通的。次依据 = 客户端探测：ov.napcat 只回答「QQ 客户端进程在不在」。
     以前顶栏和总览把客户端探测当主依据，探测失败就显示「未连接」，
     部署者看到「QQ 未连接」但 QQ 明明在跑 —— 现在统一成四种组合，只在这里算一次。
     后端已经聚合出 ov.qq（level/text/nextStep 与 bridge、client 两组字段），前端只取。 */
  var QQ_LEVEL_TEXT = {
    connected: 'QQ 在线',
    'bridge-only': 'QQ 在线·客户端信息不可达',
    'client-only': 'QQ 在运行·Molly 未连',
    offline: 'QQ 未登录'
  };
  var QQ_LEVEL_KIND = {
    connected: 'ok',
    'bridge-only': 'ok',
    'client-only': 'warn',
    offline: 'bad'
  };

  function qqStatus(ov) {
    ov = ov || state.overview || {};
    var q = ov.qq;
    if (q && q.level) return q;
    /* 旧后端兼容（没有 ov.qq）：按同一优先级就地算一份，口径不许漂 */
    var p = ov.plugin || {};
    var link = p.link || {};
    var nc = ov.napcat || {};
    var bridgeOnline = link.ready === true && link.state === 'online';
    var clientReachable = nc.reachable === true;
    var level = bridgeOnline
      ? (clientReachable ? 'connected' : 'bridge-only')
      : (clientReachable ? 'client-only' : 'offline');
    var backend = nc.backend === 'snowluma' ? 'snowluma' : (nc.backend || '');
    return {
      level: level,
      text: QQ_LEVEL_TEXT[level],
      nextStep: '',
      bridgeState: link.state || 'unknown',
      bridgeReady: link.ready === true,
      bridgeOnline: bridgeOnline,
      clientReachable: clientReachable,
      clientLogin: nc.isLogin === true,
      backend: backend,
      backendName: backend === 'snowluma' ? 'SnowLuma' : 'QQ',
      uin: nc.uin || (p.bot && p.bot.userId) || null,
      nickname: nc.nickname || (p.bot && p.bot.nickname) || null,
      isLogin: bridgeOnline || nc.isLogin === true,
      napcat: nc
    };
  }

  /* ---------------- 顶部状态条 ---------------- */

  function renderTop() {
    var ov = state.overview || {};
    var p = ov.plugin || {};
    var nc = ov.napcat || {};
    var wd = ov.watchdog || {};

    var molly = $('#pillMolly');
    if (molly) {
      /* 读超时 ≠ 掉线：宿主在跑模型/写记忆时 /state 会慢 3~5 秒，
         后端已把「45 秒内曾在线」记成 qq.stale，这里跟着降级成「读取超时」。 */
      var qqForPill = qqStatus(ov);
      if (!p.reachable && qqForPill && qqForPill.stale) {
        molly.className = 'pill pill-warn';
        molly.innerHTML = '<i class="dot"></i>Molly 在线（读取超时）';
        molly.title = '宿主这会儿在跑模型或写记忆，读数慢了一点，不是掉线。';
      } else if (!p.reachable) {
        molly.className = 'pill pill-idle';
        molly.innerHTML = '<i class="dot"></i>插件不可达';
        molly.title = '';
      } else if (p.link && p.link.ready) {
        molly.className = 'pill pill-ok';
        molly.innerHTML = '<i class="dot"></i>Molly 在线';
      } else if (p.enabled === false) {
        molly.className = 'pill pill-idle';
        molly.innerHTML = '<i class="dot"></i>Molly 已关闭';
      } else {
        molly.className = 'pill pill-bad';
        molly.innerHTML = '<i class="dot"></i>Molly 离线';
      }
    }

    var np = $('#pillNapcat');
    if (np) {
      /* QQ 状态 pill：主依据是插件桥接（link），客户端探测只作为补充信息。
         四种组合的文案和配色都在 qqStatus() 里统一，别在这里另写一套。 */
      var hasData = !!(ov.qq || ov.plugin || ov.napcat);
      var q = qqStatus(ov);
      if (!hasData) {
        np.className = 'pill pill-idle';
        np.innerHTML = '<i class="dot"></i>QQ 未知';
        np.title = '还没拿到控制台数据';
      } else {
        np.className = 'pill pill-' + (QQ_LEVEL_KIND[q.level] || 'idle');
        np.innerHTML = '<i class="dot"></i>' + esc(QQ_LEVEL_TEXT[q.level] || 'QQ 未知');
        np.title = q.text + (q.nextStep ? '：' + q.nextStep : '');
      }
    }

    var wp = $('#pillWatchdog');
    if (wp) {
      if (!wd.reachable) {
        wp.className = 'pill pill-idle';
        wp.innerHTML = '<i class="dot"></i>守护 不可达';
      } else if (!wd.lastRun && wd.lastRun !== '') {
        /* watchdog.mjs 只写 lastState/lastCheckAt，不写 lastResult。
           判「跑没跑过」看 lastRun 有没有值，跑没跑好没有独立字段，只能看 lastState。 */
        wp.className = 'pill pill-idle';
        wp.innerHTML = '<i class="dot"></i>守护 未跑过';
      } else if (wd.state && wd.state.lastState === 'offline') {
        wp.className = 'pill pill-warn';
        wp.innerHTML = '<i class="dot"></i>守护 上次离线';
      } else {
        wp.className = 'pill pill-ok';
        wp.innerHTML = '<i class="dot"></i>守护 正常';
      }
    }

    var model = $('#topModel');
    if (model) model.textContent = p.model ? String(p.model) : '—';

    var budget = p.budget || {};
    var tb = $('#topBudget');
    if (tb) tb.textContent = (budget.used === undefined || budget.used === null)
      ? '—'
      : num(budget.used, 2) + '/' + num(budget.dailyCap, 0);

    var tr = $('#topRefresh');
    if (tr) tr.textContent = state.lastOkAt ? fmtClock(state.lastOkAt) : '—';

    updateLinkPill();
  }

  function updateLinkPill() {
    var el = $('#pillLink');
    if (!el) return;
    if (!state.lastError) {
      el.hidden = true;
      return;
    }
    el.hidden = false;
    var secs = state.lastOkAt ? Math.max(0, Math.round((Date.now() - state.lastOkAt) / 1000)) : null;
    el.innerHTML = '<i class="dot"></i>连接中断' +
      (secs === null ? '（还没有拿到数据）' : '（上次数据 ' + secs + ' 秒前）');
  }

  /* ---------------- 总览 ---------------- */

  /* 卡片区渲染失败时的红边卡片：写清楚错在哪，别静默停在占位 */
  function overviewErrorCard(msg) {
    return '<article class="card" style="border-color:#c0392b;background:#fff5f5">' +
      '<h2 class="card-title" style="color:#c0392b">总览渲染失败</h2>' +
      '<p class="ar-error" style="white-space:pre-wrap">总览渲染失败：' + esc(msg) + '</p>' +
      '<p class="card-sub">这是真实的前端渲染异常（以前会被 safe() 静默吞掉，只留一张空白占位）。' +
      '按 Ctrl+F5 可重试；若一直出现，把这条错误原文发给开发者。</p>' +
      '</article>';
  }

  function renderOverview() {
    var ov = state.overview;
    var stats = $('#ovStats');
    var cards = $('#ovCards');
    if (!stats || !cards) return;

    if (!ov) {
      setHtml(stats, '');
      setHtml(cards, card('等待数据', '<p class="card-sub">正在连接控制台服务…</p>'));
      var b0 = $('#ovLoginBanner');
      if (b0) b0.hidden = true;
      return;
    }

    var p = ov.plugin || {};
    var nc = ov.napcat || {};
    var wd = ov.watchdog || {};
    var metrics = p.metrics || {};
    var budget = p.budget || {};
    var mem = p.memory || {};
    var stk = p.stickers || {};
    var side = ov.sidecar || {};

    /* 掉登录横幅：只在「Molly 没连上 QQ」时出现（桥接离线且客户端也不可达，
       或者客户端在跑但 Molly 没连上）。客户端信息不可达但桥接正常不算掉线，
       否则又回到「QQ 明明在线却提示未连接」的老问题。 */
    var q = qqStatus(ov);
    var banner = $('#ovLoginBanner');
    if (banner) {
      banner.hidden = !(q.level === 'offline' || q.level === 'client-only');
    }

    /* ── 统计卡：独立 try。这里炸了也不许影响下面卡片区 ─────────────────── */
    try {
      var used = Number(budget.used);
      var cap = Number(budget.dailyCap);
      var pct = (isFinite(used) && isFinite(cap) && cap > 0) ? (used / cap) * 100 : 0;

      setHtml(stats, [
        '<div class="stat tint-sky"><div class="stat-label">今日积分</div>' +
          '<div class="stat-value">' + num(budget.used, 2) + '<span class="stat-unit">/ ' + num(budget.dailyCap, 0) + '</span></div>' +
          progressHtml(pct) +
          '<div class="stat-note">' + (budget.enabled ? '积分限制已开启' : '积分限制已关闭') + ' · 日切 ' + val(budget.day) + '</div></div>',
        '<div class="stat tint-lavender"><div class="stat-label">Jasmine 记忆</div>' +
          '<div class="stat-value">' + num(mem.count, 0) + '<span class="stat-unit">条</span></div>' +
          '<div class="stat-note">' + (side.reachable ? '数据服务已连接' : '数据服务不可达') + '</div></div>',
        '<div class="stat tint-mint"><div class="stat-label">表情</div>' +
          '<div class="stat-value">' + num(stk.count, 0) + '<span class="stat-unit">张</span></div>' +
          '<div class="stat-note">已学 ' + num(stk.learned, 0) + ' 张</div></div>',
        '<div class="stat tint-cream"><div class="stat-label">已聊</div>' +
          '<div class="stat-value">' + num(metrics.messages, 0) + '<span class="stat-unit">条</span></div>' +
          '<div class="stat-note">' + num(metrics.conversations, 0) + ' 个会话 · 平均 ' + fmtSeconds(metrics.avgReplySeconds) + '</div></div>'
      ].join(''));
    } catch (err) {
      console.warn('[molly-console] 总览统计卡渲染失败：', err);
      showErrorBar('renderOverview/统计卡', err);
    }

    /* ── 卡片区：独立 try。抛错时显示红边卡片，绝不停在占位 ─────────────── */
    try {
      var identity = p.reachable
        ? [
          kv('连接', p.link && p.link.ready ? pill('ok', 'ready') : pill('bad', val(p.link && p.link.state))),
          kv('插件', p.enabled === false ? pill('idle', '已停用') : pill('ok', '已启用')),
          kv('机器人', val(p.bot && p.bot.nickname)),
          kv('QQ 号', p.bot && p.bot.userId ? '<span class="mono">' + esc(p.bot.userId) + '</span>' : '—'),
          kv('群数', p.bot && p.bot.groupCount !== undefined && p.bot.groupCount !== null ? mono(p.bot.groupCount) : '—'),
          kv('模型', p.model ? '<span class="mono">' + esc(p.model) + '</span>' : '—')
        ].join('')
        : '<p class="ar-error">插件不可达：' + esc(p.error || '宿主未响应') + '</p>';

      var msgRows = [
        kv('消息总数', mono(metrics.messages)),
        kv('会话数', mono(metrics.conversations)),
        kv('平均响应', fmtSeconds(metrics.avgReplySeconds)),
        kv('上次响应', fmtMs(metrics.lastReplyMs)),
        kv('上次说话', fmtStamp(metrics.lastReplyAt))
      ].join('');

      var wdRows = [
        /* watchdog.mjs 不写 lastResult，只用 lastState/lastRun 表达结果 */
        kv('巡检结论', wd.reachable
          ? (!wd.lastRun ? pill('idle', '还没跑过')
            : (wd.state && wd.state.lastState === 'offline' ? pill('warn', '上次离线') : pill('ok', '上次在线')))
          : pill('idle', '不可达')),
        kv('上次巡检', val(wd.lastRun)),
        kv('免打扰', wd.quiet ? pill('idle', '静默中') : '否'),
        kv('计划任务', wd.taskEnabled === false ? pill('warn', '已禁用') : '已启用')
      ].join('');

      /* QQ 连接卡：状态用统一口径（桥接优先），后端名只做展示。
         SnowLuma 是默认后端；只有回滚配置才会出现 NapCat，且这里不显示品牌名。 */
      var qRows = [
        kv('状态', pill(QQ_LEVEL_KIND[q.level] || 'idle', q.text || '未知')),
        kv('后端', esc(q.backendName || 'QQ')),
        kv('Molly 链路', q.bridgeReady ? pill('ok', '已连接') : pill('bad', val(q.bridgeState))),
        kv('QQ 客户端', q.clientReachable
          ? (q.clientLogin ? pill('ok', '已登录') : pill('warn', '未登录'))
          : pill('idle', '进程信息不可达')),
        kv('QQ 号', (q.uin || (p.bot && p.bot.userId)) ? '<span class="mono">' + esc(q.uin || p.bot.userId) + '</span>' : '—'),
        kv('昵称', q.nickname ? esc(q.nickname) : '—'),
        q.backend === 'snowluma'
          ? kv('深度探测', nc.deepOk === true ? pill('ok', '正常') : (nc.deepOk === false ? pill('warn', '假在线') : '—'))
          : kv('核心', nc.coreReady ? '就绪' : '未就绪')
      ].join('');

      var learner = p.learner || {};
      var today = learner.today || {};
      var learnRows = [
        kv('累计学会', mono(learner.total) + ' 张'),
        kv('今日学会', mono(today.kept) + ' 张'),
        kv('采纳', mono(learner.kept)),
        kv('拒绝', mono(learner.rejected)),
        kv('重复', mono(learner.dup))
      ].join('');

      var sideRows = side.reachable
        ? [
          kv('状态', pill('ok', '已连接')),
          kv('记忆', mono((side.memory && side.memory.count) || (p.memory && p.memory.count)) + ' 条'),
          kv('表情', mono(side.stickers && side.stickers.count) + ' 张'),
          kv('预算上限', mono(side.budget && side.budget.cap))
        ].join('')
        : '<p class="ar-error">数据服务 19391 不可达：' + esc(side.error || '连接被拒绝') + '</p>';

      setHtml(cards, [
        card('连接与身份', identity),
        card('消息与响应', msgRows),
        card('守护', wdRows),
        card('QQ 连接', qRows),
        card('学习器', learnRows),
        card('数据服务', sideRows)
      ].join(''));
    } catch (err) {
      console.warn('[molly-console] 总览卡片区渲染失败：', err);
      showErrorBar('renderOverview/卡片区', err);
      setHtml(cards, overviewErrorCard(err && err.message ? err.message : String(err)));
    }
  }

  /* ---------------- 会话与消息 ---------------- */

  function renderChats() {
    var box = $('#chatCards');
    if (!box) return;
    var ov = state.overview;
    if (!ov) { setHtml(box, card('等待数据', '<p class="card-sub">正在连接控制台服务…</p>')); return; }

    var p = ov.plugin || {};
    var m = p.metrics || {};
    var l = p.learner || {};
    var side = ov.sidecar || {};

    var metricsTable =
      '<table class="tbl"><thead><tr><th>指标</th><th class="num">值</th></tr></thead><tbody>' +
      '<tr><td>消息总数</td><td class="num">' + num(m.messages, 0) + '</td></tr>' +
      '<tr><td>会话数</td><td class="num">' + num(m.conversations, 0) + '</td></tr>' +
      '<tr><td>平均响应</td><td class="num">' + fmtSeconds(m.avgReplySeconds) + '</td></tr>' +
      '<tr><td>上次响应耗时</td><td class="num">' + fmtMs(m.lastReplyMs) + '</td></tr>' +
      '<tr><td>上次说话</td><td class="num">' + fmtStamp(m.lastReplyAt) + '</td></tr>' +
      '</tbody></table>';

    var learnerTable =
      '<table class="tbl"><thead><tr><th>结果</th><th class="num">条数</th></tr></thead><tbody>' +
      '<tr><td>累计学会</td><td class="num">' + num(l.total, 0) + '</td></tr>' +
      '<tr><td>今日学会</td><td class="num">' + num(l.today && l.today.kept, 0) + '</td></tr>' +
      '<tr><td>本进程采纳</td><td class="num">' + num(l.kept, 0) + '</td></tr>' +
      '<tr><td>本进程拒绝</td><td class="num">' + num(l.rejected, 0) + '</td></tr>' +
      '<tr><td>本进程重复</td><td class="num">' + num(l.dup, 0) + '</td></tr>' +
      '</tbody></table>';

    /* 跳过/拒绝原因（P0）：来自 .learned-stats.json 的 reasons，
       用来回答"为什么一张都没学成"——是体积超限、视觉描述失败还是配额满了。 */
    var reasons = l.reasons || {};
    var reasonKeys = Object.keys(reasons)
      .filter(function (k) { return Number(reasons[k]) > 0; })
      .sort(function (a, b) { return Number(reasons[b]) - Number(reasons[a]); })
      .slice(0, 6);
    var reasonTable = reasonKeys.length
      ? '<table class="tbl"><thead><tr><th>跳过原因</th><th class="num">次数</th></tr></thead><tbody>' +
        reasonKeys.map(function (k) { return kv(k, mono(reasons[k])); }).join('') +
        '</tbody></table>'
      : '<p class="card-sub">还没有跳过记录。</p>';

    var sideRows = side.reachable
      ? [
        kv('记忆条数', mono((side.memory && side.memory.count) || (p.memory && p.memory.count))),
        kv('表情张数', mono(side.stickers && side.stickers.count)),
        kv('消息（旁路）', mono(side.metrics && side.metrics.messages))
      ].join('')
      : '<p class="ar-error">数据服务不可达：' + esc(side.error || '连接被拒绝') + '</p>';

    var groups = (side.memory && side.memory.groups) || null;
    var groupRows = '';
    if (Array.isArray(groups)) {
      /* sidecar 实际返回的是 [{name, items:[...]}]，按数组渲染，别按对象枚举 */
      groupRows = groups.map(function (g) {
        var n = (g && Array.isArray(g.items)) ? g.items.length : (g && g.count);
        return kv((g && g.name) || '未分组', mono(n) + ' 条');
      }).join('');
    } else if (groups && typeof groups === 'object') {
      groupRows = Object.keys(groups).map(function (k) {
        return kv(k, mono(groups[k]) + ' 条');
      }).join('');
    }

    setHtml(box, [
      card('消息指标', metricsTable),
      card('学习器取舍', learnerTable),
      card('学习跳过原因', reasonTable),
      card('数据服务计数', sideRows + (groupRows ? '<div class="kv-sep"></div>' + groupRows : ''))
    ].join(''));
  }

  /* ---------------- 记忆 ---------------- */

  function loadMemory(force) {
    if (state.memEntries && !force) return;
    var sub = $('#memSub');
    if (!state.memEntries) {
      if (sub) sub.textContent = 'Jasmine · 正在读取…';
      safe(memSkeleton);
    }

    /* 优先走带 id 的写接口：只有它返回的条目才能「改 / 删」。
       写接口未上线（console-server 还是旧的 14 个动作，POST 会 404）时退回
       只读的 /api/memory，页面照常能看，只是出现一条降级提示。 */
    apiPost('memory/list', {}).then(function (res) {
      if (res.ok) {
        /* console-server 会包一层 {ok,data}；插件直连时 entries 在顶层。两形状都认。 */
        var data = (res.data && Array.isArray(res.data.entries)) ? res.data : res;
        state.memEntries = Array.isArray(data.entries) ? data.entries : [];
        state.memCrudReady = true;
        state.memCrudError = null;
        state.memoryError = null;
        safe(renderMemory);
        return;
      }
      if (res.__http === 404 || res.__http === 0) {
        state.memCrudReady = false;
        state.memCrudError = res.error || 'memory/list 不可用';
        loadMemoryReadOnly();
        return;
      }
      state.memoryError = res.error || ('HTTP ' + res.__http);
      state.memCrudReady = false;
      safe(renderMemory);
    });
  }

  /* 只读兜底：老接口 /api/memory 返回按分组整理好的文本，没有 id，不能编辑 */
  function loadMemoryReadOnly() {
    fetch('/api/memory', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        if (!j || j.ok === false) throw new Error((j && j.error) || '接口返回失败');
        state.memory = j;
        state.memoryError = null;
        safe(renderMemory);
      })
      .catch(function (err) {
        state.memoryError = err && err.message ? err.message : String(err);
        safe(renderMemory);
      });
  }

  function renderMemory() {
    var box = $('#memGroups');
    var sub = $('#memSub');
    var notice = $('#memNotice');
    var addBtn = $('#memAdd');
    if (!box || !sub) return;

    /* 只读降级时整页换成单栏（CSS .is-readonly），三栏里的写接口产物不参与 */
    var pageEl = $('#jzPage');
    if (pageEl) pageEl.classList.toggle('is-readonly', state.memCrudReady !== true);

    /* 降级提示与「新增」按钮状态：写接口不可用时按钮禁用，但页面照常可读 */
    if (notice) {
      var degraded = state.memCrudReady === false;
      notice.hidden = !degraded;
      if (degraded) {
        notice.textContent = '写接口（memory/list）还没上线，当前是只读视图：新增 / 修改 / 删除暂不可用。' +
          '（' + (state.memCrudError || '服务端未提供该动作') + '）上线后点「重新加载」即可恢复。';
      }
    }
    if (addBtn) {
      var canAdd = state.memCrudReady === true;
      addBtn.disabled = !canAdd;
      addBtn.title = canAdd ? '' : '写接口未上线，暂时不能新增';
    }

    if (state.memCrudReady === true) {
      renderMemoryEntries();
      return;
    }

    /* 只读降级：三栏里的指标 / 索引 / 详情都清掉，别把写接口的旧结果留在页面上 */
    setHtml($('#jzHero'), '');
    setHtml($('#jzFacets'), '');
    setHtml($('#jzDetail'), '');
    jzCloseDrawer();
    var roCount = $('#jzCount');
    if (roCount) roCount.textContent = '—';
    var roMore = $('#jzMoreWrap');
    if (roMore) roMore.hidden = true;

    if (state.memoryError && !state.memory) {
      sub.textContent = '读取失败';
      setHtml(box, emptyHtml('记忆读取失败：' + esc(state.memoryError), '重试'));
      bindRetry(box, function () { loadMemory(true); });
      return;
    }
    if (!state.memory) {
      sub.textContent = 'Jasmine · 正在读取…';
      setHtml(box, '');
      return;
    }

    var data = state.memory;
    var mem = data.memory || data;
    var groups = Array.isArray(mem.groups) ? mem.groups : [];

    sub.textContent = 'Jasmine · 共 ' + num(mem.count, 0) + ' 条 · 更新于 ' + val(mem.updatedAt) + ' · 只读';

    if (!groups.length) {
      setHtml(box, emptyHtml('还没有记忆条目。'));
      return;
    }

    var html = groups.map(function (g) {
      var items = Array.isArray(g.items) ? g.items : [];
      var rows = items.map(function (it) {
        var search = [it.date, it.tag, it.text, it.who, it.qq].filter(Boolean).join(' ').toLowerCase();
        return '<div class="mem-item" data-search="' + esc(search) + '">' +
          (it.date ? '<span class="mem-date">' + esc(it.date) + '</span>' : '') +
          (it.tag ? '<span class="mem-tag">' + esc(it.tag) + '</span>' : '') +
          (it.who ? '<span class="mem-who">' + esc(it.who) + '</span>' : '') +
          (it.qq ? '<span class="mem-qq">QQ ' + esc(it.qq) + '</span>' : '') +
          '<span class="mem-text">' + esc(it.text) + '</span>' +
          '</div>';
      }).join('');
      return '<details class="mem-group" open>' +
        '<summary class="mem-summary">' + esc(g.name || '未分组') +
        '<span class="mem-count mono">' + items.length + ' 条</span></summary>' +
        '<div class="mem-items">' + rows + '</div></details>';
    }).join('');

    setHtml(box, html);
    applyMemFilter();
  }

  /* ---------------- Jasmine 记忆：视图层 ----------------
     5428 条全部在内存数组上过滤 / 排序，DOM 只保留当前一批（JZ_BATCH 条/批）。
     搜索按空格分词、词间 AND；命中高亮只做前 2 处，长文本不会爆量。
     任何筛选 / 搜索变化：重置为 60 条并回到列表顶部。 */
  var JZ_BATCH = 60;
  var JZ_MARK = '<svg class="jz-mark" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><g fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round"><ellipse cx="12" cy="6.6" rx="2.5" ry="3.9"/><ellipse cx="12" cy="6.6" rx="2.5" ry="3.9" transform="rotate(72 12 12)"/><ellipse cx="12" cy="6.6" rx="2.5" ry="3.9" transform="rotate(144 12 12)"/><ellipse cx="12" cy="6.6" rx="2.5" ry="3.9" transform="rotate(216 12 12)"/><ellipse cx="12" cy="6.6" rx="2.5" ry="3.9" transform="rotate(288 12 12)"/><circle cx="12" cy="12" r="1.3"/></g></svg>';

  var memView = {
    q: '', sort: 'added',
    kind: '', who: '', band: '', time: '', day: '',
    shown: JZ_BATCH, selId: null, whoAll: false,
    view: null, index: null
  };

  function jzWide() {
    try {
      return !window.matchMedia || window.matchMedia('(min-width: 1280px)').matches;
    } catch (err) { return true; }
  }

  function jzDayStart(daysAgo) {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    if (daysAgo) d.setDate(d.getDate() - daysAgo);
    return d.getTime();
  }

  function jzMs(v) {
    var d = asDate(v);
    if (d) return d.getTime();
    var n = Number(v);
    return isFinite(n) && n > 0 ? n : 0;
  }

  function jzWho(it) {
    return it && it.who ? String(it.who).trim() : '';
  }

  function jzWeightTxt(it) {
    var w = Number(it && it.weight);
    if (!isFinite(w) || w <= 0) return '—';
    return String(Math.round(w * 10) / 10);
  }

  /* ── 权重衰减（记忆曲线）─────────────────────────────────────────
     盘上只存 base（weight）+ hits + lastActiveDay；衰减是「读的时候的看法」：
     空闲 = 当前活跃天 − 条目的 lastActiveDay，超过该类宽限期后每 7 活跃天 −0.5，
     掉到该类下限为止（称谓恒 10）。
     这张表必须和 plugin/dsh-qq-whale/lib/memory.js 里的 WEIGHT_FLOOR / GRACE_ACTIVE_DAYS /
     DECAY_STEP_DAYS / DECAY_STEP 保持一致，否则界面显示的有效权重和召回用的不是一个数。 */
  var JZ_DECAY_FLOOR = { address: 10, promise: 5, person: 4, fact: 3, preference: 3, event: 1, meme: 1 };
  var JZ_DECAY_GRACE = { address: Infinity, promise: 14, person: 14, fact: 14, preference: 14, event: 7, meme: 7 };
  var JZ_DECAY_STEP_DAYS = 7;
  var JZ_DECAY_STEP = 0.5;

  /* 活跃天：插件 state 里 memory.activeDays 是权威值；后端没带时退一步用最老的 lastActiveDay 猜。 */
  function jzActiveDays() {
    var m = state.overview && state.overview.plugin && state.overview.plugin.memory;
    var n = m ? Number(m.activeDays) : NaN;
    if (isFinite(n) && n > 0) return n;
    var all = state.memEntries || [], max = 0;
    for (var i = 0; i < all.length; i++) {
      var v = Number(all[i] && all[i].lastActiveDay);
      if (isFinite(v) && v > max) max = v;
    }
    return max;
  }

  function jzFmtW(w) { return String(Math.round(Number(w) * 10) / 10); }

  function jzDecay(it) {
    var kind = String((it && it.kind) || 'fact');
    var base = Number(it && it.weight);
    if (!isFinite(base) || base <= 0) base = 6;
    base = Math.min(10, Math.max(1, Math.round(base)));
    var days = jzActiveDays();
    if (kind === 'address') return { base: base, eff: 10, idle: 0, grace: Infinity, steps: 0, floor: 10, days: days };
    var floor = JZ_DECAY_FLOOR[kind] !== undefined ? JZ_DECAY_FLOOR[kind] : 1;
    var last = Number(it && it.lastActiveDay);
    if (!isFinite(last)) last = 0;
    var idle = Math.max(0, days - Math.max(0, Math.round(last)));
    var grace = JZ_DECAY_GRACE[kind] !== undefined ? JZ_DECAY_GRACE[kind] : JZ_DECAY_STEP_DAYS;
    var steps = 0;
    var eff = base;
    if (base > floor && isFinite(grace) && idle > grace) {
      steps = Math.floor((idle - grace) / JZ_DECAY_STEP_DAYS);
      eff = Math.min(10, Math.max(floor, Math.round((base - steps * JZ_DECAY_STEP) * 10) / 10));
    }
    return { base: base, eff: eff, idle: idle, grace: grace, steps: steps, floor: floor, days: days };
  }

  /* 行内标签：没掉权只显示一个数；掉了显示「w6→5.5」，一眼能看出曲线在起作用。 */
  function jzWLabel(it) {
    var d = jzDecay(it);
    if (d.eff >= d.base) return 'w' + jzFmtW(d.base);
    return 'w' + jzFmtW(d.base) + '<span class="jz-wdown">→' + jzFmtW(d.eff) + '</span>';
  }

  function jzTokens() {
    return String(memView.q || '').toLowerCase().split(/\s+/).filter(function (t) { return !!t; });
  }

  /* 检索串每条只拼一次，挂在条目自己的 __jzHay 上（只在内存里，不回写数据）。 */
  function jzHay(it) {
    if (it.__jzHay === undefined) {
      it.__jzHay = [it.text, it.who, it.qq, memKindLabel(it.kind)].filter(Boolean).join(' ').toLowerCase();
    }
    return it.__jzHay;
  }

  /* 本地日历日 YYYY-MM-DD（用本地时区，避免 toISOString 的 UTC 偏移把凌晨算到前一天） */
  function jzDayKey(ms) {
    var d = new Date(jzMs(ms));
    if (isNaN(d.getTime())) return '';
    var m = d.getMonth() + 1, day = d.getDate();
    return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  function jzTodayKey() { return jzDayKey(Date.now()); }

  function jzInTime(it, bucket) {
    var at = jzMs(it.at);
    if (bucket === 'today') return at >= jzDayStart(0);
    if (bucket === 'week') return at >= jzDayStart(6);
    if (bucket === 'month') return at >= jzDayStart(29);
    if (bucket === 'older') return at < jzDayStart(29);
    return true;
  }

  function jzBandOf(it) {
    var w = jzDecay(it).eff;
    if (!isFinite(w)) w = 0;
    if (w >= 8) return 'core';
    if (w >= 5) return 'normal';
    return 'edge';
  }

  /* skip：算某一组的计数时先忽略它自己那一组（分面计数的常规口径） */
  function jzPass(it, toks, skip) {
    if (!it) return false;
    if (skip !== 'kind' && memView.kind && String(it.kind) !== memView.kind) return false;
    if (skip !== 'who' && memView.who) {
      var who = jzWho(it);
      if (memView.who === '__none__') { if (who) return false; }
      else if (who !== memView.who) return false;
    }
    if (skip !== 'band' && memView.band && jzBandOf(it) !== memView.band) return false;
    if (skip !== 'time' && memView.time && !jzInTime(it, memView.time)) return false;
    if (skip !== 'day' && memView.day && jzDayKey(it.at) !== memView.day) return false;
    if (toks && toks.length) {
      var hay = jzHay(it);
      for (var i = 0; i < toks.length; i++) if (hay.indexOf(toks[i]) < 0) return false;
    }
    return true;
  }

  function jzFilterList(skip) {
    var all = state.memEntries || [];
    var toks = jzTokens();
    var out = [];
    for (var i = 0; i < all.length; i++) {
      if (jzPass(all[i], toks, skip)) out.push(all[i]);
    }
    return out;
  }

  function jzViewList() {
    var out = jzFilterList();
    var s = memView.sort;
    out.sort(function (a, b) {
      var d = 0;
      if (s === 'added') d = jzMs(b.at) - jzMs(a.at);
      else if (s === 'old') d = jzMs(a.at) - jzMs(b.at);
      else if (s === 'weight') d = jzDecay(b).eff - jzDecay(a).eff;
      else if (s === 'weight-asc') d = jzDecay(a).eff - jzDecay(b).eff;
      else if (s === 'hits') d = (Number(b.hits) || 0) - (Number(a.hits) || 0);
      /* lastActiveDay 是「第几天」的序号、不是时间戳，混进来会让排序看起来是乱的（2026-11-05） */
      else d = jzMs(b.lastHitAt || b.at) - jzMs(a.lastHitAt || a.at);
      if (d) return d;
      return (s === 'old' || s === 'weight-asc') ? (jzMs(a.at) - jzMs(b.at)) : (jzMs(b.at) - jzMs(a.at));
    });
    return out;
  }

  function jzStats() {
    var all = state.memEntries || [];
    var n = 0, withQQ = 0, today = 0, wSum = 0, wN = 0, latest = 0, decayed = 0;
    var kinds = {}, order = [];
    MEM_KINDS.forEach(function (k) { kinds[k[0]] = 0; order.push(k[0]); });
    var t0 = jzDayStart(0);
    for (var i = 0; i < all.length; i++) {
      var it = all[i];
      if (!it) continue;
      n++;
      if (it.qq) withQQ++;
      var at = jzMs(it.at);
      if (at >= t0) today++;
      if (at > latest) latest = at;
      var d = jzDecay(it);
      if (isFinite(d.eff) && d.eff > 0) { wSum += d.eff; wN++; }
      if (d.eff < d.base) decayed++;
      var k = String(it.kind || '');
      if (kinds[k] === undefined) { kinds[k] = 0; order.push(k); }
      kinds[k]++;
    }
    return { n: n, withQQ: withQQ, today: today, wAvg: wN ? wSum / wN : 0, latest: latest, decayed: decayed, days: jzActiveDays(), kinds: kinds, order: order };
  }

  function jzMetric(k, v) {
    return '<div class="jz-metric"><span class="jz-metric-k">' + esc(k) + '</span>' +
      '<span class="jz-metric-v mono">' + v + '</span></div>';
  }

  function jzHeroHtml(st) {
    var pct = st.n ? Math.round(st.withQQ / st.n * 100) : 0;
    var avg = st.wAvg ? (Math.round(st.wAvg * 10) / 10).toFixed(1) : '—';
    var segs = [], legend = [];
    st.order.forEach(function (k, i) {
      var c = st.kinds[k] || 0;
      if (!c || !st.n) return;
      var share = (c / st.n) * 100;
      var label = memKindLabel(k);
      segs.push('<span class="jz-seg" data-i="' + Math.min(i, 6) + '" style="width:' + share.toFixed(2) + '%" title="' +
        esc(label) + ' ' + num(c, 0) + ' 条 · ' + share.toFixed(1) + '%"></span>');
      legend.push('<button class="jz-legend" type="button" data-act="jz-facet" data-group="kind" data-value="' + esc(k) + '">' +
        '<i class="jz-legend-dot" data-i="' + Math.min(i, 6) + '"></i>' + esc(label) +
        '<span class="jz-legend-n mono">' + num(c, 0) + '</span></button>');
    });
    return '<div class="jz-hero-inner">' +
      '<div class="jz-metrics">' +
      jzMetric('总条数', num(st.n, 0)) +
      jzMetric('今日新增', num(st.today, 0)) +
      jzMetric('有身份', num(st.withQQ, 0) + ' <em>· ' + pct + '%</em>') +
      jzMetric('平均权重', 'w' + avg) +
      '</div>' +
      '<div class="jz-dist">' +
      '<div class="jz-dist-bar" role="img" aria-label="类型分布">' + segs.join('') + '</div>' +
      '<div class="jz-dist-legend">' + legend.join('') + '</div>' +
      '</div>' +
      '<div class="jz-decay-note">衰减曲线：活跃天 <b class="mono">' + num(st.days, 0) + '</b> 天 · ' +
      '事实/约定/人物/偏好宽限 14 天、闲聊/梗 7 天，之后每 7 活跃天 −0.5' +
      (st.decayed ? ' · 已有 <b class="mono">' + num(st.decayed, 0) + '</b> 条掉权' : ' · 还没有条目掉权') +
      '</div></div>';
  }

  function jzFacetRow(group, value, label, count, on) {
    return '<button class="jz-facet-row' + (on ? ' is-on' : '') + '" type="button" ' +
      'data-act="jz-facet" data-group="' + esc(group) + '" data-value="' + esc(value) + '"' +
      (on ? ' aria-pressed="true"' : '') + '>' +
      '<span class="jz-facet-label">' + esc(label) + '</span>' +
      '<span class="jz-facet-n mono">' + num(count, 0) + '</span></button>';
  }

  function jzPillText(group, value) {
    if (group === 'kind') return '类型：' + memKindLabel(value);
    if (group === 'who') return '人物：' + (value === '__none__' ? '未记名字' : value);
    if (group === 'band') return '权重：' + (value === 'core' ? '核心' : value === 'normal' ? '常规' : '边缘');
    if (group === 'time') return '时间：' + (value === 'today' ? '今天' : value === 'week' ? '近 7 天' : value === 'month' ? '近 30 天' : '更早');
    if (group === 'day') return '日期：' + String(value || '').slice(5);
    return String(value);
  }

  function jzFacetsHtml() {
    var byKind = jzFilterList('kind');
    var byWho = jzFilterList('who');
    var byBand = jzFilterList('band');
    var byTime = jzFilterList('time');

    var kindCount = {};
    byKind.forEach(function (it) { var k = String(it.kind || ''); kindCount[k] = (kindCount[k] || 0) + 1; });

    var whoCount = {};
    byWho.forEach(function (it) {
      var w = jzWho(it) || '__none__';
      whoCount[w] = (whoCount[w] || 0) + 1;
    });
    var whoKeys = Object.keys(whoCount).sort(function (a, b) { return whoCount[b] - whoCount[a]; });
    var named = whoKeys.filter(function (k) { return k !== '__none__'; });

    var bandCount = { core: 0, normal: 0, edge: 0 };
    byBand.forEach(function (it) { bandCount[jzBandOf(it)]++; });

    var timeCount = { today: 0, week: 0, month: 0, older: 0 };
    byTime.forEach(function (it) {
      ['today', 'week', 'month', 'older'].forEach(function (b) { if (jzInTime(it, b)) timeCount[b]++; });
    });

    /* 顶部：当前筛选回显 + 一键清除 */
    var pills = [];
    ['kind', 'who', 'band', 'time', 'day'].forEach(function (g) {
      if (!memView[g]) return;
      pills.push('<button class="jz-pill" type="button" data-act="jz-facet" data-group="' + g + '" data-value="' + esc(memView[g]) + '" title="点一下取消">' +
        esc(jzPillText(g, memView[g])) + '<span class="jz-pill-x" aria-hidden="true">×</span></button>');
    });
    var head = '<div class="jz-facet-head">' +
      '<button class="jz-facet-clear" type="button" data-act="jz-clear"' + (pills.length ? '' : ' disabled') + '>清除筛选</button>' +
      '<div class="jz-pills">' + pills.join('') + '</div></div>';

    var kindRows = MEM_KINDS.map(function (k) {
      return jzFacetRow('kind', k[0], k[1], kindCount[k[0]] || 0, memView.kind === k[0]);
    }).join('');

    var whoTop = (memView.whoAll ? named : named.slice(0, 12)).map(function (k) {
      return jzFacetRow('who', k, k, whoCount[k], memView.who === k);
    }).join('');
    if (whoCount.__none__) {
      whoTop += jzFacetRow('who', '__none__', '未记名字', whoCount.__none__, memView.who === '__none__');
    }
    var whoFoot = named.length > 12
      ? '<button class="jz-facet-more" type="button" data-act="jz-who-all" aria-expanded="' + (memView.whoAll ? 'true' : 'false') + '">' +
        (memView.whoAll ? '收起人物' : '全部人物（' + named.length + '）') + '</button>'
      : '';

    var bandRows =
      jzFacetRow('band', 'core', '核心 w≥8', bandCount.core, memView.band === 'core') +
      jzFacetRow('band', 'normal', '常规 w5–7', bandCount.normal, memView.band === 'normal') +
      jzFacetRow('band', 'edge', '边缘 w≤4', bandCount.edge, memView.band === 'edge');

    var timeRows =
      jzFacetRow('time', 'today', '今天', timeCount.today, memView.time === 'today') +
      jzFacetRow('time', 'week', '近 7 天', timeCount.week, memView.time === 'week') +
      jzFacetRow('time', 'month', '近 30 天', timeCount.month, memView.time === 'month') +
      jzFacetRow('time', 'older', '更早', timeCount.older, memView.time === 'older');

    return head +
      '<div class="jz-facet-group"><div class="jz-facet-title">类型</div>' + kindRows + '</div>' +
      '<div class="jz-facet-group"><div class="jz-facet-title">人物</div>' +
      '<div class="jz-facet-people' + (memView.whoAll ? ' is-all' : '') + '">' + whoTop + '</div>' + whoFoot + '</div>' +
      '<div class="jz-facet-group"><div class="jz-facet-title">权重</div>' + bandRows + '</div>' +
      '<div class="jz-facet-group"><div class="jz-facet-title">时间</div>' + timeRows + '</div>';
  }

  /* 命中高亮：只做前 2 处，返回已转义的 HTML */
  function jzHl(text) {
    var s = String(text === null || text === undefined ? '' : text);
    var toks = jzTokens();
    if (!toks.length) return esc(s);
    var lower = s.toLowerCase();
    var marks = [];
    for (var i = 0; i < toks.length && marks.length < 2; i++) {
      var tok = toks[i];
      if (!tok) continue;
      var idx = lower.indexOf(tok);
      if (idx < 0) continue;
      var end = idx + tok.length;
      var overlap = false;
      for (var j = 0; j < marks.length; j++) {
        if (idx < marks[j][1] && end > marks[j][0]) { overlap = true; break; }
      }
      if (!overlap) marks.push([idx, end]);
    }
    if (!marks.length) return esc(s);
    marks.sort(function (a, b) { return a[0] - b[0]; });
    var out = '', pos = 0;
    marks.forEach(function (m) {
      out += esc(s.slice(pos, m[0])) + '<mark>' + esc(s.slice(m[0], m[1])) + '</mark>';
      pos = m[1];
    });
    return out + esc(s.slice(pos));
  }

  function jzRowHtml(it) {
    var id = esc(it.id);
    var who = jzWho(it);
    var sel = memView.selId !== null && String(it.id) === String(memView.selId);
    return '<div class="jz-row' + (sel ? ' is-sel' : '') + '" data-id="' + id + '" role="option" ' +
      'aria-selected="' + (sel ? 'true' : 'false') + '" tabindex="-1">' +
      '<div class="jz-row-text">' + jzHl(it.text) + '</div>' +
      '<div class="jz-row-meta">' +
      '<span class="mono">' + esc(fmtStamp(it.at)) + '</span>' +
      '<span class="jz-sep">·</span><span>' + esc(memKindLabel(it.kind)) + '</span>' +
      (who ? '<span class="jz-sep">·</span><span class="jz-row-who">' + esc(who) + '</span>' : '') +
      '<span class="jz-sep">·</span><span class="mono">' + jzWLabel(it) + '</span>' +
      (isFinite(Number(it.hits)) && it.hits !== null && it.hits !== '' ? '<span class="jz-sep">·</span><span>命中 <b class="mono">' + num(it.hits, 0) + '</b></span>' : '') +
      '</div>' +
      '<span class="jz-row-ops">' +
      '<button class="btn btn-ghost btn-xs" type="button" data-act="mem-edit" data-id="' + id + '">改</button>' +
      '<button class="btn btn-ghost btn-xs btn-quiet-danger" type="button" data-act="mem-del" data-id="' + id + '">删</button>' +
      '</span></div>';
  }

  /* 兼容旧名字：外部没别处引用，留一个别名免得以后误改 */
  function memEntryHtml(it) { return jzRowHtml(it); }

  function jzEmptyHtml() {
    return '<div class="jz-empty">' + JZ_MARK +
      '<p>没有符合条件的记忆</p>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-act="jz-clear">清除筛选</button></div>';
  }

  function jzMoreState(list) {
    var wrap = $('#jzMoreWrap');
    var btn = $('#jzMore');
    list = list || memView.view || [];
    var left = list.length - memView.shown;
    if (wrap) wrap.hidden = !(left > 0);
    if (btn) btn.textContent = '加载更多（还有 ' + num(left, 0) + ' 条）';
  }

  function jzCountText(list) {
    var cnt = $('#jzCount');
    if (!cnt) return;
    var total = (state.memEntries || []).length;
    var shown = (list || []).length;
    /* 没筛选时两个数一样，说两遍是噪音（2026-11-05） */
    cnt.textContent = shown === total ? (num(total, 0) + ' 条') : (num(total, 0) + ' 条中 ' + num(shown, 0) + ' 条');
  }

  function jzAppend() {
    var box = $('#memGroups');
    var list = memView.view || [];
    if (!box || memView.shown >= list.length) { jzMoreState(list); return; }
    var from = memView.shown;
    var to = Math.min(list.length, from + JZ_BATCH);
    var html = '';
    for (var i = from; i < to; i++) html += jzRowHtml(list[i]);
    box.insertAdjacentHTML('beforeend', html);
    memView.shown = to;
    jzMoreState(list);
  }

  function jzScroller(el) {
    var p = el && el.parentNode;
    while (p && p !== document.body && p !== document.documentElement) {
      var oy = '';
      try { oy = window.getComputedStyle(p).overflowY; } catch (err) { oy = ''; }
      if (oy === 'auto' || oy === 'scroll') return p;
      p = p.parentNode;
    }
    return null;
  }

  /* 筛选变化后回到列表顶部：滚最近的可滚动祖先，不去动 window 的滚动条 */
  function jzListTop() {
    var list = $('.jz-list');
    if (!list) return;
    var sc = jzScroller(list);
    if (!sc) return;
    var top = list.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 8;
    sc.scrollTop = Math.max(0, top);
  }

  /* 工具栏日期框与 memView.day 对齐：值、最大可选（今天）、清空按钮显隐 */
  function jzSyncDate() {
    var el = $('#jzDate');
    if (!el) return;
    if (el.value !== (memView.day || '')) el.value = memView.day || '';
    el.max = jzTodayKey();
    el.classList.toggle('is-on', !!memView.day);
  }

  function jzPaintRows(reset) {
    var box = $('#memGroups');
    if (!box) return;
    var list = jzViewList();
    memView.view = list;
    if (reset) memView.shown = Math.min(JZ_BATCH, list.length);
    var html = '';
    for (var i = 0; i < memView.shown; i++) html += jzRowHtml(list[i]);
    setHtml(box, list.length ? html : jzEmptyHtml());
    jzCountText(list);
    jzMoreState(list);
    if (reset) {
      setHtml($('#jzFacets'), jzFacetsHtml());
      var sortEl = $('#jzSort');
      if (sortEl) sortEl.value = memView.sort;
      jzSyncDate();
    }
  }

  function jzSel() {
    if (memView.selId === null || !memView.index) return null;
    return memView.index[String(memView.selId)] || null;
  }

  function jzFindById(id) {
    if (!memView.index) return null;
    return memView.index[String(id)] || null;
  }

  function jzIndexOf(list, id) {
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return i;
    return -1;
  }

  function jzEdgeLabel(t) {
    var s = String((t && t.text) || '');
    return s.length > 24 ? s.slice(0, 24) + '…' : s;
  }

  function jzDetailInner(it) {
    if (!it) {
      return '<div class="jz-detail-empty">' + JZ_MARK + '<p>从左边挑一条记忆看详情</p></div>';
    }
    var who = jzWho(it);
    var qq = it.qq ? String(it.qq).trim() : '';
    var edges = Array.isArray(it.edges) ? it.edges : [];
    var edgeRows = edges.slice(0, 8).map(function (e) {
      var tid = e && e[0];
      var t = jzFindById(tid);
      return '<button class="jz-edge" type="button" data-act="jz-edge" data-id="' + esc(tid) + '">' +
        '<span class="jz-edge-kind">' + esc(t ? memKindLabel(t.kind) : '未知') + '</span>' +
        '<span class="jz-edge-text">' + esc(t ? jzEdgeLabel(t) : '已不在这批记忆里') + '</span></button>';
    }).join('');

    return '<div class="jz-detail-inner">' +
      '<div class="jz-detail-head">' +
      '<span class="jz-chip">' + esc(memKindLabel(it.kind)) + '</span>' +
      '<span class="jz-wpill mono">' + jzWLabel(it) + '</span>' +
      '<span class="jz-detail-ops">' +
      '<button class="btn btn-ghost btn-xs" type="button" data-act="mem-edit" data-id="' + esc(it.id) + '">改</button>' +
      '<button class="btn btn-ghost btn-xs btn-quiet-danger" type="button" data-act="mem-del" data-id="' + esc(it.id) + '">删</button>' +
      '<button class="jz-detail-close" type="button" data-act="jz-close" aria-label="关闭详情">×</button>' +
      '</span></div>' +
      '<div class="jz-detail-text">' + esc(it.text || '') + '</div>' +
      '<div class="jz-detail-kv">' +
      kv('人物', who ? esc(who) : '未记名字') +
      kv('QQ', qq ? '<span class="mono">' + esc(qq) + '</span>' : '—') +
      kv('来源', it.source ? esc(it.source) : '—') +
      kv('权重', (function () {
        var d = jzDecay(it);
        var txt = '<span class="mono">w' + jzFmtW(d.base) + '</span>';
        if (d.eff < d.base) txt += ' → <span class="mono">w' + jzFmtW(d.eff) + '</span>';
        txt += ' <span class="jz-kv-hint">空闲 ' + num(d.idle, 0) + ' 活跃天' +
          (isFinite(d.grace) ? ' · 宽限 ' + num(d.grace, 0) + ' 天' : '') + '</span>';
        return txt;
      })()) +
      kv('层级', (it.level === null || it.level === undefined || it.level === '') ? '—' : esc(it.level)) +
      kv('命中', (isFinite(Number(it.hits)) && it.hits !== null && it.hits !== '') ? ('<span class="mono">' + num(it.hits, 0) + '</span> 次') : '—') +
      kv('上次命中', esc(fmtStamp(it.lastHitAt))) +
      kv('记录时间', esc(fmtStamp(it.at))) +
      '</div>' +
      '<div class="jz-detail-sec">' +
      '<div class="jz-sec-title">关系 <span class="mono">' + num(edges.length, 0) + '</span></div>' +
      (edges.length ? '<div class="jz-edges">' + edgeRows + '</div>' : '<p class="jz-sec-empty">没有关系记录</p>') +
      '</div>' +
      '<div class="jz-detail-sec jz-quick">' +
      '<button class="btn btn-ghost btn-sm" type="button" data-act="jz-only-who"' + (who ? '' : ' disabled') + '>只看这个人</button>' +
      '<button class="btn btn-ghost btn-sm" type="button" data-act="jz-only-kind">只看这个类型</button>' +
      '</div></div>';
  }

  function jzPaintDetail() {
    var box = $('#jzDetail');
    if (!box) return;
    setHtml(box, jzDetailInner(jzSel()));
  }

  function jzPaintRowsSelection() {
    $$('#memGroups .jz-row').forEach(function (row) {
      var on = memView.selId !== null && String(row.getAttribute('data-id')) === String(memView.selId);
      row.classList.toggle('is-sel', on);
      row.setAttribute('aria-selected', on ? 'true' : 'false');
    });
  }

  function jzRowById(id) {
    var rows = $$('#memGroups .jz-row');
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].getAttribute('data-id')) === String(id)) return rows[i];
    }
    return null;
  }

  // 抽屉是 fixed 的，但顶栏（玻璃层，z-index 20）画在它上面，顶栏高度又随宽度换行变化，
  // 所以打开时按实测的顶栏底边给抽屉定位；回到宽屏再清掉，交还给 CSS 的三栏 sticky。
  function jzSyncDrawerBox(d) {
    if (!d) return;
    if (jzWide()) { d.style.top = ''; d.style.height = ''; return; }
    var bar = document.querySelector('.topbar');
    /* 顶栏在窄屏会换行成多行，高度只能实测；抽屉从它下面展开，避免被玻璃层压住 */
    var bottom = bar ? Math.max(0, Math.round(bar.getBoundingClientRect().bottom)) : 0;
    d.style.top = bottom + 'px';
    d.style.height = 'calc(100vh - ' + bottom + 'px)';
    d.style.height = 'calc(100dvh - ' + bottom + 'px)';
  }

  function jzOpenDetail() {
    var d = $('#jzDetail');
    var scrim = $('#jzScrim');
    if (!d || jzWide()) { if (scrim) scrim.hidden = true; return; }
    jzSyncDrawerBox(d);
    d.classList.add('is-open');
    if (scrim) scrim.hidden = false;
  }

  function jzCloseDrawer() {
    var d = $('#jzDetail');
    var scrim = $('#jzScrim');
    if (d) d.classList.remove('is-open');
    if (scrim) scrim.hidden = true;
  }

  function jzSelectRow(id, open) {
    memView.selId = (id === null || id === undefined) ? null : String(id);
    jzPaintRowsSelection();
    jzPaintDetail();
    if (open !== false) jzOpenDetail();
  }

  function jzSyncSearch() {
    var input = $('#memSearch');
    if (input) input.value = memView.q;
  }

  function jzClear(silent) {
    memView.kind = '';
    memView.who = '';
    memView.band = '';
    memView.time = '';
    memView.day = '';
    memView.q = '';
    memView.whoAll = false;
    jzSyncSearch();
    jzApply();
    if (!silent) toast('已清除筛选');
  }

  function jzApply() {
    memView.shown = JZ_BATCH;
    memView.view = null;
    jzScrollListTopSafe();
    jzPaintRows(true);
  }

  function jzScrollListTopSafe() {
    try { jzListTop(); } catch (err) { /* 滚动失败不影响渲染 */ }
  }

  function jzOnlyWho() {
    var it = jzSel();
    if (!it) return;
    var who = jzWho(it);
    if (!who) { toast('这条记忆没有记名字'); return; }
    memView.kind = ''; memView.band = ''; memView.time = ''; memView.who = who;
    memView.q = ''; memView.whoAll = false;
    jzSyncSearch();
    jzApply();
    if (!(memView.view || []).length) toast('没有别的记忆属于这个人');
  }

  function jzOnlyKind() {
    var it = jzSel();
    if (!it) return;
    memView.who = ''; memView.band = ''; memView.time = '';
    memView.kind = String(it.kind || '');
    memView.q = '';
    jzSyncSearch();
    jzApply();
  }

  function jzOpenEdge(id) {
    var target = jzFindById(id);
    if (!target) { toast('这条不在这批记忆里'); return; }
    var list = memView.view || [];
    var idx = jzIndexOf(list, id);
    if (idx < 0) {
      toast('这条不在当前筛选内，已清除筛选后定位');
      memView.kind = ''; memView.who = ''; memView.band = ''; memView.time = ''; memView.q = '';
      jzSyncSearch();
      jzApply();
      list = memView.view || [];
      idx = jzIndexOf(list, id);
    }
    if (idx < 0) return;
    while (memView.shown <= idx) jzAppend();
    jzSelectRow(id);
    var row = jzRowById(id);
    if (row) { try { row.scrollIntoView({ block: 'nearest' }); } catch (err) { /* 老引擎没有 options */ } }
  }

  /* 可写视图：三栏（索引 / 结果 / 详情）。 */
  function renderMemoryEntries() {
    var box = $('#memGroups');
    var sub = $('#memSub');
    if (!box || !sub) return;
    var entries = state.memEntries || [];

    var index = {};
    for (var i = 0; i < entries.length; i++) {
      if (entries[i]) index[String(entries[i].id)] = entries[i];
    }
    memView.index = index;
    jzSyncSearch();

    var st = jzStats();
    sub.textContent = 'Jasmine · ' + num(st.n, 0) + ' 条' + (st.latest ? ' · 最近更新 ' + fmtStamp(st.latest) : '');

    if (!entries.length) {
      setHtml($('#jzHero'), '');
      setHtml($('#jzFacets'), '');
      setHtml(box, emptyHtml('还没有记忆条目，点右上角「+ 记一条」写一条。'));
      setHtml($('#jzDetail'), '');
      jzCountText([]);
      jzMoreState([]);
      return;
    }

    setHtml($('#jzHero'), jzHeroHtml(st));
    var list = jzViewList();
    memView.view = list;
    memView.shown = Math.min(JZ_BATCH, list.length);
    var html = '';
    for (var j = 0; j < memView.shown; j++) html += jzRowHtml(list[j]);
    setHtml(box, list.length ? html : jzEmptyHtml());
    setHtml($('#jzFacets'), jzFacetsHtml());
    jzCountText(list);
    jzMoreState(list);
    var sortEl = $('#jzSort');
    if (sortEl) sortEl.value = memView.sort;
    jzSyncDate();
    jzPaintDetail();
    if (!jzWide()) jzCloseDrawer();
  }

  /* 加载态：6 条骨架，prefers-reduced-motion 下不动（见 CSS） */
  function memSkeleton() {
    var box = $('#memGroups');
    if (!box) return;
    var rows = '';
    for (var i = 0; i < 6; i++) {
      rows += '<div class="jz-row is-skeleton" aria-hidden="true">' +
        '<span class="jz-sk jz-sk-a"></span><span class="jz-sk jz-sk-b"></span></div>';
    }
    setHtml(box, '<div class="jz-skeleton">' + rows + '</div>');
    var hero = $('#jzHero');
    if (hero && !hero.innerHTML) setHtml(hero, '<div class="jz-hero-inner is-skeleton"><span class="jz-sk jz-sk-c"></span></div>');
  }

  /* 搜索 / 筛选的统一入口：写接口视图走内存过滤，只读降级走旧的 DOM 过滤 */
  function applyMemFilter() {
    if (state.memCrudReady === true) {
      var search = $('#memSearch');
      var q = search ? String(search.value || '') : '';
      if (q !== memView.q) {
        memView.q = q;
        jzApply();
      }
      return;
    }
    var input = $('#memSearch');
    if (!input) return;
    var query = (input.value || '').trim().toLowerCase();
    $$('#memGroups .mem-group').forEach(function (group) {
      var items = $$('.mem-item', group);
      var visible = 0;
      items.forEach(function (item) {
        var hit = !query || (item.getAttribute('data-search') || '').indexOf(query) >= 0;
        item.hidden = !hit;
        if (hit) visible++;
      });
      group.hidden = visible === 0;
      if (query && visible > 0) group.open = true;
      var cnt = $('.mem-count', group);
      if (cnt) cnt.textContent = visible + ' 条';
    });
  }

  /* 列表面板上的点击：筛选 / 选中 / 详情里的动作。行内「改 / 删」仍由 #memGroups 的旧委托处理。 */
  function onMemClick(ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var btn = t.closest('[data-act]');
    if (btn) {
      var act = btn.getAttribute('data-act');
      if (act === 'mem-edit' || act === 'mem-del') {
        /* 结果行交给 #memGroups 的委托，避免重复打开弹层 */
        if (!btn.closest('#jzDetail')) return;
        if (act === 'mem-edit') memEditExisting(btn.getAttribute('data-id'));
        else memDeleteExisting(btn.getAttribute('data-id'));
        return;
      }
      if (act === 'jz-facet') {
        var group = btn.getAttribute('data-group');
        var value = btn.getAttribute('data-value');
        if (!group) return;
        memView[group] = (String(memView[group]) === String(value)) ? '' : value;
        if (group === 'time' && memView.time) memView.day = '';
        if (group === 'day' && memView.day) memView.time = '';
        jzApply();
        return;
      }
      if (act === 'jz-clear') { jzClear(); return; }
      if (act === 'jz-who-all') { memView.whoAll = !memView.whoAll; setHtml($('#jzFacets'), jzFacetsHtml()); return; }
      if (act === 'jz-close') { jzCloseDrawer(); return; }
      if (act === 'jz-edge') { jzOpenEdge(btn.getAttribute('data-id')); return; }
      if (act === 'jz-only-who') { jzOnlyWho(); return; }
      if (act === 'jz-only-kind') { jzOnlyKind(); return; }
      return;
    }
    var row = t.closest('.jz-row');
    if (row) jzSelectRow(row.getAttribute('data-id'));
  }

  /* 键盘：↑/↓ 移选中（只 scrollIntoView nearest），Enter 开详情，Esc 清搜索。
     绑定在 document 上（行不抢焦点），所以要先确认当前页就是记忆页、焦点不在输入框。 */
  function onMemKey(ev) {
    if (state.page !== 'memory' || !ev) return;
    if (ev.defaultPrevented) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    var key = ev.key;
    var el = document.activeElement;
    var inField = !!(el && el.tagName && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
    if (inField && el.id !== 'memSearch') return;
    if (key === 'Escape') {
      if (memView.q) {
        memView.q = '';
        jzSyncSearch();
        jzApply();
        if (ev.preventDefault) ev.preventDefault();
      } else {
        jzCloseDrawer();
      }
      return;
    }
    if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Enter') return;
    var list = memView.view || [];
    if (!list.length) return;
    if (key === 'Enter') {
      if (memView.selId !== null) {
        jzPaintDetail();
        jzOpenDetail();
        if (ev.preventDefault) ev.preventDefault();
      }
      return;
    }
    /* 输入框里按上下键是移动光标，不抢 */
    if (inField) return;
    if (ev.preventDefault) ev.preventDefault();
    var idx = jzIndexOf(list, memView.selId);
    var next = key === 'ArrowDown'
      ? (idx < 0 ? 0 : Math.min(list.length - 1, idx + 1))
      : (idx < 0 ? 0 : Math.max(0, idx - 1));
    if (next < 0) return;
    while (memView.shown <= next) jzAppend();
    var it = list[next];
    jzSelectRow(it.id);
    var row = jzRowById(it.id);
    if (row) { try { row.scrollIntoView({ block: 'nearest' }); } catch (err) { /* 忽略 */ } }
  }

  /* 滚动到距底部 240px 时自动追加下一批（按钮兜底） */
  function jzMaybeAppend() {
    if (state.page !== 'memory') return;
    var box = $('#memGroups');
    var list = memView.view || [];
    if (!box || !list.length || memView.shown >= list.length) return;
    var r = box.getBoundingClientRect();
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (r.bottom - vh < 240) jzAppend();
  }

  /* ---------------- 待核实（被拦下来、等着人过目的记忆） ---------------- */

  /* 相对时间用 createdAt（入队时刻），不是 at（记忆本来的时间）：
     用户关心的是「这东西什么时候冒出来的」。 */
  function relTime(ms) {
    var t = Number(ms);
    if (!isFinite(t) || t <= 0) return '—';
    var diff = Date.now() - t;
    if (diff < 0) diff = 0;
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return mins + ' 分钟前';
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + ' 小时前';
    var days = Math.floor(hours / 24);
    if (days < 30) return days + ' 天前';
    return new Date(t).toLocaleDateString('zh-CN');
  }

  function pendReasonLabel(reason) {
    for (var i = 0; i < PEND_REASONS.length; i++) {
      if (PEND_REASONS[i][0] === reason) return PEND_REASONS[i][1];
    }
    /* 后端以后加了新原因，前端不至于显示空白：原样给出去 */
    return reason ? String(reason) : '未知原因';
  }

  function pendTimeTitle(it) {
    var t = Number(it.createdAt || it.at);
    if (!isFinite(t) || t <= 0) return '';
    try { return new Date(t).toLocaleString('zh-CN'); } catch (err) { return ''; }
  }

  /* 只更新统计数字 / 导航气泡 / 空态 / 按钮可用性，不重建列表：
     15 秒轮询时重建列表会把用户正在点的按钮换掉。 */
  function renderPendingMeta() {
    var stat = $('#pendStat');
    var empty = $('#pendEmpty');
    var list = $('#pendList');
    var rejectAll = $('#pendRejectAll');
    var hint = $('#pendHint');
    var items = state.pendingItems || [];
    var ready = state.pendingReady === true;

    if (stat) stat.textContent = '待核实 ' + (ready ? items.length : '—') + ' 条';
    if (empty) empty.hidden = !(ready && items.length === 0);
    if (list) list.hidden = !ready || items.length === 0;
    if (rejectAll) rejectAll.disabled = !ready || items.length === 0 || state.pendingBusy;
    if (hint) {
      hint.hidden = !state.pendingHint;
      hint.textContent = state.pendingHint ? '待核实数量有变化，点「刷新」看最新列表' : '';
    }

    var badge = $('#pendBadge');
    if (badge) {
      var n = ready ? items.length : state.pendingCount;
      badge.textContent = String(n);
      badge.hidden = !(n > 0);
    }
  }

  function renderPending() {
    var box = $('#pendList');
    var notice = $('#pendNotice');
    if (!box || !notice) return;

    var items = state.pendingItems;

    /* 接口没上线 / 读失败：给出能看懂的一句话 + 重试，而不是白屏 */
    if (state.pendingReady === false) {
      notice.hidden = false;
      notice.innerHTML = '<b>服务端还没上线这个功能（memory/pending）</b>' +
        '<div class="notice-soft">' + esc(state.pendingError || '接口不可用') + '</div>' +
        '<button class="btn btn-ghost btn-sm" type="button" id="pendRetry">重试</button>';
      var retry = $('#pendRetry');
      if (retry) retry.addEventListener('click', function () { loadPending(true); });
      setHtml(box, '');
      box.hidden = true;
      var emptyOff = $('#pendEmpty');
      if (emptyOff) emptyOff.hidden = true;
      renderPendingMeta();
      return;
    }

    notice.hidden = true;

    if (!items) { renderPendingMeta(); return; }

    if (!items.length) {
      setHtml(box, '');
      renderPendingMeta();
      return;
    }

    setHtml(box, items.map(pendItemHtml).join(''));
    renderPendingMeta();
  }

  function pendItemHtml(it) {
    var qq = it.qq ? String(it.qq).trim() : '';
    var reasonRaw = it.reason ? String(it.reason) : '';
    var isInsult = reasonRaw === 'insult';
    var whoHtml = it.who
      ? '<span class="mem-who">' + esc(it.who) + '</span>'
      : '<span class="mem-who is-unknown">不知道是谁</span>';
    return '<div class="pend-item" data-id="' + esc(it.id) + '">' +
      '<div class="pend-main">' +
      '<div class="pend-top">' +
      '<span class="mem-tag">' + esc(memKindLabel(it.kind)) + '</span>' +
      '<span class="pend-reason' + (isInsult ? ' is-insult' : '') + '" title="入队原因">' +
      esc(pendReasonLabel(reasonRaw)) + '</span>' +
      whoHtml +
      '<span class="mem-qq' + (qq ? '' : ' is-empty') + '">' + (qq ? 'QQ ' + esc(qq) : 'QQ 未记录') + '</span>' +
      '<span class="pend-when" title="' + esc(pendTimeTitle(it)) + '">' + esc(relTime(it.createdAt || it.at)) + '</span>' +
      '</div>' +
      '<div class="pend-text">' + esc(it.text) + '</div>' +
      '</div>' +
      '<div class="pend-ops">' +
      '<button class="btn btn-approve btn-sm" type="button" data-act="pend-approve" data-id="' + esc(it.id) + '">通过</button>' +
      '<button class="btn btn-danger btn-sm" type="button" data-act="pend-reject" data-id="' + esc(it.id) + '">丢弃</button>' +
      '</div>' +
      '</div>';
  }

  function showPendError(msg) {
    var box = $('#pendError');
    if (!box) return;
    if (!msg) { box.hidden = true; box.textContent = ''; return; }
    box.hidden = false;
    box.textContent = String(msg);
  }

  /* 拉列表。force=false 时已经拉过就不动，避免切页签反复重绘。 */
  function loadPending(force) {
    if (state.pendingBusy) return;
    if (state.pendingItems && !force) return;
    showPendError('');

    apiPost('memory/pending', {}).then(function (res) {
      if (!res || !res.ok) {
        state.pendingReady = false;
        state.pendingItems = null;
        state.pendingError = (res && res.error) || ('HTTP ' + (res && res.__http));
        safe(renderPending);
        return;
      }
      /* 契约：console-server 包一层 {ok,action,data}，条目在 data.items */
      var data = (res.data && Array.isArray(res.data.items)) ? res.data : null;
      if (!data) {
        state.pendingReady = false;
        state.pendingItems = null;
        state.pendingError = 'memory/pending 返回格式不对（没找到 data.items）';
        safe(renderPending);
        return;
      }
      state.pendingItems = data.items;
      state.pendingCount = typeof data.count === 'number' ? data.count : data.items.length;
      state.pendingReady = true;
      state.pendingError = null;
      state.pendingHint = false;
      safe(renderPending);
    });
  }

  /* 15 秒轻量轮询：只取数量。列表结构变了也不重绘，只提示用户点刷新。 */
  function pollPending() {
    if (state.pendingBusy) return;   /* 操作中：别拿旧数据盖掉正在变化的行 */
    apiPost('memory/pending', {}).then(function (res) {
      if (!res || !res.ok || !res.data || !Array.isArray(res.data.items)) {
        if (state.pendingItems === null && state.pendingReady !== false) {
          state.pendingReady = false;
          state.pendingError = (res && res.error) || ('HTTP ' + (res && res.__http));
          safe(renderPending);
        }
        return;
      }
      var items = res.data.items;
      state.pendingCount = typeof res.data.count === 'number' ? res.data.count : items.length;
      state.pendingReady = true;

      if (state.pendingItems === null) {
        /* 还没打开过这个页签：顺手把列表备好，打开就不闪 */
        state.pendingItems = items;
        state.pendingHint = false;
        safe(renderPending);
        return;
      }

      var oldIds = state.pendingItems.map(function (x) { return String(x.id); }).join(',');
      var newIds = items.map(function (x) { return String(x.id); }).join(',');
      if (oldIds !== newIds) {
        state.pendingHint = true;
        safe(renderPendingMeta);
      } else {
        state.pendingHint = false;
        safe(renderPendingMeta);
      }
    });
  }

  function removePendingRow(id) {
    var sid = String(id);
    state.pendingItems = (state.pendingItems || []).filter(function (x) { return String(x.id) !== sid; });
    state.pendingCount = state.pendingItems.length;
    state.pendingHint = false;
    var row = null;
    $$('#pendList .pend-item').forEach(function (el) {
      if (!row && el.getAttribute('data-id') === sid) row = el;
    });
    if (row && row.parentNode) row.parentNode.removeChild(row);
    renderPendingMeta();
    safe(renderPending);
  }

  function pendAction(actionId, it) {
    state.pendingBusy = true;
    return apiPost(actionId, { id: String(it.id), confirm: true }).then(function (res) {
      state.pendingBusy = false;
      return res;
    }, function (err) {
      state.pendingBusy = false;
      return { ok: false, error: err && err.message ? err.message : String(err) };
    });
  }

  /* 通过 / 丢弃都先弹确认：通过=进正式记忆，丢弃=不可恢复 */
  function openPendConfirm(approve, it) {
    var actionId = approve ? 'memory/pending/approve' : 'memory/pending/reject';
    openCrud({
      mode: 'confirm',
      title: approve ? '通过这条记忆？' : '丢弃这条记忆？',
      body: '<p class="crud-hint-line">' + esc(memKindLabel(it.kind)) +
        (it.who ? ' · ' + esc(it.who) : ' · 不知道是谁') +
        ' · ' + esc(pendReasonLabel(it.reason)) + '</p>' +
        '<p class="crud-quote">' + esc(it.text) + '</p>' +
        '<p class="crud-hint-line">' + (approve
          ? '通过后它会进入正式记忆，之后可以在「记忆」页修改。'
          : '丢弃后不会进入记忆，也不能恢复。') + '</p>',
      okText: approve ? '通过' : '丢弃',
      danger: !approve,
      onOk: function () {
        return pendAction(actionId, it).then(function (res) {
          if (!res || !res.ok) throw new Error((res && res.error) || ('HTTP ' + (res && res.__http)));
          removePendingRow(it.id);
          showPendError('');
          toast(approve ? '已通过，进入记忆' : '已丢弃');
        });
      }
    });
  }

  /* 服务端没有批量接口，这里就真的一条一条 reject；失败不藏着，原样列出来 */
  function rejectAllPending() {
    var items = (state.pendingItems || []).slice();
    if (!items.length) return;
    openCrud({
      mode: 'confirm',
      title: '全部丢弃 ' + items.length + ' 条？',
      body: '<p class="crud-hint-line">服务端暂时没有批量接口，会逐条丢弃，共 ' + items.length + ' 次请求。</p>' +
        '<p class="crud-hint-line">丢弃后不会进入记忆，也不能恢复。</p>',
      okText: '全部丢弃',
      danger: true,
      onOk: function () {
        state.pendingBusy = true;
        var failed = [];
        var seq = Promise.resolve();
        items.forEach(function (it) {
          seq = seq.then(function () {
            return apiPost('memory/pending/reject', { id: String(it.id), confirm: true }).then(function (res) {
              if (res && res.ok) removePendingRow(it.id);
              else failed.push({ id: it.id, error: (res && res.error) || ('HTTP ' + (res && res.__http)) });
            });
          });
        });
        return seq.then(function () {
          state.pendingBusy = false;
          safe(renderPending);
          if (failed.length) {
            showPendError('有 ' + failed.length + ' 条没丢掉：' + failed[0].error +
              '（其它 ' + (items.length - failed.length) + ' 条已丢弃，剩下的可以再点一次）');
            toast('有 ' + failed.length + ' 条没丢掉');
            return;
          }
          showPendError('');
          toast('已丢弃 ' + items.length + ' 条');
        });
      }
    });
  }

  /* ---------------- 表情包 ---------------- */

  function stickerUrl(it) {
    var f = it && (it.file || it.name);
    if (!f) return '';
    return '/api/sticker/' + encodeURIComponent(f);
  }

  /* 表情包搜索（2026-10-25 主人要求「表情包做一个搜索功能」）：
     数据源 /api/stickers 的 item 只有 name/file（关键词就是文件名用 _ 分隔），
     插件侧另有 keywords 数组；两条路径都兼容。把 _ 换成空格，
     这样「白猫 偷笑」能命中「白猫_眯眼_偷笑_坏笑」。 */
  function stkSearchText(it) {
    var parts = [it && it.name, it && it.file];
    if (it && Array.isArray(it.keywords)) parts = parts.concat(it.keywords);
    return String(parts.filter(Boolean).join(' ')).replace(/_/g, ' ').toLowerCase();
  }

  function stkTokens(q) {
    return String(q || '').trim().toLowerCase().split(/[\s,，]+/).filter(Boolean);
  }

  /* 多词 = AND：每个词都要出现在名字 / 文件名 / 关键词任一里 */
  function stickerHit(it, tokens) {
    if (!tokens || !tokens.length) return true;
    var hay = stkSearchText(it);
    for (var i = 0; i < tokens.length; i++) {
      if (hay.indexOf(tokens[i]) < 0) return false;
    }
    return true;
  }

  function loadStickers(force) {
    if (state.stickers && !force) return;
    if (!state.stickers) {
      var sub = $('#stkSub');
      if (sub) sub.textContent = '正在读取…';
    }
    fetch('/api/stickers', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        if (!j || j.ok === false) throw new Error((j && j.error) || '接口返回失败');
        state.stickers = j;
        state.stickerError = null;
        safe(renderStickers);
      })
      .catch(function (err) {
        state.stickerError = err && err.message ? err.message : String(err);
        safe(renderStickers);
      });
  }

  function renderStickers() {
    var grid = $('#stkGrid');
    var empty = $('#stkEmpty');
    var sub = $('#stkSub');
    if (!grid || !empty || !sub) return;

    if (state.stickerError) {
      sub.textContent = '读取失败';
      setHtml(grid, '');
      empty.hidden = false;
      setHtml(empty, emptyHtml('表情包读取失败：' + esc(state.stickerError), '重试'));
      bindRetry(empty, function () { loadStickers(true); });
      return;
    }
    if (!state.stickers) {
      sub.textContent = '正在读取…';
      setHtml(grid, '');
      empty.hidden = true;
      return;
    }

    var data = state.stickers;
    var stk = data.stickers || data;
    var items = Array.isArray(stk.items) ? stk.items : [];

    var q = String(state.stkQuery || '').trim();
    var tokens = stkTokens(q);
    var shown = tokens.length
      ? items.filter(function (it) { return stickerHit(it, tokens); })
      : items;

    sub.textContent = tokens.length
      ? '「' + q + '」命中 ' + shown.length + ' / 共 ' + num(stk.count, 0) + ' 张'
      : '共 ' + num(stk.count, 0) + ' 张 · 点击看大图';

    if (!items.length) {
      setHtml(grid, '');
      empty.hidden = false;
      setHtml(empty, emptyHtml('还没有学到的表情。'));
      return;
    }

    if (!shown.length) {
      /* 搜不到时给一键清空，免得看起来像表情包丢了 */
      setHtml(grid, '');
      empty.hidden = false;
      setHtml(empty, emptyHtml('没有匹配「' + esc(q) + '」的表情包。', '清空搜索'));
      bindRetry(empty, function () {
        var box = $('#stkSearch');
        if (box) box.value = '';
        state.stkQuery = '';
        safe(renderStickers);
      });
      return;
    }

    empty.hidden = true;
    setHtml(grid, shown.map(function (it) {
      var url = stickerUrl(it);
      var file = it.file || it.name || '';
      /* 卡片外壳拆成两层：外层放操作条，内层 button 继续负责「点开大图」。
         button 里不能再嵌 button，所以「改关键词 / 删」必须放在它外面。 */
      return '<div class="sticker-cell">' +
        '<button class="sticker" type="button" data-url="' + esc(url) + '" data-name="' + esc(it.name) + '">' +
        '<img loading="lazy" alt="' + esc(it.name) + '" src="' + esc(url) + '">' +
        '<span class="sticker-name">' + esc(it.name) + '</span>' +
        '</button>' +
        '<div class="stk-ops">' +
        '<button class="btn btn-ghost btn-xs" type="button" data-act="stk-edit" data-file="' + esc(file) + '">改关键词</button>' +
        '<button class="btn btn-ghost btn-xs btn-quiet-danger" type="button" data-act="stk-del" data-file="' + esc(file) + '">删</button>' +
        '</div></div>';
    }).join(''));
  }

  function openSticker(url, name) {
    var modal = $('#stkModal');
    var img = $('#stkModalImg');
    var label = $('#stkModalName');
    if (!modal || !img || !label) return;
    img.src = url;
    label.textContent = name || '';
    modal.hidden = false;
  }

  function closeSticker() {
    var modal = $('#stkModal');
    var img = $('#stkModalImg');
    if (modal) modal.hidden = true;
    if (img) img.removeAttribute('src');
  }

  /* ---------------- 记忆 CRUD ---------------- */

  function findMemEntry(id) {
    var list = state.memEntries || [];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === String(id)) return list[i];
    }
    return null;
  }

  function memoryFormBody(it) {
    it = it || {};
    var kind = it.kind || 'fact';
    var options = MEM_KINDS.map(function (k) {
      return '<option value="' + k[0] + '"' + (k[0] === kind ? ' selected' : '') + '>' +
        k[1] + '（' + k[0] + '）</option>';
    }).join('');
    /* 权重刻度 1–10（2026-10-27 主人：5 → 10，老数据 ×2，一位小数）。默认 6 = 旧默认 3 的等比。 */
    var weight = it.weight === undefined || it.weight === null ? 6 : it.weight;
    return '' +
      '<div class="field"><label class="field-label" for="cmKind">类型</label>' +
      '<select class="input" id="cmKind">' + options + '</select></div>' +
      '<div class="field"><label class="field-label" for="cmWho">谁（可空）</label>' +
      '<input class="input" id="cmWho" type="text" maxlength="40" placeholder="例如：主人 / 全体" value="' + esc(it.who || '') + '"></div>' +
      /* qq 单独一列：名字可能重名，QQ 号才是稳定身份；老数据没有这字段，一律当空处理 */
      '<div class="field"><label class="field-label" for="cmQQ">QQ 号（可空）</label>' +
      '<input class="input mono" id="cmQQ" type="text" inputmode="numeric" autocomplete="off" maxlength="12" placeholder="例如：123456789" value="' + esc(it.qq || '') + '">' +
      '<div class="field-hint">留空表示只记名字；填了就按 QQ 号也能搜到。</div></div>' +
      '<div class="field"><label class="field-label" for="cmText">正文' +
      '<span class="crud-counter mono" id="cmCount">0/200</span></label>' +
      '<textarea class="input textarea" id="cmText" rows="4" placeholder="一句话说清楚，Molly 之后会按权重取用">' + esc(it.text || '') + '</textarea></div>' +
      '<div class="field"><label class="field-label" for="cmWeight">权重（1–10，一位小数，越高越常被想起）</label>' +
      '<input class="input" id="cmWeight" type="number" min="1" max="10" step="0.1" value="' + esc(String(weight)) + '"></div>';
  }

  function bindMemoryCounter() {
    var ta = $('#cmText');
    var out = $('#cmCount');
    if (!ta || !out) return;
    var update = function () {
      /* 与保存时的校验同一口径：码点数，🐟 算 1 个字 */
      var n = Array.from(ta.value).length;
      out.textContent = n + '/200';
      out.classList.toggle('is-bad', n > 200);
    };
    ta.addEventListener('input', update);
    update();
    ta.focus();
  }

  function memAddNew() {
    openCrud({
      mode: 'mem-add',
      title: '记一条新记忆',
      body: memoryFormBody(null),
      hint: '会立刻写回 memory.json 与 memory.md',
      okText: '保存',
      afterOpen: bindMemoryCounter,
      onOk: function () { return saveMemoryEntry(null); }
    });
  }

  function memEditExisting(id) {
    var it = findMemEntry(id);
    if (!it) { toast('这条记忆已经不在了，先点「重新加载」'); return; }
    openCrud({
      mode: 'mem-edit',
      item: it,
      title: '改这条记忆',
      body: memoryFormBody(it),
      hint: '记下的时间不会变，只改内容',
      okText: '保存',
      afterOpen: bindMemoryCounter,
      onOk: function () { return saveMemoryEntry(it); }
    });
  }

  function saveMemoryEntry(it) {
    var textEl = $('#cmText');
    var whoEl = $('#cmWho');
    var qqEl = $('#cmQQ');
    var kindEl = $('#cmKind');
    var weightEl = $('#cmWeight');
    var text = (textEl && textEl.value || '').trim();
    var who = (whoEl && whoEl.value || '').trim();
    var qq = (qqEl && qqEl.value || '').trim();
    var kind = kindEl && kindEl.value ? kindEl.value : 'fact';
    var weight = Number(weightEl && weightEl.value);

    /* 前端先拦：这些提示比服务端 400 更早、更具体。服务端仍会再校验一次。 */
    /* 字数按码点数算：String.length 是 UTF-16 码元，一个 emoji 会算成 2，
       插件与代理层都用码点，前端先拦时口径必须一致。 */
    if (!text) throw new Error('正文不能为空');
    var clen = Array.from(text).length;
    if (clen > 200) throw new Error('正文最多 200 字，现在 ' + clen + ' 字');
    if (MEM_KINDS.every(function (k) { return k[0] !== kind; })) throw new Error('类型不合法：' + kind);
    /* 权重：1–10，最多一位小数（与服务端 parseWeight 同一口径） */
    if (!isFinite(weight) || weight < 1 || weight > 10 || Math.abs(Math.round(weight * 10) - weight * 10) > 1e-9) {
      throw new Error('权重必须是 1–10 的数字，最多一位小数');
    }
    weight = Math.round(weight * 10) / 10;
    /* QQ 号可空；非空必须是 5–12 位、不以 0 开头的数字（QQ 号没有前导 0） */
    if (qq && !/^[1-9]\d{4,11}$/.test(qq)) {
      throw new Error('QQ 号要 5–12 位数字且不以 0 开头，现在是「' + qq + '」');
    }

    var body = { kind: kind, who: who, qq: qq, text: text, weight: weight };
    if (it) body.id = it.id;
    var action = it ? 'memory/update' : 'memory/add';

    return apiPost(action, body).then(function (res) {
      if (!res.ok) throw new Error(res.error || ('HTTP ' + res.__http));

      if (it) {
        toast('记忆已更新');
      } else {
        /* MemoryStore 会按相似度判重：太像的话不新建，而是并入旧条目，条数不变。
           条数没变 ≠ 失败，所以只看服务端给的 merged 标记，别用条数推断成败。 */
        var data = (res && res.data && typeof res.data === 'object') ? res.data : res;
        var merged = !!(data && data.merged === true);
        toast(merged ? '内容相近，已合并到已有条目（没有新增）' : '已记下');
      }

      /* 只重拉列表，不整页 reload；弹层由 submitCrud 在 promise 成功后关掉 */
      loadMemory(true);
      return res;
    });
  }

  function memDeleteExisting(id) {
    var it = findMemEntry(id);
    if (!it) { toast('这条记忆已经不在了，先点「重新加载」'); return; }
    openCrud({
      mode: 'mem-del',
      item: it,
      title: '删掉这条记忆？',
      body: '<p class="crud-warn">删掉后不可恢复。</p>' +
        '<p class="crud-quote">' + esc(it.text || '') + '</p>' +
        '<p class="crud-hint-line">类型：' + esc(memKindLabel(it.kind)) +
        (it.who ? ' · ' + esc(it.who) : '') +
        ' · ' + (it.qq ? 'QQ ' + esc(it.qq) : 'QQ 未记录') + '</p>',
      okText: '删除',
      danger: true,
      onOk: function () {
        return apiPost('memory/delete', { id: it.id, confirm: true }).then(function (res) {
          if (!res.ok) throw new Error(res.error || ('HTTP ' + res.__http));
          toast('已删掉 1 条记忆');
          loadMemory(true);
          return res;
        });
      }
    });
  }

  /* ---------------- 表情包 CRUD ---------------- */

  function findSticker(file) {
    var raw = state.stickers;
    var stk = raw && (raw.stickers || raw);
    var items = stk && Array.isArray(stk.items) ? stk.items : [];
    for (var i = 0; i < items.length; i++) {
      if (String(items[i].file || items[i].name) === String(file)) return items[i];
    }
    return null;
  }

  /* 关键词就编码在文件名里：动漫少女_震惊.jpg -> ["动漫少女","震惊"] */
  function stickerKeywords(it) {
    if (it && Array.isArray(it.keywords)) {
      return it.keywords.map(String).filter(Boolean);
    }
    return String((it && it.name) || '').split('_').filter(Boolean);
  }

  function chipsFieldHtml(hint) {
    return '<div class="field"><label class="field-label">关键词</label>' +
      '<div class="chips" id="csChips"></div>' +
      '<div class="chip-add">' +
      '<input class="input" id="csKw" type="text" placeholder="输入关键词，回车 / 逗号 / 空格加入" autocomplete="off" spellcheck="false">' +
      '<button class="btn btn-ghost btn-sm" id="csKwAdd" type="button">加入</button>' +
      '</div>' +
      '<p class="field-hint">' + esc(hint) + '</p></div>';
  }

  function bindChips() {
    var box = $('#csChips');
    var input = $('#csKw');
    var addBtn = $('#csKwAdd');
    if (!box) return;

    var paint = function () {
      box.innerHTML = crud.chips.length
        ? crud.chips.map(function (k, i) {
          return '<span class="chip">' + esc(k) +
            '<button class="chip-x" type="button" data-chip="' + i + '" aria-label="移除 ' + esc(k) + '">×</button></span>';
        }).join('')
        : '<span class="chips-empty">还没有关键词</span>';
    };

    var commit = function (raw) {
      String(raw === null || raw === undefined ? '' : raw).split(/[,，\s]+/).forEach(function (part) {
        var k = cleanKeyword(part);
        if (!k) return;
        if (crud.chips.indexOf(k) >= 0) return;
        if (crud.chips.length >= 8) { toast('最多 8 个关键词'); return; }
        crud.chips.push(k);
      });
      if (input) input.value = '';
      paint();
    };

    paint();
    if (addBtn) addBtn.addEventListener('click', function () { commit(input && input.value); if (input) input.focus(); });
    if (input) {
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') {
          ev.preventDefault();
          commit(input.value);
        }
      });
      /* 输入逗号或空格即结算上一个词：符合「逗号或空格分隔」的直觉 */
      input.addEventListener('input', function () {
        if (/[,，\s]$/.test(input.value)) commit(input.value);
      });
    }
    box.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('.chip-x') : null;
      if (!b || !crud) return;
      var i = Number(b.getAttribute('data-chip'));
      if (i >= 0 && i < crud.chips.length) {
        crud.chips.splice(i, 1);
        paint();
      }
    });
  }

  function stkEditKeywords(file) {
    var it = findSticker(file);
    if (!it) { toast('这张表情已经不在了，先点「重新加载」'); return; }
    openCrud({
      mode: 'stk-edit',
      item: it,
      title: '改关键词',
      chips: stickerKeywords(it),
      body: chipsFieldHtml('关键词就是文件名，用 _ 连接；改名后文件会重命名。'),
      okText: '保存',
      afterOpen: bindChips,
      onOk: function () { return saveStickerKeywords(it); }
    });
  }

  function saveStickerKeywords(it) {
    var keywords = (crud && crud.chips ? crud.chips.slice() : []);
    if (!keywords.length) throw new Error('至少写一个关键词');
    if (keywords.length > 8) throw new Error('最多 8 个关键词');
    var file = it.file || it.name;

    return apiPost('stickers/update', { file: file, keywords: keywords }).then(function (res) {
      if (!res.ok) throw new Error(res.error || ('HTTP ' + res.__http));
      var data = (res.data && res.data.renamed) ? res.data : res;
      var to = data.renamed && data.renamed.to;
      toast('关键词已更新');
      if (to) patchSticker(it, to, keywords);
      else loadStickers(true);
      return res;
    });
  }

  /* 文件名变了，本地卡片先就地更新（契约要求用 renamed.to），再向服务端要一次真值 */
  function patchSticker(it, toFile, keywords) {
    var raw = state.stickers;
    var stk = raw && (raw.stickers || raw);
    var items = stk && Array.isArray(stk.items) ? stk.items : null;
    if (!items) { loadStickers(true); return; }
    var oldFile = it.file || it.name;
    var newName = String(toFile).replace(/\.[^.]+$/, '');
    items.forEach(function (x) {
      if (String(x.file || x.name) === String(oldFile)) {
        x.file = toFile;
        x.name = newName;
        x.keywords = keywords.slice();
      }
    });
    safe(renderStickers);
    loadStickers(true);
  }

  function stkUpload() {
    openCrud({
      mode: 'stk-add',
      title: '上传表情包',
      body: '<div class="field"><label class="field-label" for="csFile">图片（jpg / png / gif / webp，≤ 8 MB）</label>' +
        '<input class="input file-input" id="csFile" type="file" accept="image/jpeg,image/png,image/gif,image/webp"></div>' +
        '<div class="upload-preview" id="csPreviewBox" hidden><img id="csPreview" alt="本地预览"></div>' +
        chipsFieldHtml('逗号或空格分隔；最多 8 个；最终文件名由关键词拼成。'),
      okText: '上传',
      afterOpen: function () {
        if (crud) { crud.file = null; crud.dataUrl = ''; }
        var input = $('#csFile');
        if (input) input.addEventListener('change', onUploadFileChange);
        bindChips();
      },
      onOk: function () { return submitUpload(); }
    });
  }

  function onUploadFileChange() {
    var input = $('#csFile');
    var box = $('#csPreviewBox');
    var img = $('#csPreview');
    var f = input && input.files && input.files[0];
    if (crud) { crud.file = f || null; crud.dataUrl = ''; }
    if (box) box.hidden = true;

    if (!f) return;
    /* 类型不可信，先看 MIME；MIME 为空（老浏览器 / 特殊文件）再退回扩展名 */
    if (!STK_TYPES.test(f.type || '') && !/\.(jpe?g|png|gif|webp)$/i.test(f.name || '')) {
      var e0 = crudEls();
      if (e0.err) e0.err.hidden = true;
      showCrudError('只能上传 jpg / png / gif / webp 图片（这个文件是 ' + (f.type || '未知类型') + '）');
      input.value = '';
      if (crud) crud.file = null;
      return;
    }
    if (f.size > STK_MAX_BYTES) {
      showCrudError('图片太大：' + (f.size / 1048576).toFixed(1) + ' MB，最多 8 MB');
      input.value = '';
      if (crud) crud.file = null;
      return;
    }

    var reader = new FileReader();
    reader.onload = function () {
      if (!crud) return;
      crud.dataUrl = String(reader.result || '');
      if (img) img.src = crud.dataUrl;
      if (box) box.hidden = false;
      var e = crudEls();
      if (e.err) e.err.hidden = true;
    };
    reader.onerror = function () { showCrudError('读取本地文件失败'); };
    reader.readAsDataURL(f);
  }

  function submitUpload() {
    if (!crud || !crud.file) throw new Error('先选一张图片');
    var keywords = crud.chips.slice();
    if (!keywords.length) throw new Error('至少写一个关键词');
    if (keywords.length > 8) throw new Error('最多 8 个关键词');
    var b64 = String(crud.dataUrl || '').replace(/^data:[^,]*,/, '');
    if (!b64) throw new Error('图片还在读取，稍等一下再点上传');

    return apiPost('stickers/add', {
      dataBase64: b64,
      keywords: keywords,
      filename: crud.file.name
    }).then(function (res) {
      if (!res.ok) throw new Error(res.error || ('HTTP ' + res.__http));
      toast('已上传：' + keywords.join('_'));
      loadStickers(true);
      return res;
    });
  }

  function stkDelete(file) {
    var it = findSticker(file);
    if (!it) { toast('这张表情已经不在了，先点「重新加载」'); return; }
    openCrud({
      mode: 'stk-del',
      item: it,
      title: '删掉这张表情？',
      body: '<p class="crud-warn">删掉后不可恢复。</p>' +
        '<p class="crud-quote">' + esc(it.file || it.name) + '</p>' +
        '<p class="crud-hint-line">同时会把它从学过的哈希表里移除，以后同一张图还能重新学。</p>',
      okText: '删除',
      danger: true,
      onOk: function () {
        return apiPost('stickers/delete', { file: it.file || it.name, confirm: true }).then(function (res) {
          if (!res.ok) throw new Error(res.error || ('HTTP ' + res.__http));
          toast('已删掉这张表情');
          loadStickers(true);
          return res;
        });
      }
    });
  }

  /* ---------------- 预算 ---------------- */

  function renderBudgetEditor() {
    var box = $('#budgetEditor');
    var b = state.overview && state.overview.plugin && state.overview.plugin.budget;
    if (!box || box.childNodes.length || !b) return;
    box.innerHTML = '<h2 class="card-title">每日额度</h2><p class="card-sub">设置 Molly 每天可用的积分。改动立即生效，无需重启。</p><div class="budget-controls"><select class="input" id="budgetEnabled" aria-label="积分限制开关"><option value="">保持不变</option><option value="true">开启限制</option><option value="false">关闭限制</option></select><input class="input" id="budgetCap" type="number" min="0" step="1" placeholder="每日上限，例如 300" aria-label="每日积分上限"><button class="btn btn-primary" id="budgetSave" type="button">保存额度</button></div><div class="action-result" id="budgetOut" hidden></div>';
    $('#budgetSave').addEventListener('click', function () {
      var body = {}; var enabled = $('#budgetEnabled').value; var cap = $('#budgetCap').value.trim();
      if (enabled) body.enabled = enabled === 'true';
      if (cap) body.cap = Number(cap);
      if (!Object.keys(body).length) { toast('请选择开关状态或填写新的每日上限'); return; }
      runAction('plugin/budget', body, { btn: $('#budgetSave'), box: $('#budgetOut') });
    });
  }

  function renderBudget() {
    var box = $('#budgetCards');
    if (!box) return;
    var ov = state.overview;
    if (!ov) { setHtml(box, card('等待数据', '<p class="card-sub">正在连接控制台服务…</p>')); return; }

    var p = ov.plugin || {};
    var b = p.budget || {};
    var side = ov.sidecar || {};
    var used = Number(b.used);
    var cap = Number(b.dailyCap);
    var remain = (isFinite(used) && isFinite(cap)) ? (cap - used) : null;
    var pct = (isFinite(used) && isFinite(cap) && cap > 0) ? (used / cap) * 100 : 0;

    var usage =
      '<div class="stat-value">' + num(b.used, 2) + '<span class="stat-unit">/ ' + num(b.dailyCap, 0) + '</span></div>' +
      progressHtml(pct) +
      '<div class="row-actions">' + kv('已用比例', pct.toFixed(1) + '%') + '</div>';

    setHtml(box, [
      card('今日用量', usage),
      card('额度', [
        kv('积分限制', b.enabled === false ? pill('idle', '已关闭') : pill('ok', '已开启')),
        kv('每日上限', mono(b.dailyCap)),
        kv('已用', mono(b.used, 2)),
        kv('剩余', remain === null ? '—' : mono(remain, 2)),
        kv('日切日期', val(b.day))
      ].join('')),
      card('数据服务侧', side.reachable
        ? [
          kv('状态', pill('ok', '已连接')),
          kv('预算上限', mono(side.budget && side.budget.cap))
        ].join('')
        : '<p class="ar-error">数据服务不可达：' + esc(side.error || '连接被拒绝') + '</p>')
    ].join(''));
  }

  /* ---------------- 干活 ---------------- */

  function pick(obj, key) {
    if (!obj) return null;
    if (obj[key] !== undefined) return obj[key];
    return null;
  }

  function renderWork() {
    var box = $('#workCards');
    if (!box) return;
    var workspace = $('#dshWorkspaceLink');
    var hint = $('#dshWorkspaceHint');
    var ov = state.overview;
    var base = ov?.plugin?.reachable ? ov.plugin.base : '';
    /* 桌面窗口里的页面带宿主桥（window.chrome.webview）。DSH 的网页版只认它自己
       打印出来的授权地址，光有 origin 一定停在 "dsh web authentication required"，
       所以桌面模式下不再往浏览器甩链接，改成请宿主把正在用的 DSH 窗口提到最前。 */
    var bridge = !!(window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === 'function');
    if (workspace && base) {
      try {
        var url = new URL(base);
        if (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) workspace.href = url.origin;
      } catch (_) { /* 不采信非法上游地址，保留最后的已知入口。 */ }
    }
    if (workspace) {
      if (bridge) {
        workspace.textContent = '切到 DSH 工作台';
        workspace.removeAttribute('target');
        workspace.removeAttribute('rel');
        if (workspace.dataset.bound !== '1') {
          workspace.dataset.bound = '1';
          workspace.addEventListener('click', function (e) {
            if (!(window.chrome && window.chrome.webview)) return;   /* 浏览器里退回普通链接 */
            e.preventDefault();
            try {
              window.chrome.webview.postMessage('molly:open-dsh');
              toast('已把 DSH 窗口提到最前');
            } catch (_) { location.href = workspace.href; }
          });
        }
      } else {
        workspace.textContent = '打开 DSH 工作台 ↗';
        workspace.setAttribute('target', '_blank');
        workspace.setAttribute('rel', 'noopener');
      }
    }
    if (hint) {
      setHtml(hint, bridge
        ? '点上面的按钮会把已经打开的 <b>DeepSeek Harness</b> 窗口提到最前。DSH 的网页版只认它自己打印的授权地址，所以这里不再往浏览器转发链接。'
        : 'DSH 的网页版只认它自己打印的授权地址，直接用浏览器打开这个端口会停在授权提示上。请在 <b>Molly 桌面应用</b>里点上面的按钮，或从开始菜单启动 <b>DeepSeek Harness</b>。');
    }
    setHtml(box, '<p class="card-sub">执行、研究、插件开发与运行记录请前往 DSH 工作台。控制台不再创建第二套任务执行器。</p>');
  }

  /* ---------------- 骂人模式（出气筒总开关，task-36） ----------------
     为什么单独一张卡、单独容器：这是「一键停手」的入口，不能跟着 watchdog
     可达性一起消失（守护进程挂了也得能点）。接口在插件侧 /dsh-qq-whale/pest，
     控制台只转发 POST /api/action/pest/set；相对路径，部署到服务器也能用。 */

  var pestLast = null;   /* 最近一次渲染的快照；点击时用它判断「此刻是开还是关」 */
  var pestBusy = false;  /* 请求没回来时禁止再点，避免连点两次互相覆盖 */

  function pestTargetsText(p) {
    var t = p && Array.isArray(p.targets) ? p.targets : [];
    if (!t.length) return '—';
    return t.map(function (x) { return '<span class="mono">' + esc(String(x)) + '</span>'; }).join('、');
  }

  function pestUsedText(p) {
    var used = p.todayUsed;
    var cap = p.dailyCap;
    if (used === null || used === undefined) return '—';
    if (cap === null || cap === undefined) return mono(used) + ' 次';
    if (cap === 0) return mono(used) + ' 次（不限）';
    return mono(used) + ' / ' + mono(cap) + ' 次';
  }

  function pestMuteText(p) {
    if (!p.muted) return '没有静音';
    return '静音到 ' + esc(p.mutedUntil ? fmtStamp(p.mutedUntil) : '—');
  }

  function pestCardHtml(p) {
    var on = p.enabled === true;
    var word = p.stopWord ? String(p.stopWord) : '';
    var firstTarget = (Array.isArray(p.targets) && p.targets.length) ? String(p.targets[0]) : '';
    var wordBlock = word
      ? '<div class="pest-word' + (on ? '' : ' is-off') + '">' +
          '<span class="pest-word-label">今天的停止词</span>' +
          '<button class="pest-word-value js-pest-word" type="button" title="点击复制">' + esc(word) + '</button>' +
        '</div>' +
        '<p class="pest-word-note">' + (p.stopWordSent ? '今天已经公告过了。' : '今天还没公告（她主动开团时才发）。') +
          ' 有人喊这个词，她今天的主动挑事立刻停到明天 0 点。</p>'
      : '<div class="pest-word is-off"><span class="pest-word-label">今天的停止词</span>' +
          '<span class="pest-word-value is-empty">今天还没有</span></div>' +
        '<p class="pest-word-note">停止词每天换一个，只在她主动开团时生成。</p>';

    var rows = [
      kv('目标 QQ', pestTargetsText(p)),
      kv('今日已用', pestUsedText(p)),
      kv('现在状态', pestMuteText(p)),
      (typeof p.intervalMinutes === 'number') ? kv('巡检间隔', mono(p.intervalMinutes) + ' 分钟') : '',
      (typeof p.nextPickInMinutes === 'number') ? kv('下次评估', mono(p.nextPickInMinutes) + ' 分钟后') : ''
    ].join('');

    return '<article class="card pest-card' + (on ? ' is-on' : ' is-off') + '">' +
      '<h2 class="card-title">骂人模式 ' +
        '<span class="pest-badge ' + (on ? 'is-on' : 'is-off') + '"><i class="dot"></i>' + (on ? '开' : '关') + '</span>' +
      '</h2>' +
      '<p class="card-sub">' + (on
        ? '她可以主动挑事' + (firstTarget ? '，也会按「骂 ' + esc(firstTarget) + '」的人设张嘴' : '') + '。'
        : '已停手：不再主动开团、不再回击注入。') + '</p>' +
      rows +
      wordBlock +
      '<div class="row-actions">' +
        '<button class="btn ' + (on ? 'btn-danger' : 'btn-primary') + ' js-pest-toggle" type="button"' +
          (pestBusy ? ' disabled' : '') + '>' +
          (pestBusy ? '正在切换…' : (on ? '关闭骂人模式（立刻停）' : '开启骂人模式')) +
        '</button>' +
      '</div>' +
      '<p class="pest-foot">开关落在 pest-settings.json，重载插件也保持。只影响她「主动去骂」；' +
        '被动回话时的语气由人设决定，这个开关管不到。</p>' +
      '</article>';
  }

  function renderPestCard() {
    var box = $('#pestCards');
    if (!box) return;
    var ov = state.overview;
    if (!ov) { setHtml(box, card('骂人模式', '<p class="card-sub">正在连接控制台服务…</p>')); return; }

    var p = (ov.plugin && ov.plugin.pest) || null;
    if (!p) {
      pestLast = null;
      setHtml(box, '<article class="card pest-card is-off">' +
        '<h2 class="card-title">骂人模式 <span class="pest-badge is-off"><i class="dot"></i>不可用</span></h2>' +
        '<p class="card-sub">插件还没上报出气筒状态（旧版本，或重载还没完成）。开关暂时不能点。</p>' +
        '</article>');
      return;
    }
    pestLast = p;
    setHtml(box, pestCardHtml(p));
  }

  /* 开关成功后不等下一轮轮询：就地把插件回的 state 合进 overview 再重画 */
  function applyPestState(st) {
    if (!st || !state.overview) return;
    var plugin = state.overview.plugin || (state.overview.plugin = {});
    plugin.pest = {
      enabled: st.enabled === true,
      targets: Array.isArray(st.targets) ? st.targets : [],
      dailyCap: (typeof st.dailyCap === 'number') ? st.dailyCap : null,
      todayUsed: (typeof st.todayUsed === 'number') ? st.todayUsed : null,
      stopWord: st.stopWord || '',
      stopWordSent: Number(st.stopSentAt) > 0,
      muted: st.muted === true,
      mutedUntil: st.mutedUntil || null,
      intervalMinutes: (typeof st.intervalMinutes === 'number') ? st.intervalMinutes : null,
      nextPickInMinutes: (typeof st.nextPickInMinutes === 'number') ? st.nextPickInMinutes : null
    };
    pestLast = plugin.pest;
    renderPestCard();
  }

  function setPestEnabled(want) {
    if (pestBusy) return;
    pestBusy = true;
    renderPestCard();   /* 先把按钮切成禁用态，防连点 */
    apiPost('pest/set', { enabled: want }).then(function (res) {
      pestBusy = false;
      if (!res.ok) {
        /* 服务端原文照摆：404（没重载）/405/校验失败 都要看得见，别翻译成「失败了」 */
        toast('没切成：' + (res.error || '服务端没给原因'));
        renderPestCard();
        return;
      }
      toast(want ? '已开启骂人模式' : '已关闭，不再主动挑事');
      if (res.data && res.data.state) applyPestState(res.data.state);
      else { renderPestCard(); poll(); }
    });
  }

  function copyPestWordFallback(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      toast(ok ? '停止词已复制：' + text : '复制失败，请手动选中复制');
    } catch (e) {
      toast('复制失败，请手动选中复制');
    }
  }

  function copyPestWord() {
    if (!pestLast || !pestLast.stopWord) return;
    var text = String(pestLast.stopWord);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast('停止词已复制：' + text);
      }, function () { copyPestWordFallback(text); });
    } else {
      copyPestWordFallback(text);
    }
  }

  /* ---------------- 守护 ---------------- */

  function renderWatchdog() {
    /* 先画骂人模式：它独立于 watchdog 可达性 */
    renderPestCard();
    var box = $('#wdCards');
    if (!box) return;
    var ov = state.overview;
    if (!ov) { setHtml(box, card('等待数据', '<p class="card-sub">正在连接控制台服务…</p>')); return; }

    var wd = ov.watchdog || {};
    if (!wd.reachable) {
      setHtml(box, card('守护不可达', '<p class="ar-error">' + esc(wd.error || 'watchdog 未响应') + '</p>'));
      return;
    }

    var st = wd.state || {};
    var cfg = wd.config || {};
    var quietHours = Array.isArray(cfg.quietHours) ? cfg.quietHours.join('–') + ' 点' : val(cfg.quietHours);

    setHtml(box, [
      card('运行状态', [
        kv('上次状态', st.lastState === 'online' ? pill('ok', '在线') : pill('warn', val(st.lastState))),
        kv('上次在线', fmtStamp(st.lastOnlineAt)),
        kv('离线起点', st.offlineSince ? fmtStamp(st.offlineSince) : '—'),
        kv('恢复尝试', mono(st.recoverAttempts)),
        kv('连续失败', mono(st.consecutiveFails)),
        kv('免打扰', wd.quiet ? pill('idle', '静默中') : '否'),
        kv('计划任务', wd.taskEnabled === false ? pill('warn', '已禁用') : pill('ok', '已启用'))
      ].join('')),
      card('巡检配置', [
        kv('启用', cfg.enabled === false ? pill('idle', '已关闭') : pill('ok', '已开启')),
        kv('间隔', mono(cfg.intervalMinutes) + ' 分钟'),
        kv('静默时段', esc(quietHours)),
        kv('重复提醒', mono(cfg.repeatMinutes) + ' 分钟'),
        kv('自动恢复', cfg.autoRecover ? '开' : '关'),
        kv('最大尝试', mono(cfg.maxAutoRecoverAttempts)),
        kv('恢复后静置', mono(cfg.settleMinutesAfterRecover) + ' 分钟')
      ].join('')),
      card('最近一次', [
        kv('巡检时间', val(wd.lastRun)),
        /* window 计划任务的返回码 watchdog.mjs 不落盘（只写 lastState/lastCheckAt），
           所以这里展示 lastState + 距上次巡检多久，而不是编一个「返回码」出来。 */
        kv('巡检结论', st.lastState === 'online' ? pill('ok', '在线')
          : (st.lastState ? pill('warn', val(st.lastState)) : pill('idle', '没有记录'))),
        kv('距上次巡检', st.lastCheckAt ? agoText(st.lastCheckAt) : '—')
      ].join(''))
    ].join(''));
  }

  /* ---------------- QQ 连接 ----------------
     这页回答两件事：Molly 有没有连上 QQ、QQ 客户端进程在不在。
     主依据 = 插件桥接（link），次依据 = 客户端探测；后端名只做展示，
     SnowLuma 之外的都叫「回滚后端」，不再出现 NapCat 字样（回滚备注只在设置页）。 */

  function qqBackendLabel(q) {
    q = q || {};
    if (q.backend === 'snowluma') return 'SnowLuma';
    if (q.backend) return '回滚后端';
    return 'QQ';
  }

  function renderQq() {
    var box = $('#ncCards');
    if (!box) return;
    var ov = state.overview;
    if (!ov) { setHtml(box, card('等待数据', '<p class="card-sub">正在连接控制台服务…</p>')); return; }

    var nc = ov.napcat || {};
    var p = ov.plugin || {};
    var bot = p.bot || {};
    var q = qqStatus(ov);
    var label = qqBackendLabel(q);
    var uin = q.uin || bot.userId || '';
    var nick = q.nickname || bot.nickname || '';

    var bn = $('#qqBackendName');
    if (bn) bn.textContent = label;

    var clientText = (nc.onlineClients || []).map(function (c) {
      var n = c.name || c.kind || '未知设备';
      if (c.name && c.kind && c.kind !== n) n += '（' + c.kind + '）';
      return n;
    }).join('、');

    var flowBody = q.backend === 'snowluma'
      ? '<p class="card-sub">SnowLuma 后端：点按钮 = 触发计划任务 <span class="mono">SnowLuma-Relogin</span>，只重启 QQ 客户端，约 10~25 秒后 QQ 窗口会弹出来，用手机扫码即可。不会重启 Molly 插件、网关和控制台。</p>'
      : '<p class="card-sub">回滚后端：点按钮 = 现场生成一张登录二维码（约 2–6 秒，2 分钟过期），用手机 QQ 扫码。不会重启 Molly 插件、网关和控制台。</p>';

    var svcRows = q.backend === 'snowluma'
      ? [
          kv('OneBot', '<span class="mono">3000 / 3001</span>'),
          kv('WebUI', nc.webui
            ? '<a href="' + esc(nc.webui) + '" target="_blank" rel="noreferrer">' + esc(nc.webui) + '</a>'
            : '—'),
          kv('深度探测', nc.deepOk === true ? pill('ok', '正常') : (nc.deepOk === false ? pill('warn', '假在线') : '—')),
          kv('在线设备', esc(clientText || '未返回'))
        ]
      : [
          kv('WebUI', pill(nc.reachable ? 'ok' : 'idle', nc.reachable ? '可达' : '不可达')),
          kv('端口', '<span class="mono">6099</span>'),
          kv('OneBot', '<span class="mono">3001</span>'),
          kv('核心就绪', nc.coreReady ? '是' : '否')
        ];

    /* 合并页里「登录状态」由下半部分的扫码登录卡负责，这里连上时不再重复一句；
       没连上时仍给一句下一步提示（总览黄条也指到这一页）。 */
    var nextStep = q.level === 'connected'
      ? ''
      : '<p class="card-sub">' + esc(q.nextStep || '先点下面的「重新登录 QQ（扫码）」，再回来看这个状态。') + '</p>';

    setHtml(box, [
      card('QQ 连接状态', [
        kv('状态', pill(QQ_LEVEL_KIND[q.level] || 'idle', q.text || '未知')),
        kv('Molly 链路', q.bridgeReady ? pill('ok', '已连接') : pill('bad', val(q.bridgeState))),
        kv('QQ 客户端', q.clientReachable
          ? (q.clientLogin ? pill('ok', '已登录') : pill('warn', '未登录'))
          : pill('idle', '进程信息不可达')),
        kv('后端', esc(label)),
        kv('QQ 号', uin ? '<span class="mono">' + esc(uin) + '</span>' : '—'),
        kv('昵称', nick ? esc(nick) : '—'),
        nc.loginError ? kv('错误', esc(nc.loginError), 'is-bad') : ''
      ].join('') + nextStep),
      card('服务', svcRows.join(''))
    ].join(''));
  }

  /* ---------------- 登录（扫码） ----------------
     一条原则：进页面绝不自动生成。RefreshQRcode 每调一次都会让上一张码失效，
     乱生成会把别人正在扫的码顶掉；只有用户点按钮、或从总览黄条点进来才生成。
     自动的只有一种：码过期后的自动换码，最多连换 3 次。 */

  function loginUin() {
    var ov = state.overview || {};
    var nc = ov.napcat || {};
    var bot = (ov.plugin && ov.plugin.bot) || {};
    return String(nc.uin || bot.userId || '');
  }

  function loginPhaseText(phase) {
    var map = { ready: '就绪', online: '在线', waiting_qrcode: '等待扫码', waiting: '等待扫码', offline: '离线' };
    if (!phase) return '—';
    return map[phase] || String(phase);
  }

  function fmtRemain(ms) {
    var s = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(s / 60) + ':' + pad2(s % 60);
  }

  function renderLoginStatus() {
    var box = $('#loginStatus');
    if (!box) return;
    var ov = state.overview;
    var lg = state.login;
    var nc = (ov && ov.napcat) || {};
    var q = qqStatus(ov);
    var label = qqBackendLabel(q);
    var kind = 'idle';
    var head = '正在读取…';
    var note = '';
    var uin = loginUin();

    if (!ov) {
      head = '正在连接控制台服务…';
    } else if (q.bridgeOnline) {
      kind = 'ok';
      head = 'Molly 已连接 QQ';
      note = 'Molly ' + (uin || '（QQ 号未知）') + (q.nickname ? '（' + q.nickname + '）' : '') + '，不需要扫码。';
    } else if (q.clientReachable && q.clientLogin) {
      /* QQ 明明在跑、也登录了，但插件没连上 OneBot：别再说「QQ 未登录」 */
      kind = 'warn';
      head = 'QQ 在运行，Molly 还没连上';
      note = 'QQ 客户端已登录，但插件没连上 OneBot。去「守护」或「执行块」看插件连接状态；也可以点下面的「重新登录 QQ（扫码）」重拉一次。';
    } else if (lg.triggered) {
      kind = 'warn';
      head = '已触发重启，等待登录';
      note = '计划任务已下发：约 10~25 秒后 QQ 窗口弹出，用手机扫码即可。30 秒没反应看「运维」页的 SnowLuma 启动/运行日志。';
    } else {
      kind = 'warn';
      head = q.clientReachable ? '等待扫码' : 'QQ 未连接';
      note = q.backend === 'snowluma'
        ? '点下面的「重新登录 QQ（扫码）」，约 10~25 秒后 QQ 窗口弹出，用手机扫码'
        : (lg.waiting ? '二维码已就绪，用手机 QQ 扫一下' : '还没登录：点下面的「重新登录 QQ（扫码）」');
    }

    box.innerHTML = '<article class="card login-status-card is-' + kind + '">' +
      '<div class="login-status-head">' + pill(kind, head) +
        '<span class="login-status-note">' + esc(note) + '</span>' +
      '</div>' +
      '<div class="login-status-grid">' +
        kv('Molly 链路', q.bridgeReady ? pill('ok', '已连接') : pill('bad', val(q.bridgeState))) +
        kv('QQ 客户端', q.clientReachable
          ? (q.clientLogin ? pill('ok', '已登录') : pill('warn', '未登录'))
          : pill('idle', '进程信息不可达')) +
        kv('后端', esc(label)) +
        (q.backend === 'snowluma'
          ? kv('深度探测', nc.deepOk === true ? pill('ok', '正常') : (nc.deepOk === false ? pill('warn', '假在线') : '—'))
          : kv('核心就绪', nc.reachable ? (nc.coreReady ? '是' : '否') : '—')) +
        kv('QQ 号', uin ? '<span class="mono">' + esc(uin) + '</span>' : '—') +
        (q.backend === 'snowluma'
          ? kv('登录方式', 'QQ 原生窗口扫码')
          : kv('二维码', lg.png ? pill('warn', '已生成') : pill('idle', '未生成'))) +
      '</div></article>';
  }

  function renderLogin() {
    var lg = state.login;

    renderLoginStatus();

    var okBox = $('#loginSuccess');
    if (okBox) {
      if (lg.success) {
        okBox.hidden = false;
        okBox.innerHTML = '<strong>已登录：' + esc(lg.success) + '</strong>' +
          '<span>' + esc(lg.successNote || '扫码成功，Molly 已经能正常收发消息了。') + '</span>';
      } else {
        okBox.hidden = true;
        okBox.innerHTML = '';
      }
    }

    /* 失败必须给服务端原文：只写「网络错误」等于让人猜 */
    var errBox = $('#loginError');
    if (errBox) {
      if (lg.error) {
        errBox.hidden = false;
        errBox.innerHTML = '<strong>二维码生成失败</strong>' +
          '<p class="login-error-text">' + esc(lg.error) + '</p>' +
          '<div class="row-actions"><button class="btn btn-ghost btn-sm" id="loginRetry" type="button">重试</button></div>';
      } else {
        errBox.hidden = true;
        errBox.innerHTML = '';
      }
    }

    var gen = $('#loginGen');
    if (gen) {
      gen.disabled = lg.generating;
      gen.textContent = lg.generating
        ? '处理中…'
        : (lg.triggered ? '再次触发重启' : (lg.waiting ? '换一张' : '重新登录 QQ（扫码）'));
      gen.classList.toggle('is-loading', lg.generating);
    }

    if (lg.generating) {
      tickGenProgress();
    } else {
      var prog = $('#loginProgress');
      if (prog) { prog.hidden = true; prog.textContent = ''; }
    }

    var cd = $('#loginCountdown');
    if (cd) {
      if (lg.waiting && lg.expiresAt) {
        var remain = lg.expiresAt - Date.now();
        cd.hidden = false;
        cd.textContent = remain > 0 ? ('有效期 ' + fmtRemain(remain)) : '已过期';
        cd.classList.toggle('is-low', remain <= 15000);
      } else {
        cd.hidden = true;
        cd.textContent = '';
      }
    }

    var qr = $('#loginQr');
    var img = $('#loginQrImg');
    var idle = $('#loginIdle');
    var idleMain = $('#loginIdleMain');
    var idleHint = $('#loginIdleHint');
    var link = $('#loginUrl');
    var hint = $('#loginHint');
    if (qr && img) {
      if (lg.png && !lg.success) {
        qr.hidden = false;
        if (idle) idle.hidden = true;
        /* 过期但还没换码时把旧图留着（灰掉），比突然消失更好懂 */
        qr.classList.toggle('is-expired', !lg.waiting);
        if (img.getAttribute('src') !== lg.imgSrc) img.setAttribute('src', lg.imgSrc);
        if (link) link.value = lg.url || '';
        if (hint) {
          hint.textContent = lg.hint || (lg.waiting
            ? '用手机 QQ 扫码；扫上后本页会自动变成已登录。'
            : '这张码已失效，点「换一张」重新生成。');
        }
      } else {
        qr.hidden = true;
        if (idle) idle.hidden = false;
        if (img) img.removeAttribute('src');
        /* 没有二维码分两种：SnowLuma 后端「已触发重启、等窗口」和「还没点按钮」 */
        var q = qqStatus();
        if (idleMain) {
          idleMain.textContent = lg.triggered
            ? '已触发重启 QQ：约 10~25 秒后 QQ 窗口会弹出来，用手机扫码登录。'
            : (q.backend === 'snowluma'
              ? '点「重新登录 QQ（扫码）」：会触发计划任务重启 QQ 客户端，约 10~25 秒后 QQ 窗口弹出，用手机扫码。'
              : '点「重新登录 QQ（扫码）」会现场生成一张登录二维码，用手机 QQ 扫码。');
        }
        if (idleHint) {
          idleHint.textContent = lg.triggered
            ? '不会重启 Molly 插件、网关和控制台。30 秒还没反应：看「运维」页的 SnowLuma 启动/运行日志，或去「守护」检查插件连接。'
            : '不会重启 Molly 插件、网关和控制台。回滚后端下二维码约 2 分钟过期，过期后最多自动换 3 张。';
        }
      }
    }

    /* 导航上的橙点：有码在等扫、或者刚触发完重启在等登录时都亮 */
    var badge = $('#loginBadge');
    if (badge) badge.hidden = !((lg.waiting || lg.triggered) && !lg.success);
  }

  function tickGenProgress() {
    var lg = state.login;
    var prog = $('#loginProgress');
    if (!lg.generating) {
      if (prog) { prog.hidden = true; prog.textContent = ''; }
      stopGenTick();
      return;
    }
    if (!prog) return;
    var secs = Math.max(0, Math.round((Date.now() - lg.genStartedAt) / 1000));
    prog.hidden = false;
    /* SnowLuma 后台没有二维码可生成：点按钮是触发计划任务重启 QQ，文案别再说「生成二维码」 */
    prog.textContent = qqStatus().backend === 'snowluma'
      ? '正在触发重新登录，已等待 ' + secs + ' 秒…'
      : '正在生成二维码，已等待 ' + secs + ' 秒（通常 2–6 秒）';
  }

  function stopGenTick() {
    if (qrGenTimer) { clearInterval(qrGenTimer); qrGenTimer = null; }
  }

  function stopLoginPoll() {
    if (qrPollTimer) { clearInterval(qrPollTimer); qrPollTimer = null; }
  }

  function stopLoginCountdown() {
    if (qrCountTimer) { clearInterval(qrCountTimer); qrCountTimer = null; }
  }

  function startLoginPoll() {
    stopLoginPoll();
    qrPollTimer = setInterval(function () {
      /* 人离开登录页就停：后台不该一直问 overview，4 秒的全局轮询已经够用 */
      if (state.page !== 'qq') { stopLoginPoll(); return; }
      safe(loginPollTick);
    }, QR_POLL_MS);
  }

  function startLoginCountdown() {
    stopLoginCountdown();
    qrCountTimer = setInterval(function () { safe(loginCountdownTick); }, 1000);
  }

  function loginPollTick() {
    var lg = state.login;
    if (!lg.waiting && !lg.triggered) { stopLoginPoll(); return; }
    fetch('/api/overview', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        if (!j || j.ok === false) throw new Error((j && j.error) || '接口返回失败');
        state.overview = j;
        state.lastOkAt = Date.now();
        state.lastError = null;
        safe(renderTop);
        /* 成功标准 = 插件桥接 online（Molly 真连上了），不是客户端探测 */
        var q = qqStatus(j);
        if (q.bridgeOnline) {
          markLoginSuccess(lg.triggered ? { retriggered: true } : (lg.generating ? { already: true } : {}));
          return;
        }
        /* 触发重启后最多等 60 秒：别让「等待中」无限转下去 */
        if (lg.triggered && lg.triggeredAt && Date.now() - lg.triggeredAt > 60_000) {
          lg.triggered = false;
          lg.hint = '还没等到 QQ 登录。看「运维」页的 SnowLuma 启动/运行日志（G:\\Molly\\qq-whale\\out\\snowluma-boot.log、snowluma-runtime.out.log），也可以去「守护」检查插件连接。';
          stopLoginPoll();
        }
        safe(renderLogin);
      })
      .catch(function (err) {
        /* 轮询失败只记日志：本来就在等扫码，弹红条反而吓人 */
        console.warn('[molly-console] 扫码轮询失败：', err && err.message ? err.message : err);
      });
  }

  function loginCountdownTick() {
    var lg = state.login;
    if (!lg.waiting) { stopLoginCountdown(); return; }
    var remain = lg.expiresAt - Date.now();
    var cd = $('#loginCountdown');
    if (cd) {
      cd.hidden = false;
      cd.textContent = remain > 0 ? ('有效期 ' + fmtRemain(remain)) : '已过期';
      cd.classList.toggle('is-low', remain <= 15000);
    }
    if (remain <= 0) {
      stopLoginCountdown();
      handleQrExpired();
    }
  }

  /* 过期处理：人在登录页才自动换码；换满 3 次就停手，避免把请求打成环 */
  function handleQrExpired() {
    var lg = state.login;
    if (!lg.waiting) return;
    lg.waiting = false;
    if (state.page !== 'qq') {
      lg.hint = '二维码已过期；回到本页会自动换新码，也可以手动点「换一张」。';
      safe(renderLogin);
      return;
    }
    if (lg.autoSwaps >= QR_MAX_AUTO) {
      lg.hint = '二维码已过期。已经自动连换 ' + QR_MAX_AUTO + ' 次，先停下来了，请手动点「换一张」。';
      safe(renderLogin);
      return;
    }
    lg.autoSwaps += 1;
    generateQr({ auto: true });
  }

  /* opts.already 表示「本来就在线，后端没给码」：这时候说「扫码成功」是在骗人；
     opts.retriggered 表示「刚触发重启 QQ，后来真的连上了」 */
  function markLoginSuccess(opts) {
    var lg = state.login;
    opts = opts || {};
    lg.waiting = false;
    lg.triggered = false;
    lg.expiresAt = 0;
    lg.png = '';
    lg.url = '';
    lg.imgSrc = '';
    lg.error = '';
    lg.hint = '';
    lg.success = 'Molly ' + (loginUin() || '（QQ 号未知）');
    lg.successNote = opts.already
      ? '本来就在线，不需要扫码。'
      : (opts.retriggered
        ? 'QQ 重新登录完成，Molly 已经连上 QQ，能正常收发消息了。'
        : '扫码成功，Molly 已经连上 QQ，能正常收发消息了。');
    stopLoginPoll();
    stopLoginCountdown();
    safe(renderLogin);
    toast(opts.already ? '本来就在线，不需要扫码' : 'QQ 已重新登录，Molly 已连上');
    poll();   /* 立刻刷一遍总览和顶栏，别等 4 秒 */
  }

  function generateQr(opts) {
    var lg = state.login;
    opts = opts || {};
    if (lg.generating) return;

    lg.generating = true;
    lg.genStartedAt = Date.now();
    lg.error = '';
    lg.hint = '';
    lg.triggered = false;
    if (!opts.auto) {
      lg.autoSwaps = 0;   /* 手动生成一次 = 重新开始计数 */
      lg.success = '';
      lg.successNote = '';
    }
    lg.waiting = false;
    stopLoginPoll();
    stopLoginCountdown();

    if (qrGenTimer) { clearInterval(qrGenTimer); qrGenTimer = null; }
    qrGenTimer = setInterval(function () { safe(tickGenProgress); }, 500);
    safe(renderLogin);

    apiPost('napcat/qr', { confirm: true }).then(function (res) {
      lg.generating = false;
      stopGenTick();

      if (!res || res.ok !== true) {
        lg.error = (res && res.error) ? String(res.error) : '生成失败，服务端没有给出原因';
        lg.png = '';
        lg.imgSrc = '';
        safe(renderLogin);
        return;
      }

      var d = (res.data && typeof res.data === 'object') ? res.data : {};

      if (d.alreadyLogin) {
        /* 已登录时后端不返回码：直接按「已登录」收尾，不让用户看见一张空图 */
        lg.png = '';
        lg.imgSrc = '';
        lg.url = '';
        markLoginSuccess({ already: true });
        return;
      }

      /* SnowLuma 后端「重新登录」= 触发 SnowLuma-Relogin 计划任务重启 QQ 客户端，
         本来就没有二维码。没有 png 不是失败：转成「已触发，等窗口」状态继续轮询。 */
      if (!d.png && (d.backend === 'snowluma' || d.hint || d.task === 'SnowLuma-Relogin')) {
        lg.png = '';
        lg.imgSrc = '';
        lg.url = '';
        lg.waiting = false;
        lg.triggered = true;
        lg.triggeredAt = Date.now();
        lg.expiresAt = 0;
        lg.hint = d.hint ? String(d.hint) : '已触发重新登录：约 10~25 秒后 QQ 窗口会弹出来，用手机扫码即可。';
        lg.success = '';
        startLoginPoll();
        toast('已触发重新登录 QQ，等窗口弹出');
        safe(renderLogin);
        poll();
        return;
      }

      if (!d.png) {
        lg.error = '服务端没有返回二维码（png 为空）';
        lg.png = '';
        lg.imgSrc = '';
        safe(renderLogin);
        return;
      }

      lg.png = String(d.png);
      lg.url = d.url ? String(d.url) : '';
      /* 二维码每次都要换 URL，否则浏览器会拿缓存里的旧图给人扫 */
      lg.imgSrc = lg.png + (lg.png.indexOf('?') >= 0 ? '&' : '?') + 't=' + Date.now();
      lg.qrAt = Date.now();
      lg.expiresAt = lg.qrAt + QR_TTL_MS;
      lg.waiting = true;
      lg.success = '';
      lg.hint = opts.auto
        ? ('旧码过期，已自动换新码（' + lg.autoSwaps + '/' + QR_MAX_AUTO + '）')
        : '';

      startLoginPoll();
      startLoginCountdown();
      if (opts.auto) toast('旧码过期，已自动换新码');
      safe(renderLogin);
    });
  }

  /* 进登录页：只恢复现场，不自动触发；点按钮才是明确动作。
     例外是「停在别处时码过期了」——这种情况下用户本来就想要一张新码；
     SnowLuma 的「已触发重启、等登录」状态下进页继续轮询等结果。 */
  function enterLoginPage() {
    var lg = state.login;
    safe(renderLogin);
    if (lg.generating || lg.success) return;

    if (lg.triggered) {
      startLoginPoll();
      return;
    }

    if (lg.waiting && lg.expiresAt && lg.expiresAt <= Date.now()) {
      lg.waiting = false;
      if (lg.autoSwaps >= QR_MAX_AUTO) {
        lg.hint = '二维码已过期。已经自动连换 ' + QR_MAX_AUTO + ' 次，先停下来了，请手动点「换一张」。';
        safe(renderLogin);
      } else {
        lg.autoSwaps += 1;
        generateQr({ auto: true });
      }
      return;
    }

    if (lg.waiting) {
      startLoginPoll();
      startLoginCountdown();
    }
  }

  function copyLoginUrl() {
    var text = state.login.url || '';
    if (!text) { toast('还没有二维码链接'); return; }
    var fallback = function () {
      var inp = $('#loginUrl');
      if (inp) { inp.focus(); inp.select(); }
      toast('复制失败，链接已选中，请按 Ctrl+C');
    };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          toast('二维码链接已复制');
        }, fallback);
      } else {
        fallback();
      }
    } catch (err) {
      fallback();
    }
  }

  /* ---------------- 设置 ---------------- */

  function readSleepForm() {
    var en = $('#sleepEnabled');
    var st = $('#sleepStart');
    var ed = $('#sleepEnd');
    return {
      enabled: !en || en.value !== 'false',
      start: (st && st.value) || '',
      end: (ed && ed.value) || ''
    };
  }

  function sleepCardReady() {
    var card = $('#sleepCard');
    return !!(card && card.getAttribute('data-loaded') === '1');
  }

  function setSleepSaveEnabled(on) {
    var btn = $('#sleepSave');
    if (btn) btn.disabled = !on;
  }

  function fillSleepForm(sleep) {
    var en = $('#sleepEnabled');
    var st = $('#sleepStart');
    var ed = $('#sleepEnd');
    var hint = $('#sleepHint');
    var card = $('#sleepCard');
    if (!sleep || sleep.ok === false) return false;
    if (en) en.value = sleep.enabled === false ? 'false' : 'true';
    if (st && sleep.start) st.value = sleep.start;
    if (ed && sleep.end) ed.value = sleep.end;
    if (hint) hint.textContent = sleep.sleeping ? "（现在正在睡觉时间里）" : "";
    if (card) card.setAttribute('data-loaded', '1');
    setSleepSaveEnabled(true);
    return true;
  }

  var sleepRetryTimer = null;
  // 读不到真实作息时，绝不能把「表单默认值」当成当前值留着：
  // 否则主人一点保存，就把真实设置覆盖成 23:50/09:00，看起来像"自己变回默认"。
  function refreshSleep(tries) {
    var n = typeof tries === 'number' ? tries : 0;
    fetch('/api/sleep', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) { fillSleepForm(j); return; }
        throw new Error((j && j.error) || '读取失败');
      })
      .catch(function (e) {
        var hint = $('#sleepHint');
        if (n < 6) {
          if (sleepRetryTimer) clearTimeout(sleepRetryTimer);
          setSleepSaveEnabled(false);
          if (hint) hint.textContent = '正在读取作息…（插件可能刚重载）';
          sleepRetryTimer = setTimeout(function () { refreshSleep(n + 1); }, 800);
          return;
        }
        setSleepSaveEnabled(false);
        if (hint) hint.textContent = '读取失败：' + ((e && e.message) || e) + '，请刷新页面后再改';
      });
  }

  window.__mollySaveSleep = function () {
    if (!sleepCardReady()) {
      toast('还没读到当前作息，先刷新页面再改（避免把设置覆盖成默认值）');
      return;
    }
    var body = readSleepForm();
    var btn = $('#sleepSave');
    if (btn) btn.disabled = true;
    fetch('/api/sleep', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) {
          fillSleepForm(j);
          toast("作息已保存：" + (j.enabled ? j.start + "–" + j.end : "不睡"));
        } else {
          toast("保存失败：" + ((j && j.error) || "未知错误"));
        }
      })
      .catch(function (e) { toast("保存失败：" + (e && e.message ? e.message : e)); })
      .then(function () { if (btn) btn.disabled = false; });
  };

  function renderSettings() {
    var box = $('#setCards');
    if (!box) return;
    var ov = state.overview || {};
    var p = ov.plugin || {};
    var side = ov.sidecar || {};
    var h = state.health || {};

    setHtml(box, [
      card('连接', [
        kv('控制台', pill('ok', location.origin)),
        kv('版本', val(h.version)),
        kv('插件端口', p.reachable ? pill('ok', '自动探测到') : pill('bad', '未探测到')),
        kv('数据服务 19391', side.reachable ? pill('ok', '可达') : pill('bad', '不可达')),
        kv('数据更新时间', fmtStamp(ov.at))
      ].join('')),
      card('刷新', [
        kv('轮询间隔', '<span class="mono">' + (POLL_MS / 1000) + ' 秒</span>'),
        kv('页面隐藏时', '暂停'),
        kv('日志源', '<span class="mono">watchdog</span>'),
        kv('日志轮询', '<span class="mono">' + (LOG_POLL_MS / 1000) + ' 秒</span>')
      ].join('')),
      card('界面', [
        kv('主题', '暖纸 · 墨绿'),
        kv('主色', '<span class="mono">#294f3e</span>'),
        kv('字体', '系统字体，无外链'),
        kv('构建', '无（原生 HTML/CSS/JS）')
      ].join(''))
    ].join(''));
    /* 储存与占用是异步的（要跑一次 tasklist + 问一次侧车），单独拉，别拖慢设置页首屏 */
    safe(renderMem);
  }

  function loadHealth() {
    fetch('/api/health', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        state.health = j || {};
        var fv = $('#footVersion');
        if (fv && state.health.version) fv.textContent = 'v' + state.health.version;
        if (state.page === 'settings') { safe(renderSettings); safe(refreshSleep); }
        /* 关于页的版本/构建也吃 health：进页时那一次拉完要把卡片重绘一遍 */
        if (state.page === 'about') safe(renderAbout);
      })
      .catch(function (err) { console.warn('[molly-console] health 读取失败：', err); });
  }

  /* ---------------- 本次更新说明（2026-10-25，主人 m04452） ----------------
     点左下角版本号弹出「这次更新了什么」。数据源是服务端 /api/changelog，
     它直接读仓库里的 docs/CHANGELOG.md 最新一节——不另维护一份文案，
     免得版本说明和发布记录对不上。 */

  var chgCache = null;

  function chgInline(text) {
    return esc(text)
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/「([^」]+)」/g, '「$1」');
  }

  function renderChangelog(md) {
    var lines = String(md || '').split(/\r?\n/);
    var html = [];
    var inList = false;
    function closeList() {
      if (inList) { html.push('</ul>'); inList = false; }
    }
    lines.forEach(function (raw) {
      var line = raw.replace(/\s+$/, '');
      if (!line.trim()) { closeList(); return; }
      if (/^###\s+/.test(line)) { closeList(); html.push('<h4>' + chgInline(line.replace(/^###\s+/, '')) + '</h4>'); return; }
      if (/^##\s+/.test(line)) { closeList(); html.push('<h3>' + chgInline(line.replace(/^##\s+/, '')) + '</h3>'); return; }
      if (/^[-*]\s+/.test(line)) {
        if (!inList) { html.push('<ul>'); inList = true; }
        html.push('<li>' + chgInline(line.replace(/^[-*]\s+/, '')) + '</li>');
        return;
      }
      if (/^>\s?/.test(line)) { closeList(); html.push('<p class="chg-quote">' + chgInline(line.replace(/^>\s?/, '')) + '</p>'); return; }
      if (/^---+$/.test(line)) { closeList(); html.push('<hr>'); return; }
      closeList();
      html.push('<p>' + chgInline(line) + '</p>');
    });
    closeList();
    return html.join('');
  }

  function openChangelog() {
    var mask = $('#chgModal');
    var body = $('#chgBody');
    if (!mask || !body) return;
    mask.hidden = false;
    if (chgCache) { body.innerHTML = renderChangelog(chgCache); return; }
    body.innerHTML = '<p class="chg-muted">读取中…</p>';
    fetch('/api/changelog', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var text = (j && j.text) || '';
        if (!text) {
          body.innerHTML = '<p class="chg-muted">这一版没有单独的变更说明，可点右下角看完整变更日志。</p>';
          return;
        }
        chgCache = text;
        body.innerHTML = renderChangelog(text);
      })
      .catch(function (err) {
        body.innerHTML = '<p class="chg-muted">读取失败：' + esc(String(err && err.message || err)) + '</p>';
      });
  }

  function bindChangelog() {
    var fv = $('#footVersion');
    if (fv) fv.addEventListener('click', function () { openChangelog(); });
    var mask = $('#chgModal');
    var close = $('#chgClose');
    if (close) close.addEventListener('click', function () { if (mask) mask.hidden = true; });
    if (mask) {
      mask.addEventListener('click', function (ev) { if (ev.target === mask) mask.hidden = true; });
    }
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && mask && !mask.hidden) mask.hidden = true;
    });
    var full = $('#chgFull');
    if (full) full.addEventListener('click', function (ev) {
      ev.preventDefault();
      window.open('https://github.com/3150481853/molly-qq-whale/blob/main/docs/CHANGELOG.md', '_blank', 'noopener');
    });
  }

  /* ---------------- 关于页（2026-11-04） ----------------
     只读事实页：左列讲她自己（标识、版本/构建比对、本机数据），右列是出口
     （论坛帖、项目目录、排障文档、恢复入口）。数据只来自已有的 /api/overview
     （4 秒轮询）与 /api/health，不新增接口；缺一块就写「—」，
     绝不让 undefined / NaN / null 漏到屏幕上。 */

  function aboutNum(v, digits) {
    if (v === null || v === undefined || v === '') return '';
    var n = Number(v);
    return isFinite(n) ? num(n, digits || 0) : '';
  }

  function aboutUnit(v, unit) {
    var s = aboutNum(v);
    return s ? '<span class="mono">' + s + '</span> ' + unit : '—';
  }

  function aboutVersion() {
    var h = state.health || {};
    return h.version ? String(h.version) : '';
  }

  function aboutBuild() {
    var h = state.health || {};
    var ov = state.overview || {};
    var b = String(h.build || (ov && ov.build) || '');
    return b ? b.slice(0, 8) : '';
  }

  /* 状态行单独维护：4 秒轮询只重绘数据容器，不碰这一行，
     否则「已是最新 · 20:14:03」会被下一轮 overview 冲掉。 */
  function aboutStatus(text, cls, withReload) {
    var el = $('#aboutStatus');
    if (!el) return;
    el.className = 'about-status' + (cls ? ' ' + cls : '');
    el.innerHTML = '<span>' + esc(String(text)) + '</span>' +
      (withReload ? '<button class="btn btn-ghost btn-sm" id="aboutReload" type="button">刷新</button>' : '');
  }

  function checkAboutUpdate() {
    if (state.about.checking) return;
    state.about.checking = true;
    aboutStatus('检查中…', '');
    fetch('/api/health', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        state.health = j || {};
        var fv = $('#footVersion');
        if (fv && state.health.version) fv.textContent = 'v' + state.health.version;
        var server = String(state.health.build || '');
        var at = fmtClock(Date.now());
        if (!PAGE_BUILD) {
          aboutStatus('这个页面没有构建标识（不是控制台服务发出的），刷新后以服务端为准', 'is-warn', true);
        } else if (!server) {
          aboutStatus('服务端没返回构建号，这次比不了', 'is-warn');
        } else if (server === PAGE_BUILD) {
          aboutStatus('已是最新 · ' + at, 'is-ok');
        } else {
          aboutStatus('服务端前端已更新（' + server + '），刷新后生效', 'is-warn', true);
        }
        safe(renderAbout);
      })
      .catch(function (err) {
        aboutStatus('检查失败：' + ((err && err.message) || String(err)), 'is-bad');
      })
      .then(function () { state.about.checking = false; });
  }

  /* /api/changelog 只给最新一节，这里取「改了什么」那一段的条目就地展开。
     发布说明是给我自己看的（还有「验证」「怎么退回」两段，全是测试条数与回滚步骤），
     关于页要的是「这一版改了什么」，所以优先取变更段；一版里没有小节就退回整节条目。 */
  function aboutChgSections(md) {
    var sections = {};
    var order = [];
    var cur = '';
    String(md || '').split(/\r?\n/).forEach(function (raw) {
      var line = raw.replace(/\s+$/, '');
      if (!line.trim()) return;
      var head = line.trim().match(/^\*\*(.+?)\*\*$/);
      if (head) {
        cur = head[1].trim();
        if (!sections[cur]) { sections[cur] = []; order.push(cur); }
        return;
      }
      if (/^#{1,6}\s+/.test(line) || /^---+$/.test(line)) return;
      if (!cur) return;
      sections[cur].push(line.trim());
    });
    return { sections: sections, order: order };
  }

  function aboutChgBullets(lines) {
    var out = [];
    lines.forEach(function (line) {
      if (/^[-*]\s+/.test(line)) { out.push(line.replace(/^[-*]\s+/, '')); return; }
      /* 折行的续行并回上一条，别拆成两条 */
      if (out.length && /^\s{2,}/.test(line)) { out[out.length - 1] += ' ' + line.trim(); return; }
      if (out.length) out[out.length - 1] += ' ' + line;
    });
    return out;
  }

  function aboutChgItems(md) {
    var parsed = aboutChgSections(md);
    var pick = '';
    for (var i = 0; i < parsed.order.length; i += 1) {
      if (/改了什么|变更|新增|修复|更新内容/.test(parsed.order[i])) { pick = parsed.order[i]; break; }
    }
    var items = [];
    if (pick) items = aboutChgBullets(parsed.sections[pick]);
    if (!items.length) {
      /* 没有小节标题：退回「全部 bullet」，仍剔掉一眼就是测试结论的行 */
      var all = [];
      parsed.order.forEach(function (k) { all = all.concat(parsed.sections[k]); });
      items = aboutChgBullets(all).filter(function (x) {
        return !/(通过\s*\/\s*|单测|测试脚本|\.mjs|哈希一致后重载)/.test(x);
      });
    }
    return items.slice(0, 5);
  }

  function renderAboutChg() {
    var box = $('#aboutChg');
    if (!box) return;
    if (state.about.chgError) {
      box.innerHTML = '<p class="about-muted">更新日志读取失败：' + esc(state.about.chgError) + '</p>';
      return;
    }
    var items = state.about.chg;
    if (!items || !items.length) {
      box.innerHTML = '<p class="about-muted">本版本没有更新记录</p>';
      return;
    }
    var title = state.about.chgTitle ? String(state.about.chgTitle) : '';
    box.innerHTML = (title ? '<div class="about-chg-title">' + esc(title) + '</div>' : '') +
      '<ul class="about-chg-list">' + items.map(function (x) {
        return '<li>' + chgInline(x) + '</li>';
      }).join('') + '</ul>';
  }

  function toggleAboutChangelog() {
    var box = $('#aboutChg');
    var btn = $('#aboutChgToggle');
    if (!box) return;
    if (!box.hidden) {
      box.hidden = true;
      if (btn) btn.setAttribute('aria-expanded', 'false');
      return;
    }
    box.hidden = false;
    if (btn) btn.setAttribute('aria-expanded', 'true');
    if (state.about.chg || state.about.chgError) { renderAboutChg(); return; }
    box.innerHTML = '<p class="about-muted">读取中…</p>';
    fetch('/api/changelog', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var text = (j && j.text) || '';
        if (text) chgCache = text;   /* 顺手喂给左下角那个弹层，两边不重复请求 */
        state.about.chgError = '';
        /* 小标题优先用接口给的 title（「2026-10-30（深夜）· 记忆闸门：…」），
           拿不到再从正文第一行 ## 标题里抠一个。 */
        var t = (j && j.title) ? String(j.title) : '';
        if (!t && text) {
          var firstHash = text.match(/^#{1,6}\s+(.+)$/m);
          if (firstHash) t = firstHash[1].trim();
        }
        state.about.chgTitle = t;
        state.about.chg = aboutChgItems(text);
        renderAboutChg();
      })
      .catch(function (err) {
        state.about.chg = null;
        state.about.chgError = String((err && err.message) || err);
        renderAboutChg();
      });
  }

  function copyAboutText(text) {
    if (!text) return;
    if (!(navigator.clipboard && navigator.clipboard.writeText)) {
      toast('当前环境不支持剪贴板');
      return;
    }
    navigator.clipboard.writeText(text)
      .then(function () { toast('路径已复制'); })
      .catch(function (err) { toast('复制失败：' + ((err && err.message) || '浏览器拒绝')); });
  }

  function renderAbout() {
    var ov = state.overview || {};
    var p = ov.plugin || {};
    var wd = ov.watchdog || {};
    var ver = aboutVersion();
    var build = aboutBuild();

    /* 标识 + pill 组：版本 / 构建 / 本机地址 / 运行形态 */
    var host = '';
    try { host = String(location.host || ''); } catch (err) { host = ''; }
    var desktop = document.documentElement.getAttribute('data-shell') === 'desktop';
    setHtml($('#aboutPills'), [
      pill('idle', ver ? 'v' + ver : '版本未知'),
      pill('idle', build ? '构建 ' + build : '构建 —'),
      pill('idle', host || '127.0.0.1:19392'),
      pill('idle', desktop ? '桌面应用' : '浏览器')
    ].join(''));

    setHtml($('#aboutUpdateKv'), [
      kv('当前版本', ver ? '<span class="mono">v' + esc(ver) + '</span>' : '—'),
      kv('服务端构建', build ? '<span class="mono">' + esc(build) + '</span>' : '—')
    ].join(''));

    /* 数据与连接：全部 /api/overview；其中一块没报就整行写「—」 */
    var memCount = aboutUnit(p.memory && p.memory.count, '条');
    var stkCount = aboutUnit(p.stickers && p.stickers.count, '张');
    var msgs = aboutNum(p.metrics && p.metrics.messages);
    var convs = aboutNum(p.metrics && p.metrics.conversations);
    var talked = (msgs || convs)
      ? '<span class="mono">' + (msgs || '—') + '</span> 条 / <span class="mono">' + (convs || '—') + '</span> 个会话'
      : '—';
    /* 积分是有小数的（22.79），别四舍五入成 23 —— 那和顶栏对不上 */
    var used = aboutNum(p.budget && p.budget.used, 2);
    var cap = aboutNum(p.budget && p.budget.dailyCap);
    var budget = (used || cap)
      ? '<span class="mono">' + (used || '—') + '</span> / ' + (cap || '—')
      : '—';
    var bot = p.bot || {};
    var nick = bot.nickname ? String(bot.nickname) : '';
    var uid = (bot.userId === null || bot.userId === undefined || bot.userId === '') ? '' : String(bot.userId);
    var linkState = String((p.link && p.link.state) || '');
    var qqLine = (nick || uid)
      ? esc(nick || '未命名') + (uid ? '（' + esc(uid) + '）' : '') + (linkState ? ' · ' + esc(linkState) : '')
      : '—';
    var wdLine = (typeof wd.reachable === 'boolean')
      ? (wd.reachable ? '<i class="about-dot is-ok" aria-hidden="true"></i>正常'
        : '<i class="about-dot is-bad" aria-hidden="true"></i>不可达')
      : '—';
    var base = p.base ? String(p.base) : '';

    setHtml($('#aboutFacts'), [
      kv('Jasmine 记忆', memCount),
      kv('表情', stkCount),
      kv('已聊', talked),
      kv('积分', budget),
      kv('QQ', qqLine),
      kv('守护', wdLine),
      kv('DSH 宿主', base ? '<span class="mono">' + esc(base) + '</span>' : '—')
    ].join(''));

    /* 版本与许可：外观跟着 data-glass 说实话 —— 关掉磨砂时不应还写「玻璃」 */
    var glass = document.documentElement.getAttribute('data-glass') !== 'false';
    setHtml($('#aboutMeta'), [
      kv('版本', ver ? '<span class="mono">v' + esc(ver) + '</span>' : '—'),
      kv('构建', build ? '<span class="mono">' + esc(build) + '</span>' : '—'),
      kv('许可', '私有自用'),
      kv('平台', 'Windows · WebView2'),
      kv('语言', '中文'),
      kv('外观', glass ? '玻璃' : '不透明')
    ].join(''));
  }

  /* ---------------- 执行块 ---------------- */

  var ACTIONS = [
    {
      id: 'plugin/toggle',
      title: '开关插件',
      desc: '启用或停用 Molly 插件本体，改完立即生效。',
      fields: [{ key: 'enabled', label: '目标状态', type: 'select', cast: 'bool', def: 'true', options: [{ value: 'true', label: '启用' }, { value: 'false', label: '停用' }] }]
    },
    {
      id: 'plugin/recheck',
      title: '重新检查连接',
      desc: '让插件重新连一次 QQ，并刷新模型与账号信息。'
    },
    {
      id: 'plugin/budget',
      title: '积分限制',
      desc: '改每日积分上限或开关限制。留空表示保持原值。',
      fields: [
        { key: 'enabled', label: '限制开关', type: 'select', cast: 'bool', def: '', options: [{ value: '', label: '保持不变' }, { value: 'true', label: '开启' }, { value: 'false', label: '关闭' }] },
        { key: 'cap', label: '每日上限（积分）', type: 'number', cast: 'number', placeholder: '例如 500' }
      ]
    },
    {
      id: 'napcat/qr',
      title: '重新登录 QQ（扫码）',
      /* 两种后端行为不同：SnowLuma 只重启 QQ（不重启 SnowLuma，设备指纹不变）；
         回滚后端走 make-qr.mjs 出二维码。标题用中性的「重新登录」。 */
      desc: '只重启 QQ 客户端（约 10~25 秒后 QQ 窗口弹出，手机扫码）。Molly 插件、网关和控制台都不重启，扫码完就恢复。'
    },
    {
      id: 'napcat/restart',
      title: '全量重启 QQ 客户端',
      desc: '连 QQ 后端一起重启，只在进程卡死、上面那条「重新登录」也不管用的时候用。',
      confirm: true,
      consequence: '会踢掉当前 QQ 登录：Molly 立刻掉线，必须重新扫码才能回来。'
    },
    {
      id: 'watchdog/status',
      title: '守护状态',
      desc: '读出守护的最新巡检状态与配置，原样显示在下面。'
    },
    {
      id: 'watchdog/once',
      title: '立即巡检一次',
      desc: '立刻巡检一次，最长等 120 秒。'
    },
    {
      id: 'watchdog/test-notify',
      title: '测试通知',
      desc: '发一条测试通知，确认 PushPlus 那条通路是通的。'
    },
    {
      id: 'watchdog/config',
      title: '改写守护配置',
      desc: '把 patch 合并写进守护配置（watchdog-config.json），只接受已知的键，写错会让守护按错误节奏巡检。',
      confirm: true,
      consequence: '会改写 watchdog-config.json：写错键名或数值会让守护按错误节奏巡检。',
      fields: [{ key: 'patch', label: 'patch（JSON）', type: 'textarea', cast: 'json', required: true, placeholder: '{"intervalMinutes": 10}' }]
    },
    {
      id: 'watchdog/task',
      title: '计划任务开关',
      desc: 'schtasks 改动 Windows 计划任务 Molly-Watchdog 的启用状态。',
      confirm: true,
      consequence: '会改动系统计划任务：禁用后 watchdog 不再自动巡检，Molly 掉线没人管。',
      fields: [{ key: 'enable', label: '目标状态', type: 'select', cast: 'bool', def: 'true', options: [{ value: 'true', label: '启用' }, { value: 'false', label: '禁用' }] }]
    },
    {
      id: 'process/start-napcat',
      title: '启动 QQ 客户端进程',
      desc: '拉起 QQ 后端和 QQ 客户端（不重启已有的）。',
      confirm: true,
      consequence: '如果 QQ 已经在跑，再拉一次可能端口冲突。'
    }
  ];

  function actionById(id) {
    for (var i = 0; i < ACTIONS.length; i++) {
      if (ACTIONS[i].id === id) return ACTIONS[i];
    }
    return null;
  }

  function fieldHtml(a, f) {
    var keyAttr = 'data-key="' + esc(f.key) + '"';
    var control;
    if (f.type === 'select') {
      control = '<select class="input" ' + keyAttr + '>' + f.options.map(function (o) {
        return '<option value="' + esc(o.value) + '"' + (o.value === f.def ? ' selected' : '') + '>' + esc(o.label) + '</option>';
      }).join('') + '</select>';
    } else if (f.type === 'textarea') {
      control = '<textarea class="input" rows="4" ' + keyAttr + ' placeholder="' + esc(f.placeholder || '') + '"></textarea>';
    } else {
      control = '<input class="input" type="' + (f.type === 'number' ? 'number' : 'text') + '" ' + keyAttr +
        ' placeholder="' + esc(f.placeholder || '') + '">';
    }
    return '<div class="field"><label class="field-label">' + esc(f.label) + '</label>' + control + '</div>';
  }

  /* 卡片右上角只给一个中文分类，不把内部接口名（例如 napcat/qr）暴露给用户 */
  function actionTag(a) {
    var prefix = String((a && a.id) || '').split('/')[0];
    var map = {
      plugin: '插件', napcat: 'QQ', watchdog: '守护', process: '进程',
      molly: 'Molly', memory: '记忆', stickers: '表情', gateway: '模型',
      pushplus: '通知', heartbeat: '心跳', pest: '状态'
    };
    return map[prefix] || '操作';
  }

  function actionCardHtml(a) {
    var fields = (a.fields || []).map(function (f) { return fieldHtml(a, f); }).join('');
    return '<article class="card action-card" data-action="' + esc(a.id) + '">' +
      '<div class="action-head">' +
        '<h2 class="card-title">' + esc(a.title) + '</h2>' +
        '<span class="action-tag">' + esc(actionTag(a)) + '</span>' +
      '</div>' +
      '<p class="action-desc">' + esc(a.desc) + '</p>' +
      (a.consequence ? '<p class="action-consequence">⚠ ' + esc(a.consequence) + '</p>' : '') +
      '<div class="action-fields">' + fields + '</div>' +
      '<div class="action-foot">' +
        '<button class="btn ' + (a.confirm ? 'btn-danger' : 'btn-primary') + ' action-run" type="button">' +
          (a.confirm ? '执行（需确认）' : '执行') + '</button>' +
      '</div>' +
      '<div class="action-result" hidden></div>' +
      '</article>';
  }

  function initActions() {
    var grid = $('#actionGrid');
    if (!grid) return;
    grid.innerHTML = ACTIONS.map(actionCardHtml).join('');
    grid.addEventListener('click', function (ev) {
      var target = ev.target;
      if (!target || !target.closest) return;
      var btn = target.closest('.action-run');
      if (!btn) return;
      var card = btn.closest('.action-card');
      if (!card) return;
      executeCard(card);
    });
  }

  function collectBody(card, a) {
    var body = {};
    (a.fields || []).forEach(function (f) {
      var node = card.querySelector('[data-key="' + f.key + '"]');
      if (!node) return;
      var raw = String(node.value === undefined ? '' : node.value).trim();
      if (!raw) {
        if (f.required) throw new Error('请填写「' + f.label + '」');
        return;
      }
      if (f.cast === 'bool') {
        body[f.key] = raw === 'true';
      } else if (f.cast === 'number') {
        var n = Number(raw);
        if (!isFinite(n)) throw new Error('「' + f.label + '」必须是数字');
        body[f.key] = n;
      } else if (f.cast === 'json') {
        try {
          body[f.key] = JSON.parse(raw);
        } catch (err) {
          throw new Error('「' + f.label + '」不是合法 JSON：' + err.message);
        }
      } else {
        body[f.key] = raw;
      }
    });
    return body;
  }

  function showInlineError(card, msg) {
    var box = card.querySelector('.action-result');
    if (!box) return;
    box.hidden = false;
    box.innerHTML = '<div class="ar-head">' + pill('idle', '未执行') + '</div>' +
      '<p class="ar-error">' + esc(msg) + '</p>';
  }

  function executeCard(card) {
    var id = card.getAttribute('data-action');
    var a = actionById(id);
    if (!a) return;
    var body;
    try {
      body = collectBody(card, a);
    } catch (err) {
      showInlineError(card, err.message);
      return;
    }
    if (a.confirm) {
      var msg = '确定要执行「' + a.title + '」吗？\n\n' + (a.consequence || a.desc) + '\n\n（这一步不可撤销）';
      var yes = false;
      try { yes = window.confirm(msg); } catch (e) { yes = false; }
      if (!yes) {
        showInlineError(card, '已取消，没有执行。');
        return;
      }
      body.confirm = true;
    }
    runAction(id, body, {
      btn: card.querySelector('.action-run'),
      box: card.querySelector('.action-result')
    });
  }

  /* ---------------- 动作执行（执行块 / 快捷动作共用） ---------------- */

  function setBusy(btn, busy) {
    if (!btn) return;
    if (busy) {
      if (!btn.getAttribute('data-label')) btn.setAttribute('data-label', btn.textContent);
      btn.disabled = true;
      btn.classList.add('is-loading');
    } else {
      btn.disabled = false;
      btn.classList.remove('is-loading');
      var label = btn.getAttribute('data-label');
      if (label) btn.textContent = label;
    }
  }

  function runAction(actionId, body, opts) {
    opts = opts || {};
    var btn = opts.btn || null;
    var box = opts.box || null;
    var started = Date.now();

    setBusy(btn, true);
    if (box) {
      box.hidden = false;
      box.innerHTML = '<div class="ar-head">' + pill('idle', '执行中…') + '</div>';
    }

    fetch('/api/action/' + encodeURIComponent(actionId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) {
      return r.json().catch(function () {
        return { ok: false, error: '服务端返回的不是 JSON（HTTP ' + r.status + '）' };
      }).then(function (j) {
        j.__http = r.status;
        return j;
      });
    }).catch(function (err) {
      return {
        ok: false,
        error: '请求失败：' + (err && err.message ? err.message : String(err)),
        durationMs: Date.now() - started
      };
    }).then(function (res) {
      if (!res || typeof res !== 'object') res = { ok: false, error: '响应为空' };
      if (res.durationMs === undefined) res.durationMs = Date.now() - started;
      if (box) safe(function () { showResult(box, res); });
      setBusy(btn, false);
      if (res.ok) {
        var acted = actionById(actionId);
        toast(actionId === 'napcat/qr'
          ? '已触发重新登录 QQ，等窗口弹出扫码'
          : ('已执行：' + (acted && acted.title ? acted.title : '该操作')));
        if (actionId === 'napcat/qr') safe(poll);   /* 立刻刷一遍状态条，别等 4 秒 */
      } else toast('失败：' + (res.error || '未知错误'));
    });
  }

  function showResult(box, res) {
    var ok = res.ok === true;
    var stdout = typeof res.stdout === 'string' ? res.stdout : '';
    var tail = stdout.length > 6000 ? '…（已截断前段）\n' + stdout.slice(-6000) : stdout;
    var dataStr = res.data === undefined || res.data === null ? '' : JSON.stringify(res.data, null, 2);
    var head = '<div class="ar-head">' + pill(ok ? 'ok' : 'bad', ok ? '成功' : '失败') +
      (res.durationMs !== undefined ? '<span class="ar-meta mono">' + num(res.durationMs, 0) + ' ms</span>' : '') +
      (res.__http ? '<span class="ar-meta mono">HTTP ' + num(res.__http, 0) + '</span>' : '') +
      '</div>';

    var html = head;
    if (!ok && res.error) html += '<p class="ar-error">' + esc(res.error) + '</p>';

    var data = res.data || {};
    if (ok && data.png) {
      html += '<img class="ar-qr" src="' + esc(data.png) + '?t=' + Date.now() + '" alt="登录二维码">';
    }
    if (ok && data.url) {
      html += '<p class="ar-meta">链接：<a href="' + esc(data.url) + '" target="_blank" rel="noreferrer">' + esc(data.url) + '</a></p>';
    }
    if (ok && data.hint) {
      /* 重新登录是「触发计划任务」而不是「生成一张码」，服务端会带一句人话解释，别让它埋在 JSON 里 */
      html += '<p class="ar-hint">' + esc(String(data.hint)) + '</p>';
    }

    if (tail) {
      html += '<details class="ar-details"' + (ok ? '' : ' open') + '>' +
        '<summary>stdout 尾部（' + tail.split('\n').length + ' 行）</summary>' +
        '<pre>' + esc(tail) + '</pre></details>';
    }
    if (dataStr) {
      html += '<details class="ar-details"' + (ok ? '' : ' open') + '>' +
        '<summary>data</summary><pre>' + esc(dataStr) + '</pre></details>';
    }

    box.innerHTML = html;
    box.hidden = false;
  }

  /* ---------------- 快捷动作绑定 ---------------- */

  function bindQuickActions() {
    // 工作流与研究测试只在 DSH 执行，此处不绑定第二套执行入口。
    var wdStatus = $('#wdStatus');
    if (wdStatus) {
      wdStatus.addEventListener('click', function () {
        runAction('watchdog/status', {}, { btn: wdStatus, box: $('#wdOut') });
      });
    }
    var wdOnce = $('#wdOnce');
    if (wdOnce) {
      wdOnce.addEventListener('click', function () {
        runAction('watchdog/once', {}, { btn: wdOnce, box: $('#wdOut') });
      });
    }
    var wdNotify = $('#wdNotify');
    if (wdNotify) {
      wdNotify.addEventListener('click', function () {
        runAction('watchdog/test-notify', {}, { btn: wdNotify, box: $('#wdOut') });
      });
    }
    var wdLogs = $('#wdLogs');
    if (wdLogs) wdLogs.addEventListener('click', function () { openDrawer('watchdog'); });

    /* 骂人模式卡片：内容每轮重绘，用事件委托，不用重绑 */
    var pestBox = $('#pestCards');
    if (pestBox) {
      pestBox.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.closest) return;
        if (t.closest('.js-pest-toggle')) {
          setPestEnabled(!(pestLast && pestLast.enabled === true));
          return;
        }
        if (t.closest('.js-pest-word')) copyPestWord();
      });
    }

    /* 登录页：生成 / 换一张、刷新状态、复制链接、失败重试、总览黄条 */
    var loginGen = $('#loginGen');
    if (loginGen) loginGen.addEventListener('click', function () { generateQr(); });

    var loginRefresh = $('#loginRefresh');
    if (loginRefresh) {
      loginRefresh.addEventListener('click', function () {
        poll();
        safe(renderLogin);
      });
    }

    var loginCopy = $('#loginCopy');
    if (loginCopy) loginCopy.addEventListener('click', copyLoginUrl);

    var loginErr = $('#loginError');
    if (loginErr) {
      /* 「重试」是错误条重绘时生成的，用委托才不用每次重绑 */
      loginErr.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('#loginRetry') : null;
        if (b) generateQr();
      });
    }

    var ovBanner = $('#ovLoginBanner');
    if (ovBanner) {
      ovBanner.addEventListener('click', function (ev) {
        ev.preventDefault();
        /* 去「QQ 连接」页看状态和下一步：SnowLuma 后端不能现场出二维码，
           所以这里不再自动「生成」，否则用户会以为闪一下就有码可扫。 */
        if (location.hash === '#/qq') setPage('qq');
        else location.hash = '#/qq';
      });
    }
  }

  /* ---------------- 日志抽屉 ---------------- */

  function openDrawer(source) {
    var drawer = $('#drawer');
    var fab = $('#logFab');
    if (!drawer) return;
    if (source) {
      var sel = $('#logSource');
      if (sel) sel.value = source;
    }
    drawer.hidden = false;
    if (fab) fab.hidden = true;
    loadLogs();
    if (!logTimer) logTimer = setInterval(loadLogs, LOG_POLL_MS);
  }

  function closeDrawer() {
    var drawer = $('#drawer');
    var fab = $('#logFab');
    if (drawer) drawer.hidden = true;
    if (fab) fab.hidden = false;
    if (logTimer) {
      clearInterval(logTimer);
      logTimer = null;
    }
  }

  function loadLogs() {
    var body = $('#logBody');
    var path = $('#logPath');
    var sel = $('#logSource');
    if (!body || !sel) return;
    var source = sel.value || 'watchdog';
    fetch('/api/logs?source=' + encodeURIComponent(source) + '&tail=200', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.ok === false) throw new Error((j && j.error) || '读取失败');
        var lines = Array.isArray(j.lines) ? j.lines : [];
        var nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
        body.textContent = lines.length
          ? lines.join('\n')
          : '（' + (j.note || '暂无日志') + '）';
        if (path) path.textContent = j.path || '';
        if (nearBottom) body.scrollTop = body.scrollHeight;
      })
      .catch(function (err) {
        if (path) path.textContent = '';
        body.textContent = '日志读取失败：' + (err && err.message ? err.message : String(err));
      });
  }

  /* ---------------- 轮询 ---------------- */

  /* 前端版本自愈：服务端每次请求现算 build（console.js/css 的 mtime+size 短哈希），
     并注入到 index.html 的 window.__MOLLY_BUILD__。浏览器里长期开着的窗口不会自己
     加载新代码（旧 bug：卡片区停在「等待数据」要人工 Ctrl+F5），这里比对不一致就 reload。 */
  var RELOAD_GUARD_KEY = 'molly.console.reloadAt';

  /* 60 秒内最多 reload 一次：万一服务端注入失效导致版本永远对不上，也不会每 4 秒刷屏 */
  function reloadAllowed() {
    try {
      var last = Number(window.sessionStorage.getItem(RELOAD_GUARD_KEY) || 0);
      if (last && Date.now() - last < 60000) return false;
      window.sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()));
    } catch (err) {
      /* 隐私模式拿不到 sessionStorage：照常允许 */
    }
    return true;
  }

  function maybeReloadForNewBuild(ov) {
    try {
      if (state.reloading) return;
      var serverBuild = String((ov && ov.build) || (ov && ov.plugin && ov.plugin.build) || '');
      if (!serverBuild || serverBuild === '0') return;
      var pageBuild = String(window.__MOLLY_BUILD__ || '');
      if (pageBuild === serverBuild) return;
      if (!reloadAllowed()) return;
      state.reloading = true;
      console.warn('[molly-console] 前端文件已更新（' + (pageBuild || '旧页面未注入') + ' -> ' + serverBuild + '），自动刷新一次');
      setTimeout(function () { location.reload(); }, 300);
    } catch (err) {
      console.warn('[molly-console] 版本比对失败：', err);
    }
  }

  function poll() {
    fetch('/api/overview', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (j) {
        if (!j || j.ok === false) throw new Error((j && j.error) || '接口返回失败');
        state.overview = j;
        state.lastOkAt = Date.now();
        state.lastError = null;
        maybeReloadForNewBuild(j);
        safe(renderTop);
        safe(renderPageNow);
    revealPage(name);
      })
      .catch(function (err) {
        /* 失败不清空界面：只标红状态条，旧数据继续留着 */
        state.lastError = err && err.message ? err.message : String(err);
        safe(renderTop);
      });
  }

  /* 「刷新」按钮以前只 poll() 一下 overview，页内数据（在线时间、待核实、表情包…）
     根本不动，主人点了以为坏了。现在按当前页把该页的数据源强制重拉。 */
  function reloadPageData(notify) {
    poll();
    var p = state.page;
    if (p === 'online') loadOnline(true);
    else if (p === 'memory') { loadMemory(true); loadMemoryReadOnly(); }
    else if (p === 'pending') loadPending(true);
    else if (p === 'stickers') loadStickers(true);
    else if (p === 'switches') loadSwitches();
    else if (p === 'ops') { loadOpsHeartbeat(); if ($('#opsLogBody')) loadOpsLogs(); }
    else if (p === 'external') loadExternal();
    else if (p === 'qq') enterLoginPage();
    else if (p === 'settings') refreshSleep();
    else if (p === 'about') loadHealth();
    if (notify) toast('已刷新当前页');
  }

  function startTimers() {
    stopTimers();
    pollTimer = setInterval(poll, POLL_MS);
    tickTimer = setInterval(function () { safe(updateLinkPill); }, 1000);
    /* 待核实计数单独一条慢轮询：它只在需要时读一遍，不跟 4 秒的 overview 绑在一起 */
    pendTimer = setInterval(function () { safe(pollPending); }, PEND_POLL_MS);
    /* 在线时间：停在那一页时才每 30 秒自己拉一次（后端也有 30 秒缓存），
       切走就停，别在后台白打插件。 */
    onlineTimer = setInterval(function () {
      if (state.page !== 'online') return;
      if (document.visibilityState !== 'visible') return;
      if (state.online && state.online.loading) return;
      loadOnline(true);
    }, ONLINE_POLL_MS);
  }

  function stopTimers() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (pendTimer) { clearInterval(pendTimer); pendTimer = null; }
    if (onlineTimer) { clearInterval(onlineTimer); onlineTimer = null; }
  }

  /* ---------------- 运维 / 外部服务（task-58） ----------------
     两页都只调 /api/action/*，不新增接口：服务端动作在 task-57 已就位。
     主人定的硬规矩（m00223）：
       - 停 / 重启 Molly 只做页内确认弹层，不做「输入 RESTART」二次保险
       - 日志只在页面里看和复制，不提供下载
       - 切模型只在控制台（令牌只待在服务端）
     ------------------------------------------------------------------------ */

  /* 页内确认弹层。为什么不用 window.confirm：它会卡住整页、样式不可控，
     而且在某些壳里会被静默吞掉；确认文案与后果应该由调用点写清楚。 */
  var confirmCb = null;

  function openConfirm(opts) {
    opts = opts || {};
    var mask = $('#confirmSheet');
    var title = $('#confirmTitle');
    var body = $('#confirmBody');
    var ok = $('#confirmOk');
    var cancel = $('#confirmCancel');
    if (!mask || !title || !body || !ok || !cancel) {
      /* 弹层被改坏了也别静默：退回原生确认，至少动作还能执行 */
      if (window.confirm((opts.title || '确认') + '\n\n' + (opts.desc || ''))) {
        if (typeof opts.onYes === 'function') opts.onYes();
      }
      return;
    }
    confirmCb = typeof opts.onYes === 'function' ? opts.onYes : null;
    title.textContent = opts.title || '确认';
    body.innerHTML = '<p class="confirm-desc">' + esc(opts.desc || '') + '</p>' +
      (Array.isArray(opts.items) && opts.items.length
        ? '<ul class="confirm-list">' + opts.items.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>'
        : '');
    ok.textContent = opts.okText || '确认执行';
    ok.className = 'btn ' + (opts.danger === false ? 'btn-primary' : 'btn-danger');
    cancel.textContent = opts.cancelText || '取消';
    mask.hidden = false;
    try { ok.focus(); } catch (err) { /* 聚焦失败不影响执行 */ }
  }

  function closeConfirm() {
    confirmCb = null;
    var mask = $('#confirmSheet');
    if (mask) mask.hidden = true;
  }

  function fireConfirm() {
    var fn = confirmCb;
    closeConfirm();
    if (fn) fn();
  }

  /* ---------------- 运维 ---------------- */

  function pushPlusCard() {
    var p = state.ops.push;
    var on = !!(p && p.enabled);
    return card('PushPlus 推送', [
      kv('状态', p ? (on ? pill('ok', '已开启') : pill('idle', '已关闭')) : '未知'),
      kv('Token', p ? (p.hasToken ? '<span class="mono">' + esc(p.token) + '</span>' : '未配置') : '—'),
      '<div class="row-actions"><button class="btn btn-ghost btn-sm" type="button" id="opsPushToggle" data-enabled="' +
        (on ? '1' : '0') + '">' + (on ? '关掉推送' : '打开推送') + '</button></div>'
    ].join(''));
  }

  function heartbeatKv(hb, hbError) {
    if (!hb) {
      return kv('本地推送', hbError ? '<span class="is-bad">' + esc(hbError) + '</span>' : '正在读取…') +
        kv('服务器', '—');
    }
    var local = hb.local || null;
    var remote = hb.remote || {};
    return kv('本地推送', local
        ? (local.ok ? pill('ok', '正常') : pill('warn', '失败 ' + num(local.fails, 0) + ' 次'))
        : pill('idle', '还没有记录')) +
      kv('最近推送', local && local.lastAt ? fmtStamp(local.lastAt) : '—') +
      kv('服务器', remote.ok
        ? pill(remote.stale ? 'warn' : 'ok', remote.stale ? '可达（数据偏旧）' : '可达')
        : pill('bad', esc(remote.error || '不可达'))) +
      kv('服务器延迟', remote.ok && remote.ageSeconds !== null ? mono(remote.ageSeconds) + ' 秒前收到' : '—');
  }

  function renderOps() {
    var box = $('#opsCards');
    if (!box) return;
    var ov = state.overview;
    if (!ov) { setHtml(box, card('等待数据', '<p class="card-sub">正在连接控制台服务…</p>')); return; }

    var pl = ov.plugin || {};
    var nc = ov.napcat || {};
    var wd = ov.watchdog || {};
    var q = qqStatus(ov);
    var linkReady = !!(pl.link && pl.link.ready);
    var linkState = (pl.link && pl.link.state) || 'unknown';

    setHtml(box, [
      card('Molly 进程', [
        kv('插件', pl.reachable ? (pl.enabled ? pill('ok', '已加载') : pill('warn', '已停用')) : pill('bad', '不可达')),
        kv('QQ 连接', linkReady ? pill('ok', '在线') : pill('warn', esc(linkState))),
        kv('QQ 号', pl.bot && pl.bot.userId ? '<span class="mono">' + esc(pl.bot.userId) + '</span>' : '—'),
        kv('昵称', pl.bot && pl.bot.nickname ? esc(pl.bot.nickname) : '—'),
        kv('今天消息', pl.metrics && pl.metrics.messages !== null ? mono(pl.metrics.messages) : '—')
      ].join('')),
      card('QQ 客户端（' + qqBackendLabel(q) + '）', [
        kv('Molly 链路', q.bridgeOnline ? pill('ok', '在线') : pill('warn', esc(q.bridgeState || '未连上'))),
        kv('客户端进程', q.clientReachable ? pill('ok', '在跑') : pill('bad', '探测不到')),
        kv('登录态', q.isLogin ? pill('ok', '已登录') : pill('warn', '未登录')),
        kv('阶段', nc.loginPhase ? val(nc.loginPhase) : '—'),
        q.backend === 'snowluma'
          ? (nc.webui
            ? kv('WebUI', '<a href="' + esc(nc.webui) + '" target="_blank" rel="noreferrer">' + esc(nc.webui) + '</a>')
            : '')
          : kv('WebUI', nc.reachable ? pill('ok', '可达') : pill('bad', '不可达'))
      ].join('')),
      card('守护', [
        kv('watchdog', wd.reachable ? pill('ok', '可达') : pill('bad', '不可达')),
        kv('计划任务', wd.taskEnabled === false ? pill('warn', '已禁用') : pill('ok', '已启用')),
        kv('上次巡检', wd.lastRun ? fmtStamp(wd.lastRun) : '—'),
        kv('最近结论', wd.lastResult ? esc(wd.lastResult) : '—')
      ].join('')),
      card('心跳 / 中继', heartbeatKv(state.ops.hb, state.ops.hbError)),
      pushPlusCard()
    ].join(''));
  }

  function loadOpsHeartbeat() {
    /* 心跳和推送状态一起取：两者都只读，且都只在进页 / 手动刷新时拉一次 */
    Promise.all([
      apiPost('heartbeat/status', {}),
      apiPost('pushplus/status', {})
    ]).then(function (all) {
      var hb = all[0] || {};
      var pp = all[1] || {};
      state.ops.hbAt = Date.now();
      if (hb.ok) { state.ops.hb = hb.data || null; state.ops.hbError = null; }
      else { state.ops.hb = null; state.ops.hbError = hb.error || '心跳接口失败'; }
      if (pp.ok) { state.ops.push = pp.data || null; }
      safe(renderOps);
    });
  }

  function loadOpsLogs() {
    var body = $('#opsLogBody');
    var pathEl = $('#opsLogPath');
    var sel = $('#opsLogSource');
    if (!body) return;
    var source = (sel && sel.value) || 'watchdog';
    body.textContent = '（加载中…）';
    fetch('/api/logs?source=' + encodeURIComponent(source) + '&tail=200', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || j.ok === false) throw new Error((j && j.error) || '读取失败');
        var lines = Array.isArray(j.lines) ? j.lines : [];
        body.textContent = lines.length ? lines.join('\n') : '（' + (j.note || '暂无日志') + '）';
        if (pathEl) pathEl.textContent = j.path || '';
        body.scrollTop = body.scrollHeight;
      })
      .catch(function (err) {
        if (pathEl) pathEl.textContent = '';
        body.textContent = '日志读取失败：' + (err && err.message ? err.message : String(err));
      });
  }

  function copyOpsLogs() {
    var body = $('#opsLogBody');
    if (!body) return;
    var text = body.textContent || '';
    if (!text || text.indexOf('尚未加载') >= 0 || text.indexOf('加载中') === 0) {
      toast('先点「加载」把日志读出来');
      return;
    }
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      toast('当前环境不支持剪贴板');
      return;
    }
    navigator.clipboard.writeText(text).then(function () {
      toast('日志已复制（' + text.length + ' 字符）');
    }).catch(function (err) {
      toast('复制失败：' + (err && err.message ? err.message : '浏览器拒绝'));
    });
  }

  function opsStartMolly() {
    /* 启动不破坏任何东西，不需要确认；跑完 overview 会自己跟上 */
    runAction('molly/start', {}, { btn: $('#opsStart'), box: $('#opsOut') });
  }

  function opsStopMolly() {
    openConfirm({
      title: '停止 Molly',
      desc: '会停掉 QQ 客户端和它的连接服务，Molly 立刻掉线。',
      items: [
        '只停 QQ 客户端和它的连接服务；DSH 宿主、网关、控制台本身不动',
        '再要说话得重新启动，可能需要重新扫码'
      ],
      okText: '停掉',
      onYes: function () {
        runAction('molly/stop', { confirm: true }, { btn: $('#opsStop'), box: $('#opsOut') });
      }
    });
  }

  function opsRestartMolly() {
    openConfirm({
      title: '重启 Molly',
      desc: '先停 QQ 客户端和它的连接服务，等 3 秒再重新拉起。中间会有一段空窗。',
      items: ['重启期间消息不会回应', '拉起成功与否看下面结果里的 tail'],
      okText: '重启',
      onYes: function () {
        runAction('molly/restart', { confirm: true }, { btn: $('#opsRestart'), box: $('#opsOut') });
      }
    });
  }

  /* ---------------- 外部服务 ---------------- */

  function loadExternal() {
    if (state.ext.loading) return;
    state.ext.loading = true;
    safe(renderExternal);
    var jobs = [
      apiPost('gateway/usage', {}).then(function (res) {
        if (res.ok) { state.ext.usage = res.data || null; state.ext.usageError = null; }
        else { state.ext.usage = null; state.ext.usageError = res.error || '网关用量读取失败'; }
      }),
      apiPost('gateway/models', {}).then(function (res) {
        if (res.ok) { state.ext.models = res.data || null; state.ext.modelsError = null; }
        else { state.ext.models = null; state.ext.modelsError = res.error || '模型清单读取失败'; }
      }),
      apiPost('heartbeat/status', {}).then(function (res) {
        if (res.ok) { state.ext.hb = res.data || null; state.ext.hbError = null; }
        else { state.ext.hb = null; state.ext.hbError = res.error || '心跳接口失败'; }
      })
    ];
    Promise.all(jobs).then(function () {
      state.ext.loading = false;
      state.ext.at = Date.now();
      safe(renderExternal);
      safe(fillModelSelects);
    });
  }

  function byModelHtml(byModel) {
    var keys = Object.keys(byModel || {});
    if (!keys.length) return '<p class="card-sub">网关照没有按模型统计。</p>';
    return '<div class="ext-table">' + keys.map(function (k) {
      var v = byModel[k] || {};
      return '<div class="ext-row">' +
        '<span class="mono">' + esc(k) + '</span>' +
        '<span class="mono">' + num(v.requests, 0) + ' 次</span>' +
        '<span class="mono">' + num(v.credit, 2) + ' 分</span>' +
        '</div>';
    }).join('') + '</div>';
  }

  function renderExternal() {
    var box = $('#extCards');
    if (!box) return;
    var ext = state.ext;
    if (!ext.at && ext.loading) {
      setHtml(box, card('读取中', '<p class="card-sub">正在读网关与中继…</p>'));
      return;
    }
    if (!ext.at) {
      setHtml(box, card('还没读到', '<p class="card-sub">点右上角「刷新」读一次网关与中继。</p>'));
      return;
    }

    var u = ext.usage;
    var usageCard = ext.usageError
      ? card('网关用量', '<p class="ar-error">' + esc(ext.usageError) + '</p>')
      : card('网关用量', u ? [
          kv('请求数', mono(u.requests)),
          kv('错误数', mono(u.errors)),
          kv('积分', mono(u.credit)),
          kv('成本', u.costCny !== null ? '¥' + num(u.costCny, 2) : '—'),
          kv('总 Token', mono(u.totalTokens)),
          kv('缓存命中', u.totalTokens && u.cachedTokens !== null
            ? '<span class="mono">' + (u.cachedTokens / u.totalTokens * 100).toFixed(1) + '%</span>'
            : '—'),
          kv('统计起点', u.since ? fmtStamp(u.since) : '—')
        ].join('') : '<p class="card-sub">没有数据。</p>');

    var m = ext.models;
    var modelsCard = ext.modelsError
      ? card('网关模型', '<p class="ar-error">' + esc(ext.modelsError) + '</p>')
      : card('网关模型', m && Array.isArray(m.items) && m.items.length
          ? '<div class="ext-table">' + m.items.map(function (x) {
              return '<div class="ext-row"><span class="mono">' + esc(x.id) + '</span>' +
                '<span class="mono">' + esc(x.ownedBy || '—') + '</span>' +
                '<span class="mono">' + (x.supportsVision === true ? '看图' : (x.supportsVision === false ? '不看图' : '—')) + '</span></div>';
            }).join('') + '</div>'
          : '<p class="card-sub">没有可用模型。</p>');

    var remote = (ext.hb && ext.hb.remote) || {};
    var relayCard = card('服务器中继', [
      kv('地址', remote.relayBase ? '<span class="mono">' + esc(remote.relayBase) + '</span>' : '—'),
      kv('状态', remote.ok ? pill(remote.stale ? 'warn' : 'ok', remote.stale ? '可达（数据偏旧）' : '可达')
        : pill('bad', esc(remote.error || '不可达'))),
      kv('水位', remote.level ? esc(remote.level) : '—'),
      kv('数据年龄', remote.ageSeconds !== null && remote.ageSeconds !== undefined ? mono(remote.ageSeconds) + ' 秒' : '—'),
      kv('服务器收到', remote.lastReceivedAt ? fmtStamp(remote.lastReceivedAt) : '—')
    ].join(''));

    setHtml(box, [usageCard, modelsCard, relayCard].join(''));
  }

  function fillModelSelects() {
    var ids = ((state.ext.models && state.ext.models.items) || [])
      .map(function (x) { return x.id; })
      .filter(Boolean);
    ['#extModelChat', '#extModelWork', '#extModelCode'].forEach(function (sel) {
      var node = $(sel);
      if (!node) return;
      var keep = node.value;
      node.innerHTML = '<option value="">（不改）</option>' + ids.map(function (id) {
        return '<option value="' + esc(id) + '">' + esc(id) + '</option>';
      }).join('');
      if (keep) node.value = keep;
    });
    var now = $('#extModelNow');
    var cur = (state.overview && state.overview.plugin && state.overview.plugin.model) || '';
    if (now) now.textContent = cur ? '聊天当前：' + cur : '';
  }

  function saveModelChange() {
    var body = {};
    [['chat', '#extModelChat'], ['work', '#extModelWork'], ['code', '#extModelCode']].forEach(function (pair) {
      var node = $(pair[1]);
      var v = node && node.value ? String(node.value).trim() : '';
      if (v) body[pair[0]] = v;
    });
    if (!Object.keys(body).length) { toast('先选一个要换的模型'); return; }
    openConfirm({
      title: '切换模型',
      desc: '写进插件配置后立即生效，下一轮对话就用新模型。',
      items: Object.keys(body).map(function (k) { return k + ' → ' + body[k]; }),
      okText: '确认切换',
      danger: false,
      onYes: function () {
        runAction('plugin/model-set', body, { btn: $('#extModelSave'), box: $('#extOut') });
        /* 插件成功后 overview 需要一次刷新，顶部模型胶囊才跟上 */
        setTimeout(function () { poll(); }, 1200);
      }
    });
  }

  function bindOpsEvents() {
    var start = $('#opsStart');
    if (start) start.addEventListener('click', opsStartMolly);
    var stop = $('#opsStop');
    if (stop) stop.addEventListener('click', opsStopMolly);
    var restart = $('#opsRestart');
    if (restart) restart.addEventListener('click', opsRestartMolly);

    var logLoad = $('#opsLogLoad');
    if (logLoad) logLoad.addEventListener('click', loadOpsLogs);
    var logCopy = $('#opsLogCopy');
    if (logCopy) logCopy.addEventListener('click', copyOpsLogs);
    var logSource = $('#opsLogSource');
    if (logSource) logSource.addEventListener('change', loadOpsLogs);

    /* 推送开关在卡片重绘后还在，用事件委托 */
    var opsBox = $('#opsCards');
    if (opsBox) {
      opsBox.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('#opsPushToggle') : null;
        if (!b) return;
        var next = b.getAttribute('data-enabled') !== '1';
        apiPost('pushplus/toggle', { enabled: next }).then(function (res) {
          if (res.ok) {
            state.ops.push = res.data || null;
            toast(next ? '推送已打开' : '推送已关闭');
          } else {
            toast('切换失败：' + (res.error || '未知错误'));
          }
          safe(renderOps);
        });
      });
    }

    var extReload = $('#extReload');
    if (extReload) extReload.addEventListener('click', function () { loadExternal(); });
    var save = $('#extModelSave');
    if (save) save.addEventListener('click', saveModelChange);

    var okBtn = $('#confirmOk');
    if (okBtn) okBtn.addEventListener('click', fireConfirm);
    var cancelBtn = $('#confirmCancel');
    if (cancelBtn) cancelBtn.addEventListener('click', closeConfirm);
    var mask = $('#confirmSheet');
    if (mask) {
      mask.addEventListener('click', function (ev) { if (ev.target === mask) closeConfirm(); });
    }
  }

  /* ---------------- 发言开关（运行时热切换，不用重载插件） ---------------- */

  var SW_CAPS = ['reply', 'sticker', 'light', 'like', 'proactive', 'voice'];
  var SW_CAP_LABEL = {
    reply: '回话',
    sticker: '发表情包',
    light: '轻回应（单独甩图/表情）',
    like: '点赞',
    proactive: '主动搭话',
    voice: '发语音'
  };
  var SW_CAP_HINT = {
    reply: '关掉后只有 @ 或叫名字能让她开口（会带一句状态前缀）',
    sticker: '关掉后回复里不再夹表情包',
    light: '关掉后不会单独发一张图或一个表情就完事',
    like: '关掉后不再给群消息点赞',
    proactive: '关掉后不会自己找话说',
    voice: '关掉后不会再发语音（需要本机 python + edge-tts）'
  };

  function swFetch(url, opt) {
    return fetch(url, opt || {}).then(function (r) {
      return r.json().catch(function () {
        return { ok: false, error: '服务端返回非 JSON（HTTP ' + r.status + '）' };
      });
    }).catch(function (err) {
      return { ok: false, error: '请求失败：' + ((err && err.message) ? err.message : String(err)) };
    });
  }

  function swPost(path, body) {
    return swFetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  function loadSwitches() {
    if (state.sw.loading) return;
    state.sw.loading = true;
    state.sw.error = '';
    var gid = String(state.sw.group || '').replace(/[^0-9]/g, '');
    var url = '/api/plugin/switches' + (gid ? ('?gid=' + encodeURIComponent(gid)) : '');
    swFetch(url, { headers: { Accept: 'application/json' } }).then(function (res) {
      state.sw.loading = false;
      if (!res || !res.ok) {
        state.sw.error = (res && res.error) || '拉取开关失败';
      } else {
        state.sw.data = res.view || res.data || null;
      }
      if (state.page === 'switches') safe(renderSwitches);
    });
  }

  function swApplyResult(res) {
    state.sw.busy = false;
    if (!res || !res.ok) {
      toast('保存失败：' + ((res && res.error) || '未知错误'));
      if (state.page === 'switches') safe(renderSwitches);
      return;
    }
    if (res.view) state.sw.data = res.view;
    state.sw.error = '';
    safe(renderSwitches);
  }

  function swSet(path, value) {
    if (state.sw.busy) return;
    state.sw.busy = true;
    swPost('/api/plugin/switches/set', { path: path, value: value, gid: state.sw.group || '' }).then(swApplyResult);
  }

  function swToggleBtn(path, on) {
    var attrs = 'data-sw-act="set" data-path="' + esc(path) + '" data-value="' + (on ? '0' : '1') + '"';
    return '<button class="btn btn-xs ' + (on ? 'btn-primary' : 'btn-ghost') + '" type="button" ' + attrs + '>'
      + (on ? '开' : '关') + '</button>';
  }

  function swRow(label, valueHtml, hint) {
    return '<div class="kv"><span class="kv-k"' + (hint ? ' title="' + esc(hint) + '"' : '') + '>'
      + esc(label) + '</span><span class="kv-v">' + valueHtml + '</span></div>';
  }

  function swCapRows(prefix, caps) {
    return SW_CAPS.map(function (cap) {
      var on = !caps || caps[cap] !== false;
      return swRow(SW_CAP_LABEL[cap], swToggleBtn(prefix + '.' + cap, on), SW_CAP_HINT[cap]);
    }).join('');
  }

  function swMuteRow(m) {
    var until = Number(m && m.until) || 0;
    var left = '';
    if (until > 0) {
      var mins = Math.max(0, Math.round((until - Date.now() / 1000) / 60));
      left = mins > 0 ? (mins + ' 分钟后到期') : '已到期';
    }
    return '<div class="kv"><span class="kv-k mono">' + esc(String(m.scope || '')) + '</span><span class="kv-v">'
      + esc(left) + (m.note ? ' · ' + esc(String(m.note)) : '')
      + ' <button class="btn btn-xs btn-ghost" type="button" data-sw-act="unmute" data-scope="'
      + esc(String(m.scope || '')) + '">解除</button></span></div>';
  }

  function swAuditItem(a) {
    var v = a.value === null ? '（清除）' : (a.value === true ? '开' : (a.value === false ? '关' : String(a.value)));
    return '<div class="kv"><span class="kv-k mono">' + esc(fmtStamp(a.at)) + '</span><span class="kv-v">'
      + '<span class="mono">' + esc(String(a.path || '')) + '</span> → ' + esc(v)
      + (a.actor ? ' · ' + esc(String(a.actor)) : '') + '</span></div>';
  }

  function onSwAction(ev) {
    var target = ev.target;
    var el = target && target.closest ? target.closest('[data-sw-act]') : null;
    if (!el) return;
    var act = el.getAttribute('data-sw-act');
    if (act === 'set') {
      swSet(el.getAttribute('data-path'), el.getAttribute('data-value') === '1');
      return;
    }
    if (act === 'group-open') {
      var input = $('#swGroupInput');
      var gid = String((input && input.value) || el.getAttribute('data-gid') || '').replace(/[^0-9]/g, '');
      if (!gid) { toast('先填群号'); return; }
      state.sw.group = gid;
      state.sw.form.group = '';   /* 已打开该群，输入框回到显示当前群号 */
      safe(renderSwitches);
      loadSwitches();
      return;
    }
    if (act === 'group-remove') {
      var rid = String(el.getAttribute('data-gid') || state.sw.group || '').replace(/[^0-9]/g, '');
      if (!rid) return;
      if (!confirm('清除群 ' + rid + ' 的所有覆盖？')) return;
      state.sw.busy = true;
      swPost('/api/plugin/switches/set', { path: 'groups.' + rid, value: null, gid: rid }).then(function (res) {
        if (res && res.ok) state.sw.group = '';
        swApplyResult(res);
      });
      return;
    }
    if (act === 'cf-mode') {
      swSet('contentFilter.mode', el.getAttribute('data-mode'));
      return;
    }
    if (act === 'cf-max') {
      var mc = $('#swMaxChars');
      var n = mc ? Number(mc.value) : 180;
      if (!n || n < 60 || n > 2000) { toast('字数上限要在 60–2000 之间'); return; }
      swSet('contentFilter.maxChars', n);
      return;
    }
    if (act === 'mute') {
      var scopeEl = $('#swMuteScope');
      var scope = String((scopeEl && scopeEl.value) || '').trim().replace(/^group:/, '');
      if (!scope) { toast('先填 private 或群号'); return; }
      var minEl = $('#swMuteMinutes');
      var noteEl = $('#swMuteNote');
      var minutes = Number((minEl && minEl.value) || 30) || 30;
      var note = String((noteEl && noteEl.value) || '');
      state.sw.busy = true;
      swPost('/api/plugin/switches/mute', { scope: scope, minutes: minutes, note: note }).then(function (res) {
        if (res && res.ok) {
          /* 静音成功：清掉输入框草稿，避免下次重渲染又填回来 */
          state.sw.form.muteScope = '';
          state.sw.form.muteNote = '';
          state.sw.form.muteMinutes = 30;
        }
        swApplyResult(res);
      });
      return;
    }
    if (act === 'unmute') {
      var sc = String(el.getAttribute('data-scope') || '');
      if (!sc) return;
      state.sw.busy = true;
      swPost('/api/plugin/switches/unmute', { scope: sc }).then(swApplyResult);
      return;
    }
    if (act === 'reset') {
      if (!confirm('恢复默认：所有开关都打开，清空群级覆盖和临时静音？')) return;
      state.sw.busy = true;
      swPost('/api/plugin/switches/reset', {}).then(swApplyResult);
    }
  }

  /* 输入框草稿值：有缓存用缓存，没有用页面给的默认值 */
  function swFormVal(name, fallback) {
    var f = state.sw.form || {};
    return Object.prototype.hasOwnProperty.call(f, name) ? f[name] : fallback;
  }

  /* 正在输入框里打字时，跳过整页重渲染，别把光标和内容冲掉 */
  function swInputFocused() {
    var el = document.activeElement;
    if (!el) return false;
    var tag = String(el.tagName || '').toUpperCase();
    if (tag !== 'INPUT' && tag !== 'TEXTAREA') return false;
    var box = $('#swCards');
    return !!(box && box.contains(el));
  }

  function renderSwitches() {
    var box = $('#swCards');
    if (!box) return;
    var err = $('#swErr');
    if (err) {
      var msg = state.sw.error || '';
      err.hidden = !msg;
      err.textContent = msg;
    }
    var auditBox = $('#swAudit');
    var auditSub = $('#swAuditSub');
    if (!state.sw.data) {
      box.innerHTML = '<div class="card card-block"><p class="card-sub">'
        + (state.sw.loading ? '正在加载开关…' : '还没有数据，点右上角「重新加载」。') + '</p></div>';
      if (auditBox) auditBox.innerHTML = '<p class="card-sub">—</p>';
      return;
    }
    var d = state.sw.data;
    var sw = d.switches || {};
    var cards = [];

    cards.push(card('总开关', [
      swRow('全部发言', swToggleBtn('master', sw.master !== false),
        '关掉 = 全局静音：不回话、不发图、不点赞、不主动搭话'),
      '<p class="card-sub">审批、命令回复、重要通知不受影响。群聊被关时，@ 她或叫名字仍然会回一句（带状态前缀）。</p>',
      '<div class="row-actions" style="margin-top:6px"><button class="btn btn-sm btn-danger" type="button" data-sw-act="reset">恢复默认（全部打开）</button></div>'
    ].join('')));
    cards.push(card('私聊', swCapRows('private', sw.private)));
    cards.push(card('群聊（默认）', swCapRows('group', sw.group)));

    var groups = (sw.groups && typeof sw.groups === 'object') ? sw.groups : {};
    var gids = Object.keys(groups).sort();
    var gid = String(state.sw.group || '').replace(/[^0-9]/g, '');
    var gh = '';
    if (gids.length) {
      gh += '<div class="chips" style="margin-bottom:10px">' + gids.map(function (g) {
        return '<button class="chip ' + (g === gid ? 'is-active' : '') + '" type="button" data-sw-act="group-open" data-gid="'
          + esc(g) + '">群 ' + esc(g) + '</button>';
      }).join('') + '</div>';
    } else {
      gh += '<p class="card-sub">还没有群级覆盖，所有群都跟随「群聊（默认）」。</p>';
    }
    gh += '<div class="field"><div class="field-label">群号</div><div class="row-actions">'
      + '<input class="input input-sm" id="swGroupInput" inputmode="numeric" placeholder="例如 123456789" value="'
      + esc(swFormVal('group', gid)) + '">'
      + '<button class="btn btn-sm" type="button" data-sw-act="group-open">打开</button>'
      + (gid ? '<button class="btn btn-sm btn-ghost" type="button" data-sw-act="group-remove" data-gid="'
        + esc(gid) + '">清除该群覆盖</button>' : '')
      + '</div></div>';
    if (gid) {
      var eff = (d.effectiveGroup && typeof d.effectiveGroup === 'object') ? d.effectiveGroup : {};
      gh += '<p class="card-sub mono">群 ' + esc(gid) + ' 实际生效：' + SW_CAPS.map(function (cap) {
        return SW_CAP_LABEL[cap] + '=' + (eff[cap] !== false ? '开' : '关');
      }).join(' / ') + '</p>';
      gh += swCapRows('groups.' + gid, groups[gid] || {});
    }
    cards.push(card('群级覆盖', gh));

    var cf = sw.contentFilter || {};
    cards.push(card('群聊内容过滤', [
      swRow('过滤长日志/代码/路径', swToggleBtn('contentFilter.enabled', cf.enabled !== false),
        '群聊里把大段日志、代码、文件路径压短或直接不发'),
      '<div class="field"><div class="field-label">超长时怎么办</div><div class="row-actions">'
        + '<button class="btn btn-sm ' + (cf.mode === 'drop' ? 'btn-ghost' : 'btn-primary')
        + '" type="button" data-sw-act="cf-mode" data-mode="shorten">压成短句</button>'
        + '<button class="btn btn-sm ' + (cf.mode === 'drop' ? 'btn-primary' : 'btn-ghost')
        + '" type="button" data-sw-act="cf-mode" data-mode="drop">直接不发</button>'
        + '</div></div>',
      '<div class="field"><div class="field-label">压短后的字数上限（60–2000，默认 180）</div><div class="row-actions">'
        + '<input class="input input-sm" id="swMaxChars" type="number" min="60" max="2000" value="'
        + esc(swFormVal('cfMax', Number(cf.maxChars) || 180)) + '">'
        + '<button class="btn btn-sm" type="button" data-sw-act="cf-max">保存</button>'
        + '</div></div>'
    ].join('')));

    var mutes = Array.isArray(d.mutes) ? d.mutes : [];
    var mh = mutes.length ? mutes.map(swMuteRow).join('')
      : '<p class="card-sub">现在没有临时静音。</p>';
    mh += '<div class="field"><div class="field-label">加临时静音（到点自动恢复）</div><div class="row-actions">'
      + '<input class="input input-sm" id="swMuteScope" placeholder="private 或 群号" style="width:150px" value="'
      + esc(swFormVal('muteScope', '')) + '">'
      + '<input class="input input-sm" id="swMuteMinutes" type="number" min="1" max="10080" style="width:90px" value="'
      + esc(swFormVal('muteMinutes', 30)) + '"> 分钟'
      + '<input class="input input-sm" id="swMuteNote" placeholder="备注（可选）" style="width:160px" value="'
      + esc(swFormVal('muteNote', '')) + '">'
      + '<button class="btn btn-sm" type="button" data-sw-act="mute">静音</button>'
      + '</div><p class="field-hint">scope 写 private（私聊）或群号（群聊），例如 123456789。</p></div>';
    cards.push(card('临时静音', mh));

    box.innerHTML = cards.join('');

    var audit = Array.isArray(d.audit) ? d.audit : [];
    if (auditBox) {
      auditBox.innerHTML = audit.length
        ? audit.slice().reverse().map(swAuditItem).join('')
        : '<p class="card-sub">还没有改动记录。</p>';
    }
    if (auditSub) auditSub.textContent = '文件：' + (d.file || '—');
  }

  /* ---------------- 路由 ---------------- */

  function currentPage() {
    var h = String(location.hash || '').replace(/^#\/?/, '');
    /* 老链接兼容：#/napcat 是这一页改名前叫「QQ 连接」的地址，收藏夹里可能还留着 */
    if (h === 'napcat') h = 'qq';
    /* 「登录」页已并进「QQ 连接」：收藏夹里的 #/login 也落到同一页 */
    if (h === 'login') h = 'qq';
    return PAGES.indexOf(h) >= 0 ? h : 'overview';
  }

  /* 功能搜索只负责导航，不复制业务按钮，避免产生第二套状态与写入路径。 */
  var FEATURE_LINKS = [
    { page: 'overview', icon: '⌂', name: '总览', desc: 'Molly、QQ、守护和数据状态', keys: '首页 状态 在线 健康' },
    { page: 'chats', icon: '◌', name: '会话与消息', desc: '消息量、响应与学习器记录', keys: '聊天 回复 历史' },
    { page: 'memory', icon: '❀', name: 'Jasmine 记忆', desc: '搜索、新增、编辑和删除记忆', keys: '记住 事实 偏好 人物' },
    { page: 'pending', icon: '✓', name: '待核实', desc: '通过或丢弃待确认的记忆', keys: '审批 审核' },
    { page: 'stickers', icon: '☺', name: '表情包', desc: '上传、改关键词和整理表情', keys: '图片 gif 学习' },
    { page: 'switches', icon: '◫', name: '发言与互动', desc: '回话、轻回应、点赞、主动搭话和静音', keys: '开关 群聊 私聊 闭嘴' },
    { page: 'budget', icon: '◒', name: '积分与预算', desc: '每日额度、消耗与限制', keys: '费用 上限 用量' },
    { page: 'work', icon: '↗', name: '让她干活', desc: '指令、工作总线和研究测试', keys: '任务 执行 研究' },
    { page: 'qq', icon: '⌁', name: 'QQ 连接', desc: '连接诊断、重新登录与扫码', keys: '掉线 登录 二维码' },
    { page: 'watchdog', icon: '◎', name: '自动守护', desc: '巡检、通知与计划任务', keys: '监控 修复 免打扰' },
    { page: 'ops', icon: '↻', name: '进程与日志', desc: '启动、停止、重启和最近日志', keys: '运维 重启 关闭 排障' },
    { page: 'external', icon: '⊙', name: '模型与服务', desc: '模型选择、网关与外部用量', keys: '切换 deepseek 计费' },
    { page: 'settings', icon: '⚙', name: '偏好设置', desc: '作息时间与诊断信息', keys: '睡觉 起床 复制' },
    { page: 'about', icon: 'ⓘ', name: '关于', desc: '版本、构建、本机数据与联系方式', keys: '版本 更新 构建 联系 目录 许可' },
    { page: 'exec', icon: '⋯', name: '高级操作', desc: '全部底层执行块（仅供排障）', keys: '高级 action 配置' }
  ];
  function openCommand() {
    var mask = $('#commandModal');
    if (!mask) return;
    mask.hidden = false;
    var input = $('#commandInput');
    if (input) { input.value = ''; input.focus(); }
    renderCommandResults('');
  }
  function closeCommand() { var mask = $('#commandModal'); if (mask) mask.hidden = true; }

  /* 搜索 = 页面导航 + 一句话执行（2026-11-05 主人：功能太多、找起来不友好）。
     动作不复制第二套写入通路：挑中动作就跳到「高级操作」里那张卡并按卡片自己的
     规则跑（字段校验、危险动作的系统确认、结果区都还是同一份代码）。 */
  var commandMatches = [];
  var commandActive = 0;

  function commandEntries() {
    var out = [];
    FEATURE_LINKS.forEach(function (f) {
      out.push({ kind: 'page', page: f.page, icon: f.icon, name: f.name, desc: f.desc, group: '页面', keys: f.keys });
    });
    ACTIONS.forEach(function (a) {
      out.push({
        kind: 'action', id: a.id, icon: '▶', name: a.title, desc: a.desc, group: actionTag(a),
        keys: a.title + ' ' + a.desc + ' ' + actionTag(a) + ' 执行 动作 一键'
      });
    });
    return out;
  }

  function commandScore(e, q) {
    if (!q) return 1;
    var name = String(e.name || '').toLowerCase();
    var hay = (name + ' ' + String(e.desc || '') + ' ' + String(e.keys || '') + ' ' + String(e.group || '')).toLowerCase();
    if (name.indexOf(q) === 0) return 100;
    if (name.indexOf(q) >= 0) return 60;
    if (String(e.group || '').toLowerCase().indexOf(q) >= 0) return 30;
    if (hay.indexOf(q) >= 0) return 20;
    return 0;
  }

  function renderCommandResults(query) {
    var box = $('#commandResults');
    if (!box) return;
    var q = String(query || '').trim().toLowerCase();
    var scored = [];
    commandEntries().forEach(function (e) {
      var s = commandScore(e, q);
      if (s > 0) scored.push({ e: e, s: s });
    });
    scored.sort(function (a, b) { return b.s - a.s; });
    /* 同样的分组标题只能出现一次：先按「页面 / 各动作分类」切段，段内再按得分排 */
    var sections = [];
    var byGroup = {};
    scored.slice(0, 24).forEach(function (x) {
      var label = x.e.kind === 'page' ? '页面' : ('执行 · ' + x.e.group);
      if (!byGroup[label]) { byGroup[label] = { label: label, items: [], best: x.s }; sections.push(byGroup[label]); }
      byGroup[label].items.push(x.e);
    });
    commandMatches = [];
    sections.forEach(function (sec) { sec.items.forEach(function (e) { commandMatches.push(e); }); });
    commandActive = 0;
    if (!commandMatches.length) {
      box.innerHTML = '<div class="empty">没找到。试试「记忆」「连接」「守护」或「执行」。</div>';
      return;
    }
    var html = '';
    var lastGroup = '';
    var idx = -1;
    commandMatches.forEach(function (e) {
      idx += 1;
      if (e.group !== lastGroup) {
        html += '<div class="command-group">' + esc(e.kind === 'page' ? '页面' : ('执行 · ' + e.group)) + '</div>';
        lastGroup = e.group;
      }
      var i = idx;
      var cls = 'command-result' + (i === 0 ? ' is-active' : '');
      if (e.kind === 'page') {
        html += '<a class="' + cls + '" href="#/' + e.page + '" role="option">' +
          '<span aria-hidden="true">' + e.icon + '</span>' +
          '<span><strong>' + esc(e.name) + '</strong><small>' + esc(e.desc) + '</small></span>' +
          '<span>打开 ↗</span></a>';
      } else {
        html += '<button class="' + cls + ' command-action" type="button" role="option" data-action="' + esc(e.id) + '">' +
          '<span aria-hidden="true">' + e.icon + '</span>' +
          '<span><strong>' + esc(e.name) + '</strong><small>' + esc(e.desc) + '</small></span>' +
          '<span>执行 ↵</span></button>';
      }
    });
    box.innerHTML = html;
  }

  function commandSetActive(i) {
    var box = $('#commandResults');
    if (!box || !commandMatches.length) return;
    var rows = box.querySelectorAll('.command-result');
    if (!rows.length) return;
    commandActive = (i + rows.length) % rows.length;
    for (var k = 0; k < rows.length; k += 1) rows[k].classList.toggle('is-active', k === commandActive);
    if (rows[commandActive] && rows[commandActive].scrollIntoView) {
      try { rows[commandActive].scrollIntoView({ block: 'nearest' }); } catch (err) {}
    }
  }

  function commandChoose(i) {
    var e = commandMatches[typeof i === 'number' ? i : commandActive];
    if (!e) return;
    closeCommand();
    if (e.kind === 'page') { location.hash = '#/' + e.page; return; }
    runActionFromPalette(e.id);
  }

  function runActionFromPalette(actionId) {
    if (location.hash.indexOf('#/exec') !== 0) location.hash = '#/exec';
    setTimeout(function () {
      var card = document.querySelector('.action-card[data-action="' + actionId + '"]');
      if (!card) { toast('没找到这个动作，去「高级操作」里看看'); return; }
      card.classList.add('is-flash');
      setTimeout(function () { card.classList.remove('is-flash'); }, 1800);
      try { card.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (err) {}
      executeCard(card);
    }, prefReduceMotion() ? 80 : PAGE_LEAVE_MS + 160);
  }

  function bindCommandPalette() {
    var open = $('#navSearch'); var mask = $('#commandModal'); var input = $('#commandInput');
    var close = $('#commandClose'); var box = $('#commandResults');
    if (open) open.addEventListener('click', openCommand);
    if (close) close.addEventListener('click', closeCommand);
    if (input) input.addEventListener('input', function () { renderCommandResults(input.value); });
    if (box) box.addEventListener('click', function (e) {
      var row = e.target && e.target.closest ? e.target.closest('.command-result') : null;
      if (!row) return;
      e.preventDefault();
      var rows = box.querySelectorAll('.command-result');
      var idx = Array.prototype.indexOf.call(rows, row);
      commandChoose(idx >= 0 ? idx : 0);
    });
    if (mask) mask.addEventListener('click', function (e) { if (e.target === mask) closeCommand(); });
    document.addEventListener('keydown', function (e) {
      var isOpen = mask && !mask.hidden;
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 'k') { e.preventDefault(); openCommand(); return; }
      if (!isOpen) return;
      if (e.key === 'Escape') { e.preventDefault(); closeCommand(); }
      else if (e.key === 'ArrowDown') { e.preventDefault(); commandSetActive(commandActive + 1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); commandSetActive(commandActive - 1); }
      else if (e.key === 'Enter') { e.preventDefault(); commandChoose(commandActive); }
    });
  }

  function renderPageNow() {
    switch (state.page) {
      case 'overview': renderOverview(); break;
      case 'chats': renderChats(); break;
      case 'budget': renderBudget(); renderBudgetEditor(); break;
      case 'work': renderWork(); break;
      case 'watchdog': renderWatchdog(); break;
      case 'ops': renderOps(); break;
      case 'external': renderExternal(); break;
      case 'online': renderOnline(); break;
      /* 合并成一页：QQ 连接 = 链路状态 + 扫码登录（原独立「登录」页已删） */
      case 'qq': renderQq(); renderLogin(); break;
      case 'settings': renderSettings(); break;
      case 'about': renderAbout(); break;
      case 'switches': if (!swInputFocused()) renderSwitches(); break;
      default: break;
    }
  }

  /* THRM 式切页入场（2026-11-05）：内容卡按 80ms 阶梯、0.285s ease-out 淡入。
     动画只在切页时重放，4 秒轮询重绘不触发；prefers-reduced-motion 下由 CSS 关掉。 */
  function revealPage(name) {
    var sec = document.querySelector('.page[data-page="' + name + '"]');
    if (!sec) return;
    var kids = sec.children;
    var k = 0;
    for (var i = 0; i < kids.length; i += 1) {
      var el = kids[i];
      if (!el || el.classList.contains('page-head')) continue;
      el.style.setProperty('--reveal-i', String(Math.min(k, 6)));
      k += 1;
    }
    sec.classList.remove('is-revealing');
    void sec.offsetWidth;
    sec.classList.add('is-revealing');
  }

  /* 切页过渡（2026-11-05，按 THRM 的 AnimatePresence mode="wait" 复刻）：
     旧页 160ms 向上 -14px 淡出 → 新页 190ms 从 +18px 淡入，两者串行，
     缓动统一 cubic-bezier(.22,1,.36,1)。卡片另有 80ms 阶梯淡入（revealPage）。
     减少动态效果时不串行，直接切换。 */
  var PAGE_LEAVE_MS = 160;
  var pageSwapTimer = null;
  function prefReduceMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  function switchPageTo(name) {
    var secs = $$('.page');
    var next = null;
    var prev = null;
    for (var i = 0; i < secs.length; i += 1) {
      var s = secs[i];
      var isNext = s.getAttribute('data-page') === name;
      if (isNext) next = s;
      if (!s.hidden) prev = s;
    }
    if (pageSwapTimer) { clearTimeout(pageSwapTimer); pageSwapTimer = null; }
    for (var j = 0; j < secs.length; j += 1) secs[j].classList.remove('is-leaving', 'is-entering');
    if (!next) return;
    if (!prev || prev === next || prefReduceMotion()) {
      for (var k = 0; k < secs.length; k += 1) secs[k].hidden = secs[k] !== next;
      return;
    }
    prev.classList.add('is-leaving');
    for (var m = 0; m < secs.length; m += 1) {
      if (secs[m] !== prev && secs[m] !== next) secs[m].hidden = true;
    }
    pageSwapTimer = setTimeout(function () {
      pageSwapTimer = null;
      prev.hidden = true;
      prev.classList.remove('is-leaving');
      next.hidden = false;
      next.classList.add('is-entering');
      setTimeout(function () { next.classList.remove('is-entering'); }, 240);
      safe(renderPageNow);
      revealPage(name);
    }, PAGE_LEAVE_MS);
  }

  function setPage(name) {
    if (PAGES.indexOf(name) < 0) name = 'overview';
    state.page = name;
    $$('.nav-item').forEach(function (a) {
      a.classList.toggle('is-active', a.getAttribute('data-page') === name);
    });
    switchPageTo(name);
    safe(renderPageNow);
    /* 有出场动画时不在这里播入场：等换页完成（见 switchPageTo 回调）再播，
       否则入场动画会在 hidden 状态下空跑完。 */
    if (!pageSwapTimer) revealPage(name);
    if (name === 'memory') loadMemory();
    /* 进页签时强制拉一次：轮询只动数字，列表可能是几十分钟前的 */
    if (name === 'pending') loadPending(true);
    if (name === 'stickers') loadStickers();
    /* 运维 / 外部服务：进页各拉一次，别让 4 秒轮询拖着外部请求走 */
    if (name === 'ops') loadOpsHeartbeat();
    if (name === 'external') loadExternal();
    /* 在线时间：进页拉一次，60 秒内切回来不重复打插件 */
    if (name === 'online') loadOnline();
    if (name === 'switches') loadSwitches();
    /* 作息：进「设置」页必须现拉一次。以前只靠 loadHealth 的 then 里顺手刷，
       启动时若 state.page 还没变成 settings 就永远不刷，表单一直是 HTML 里的
       默认 23:50/09:00——主人一保存就把真实作息覆盖成默认值。 */
    if (name === 'settings') refreshSleep();
    /* 关于页：进页拉一次 /api/health，别拿几十分钟前的 build 说「已是最新」 */
    if (name === 'about') loadHealth();
    /* 扫码轮询只挂在「QQ 连接」页：离开就停，别在后台空转 */
    if (name === 'qq') enterLoginPage();
    else stopLoginPoll();
  }

  /* ---------------- 在线时间页（2026-11-06） ----------------
     数据只有一份：一次 POST online/stats（days=30）就拿齐分天/分时/热力/轨迹；
     切「今天/昨天/近 7 天」只重绘分时柱，不再打接口（spec §3.2）。
     柱子、热力格、轨迹全用 div 的高度与背景色画，不用 canvas：玻璃质感靠 CSS。 */

  var ON_WEEK = ['一', '二', '三', '四', '五', '六', '日'];
  var ON_TABS = [['today', '今天'], ['yesterday', '昨天'], ['week', '近 7 天']];

  function onClock(ms) {
    var d = asDate(ms);
    if (!d) return '—';
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  function onDateText(ms) {
    if (typeof ms === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ms)) return ms.slice(5);
    var d = asDate(ms);
    if (!d) return '—';
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  /* 毫秒 → 「23 小时 58 分」/「58 分」/「—」（spec §3.3 onFmtDur） */
  function onFmtDur(ms) {
    var total = Math.round(Number(ms) / 60000);
    if (!isFinite(total) || total < 0) return '—';
    if (total <= 0) return '0 分';
    var h = Math.floor(total / 60);
    var m = total % 60;
    if (!h) return m + ' 分';
    return m ? h + ' 小时 ' + m + ' 分' : h + ' 小时';
  }

  /* 同上，但单位小一号（KPI 大数字用）：23<small>小时</small>58<small>分</small> */
  function onDurHtml(ms) {
    var total = Math.round(Number(ms) / 60000);
    if (!isFinite(total) || total < 0) return '<span class="on-num">—</span>';
    if (total <= 0) return '<span class="on-num">0</span><small>分</small>';
    var h = Math.floor(total / 60);
    var m = total % 60;
    if (!h) return '<span class="on-num">' + m + '</span><small>分</small>';
    return '<span class="on-num">' + h + '</span><small>小时</small>'
      + (m ? '<span class="on-num">' + m + '</span><small>分</small>' : '');
  }

  function onPct(v) {
    var n = Number(v);
    if (!isFinite(n)) return '—';
    n = Math.round(n * 10) / 10;
    return (String(n).indexOf('.') === -1 ? String(n) : n.toFixed(1)) + '%';
  }

  /* 可用率胶囊：≥99% 绿、≥95% 琥珀、其余红；没有采样走灰（spec §4.1） */
  function onPill(pct, text) {
    var n = Number(pct);
    if (!isFinite(n) || n <= 0) return '<span class="on-pill is-idle">' + esc(text || '无数据') + '</span>';
    var kind = n >= 99 ? 'ok' : (n >= 95 ? 'warn' : 'bad');
    return '<span class="on-pill is-' + kind + '">' + esc(text || onPct(n)) + '</span>';
  }

  /* 可用率只给一个词，别在卡片上把同一个百分比印两遍（数值在中间那一行已经写了大号） */
  function onQual(pct) {
    var n = Number(pct);
    if (!isFinite(n) || n <= 0) return '待采样';
    return n >= 99 ? '稳定' : (n >= 95 ? '偶有中断' : '中断偏多');
  }

  function onKpi(label, valueHtml, note, pillHtml, extraClass) {
    return '<div class="on-kpi' + (extraClass ? ' ' + extraClass : '') + '">'
      + '<div class="on-kpi-head"><span class="on-kpi-label">' + esc(label) + '</span>' + (pillHtml || '') + '</div>'
      + '<div class="on-kpi-value">' + valueHtml + '</div>'
      + '<div class="on-kpi-note">' + (note || '') + '</div></div>';
  }

  function onKpis(data) {
    var today = data.today || {};
    var days = data.days || [];
    var cov = Number(today.coverageMs) || 0;
    var total = Number(today.totalMs) || 1;
    var avail = cov > 0 ? Number(today.onlinePercent) || 0 : 0;

    var k1 = onKpi('今日在线', cov ? onDurHtml(today.onlineMs) : '<span class="on-num">—</span>',
      cov ? '采样覆盖 ' + onPct(cov / total * 100) : '今天还没有采样', '');

    var k2 = onKpi('今日可用率', cov ? onPct(avail) : '<span class="on-num">—</span>',
      cov ? '在线 ' + onFmtDur(today.onlineMs) + ' / 会话 ' + (Number(today.sessions) || 0) + ' 段' : '按已采样时段计算',
      cov ? onPill(avail, onQual(avail)) : onPill(0, '待采样'));

    var ongoing = Number(today.ongoingMs) || 0;
    var k3;
    if (ongoing > 0) {
      var segs = today.timeline || [];
      var since = segs.length ? segs[segs.length - 1].start : 0;
      k3 = onKpi('当前连着', onDurHtml(ongoing),
        since ? '从 ' + onClock(since) + ' 起一直在' : '现在在线',
        '<span class="on-pill is-ok">在线</span>');
    } else if (today.lastOfflineAt) {
      k3 = onKpi('当前状态', '<span class="on-kpi-text">现在不在线</span>',
        '最后在线到 ' + onClock(today.lastOfflineAt),
        '<span class="on-pill is-idle">离线</span>');
    } else {
      k3 = onKpi('当前状态', '<span class="on-num">—</span>', '等一次采样', onPill(0, '待采样'));
    }

    /* 近 7 天：只按有采样的天平均，别让刚装的那天把均值拉低 */
    var last7 = days.slice(-7);
    var sumOnline = 0;
    var sumCov = 0;
    var n7 = 0;
    for (var i = 0; i < last7.length; i++) {
      var c = Number(last7[i].coverageMs) || 0;
      sumOnline += Number(last7[i].onlineMs) || 0;
      sumCov += c;
      if (c > 0) n7++;
    }
    var avail7 = sumCov > 0 ? sumOnline / sumCov * 100 : 0;
    var k4 = onKpi('近 7 天平均',
      n7 ? onDurHtml(n7 ? sumOnline / n7 : 0) : '<span class="on-num">—</span>',
      n7 ? n7 + ' 天有数据' : '这 7 天还没有采样',
      n7 ? onPill(avail7, onQual(avail7)) : onPill(0, '待采样'));

    return k1 + k2 + k3 + k4;
  }

  function onKpiSkeleton() {
    var out = '';
    for (var i = 0; i < 4; i++) {
      out += '<div class="on-kpi"><div class="on-kpi-head"><span class="on-kpi-label">读取中</span></div>'
        + '<div class="on-kpi-value"><span class="on-num">—</span></div>'
        + '<div class="on-kpi-note">正在拉在线时间…</div></div>';
    }
    return out;
  }

  function onRangeTabs() {
    var days = state.online.days;
    var out = '';
    var opts = [[7, '最近 7 天'], [30, '最近 30 天'], [90, '最近 90 天']];
    for (var i = 0; i < opts.length; i++) {
      var on = days === opts[i][0];
      out += '<button type="button" role="tab" aria-selected="' + (on ? 'true' : 'false') + '"'
        + ' class="on-tab' + (on ? ' is-active' : '') + '" data-on-range="' + opts[i][0] + '">'
        + opts[i][1] + '</button>';
    }
    return out;
  }

  function onTabBar() {
    var out = '';
    for (var i = 0; i < ON_TABS.length; i++) {
      var on = state.online.tab === ON_TABS[i][0];
      out += '<button type="button" role="tab" aria-selected="' + (on ? 'true' : 'false') + '"'
        + ' class="on-tab' + (on ? ' is-active' : '') + '" data-on-tab="' + ON_TABS[i][0] + '">'
        + ON_TABS[i][1] + '</button>';
    }
    return out;
  }

  /* 分天模块的横幅：她一直在 / 今天断过 N 次 / 今天大半时间不在（spec §4.2） */
  function onBanner(today) {
    var cov = Number(today.coverageMs) || 0;
    var avail = Number(today.onlinePercent) || 0;
    var breaks = Number(today.offlineCount) || 0;
    var cls;
    var icon;
    var title;
    if (!cov) {
      cls = 'is-idle';
      icon = '◌';
      title = '今天还没有采样';
    } else if (avail < 60) {
      cls = 'is-bad';
      icon = '×';
      title = '今天大半时间不在';
    } else if (avail < 99.5) {
      cls = 'is-warn';
      icon = '!';
      title = breaks > 0 ? '今天断过 ' + breaks + ' 次' : '今天有中断';
    } else {
      cls = 'is-ok';
      icon = '✓';
      title = '她一直在';
    }
    var sub = cov
      ? '今日在线 ' + onFmtDur(today.onlineMs) + ' · 可用率 ' + onPct(avail)
        + ' · 采样覆盖 ' + onPct(cov / (Number(today.totalMs) || 1) * 100)
      : '采样跑起来之后，这里会显示她今天的状态';
    return '<div class="on-banner ' + cls + '">'
      + '<span class="on-banner-icon" aria-hidden="true">' + icon + '</span>'
      + '<div class="on-banner-body"><div class="on-banner-title">' + esc(title) + '</div>'
      + '<div class="on-banner-sub">' + esc(sub) + '</div></div></div>';
  }

  function onDayRow(name, icon, valueText, barsHtml) {
    return '<div class="on-day-row">'
      + '<div class="on-day-head"><span class="on-day-name"><i aria-hidden="true">' + icon + '</i>'
      + esc(name) + '</span><span class="on-day-value">' + valueText + '</span></div>'
      + '<div class="on-bars">' + barsHtml + '</div></div>';
  }

  function onDayBars(data) {
    var days = data.days || [];
    if (!days.length || !data.summary || !data.summary.daysWithData) {
      return onBanner({}) + '<div class="on-empty">还没有采样数据，等一会儿再看</div>';
    }
    var onlineBars = '';
    var coverBars = '';
    var sumOnline = 0;
    var sumCov = 0;
    var sumTotal = 0;
    var covDays = 0;
    var firstCovIdx = -1;
    var lastIdx = days.length - 1;
    for (var i = 0; i < days.length; i++) {
      var d = days[i];
      var cov = Number(d.coverageMs) || 0;
      var total = Number(d.totalMs) || 0;
      var pct = cov > 0 ? Number(d.onlinePercent) || 0 : 0;
      var dateText = onDateText(d.start) + ' 周' + ON_WEEK[Number(d.weekday) || 0];
      var cls = !cov ? 'is-none' : (pct >= 99 ? 'is-ok' : (pct >= 95 ? 'is-warn' : 'is-bad'));
      var tip = cov
        ? dateText + ' · 在线 ' + onFmtDur(d.onlineMs) + ' · 可用率 ' + onPct(pct)
          + ' · 会话 ' + (Number(d.sessions) || 0) + ' 段 · 最长 ' + onFmtDur(d.longestMs)
        : dateText + ' · ' + (firstCovIdx < 0 || i < firstCovIdx ? '还没开始采样' : '这一天没有采样');
      onlineBars += '<i class="on-bar ' + cls + (i === lastIdx ? ' is-today' : '') + '"'
        + ' data-tip="' + esc(tip) + '"></i>';

      var ratio = total > 0 ? Math.min(1, cov / total) : 0;
      var alpha = cov > 0 ? 0.12 + 0.5 * ratio : 0.1;
      coverBars += '<i class="on-bar is-cover' + (i === lastIdx ? ' is-today' : '') + '"'
        + ' style="background:rgba(25,33,30,' + (Math.round(alpha * 100) / 100) + ')"'
        + ' data-tip="' + esc(dateText + ' · 采样覆盖 ' + (total ? onPct(ratio * 100) : '—')
          + ' · 覆盖 ' + onFmtDur(cov)) + '"></i>';

      sumOnline += Number(d.onlineMs) || 0;
      sumCov += cov;
      sumTotal += total;
      if (cov > 0) {
        covDays += 1;
        if (firstCovIdx < 0) firstCovIdx = i;
      }
    }
    var availAll = sumCov > 0 ? sumOnline / sumCov * 100 : 0;
    var row1 = onDayRow('Molly 在线', '✓', sumCov > 0 ? onPct(availAll) + ' 在线' : '—', onlineBars);
    /* 覆盖度用「天数 · 时长」表达：它说的是数据够不够，不是在线率，别用百分比让人误读 */
    var row2 = onDayRow('采样覆盖', '◌', covDays > 0 ? covDays + ' 天 · ' + onFmtDur(sumCov) : '—', coverBars);
    var axis = '<div class="on-days-axis"><span>' + esc(onDateText(days[0].start)) + '</span>'
      + '<span>' + esc(onDateText(days[lastIdx].start)) + '</span></div>';
    var note = firstCovIdx > 0
      ? '<div class="on-days-note">采样从 ' + esc(onDateText(days[firstCovIdx].start))
        + ' 开始，之前的日期是空白（不是她掉线）</div>'
      : '';
    return onBanner(data.today || {})
      + '<div class="on-day-rows' + (days.length <= 10 ? ' is-few' : '') + '">' + row1 + row2 + '</div>'
      + axis + note;
  }

  /* 分时柱：今天/昨天用那一天的 hours，近 7 天用 hourProfile（spec §3.3） */
  function onHourBars(data, tab) {
    var days = data.days || [];
    var day = null;
    var markNow = false;
    if (tab === 'yesterday') {
      day = days[days.length - 2];
      if (!day) return '<div class="on-empty">昨天还没有数据。</div>';
    } else if (tab !== 'week') {
      day = days[days.length - 1];
      markNow = true;
    }
    if (!data.summary || !data.summary.daysWithData) return '<div class="on-empty">还没有采样数据，等一会儿再看</div>';

    var nowHour = new Date().getHours();
    var bars = '';
    var axis = '';
    for (var h = 0; h < 24; h++) {
      var ratio = 0;
      var covered = false;
      var note = '';
      if (day) {
        var cell = (day.hours && day.hours[h]) || {};
        var onMs = Number(cell.onlineMs) || 0;
        var cov = onMs + (Number(cell.offlineMs) || 0);
        covered = cov > 0;
        ratio = covered ? onMs / cov : 0;
        note = covered ? onFmtDur(onMs) + ' 在线' : '没有采样';
      } else {
        ratio = Number((data.hourProfile || [])[h]) || 0;
        covered = ratio > 0;
        note = Math.round(ratio * 100) + '% 在线';
      }
      var future = markNow && h > nowHour;
      var tip = future ? pad2(h) + ':00 · 还没到这个点' : (pad2(h) + ':00 · ' + note);
      var cls = 'on-hour' + (!covered ? ' is-none' : '') + (future ? ' is-future' : '')
        + (markNow && h === nowHour ? ' is-now' : '');
      bars += '<div class="' + cls + '" data-tip="' + esc(tip) + '">'
        + (future ? '' : '<i style="height:' + Math.max(covered ? 3 : 2, Math.round(ratio * 72)) + 'px"></i>')
        + '</div>';
      var label = h === 0 || h === 6 || h === 12 || h === 18 || h === 23 ? String(h) : '';
      axis += '<span' + (h === 23 ? ' class="is-end"' : '') + '>' + label + '</span>';
    }
    var title;
    var sub;
    if (tab === 'week') {
      title = '近 7 天同一时刻';
      sub = '只统计有采样的时段';
    } else if (tab === 'yesterday') {
      title = '昨天 ' + onDateText(day.start) + ' 周' + ON_WEEK[Number(day.weekday) || 0];
      sub = '在线 ' + onFmtDur(day.onlineMs) + ' · 可用率 ' + (day.coverageMs ? onPct(day.onlinePercent) : '—');
    } else {
      var t = data.today || {};
      title = '今天 ' + onDateText(t.start);
      sub = '在线 ' + onFmtDur(t.onlineMs) + ' · 可用率 ' + (t.coverageMs ? onPct(t.onlinePercent) : '—');
    }
    return '<div class="on-hour-head"><div><div class="on-hour-title">' + esc(title) + '</div>'
      + '<div class="on-hour-sub">' + esc(sub) + '</div></div></div>'
      + '<div class="on-hours-grid">' + bars + '</div>'
      + '<div class="on-hours-axis">' + axis + '</div>';
  }

  function onHeatmap(data) {
    if (!data.summary || !data.summary.daysWithData) {
      return '<div class="on-empty">还没有采样数据，等一会儿再看</div>';
    }
    var matrix = data.weekMatrix || [];
    var head = '<div class="on-heat-row is-head"><span class="on-heat-label"></span>';
    var rows = '';
    for (var w = 0; w < 7; w++) {
      rows += '<div class="on-heat-row"><span class="on-heat-label">周' + ON_WEEK[w] + '</span>';
      for (var h = 0; h < 24; h++) {
        var v = Number((matrix[w] || [])[h]) || 0;
        var step = v <= 0 ? 0 : (v < 0.25 ? 0.25 : (v < 0.5 ? 0.5 : (v < 0.75 ? 0.75 : 1)));
        var bg = step === 0 ? 'rgba(25,33,30,.05)' : 'rgba(41,79,62,' + step + ')';
        var tip = '周' + ON_WEEK[w] + ' ' + pad2(h) + ':00 · 在线 ' + Math.round(v * 100) + '%';
        rows += '<i class="on-heat-cell" style="background:' + bg + '" data-tip="' + esc(tip) + '"></i>';
        if (w === 0) {
          var label = h === 0 || h === 6 || h === 12 || h === 18 || h === 23 ? String(h) : '';
          head += '<span class="on-heat-hour' + (h === 23 ? ' is-end' : '') + '">' + label + '</span>';
        }
      }
      rows += '</div>';
    }
    head += '</div>';
    return '<div class="on-heat-grid">' + head + rows + '</div>';
  }

  function onSegName(status) {
    return status === 'online' ? '在线' : (status === 'offline' ? '离线' : '未知');
  }

  function onTimeline(data) {
    var today = data.today || {};
    var segs = today.timeline || [];
    var dayStart = Number(today.start) || 0;
    if (!dayStart || !segs.length) return '<div class="on-empty">今天还没有采样数据。</div>';
    var body = '';
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      var left = Math.max(0, seg.start - dayStart) / 86400000 * 100;
      var width = Math.max(0, seg.end - seg.start) / 86400000 * 100;
      if (width <= 0) continue;
      body += '<i class="on-seg is-' + (seg.status || 'unknown') + '" style="left:'
        + (Math.round(left * 100) / 100) + '%;width:' + (Math.round(width * 100) / 100) + '%"'
        + ' data-tip="' + esc(onClock(seg.start) + '–' + onClock(seg.end) + ' · ' + onSegName(seg.status)) + '"></i>';
    }
    if (!body) return '<div class="on-empty">今天还没有采样数据。</div>';
    return '<div class="on-band">' + body + '</div>'
      + '<div class="on-ticks"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>';
  }

  function onSessions(data) {
    var list = (data.today && data.today.sessionList) || [];
    if (!list.length) return '<div class="on-empty on-empty-sm">今天还没有在线记录。</div>';
    var max = 6;
    var out = '';
    for (var i = 0; i < list.length && i < max; i++) {
      var s = list[i];
      out += '<div class="on-session' + (s.ongoing ? ' is-ongoing' : '') + '">'
        + '<span class="on-session-time">' + esc(onClock(s.start)) + '</span>'
        + '<span class="on-session-dash">–</span>'
        + '<span class="on-session-time">' + esc(s.ongoing ? '现在' : onClock(s.end)) + '</span>'
        + '<span class="on-session-dur">' + esc(onFmtDur(s.durationMs)) + '</span></div>';
    }
    if (list.length > max) out += '<div class="on-session-more">还有 ' + (list.length - max) + ' 段</div>';
    return out;
  }

  function renderOnline() {
    var st = state.online;
    var kpis = $('#onKpis');
    if (!kpis) return;
    var data = st.data;
    if (!data) {
      setHtml(kpis, onKpiSkeleton());
      setHtml($('#onRange'), '');
      var box = st.error
        ? '<div class="on-empty"><p class="ar-error">' + esc(st.error) + '</p>'
          + '<button class="btn btn-ghost btn-sm js-retry" type="button">重试</button></div>'
        : '<div class="on-empty">正在读取在线时间…</div>';
      setHtml($('#onDays'), box);
      setHtml($('#onTabs'), '');
      setHtml($('#onHours'), '');
      setHtml($('#onHeat'), '');
      setHtml($('#onTimeline'), '');
      setHtml($('#onSessions'), '');
      if (st.error) bindRetry($('#onDays'), function () { loadOnline(true); });
      return;
    }
    setHtml(kpis, onKpis(data));
    setHtml($('#onRange'), onRangeTabs());
    setHtml($('#onDays'), onDayBars(data));
    var hasData = !!(data.summary && data.summary.daysWithData);
    var tabsBox = $('#onTabs');
    /* 一条数据都没有时，别在分时卡里连贴三段空态：留一句就够 */
    setHtml(tabsBox, hasData ? onTabBar() : '');
    if (tabsBox) tabsBox.hidden = !hasData;
    setHtml($('#onHours'), hasData
      ? onHourBars(data, st.tab)
      : '<div class="on-empty">还没有采样数据，等一会儿再看</div>');
    setHtml($('#onHeat'), hasData ? onHeatmap(data) : '');
    var heatTitle = document.querySelector('#onlinePage .on-sub-title');
    if (heatTitle) heatTitle.hidden = !hasData;
    setHtml($('#onTimeline'), onTimeline(data));
    setHtml($('#onSessions'), onSessions(data));
  }

  function loadOnline(force) {
    var st = state.online;
    if (st.loading) return;
    /* 60 秒内不重复拉：切页签回来不该再打一次插件（spec §3.2） */
    if (!force && st.data && st.at && Date.now() - st.at < 60000) {
      safe(renderOnline);
      return;
    }
    st.loading = true;
    if (!st.data) safe(renderOnline);
    apiPost('online/stats', { days: st.days }).then(function (res) {
      st.loading = false;
      st.at = Date.now();
      if (res && res.ok) {
        st.data = res.data || null;
        st.error = '';
      } else {
        st.error = (res && (res.error || (res.data && res.data.error))) || '在线时间读取失败';
      }
      safe(renderOnline);
    });
  }

  /* 切「今天/昨天/近 7 天」只重绘分时区：数据在一次 days=30 响应里已经齐了 */
  function onOnlineTab(id) {
    if (state.online.tab === id) return;
    state.online.tab = id;
    var data = state.online.data;
    if (!data) return;
    setHtml($('#onTabs'), onTabBar());
    setHtml($('#onHours'), onHourBars(data, id));
  }

  function onOnlineRange(days) {
    if (state.online.days === days) return;
    state.online.days = days;
    state.online.at = 0;
    safe(renderOnline);
    loadOnline(true);
  }

  function bindOnline() {
    var sec = $('#onlinePage');
    if (!sec) return;
    sec.addEventListener('click', function (ev) {
      var t = ev.target;
      var tab = t && t.closest ? t.closest('[data-on-tab]') : null;
      if (tab) {
        onOnlineTab(tab.getAttribute('data-on-tab'));
        return;
      }
      var range = t && t.closest ? t.closest('[data-on-range]') : null;
      if (range) onOnlineRange(Number(range.getAttribute('data-on-range')) || 30);
    });

    /* 悬浮提示只挂一个元素 + 一次委托，不逐格绑监听。
       挂在 body 上而不是页面里：换页动画会给 .page 加 transform，fixed 会跑偏。 */
    var tip = null;
    function ensureTip() {
      if (!tip) {
        tip = document.createElement('div');
        tip.className = 'on-tip';
        tip.hidden = true;
        document.body.appendChild(tip);
      }
      return tip;
    }
    sec.addEventListener('mouseover', function (ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-tip]') : null;
      if (!el) return;
      var node = ensureTip();
      node.textContent = el.getAttribute('data-tip') || '';
      node.hidden = false;
      var r = el.getBoundingClientRect();
      var top = r.top - node.offsetHeight - 8;
      if (top < 8) top = r.bottom + 8;
      var left = r.left + r.width / 2 - node.offsetWidth / 2;
      left = Math.max(8, Math.min(window.innerWidth - node.offsetWidth - 8, left));
      node.style.left = left + 'px';
      node.style.top = top + 'px';
    });
    sec.addEventListener('mouseout', function (ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-tip]') : null;
      if (el && tip && !el.contains(ev.relatedTarget)) tip.hidden = true;
    });
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindEvents() {
    window.addEventListener('hashchange', function () {
      setPage(currentPage());
    });

    /* 关于页：检查更新 / 更新日志就地展开 / 路径复制 / 服务端已更新后的刷新，
       全部走页内事件委托 —— 卡片被 4 秒轮询重绘也不用重新绑定。 */
    var aboutPage = $('#aboutPage');
    if (aboutPage) {
      aboutPage.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.closest) return;
        var copyBtn = t.closest('[data-copy]');
        if (copyBtn) { copyAboutText(copyBtn.getAttribute('data-copy')); return; }
        if (t.closest('#aboutCheck')) { checkAboutUpdate(); return; }
        if (t.closest('#aboutChgToggle')) { toggleAboutChangelog(); return; }
        if (t.closest('#aboutReload')) { location.reload(); return; }
      });
    }

    /* 发言开关：重新加载 + 页内所有按钮走事件委托（列表重绘不用重绑） */
    var swReload = $('#swReload');
    if (swReload) swReload.addEventListener('click', function () { loadSwitches(); });
    var swCards = $('#swCards');
    if (swCards) swCards.addEventListener('click', onSwAction);
    /* 记住输入框草稿：4 秒一次的 poll 会重渲染本页，靠这份缓存把值带回来 */
    if (swCards) swCards.addEventListener('input', function (e) {
      var t = e.target;
      var id = t && t.id;
      if (!id || !state.sw.form) return;
      if (id === 'swGroupInput') state.sw.form.group = t.value;
      else if (id === 'swMaxChars') state.sw.form.cfMax = t.value;
      else if (id === 'swMuteScope') state.sw.form.muteScope = t.value;
      else if (id === 'swMuteMinutes') state.sw.form.muteMinutes = t.value;
      else if (id === 'swMuteNote') state.sw.form.muteNote = t.value;
    });
    /* 回车直接提交：省得点按钮时不小心点到别处把输入框弄丢 */
    if (swCards) swCards.addEventListener('keydown', function (e) {
      if (!e || e.key !== 'Enter') return;
      var id = e.target && e.target.id;
      var act = id === 'swGroupInput' ? 'group-open'
        : (id === 'swMuteScope' ? 'mute' : (id === 'swMaxChars' ? 'cf-max' : ''));
      if (!act) return;
      e.preventDefault();
      var btn = swCards.querySelector('[data-sw-act="' + act + '"]');
      if (btn) onSwAction({ target: btn, preventDefault: function () {} });
    });
    var swAudit = $('#swAudit');
    if (swAudit) swAudit.addEventListener('click', onSwAction);

    var btnRefresh = $('#btnRefresh');
    if (btnRefresh) btnRefresh.addEventListener('click', function () { reloadPageData(true); });

    var memSearch = $('#memSearch');
    if (memSearch) memSearch.addEventListener('input', function () { safe(applyMemFilter); });

    var memReload = $('#memReload');
    if (memReload) memReload.addEventListener('click', function () { loadMemory(true); });

    var memAdd = $('#memAdd');
    if (memAdd) memAdd.addEventListener('click', function () { memAddNew(); });

    var jzDate = $('#jzDate');
    if (jzDate) {
      jzDate.addEventListener('change', function () {
        memView.day = String(jzDate.value || '');
        if (memView.day) memView.time = '';
        memView.shown = JZ_BATCH;
        safe(jzApply);
      });
    }

    var jzSort = $('#jzSort');
    if (jzSort) {
      jzSort.addEventListener('change', function () {
        memView.sort = jzSort.value || 'added';
        safe(jzApply);
      });
    }

    /* 日期筛选：面板每次重绘都会换掉里面的节点，所以监听挂在容器上做委托 */
    var jzFacetsBox = $('#jzFacets');
    if (jzFacetsBox) {
      jzFacetsBox.addEventListener('change', function (ev) {
        var t = ev && ev.target;
        if (!t || t.id !== 'jzDate') return;
        memView.day = String(t.value || '');
        if (memView.day) memView.time = '';
        memView.shown = JZ_BATCH;
        safe(jzApply);
      });
    }

    var jzMore = $('#jzMore');
    if (jzMore) jzMore.addEventListener('click', function () { safe(jzAppend); });

    var jzScrim = $('#jzScrim');
    if (jzScrim) jzScrim.addEventListener('click', function () { jzCloseDrawer(); });

    /* 索引栏 / 详情 / 结果行：一个委托管完。行内「改 / 删」仍由下面的 #memGroups 老委托处理。 */
    var jzPage = $('#jzPage');
    if (jzPage) jzPage.addEventListener('click', function (ev) { safe(function () { onMemClick(ev); }); });
    document.addEventListener('keydown', function (ev) { safe(function () { onMemKey(ev); }); });

    /* 滚动到离底 240px 时追加下一批：桌面壳滚 .content，浏览器壳滚 window，两个都听着 */
    var jzScrollHost = $('.content');
    if (jzScrollHost) jzScrollHost.addEventListener('scroll', function () { safe(jzMaybeAppend); }, { passive: true });
    window.addEventListener('scroll', function () { safe(jzMaybeAppend); }, { passive: true });

    /* 跨断点时抽屉的内联定位要交还给 CSS */
    window.addEventListener('resize', function () {
      safe(function () {
        var d = $('#jzDetail');
        if (d && jzWide()) { d.style.top = ''; d.style.height = ''; jzCloseDrawer(); }
        jzMaybeAppend();
      });
    }, { passive: true });

    /* 记忆行的「改 / 删」用事件委托：列表重绘后不用重新绑定 */
    var memGroups = $('#memGroups');
    if (memGroups) {
      memGroups.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
        if (!b) return;
        var act = b.getAttribute('data-act');
        if (act === 'mem-edit') memEditExisting(b.getAttribute('data-id'));
        else if (act === 'mem-del') memDeleteExisting(b.getAttribute('data-id'));
      });
    }

    var stkReload = $('#stkReload');
    if (stkReload) stkReload.addEventListener('click', function () { loadStickers(true); });

    /* 表情包搜索框：输入即过滤（纯前端，不重新请求）；Esc 清空 */
    var stkSearch = $('#stkSearch');
    if (stkSearch) {
      stkSearch.addEventListener('input', function () {
        state.stkQuery = stkSearch.value || '';
        safe(renderStickers);
      });
      stkSearch.addEventListener('keydown', function (ev) {
        if (ev.key === 'Escape') {
          ev.preventDefault();
          stkSearch.value = '';
          state.stkQuery = '';
          safe(renderStickers);
        }
      });
    }

    /* 待核实：刷新 / 全部丢弃 / 每条行内按钮（事件委托，行被移除后不用重绑） */
    var pendReload = $('#pendReload');
    if (pendReload) pendReload.addEventListener('click', function () { loadPending(true); });
    var pendRejectAll = $('#pendRejectAll');
    if (pendRejectAll) pendRejectAll.addEventListener('click', function () { rejectAllPending(); });
    var pendList = $('#pendList');
    if (pendList) {
      pendList.addEventListener('click', function (ev) {
        var b = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
        if (!b) return;
        var act = b.getAttribute('data-act');
        var id = b.getAttribute('data-id');
        var it = null;
        (state.pendingItems || []).forEach(function (x) { if (!it && String(x.id) === String(id)) it = x; });
        if (!it) return;
        if (act === 'pend-approve') openPendConfirm(true, it);
        else if (act === 'pend-reject') openPendConfirm(false, it);
      });
    }

    var stkAdd = $('#stkAdd');
    if (stkAdd) stkAdd.addEventListener('click', function () { stkUpload(); });

    /* 通用 CRUD 弹层：取消 / × / 点遮罩 都走 closeCrud（保存中会被它自己挡住） */
    var crudModal = $('#crudModal');
    if (crudModal) {
      crudModal.addEventListener('click', function (ev) {
        if (ev.target === crudModal) closeCrud();
      });
    }
    var crudOk = $('#crudOk');
    if (crudOk) crudOk.addEventListener('click', submitCrud);
    var crudCancel = $('#crudCancel');
    if (crudCancel) crudCancel.addEventListener('click', closeCrud);
    var crudClose = $('#crudClose');
    if (crudClose) crudClose.addEventListener('click', closeCrud);

    var grid = $('#stkGrid');
    if (grid) {
      grid.addEventListener('click', function (ev) {
        /* 先看是不是操作按钮：落在「改关键词 / 删」上时不能顺带打开大图 */
        var act = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
        if (act) {
          var kind = act.getAttribute('data-act');
          if (kind === 'stk-edit') stkEditKeywords(act.getAttribute('data-file'));
          else if (kind === 'stk-del') stkDelete(act.getAttribute('data-file'));
          return;
        }
        var btn = ev.target && ev.target.closest ? ev.target.closest('.sticker') : null;
        if (!btn) return;
        openSticker(btn.getAttribute('data-url'), btn.getAttribute('data-name'));
      });
      /* 图片加载失败（服务未起 / 文件缺失）只降透明度，不弹错 */
      grid.addEventListener('error', function (ev) {
        var img = ev.target;
        if (img && img.tagName === 'IMG') {
          var card = img.closest ? img.closest('.sticker') : null;
          if (card) card.classList.add('is-failed');
        }
      }, true);
    }

    var modal = $('#stkModal');
    if (modal) {
      modal.addEventListener('click', function (ev) {
        if (ev.target === modal) closeSticker();
      });
    }
    var modalClose = $('#stkModalClose');
    if (modalClose) modalClose.addEventListener('click', closeSticker);

    var logFab = $('#logFab');
    if (logFab) logFab.addEventListener('click', function () { openDrawer(); });
    var logClose = $('#logClose');
    if (logClose) logClose.addEventListener('click', closeDrawer);
    var logReload = $('#logReload');
    if (logReload) logReload.addEventListener('click', loadLogs);
    var logSource = $('#logSource');
    if (logSource) logSource.addEventListener('change', loadLogs);

    var copyDiag = $('#setCopyDiag');
    if (copyDiag) copyDiag.addEventListener('click', copyDiagnostics);
    var openLogs = $('#setOpenLogs');
    if (openLogs) openLogs.addEventListener('click', function () { openDrawer('watchdog'); });

    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      var cf = $('#confirmSheet');
      if (cf && !cf.hidden) { closeConfirm(); return; }
      var cm = $('#crudModal');
      if (cm && !cm.hidden) { closeCrud(); return; }
      var m = $('#stkModal');
      if (m && !m.hidden) { closeSticker(); return; }
      var d = $('#drawer');
      if (d && !d.hidden) closeDrawer();
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        stopTimers();
      } else {
        /* 从别的窗口切回来：当前页的数据也一起刷新，不然看到的是离开前的快照 */
        reloadPageData(false);
        startTimers();
      }
    });
  }

  function copyDiagnostics() {
    var payload = {
      at: Date.now(),
      overview: state.overview,
      memory: state.memory,
      stickers: state.stickers,
      lastError: state.lastError
    };
    var text;
    try {
      text = JSON.stringify(payload, null, 2);
    } catch (err) {
      toast('诊断信息序列化失败：' + err.message);
      return;
    }
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      toast('当前环境不支持剪贴板');
      return;
    }
    navigator.clipboard.writeText(text).then(function () {
      toast('诊断信息已复制（' + text.length + ' 字符）');
    }).catch(function (err) {
      toast('复制失败：' + (err && err.message ? err.message : '浏览器拒绝'));
    });
  }

  /* ---------------- 本地外观偏好 ---------------- */

  function bindAppearance() {
    var root = document.documentElement;
    var theme = 'forest';
    var glass = true;
    try {
      var saved = JSON.parse(localStorage.getItem('molly-console-appearance') || '{}');
      if (['forest', 'indigo', 'clay', 'plum'].indexOf(saved.theme) >= 0) theme = saved.theme;
      if (typeof saved.glass === 'boolean') glass = saved.glass;
    } catch (err) { console.warn('[molly-console] 外观偏好读取失败，使用默认值', err); }
    function apply() {
      root.setAttribute('data-theme', theme);
      root.setAttribute('data-glass', glass ? 'true' : 'false');
      $$('.theme-option').forEach(function (button) {
        button.setAttribute('aria-checked', button.getAttribute('data-theme') === theme ? 'true' : 'false');
      });
      var toggle = $('#glassEnabled');
      if (toggle) toggle.checked = glass;
      try { localStorage.setItem('molly-console-appearance', JSON.stringify({ theme: theme, glass: glass })); }
      catch (err) { console.warn('[molly-console] 外观偏好无法保存', err); }
    }
    $$('.theme-option').forEach(function (button) {
      button.addEventListener('click', function () { theme = button.getAttribute('data-theme'); apply(); });
    });
    var toggle = $('#glassEnabled');
    if (toggle) toggle.addEventListener('change', function () { glass = toggle.checked; apply(); });
    apply();
  }

  /* ---------------- 储存与占用（2026-11-05） ----------------
     主人要的是「给其他部署者用」：在控制台里能看见各类进程各占多少、能调策略、能一键回收。
     策略落在服务端 out\mem-config.json —— 桌面壳和 Python 侧车读同一份，避免三套口径。
     这里只做「读状态 / 写配置 / 触发回收」，真正把模型卸出内存的是侧车的 /unload。 */

  var memState = { config: null, mem: null, embed: null, game: null, busy: false };

  function memMb(n) {
    var v = Number(n);
    if (!isFinite(v) || v <= 0) return '0 MB';
    return v >= 1000 ? (v / 1024).toFixed(2) + ' GB' : Math.round(v) + ' MB';
  }

  function memPost(actionId, body) {
    return fetch('/api/action/' + actionId, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (r) { return r.json(); });
  }

  function renderMemTable() {
    var box = $('#memTable');
    if (!box) return;
    var m = memState.mem;
    if (!m || !m.groups || !m.groups.length) {
      setHtml(box, '<div class="mem-item is-muted"><span>读不到进程内存</span><b>—</b></div>');
      return;
    }
    var rows = m.groups.map(function (g) {
      return '<div class="mem-item"><span>' + esc(g.label) +
        (g.count ? '<i class="mem-count">×' + g.count + '</i>' : '') +
        '</span><b class="mono">' + memMb(g.mb) + '</b></div>';
    });
    rows.push('<div class="mem-item is-total"><span>Molly 合计</span><b class="mono">' + memMb(m.totalMb) + '</b></div>');
    /*
     * 参考行（2026-11-06，主人 m07510）：主人问过「这些算不算 DSH / QQ / 浏览器」。
     * 之前卡片只报 Molly 自己的四条进程树，看着像「整机就吃这么点」；这里把不相干但
     * 同机的大头也列出来，最后一行给个全场合计，方便判断「到底是谁在吃内存」。
     */
    if (m.others && m.others.length) {
      rows.push('<div class="mem-head">不计入 Molly（同机参考）</div>');
      rows.push(m.others.map(function (o) {
        return '<div class="mem-item is-ref"><span>' + esc(o.label) +
          (o.count ? '<i class="mem-count">×' + o.count + '</i>' : '') +
          '</span><b class="mono">' + memMb(o.mb) + '</b></div>';
      }).join(''));
      rows.push('<div class="mem-item is-total is-grand"><span>以上全部合计</span><b class="mono">' +
        memMb(m.grandTotalMb) + '</b></div>');
    }
    setHtml(box, rows.join(''));
  }

  function renderMemControls() {
    var c = memState.config || {};
    var mode = $('#memRerankMode');
    if (mode) mode.value = c.rerankMode === 'always' ? 'always' : 'lazy';
    var idle = $('#memRerankIdle');
    if (idle) idle.value = String(c.rerankIdleMin == null ? 5 : c.rerankIdleMin);
    var sovits = $('#memSovitsIdle');
    if (sovits) sovits.value = String(c.sovitsIdleMin == null ? 10 : c.sovitsIdleMin);
    var guard = $('#memGuard');
    if (guard) guard.checked = c.guard !== false;
    var susp = $('#memSuspend');
    if (susp) susp.checked = c.suspendOnMinimize !== false;
    var game = $('#memGame');
    if (game) {
      var on = memState.game && typeof memState.game.on === 'boolean' ? memState.game.on : c.gameMode === true;
      game.checked = Boolean(on);
      var card = $('#memCard');
      if (card) card.classList.toggle('is-game', Boolean(on));
    }
  }

  function renderMem(force) {
    if (memState.busy && !force) return;
    memPost('mem/status').then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || '状态读取失败');
      var d = j.data || {};
      memState.config = d.config || null;
      memState.mem = d.mem || null;
      memState.embed = d.embed || null;
      memState.game = d.game || null;
      renderMemTable();
      renderMemControls();
      var hint = $('#memHint');
      if (hint && d.embed && d.embed.reached) {
        var mins = d.embed.uptime_s ? Math.round(d.embed.uptime_s / 60) : 0;
        hint.textContent = '嵌入服务在跑 · 已用 ' + mins + ' 分钟' +
          (d.embed.rerank && d.embed.rerank.calls ? ' · 重排 ' + d.embed.rerank.calls + ' 次' : '');
      } else if (hint && !memState.busy) {
        hint.textContent = '嵌入服务没在跑（空闲会自动退出）';
      }
    }).catch(function (err) {
      var box = $('#memTable');
      if (box) setHtml(box, '<div class="mem-item is-muted"><span>状态读取失败</span><b>—</b></div>');
      console.warn('[molly-console] 储存与占用状态读取失败：', err);
    });
  }

  function saveMem(patch, label) {
    memPost('mem/config', patch).then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || '保存失败');
      memState.config = (j.data && j.data.config) || memState.config;
      renderMemControls();
      toast('已保存' + (label ? '：' + label : ''));
    }).catch(function (err) { toast('保存失败：' + (err && err.message ? err.message : err)); });
  }

  function trimMemory() {
    var btn = $('#memTrim');
    var hint = $('#memHint');
    if (memState.busy) return;
    memState.busy = true;
    if (btn) { btn.disabled = true; btn.textContent = '正在回收…'; }
    if (hint) hint.textContent = '把重排和嵌入卸出内存，下一次召回会重新加载…';
    memPost('mem/trim').then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || '回收失败');
      var d = j.data || {};
      memState.mem = d.after || memState.mem;
      renderMemTable();
      var freed = Number(d.freedMb) || 0;
      toast(freed > 0 ? '已回收约 ' + memMb(freed) : '没有可回收的内存');
      if (hint) hint.textContent = freed > 0 ? ('刚回收 ' + memMb(freed) + '，需要时她会自己重新加载') : '没有可回收的内存';
    }).catch(function (err) {
      toast('回收失败：' + (err && err.message ? err.message : err));
      if (hint) hint.textContent = '';
    }).then(function () {
      memState.busy = false;
      if (btn) { btn.disabled = false; btn.textContent = '立即回收'; }
      safe(function () { renderMem(true); });
    });
  }

  function toggleGameMode(on) {
    var box = $('#memGame');
    var hint = $('#memHint');
    if (box) box.disabled = true;
    if (hint) hint.textContent = on ? '正在暂停语音与点歌…' : '正在恢复语音与点歌…';
    memPost('mem/gamemode', { on: Boolean(on) }).then(function (j) {
      if (!j || !j.ok) throw new Error((j && j.error) || '切换失败');
      var d = j.data || {};
      memState.config = d.config || memState.config;
      memState.game = { on: Boolean(d.game && d.game.on) };
      renderMemControls();
      if (hint) hint.textContent = d.hint || '';
      toast(d.hint || (on ? '游戏模式已开' : '游戏模式已关'));
      safe(function () { renderMem(true); });
    }).catch(function (err) {
      if (box) box.checked = !on;
      if (hint) hint.textContent = '';
      toast('切换失败：' + (err && err.message ? err.message : err));
    }).then(function () { if (box) box.disabled = false; });
  }

  function bindMem() {
    var mode = $('#memRerankMode');
    if (mode) mode.addEventListener('change', function () { saveMem({ rerankMode: mode.value }, '重排方式'); });
    var idle = $('#memRerankIdle');
    if (idle) idle.addEventListener('change', function () { saveMem({ rerankIdleMin: Number(idle.value) }, '重排空闲卸载'); });
    var sovits = $('#memSovitsIdle');
    if (sovits) sovits.addEventListener('change', function () { saveMem({ sovitsIdleMin: Number(sovits.value) }, '语音空闲退出'); });
    var guard = $('#memGuard');
    if (guard) guard.addEventListener('change', function () { saveMem({ guard: guard.checked }, '内存守卫'); });
    var susp = $('#memSuspend');
    if (susp) susp.addEventListener('change', function () { saveMem({ suspendOnMinimize: susp.checked }, '最小化挂起'); });
    var trim = $('#memTrim');
    if (trim) trim.addEventListener('click', trimMemory);
    var game = $('#memGame');
    if (game) game.addEventListener('change', function () { toggleGameMode(game.checked); });
  }

  /* ---------------- 启动 ---------------- */

  function init() {
    try {
      bindAppearance();
      bindMem();
      initActions();
      bindQuickActions();
      bindOpsEvents();
      bindEvents();
      bindOnline();
      bindChangelog();
      bindCommandPalette();
      setPage(currentPage());
      loadHealth();
      poll();
      /* 气泡在任意页都要能看见，所以启动就先探一次待核实数量 */
      safe(pollPending);
      startTimers();
    } catch (err) {
      console.warn('[molly-console] 初始化失败：', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
