#!/usr/bin/env node
/**
 * console-server.mjs 鈥斺€?Molly 鎺у埗鍙版湇鍔＄锛?<REDACTED>:19392锛? *
 * 瑙勬牸锛歲q-whale/docs/console-contract.md锛堝敮涓€浜嬪疄鏉ユ簮锛屾湰鏂囦欢涓ユ牸鎸夊畠瀹炵幇锛? *
 * 璁捐瑕佺偣锛? *  - 鍙敤 Node 鍐呯疆妯″潡锛岄浂渚濊禆锛屼笉鐢?shell:true锛堜腑鏂囪矾寰?+ 绌烘牸浼氱偢锛夈€? *  - 鍙洃鍚?1<REDACTED>锛屼笉瀵瑰鏆撮湶銆? *  - 瀹夸富绔彛锛圖SH 鐨?/dsh-qq-whale/*锛?*涓嶅啓姝?7053**锛氬厛璇?7053锛屽啀浠?netstat 鐨? *    LISTEN 鍒楄〃閲屾寫 1024-65535 鐨勭鍙ｏ紙鍘熷厛鏄?7000-9000锛孌SH 妗岄潰绔噸鍚悗
 *    鍙兘钀藉埌 2160 杩欑被浣庝綅绔彛锛屾晠鏀惧锛夛紝閫愪釜 GET /dsh-qq-whale/state 鎺㈠埌 200 涓烘銆? *  - 浠讳綍涓婃父鎸傛帀锛?api/overview 浠嶈繑鍥?200锛屽搴斿潡 reachable:false銆? *  - 鎵€鏈?spawn 甯﹁秴鏃讹紝瓒呮椂 kill锛圵indows 涓嬬敤 taskkill /T 杩炲瓙杩涚▼涓€璧锋潃锛夈€? *  - 鏃ュ織鍙湪鍚姩鍜?5xx 鎵擄紝鍓嶇 4 绉掕疆璇笉浼氭妸鏃ュ織鎾戠垎锛涙棩蹇楅噷涓嶆墦鍗?token/secret銆? *
 * 璺緞绾﹀畾锛堜袱濂楁牴鐩綍锛屽埆娣凤級锛? *  - ROOT = qq-whale 宸ヤ綔鐩綍锛堜唬鐮?闈欐€侀〉/out 鏃ュ織閮藉湪杩欓噷锛夛細MOLLY_ROOT > console.json > 鎸夋湰鏂囦欢浣嶇疆鎺ㄥ
 *  - DATA = 杩愯鏃舵暟鎹紙memory/stickers/metrics/budget锛夛細MOLLY_DATA_DIR > console.json > 鎻掍欢閰嶇疆閲岀殑
 *           dataDir > <鐢ㄦ埛鐩綍>/.dsh/qq-whale銆?026-10-26锛堥儴缃茶€呭弽棣?m03205锛変箣鍓嶈繖閲屽啓姝? *           浣滆€呮満鐨?`${MOLLY_ROOT}\data\qq-whale`锛屽埆鐨勬満鍣ㄤ笂閮ㄧ讲鍙兘鏀逛唬鐮併€? */

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { isSea } from 'node:sea';
import { detectDataDirFromProfiles, defaultDataDir } from './resolve-paths.mjs';

/*
 * 鈹€鈹€ 閰嶇疆锛堜笁鏉℃潵婧愶紝浼樺厛绾т粠浣庡埌楂橈級鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
 *   鈶?涓嬮潰鐨勫唴缃粯璁ゅ€?         鈥斺€?鍦ㄦ湰鏈轰粠婧愮爜璺戞椂琛屼负涓庝互鍓嶅畬鍏ㄤ竴鑷? *   鈶?console.json 閰嶇疆鏂囦欢     鈥斺€?exe 妯″紡鏀?exe 鍚岀骇锛涙簮鐮佹ā寮忔斁 console-server.mjs 鍚岀骇
 *                                 锛坱ools\console.json锛夛紝鏀归厤缃笉鐢ㄩ噸鏂版墦鍖?鏀逛唬鐮? *   鈶?鐜鍙橀噺 MOLLY_*          鈥斺€?瀹瑰櫒 / systemd / 涓存椂鎺掗殰鏃舵渶楂樹紭鍏? *
 * 涓轰粈涔堣杩欎竴灞傦細molly-console.exe 瑕佽兘鎷峰埌浠绘剰鐩綍璺戙€佷篃鍙兘鎼埌鏈嶅姟鍣ㄤ笂锛坉ocs/deploy.md锛夛紝
 * 涓嶈兘鍐嶆妸宸ヤ綔鍖虹粷瀵硅矾寰勫啓姝诲湪浠ｇ爜閲屻€係EA 鍗曟枃浠舵ā寮忎笅 exe 鎷夸笉鍒版簮鐮佺洰褰曪紝
 * 鍙兘鐢?process.execPath 鐨勬墍鍦ㄧ洰褰曞綋鍦板熀锛涙簮鐮佹ā寮忓垯鐢ㄨ剼鏈嚜宸辩殑鐩綍銆? */
const IS_SEA = (() => {
  try {
    return isSea();
  } catch {
    return false;
  }
})();
const EXE_DIR = path.dirname(process.execPath);
// 鑴氭湰鑷韩鐩綍锛堟簮鐮佹ā寮?= tools\锛夈€備笉鑳界敤 ESM 鐨?importMeta.url锛歋EA 鎵撳寘瑕佹眰鏈枃浠?// 淇濇寔銆岄浂 importMeta 寮曠敤銆嶆墠鑳芥満姊拌浆鎴?CJS锛坱ools/build-exe.mjs 鐨?toCjs 浼氱洿鎺ユ姤閿欙級銆?// node tools\console-server.mjs 鍚姩鏃?argv[1] 灏辨槸鑴氭湰璺緞锛屽鐢紱SEA 涓嬮€€鍥?EXE_DIR銆?const HERE = (() => {
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

// 閰嶇疆鏂囦欢浣嶇疆锛歁OLLY_CONSOLE_CONFIG 鎸囧畾浼樺厛锛涘惁鍒?exe 鍚岀骇 / 鑴氭湰鍚岀骇 console.json銆?// 婧愮爜妯″紡浠ュ墠钀藉湪 <node.exe 鐩綍>锛圕:\...\node\bin\console.json锛夆€斺€旀病浜轰細鍘婚偅鍎挎斁閰嶇疆锛?// 浜庢槸 tools\console.json 鐪嬬潃鍍忕敓鏁堝叾瀹炴病璇伙紙2026-10-21 鍒囨ā鍨?403 鐨勬牴鍥犱箣涓€锛夈€?const CONFIG_FILE = (() => {
  const explicit = String(process.env.MOLLY_CONSOLE_CONFIG || '').trim();
  if (explicit) return path.resolve(explicit);
  return path.join(IS_SEA ? EXE_DIR : HERE, 'console.json');
})();
const FILE_CFG = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch {
    return {}; // 娌℃湁鏂囦欢 / 涓嶆槸鍚堟硶 JSON 閮介€€鍥為粯璁ゅ€硷紝涓嶉樆鏂惎鍔?  }
})();
// 鎸夈€岀幆澧冨彉閲?> 閰嶇疆鏂囦欢 > 榛樿鍊笺€嶅彇鍊硷紱绌哄瓧绗︿覆涓€寰嬭涓烘病璁?const pick = (envKey, cfgKey, fallback) => {
  const e = String(process.env[envKey] ?? '').trim();
  if (e) return e;
  const c = FILE_CFG[cfgKey];
  if (c !== undefined && c !== null && String(c).trim() !== '') return String(c).trim();
  return fallback;
};

// 宸ヤ綔鍖烘牴锛歁OLLY_ROOT > console.json > 婧愮爜妯″紡鎸夋湰鏂囦欢浣嶇疆鎺紙<root>/tools/console-server.mjs锛夛紝
// exe 妯″紡鍙?exe 鎵€鍦ㄧ洰褰曪紙涓嬮潰 CONSOLE_DIR 浼氬啀鍏滃簳锛夈€?const ROOT = pick('MOLLY_ROOT', 'root',
  IS_SEA ? EXE_DIR : path.resolve(HERE, '..'));
const DATA = pick('MOLLY_DATA_DIR', 'dataDir',
  detectDataDirFromProfiles() || defaultDataDir());
// 鍓嶇浜х墿锛歁OLLY_CONSOLE_DIR > console.json(consoleDir) > exe 鍚岀骇 console/ > 宸ヤ綔鍖?console/
// SEA 妯″紡涓?*涓嶆妸闈欐€佽祫婧愭墦杩?exe**锛岃€屾槸鎸夌洰褰曟煡鎵撅紝杩欐牱鏀瑰墠绔笉鐢ㄩ噸鏂版墦鍖呫€?const CONSOLE_DIR = pick(
  'MOLLY_CONSOLE_DIR',
  'consoleDir',
  IS_SEA ? path.join(EXE_DIR, 'console') : path.join(ROOT, 'console'),
);
const OUT = pick('MOLLY_OUT_DIR', 'outDir', path.join(ROOT, 'out')); // watchdog 鏃ュ織/鐘舵€併€佷簩缁寸爜
const TOOLS = path.join(ROOT, 'tools');
// 鐪嬫澘鏁版嵁鏈嶅姟锛?9391锛夌殑鍏ュ彛锛氭帶鍒跺彴鍙戠幇瀹冧笉鍙揪鏃朵細灏濊瘯鎷夎捣锛?026-10-27锛岄噸鍚悗甯歌鈥滄暟鎹湇鍔?19391 涓嶅彲杈锯€濓級
const PANEL_DATA_JS = path.join(TOOLS, 'panel-data.mjs');
// 鐩戝惉鍦板潃锛氶粯璁ゅ彧鍚湰鏈哄洖鐜紙榛樿鍊间笉鍙橈級锛涜瀵瑰缃戝崱寮€鏀捐 MOLLY_CONSOLE_HOST=0.0.0.0
const HOST = pick('MOLLY_CONSOLE_HOST', 'host', '1<REDACTED>');
const PORT = Number(pick('MOLLY_CONSOLE_PORT', 'port', 19392)) || 19392;
// 鎺у埗鍙扮増鏈細浠ユ彃浠?package.json 涓哄敮涓€鐪熸簮锛屽埆鍦ㄨ繖閲屽啓姝伙紙2026-10-25 涓讳汉 m03522锛?// 宸︿笅瑙掍竴鐩存樉绀?v1.0.0 灏辨槸杩欎竴琛屽啓姝荤殑锛涘彂甯冪増鏈笌鎻掍欢鐗堟湰浠庢鑷姩鍚屾锛夈€?// exe 妯″紡璇讳笉鍒?package.json 鏃堕€€鍥?FALLBACK_VERSION锛屼繚璇佹墦鍖呯増涔熸湁鐗堟湰鍙枫€?const FALLBACK_VERSION = '1.1.6-Hotfix.1';
const VERSION = (() => {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(ROOT, 'plugin', 'dsh-qq-whale', 'package.json'), 'utf8'),
    );
    const v = String(pkg.version || '').trim();
    if (v) return v;
  } catch {
    /* 璇讳笉鍒板氨鐢ㄥ厹搴曞€硷紝涓嶉樆鏂惎鍔?*/
  }
  return FALLBACK_VERSION;
})();

// 閴存潈锛氶粯璁ゅ叧闂紙鏈満鍏嶉壌鏉冿紝琛屼负涓嶅彉锛夈€侻OLLY_CONSOLE_TOKEN 鏈夊€兼墠鏍￠獙璇锋眰澶?// x-molly-token 鈥斺€?鏀捐姹傚ご涓嶆斁 query锛岄伩鍏嶅瘑閽ヨ繘璁块棶鏃ュ織锛堝绾?搂7.1.3锛?const CONSOLE_TOKEN = String(pick('MOLLY_CONSOLE_TOKEN', 'token', '')).trim();

// 鈹€鈹€ 涓婃父 base锛堝叏閮ㄥ彲瑕嗙洊锛氫互鍚庢妸鎺у埗鍙版惉鍒版湇鍔″櫒鏃朵笉鐢ㄦ敼浠ｇ爜锛屽绾?搂7.2锛夆攢鈹€鈹€鈹€
const stripSlash = (s) => String(s || '').trim().replace(/\/+$/, '');

// 鏁版嵁鏈嶅姟锛堝彧璇伙紝宸插湪璺戯紝鍒姩瀹冿級
const SIDECAR = stripSlash(pick('MOLLY_SIDECAR', 'sidecar', 'http://1<REDACTED>:19391'));

// 鏁版嵁鏈嶅姟鑷剤锛?026-10-27锛夛細閲嶅惎鍚庢病浜烘媺璧?panel-data.mjs 鏃讹紝鎺у埗鍙颁富鍔ㄨˉ涓€涓€?// 30 绉掑唴鏈€澶氬皾璇曚竴娆★紱澶辫触鍙鏃ュ織锛屼笉褰卞搷鍙鎺ュ彛銆?let sidecarSpawnAt = 0;
function ensureSidecar(reason) {
  if (Date.now() - sidecarSpawnAt < 30000) return;
  sidecarSpawnAt = Date.now();
  try {
    const child = spawn(process.execPath, [PANEL_DATA_JS], {
      cwd: ROOT,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    console.log(`[console] 鏁版嵁鏈嶅姟涓嶅彲杈撅紙${reason || 'unknown'}锛夛紝宸插皾璇曟媺璧?panel-data.mjs (pid ${child.pid})`);
  } catch (e) {
    console.log('[console] 鎷夎捣 panel-data.mjs 澶辫触锛? + (e && e.message ? e.message : e));
  }
}
// NapCat WebUI锛堥渶 JWT 閴存潈锛岃濂戠害 搂6锛夆€斺€?026-10-22 璧蜂粎浣滃洖婊氬悗绔睍绀?const NAPCAT = stripSlash(pick('MOLLY_NAPCAT', 'napcat', 'http://1<REDACTED>:6099'));
// SnowLuma OneBot HTTP锛圥2 杩佺Щ鍚庣殑涓诲悗绔級銆倀oken 涓?watchdog-config.json 鐨?snowluma.token 涓€鑷淬€?// 娉ㄦ剰锛歵oken 鍙湪鏈嶅姟绔唴瀛橀噷鐢紝缁濅笉鍥炴樉缁欏墠绔€佺粷涓嶅啓鏃ュ織銆?const SNOWLUMA = stripSlash(pick('MOLLY_SNOWLUMA', 'snowluma', 'http://1<REDACTED>:3000'));
const SNOWLUMA_TOKEN = String(pick('MOLLY_SNOWLUMA_TOKEN', 'snowlumaToken', '${ONEBOT_TOKEN}')).trim();
const SNOWLUMA_WEBUI = stripSlash(pick('MOLLY_SNOWLUMA_WEBUI', 'snowlumaWebui', 'http://1<REDACTED>:5099'));
// 寮哄埗鍚庣锛氱┖ = 姣忔閮借 watchdog-config.json 鐨?backend锛堥粯璁?snowluma锛?const FORCE_BACKEND = String(pick('MOLLY_BACKEND', 'backend', '')).trim();
// DSH 瀹夸富鎻掍欢鎺ュ彛銆傜暀绌?= 杩愯鏃舵帰娴嬬鍙ｏ紙瀹夸富閲嶅惎浼氭崲绔彛锛岃涓嬫柟鎺㈡祴閫昏緫锛夛紱
// 璁句簡灏辩敤璁剧殑銆佷笉鍐嶆壂绔彛銆備袱绉嶅啓娉曢兘鏀讹細http://h:7053 鎴?http://h:7053/dsh-qq-whale
const PLUGIN_BASE = (() => {
  let s = stripSlash(pick('MOLLY_PLUGIN_BASE', 'pluginBase', ''));
  if (s.toLowerCase().endsWith('/dsh-qq-whale')) s = s.slice(0, -'/dsh-qq-whale'.length);
  return stripSlash(s);
})();

// 澶栭儴 node锛堜粎鏈満鍔ㄤ綔濡?watchdog/make-qr 鐢紱閮ㄧ讲鍒版湇鍔″櫒鍚庤繖浜涘姩浣滀細濡傚疄鎶ラ敊锛屼笉褰卞搷鍙鎺ュ彛锛?const NODE_EXE = pick(
  'MOLLY_NODE_EXE',
  'nodeExe',
  'C:\\Users\\example\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\node\\bin\\node.exe',
);
const PS_EXE = 'powershell.exe';

const WD_STATE = path.join(OUT, 'watchdog-state.json');
const WD_LOG = path.join(OUT, 'watchdog.log');
const WD_CONFIG = path.join(ROOT, 'watchdog-config.json');
const QR_PNG = path.join(OUT, 'console-qr.png');
// 绔彛琚崰鏃跺紑鐙珛绐楀彛鐢ㄧ殑娴忚鍣ㄧ敤鎴风洰褰曪紙涓?tools\open-console-window.ps1 淇濇寔涓€鑷达紝
// 杩欐牱 exe 寮€鐨勭獥鍙ｅ拰妗岄潰蹇嵎鏂瑰紡寮€鐨勬槸鍚屼竴涓獥鍙ｏ紝涓嶄細鍙犲嚭绗簩涓級銆?const BROWSER_PROFILE = path.join(OUT, 'edge-console-profile');
const STICKER_DIR = path.join(DATA, 'stickers', '瀛︽潵鐨?); // 琛ㄦ儏鍖呭浘鐗囩洰褰曪紙涓?panel-data.mjs 涓€鑷达級
const TASK_NAME = 'Molly-Watchdog';                       // Windows 璁″垝浠诲姟鍚?const LIVE = process.env.MOLLY_CONSOLE_LIVE === '1';      // 鍙湁鏄惧紡缃?1 鎵嶇湡璺戝嵄闄╁姩浣?
// 鈹€鈹€ 澶栭儴鏈嶅姟锛坱ask-57锛氶泦鎴愮粓绔噷鐨?澶栭儴鏈嶅姟绫?鍔ㄤ綔锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
// 缃戝叧鏄湰鍦板崟杩涚▼锛坵b_proxy.py锛夛紝闈㈡澘瀵嗙爜榛樿 admin锛?*瀵嗙爜涓?token 缁濅笉杩涙棩蹇?*銆?const GATEWAY = stripSlash(pick('MOLLY_GATEWAY', 'gateway', 'http://1<REDACTED>:8788'));
const GATEWAY_PASSWORD = pick('MOLLY_GATEWAY_PASSWORD', 'gatewayPassword', 'admin');
// 蹇冭烦锛氬閲?PC 寰€鏈嶅姟鍣ㄦ帹鐘舵€併€備袱涓枃浠堕兘鐢辨帹閫佸櫒缁存姢锛屾帶鍒跺彴鍙銆?const HB_STATE = path.join(OUT, 'heartbeat-state.json');
const HB_CONFIG = path.join(OUT, 'heartbeat-config.json');
// 鍒囨ā鍨嬬殑 x-molly-admin 浠ょ墝锛堢敤鎴?m39817锛氥€屾ā鍨嬪垏鎹粎闄愭帶鍒跺彴銆嶏級銆?// 蹇呴』涓庢彃浠堕厤缃?modelSwitchToken 涓€鑷达紱鎻掍欢渚х暀绌烘椂鍐欐帴鍙ｄ竴寰?403锛岃繖閲屼篃涓嶇紪閫犮€?// **缁濅笉鍐欐棩蹇椼€佺粷涓嶅洖鏄?* 鈥斺€?鍓嶇鍙細鐪嬪埌"鏈嶅姟绔繕娌￠厤缃垏妯″瀷浠ょ墝"杩欑被閫忎紶鍘熸枃銆?const MODEL_SWITCH_TOKEN = pick('MOLLY_MODEL_SWITCH_TOKEN', 'modelSwitchToken', '');

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
  'Access-Control-Allow-Headers': '*',
};

// 鈹€鈹€ 灏忓伐鍏?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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
      // 鍙灏鹃儴锛岄伩鍏嶆棩蹇楀緢澶ф椂鏁磋
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

// 甯搁噺鏃堕棿姣旇緝锛岄伩鍏嶇敤 token 闀垮害/鍓嶇紑宸紓鍋氭椂搴忎晶淇￠亾
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

// 鈹€鈹€ 涓婃父 GET锛堝甫瓒呮椂锛岀粷涓嶆姏锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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
    const msg = err && err.name === 'TimeoutError' ? `瓒呮椂 ${timeoutMs}ms` : `${(err && err.message) || err}`;
    return { ok: false, error: msg };
  }
}

