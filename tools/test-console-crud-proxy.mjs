#!/usr/bin/env node
/**
 * console-server CRUD 代理层单测（task-18）
 *
 * 做法：起一个假插件服务（模拟 DSH 宿主的 /dsh-qq-whale/* 接口），
 * 再用 MOLLY_PLUGIN_BASE 把 console-server 指过去，然后打 console-server 的
 * /api/action/* —— 验证代理层的透传、校验、413、409 等行为。
 *
 * 全程不碰真库：假插件只返回内存里的固定对象。
 *
 * 用法：node test-console-crud-proxy.mjs
 * 退出码：0 全过 / 1 有失败
 */
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, 'console-server.mjs');
const NODE_EXE = process.execPath;

// ── 假插件：可编程返回，测试里随时改 fake.mode ──────────────────────────────
const fake = {
  mode: 'ok',
  received: null, // 记录最后一次收到的 body，用来断言代理有没有改坏 payload
  lastPath: null,
  lastMethod: null,
  hits: 0,
};

const fakeServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (b) => {
    raw += b.toString('utf8');
  });
  req.on('end', () => {
    fake.hits += 1;
    fake.lastPath = req.url;
    fake.lastMethod = req.method;
    try {
      fake.received = raw ? JSON.parse(raw) : null;
    } catch {
      fake.received = raw;
    }
    const send = (status, obj) => {
      const b = Buffer.from(JSON.stringify(obj), 'utf8');
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': b.length });
      res.end(b);
    };

    switch (fake.mode) {
      case 'ok':
        // 模拟插件成功响应；不同接口给不同形状，验证原样透传
        if (req.url === '/dsh-qq-whale/memory/list') {
          return send(200, { ok: true, count: 78, entries: [{ id: 'mmvc3yjucwige', kind: 'fact', who: '主人', text: 'x', weight: 3, at: 1792224107508 }] });
        }
        if (req.url === '/dsh-qq-whale/stickers/list') {
          return send(200, { ok: true, count: 15, items: [{ name: 'a_b', ext: '.jpg', file: 'a_b.jpg', size: 1, keywords: ['a', 'b'], mtime: 1 }] });
        }
        if (req.url === '/dsh-qq-whale/memory/pending') {
          return send(200, {
            ok: true,
            count: 2,
            items: [
              { id: 'mp1x2y3z4', text: '待核实A', kind: 'fact', who: '主人', at: 1792224107508, reason: 'similar', score: 0.83 },
              { id: 'mp5a6b7c8', text: '待核实B', kind: 'work', who: '主人', at: 1792224107509, reason: 'low', score: 0.41 },
            ],
          });
        }
        if (req.url === '/dsh-qq-whale/memory/pending/approve') {
          return send(200, { ok: true, entry: { id: 'mmnewone', text: '待核实A' }, count: 79, pending: 1 });
        }
        if (req.url === '/dsh-qq-whale/memory/pending/reject') {
          // 真实插件 web.js 的返回体就是 { ok:true, removed:true, pending }（不是 rejected）
          return send(200, { ok: true, removed: true, pending: 1 });
        }
        return send(200, { ok: true, entry: { id: 'new1' }, count: 79 });
      case 'notfound':
        return send(404, { ok: false, error: '没有这条记忆' });
      case 'conflict':
        return send(409, { ok: false, error: '同名文件已存在' });
      case 'bad':
        return send(400, { ok: false, error: 'text 太长' });
      case 'bizfail':
        return send(200, { ok: false, error: '插件内部业务失败' });
      case 'garbage':
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end('这不是 JSON');
      case 'slow':
        return setTimeout(() => send(200, { ok: true, slow: true }), 30_000);
      default:
        return send(500, { ok: false, error: 'unknown mode' });
    }
  });
});

const PORT_FAKE = 19471;
const PORT_CONSOLE = 19472;

// ── 测试框架 ─────────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failures = [];

function check(name, cond, detail) {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    failures.push(name + (detail ? ` — ${detail}` : ''));
    console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`);
  }
}

async function post(p, body, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${PORT_CONSOLE}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: r.status, json, text };
}

function waitHealth(ms = 15_000) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT_CONSOLE}/api/health`, { signal: AbortSignal.timeout(1000) });
        if (r.ok) return resolve(true);
      } catch {
        /* retry */
      }
      if (Date.now() - t0 > ms) return resolve(false);
      setTimeout(tick, 150);
    };
    tick();
  });
}

