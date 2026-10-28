#!/usr/bin/env node
/**
 * cmd-agent —— 远程指令信箱的"家里那一端"
 *
 * 形态：服务器存指令，家里轮询拉取、执行、回写结果。全程出站，不需要端口映射/隧道。
 * 依赖：零依赖（只用 node 内置 fetch / fs）。
 *
 * 用法：
 *   node tools/cmd-agent.mjs --once           跑一轮（拉取→执行→回写）
 *   node tools/cmd-agent.mjs --loop           常驻，默认 30 秒一轮
 *   node tools/cmd-agent.mjs --issue-otp      生成一次性口令（破坏性动作需要，5 分钟有效）
 *   node tools/cmd-agent.mjs --dry-run       只打印将要执行的动作，不真跑、不回写
 *
 * 环境变量覆盖（便于本地 mock 测试）：
 *   MOLLY_RELAY_BASE   默认取 out/heartbeat-config.json 的 relayBase
 *   MOLLY_RELAY_TOKEN  同上 token
 *   MOLLY_CMD_KEY      二级口令；不设则只读 out/cmd-key.txt
 *   MOLLY_CMD_STATE    状态文件路径，默认 out/cmd-state.json
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { sendGroupText, sendPrivateText } from './qq-say.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const ROOT = path.resolve(HERE, '..');            // qq-whale/
const OUT = path.join(ROOT, 'out');
const DATA = process.env.MOLLY_DATA_DIR || path.join('G:\\Molly\\data\\qq-whale');

const argv = new Set(process.argv.slice(2));
const DRY = argv.has('--dry-run');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function tail(p, n) {
  try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).slice(-n); } catch { return []; }
}
function log(line) { console.log(`[${new Date().toISOString()}] ${line}`); }
function audit(entry) {
  try {
    fs.appendFileSync(path.join(OUT, 'cmd-audit.log'),
      `${new Date().toISOString()}\t${JSON.stringify(entry)}\n`, 'utf8');
  } catch { /* 审计失败不影响主流程 */ }
}

/** 每轮一行的轻量运行日志，用来判断 agent 是否还活着（超过 256KB 自动瘦身到最近 500 行） */
const AGENT_LOG = path.join(OUT, 'cmd-agent.log');
function appendLog(line) {
  try {
    fs.appendFileSync(AGENT_LOG, `${new Date().toISOString()}\t${line}\n`, 'utf8');
    if (fs.statSync(AGENT_LOG).size > 256 * 1024) {
      const keep = fs.readFileSync(AGENT_LOG, 'utf8').split('\n').filter(Boolean).slice(-500);
      fs.writeFileSync(AGENT_LOG, `${keep.join('\n')}\n`, 'utf8');
    }
  } catch { /* 日志失败不影响主流程 */ }
}

