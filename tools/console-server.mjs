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
 *    LISTEN 列表里挑 1024-65535 的端口（原先是 7000-9000，DSH 桌面端重启后
 *    可能落到 2160 这类低位端口，故放宽），逐个 GET /dsh-qq-whale/state 探到 200 为止。
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
 *   ② console.json 配置文件     —— exe 模式放 exe 同级；源码模式放 console-server.mjs 同级
 *                                 （tools\console.json），改配置不用重新打包/改代码
 *   ③ 环境变量 MOLLY_*          —— 容器 / systemd / 临时排障时最高优先
 *
 * 为什么要这一层：molly-console.exe 要能拷到任意目录跑、也可能搬到服务器上（docs/deploy.md），
 * 不能再把工作区绝对路径写死在代码里。SEA 单文件模式下 exe 拿不到源码目录，
 * 只能用 process.execPath 的所在目录当地基；源码模式则用脚本自己的目录。
 */
const IS_SEA = (() => {
  try {
    return isSea();
  } catch {
    return false;
  }
})();
const EXE_DIR = path.dirname(process.execPath);
// 脚本自身目录（源码模式 = tools\）。不能用 ESM 的 importMeta.url：SEA 打包要求本文件
// 保持「零 importMeta 引用」才能机械转成 CJS（tools/build-exe.mjs 的 toCjs 会直接报错）。
// node tools\console-server.mjs 启动时 argv[1] 就是脚本路径，够用；SEA 下退回 EXE_DIR。
const HERE = (() => {
  try {
    const entry = process.argv?.[1];
    if (entry) {
      const p = path.resolve(entry);
      if (p.endsWith('.mjs') || p.endsWith('.js') || p.endsWith('.cjs')) return path.dirname(p);
    }
  } catch {
    /* ignore */
  }
  return EXE_DIR;
})();

// 配置文件位置：MOLLY_CONSOLE_CONFIG 指定优先；否则 exe 同级 / 脚本同级 console.json。
// 源码模式以前落在 <node.exe 目录>（C:\...\node\bin\console.json）——没人会去那儿放配置，
// 于是 tools\console.json 看着像生效其实没读（2026-10-21 切模型 403 的根因之一）。
const CONFIG_FILE = (() => {
  const explicit = String(process.env.MOLLY_CONSOLE_CONFIG || '').trim();
  if (explicit) return path.resolve(explicit);
  return path.join(IS_SEA ? EXE_DIR : HERE, 'console.json');
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
// 控制台版本：以插件 package.json 为唯一真源，别在这里写死（2026-10-25 主人 m03522：
// 左下角一直显示 v1.0.0 就是这一行写死的；发布版本与插件版本从此自动同步）。
// exe 模式读不到 package.json 时退回 FALLBACK_VERSION，保证打包版也有版本号。
const FALLBACK_VERSION = '1.1.5-preview.2';
const VERSION = (() => {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'plugin', 'dsh-qq-whale', 'package.json'), 'utf8'),
    );
    const v = String(pkg.version || '').trim();
    if (v) return v;
  } catch {
    /* 读不到就用兜底值，不阻断启动 */
  }
  return FALLBACK_VERSION;
})();

// 鉴权：默认关闭（本机免鉴权，行为不变）。MOLLY_CONSOLE_TOKEN 有值才校验请求头
// x-molly-token —— 放请求头不放 query，避免密钥进访问日志（契约 §7.1.3）
const CONSOLE_TOKEN = String(pick('MOLLY_CONSOLE_TOKEN', 'token', '')).trim();

// ── 上游 base（全部可覆盖：以后把控制台搬到服务器时不用改代码，契约 §7.2）────
const stripSlash = (s) => String(s || '').trim().replace(/\/+$/, '');

// 数据服务（只读，已在跑，别动它）
const SIDECAR = stripSlash(pick('MOLLY_SIDECAR', 'sidecar', 'http://127.0.0.1:19391'));
// NapCat WebUI（需 JWT 鉴权，见契约 §6）——2026-10-22 起仅作回滚后端展示
const NAPCAT = stripSlash(pick('MOLLY_NAPCAT', 'napcat', 'http://127.0.0.1:6099'));
// SnowLuma OneBot HTTP（P2 迁移后的主后端）。token 与 watchdog-config.json 的 snowluma.token 一致。
// 注意：token 只在服务端内存里用，绝不回显给前端、绝不写日志。
const SNOWLUMA = stripSlash(pick('MOLLY_SNOWLUMA', 'snowluma', 'http://127.0.0.1:3000'));
const SNOWLUMA_TOKEN = String(pick('MOLLY_SNOWLUMA_TOKEN', 'snowlumaToken', '${ONEBOT_TOKEN}')).trim();
const SNOWLUMA_WEBUI = stripSlash(pick('MOLLY_SNOWLUMA_WEBUI', 'snowlumaWebui', 'http://127.0.0.1:5099'));
// 强制后端：空 = 每次都读 watchdog-config.json 的 backend（默认 snowluma）
const FORCE_BACKEND = String(pick('MOLLY_BACKEND', 'backend', '')).trim();
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

// ── 外部服务（task-57：集成终端里的"外部服务类"动作）──────────────────────
// 网关是本地单进程（wb_proxy.py），面板密码默认 admin；**密码与 token 绝不进日志**。
const GATEWAY = stripSlash(pick('MOLLY_GATEWAY', 'gateway', 'http://127.0.0.1:8788'));
const GATEWAY_PASSWORD = pick('MOLLY_GATEWAY_PASSWORD', 'gatewayPassword', 'admin');
// 心跳：家里 PC 往服务器推状态。两个文件都由推送器维护，控制台只读。
const HB_STATE = path.join(OUT, 'heartbeat-state.json');
const HB_CONFIG = path.join(OUT, 'heartbeat-config.json');
// 切模型的 x-molly-admin 令牌（用户 m39817：「模型切换仅限控制台」）。
// 必须与插件配置 modelSwitchToken 一致；插件侧留空时写接口一律 403，这里也不编造。
// **绝不写日志、绝不回显** —— 前端只会看到"服务端还没配置切模型令牌"这类透传原文。
const MODEL_SWITCH_TOKEN = pick('MOLLY_MODEL_SWITCH_TOKEN', 'modelSwitchToken', '');

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

