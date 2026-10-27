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

/** 跑一个本地脚本并等它退出，只回退出码（不抓 stdout，避免和卡巴/沙箱的管道限制打架） */function runOnce(script, args = []) {
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
};

// ---------- 一次性口令 ----------
function issueOtp() {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const rec = { code, exp: Date.now() + 5 * 60 * 1000, used: false };
  fs.writeFileSync(OTP_FILE, JSON.stringify(rec), 'utf8');
  log(`一次性口令：${code}（5 分钟内有效，用一次即废）`);
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
