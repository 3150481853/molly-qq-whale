#!/usr/bin/env node
/**
 * panel-data.mjs —— Molly「大看板」只读本地数据服务
 *
 * 设计原则：
 *  - 只用 Node 内置模块（node:http / node:fs / node:path），零依赖。
 *  - 全程只读 DATA 目录，绝不写入、不修改任何数据文件。
 *  - 每次请求现读盘（文件都很小），不做内存缓存；图片按需流式读，不堆内存。
 *  - 所有读盘都 try/catch：文件缺失 / JSON 坏掉 / 目录不存在 都不能让服务崩，
 *    对应数据块给 null 或空数组，响应里 ok 仍为 true。
 *  - 只绑 127.0.0.1（本地前端跨端口取数），不对外暴露。
 *
 * 数据来源（DATA = 环境变量 MOLLY_DATA_DIR，默认 <用户目录>/.dsh/qq-whale）：
 *  - memory/memory.md        记忆正文（主来源；加密后不存在）
 *  - memory/memory.md.enc    加密后的记忆正文（2026-10-23 m00709 起；优先读它）
 *  - memory/memory.json      记忆 JSON（md 解析出 0 条时的兜底；加密后是 aes-256-gcm 信封）
 *  - memory/memory.json      密钥按插件同一套规则找（<数据目录父级>/qq-whale-keys/memory.key，
 *                            可被 MOLLY_MEMORY_KEY_FILE 或 MOLLY_MEMORY_KEY 覆盖）
 *  - stickers/学来的/*.jpg|png|gif|webp   表情包图片
 *  - stickers/学来的/.learned.json       表情包元数据（隐藏文件，不当作表情包列出）
 *  - metrics.json            消息量 / 会话数 / 回复耗时
 *  - budget.json             今日已用额度
 *  - budget-settings.json    额度上限 dailyCap 与开关 enabled
 *  - spare-budget.json       备用额度
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// 记忆池加密（2026-10-23 m00709）：只借用插件里的解密实现，本服务仍然零外部依赖、只读。
import { loadKey, decryptText, isEnvelope, resolveKeyFile } from '../plugin/dsh-qq-whale/lib/memcrypt.js';

// ── 基础配置 ────────────────────────────────────────────────────────────────
// 2026-10-26（部署者反馈 m03205）：这个文件原先写死 `${MOLLY_ROOT}\data\qq-whale`，别的机器上
// 要么读不到数据（看板全空），要么得自己改代码。现在的顺序：
//   1) 环境变量 MOLLY_DATA_DIR
//   2) DSH 插件配置里的 dataDir（~/.dsh/profiles/*/cordis.patch.yml 的 dsh-qq-whale 段）
//   3) <用户目录>/.dsh/qq-whale（插件自带默认值）
//   MOLLY_SIDECAR_PORT  端口（不给就 19391，和 console-server.mjs 的默认一致）
//   MOLLY_MEMORY_KEY_FILE 密钥文件（不给就按插件同一套规则找：<数据目录父级>/qq-whale-keys/memory.key）
// 路径推导放在 resolve-paths.mjs（console-server.mjs 也用同一份，避免两处写法漂移）。
import { detectDataDirFromProfiles, defaultDataDir } from './resolve-paths.mjs';

const DATA = path.resolve(
  String(process.env.MOLLY_DATA_DIR || '').trim()
    || detectDataDirFromProfiles()
    || defaultDataDir(),
); // 数据根目录，也是 /api/health 的 dataDir
const STICKER_DIR = path.join(DATA, 'stickers', '学来的');  // 表情包图片目录
const HOST = '127.0.0.1';                                   // 只绑本机回环
const PORT = Number(String(process.env.MOLLY_SIDECAR_PORT || '').trim() || 19391);
const VERSION = '1.0.1';

// 允许对外吐的图片扩展名 → Content-Type（其它扩展名一律不列、不服务）
const IMG_EXT = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

// 跨端口取数必需的 CORS 头（前端跑在 http://127.0.0.1:7053）
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

// ── 通用读盘工具（全部吞异常，失败返回 null）─────────────────────────────────
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJson(file) {
  const txt = readText(file);
  if (txt == null) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return null; // JSON 坏掉 → 当作没有
  }
}

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