// 鍙?JSON 鐨?POST锛堝涓绘彃浠剁殑鍐欐帴鍙ｇ粺涓€璧拌繖涓級
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
    const msg = err && err.name === 'TimeoutError' ? `瓒呮椂 ${timeoutMs}ms` : `${(err && err.message) || err}`;
    return { ok: false, error: msg };
  }
}

// 鈹€鈹€ 瀹夸富绔彛鎺㈡祴锛堜笉鍐欐 7053锛汥SH 閲嶅惎浼氭崲绔彛锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
// 鍓嶇 4 绉掕疆璇紝缁濅笉鑳芥瘡娆￠兘閬嶅巻绔彛锛氱粨鏋滐紙鍚?娌℃帰鍒?锛夌粺涓€缂撳瓨 30 绉掋€?const HOST_PROBE_TTL = 30_000;
const HOST_PROBE_TIMEOUT = 700;
let hostCache = { base: null, port: 0, at: 0 };
let hostProbing = null;

// 璧?PowerShell 鎷挎湰鏈?LISTEN 绔彛锛堝彧鐢ㄥ唴缃ā鍧楋紝涓嶈渚濊禆锛?function listListenPorts() {
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
      // 鐢?'exit' 鑰屼笉鏄?'close'锛歴tdout 琚噸瀹氬悜鍒版枃浠舵椂 'close' 鍙兘鍥犵閬撴湭鍏宠€岃繜杩熶笉鏉?      clearTimeout(timer);
      const ports = out
        .split(/\r?\n/)
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isInteger(n) && n >= 1024 && n <= 65535);
      finish([...new Set(ports)].sort((a, b) => a - b));
    });
  });
}

// 鎺竴涓鍙ｆ槸涓嶆槸 DSH 瀹夸富锛堣鐪熺殑杩斿洖 /state 鐨?JSON锛屼笉鏄殢渚?200锛?async function probeHost(port) {
  const r = await jget(`http://1<REDACTED>:${port}/dsh-qq-whale/state`, HOST_PROBE_TIMEOUT);
  if (!r.ok) return null;
  const d = r.data;
  if (!d || typeof d !== 'object') return null;
  if (!d.link && d.enabled === undefined) return null; // 涓嶆槸瀹夸富
  return `http://1<REDACTED>:${port}`;
}

async function discoverHostBase() {
  const tried = new Set();
  // 1) 鍏堣瘯涓婃鎺㈠埌鐨勭鍙ｏ紙瀹夸富閲嶅惎鍚庡鍗婅繕鏄畠锛?  if (hostCache.port) {
    tried.add(hostCache.port);
    const again = await probeHost(hostCache.port);
    if (again) return again;
  }
  // 2) 鍥哄畾鍏堣瘯濂戠害閲岀殑 7053
  if (!tried.has(7053)) {
    tried.add(7053);
    const direct = await probeHost(7053);
    if (direct) return direct;
  }
  // 3) 鍐嶉亶鍘?1024-65535 鐨?LISTEN 绔彛锛堝苟鍙戞帰锛屾暣浣撹€楁椂鈮堝崟娆¤秴鏃讹級
  const ports = (await listListenPorts()).filter((p) => !tried.has(p));
  if (!ports.length) return null;
  const hits = await Promise.all(ports.map((p) => probeHost(p)));
  return hits.find(Boolean) || null;
}

