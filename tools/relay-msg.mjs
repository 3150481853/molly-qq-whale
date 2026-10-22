#!/usr/bin/env node
// Molly ⇄ 服务器 DSH 留言通道小工具（家里这台用）
// 契约来源：服务器 DSH #16（2026-10-22）：POST /messages 发；GET /messages?since=N&limit=100 读；
// 头 X-Molly-Token；单条 ≤4000 字；只读 /status /status.md /health（便于人看）。
// 用法：
//   node tools/relay-msg.mjs get                # 从上次读到的位置继续读（默认 since=state.lastId）
//   node tools/relay-msg.mjs get --since 15     # 从指定位置读（不含 15 本身？含，服务端语义：since=已读到的 id）
//   node tools/relay-msg.mjs get --unread --json
//   node tools/relay-msg.mjs read 16            # 读某一条全文
//   node tools/relay-msg.mjs post "内容"        # 发一条（from=home-dsh）
//   node tools/relay-msg.mjs status             # 看服务器 /health + 通道最新状态
//   node tools/relay-msg.mjs state              # 看本地记录到哪了
// 配置：优先环境变量 MOLLY_RELAY_BASE / MOLLY_RELAY_TOKEN，
//       否则读 out/heartbeat-config.json 里的 relayBase / token。
// 本地进度：out/relay-state.json（{"lastId":16}）。读过的位置会自动保存，避免重复。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'out');
const CONFIG_PATH = path.join(OUT, 'heartbeat-config.json');
const STATE_PATH = path.join(OUT, 'relay-state.json');
const DEFAULT_BASE = 'https://example.asia/molly';
const TIMEOUT_MS = 15000;

const args = process.argv.slice(2);
const command = (args[0] || 'help').toLowerCase();
const flags = {};
const positional = [];
for (let i = 1; i < args.length; i++) {
  const a = args[i];
  if (a === '--json') flags.json = true;
  else if (a === '--unread' || a === '--new') flags.unread = true;
  else if (a === '--no-save') flags.noSave = true;
  else if (a === '--since') flags.since = Number(args[++i]);
  else if (a === '--limit') flags.limit = Number(args[++i]);
  else if (a === '--text') flags.text = args[++i];
  else if (!a.startsWith('--')) positional.push(a);
}

function readJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

const cfg = readJson(CONFIG_PATH, {}) || {};
const BASE = String(process.env.MOLLY_RELAY_BASE || cfg.relayBase || DEFAULT_BASE).replace(/\/+$/, '');
const TOKEN = String(process.env.MOLLY_RELAY_TOKEN || cfg.token || '');
const state = readJson(STATE_PATH, { lastId: 0 }) || { lastId: 0 };

function headers(extra = {}) {
  const h = { Accept: 'application/json', ...extra };
  if (TOKEN) h['X-Molly-Token'] = TOKEN;
  return h;
}

async function request(method, pathname, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(BASE + pathname, {
      method,
      headers: headers(body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { status: res.status, ok: res.ok, data, text };
  } finally {
    clearTimeout(timer);
  }
}

function fail(message, detail) {
  console.error('✗ ' + message);
  if (detail) console.error(String(detail).slice(0, 800));
  process.exit(1);
}

function excerpt(text, max = 120) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function messagesOf(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.messages)) return data.messages;
  if (Array.isArray(data.items)) return data.items;
  if (data.message && Array.isArray(data.message.messages)) return data.message.messages;
  return [];
}

function idOf(m, idx) {
  const n = Number(m && (m.id ?? m.lastId ?? m.seq ?? m.messageId));
  return Number.isFinite(n) ? n : idx;
}

async function cmdGet() {
  const since = Number.isFinite(flags.since)
    ? flags.since
    : Number(flags.unread ? 0 : state.lastId || 0);
  const limit = Number.isFinite(flags.limit) ? Math.min(Math.max(flags.limit, 1), 100) : 50;
  const res = await request('GET', `/messages?since=${encodeURIComponent(since)}&limit=${encodeURIComponent(limit)}`);
  if (!res.ok) fail(`读取失败 HTTP ${res.status}`, res.text);
  const list = messagesOf(res.data);
  if (flags.json) {
    console.log(JSON.stringify({ base: BASE, since, limit, count: list.length, messages: list }, null, 2));
  } else {
    const lastIdShown = list.length ? Math.max(...list.map((m, i) => idOf(m, i))) : since;
    console.log(`通道 ${BASE}  since=${since} 条数=${list.length}` + (list.length ? `  最新id=${lastIdShown}` : ''));
    for (const m of list) {
      console.log(`  #${String(m.id ?? '?').padEnd(4)} [${m.from || '?'}] ${excerpt(m.text)}`);
      if (m.ts || m.time) console.log(`        ${m.ts || m.time}`);
    }
    if (!list.length) console.log('  （没有新留言）');
  }
  if (!flags.noSave && list.length) {
    const last = Math.max(...list.map((m, i) => idOf(m, i)));
    if (last > (state.lastId || 0)) {
      state.lastId = last;
      state.updatedAt = new Date().toISOString();
      writeJson(STATE_PATH, state);
    }
  }
}