// 发 JSON 的 POST（宿主插件的写接口统一走这个）
async function jpost(url, body, timeoutMs = 6000) {
  try {
    const r = await fetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
    let data = null;
    try {
      data = await r.json();
    } catch {
      data = null;
    }
    if (!r.ok) return { ok: false, error: (data && data.error) || `HTTP ${r.status}`, data };
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
        .filter((n) => Number.isInteger(n) && n >= 1024 && n <= 65535);
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
  // 3) 再遍历 1024-65535 的 LISTEN 端口（并发探，整体耗时≈单次超时）
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
    out.plugin = { reachable: false, error: '没探到 DSH 宿主端口（1024-65535）' };
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
              learned: isNum(s.stickers.learned)
                ? s.stickers.learned
                : (isNum(s.learner && s.learner.total) ? s.learner.total : null),
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
              /* 累计 / 今日：插件 learner.total / learner.today 原样透出。
                 不在这里算「累计 = lifetime.kept」，免得两套口径对不上。 */
              total: isNum(s.learner.total) ? s.learner.total : null,
              today: s.learner.today && typeof s.learner.today === 'object'
                ? {
                    date: s.learner.today.date || null,
                    seen: isNum(s.learner.today.seen) ? s.learner.today.seen : null,
                    kept: isNum(s.learner.today.kept) ? s.learner.today.kept : null,
                    rejected: isNum(s.learner.today.rejected) ? s.learner.today.rejected : null,
                    dup: isNum(s.learner.today.dup) ? s.learner.today.dup : null,
                    skipped: isNum(s.learner.today.skipped) ? s.learner.today.skipped : null,
                  }
                : null,
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

      /* 群数：插件 /state 只报 bot 身份，群列表要去 SnowLuma 的 get_group_list 拿。
         拿不到就保持 null —— 前端显示「—」，绝不编造 0。 */
      if (out.plugin.bot) {
        try {
          const gl = await snowlumaAction('get_group_list', {}, 2000);
          const list = gl && gl.retcode === 0 && Array.isArray(gl.data) ? gl.data : null;
          if (list) out.plugin.bot.groupCount = list.length;
        } catch {
          /* 探测失败不拖累总览：这一项留空即可 */
        }
      }
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

  /* 记忆条数兜底：数据服务（19391）读的是 memory.md 明文，记忆加密后它读不到，
     count 会是空的。这里用插件侧 memory.count 补上，并标 source=plugin，
     只做展示、不落盘。 */
  if (out.plugin && out.plugin.memory && isNum(out.plugin.memory.count)) {
    if (!out.sidecar || typeof out.sidecar !== 'object') out.sidecar = { reachable: false };
    const sideCount = isNum(out.sidecar.memory && out.sidecar.memory.count)
      ? out.sidecar.memory.count
      : null;
    if (sideCount === null) {
      out.sidecar.memory = Object.assign({}, out.sidecar.memory || {}, {
        count: out.plugin.memory.count,
        source: 'plugin',
      });
    }
  }

  // 3) QQ 客户端探测（SnowLuma 走 OneBot HTTP 3000；回滚后端 NapCat 走 WebUI 6099。
  //    token/secret 绝不落日志）
  out.napcat = await buildNapcat();

  // 3.5) QQ 链路聚合（2026-10-25）：主依据 = 插件桥接，次依据 = QQ 客户端探测。
  //    out.napcat 原样保留做兼容；前端新逻辑优先读 out.qq。
  out.qq = await buildQqStatus(out.plugin, out.napcat);

  // 4) 守护（本地文件 + 计划任务状态）
  out.watchdog = await buildWatchdog();

  return out;
}

// ── 后端选择：watchdog-config.json 的 backend（默认 snowluma，可切回 napcat 回滚）──
function currentBackend() {
  if (FORCE_BACKEND === 'napcat' || FORCE_BACKEND === 'snowluma') return FORCE_BACKEND;
  const cfg = readJson(WD_CONFIG, null);
  return cfg && cfg.backend === 'napcat' ? 'napcat' : 'snowluma';
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

// ── SnowLuma：OneBot v11 HTTP 动作（token 只走请求头，永不回显）────────────
async function snowlumaAction(action, params = {}, timeoutMs = 2000) {
  const r = await fetch(`${SNOWLUMA}/${action}`, {
    method: 'POST',
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      'content-type': 'application/json',
      ...(SNOWLUMA_TOKEN ? { authorization: `Bearer ${SNOWLUMA_TOKEN}` } : {}),
    },
    body: JSON.stringify(params || {}),
  });
  const j = await r.json().catch(() => null);
  if (!j || typeof j.retcode !== 'number') throw new Error(`HTTP ${r.status}（OneBot 应答不可解析）`);
  return j;
}

/**
 * SnowLuma 状态探测（返回形状与 NapCat 版兼容，前端字段名不变）。
 * 三层：get_login_info（连通 + 账号）→ get_status.online（登录态）→ get_csrf_token（深度探测）。
 * 为什么要有深度探测：SnowLuma 也可能「假在线」——get_status 说 online 但服务端登录态
 * 已经作废（10-22 11:30 的 NapCat 事故同型）；get_csrf_token 需要服务端往返，能暴露出来。
 */
async function buildSnowluma() {
  const base = {
    reachable: false,
    backend: 'snowluma',
    webui: SNOWLUMA_WEBUI,
    uin: null,
    nickname: null,
    deepOk: null,
    onlineClients: [],
  };
  try {
    const li = await snowlumaAction('get_login_info');
    if (li.retcode !== 0) {
      return {
        ...base,
        reachable: true,
        isLogin: false,
        loginPhase: 'offline',
        coreReady: false,
        loginError: li.message || li.wording || `retcode ${li.retcode}`,
      };
    }
    const [st, csrf, clients] = await Promise.all([
      snowlumaAction('get_status').catch(() => null),
      snowlumaAction('get_csrf_token').catch(() => null),
      snowlumaAction('get_online_clients').catch(() => null),
    ]);
    const online = Boolean(st && st.retcode === 0 && st.data && st.data.online === true);
    const deepOk = Boolean(csrf && csrf.retcode === 0);
    // SnowLuma 把客户端列表包在 data.clients 里（NapCat 兼容接口历史上放在 data 直接成数组）
    const rawClients = clients && clients.retcode === 0 ? clients.data : null;
    const list = Array.isArray(rawClients)
      ? rawClients
      : (rawClients && Array.isArray(rawClients.clients) ? rawClients.clients : []);
    return {
      ...base,
      reachable: true,
      isLogin: online,
      loginPhase: online ? 'online' : 'offline',
      coreReady: online,
      uin: li.data && li.data.user_id ? String(li.data.user_id) : null,
      nickname: li.data && li.data.nickname ? String(li.data.nickname) : null,
      deepOk,
      onlineClients: list.slice(0, 5).map((c) => ({
        name: String((c && (c.device_name || c.app_name)) || ''),
        kind: String((c && (c.device_kind || c.app_name)) || ''),
      })),
      loginError: '',
    };
  } catch (err) {
    return { ...base, error: (err && err.message) || String(err) };
  }
}

async function buildNapcat() {
  if (currentBackend() === 'snowluma') return await buildSnowluma();
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
      return { reachable: true, backend: 'napcat', webui: null, isLogin: false, error: (j && j.message) || `HTTP ${r.status}` };
    }
    return {
      reachable: true,
      backend: 'napcat',
      webui: null,
      isLogin: d.isLogin === true,
      loginPhase: d.loginPhase ?? null,
      coreReady: d.coreReady === true,
      uin: d.uin ? String(d.uin) : null,
      qrcodeurl: typeof d.qrcodeurl === 'string' ? d.qrcodeurl : '',
      loginError: typeof d.loginError === 'string' ? d.loginError : '',
      nickname: null,
      deepOk: null,
      onlineClients: [],
    };
  } catch (err) {
    return { reachable: false, backend: 'napcat', webui: null, error: `${(err && err.message) || err}` };
  }
}