async function resolveHostBase() {
  // 鏄惧紡閰嶄簡 MOLLY_PLUGIN_BASE 灏辩敤瀹冿紝涓嶅啀鎵鍙ｏ紙閮ㄧ讲鍒版湇鍔″櫒鏃惰蛋杩欐潯锛?  if (PLUGIN_BASE) return PLUGIN_BASE;
  if (Date.now() - hostCache.at < HOST_PROBE_TTL) return hostCache.base; // 30 绉掑唴鐩存帴鐢ㄧ紦瀛?  if (hostProbing) return hostProbing; // 4 绉掕疆璇㈠苟鍙戞椂鍙帰涓€娆?  hostProbing = (async () => {
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

// 鈹€鈹€ /api/overview 鑱氬悎锛堝绾?搂3.2锛氫换浣曚笂娓告寕浜嗛兘杩斿洖 200锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
async function buildOverview() {
  // build 璁╁墠绔兘鍒ゆ柇鑷繁璺戠殑鏄笉鏄渶鏂板墠绔枃浠讹紙涓嶄竴鑷村氨鑷姩 reload锛?  const out = { ok: true, at: Date.now(), build: consoleBuild() };

  // 1) 鎻掍欢锛圖SH 瀹夸富 /dsh-qq-whale/state锛夆€斺€旂鍙ｅ悗缃綅锛屽厛鐢?7053
  const pluginBase = await resolveHostBase();
  if (!pluginBase) {
    out.plugin = { reachable: false, error: '娌℃帰鍒?DSH 瀹夸富绔彛锛?024-65535锛? };
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
              /* 绱 / 浠婃棩锛氭彃浠?learner.total / learner.today 鍘熸牱閫忓嚭銆?                 涓嶅湪杩欓噷绠椼€岀疮璁?= lifetime.kept銆嶏紝鍏嶅緱涓ゅ鍙ｅ緞瀵逛笉涓娿€?*/
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
              // 鍏ュ簱闂搁棬璁℃暟锛坱ask-27 鎻掍欢渚?learner.memory锛夈€傛彃浠舵病涓婄嚎杩欐鏃?              // 鏁翠釜瀵硅薄涓?null 鈥斺€?濂戠害瑕佹眰銆屾嬁涓嶅埌灏辩敤 null銆嶏紝缁濅笉缂栭€?0銆?              // queued 涓?pending 鏄袱涓暟锛歱ending 鏄€岃鎷︿簡 N 娆°€嶏紝queued 鎵嶆槸
              // 寰呮牳瀹炲尯**姝ゅ埢鐪熷疄鏈夊嚑鏉?*锛堝悓涓€鏉?24h 鍐呴噸澶嶈鎷︿細璁?pending 娑ㄨ€?queued 涓嶅彉锛夈€?              memory: s.learner.memory
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
         * 楠備汉妯″紡锛堝嚭姘旂瓛锛夋€诲紑鍏炽€傚瓧娈垫潵鑷彃浠剁殑 pest 蹇収锛坱ask-36锛夈€?         * 鎷夸笉鍒版暣鍧?null 鈥斺€?鎺у埗鍙颁笉鑳藉洜涓?鐚滀竴涓?false"灏辨樉绀烘垚鍏崇潃锛?         * 閭ｄ細璁╀富浜轰互涓鸿嚜宸卞叧鎺変簡锛屽疄闄呰繕鍦ㄩ獋銆?         */
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

      /* 缇ゆ暟锛氭彃浠?/state 鍙姤 bot 韬唤锛岀兢鍒楄〃瑕佸幓 SnowLuma 鐨?get_group_list 鎷裤€?         鎷夸笉鍒板氨淇濇寔 null 鈥斺€?鍓嶇鏄剧ず銆屸€斻€嶏紝缁濅笉缂栭€?0銆?*/
      if (out.plugin.bot) {
        try {
          const gl = await snowlumaAction('get_group_list', {}, 2000);
          const list = gl && gl.retcode === 0 && Array.isArray(gl.data) ? gl.data : null;
          if (list) out.plugin.bot.groupCount = list.length;
        } catch {
          /* 鎺㈡祴澶辫触涓嶆嫋绱€昏锛氳繖涓€椤圭暀绌哄嵆鍙?*/
        }
      }
    }
  }

  // 2) 鏁版嵁鏈嶅姟锛?9391锛屽彧璇伙紝鍒姩瀹冿級锛涗笉鍙揪鏃堕『鎵嬫媺璧蜂竴娆″啀閲嶈瘯
  let sd = await jget(`${SIDECAR}/api/all`, 1500);
  if (!sd.ok) {
    ensureSidecar(sd.error);
    // panel-data 浠?spawn 鍒?listen 閫氬父 1鈥? 绉掞紝鍗曟 700ms 閲嶈瘯寰€寰€鎶笉鍒帮紱鍒嗕笁妗ｇ瓑
    for (const wait of [700, 900, 1200]) {
      await new Promise((r) => setTimeout(r, wait));
      sd = await jget(`${SIDECAR}/api/all`, 2500);
      if (sd.ok) break;
    }
  }
  if (!sd.ok) {
    out.sidecar = { reachable: false, error: sd.error };
  } else {
    const d = sd.data || {};
    out.sidecar = { reachable: true, ...d };
  }

  /* 璁板繂鏉℃暟鍏滃簳锛氭暟鎹湇鍔★紙19391锛夎鐨勬槸 memory.md 鏄庢枃锛岃蹇嗗姞瀵嗗悗瀹冭涓嶅埌锛?     count 浼氭槸绌虹殑銆傝繖閲岀敤鎻掍欢渚?memory.count 琛ヤ笂锛屽苟鏍?source=plugin锛?     鍙仛灞曠ず銆佷笉钀界洏銆?*/
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

  // 3) QQ 瀹㈡埛绔帰娴嬶紙SnowLuma 璧?OneBot HTTP 3000锛涘洖婊氬悗绔?NapCat 璧?WebUI 6099銆?  //    token/secret 缁濅笉钀芥棩蹇楋級
  out.napcat = await buildNapcat();

  // 3.5) QQ 閾捐矾鑱氬悎锛?026-10-25锛夛細涓讳緷鎹?= 鎻掍欢妗ユ帴锛屾渚濇嵁 = QQ 瀹㈡埛绔帰娴嬨€?  //    out.napcat 鍘熸牱淇濈暀鍋氬吋瀹癸紱鍓嶇鏂伴€昏緫浼樺厛璇?out.qq銆?  out.qq = await buildQqStatus(out.plugin, out.napcat);

  // 4) 瀹堟姢锛堟湰鍦版枃浠?+ 璁″垝浠诲姟鐘舵€侊級
  out.watchdog = await buildWatchdog();

  return out;
}

// 鈹€鈹€ 鍚庣閫夋嫨锛歸atchdog-config.json 鐨?backend锛堥粯璁?snowluma锛屽彲鍒囧洖 napcat 鍥炴粴锛夆攢鈹€
function currentBackend() {
  if (FORCE_BACKEND === 'napcat' || FORCE_BACKEND === 'snowluma') return FORCE_BACKEND;
  const cfg = readJson(WD_CONFIG, null);
  return cfg && cfg.backend === 'napcat' ? 'napcat' : 'snowluma';
}

// 鈹€鈹€ NapCat锛歅OST CheckLoginStatus锛圝WT 鏋勯€犺濂戠害 搂6锛屼笉鎵撳嵃 token锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
function napcatBearer() {
  const SECRET = process.env.NAPCAT_WEBUI_JWT_SECRET_KEY || '${NAPCAT_JWT_SECRET}';
  const TOKEN = '${NAPCAT_TOKEN}';
  const hash = crypto.createHash('sha256').update(TOKEN + '.napcat').digest('hex');
  const data = { CreatedTime: Math.floor(Date.now() / 1000), HashEncoded: hash };
  const hmac = crypto.createHmac('sha256', SECRET).update(JSON.stringify(data), 'utf8').digest('hex');
  return Buffer.from(JSON.stringify({ Data: data, Hmac: hmac })).toString('base64');
}

// 鈹€鈹€ SnowLuma锛歄neBot v11 HTTP 鍔ㄤ綔锛坱oken 鍙蛋璇锋眰澶达紝姘镐笉鍥炴樉锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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
  if (!j || typeof j.retcode !== 'number') throw new Error(`HTTP ${r.status}锛圤neBot 搴旂瓟涓嶅彲瑙ｆ瀽锛塦);
  return j;
}

/**
 * SnowLuma 鐘舵€佹帰娴嬶紙杩斿洖褰㈢姸涓?NapCat 鐗堝吋瀹癸紝鍓嶇瀛楁鍚嶄笉鍙橈級銆? * 涓夊眰锛歡et_login_info锛堣繛閫?+ 璐﹀彿锛夆啋 get_status.online锛堢櫥褰曟€侊級鈫?get_csrf_token锛堟繁搴︽帰娴嬶級銆? * 涓轰粈涔堣鏈夋繁搴︽帰娴嬶細SnowLuma 涔熷彲鑳姐€屽亣鍦ㄧ嚎銆嶁€斺€攇et_status 璇?online 浣嗘湇鍔＄鐧诲綍鎬? * 宸茬粡浣滃簾锛?0-22 11:30 鐨?NapCat 浜嬫晠鍚屽瀷锛夛紱get_csrf_token 闇€瑕佹湇鍔＄寰€杩旓紝鑳芥毚闇插嚭鏉ャ€? */
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
    // SnowLuma 鎶婂鎴风鍒楄〃鍖呭湪 data.clients 閲岋紙NapCat 鍏煎鎺ュ彛鍘嗗彶涓婃斁鍦?data 鐩存帴鎴愭暟缁勶級
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

// 鈹€鈹€ QQ 閾捐矾鑱氬悎锛氫富渚濇嵁 = 鎻掍欢妗ユ帴锛屾渚濇嵁 = QQ 瀹㈡埛绔帰娴?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
/*
 * 2026-10-25 涓讳汉纭鐨勫垽瀹氫紭鍏堢骇锛堥儴缃茶€呭弽棣堬細QQ 鏄庢槑鍦ㄨ窇锛屾帶鍒跺彴鍗存樉绀烘湭杩炴帴锛夛細
 *   - 鎻掍欢 /state.link.state === 'online' 鈬?Molly 宸茬粡杩炰笂 OneBot锛孮Q 閾捐矾鏄€氱殑銆? *   - QQ 瀹㈡埛绔?WebUI 鎺㈡祴鍙洖绛斻€屽鎴风杩涚▼鍦ㄤ笉鍦ㄣ€嶏紝**涓嶈兘**鎷挎潵鍒ゃ€屾湭杩炴帴銆嶃€? * 鍥涚缁勫悎锛坙evel锛夛細connected / bridge-only / client-only / offline锛? * 鏂囨涓庛€屼笅涓€姝ャ€嶅缓璁兘鏀捐繖閲岋紝鍓嶇鍙彇锛岄伩鍏嶄袱澶勬枃妗堟紓绉汇€? * 浠ュ墠璇姤鐨勫師鍥狅細鍓嶇鍙湁 napcat 鍧楋紙瀹㈡埛绔帰娴嬶級锛屾嬁瀹冨綋涓讳緷鎹紝
 * 瀹㈡埛绔帰娴嬪け璐ュ氨鐩存帴鏄剧ず鏈櫥褰曪紝鎶娿€屾彃浠跺凡鍦ㄧ嚎銆嶈繖涓洿寮虹殑璇佹嵁鐩栨帀浜嗐€? */

// 瀹㈡埛绔帰娴嬬紦瀛橈細4 绉掕疆璇笅涓嶈兘姣忚疆閮界瓑涓€娆¤繛鎺ヨ秴鏃讹紙涓嶅彲杈炬椂灏ゅ叾鎱級銆?const clientProbeCache = { key: '', at: 0, reachable: false };
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
    // 鍙 HTTP 鏈夊簲绛斿氨绠楄繘绋嬫椿鐫€锛歐ebUI 瑕侀壌鏉冩椂 401/403 涔熺畻鍙揪銆?    const r = await fetch(url + '/', {
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
  // 瀹㈡埛绔繘绋嬬殑涓ょ璇佹嵁锛歐ebUI 鑳藉簲绛旓紝鎴?OneBot HTTP 宸茬粡鍥炶繃璇?  //锛堝洖杩囪瘽璇存槑 SnowLuma 杩涚▼娲荤潃锛屽摢鎬?QQ 杩樻病鐧诲綍锛夈€備换涓€鎴愮珛閮界畻銆岃繘绋嬪彲杈俱€嶃€?  const webuiOk = await probeClientWebui();
  const clientReachable = webuiOk || !!(napcat && napcat.reachable === true);
  const clientLogin = !!(napcat && napcat.isLogin === true);
  const level = bridgeOnline
    ? (clientReachable ? 'connected' : 'bridge-only')
    : (clientReachable ? 'client-only' : 'offline');
  const text = {
    connected: 'Molly 宸茶繛鎺?QQ',
    'bridge-only': 'Molly 宸茶繛鎺?QQ锛堝鎴风鐘舵€佷俊鎭笉鍙敤锛?,
    'client-only': 'QQ 鍦ㄨ繍琛岋紝浣?Molly 杩樻病杩炰笂',
    offline: 'QQ 鏈繛鎺?,
  }[level];
  const nextStep = {
    connected: '',
    'bridge-only': '閾捐矾宸查€氾紝娑堟伅鑳芥甯告敹鍙戝氨涓嶇敤绠★紱鎸佺画寮傚父鍘汇€岃繍缁淬€嶇湅鏃ュ織銆?,
    'client-only': '鍒般€屾墽琛屽潡銆嶇偣銆岄噸鏂版鏌ヨ繛鎺ャ€嶏紱鍒氶噸鍚繃 QQ 灏辩瓑 10~25 绉掑啀鍒锋柊锛屾垨鍘汇€屽畧鎶ゃ€嶇湅 watchdog 缁撹銆?,
    offline: '鐐广€岄噸鏂扮櫥褰?QQ锛堟壂鐮侊級銆嶏紙銆孮Q 杩炴帴銆嶉〉锛屾垨鎬昏椤电殑鎻愮ず鏉★級銆?,
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
    backendName: backend === 'snowluma' ? 'SnowLuma' : '鍥炴粴鍚庣锛圢apCat锛?,
    webui: backend === 'snowluma' ? SNOWLUMA_WEBUI : NAPCAT,
    uin: (napcat && napcat.uin) || (plugin && plugin.bot && plugin.bot.userId) || null,
    nickname: (napcat && napcat.nickname) || (plugin && plugin.bot && plugin.bot.nickname) || null,
    // 璇箟锛歈Q 閾捐矾褰撳墠鑳戒笉鑳界敤锛堟ˉ鎺ヤ紭鍏堬紱瀹㈡埛绔湪绾夸笖宸茬櫥褰曚篃绠楋級
    isLogin: bridgeOnline || (clientReachable && clientLogin),
    napcat: napcat || null, // 鏃у瓧娈靛師鏍峰甫涓€浠斤紝鍏煎浠嶈 ov.qq.napcat 鐨勮皟鐢ㄦ柟
    at: Date.now(),
  };
}

// 鈹€鈹€ 瀹堟姢锛氱姸鎬?閰嶇疆璇绘枃浠讹紝quiet 鐢遍厤缃畻锛宼askEnabled 鏌ヨ鍒掍换鍔?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
function inQuietHours(cfg, at = new Date()) {
  const q = cfg && Array.isArray(cfg.quietHours) ? cfg.quietHours : null;
  if (!q || q.length !== 2) return false;
  const [from, to] = q;
  const h = at.getHours();
  if (!isNum(from) || !isNum(to)) return false;
  return from <= to ? h >= from && h < to : h >= from || h < to;
}

// watchdog.log 姣忚褰㈠ `2026-10-18 23:20:01 妫€鏌? online -> online phase=ready`
// 鍒ゅ畾锛氬惈 FAIL / 閫€鍑虹爜闈?0 / 鎶慨澶辫触 鎵嶇畻澶辫触锛涙甯稿贰妫€琛岀畻鎴愬姛銆?// 锛堟棫瀹炵幇鍙瑙佸埌銆屾鏌ャ€嶅氨杩斿洖 1锛屽鑷村畧鎶ゆ案杩滄樉绀恒€屼笂娆″け璐ャ€嶏紝宸蹭慨锛?function lastWatchdogLine(text) {
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
  if (/\bNOTIFY_FAIL\b|澶辫触|\bFAIL\b|閫€鍑虹爜 [1-9]/.test(body)) lastResult = 1;
  else if (/^(妫€鏌鎶慨|NOTIFY|椋庢帶闈欓粯鏈?/.test(body)) lastResult = 0;
  else lastResult = null;
  return { lastRun, lastResult, tail: line.slice(0, 400) };
}

async function buildWatchdog() {
  const state = readJson(WD_STATE, null);
  const raw = readJson(WD_CONFIG, null);
  // 閰嶇疆閲岀殑 token 缁濅笉鑳芥紡鍑哄幓
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
          // 鍓嶇銆岃窛涓婃宸℃銆嶈鐢紱涔嬪墠婕忎紶瀵艰嚧椤甸潰鏄剧ず銆屸€斻€?          lastCheckAt: isNum(state.lastCheckAt) ? state.lastCheckAt : 0,
        }
      : null,
    config,
    quiet: inQuietHours(config),
    taskEnabled,
    lastRun,
    lastResult,
  };
}

// 璁″垝浠诲姟鏄惁鍚敤锛堟煡璇㈠け璐ヨ繑鍥?null锛屼笉瑕佸亣瑁呮湁鍊硷級
// 鐢?Get-ScheduledTask 鑰屼笉鏄?schtasks锛氬悗鑰呭湪涓枃绯荤粺杈撳嚭 GBK锛孨ode 璇诲嚭鏉ユ槸涔辩爜銆?// 缁撴灉缂撳瓨 30 绉掆€斺€? 绉掕疆璇笉璇ユ瘡娆￠兘 spawn 涓€涓?PowerShell銆?const TASK_CACHE_TTL = 30_000;
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

// 鈹€鈹€ 闈欐€佽祫婧愶紙濂戠害 搂2锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

// 闈欐€佽矾鐢辩櫧鍚嶅崟锛氬彧鏀捐繖涓変釜 + favicon锛屽埆鐨勪竴寰?404锛堥槻姝换鎰忔枃浠惰鍙栵級
const STATIC_ROUTES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/console.js': 'console.js',
  '/console.css': 'console.css',
};

// 鈹€鈹€ 鍓嶇鏋勫缓鏍囪瘑锛堟瘡娆¤姹傜幇绠楋紝缁濅笉缂撳瓨姝伙級鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
// 涓轰粈涔堥渶瑕侊細娴忚鍣ㄩ噷闀挎湡寮€鐫€鐨勬帶鍒跺彴绐楀彛涓嶄細鍥犱负鍓嶇鏂囦欢鏇存柊鑰岃嚜鍔ㄥ姞杞芥柊浠ｇ爜锛?// 姣忔鏀瑰墠绔兘寰椾汉宸?Ctrl+F5锛岃繖涓潙浼氬弽澶嶅鍙戙€?// 鍋氭硶锛氭妸 console.js/console.css 鐨?mtime+size 鎻夋垚 8 浣嶇煭鍝堝笇 鈫?闈欐€佽祫婧愬姞 ?v=<build>銆?// index.html 閲屾敞鍏?window.__MOLLY_BUILD__锛屽墠绔疆璇?/api/overview 鏃舵瘮瀵?build锛?// 涓嶄竴鑷村氨鑷姩 reload 涓€娆°€備换涓€鏂囦欢缂哄け鏃惰繑鍥?'0'锛堝墠绔鍒?'0' 涓嶅姩浣滐級銆?function consoleBuild() {
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
  // favicon 涓嶉渶瑕佹枃浠讹紝鐩存帴 204
  if (urlPath === '/favicon.ico') {
    res.writeHead(204, CORS);
    return res.end();
  }

  // STATIC_ROUTES 鍙绮剧‘璺緞锛屾墍浠??v=<build> 杩欑被鏌ヨ涓插繀椤诲厛鍓ユ帀鍐嶅尮閰?  let relPath = urlPath;
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
    // 鍓嶇杩樻病浜у嚭锛?03 + 鏄庣‘鎻愮ず锛堝绾?搂3 闈欐€佹枃浠朵笉瀛樺湪 鈫?503锛?    const msg =
      `鎺у埗鍙板墠绔枃浠惰繕娌＄敓鎴愶細${full}\n` +
      `璇风瓑 console-ui 浜у嚭 console/index.html銆乧onsole.js銆乧onsole.css 鍚庡埛鏂版湰椤点€俓n` +
      `鏈嶅姟绔紙鏈繘绋嬶級宸插氨缁紝鎺ュ彛鍙敤锛?api/health銆?api/overview銆俙;
    if (rel.endsWith('.html')) {
      return sendBuffer(
        res,
        503,
        Buffer.from(
          `<!doctype html><meta charset="utf-8"><title>鎺у埗鍙板墠绔湭灏辩华</title>` +
            `<body style="font:14px/1.7 system-ui;padding:40px;color:#333">` +
            `<h2 style="margin:0 0 12px">鎺у埗鍙板墠绔繕娌＄敓鎴?/h2>` +
            `<pre style="white-space:pre-wrap;background:#f7f6f3;border:1px solid #e5e3df;` +
            `border-radius:8px;padding:12px">${msg.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre>` +
            `</body>`,
          'utf8'
        ),
        'text/html; charset=utf-8',
        'no-store'
      );
    }
    return sendJson(res, 503, { ok: false, error: '鍓嶇鏂囦欢杩樻病鐢熸垚', path: full });
  }

  // index.html锛氭敞鍏ユ瀯寤烘爣璇?+ 缁欓潤鎬佽祫婧愬姞 ?v=<build>锛堟湇鍔＄鏀瑰啓锛屾枃浠舵湰韬笉鍔級
  let outBuf = buf;
  if (rel.endsWith('.html')) {
    const build = consoleBuild();
    let html = buf.toString('utf8');
    // 1) 鑰佸啓娉曪紙index.html 鐩墠灏辨槸 "href=\"/console.css\"" / "src=\"/console.js\""锛?    html = html.replace('"/console.css"', `"/console.css?v=${build}"`);
    html = html.replace('"/console.js"', `"/console.js?v=${build}"`);
    // 2) 鍏滃簳锛氬崟寮曞彿/鏃犲紩鍙风瓑鍏跺畠鍐欐硶涔熻ˉ涓婏紙宸插甫 ? 鐨勪笉閲嶅鍔狅紝鎵€浠ュ彲閲嶅鎵ц锛?    html = html.replace(/(["'])(\/console\.css)(?!\?)/g, `$1$2?v=${build}`);
    html = html.replace(/(["'])(\/console\.js)(?!\?)/g, `$1$2?v=${build}`);
    // 3) 娉ㄥ叆 window.__MOLLY_BUILD__锛堝繀椤诲湪 console.js 涔嬪墠璺戯紝鏀?</head> 鍓嶆渶绋筹級
    const marker = `<script>window.__MOLLY_BUILD__="${build}";</script>`;
    if (html.includes('</head>')) html = html.replace('</head>', marker + '\n</head>');
    else if (html.includes('<head>')) html = html.replace('<head>', '<head>\n' + marker);
    else html = marker + '\n' + html;
    outBuf = Buffer.from(html, 'utf8');
  }

  const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
  // 闈欐€佽祫婧愪竴寰?no-store锛氶厤鍚??v=<build>锛屽交搴曟柇鎺夋祻瑙堝櫒缂撳瓨鏃?console.js 鐨勫彲鑳?  return sendBuffer(res, 200, outBuf, type, 'no-store');
}

// 鈹€鈹€ 鍚姩涓夋€佺殑鎺㈤拡锛坱ask-31锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
// 涓轰粈涔堛€屽厛鎺㈠啀 listen銆嶈€屼笉鏄瓑 EADDRINUSE锛歐indows 鐨?EADDRINUSE 鍙湁涓€涓?errno锛?// 鎷夸笉鍒板崰鐢ㄨ€?pid锛屼篃鍒嗕笉娓呭崰鐢ㄨ€呮槸銆屾垜浠嚜宸辩殑鍙︿竴涓疄渚嬨€嶈繕鏄埆浜虹殑绋嬪簭銆?// 鍏堟帰灏辫兘鍦ㄥ惎鍔ㄥ墠缁欏嚭鍙銆佸彲鎵ц鐨勬彁绀猴紝鑰屼笖鏁翠釜杩囩▼闆跺壇浣滅敤锛堜笉 kill銆佷笉鏀规枃浠讹級銆?// 娉ㄦ剰锛氳繖涓€娈靛湪妯″潡椤跺眰鎵ц锛屾棭浜庝笅闈?errText 鐨?const 鍒濆鍖栵紙TDZ锛夛紝鎵€浠ヨ嚜甯︿竴涓牸寮忓寲鍑芥暟銆?const eText = (e) => (e && e.message ? e.message : String(e));

// 鐩戝惉鍦板潃鏄€氶厤鍦板潃锛?.0.0.0 / ::锛夋椂锛屾湰鏈鸿嚜鎺㈣璧板洖鐜紝涓嶇劧鏌愪簺绯荤粺涓?connect 涓嶅嚭鍘汇€?const PROBE_HOST = (HOST === '0.0.0.0' || HOST === '::' || HOST === '') ? '1<REDACTED>' : HOST;
const SELF_URL = `http://${PROBE_HOST}:${PORT}/`;

// 杩炰竴涓嬬湅鏈夋病鏈変汉鍦ㄥ惉銆傝繛涓?琚崰锛涙嫆缁?瓒呮椂=绌洪棽銆?function portIsFree(port, host) {
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
    sock.once('error', () => finish(true)); // ECONNREFUSED 绛夛細娌′汉鐩戝惉
  });
}