/** 让模型按 Molly 的人设写一句可以直接发出去的话（不含解释与引号） */
async function askText(prompt) {
  const p = String(prompt || '').trim();
  if (!p) throw new Error('缺少提示词');
  let persona = '';
  try { persona = fs.readFileSync(PERSONA_FILE, 'utf8').slice(0, 6000); } catch { /* 读不到人设就退化成通用口吻 */ }
  const sys = (persona || '你是 Molly，一个在 QQ 上聊天的普通人。')
    + '\n\n【这一次的任务】下面会给你一个要求。你只需要输出**一句**可以直接发到聊天里的话：'
    + '不要解释、不要加引号、不要 Markdown、不要提“任务/要求/提示词”、不要自称 AI。控制在 60 字以内。';
  const r = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${GATEWAY_KEY}` },
    body: JSON.stringify({
      model: ASK_MODEL,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: p }],
      max_tokens: 500,
      temperature: 0.85,
      stream: false,
    }),
  });
  if (!r.ok) throw new Error(`模型网关 HTTP ${r.status}`);
  const j = await r.json();
  let t = String(j?.choices?.[0]?.message?.content || '').trim();
  t = t.replace(/^["'“”「」]+|["'“”「」]+$/g, '').trim();
  if (!t) throw new Error('模型返回空内容（可能被思考链吃掉了）');
  return t.length > 200 ? t.slice(0, 200) : t;
}

/** 跑一个本地脚本并等它退出，只回退出码（不抓 stdout，避免和卡巴/沙箱的管道限制打架） */
function runOnce(script, args = []) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [script, ...args], { stdio: 'ignore', windowsHide: true });
    } catch {
      resolve(-1);
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } resolve(-2); }, 120000);
    child.on('error', () => { clearTimeout(timer); resolve(-1); });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve(signal ? -3 : (code ?? -1));
    });
  });
}

// ---------- 通道配置 ----------
const hb = readJson(path.join(OUT, 'heartbeat-config.json'), {});
const BASE = (process.env.MOLLY_RELAY_BASE || hb.relayBase || 'https://example.asia/molly').replace(/\/+$/, '');
const TOKEN = process.env.MOLLY_RELAY_TOKEN || hb.token || '';
const CMD_KEY = process.env.MOLLY_CMD_KEY
  || (() => { try { return fs.readFileSync(path.join(OUT, 'cmd-key.txt'), 'utf8').trim(); } catch { return ''; } })();
const STATE = process.env.MOLLY_CMD_STATE || path.join(OUT, 'cmd-state.json');
const OTP_FILE = path.join(OUT, 'cmd-otp.json');
const OWNER_UIN = Number(process.env.MOLLY_OWNER_UIN || 222222222);

// ---------- 「让 Molly 自己说」用的模型通道 ----------
// 走本机网关（和插件同一条链路），不经过插件代码；人设直接读 persona/core.md。
const GATEWAY_URL = process.env.MOLLY_GATEWAY_URL || 'http://127.0.0.1:8788/v1/chat/completions';
const GATEWAY_KEY = process.env.MOLLY_GATEWAY_KEY || 'wb-proxy-local';
const ASK_MODEL = process.env.MOLLY_ASK_MODEL || 'deepseek-v4.1-flash';
const PERSONA_FILE = process.env.MOLLY_PERSONA_FILE
  || path.join(ROOT, 'plugin', 'dsh-qq-whale', 'persona', 'core.md');

// ---------- 动作白名单 ----------
// readOnly=true 的动作不需要 otp；其余必须带有效 otp
const ACTIONS = {
  ping: {
    readOnly: true,
    run: () => ({ host: os.hostname(), pid: process.pid, agent: 'cmd-agent/1.0.0', at: new Date().toISOString() }),
  },
  status: {
    readOnly: true,
    async run() {
      const r = await fetch(`${BASE}/health`, { headers: { 'x-molly-token': TOKEN } });
      const h = await r.json();
      const m = h?.lastHeartbeat?.molly || {};
      return {
        level: h.level, stale: h.stale, ageSeconds: h.ageSeconds,
        link: m.link, ready: m.ready, bot: m.bot, memory: m.memory, stickers: m.stickers,
        budget: m.budget, plugins: m.plugins, watchdog: m.watchdog?.state, pest: !!m.pest?.enabled,
      };
    },
  },
  logs: {
    readOnly: true,
    run(args = {}) {
      const n = Math.min(Math.max(Number(args.lines) || 20, 1), 80);
      return { file: 'out/heartbeat.log', lines: tail(path.join(OUT, 'heartbeat.log'), n) };
    },
  },
  budget: {
    readOnly: true,
    run() {
      const b = readJson(path.join(DATA, 'budget.json'), null);
      if (!b) return { error: 'budget.json 不存在' };
      return { date: b.date, used: b.used, cap: null, calls: b.calls, tokens: b.tokens, byChannel: b.byChannel };
    },
  },
  // ---- 以下为破坏性动作，必须带 otp ----
  'reload-watchdog': {
    readOnly: false,
    async run() {
      const code = await runOnce(path.join(HERE, 'watchdog.mjs'), ['--once']);
      return { ok: code === 0, exitCode: code };
    },
  },
  say: {
    readOnly: false,
    async run(args = {}) {
      const groupId = Number(args.groupId);
      const text = String(args.text || '').trim();
      if (!Number.isInteger(groupId) || groupId <= 0) throw new Error('缺少合法 groupId');
      if (!text) throw new Error('缺少 text');
      if (text.length > 200) throw new Error('text 太长（上限 200 字）');
      const r = await sendGroupText(groupId, text);
      // 注意：result 是公开可读的（服务器截断 500），这里只回执状态，不回显群号与正文
      return { ok: true, messageId: r?.message_id ?? null, chars: text.length };
    },
  },
  'say-private': {
    readOnly: false,
    async run(args = {}) {
      const uin = Number(args.uin);
      const text = String(args.text || '').trim();
      if (!Number.isInteger(uin) || uin < 10000) throw new Error('缺少合法 uin');
      if (!text) throw new Error('缺少 text');
      if (text.length > 200) throw new Error('text 太长（上限 200 字）');
      const r = await sendPrivateText(uin, text);
      // result 公开可读：只回执状态，不回显 uin 与正文
      return { ok: true, messageId: r?.message_id ?? null, chars: text.length };
    },
  },
  /** 让 Molly 自己按人设写一句，发到群里 */
  ask: {
    readOnly: false,
    async run(args = {}) {
      const groupId = Number(args.groupId);
      if (!Number.isInteger(groupId) || groupId <= 0) throw new Error('缺少合法 groupId');
      const text = await askText(args.prompt);
      const r = await sendGroupText(groupId, text);
      return { ok: true, messageId: r?.message_id ?? null, chars: text.length };
    },
  },
  /** 同上，发私聊 */
  'ask-private': {
    readOnly: false,
    async run(args = {}) {
      const uin = Number(args.uin);
      if (!Number.isInteger(uin) || uin < 10000) throw new Error('缺少合法 uin');
      const text = await askText(args.prompt);
      const r = await sendPrivateText(uin, text);
      return { ok: true, messageId: r?.message_id ?? null, chars: text.length };
    },
  },
  /**
   * 上架审核：把插件卡片私信给审核人（默认主人 + mndnbd），并进本地待审队列。
   * 注意 result 公开可读，所以只回执「通知了几个人」，不回显卡片内容。
   */
  review: {
    readOnly: false,
    async run(args = {}) {
      const c = args.card && typeof args.card === 'object' ? args.card : {};
      const id = String(c.id || '').trim();
      const name = String(c.name || '').trim();
      const summary = String(c.summary || '').trim();
      if (!/^[a-z0-9][a-z0-9-]{1,31}$/.test(id)) throw new Error('id 需 2–32 位小写字母/数字/短横线');
      if (!name) throw new Error('缺 name');
      if (!summary) throw new Error('缺 summary');
      const tier = String(c.tier || 'A').toUpperCase();
      if (!'ABC'.includes(tier)) throw new Error('tier 只能是 A/B/C');
      const card = {
        id, name, summary,
        author: String(c.author || '匿名'),
        version: String(c.version || '0.0.0'),
        license: String(c.license || 'MIT'),
        tier,
        repo: String(c.repo || ''),
        tags: Array.isArray(c.tags) ? c.tags.slice(0, 6) : [],
      };
      const targets = String(process.env.MOLLY_REVIEW_TARGETS || '')
        .split(',').map((x) => Number(String(x).trim())).filter((n) => Number.isInteger(n) && n > 10000);
      const list = targets.length ? targets : [OWNER_UIN, 333333333];
      const text = [
        '【插件上架待审】',
        `id：${card.id}`,
        `名称：${card.name}`,
        `版本：${card.version}`,
        `作者：${card.author}`,
        `许可：${card.license}`,
        `档位：${card.tier}`,
        `简介：${card.summary}`,
        `仓库：${card.repo || '(无)'}`,
        '',
        `回复「准 ${card.id}」或「驳回 ${card.id} 理由」`,
      ].join('\n');
      let ok = 0; const errs = [];
      for (const uin of list) {
        try { await sendPrivateText(uin, text); ok++; } catch (e) { errs.push(`${uin}:${String(e?.message || e).slice(0, 30)}`); }
      }
      try {
        const f = path.join(OUT, 'review-pending.json');
        const cur = readJson(f, { items: [] });
        cur.items = Array.isArray(cur.items) ? cur.items : [];
        cur.items.unshift({ at: new Date().toISOString(), card, notified: ok });
        cur.items = cur.items.slice(0, 100);
        fs.writeFileSync(f, JSON.stringify(cur, null, 2), 'utf8');
      } catch { /* 队列落盘失败不影响发信 */ }
      return { ok: ok > 0, notified: ok, targets: list.length, failed: errs.length ? errs : undefined, id: card.id };
    },
  },
};

// ---------- 把中继里的「插件提交/审核」通知转成 QQ 私信 ----------
const RELAY_WATCH_STATE = path.join(OUT, 'relay-watch-state.json');

/** 首次运行只记基线，不倒灌历史消息 */
async function forwardRelayNotifications() {
  const st = readJson(RELAY_WATCH_STATE, null);
  const since = st && Number.isFinite(Number(st.lastId)) ? Number(st.lastId) : null;
  const url = `${BASE}/messages?since=${since ?? 0}&limit=20`;
  const r = await fetch(url, { headers: { 'x-molly-token': TOKEN } });
  if (!r.ok) { log(`看中继失败 HTTP ${r.status}`); return; }
  const j = await r.json();
  const list = j?.messages || j?.items || (Array.isArray(j) ? j : []);
  if (!list.length) return;
  const maxId = list.reduce((a, m) => Math.max(a, Number(m.id) || 0), since ?? 0);
  // 服务端会回一个 lastId（当前最大 id）；用它当游标，别用「本页最大」——
  // 否则 since=0 只拿到前 20 条，游标会停在 20，下次把 21..N 当新消息全转发一遍。
  const cursor = Number.isFinite(Number(j?.lastId)) ? Number(j.lastId) : maxId;

  if (since === null) {
    // 基线：只记位置，不转发
    fs.writeFileSync(RELAY_WATCH_STATE, JSON.stringify({ lastId: cursor, at: new Date().toISOString() }), 'utf8');
    log(`中继看守建基线 lastId=${cursor}（历史消息不转发）`);
    return;
  }

  // 收集本轮要发的事件，最后**合并成一条**发出去，避免刷屏
  const NOTIFY_CFG = readJson(path.join(OUT, 'notify-config.json'), null) || {};
  const muteForOwner = Array.isArray(NOTIFY_CFG.muteForOwner) ? NOTIFY_CFG.muteForOwner : ['今年的你不懂'];
  const ownerLines = [];
  const otherLines = [];
  for (const m of list) {
    if ((Number(m.id) || 0) <= since) continue;
    const text = String(m.text || '').trim();
    const isPluginEvent = /^\[插件(提交|审核)\]/.test(text) || String(m.from) === 'myblog';
    if (!isPluginEvent) continue;
    // 自己干的事不再通知自己（否则点一次提交就自己收一条），但仍告知其它审核人
    const byMe = muteForOwner.some((name) => name && text.includes(` by ${name}`));
    if (!byMe) ownerLines.push(text);
    otherLines.push(text);
  }

  let forwarded = 0;
  const pack = (lines) => {
    const head = '【部落格来信】';
    let body = lines.join('\n——\n');
    if (body.length > 1200) body = `${body.slice(0, 1200)}…（还有 ${lines.length} 条未展开）`;
    return `${head}\n${body}`;
  };
  for (const [uin, lines] of [[OWNER_UIN, ownerLines], [333333333, otherLines]]) {
    if (!lines.length) continue;
    try {
      await sendPrivateText(uin, pack(lines));
      forwarded++;
    } catch (e) {
      log(`转发失败 ${uin}：${String(e?.message || e).slice(0, 40)}`);
    }
  }
  if (forwarded) appendLog(`relay-forward ${forwarded} 条目标（owner ${ownerLines.length} / 其它 ${otherLines.length}）`);
  fs.writeFileSync(RELAY_WATCH_STATE, JSON.stringify({ lastId: cursor, at: new Date().toISOString() }), 'utf8');
}

// ---------- 一次性口令 ----------
function issueOtp() {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const rec = { code, exp: Date.now() + 5 * 60 * 1000, used: false };
  fs.writeFileSync(OTP_FILE, JSON.stringify(rec), 'utf8');
  log(`一次性口令：${code}（5 分钟内有效，用一次即废）`);
  return rec;
}
/** 有没有一条「还没用、还没过期」的口令；有就复用，不再重发，避免口令刷屏 */
function peekOtp() {
  const rec = readJson(OTP_FILE, null);
  if (!rec || rec.used) return null;
  if (Date.now() > rec.exp) return null;
  return rec;
}
function checkOtp(code) {
  if (!code) return { ok: false, why: 'need-otp' };
  const rec = readJson(OTP_FILE, null);
  if (!rec) return { ok: false, why: 'no-otp-issued' };
  if (rec.used) return { ok: false, why: 'otp-used' };
  if (Date.now() > rec.exp) return { ok: false, why: 'otp-expired' };
  if (String(code) !== String(rec.code)) return { ok: false, why: 'otp-mismatch' };
  rec.used = true;
  fs.writeFileSync(OTP_FILE, JSON.stringify(rec), 'utf8');
  return { ok: true };
}

// ---------- 执行 ----------
async function execute(cmd) {
  const action = String(cmd.action || '').trim();
  const def = ACTIONS[action];
  if (!def) {
    audit({ id: cmd.id, action, outcome: 'rejected', why: 'not-in-whitelist' });
    return { status: 'failed', result: `动作不在白名单：${action || '(空)'}；可用：${Object.keys(ACTIONS).join(', ')}` };
  }
  if (!def.readOnly) {
    const v = checkOtp(cmd.otp || cmd.args?.otp);
    if (!v.ok) {
      audit({ id: cmd.id, action, outcome: 'rejected', why: v.why });
      // 没口令 / 口令过期 → 现发一个，并且直接私信给主人（不写进公开 result）
      if (v.why === 'need-otp' || v.why === 'no-otp-issued' || v.why === 'otp-expired') {
        // 已经有一条有效未用的口令 → 复用它，别再发新的（否则每次重试都把上一条作废）
        const live = peekOtp();
        if (live) {
          const mins = Math.max(1, Math.ceil((live.exp - Date.now()) / 60000));
          return { status: 'failed', result: `需要一次性口令：${mins} 分钟前发到你 QQ 的那条仍然有效，直接填它重发即可（不会重发新口令）` };
        }
        const rec = issueOtp();
        let dm = 'failed';
        try {
          await sendPrivateText(OWNER_UIN,
            `Molly 控制台请求执行「${action}」\n一次性口令：${rec.code}\n5 分钟内有效，用一次即废。不是你发的就忽略这条。`);
          dm = 'sent';
        } catch (e) {
          dm = `failed(${String(e?.message || e).slice(0, 40)})`;
        }
        return { status: 'failed', result: `需要一次性口令，已尝试私信主人（${dm}）；5 分钟内有效，用一次即废` };
      }
      return { status: 'failed', result: `破坏性动作需要一次性口令（${v.why}）` };
    }
  }
  try {
    const out = await def.run(cmd.args || {});
    let text = typeof out === 'string' ? out : JSON.stringify(out);
    if (text.length > 500) text = `${text.slice(0, 497)}...`;
    audit({ id: cmd.id, action, outcome: 'done', result: text.slice(0, 200) });
    return { status: 'done', result: text };
  } catch (e) {
    audit({ id: cmd.id, action, outcome: 'failed', why: String(e?.message || e) });
    return { status: 'failed', result: `执行出错：${String(e?.message || e).slice(0, 300)}` };
  }
}

// ---------- 主流程 ----------
async function tick() {
  const st = readJson(STATE, { lastId: 0 });
  const url = `${BASE}/cmd?since=${st.lastId || 0}&limit=20`;
  const r = await fetch(url, { headers: { 'x-molly-cmd': CMD_KEY, 'x-molly-token': TOKEN } });
  if (!r.ok) { log(`拉取失败 HTTP ${r.status}：${(await r.text()).slice(0, 160)}`); return; }
  const rows = await r.json();
  const list = Array.isArray(rows) ? rows : (rows.items || []);
  const queued = list.filter((x) => (x.status || 'queued') === 'queued');
  log(`拉到 ${list.length} 条，待执行 ${queued.length} 条（lastId=${st.lastId || 0}）`);
  for (const cmd of queued) {
    if (DRY) { log(`[dry-run] 将执行 #${cmd.id} ${cmd.action} ${JSON.stringify(cmd.args || {})}`); continue; }
    const res = await execute(cmd);
    const post = await fetch(`${BASE}/cmd/result`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', 'x-molly-token': TOKEN },
      body: JSON.stringify({ id: cmd.id, status: res.status, result: res.result }),
    });
    log(`#${cmd.id} ${cmd.action} → ${res.status}（回写 HTTP ${post.status}）`);
  }
  const maxId = list.reduce((a, x) => Math.max(a, Number(x.id) || 0), Number(st.lastId) || 0);
  try { await forwardRelayNotifications(); } catch (e) { log(`中继看守异常：${String(e?.message || e).slice(0, 60)}`); }
  if (!DRY) {
    // 每轮都落一次状态，方便外部判断「agent 还活着吗」（lastId 没变也要写 at）
    fs.writeFileSync(STATE, JSON.stringify({ lastId: maxId, at: new Date().toISOString() }), 'utf8');
    appendLog(`ok rows=${list.length} queued=${queued.length} lastId=${maxId}`);
  }
}

if (argv.has('--issue-otp')) {
  issueOtp();
} else if (argv.has('--once') || argv.has('--dry-run')) {
  await tick();
} else if (argv.has('--loop')) {
  const every = Number(process.env.MOLLY_CMD_INTERVAL_MS) || 30000;
  log(`常驻：每 ${every}ms 拉一次，通道 ${BASE}，口令${CMD_KEY ? '已配置' : '缺失（写接口会被拒）'}`);
  for (;;) {
    try { await tick(); } catch (e) { log(`轮次异常：${e?.message || e}`); }
    await new Promise((r) => setTimeout(r, every));
  }
} else {
  console.log('用法：--once | --loop | --dry-run | --issue-otp');
}