const children = [];
function cleanup() {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      /* ignore */
    }
  }
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
async function main() {
  await new Promise((r) => fakeServer.listen(PORT_FAKE, '127.0.0.1', r));
  console.log(`假插件服务已起：http://127.0.0.1:${PORT_FAKE}`);

  const child = spawn(NODE_EXE, [SERVER], {
    env: {
      ...process.env,
      MOLLY_CONSOLE_PORT: String(PORT_CONSOLE),
      MOLLY_CONSOLE_HOST: '127.0.0.1',
      MOLLY_PLUGIN_BASE: `http://127.0.0.1:${PORT_FAKE}`,
      MOLLY_SIDECAR: `http://127.0.0.1:${PORT_FAKE}`,
      MOLLY_NAPCAT: `http://127.0.0.1:${PORT_FAKE}`,
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  children.push(child);

  const up = await waitHealth();
  if (!up) {
    console.log('console-server 起不来，放弃');
    cleanup();
    process.exit(1);
  }
  console.log(`console-server 已起：http://127.0.0.1:${PORT_CONSOLE}`);

  // ── 1. 未知动作：available 必须是 27 个且含 11 个新动作 ───────────────────
  // 数量从 25 涨到 27 是 task-36 加的 pest/status、pest/set（骂人模式开关）。
  // 这条断言的本意是"动作表没被意外删空/重复"，所以跟着真实数量改。
  console.log('\n[1] 未知动作的 data.available');
  {
    const r = await post('/api/action/no/such', {});
    check('未知动作 → 404', r.status === 404, `got ${r.status}`);
    const av = r.json?.data?.available;
    check('available 是数组', Array.isArray(av));
    check('available 长度 = 27', av?.length === 27, `got ${av?.length}`);
    const NEW11 = [
      'memory/list', 'memory/add', 'memory/update', 'memory/delete',
      'stickers/list', 'stickers/add', 'stickers/update', 'stickers/delete',
      'memory/pending', 'memory/pending/approve', 'memory/pending/reject',
    ];
    const missing = NEW11.filter((n) => !av?.includes(n));
    check('11 个新动作全在 available 里', missing.length === 0, `缺 ${missing.join(',')}`);
    check('available 无重复', new Set(av).size === av?.length, `size ${new Set(av).size} vs ${av?.length}`);
  }

  // ── 1b. 待核实区（task-28）──────────────────────────────────────────────
  console.log('\n[1b] 待核实区 3 个动作');
  {
    // 列表：GET，透传 {ok,count,items}
    const l = await post('/api/action/memory/pending', {});
    check('memory/pending → 200', l.status === 200, `got ${l.status}`);
    check('memory/pending 走 GET', fake.lastMethod === 'GET', `got ${fake.lastMethod}`);
    check('memory/pending 走对路径', fake.lastPath === '/dsh-qq-whale/memory/pending', `got ${fake.lastPath}`);
    check('memory/pending 透传 count', l.json?.data?.count === 2, `got ${l.json?.data?.count}`);
    check('memory/pending 透传 items', Array.isArray(l.json?.data?.items) && l.json.data.items.length === 2);
    check('memory/pending 外层 ok:true', l.json?.ok === true, JSON.stringify(l.json)?.slice(0, 120));

    // approve / reject 无 confirm → 409，且不许打到插件
    const before = fake.hits;
    const a = await post('/api/action/memory/pending/approve', { id: 'mp1x2y3z4' });
    check('pending/approve 无 confirm → 409', a.status === 409, `got ${a.status}`);
    check('pending/approve 409 带 status', a.json?.status === 409, JSON.stringify(a.json)?.slice(0, 120));
    const b = await post('/api/action/memory/pending/reject', { id: 'mp1x2y3z4' });
    check('pending/reject 无 confirm → 409', b.status === 409, `got ${b.status}`);
    check('没 confirm 时两个都没打到插件', fake.hits === before, `hits ${before}→${fake.hits}`);

    // 带 confirm：转发时自动补 confirm:true（前端不必自己拼）
    const c = await post('/api/action/memory/pending/approve', { id: 'mp1x2y3z4', confirm: true });
    check('pending/approve 带 confirm → 200', c.status === 200, `got ${c.status}`);
    check('approve 转发补上 confirm:true', fake.received?.confirm === true, JSON.stringify(fake.received));
    check('approve 只传 id + confirm', Object.keys(fake.received || {}).sort().join(',') === 'confirm,id', JSON.stringify(fake.received));
    check('approve 透传 entry', c.json?.data?.entry?.id === 'mmnewone', JSON.stringify(c.json?.data));

    const d = await post('/api/action/memory/pending/reject', { id: 'mp1x2y3z4', confirm: true });
    check('pending/reject 带 confirm → 200', d.status === 200, `got ${d.status}`);
    check('reject 转发补上 confirm:true', fake.received?.confirm === true, JSON.stringify(fake.received));
    check('reject 透传 removed:true', d.json?.data?.removed === true, JSON.stringify(d.json?.data));
    check('reject 透传 pending 计数', d.json?.data?.pending === 1, JSON.stringify(d.json?.data));

    // id 校验：三种坏输入都在本地拦下
    const before2 = fake.hits;
    const e1 = await post('/api/action/memory/pending/approve', { confirm: true });
    check('pending/approve 缺 id → 400', e1.status === 400, `got ${e1.status}`);
    const e2 = await post('/api/action/memory/pending/approve', { id: '   ', confirm: true });
    check('pending/approve 空白 id → 400', e2.status === 400, `got ${e2.status}`);
    const e3 = await post('/api/action/memory/pending/approve', { id: 123, confirm: true });
    check('pending/approve 非字符串 id → 400', e3.status === 400, `got ${e3.status}`);
    const e4 = await post('/api/action/memory/pending/reject', { id: 'a'.repeat(129), confirm: true });
    check('pending/reject id>128 → 400', e4.status === 400, `got ${e4.status}`);
    const e5 = await post('/api/action/memory/pending/reject', { id: 'a\nb', confirm: true });
    check('pending/reject id 含控制字符 → 400', e5.status === 400, `got ${e5.status}`);
    check('id 校验失败都没打到插件', fake.hits === before2, `hits ${before2}→${fake.hits}`);

    // 插件 404 原样透传
    const save = fake.mode;
    fake.mode = 'notfound';
    const f1 = await post('/api/action/memory/pending/approve', { id: 'mp1x2y3z4', confirm: true });
    check('插件 404 原样透 404', f1.status === 404, `got ${f1.status}`);
    check('404 带插件 error', typeof f1.json?.error === 'string' && f1.json.error.includes('没有这条'), JSON.stringify(f1.json));
    fake.mode = save;
  }

  // ── 2. 破坏性动作必须 confirm ────────────────────────────────────────────
  console.log('\n[2] 破坏性动作无 confirm → 409');
  {
    const before = fake.hits;
    const a = await post('/api/action/memory/delete', { id: 'mmvc3yjucwige' });
    check('memory/delete 无 confirm → 409', a.status === 409, `got ${a.status}`);
    check('memory/delete 409 带 error', typeof a.json?.error === 'string' && a.json.error.length > 0);
    const b = await post('/api/action/stickers/delete', { file: 'a_b.jpg' });
    check('stickers/delete 无 confirm → 409', b.status === 409, `got ${b.status}`);
    check('没 confirm 时没打到插件', fake.hits === before, `hits ${before}→${fake.hits}`);

    const c = await post('/api/action/memory/delete', { id: 'mmvc3yjucwige', confirm: true });
    check('memory/delete 带 confirm 放行', c.status === 200, `got ${c.status}`);
    const d = await post('/api/action/stickers/delete', { file: 'a_b.jpg', confirm: true });
    check('stickers/delete 带 confirm 放行', d.status === 200, `got ${d.status}`);
  }

  // ── 3. 参数校验（本地拦，不打插件）───────────────────────────────────────
  console.log('\n[3] 本地参数校验');
  {
    const before = fake.hits;
    const a = await post('/api/action/memory/add', { kind: 'fact' });
    check('memory/add 缺 text → 400', a.status === 400, `got ${a.status}`);
    const b = await post('/api/action/memory/add', { text: '   ' });
    check('memory/add 空白 text → 400', b.status === 400, `got ${b.status}`);
    const c = await post('/api/action/memory/add', { text: 'x'.repeat(201) });
    check('memory/add text>200 → 400', c.status === 400, `got ${c.status}`);
    const d = await post('/api/action/memory/add', { text: 'ok', weight: 9 });
    check('memory/add weight=9 → 400', d.status === 400, `got ${d.status}`);
    const e = await post('/api/action/stickers/add', { keywords: ['a'] });
    check('stickers/add 缺 dataBase64 → 400', e.status === 400, `got ${e.status}`);
    const f = await post('/api/action/stickers/add', { dataBase64: 'AAAA' });
    check('stickers/add 缺 keywords → 400', f.status === 400, `got ${f.status}`);
    const g = await post('/api/action/memory/update', { id: 'x' });
    check('memory/update 不给任何字段 → 400', g.status === 400, `got ${g.status}`);
    const h = await post('/api/action/memory/update', {});
    check('memory/update 缺 id → 400', h.status === 400, `got ${h.status}`);
    const i = await post('/api/action/stickers/update', { file: '../../memory/memory.json', keywords: ['a'] });
    check('stickers/update 路径穿越 → 400', i.status === 400, `got ${i.status}`);
    const j = await post('/api/action/stickers/delete', { file: '../x.jpg', confirm: true });
    check('stickers/delete 路径穿越 → 400', j.status === 400, `got ${j.status}`);
    check('校验失败都没打到插件', fake.hits === before, `hits ${before}→${fake.hits}`);

    // 回归：必须按码点数（与插件 charLen 一致），不能按 UTF-16 length。
    // 下面是 200 个 emoji，s.length 会是 400，用 s.length 判就会误拒。
    // 放在 hits 断言之后：下面第 1 条是「成功」路径，会打到插件。
    const emoji200 = '😀'.repeat(200);
    const k = await post('/api/action/memory/add', { text: emoji200 });
    check('memory/add 200 个 emoji（码点 200）→ 放行', k.status === 200, `got ${k.status}（若 400 说明又按 UTF-16 length 算了）`);
    const emoji201 = '😀'.repeat(201);
    const l = await post('/api/action/memory/add', { text: emoji201 });
    check('memory/add 201 个 emoji（码点 201）→ 400', l.status === 400, `got ${l.status}`);
  }

  // ── 4. 成功透传：插件响应原样进 data ────────────────────────────────────
  console.log('\n[4] 成功透传');
  fake.mode = 'ok';
  {
    const r = await post('/api/action/memory/list', {});
    check('memory/list → 200', r.status === 200, `got ${r.status}`);
    check('memory/list ok=true', r.json?.ok === true);
    check('memory/list data.count = 78', r.json?.data?.count === 78, `got ${r.json?.data?.count}`);
    check('memory/list data.entries 是数组', Array.isArray(r.json?.data?.entries));
    check('memory/list 带 durationMs', typeof r.json?.durationMs === 'number');
    check('memory/list 打到 GET', fake.lastMethod === 'GET', `got ${fake.lastMethod}`);
    check('memory/list 走对路径', fake.lastPath === '/dsh-qq-whale/memory/list', `got ${fake.lastPath}`);

    const s = await post('/api/action/stickers/list', {});
    check('stickers/list → 200', s.status === 200, `got ${s.status}`);
    check('stickers/list data.count = 15', s.json?.data?.count === 15);
    check('stickers/list keywords 保留', Array.isArray(s.json?.data?.items?.[0]?.keywords));

    const a = await post('/api/action/memory/add', { kind: 'work', who: '主人', text: '测试一条', weight: 4 });
    check('memory/add → 200', a.status === 200, `got ${a.status}`);
    check('memory/add payload 完整透传', fake.received?.text === '测试一条' && fake.received?.kind === 'work' && fake.received?.weight === 4,
      JSON.stringify(fake.received));

    const u = await post('/api/action/memory/update', { id: 'new1', text: '改过' });
    check('memory/update 只传给的字段', u.status === 200 && fake.received?.id === 'new1' && fake.received?.text === '改过'
      && !('kind' in (fake.received || {})), JSON.stringify(fake.received));

    // 关键词字符串 → 数组
    const k = await post('/api/action/stickers/update', { file: 'a_b.jpg', keywords: '猫, 狗 鸭' });
    check('keywords 字符串被拆成数组', Array.isArray(fake.received?.keywords) && fake.received.keywords.length === 3,
      JSON.stringify(fake.received?.keywords));
    check('keywords 去空白', fake.received?.keywords?.join('|') === '猫|狗|鸭');
  }

  // ── 5. 上游错误状态原样透传 ──────────────────────────────────────────────
  console.log('\n[5] 上游错误透传');
  {
    fake.mode = 'notfound';
    const a = await post('/api/action/memory/update', { id: 'nope', text: 'x' });
    check('插件 404 → 代理 404', a.status === 404, `got ${a.status}`);
    check('404 带插件原文', a.json?.error === '没有这条记忆', `got ${JSON.stringify(a.json?.error)}`);
    check('失败体 ok=false', a.json?.ok === false);
    check('失败体带 status', a.json?.status === 404, `got ${a.json?.status}`);

    fake.mode = 'conflict';
    const b = await post('/api/action/stickers/update', { file: 'a.jpg', keywords: ['x'] });
    check('插件 409 → 代理 409', b.status === 409, `got ${b.status}`);

    fake.mode = 'bad';
    const c = await post('/api/action/memory/add', { text: 'ok' });
    check('插件 400 → 代理 400', c.status === 400, `got ${c.status}`);

    fake.mode = 'bizfail';
    const d = await post('/api/action/memory/add', { text: 'ok' });
    check('插件 200 但 ok:false → 不算成功', d.json?.ok === false, JSON.stringify(d.json));
    check('插件 200 但 ok:false → 带 error', d.json?.error === '插件内部业务失败');

    fake.mode = 'ok';
  }

  // ── 6. 体积上限 12MB ────────────────────────────────────────────────────
  console.log('\n[6] 请求体 12MB 上限');
  {
    // 12MB + 一点，用 content-length 提前拒
    const big = 'A'.repeat(12 * 1024 * 1024 + 1024);
    const r = await fetch(`http://127.0.0.1:${PORT_CONSOLE}/api/action/stickers/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataBase64: big, keywords: ['x'] }),
      signal: AbortSignal.timeout(60_000),
    }).catch((e) => ({ status: 0, err: e }));
    check('超 12MB → 413', r.status === 413, `got ${r.status} ${r.err || ''}`);

    // 边界：略小于 12MB 应当能进（这里只验不被 413 拦，假插件那边正常回）
    const okBody = Buffer.alloc(11 * 1024 * 1024, 0x41).toString('utf8');
    const r2 = await fetch(`http://127.0.0.1:${PORT_CONSOLE}/api/action/stickers/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dataBase64: okBody, keywords: ['x'] }),
      signal: AbortSignal.timeout(60_000),
    }).catch((e) => ({ status: 0, err: e }));
    check('11MB 不被 413 拦', r2.status !== 413, `got ${r2.status} ${r2.err || ''}`);
  }

  // ── 7. 非法 JSON ────────────────────────────────────────────────────────
  console.log('\n[7] 非法 JSON');
  {
    const r = await fetch(`http://127.0.0.1:${PORT_CONSOLE}/api/action/memory/add`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{这不是 json',
    });
    check('非法 JSON → 400', r.status === 400, `got ${r.status}`);
  }

  // ── 8. 只读接口没被破坏 ──────────────────────────────────────────────────
  console.log('\n[8] 既有只读接口仍在');
  {
    const r = await fetch(`http://127.0.0.1:${PORT_CONSOLE}/api/health`);
    check('/api/health → 200', r.status === 200, `got ${r.status}`);
    const r2 = await fetch(`http://127.0.0.1:${PORT_CONSOLE}/api/memory`);
    check('/api/memory → 200', r2.status === 200, `got ${r2.status}`);
    const r3 = await fetch(`http://127.0.0.1:${PORT_CONSOLE}/api/stickers`);
    check('/api/stickers → 200', r3.status === 200, `got ${r3.status}`);
  }

  // ── 9. GET 打动作接口应当 405 ───────────────────────────────────────────
  console.log('\n[9] 动作接口只收 POST');
  {
    const r = await fetch(`http://127.0.0.1:${PORT_CONSOLE}/api/action/memory/list`);
    check('GET /api/action/* → 405', r.status === 405, `got ${r.status}`);
  }

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`通过 ${pass} 条，失败 ${fail} 条`);
  if (fail) {
    console.log('失败项：');
    for (const f of failures) console.log('  - ' + f);
  }
  cleanup();
  fakeServer.close();
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('单测崩了：', e);
  cleanup();
  fakeServer.close();
  process.exit(1);
});