// 鏄笉鏄€屾垜浠嚜宸辩殑鎺у埗鍙般€嶏細濂戠害鍒ゆ嵁 = 200 + ok:true + 鏈?version 瀛楁銆?// 涓夋潯缂轰竴鏉￠兘涓嶈锛堟瘮濡傚埆鐨勭▼搴忎篃鍥?200 鐨?JSON锛屼絾娌℃湁 version锛夈€?async function probeExistingConsole(port, host) {
  const r = await fetchJson(`http://${host}:${port}/api/health`, {}, 1500);
  if (!r || r.status !== 200 || !r.data || typeof r.data !== 'object') return null;
  const d = r.data;
  if (d.ok !== true) return null;
  if (typeof d.version !== 'string' || !d.version.trim()) return null;
  return d;
}

// 鍗犵鍙ｇ殑杩涚▼鍙凤細Windows 鐢?netstat -ano 瑙ｆ瀽锛堢姸鎬佸垪 LISTENING 鏄?ASCII锛屼笉鍙楃郴缁熻瑷€褰卞搷锛夈€?// 闈?Windows 鎴栬В鏋愬け璐ヤ竴寰嬭繑鍥?null 鈥斺€?鎷夸笉鍒板氨涓嶇紪閫犮€?function portOwnerPid(port) {
  if (process.platform !== 'win32') return null;
  try {
    const r = spawnSync('netstat.exe', ['-ano', '-p', 'TCP'], {
      encoding: 'utf8', timeout: 4000, windowsHide: true,
    });
    const out = String((r && r.stdout) || '');
    for (const line of out.split(/\r?\n/)) {
      // 褰㈠锛? TCP    1<REDACTED>:19392    0.0.0.0:0    LISTENING    37528
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (m && Number(m[1]) === Number(port)) return Number(m[2]);
    }
  } catch { /* ignore */ }
  return null;
}

// pid 瀵瑰簲鐨勮繘绋嬪悕锛堟嬁涓嶅埌杩斿洖 null锛屽彧鐢ㄤ簬鎻愮ず鏇村ソ璇伙級
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

// 鎵炬祻瑙堝櫒锛氶『搴忎笌 tools\open-console-window.ps1 涓€鑷达紙Edge 浼樺厛锛屽叾娆?Chrome锛?function findBrowser() {
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

// 鐢?--app 寮€鐙珛绐楀彛銆倁ser-data-dir 涓庢闈㈠揩鎹锋柟寮忓叡鐢ㄥ悓涓€涓?profile锛?// 鍥犳涓嶄細鍜岀敤鎴锋棩甯告祻瑙堢殑绐楀彛娣峰湪涓€璧凤紝涔熶笉浼氬紑鍑虹浜屼釜銆孧olly 鎺у埗鍙般€嶇獥鍙ｃ€?//
// 韪╄繃鐨勫潙锛歴pawn 瀹岀珛鍒?process.exit 鐨勮瘽锛屾柊绐楀彛**寮€涓嶅嚭鏉?*銆傚疄娴嬶紙node spawn msedge --app锛夛細
//   绔嬪埢閫€鍑?鈫?鏂板绐楀彛 0锛涚瓑 1200ms 鍐嶉€€ 鈫?鏂板绐楀彛 1銆?// 鍘熷洜鏄?Edge 鐨勫惎鍔ㄥ櫒瑕佸厛鎶婄湡姝ｇ殑 browser 杩涚▼鎷夎捣鏉ワ紝鐖惰繘绋嬫彁鍓嶉€€鍑轰細璁╄繖鏉￠摼璺柇鎺夈€?// 鎵€浠?openAppWindow 涔嬪悗璋冪敤鏂瑰繀椤荤瓑 OPEN_SETTLE_MS 鍐嶉€€锛堣 handleOccupiedPort锛夈€?const OPEN_SETTLE_MS = 1500;
function openAppWindow(url) {
  const browser = findBrowser();
  if (!browser) return { opened: false, reason: '娌℃壘鍒?Edge / Chrome' };
  try {
    fs.mkdirSync(BROWSER_PROFILE, { recursive: true });
  } catch { /* 寤轰笉寤哄緱鍑烘潵閮界户缁瘯 */ }
  const args = [
    `--app=${url}`,
    `--user-data-dir=${BROWSER_PROFILE}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1120,900',
  ];
  try {
    // 涓嶇敤 detached锛歞etached 鍦?Windows 涓婁細鍙︾粰瀛愯繘绋嬮厤涓€涓帶鍒跺彴绐楀彛锛?    // 鑰屻€屼笉寮归粦妗嗐€嶆槸纭害鏉熴€傚疄娴?detached 鍙嶈€屽紑涓嶅嚭绐楀彛锛堣涓婇潰鐨勫鐓у疄楠岋級銆?    const child = spawn(browser, args, { stdio: 'ignore', windowsHide: true });
    child.unref();
    return { opened: true, browser, pid: child.pid };
  } catch (err) {
    return { opened: false, browser, reason: eText(err) };
  }
}

// 鈹€鈹€ 鍚姩 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
// 鍛戒护琛岋細--version / -v 鍙墦鍗扮増鏈€€鍑猴紙鎵撳寘鎴?exe 鍚庣敤瀹冪‘璁ゆ枃浠舵病鍧忥級锛?// --help / -h 鎵撳嵃閰嶇疆璇存槑銆傛甯稿惎鍔ㄦ椂涓嶆秷璐逛换浣曞弬鏁般€?const ARGV = process.argv.slice(2);
if (ARGV.includes('--version') || ARGV.includes('-v')) {
  console.log(`molly-console ${VERSION}${IS_SEA ? ' (sea)' : ''}`);
  console.log(`node ${process.version} / ${process.platform}-${process.arch}`);
  console.log(`exec ${process.execPath}`);
  console.log(`consoleDir ${CONSOLE_DIR}`);
  console.log(`config ${CONFIG_FILE}${fs.existsSync(CONFIG_FILE) ? '' : ' (涓嶅瓨鍦紝鐢ㄩ粯璁ゅ€?'}`);
  process.exit(0);
}
if (ARGV.includes('--help') || ARGV.includes('-h')) {
  console.log(`molly-console ${VERSION} 鈥斺€?Molly 鎺у埗鍙版湇鍔＄

鐢ㄦ硶锛?  molly-console.exe            鎸?console.json + 鐜鍙橀噺鍚姩
  molly-console.exe --version  鎵撳嵃鐗堟湰鍜岀敓鏁堣矾寰?  molly-console.exe --help     鏈鏄?
閰嶇疆鏂囦欢锛堝彲閫夛級锛歟xe 妯″紡 <exe 鍚岀骇>\\console.json锛涙簮鐮佹ā寮?tools\\console.json锛堣剼鏈悓绾э級
                  閿悕瑙?console.example.json锛涘綋鍓嶈锛?{CONFIG_FILE}
鐜鍙橀噺锛堜紭鍏堢骇鏈€楂橈級锛?  MOLLY_CONSOLE_HOST / MOLLY_CONSOLE_PORT / MOLLY_CONSOLE_TOKEN
  MOLLY_CONSOLE_DIR  鍓嶇闈欐€佺洰褰曪紙榛樿 <exe鍚岀骇>\\console锛?  MOLLY_CONSOLE_CONFIG  閰嶇疆鏂囦欢璺緞锛堣鐩栦笂闈袱涓粯璁や綅缃級
  MOLLY_PLUGIN_BASE / MOLLY_SIDECAR / MOLLY_NAPCAT
  MOLLY_ROOT / MOLLY_DATA_DIR / MOLLY_OUT_DIR  鏈満璺緞瑕嗙洊

褰撳墠鐢熸晥锛?  ${HOST}:${PORT}  鍓嶇=${CONSOLE_DIR}
  鎻掍欢=${PLUGIN_BASE || '(杩愯鏃惰嚜鍔ㄦ帰娴?1024-65535)'}  鏁版嵁=${SIDECAR}  NapCat=${NAPCAT}`);
  process.exit(0);
}

// 鍚姩鑷锛氬墠绔洰褰?鍏ュ彛鏂囦欢缂哄け鏃舵墦鍗版竻鏅版寚寮曪紝鑰屼笉鏄鐢ㄦ埛鐪嬪埌鐧藉睆銆?// 娉ㄦ剰涓?exit 鈥斺€?鎺ュ彛锛?api/health 绛夛級浠嶅彲鐢紝绗﹀悎鍘熴€屼笂娓告寕鎺変篃瑕佽兘璇婃柇銆嶇殑璁捐銆?(function preflight() {
  const entry = path.join(CONSOLE_DIR, 'index.html');
  if (fs.existsSync(entry)) return;
  console.log('');
  console.log(`[console] 鈿?鎵句笉鍒板墠绔叆鍙ｏ細${entry}`);
  console.log(`[console]   璇锋妸 console/ 鐩綍锛坕ndex.html銆乧onsole.js銆乧onsole.css锛夋斁鍒帮細`);
  console.log(`[console]      ${CONSOLE_DIR}`);
  console.log(`[console]   鎴栫敤 MOLLY_CONSOLE_DIR / console.json 鐨?consoleDir 鎸囧悜鍒銆俙);
  console.log(`[console]   鐜板湪鍙湁鎺ュ彛鍙敤锛?api/health銆?api/overview锛夛紝缃戦〉浼?503銆俙);
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

// 鍙屽嚮 exe 鍑洪棶棰樻椂绐楀彛浼氱灛闂存秷澶憋紝鐢ㄦ埛浠€涔堥兘鐪嬩笉鍒般€傚彧鏈夊湪鐪熸杩炵潃浜や簰寮忔帶鍒跺彴鏃舵墠鍋滀竴涓嬨€?// 琚?Start-Process 閲嶅畾鍚?/ 璁″垝浠诲姟 / 绠￠亾鎷夎捣鏃?stdin 涓嶆槸 TTY锛岃繖閲岀珛鍒昏繑鍥烇紝涓嶄細鎸備綇鑷姩鍖栥€?function pauseIfInteractive(ms = 30000) {
  if (!process.stdin || !process.stdin.isTTY) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const fin = () => {
      if (done) return;
      done = true;
      try { process.stdin.pause(); } catch { /* ignore */ }
      resolve();
    };
    process.stdout.write('鎸夊洖杞﹂敭鍏抽棴绐楀彛鈥?);
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

// 绔彛宸茶鍗犵敤鏃剁殑鍒ゅ畾涓庢敹灏撅細鍙兘銆屽凡缁忓湪璺戙€嶄篃鍙兘銆岃鍒殑绋嬪簭鍗犱簡銆嶃€?// 涓ょ鎯呭喌閮戒笉纰板崰鐢ㄨ€呯殑杩涚▼锛屽彧鍐冲畾閫€鍑虹爜銆?async function handleOccupiedPort() {
  const health = await probeExistingConsole(PORT, PROBE_HOST);
  if (health) {
    console.log(`鎺у埗鍙板凡缁忓湪杩愯锛?{SELF_URL}锛堟湰娆′笉鍐嶅惎鍔紝鐩存帴缁欎綘寮€绐楀彛锛塦);
    const r = openAppWindow(SELF_URL);
    if (r.opened) {
      console.log(`[console] 宸茬敤 ${path.basename(r.browser)} 鎵撳紑鐙珛绐楀彛锛坧id=${r.pid}锛塦);
      // 蹇呴』绛夌獥鍙ｇ湡姝ｅ紑鍑烘潵鍐嶉€€锛氱珛鍒婚€€浼氳 Edge 杩欐潯鍚姩閾捐矾鏂帀锛岀獥鍙ｆ牴鏈笉鍑恒€?      // 瀹炴祴 1200ms 澶熺敤锛岃繖閲岀暀 1500ms 瀵屼綑锛泂tdin 闈?TTY 鏃舵病鏈夐澶栫瓑寰咃紝涓嶅奖鍝嶈嚜鍔ㄥ寲銆?      await new Promise((resolve) => setTimeout(resolve, OPEN_SETTLE_MS));
    } else {
      console.log(`[console] 娌¤兘鑷姩寮€绐楋紙${r.reason}锛夛紝璇锋墜鍔ㄦ墦寮€锛?{SELF_URL}`);
    }
    return 0;
  }

  const pid = portOwnerPid(PORT);
  const pname = pid ? processNameOf(pid) : null;
  console.log(`绔彛 ${PORT} 琚埆鐨勭▼搴忓崰浜嗭紙pid=${pid ?? '鏈煡'}锛岃鎺у埗鍙帮級`);
  if (pname) console.log(`[console] 鍗犵敤鑰呰繘绋嬶細${pname}`);
  // 鎻愮ず瑕佽兘鐓у仛锛氫袱绉嶆ā寮忕幇鍦ㄩ兘鏈夋槑纭殑閰嶇疆鏂囦欢钀界偣锛坋xe 鍚岀骇 / 鑴氭湰鍚岀骇锛夛紝鐩存帴缁欒矾寰勬渶鐪佷簨銆?  console.log(`[console] 鎹釜绔彛锛氭敼 ${CONFIG_FILE} 鐨?port锛屾垨璁剧幆澧冨彉閲?MOLLY_CONSOLE_PORT`);
  return 1;
}

server.on('error', async (err) => {
  if (err && err.code === 'EADDRINUSE') {
    // 鎺㈢鍙ｅ拰 listen 涔嬮棿琚姠鐨勭珵鎬侊紙姒傜巼鏋佷綆锛夈€傝蛋鍚屼竴濂楀垽瀹氾紝鍒竴姒?exit 0銆?    const code = await handleOccupiedPort();
    await pauseIfInteractive();
    process.exit(code);
  }
  console.log(`[console] 鍚姩澶辫触锛?{err && err.message ? err.message : err}`);
  await pauseIfInteractive();
  process.exit(1);
});

// 鍚姩涓夋€侊細绔彛绌洪棽 鈫?姝ｅ父璧凤紱宸茶鑷繁鐨勬帶鍒跺彴鍗?鈫?鎻愮ず + 寮€绐?+ exit 0锛涜鍒汉鍗?鈫?鎶?pid + exit 1銆?(async function boot() {
  if (!(await portIsFree(PORT, PROBE_HOST))) {
    const code = await handleOccupiedPort();
    await pauseIfInteractive();
    process.exit(code);
  }
  server.listen(PORT, HOST, () => {
    console.log(`[console] 宸插惎鍔?http://${HOST}:${PORT}  version=${VERSION}`);
    console.log(`[console] 鍓嶇鐩綍 ${CONSOLE_DIR}`);
    console.log(`[console] 鏁版嵁鏈嶅姟 ${SIDECAR}`);
    // 鎶娿€岄厤缃粠鍝鐨勩€佸垏妯″瀷鑳戒笉鑳界敤銆嶆墦鍑烘潵锛?03 鎺掓煡绗竴姝ュ氨鐪嬭繖琛岋紙鍙姤璺緞鍜屾湁娌℃湁锛屼笉鎶ヤ护鐗屽€硷級銆?    console.log(
      `[console] 閰嶇疆鏂囦欢 ${CONFIG_FILE}${fs.existsSync(CONFIG_FILE) ? '' : '锛堜笉瀛樺湪锛岃蛋榛樿鍊?鐜鍙橀噺锛?}锛涘垏妯″瀷浠ょ墝 ${MODEL_SWITCH_TOKEN ? '宸查厤缃? : '鏈厤缃紙鍐欐帴鍙ｄ細 403锛?}`,
    );
  });
})();

