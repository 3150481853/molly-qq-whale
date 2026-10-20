#!/usr/bin/env node
/**
 * console-server.mjs —— Molly 控制台服务端（127.0.0.1:19392）
 *
 * 规格：qq-whale/docs/console-contract.md（唯一事实来源，本文件严格按它实现）
 *
 * 设计要点：
 *  - 只用 Node 内置模块，零依赖，不用 shell:true（中文路径 + 空格会炸）。
 *  - 只监听 127.0.0.1，不对外暴露。
 *  - 宿主端口（DSH 的 /dsh-qq-whale/*）**不写死 7053**：先试 7053，再从 netstat 的
 *    LISTEN 列表里挑 7000-9000 的端口，逐个 GET /dsh-qq-whale/state 探到 200 为止。
 *  - 任何上游挂掉，/api/overview 仍返回 200，对应块 reachable:false。
 *  - 所有 spawn 带超时，超时 kill（Windows 下用 taskkill /T 连子进程一起杀）。
 *  - 日志只在启动和 5xx 打，前端 4 秒轮询不会把日志撑爆；日志里不打印 token/secret。
 *
 * 路径约定（两套根目录，别混）：
 *  - ROOT = qq-whale 工作目录（代码/静态页/out 日志都在这里）
 *  - DATA = ${HOME}\.dsh\qq-whale（运行时数据：memory/stickers/metrics/budget）
 */

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { isSea } from 'node:sea';

/*
 * ── 配置（三条来源，优先级从低到高）────────────────────────────────────────
 *   ① 下面的内置默认值          —— 在本机从源码跑时行为与以前完全一致
 *   ② console.json 配置文件     —— SEA 打包成 exe 后放在 exe 同级即可改配置，不用重新打包
 *   ③ 环境变量 MOLLY_*          —— 容器 / systemd / 临时排障时最高优先
 *
 * 为什么要这一层：molly-console.exe 要能拷到任意目录跑、也可能搬到服务器上（docs/deploy.md），
 * 不能再把工作区绝对路径写死在代码里。SEA 单文件模式下 exe 拿不到源码目录，
 * 只能用 process.execPath 的所在目录当地基。
 */
const IS_SEA = (() => {
  try {
    return isSea();
  } catch {
    return false;
  }
})();
const EXE_DIR = path.dirname(process.execPath);

// 配置文件位置：MOLLY_CONSOLE_CONFIG 指定优先，否则 <exe目录>/console.json；不存在就当空对象
const CONFIG_FILE = (() => {
  const explicit = String(process.env.MOLLY_CONSOLE_CONFIG || '').trim();
  return explicit ? path.resolve(explicit) : path.join(EXE_DIR, 'console.json');
})();
const FILE_CFG = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {}; // 没有文件 / 不是合法 JSON 都退回默认值，不阻断启动
  }
})();
// 按「环境变量 > 配置文件 > 默认值」取值；空字符串一律视为没设
const pick = (envKey, cfgKey, fallback) => {
  const e = String(process.env[envKey] ?? '').trim();
  if (e) return e;
  const c = FILE_CFG[cfgKey];
  if (c !== undefined && c !== null && String(c).trim() !== '') return String(c).trim();
  return fallback;
};

// 工作区根：源码模式仍是原来的 qq-whale 目录；exe 模式默认取 exe 所在目录（下面 CONSOLE_DIR 会再兜底）
const ROOT = pick('MOLLY_ROOT', 'root', 'G:\\Molly\\qq-whale');
const DATA = pick('MOLLY_DATA_DIR', 'dataDir', 'G:\\Molly\\data\\qq-whale');
// 前端产物：MOLLY_CONSOLE_DIR > console.json(consoleDir) > exe 同级 console/ > 工作区 console/
// SEA 模式下**不把静态资源打进 exe**，而是按目录查找，这样改前端不用重新打包。
const CONSOLE_DIR = pick(
  'MOLLY_CONSOLE_DIR',
  'consoleDir',
  IS_SEA ? path.join(EXE_DIR, 'console') : path.join(ROOT, 'console'),
);
const OUT = pick('MOLLY_OUT_DIR', 'outDir', path.join(ROOT, 'out')); // watchdog 日志/状态、二维码
const TOOLS = path.join(ROOT, 'tools');
// 监听地址：默认只听本机回环（默认值不变）；要对外网卡开放设 MOLLY_CONSOLE_HOST=0.0.0.0
const HOST = pick('MOLLY_CONSOLE_HOST', 'host', '127.0.0.1');
const PORT = Number(pick('MOLLY_CONSOLE_PORT', 'port', 19392)) || 19392;
const VERSION = '1.0.0';

// 鉴权：默认关闭（本机免鉴权，行为不变）。MOLLY_CONSOLE_TOKEN 有值才校验请求头
// x-molly-token —— 放请求头不放 query，避免密钥进访问日志（契约 §7.1.3）
const CONSOLE_TOKEN = String(pick('MOLLY_CONSOLE_TOKEN', 'token', '')).trim();

// ── 上游 base（全部可覆盖：以后把控制台搬到服务器时不用改代码，契约 §7.2）────
const stripSlash = (s) => String(s || '').trim().replace(/\/+$/, '');

// 数据服务（只读，已在跑，别动它）
const SIDECAR = stripSlash(pick('MOLLY_SIDECAR', 'sidecar', 'http://127.0.0.1:19391'));
// NapCat WebUI（需 JWT 鉴权，见契约 §6）
const NAPCAT = stripSlash(pick('MOLLY_NAPCAT', 'napcat', 'http://127.0.0.1:6099'));
// DSH 宿主插件接口。留空 = 运行时探测端口（宿主重启会换端口，见下方探测逻辑）；
// 设了就用设的、不再扫端口。两种写法都收：http://h:7053 或 http://h:7053/dsh-qq-whale
const PLUGIN_BASE = (() => {
  let s = stripSlash(pick('MOLLY_PLUGIN_BASE', 'pluginBase', ''));
  if (s.toLowerCase().endsWith('/dsh-qq-whale')) s = s.slice(0, -'/dsh-qq-whale'.length);
  return stripSlash(s);
})();

// 外部 node（仅本机动作如 watchdog/make-qr 用；部署到服务器后这些动作会如实报错，不影响只读接口）
const NODE_EXE = pick(
  'MOLLY_NODE_EXE',
  'nodeExe',
  'C:\\Users\\example\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe',
);
const PS_EXE = 'powershell.exe';

const WD_STATE = path.join(OUT, 'watchdog-state.json');
const WD_LOG = path.join(OUT, 'watchdog.log');
const WD_CONFIG = path.join(ROOT, 'watchdog-config.json');
const QR_PNG = path.join(OUT, 'console-qr.png');
// 端口被占时开独立窗口用的浏览器用户目录（与 tools\open-console-window.ps1 保持一致，
// 这样 exe 开的窗口和桌面快捷方式开的是同一个窗口，不会叠出第二个）。
const BROWSER_PROFILE = path.join(OUT, 'edge-console-profile');
const STICKER_DIR = path.join(DATA, 'stickers', '学来的'); // 表情包图片目录（与 panel-data.mjs 一致）
const TASK_NAME = 'Molly-Watchdog';                       // Windows 计划任务名
const LIVE = process.env.MOLLY_CONSOLE_LIVE === '1';      // 只有显式置 1 才真跑危险动作

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

// ── 小工具 ──────────────────────────────────────────────────────────────────
function readJson(file, dflt = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return dflt;
  }
}

function readTextSafe(file, maxBytes = 2 * 1024 * 1024) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return null;
    const fd = fs.openSync(file, 'r');
    try {
      // 只读尾部，避免日志很大时整读
      const start = Math.max(0, st.size - maxBytes);
      const len = st.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      return buf.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function sendJson(res, status, obj) {
  let body;
  try {
    body = Buffer.from(JSON.stringify(obj), 'utf8');
  } catch {
    body = Buffer.from('{"ok":false,"error":"encode error"}', 'utf8');
    status = 500;
  }
  res.writeHead(status, {
    ...CORS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendBuffer(res, status, buf, type, cache = 'no-store') {
  res.writeHead(status, {
    ...CORS,
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': cache,
  });
  res.end(buf);
}

const notFound = (res, error = 'not found') => sendJson(res, 404, { ok: false, error });

// 常量时间比较，避免用 token 长度/前缀差异做时序侧信道
function tokenOk(req) {
  const got = String(req.headers['x-molly-token'] || '');
  const a = Buffer.from(got, 'utf8');
  const b = Buffer.from(CONSOLE_TOKEN, 'utf8');
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ── 上游 GET（带超时，绝不抛）───────────────────────────────────────────────
async function jget(url, timeoutMs = 1500) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json' },
    });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const data = await r.json();
    return { ok: true, data };
  } catch (err) {
    const msg = err && err.name === 'TimeoutError' ? `超时 ${timeoutMs}ms` : `${(err && err.message) || err}`;
    return { ok: false, error: msg };
  }
}

// ── 宿主端口探测（不写死 7053；DSH 重启会换端口）───────────────────────────
// 前端 4 秒轮询，绝不能每次都遍历端口：结果（含"没探到"）统一缓存 30 秒。
const HOST_PROBE_TTL = 30_000;
const HOST_PROBE_TIMEOUT = 700;
let hostCache = { base: null, port: 0, at: 0 };
let hostProbing = null;

// 走 PowerShell 拿本机 LISTEN 端口（只用内置模块，不装依赖）
function listListenPorts() {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let ps;
    try {
      ps = spawn(
        PS_EXE,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
          'Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ' +
          'Select-Object -ExpandProperty LocalPort'],
        { windowsHide: true }
      );
    } catch {
      return finish([]);
    }
    const timer = setTimeout(() => {
      try { ps.kill(); } catch { /* ignore */ }
      finish([]);
    }, 4000);
    ps.stdout.on('data', (b) => { out += b.toString('utf8'); });
    ps.on('error', () => { clearTimeout(timer); finish([]); });
    ps.on('exit', (code) => {
      // 用 'exit' 而不是 'close'：stdout 被重定向到文件时 'close' 可能因管道未关而迟迟不来
      clearTimeout(timer);
      const ports = out
        .split(/\r?\n/)
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n >= 7000 && n <= 9000);
      finish([...new Set(ports)].sort((a, b) => a - b));
    });
  });
}

