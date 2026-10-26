#!/usr/bin/env node
/**
 * resolve-paths.mjs —— 工具脚本共用的路径推导（2026-10-26，部署者反馈 m03205）
 *
 * 背景：panel-data.mjs / console-server.mjs 以前都把作者机的绝对路径写成默认值
 * （`${MOLLY_ROOT}\data\qq-whale`）。别的机器上要么读不到数据，要么得改代码。
 *
 * 这里提供一个「按插件真实配置找数据目录」的推导：
 *   1) 环境变量 MOLLY_DATA_DIR（调用方自己处理，本模块不读环境变量）
 *   2) DSH profile 配置里的 dataDir（~/.dsh/profiles/<profile>/cordis.patch.yml
 *      或 ~/.dsh/profiles/cordis.patch.yml，定位 `dsh-qq-whale` 这一项）
 *   3) 空串 —— 由调用方决定兜底（一般是 <用户目录>/.dsh/qq-whale）
 *
 * 只做只读解析，不依赖第三方 YAML 库，也不猜：找不到就返回空串。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 在一份 cordis.patch.yml 文本里定位 dsh-qq-whale 配置项下的 `dataDir`。
 * 支持两种写法：
 *   - 列表项：      `- id: dsh-qq-whale` … 同项内 `dataDir: ...`
 *   - 顶层映射键：  `dsh-qq-whale:` … 下一层 `dataDir: ...`
 * @param {string} text
 * @returns {string} 绝对路径；找不到返回空串
 */
export function dataDirInYml(text) {
  const lines = String(text || '').split(/\r?\n/);
  const isEntryStart = (line) => /^\s*-\s+(id|name)\s*:/.test(line);
  const isIdLine = (line) => /^\s*-\s*(id|name)\s*:\s*["']?dsh-qq-whale["']?\s*(#.*)?$/.test(line);

  // ① 列表项写法
  for (let i = 0; i < lines.length; i++) {
    if (!isIdLine(lines[i])) continue;
    const indent = lines[i].length - lines[i].trimStart().length;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const ind = line.length - line.trimStart().length;
      if (isEntryStart(line) && ind <= indent) break;
      const m = /^\s*dataDir\s*:\s*(.+?)\s*$/.exec(line);
      if (m) {
        const val = m[1].replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '').trim();
        if (val) return path.resolve(val);
      }
    }
  }

  // ② 顶层映射写法
  let sectionIndent = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;
    if (sectionIndent >= 0) {
      if (indent <= sectionIndent) {
        sectionIndent = -1;
        continue;
      }
      const m = /^\s*dataDir\s*:\s*(.+?)\s*$/.exec(line);
      if (m) {
        const val = m[1].replace(/\s+#.*$/, '').trim().replace(/^['"]|['"]$/g, '').trim();
        if (val) return path.resolve(val);
      }
      continue;
    }
    if (/^\s*dsh-qq-whale\s*:\s*(#.*)?$/.test(line)) sectionIndent = indent;
  }
  return '';
}

/**
 * 依次查看 DSH profile 配置，返回第一个能找到的 dataDir（绝对路径）。
 * @param {{ profileDir?: string, homeDir?: string }} [opts]
 * @returns {string} 找不到返回空串
 */
export function detectDataDirFromProfiles(opts = {}) {
  const home = opts.homeDir || os.homedir();
  const roots = [];
  const explicit = String(opts.profileDir || process.env.DSH_PROFILE_DIR || '').trim();
  if (explicit) roots.push(explicit);
  roots.push(path.join(home, '.dsh', 'profiles'));

  for (const root of roots) {
    let entries = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const yml = path.join(root, entry.name, 'cordis.patch.yml');
      try {
        const hit = dataDirInYml(fs.readFileSync(yml, 'utf8'));
        if (hit) return hit;
      } catch {
        /* 没有这份配置就跳过 */
      }
    }
    try {
      const hit = dataDirInYml(fs.readFileSync(path.join(root, 'cordis.patch.yml'), 'utf8'));
      if (hit) return hit;
    } catch {
      /* ignore */
    }
  }
  return '';
}

/** 插件的默认数据目录（与 lib/main.js 的 DEFAULTS.dataDir 一致）。 */
export function defaultDataDir(homeDir = os.homedir()) {
  return path.join(homeDir, '.dsh', 'qq-whale');
}