// ── QQ 链路聚合：主依据 = 插件桥接，次依据 = QQ 客户端探测 ───────────────────
/*
 * 2026-10-25 主人确认的判定优先级（部署者反馈：QQ 明明在跑，控制台却显示未连接）：
 *   - 插件 /state.link.state === 'online' ⇒ Molly 已经连上 OneBot，QQ 链路是通的。
 *   - QQ 客户端 WebUI 探测只回答「客户端进程在不在」，**不能**拿来判「未连接」。
 * 四种组合（level）：connected / bridge-only / client-only / offline；
 * 文案与「下一步」建议都放这里，前端只取，避免两处文案漂移。
 * 以前误报的原因：前端只有 napcat 块（客户端探测），拿它当主依据，
 * 客户端探测失败就直接显示未登录，把「插件已在线」这个更强的证据盖掉了。
 */

// 客户端探测缓存：4 秒轮询下不能每轮都等一次连接超时（不可达时尤其慢）。
const clientProbeCache = { key: '', at: 0, reachable: false };
const CLIENT_PROBE_TTL = 10_000;
const CLIENT_PROBE_TIMEOUT = 800;

async function probeClientWebui() {
  const backend = currentBackend();
  const url = backend === 'snowluma' ? SNOWLUMA_WEBUI : NAPCAT;
  const key = backend + '|' + url;
  if (clientProbeCache.key === key && Date.now() - clientProbeCache.at < CLIENT_PROBE_TTL) {
    return clientProbeCache.reachable;
  }
  let reachable = false;
  try {
    // 只要 HTTP 有应答就算进程活着：WebUI 要鉴权时 401/403 也算可达。
    const r = await fetch(url + '/', {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(CLIENT_PROBE_TIMEOUT),
    });
    reachable = Number(r.status) > 0;
  } catch {
    reachable = false;
  }
  clientProbeCache.key = key;
  clientProbeCache.at = Date.now();
  clientProbeCache.reachable = reachable;
  return reachable;
}