// 探一个端口是不是 DSH 宿主（要真的返回 /state 的 JSON，不是随便 200）
async function probeHost(port) {
  const r = await jget(`http://127.0.0.1:${port}/dsh-qq-whale/state`, HOST_PROBE_TIMEOUT);
  if (!r.ok) return null;
  const d = r.data;
  if (!d || typeof d !== 'object') return null;
  if (!d.link && d.enabled === undefined) return null; // 不是宿主
  return `http://127.0.0.1:${port}`;
}

async function discoverHostBase() {
  const tried = new Set();
  // 1) 先试上次探到的端口（宿主重启后多半还是它）
  if (hostCache.port) {
    tried.add(hostCache.port);
    const again = await probeHost(hostCache.port);
    if (again) return again;
  }
  // 2) 固定先试契约里的 7053
  if (!tried.has(7053)) {
    tried.add(7053);
    const direct = await probeHost(7053);
    if (direct) return direct;
  }
  // 3) 再遍历 7000-9000 的 LISTEN 端口（并发探，整体耗时≈单次超时）
  const ports = (await listListenPorts()).filter((p) => !tried.has(p));
  if (!ports.length) return null;
  const hits = await Promise.all(ports.map((p) => probeHost(p)));
  return hits.find(Boolean) || null;
}

async function resolveHostBase() {
  // 显式配了 MOLLY_PLUGIN_BASE 就用它，不再扫端口（部署到服务器时走这条）
  if (PLUGIN_BASE) return PLUGIN_BASE;
  if (Date.now() - hostCache.at < HOST_PROBE_TTL) return hostCache.base; // 30 秒内直接用缓存
  if (hostProbing) return hostProbing; // 4 秒轮询并发时只探一次
  hostProbing = (async () => {
    let base = null;
    try {
      base = await discoverHostBase();
    } catch {
      base = null;
    }
    hostCache = {
      base,
      port: base ? Number(base.slice(base.lastIndexOf(':') + 1)) : 0,
      at: Date.now(),
    };
    hostProbing = null;
    return base;
  })();
  return hostProbing;
}

// ── /api/overview 聚合（契约 §3.2：任何上游挂了都返回 200）───────────────────
async function buildOverview() {
  // build 让前端能判断自己跑的是不是最新前端文件（不一致就自动 reload）
  const out = { ok: true, at: Date.now(), build: consoleBuild() };

  // 1) 插件（DSH 宿主 /dsh-qq-whale/state）——端口后置位，先用 7053
  const pluginBase = await resolveHostBase();
  if (!pluginBase) {
    out.plugin = { reachable: false, error: '没探到 DSH 宿主端口（7000-9000）' };
  } else {
    const r = await jget(`${pluginBase}/dsh-qq-whale/state`, 1500);
    if (!r.ok) {
      out.plugin = { reachable: false, error: r.error, base: pluginBase };
    } else {
      const s = r.data || {};
      const m = s.model && typeof s.model === 'object' ? s.model : null;
      out.plugin = {
        reachable: true,
        enabled: s.enabled === true,
        link: { ready: !!(s.link && s.link.ready), state: (s.link && s.link.state) || 'unknown' },
        bot: s.bot ? { userId: s.bot.userId ?? null, nickname: s.bot.nickname ?? null } : null,
        model: m ? m.model || m.label || null : typeof s.model === 'string' ? s.model : null,
        metrics: s.metrics
          ? {
              messages: isNum(s.metrics.messages) ? s.metrics.messages : null,
              conversations: isNum(s.metrics.conversations) ? s.metrics.conversations : null,
              avgReplySeconds: isNum(s.metrics.avgReplySeconds) ? s.metrics.avgReplySeconds : null,
              lastReplyAt: s.metrics.lastReplyAt ?? null,
              lastReplyMs: isNum(s.metrics.lastReplyMs) ? s.metrics.lastReplyMs : null,
            }
          : null,
        memory: s.memory ? { count: isNum(s.memory.count) ? s.memory.count : null } : null,
        stickers: s.stickers
          ? {
              count: isNum(s.stickers.count) ? s.stickers.count : null,
              learned: isNum(s.stickers.learned) ? s.stickers.learned : null,
            }
          : null,
        budget: s.budget
          ? {
              enabled: s.budget.enabled === true,
              dailyCap: isNum(s.budget.dailyCap) ? s.budget.dailyCap : isNum(s.budget.cap) ? s.budget.cap : null,
              used: isNum(s.budget.used) ? s.budget.used : null,
              day: s.budget.day ?? s.budget.date ?? null,
            }
          : null,
        learner: s.learner
          ? {
              kept: isNum(s.learner.kept) ? s.learner.kept : null,
              rejected: isNum(s.learner.rejected) ? s.learner.rejected : null,
              dup: isNum(s.learner.dup) ? s.learner.dup : null,
              // 入库闸门计数（task-27 插件侧 learner.memory）。插件没上线这段时
              // 整个对象为 null —— 契约要求「拿不到就用 null」，绝不编造 0。
              // queued 与 pending 是两个数：pending 是「被拦了 N 次」，queued 才是
              // 待核实区**此刻真实有几条**（同一条 24h 内重复被拦会让 pending 涨而 queued 不变）。
              memory: s.learner.memory
                ? {
                    added: isNum(s.learner.memory.added) ? s.learner.memory.added : null,
                    rejected: isNum(s.learner.memory.rejected) ? s.learner.memory.rejected : null,
                    pending: isNum(s.learner.memory.pending) ? s.learner.memory.pending : null,
                    dup: isNum(s.learner.memory.dup) ? s.learner.memory.dup : null,
                    queued: isNum(s.learner.memory.queued) ? s.learner.memory.queued : null,
                  }
                : null,
            }
          : null,
        /*
         * 骂人模式（出气筒）总开关。字段来自插件的 pest 快照（task-36）。
         * 拿不到整块 null —— 控制台不能因为"猜一个 false"就显示成关着，
         * 那会让主人以为自己关掉了，实际还在骂。
         */
        pest: s.pest
          ? {
              enabled: s.pest.enabled === true,
              targets: Array.isArray(s.pest.targets) ? s.pest.targets.map(String) : [],
              dailyCap: isNum(s.pest.dailyCap) ? s.pest.dailyCap : null,
              todayUsed: isNum(s.pest.todayUsed ?? s.pest.used) ? (s.pest.todayUsed ?? s.pest.used) : null,
              stopWord: typeof s.pest.stopWord === 'string' ? s.pest.stopWord : '',
              stopWordSent: isNum(s.pest.stopSentAt) ? s.pest.stopSentAt > 0 : null,
              muted: s.pest.muted === true,
              mutedUntil: isNum(s.pest.mutedUntil) ? s.pest.mutedUntil : null,
              intervalMinutes: isNum(s.pest.intervalMinutes) ? s.pest.intervalMinutes : null,
              nextPickInMinutes: isNum(s.pest.nextPickInMinutes) ? s.pest.nextPickInMinutes : null,
            }
          : null,
        base: pluginBase,
      };
    }
  }

  // 2) 数据服务（19391，只读，别动它）
  const sd = await jget(`${SIDECAR}/api/all`, 1500);
  if (!sd.ok) {
    out.sidecar = { reachable: false, error: sd.error };
  } else {
    const d = sd.data || {};
    out.sidecar = { reachable: true, ...d };
  }

  // 3) NapCat WebUI（6099，需 JWT，见契约 §6；token/secret 绝不落日志）
  out.napcat = await buildNapcat();

  // 4) 守护（本地文件 + 计划任务状态）
  out.watchdog = await buildWatchdog();

  return out;
}

// ── NapCat：POST CheckLoginStatus（JWT 构造见契约 §6，不打印 token）─────────
function napcatBearer() {
  const SECRET = process.env.NAPCAT_WEBUI_JWT_SECRET_KEY || '${NAPCAT_JWT_SECRET}';
  const TOKEN = '${NAPCAT_TOKEN}';
  const hash = crypto.createHash('sha256').update(TOKEN + '.napcat').digest('hex');
  const data = { CreatedTime: Math.floor(Date.now() / 1000), HashEncoded: hash };
  const hmac = crypto.createHmac('sha256', SECRET).update(JSON.stringify(data), 'utf8').digest('hex');
  return Buffer.from(JSON.stringify({ Data: data, Hmac: hmac })).toString('base64');
}