async function cmdRead() {
  const id = Number(positional[0] ?? flags.id);
  if (!Number.isFinite(id)) fail('用法：node tools/relay-msg.mjs read <id>');
  const since = Math.max(0, id - 1);
  const res = await request('GET', `/messages?since=${since}&limit=100`);
  if (!res.ok) fail(`读取失败 HTTP ${res.status}`, res.text);
  const list = messagesOf(res.data);
  const target = list.find((m, i) => Number(m.id) === id) || (list.length === 1 ? list[0] : null);
  if (!target) fail(`没找到 #${id}（服务端返回 ${list.length} 条：${list.map((m, i) => m.id ?? i).join(',') || '空'}）`);
  if (flags.json) console.log(JSON.stringify(target, null, 2));
  else {
    console.log(`#${target.id}  from=${target.from}  ${target.ts || target.time || ''}`);
    console.log(String(target.text || '').trim());
  }
}

async function cmdPost() {
  const text = flags.text ?? positional.join(' ');
  if (!String(text || '').trim()) fail('用法：node tools/relay-msg.mjs post "要发送的内容"（或 --text "..."）');
  const body = { from: 'home-dsh', text: String(text).trim() };
  const res = await request('POST', '/messages', body);
  if (!res.ok) fail(`发送失败 HTTP ${res.status}`, res.text || JSON.stringify(res.data));
  const d = res.data || {};
  console.log(`✓ 已发送（HTTP ${res.status}）` + (d.id != null ? ` id=${d.id}` : '') + (d.ok === false ? ' ⚠ 服务端 ok=false' : ''));
  if (d && !flags.json) {
    console.log(JSON.stringify(d, null, 2));
  } else if (flags.json) {
    console.log(JSON.stringify(d, null, 2));
  }
}

async function cmdStatus() {
  const since = state.lastId || 0;
  const health = await request('GET', '/health');
  console.log(`通道 ${BASE}`);
  console.log(health.ok
    ? `  /health HTTP ${health.status}: ${excerpt(health.text, 300)}`
    : `  /health HTTP ${health.status}: ${excerpt(health.text, 300)}`);
  const got = await request('GET', `/messages?since=${since}&limit=5`);
  if (got.ok) {
    const list = messagesOf(got.data);
    console.log(`  本地进度 lastId=${since}；还有 ${list.length} 条新留言`);
    for (const m of list) console.log(`    #${m.id ?? '?'} [${m.from || '?'}] ${excerpt(m.text, 60)}`);
  } else {
    console.log(`  /messages HTTP ${got.status}: ${excerpt(got.text, 200)}`);
  }
}

function cmdState() {
  console.log(`配置文件 ${CONFIG_PATH}  ${fs.existsSync(CONFIG_PATH) ? '存在' : '不存在'}`);
  console.log(`通道 ${BASE}  token=${TOKEN ? '已配置(' + TOKEN.slice(0, 6) + '…)' : '未配置'}`);
  console.log(`本地进度 ${STATE_PATH}: ${JSON.stringify(state)}`);
}

function cmdHelp() {
  console.log(`Molly ⇄ 服务器 DSH 留言通道
  
用法：
  node tools/relay-msg.mjs get [--since N] [--limit N] [--unread] [--json] [--no-save]
  node tools/relay-msg.mjs read <id> [--json]
  node tools/relay-msg.mjs post "内容" [--json]
  node tools/relay-msg.mjs status
  node tools/relay-msg.mjs state
  
通道：${BASE}
进度：${STATE_PATH}`);
}

try {
  if (command === 'get' || command === 'read' || command === 'unread' || command === 'poll') {
    if (command === 'read') await cmdRead();
    else await cmdGet();
  } else if (command === 'post' || command === 'send') {
    await cmdPost();
  } else if (command === 'status') {
    await cmdStatus();
  } else if (command === 'state') {
    cmdState();
  } else {
    cmdHelp();
  }
} catch (err) {
  fail((err && err.message) || String(err));
}