// ── 记忆解密（2026-10-23 m00709：记忆池加密后，看板要自己能读）─────────────────
// 密钥和密文分开放：密文在 DATA\memory\，钥匙按插件同一套规则找（2026-10-26 起不再写死盘符）。
// 读不到钥匙就当作"没有记忆"，看板显示空，绝不让整个服务 500。
const MEMORY_KEY_FILE = resolveKeyFile({
  dataDir: DATA,
  keyFile: String(process.env.MOLLY_MEMORY_KEY_FILE || '').trim(),
});
let memoryKeyLoaded = false;
let memoryKey = null;

function getMemoryKey() {
  if (memoryKeyLoaded) return memoryKey;
  memoryKeyLoaded = true;
  try {
    memoryKey = loadKey({ keyFile: MEMORY_KEY_FILE }).key;
  } catch {
    memoryKey = null; // 钥匙丢了/没生成：按空处理
  }
  return memoryKey;
}

/** 读一个可能是明文的文本文件；不存在就试同名 .enc 解密，都没有返回 null */
function readTextMaybeEncrypted(file, encFile) {
  const plain = readText(file);
  if (plain != null) return plain;
  const env = readJson(encFile);
  if (env == null) return null;
  const key = getMemoryKey();
  if (!key) return null;
  try {
    return decryptText(env, key);
  } catch {
    return null;
  }
}

