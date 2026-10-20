#!/usr/bin/env node
/**
 * build-exe.mjs —— 把 console-server.mjs 打成单文件 molly-console.exe（Node SEA）
 *
 * 为什么是 SEA 而不是 pkg：pkg 已停更，且不支持 Node 24；SEA 是官方方案。
 *
 * 零依赖原则的取舍：
 *   SEA 官方流程最后一步「把 blob 注入 node.exe 副本」需要 postject（第三方）。
 *   本脚本**不要求预先装 npm**：它自己去 registry 拉 postject + commander 的 tarball、
 *   解到 dist/_build/pkg/，用 `node <postject>/dist/cli.js` 直接调，不污染全局环境。
 *   已经有 node_modules 的话会直接复用（见 ensurePostject）。
 *
 * 关键限制：SEA 的 main 当前只按 CommonJS 执行（config 里的 mainFormat 会被静默忽略，
 * 实测报 "Cannot use import statement outside a module"）。而 console-server.mjs 是 ESM。
 * 本脚本的处理：把源文件里 5 行 `import ... from 'node:x'` 机械改成 `require('node:x')`，
 * 生成 dist/_build/console-sea.cjs 再打包。**不改动源文件本身**，`node console-server.mjs`
 * 仍按 ESM 跑；转换后若出现残留的 ESM 语法会直接报错退出，不会悄悄打出一个坏 exe。
 *
 * 用法：
 *   node tools/build-exe.mjs            正常构建
 *   node tools/build-exe.mjs --keep     保留 dist/_build/ 中间产物便于排错
 *   node tools/build-exe.mjs --offline  不联网（要求 dist/_build/pkg 里已有 postject）
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const QQ_WHALE = path.resolve(HERE, '..');
const DIST = path.join(QQ_WHALE, 'dist');
const BUILD = path.join(DIST, '_build');
const PKG_DIR = path.join(BUILD, 'pkg');
const CONSOLE_DIR = path.join(QQ_WHALE, 'console');
const SRC = path.join(HERE, 'console-server.mjs');
const OUT_EXE = path.join(DIST, 'molly-console.exe');

const KEEP = process.argv.includes('--keep');
const OFFLINE = process.argv.includes('--offline');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

// postject 是唯一的外部依赖；版本钉死，避免哪天上游改行为把构建弄挂
const POSTJECT = { name: 'postject', version: '1.0.0-alpha.6' };
const COMMANDER = { name: 'commander', version: '9.5.0' }; // postject 的运行时依赖

const log = (s) => console.log(s);
const die = (s) => {
  console.error('\n[build] 失败：' + s);
  process.exit(1);
};
const kb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';

// ── 0. 前置检查 ─────────────────────────────────────────────────────────────
function preflight() {
  if (!fs.existsSync(SRC)) die(`找不到源文件 ${SRC}`);
  const nodeVer = process.versions.node;
  const major = Number(nodeVer.split('.')[0]);
  if (major < 20) die(`Node ${nodeVer} 太老，SEA 需要 Node >= 20（本机 ${process.execPath}）`);
  log(`[build] node ${nodeVer} (${process.platform}-${process.arch})`);
  log(`[build] 源文件 ${SRC}`);

  // 静态资源不打包，但构建时至少确认它们存在，否则打出来的 exe 是空壳
  const missing = ['index.html', 'console.js', 'console.css'].filter(
    (f) => !fs.existsSync(path.join(CONSOLE_DIR, f)),
  );
  if (missing.length) {
    log(`[build] ⚠ 前端缺文件：${missing.join(', ')}（exe 仍会生成，但网页会 503）`);
  } else {
    log(`[build] 前端资源 ${CONSOLE_DIR} 就绪（不打包，运行时按目录加载）`);
  }
}

// ── 1. ESM → CJS 机械转换 ───────────────────────────────────────────────────
// 只处理 console-server.mjs 里实际出现的 import 形式；转换后若还有 ESM 残留就失败，
// 这样以后谁在源文件里新加 `import` / `export` / `import.meta` 会立刻被这条守住。
function toCjs(srcPath) {
  let text = fs.readFileSync(srcPath, 'utf8');
  // 去掉 shebang（exe 里不需要）
  text = text.replace(/^#![^\n]*\n/, '');

  const converted = [];
  // import x from 'm'  →  const x = require('m')
  text = text.replace(
    /^import\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm,
    (m, name, mod) => {
      converted.push(`${name} <- ${mod}`);
      return `const ${name} = require('${mod}');`;
    },
  );
  // import { a, b as c } from 'm'  →  const { a, b: c } = require('m')
  text = text.replace(
    /^import\s*\{([^}]+)\}\s*from\s+['"]([^'"]+)['"];?[ \t]*$/gm,
    (m, names, mod) => {
      const list = names
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => s.replace(/\s+as\s+/, ': '))
        .join(', ');
      converted.push(`{${list}} <- ${mod}`);
      return `const { ${list} } = require('${mod}');`;
    },
  );
  // import * as ns from 'm'
  text = text.replace(
    /^import\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+['"]([^'"]+)['"];?[ \t]*$/gm,
    (m, ns, mod) => {
      converted.push(`*${ns} <- ${mod}`);
      return `const ${ns} = require('${mod}');`;
    },
  );

  // 兜底：任何残留的 ESM 语法都视为转换失败
  const leftovers = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (/^\s*import\s/.test(line) || /^\s*export\s/.test(line) || /\bimport\.meta\b/.test(line)) {
      leftovers.push(`L${i + 1}: ${line.trim()}`);
    }
  });
  if (leftovers.length) {
    die(
      '源文件里有本脚本不认识、且 SEA 不支持的 ESM 语法（需要扩展 toCjs）：\n  ' +
        leftovers.join('\n  '),
    );
  }
  if (!converted.length) die('一行 import 都没转换，源文件结构可能变了，不敢继续');

  const header =
    '/* 由 tools/build-exe.mjs 生成，勿手改。源：tools/console-server.mjs（ESM）*/\n' +
    `/* 转换的 import：${converted.join(' | ')} */\n`;
  return header + text;
}