async function buildNapcat() {
  try {
    const r = await fetch(`${NAPCAT}/api/QQLogin/CheckLoginStatus`, {
      method: 'POST',
      signal: AbortSignal.timeout(1500),
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${napcatBearer()}`,
      },
      body: '{}',
    });
    const j = await r.json().catch(() => null);
    const d = (j && j.data) || {};
    if (!j || j.code !== 0) {
      return { reachable: true, isLogin: false, error: (j && j.message) || `HTTP ${r.status}` };
    }
    return {
      reachable: true,
      isLogin: d.isLogin === true,
      loginPhase: d.loginPhase ?? null,
      coreReady: d.coreReady === true,
      uin: d.uin ? String(d.uin) : null,
      qrcodeurl: typeof d.qrcodeurl === 'string' ? d.qrcodeurl : '',
      loginError: typeof d.loginError === 'string' ? d.loginError : '',
    };
  } catch (err) {
    return { reachable: false, error: `${(err && err.message) || err}` };
  }
}

// ── 守护：状态/配置读文件，quiet 由配置算，taskEnabled 查计划任务 ───────────
function inQuietHours(cfg, at = new Date()) {
  const q = cfg && Array.isArray(cfg.quietHours) ? cfg.quietHours : null;
  if (!q || q.length !== 2) return false;
  const [from, to] = q;
  const h = at.getHours();
  if (!isNum(from) || !isNum(to)) return false;
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

// watchdog.log 每行形如 `2026-10-18 23:20:01 检查: online -> online phase=ready`
// 判定：含 FAIL / 退出码非 0 / 抢修失败 才算失败；正常巡检行算成功。
// （旧实现只要见到「检查」就返回 1，导致守护永远显示「上次失败」，已修）
function lastWatchdogLine(text) {
  if (!text) return { lastRun: null, lastResult: null };
  const lines = text.split(/\r?\n/).filter(Boolean);
  let line = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\s+/.test(lines[i])) { line = lines[i]; break; }
  }
  if (!line) return { lastRun: null, lastResult: null, tail: '' };
  const m = line.match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(.*)$/);
  const lastRun = m ? m[1] : null;
  const body = m ? m[2] : line;
  let lastResult;
  if (/\bNOTIFY_FAIL\b|失败|\bFAIL\b|退出码 [1-9]/.test(body)) lastResult = 1;
  else if (/^(检查|抢修|NOTIFY|风控静默期)/.test(body)) lastResult = 0;
  else lastResult = null;
  return { lastRun, lastResult, tail: line.slice(0, 400) };
}

async function buildWatchdog() {
  const state = readJson(WD_STATE, null);
  const raw = readJson(WD_CONFIG, null);
  // 配置里的 token 绝不能漏出去
  const config = raw
    ? {
        enabled: raw.enabled === true,
        intervalMinutes: isNum(raw.intervalMinutes) ? raw.intervalMinutes : null,
        quietHours: Array.isArray(raw.quietHours) ? raw.quietHours : null,
        repeatMinutes: isNum(raw.repeatMinutes) ? raw.repeatMinutes : null,
        autoRecover: raw.autoRecover === true,
        maxAutoRecoverAttempts: isNum(raw.maxAutoRecoverAttempts) ? raw.maxAutoRecoverAttempts : null,
        slowRecoverMinutes: isNum(raw.slowRecoverMinutes) ? raw.slowRecoverMinutes : null,
        settleMinutesAfterRecover: isNum(raw.settleMinutesAfterRecover) ? raw.settleMinutesAfterRecover : null,
        notifyOnRecover: raw.notifyOnRecover === true,
      }
    : null;

  const { lastRun, lastResult } = lastWatchdogLine(readTextSafe(WD_LOG, 256 * 1024));
  const taskEnabled = await queryTaskEnabled('Molly-Watchdog');

  return {
    reachable: !!(state || raw),
    state: state
      ? {
          lastState: state.lastState ?? null,
          lastOnlineAt: isNum(state.lastOnlineAt) ? state.lastOnlineAt : 0,
          offlineSince: isNum(state.offlineSince) ? state.offlineSince : 0,
          recoverAttempts: isNum(state.recoverAttempts) ? state.recoverAttempts : 0,
          consecutiveFails: isNum(state.consecutiveFails) ? state.consecutiveFails : 0,
          lastNotifyAt: isNum(state.lastNotifyAt) ? state.lastNotifyAt : 0,
          // 前端「距上次巡检」要用；之前漏传导致页面显示「—」
          lastCheckAt: isNum(state.lastCheckAt) ? state.lastCheckAt : 0,
        }
      : null,
    config,
    quiet: inQuietHours(config),
    taskEnabled,
    lastRun,
    lastResult,
  };
}

// 计划任务是否启用（查询失败返回 null，不要假装有值）
// 用 Get-ScheduledTask 而不是 schtasks：后者在中文系统输出 GBK，Node 读出来是乱码。
// 结果缓存 30 秒——4 秒轮询不该每次都 spawn 一个 PowerShell。
const TASK_CACHE_TTL = 30_000;
let taskCache = { value: null, at: 0 };
let taskProbing = null;

async function queryTaskEnabled(name) {
  if (Date.now() - taskCache.at < TASK_CACHE_TTL) return taskCache.value;
  if (taskProbing) return taskProbing;
  taskProbing = (async () => {
    const v = await probeTaskEnabled(name);
    taskCache = { value: v, at: Date.now() };
    taskProbing = null;
    return v;
  })();
  return taskProbing;
}

function probeTaskEnabled(name) {
  return new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    let ps;
    try {
      ps = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
        `$t = Get-ScheduledTask -TaskName ${name} -ErrorAction SilentlyContinue; ` +
        `if ($t) { [string]$t.State } else { 'MISSING' }`], { windowsHide: true });
    } catch {
      return finish(null);
    }
    const timer = setTimeout(() => {
      try { ps.kill(); } catch { /* ignore */ }
      finish(null);
    }, 4000);
    ps.stdout.on('data', (b) => { out += b.toString('utf8'); });
    ps.on('error', () => { clearTimeout(timer); finish(null); });
    ps.on('exit', () => {
      clearTimeout(timer);
      const v = out.trim().toLowerCase();
      if (!v || v === 'missing') return finish(null);
      if (v === 'disabled') return finish(false);
      if (v === 'ready' || v === 'running' || v === 'queued') return finish(true);
      return finish(null);
    });
  });
}

// ── 静态资源（契约 §2）──────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

// 静态路由白名单：只放这三个 + favicon，别的一律 404（防止任意文件读取）
const STATIC_ROUTES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/console.js': 'console.js',
  '/console.css': 'console.css',
};

// ── 前端构建标识（每次请求现算，绝不缓存死）─────────────────────────────────
// 为什么需要：浏览器里长期开着的控制台窗口不会因为前端文件更新而自动加载新代码，
// 每次改前端都得人工 Ctrl+F5，这个坑会反复复发。
// 做法：把 console.js/console.css 的 mtime+size 揉成 8 位短哈希 → 静态资源加 ?v=<build>、
// index.html 里注入 window.__MOLLY_BUILD__，前端轮询 /api/overview 时比对 build，
// 不一致就自动 reload 一次。任一文件缺失时返回 '0'（前端见到 '0' 不动作）。
function consoleBuild() {
  try {
    const parts = [];
    for (const rel of ['console.js', 'console.css']) {
      const st = fs.statSync(path.join(CONSOLE_DIR, rel));
      parts.push(`${rel}:${Math.round(st.mtimeMs)}:${st.size}`);
    }
    return crypto.createHash('sha1').update(parts.join('|'), 'utf8').digest('hex').slice(0, 8);
  } catch {
    return '0';
  }
}

function serveStatic(req, res, urlPath) {
  // favicon 不需要文件，直接 204
  if (urlPath === '/favicon.ico') {
    res.writeHead(204, CORS);
    return res.end();
  }

  // STATIC_ROUTES 只认精确路径，所以 ?v=<build> 这类查询串必须先剥掉再匹配
  let relPath = urlPath;
  try {
    relPath = new URL(urlPath || '/', 'http://x').pathname;
  } catch {
    relPath = urlPath;
  }

  const rel = STATIC_ROUTES[relPath];
  if (!rel) return notFound(res);

  const full = path.join(CONSOLE_DIR, rel);
  let buf;
  try {
    buf = fs.readFileSync(full);
  } catch {
    // 前端还没产出：503 + 明确提示（契约 §3 静态文件不存在 → 503）
    const msg =
      `控制台前端文件还没生成：${full}\n` +
      `请等 console-ui 产出 console/index.html、console.js、console.css 后刷新本页。\n` +
      `服务端（本进程）已就绪，接口可用：/api/health、/api/overview。`;
    if (rel.endsWith('.html')) {
      return sendBuffer(
        res,
        503,
        Buffer.from(
          `<!doctype html><meta charset="utf-8"><title>控制台前端未就绪</title>` +
            `<body style="font:14px/1.7 system-ui;padding:40px;color:#333">` +
            `<h2 style="margin:0 0 12px">控制台前端还没生成</h2>` +
            `<pre style="white-space:pre-wrap;background:#f7f6f3;border:1px solid #e5e3df;` +
            `border-radius:8px;padding:12px">${msg.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre>` +
            `</body>`,
          'utf8'
        ),
        'text/html; charset=utf-8',
        'no-store'
      );
    }
    return sendJson(res, 503, { ok: false, error: '前端文件还没生成', path: full });
  }

  // index.html：注入构建标识 + 给静态资源加 ?v=<build>（服务端改写，文件本身不动）
  let outBuf = buf;
  if (rel.endsWith('.html')) {
    const build = consoleBuild();
    let html = buf.toString('utf8');
    // 1) 老写法（index.html 目前就是 "href=\"/console.css\"" / "src=\"/console.js\""）
    html = html.replace('"/console.css"', `"/console.css?v=${build}"`);
    html = html.replace('"/console.js"', `"/console.js?v=${build}"`);
    // 2) 兜底：单引号/无引号等其它写法也补上（已带 ? 的不重复加，所以可重复执行）
    html = html.replace(/(["'])(\/console\.css)(?!\?)/g, `$1$2?v=${build}`);
    html = html.replace(/(["'])(\/console\.js)(?!\?)/g, `$1$2?v=${build}`);
    // 3) 注入 window.__MOLLY_BUILD__（必须在 console.js 之前跑，放 </head> 前最稳）
    const marker = `<script>window.__MOLLY_BUILD__="${build}";</script>`;
    if (html.includes('</head>')) html = html.replace('</head>', marker + '\n</head>');
    else if (html.includes('<head>')) html = html.replace('<head>', '<head>\n' + marker);
    else html = marker + '\n' + html;
    outBuf = Buffer.from(html, 'utf8');
  }

  const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
  // 静态资源一律 no-store：配合 ?v=<build>，彻底断掉浏览器缓存旧 console.js 的可能
  return sendBuffer(res, 200, outBuf, type, 'no-store');
}

// ── 启动三态的探针（task-31）────────────────────────────────────────────────
// 为什么「先探再 listen」而不是等 EADDRINUSE：Windows 的 EADDRINUSE 只有一个 errno，
// 拿不到占用者 pid，也分不清占用者是「我们自己的另一个实例」还是别人的程序。
// 先探就能在启动前给出可读、可执行的提示，而且整个过程零副作用（不 kill、不改文件）。
// 注意：这一段在模块顶层执行，早于下面 errText 的 const 初始化（TDZ），所以自带一个格式化函数。
const eText = (e) => (e && e.message ? e.message : String(e));

// 监听地址是通配地址（0.0.0.0 / ::）时，本机自探要走回环，不然某些系统上 connect 不出去。
const PROBE_HOST = (HOST === '0.0.0.0' || HOST === '::' || HOST === '') ? '127.0.0.1' : HOST;
const SELF_URL = `http://${PROBE_HOST}:${PORT}/`;

// 连一下看有没有人在听。连上=被占；拒绝/超时=空闲。
function portIsFree(port, host) {
  return new Promise((resolve) => {
    let done = false;
    const sock = net.createConnection({ host, port });
    const finish = (free) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(free);
    };
    sock.setTimeout(700);
    sock.once('connect', () => finish(false));
    sock.once('timeout', () => finish(true));
    sock.once('error', () => finish(true)); // ECONNREFUSED 等：没人监听
  });
}

// 是不是「我们自己的控制台」：契约判据 = 200 + ok:true + 有 version 字段。
// 三条缺一条都不认（比如别的程序也回 200 的 JSON，但没有 version）。
async function probeExistingConsole(port, host) {
  const r = await fetchJson(`http://${host}:${port}/api/health`, {}, 1500);
  if (!r || r.status !== 200 || !r.data || typeof r.data !== 'object') return null;
  const d = r.data;
  if (d.ok !== true) return null;
  if (typeof d.version !== 'string' || !d.version.trim()) return null;
  return d;
}

// 占端口的进程号：Windows 用 netstat -ano 解析（状态列 LISTENING 是 ASCII，不受系统语言影响）。
// 非 Windows 或解析失败一律返回 null —— 拿不到就不编造。
function portOwnerPid(port) {
  if (process.platform !== 'win32') return null;
  try {
    const r = spawnSync('netstat.exe', ['-ano', '-p', 'TCP'], {
      encoding: 'utf8', timeout: 4000, windowsHide: true,
    });
    const out = String((r && r.stdout) || '');
    for (const line of out.split(/\r?\n/)) {
      // 形如：  TCP    127.0.0.1:19392    0.0.0.0:0    LISTENING    37528
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (m && Number(m[1]) === Number(port)) return Number(m[2]);
    }
  } catch { /* ignore */ }
  return null;
}

// pid 对应的进程名（拿不到返回 null，只用于提示更好读）
function processNameOf(pid) {
  if (process.platform !== 'win32' || !pid) return null;
  try {
    const r = spawnSync('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
      encoding: 'utf8', timeout: 4000, windowsHide: true,
    });
    const line = String((r && r.stdout) || '').trim().split(/\r?\n/)[0] || '';
    if (!line || /^INFO:/i.test(line)) return null;
    const m = line.match(/^"([^"]+)"/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

// 找浏览器：顺序与 tools\open-console-window.ps1 一致（Edge 优先，其次 Chrome）
function findBrowser() {
  const dirs = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA]
    .filter(Boolean);
  const rels = [
    ['Microsoft', 'Edge', 'Application', 'msedge.exe'],
    ['Google', 'Chrome', 'Application', 'chrome.exe'],
  ];
  for (const rel of rels) {
    for (const d of dirs) {
      const p = path.join(d, ...rel);
      try {
        if (fs.existsSync(p)) return p;
      } catch { /* ignore */ }
    }
  }
  return null;
}

// 用 --app 开独立窗口。user-data-dir 与桌面快捷方式共用同一个 profile，
// 因此不会和用户日常浏览的窗口混在一起，也不会开出第二个「Molly 控制台」窗口。
//
// 踩过的坑：spawn 完立刻 process.exit 的话，新窗口**开不出来**。实测（node spawn msedge --app）：
//   立刻退出 → 新增窗口 0；等 1200ms 再退 → 新增窗口 1。
// 原因是 Edge 的启动器要先把真正的 browser 进程拉起来，父进程提前退出会让这条链路断掉。
// 所以 openAppWindow 之后调用方必须等 OPEN_SETTLE_MS 再退（见 handleOccupiedPort）。
const OPEN_SETTLE_MS = 1500;
function openAppWindow(url) {
  const browser = findBrowser();
  if (!browser) return { opened: false, reason: '没找到 Edge / Chrome' };
  try {
    fs.mkdirSync(BROWSER_PROFILE, { recursive: true });
  } catch { /* 建不建得出来都继续试 */ }
  const args = [
    `--app=${url}`,
    `--user-data-dir=${BROWSER_PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1120,900',
  ];
  try {
    // 不用 detached：detached 在 Windows 上会另给子进程配一个控制台窗口，
    // 而「不弹黑框」是硬约束。实测 detached 反而开不出窗口（见上面的对照实验）。
    const child = spawn(browser, args, { stdio: 'ignore', windowsHide: true });
    child.unref();
    return { opened: true, browser, pid: child.pid };
  } catch (err) {
    return { opened: false, browser, reason: eText(err) };
  }
}

// ── 启动 ────────────────────────────────────────────────────────────────────
// 命令行：--version / -v 只打印版本退出（打包成 exe 后用它确认文件没坏）；
// --help / -h 打印配置说明。正常启动时不消费任何参数。
const ARGV = process.argv.slice(2);
if (ARGV.includes('--version') || ARGV.includes('-v')) {
  console.log(`molly-console ${VERSION}${IS_SEA ? ' (sea)' : ''}`);
  console.log(`node ${process.version} / ${process.platform}-${process.arch}`);
  console.log(`exec ${process.execPath}`);
  console.log(`consoleDir ${CONSOLE_DIR}`);
  console.log(`config ${CONFIG_FILE}${fs.existsSync(CONFIG_FILE) ? '' : ' (不存在，用默认值)'}`);
  process.exit(0);
}
if (ARGV.includes('--help') || ARGV.includes('-h')) {
  console.log(`molly-console ${VERSION} —— Molly 控制台服务端

用法：
  molly-console.exe            按 console.json + 环境变量启动
  molly-console.exe --version  打印版本和生效路径
  molly-console.exe --help     本说明

配置文件（可选）：<exe 同级>\\console.json，键名见 console.example.json
环境变量（优先级最高）：
  MOLLY_CONSOLE_HOST / MOLLY_CONSOLE_PORT / MOLLY_CONSOLE_TOKEN
  MOLLY_CONSOLE_DIR  前端静态目录（默认 <exe同级>\\console）
  MOLLY_CONSOLE_CONFIG  配置文件路径（默认 <exe同级>\\console.json）
  MOLLY_PLUGIN_BASE / MOLLY_SIDECAR / MOLLY_NAPCAT
  MOLLY_ROOT / MOLLY_DATA_DIR / MOLLY_OUT_DIR  本机路径覆盖

当前生效：
  ${HOST}:${PORT}  前端=${CONSOLE_DIR}
  插件=${PLUGIN_BASE || '(运行时自动探测 7000-9000)'}  数据=${SIDECAR}  NapCat=${NAPCAT}`);
  process.exit(0);
}

// 启动自检：前端目录/入口文件缺失时打印清晰指引，而不是让用户看到白屏。
// 注意不 exit —— 接口（/api/health 等）仍可用，符合原「上游挂掉也要能诊断」的设计。
(function preflight() {
  const entry = path.join(CONSOLE_DIR, 'index.html');
  if (fs.existsSync(entry)) return;
  console.log('');
  console.log(`[console] ⚠ 找不到前端入口：${entry}`);
  console.log(`[console]   请把 console/ 目录（index.html、console.js、console.css）放到：`);
  console.log(`[console]      ${CONSOLE_DIR}`);
  console.log(`[console]   或用 MOLLY_CONSOLE_DIR / console.json 的 consoleDir 指向别处。`);
  console.log(`[console]   现在只有接口可用（/api/health、/api/overview），网页会 503。`);
  console.log('');
})();

const server = http.createServer((req, res) => {
  try {
    route(req, res).catch((err) => {
      console.log(`[console] 500 ${req.method} ${req.url}: ${err && err.stack ? err.stack : err}`);
      try {
        sendJson(res, 500, { ok: false, error: 'internal error' });
      } catch {
        try { res.destroy(); } catch { /* ignore */ }
      }
    });
  } catch (err) {
    console.log(`[console] 500 ${req.method} ${req.url}: ${err && err.stack ? err.stack : err}`);
    try { sendJson(res, 500, { ok: false, error: 'internal error' }); } catch { /* ignore */ }
  }
});

// 双击 exe 出问题时窗口会瞬间消失，用户什么都看不到。只有在真正连着交互式控制台时才停一下。
// 被 Start-Process 重定向 / 计划任务 / 管道拉起时 stdin 不是 TTY，这里立刻返回，不会挂住自动化。
function pauseIfInteractive(ms = 30000) {
  if (!process.stdin || !process.stdin.isTTY) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      try { process.stdin.pause(); } catch { /* ignore */ }
      resolve();
    };
    process.stdout.write('按回车键关闭窗口…');
    try {
      process.stdin.resume();
      process.stdin.once('data', fin);
      process.stdin.once('error', fin);
    } catch {
      fin();
    }
    setTimeout(fin, ms);
  });
}

// 端口已被占用时的判定与收尾：可能「已经在跑」也可能「被别的程序占了」。
// 两种情况都不碰占用者的进程，只决定退出码。
async function handleOccupiedPort() {
  const health = await probeExistingConsole(PORT, PROBE_HOST);
  if (health) {
    console.log(`控制台已经在运行：${SELF_URL}（本次不再启动，直接给你开窗口）`);
    const r = openAppWindow(SELF_URL);
    if (r.opened) {
      console.log(`[console] 已用 ${path.basename(r.browser)} 打开独立窗口（pid=${r.pid}）`);
      // 必须等窗口真正开出来再退：立刻退会让 Edge 这条启动链路断掉，窗口根本不出。
      // 实测 1200ms 够用，这里留 1500ms 富余；stdin 非 TTY 时没有额外等待，不影响自动化。
      await new Promise((resolve) => setTimeout(resolve, OPEN_SETTLE_MS));
    } else {
      console.log(`[console] 没能自动开窗（${r.reason}），请手动打开：${SELF_URL}`);
    }
    return 0;
  }

  const pid = portOwnerPid(PORT);
  const pname = pid ? processNameOf(pid) : null;
  console.log(`端口 ${PORT} 被别的程序占了（pid=${pid ?? '未知'}，见控制台）`);
  if (pname) console.log(`[console] 占用者进程：${pname}`);
  // 提示要能照做：exe 模式下 console.json 就在 exe 旁边；源码模式下 CONFIG_FILE 落在 node 目录里，
  // 指过去只会误导人，所以源码模式直接给环境变量 + MOLLY_CONSOLE_CONFIG 两条路。
  if (IS_SEA) {
    console.log(`[console] 换个端口：改 ${CONFIG_FILE} 的 port，或设环境变量 MOLLY_CONSOLE_PORT`);
  } else {
    console.log('[console] 换个端口：设环境变量 MOLLY_CONSOLE_PORT，'
      + '或用 MOLLY_CONSOLE_CONFIG 指向一个 {"port":新端口} 的 JSON 文件');
  }
  return 1;
}

server.on('error', async (err) => {
  if (err && err.code === 'EADDRINUSE') {
    // 探端口和 listen 之间被抢的竞态（概率极低）。走同一套判定，别一概 exit 0。
    const code = await handleOccupiedPort();
    await pauseIfInteractive();
    process.exit(code);
  }
  console.log(`[console] 启动失败：${err && err.message ? err.message : err}`);
  await pauseIfInteractive();
  process.exit(1);
});

// 启动三态：端口空闲 → 正常起；已被自己的控制台占 → 提示 + 开窗 + exit 0；被别人占 → 报 pid + exit 1。
(async function boot() {
  if (!(await portIsFree(PORT, PROBE_HOST))) {
    const code = await handleOccupiedPort();
    await pauseIfInteractive();
    process.exit(code);
  }
  server.listen(PORT, HOST, () => {
    console.log(`[console] 已启动 http://${HOST}:${PORT}  version=${VERSION}`);
    console.log(`[console] 前端目录 ${CONSOLE_DIR}`);
    console.log(`[console] 数据服务 ${SIDECAR}`);
  });
})();

// ── 路由分发（分步实现，见下方各段）─────────────────────────────────────────
async function route(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  // 鉴权：只有设了 MOLLY_CONSOLE_TOKEN 才校验（默认免鉴权，本机行为不变）
  if (CONSOLE_TOKEN && !tokenOk(req)) {
    return sendJson(res, 401, { ok: false, error: '缺少或错误的 x-molly-token' });
  }

  // 数据接口
  if (p === '/api/health') {
    return sendJson(res, 200, { ok: true, version: VERSION, build: consoleBuild(), at: Date.now() });
  }

  // 总览聚合（契约 §3.2）——上游全挂也必须 200
  if (p === '/api/overview') {
    return sendJson(res, 200, await buildOverview());
  }

  // 日志（契约 §3.3）
  if (p === '/api/logs') {
    const source = url.searchParams.get('source') || 'watchdog';
    const tail = Math.min(Math.max(Number(url.searchParams.get('tail')) || 200, 1), 2000);
    const r = await readLogTail(source, tail);
    return sendJson(res, 200, r);
  }

  // 记忆（契约 §3.4）—— 透传 sidecar，前端按 {groups:[{name,items:[{date,tag,text}]}]} 渲染
  if (p === '/api/memory') {
    const r = await jget(SIDECAR + '/api/memory', 5000);
    if (!r.ok) return sendJson(res, 200, { ok: false, reachable: false, count: 0, groups: [], error: r.error });
    return sendJson(res, 200, Object.assign({ ok: true, reachable: true }, r.data || {}));
  }

  // 表情包列表（契约 §3.5）—— 透传 sidecar，前端按 {count,items} 渲染
  if (p === '/api/stickers') {
    const r = await jget(SIDECAR + '/api/stickers', 5000);
    if (!r.ok) return sendJson(res, 200, { ok: false, reachable: false, count: 0, items: [], error: r.error });
    return sendJson(res, 200, Object.assign({ ok: true, reachable: true }, r.data || {}));
  }

  // 表情包原图（契约 §3.6）
  if (p.startsWith('/api/sticker/')) {
    return serveSticker(res, p.slice('/api/sticker/'.length));
  }

  // 动作执行（契约 §4.2）
  if (p.startsWith('/api/action/')) {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'use POST' });
    const name = decodeURIComponent(p.slice('/api/action/'.length));
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      // 413 时绝不回显请求体内容（里面可能是 base64 图片或记忆正文）
      if (err && err.code === 'BODY_TOO_LARGE') {
        return sendJson(res, 413, { ok: false, action: name, error: err.message });
      }
      return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON：' + errText(err) });
    }
    return runAction(res, name, body);
  }

  // 登录二维码原图（契约 §3.7）
  if (p === '/api/qr/latest.png') {
    return serveQr(res);
  }


  // 静态资源
  return serveStatic(req, res, p);
}

