/**
 * dsh-qq-whale —— DSH Web 左下角的 Molly 看板（客户端）。
 *
 * 为什么要有它：wbai 是外部桌面 App 的免费额度，宿主根本感知不到它掉线。
 * 结果就是"人以为机器人在，实际上谁都收不到消息"，或者反过来，在 wbai
 * 没起来的时候让插件硬跑、日志里刷一堆报错。这个挂件把三件事摊到明面：
 *   1. 一眼看到 Molly 到底活着没有（QQ 连着吗？wbai 额度在吗？）
 *   2. 一键开关，不用去改 cordis.patch.yml 再重启
 *   3. 出问题时点开就能看到具体卡在哪一步
 *
 * 为什么从"小圆点"长成"看板"：用户原话是「Molly 挂在左下角的看板我还不是
 * 特别满足，能不能写一个稍微大一点点界面」。一颗 44px 的鲸鱼头只回答
 * "她活着没有"，回答不了"她今天聊了多少、记着什么、表情库长什么样、
 * 干活通道通不通"。所以面板从 284px 长到 420px，切成五个页签：
 * 总览 / 记忆 / 表情 / 干活 / 设置。
 *
 * 设计取舍：
 *   - 纯原生 DOM，不依赖任何前端框架 —— 这个脚本是宿主在页面加载后
 *     动态塞进来的，拿不到 React 上下文。
 *   - **绝不遮挡内容**：收起态还是一颗 44px 的鲸鱼头，贴在最左下角；
 *     平时半透明，鼠标移上去才完全显形；可以拖到任意位置并记住。
 *     一切异常吞掉——挂件把 DSH 搞崩就是本末倒置。
 *   - 轮询而不是 WebSocket：状态变化本来就慢（秒级），4 秒一次的
 *     轻量 GET 足够，还省掉一套重连逻辑。本地数据服务（19391）更慢，
 *     而且**只在面板展开时**才拉——收起态空转纯属浪费。
 *   - 主题跟着宿主走：云白纸面是浅色，但用户可能切深色。build() 时读
 *     body 背景亮度决定挂 .qw-dark，整套 CSS 变量切换，不写两份样式。
 */