// ── 2. 取 postject（无 npm 也能用）──────────────────────────────────────────
function untarGz(buf, dir) {
  const tar = zlib.gunzipSync(buf);
  let off = 0;
  let n = 0;
  while (off + 512 <= tar.length) {
    const hdr = tar.subarray(off, off + 512);
    if (hdr.every((b) => b === 0)) break;
    const name = hdr.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(hdr.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim(), 8) || 0;
    const type = String.fromCharCode(hdr[156]);
    const prefix = hdr.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const full = prefix ? `${prefix}/${name}` : name;
    const data = tar.subarray(off + 512, off + 512 + size);
    // tarball 顶层固定是 package/，剥掉
    const rel = full.split('/').slice(1).join('/');
    if (rel) {
      const target = path.join(dir, rel);
      if (type === '5') {
        fs.mkdirSync(target, { recursive: true });
      } else if (type === '0' || type === '\0') {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, data);
        n++;
      }
    }
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return n;
}

async function fetchPkg(spec) {
  const url = `https://registry.npmjs.org/${spec.name}/-/${spec.name}-${spec.version}.tgz`;
  log(`[build] 拉取 ${spec.name}@${spec.version} …`);
  const r = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!r.ok) die(`下载 ${spec.name} 失败：HTTP ${r.status}（${url}）`);
  const buf = Buffer.from(await r.arrayBuffer());
  const dir = path.join(PKG_DIR, 'node_modules', spec.name);
  fs.rmSync(dir, { recursive: true, force: true });
  const n = untarGz(buf, dir);
  log(`[build]   ${kb(buf.length)} → ${n} 个文件`);
}

async function ensurePostject() {
  const cli = path.join(PKG_DIR, 'node_modules', 'postject', 'dist', 'cli.js');
  if (fs.existsSync(cli)) {
    log('[build] postject 已有，跳过下载');
    return cli;
  }
  if (OFFLINE) {
    die(
      `--offline 模式下要求 ${cli} 已存在。\n` +
        '  联网构建请去掉 --offline；或手动准备后重试。',
    );
  }
  fs.mkdirSync(PKG_DIR, { recursive: true });
  await fetchPkg(POSTJECT);
  await fetchPkg(COMMANDER);
  if (!fs.existsSync(cli)) die(`postject 解包后仍找不到 ${cli}`);
  return cli;
}