// ── 数据/动作接口实现（patch-console-server 注入）──
/* ─────────────────────────────────────────────────────────────────────────────
 * 以下由 patch-console-server.mjs 注入到 console-server.mjs 末尾。
 * 依赖前面的：SIDECAR / STICKER_DIR / OUT / PORT / TASK_NAME / LIVE / PS_EXE /
 *            NODE_EXE / CORS / sendJson / sendBuffer / jget / readJson /
 *            readTextSafe / resolveHostBase / napcatBearer / notFound
 * ───────────────────────────────────────────────────────────────────────────── */

const fsp = fs.promises;
const errText = (e) => (e && e.message ? e.message : String(e));

// ── 通用：带超时 fetch，绝不抛 ──────────────────────────────────────────────
async function fetchJson(url, opts = {}, ms = 15000) {
  try {
    const r = await fetch(url, {
      ...opts,
      signal: AbortSignal.timeout(ms),
      headers: { 'content-type': 'application/json', ...(opts.headers || {}) },
    });
    const txt = await r.text();
    let data = null;
    try {
      data = JSON.parse(txt);
    } catch {
      data = txt ? { raw: txt.slice(0, 4000) } : null;
    }
    return { ok: r.ok, status: r.status, data, text: txt };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: errText(err) };
  }
}