// 把 ms 时间戳格式化成 "YYYY-MM-DD HH:mm"（本地时区，和 memory.md 的写法一致）
function fmtMinute(ms) {
  if (!isNum(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ms 时间戳 → "YYYY-MM-DD"（本地时区）
function fmtDate(ms) {
  if (!isNum(ms)) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ── memory：解析 memory.md ──────────────────────────────────────────────────
/**
 * memory.md 结构：
 *   # 标题
 *   更新时间：2026-10-18 15:58      ← updatedAt
 *   ## 分组名                        ← groups[].name
 *   - 2026-10-17 [sticker/w2] 正文   ← items[]: {date, tag, text}
 * 兼容：没有 [tag] 的行，正文直接从日期后面开始；没有日期的行，date 给 null。
 */
function parseMemoryMd() {
  const txt = readTextMaybeEncrypted(
    path.join(DATA, 'memory', 'memory.md'),
    path.join(DATA, 'memory', 'memory.md.enc'),
  );
  if (txt == null) return null;

  let updatedAt = null;
  const groups = [];
  let cur = null;

  for (const raw of txt.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;

    // 更新时间：xxx（全角/半角冒号都认）
    const mUpd = line.match(/^更新时间[:：]\s*(.+)$/);
    if (mUpd) {
      updatedAt = mUpd[1].trim();
      continue;
    }

    // 一级标题忽略
    if (/^#\s+/.test(line)) continue;

    // 二级标题 = 分组名
    const mGroup = line.match(/^##\s+(.+)$/);
    if (mGroup) {
      cur = { name: mGroup[1].trim(), items: [] };
      groups.push(cur);
      continue;
    }

    // 列表条目：- YYYY-MM-DD [tag] 正文  或  - YYYY-MM-DD 正文  或  - 正文
    const mItem = line.match(/^[-*]\s+(.*)$/);
    if (!mItem) continue;
    let rest = mItem[1].trim();

    let date = null;
    const mDate = rest.match(/^(\d{4}-\d{2}-\d{2})\s*(.*)$/);
    if (mDate) {
      date = mDate[1];
      rest = mDate[2].trim();
    }

    let tag = null;
    const mTag = rest.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (mTag) {
      tag = mTag[1].trim();
      rest = mTag[2].trim();
    }

    if (!rest) continue; // 空正文不要

    if (!cur) {
      // 条目出现在任何 ## 之前：兜个默认分组，避免丢数据
      cur = { name: '杂项', items: [] };
      groups.push(cur);
    }
    cur.items.push({ date, tag, text: rest });
  }

  return { updatedAt, groups };
}

// ── memory：memory.json 兜底 ────────────────────────────────────────────────
/**
 * memory.json 实际结构（version 1）：
 *   { "version": 1, "entries": [ { id, kind, who, text, weight, at } ] }
 * 映射到统一的 groups 形状：
 *   who 为空 → 归到「杂项」分组；kind + weight → tag（"sticker/w2"），和 md 里的 [sticker/w2] 对齐；
 *   at（ms）→ date；text 原样。
 * updatedAt 取所有 at 里最大的那个（md 没有时的合理推导，推不出就给 null）。
 */
function parseMemoryJson() {
  let data = readJson(path.join(DATA, 'memory', 'memory.json'));
  if (!data) return null;
  // 加密后 memory.json 是信封（{enc, iv, tag, data}）：解出来才是 {version, entries}
  if (isEnvelope(data)) {
    const key = getMemoryKey();
    if (!key) return null;
    try {
      data = JSON.parse(decryptText(data, key));
    } catch {
      return null;
    }
  }
  if (!Array.isArray(data.entries)) return null;

  const byName = new Map();
  let maxAt = null;

  for (const e of data.entries) {
    if (!e || typeof e !== 'object') continue;
    const text = typeof e.text === 'string' ? e.text.trim() : '';
    if (!text) continue;

    const who = typeof e.who === 'string' && e.who.trim() ? e.who.trim() : '杂项';
    const kind = typeof e.kind === 'string' && e.kind.trim() ? e.kind.trim() : null;
    const weight = isNum(e.weight) ? `w${e.weight}` : null;
    const tag = kind ? [kind, weight].filter(Boolean).join('/') : null;

    if (isNum(e.at) && (maxAt == null || e.at > maxAt)) maxAt = e.at;

    if (!byName.has(who)) byName.set(who, []);
    byName.get(who).push({ date: fmtDate(e.at), tag, text });
  }

  const groups = [...byName.entries()].map(([name, items]) => ({ name, items }));
  return { updatedAt: fmtMinute(maxAt), groups };
}

// ── memory 汇总：md 优先，解析出 0 条则退回 json ─────────────────────────────
function buildMemory() {
  const md = parseMemoryMd();
  const mdCount = md ? md.groups.reduce((n, g) => n + g.items.length, 0) : 0;

  let src = md;
  if (mdCount === 0) {
    const js = parseMemoryJson();
    if (js) src = js; // md 没东西 → 用 json
  }
  if (!src) return null;

  const groups = src.groups.filter((g) => g.items.length > 0);
  const count = groups.reduce((n, g) => n + g.items.length, 0);
  return { updatedAt: src.updatedAt ?? null, count, groups };
}

// ── stickers：扫 stickers/学来的 目录 ────────────────────────────────────────
/**
 * 每个 item：{ name（去扩展名）, file（原始文件名）, ext, size, url（/sticker/<urlencode 文件名>）}
 * 跳过隐藏文件（.learned.json 是元数据哈希数组，不是表情包）。
 */
function buildStickers() {
  let entries;
  try {
    entries = fs.readdirSync(STICKER_DIR, { withFileTypes: true });
  } catch {
    return { count: 0, items: [] }; // 目录不存在 → 空，不崩
  }

  const items = [];
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    const file = ent.name;
    if (file.startsWith('.')) continue; // .learned.json 之类
    const ext = path.extname(file).slice(1).toLowerCase();
    if (!IMG_EXT[ext]) continue;        // 非图片忽略

    let size = null;
    try {
      size = fs.statSync(path.join(STICKER_DIR, file)).size;
    } catch {
      size = null;
    }

    items.push({
      name: path.basename(file, path.extname(file)),
      file,
      ext,
      size,
      url: '/sticker/' + encodeURIComponent(file),
    });
  }

  items.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return { count: items.length, items };
}

// ── metrics：metrics.json ───────────────────────────────────────────────────
/**
 * 原始：{ messages, conversations: [id...], replyDurations: [ms...], lastReplyAt, lastReplyMs }
 * 注意 conversations 是「数组」，对外要的是「数量」。
 * topConversations：数组里没有任何次数信息，无法排序 → 给 null（不编造）。
 * avgReplySeconds：replyDurations 的平均值 / 1000，保留 1 位小数。
 */
function buildMetrics() {
  const m = readJson(path.join(DATA, 'metrics.json'));
  if (!m || typeof m !== 'object') return null;

  let conversations = null;
  if (Array.isArray(m.conversations)) conversations = m.conversations.length;
  else if (isNum(m.conversations)) conversations = m.conversations;

  let avgReplySeconds = null;
  if (Array.isArray(m.replyDurations) && m.replyDurations.length > 0) {
    const nums = m.replyDurations.filter(isNum);
    if (nums.length > 0) {
      const avgMs = nums.reduce((a, b) => a + b, 0) / nums.length;
      avgReplySeconds = Math.round(avgMs / 100) / 10; // ms→s 且保留 1 位
    }
  }

  return {
    messages: isNum(m.messages) ? m.messages : null,
    conversations,
    avgReplySeconds,
    lastReplyAt: typeof m.lastReplyAt === 'string' ? m.lastReplyAt : null,
    lastReplyMs: isNum(m.lastReplyMs) ? m.lastReplyMs : null,
    topConversations: null, // 原始数据无次数信息，见上方注释
  };
}

// ── budget：budget.json + budget-settings.json + spare-budget.json ──────────
/**
 * used    ← budget.json.used
 * cap     ← budget-settings.json.dailyCap（原始字段名是 dailyCap，对外叫 cap）
 * enabled ← budget-settings.json.enabled
 * spare   ← spare-budget.json 原样透出
 * 三个文件都读不到才返回 null。
 */
function buildBudget() {
  const b = readJson(path.join(DATA, 'budget.json'));
  const s = readJson(path.join(DATA, 'budget-settings.json'));
  const sp = readJson(path.join(DATA, 'spare-budget.json'));
  if (!b && !s && !sp) return null;

  return {
    used: b && isNum(b.used) ? b.used : null,
    cap: s && isNum(s.dailyCap) ? s.dailyCap : null,
    enabled: s && typeof s.enabled === 'boolean' ? s.enabled : null,
    spare: sp ?? null,
  };
}

// ── HTTP 工具 ───────────────────────────────────────────────────────────────
function sendJson(res, status, obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const notFound = (res) => sendJson(res, 404, { ok: false, error: 'not found' });

// 服务单张表情包图片：按需读盘，读完即丢，不缓存
function serveSticker(req, res, rawName) {
  let name;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return notFound(res); // urlencode 坏掉
  }

  // 只允许单层文件名，挡住 ../ 之类的路径穿越
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return notFound(res);
  }

  const ext = path.extname(name).slice(1).toLowerCase();
  const type = IMG_EXT[ext];
  if (!type) return notFound(res);

  const full = path.resolve(STICKER_DIR, name);
  if (!full.startsWith(path.resolve(STICKER_DIR) + path.sep)) return notFound(res);

  fs.readFile(full, (err, buf) => {
    if (err) return notFound(res);
    res.writeHead(200, {
      ...CORS_HEADERS,
      'Content-Type': type,
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

// ── 路由 ────────────────────────────────────────────────────────────────────
function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  // CORS 预检：204 + 同样的头
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }

  // 图片：/sticker/<文件名>
  if (p.startsWith('/sticker/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
    return serveSticker(req, res, p.slice('/sticker/'.length));
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);

  switch (p) {
    case '/api/health':
      return sendJson(res, 200, { ok: true, version: VERSION, dataDir: DATA, at: Date.now() });

    case '/api/all':
      // 前端主要就调这一个：一次给全（各块独立容错，单块失败不影响整体 ok）
      return sendJson(res, 200, {
        ok: true,
        at: Date.now(),
        memory: buildMemory(),
        stickers: buildStickers(),
        metrics: buildMetrics(),
        budget: buildBudget(),
      });

    case '/api/memory':
      return sendJson(res, 200, buildMemory());
    case '/api/stickers':
      return sendJson(res, 200, buildStickers());
    case '/api/metrics':
      return sendJson(res, 200, buildMetrics());
    case '/api/budget':
      return sendJson(res, 200, buildBudget());

    default:
      return notFound(res);
  }
}

const server = http.createServer((req, res) => {
  try {
    handle(req, res);
  } catch (err) {
    // 只在 5xx 打日志，避免前端 5 秒轮询把日志撑爆
    console.log(`[panel-data] 500 ${req.method} ${req.url}: ${err && err.stack ? err.stack : err}`);
    try {
      sendJson(res, 500, { ok: false, error: 'internal error' });
    } catch {
      try { res.destroy(); } catch { /* ignore */ }
    }
  }
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    // 端口被占：说明已有实例在跑，正常退出，不抛栈
    console.log('已有实例在跑，退出');
    process.exit(0);
  }
  console.log(`[panel-data] 启动失败：${err && err.message ? err.message : err}`);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`[panel-data] 已启动 http://${HOST}:${PORT}  version=${VERSION}`);
  console.log(`[panel-data] 数据目录 ${DATA}`);
});
