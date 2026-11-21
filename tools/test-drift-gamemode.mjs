/**
 * test-drift-gamemode.mjs —— 游戏模式必须管住「闲逛」这条会开浏览器的定时任务
 *
 * 为什么单独写这个（2026-11-21，主人 m04658）：
 *   「我应该还没关游戏模式吧，为什么又开始小黑盒」
 *   查下来是 drift（闲逛）每 60 秒 tick 一次，到点就让那条 drift 干活会话去小黑盒翻帖子，
 *   翻帖子要拉浏览器、占 CPU；而 tick() 以前只看时间窗 / 额度 / 空闲，完全不看游戏模式。
 *   这个用例盯的就是那一行门禁，别以后又被谁删掉。
 *
 * 全离线：不联网、不碰真数据目录、不写盘（runOnce 被 stub 掉）。
 */
import assert from 'node:assert/strict';
import { Drift } from '../plugin/dsh-qq-whale/lib/drift.js';

let pass = 0;
let fail = 0;
const cases = [];
function test(name, fn) { cases.push([name, fn]); }

/** 造一个「除了游戏模式以外，其它条件全都满足触发」的 Drift。 */
function makeDrift({ config = {}, engine = {} } = {}) {
  const d = new Drift({
    logger: () => {},
    config: { driftEnabled: true, ...config },
    executor: { run: async () => ({ ok: true, text: '（stub）' }) },
    engine,
    client: null,
    dataDir: 'C:/Molly-build-test/.tmp-drift',
  });
  // 把「时间窗 / 空闲 / 额度 / 冷却」全部置为满足，只留游戏模式这一个变量
  d.inWindow = () => true;
  d.idleMs = () => 10 * 3600 * 1000;
  d.budgetLeft = () => 999;
  d.lastRunAt = 0;
  d.count = 0;
  let calls = 0;
  d.runOnce = async () => { calls += 1; return { ok: true }; };
  return { d, calls: () => calls };
}

test('游戏模式开着（config.gameModeOn）→ tick 一轮都不跑', async () => {
  const { d, calls } = makeDrift({ config: { gameModeOn: true } });
  await d.tick();
  assert.equal(calls(), 0);
});

test('游戏模式只挂在 engine.config 上也认（web.js 改的就是它）', async () => {
  const { d, calls } = makeDrift({ engine: { config: { gameModeOn: true } } });
  await d.tick();
  assert.equal(calls(), 0);
});

test('游戏模式关着 → 条件都满足时正常跑一轮', async () => {
  const { d, calls } = makeDrift({ config: { gameModeOn: false } });
  await d.tick();
  assert.equal(calls(), 1);
});

test('gameModeOn 完全没设过（DSH 刚重启、还没被控制台补开）→ 不拦', async () => {
  const { d, calls } = makeDrift();
  await d.tick();
  assert.equal(calls(), 1);
});

test('有值但不是 true（字符串 / 1）→ 不拦，只认真正的 true', async () => {
  for (const v of ['true', 1, 'yes', {}]) {
    const { d, calls } = makeDrift({ config: { gameModeOn: v } });
    await d.tick();
    assert.equal(calls(), 1, `gameModeOn=${JSON.stringify(v)} 不该被当成开着`);
  }
});

test('游戏模式优先级高于「额度够 + 已过冷却 + 在时间窗」', async () => {
  const { d, calls } = makeDrift({ config: { gameModeOn: true } });
  d.lastRunAt = 0;          // 冷却早就过了
  d.count = 0;              // 今日额度一点没用
  d.idleMs = () => 24 * 3600 * 1000;  // 一整天没人说话
  d.budgetLeft = () => 100000;
  await d.tick();
  assert.equal(calls(), 0);
});

test('上一轮还在跑（running）时仍然不动，与游戏模式无关', async () => {
  const { d, calls } = makeDrift({ config: { gameModeOn: false } });
  d.running = true;
  await d.tick();
  assert.equal(calls(), 0);
});

test('status() 里能看见 gameMode，控制台/state 一眼可判', async () => {
  const on = makeDrift({ config: { gameModeOn: true } }).d;
  const off = makeDrift({ config: { gameModeOn: false } }).d;
  assert.equal(on.status().gameMode, true);
  assert.equal(off.status().gameMode, false);
});

test('DSH 重启后 gameModeOn 丢失时，status 如实报 false（不假装在拦）', () => {
  const { d } = makeDrift();
  assert.equal(d.status().gameMode, false);
});

for (const [name, fn] of cases) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}\n       ${err?.message || err}`);
  }
}

console.log(`\n游戏模式×闲逛：${pass} 过 / ${fail} 挂`);
process.exit(fail === 0 ? 0 : 1);
