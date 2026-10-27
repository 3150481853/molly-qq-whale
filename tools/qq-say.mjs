// qq-say.mjs — 通过 NapCat 的 OneBot v11 WebSocket 发一条消息（零依赖，Node 22+ 自带 WebSocket）
//
// 为什么不用 HTTP：本机 NapCat 只开了 WS server（127.0.0.1:3001），httpServers 是空的。
// 开 HTTP 要改 napcat 配置并重启 QQ，代价大；WS 客户端可以多开，随手连一下最快。
//
// 用法：
//   node tools/qq-say.mjs --group 123456 --text "你好"
//   node tools/qq-say.mjs --user 222222222 --text "私聊测试"
//   node tools/qq-say.mjs --login            # 只读，验证通道是否活着
//   node tools/qq-say.mjs --group 123 --text "hi" --dry-run
//
// 作为模块：
//   import { onebotCall, sendGroupText, sendPrivateText } from './qq-say.mjs'
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const NAPCAT_CFG_DIR = path.join(ROOT, 'napcat', 'config');

function readJson(p, fb = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fb; }
}

/** 从 napcat 配置里捞 WS 地址与令牌，允许 env 覆盖 */
export function resolveOneBot() {
  if (process.env.MOLLY_ONEBOT_URL) {
    return { url: process.env.MOLLY_ONEBOT_URL, token: process.env.MOLLY_ONEBOT_TOKEN || '' };
  }
  let cfgDir = NAPCAT_CFG_DIR;
  let files = [];
  try { files = fs.readdirSync(cfgDir).filter((f) => /^onebot11.*\.json$/.test(f)); } catch { /* 配置目录不在，退回默认 */ }
  // 优先带 QQ 号的那份，再退回 onebot11.json
  files.sort((a, b) => (a === 'onebot11.json' ? 1 : 0) - (b === 'onebot11.json' ? 1 : 0));
  for (const f of files) {
    const j = readJson(path.join(cfgDir, f));
    const srv = j?.network?.websocketServers?.find?.((s) => s?.enable !== false);
    if (srv) {
      return { url: `ws://${srv.host || '127.0.0.1'}:${srv.port || 3001}/`, token: srv.token || '' };
    }
  }
  return { url: 'ws://127.0.0.1:3001/', token: '' };
}

/** 调用一个 OneBot v11 action，等 echo 回来；超时抛错 */
export function onebotCall(action, params = {}, opts = {}) {
  const { url, token } = opts.url ? opts : resolveOneBot();
  const timeoutMs = opts.timeoutMs || 15000;
  const echo = `molly-${action}-${Math.random().toString(36).slice(2, 10)}`;
  const wsUrl = token ? `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}` : url;

  return new Promise((resolve, reject) => {
    let done = false;
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => finish(new Error(`OneBot ${action} 超时（${timeoutMs}ms）`)), timeoutMs);

    function finish(err, data) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* 已关闭 */ }
      err ? reject(err) : resolve(data);
    }

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ action, params, echo }));
    });
    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg?.echo !== echo) return;               // 事件推送与别的 echo 一律忽略
      if (msg.status === 'failed' || msg.retcode !== 0) {
        finish(new Error(`${action} 失败：${msg.retcode} ${msg.wording || msg.message || ''}`.trim()));
      } else {
        finish(null, msg.data);
      }
    });
    ws.addEventListener('error', () => finish(new Error(`连不上 OneBot WS：${url}`)));
    ws.addEventListener('close', () => finish(new Error('OneBot WS 提前关闭')));
  });
}

export function sendGroupText(groupId, text, opts = {}) {
  return onebotCall('send_group_msg', { group_id: Number(groupId), message: [{ type: 'text', data: { text: String(text) } }] }, opts);
}

export function sendPrivateText(userId, text, opts = {}) {
  return onebotCall('send_private_msg', { user_id: Number(userId), message: [{ type: 'text', data: { text: String(text) } }] }, opts);
}

// ---------- CLI ----------
if (process.argv[1] && path.resolve(process.argv[1]).endsWith('qq-say.mjs')) {
  const argv = process.argv.slice(2);
  const get = (k) => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const dry = argv.includes('--dry-run');
  const group = get('--group');
  const user = get('--user');
  const text = get('--text');
  const loginOnly = argv.includes('--login');

  const { url } = resolveOneBot();
  if (loginOnly) {
    const info = await onebotCall('get_login_info');
    console.log(`WS ${url} 登录账号 ${info?.user_id} 昵称 ${info?.nickname}`);
  } else if (!text || (!group && !user)) {
    console.error('用法：node tools/qq-say.mjs --group <群号> --text "内容"  |  --user <QQ号> --text "内容"  |  --login');
    process.exit(2);
  } else if (dry) {
    console.log(`[dry-run] ${group ? `群 ${group}` : `私聊 ${user}`}：${text}`);
  } else {
    const r = group ? await sendGroupText(group, text) : await sendPrivateText(user, text);
    console.log(`已发送 message_id=${r?.message_id}`);
  }
}
