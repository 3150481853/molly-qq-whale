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
  var QR_MAX_AUTO = 3;        /* 过期自动换码最多连换 3 次，之后交回人手，免得无限刷 */
  /* 二维码有效期只是本地展示：约 2 分钟，不假装与 NapCat 内部计时精确一致。
     测试里用 window.__QR_TTL_MS__ 缩短，免得等两分钟。 */
  var QR_TTL_MS = (typeof window !== 'undefined' && typeof window.__QR_TTL_MS__ === 'number' && window.__QR_TTL_MS__ > 0)
    ? window.__QR_TTL_MS__
    : 120000;
  var PAGES = ['overview', 'chats', 'memory', 'pending', 'stickers', 'budget', 'work', 'watchdog', 'ops', 'external', 'napcat', 'login', 'exec', 'settings'];

  /* 记忆类型：顺序即页面分组顺序。值和插件端 lib/memory.js 的 kind 枚举一一对应，
     中文标签只在前端出现，不参与任何写请求。 */
  var MEM_KINDS = [
    ['fact', '事实'],
    ['preference', '偏好'],
    ['promise', '约定'],
    ['person', '人物'],
    ['event', '事件'],
    ['work', '干活'],
    ['sticker', '表情包']
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
      success: '',       /* 非空=已登录横幅要显示，值是「Molly 345…」 */
      successNote: '',   /* 已登录横幅的副标题：扫码成功 / 本来就在线 */
      error: '',
      hint: ''
    },
    loginAutoStart: false,   /* 总览黄条点进来时置位：进页后自动生成一次 */
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

  /* ---------------- 顶部状态条 ---------------- */

  function renderTop() {
    var ov = state.overview || {};
    var p = ov.plugin || {};
    var nc = ov.napcat || {};
    var wd = ov.watchdog || {};

    var molly = $('#pillMolly');
    if (molly) {
      if (!p.reachable) {
        molly.className = 'pill pill-idle';
        molly.innerHTML = '<i class="dot"></i>插件不可达';
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
      if (!nc.reachable) {
        np.className = 'pill pill-idle';
        np.innerHTML = '<i class="dot"></i>NapCat 不可达';
      } else if (nc.isLogin) {
        np.className = 'pill pill-ok';
        np.innerHTML = '<i class="dot"></i>NapCat 已登录';
      } else {
        np.className = 'pill pill-warn';
        np.innerHTML = '<i class="dot"></i>NapCat 未登录';
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

    /* 掉登录横幅：isLogin=false 且插件链路也不 online 才算真掉线，
       避免「插件开着但没连 QQ」和「还没探到 NapCat」被误报 */
    var banner = $('#ovLoginBanner');
    if (banner) {
      var linkState = p.link && p.link.state;
      banner.hidden = !(nc.isLogin === false && linkState !== 'online');
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
        '<div class="stat tint-lavender"><div class="stat-label">记忆</div>' +
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

      var ncRows = [
        kv('登录', nc.reachable ? (nc.isLogin ? pill('ok', '已登录') : pill('warn', '未登录')) : pill('idle', '不可达')),
        kv('阶段', val(nc.loginPhase)),
        kv('QQ 号', (nc.uin || (p.bot && p.bot.userId)) ? '<span class="mono">' + esc(nc.uin || p.bot.userId) + '</span>' : '—'),
        kv('核心', nc.coreReady ? '就绪' : '未就绪')
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
          kv('记忆', mono(side.memory && side.memory.count) + ' 条'),
          kv('表情', mono(side.stickers && side.stickers.count) + ' 张'),
          kv('预算上限', mono(side.budget && side.budget.cap))
        ].join('')
        : '<p class="ar-error">数据服务 19391 不可达：' + esc(side.error || '连接被拒绝') + '</p>';

      setHtml(cards, [
        card('连接与身份', identity),
        card('消息与响应', msgRows),
        card('守护', wdRows),
        card('NapCat', ncRows),
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
        kv('记忆条数', mono(side.memory && side.memory.count)),
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
    if (!state.memEntries && sub) sub.textContent = '正在读取…';

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

    if (state.memoryError && !state.memory) {
      sub.textContent = '读取失败';
      setHtml(box, emptyHtml('记忆读取失败：' + esc(state.memoryError), '重试'));
      bindRetry(box, function () { loadMemory(true); });
      return;
    }
    if (!state.memory) {
      sub.textContent = '正在读取…';
      setHtml(box, '');
      return;
    }

    var data = state.memory;
    var mem = data.memory || data;
    var groups = Array.isArray(mem.groups) ? mem.groups : [];

    sub.textContent = '共 ' + num(mem.count, 0) + ' 条 · 更新于 ' + val(mem.updatedAt) + ' · 只读';

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

  /* 可写视图：按 kind 分组，行尾带「改 / 删」。条目按 at 倒序（服务端已排序）。 */
  function renderMemoryEntries() {
    var box = $('#memGroups');
    var sub = $('#memSub');
    if (!box || !sub) return;
    var entries = state.memEntries || [];

    /* 有 QQ 号的比例是这次改造要能一眼看到的指标：名字会重名，QQ 号不会 */
    var withQQ = entries.filter(function (e) { return e && e.qq; }).length;
    sub.textContent = '共 ' + entries.length + ' 条 · 其中 ' + withQQ + ' 条有 QQ 号 · 点行尾「改 / 删」维护';

    if (!entries.length) {
      setHtml(box, emptyHtml('还没有记忆条目，点右上角「+ 新增记忆」写一条。'));
      return;
    }

    var groups = MEM_KINDS.map(function (k) { return { kind: k[0], label: k[1], items: [] }; });
    var extra = {};
    entries.forEach(function (it) {
      var g = null;
      for (var i = 0; i < groups.length; i++) {
        if (groups[i].kind === it.kind) { g = groups[i]; break; }
      }
      if (!g) {
        if (!extra[it.kind]) { extra[it.kind] = { kind: it.kind, label: memKindLabel(it.kind), items: [] }; }
        g = extra[it.kind];
      }
      g.items.push(it);
    });
    var ordered = groups.concat(Object.keys(extra).map(function (k) { return extra[k]; }));

    var html = ordered.filter(function (g) { return g.items.length; }).map(function (g) {
      var rows = g.items.map(function (it) { return memEntryHtml(it, g.label); }).join('');
      return '<details class="mem-group" open>' +
        '<summary class="mem-summary">' + esc(g.label) +
        '<span class="mem-count mono">' + g.items.length + ' 条</span></summary>' +
        '<div class="mem-items">' + rows + '</div></details>';
    }).join('');

    setHtml(box, html);
    applyMemFilter();
  }

  function memEntryHtml(it, kindLabel) {
    /* qq 既显示也参与搜索：qq 是稳定身份，重名时靠它认人 */
    var qq = it.qq ? String(it.qq).trim() : '';
    var search = [it.text, it.who, qq, kindLabel, it.kind, memDate(it.at)].filter(Boolean).join(' ').toLowerCase();
    var id = esc(it.id);
    return '<div class="mem-item" data-search="' + esc(search) + '">' +
      '<span class="mem-date">' + esc(memDate(it.at)) + '</span>' +
      '<span class="mem-tag">' + esc(kindLabel) + '</span>' +
      (it.who ? '<span class="mem-who">' + esc(it.who) + '</span>' : '') +
      '<span class="mem-qq' + (qq ? '' : ' is-empty') + '" title="' + (qq ? 'QQ 号' : '还没记 QQ 号') + '">' +
      (qq ? 'QQ ' + esc(qq) : 'QQ 未记录') + '</span>' +
      '<span class="mem-text">' + esc(it.text) + '</span>' +
      '<span class="mem-ops">' +
      '<span class="mem-weight mono" title="权重">w' + esc(it.weight === undefined || it.weight === null ? '—' : it.weight) + '</span>' +
      '<button class="btn btn-ghost btn-xs" type="button" data-act="mem-edit" data-id="' + id + '">改</button>' +
      '<button class="btn btn-ghost btn-xs btn-quiet-danger" type="button" data-act="mem-del" data-id="' + id + '">删</button>' +
      '</span></div>';
  }

  function applyMemFilter() {
    var input = $('#memSearch');
    if (!input) return;
    var q = (input.value || '').trim().toLowerCase();
    $$('#memGroups .mem-group').forEach(function (group) {
      var items = $$('.mem-item', group);
      var visible = 0;
      items.forEach(function (item) {
        var hit = !q || (item.getAttribute('data-search') || '').indexOf(q) >= 0;
        item.hidden = !hit;
        if (hit) visible++;
      });
      group.hidden = visible === 0;
      if (q && visible > 0) group.open = true;
      var cnt = $('.mem-count', group);
      if (cnt) cnt.textContent = visible + ' 条';
    });
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

    sub.textContent = '共 ' + num(stk.count, 0) + ' 张 · 点击看大图';

    if (!items.length) {
      setHtml(grid, '');
      empty.hidden = false;
      setHtml(empty, emptyHtml('还没有学到的表情。'));
      return;
    }

    empty.hidden = true;
    setHtml(grid, items.map(function (it) {
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
    var weight = it.weight === undefined || it.weight === null ? 3 : it.weight;
    return '' +
      '<div class="field"><label class="field-label" for="cmKind">类型</label>' +
      '<select class="input" id="cmKind">' + options + '</select></div>' +
      '<div class="field"><label class="field-label" for="cmWho">谁（可空）</label>' +
      '<input class="input" id="cmWho" type="text" maxlength="40" placeholder="例如：主人 / 全体" value="' + esc(it.who || '') + '"></div>' +
      /* qq 单独一列：名字可能重名，QQ 号才是稳定身份；老数据没有这字段，一律当空处理 */
      '<div class="field"><label class="field-label" for="cmQQ">QQ 号（可空）</label>' +
      '<input class="input mono" id="cmQQ" type="text" inputmode="numeric" autocomplete="off" maxlength="12" placeholder="例如：111111111" value="' + esc(it.qq || '') + '">' +
      '<div class="field-hint">留空表示只记名字；填了就按 QQ 号也能搜到。</div></div>' +
      '<div class="field"><label class="field-label" for="cmText">正文' +
      '<span class="crud-counter mono" id="cmCount">0/200</span></label>' +
      '<textarea class="input textarea" id="cmText" rows="4" placeholder="一句话说清楚，Molly 之后会按权重取用">' + esc(it.text || '') + '</textarea></div>' +
      '<div class="field"><label class="field-label" for="cmWeight">权重（1–5，越高越常被想起）</label>' +
      '<input class="input" id="cmWeight" type="number" min="1" max="5" step="1" value="' + esc(String(weight)) + '"></div>';
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
      title: '新增记忆',
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
      title: '改记忆',
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
    if (!isFinite(weight) || Math.round(weight) !== weight || weight < 1 || weight > 5) {
      throw new Error('权重必须是 1–5 的整数');
    }
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
        toast(merged ? '内容相近，已合并到已有条目（没有新增）' : '已添加');
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
    var ov = state.overview;
    if (!ov) { setHtml(box, card('等待数据', '<p class="card-sub">正在连接控制台服务…</p>')); return; }

    var p = ov.plugin || {};
    var work = p.work || ov.work || null;
    var research = p.research || ov.research || null;
    var qqTool = p.qqTool || ov.qqTool || null;

    var workHtml = work
      ? [
        kv('就绪', work.ready ? pill('ok', 'ready') : pill('idle', '未就绪')),
        kv('会话', work.sessionId ? '<span class="mono">' + esc(work.sessionId) + '</span>' : '—'),
        kv('运行中', work.running ? pill('warn', '正在跑') : '否'),
        kv('当前任务', val(work.task)),
        work.error ? kv('错误', esc(work.error), 'is-bad') : ''
      ].join('')
      : '<p class="card-sub">契约 v1 的 /api/overview 未暴露 work 字段，可用下方「探活」现场探测。</p>';

    var researchHtml = research
      ? [
        kv('开关', research.enabled === false ? pill('idle', '已关闭') : pill('ok', '已开启')),
        kv('上次结果', research.ok ? pill('ok', '成功') : pill('warn', '失败')),
        kv('上次时间', fmtStamp(research.lastAt)),
        kv('上次需求', val(research.lastNeed)),
        kv('上次原因', val(research.lastReason)),
        kv('找到条数', mono(research.lastFound)),
        kv('耗时', fmtMs(research.lastMs))
      ].join('')
      : '<p class="card-sub">契约 v1 未暴露 research 字段，可用下方「研究测试」现场验证。</p>';

    var toolHtml = qqTool
      ? [
        kv('工具名', val(qqTool.name)),
        kv('注册', qqTool.registered ? pill('ok', '已注册') : pill('bad', '未注册')),
        qqTool.error ? kv('错误', esc(qqTool.error), 'is-bad') : ''
      ].join('')
      : '<p class="card-sub">契约 v1 未暴露 qqTool 字段。</p>';

    setHtml(box, [
      card('工作总线', workHtml),
      card('研究', researchHtml),
      card('QQ 工具', toolHtml)
    ].join(''));
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

  /* ---------------- NapCat ---------------- */

  function renderNapcat() {
    var box = $('#ncCards');
    if (!box) return;
    var ov = state.overview;
    if (!ov) { setHtml(box, card('等待数据', '<p class="card-sub">正在连接控制台服务…</p>')); return; }

    var nc = ov.napcat || {};
    var bot = (ov.plugin && ov.plugin.bot) || {};
    if (!nc.reachable) {
      setHtml(box, card('NapCat 不可达', '<p class="ar-error">' + esc(nc.error || 'WebUI 未响应') + '</p>'));
      return;
    }

    var qrBody = nc.qrcodeurl
      ? '<p class="card-sub">当前二维码地址：<a href="' + esc(nc.qrcodeurl) + '" target="_blank" rel="noreferrer">打开</a></p>'
      : '<p class="card-sub">当前没有待扫的二维码。已登录时不需要扫码。</p>';

    setHtml(box, [
      card('登录态', [
        kv('状态', nc.isLogin ? pill('ok', '已登录') : pill('warn', '未登录')),
        kv('阶段', val(nc.loginPhase)),
        /* NapCat 的 CheckLoginStatus 不返回 uin，退回插件侧的 bot.userId */
        kv('QQ 号', (nc.uin || bot.userId)
          ? '<span class="mono">' + esc(nc.uin || bot.userId) + '</span>'
          : '—'),
        kv('核心就绪', nc.coreReady ? '是' : '否'),
        nc.loginError ? kv('错误', esc(nc.loginError), 'is-bad') : ''
      ].join('')),
      card('服务', [
        kv('WebUI', pill('ok', '可达')),
        kv('端口', '<span class="mono">6099</span>'),
        kv('OneBot', '<span class="mono">3001</span>')
      ].join('')),
      card('二维码', qrBody)
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
    var map = { ready: '就绪', waiting_qrcode: '等待扫码', waiting: '等待扫码', offline: '离线' };
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
    var kind = 'idle';
    var head = '正在读取…';
    var note = '';
    var uin = loginUin();

    if (!ov) {
      head = '正在连接控制台服务…';
    } else if (!nc.reachable) {
      kind = 'bad';
      head = 'NapCat 不可达';
      note = String(nc.error || 'WebUI 未响应');
    } else if (nc.isLogin) {
      kind = 'ok';
      head = '已登录';
      note = 'Molly ' + (uin || '（QQ 号未知）');
    } else {
      kind = 'warn';
      head = '等待扫码';
      note = lg.waiting ? '二维码已就绪，用手机 QQ 扫一下' : '还没登录：点下面的「生成二维码」';
    }

    box.innerHTML = '<article class="card login-status-card is-' + kind + '">' +
      '<div class="login-status-head">' + pill(kind, head) +
        '<span class="login-status-note">' + esc(note) + '</span>' +
      '</div>' +
      '<div class="login-status-grid">' +
        kv('登录阶段', nc.reachable ? esc(loginPhaseText(nc.loginPhase)) : '—') +
        kv('核心就绪', nc.reachable ? (nc.coreReady ? '是' : '否') : '—') +
        kv('QQ 号', uin ? '<span class="mono">' + esc(uin) + '</span>' : '—') +
        kv('二维码', lg.png ? pill('warn', '已生成') : pill('idle', '未生成')) +
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
      gen.textContent = lg.generating ? '生成中…' : (lg.waiting ? '换一张' : '生成二维码');
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
      }
    }

    /* 导航上的橙点：只在「有一张还没扫的码」时亮，成功或过期即灭 */
    var badge = $('#loginBadge');
    if (badge) badge.hidden = !(lg.waiting && !lg.success);
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
    prog.textContent = '正在生成二维码，已等待 ' + secs + ' 秒（通常 2–6 秒）';
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
      if (state.page !== 'login') { stopLoginPoll(); return; }
      safe(loginPollTick);
    }, QR_POLL_MS);
  }

  function startLoginCountdown() {
    stopLoginCountdown();
    qrCountTimer = setInterval(function () { safe(loginCountdownTick); }, 1000);
  }

  function loginPollTick() {
    var lg = state.login;
    if (!lg.waiting) { stopLoginPoll(); return; }
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
        var nc = j.napcat || {};
        if (nc.isLogin) {
          /* 码还在生成时就已经在线：说明用户本来就是登录状态，不是刚扫上的 */
          markLoginSuccess(lg.generating ? { already: true } : {});
          return;
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
    if (state.page !== 'login') {
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

  /* opts.already 表示「本来就在线，后端没给码」：这时候说「扫码成功」是在骗人 */
  function markLoginSuccess(opts) {
    var lg = state.login;
    opts = opts || {};
    lg.waiting = false;
    lg.expiresAt = 0;
    lg.png = '';
    lg.url = '';
    lg.imgSrc = '';
    lg.error = '';
    lg.hint = '';
    lg.success = 'Molly ' + (loginUin() || '（QQ 号未知）');
    lg.successNote = opts.already
      ? '本来就在线，不需要扫码。'
      : '扫码成功，Molly 已经能正常收发消息了。';
    stopLoginPoll();
    stopLoginCountdown();
    safe(renderLogin);
    toast(opts.already ? '本来就在线，不需要扫码' : '扫码登录成功');
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

  /* 进登录页：只恢复现场，不自动生成；例外是总览黄条点进来（loginAutoStart）
     和「停在别处时码过期了」——这两种情况下用户本来就想要一张新码。 */
  function enterLoginPage() {
    var lg = state.login;
    safe(renderLogin);
    if (lg.generating || lg.success) return;

    if (state.loginAutoStart) {
      state.loginAutoStart = false;
      if (!lg.waiting) { generateQr(); return; }
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
        kv('主题', '浅色 Notion'),
        kv('主色', '<span class="mono">#5645d4</span>'),
        kv('字体', '系统字体，无外链'),
        kv('构建', '无（原生 HTML/CSS/JS）')
      ].join(''))
    ].join(''));
  }

  function loadHealth() {
    fetch('/api/health', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        state.health = j || {};
        var fv = $('#footVersion');
        if (fv && state.health.version) fv.textContent = 'v' + state.health.version;
        if (state.page === 'settings') safe(renderSettings);
      })
      .catch(function (err) { console.warn('[molly-console] health 读取失败：', err); });
  }

  /* ---------------- 执行块 ---------------- */

  var ACTIONS = [
    {
      id: 'plugin/toggle',
      title: '开关插件',
      desc: '启用或停用 Molly 插件本体，经服务端转发到宿主 /toggle。',
      fields: [{ key: 'enabled', label: '目标状态', type: 'select', cast: 'bool', def: 'true', options: [{ value: 'true', label: '启用' }, { value: 'false', label: '停用' }] }]
    },
    {
      id: 'plugin/recheck',
      title: '重新检查连接',
      desc: '让插件重连 OneBot，并刷新模型与账号信息。'
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
      id: 'plugin/work-probe',
      title: '工作总线探活',
      desc: '转发 /work/probe，确认干活通道是否可用。'
    },
    {
      id: 'plugin/work-run',
      title: '跑一条指令',
      desc: '转发 /work/run。任务文本不能为空，默认不发送到 QQ。',
      fields: [{ key: 'task', label: '指令内容', type: 'text', cast: 'string', required: true, placeholder: '例如：总结今天群里的讨论' }]
    },
    {
      id: 'plugin/research-test',
      title: '研究测试',
      desc: '转发 /research/test，用一段文本验证研究链路。',
      fields: [{ key: 'text', label: '测试文本', type: 'text', cast: 'string', required: true, placeholder: '例如：最近有没有新的表情包' }]
    },
    {
      id: 'napcat/qr',
      title: '生成登录二维码',
      desc: 'spawn make-qr.mjs，成功后把二维码显示在卡片里（最长等 45 秒）。'
    },
    {
      id: 'napcat/restart',
      title: '重启 NapCat 登录',
      desc: 'spawn start-molly.ps1 -Restart，重新拉起 QQ 登录流程。',
      confirm: true,
      consequence: '会踢掉当前 QQ 登录：Molly 立刻掉线，必须重新扫码才能回来。'
    },
    {
      id: 'watchdog/status',
      title: '守护状态',
      desc: 'spawn watchdog.mjs --status，把解析后的状态 JSON 显示在下面。'
    },
    {
      id: 'watchdog/once',
      title: '立即巡检一次',
      desc: 'spawn watchdog.mjs --once，最长等 120 秒。'
    },
    {
      id: 'watchdog/test-notify',
      title: '测试通知',
      desc: 'spawn watchdog.mjs --test-notify，确认通知渠道通畅。'
    },
    {
      id: 'watchdog/config',
      title: '改写守护配置',
      desc: '把 patch 合并写进 watchdog-config.json，只允许契约 §3.2 列出的键。',
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
      title: '启动 NapCat 进程',
      desc: 'spawn start-molly.ps1（不带 -Restart），只拉起进程。',
      confirm: true,
      consequence: '会拉起一个新的 NapCat 进程；若已有进程在跑，可能端口冲突。'
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

  function actionCardHtml(a) {
    var fields = (a.fields || []).map(function (f) { return fieldHtml(a, f); }).join('');
    return '<article class="card action-card" data-action="' + esc(a.id) + '">' +
      '<div class="action-head">' +
        '<h2 class="card-title">' + esc(a.title) + '</h2>' +
        '<span class="action-id mono">' + esc(a.id) + '</span>' +
      '</div>' +
      '<p class="action-desc">' + esc(a.desc) + '</p>' +
      (a.consequence ? '<p class="action-consequence">⚠ ' + esc(a.consequence) + '</p>' : '') +
      '<div class="action-fields">' + fields + '</div>' +
      '<div class="action-foot">' +
        '<button class="btn ' + (a.confirm ? 'btn-danger' : 'btn-primary') + ' action-run" type="button">' +
          (a.confirm ? '执行（需确认）' : '执行') + '</button>' +
        '<span class="action-id mono">' + (a.confirm ? 'confirm: true' : 'confirm: false') + '</span>' +
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
      if (res.ok) toast('已执行：' + actionId);
      else toast('失败：' + (res.error || '未知错误'));
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
    var probe = $('#workProbe');
    if (probe) {
      probe.addEventListener('click', function () {
        runAction('plugin/work-probe', {}, { btn: probe, box: $('#workOut') });
      });
    }
    var run = $('#workRun');
    if (run) {
      run.addEventListener('click', function () {
        var t = ($('#workTask') && $('#workTask').value || '').trim();
        if (!t) { toast('先在输入框里写一条指令'); return; }
        runAction('plugin/work-run', { task: t }, { btn: run, box: $('#workOut') });
      });
    }
    var research = $('#workResearch');
    if (research) {
      research.addEventListener('click', function () {
        var t = ($('#workTask') && $('#workTask').value || '').trim();
        if (!t) { toast('先在输入框里写一段测试文本'); return; }
        runAction('plugin/research-test', { text: t }, { btn: research, box: $('#workOut') });
      });
    }

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

    var ncQr = $('#ncQr');
    if (ncQr) {
      ncQr.addEventListener('click', function () {
        runAction('napcat/qr', {}, { btn: ncQr, box: $('#ncOut') });
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
        state.loginAutoStart = true;   /* 由 setPage('login') 消费一次 */
        if (location.hash === '#/login') setPage('login');
        else location.hash = '#/login';
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
      })
      .catch(function (err) {
        /* 失败不清空界面：只标红状态条，旧数据继续留着 */
        state.lastError = err && err.message ? err.message : String(err);
        safe(renderTop);
      });
  }

  function startTimers() {
    stopTimers();
    pollTimer = setInterval(poll, POLL_MS);
    tickTimer = setInterval(function () { safe(updateLinkPill); }, 1000);
    /* 待核实计数单独一条慢轮询：它只在需要时读一遍，不跟 4 秒的 overview 绑在一起 */
    pendTimer = setInterval(function () { safe(pollPending); }, PEND_POLL_MS);
  }

  function stopTimers() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
    if (pendTimer) { clearInterval(pendTimer); pendTimer = null; }
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
      card('NapCat', [
        kv('WebUI', nc.reachable ? pill('ok', '可达') : pill('bad', '不可达')),
        kv('登录态', nc.isLogin ? pill('ok', '已登录') : pill('warn', '未登录')),
        kv('阶段', val(nc.loginPhase)),
        kv('核心就绪', nc.coreReady ? '是' : '否')
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
      desc: '会杀掉 QQ 与 NapCat 进程，Molly 立刻掉线。',
      items: [
        '只停 QQ 与 NapCat；DSH 宿主、网关、控制台本身不动',
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
      desc: '先停 QQ 与 NapCat，等 3 秒再重新拉起。中间会有一段空窗。',
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

  /* ---------------- 路由 ---------------- */

  function currentPage() {
    var h = String(location.hash || '').replace(/^#\/?/, '');
    return PAGES.indexOf(h) >= 0 ? h : 'overview';
  }

  function renderPageNow() {
    switch (state.page) {
      case 'overview': renderOverview(); break;
      case 'chats': renderChats(); break;
      case 'budget': renderBudget(); break;
      case 'work': renderWork(); break;
      case 'watchdog': renderWatchdog(); break;
      case 'ops': renderOps(); break;
      case 'external': renderExternal(); break;
      case 'napcat': renderNapcat(); break;
      case 'login': renderLogin(); break;
      case 'settings': renderSettings(); break;
      default: break;
    }
  }

  function setPage(name) {
    if (PAGES.indexOf(name) < 0) name = 'overview';
    state.page = name;
    $$('.nav-item').forEach(function (a) {
      a.classList.toggle('is-active', a.getAttribute('data-page') === name);
    });
    $$('.page').forEach(function (sec) {
      sec.hidden = sec.getAttribute('data-page') !== name;
    });
    safe(renderPageNow);
    if (name === 'memory') loadMemory();
    /* 进页签时强制拉一次：轮询只动数字，列表可能是几十分钟前的 */
    if (name === 'pending') loadPending(true);
    if (name === 'stickers') loadStickers();
    /* 运维 / 外部服务：进页各拉一次，别让 4 秒轮询拖着外部请求走 */
    if (name === 'ops') loadOpsHeartbeat();
    if (name === 'external') loadExternal();
    /* 登录页只在等待扫码时轮询，离开就停，别在后台空转 */
    if (name === 'login') enterLoginPage();
    else stopLoginPoll();
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindEvents() {
    window.addEventListener('hashchange', function () {
      setPage(currentPage());
    });

    var btnRefresh = $('#btnRefresh');
    if (btnRefresh) btnRefresh.addEventListener('click', function () { poll(); });

    var memSearch = $('#memSearch');
    if (memSearch) memSearch.addEventListener('input', function () { safe(applyMemFilter); });

    var memReload = $('#memReload');
    if (memReload) memReload.addEventListener('click', function () { loadMemory(true); });

    var memAdd = $('#memAdd');
    if (memAdd) memAdd.addEventListener('click', function () { memAddNew(); });

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
        poll();
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

  /* ---------------- 启动 ---------------- */

  function init() {
    try {
      initActions();
      bindQuickActions();
      bindOpsEvents();
      bindEvents();
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