// ── 通用：读请求体（上限 12MB：表情包 base64 膨胀后约 10.7MB，留余量）────────
const MAX_BODY = 12 * 1024 * 1024;

// 超限用这个错误类型区分，好回 413 而不是 400
class BodyTooLarge extends Error {
  constructor(limit) {
    super(`请求体超过 ${Math.round(limit / 1024 / 1024)}MB 上限`);
    this.code = 'BODY_TOO_LARGE';
    this.limit = limit;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    // content-length 能提前判就直接拒，免得白读 12MB
    if (Number.isFinite(declared) && declared > MAX_BODY) {
      return reject(new BodyTooLarge(MAX_BODY));
    }
    const chunks = [];
    let total = 0;
    let done = false;
    const finish = (fn, v) => {
      if (done) return;
      done = true;
      fn(v);
    };
    req.on('data', (b) => {
      total += b.length;
      if (total > MAX_BODY) {
        finish(reject, new BodyTooLarge(MAX_BODY));
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
        return;
      }
      chunks.push(b);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return finish(resolve, {});
      try {
        finish(resolve, JSON.parse(raw));
      } catch (err) {
        finish(reject, new Error('不是合法 JSON'));
      }
    });
    req.on('error', (err) => finish(reject, err));
  });
}

// ── 跑 node 脚本（带超时、按行收集）──────────────────────────────────────────
function runNode(scriptPath, args = [], timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    if (!fs.existsSync(scriptPath)) {
      return resolve({ ok: false, error: `脚本不存在：${scriptPath}`, durationMs: 0 });
    }
    let child;
    try {
      child = spawn(NODE_EXE, [scriptPath, ...args], { windowsHide: true });
    } catch (err) {
      return resolve({ ok: false, error: `起不来进程：${errText(err)}`, durationMs: 0 });
    }
    let out = '';
    let errOut = '';
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...v, durationMs: Date.now() - t0 });
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish({ ok: false, error: `超过 ${Math.round(timeoutMs / 1000)} 秒没结束，已终止`, stdout: out.slice(-8000), stderr: errOut.slice(-2000) });
    }, timeoutMs);
    child.stdout?.on('data', (d) => {
      out += d.toString('utf8');
      if (out.length > 400_000) out = out.slice(-200_000);
    });
    child.stderr?.on('data', (d) => {
      errOut += d.toString('utf8');
      if (errOut.length > 200_000) errOut = errOut.slice(-100_000);
    });
    child.on('error', (err) => finish({ ok: false, error: errText(err) }));
    child.on('exit', (code) =>
      finish({ ok: code === 0, code, stdout: out.slice(-20000), stderr: errOut.slice(-8000) })
    );
  });
}

