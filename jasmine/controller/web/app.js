/* 茉莉花控制台 · 前端（经典脚本，无框架、无构建） */
(function () {
  'use strict';

  window.__jzErrors = [];
  window.addEventListener('error', function (ev) {
    window.__jzErrors.push(String((ev && ev.message) || ev));
  });
  window.addEventListener('unhandledrejection', function (ev) {
    window.__jzErrors.push('unhandledrejection: ' + String((ev && ev.reason && ev.reason.message) || (ev && ev.reason)));
  });

  // 七类配色：同一套「书房」低饱和，但色相拉开——绿（称呼/人物/事实）· 琥珀（偏好）· 陶土（约定）· 青灰（事件）· 沙（梗）
  var KIND_LIST = [
    { id: 'address', label: '称呼', color: '#2c5241' },
    { id: 'person', label: '人物', color: '#4d7a5f' },
    { id: 'fact', label: '事实', color: '#86a077' },
    { id: 'preference', label: '偏好', color: '#b9924f' },
    { id: 'promise', label: '约定', color: '#a2604b' },
    { id: 'event', label: '事件', color: '#5f7f96' },
    { id: 'meme', label: '梗与表情', color: '#b9a87f' }
  ];
  var KIND_LABEL = {};
  var KIND_COLOR = {};
  KIND_LIST.forEach(function (k) { KIND_LABEL[k.id] = k.label; KIND_COLOR[k.id] = k.color; });

  var BANDS = [
    // 档位与后端 bandOf() 一一对应：full ≥9.95 / high ≥8 / mid ≥5 / low ≥3 / floor <3
    { id: 'full', label: '满格 10' },
    { id: 'high', label: '高 8–9.9' },
    { id: 'mid', label: '中 5–7.9' },
    { id: 'low', label: '低 3–4.9' },
    { id: 'floor', label: '见底 <3' }
  ];
  var DAYS = [
    { id: 'today', label: '今日' },
    { id: '7d', label: '近 7 天' },
    { id: '30d', label: '近 30 天' },
    { id: '90d', label: '近 90 天' },
    { id: 'older', label: '更早' }
  ];

  var state = {
    route: 'memory',
    list: { q: '', kinds: [], who: [], bands: [], day: '', sort: 'at-desc', offset: 0, limit: 60 },
    rows: [],
    total: 0,
    tokens: [],
    facets: null,
    status: null,
    selectedId: null,
    current: null,
    edges: [],
    curves: null,
    rawLines: [],
    pendingImport: null,
    armArchive: false,
    armRebuild: false
  };

  /* ------------------------------------------------------------- 工具 */

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtTime(ts) {
    if (!ts) return '—';
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '—';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function fmtDay(ts) {
    if (!ts) return '—';
    var d = new Date(Number(ts));
    if (isNaN(d.getTime())) return '—';
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function fmtW(n) {
    var v = Math.round(Number(n) * 10) / 10;
    return (v % 1 === 0 ? String(v) : v.toFixed(1));
  }
  function pct(a, b) { return b ? Math.round((a / b) * 1000) / 10 : 0; }

  function toast(msg, kind) {
    var box = $('#toasts');
    if (!box) return;
    var el = document.createElement('div');
    el.className = 'toast' + (kind ? ' ' + kind : '');
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(function () {
      el.style.opacity = '0';
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 220);
    }, 3200);
  }

  async function api(path, body) {
    var opt = body === undefined
      ? { method: 'GET' }
      : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
    var res = await fetch(path, opt);
    var data = null;
    try { data = await res.json(); } catch (err) { data = null; }
    if (!res.ok || !data || data.ok === false) {
      throw new Error((data && data.error) || ('请求失败：' + res.status + ' ' + path));
    }
    return data;
  }

  function highlight(text) {
    var out = esc(text);
    if (!state.tokens || !state.tokens.length) return out;
    state.tokens.forEach(function (t) {
      if (!t) return;
      var re = new RegExp(escRe(esc(t)), 'gi');
      out = out.replace(re, function (m) { return '<mark>' + m + '</mark>'; });
    });
    return out;
  }

  function kindBadge(kind) {
    return '<span class="kb kb-' + esc(kind) + '">' + esc(KIND_LABEL[kind] || kind) + '</span>';
  }

  /* ------------------------------------------------------------- 记忆库 */

  async function loadList(reset) {
    if (reset) state.list.offset = 0;
    var body = {
      q: state.list.q,
      kinds: state.list.kinds,
      who: state.list.who,
      bands: state.list.bands,
      day: state.list.day,
      sort: state.list.sort,
      offset: state.list.offset,
      limit: state.list.limit
    };
    var data = await api('/api/list', body);
    state.rows = reset ? data.entries.slice() : state.rows.concat(data.entries);
    state.total = data.total;
    state.tokens = data.tokens || [];
    state.facets = data.facets;
    state.status = data.status;
    state.list.offset = state.rows.length;
    renderShell();
    renderMetrics();
    renderDist();
    renderIndex();
    renderRows();
    window.__jzReady = true;
    window.__jzState = {
      route: state.route, total: state.total, shown: state.rows.length,
      sort: state.list.sort, q: state.list.q, count: state.status ? state.status.count : 0
    };
  }

  function renderShell() {
    var st = state.status;
    if (!st) return;
    var dirEl = $('#sideDir');
    // 侧栏只有 216px，长路径留尾部（数据目录的末级最有辨识度），完整路径放 title
    dirEl.textContent = st.dir.length > 30 ? '…' + st.dir.slice(-29) : st.dir;
    dirEl.title = st.dir;
    $('#memSub').textContent = 'Jasmine · ' + st.count + ' 条 · 活跃天 ' + st.activeDays;
  }

  function renderMetrics() {
    var st = state.status;
    var f = state.facets;
    if (!st || !f) return;
    var identifiedPct = st.count ? Math.round((st.identified / st.count) * 100) : 0;
    var cards = [
      { label: '总条数', value: String(st.count), note: '上限 ' + st.limit + ' · 归档 ' + st.archiveCount },
      { label: '今日新增', value: String(f.days.today || 0), note: '同一天写入本库' },
      { label: '有身份占比', value: identifiedPct + '<small>%</small>', note: st.identified + ' 条带人物或 QQ' },
      { label: '平均有效权重', value: fmtW(st.avgEff), note: '已按宽限与步长衰减' }
    ];
    $('#metrics').innerHTML = cards.map(function (c) {
      return '<div class="metric"><div class="metric-label">' + esc(c.label) + '</div>' +
        '<div class="metric-value">' + c.value + '</div>' +
        '<div class="metric-note">' + esc(c.note) + '</div></div>';
    }).join('');
  }

  function renderDist() {
    var f = state.facets;
    if (!f) return;
    var total = 0;
    KIND_LIST.forEach(function (k) { total += f.kinds[k.id] || 0; });
    var segs = KIND_LIST.map(function (k) {
      var n = f.kinds[k.id] || 0;
      if (!n) return '';
      return '<span class="dist-seg" style="flex:' + n + ' 1 0;background:' + k.color +
        '" title="' + esc(k.label) + ' ' + n + ' 条 · ' + pct(n, total) + '%"></span>';
    }).join('');
    $('#distBar').innerHTML = segs || '<span class="dist-seg" style="flex:1;background:#eeebe2"></span>';
    $('#distLegend').innerHTML = KIND_LIST.map(function (k) {
      var n = f.kinds[k.id] || 0;
      return '<span class="lg" title="' + esc(k.label) + ' 占 ' + pct(n, total) + '%">' +
        '<i class="dot" style="background:' + k.color + '"></i>' + esc(k.label) +
        ' <b>' + n + '</b></span>';
    }).join('');
  }

  function idxGroup(title, group, items, active) {
    var head = '<div class="idx-title"><span>' + esc(title) + '</span>' +
      (active.length ? '<button class="idx-clear" data-g="' + group + '" data-clear="1" type="button">清除</button>' : '') +
      '</div>';
    var body = items.map(function (it) {
      var on = active.indexOf(it.v) >= 0;
      var dot = it.color ? '<i class="dot" style="background:' + it.color + '"></i>' : '';
      return '<div class="idx-item' + (on ? ' on' : '') + '" data-g="' + group + '" data-v="' + esc(it.v) + '"' +
        (it.title ? ' title="' + esc(it.title) + '"' : '') + '>' +
        '<span class="name">' + dot + esc(it.label) + '</span><span class="n">' + it.n + '</span></div>';
    }).join('');
    return '<div class="idx-group">' + head + body + '</div>';
  }

  function renderIndex() {
    var f = state.facets;
    if (!f) return;
    var kinds = KIND_LIST.map(function (k) {
      return { v: k.id, label: k.label, n: f.kinds[k.id] || 0, color: k.color };
    });
    var who = (f.who || []).map(function (w) {
      return { v: w.who, label: w.who, n: w.count };
    });
    if (!who.length) who = [{ v: '__none', label: '（还没有人物）', n: 0 }];

    var bands = BANDS.map(function (b) {
      return { v: b.id, label: b.label, n: f.bands[b.id] || 0 };
    });
    var days = DAYS.map(function (d) {
      return { v: d.id, label: d.label, n: (f.days[d.id] || 0) };
    });

    $('#idx').innerHTML =
      idxGroup('类型', 'kinds', kinds, state.list.kinds) +
      idxGroup('人物 Top12', 'who', who, state.list.who) +
      idxGroup('权重档', 'bands', bands, state.list.bands) +
      idxGroup('时间', 'day', days, state.list.day ? [state.list.day] : []);
  }

  function renderRows() {
    var box = $('#rows');
    var st = state.status;
    if (!state.rows.length) {
      if (st && st.count === 0) {
        box.innerHTML = '<div class="empty"><div class="glyph">❀</div>' +
          '<h3>这本记忆簿还是空的</h3>' +
          '<p>茉莉花会把值得记的话存成条目，按七类分好，用久了权重会自己往下掉。先记一条试试，或者从别处导入一份 bundle。</p>' +
          '<div class="empty-actions">' +
          '<button class="btn btn-primary" data-act="add" type="button">＋ 记一条</button>' +
          '<button class="btn" data-act="go-import" type="button">从 bundle 导入</button>' +
          '</div></div>';
      } else {
        box.innerHTML = '<div class="empty"><div class="glyph">·</div>' +
          '<h3>没有符合条件的记忆</h3><p>换个词，或者把左边的筛选清掉。</p>' +
          '<div class="empty-actions"><button class="btn" data-act="clear-filters" type="button">清空筛选</button></div></div>';
      }
      $('#listFoot').hidden = true;
      renderCount();
      return;
    }
    box.innerHTML = state.rows.map(function (e) {
      var w = '权重 ' + fmtW(e.base) + (e.eff !== e.base ? '→' + fmtW(e.eff) : '');
      return '<div class="row' + (e.id === state.selectedId ? ' on' : '') + '" data-id="' + esc(e.id) + '">' +
        '<div class="row-text">' + highlight(e.text) + '</div>' +
        '<div class="row-meta">' +
        '<span>' + fmtDay(e.at) + '</span><span class="sep">·</span>' +
        kindBadge(e.kind) + '<span class="sep">·</span>' +
        '<span class="wt ' + (e.dropped > 0 ? 'wt-down' : 'wt-flat') + '">' + w + '</span><span class="sep">·</span>' +
        '<span>命中 ' + (e.hits || 0) + ' 次</span>' +
        (e.who ? '<span class="sep">·</span><span>' + esc(e.who) + '</span>' : '') +
        '</div></div>';
    }).join('');
    $('#listFoot').hidden = !(state.rows.length < state.total);
    renderCount();
  }

  function renderCount() {
    var st = state.status;
    var txt = '共 ' + state.total + ' 条';
    if (state.rows.length < state.total) txt += ' · 已显示 ' + state.rows.length;
    if (state.tokens && state.tokens.length) txt += ' · 命中「' + state.tokens.join(' ') + '」';
    if (st && state.total === st.count) txt = '共 ' + st.count + ' 条';
    $('#countText').textContent = txt;
  }

  /* ------------------------------------------------------------- 详情 */

  async function openDetail(id) {
    var data = await api('/api/item?id=' + encodeURIComponent(id));
    state.current = data.entry;
    state.edges = data.edges || [];
    state.selectedId = id;
    renderRows();
    renderDrawer();
    $('#drawerWrap').classList.add('open');
  }

  function closeDetail() {
    state.selectedId = null;
    state.current = null;
    state.edges = [];
    $('#drawerWrap').classList.remove('open');
    renderRows();
  }

  function renderDrawer() {
    var e = state.current;
    if (!e) return;
    var cap;
    if (e.graceInf) {
      cap = '称呼不衰减，权重恒为 10。';
    } else if (e.idle <= e.grace) {
      cap = '基础权重 <b>' + fmtW(e.base) + '</b>，已空闲 <b>' + e.idle + '</b> 活跃天，仍在宽限 <b>' +
        e.grace + '</b> 天内，还没开始掉。';
    } else {
      cap = '基础权重 <b>' + fmtW(e.base) + '</b>，已空闲 <b>' + e.idle + '</b> 活跃天，超出宽限 <b>' +
        e.grace + '</b> 天 <b>' + (e.idle - e.grace) + '</b> 天；每 <b>' + e.stepDays + '</b> 活跃天 −<b>' +
        fmtW(e.step) + '</b>，已掉 <b>' + fmtW(e.dropped) + '</b>，下限 <b>' + fmtW(e.floor) + '</b>。';
    }
    var kv = [
      ['类型', kindBadge(e.kind)],
      ['人物', e.who ? esc(e.who) : '<span class="muted">—</span>'],
      ['QQ', e.qq ? esc(e.qq) : '<span class="muted">—</span>'],
      ['来源', esc(e.source || 'user')],
      ['命中', (e.hits || 0) + ' 次'],
      ['加入', fmtTime(e.at)],
      ['最后命中', e.lastHitAt ? fmtTime(e.lastHitAt) : '还没被召回'],
      ['最后活跃', '活跃天 ' + (e.lastActiveDay == null ? '—' : e.lastActiveDay)],
      ['id', '<span class="mono">' + esc(e.id) + '</span>']
    ];
    var kvHtml = kv.map(function (kv2) {
      return '<div><dt>' + esc(kv2[0]) + '</dt><dd>' + kv2[1] + '</dd></div>';
    }).join('');

    var edgesHtml = state.edges.length
      ? '<div class="d-sec">关联</div>' + state.edges.map(function (ed) {
        return '<div class="edge"><span class="rel">' + (ed.rel === 'supersedes' ? '取代了' : '被取代') + '</span>' +
          '<span class="t" title="' + esc(ed.text) + '">' + esc(ed.text) + '</span></div>';
      }).join('')
      : '';

    $('#drawer').innerHTML =
      '<div class="d-top">' + kindBadge(e.kind) +
      '<button class="icon-btn" data-act="close-detail" type="button" aria-label="关闭">×</button></div>' +
      '<div class="d-text">' + esc(e.text) + '</div>' +
      '<div class="weight-box">' +
      '<div class="weight-nums">' +
      '<span class="wnum"><i>基础权重</i><b>' + fmtW(e.base) + '</b></span>' +
      '<span class="to">→</span>' +
      '<span class="wnum"><i>有效权重</i><b class="eff' + (e.dropped > 0 ? ' dropped' : '') + '">' + fmtW(e.eff) + '</b></span>' +
      '<span class="arrow-note">' + (e.dropped > 0 ? '已掉 ' + fmtW(e.dropped) : '还没掉') + '</span>' +
      '</div>' +
      '<div class="weight-cap">' + cap + '</div>' +
      '<div class="weight-bar"><i style="width:' + Math.max(2, Math.min(100, (e.eff / 10) * 100)) + '%"></i></div>' +
      '</div>' +
      '<div class="d-sec">这条记忆</div><dl class="d-kv">' + kvHtml + '</dl>' +
      edgesHtml +
      '<div class="d-actions">' +
      '<button class="btn" data-act="edit" type="button">改这条</button>' +
      '<button class="btn btn-danger" data-act="del" type="button">删这条</button>' +
      '<button class="btn btn-ghost" data-act="to-search" type="button">载入到检索框</button>' +
      '</div>';
  }

  /* ------------------------------------------------------------- 弹窗 */

  function fillSelects() {
    var ks = $('#f-kind');
    if (!ks.options.length) {
      ks.innerHTML = KIND_LIST.map(function (k) {
        return '<option value="' + k.id + '">' + esc(k.label) + '</option>';
      }).join('');
    }
    var ws = $('#f-weight');
    if (!ws.options.length) {
      var opts = '';
      for (var i = 10; i >= 1; i--) opts += '<option value="' + i + '">' + i + '</option>';
      ws.innerHTML = opts;
    }
  }

  function openModal(entry) {
    fillSelects();
    $('#modalTitle').textContent = entry ? '改这条' : '记一条';
    $('#modalSubmit').textContent = entry ? '保存' : '写进去';
    $('#f-id').value = entry ? entry.id : '';
    $('#f-text').value = entry ? entry.text : '';
    $('#f-kind').value = entry ? entry.kind : 'fact';
    $('#f-weight').value = String(entry ? Math.round(entry.base || entry.weight || 6) : 6);
    $('#f-who').value = entry ? (entry.who || '') : '';
    $('#f-qq').value = entry ? (entry.qq || '') : '';
    updateTextNote();
    $('#modalMask').hidden = false;
    setTimeout(function () { $('#f-text').focus(); }, 30);
  }

  function closeModal() {
    $('#modalMask').hidden = true;
    $('#entryForm').reset();
    $('#f-id').value = '';
  }

  function updateTextNote() {
    var n = Array.from($('#f-text').value).length;
    $('#f-textNote').textContent = n + ' / 200';
  }

  async function submitModal(ev) {
    ev.preventDefault();
    var id = $('#f-id').value;
    var text = $('#f-text').value.trim();
    if (!text) { toast('正文不能为空', 'warn'); return; }
    var payload = {
      text: text,
      kind: $('#f-kind').value,
      weight: Number($('#f-weight').value),
      who: $('#f-who').value.trim(),
      qq: $('#f-qq').value.trim()
    };
    var submit = $('#modalSubmit');
    submit.disabled = true;
    try {
      var data;
      if (id) {
        data = await api('/api/update', { id: id, patch: payload });
        toast('改好了');
      } else {
        data = await api('/api/add', payload);
        if (data.merged) toast('这句太像旧条目了，已合并进去', 'warn');
        else toast('记下了');
        if (data.truncated) toast('正文超过 200 字，已截断', 'warn');
      }
      closeModal();
      await loadList(true);
      if (id && state.selectedId === id) await openDetail(id);
      else if (data && data.entry && data.entry.id && !id) await openDetail(data.entry.id);
    } catch (err) {
      toast(err.message || String(err), 'err');
    } finally {
      submit.disabled = false;
    }
  }

  /* ------------------------------------------------------------- 曲线 */

  async function loadCurves() {
    var data = await api('/api/curves');
    state.curves = data;
    var base = data.baseBands || [];
    var eff = data.effBands || [];
    var max = 1;
    base.concat(eff).forEach(function (n) { if (n > max) max = n; });

    var groups = '';
    for (var i = 0; i < 10; i++) {
      var b = base[i] || 0;
      var e = eff[i] || 0;
      groups += '<div class="bar-group">' +
        '<div class="bar bar-base" style="height:' + Math.max(1, (b / max) * 100) + '%" data-tip="基础 ' + (i + 1) + ' · ' + b + ' 条"></div>' +
        '<div class="bar bar-eff" style="height:' + Math.max(1, (e / max) * 100) + '%" data-tip="有效 ' + (i + 1) + ' · ' + e + ' 条"></div>' +
        '</div>';
    }
    $('#chart').innerHTML = groups;
    var axis = $('#chartAxis');
    if (axis) {
      var ax = '';
      for (var j = 1; j <= 10; j++) ax += '<span>' + j + '</span>';
      axis.innerHTML = ax;
    }
    var moved = 0;
    base.forEach(function (b2, k) { moved += Math.abs((b2 || 0) - (eff[k] || 0)); });
    $('#chartNote').textContent = '活跃天 ' + data.activeDays + ' · 共 ' + (data.baseBands || []).reduce(function (a, b3) { return a + b3; }, 0) + ' 条 · 两档相差 ' + Math.round(moved / 2) + ' 条次';
    $('#curvesSub').textContent = '基础权重与有效权重 · 同一坐标 · 活跃天 ' + data.activeDays;

    $('#decayTable').querySelector('tbody').innerHTML = data.kinds.map(function (k) {
      return '<tr>' +
        '<td class="kname">' + esc(KIND_LABEL[k.kind] || k.kind) + '</td>' +
        '<td class="num' + (k.count ? '' : ' zero') + '">' + k.count + '</td>' +
        '<td class="num">' + (k.graceInf ? '∞' : k.grace) + '</td>' +
        '<td class="num">−' + fmtW(k.step) + ' / ' + k.stepDays + ' 天</td>' +
        '<td class="num">' + fmtW(k.floor) + '</td>' +
        '<td class="num' + (k.idleMax == null ? ' zero' : '') + '">' + (k.idleMax == null ? '—' : k.idleMax) + '</td>' +
        '<td class="num' + (k.archivable ? '' : ' zero') + '">' + k.archivable + '</td>' +
        '</tr>';
    }).join('');

    var arch = data.archive || [];
    $('#archCount').textContent = String(arch.length);
    if (!arch.length) {
      $('#archList').innerHTML = '<div class="arch-empty">归档簿是空的。只有当事件/梗见底、且超过 ' + 90 + ' 活跃天没动过，才会被挪进来。</div>';
    } else {
      $('#archList').innerHTML = arch.map(function (a) {
        return '<div class="arch-item">' + kindBadge(a.kind) +
          '<span class="t" title="' + esc(a.text) + '">' + esc(a.text) + '</span>' +
          '<span class="when">' + (a.archivedAt ? fmtDay(a.archivedAt) : '—') + '</span>' +
          '<button class="btn btn-sm" data-act="restore" data-id="' + esc(a.id) + '" type="button">取回</button>' +
          '</div>';
      }).join('');
    }
  }

  /* ------------------------------------------------------------- 数据 */

  async function loadData() {
    await refreshStatus();
    renderDataKv();
    await loadRaw();
  }

  async function refreshStatus() {
    var st = await api('/api/status');
    state.status = st;
    renderShell();
    return st;
  }

  function renderDataKv() {
    var st = state.status;
    if (!st) return;
    var rows = [
      ['数据目录', '<span class="mono">' + esc(st.dir) + '</span>'],
      ['条数 / 上限', st.count + ' / ' + st.limit],
      ['归档簿', st.archiveCount + ' 条（超过 ' + st.archiveLimitDays + ' 活跃天的陈旧条目）'],
      ['字符数', String(st.chars)],
      ['活跃天', st.activeDays + (st.activeDayKey ? '（' + st.activeDayKey + '）' : '')],
      ['上次压缩', st.lastCompactionAt ? fmtTime(st.lastCompactionAt) : '还没压缩过'],
      ['类型分布', KIND_LIST.map(function (k) { return k.label + ' ' + (st.counts[k.id] || 0); }).join(' · ')],
      ['库文件', st.broken ? '<span style="color:var(--danger)">读盘有问题</span>' : '正常']
    ];
    $('#dataKv').innerHTML = rows.map(function (r) {
      return '<dt>' + esc(r[0]) + '</dt><dd>' + r[1] + '</dd>';
    }).join('');
    $('#dataSub').textContent = '原始账 · 导入导出 · 维护 · ' + st.count + ' 条';
    $('#archDays').textContent = String(st.archiveLimitDays || 90);
  }

  function rawSummary(line) {
    var e = line.entry || (Array.isArray(line.entries) && line.entries[0]) || null;
    var parts = [];
    if (e && e.text) parts.push(e.text);
    if (line.id) parts.push('#' + line.id);
    if (line.ids) parts.push('ids=' + (Array.isArray(line.ids) ? line.ids.length : line.ids));
    if (line.count != null) parts.push('count=' + line.count);
    if (line.added != null) parts.push('+' + line.added);
    if (line.moved != null) parts.push('moved=' + line.moved);
    if (line.dryRun != null) parts.push('dryRun=' + line.dryRun);
    if (!parts.length) {
      var s = JSON.stringify(line);
      parts.push(s.length > 180 ? s.slice(0, 180) + '…' : s);
    }
    return parts.join(' · ');
  }

  async function loadRaw() {
    var data = await api('/api/raw?limit=200');
    state.rawLines = data.lines || [];
    if (!state.rawLines.length) {
      $('#rawList').innerHTML = '<div class="raw-empty">原始账还是空的。</div>';
      return;
    }
    $('#rawList').innerHTML = state.rawLines.map(function (line) {
      var op = String(line.op || '?');
      var cls = ['add', 'update', 'remove', 'archive', 'hits', 'merge', 'restore', 'week', 'import'].indexOf(op) >= 0
        ? 'op-' + op : 'op-default';
      return '<div class="raw-line"><span class="raw-t">' + fmtTime(line.t) + '</span>' +
        '<span class="raw-op ' + cls + '">' + esc(op) + '</span>' +
        '<span class="raw-body">' + esc(rawSummary(line)) + '</span></div>';
    }).join('');
    var box = $('#rawList');
    box.scrollTop = box.scrollHeight;
  }

  async function doExport() {
    try {
      var res = await fetch('/api/export');
      if (!res.ok) throw new Error('导出失败：' + res.status);
      var blob = await res.blob();
      var d = new Date();
      var name = 'jasmine-bundle-' + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '.json';
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
      toast('导出 ' + name + '（' + Math.round(blob.size / 1024) + ' KB）');
    } catch (err) {
      toast(err.message || String(err), 'err');
    }
  }

  function handleImportFile(ev) {
    var file = ev.target.files && ev.target.files[0];
    state.pendingImport = null;
    $('#btnImportConfirm').disabled = true;
    $('#btnImportCancel').disabled = true;
    if (!file) return;
    var reader = new FileReader();
    reader.onload = async function () {
      var parsed;
      try {
        parsed = JSON.parse(String(reader.result));
      } catch (err) {
        $('#importPreview').innerHTML = '<span class="warn">这个文件不是合法 JSON。</span>';
        return;
      }
      $('#importPreview').textContent = '正在预览…';
      try {
        var preview = await api('/api/import', { bundle: parsed, dryRun: true });
        state.pendingImport = parsed;
        $('#importPreview').innerHTML =
          '将 <span class="ok-line">新增 ' + preview.added + ' 条</span> · 合并 ' + preview.merged +
          ' 条 · 跳过 ' + preview.skipped + ' 条<br>' +
          '<span style="color:var(--faint)">当前 ' + preview.countBefore + ' 条 → 预览后约 ' +
          (preview.countBefore + preview.added) + ' 条；合并按 id 取较新的一条。</span>';
        $('#btnImportConfirm').disabled = false;
        $('#btnImportCancel').disabled = false;
      } catch (err2) {
        $('#importPreview').innerHTML = '<span class="warn">' + esc(err2.message || err2) + '</span>';
      }
    };
    reader.readAsText(file, 'utf-8');
  }

  async function confirmImport() {
    if (!state.pendingImport) return;
    var btn = $('#btnImportConfirm');
    btn.disabled = true;
    try {
      var res = await api('/api/import', { bundle: state.pendingImport, dryRun: false });
      toast('导入完成：新增 ' + res.added + '，合并 ' + res.merged + '，现有 ' + res.count + ' 条');
      state.pendingImport = null;
      $('#importPreview').textContent = '已导入。新增 ' + res.added + ' 条，合并 ' + res.merged + ' 条。';
      $('#btnImportConfirm').disabled = true;
      $('#btnImportCancel').disabled = true;
      $('#importFile').value = '';
      await refreshStatus();
      renderDataKv();
      if (state.route === 'memory') await loadList(true);
    } catch (err) {
      toast(err.message || String(err), 'err');
    } finally {
      btn.disabled = state.pendingImport == null;
    }
  }

  async function archiveClick() {
    var btn = $('#btnArchive');
    try {
      if (!state.armArchive) {
        var dry = await api('/api/archive-stale', { dryRun: true });
        if (!dry.wouldMove) { toast('没有可归档的条目（要事件/梗、权重见底、且 ' + dry.threshold + ' 活跃天没动）'); return; }
        state.armArchive = true;
        btn.textContent = '确认归档 ' + dry.wouldMove + ' 条';
        toast('预计归档 ' + dry.wouldMove + ' 条，再点一次确认', 'warn');
        return;
      }
      var res = await api('/api/archive-stale', { dryRun: false });
      state.armArchive = false;
      btn.textContent = '查看预计';
      toast('已归档 ' + res.moved + ' 条，主库剩 ' + res.status.count + ' 条');
      await refreshStatus();
      renderDataKv();
      if (state.route === 'memory') await loadList(true);
    } catch (err) {
      state.armArchive = false;
      btn.textContent = '查看预计';
      toast(err.message || String(err), 'err');
    }
  }

  async function rebuildClick() {
    var btn = $('#btnRebuild');
    if (!state.armRebuild) {
      state.armRebuild = true;
      btn.textContent = '再点一次确认重建';
      toast('重建会用原始账覆盖当前条目，改动前先导出一份', 'warn');
      return;
    }
    state.armRebuild = false;
    btn.textContent = '重建';
    try {
      var res = await api('/api/rebuild', {});
      toast('重建完成：' + res.count + ' 条，归档 ' + res.archive + ' 条，扫了 ' + res.scanned + ' 行');
      await refreshStatus();
      renderDataKv();
      await loadRaw();
      if (state.route === 'memory') await loadList(true);
    } catch (err) {
      toast(err.message || String(err), 'err');
    }
  }

  /* ------------------------------------------------------------- 路由 */

  function route() {
    var h = (location.hash || '').replace(/^#\/?/, '');
    if (['memory', 'curves', 'data'].indexOf(h) < 0) h = 'memory';
    state.route = h;
    $$('.nav-item').forEach(function (a) {
      a.classList.toggle('on', a.getAttribute('data-route') === h);
    });
    $$('.page').forEach(function (p) {
      p.classList.toggle('active', p.id === 'page-' + h);
    });
    // 换页时把详情抽屉收起来：它属于记忆库那一页，别跟着跑到别的页上
    var dw = $('#drawerWrap');
    if (dw && dw.classList.contains('open')) {
      dw.classList.remove('open');
      state.selectedId = null;
    }
    if (h === 'memory') {
      loadList(true).catch(function (err) { toast(err.message || String(err), 'err'); });
    } else if (h === 'curves') {
      loadCurves().catch(function (err) { toast(err.message || String(err), 'err'); });
    } else {
      loadData().catch(function (err) { toast(err.message || String(err), 'err'); });
    }
  }

  var searchTimer = null;

  /* ------------------------------------------------------------- 事件 */

  function bind() {
    window.addEventListener('hashchange', route);

    $('#btnAdd').addEventListener('click', function () { openModal(null); });
    $('#btnExport').addEventListener('click', doExport);
    $('#btnDataExport').addEventListener('click', doExport);
    $('#btnCurvesReload').addEventListener('click', function () {
      loadCurves().catch(function (err) { toast(err.message || String(err), 'err'); });
    });
    $('#btnRawReload').addEventListener('click', function () {
      loadRaw().catch(function (err) { toast(err.message || String(err), 'err'); });
    });

    $('#search').addEventListener('input', function (ev) {
      var v = ev.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        state.list.q = v.trim();
        loadList(true).catch(function (err) { toast(err.message || String(err), 'err'); });
      }, 240);
    });

    $('#sort').addEventListener('change', function (ev) {
      state.list.sort = ev.target.value;
      loadList(true).catch(function (err) { toast(err.message || String(err), 'err'); });
    });

    $('#more').addEventListener('click', function () {
      loadList(false).catch(function (err) { toast(err.message || String(err), 'err'); });
    });

    $('#idx').addEventListener('click', function (ev) {
      var clear = ev.target.closest('[data-clear]');
      if (clear) {
        var g0 = clear.getAttribute('data-g');
        if (g0 === 'day') state.list.day = '';
        else state.list[g0] = [];
        loadList(true).catch(function (err) { toast(err.message || String(err), 'err'); });
        return;
      }
      var item = ev.target.closest('.idx-item');
      if (!item) return;
      var g = item.getAttribute('data-g');
      var v = item.getAttribute('data-v');
      if (g === 'day') {
        state.list.day = state.list.day === v ? '' : v;
      } else {
        if (v === '__none') return;
        var arr = state.list[g];
        var i = arr.indexOf(v);
        if (i >= 0) arr.splice(i, 1); else arr.push(v);
      }
      loadList(true).catch(function (err) { toast(err.message || String(err), 'err'); });
    });

    $('#rows').addEventListener('click', async function (ev) {
      var act = ev.target.closest('[data-act]');
      if (act) {
        var a = act.getAttribute('data-act');
        if (a === 'add') { openModal(null); return; }
        if (a === 'go-import') { location.hash = '#/data'; return; }
        if (a === 'clear-filters') {
          state.list.kinds = []; state.list.who = []; state.list.bands = []; state.list.day = '';
          state.list.q = ''; $('#search').value = '';
          loadList(true).catch(function (err) { toast(err.message || String(err), 'err'); });
          return;
        }
      }
      var row = ev.target.closest('.row');
      if (!row) return;
      var id = row.getAttribute('data-id');
      if (state.selectedId === id) { closeDetail(); return; }
      try { await openDetail(id); } catch (err) { toast(err.message || String(err), 'err'); }
    });

    $('#drawer').addEventListener('click', async function (ev) {
      var btn = ev.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      var e = state.current;
      if (act === 'close-detail') { closeDetail(); return; }
      if (!e) return;
      if (act === 'edit') { openModal(e); return; }
      if (act === 'to-search') {
        $('#search').value = e.text.slice(0, 24);
        state.list.q = $('#search').value.trim();
        await loadList(true);
        return;
      }
      if (act === 'del') {
        if (!window.confirm('删掉这条？会进归档簿，可以在「曲线」页的归档簿取回。')) return;
        try {
          await api('/api/remove', { id: e.id });
          closeDetail();
          toast('删了，可以在曲线页归档簿取回');
          await loadList(true);
        } catch (err) { toast(err.message || String(err), 'err'); }
      }
    });

    $('#archList').addEventListener('click', async function (ev) {
      var btn = ev.target.closest('[data-act="restore"]');
      if (!btn) return;
      var id = btn.getAttribute('data-id');
      try {
        await api('/api/restore', { id: id });
        toast('取回了一条');
        await loadCurves();
        if (state.route === 'memory') await loadList(true);
      } catch (err) { toast(err.message || String(err), 'err'); }
    });

    $('#modalMask').addEventListener('click', function (ev) {
      if (ev.target.id === 'modalMask') closeModal();
    });
    $('#modalClose').addEventListener('click', closeModal);
    $('#modalCancel').addEventListener('click', closeModal);
    $('#entryForm').addEventListener('submit', submitModal);
    $('#f-text').addEventListener('input', updateTextNote);

    $('#importFile').addEventListener('change', handleImportFile);
    $('#btnImportConfirm').addEventListener('click', confirmImport);
    $('#btnImportCancel').addEventListener('click', function () {
      state.pendingImport = null;
      $('#importFile').value = '';
      $('#importPreview').textContent = '已取消。';
      $('#btnImportConfirm').disabled = true;
      $('#btnImportCancel').disabled = true;
    });

    $('#btnArchive').addEventListener('click', archiveClick);
    $('#btnRebuild').addEventListener('click', rebuildClick);

    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        if (!$('#modalMask').hidden) { closeModal(); return; }
        if (state.selectedId) closeDetail();
      }
    });
  }

  /* ------------------------------------------------------------- 启动 */

  fillSelects();
  bind();
  route();
})();