// 鈹€鈹€ 璺敱鍒嗗彂锛堝垎姝ュ疄鐜帮紝瑙佷笅鏂瑰悇娈碉級鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
async function route(req, res) {
  const url = new URL(req.url, 'http://1<REDACTED>');
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    return res.end();
  }

  // 閴存潈锛氬彧鏈夎浜?MOLLY_CONSOLE_TOKEN 鎵嶆牎楠岋紙榛樿鍏嶉壌鏉冿紝鏈満琛屼负涓嶅彉锛?  if (CONSOLE_TOKEN && !tokenOk(req)) {
    return sendJson(res, 401, { ok: false, error: '缂哄皯鎴栭敊璇殑 x-molly-token' });
  }

  // 鏁版嵁鎺ュ彛
  // 浣滄伅鏃堕棿锛?026-10-25 涓讳汉 m05189-3锛氭帶鍒跺彴鍙鐫¤鏃堕棿锛?  if (p === '/api/sleep') {
    const base = await resolveHostBase();
    if (!base) return sendJson(res, 503, { ok: false, error: '瀹夸富绔彛杩樻病鎺㈡祴鍒? });
    if (req.method === 'POST') {
      let body = {};
      try {
        body = await readJsonBody(req);
      } catch {
        return sendJson(res, 400, { ok: false, error: '璇锋眰浣撲笉鏄悎娉?JSON' });
      }
      const r = await jpost(base + '/dsh-qq-whale/sleep', body, 6000);
      return sendJson(res, r.ok ? 200 : 502, r.ok ? r.data : { ok: false, error: r.error });
    }
    const r = await jget(base + '/dsh-qq-whale/sleep', 3000);
    return sendJson(res, r.ok ? 200 : 502, r.ok ? r.data : { ok: false, error: r.error });
  }

  if (p === '/api/health') {
    return sendJson(res, 200, { ok: true, version: VERSION, build: consoleBuild(), at: Date.now() });
  }

  /*
   * 鑼夎帀鑺?token 璐︽湰鐪嬫澘锛圥1-5锛?026-10-30锛?   * 鏁版嵁婧愭槸 <dataDir>/jasmine/ledger.jsonl锛堝紩鎿庢瘡娆℃ā鍨嬭皟鐢ㄨ拷鍔犱竴琛岋紝
   * 瀛楁 t/model/purpose/in/out/cached/cost锛夈€傝繖閲屽彧璇汇€佸彧鑱氬悎锛屼笉鍐欍€?   * 浠锋牸琛ㄥ彇 console.json 鐨?jasminePrices锛堝厓/鐧句竾 token锛夛紱娌￠厤鏃?cost 涓?0锛?   * 浣?in/out/cached 涓庣紦瀛樺懡涓巼浠嶇劧鍑嗙‘鈥斺€旈偅涓€鍒楁墠鏄€岀渷娌＄渷閽便€嶇殑璇佹嵁銆?   * 鍗曠嫭寮€涓€涓帴鍙ｈ€屼笉鏄杩?/api/overview锛氳处鏈鏁版寜璋冪敤閲忕嚎鎬у闀匡紝
   * overview 鏄瘡鍑犵杞涓€娆＄殑楂橀鎺ュ彛锛屼笉璇ヨ儗鐫€瀹冪炕鏂囦欢銆?   */
  if (p === '/api/jasmine/tokens') {
    const days = Math.max(1, Math.min(365, Number(url.searchParams.get('days')) || 7));
    const since = Date.now() - days * 86400000;
    try {
      const { TokenLedger } = await import('../jasmine/index.mjs');
      const jp = FILE_CFG && FILE_CFG.jasminePrices;
      const prices = jp && typeof jp === 'object' ? jp : {};
      const led = new TokenLedger({ file: path.join(DATA, 'jasmine', 'ledger.jsonl'), prices });
      const sum = led.summary({ since });
      return sendJson(res, 200, { ok: true, since, days, ...sum, recent: led.tail(20) });
    } catch (err) {
      // jasmine 娌￠殢鍖呮垨缂烘枃浠讹細杩斿洖 200 + 璇存槑锛屽墠绔笉鑷充簬鏁撮〉鎶ラ敊
      return sendJson(res, 200, {
        ok: false,
        days,
        error: String((err && err.message) || err),
        hint: '璐︽湰鏂囦欢 <dataDir>/jasmine/ledger.jsonl 鐢卞紩鎿庡啓鍏ワ紱娌℃湁璋冪敤杩囧氨鏄┖璐︽湰',
      });
    }
  }

  /*
   * 鏈鏇存柊璇存槑锛?026-10-25锛屼富浜?m04452锛氥€屾帶鍒跺彴涓婄殑鐗堟湰鏇存柊涓€涓嬶紝娉ㄩ噴涓€涓嬭繖娆℃洿鏂颁簡浠€涔堛€嶏級銆?   * 鏁版嵁婧愬氨鏄粨搴撻噷鐨?docs/CHANGELOG.md鈥斺€斿彇鏈€鏂颁竴鑺傦紙绗竴涓?`## ` 鏍囬鍒颁笅涓€鑺備箣闂达級锛?   * 鍓嶇鐐瑰乏涓嬭鐗堟湰鍙锋椂寮瑰眰灞曠ず锛屼笉棰濆缁存姢涓€浠芥枃妗堛€?   * 鏂囦欢涓嶅瓨鍦ㄤ篃杩斿洖 200锛堟墦鍖呯増娌″甫 docs 鏃跺墠绔彧鏄剧ず銆岀増鏈彿銆嶏級銆?   */
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
        text = section.length > 8000 ? section.slice(0, 8000) + '\n鈥? : section;
        title = String((section.match(/^##\s+(.+)$/m) || [])[1] || '').trim();
      }
    } catch (err) {
      text = '';
      title = '';
    }
    return sendJson(res, 200, { ok: true, version: VERSION, title, text, file: 'docs/CHANGELOG.md' });
  }

  // 鎬昏鑱氬悎锛堝绾?搂3.2锛夆€斺€斾笂娓稿叏鎸備篃蹇呴』 200
  if (p === '/api/overview') {
    return sendJson(res, 200, await buildOverview());
  }

  // 鏃ュ織锛堝绾?搂3.3锛?  if (p === '/api/logs') {
    const source = url.searchParams.get('source') || 'watchdog';
    const tail = Math.min(Math.max(Number(url.searchParams.get('tail')) || 200, 1), 2000);
    const r = await readLogTail(source, tail);
    return sendJson(res, 200, r);
  }

  // 璁板繂锛堝绾?搂3.4锛夆€斺€?閫忎紶 sidecar锛屽墠绔寜 {groups:[{name,items:[{date,tag,text}]}]} 娓叉煋
  if (p === '/api/memory') {
    let r = await jget(SIDECAR + '/api/memory', 5000);
    if (!r.ok) {
      ensureSidecar(r.error);
      await new Promise((x) => setTimeout(x, 700));
      r = await jget(SIDECAR + '/api/memory', 5000);
    }
    if (!r.ok) return sendJson(res, 200, { ok: false, reachable: false, count: 0, groups: [], error: r.error });
    return sendJson(res, 200, Object.assign({ ok: true, reachable: true }, r.data || {}));
  }

  // 琛ㄦ儏鍖呭垪琛紙濂戠害 搂3.5锛夆€斺€?閫忎紶 sidecar锛屽墠绔寜 {count,items} 娓叉煋
  if (p === '/api/stickers') {
    let r = await jget(SIDECAR + '/api/stickers', 5000);
    if (!r.ok) {
      ensureSidecar(r.error);
      await new Promise((x) => setTimeout(x, 700));
      r = await jget(SIDECAR + '/api/stickers', 5000);
    }
    if (!r.ok) return sendJson(res, 200, { ok: false, reachable: false, count: 0, items: [], error: r.error });
    return sendJson(res, 200, Object.assign({ ok: true, reachable: true }, r.data || {}));
  }

  // 琛ㄦ儏鍖呭師鍥撅紙濂戠害 搂3.6锛?  if (p.startsWith('/api/sticker/')) {
    return serveSticker(res, p.slice('/api/sticker/'.length));
  }

  // 鍙戣█寮€鍏筹紙2026-10-22锛夆€斺€?閫忎紶瀹夸富鎻掍欢 /dsh-qq-whale/switches*
  // GET  /api/plugin/switches                鈫?璇诲叏閮ㄧ姸鎬侊紙鍚璁?闈欓煶/鐢熸晥鍊硷級
  // POST /api/plugin/switches/set            {path,value}
  // POST /api/plugin/switches/mute           {scope,minutes,note}
  // POST /api/plugin/switches/unmute         {scope}
  // POST /api/plugin/switches/reset          {}
  if (p === '/api/plugin/switches' || p.startsWith('/api/plugin/switches/')) {
    const base = await resolveHostBase();
    if (!base) return sendJson(res, 200, { ok: false, reachable: false, error: '瀹夸富锛圖SH锛夋病鎺㈠埌绔彛' });
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
      return sendJson(res, 400, { ok: false, error: '璇锋眰浣撲笉鏄悎娉?JSON锛? + errText(err) });
    }
    const sub = p.slice('/api/plugin/switches'.length) || '/';
    if (!['/set', '/mute', '/unmute', '/reset'].includes(sub)) {
      return sendJson(res, 404, { ok: false, error: '鏈煡鐨勫紑鍏虫帴鍙?' + sub });
    }
    /* /set 瀵瑰簲鎻掍欢渚?POST /switches锛堝悓涓€涓帴鍙ｏ紝鐪佸緱鎻掍欢鍐嶅紑涓€涓埆鍚嶈矾鐢憋級 */
    const targetPath = sub === '/set' ? '/dsh-qq-whale/switches' : ('/dsh-qq-whale/switches' + sub);
    const r = await jpost(base + targetPath, body, 6000);
    if (!r.ok) return sendJson(res, 200, { ok: false, reachable: true, error: r.error });
    return sendJson(res, 200, Object.assign({ ok: true }, r.data || {}));
  }

  // 鍔ㄤ綔鎵ц锛堝绾?搂4.2锛?  if (p.startsWith('/api/action/')) {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'use POST' });
    const name = decodeURIComponent(p.slice('/api/action/'.length));
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch (err) {
      // 413 鏃剁粷涓嶅洖鏄捐姹備綋鍐呭锛堥噷闈㈠彲鑳芥槸 base64 鍥剧墖鎴栬蹇嗘鏂囷級
      if (err && err.code === 'BODY_TOO_LARGE') {
        return sendJson(res, 413, { ok: false, action: name, error: err.message });
      }
      return sendJson(res, 400, { ok: false, error: '璇锋眰浣撲笉鏄悎娉?JSON锛? + errText(err) });
    }
    return runAction(res, name, body);
  }

  // 鐧诲綍浜岀淮鐮佸師鍥撅紙濂戠害 搂3.7锛?  if (p === '/api/qr/latest.png') {
    return serveQr(res);
  }


  // 闈欐€佽祫婧?  return serveStatic(req, res, p);
}

// 鈹€鈹€ 鏁版嵁/鍔ㄤ綔鎺ュ彛瀹炵幇锛坧atch-console-server 娉ㄥ叆锛夆攢鈹€
/* 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
 * 浠ヤ笅鐢?patch-console-server.mjs 娉ㄥ叆鍒?console-server.mjs 鏈熬銆? * 渚濊禆鍓嶉潰鐨勶細SIDECAR / STICKER_DIR / OUT / PORT / TASK_NAME / LIVE / PS_EXE /
 *            NODE_EXE / CORS / sendJson / sendBuffer / jget / readJson /
 *            readTextSafe / resolveHostBase / napcatBearer / notFound
 * 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€ */

const fsp = fs.promises;
const errText = (e) => (e && e.message ? e.message : String(e));

// 鈹€鈹€ 閫氱敤锛氬甫瓒呮椂 fetch锛岀粷涓嶆姏 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
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

// 鈹€鈹€ 閫氱敤锛氳璇锋眰浣擄紙涓婇檺 12MB锛氳〃鎯呭寘 base64 鑶ㄨ儉鍚庣害 10.7MB锛岀暀浣欓噺锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€
const MAX_BODY = 12 * 1024 * 1024;

// 瓒呴檺鐢ㄨ繖涓敊璇被鍨嬪尯鍒嗭紝濂藉洖 413 鑰屼笉鏄?400
class BodyTooLarge extends Error {
  constructor(limit) {
    super(`璇锋眰浣撹秴杩?${Math.round(limit / 1024 / 1024)}MB 涓婇檺`);
    this.code = 'BODY_TOO_LARGE';
    this.limit = limit;
  }
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    // content-length 鑳芥彁鍓嶅垽灏辩洿鎺ユ嫆锛屽厤寰楃櫧璇?12MB
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
        finish(reject, new Error('涓嶆槸鍚堟硶 JSON'));
      }
    });
    req.on('error', (err) => finish(reject, err));
  });
}