// ── 表情包图片：先问 sidecar 要 items 定位文件名，再回读本地字节 ─────────────
async function serveSticker(res, rawName) {
  let name;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return notFound(res, '文件名编码不对');
  }
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return notFound(res, '文件名不合法');
  }
  // 只允许契约 §3.6 的字符集
  if (!/^[A-Za-z0-9_\-.()\u4e00-\u9fa5]+$/.test(name)) {
    return notFound(res, '文件名不合法');
  }

  const ext = path.extname(name).slice(1).toLowerCase();
  const MIME_IMG = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
  };

  // 前端传的是 it.file（带扩展名）。万一没扩展名，补一个再试。
  const candidates = ext && MIME_IMG[ext] ? [name] : [name];
  for (const nm of candidates) {
    const e = path.extname(nm).slice(1).toLowerCase();
    if (!MIME_IMG[e]) continue;
    const full = path.resolve(STICKER_DIR, nm);
    if (!full.startsWith(path.resolve(STICKER_DIR) + path.sep)) continue;
    try {
      const buf = await fsp.readFile(full);
      return sendBuffer(res, 200, buf, MIME_IMG[e], 'public, max-age=3600');
    } catch {
      /* 继续下一个候选 */
    }
  }
  return notFound(res, '表情包图片不存在：' + name);
}

// ── 二维码：返回 out 目录里最新的那张登录二维码 ──────────────────────────────
async function serveQr(res) {
  const PREFERRED = ['console-qr.png', 'molly-login.png'];
  for (const nm of PREFERRED) {
    try {
      const buf = await fsp.readFile(path.join(OUT, nm));
      if (buf.length > 0) return sendBuffer(res, 200, buf, 'image/png', 'no-store');
    } catch {
      /* 下一个 */
    }
  }
  // 退路：扫 out 目录里所有 *login*.png / *qr*.png，取 mtime 最新的
  let best = null;
  try {
    for (const nm of await fsp.readdir(OUT)) {
      if (!/\.(png|jpg|jpeg)$/i.test(nm)) continue;
      if (!/login|qr/i.test(nm)) continue;
      const st = await fsp.stat(path.join(OUT, nm));
      if (!best || st.mtimeMs > best.mtimeMs) best = { nm, mtimeMs: st.mtimeMs };
    }
  } catch {
    /* ignore */
  }
  if (best) {
    const buf = await fsp.readFile(path.join(OUT, best.nm));
    const e = path.extname(best.nm).slice(1).toLowerCase();
    return sendBuffer(res, 200, buf, e === 'jpg' || e === 'jpeg' ? 'image/jpeg' : 'image/png', 'no-store');
  }
  return sendJson(res, 404, { ok: false, error: '还没有二维码，先点「生成二维码」' });
}

// ── 日志尾部（契约 §3.3）────────────────────────────────────────────────────
async function readLogTail(source, tail) {
  const MAP = {
    watchdog: path.join(OUT, 'watchdog.log'),
    console: path.join(OUT, 'console.log'),
    plugin: path.join(OUT, 'plugin.log'),
    napcat: path.join(OUT, 'napcat.log'),
  };
  const file = MAP[source] || MAP.watchdog;
  const txt = readTextSafe(file, 4 * 1024 * 1024);
  if (txt === null) {
    return { ok: true, source, path: file, lines: [], note: '该日志不存在' };
  }
  const lines = txt.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { ok: true, source, path: file, lines: lines.slice(-tail) };
}

// ── 动作表（契约 §4.2 的 14 个 + CRUD 8 个 = 22）──────────────────────────────
const DESTRUCTIVE = new Set([
  'napcat/restart',
  'watchdog/config',
  'watchdog/task',
  'process/start-napcat',
  'memory/delete',   // 删记忆不可恢复，契约 §3 要求 confirm
  'stickers/delete', // 删表情包会连哈希一起删，契约 §3 要求 confirm
  'memory/pending/approve', // 转正后立刻进正式库并参与召回，等于一次写入
  'memory/pending/reject',  // 丢弃后该条彻底消失，没有回收站
]);

const TOOLS_DIR = TOOLS;

// 关键词：数组或 "a,b c" 字符串都收（前端 chip 组件两种都可能给）
function normKeywords(v) {
  if (v == null) return null;
  // 分隔符与插件 cleanKeywords 保持一致（含中文分号和全角逗号顿号）
  const arr = Array.isArray(v) ? v : String(v).split(/[,，、;；\s]+/);
  return arr.map((x) => String(x).trim()).filter(Boolean);
}

/**
 * 按码点数字数，与插件 charLen（`[...s].length`）保持一致。
 * 用 s.length 会把 emoji 算成 2 个，导致 100~200 字含表情的记忆在代理层就被误拒。
 */
function charLen(s) {
  return [...String(s ?? '')].length;
}

/**
 * 待核实区条目 id 校验（task-28）。
 * 条目 id 形如 `mp1x2y3z4`，但插件侧实现可能换生成方式，所以这里不限制字符集，
 * 只挡住三类一定会出问题的输入：
 *   - 空 / 非字符串
 *   - 超长（128 码点）—— 防止有人拿它当超大 payload 撞插件
 *   - 控制字符（\x00-\x1f、\x7f）—— 含换行的 id 会污染插件日志
 * 返回 null 表示合法，否则返回错误话术。
 */
function badPendingId(v) {
  if (typeof v !== 'string') return 'id 必须是字符串';
  const id = v.trim();
  if (!id) return 'id 不能为空';
  if (charLen(id) > 128) return 'id 超过 128 字符';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(id)) return 'id 不能包含控制字符';
  return null;
}

/**
 * 透传插件接口（契约 §3）：校验在本地先做一遍，插件没上线也能给出人话错误。
 * 返回 { ok, data, status?, error? }；data 是插件原始响应，前端直接读。
 * 注意：这里绝不把 payload / 响应正文写进日志（base64、记忆正文都是敏感内容）。
 */
async function proxyPlugin(method, ep, payload, ms = 20_000) {
  const base = await resolveHostBase();
  if (!base) return { ok: false, status: 503, error: '没探到 DSH 宿主端口' };
  const url = base + '/dsh-qq-whale' + ep;
  const r =
    method === 'GET'
      ? await fetchJson(url, {}, ms)
      : await fetchJson(url, { method: 'POST', body: JSON.stringify(payload || {}) }, ms);
  const d = r.data;
  // 上游 HTTP 层失败：原样透传状态码（404 找不到 / 409 冲突 / 400 参数错都靠这个）
  if (!r.ok) {
    const msg = (d && (d.error || d.message)) || (r.status ? `HTTP ${r.status}` : r.error) || '插件请求失败';
    return { ok: false, status: r.status || 502, error: msg, data: d ?? null };
  }
  // 上游 200 但业务失败：按业务错误处理，状态码沿用插件给的（没给就当 400）
  if (d && d.ok === false) {
    return { ok: false, status: d.status || 400, error: d.error || '插件返回 ok:false', data: d };
  }
  return { ok: true, data: d ?? null };
}