// ── 3. 主流程 ───────────────────────────────────────────────────────────────
async function main() {
  preflight();
  fs.mkdirSync(DIST, { recursive: true });
  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.mkdirSync(BUILD, { recursive: true });

  // 3.1 ESM → CJS
  const cjsPath = path.join(BUILD, 'console-sea.cjs');
  const cjs = toCjs(SRC);
  fs.writeFileSync(cjsPath, cjs, 'utf8');
  log(`[build] 已生成 CJS 入口 ${path.basename(cjsPath)}（${(cjs.length / 1024).toFixed(1)} KB）`);

  // 3.2 语法自检 —— 转换出来的东西必须是合法 JS，否则后面注入完才发现就晚了
  const chk = spawnSync(process.execPath, ['--check', cjsPath], { encoding: 'utf8' });
  if (chk.status !== 0) {
    die('转换后的 CJS 过不了 node --check：\n' + (chk.stderr || chk.stdout || ''));
  }

  // 3.3 生成 SEA blob
  const seaCfg = path.join(BUILD, 'sea-config.json');
  const blobPath = path.join(BUILD, 'sea-prep.blob');
  fs.writeFileSync(
    seaCfg,
    JSON.stringify(
      {
        main: cjsPath,
        output: blobPath,
        disableExperimentalSEAWarning: true,
        // 静态资源不内联：exe 运行时按 MOLLY_CONSOLE_DIR 读目录，
        // 这样改 console.js 不用重新打包（deploy.md 有说明）。
      },
      null,
      2,
    ),
    'utf8',
  );
  log('[build] 生成 SEA blob …');
  const blobRun = spawnSync(process.execPath, ['--experimental-sea-config', seaCfg], {
    encoding: 'utf8',
    cwd: BUILD,
  });
  if (blobRun.status !== 0) {
    die('生成 blob 失败：\n' + (blobRun.stderr || blobRun.stdout || ''));
  }
  if (!fs.existsSync(blobPath)) die('命令返回 0 但 blob 没生成，SEA 配置有问题');
  log(`[build]   blob ${kb(fs.statSync(blobPath).size)}`);

  // 3.4 复制 node.exe 作为宿主
  log('[build] 复制 node 运行时 …');
  fs.copyFileSync(process.execPath, OUT_EXE);
  log(`[build]   ${kb(fs.statSync(OUT_EXE).size)}`);

  // 3.5 注入 blob
  const postjectCli = await ensurePostject();
  log('[build] 注入 blob 到 exe（会警告签名被破坏，正常）…');
  const inj = spawnSync(
    process.execPath,
    [postjectCli, OUT_EXE, 'NODE_SEA_BLOB', blobPath, '--sentinel-fuse', FUSE],
    { encoding: 'utf8', cwd: DIST },
  );
  if (inj.status !== 0) {
    die('注入失败：\n' + (inj.stderr || '') + (inj.stdout || ''));
  }
  // postject 在 Windows 上必然报 "signature seems corrupted"（node.exe 自带签名，
  // 追加数据后失效）。未签名 exe 仍可运行，只是首次运行可能触发 SmartScreen。
  if (/signature seems corrupted/i.test(inj.stderr || '')) {
    log('[build]   签名警告：已忽略（追加数据导致原签名失效，不影响运行）');
  }

  // 3.6 冒烟测试：--version 必须能跑，否则这个 exe 是废的
  log('[build] 冒烟测试 --version …');
  const ver = spawnSync(OUT_EXE, ['--version'], { encoding: 'utf8', timeout: 60000 });
  if (ver.status !== 0) {
    die(`生成的 exe 跑不起来（exit=${ver.status}）：\n${ver.stderr || ver.stdout || ''}`);
  }
  const firstLine = String(ver.stdout).split('\n')[0].trim();
  log(`[build]   ${firstLine}`);

  // 3.7 把前端快照进 dist/console/，让 dist 整个目录可以直接打包搬走。
  // 注意这是「构建时快照」：之后改 qq-whale/console/ 下的文件不会自动同步到 dist，
  // 本地跑应当直接用 qq-whale/console/，dist 里的副本只服务于「拷到别的机器」。
  const distConsole = path.join(DIST, 'console');
  const haveAll = ['index.html', 'console.js', 'console.css'].every((f) =>
    fs.existsSync(path.join(CONSOLE_DIR, f)),
  );
  if (haveAll) {
    fs.rmSync(distConsole, { recursive: true, force: true });
    fs.mkdirSync(distConsole, { recursive: true });
    for (const f of ['index.html', 'console.js', 'console.css']) {
      const src = path.join(CONSOLE_DIR, f);
      fs.copyFileSync(src, path.join(distConsole, f));
    }
    log('[build] 前端已快照到 dist/console/（构建时副本，不是链接）');
  } else {
    log('[build] ⚠ 前端三件套不全，跳过 dist/console/ 快照');
  }

  // 3.8 配置外置：dist/console.json 是用户实际改的那份，console.example.json 是模板。
  // 只在不存在时生成，绝不覆盖用户已经改过的配置。
  const cfgOut = path.join(DIST, 'console.json');
  const example = path.join(DIST, 'console.example.json');
  if (!fs.existsSync(cfgOut)) {
    const real = {
      host: '127.0.0.1',
      port: 19392,
      pluginBase: '',
      sidecar: 'http://127.0.0.1:19391',
      napcat: 'http://127.0.0.1:6099',
      token: '',
      consoleDir: '',
    };
    fs.writeFileSync(cfgOut, JSON.stringify(real, null, 2) + '\n', 'utf8');
    log('[build] 已生成 dist/console.json（首次，之后不会被覆盖）');
  } else {
    log('[build] dist/console.json 已存在，保留不动');
  }
  if (!fs.existsSync(example)) log('[build] ⚠ dist/console.example.json 不存在（应由仓库提供）');

  // 3.9 汇总
  const st = fs.statSync(OUT_EXE);
  const sha = crypto.createHash('sha256').update(fs.readFileSync(OUT_EXE)).digest('hex');

  if (!KEEP) fs.rmSync(BUILD, { recursive: true, force: true });

  log('');
  log('════════════════════════════════════════════');
  log(`  产物  ${OUT_EXE}`);
  log(`  大小  ${st.size} 字节 (${kb(st.size)})`);
  log(`  sha256 ${sha}`);
  log(`  版本  ${firstLine}`);
  log('════════════════════════════════════════════');
  log('');
  log('下一步：把 dist/ 整个目录拷到目标机，或直接：');
  log(`  ${OUT_EXE}`);
  log('（前端静态资源在 console/ 子目录；配置改 console.json）');
}

main().catch((e) => die(e && e.stack ? e.stack : String(e)));