// 鈹€鈹€ 璺?node 鑴氭湰锛堝甫瓒呮椂銆佹寜琛屾敹闆嗭級鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
function runNode(scriptPath, args = [], timeoutMs = 30_000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    if (!fs.existsSync(scriptPath)) {
      return resolve({ ok: false, error: `鑴氭湰涓嶅瓨鍦細${scriptPath}`, durationMs: 0 });
    }
    let child;
    try {
      child = spawn(NODE_EXE, [scriptPath, ...args], { windowsHide: true });
    } catch (err) {
      return resolve({ ok: false, error: `璧蜂笉鏉ヨ繘绋嬶細${errText(err)}`, durationMs: 0 });
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
      finish({ ok: false, error: `瓒呰繃 ${Math.round(timeoutMs / 1000)} 绉掓病缁撴潫锛屽凡缁堟`, stdout: out.slice(-8000), stderr: errOut.slice(-2000) });
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

// 鈹€鈹€ 琛ㄦ儏鍖呭浘鐗囷細鍏堥棶 sidecar 瑕?items 瀹氫綅鏂囦欢鍚嶏紝鍐嶅洖璇绘湰鍦板瓧鑺?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
async function serveSticker(res, rawName) {
  let name;
  try {
    name = decodeURIComponent(rawName);
  } catch {
    return notFound(res, '鏂囦欢鍚嶇紪鐮佷笉瀵?);
  }
  if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
    return notFound(res, '鏂囦欢鍚嶄笉鍚堟硶');
  }
  // 鍙厑璁稿绾?搂3.6 鐨勫瓧绗﹂泦
  if (!/^[A-Za-z0-9_\-.()\u4e00-\u9fa5]+$/.test(name)) {
    return notFound(res, '鏂囦欢鍚嶄笉鍚堟硶');
  }

  const ext = path.extname(name).slice(1).toLowerCase();
  const MIME_IMG = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
  };

  // 鍓嶇浼犵殑鏄?it.file锛堝甫鎵╁睍鍚嶏級銆備竾涓€娌℃墿灞曞悕锛岃ˉ涓€涓啀璇曘€?  const candidates = ext && MIME_IMG[ext] ? [name] : [name];
  for (const nm of candidates) {
    const e = path.extname(nm).slice(1).toLowerCase();
    if (!MIME_IMG[e]) continue;
    const full = path.resolve(STICKER_DIR, nm);
    if (!full.startsWith(path.resolve(STICKER_DIR) + path.sep)) continue;
    try {
      const buf = await fsp.readFile(full);
      return sendBuffer(res, 200, buf, MIME_IMG[e], 'public, max-age=3600');
    } catch {
      /* 缁х画涓嬩竴涓€欓€?*/
    }
  }
  return notFound(res, '琛ㄦ儏鍖呭浘鐗囦笉瀛樺湪锛? + name);
}

// 鈹€鈹€ 浜岀淮鐮侊細杩斿洖 out 鐩綍閲屾渶鏂扮殑閭ｅ紶鐧诲綍浜岀淮鐮?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
async function serveQr(res) {
  const PREFERRED = ['console-qr.png', 'molly-login.png'];
  for (const nm of PREFERRED) {
    try {
      const buf = await fsp.readFile(path.join(OUT, nm));
      if (buf.length > 0) return sendBuffer(res, 200, buf, 'image/png', 'no-store');
    } catch {
      /* 涓嬩竴涓?*/
    }
  }
  // 閫€璺細鎵?out 鐩綍閲屾墍鏈?*login*.png / *qr*.png锛屽彇 mtime 鏈€鏂扮殑
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
  return sendJson(res, 404, { ok: false, error: '杩樻病鏈変簩缁寸爜锛屽厛鐐广€岀敓鎴愪簩缁寸爜銆? });
}

// 鈹€鈹€ 鏃ュ織灏鹃儴锛堝绾?搂3.3锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
async function readLogTail(source, tail) {
  const MAP = {
    watchdog: path.join(OUT, 'watchdog.log'),
    console: path.join(OUT, 'console.log'),
    plugin: path.join(OUT, 'plugin.log'),
    napcat: path.join(OUT, 'napcat.log'),
    // 蹇冭烦鎺ㄩ€佸櫒锛坱ools\heartbeat-push.mjs锛夎嚜宸辩殑鏃ュ織銆傚垰寮€濮嬫帹鐨勬椂鍊欐枃浠跺彲鑳借繕涓嶅瓨鍦ㄣ€?    heartbeat: path.join(OUT, 'heartbeat.log'),
    // SnowLuma 鍚庣锛?026-10-25 鍔狅級锛氭壂鐮?閲嶅惎澶辫触鏃讹紝杩欎袱涓棩蹇楁槸绗竴鐜板満銆?    //  - snowluma-boot锛歵ools\snowluma-start.ps1 鐨勫惎鍔ㄨ繃绋嬫棩蹇?    //  - snowluma-runtime锛歋nowLuma 杩涚▼鑷繁鐨?stdout/err
    'snowluma-boot': path.join(OUT, 'snowluma-boot.log'),
    'snowluma-runtime': path.join(OUT, 'snowluma-runtime.out.log'),
  };
  const known = Object.prototype.hasOwnProperty.call(MAP, source);
  const file = known ? MAP[source] : MAP.watchdog;
  const txt = readTextSafe(file, 4 * 1024 * 1024);
  // 缂烘枃浠朵笉鏄敊璇細蹇冭烦鎺ㄩ€佸櫒鍙兘杩樻病璺戣繃銆佹彃浠舵棩蹇楀彲鑳借繕娌″啓杩囥€?  // 鍓嶇闈?exists 鍐冲畾鏄樉绀虹┖鍒楄〃杩樻槸"杩欎釜鏃ュ織杩樻病鐢熸垚"銆?  if (txt === null) {
    return { ok: true, source, path: file, exists: false, lines: [], note: '璇ユ棩蹇椾笉瀛樺湪' };
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
    // 鍏煎鑰佸墠绔細source 鍐欓敊鏃朵粛鍥?watchdog锛屼絾鏄庣‘鍛婅瘔璋冪敤鏂圭敤鐨勬槸鍝釜
    out.note = `鏈煡 source銆?{source}銆嶏紝宸插洖閫€鍒?watchdog`;
    out.known = Object.keys(MAP);
  }
  return out;
}

// 鈹€鈹€ 鍔ㄤ綔琛紙濂戠害 搂4.2 鐨?14 涓?+ CRUD 8 涓?= 22锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
const DESTRUCTIVE = new Set([
  'napcat/restart',
  'watchdog/config',
  'watchdog/task',
  'process/start-napcat',
  'memory/delete',   // 鍒犺蹇嗕笉鍙仮澶嶏紝濂戠害 搂3 瑕佹眰 confirm
  'stickers/delete', // 鍒犺〃鎯呭寘浼氳繛鍝堝笇涓€璧峰垹锛屽绾?搂3 瑕佹眰 confirm
  'memory/pending/approve', // 杞鍚庣珛鍒昏繘姝ｅ紡搴撳苟鍙備笌鍙洖锛岀瓑浜庝竴娆″啓鍏?  'memory/pending/reject',  // 涓㈠純鍚庤鏉″交搴曟秷澶憋紝娌℃湁鍥炴敹绔?  'molly/stop',     // 鍋?QQ + NapCat锛氫細鐩存帴鎺夌嚎锛屽垰鎵畬鐮佺殑璇濆緱閲嶆壂
  'molly/restart',  // 鍚屼笂锛岃€屼笖涓棿鏈?3 绉掔┖绐?]);

const TOOLS_DIR = TOOLS;

// 鍏抽敭璇嶏細鏁扮粍鎴?"a,b c" 瀛楃涓查兘鏀讹紙鍓嶇 chip 缁勪欢涓ょ閮藉彲鑳界粰锛?function normKeywords(v) {
  if (v == null) return null;
  // 鍒嗛殧绗︿笌鎻掍欢 cleanKeywords 淇濇寔涓€鑷达紙鍚腑鏂囧垎鍙峰拰鍏ㄨ閫楀彿椤垮彿锛?  const arr = Array.isArray(v) ? v : String(v).split(/[,锛屻€?锛沑s]+/);
  return arr.map((x) => String(x).trim()).filter(Boolean);
}

/**
 * 鎸夌爜鐐规暟瀛楁暟锛屼笌鎻掍欢 charLen锛坄[...s].length`锛変繚鎸佷竴鑷淬€? * 鐢?s.length 浼氭妸 emoji 绠楁垚 2 涓紝瀵艰嚧 100~200 瀛楀惈琛ㄦ儏鐨勮蹇嗗湪浠ｇ悊灞傚氨琚鎷掋€? */
function charLen(s) {
  return [...String(s ?? '')].length;
}

/**
 * 寰呮牳瀹炲尯鏉＄洰 id 鏍￠獙锛坱ask-28锛夈€? * 鏉＄洰 id 褰㈠ `mp1x2y3z4`锛屼絾鎻掍欢渚у疄鐜板彲鑳芥崲鐢熸垚鏂瑰紡锛屾墍浠ヨ繖閲屼笉闄愬埗瀛楃闆嗭紝
 * 鍙尅浣忎笁绫讳竴瀹氫細鍑洪棶棰樼殑杈撳叆锛? *   - 绌?/ 闈炲瓧绗︿覆
 *   - 瓒呴暱锛?28 鐮佺偣锛夆€斺€?闃叉鏈変汉鎷垮畠褰撹秴澶?payload 鎾炴彃浠? *   - 鎺у埗瀛楃锛圽x00-\x1f銆乗x7f锛夆€斺€?鍚崲琛岀殑 id 浼氭薄鏌撴彃浠舵棩蹇? * 杩斿洖 null 琛ㄧず鍚堟硶锛屽惁鍒欒繑鍥為敊璇瘽鏈€? */
function badPendingId(v) {
  if (typeof v !== 'string') return 'id 蹇呴』鏄瓧绗︿覆';
  const id = v.trim();
  if (!id) return 'id 涓嶈兘涓虹┖';
  if (charLen(id) > 128) return 'id 瓒呰繃 128 瀛楃';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(id)) return 'id 涓嶈兘鍖呭惈鎺у埗瀛楃';
  return null;
}

/**
 * 閫忎紶鎻掍欢鎺ュ彛锛堝绾?搂3锛夛細鏍￠獙鍦ㄦ湰鍦板厛鍋氫竴閬嶏紝鎻掍欢娌′笂绾夸篃鑳界粰鍑轰汉璇濋敊璇€? * 杩斿洖 { ok, data, status?, error? }锛沝ata 鏄彃浠跺師濮嬪搷搴旓紝鍓嶇鐩存帴璇汇€? * 娉ㄦ剰锛氳繖閲岀粷涓嶆妸 payload / 鍝嶅簲姝ｆ枃鍐欒繘鏃ュ織锛坆ase64銆佽蹇嗘鏂囬兘鏄晱鎰熷唴瀹癸級銆? */
async function proxyPlugin(method, ep, payload, ms = 20_000) {
  const base = await resolveHostBase();
  if (!base) return { ok: false, status: 503, error: '娌℃帰鍒?DSH 瀹夸富绔彛' };
  const url = base + '/dsh-qq-whale' + ep;
  const r =
    method === 'GET'
      ? await fetchJson(url, {}, ms)
      : await fetchJson(url, { method: 'POST', body: JSON.stringify(payload || {}) }, ms);
  const d = r.data;
  // 涓婃父 HTTP 灞傚け璐ワ細鍘熸牱閫忎紶鐘舵€佺爜锛?04 鎵句笉鍒?/ 409 鍐茬獊 / 400 鍙傛暟閿欓兘闈犺繖涓級
  if (!r.ok) {
    const msg = (d && (d.error || d.message)) || (r.status ? `HTTP ${r.status}` : r.error) || '鎻掍欢璇锋眰澶辫触';
    return { ok: false, status: r.status || 502, error: msg, data: d ?? null };
  }
  // 涓婃父 200 浣嗕笟鍔″け璐ワ細鎸変笟鍔￠敊璇鐞嗭紝鐘舵€佺爜娌跨敤鎻掍欢缁欑殑锛堟病缁欏氨褰?400锛?  if (d && d.ok === false) {
    return { ok: false, status: d.status || 400, error: d.error || '鎻掍欢杩斿洖 ok:false', data: d };
  }
  return { ok: true, data: d ?? null };
}

/** 姣忎釜鍔ㄤ綔杩斿洖 { ok, data?, stdout?, stderr?, error?, status? } */
/**
 * 鎶婁竴鏉℃帶鍒跺彴鑷繁鐨勬搷浣滄棩蹇楄拷鍔犲埌 out/console.log銆? *
 * 涓轰粈涔堜笉鐢?console.log锛氭帶鍒跺彴杩涚▼鐨?stdout 鐢卞惎鍔ㄥ櫒閲嶅畾鍚戯紝鐪熷疄鏂囦欢浣嶇疆
 * 鍙栧喅浜庢€庝箞鍚姩鐨勶紱楠備汉妯″紡杩欑"涓讳汉鐐圭殑寮€鍏?蹇呴』鏈変竴涓浐瀹氫綅缃兘缈诲埌銆? * 鍐欏け璐ュ彧鍚炴帀鈥斺€旀棩蹇楀啓涓嶈繘鍘讳笉璇ヨ寮€鍏充篃澶辫触銆? */
function appendConsoleLog(line) {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.appendFileSync(path.join(OUT, 'console.log'), `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    /* ignore */
  }
}

// 鈹€鈹€ 澶栭儴鏈嶅姟杈呭姪锛坱ask-57锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/**
 * 缃戝叧闈㈡澘鐧诲綍 鈫?token銆? *
 * 瀵嗙爜鏉ヨ嚜閰嶇疆锛坄MOLLY_GATEWAY_PASSWORD` / console.json `gatewayPassword`锛岄粯璁?admin锛夈€? * **token 涓庡瘑鐮佷竴寰嬩笉杩涙棩蹇椼€佷笉杩涜繑鍥炲€?*锛氳繖涓嚱鏁板彧鍦ㄥ唴閮ㄧ敤锛岃皟鐢ㄦ柟鍙兘鎷垮埌
 * `{ok, token}` 鎴?`{ok:false, error}`锛岃€?error 閲屽凡鎶婂搷搴旀鏂囧墺鎺変簡銆? */
async function gatewayPanelToken() {
  const r = await fetchJson(
    GATEWAY + '/panel/login',
    { method: 'POST', body: JSON.stringify({ password: GATEWAY_PASSWORD }) },
    8000,
  );
  if (!r.ok) {
    // 鍙鐘舵€佺爜锛屼笉鍥炴樉浠讳綍璇锋眰浣擄紙閲岄潰鏈夊瘑鐮侊級
    return { ok: false, error: `缃戝叧闈㈡澘鐧诲綍澶辫触锛圚TTP ${r.status || '鏃犲搷搴?}锛塦 };
  }
  const tk = r.data?.token;
  if (!tk || typeof tk !== 'string') {
    return { ok: false, error: '缃戝叧闈㈡澘鐧诲綍杩斿洖閲屾病鏈?token' };
  }
  return { ok: true, token: tk, usingDefaultPassword: Boolean(r.data?.using_default_password) };
}

/** 搴旂敤渚ф帹閫佸櫒鍐欑殑 state 鏂囦欢锛涜涓嶅埌灏卞綋杩樻病鎺ㄨ繃 */
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
 * 鏈嶅姟鍣ㄤ晶鐘舵€併€? *
 * 绾﹀畾锛氭湇鍔″櫒 `GET <relayBase>/health` 杩斿洖 `{ok, level, stale, ageSeconds, lastReceivedAt}`銆? * 鏈嶅姟鍣ㄤ笉鍦紙瀹堕噷鏂綉銆佹湇鍔″櫒閲嶅惎锛夋椂**涓嶆姏**锛屽洖 `{ok:false, error}` 鈥斺€?璋冪敤鏂规嵁姝? * 浠嶇劧缁欏墠绔?200锛岃椤甸潰鑳芥樉绀?杩滅涓嶅彲杈?锛岃€屼笉鏄暣椤垫姤閿欍€? */
async function fetchHeartbeatRemote(timeoutMs) {
  const cfg = readJson(HB_CONFIG, null);
  const relayBase = typeof cfg?.relayBase === 'string' ? cfg.relayBase.trim() : '';
  if (!relayBase) return { ok: false, error: '娌℃湁閰嶇疆鏈嶅姟鍣ㄥ湴鍧€锛坥ut/heartbeat-config.json 缂?relayBase锛? };
  const base = relayBase.replace(/\/+$/, '');
  const r = await fetchJson(base + '/health', {}, Math.max(1000, Math.min(timeoutMs || 8000, 20000)));
  if (!r.ok) {
    return {
      ok: false,
      error: r.status ? `鏈嶅姟鍣ㄨ繑鍥?HTTP ${r.status}` : r.error || '鏈嶅姟鍣ㄤ笉鍙揪',
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
 * 鍒楀嚭鏌愪釜杩涚▼鍚嶄笅鐨勬墍鏈?pid锛圵indows 鐢?tasklist锛屽埆鐢?wmic 鈥斺€?鏂扮増宸茬Щ闄わ級銆? * 杩斿洖 [{pid, name}]锛涙嬁涓嶅埌灏辫繑鍥炵┖鏁扮粍锛岀粷涓嶆姏銆? */
function listPidsByName(name) {
  const r = spawnSync('tasklist.exe', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    timeout: 8000,
    windowsHide: true,
  });
  const out = typeof r.stdout === 'string' ? r.stdout : '';
  const pids = [];
  for (const line of out.split(/\r?\n/)) {
    // 鏍煎紡锛?"QQ.exe","1234","Console","1","120,000 K"
    const m = line.match(/^"([^"]+)","(\d+)"/);
    if (m && m[1].toLowerCase() === String(name).toLowerCase()) {
      pids.push({ pid: Number(m[2]), name: m[1] });
    }
  }
  return pids;
}

/** 瑕佸仠鐨勮繘绋嬶細鍙繖涓ょ被銆侱SH 瀹夸富銆佺綉鍏炽€佹帶鍒跺彴鑷繁涓€姒備笉纰般€?*/
const MOLLY_PROCESS_NAMES = ['QQ.exe', 'NapCatWinBootMain.exe'];

/**
 * 鍋?Molly锛圦Q + NapCat锛夈€?*涓嶇 DSH 瀹夸富銆佷笉纰扮綉鍏?*锛堢敤鎴峰師璇濓細鍙仠杩欎袱涓級銆? * 杩斿洖鏉€浜嗗摢浜?pid锛屾病鎵惧埌鐨勫瀹炶"鏈潵灏辨病鍦ㄨ窇"銆? */
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

// 鈹€鈹€ 鍔ㄤ綔琛?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
const ACTIONS = {
  'plugin/toggle': async (body) => {
    if (typeof body?.enabled !== 'boolean') return { ok: false, status: 400, error: 'enabled 蹇呴』鏄?boolean' };
    const base = await resolveHostBase();
    if (!base) return { ok: false, status: 503, error: '娌℃帰鍒?DSH 瀹夸富绔彛' };
    const r = await fetchJson(base + '/dsh-qq-whale/toggle', {
      method: 'POST',
      body: JSON.stringify({ enabled: body.enabled }),
    });
    return { ...r, ok: r.ok && r.data?.ok !== false };
  },

  'plugin/recheck': async () => {
    const base = await resolveHostBase();
    if (!base) return { ok: false, status: 503, error: '娌℃帰鍒?DSH 瀹夸富绔彛' };
    const r = await fetchJson(base + '/dsh-qq-whale/recheck', { method: 'POST', body: '{}' }, 30_000);
    return { ...r, ok: r.ok && r.data?.ok !== false };
  },

  'plugin/budget': async (body) => {
    const base = await resolveHostBase();
    if (!base) return { ok: false, status: 503, error: '娌℃帰鍒?DSH 瀹夸富绔彛' };
    const payload = {};
    if (typeof body?.enabled === 'boolean') payload.enabled = body.enabled;
    if (Number.isFinite(Number(body?.cap)) && Number(body.cap) > 0) payload.cap = Number(body.cap);
    if (!Object.keys(payload).length) return { ok: false, status: 400, error: 'enabled 鍜?cap 鑷冲皯瑕佺粰涓€涓? };
    const r = await fetchJson(base + '/dsh-qq-whale/budget', { method: 'POST', body: JSON.stringify(payload) });
    return { ...r, ok: r.ok && r.data?.ok !== false };
  },

  'plugin/work-probe': async () => {
    const base = await resolveHostBase();
    if (!base) return { ok: false, status: 503, error: '娌℃帰鍒?DSH 瀹夸富绔彛' };
    const r = await fetchJson(base + '/dsh-qq-whale/work/probe', { method: 'POST', body: '{}' }, 60_000);
    return { ...r, ok: r.ok && r.data?.ok !== false };
  },

  'plugin/work-run': async (body) => {
    const task = String(body?.task || '').trim();
    if (!task) return { ok: false, status: 400, error: 'task 涓嶈兘涓虹┖' };
    const base = await resolveHostBase();
    if (!base) return { ok: false, status: 503, error: '娌℃帰鍒?DSH 瀹夸富绔彛' };
    const r = await fetchJson(base + '/dsh-qq-whale/work/run', {
      method: 'POST',
      body: JSON.stringify({ task, send: false }),
    }, 300_000);
    return { ...r, ok: r.ok && r.data?.ok !== false };
  },

  'plugin/research-test': async (body) => {
    const text = String(body?.text || '').trim();
    if (!text) return { ok: false, status: 400, error: 'text 涓嶈兘涓虹┖' };
    const base = await resolveHostBase();
    if (!base) return { ok: false, status: 503, error: '娌℃帰鍒?DSH 瀹夸富绔彛' };
    const r = await fetchJson(base + '/dsh-qq-whale/research/test', {
      method: 'POST',
      body: JSON.stringify({ text }),
    }, 180_000);
    return { ...r, ok: r.ok && r.data?.ok !== false };
  },

  /*
   * 楠備汉妯″紡锛堝嚭姘旂瓛锛夋€诲紑鍏筹紙task-36锛夈€?   *
   * 涓や釜鍔ㄤ綔鍒嗗紑鑰屼笉鏄竴涓細status 鏄函璇伙紙瀹堟姢椤垫瘡娆¤疆璇㈤兘瑕侊級锛宻et 鎵嶅啓銆?   * set 涓嶉渶瑕?confirm 鈥斺€?瀹冩槸鍙€嗙殑锛堝啀鐐逛竴涓嬪氨寮€鍥炴潵锛夛紝鑰屼笖"绔嬪嵆鍋?杩欎欢浜?   * 濡傛灉闇€瑕佷簩娆＄‘璁わ紝鍑轰簨鐨勬椂鍊欎汉鏍规湰鏉ヤ笉鍙婄偣銆?   */
  'pest/status': async () => {
    const base = await resolveHostBase();
    if (!base) return { ok: false, status: 503, error: '娌℃帰鍒?DSH 瀹夸富绔彛' };
    const r = await fetchJson(base + '/dsh-qq-whale/pest', { method: 'GET' }, 5000);
    const okAll = r.ok && r.data?.ok !== false;
    const err = r.data?.error || `鎻掍欢杩樻病鏈?/pest 璺敱锛圚TTP ${r.status}锛夆€斺€旈噸杞芥彃浠跺悗鍐嶈瘯`;
    return { ...r, ok: okAll, error: okAll ? undefined : err };
  },

  'pest/set': async (body) => {
    if (typeof body?.enabled !== 'boolean') {
      return { ok: false, status: 400, error: 'enabled 蹇呴』鏄?boolean锛坱rue / false锛? };
    }
    const payload = { enabled: body.enabled };
    if (body.targets !== undefined) payload.targets = body.targets;
    if (body.dailyCap !== undefined) payload.dailyCap = body.dailyCap;
    if (body.intervalMinutes !== undefined) payload.intervalMinutes = body.intervalMinutes;
    const base = await resolveHostBase();
    if (!base) return { ok: false, status: 503, error: '娌℃帰鍒?DSH 瀹夸富绔彛' };
    const r = await fetchJson(
      base + '/dsh-qq-whale/pest',
      { method: 'POST', body: JSON.stringify(payload) },
      8000,
    );
    const st = r.data?.state || null;
    const okAll = r.ok && r.data?.ok !== false;
    const err = r.data?.error || `寮€鍏虫病鐢熸晥锛圚TTP ${r.status}锛夆€斺€旀彃浠堕噸杞戒簡鍚楋紵`;
    appendConsoleLog(
      `[pest] 鎺у埗鍙版妸楠備汉妯″紡 鈫?${body.enabled ? '寮€' : '鍏?}` +
        (st
          ? `锝滃璞?${(st.targets || []).join(',') || '锛堢┖锛?}锝滄棩棰濆害 ${st.dailyCap}锝滃仠姝㈣瘝 ${st.stopWord || '锛堟棤锛?}`
          : '') +
        (okAll ? '' : `锝滃け璐ワ細${err}`),
    );
    return { ...r, ok: okAll, error: okAll ? undefined : err };
  },

  // SnowLuma 鍚庣锛氭病鏈?WebUI 浜岀淮鐮佸彲鐢熸垚锛堢櫥褰曟槸 QQ 鍘熺敓绐楀彛鎵爜锛夛紝
  // 銆岄噸鏂扮櫥褰曘€? 瑙﹀彂鎻愭潈浠诲姟 snowluma-start.ps1 -QQOnly锛氬彧閲嶅惎 QQ銆佷笉鍔?SnowLuma 杩涚▼锛?  // 淇濅綇璁惧鎸囩汗锛宧ookAutoLoad 浼氭妸 hook 閲嶆柊娉ㄥ叆鏂?QQ锛孮Q 绐楀彛寮瑰嚭鎵爜銆?  'napcat/qr': async () => {
    if (currentBackend() === 'snowluma') {
      if (!LIVE) {
        return {
          ok: false,
          status: 409,
          error: '寮€鍙戜繚鎶わ細鐪熷疄閲嶅惎浼氳涪鎺夊綋鍓?QQ 鐧诲綍銆傝 MOLLY_CONSOLE_LIVE=1 鍚庨噸鍚帶鍒跺彴鎵嶅厑璁告墽琛屻€?,
          data: { dryRun: true, would: 'schtasks /Run /TN SnowLuma-Relogin' },
        };
      }
      const r = await runTaskNow('SnowLuma-Relogin', 60_000);
      return {
        ...r,
        data: {
          backend: 'snowluma',
          hint: '宸茶Е鍙?SnowLuma-Relogin锛氱害 10~25 绉掑悗 QQ 绐楀彛浼氬脊鍑猴紝鐢ㄦ墜鏈烘壂鐮佸嵆鍙紙SnowLuma 杩涚▼娌￠噸鍚紝璁惧鎸囩汗涓嶅彉锛夈€?,
        },
      };
    }
    const r = await runNode(path.join(TOOLS_DIR, 'make-qr.mjs'), [path.join(OUT, 'console-qr.png')], 45_000);
    if (!r.ok) return { ok: false, error: r.error || '鐢熸垚浜岀淮鐮佸け璐?, stdout: r.stdout };
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

  // SnowLuma 鍚庣锛氬叏閲忛噸鍚?= 瑙﹀彂 SnowLuma-Boot锛堟竻 QQ 鈫?璧?SnowLuma 鈫?璧?QQ 鈫?绛夋壂鐮侊級銆?  'napcat/restart': async () => {
    if (!LIVE) {
      return {
        ok: false,
        status: 409,
        error: '寮€鍙戜繚鎶わ細鐪熷疄閲嶅惎浼氳涪鎺夊綋鍓?QQ 鐧诲綍銆傝 MOLLY_CONSOLE_LIVE=1 鍚庨噸鍚帶鍒跺彴鎵嶅厑璁告墽琛屻€?,
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
        data: { backend: 'snowluma', hint: '宸茶Е鍙?SnowLuma-Boot锛氬叏閲忛噸鍚?SnowLuma + QQ锛岀害 20~40 绉掑悗 QQ 绐楀彛寮瑰嚭鎵爜銆? },
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
      error: data ? undefined : r.error || 'watchdog --status 娌℃湁鍚愬嚭鍙В鏋愮殑 JSON',
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
      return { ok: false, status: 400, error: 'patch 蹇呴』鏄璞? };
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
      return { ok: false, status: 400, error: '涓嶅厑璁告敼杩欎簺閿細' + bad.join(', '), data: { allowed: ALLOWED } };
    }
    const cur = readJson(WD_CONFIG, null);
    if (!cur) return { ok: false, status: 500, error: '璇讳笉鍒?watchdog-config.json' };
    const next = { ...cur, ...patch };
    try {
      fs.writeFileSync(WD_CONFIG, JSON.stringify(next, null, 2) + '\n', 'utf8');
    } catch (err) {
      return { ok: false, status: 500, error: '鍐欓厤缃け璐ワ細' + errText(err) };
    }
    return { ok: true, data: { written: patch, file: WD_CONFIG } };
  },

  'watchdog/task': async (body) => {
    if (typeof body?.enable !== 'boolean') return { ok: false, status: 400, error: 'enable 蹇呴』鏄?boolean' };
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
        done({ ok: false, error: 'schtasks 瓒呮椂' });
      }, 20_000);
      child.stdout.on('data', (d) => { out += d.toString('utf8'); });
      child.stderr.on('data', (d) => { errOut += d.toString('utf8'); });
      child.on('error', (e) => done({ ok: false, error: errText(e) }));
      child.on('exit', (code) => done({ ok: code === 0, code, stdout: out, stderr: errOut }));
    });
    // 涓枃 Windows 涓?schtasks 杈撳嚭鏄?GBK锛宻tdout 鍙兘涔辩爜锛涚敤 exit code 鍒ゅ畾锛屽洖鏌ヤ竴娆＄湡瀹炵姸鎬?    const after = await probeTaskEnabled(TASK_NAME);
    return {
      ok: r.ok,
      stdout: r.stdout,
      stderr: r.stderr,
      error: r.ok ? undefined : 'schtasks 閫€鍑虹爜 ' + (r.code ?? '?') + '锛堣緭鍑哄彲鑳芥槸 GBK 涔辩爜锛屼互 taskEnabled 涓哄噯锛?,
      data: { enable: body.enable, taskEnabled: after, durationMs: Date.now() - t0 },
    };
  },

  'process/start-napcat': async () => {
    if (!LIVE) {
      return {
        ok: false,
        status: 409,
        error: '寮€鍙戜繚鎶わ細鎷夎捣 QQ 杩涚▼鍙兘鍜岀幇鏈夎繘绋嬫姠绔彛銆傝 MOLLY_CONSOLE_LIVE=1 鍚庨噸鍚帶鍒跺彴鎵嶅厑璁告墽琛屻€?,
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
        data: { backend: 'snowluma', hint: '宸茶Е鍙?SnowLuma-Boot锛氭媺璧?SnowLuma + QQ锛岀害 20~40 绉掑悗绛夋壂鐮併€? },
      };
    }
    return runPowerShell([], 240_000);
  },

  // 鈹€鈹€ CRUD 8 鏉★紙濂戠害 搂3锛夛細鍏ㄩ儴閫忎紶鎻掍欢锛屼唬鐞嗗眰鍙仛鏈湴鍙傛暟鏍￠獙 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // 涓轰粈涔堜笉鍦ㄤ唬鐞嗗眰鏀圭洏锛氭彃浠舵寔鏈夊唴瀛樻€侊紝鐩存敼鏂囦欢浼氳瀹冧笅娆?save() 瑕嗗啓锛堝绾?搂0锛?
  'memory/list': async () => proxyPlugin('GET', '/memory/list', null, 15_000),

  'memory/add': async (body) => {
    const text = String(body?.text ?? '').trim();
    if (!text) return { ok: false, status: 400, error: 'text 涓嶈兘涓虹┖' };
    if (charLen(text) > 200) return { ok: false, status: 400, error: 'text 鏈€澶?200 瀛? };
    const payload = { text };
    if (body?.kind !== undefined) payload.kind = String(body.kind);
    if (body?.who !== undefined) payload.who = String(body.who);
    if (body?.weight !== undefined && body.weight !== null) {
      const w = Number(body.weight);
      if (!Number.isInteger(w) || w < 1 || w > 5) return { ok: false, status: 400, error: 'weight 蹇呴』鏄?1-5 鐨勬暣鏁? };
      payload.weight = w;
    }
    return proxyPlugin('POST', '/memory/add', payload);
  },

  'memory/update': async (body) => {
    const id = String(body?.id ?? '').trim();
    if (!id) return { ok: false, status: 400, error: 'id 涓嶈兘涓虹┖' };
    const payload = { id };
    if (body?.text !== undefined) {
      const text = String(body.text).trim();
      if (!text) return { ok: false, status: 400, error: 'text 涓嶈兘鏀规垚绌? };
      if (charLen(text) > 200) return { ok: false, status: 400, error: 'text 鏈€澶?200 瀛? };
      payload.text = text;
    }
    if (body?.kind !== undefined) payload.kind = String(body.kind);
    if (body?.who !== undefined) payload.who = String(body.who);
    if (body?.weight !== undefined && body.weight !== null) {
      const w = Number(body.weight);
      if (!Number.isInteger(w) || w < 1 || w > 5) return { ok: false, status: 400, error: 'weight 蹇呴』鏄?1-5 鐨勬暣鏁? };
      payload.weight = w;
    }
    // 鑷冲皯瑕佹敼涓€涓瓧娈碉紝鍚﹀垯绛変簬绌鸿窇
    if (Object.keys(payload).length === 1) {
      return { ok: false, status: 400, error: 'text/kind/who/weight 鑷冲皯瑕佺粰涓€涓? };
    }
    return proxyPlugin('POST', '/memory/update', payload);
  },

  'memory/delete': async (body) => {
    const id = String(body?.id ?? '').trim();
    if (!id) return { ok: false, status: 400, error: 'id 涓嶈兘涓虹┖' };
    return proxyPlugin('POST', '/memory/delete', { id });
  },

  'stickers/list': async () => proxyPlugin('GET', '/stickers/list', null, 15_000),

  'stickers/add': async (body) => {
    const raw = String(body?.dataBase64 ?? '').trim();
    if (!raw) return { ok: false, status: 400, error: 'dataBase64 涓嶈兘涓虹┖' };
    const keywords = normKeywords(body?.keywords ?? body?.keyword);
    if (!keywords || !keywords.length) return { ok: false, status: 400, error: 'keywords 鑷冲皯瑕佺粰涓€涓? };
    const payload = { dataBase64: raw, keywords };
    if (body?.filename !== undefined) payload.filename = String(body.filename);
    // 澶у浘涓婁紶鎱紝缁欒冻 60 绉掞紙鎻掍欢閭ｈ竟杩樿绠?sha256 + 閲嶆壂鐩綍锛?    return proxyPlugin('POST', '/stickers/add', payload, 60_000);
  },

  'stickers/update': async (body) => {
    const file = String(body?.file ?? '').trim();
    if (!file) return { ok: false, status: 400, error: 'file 涓嶈兘涓虹┖' };
    if (file.includes('..')) return { ok: false, status: 400, error: 'file 涓嶈兘鍖呭惈 ..' };
    const keywords = normKeywords(body?.keywords ?? body?.keyword);
    if (!keywords || !keywords.length) return { ok: false, status: 400, error: 'keywords 鑷冲皯瑕佺粰涓€涓? };
    return proxyPlugin('POST', '/stickers/update', { file, keywords });
  },

  'stickers/delete': async (body) => {
    const file = String(body?.file ?? '').trim();
    if (!file) return { ok: false, status: 400, error: 'file 涓嶈兘涓虹┖' };
    if (file.includes('..')) return { ok: false, status: 400, error: 'file 涓嶈兘鍖呭惈 ..' };
    return proxyPlugin('POST', '/stickers/delete', { file });
  },

  // 鈹€鈹€ 寰呮牳瀹炲尯锛坱ask-28锛屾彃浠朵晶瑙?task-27锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // 鎷︿笅鏉ョ殑璁板繂涓嶅啀鐩存帴涓㈠純锛岃€屾槸杩?pending.json 绛変富浜哄鎵广€?  // 浠ｇ悊灞備笉鍋氫笟鍔″垽鏂紝鍙仛 id 涓夌骇鏍￠獙 + 鍘熸牱閫忎紶锛堝惈鎻掍欢鐨?404/409锛夈€?
  'memory/pending': async () => proxyPlugin('GET', '/memory/pending', null, 15_000),

  'memory/pending/approve': async (body) => {
    const bad = badPendingId(body?.id);
    if (bad) return { ok: false, status: 400, error: bad };
    // 杞鍚庣珛鍒昏繘姝ｅ紡搴撳苟鍙備笌鍙洖锛岀瓑浜庝竴娆″啓鍏?鈥斺€?DESTRUCTIVE 宸插惈姝ゅ姩浣?    return proxyPlugin('POST', '/memory/pending/approve', { id: String(body.id).trim(), confirm: true });
  },

  'memory/pending/reject': async (body) => {
    const bad = badPendingId(body?.id);
    if (bad) return { ok: false, status: 400, error: bad };
    return proxyPlugin('POST', '/memory/pending/reject', { id: String(body.id).trim(), confirm: true });
  },

  // 鈹€鈹€ 杩愮淮锛歁olly 鏈綋锛坱ask-57锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // stop / restart 浼氳涪鎺?QQ 鐧诲綍锛屽睘浜庣牬鍧忔€у姩浣滐紙DESTRUCTIVE 閲屽凡鐧昏锛岀己 confirm 涓€寰?409锛夈€?  // start 涓嶇牬鍧忎换浣曚笢瑗匡紙宸叉湁杩涚▼鏃?start-molly.ps1 鑷繁浼氳烦杩囧惎鍔級锛屾墍浠ヤ笉鐢?confirm銆?
  /** 鎷夎捣 / 妫€鏌?Molly銆備笉甯?-Restart锛氶偅涓紑鍏充細鍏堟潃 QQ銆?*/
  'molly/start': async () => {
    // SnowLuma 鍚庣锛氭帶鍒跺彴鏄櫘閫氭潈闄愶紝鎷変笉璧锋彁鏉冪殑 QQ锛涗氦缁?SnowLuma-Boot 璁″垝浠诲姟
    if (currentBackend() === 'snowluma') {
      const r = await runTaskNow('SnowLuma-Boot', 60_000);
      appendConsoleLog(`[molly] 鎺у埗鍙板惎鍔?Molly锛圫nowLuma/璁″垝浠诲姟锛夛細ok=${r.ok}`);
      return {
        ok: Boolean(r.ok),
        durationMs: r.durationMs,
        data: {
          backend: 'snowluma',
          task: 'SnowLuma-Boot',
          note: '宸茶Е鍙?SnowLuma-Boot锛堟竻 QQ 鈫?璧?SnowLuma 鈫?璧峰師鐢?QQ锛夛紱闇€瑕佺櫥褰曟椂 QQ 绐楀彛浼氬脊鍑虹瓑浣犳壂鐮併€?,
          taskResult: r,
        },
        error: r.error,
      };
    }
    // 涓嶅姞 LIVE 闂革細杩欎釜鍔ㄤ綔涓嶇牬鍧忎换浣曚笢瑗库€斺€攕tart-molly.ps1 鑷繁浼氳烦杩?    // 宸茬粡鍦ㄨ窇鐨?NapCat锛岀粨灏惧彧鍋氫竴娆＄姸鎬佹鏌ャ€傜湡姝ｇ殑鐮村潖鎬у姩浣滄槸 stop / restart銆?    const r = await runPowerShell([], 180_000);
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

  /** 鍙仠 QQ + NapCat銆侱SH 瀹夸富銆佺綉鍏炽€佹帶鍒跺彴鑷繁閮戒笉纰般€?*/
  'molly/stop': async () => {
    // SnowLuma 鍚庣锛歈Q/SnowLuma 閮芥槸鎻愭潈杩涚▼锛屾櫘閫氭潈闄愭潃涓嶆帀锛岃蛋 SnowLuma-Stop 浠诲姟
    if (currentBackend() === 'snowluma') {
      const r = await runTaskNow('SnowLuma-Stop', 60_000);
      appendConsoleLog(`[molly] 鎺у埗鍙板仠 Molly锛圫nowLuma/璁″垝浠诲姟锛夛細ok=${r.ok}`);
      return {
        ok: Boolean(r.ok),
        status: r.ok ? undefined : 500,
        durationMs: r.durationMs,
        data: {
          backend: 'snowluma',
          task: 'SnowLuma-Stop',
          note: '宸茶Е鍙?SnowLuma-Stop锛堟俯鍜屽叧 QQ + 缁撴潫 SnowLuma锛夛紱DSH 瀹夸富銆佺綉鍏炽€佹帶鍒跺彴鏈韩娌″姩銆?,
          taskResult: r,
        },
        error: r.ok ? undefined : (r.error || '瑙﹀彂 SnowLuma-Stop 澶辫触'),
      };
    }
    const r = stopMollyProcesses();
    const okAll = r.failed.length === 0;
    appendConsoleLog(
      `[molly] 鎺у埗鍙板仠 Molly锛氭潃鎺?${r.killed.map((k) => `${k.name}#${k.pid}`).join(',') || '锛堟棤锛?}` +
        `锝滄湰鏉ユ病鍦ㄨ窇 ${r.notRunning.join(',') || '锛堟棤锛?}` +
        (okAll ? '' : `锝滃け璐?${r.failed.map((f) => `${f.name}#${f.pid}`).join(',')}`),
    );
    return {
      ok: okAll,
      status: okAll ? undefined : 500,
      data: {
        killed: r.killed,
        notRunning: r.notRunning,
        failed: r.failed,
        note: '鍙仠浜?QQ 涓?NapCat锛汥SH 瀹夸富銆佺綉鍏炽€佹帶鍒跺彴鏈韩娌″姩銆?,
      },
      error: okAll ? undefined : '鏈変簺杩涚▼娌″仠鎺夛細' + r.failed.map((f) => `${f.name}#${f.pid}`).join(', '),
    };
  },

  /** 鍏堝仠鍐嶈捣銆備腑闂寸暀 3 绉掕 NapCat 閲婃斁 6099 / 3001銆?*/
  'molly/restart': async () => {
    // SnowLuma 鍚庣锛氬仠 鈫?绛?2 绉?鈫?璧凤紝鍏ㄩ儴璧版彁鏉冭鍒掍换鍔?    if (currentBackend() === 'snowluma') {
      const stopped = await runTaskNow('SnowLuma-Stop', 60_000);
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const started = await runTaskNow('SnowLuma-Boot', 60_000);
      appendConsoleLog(`[molly] 鎺у埗鍙伴噸鍚?Molly锛圫nowLuma/璁″垝浠诲姟锛夛細鍋?${stopped.ok} 璧?${started.ok}`);
      return {
        ok: Boolean(started.ok),
        durationMs: (stopped.durationMs || 0) + 2000 + (started.durationMs || 0),
        data: {
          backend: 'snowluma',
          note: '宸茶Е鍙?SnowLuma-Stop 鈫?SnowLuma-Boot锛涗腑闂存湁绾?20~40 绉掔┖绐楋紝闇€瑕佺櫥褰曟椂浼氬脊 QQ 鎵爜绐椼€?,
          stopped,
          started,
        },
        error: started.ok ? undefined : (started.error || '瑙﹀彂 SnowLuma-Boot 澶辫触'),
      };
    }
    const stopped = stopMollyProcesses();
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const started = await runPowerShell([], 180_000);
    appendConsoleLog(
      `[molly] 鎺у埗鍙伴噸鍚?Molly锛氬仠 ${stopped.killed.map((k) => `${k.name}#${k.pid}`).join(',') || '锛堟棤锛?}` +
        `锝滆捣 ${started.ok ? '鎴愬姛' : '澶辫触'}`,
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

  // 鈹€鈹€ 澶栭儴鏈嶅姟锛氱綉鍏筹紙task-57锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // 瀵嗙爜涓?token 鍙湪鍐呭瓨閲岃繃涓€瓒燂紝**缁濅笉鍐欐棩蹇椼€佺粷涓嶅洖鏄?*銆?
  'gateway/usage': async () => {
    const lg = await gatewayPanelToken();
    if (!lg.ok) return { ok: false, status: 502, error: lg.error };
    const r = await fetchJson(GATEWAY + '/v1/usage', { headers: { 'x-panel-token': lg.token } }, 15000);
    if (!r.ok) {
      const msg = r.data?.error?.message || `缃戝叧杩斿洖 HTTP ${r.status}`;
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
      const msg = r.data?.error?.message || `缃戝叧杩斿洖 HTTP ${r.status}`;
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

  // 鈹€鈹€ 鍒囨ā鍨嬶紙鐢ㄦ埛 m39817锛氫粎闄愭帶鍒跺彴锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // 涓轰粈涔堜笉璁╁墠绔洿杩?7053锛氭彃浠跺啓鎺ュ彛瑕佹眰 x-molly-admin锛屼护鐗屽彧鑳藉緟鍦ㄦ湇鍔＄锛?  // 鑰屼笖鍓嶇鍙 /api/action/*锛屼笉缁欏畠绗簩涓叆鍙ｃ€?  // 浠ょ墝娌￠厤鏃?*涓嶇紪閫犳垚鍔?*锛氭彃浠朵細鍥?403 骞惰鏄庡師鍥狅紝鍘熸牱閫忕粰鍓嶇銆?
  'plugin/model-set': async (body) => {
    const patch = {};
    for (const role of ['chat', 'work', 'code']) {
      const raw = body?.[role];
      if (raw === undefined || raw === null || raw === '') continue;
      patch[role] = String(raw).trim();
    }
    if (!Object.keys(patch).length) {
      return { ok: false, status: 400, error: 'chat / work / code 鑷冲皯瑕佺粰涓€涓? };
    }
    if (!MODEL_SWITCH_TOKEN) {
      // 鏈湴鍏堟嫤涓€閬擄紝璇存竻妤氭槸"鏈嶅姟绔病閰?锛屽埆璁╁墠绔鐫€ 403 鐚?      return {
        ok: false,
        status: 403,
        error: '鏈嶅姟绔繕娌￠厤缃垏妯″瀷浠ょ墝锛圡OLLY_MODEL_SWITCH_TOKEN / console.json 鐨?modelSwitchToken锛夛紝鍒囨ā鍨嬬幇鍦ㄧ敤涓嶄簡銆?,
        data: { needToken: true, roles: ['chat', 'work', 'code'] },
      };
    }
    const base = await resolveHostBase();
    if (!base) return { ok: false, status: 503, error: '娌℃帰鍒?DSH 瀹夸富绔彛' };
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
      const msg = r.data?.error || `鎻掍欢杩斿洖 HTTP ${r.status}`;
      // 403 鎶婃湇鍔＄鍘熸枃閫忓嚭鍘伙細鍓嶇闈犲畠鎻愮ず"鏈嶅姟绔繕娌￠厤缃垏妯″瀷浠ょ墝"
      return { ok: false, status: r.status || 502, error: String(msg), data: r.data ?? null };
    }
    appendConsoleLog(`[model] 鎺у埗鍙板垏妯″瀷锛?{Object.entries(patch).map(([k, v]) => `${k}=${v}`).join(' ')}`);
    return { ok: true, data: r.data ?? null };
  },

  // 鈹€鈹€ 澶栭儴鏈嶅姟锛氬績璺筹紙task-57锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // 鏈嶅姟鍣ㄦ寕浜嗕笉鑳芥妸鏁撮〉鎷栧灝锛氳繙绔笉鍙揪鐓ф牱 200锛屽墠绔寜 remote.ok 鏄剧ず銆?
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

  // 鈹€鈹€ 澶栭儴鏈嶅姟锛歅ushPlus 鎺ㄩ€佸紑鍏筹紙task-57锛夆攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
  // 鍙敼 notify.enabled 涓€涓竷灏斿€硷紱鍐欑洏鍓嶅浠斤紱杩斿洖鍊奸噷 token **鎵撶爜**銆?
  'pushplus/status': async () => {
    const cur = readJson(WD_CONFIG, null);
    if (!cur) return { ok: false, status: 500, error: '璇讳笉鍒?watchdog-config.json' };
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
      return { ok: false, status: 400, error: 'enabled 蹇呴』鏄?boolean锛坱rue / false锛? };
    }
    const cur = readJson(WD_CONFIG, null);
    if (!cur) return { ok: false, status: 500, error: '璇讳笉鍒?watchdog-config.json' };
    const notify = cur.notify && typeof cur.notify === 'object' ? cur.notify : {};
    const before = notify.enabled === true;
    // 澶囦唤锛氶厤缃啓鍧忎簡 watchdog 灏变笉鎺ㄤ簡锛屽緱鑳芥墜宸ュ洖婊?    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const bak = `${WD_CONFIG}.bak-${stamp}`;
    try {
      fs.copyFileSync(WD_CONFIG, bak);
    } catch (err) {
      return { ok: false, status: 500, error: '澶囦唤閰嶇疆澶辫触锛? + errText(err) };
    }
    const next = { ...cur, notify: { ...notify, enabled: body.enabled } };
    try {
      fs.writeFileSync(WD_CONFIG, JSON.stringify(next, null, 2) + '\n', 'utf8');
    } catch (err) {
      return { ok: false, status: 500, error: '鍐欓厤缃け璐ワ細' + errText(err) };
    }
    const tk = typeof notify.token === 'string' ? notify.token : '';
    appendConsoleLog(`[pushplus] 鎺у埗鍙版妸鎺ㄩ€?鈫?${body.enabled ? '寮€' : '鍏?}锛堝浠?${path.basename(bak)}锛塦);
    return {
      ok: true,
      data: {
        enabled: body.enabled,
        changed: before !== body.enabled,
        // 鍙湶棣栧熬鍚?4 浣嶏紝涓棿鎵撶爜锛涙病閰?token 灏辩収瀹炶
        token: tk ? `${tk.slice(0, 4)}****${tk.slice(-4)}` : null,
        hasToken: Boolean(tk),
        type: typeof notify.type === 'string' ? notify.type : null,
        backup: path.basename(bak),
      },
    };
  },
};

/**
 * 瑙﹀彂涓€涓彁鏉冭鍒掍换鍔★紙SnowLuma 鐨勩€岄噸鏂扮櫥褰?/ 鍏ㄩ噺閲嶅惎銆嶉兘璧板畠锛夈€? * 涓轰粈涔堣缁曚竴灞傝鍒掍换鍔★細console-server 鑷繁浠?Limited 鏉冮檺璺戯紝鐩存帴璋? * snowluma-start.ps1 娉ㄥ叆涓嶄簡鎻愭潈鐨?QQ.exe锛涜鍒掍换鍔′互 RunLevel Highest 璺戯紝鑳芥敞鍏ャ€? * schtasks 鍦ㄤ腑鏂囩郴缁熻緭鍑?GBK锛岃繖閲屽彧璁ら€€鍑虹爜锛屼笉瑙ｆ瀽杈撳嚭銆? */
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
      done({ ok: false, error: `schtasks /Run ${taskName} 瓒呰繃 ${Math.round(timeoutMs / 1000)} 绉掓湭杩斿洖` });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('binary'); });
    child.stderr.on('data', (d) => { errOut += d.toString('binary'); });
    child.on('error', (e) => done({ ok: false, error: errText(e) }));
    child.on('exit', (code) => done({ ok: code === 0, code, stdout: out.slice(-2000), stderr: errOut.slice(-2000) }));
  });
}

/** 璺?start-molly.ps1锛堝彲鑳藉緢涔咃紝杈撳嚭涔熷ぇ锛?*/
async function runPowerShell(args, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const script = path.join(TOOLS_DIR, 'start-molly.ps1');
    if (!fs.existsSync(script)) return resolve({ ok: false, error: '鑴氭湰涓嶅瓨鍦細' + script, durationMs: 0 });
    let child;
    try {
      /*
       * 涓轰粈涔堣鍦?PowerShell 閲屽厛鏀硅緭鍑虹紪鐮侊細
       * start-molly.ps1 閲屽叏鏄腑鏂?Write-Host锛岃€?Windows PowerShell 5.1 榛樿鐢?       * 绯荤粺 ANSI锛堣繖鍙版槸 cp936/GBK锛夊線绠￠亾閲屽啓銆傜埗杩涚▼ Node 鎸?utf8 瑙ｅ氨浼氬彉鎴?       * 銆孧olly 全锟斤拷锟斤拷锟斤拷锟斤拷銆嶈繖鏍风殑涔辩爜銆?       *
       * [Console]::OutputEncoding 鍙奖鍝嶆湰杩涚▼鐨勬爣鍑嗚緭鍑虹紪鐮侊紝涓嶇绯荤粺璁剧疆锛?       * 璁炬垚 UTF8 鍚庯紝Node 绔洿鎺?toString('utf8') 灏辨槸姝ｇ‘鐨勪腑鏂囥€?       */
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
      done({ ok: false, error: `瓒呰繃 ${Math.round(timeoutMs / 1000)} 绉掓病缁撴潫锛屽凡缁堟` });
    }, timeoutMs);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', (d) => { errOut += d.toString('utf8'); });
    child.on('error', (e) => done({ ok: false, error: errText(e) }));
    child.on('exit', (code) => done({ ok: code === 0, code, stdout: out.slice(-20000), stderr: errOut.slice(-8000) }));
  });
}

/** 缁熶竴鎵ц鍏ュ彛锛氭牎楠?confirm 鈫?璺?鈫?褰掍竴鍖栧搷搴?*/
async function runAction(res, name, body) {
  const fn = ACTIONS[name];
  if (!fn) {
    return sendJson(res, 404, {
      ok: false,
      error: '鏈煡鍔ㄤ綔锛? + name,
      data: { available: Object.keys(ACTIONS) },
    });
  }
  if (DESTRUCTIVE.has(name) && body?.confirm !== true) {
    return sendJson(res, 409, { ok: false, action: name, status: 409, error: '杩欎釜鍔ㄤ綔闇€瑕?confirm:true 鎵嶆墽琛? });
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
    // 濂戠害 搂3锛氬け璐ヤ綋缁熶竴甯?status锛屽墠绔笉鐢ㄥ幓璇?HTTP 灞?    payload.status = out.status;
    if (!payload.error) payload.error = 'HTTP ' + out.status;
  }
  if (!payload.ok && !payload.error) payload.error = '鍔ㄤ綔澶辫触';
  delete payload.durationText;
  return sendJson(res, status, payload);
}