/** 每个动作返回 { ok, data?, stdout?, stderr?, error?, status? } */
/**
 * 把一条控制台自己的操作日志追加到 out/console.log。
 *
 * 为什么不用 console.log：控制台进程的 stdout 由启动器重定向，真实文件位置
 * 取决于怎么启动的；骂人模式这种"主人点的开关"必须有一个固定位置能翻到。
 * 写失败只吞掉——日志写不进去不该让开关也失败。
 */
function appendConsoleLog(line) {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.appendFileSync(path.join(OUT, 'console.log'), `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

const ACTIONS = {
  'plugin/toggle': async (body) => {
    if (typeof body?.enabled !== 'boolean') return { ok: false, status: 400, error: 'enabled 必须是 boolean' };
    const base = await resolveHostBase();
    if (!base) return { ok: false, status: 503, error: '没探到 DSH 宿主端口' };
    const r = await fetchJson(base + '/dsh-qq-whale/toggle', {
      method: 'POST',
      body: JSON.stringify({ enabled: body.enabled }),
    });
    return { ...r, ok: r.ok && r.data?.ok !== false };
  },

  'plugin/recheck': async () => {
    const base = await resolveHostBase();
    if (!base) return { ok: false, status: 503, error: '没探到 DSH 宿主端口' };
    const r = await fetchJson(base + '/dsh-qq-whale/recheck', { method: 'POST', body: '{}' }, 30_000);
    return { ...r, ok: r.ok && r.data?.ok !== false };
  },

  'plugin/budget': async (body) => {
    const base = await resolveHostBase();
    if (!base) return { ok: false, status: 503, error: '没探到 DSH 宿主端口' };
    const payload = {};
    if (typeof body?.enabled === 'boolean') payload.enabled = body.enabled;
    if (Number.isFinite(Number(body?.cap)) && Number(body.cap) > 0) payload.cap = Number(body.cap);
    if (!Object.keys(payload).length) return { ok: false, status: 400, error: 'enabled 和 cap 至少要给一个' };
    const r = await fetchJson(base + '/dsh-qq-whale/budget', { method: 'POST', body: JSON.stringify(payload) });
    return { ...r, ok: r.ok && r.data?.ok !== false };
  },

  'plugin/work-probe': async () => {
    const base = await resolveHostBase();
    if (!base) return { ok: false, status: 503, error: '没探到 DSH 宿主端口' };
    const r = await fetchJson(base + '/dsh-qq-whale/work/probe', { method: 'POST', body: '{}' }, 60_000);
    return { ...r, ok: r.ok && r.data?.ok !== false };
  },

  'plugin/work-run': async (body) => {
    const task = String(body?.task || '').trim();
    if (!task) return { ok: false, status: 400, error: 'task 不能为空' };
    const base = await resolveHostBase();
    if (!base) return { ok: false, status: 503, error: '没探到 DSH 宿主端口' };
    const r = await fetchJson(base + '/dsh-qq-whale/work/run', {
      method: 'POST',
      body: JSON.stringify({ task, send: false }),
    }, 300_000);
    return { ...r, ok: r.ok && r.data?.ok !== false };
  },

  'plugin/research-test': async (body) => {
    const text = String(body?.text || '').trim();
    if (!text) return { ok: false, status: 400, error: 'text 不能为空' };
    const base = await resolveHostBase();
    if (!base) return { ok: false, status: 503, error: '没探到 DSH 宿主端口' };
    const r = await fetchJson(base + '/dsh-qq-whale/research/test', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }, 180_000);
    return { ...r, ok: r.ok && r.data?.ok !== false };
  },

  /*
   * 骂人模式（出气筒）总开关（task-36）。
   *
   * 两个动作分开而不是一个：status 是纯读（守护页每次轮询都要），set 才写。
   * set 不需要 confirm —— 它是可逆的（再点一下就开回来），而且"立即停"这件事
   * 如果需要二次确认，出事的时候人根本来不及点。
   */
  'pest/status': async () => {
    const base = await resolveHostBase();
    if (!base) return { ok: false, status: 503, error: '没探到 DSH 宿主端口' };
    const r = await fetchJson(base + '/dsh-qq-whale/pest', { method: 'GET' }, 5000);
    const okAll = r.ok && r.data?.ok !== false;
    const err = r.data?.error || `插件还没有 /pest 路由（HTTP ${r.status}）——重载插件后再试`;
    return { ...r, ok: okAll, error: okAll ? undefined : err };
  },

  'pest/set': async (body) => {
    if (typeof body?.enabled !== 'boolean') {
      return { ok: false, status: 400, error: 'enabled 必须是 boolean（true / false）' };
    }
    const payload = { enabled: body.enabled };
    if (body.targets !== undefined) payload.targets = body.targets;
    if (body.dailyCap !== undefined) payload.dailyCap = body.dailyCap;
    if (body.intervalMinutes !== undefined) payload.intervalMinutes = body.intervalMinutes;
    const base = await resolveHostBase();
    if (!base) return { ok: false, status: 503, error: '没探到 DSH 宿主端口' };
    const r = await fetchJson(
      base + '/dsh-qq-whale/pest',
      { method: 'POST', body: JSON.stringify(payload) },
      8000,
    );
    const st = r.data?.state || null;
    const okAll = r.ok && r.data?.ok !== false;
    const err = r.data?.error || `开关没生效（HTTP ${r.status}）——插件重载了吗？`;
    appendConsoleLog(
      `[pest] 控制台把骂人模式 → ${body.enabled ? '开' : '关'}` +
        (st
          ? `｜对象 ${(st.targets || []).join(',') || '（空）'}｜日额度 ${st.dailyCap}｜停止词 ${st.stopWord || '（无）'}`
          : '') +
        (okAll ? '' : `｜失败：${err}`),
    );
    return { ...r, ok: okAll, error: okAll ? undefined : err };
  },

  'napcat/qr': async () => {
    const r = await runNode(path.join(TOOLS_DIR, 'make-qr.mjs'), [path.join(OUT, 'console-qr.png')], 45_000);
    if (!r.ok) return { ok: false, error: r.error || '生成二维码失败', stdout: r.stdout };
    const out = r.stdout || '';
    if (out.includes('ALREADY_LOGIN')) {
      return { ok: true, stdout: out, data: { alreadyLogin: true, qr: null, url: null } };
    }
    const mUrl = out.match(/^URL\s+(\S+)$/m);
    return {
      ok: true,
      stdout: out,
      data: {
        alreadyLogin: false,
        png: '/api/qr/latest.png',
        url: mUrl ? mUrl[1] : null,
      },
    };
  },

  'napcat/restart': async () => {
    if (!LIVE) {
      return {
        ok: false,
        status: 409,
        error: '开发保护：真实重启会踢掉当前 QQ 登录。设 MOLLY_CONSOLE_LIVE=1 后重启控制台才允许执行。',
        data: { dryRun: true, would: 'start-molly.ps1 -Restart' },
      };
    }
    return runPowerShell(['-Restart'], 240_000);
  },

  'watchdog/status': async () => {
    const r = await runNode(path.join(TOOLS_DIR, 'watchdog.mjs'), ['--status'], 30_000);
    let data = null;
    try {
      data = JSON.parse((r.stdout || '').trim());
    } catch {
      data = null;
    }
    return {
      ok: Boolean(data),
      stdout: r.stdout,
      stderr: r.stderr,
      data,
      error: data ? undefined : r.error || 'watchdog --status 没有吐出可解析的 JSON',
    };
  },

  'watchdog/once': async () => {
    const r = await runNode(path.join(TOOLS_DIR, 'watchdog.mjs'), ['--once'], 120_000);
    return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, error: r.error };
  },

  'watchdog/test-notify': async () => {
    const r = await runNode(path.join(TOOLS_DIR, 'watchdog.mjs'), ['--test-notify'], 60_000);
    let data = null;
    try {
      data = JSON.parse((r.stdout || '').trim());
    } catch {
      data = null;
    }
    return { ok: r.ok, stdout: r.stdout, stderr: r.stderr, data, error: r.error };
  },

  'watchdog/config': async (body) => {
    const patch = body?.patch;
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      return { ok: false, status: 400, error: 'patch 必须是对象' };
    }
    const ALLOWED = [
      'enabled',
      'intervalMinutes',
      'quietHours',
      'repeatMinutes',
      'autoRecover',
      'maxAutoRecoverAttempts',
      'slowRecoverMinutes',
      'settleMinutesAfterRecover',
      'notifyOnRecover',
    ];
    const bad = Object.keys(patch).filter((k) => !ALLOWED.includes(k));
    if (bad.length) {
      return { ok: false, status: 400, error: '不允许改这些键：' + bad.join(', '), data: { allowed: ALLOWED } };
    }
    const cur = readJson(WD_CONFIG, null);
    if (!cur) return { ok: false, status: 500, error: '读不到 watchdog-config.json' };
    const next = { ...cur, ...patch };
    try {
      fs.writeFileSync(WD_CONFIG, JSON.stringify(next, null, 2) + '\n', 'utf8');
    } catch (err) {
      return { ok: false, status: 500, error: '写配置失败：' + errText(err) };
    }
    return { ok: true, data: { written: patch, file: WD_CONFIG } };
  },

  'watchdog/task': async (body) => {
    if (typeof body?.enable !== 'boolean') return { ok: false, status: 400, error: 'enable 必须是 boolean' };
    const flag = body.enable ? '/ENABLE' : '/DISABLE';
    const t0 = Date.now();
    const r = await new Promise((resolve) => {
      let out = '';
      let errOut = '';
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      };
      let child;
      try {
        child = spawn(PS_EXE, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
          `schtasks /Change /TN "${TASK_NAME}" ${flag}`], { windowsHide: true });
      } catch (err) {
        return resolve({ ok: false, error: errText(err) });
      }
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* ignore */ }
        done({ ok: false, error: 'schtasks 超时' });
      }, 20_000);
      child.stdout.on('data', (d) => { out += d.toString('utf8'); });
      child.stderr.on('data', (d) => { errOut += d.toString('utf8'); });
      child.on('error', (e) => done({ ok: false, error: errText(e) }));
      child.on('exit', (code) => done({ ok: code === 0, code, stdout: out, stderr: errOut }));
    });
    // 中文 Windows 上 schtasks 输出是 GBK，stdout 可能乱码；用 exit code 判定，回查一次真实状态
    const after = await probeTaskEnabled(TASK_NAME);
    return {
      ok: r.ok,
      stdout: r.stdout,
      stderr: r.stderr,
      error: r.ok ? undefined : 'schtasks 退出码 ' + (r.code ?? '?') + '（输出可能是 GBK 乱码，以 taskEnabled 为准）',
      data: { enable: body.enable, taskEnabled: after, durationMs: Date.now() - t0 },
    };
  },

  'process/start-napcat': async () => {
    if (!LIVE) {
      return {
        ok: false,
        status: 409,
        error: '开发保护：拉起 NapCat 可能和现有进程抢端口。设 MOLLY_CONSOLE_LIVE=1 后重启控制台才允许执行。',
        data: { dryRun: true, would: 'start-molly.ps1' },
      };
    }
    return runPowerShell([], 240_000);
  },

  // ── CRUD 8 条（契约 §3）：全部透传插件，代理层只做本地参数校验 ──────────────
  // 为什么不在代理层改盘：插件持有内存态，直改文件会被它下次 save() 覆写（契约 §0）

  'memory/list': async () => proxyPlugin('GET', '/memory/list', null, 15_000),

  'memory/add': async (body) => {
    const text = String(body?.text ?? '').trim();
    if (!text) return { ok: false, status: 400, error: 'text 不能为空' };
    if (charLen(text) > 200) return { ok: false, status: 400, error: 'text 最多 200 字' };
    const payload = { text };
    if (body?.kind !== undefined) payload.kind = String(body.kind);
    if (body?.who !== undefined) payload.who = String(body.who);
    if (body?.weight !== undefined && body.weight !== null) {
      const w = Number(body.weight);
      if (!Number.isInteger(w) || w < 1 || w > 5) return { ok: false, status: 400, error: 'weight 必须是 1-5 的整数' };
      payload.weight = w;
    }
    return proxyPlugin('POST', '/memory/add', payload);
  },

  'memory/update': async (body) => {
    const id = String(body?.id ?? '').trim();
    if (!id) return { ok: false, status: 400, error: 'id 不能为空' };
    const payload = { id };
    if (body?.text !== undefined) {
      const text = String(body.text).trim();
      if (!text) return { ok: false, status: 400, error: 'text 不能改成空' };
      if (charLen(text) > 200) return { ok: false, status: 400, error: 'text 最多 200 字' };
      payload.text = text;
    }
    if (body?.kind !== undefined) payload.kind = String(body.kind);
    if (body?.who !== undefined) payload.who = String(body.who);
    if (body?.weight !== undefined && body.weight !== null) {
      const w = Number(body.weight);
      if (!Number.isInteger(w) || w < 1 || w > 5) return { ok: false, status: 400, error: 'weight 必须是 1-5 的整数' };
      payload.weight = w;
    }
    // 至少要改一个字段，否则等于空跑
    if (Object.keys(payload).length === 1) {
      return { ok: false, status: 400, error: 'text/kind/who/weight 至少要给一个' };
    }
    return proxyPlugin('POST', '/memory/update', payload);
  },

  'memory/delete': async (body) => {
    const id = String(body?.id ?? '').trim();
    if (!id) return { ok: false, status: 400, error: 'id 不能为空' };
    return proxyPlugin('POST', '/memory/delete', { id });
  },

  'stickers/list': async () => proxyPlugin('GET', '/stickers/list', null, 15_000),

  'stickers/add': async (body) => {
    const raw = String(body?.dataBase64 ?? '').trim();
    if (!raw) return { ok: false, status: 400, error: 'dataBase64 不能为空' };
    const keywords = normKeywords(body?.keywords ?? body?.keyword);
    if (!keywords || !keywords.length) return { ok: false, status: 400, error: 'keywords 至少要给一个' };
    const payload = { dataBase64: raw, keywords };
    if (body?.filename !== undefined) payload.filename = String(body.filename);
    // 大图上传慢，给足 60 秒（插件那边还要算 sha256 + 重扫目录）
    return proxyPlugin('POST', '/stickers/add', payload, 60_000);
  },

  'stickers/update': async (body) => {
    const file = String(body?.file ?? '').trim();
    if (!file) return { ok: false, status: 400, error: 'file 不能为空' };
    if (file.includes('..')) return { ok: false, status: 400, error: 'file 不能包含 ..' };
    const keywords = normKeywords(body?.keywords ?? body?.keyword);
    if (!keywords || !keywords.length) return { ok: false, status: 400, error: 'keywords 至少要给一个' };
    return proxyPlugin('POST', '/stickers/update', { file, keywords });
  },

  'stickers/delete': async (body) => {
    const file = String(body?.file ?? '').trim();
    if (!file) return { ok: false, status: 400, error: 'file 不能为空' };
    if (file.includes('..')) return { ok: false, status: 400, error: 'file 不能包含 ..' };
    return proxyPlugin('POST', '/stickers/delete', { file });
  },

  // ── 待核实区（task-28，插件侧见 task-27）──────────────────────────────────
  // 拦下来的记忆不再直接丢弃，而是进 pending.json 等主人审批。
  // 代理层不做业务判断，只做 id 三级校验 + 原样透传（含插件的 404/409）。

  'memory/pending': async () => proxyPlugin('GET', '/memory/pending', null, 15_000),

  'memory/pending/approve': async (body) => {
    const bad = badPendingId(body?.id);
    if (bad) return { ok: false, status: 400, error: bad };
    // 转正后立刻进正式库并参与召回，等于一次写入 —— DESTRUCTIVE 已含此动作
    return proxyPlugin('POST', '/memory/pending/approve', { id: String(body.id).trim(), confirm: true });
  },

  'memory/pending/reject': async (body) => {
    const bad = badPendingId(body?.id);
    if (bad) return { ok: false, status: 400, error: bad };
    return proxyPlugin('POST', '/memory/pending/reject', { id: String(body.id).trim(), confirm: true });
  },
};

/** 跑 start-molly.ps1（可能很久，输出也大） */
async function runPowerShell(args, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const script = path.join(TOOLS_DIR, 'start-molly.ps1');
    if (!fs.existsSync(script)) return resolve({ ok: false, error: '脚本不存在：' + script, durationMs: 0 });
    let child;
    try {
      child = spawn(PS_EXE, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
        windowsHide: true,
      });
    } catch (err) {
      return resolve({ ok: false, error: errText(err), durationMs: 0 });
    }
    let out = '';
    let errOut = '';
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...v, durationMs: Date.now() - t0 });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      done({ ok: false, error: `超过 ${Math.round(timeoutMs / 1000)} 秒没结束，已终止` });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { errOut += d.toString('utf8'); });
    child.on('error', (e) => done({ ok: false, error: errText(e) }));
    child.on('exit', (code) => done({ ok: code === 0, code, stdout: out.slice(-20000), stderr: errOut.slice(-8000) }));
  });
}

/** 统一执行入口：校验 confirm → 跑 → 归一化响应 */
async function runAction(res, name, body) {
  const fn = ACTIONS[name];
  if (!fn) {
    return sendJson(res, 404, {
      ok: false,
      error: '未知动作：' + name,
      data: { available: Object.keys(ACTIONS) },
    });
  }
  if (DESTRUCTIVE.has(name) && body?.confirm !== true) {
    return sendJson(res, 409, { ok: false, action: name, status: 409, error: '这个动作需要 confirm:true 才执行' });
  }
  const t0 = Date.now();
  let out;
  try {
    out = await fn(body);
  } catch (err) {
    out = { ok: false, error: errText(err) };
  }
  const status = out.status || 200;
  const payload = {
    ok: out.ok === true,
    action: name,
    at: Date.now(),
    durationMs: out.durationMs ?? Date.now() - t0,
    data: out.data ?? null,
    stdout: typeof out.stdout === 'string' ? out.stdout.slice(-20000) : '',
    durationText: undefined,
  };
  if (out.stderr) payload.stderr = String(out.stderr).slice(-8000);
  if (out.error) payload.error = out.error;
  if (out.status && !payload.ok) {
    // 契约 §3：失败体统一带 status，前端不用去读 HTTP 层
    payload.status = out.status;
    if (!payload.error) payload.error = 'HTTP ' + out.status;
  }
  if (!payload.ok && !payload.error) payload.error = '动作失败';
  delete payload.durationText;
  return sendJson(res, status, payload);
}