(function () {
  'use strict'
  if (window.__dshQQWhaleWidget) return
  window.__dshQQWhaleWidget = true

  var API = '/dsh-qq-whale'
  /* 本地只读数据服务：记忆库 + 表情库 + 会话统计。可能没启动，必须容错 */
  var DATA = 'http://127.0.0.1:19391'
  var POLL_MS = 4000
  var DATA_MS = 15000
  var POS_KEY = 'dshQQWhale.pos'
  var OPEN_KEY = 'dshQQWhale.open'
  var TAB_KEY = 'dshQQWhale.tab'

  var TABS = ['overview', 'memory', 'sticker', 'work', 'setting']
  var TAB_LABEL = {
    overview: '总览',
    memory: '记忆',
    sticker: '表情',
    work: '干活',
    setting: '设置',
  }

  var state = null
  /* 19391 的快照。跟 state 分开存：一个来自宿主，一个来自本地文件服务，
     两边谁先回来都不该把对方清空 */
  var data = null
  var dataErr = ''
  var dataBusy = false
  var dataTimer = null
  var memBuilt = ''
  var stkBuilt = ''
  var previewing = null
  var memQuery = ''
  var timer = null
  var expanded = false
  var busy = false
  var root = null
  var panelOpen = false
  var activeTab = 'overview'

  function el(tag, cls, text) {
    var n = document.createElement(tag)
    if (cls) n.className = cls
    if (text != null) n.textContent = text
    return n
  }

  function lsGet(k, d) {
    try { var v = localStorage.getItem(k); return v == null ? d : v } catch (e) { return d }
  }
  function lsSet(k, v) {
    try { localStorage.setItem(k, v) } catch (e) {}
  }

  /*
   * 样式全在这里，一次性注入。
   *
   * 为什么用 CSS 变量：宿主有浅色（云白纸面）和深色两套主题，挂件得跟着走。
   * 变量挂在 .qw-wrap 上，.qw-dark 只覆盖变量值，其余规则一份不动——
   * 比写两套选择器少一半维护量。
   */
  function css() {
    return [
      /* ——— 底座 + 主题变量 ——— */
      '.qw-wrap{position:fixed;left:10px;bottom:10px;z-index:2147483000;',
      'font:12px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;',
      '-webkit-font-smoothing:antialiased;opacity:.95;transition:opacity .18s;',
      '--qw-bg:#ffffff;--qw-bg-soft:#f6f8fb;--qw-bg-hover:#eef2f7;',
      '--qw-fg:#111827;--qw-fg-dim:#4b5563;--qw-fg-faint:#8b95a5;',
      '--qw-line:#e3e8ef;--qw-line-soft:#eef1f6;',
      '--qw-accent:#2563eb;--qw-accent-soft:rgba(37,99,235,.09);',
      '--qw-ok:#0f9d6b;--qw-warn:#c2790a;--qw-bad:#dc2626;--qw-warn-soft:#fdf3e3;',
      '--qw-shadow:0 16px 44px rgba(15,23,42,.16);--qw-ring:#ffffff;',
      'color:var(--qw-fg)}',
      '.qw-wrap.qw-dark{--qw-bg:rgba(17,24,39,.98);--qw-bg-soft:rgba(31,41,55,.72);',
      '--qw-bg-hover:rgba(255,255,255,.09);--qw-fg:#e5e7eb;--qw-fg-dim:#9ca3af;',
      '--qw-fg-faint:#6b7280;--qw-line:rgba(255,255,255,.12);',
      '--qw-line-soft:rgba(255,255,255,.06);--qw-accent:#60a5fa;',
      '--qw-accent-soft:rgba(96,165,250,.14);--qw-ok:#34d399;--qw-warn:#fbbf24;',
      '--qw-bad:#f87171;--qw-warn-soft:rgba(41,32,10,.85);',
      '--qw-shadow:0 10px 40px rgba(0,0,0,.5);--qw-ring:#0b1220}',
      '.qw-wrap:hover,.qw-wrap.qw-open{opacity:1}',
      '.qw-wrap.qw-dragging{transition:none;opacity:1}',
      /* 横向底座：鲸鱼头 + 模型标签并排，并排好贴左下角 */
      '.qw-dock{display:flex;align-items:center}',
      /* 收起态：一颗鲸鱼头 + 状态灯。**必须够大**——22px 的小点用户根本看不见 */
      '.qw-dot-btn{position:relative;width:44px;height:44px;border-radius:50%;display:flex;align-items:center;justify-content:center;',
      'cursor:pointer;background:radial-gradient(120% 120% at 30% 20%,#ffffff,#eef2ff 62%);',
      'border:1.5px solid rgba(37,99,235,.25);box-shadow:0 4px 16px rgba(15,23,42,.14);',
      'transition:transform .14s,border-color .15s,box-shadow .2s;user-select:none;--qw-c:#6b7280}',
      '.qw-wrap.qw-dark .qw-dot-btn{background:radial-gradient(120% 120% at 30% 20%,rgba(59,130,246,.38),rgba(17,24,39,.92) 62%);',
      'border-color:rgba(147,197,253,.38);box-shadow:0 4px 16px rgba(0,0,0,.45)}',
      '.qw-dot-btn:hover{transform:scale(1.08);border-color:rgba(37,99,235,.6);',
      'box-shadow:0 6px 22px rgba(15,23,42,.2),0 0 18px rgba(59,130,246,.35)}',
      '.qw-wrap.qw-dark .qw-dot-btn:hover{border-color:rgba(147,197,253,.8);box-shadow:0 6px 22px rgba(0,0,0,.55),0 0 18px rgba(59,130,246,.45)}',
      '.qw-ico{font-size:22px;line-height:1;filter:grayscale(.45) brightness(.88);transition:filter .15s;pointer-events:none}',
      '.qw-dot-btn.ok .qw-ico,.qw-dot-btn.warn .qw-ico,.qw-dot-btn.bad .qw-ico{filter:none}',
      /* 状态灯：钉在鲸鱼头右下角 */
      '.qw-core{position:absolute;right:-1px;bottom:-1px;width:13px;height:13px;border-radius:50%;background:var(--qw-c);',
      'box-shadow:0 0 9px var(--qw-c);border:2.5px solid var(--qw-ring);pointer-events:none}',
      '.qw-dot-btn.ok{--qw-c:#34d399}',
      '.qw-dot-btn.warn{--qw-c:#fbbf24}',
      '.qw-dot-btn.bad{--qw-c:#f87171}',
      '.qw-dot-btn.off{--qw-c:#6b7280}',
      /* 有毛病的时候整颗头像呼吸，隔半屏也看得见 */
      '.qw-dot-btn.warn,.qw-dot-btn.bad{animation:qw-ring 1.9s ease-in-out infinite}',
      '.qw-dot-btn.warn .qw-core,.qw-dot-btn.bad .qw-core{animation:qw-breathe 1.2s ease-in-out infinite}',
      '@keyframes qw-breathe{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(.82)}}',
      '@keyframes qw-ring{0%,100%{box-shadow:0 4px 16px rgba(15,23,42,.14),0 0 0 0 rgba(248,113,113,.55)}50%{box-shadow:0 4px 16px rgba(15,23,42,.14),0 0 0 10px rgba(248,113,113,0)}}',
      /*
       * 模型名标签。用户 m11614-3：「在左下角状态栏增加一个可看当前是什么模型
       * 在运行她」。
       *
       * 放鲸鱼头右边、竖排贴着：不抢状态灯的位置，展开面板时自动隐藏
       * （那时候面板里信息更全）。降智模式给它换个黄色，跟正常态一眼分开——
       * "她在用备用脑"是个该被看见的事实，不该藏在面板里。
       */
      '.qw-model{margin-left:7px;max-width:150px;padding:3px 7px;border-radius:999px;',
      'font-size:10.5px;line-height:1.25;letter-spacing:.1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;',
      'background:var(--qw-bg);border:1px solid var(--qw-line);',
      'color:var(--qw-accent);cursor:default;pointer-events:auto;user-select:none;transition:opacity .15s,border-color .15s}',
      '.qw-model.degraded{color:var(--qw-warn);border-color:rgba(251,191,36,.45);background:var(--qw-warn-soft)}',
      '.qw-model:hover{border-color:rgba(37,99,235,.45)}',
      '.qw-wrap.qw-open .qw-model{display:none}',
      /* ——— 展开后的看板面板 ——— */
      '.qw-panel{position:absolute;left:0;bottom:54px;width:420px;max-width:calc(100vw - 24px);',
      'border-radius:14px;overflow:hidden;display:none;flex-direction:column;',
      'max-height:min(72vh,640px);background:var(--qw-bg);border:1px solid var(--qw-line);',
      'box-shadow:var(--qw-shadow);animation:qw-in .14s ease-out;color:var(--qw-fg)}',
      '.qw-wrap.qw-left .qw-panel{left:auto;right:0}',
      '.qw-wrap.qw-up .qw-panel{bottom:auto;top:54px}',
      '.qw-panel.open{display:flex}',
      '@keyframes qw-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}',
      /* 头部 */
      '.qw-head{padding:11px 12px 9px;border-bottom:1px solid var(--qw-line);',
      'display:flex;align-items:flex-start;gap:8px;flex:none;',
      'background:linear-gradient(180deg,var(--qw-accent-soft),transparent)}',
      '.qw-head-main{flex:1;min-width:0}',
      '.qw-title{font-weight:600;font-size:13.5px;display:flex;align-items:center;gap:6px;flex:1}',
      '.qw-sub{color:var(--qw-fg-faint);font-size:11px;margin-top:2px;word-break:break-all;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.qw-head-model.degraded{color:var(--qw-warn)}',
      '.qw-pill{display:inline-flex;align-items:center;gap:4px;font-size:10px;font-weight:500;',
      'padding:1px 7px;border-radius:999px;border:1px solid transparent;flex:none}',
      '.qw-pill i{width:6px;height:6px;border-radius:50%;background:currentColor;display:block}',
      '.qw-pill.ok{color:var(--qw-ok);background:rgba(16,185,129,.1);border-color:rgba(16,185,129,.28)}',
      '.qw-pill.warn{color:var(--qw-warn);background:rgba(245,158,11,.12);border-color:rgba(245,158,11,.32)}',
      '.qw-pill.bad{color:var(--qw-bad);background:rgba(239,68,68,.1);border-color:rgba(239,68,68,.28)}',
      '.qw-pill.off{color:var(--qw-fg-faint);background:var(--qw-bg-soft);border-color:var(--qw-line)}',
      '.qw-x{flex:none;cursor:pointer;color:var(--qw-fg-faint);font-size:15px;line-height:1;padding:1px 3px;border-radius:4px}',
      '.qw-x:hover{color:var(--qw-fg);background:var(--qw-bg-hover)}',
      /* 页签栏 */
      '.qw-tabs{display:flex;gap:2px;padding:0 8px;flex:none;',
      'border-bottom:1px solid var(--qw-line);background:var(--qw-bg-soft)}',
      '.qw-tab{flex:1;height:30px;border:0;background:transparent;color:var(--qw-fg-dim);',
      'font:inherit;font-size:11.5px;cursor:pointer;border-bottom:2px solid transparent;',
      'transition:color .12s,border-color .12s}',
      '.qw-tab:hover{color:var(--qw-fg)}',
      '.qw-tab.on{color:var(--qw-accent);border-bottom-color:var(--qw-accent);font-weight:600}',
      /* 内容区：唯一滚动的地方 */
      '.qw-body{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain;scrollbar-width:thin}',
      '.qw-body::-webkit-scrollbar{width:8px}',
      '.qw-body::-webkit-scrollbar-thumb{background:var(--qw-line);border-radius:4px}',
      '.qw-pane{display:none}',
      '.qw-pane.on{display:block}',
      /* 总览：2×2 指标卡 */
      '.qw-cards{display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:10px 12px 2px}',
      '.qw-card{border:1px solid var(--qw-line);border-radius:12px;background:var(--qw-bg-soft);padding:8px 10px;min-width:0}',
      '.qw-card-k{font-size:10.5px;color:var(--qw-fg-faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.qw-card-v{font-size:16px;font-weight:600;margin-top:1px;letter-spacing:-.2px;color:var(--qw-fg);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.qw-card-v small{font-size:11px;font-weight:400;color:var(--qw-fg-faint);margin-left:3px;letter-spacing:0}',
      '.qw-card.warn .qw-card-v{color:var(--qw-warn)}',
      '.qw-card.bad .qw-card-v{color:var(--qw-bad)}',
      '.qw-bar{height:4px;border-radius:2px;background:var(--qw-line-soft);margin-top:6px;overflow:hidden}',
      '.qw-bar i{display:block;height:100%;background:var(--qw-accent);border-radius:2px;transition:width .3s}',
      '.qw-card.warn .qw-bar i{background:var(--qw-warn)}',
      '.qw-card.bad .qw-bar i{background:var(--qw-bad)}',
      /* 信息行 */
      '.qw-rows{padding:4px 0 6px}',
      '.qw-row{display:flex;align-items:center;gap:8px;padding:4px 12px;font-size:11.5px}',
      '.qw-row .k{color:var(--qw-fg-faint);flex:none;width:60px}',
      '.qw-row .v{flex:1;text-align:right;word-break:break-all}',
      '.qw-v-ok{color:var(--qw-ok)}.qw-v-warn{color:var(--qw-warn)}',
      '.qw-v-bad{color:var(--qw-bad)}.qw-v-dim{color:var(--qw-fg-dim)}',
      /* 待审批：要主人动手的事，给一张醒目的卡 */
      '.qw-alert{margin:8px 12px 4px;padding:8px 10px;border-radius:10px;',
      'border:1px solid rgba(245,158,11,.45);background:rgba(245,158,11,.13)}',
      '.qw-alert-t{font-size:11.5px;font-weight:600;color:var(--qw-warn)}',
      '.qw-alert-b{font-size:11px;color:var(--qw-fg-dim);margin-top:3px;word-break:break-all}',
      '.qw-alert-h{font-size:10.5px;color:var(--qw-fg-faint);margin-top:4px}',
      /* 记忆页：搜索框吸顶，列表在下面滚 */
      '.qw-mem-top{position:sticky;top:0;z-index:2;background:var(--qw-bg);',
      'padding:8px 12px 6px;border-bottom:1px solid var(--qw-line-soft)}',
      '.qw-mem-meta{font-size:10.5px;color:var(--qw-fg-faint);margin-bottom:6px}',
      '.qw-search{width:100%;box-sizing:border-box;height:28px;border-radius:8px;',
      'border:1px solid var(--qw-line);background:var(--qw-bg-soft);color:var(--qw-fg);',
      'font:inherit;font-size:11.5px;padding:0 9px;outline:none;transition:border-color .12s,box-shadow .12s}',
      '.qw-search:focus{border-color:var(--qw-accent);box-shadow:0 0 0 2px var(--qw-accent-soft)}',
      '.qw-mem-group{padding:6px 12px 0}',
      '.qw-mem-gname{font-size:10.5px;color:var(--qw-fg-faint);margin:4px 0 3px;letter-spacing:.3px}',
      '.qw-mem-item{padding:5px 8px;border-left:2px solid var(--qw-line);margin-bottom:3px}',
      '.qw-mem-line{display:flex;align-items:center;gap:5px;flex-wrap:wrap}',
      '.qw-date{font-size:10px;color:var(--qw-fg-faint);background:var(--qw-bg-soft);border-radius:999px;padding:1px 6px}',
      '.qw-tag{font-size:10px;color:var(--qw-accent);background:var(--qw-accent-soft);border-radius:999px;padding:1px 6px}',
      '.qw-mem-text{font-size:11.5px;color:var(--qw-fg);margin-top:2px;word-break:break-word;line-height:1.45}',
      '.qw-empty{padding:18px 14px;text-align:center;color:var(--qw-fg-faint);font-size:11.5px;line-height:1.6}',
      '.qw-empty-sub{font-size:10.5px;color:var(--qw-fg-faint);margin-top:4px;word-break:break-all}',
      '.qw-retry{display:block;width:96px;margin:9px auto 0;height:26px}',
      /* 表情页：3 列网格 */
      '.qw-stk-top{position:sticky;top:0;z-index:2;background:var(--qw-bg);',
      'padding:8px 12px 5px;border-bottom:1px solid var(--qw-line-soft);',
      'font-size:10.5px;color:var(--qw-fg-faint)}',
      '.qw-stk-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:8px 12px 12px}',
      '.qw-stk{border:1px solid var(--qw-line);border-radius:10px;background:var(--qw-bg-soft);',
      'padding:5px;cursor:zoom-in;overflow:hidden;transition:border-color .12s,transform .12s;min-width:0}',
      '.qw-stk:hover{border-color:var(--qw-accent);transform:translateY(-1px)}',
      '.qw-stk-img{display:block;width:100%;height:72px;object-fit:contain}',
      '.qw-stk-name{font-size:10px;color:var(--qw-fg-dim);margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      /* 大图预览：盖在面板上，点任意处关 */
      '.qw-preview{position:absolute;inset:0;z-index:9;background:var(--qw-bg);display:none;',
      'flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:18px;cursor:zoom-out}',
      '.qw-preview.show{display:flex}',
      '.qw-preview img{max-width:280px;max-height:280px;object-fit:contain}',
      '.qw-preview .n{font-size:11.5px;color:var(--qw-fg-dim);text-align:center;word-break:break-all}',
      '.qw-preview .h{font-size:10.5px;color:var(--qw-fg-faint)}',
      /* 干活页 */
      '.qw-work{padding:10px 12px 14px}',
      '.qw-sec-t{font-size:10.5px;color:var(--qw-fg-faint);margin:10px 0 4px;letter-spacing:.3px}',
      '.qw-work>.qw-sec-t:first-child{margin-top:0}',
      '.qw-work .qw-row{padding-left:0;padding-right:0}',
      '.qw-work .qw-row .k{width:64px}',
      '.qw-input{width:100%;box-sizing:border-box;height:30px;border-radius:8px;',
      'border:1px solid var(--qw-line);background:var(--qw-bg-soft);color:var(--qw-fg);',
      'font:inherit;font-size:11.5px;padding:0 9px;outline:none;transition:border-color .12s,box-shadow .12s}',
      '.qw-input:focus{border-color:var(--qw-accent);box-shadow:0 0 0 2px var(--qw-accent-soft)}',
      '.qw-btns{display:flex;gap:6px;margin-top:8px}',
      '.qw-btns .qw-btn{flex:1;height:28px}',
      '.qw-out{margin:6px 0 0;padding:8px 9px;border-radius:8px;border:1px solid var(--qw-line);',
      'background:var(--qw-bg-soft);color:var(--qw-fg-dim);',
      'font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;',
      'white-space:pre-wrap;word-break:break-all;max-height:180px;overflow:auto;min-height:34px}',
      '.qw-out.bad{color:var(--qw-bad);border-color:rgba(239,68,68,.38)}',
      /* 设置页 */
      '.qw-set{padding:4px 0 14px}',
      '.qw-note{margin:2px 12px 0;font-size:10.5px;color:var(--qw-fg-faint);word-break:break-all;line-height:1.5}',
      '.qw-wide{display:block;width:calc(100% - 24px);margin:10px 12px 0;height:28px}',
      /* 底部动作条 */
      '.qw-acts{display:flex;gap:8px;padding:9px 12px;border-top:1px solid var(--qw-line);',
      'flex:none;background:var(--qw-bg-soft)}',
      '.qw-btn{border-radius:8px;border:1px solid var(--qw-line);background:var(--qw-bg);',
      'color:var(--qw-fg);font:inherit;font-size:11.5px;cursor:pointer;',
      'transition:background .12s,border-color .12s,color .12s}',
      '.qw-acts .qw-btn{flex:1;height:27px}',
      '.qw-btn:hover:not(:disabled){background:var(--qw-bg-hover)}',
      '.qw-btn:disabled{opacity:.45;cursor:default}',
      '.qw-btn.on{border-color:rgba(16,185,129,.45);color:var(--qw-ok)}',
      '.qw-btn.off{border-color:rgba(239,68,68,.45);color:var(--qw-bad)}',
      /* 打开控制台：紫色实心主按钮，独占一行（跟三个状态按钮不是一类操作） */
      '.qw-acts{flex-wrap:wrap}',
      '.qw-acts .qw-console{flex:1 1 100%;height:28px;font-weight:600;',
      'background:#5645d4;border-color:#5645d4;color:#fff}',
      '.qw-acts .qw-console:hover:not(:disabled){background:#6555e2;border-color:#6555e2;color:#fff}',
      '.qw-console-hint{display:none;margin:0 12px 9px;font-size:10.5px;line-height:1.5;',
      'color:var(--qw-bad);word-break:break-all}',
      '.qw-console-hint.show{display:block}',
      /* toast 必须留在面板里面：面板 overflow:hidden，挂到外面会被裁掉 */
      '.qw-toast{position:absolute;left:12px;right:12px;bottom:44px;z-index:8;text-align:center;',
      'font-size:11px;color:var(--qw-fg);background:var(--qw-bg);border:1px solid var(--qw-line);',
      'border-radius:8px;padding:5px 8px;box-shadow:var(--qw-shadow);opacity:0;',
      'transform:translateY(4px);transition:opacity .18s,transform .18s;pointer-events:none}',
      '.qw-toast.show{opacity:1;transform:none}',
    ].join('')
  }

  function injectStyle() {
    if (document.getElementById('qw-style')) return
    var s = el('style')
    s.id = 'qw-style'
    s.textContent = css()
    ;(document.head || document.documentElement).appendChild(s)
  }

  /** 三分态：正常 / 有毛病但还能转 / 挂了 */
  function health(s) {
    if (!s) return { level: 'off', text: '连接中…' }
    if (!s.enabled) return { level: 'off', text: '已关闭' }
    if (!s.link || !s.link.ready) return { level: 'bad', text: 'QQ 未连接' }
    if (!s.model || !s.model.ok) return { level: 'warn', text: 'wbai 未就绪' }
    return { level: 'ok', text: '在线' }
  }

  function row(k, v, cls) {
    var r = el('div', 'qw-row')
    r.appendChild(el('span', 'k', k))
    r.appendChild(el('span', 'v' + (cls ? ' ' + cls : ''), v))
    return r
  }

  /*
   * 说的是什么时候。
   *
   * lastReplyAt 是 ISO UTC 字符串（`2026-10-17T15:51:15.832Z`），
   * 以前直接 slice(11, 16) 切出 "15:51" 就当本地时间显示，正好差 8 小时——
   * 用户看到的"15:51"其实是北京时间 23:51，只差一分钟，却以为自己记错了。
   * 必须交给 Date 解析，让它按浏览器本地时区格式化。
   *
   * 近期用相对时间，一眼看出是"刚才"还是"很久以前"；
   * 当天只显示时分；跨天才补日期。
   */
  function fmtLocalTime(v) {
    /* new Date(null) 是 1970-01-01，会显示成"1-1 8:00"，先挡掉空值 */
    if (v === null || v === undefined || v === '') return '—'
    var d = new Date(v)
    if (isNaN(d.getTime())) return '—'
    var now = new Date()
    var diff = now.getTime() - d.getTime()
    if (diff < 0) diff = 0
    var mins = Math.floor(diff / 60000)
    if (mins < 1) return '刚刚'
    if (mins < 60) return mins + ' 分钟前'
    var mm = String(d.getMinutes())
    if (mm.length < 2) mm = '0' + mm
    var clock = d.getHours() + ':' + mm
    var sameDay = d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() && d.getDate() === now.getDate()
    if (sameDay) return clock
    return (d.getMonth() + 1) + '-' + d.getDate() + ' ' + clock
  }

  /** 完整本地时间，给 title 用——行里位置不够，鼠标放上去看全的 */
  function fullLocalTime(v) {
    if (v === null || v === undefined || v === '') return ''
    var d = new Date(v)
    if (isNaN(d.getTime())) return ''
    function p(n) { return n < 10 ? '0' + n : String(n) }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  }

  /** 到期时间：毫秒时间戳 → 还剩几天。直接显示 1794639703539 谁看得懂 */
  function fmtExpiry(v) {
    var n = Number(v)
    if (!isFinite(n) || n <= 0) return '可用'
    var days = Math.floor((n - Date.now()) / 86400000)
    if (days > 1) return '可用 · 还剩 ' + days + ' 天'
    if (days === 1) return '可用 · 明天到期'
    if (days === 0) return '可用 · 今天到期'
    return '可用 · 已过期？'
  }

  function num(v, d) {
    var n = Number(v)
    return isFinite(n) ? n : (d == null ? 0 : d)
  }

  function pctOf(used, cap) {
    var a = num(used)
    var b = num(cap)
    if (b <= 0) return 0
    return Math.max(0, Math.min(100, Math.round(a / b * 100)))
  }

  function fmtSize(n) {
    var v = num(n)
    if (v >= 1048576) return (v / 1048576).toFixed(1) + ' MB'
    if (v >= 1024) return Math.round(v / 1024) + ' KB'
    return v + ' B'
  }

  /* 数据服务的计数优先（它是记忆库的真相），宿主 state 只作兜底 */
  function memCount() {
    if (data && data.memory && data.memory.count != null) return num(data.memory.count)
    return state && state.memory ? num(state.memory.count) : 0
  }
  function stkCount() {
    if (data && data.stickers && data.stickers.count != null) return num(data.stickers.count)
    return state && state.stickers ? num(state.stickers.count) : 0
  }

  /*
   * 浅色还是深色。
   *
   * body 背景常常是 transparent（真正的底色挂在 html 上），所以两个都看，
   * 跳过 alpha 太低的那个。算亮度用标准 Rec.709 系数——比"是不是 #000"
   * 靠谱，主题的米白和深灰都能分对。
   */
  function detectDark() {
    try {
      var nodes = [document.body, document.documentElement]
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i]
        if (!n) continue
        var bg = getComputedStyle(n).backgroundColor || ''
        var m = /^rgba?\(([^)]+)\)$/.exec(bg)
        if (!m) continue
        var parts = m[1].split(',')
        var r = parseFloat(parts[0])
        var g = parseFloat(parts[1])
        var b = parseFloat(parts[2])
        var a = parts.length > 3 ? parseFloat(parts[3]) : 1
        if (!isFinite(a) || a < 0.5) continue
        var lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
        return lum < 0.5
      }
    } catch (e) {}
    /* 判断不出来就按浅色走：默认主题是云白纸面 */
    return false
  }

  // ——— 渲染：只碰 DOM，不碰网络；外面统一 try/catch ———
  function render() {
    if (!root) return
    try {
      renderDot()
      renderHead()
      renderTabs()
      if (panelOpen) {
        renderActivePane()
        renderActs()
      }
    } catch (e) {
      console.warn('[dsh-qq-whale] 渲染失败：', e)
    }
  }

  function renderDot() {
    var h = health(state)
    var dotBtn = root.querySelector('.qw-dot-btn')
    if (dotBtn) {
      dotBtn.className = 'qw-dot-btn ' + h.level
      dotBtn.title = 'Molly · ' + h.text
    }

    /*
     * 模型标签。
     *
     * 收起态也要更新——用户 m11614-3 要的就是"不用点开就知道是谁在跑"。
     * 三态：
     *   有 active 字段（新版后端）：直接用它算好的 label，最准
     *   没 active 但知道主模型：退回显示配置里的模型名，至少不空着
     *   什么都不知道：显示「—」，别显示"未知"这种吓人的词
     */
    var tag = root.querySelector('.qw-model')
    if (tag) {
      var a = state && state.active
      var label = ''
      var degraded = false
      if (a && a.label) {
        label = a.label
        degraded = !!a.degraded
        tag.title = '当前生效：' + a.label + '\n' + (a.reason || '') +
          (a.provider ? '\nprovider: ' + a.provider : '') +
          (a.flavor ? '\nflavor: ' + a.flavor : '')
      } else if (state && state.model && state.model.model) {
        label = state.model.model
        tag.title = '当前生效：' + label
      } else {
        label = '—'
        tag.title = '还没拿到模型信息'
      }
      // 面板展开时不显示（详情在面板里，别重复）
      if (panelOpen) {
        tag.style.display = 'none'
      } else {
        tag.style.display = ''
        tag.textContent = label
        tag.className = 'qw-model' + (degraded ? ' degraded' : '')
      }
    }
  }

  function renderHead() {
    var h = health(state)
    var pill = root.querySelector('.qw-pill')
    if (pill) {
      var label
      if (h.level === 'ok') label = '在线'
      else if (h.level === 'off') label = state ? '已关闭' : '连接中…'
      else label = '离线'
      pill.className = 'qw-pill ' + h.level
      pill.textContent = ''
      pill.appendChild(el('i'))
      pill.appendChild(document.createTextNode(label))
      /* 胶囊只给三种粗粒度状态，具体卡在哪一步放 title 里 */
      pill.title = h.text
    }

    var qq = root.querySelector('.qw-head-qq')
    if (qq) {
      var bot = state && state.bot
      var uid = bot && bot.userId ? bot.userId : '111111111'
      var nick = bot && bot.nickname ? bot.nickname : '蓝色大肥鱼'
      qq.textContent = 'QQ ' + uid + ' · ' + nick
      qq.title = qq.textContent
    }

    var model = root.querySelector('.qw-head-model')
    if (model) {
      var a = state && state.active
      var m = state && state.model
      var txt = a && a.label ? a.label : (m && m.model ? m.model : '—')
      var deg = !!(a && a.degraded)
      if (deg) txt += ' · 降级'
      model.textContent = '模型 ' + txt
      model.className = 'qw-sub qw-head-model' + (deg ? ' degraded' : '')
      model.title = (a && a.reason ? a.reason + '\n' : '') +
        (m && m.baseUrl ? m.baseUrl : '')
    }
  }

  function renderTabs() {
    var btns = root.querySelectorAll('.qw-tab')
    for (var i = 0; i < btns.length; i++) {
      btns[i].classList.toggle('on', btns[i].getAttribute('data-tab') === activeTab)
    }
  }

  function renderActivePane() {
    var panes = root.querySelectorAll('.qw-pane')
    for (var i = 0; i < panes.length; i++) {
      panes[i].classList.toggle('on', panes[i].getAttribute('data-tab') === activeTab)
    }
    try {
      if (activeTab === 'overview') renderOverview()
      else if (activeTab === 'memory') renderMemory()
      else if (activeTab === 'sticker') renderSticker()
      else if (activeTab === 'work') renderWork()
      else if (activeTab === 'setting') renderSetting()
    } catch (e) {
      console.warn('[dsh-qq-whale] 页签渲染失败（' + activeTab + '）：', e)
    }
  }

  function card(k, v, cls, sub) {
    var c = el('div', 'qw-card' + (cls ? ' ' + cls : ''))
    c.appendChild(el('div', 'qw-card-k', k))
    var vv = el('div', 'qw-card-v')
    vv.appendChild(document.createTextNode(v))
    if (sub) vv.appendChild(el('small', '', sub))
    c.appendChild(vv)
    return c
  }

  function renderOverview() {
    var box = root.querySelector('.qw-ov')
    if (!box) return
    box.textContent = ''
    var s = state || {}

    /* ——— 2×2 指标卡 ——— */
    var cards = el('div', 'qw-cards')

    var b = s.budget
    var budCard
    if (!b) {
      budCard = card('今日积分', '—')
    } else if (!b.enabled) {
      budCard = card('今日积分', '不限', '', '开关已关')
    } else {
      var used = num(b.used)
      var cap = num(b.cap)
      var exhausted = !!b.exhausted
      var cls = exhausted ? 'bad' : (cap > 0 && used / cap > 0.8 ? 'warn' : '')
      budCard = card('今日积分', used.toFixed(2) + ' / ' + cap, cls)
      var bar = el('div', 'qw-bar')
      var fill = el('i')
      fill.style.width = pctOf(used, cap) + '%'
      bar.appendChild(fill)
      budCard.appendChild(bar)
    }
    cards.appendChild(budCard)

    cards.appendChild(card('记忆', String(memCount()), '', '条'))
    cards.appendChild(card('表情', String(stkCount()), '', '张'))
    cards.appendChild(card('已聊', s.metrics ? String(num(s.metrics.messages)) : '—', '', '条'))
    box.appendChild(cards)

    /* ——— 待审批：唯一需要主人动手的事，压在最上面 ——— */
    var gk = s.gatekeeper
    if (gk && num(gk.pending) > 0) {
      var alert = el('div', 'qw-alert')
      alert.appendChild(el('div', 'qw-alert-t', '⏳ 有 ' + num(gk.pending) + ' 个人在等你审批'))
      var who = (gk.pendingList || [])
        .map(function (p) {
          return p.name && p.name !== p.userId ? p.name : p.userId
        })
        .slice(0, 4)
        .join('、')
      if (who) alert.appendChild(el('div', 'qw-alert-b', who))
      alert.appendChild(el('div', 'qw-alert-h', '在 QQ 私聊里回「1」通过 · 回「0」拒绝'))
      box.appendChild(alert)
    }

    /* ——— 信息行 ——— */
    var rows = el('div', 'qw-rows')
    var link = s.link
    rows.appendChild(row('QQ', link && link.ready
      ? (s.bot && s.bot.nickname ? s.bot.nickname + ' ' + s.bot.userId : '已连接')
      : '未连接', link && link.ready ? 'qw-v-ok' : 'qw-v-bad'))

    var m = s.model
    rows.appendChild(row('wbai', m && m.ok
      ? fmtExpiry(m.expiresAt)
      : (m && m.error) || '不可用',
      m && m.ok ? 'qw-v-ok' : 'qw-v-bad'))

    var a = s.active
    if (a && a.label) {
      rows.appendChild(row('当前模型', a.label, a.degraded ? 'qw-v-warn' : 'qw-v-ok'))
    }

    var t = s.trae
    if (t && t.ready) {
      var th = t.health
      var tCls = 'qw-v-dim'
      var tTxt = t.model || 'trae'
      if (th && th.ok === true) {
        tCls = 'qw-v-ok'
        if (th.ms) tTxt += ' · ' + th.ms + 'ms'
      } else if (th && th.ok === false) {
        tCls = 'qw-v-bad'
        tTxt += '（失联）'
      }
      rows.appendChild(row('备用脑', tTxt, tCls))
    } else {
      rows.appendChild(row('备用脑', '未启用', 'qw-v-dim'))
    }

    var mt = s.metrics
    if (mt) {
      if (mt.avgReplySeconds) rows.appendChild(row('平均响应', mt.avgReplySeconds + ' 秒', 'qw-v-dim'))
      if (mt.lastReplyAt) {
        var lastRow = row('上次说话', fmtLocalTime(mt.lastReplyAt), 'qw-v-dim')
        lastRow.title = '本地时间 ' + fullLocalTime(mt.lastReplyAt)
        rows.appendChild(lastRow)
      }
      rows.appendChild(row('活跃会话', num(mt.conversations) + ' 个', 'qw-v-dim'))
    }

    rows.appendChild(row('待审批', gk ? num(gk.pending) + ' 人' : '—',
      gk && num(gk.pending) > 0 ? 'qw-v-warn' : 'qw-v-dim'))

    var r = s.research
    var rTxt = '—'
    var rCls = 'qw-v-dim'
    if (r) {
      if (!r.enabled) {
        rTxt = '未开启'
      } else if (r.ok === false) {
        rTxt = '异常' + (r.lastReason ? '：' + r.lastReason : '')
        rCls = 'qw-v-bad'
      } else {
        rTxt = '正常' + (r.lastAt ? ' · ' + fmtLocalTime(r.lastAt) : '')
        rCls = 'qw-v-ok'
      }
    }
    var rRow = row('研究', rTxt, rCls)
    if (r && r.lastNeed) rRow.title = '上次需要：' + r.lastNeed
    rows.appendChild(rRow)

    box.appendChild(rows)
  }

  function dataFallback() {
    var box = el('div', 'qw-empty')
    box.appendChild(el('div', '', '数据服务未启动（tools\\panel-data.mjs）'))
    box.appendChild(el('div', 'qw-empty-sub', dataErr ? String(dataErr) : '端口 19391 没有响应'))
    var b = el('button', 'qw-btn qw-retry', '重试')
    b.addEventListener('click', function (e) {
      e.stopPropagation()
      loadData(true)
    })
    box.appendChild(b)
    return box
  }

  function renderMemory() {
    var pane = root.querySelector('.qw-pane[data-tab="memory"]')
    if (!pane) return
    var meta = pane.querySelector('.qw-mem-meta')
    var list = pane.querySelector('.qw-mem-list')
    if (!meta || !list) return

    if (data && data.memory) {
      var mem = data.memory
      var hm = /\d{2}:\d{2}/.exec(String(mem.updatedAt || ''))
      meta.textContent = '共 ' + memCount() + ' 条' + (hm ? ' · 更新于 ' + hm[0] : '')
    } else if (dataErr) {
      meta.textContent = '记忆库 · 数据服务未启动'
    } else {
      meta.textContent = '记忆库 · 读取中…'
    }

    /*
     * 指纹没变就不重建列表。
     *
     * 4 秒一次的状态轮询会把这里连带刷一遍，重建本身不丢输入焦点（输入框在
     * 列表外面），但会把用户正在拖的滚动条位置和选中的文字冲掉。没新数据就
     * 别动 DOM，这是最省事也最稳的做法。
     */
    var fp = ''
    try {
      fp = data && data.memory ? JSON.stringify(data.memory) : 'err:' + dataErr
    } catch (e) { fp = '' }
    if (fp === memBuilt && list.firstChild) return
    memBuilt = fp

    list.textContent = ''
    if (!data || !data.memory) {
      if (dataErr) list.appendChild(dataFallback())
      else list.appendChild(el('div', 'qw-empty', '读取中…'))
      return
    }

    var groups = data.memory.groups || []
    var total = 0
    groups.forEach(function (g) {
      var items = (g && g.items) || []
      if (!items.length) return
      var gEl = el('div', 'qw-mem-group')
      gEl.appendChild(el('div', 'qw-mem-gname', g.name || '未分组'))
      items.forEach(function (it) {
        if (!it) return
        total++
        var item = el('div', 'qw-mem-item')
        var line = el('div', 'qw-mem-line')
        if (it.date) line.appendChild(el('span', 'qw-date', String(it.date)))
        if (it.tag) line.appendChild(el('span', 'qw-tag', String(it.tag)))
        item.appendChild(line)
        item.appendChild(el('div', 'qw-mem-text', String(it.text || '')))
        /* 预拼一个小写检索串：正文 + 日期 + 标签 + 分组名，一次 indexOf 就够 */
        item.__q = (String(it.text || '') + ' ' + String(it.date || '') + ' ' +
          String(it.tag || '') + ' ' + String(g.name || '')).toLowerCase()
        gEl.appendChild(item)
      })
      list.appendChild(gEl)
    })
    if (!total) list.appendChild(el('div', 'qw-empty', '记忆库还是空的'))
    filterMemory()
  }

  function filterMemory() {
    var list = root && root.querySelector('.qw-mem-list')
    if (!list) return
    var q = memQuery.trim().toLowerCase()
    var groups = list.querySelectorAll('.qw-mem-group')
    var shown = 0
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i]
      var items = g.querySelectorAll('.qw-mem-item')
      var hit = 0
      for (var j = 0; j < items.length; j++) {
        var ok = !q || String(items[j].__q || '').indexOf(q) >= 0
        items[j].style.display = ok ? '' : 'none'
        if (ok) hit++
      }
      g.style.display = hit ? '' : 'none'
      shown += hit
    }
    var none = list.querySelector('.qw-mem-none')
    if (!none) {
      none = el('div', 'qw-empty qw-mem-none')
      list.appendChild(none)
    }
    none.style.display = shown ? 'none' : ''
    none.textContent = shown ? ''
      : (q ? '没有匹配「' + memQuery.trim() + '」的条目' : '记忆库是空的')
  }

  function renderSticker() {
    var pane = root.querySelector('.qw-pane[data-tab="sticker"]')
    if (!pane) return
    var meta = pane.querySelector('.qw-stk-meta')
    var grid = pane.querySelector('.qw-stk-grid')
    if (!meta || !grid) return

    /* 大图开着的时候别把底下的网格抽掉，否则关预览会闪一下 */
    if (previewing) return

    if (data && data.stickers) {
      meta.textContent = '共 ' + stkCount() + ' 张 · 点一下看大图'
    } else if (dataErr) {
      meta.textContent = '表情库 · 数据服务未启动'
    } else {
      meta.textContent = '表情库 · 读取中…'
    }

    var fp = ''
    try {
      fp = data && data.stickers ? JSON.stringify(data.stickers) : 'err:' + dataErr
    } catch (e) { fp = '' }
    if (fp === stkBuilt && grid.firstChild) return
    stkBuilt = fp

    grid.textContent = ''
    if (!data || !data.stickers) {
      if (dataErr) grid.appendChild(dataFallback())
      else grid.appendChild(el('div', 'qw-empty', '读取中…'))
      return
    }

    var items = data.stickers.items || []
    if (!items.length) {
      grid.appendChild(el('div', 'qw-empty', '表情库还是空的'))
      return
    }
    items.forEach(function (it) {
      if (!it) return
      var cell = el('div', 'qw-stk')
      var img = el('img', 'qw-stk-img')
      img.loading = 'lazy'
      img.alt = String(it.name || '')
      if (it.url) img.src = DATA + it.url
      cell.appendChild(img)
      cell.appendChild(el('div', 'qw-stk-name', String(it.name || it.file || '')))
      cell.title = String(it.name || '') +
        (it.size ? ' · ' + fmtSize(it.size) : '') +
        (it.ext ? ' · ' + it.ext : '')
      cell.addEventListener('click', function (e) {
        e.stopPropagation()
        showPreview(it)
      })
      grid.appendChild(cell)
    })
  }

  function showPreview(it) {
    var box = root && root.querySelector('.qw-preview')
    if (!box || !it) return
    var img = box.querySelector('img')
    var name = box.querySelector('.n')
    if (img) {
      if (it.url) img.src = DATA + it.url
      else img.removeAttribute('src')
    }
    if (name) {
      name.textContent = String(it.name || it.file || '') +
        (it.size ? ' · ' + fmtSize(it.size) : '')
    }
    box.classList.add('show')
    previewing = it
  }

  function hidePreview() {
    if (!previewing) return
    var box = root && root.querySelector('.qw-preview')
    if (box) {
      box.classList.remove('show')
      var img = box.querySelector('img')
      if (img) img.removeAttribute('src')
    }
    previewing = null
    try { renderSticker() } catch (e) { console.warn('[dsh-qq-whale] 关闭预览失败：', e) }
  }

  function renderWork() {
    var pane = root.querySelector('.qw-pane[data-tab="work"]')
    if (!pane) return
    var box = pane.querySelector('.qw-work-status')
    if (!box) return
    box.textContent = ''
    if (!state) {
      box.appendChild(row('状态', '还没收到宿主数据', 'qw-v-dim'))
      return
    }
    var w = state.work || {}
    box.appendChild(row('干活通道', w.ready ? '就绪' : (w.error || '未就绪'),
      w.ready ? 'qw-v-ok' : 'qw-v-bad'))
    if (w.sessionId) {
      var sid = String(w.sessionId)
      var sidRow = row('会话', sid.length > 20 ? sid.slice(0, 20) + '…' : sid, 'qw-v-dim')
      sidRow.title = sid
      box.appendChild(sidRow)
    }
    box.appendChild(row('正在跑', w.running ? (w.task || '是') : '空闲',
      w.running ? 'qw-v-warn' : 'qw-v-dim'))

    var r = state.research || {}
    var rTxt = '未开启'
    var rCls = 'qw-v-dim'
    if (r.enabled) {
      rTxt = r.ok === false ? '异常' : '可用'
      if (r.count != null) rTxt += ' · ' + num(r.count) + ' 次'
      rCls = r.ok === false ? 'qw-v-bad' : 'qw-v-ok'
    }
    box.appendChild(row('研究', rTxt, rCls))

    var t = state.qqTool || {}
    box.appendChild(row('QQ 工具', t.registered ? (t.name || '已注册') : (t.error || '未注册'),
      t.registered ? 'qw-v-ok' : 'qw-v-bad'))
  }

  function pretty(v) {
    if (v == null) return '（无返回）'
    if (typeof v === 'string') return v
    try { return JSON.stringify(v, null, 2) } catch (e) { return String(v) }
  }

  /* 返回体里的 state 动辄几十个字段，整坨打出来只会把结果挤没 */
  function stripState(d) {
    if (!d || typeof d !== 'object' || !d.state) return d
    var out = {}
    for (var k in d) {
      if (k !== 'state' && Object.prototype.hasOwnProperty.call(d, k)) out[k] = d[k]
    }
    return out
  }

  function setOut(text, bad) {
    var out = root && root.querySelector('.qw-out')
    if (!out) return
    out.className = 'qw-out' + (bad ? ' bad' : '')
    out.textContent = text
  }

  /*
   * 干活页的三个动作走同一条路：POST → 拿原文 → 能解析就展示 JSON，
   * 不能解析就原样贴出来。失败必须显示**错误原文**——"操作失败"四个字
   * 帮不上任何忙，用户要的是宿主到底回了什么。
   */
  function runWork(path, body, btn) {
    if (busy) return
    busy = true
    setOut('请求中…')
    if (btn) btn.disabled = true
    render()
    fetch(API + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    })
      .then(function (r) {
        return r.text().then(function (txt) {
          return { ok: r.ok, status: r.status, text: txt }
        })
      })
      .then(function (res) {
        var d = null
        try { d = JSON.parse(res.text) } catch (e) { d = null }
        if (d && d.state) state = d.state
        if (!res.ok) {
          var msg = (d && (d.error || d.message)) || res.text || ('HTTP ' + res.status)
          throw new Error(String(msg))
        }
        setOut(pretty(stripState(d != null ? d : res.text)), false)
      })
      .catch(function (e) {
        setOut('失败：' + ((e && e.message) || e), true)
        toast('操作失败')
        console.warn('[dsh-qq-whale] ' + path + ' 失败：', e)
      })
      .then(function () {
        busy = false
        if (btn) btn.disabled = false
        render()
      })
  }

  function renderSetting() {
    var pane = root.querySelector('.qw-pane[data-tab="setting"]')
    if (!pane) return
    var box = pane.querySelector('.qw-set')
    if (!box) return
    box.textContent = ''
    var s = state || {}
    var m = s.model || {}
    var a = s.active || {}

    box.appendChild(row('模型', m.model || '—', m.ok ? 'qw-v-ok' : 'qw-v-bad'))
    box.appendChild(row('provider', a.provider || m.provider || '—', 'qw-v-dim'))
    if (a.degraded) {
      var degRow = row('降级原因', a.reason || '已降级', 'qw-v-warn')
      degRow.title = a.reason || ''
      box.appendChild(degRow)
    } else {
      box.appendChild(row('降级', a.label ? '未降级' : '—', 'qw-v-dim'))
    }

    var p = s.pest
    if (p) {
      var pTxt = p.enabled ? '开启' : '关闭'
      if (p.targets && p.targets.length) pTxt += ' · 盯 ' + p.targets.length + ' 个'
      if (p.muted) pTxt += ' · 静音'
      box.appendChild(row('防骚扰', pTxt, p.enabled ? 'qw-v-ok' : 'qw-v-dim'))
      if (p.dailyCap != null) {
        box.appendChild(row('今日额度', num(p.used) + ' / ' + num(p.dailyCap), 'qw-v-dim'))
      }
    } else {
      box.appendChild(row('防骚扰', '—', 'qw-v-dim'))
    }

    var gw = row('网关', m.baseUrl || '—', 'qw-v-dim')
    gw.title = m.baseUrl || ''
    box.appendChild(gw)

    box.appendChild(row('数据服务', dataErr ? '未启动' : (data ? '已连接' : '未连接'),
      dataErr ? 'qw-v-bad' : (data ? 'qw-v-ok' : 'qw-v-dim')))
    if (dataErr) {
      box.appendChild(el('div', 'qw-note',
        '19391 无响应：' + dataErr + '（tools\\panel-data.mjs）'))
    }

    var copy = el('button', 'qw-btn qw-wide', '复制诊断信息')
    copy.title = '把宿主 state 和数据服务快照一起写进剪贴板'
    copy.addEventListener('click', function (e) {
      e.stopPropagation()
      copyDiag()
    })
    box.appendChild(copy)
  }

  function copyDiag() {
    var payload = ''
    try {
      payload = JSON.stringify({
        at: new Date().toISOString(),
        state: state,
        data: data,
        dataErr: dataErr,
      }, null, 2)
    } catch (e) {
      payload = String(state)
    }

    /* 剪贴板 API 在非安全上下文 / 没焦点时会直接抛，得留一条 execCommand 的路 */
    function fallback() {
      try {
        var ta = el('textarea')
        ta.value = payload
        ta.style.position = 'fixed'
        ta.style.left = '-9999px'
        ta.style.opacity = '0'
        ;(document.body || document.documentElement).appendChild(ta)
        ta.select()
        var ok = document.execCommand('copy')
        ;(document.body || document.documentElement).removeChild(ta)
        toast(ok ? '诊断信息已复制' : '复制失败：浏览器不允许')
      } catch (e) {
        toast('复制失败：浏览器不允许')
      }
    }

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(payload).then(function () {
          toast('诊断信息已复制')
        }, fallback)
      } else {
        fallback()
      }
    } catch (e) {
      fallback()
    }
  }

  function renderActs() {
    if (!root) return
    var toggle = root.querySelector('.qw-toggle')
    if (toggle) {
      toggle.textContent = state && state.enabled ? '关掉她' : '叫醒她'
      toggle.className = 'qw-btn qw-toggle ' + (state && state.enabled ? 'on' : 'off')
      toggle.disabled = busy || !state
    }
    var rf = root.querySelector('.qw-refresh')
    if (rf) rf.disabled = busy

    var budBtn = root.querySelector('.qw-budget')
    if (budBtn) {
      var bOn = !!(state && state.budget && state.budget.enabled)
      budBtn.textContent = bOn ? '积分限制：开' : '积分限制：关'
      budBtn.className = 'qw-btn qw-budget ' + (bOn ? 'on' : 'off')
      budBtn.disabled = busy || !state || !state.budget
      budBtn.title = bOn
        ? '今日累计到上限就通知并切 trae。点一下关掉——关了就不限也不跳'
        : '当前不限制积分，也不切 trae。点一下开启'
    }
  }

  function toast(msg) {
    var t = root && root.querySelector('.qw-toast')
    if (!t) return
    t.textContent = msg
    t.classList.add('show')
    setTimeout(function () { t.classList.remove('show') }, 1800)
  }

  function fetchState() {
    return fetch(API + '/state', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null })
      .catch(function () { return null })
  }

  function post(path, body) {
    busy = true
    render()
    return fetch(API + path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    })
      .then(function (r) { return r.json() })
      .then(function (d) {
        if (d && d.state) { state = d.state; panelOpen = true; root.classList.add('qw-open'); render() }
        return d
      })
      .catch(function () { toast('操作失败') })
      .then(function () { busy = false; render() })
  }

  /*
   * 本地数据服务（19391）。
   *
   * 它跟宿主是两回事：挂了只影响「记忆」「表情」两页，其它页签照常工作，
   * 所以这里失败**不弹 toast、不抛错**，只把原因记在 dataErr 里，让页面
   * 自己显示一句"未启动 + 重试"。超时用 AbortController 兜住——端口不通
   * 时某些浏览器会卡十几秒，那会让"展开面板"手感直接崩掉。
   */
  function loadData(force) {
    if (!panelOpen) return Promise.resolve()
    if (dataBusy && !force) return Promise.resolve()
    dataBusy = true
    var ctl = null
    var to = null
    try {
      ctl = new AbortController()
      to = setTimeout(function () {
        try { ctl.abort() } catch (e) {}
      }, 5000)
    } catch (e) { ctl = null }

    return fetch(DATA + '/api/all', {
      cache: 'no-store',
      signal: ctl ? ctl.signal : undefined,
    })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status)
        return r.json()
      })
      .then(function (d) {
        if (d && d.ok === false) throw new Error('服务返回 ok=false')
        data = d || null
        dataErr = data ? '' : '返回内容无法识别'
      })
      .catch(function (e) {
        data = null
        dataErr = (e && e.message) || '连接被拒绝'
        console.warn('[dsh-qq-whale] 数据服务不可用：', e)
      })
      .then(function () {
        if (to) clearTimeout(to)
        dataBusy = false
        if (panelOpen) render()
      })
  }

  function startDataTimer() {
    if (dataTimer) return
    dataTimer = setInterval(function () { loadData() }, DATA_MS)
  }

  function stopDataTimer() {
    if (!dataTimer) return
    clearInterval(dataTimer)
    dataTimer = null
  }

  // ——— 拖拽：按住小圆点拖，松开记住位置；没拖动就是"点一下" ———
  function installDrag(handle) {
    var dragging = false
    var moved = false
    var sx = 0, sy = 0, ox = 0, oy = 0

    function applyPos(left, bottom) {
      root.style.left = left + 'px'
      root.style.bottom = bottom + 'px'
      root.style.right = 'auto'
      root.style.top = 'auto'
      // 面板方向自适应：靠近右边缘就往左弹，靠近顶部就往下弹
      root.classList.toggle('qw-left', left > window.innerWidth / 2)
    }

    handle.addEventListener('mousedown', function (e) {
      if (e.button !== 0) return
      dragging = true
      moved = false
      sx = e.clientX
      sy = e.clientY
      var r = root.getBoundingClientRect()
      ox = r.left
      oy = window.innerHeight - r.bottom
      root.classList.add('qw-dragging')
      e.preventDefault()
    })

    document.addEventListener('mousemove', function (e) {
      if (!dragging) return
      var dx = e.clientX - sx
      var dy = e.clientY - sy
      if (!moved && Math.abs(dx) + Math.abs(dy) > 4) moved = true
      if (!moved) return
      var l = Math.max(0, Math.min(window.innerWidth - 54, ox + dx))
      var b = Math.max(0, Math.min(window.innerHeight - 54, oy - dy))
      applyPos(l, b)
    })

    document.addEventListener('mouseup', function () {
      if (!dragging) return
      dragging = false
      root.classList.remove('qw-dragging')
      if (moved) {
        lsSet(POS_KEY, Math.round(parseFloat(root.style.left)) + ',' + Math.round(parseFloat(root.style.bottom)))
      } else {
        togglePanel()
      }
    })

    window.addEventListener('resize', function () {
      var l = parseFloat(root.style.left)
      var b = parseFloat(root.style.bottom)
      if (!isFinite(l) || !isFinite(b)) return
      applyPos(Math.min(l, window.innerWidth - 54), Math.min(b, window.innerHeight - 54))
    })
  }

  function togglePanel(force) {
    var want = typeof force === 'boolean' ? force : !panelOpen
    if (want === panelOpen) return
    panelOpen = want
    var panel = root.querySelector('.qw-panel')
    panel.classList.toggle('open', panelOpen)
    root.classList.toggle('qw-open', panelOpen)
    lsSet(OPEN_KEY, panelOpen ? '1' : '0')
    if (panelOpen) {
      fetchState().then(function (s) { if (s) state = s; render() })
      /* 展开瞬间立刻拉一次，别让用户对着"读取中…"等 15 秒 */
      loadData(true)
      startDataTimer()
    } else {
      stopDataTimer()
      hidePreview()
    }
    render()
  }

  function setTab(t) {
    if (TABS.indexOf(t) < 0) t = 'overview'
    activeTab = t
    lsSet(TAB_KEY, t)
    renderTabs()
    renderActivePane()
  }

  function buildPane(tab, extraCls) {
    var p = el('div', 'qw-pane' + (extraCls ? ' ' + extraCls : ''))
    p.setAttribute('data-tab', tab)
    return p
  }

  function buildOverviewPane() {
    var p = buildPane('overview')
    p.appendChild(el('div', 'qw-ov'))
    return p
  }

  function buildMemoryPane() {
    var p = buildPane('memory')
    var top = el('div', 'qw-mem-top')
    top.appendChild(el('div', 'qw-mem-meta', '记忆库'))
    var input = el('input', 'qw-search')
    input.type = 'search'
    input.placeholder = '搜正文 / 日期 / 标签…'
    input.value = memQuery
    /*
     * 输入即筛，**不重建输入框**。列表重绘时只动它下面的节点，
     * 光标和输入法候选都不会被打断。
     */
    input.addEventListener('input', function () {
      memQuery = input.value
      filterMemory()
    })
    top.appendChild(input)
    p.appendChild(top)
    p.appendChild(el('div', 'qw-mem-list'))
    return p
  }

  function buildStickerPane() {
    var p = buildPane('sticker')
    p.appendChild(el('div', 'qw-stk-meta qw-stk-top', '表情库'))
    p.appendChild(el('div', 'qw-stk-grid'))
    return p
  }

  function buildWorkPane() {
    var p = buildPane('work')
    var box = el('div', 'qw-work')

    box.appendChild(el('div', 'qw-sec-t', '通道状态'))
    box.appendChild(el('div', 'qw-work-status qw-rows'))

    box.appendChild(el('div', 'qw-sec-t', '指令 / 研究内容'))
    var input = el('input', 'qw-input')
    input.placeholder = '比如：看看群里谁在聊什么'
    box.appendChild(input)

    var btns = el('div', 'qw-btns')
    var probe = el('button', 'qw-btn', '探活')
    probe.addEventListener('click', function (e) {
      e.stopPropagation()
      runWork('/work/probe', {}, probe)
    })
    var run = el('button', 'qw-btn', '跑一条指令')
    run.addEventListener('click', function (e) {
      e.stopPropagation()
      var v = input.value.trim()
      if (!v) { toast('先写一条指令'); return }
      runWork('/work/run', { task: v, send: false }, run)
    })
    var res = el('button', 'qw-btn', '研究测试')
    res.addEventListener('click', function (e) {
      e.stopPropagation()
      var v = input.value.trim()
      if (!v) { toast('先写点研究内容'); return }
      runWork('/research/test', { text: v }, res)
    })
    btns.appendChild(probe)
    btns.appendChild(run)
    btns.appendChild(res)
    box.appendChild(btns)

    box.appendChild(el('div', 'qw-sec-t', '输出'))
    box.appendChild(el('pre', 'qw-out', '（还没有输出）'))
    p.appendChild(box)
    return p
  }

  function buildSettingPane() {
    var p = buildPane('setting')
    p.appendChild(el('div', 'qw-set'))
    return p
  }

  function build() {
    var wrap = el('div', 'qw-wrap')
    if (detectDark()) wrap.classList.add('qw-dark')

    var panel = el('div', 'qw-panel')

    /* ——— 头部：鲸鱼 + 状态胶囊 + QQ + 模型 + 关闭 ——— */
    var head = el('div', 'qw-head')
    var left = el('div', 'qw-head-main')
    var title = el('div', 'qw-title')
    title.appendChild(document.createTextNode('🐳 Molly '))
    var pill = el('span', 'qw-pill off')
    pill.appendChild(el('i'))
    pill.appendChild(document.createTextNode('连接中…'))
    title.appendChild(pill)
    left.appendChild(title)
    left.appendChild(el('div', 'qw-sub qw-head-qq', 'QQ 111111111 · 蓝色大肥鱼'))
    left.appendChild(el('div', 'qw-sub qw-head-model', '模型 —'))
    head.appendChild(left)
    var x = el('span', 'qw-x', '×')
    x.title = '收起'
    x.addEventListener('click', function (e) {
      e.stopPropagation()
      togglePanel(false)
    })
    head.appendChild(x)
    panel.appendChild(head)

    /* ——— 页签 ——— */
    var tabs = el('div', 'qw-tabs')
    TABS.forEach(function (t) {
      var btn = el('button', 'qw-tab' + (t === activeTab ? ' on' : ''), TAB_LABEL[t])
      btn.type = 'button'
      btn.setAttribute('data-tab', t)
      btn.addEventListener('click', function (e) {
        e.stopPropagation()
        setTab(t)
      })
      tabs.appendChild(btn)
    })
    panel.appendChild(tabs)

    /* ——— 内容区 ——— */
    var body = el('div', 'qw-body')
    body.appendChild(buildOverviewPane())
    body.appendChild(buildMemoryPane())
    body.appendChild(buildStickerPane())
    body.appendChild(buildWorkPane())
    body.appendChild(buildSettingPane())
    panel.appendChild(body)

    /* ——— 底部动作条：沿用原来的三个按钮 ——— */
    var acts = el('div', 'qw-acts')
    var tg = el('button', 'qw-btn qw-toggle', '…')
    tg.addEventListener('click', function (e) {
      e.stopPropagation()
      if (!state) return
      post('/toggle', { enabled: !state.enabled })
    })
    var rf = el('button', 'qw-btn qw-refresh', '重新检查')
    rf.addEventListener('click', function (e) {
      e.stopPropagation()
      post('/recheck', {})
    })
    /*
     * 积分限制的开关（用户 m03969）。
     *
     * 跟「关掉她」并排但样式不同：一个是关整个人，一个是只关省钱模式，
     * 误点的后果差太远，颜色上得能分开。
     */
    var bud = el('button', 'qw-btn qw-budget', '积分限制')
    bud.addEventListener('click', function (e) {
      e.stopPropagation()
      if (!state || !state.budget) return
      var want = !state.budget.enabled
      post('/budget', { enabled: want }).then(function (d) {
        // 读回来之后的真实值，别拿闭包里的旧 state 拼提示语——
        // 否则开关已经翻了，提示还说着上一句。
        var b = d && d.state && d.state.budget
        if (want) toast('积分限制已开，满 ' + (b ? b.cap : 100) + ' 分切 trae')
        else toast('积分限制已关，随便聊')
      })
    })
    /*
     * 打开控制台（19392，panel-ui 的独立服务）。
     *
     * 跟「关她 / 重查 / 积分」不是一类：它不改变她的状态，只是开一扇窗，
     * 所以用紫色实心，跟旁边三个描边按钮一眼分开。
     * 控制台没起来时必须说出来——点了没反应会被当成挂件坏了，然后去重启宿主（会杀 QQ）。
     * 探活用 mode:'no-cors'：控制台不一定带 CORS 头，普通 fetch 会因为读不到响应头
     * 而 reject，服务明明活着却报"未启动"；no-cors 只要连上就 resolve，够判断死活。
     */
    var con = el('button', 'qw-btn qw-console', '打开控制台')
    con.type = 'button'
    con.title = '打开 Molly 控制台'
    con.addEventListener('click', function (e) {
      e.stopPropagation()
      if (con.disabled) return
      con.disabled = true
      var ctl = null
      var to = null
      try {
        ctl = new AbortController()
        to = setTimeout(function () { try { ctl.abort() } catch (er) {} }, 2000)
      } catch (er) { ctl = null }
      fetch('http://127.0.0.1:19392/api/health', {
        mode: 'no-cors',
        cache: 'no-store',
        signal: ctl ? ctl.signal : undefined,
      }).then(function () {
        if (to) clearTimeout(to)
        con.disabled = false
        con.textContent = '打开控制台'
        var hint = root && root.querySelector('.qw-console-hint')
        if (hint) { hint.textContent = ''; hint.classList.remove('show') }
        var w = null
        try {
          w = window.open('http://127.0.0.1:19392/', 'molly-console', 'width=1280,height=860')
        } catch (er) { w = null }
        if (!w) toast('浏览器拦了弹窗，允许后再点一次')
      }).catch(function () {
        if (to) clearTimeout(to)
        con.disabled = false
        con.textContent = '控制台未启动（点我重试）'
        con.style.background = 'transparent'
        con.style.color = 'var(--qw-bad)'
        var hint = root && root.querySelector('.qw-console-hint')
        if (hint) {
          hint.textContent = '控制台没起来（127.0.0.1:19392 无响应）。它跟挂件是分开的，' +
            '起法见 tools\\console-server.mjs；别为此重启 DSH（重启会杀 QQ）。'
          hint.classList.add('show')
        }
        setTimeout(function () {
          con.textContent = '打开控制台'
          con.style.background = '#5645d4'
          con.style.color = '#fff'
        }, 4000)
      })
    })
    acts.appendChild(tg)
    acts.appendChild(rf)
    acts.appendChild(bud)
    acts.appendChild(con)
    panel.appendChild(acts)

    /* 控制台没起时的提示行：常驻在按钮下方，不靠 toast（1.8 秒就没了） */
    panel.appendChild(el('div', 'qw-console-hint', ''))

    panel.appendChild(el('div', 'qw-toast'))

    /* 大图预览层：挂在面板上而不是页签里，切页签/刷新数据都不会把它弄丢 */
    var preview = el('div', 'qw-preview')
    var pimg = el('img')
    pimg.alt = ''
    preview.appendChild(pimg)
    preview.appendChild(el('div', 'n'))
    preview.appendChild(el('div', 'h', '点任意处关闭'))
    preview.addEventListener('click', function (e) {
      e.stopPropagation()
      hidePreview()
    })
    panel.appendChild(preview)

    /* ——— 收起态：鲸鱼头 + 模型标签 ——— */
    var pillBtn = el('div', 'qw-dot-btn off')
    pillBtn.appendChild(el('div', 'qw-ico', '🐳'))
    pillBtn.appendChild(el('div', 'qw-core'))
    pillBtn.title = 'Molly · 连接中…'

    // 模型名标签：收起态也一直挂着，用户一眼能看见"她这会儿是谁在说话"
    var modelTag = el('div', 'qw-model')
    modelTag.textContent = '…'
    modelTag.title = 'Molly 当前用的模型'

    // 鲸鱼头和标签得并排——外面套一层横向容器（wrap 本身是竖的）
    var dock = el('div', 'qw-dock')
    dock.appendChild(pillBtn)
    dock.appendChild(modelTag)

    wrap.appendChild(panel)
    wrap.appendChild(dock)
    ;(document.body || document.documentElement).appendChild(wrap)
    root = wrap

    installDrag(pillBtn)
    restorePos()
    render()

    // 上次是展开的就还原（用户明确想开，不该被刷新吃掉）
    if (lsGet(OPEN_KEY, '0') === '1') togglePanel(true)
  }

  function restorePos() {
    var p = lsGet(POS_KEY, '')
    if (!p) return
    var m = /^(-?\d+),(-?\d+)$/.exec(p)
    if (!m) return
    var l = Math.max(0, Math.min(window.innerWidth - 54, parseInt(m[1], 10)))
    var b = Math.max(0, Math.min(window.innerHeight - 54, parseInt(m[2], 10)))
    root.style.left = l + 'px'
    root.style.bottom = b + 'px'
    root.style.right = 'auto'
    root.classList.toggle('qw-left', l > window.innerWidth / 2)
  }

  function tick() {
    fetchState().then(function (s) {
      if (s) {
        state = s
        render()
      }
    })
  }

  function start() {
    try {
      /* 上次停在哪个页签，刷新后还在那一页 */
      var t = lsGet(TAB_KEY, 'overview')
      activeTab = TABS.indexOf(t) >= 0 ? t : 'overview'
      injectStyle()
      build()
      tick()
      timer = setInterval(tick, POLL_MS)
    } catch (e) {
      console.error('[dsh-qq-whale] 挂件初始化失败：', e)
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start)
  } else {
    start()
  }
})()