async function buildQqStatus(plugin, napcat) {
  const backend = currentBackend();
  const link = (plugin && plugin.link) || {};
  const bridgeState = link.state || 'unknown';
  const bridgeReady = link.ready === true;
  const bridgeOnline = bridgeReady && bridgeState === 'online';
  // 客户端进程的两种证据：WebUI 能应答，或 OneBot HTTP 已经回过话
  //（回过话说明 SnowLuma 进程活着，哪怕 QQ 还没登录）。任一成立都算「进程可达」。
  const webuiOk = await probeClientWebui();
  const clientReachable = webuiOk || !!(napcat && napcat.reachable === true);
  const clientLogin = !!(napcat && napcat.isLogin === true);
  const level = bridgeOnline
    ? (clientReachable ? 'connected' : 'bridge-only')
    : (clientReachable ? 'client-only' : 'offline');
  const text = {
    connected: 'Molly 已连接 QQ',
    'bridge-only': 'Molly 已连接 QQ（客户端状态信息不可用）',
    'client-only': 'QQ 在运行，但 Molly 还没连上',
    offline: 'QQ 未连接',
  }[level];
  const nextStep = {
    connected: '',
    'bridge-only': '链路已通，消息能正常收发就不用管；持续异常去「运维」看日志。',
    'client-only': '到「执行块」点「重新检查连接」；刚重启过 QQ 就等 10~25 秒再刷新，或去「守护」看 watchdog 结论。',
    offline: '点「重新登录 QQ（扫码）」（「QQ 连接」页，或总览页的提示条）。',
  }[level];
  return {
    level,
    text,
    nextStep,
    bridgeState,
    bridgeReady,
    bridgeOnline,
    clientReachable,
    clientLogin,
    backend,
    backendName: backend === 'snowluma' ? 'SnowLuma' : '回滚后端（NapCat）',
    webui: backend === 'snowluma' ? SNOWLUMA_WEBUI : NAPCAT,
    uin: (napcat && napcat.uin) || (plugin && plugin.bot && plugin.bot.userId) || null,
    nickname: (napcat && napcat.nickname) || (plugin && plugin.bot && plugin.bot.nickname) || null,
    // 语义：QQ 链路当前能不能用（桥接优先；客户端在线且已登录也算）
    isLogin: bridgeOnline || (clientReachable && clientLogin),
    napcat: napcat || null, // 旧字段原样带一份，兼容仍读 ov.qq.napcat 的调用方
    at: Date.now(),
  };
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

配置文件（可选）：exe 模式 <exe 同级>\\console.json；源码模式 tools\\console.json（脚本同级）
                  键名见 console.example.json；当前读：${CONFIG_FILE}
环境变量（优先级最高）：
  MOLLY_CONSOLE_HOST / MOLLY_CONSOLE_PORT / MOLLY_CONSOLE_TOKEN
  MOLLY_CONSOLE_DIR  前端静态目录（默认 <exe同级>\\console）
  MOLLY_CONSOLE_CONFIG  配置文件路径（覆盖上面两个默认位置）
  MOLLY_PLUGIN_BASE / MOLLY_SIDECAR / MOLLY_NAPCAT
  MOLLY_ROOT / MOLLY_DATA_DIR / MOLLY_OUT_DIR  本机路径覆盖

当前生效：
  ${HOST}:${PORT}  前端=${CONSOLE_DIR}
  插件=${PLUGIN_BASE || '(运行时自动探测 1024-65535)'}  数据=${SIDECAR}  NapCat=${NAPCAT}`);
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
  // 提示要能照做：两种模式现在都有明确的配置文件落点（exe 同级 / 脚本同级），直接给路径最省事。
  console.log(`[console] 换个端口：改 ${CONFIG_FILE} 的 port，或设环境变量 MOLLY_CONSOLE_PORT`);
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
    // 把「配置从哪读的、切模型能不能用」打出来：403 排查第一步就看这行（只报路径和有没有，不报令牌值）。
    console.log(
      `[console] 配置文件 ${CONFIG_FILE}${fs.existsSync(CONFIG_FILE) ? '' : '（不存在，走默认值/环境变量）'}；切模型令牌 ${MODEL_SWITCH_TOKEN ? '已配置' : '未配置（写接口会 403）'}`,
    );
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

  /*
   * 本次更新说明（2026-10-25，主人 m04452：「控制台上的版本更新一下，注释一下这次更新了什么」）。
   * 数据源就是仓库里的 docs/CHANGELOG.md——取最新一节（第一个 `## ` 标题到下一节之间），
   * 前端点左下角版本号时弹层展示，不额外维护一份文案。
   * 文件不存在也返回 200（打包版没带 docs 时前端只显示「版本号」）。
   */
  if (p === '/api/changelog') {
    const file = path.join(ROOT, 'docs', 'CHANGELOG.md');
    let text = '';
    let title = '';
    try {
      const md = fs.readFileSync(file, 'utf8');
      const start = md.search(/^## /m);
      if (start >= 0) {
        const rest = md.slice(start);
        const next = rest.slice(1).search(/^## /m);
        let section = (next >= 0 ? rest.slice(0, next + 1) : rest).trim();
        const sep = section.search(/^---$/m);
        if (sep > 0) section = section.slice(0, sep).trim();
        text = section.length > 8000 ? section.slice(0, 8000) + '\n…' : section;
        title = String((section.match(/^##\s+(.+)$/m) || [])[1] || '').trim();
      }
    } catch (err) {
      text = '';
      title = '';
    }
    return sendJson(res, 200, { ok: true, version: VERSION, title, text, file: 'docs/CHANGELOG.md' });
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

  // 发言开关（2026-10-22）—— 透传宿主插件 /dsh-qq-whale/switches*
  // GET  /api/plugin/switches                → 读全部状态（含审计/静音/生效值）
  // POST /api/plugin/switches/set            {path,value}
  // POST /api/plugin/switches/mute           {scope,minutes,note}
  // POST /api/plugin/switches/unmute         {scope}
  // POST /api/plugin/switches/reset          {}
  if (p === '/api/plugin/switches' || p.startsWith('/api/plugin/switches/')) {
    const base = await resolveHostBase();
    if (!base) return sendJson(res, 200, { ok: false, reachable: false, error: '宿主（DSH）没探到端口' });
    if (req.method === 'GET' && p === '/api/plugin/switches') {
      const r = await jget(base + '/dsh-qq-whale/switches', 6000);
      if (!r.ok) return sendJson(res, 200, { ok: false, reachable: false, error: r.error });
      return sendJson(res, 200, Object.assign({ ok: true, reachable: true }, r.data || {}));
    }
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'use POST' });
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      if (err && err.code === 'BODY_TOO_LARGE') {
        return sendJson(res, 413, { ok: false, error: err.message });
      }
      return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON：' + errText(err) });
    }
    const sub = p.slice('/api/plugin/switches'.length) || '/';
    if (!['/set', '/mute', '/unmute', '/reset'].includes(sub)) {
      return sendJson(res, 404, { ok: false, error: '未知的开关接口 ' + sub });
    }
    /* /set 对应插件侧 POST /switches（同一个接口，省得插件再开一个别名路由） */
    const targetPath = sub === '/set' ? '/dsh-qq-whale/switches' : ('/dsh-qq-whale/switches' + sub);
    const r = await jpost(base + targetPath, body, 6000);
    if (!r.ok) return sendJson(res, 200, { ok: false, reachable: true, error: r.error });
    return sendJson(res, 200, Object.assign({ ok: true }, r.data || {}));
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
    // 心跳推送器（tools\heartbeat-push.mjs）自己的日志。刚开始推的时候文件可能还不存在。
    heartbeat: path.join(OUT, 'heartbeat.log'),
    // SnowLuma 后端（2026-10-25 加）：扫码/重启失败时，这两个日志是第一现场。
    //  - snowluma-boot：tools\snowluma-start.ps1 的启动过程日志
    //  - snowluma-runtime：SnowLuma 进程自己的 stdout/err
    'snowluma-boot': path.join(OUT, 'snowluma-boot.log'),
    'snowluma-runtime': path.join(OUT, 'snowluma-runtime.out.log'),
  };
  const known = Object.prototype.hasOwnProperty.call(MAP, source);
  const file = known ? MAP[source] : MAP.watchdog;
  const txt = readTextSafe(file, 4 * 1024 * 1024);
  // 缺文件不是错误：心跳推送器可能还没跑过、插件日志可能还没写过。
  // 前端靠 exists 决定是显示空列表还是"这个日志还没生成"。
  if (txt === null) {
    return { ok: true, source, path: file, exists: false, lines: [], note: '该日志不存在' };
  }
  const lines = txt.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const out = {
    ok: true,
    source,
    path: file,
    exists: true,
    lines: lines.slice(-tail),
  };
  if (!known) {
    // 兼容老前端：source 写错时仍回 watchdog，但明确告诉调用方用的是哪个
    out.note = `未知 source「${source}」，已回退到 watchdog`;
    out.known = Object.keys(MAP);
  }
  return out;
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
  'molly/stop',     // 停 QQ + NapCat：会直接掉线，刚扫完码的话得重扫
  'molly/restart',  // 同上，而且中间有 3 秒空窗
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

// ── 外部服务辅助（task-57）──────────────────────────────────────────────────

/**
 * 网关面板登录 → token。
 *
 * 密码来自配置（`MOLLY_GATEWAY_PASSWORD` / console.json `gatewayPassword`，默认 admin）。
 * **token 与密码一律不进日志、不进返回值**：这个函数只在内部用，调用方只能拿到
 * `{ok, token}` 或 `{ok:false, error}`，而 error 里已把响应正文剥掉了。
 */
async function gatewayPanelToken() {
  const r = await fetchJson(
    GATEWAY + '/panel/login',
    { method: 'POST', body: JSON.stringify({ password: GATEWAY_PASSWORD }) },
    8000,
  );
  if (!r.ok) {
    // 只说状态码，不回显任何请求体（里面有密码）
    return { ok: false, error: `网关面板登录失败（HTTP ${r.status || '无响应'}）` };
  }
  const tk = r.data?.token;
  if (!tk || typeof tk !== 'string') {
    return { ok: false, error: '网关面板登录返回里没有 token' };
  }
  return { ok: true, token: tk, usingDefaultPassword: Boolean(r.data?.using_default_password) };
}

/** 应用侧推送器写的 state 文件；读不到就当还没推过 */
function readHeartbeatLocal() {
  const s = readJson(HB_STATE, null);
  if (!s) return null;
  return {
    lastAt: isNum(s.lastAt) ? s.lastAt : null,
    ok: Boolean(s.ok),
    lastStatus: isNum(s.lastStatus) ? s.lastStatus : null,
    fails: isNum(s.fails) ? s.fails : null,
    host: typeof s.host === 'string' ? s.host : null,
    relay: typeof s.relay === 'string' ? s.relay : null,
    lastLocal: typeof s.lastLocal === 'string' ? s.lastLocal : null,
  };
}

/**
 * 服务器侧状态。
 *
 * 约定：服务器 `GET <relayBase>/health` 返回 `{ok, level, stale, ageSeconds, lastReceivedAt}`。
 * 服务器不在（家里断网、服务器重启）时**不抛**，回 `{ok:false, error}` —— 调用方据此
 * 仍然给前端 200，让页面能显示"远端不可达"，而不是整页报错。
 */
async function fetchHeartbeatRemote(timeoutMs) {
  const cfg = readJson(HB_CONFIG, null);
  const relayBase = typeof cfg?.relayBase === 'string' ? cfg.relayBase.trim() : '';
  if (!relayBase) return { ok: false, error: '没有配置服务器地址（out/heartbeat-config.json 缺 relayBase）' };
  const base = relayBase.replace(/\/+$/, '');
  const r = await fetchJson(base + '/health', {}, Math.max(1000, Math.min(timeoutMs || 8000, 20000)));
  if (!r.ok) {
    return {
      ok: false,
      error: r.status ? `服务器返回 HTTP ${r.status}` : r.error || '服务器不可达',
      relayBase: base,
    };
  }
  const d = r.data || {};
  return {
    ok: true,
    relayBase: base,
    level: typeof d.level === 'string' ? d.level : null,
    stale: typeof d.stale === 'boolean' ? d.stale : null,
    ageSeconds: isNum(d.ageSeconds) ? d.ageSeconds : null,
    lastReceivedAt: isNum(d.lastReceivedAt) ? d.lastReceivedAt : null,
  };
}

/**
 * 列出某个进程名下的所有 pid（Windows 用 tasklist，别用 wmic —— 新版已移除）。
 * 返回 [{pid, name}]；拿不到就返回空数组，绝不抛。
 */
function listPidsByName(name) {
  const r = spawnSync('tasklist.exe', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    timeout: 8000,
    windowsHide: true,
  });
  const out = typeof r.stdout === 'string' ? r.stdout : '';
  const pids = [];
  for (const line of out.split(/\r?\n/)) {
    // 格式： "QQ.exe","1234","Console","1","120,000 K"
    const m = line.match(/^"([^"]+)","(\d+)"/);
    if (m && m[1].toLowerCase() === String(name).toLowerCase()) {
      pids.push({ pid: Number(m[2]), name: m[1] });
    }
  }
  return pids;
}

/** 要停的进程：只这两类。DSH 宿主、网关、控制台自己一概不碰。 */
const MOLLY_PROCESS_NAMES = ['QQ.exe', 'NapCatWinBootMain.exe'];

/**
 * 停 Molly（QQ + NapCat）。**不碰 DSH 宿主、不碰网关**（用户原话：只停这两个）。
 * 返回杀了哪些 pid，没找到的如实说"本来就没在跑"。
 */
function stopMollyProcesses() {
  const killed = [];
  const notRunning = [];
  const failed = [];
  for (const name of MOLLY_PROCESS_NAMES) {
    const list = listPidsByName(name);
    if (!list.length) {
      notRunning.push(name);
      continue;
    }
    for (const { pid } of list) {
      const r = spawnSync('taskkill.exe', ['/PID', String(pid), '/F'], {
        encoding: 'utf8',
        timeout: 10000,
        windowsHide: true,
      });
      if (r.status === 0) killed.push({ name, pid });
      else failed.push({ name, pid, error: (r.stderr || r.stdout || '').trim().slice(0, 200) || `exit ${r.status}` });
    }
  }
  return { killed, notRunning, failed };
}

// ── 动作表 ──────────────────────────────────────────────────────────────────
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

  // SnowLuma 后端：没有 WebUI 二维码可生成（登录是 QQ 原生窗口扫码），
  // 「重新登录」= 触发提权任务 snowluma-start.ps1 -QQOnly：只重启 QQ、不动 SnowLuma 进程，
  // 保住设备指纹，hookAutoLoad 会把 hook 重新注入新 QQ，QQ 窗口弹出扫码。
  'napcat/qr': async () => {
    if (currentBackend() === 'snowluma') {
      if (!LIVE) {
        return {
          ok: false,
          status: 409,
          error: '开发保护：真实重启会踢掉当前 QQ 登录。设 MOLLY_CONSOLE_LIVE=1 后重启控制台才允许执行。',
          data: { dryRun: true, would: 'schtasks /Run /TN SnowLuma-Relogin' },
        };
      }
      const r = await runTaskNow('SnowLuma-Relogin', 60_000);
      return {
        ...r,
        data: {
          backend: 'snowluma',
          hint: '已触发 SnowLuma-Relogin：约 10~25 秒后 QQ 窗口会弹出，用手机扫码即可（SnowLuma 进程没重启，设备指纹不变）。',
        },
      };
    }
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

  // SnowLuma 后端：全量重启 = 触发 SnowLuma-Boot（清 QQ → 起 SnowLuma → 起 QQ → 等扫码）。
  'napcat/restart': async () => {
    if (!LIVE) {
      return {
        ok: false,
        status: 409,
        error: '开发保护：真实重启会踢掉当前 QQ 登录。设 MOLLY_CONSOLE_LIVE=1 后重启控制台才允许执行。',
        data: {
          dryRun: true,
          would: currentBackend() === 'snowluma' ? 'schtasks /Run /TN SnowLuma-Boot' : 'start-molly.ps1 -Restart',
        },
      };
    }
    if (currentBackend() === 'snowluma') {
      const r = await runTaskNow('SnowLuma-Boot', 60_000);
      return {
        ...r,
        data: { backend: 'snowluma', hint: '已触发 SnowLuma-Boot：全量重启 SnowLuma + QQ，约 20~40 秒后 QQ 窗口弹出扫码。' },
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
        error: '开发保护：拉起 QQ 进程可能和现有进程抢端口。设 MOLLY_CONSOLE_LIVE=1 后重启控制台才允许执行。',
        data: {
          dryRun: true,
          would: currentBackend() === 'snowluma' ? 'schtasks /Run /TN SnowLuma-Boot' : 'start-molly.ps1',
        },
      };
    }
    if (currentBackend() === 'snowluma') {
      const r = await runTaskNow('SnowLuma-Boot', 60_000);
      return {
        ...r,
        data: { backend: 'snowluma', hint: '已触发 SnowLuma-Boot：拉起 SnowLuma + QQ，约 20~40 秒后等扫码。' },
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

  // ── 运维：Molly 本体（task-57）────────────────────────────────────────────
  // stop / restart 会踢掉 QQ 登录，属于破坏性动作（DESTRUCTIVE 里已登记，缺 confirm 一律 409）。
  // start 不破坏任何东西（已有进程时 start-molly.ps1 自己会跳过启动），所以不用 confirm。

  /** 拉起 / 检查 Molly。不带 -Restart：那个开关会先杀 QQ。 */
  'molly/start': async () => {
    // SnowLuma 后端：控制台是普通权限，拉不起提权的 QQ；交给 SnowLuma-Boot 计划任务
    if (currentBackend() === 'snowluma') {
      const r = await runTaskNow('SnowLuma-Boot', 60_000);
      appendConsoleLog(`[molly] 控制台启动 Molly（SnowLuma/计划任务）：ok=${r.ok}`);
      return {
        ok: Boolean(r.ok),
        durationMs: r.durationMs,
        data: {
          backend: 'snowluma',
          task: 'SnowLuma-Boot',
          note: '已触发 SnowLuma-Boot（清 QQ → 起 SnowLuma → 起原生 QQ）；需要登录时 QQ 窗口会弹出等你扫码。',
          taskResult: r,
        },
        error: r.error,
      };
    }
    // 不加 LIVE 闸：这个动作不破坏任何东西——start-molly.ps1 自己会跳过
    // 已经在跑的 NapCat，结尾只做一次状态检查。真正的破坏性动作是 stop / restart。
    const r = await runPowerShell([], 180_000);
    const tail = String(r.stdout || '')
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .slice(-40);
    return {
      ok: Boolean(r.ok),
      code: r.code,
      durationMs: r.durationMs,
      data: { tail, healthy: r.ok },
      stdout: r.stdout ? String(r.stdout).slice(-8000) : undefined,
      stderr: r.stderr || undefined,
      error: r.error,
    };
  },

  /** 只停 QQ + NapCat。DSH 宿主、网关、控制台自己都不碰。 */
  'molly/stop': async () => {
    // SnowLuma 后端：QQ/SnowLuma 都是提权进程，普通权限杀不掉，走 SnowLuma-Stop 任务
    if (currentBackend() === 'snowluma') {
      const r = await runTaskNow('SnowLuma-Stop', 60_000);
      appendConsoleLog(`[molly] 控制台停 Molly（SnowLuma/计划任务）：ok=${r.ok}`);
      return {
        ok: Boolean(r.ok),
        status: r.ok ? undefined : 500,
        durationMs: r.durationMs,
        data: {
          backend: 'snowluma',
          task: 'SnowLuma-Stop',
          note: '已触发 SnowLuma-Stop（温和关 QQ + 结束 SnowLuma）；DSH 宿主、网关、控制台本身没动。',
          taskResult: r,
        },
        error: r.ok ? undefined : (r.error || '触发 SnowLuma-Stop 失败'),
      };
    }
    const r = stopMollyProcesses();
    const okAll = r.failed.length === 0;
    appendConsoleLog(
      `[molly] 控制台停 Molly：杀掉 ${r.killed.map((k) => `${k.name}#${k.pid}`).join(',') || '（无）'}` +
        `｜本来没在跑 ${r.notRunning.join(',') || '（无）'}` +
        (okAll ? '' : `｜失败 ${r.failed.map((f) => `${f.name}#${f.pid}`).join(',')}`),
    );
    return {
      ok: okAll,
      status: okAll ? undefined : 500,
      data: {
        killed: r.killed,
        notRunning: r.notRunning,
        failed: r.failed,
        note: '只停了 QQ 与 NapCat；DSH 宿主、网关、控制台本身没动。',
      },
      error: okAll ? undefined : '有些进程没停掉：' + r.failed.map((f) => `${f.name}#${f.pid}`).join(', '),
    };
  },

  /** 先停再起。中间留 3 秒让 NapCat 释放 6099 / 3001。 */
  'molly/restart': async () => {
    // SnowLuma 后端：停 → 等 2 秒 → 起，全部走提权计划任务
    if (currentBackend() === 'snowluma') {
      const stopped = await runTaskNow('SnowLuma-Stop', 60_000);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const started = await runTaskNow('SnowLuma-Boot', 60_000);
      appendConsoleLog(`[molly] 控制台重启 Molly（SnowLuma/计划任务）：停=${stopped.ok} 起=${started.ok}`);
      return {
        ok: Boolean(started.ok),
        durationMs: (stopped.durationMs || 0) + 2000 + (started.durationMs || 0),
        data: {
          backend: 'snowluma',
          note: '已触发 SnowLuma-Stop → SnowLuma-Boot；中间有约 20~40 秒空窗，需要登录时会弹 QQ 扫码窗。',
          stopped,
          started,
        },
        error: started.ok ? undefined : (started.error || '触发 SnowLuma-Boot 失败'),
      };
    }
    const stopped = stopMollyProcesses();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const started = await runPowerShell([], 180_000);
    appendConsoleLog(
      `[molly] 控制台重启 Molly：停 ${stopped.killed.map((k) => `${k.name}#${k.pid}`).join(',') || '（无）'}` +
        `｜起 ${started.ok ? '成功' : '失败'}`,
    );
    return {
      ok: Boolean(started.ok),
      code: started.code,
      durationMs: started.durationMs,
      data: {
        stopped: { killed: stopped.killed, notRunning: stopped.notRunning, failed: stopped.failed },
        tail: String(started.stdout || '')
          .split(/\r?\n/)
          .filter((l) => l.trim())
          .slice(-40),
        healthy: Boolean(started.ok),
      },
      stdout: started.stdout ? String(started.stdout).slice(-8000) : undefined,
      stderr: started.stderr || undefined,
      error: started.error,
    };
  },

  // ── 外部服务：网关（task-57）──────────────────────────────────────────────
  // 密码与 token 只在内存里过一趟，**绝不写日志、绝不回显**。

  'gateway/usage': async () => {
    const lg = await gatewayPanelToken();
    if (!lg.ok) return { ok: false, status: 502, error: lg.error };
    const r = await fetchJson(GATEWAY + '/v1/usage', { headers: { 'x-panel-token': lg.token } }, 15000);
    if (!r.ok) {
      const msg = r.data?.error?.message || `网关返回 HTTP ${r.status}`;
      return { ok: false, status: r.status || 502, error: String(msg) };
    }
    const d = r.data || {};
    const byModel = {};
    for (const [name, v] of Object.entries(d.by_model || {})) {
      byModel[name] = {
        requests: isNum(v?.requests) ? v.requests : null,
        credit: isNum(v?.credit) ? v.credit : null,
      };
    }
    return {
      ok: true,
      data: {
        requests: isNum(d.requests) ? d.requests : null,
        errors: isNum(d.errors) ? d.errors : null,
        credit: isNum(d.credit) ? d.credit : null,
        costCny: isNum(d.cost_cny) ? d.cost_cny : null,
        totalTokens: isNum(d.total_tokens) ? d.total_tokens : null,
        cachedTokens: isNum(d.cached_tokens) ? d.cached_tokens : null,
        since: typeof d.since === 'string' ? d.since : null,
        realm: typeof d.realm === 'string' ? d.realm : null,
        byModel,
        usingDefaultPassword: lg.usingDefaultPassword,
        at: Date.now(),
      },
    };
  },

  'gateway/models': async () => {
    const r = await fetchJson(GATEWAY + '/v1/models', {}, 15000);
    if (!r.ok) {
      const msg = r.data?.error?.message || `网关返回 HTTP ${r.status}`;
      return { ok: false, status: r.status || 502, error: String(msg) };
    }
    const list = Array.isArray(r.data?.data) ? r.data.data : [];
    return {
      ok: true,
      data: {
        count: list.length,
        items: list.map((m) => ({
          id: String(m?.id ?? ''),
          ownedBy: typeof m?.owned_by === 'string' ? m.owned_by : null,
          supportsVision: typeof m?.supports_vision === 'boolean' ? m.supports_vision : null,
        })),
        at: Date.now(),
      },
    };
  },

  // ── 切模型（用户 m39817：仅限控制台）─────────────────────────────────────
  // 为什么不让前端直连 7053：插件写接口要求 x-molly-admin，令牌只能待在服务端；
  // 而且前端只认 /api/action/*，不给它第二个入口。
  // 令牌没配时**不编造成功**：插件会回 403 并说明原因，原样透给前端。

  'plugin/model-set': async (body) => {
    const patch = {};
    for (const role of ['chat', 'work', 'code']) {
      const raw = body?.[role];
      if (raw === undefined || raw === null || raw === '') continue;
      patch[role] = String(raw).trim();
    }
    if (!Object.keys(patch).length) {
      return { ok: false, status: 400, error: 'chat / work / code 至少要给一个' };
    }
    if (!MODEL_SWITCH_TOKEN) {
      // 本地先拦一道，说清楚是"服务端没配"，别让前端对着 403 猜
      return {
        ok: false,
        status: 403,
        error: '服务端还没配置切模型令牌（MOLLY_MODEL_SWITCH_TOKEN / console.json 的 modelSwitchToken），切模型现在用不了。',
        data: { needToken: true, roles: ['chat', 'work', 'code'] },
      };
    }
    const base = await resolveHostBase();
    if (!base) return { ok: false, status: 503, error: '没探到 DSH 宿主端口' };
    const r = await fetchJson(
      base + '/dsh-qq-whale/model',
      {
        method: 'POST',
        body: JSON.stringify(patch),
        headers: { 'x-molly-admin': MODEL_SWITCH_TOKEN },
      },
      15000,
    );
    if (!r.ok) {
      const msg = r.data?.error || `插件返回 HTTP ${r.status}`;
      // 403 把服务端原文透出去：前端靠它提示"服务端还没配置切模型令牌"
      return { ok: false, status: r.status || 502, error: String(msg), data: r.data ?? null };
    }
    appendConsoleLog(`[model] 控制台切模型：${Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    return { ok: true, data: r.data ?? null };
  },

  // ── 外部服务：心跳（task-57）─────────────────────────────────────────────
  // 服务器挂了不能把整页拖垮：远端不可达照样 200，前端按 remote.ok 显示。

  'heartbeat/status': async () => {
    const local = readHeartbeatLocal();
    const cfg = readJson(HB_CONFIG, null);
    const timeoutMs = isNum(cfg?.timeoutMs) ? cfg.timeoutMs : 8000;
    const remote = await fetchHeartbeatRemote(timeoutMs);
    return {
      ok: true,
      data: {
        local: local
          ? {
              lastAt: local.lastAt,
              ok: local.ok,
              lastStatus: local.lastStatus,
              fails: local.fails,
              host: local.host,
              relay: local.relay,
              lastLocal: local.lastLocal,
            }
          : null,
        remote,
        at: Date.now(),
      },
    };
  },

  // ── 外部服务：PushPlus 推送开关（task-57）────────────────────────────────
  // 只改 notify.enabled 一个布尔值；写盘前备份；返回值里 token **打码**。

  'pushplus/status': async () => {
    const cur = readJson(WD_CONFIG, null);
    if (!cur) return { ok: false, status: 500, error: '读不到 watchdog-config.json' };
    const notify = cur.notify && typeof cur.notify === 'object' ? cur.notify : {};
    const tk = typeof notify.token === 'string' ? notify.token : '';
    return {
      ok: true,
      data: {
        enabled: notify.enabled === true,
        token: tk ? `${tk.slice(0, 4)}****${tk.slice(-4)}` : null,
        hasToken: Boolean(tk),
        type: typeof notify.type === 'string' ? notify.type : null,
      },
    };
  },

  'pushplus/toggle': async (body) => {
    if (typeof body?.enabled !== 'boolean') {
      return { ok: false, status: 400, error: 'enabled 必须是 boolean（true / false）' };
    }
    const cur = readJson(WD_CONFIG, null);
    if (!cur) return { ok: false, status: 500, error: '读不到 watchdog-config.json' };
    const notify = cur.notify && typeof cur.notify === 'object' ? cur.notify : {};
    const before = notify.enabled === true;
    // 备份：配置写坏了 watchdog 就不推了，得能手工回滚
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const bak = `${WD_CONFIG}.bak-${stamp}`;
    try {
      fs.copyFileSync(WD_CONFIG, bak);
    } catch (err) {
      return { ok: false, status: 500, error: '备份配置失败：' + errText(err) };
    }
    const next = { ...cur, notify: { ...notify, enabled: body.enabled } };
    try {
      fs.writeFileSync(WD_CONFIG, JSON.stringify(next, null, 2) + '\n', 'utf8');
    } catch (err) {
      return { ok: false, status: 500, error: '写配置失败：' + errText(err) };
    }
    const tk = typeof notify.token === 'string' ? notify.token : '';
    appendConsoleLog(`[pushplus] 控制台把推送 → ${body.enabled ? '开' : '关'}（备份 ${path.basename(bak)}）`);
    return {
      ok: true,
      data: {
        enabled: body.enabled,
        changed: before !== body.enabled,
        // 只露首尾各 4 位，中间打码；没配 token 就照实说
        token: tk ? `${tk.slice(0, 4)}****${tk.slice(-4)}` : null,
        hasToken: Boolean(tk),
        type: typeof notify.type === 'string' ? notify.type : null,
        backup: path.basename(bak),
      },
    };
  },
};

/**
 * 触发一个提权计划任务（SnowLuma 的「重新登录 / 全量重启」都走它）。
 * 为什么要绕一层计划任务：console-server 自己以 Limited 权限跑，直接调
 * snowluma-start.ps1 注入不了提权的 QQ.exe；计划任务以 RunLevel Highest 跑，能注入。
 * schtasks 在中文系统输出 GBK，这里只认退出码，不解析输出。
 */
async function runTaskNow(taskName, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let child;
    try {
      child = spawn('schtasks.exe', ['/Run', '/TN', taskName], { windowsHide: true });
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
      resolve({ ...v, durationMs: Date.now() - t0, task: taskName });
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      done({ ok: false, error: `schtasks /Run ${taskName} 超过 ${Math.round(timeoutMs / 1000)} 秒未返回` });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('binary'); });
    child.stderr.on('data', (d) => { errOut += d.toString('binary'); });
    child.on('error', (e) => done({ ok: false, error: errText(e) }));
    child.on('exit', (code) => done({ ok: code === 0, code, stdout: out.slice(-2000), stderr: errOut.slice(-2000) }));
  });
}

/** 跑 start-molly.ps1（可能很久，输出也大） */
async function runPowerShell(args, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const script = path.join(TOOLS_DIR, 'start-molly.ps1');
    if (!fs.existsSync(script)) return resolve({ ok: false, error: '脚本不存在：' + script, durationMs: 0 });
    let child;
    try {
      /*
       * 为什么要在 PowerShell 里先改输出编码：
       * start-molly.ps1 里全是中文 Write-Host，而 Windows PowerShell 5.1 默认用
       * 系统 ANSI（这台是 cp936/GBK）往管道里写。父进程 Node 按 utf8 解就会变成
       * 「Molly ȫ��������」这样的乱码。
       *
       * [Console]::OutputEncoding 只影响本进程的标准输出编码，不碰系统设置；
       * 设成 UTF8 后，Node 端直接 toString('utf8') 就是正确的中文。
       */
      const pre = "$ErrorActionPreference='Continue'; try{[Console]::OutputEncoding=[Text.Encoding]::UTF8}catch{}; & ";
      child = spawn(
        PS_EXE,
        [
          '-NoProfile',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          `${pre}'${script.replace(/'/g, "''")}'${args.map((a) => ` '${String(a).replace(/'/g, "''")}'`).join('')}`,
        ],
        { windowsHide: true },
      );
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
