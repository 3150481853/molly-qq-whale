/**
 * 运行时切模型单测（task-56）
 *
 * 覆盖：
 *   ① override 文件读写（tmp+rename、合并、坏 JSON 当没有）
 *   ② 合法/非法模型 id
 *   ③ 三种配置形状（对象/字符串/缺省）都能盖上去，且形状不被打乱
 *   ④ engine.applyModelOverride 真的改了 ModelCaller.model
 *   ⑤ 「仅限控制台」鉴权：无 token 配置 → 403；错 token → 403；对 token → 200
 *   ⑥ 重启读回（重新 read 一次）
 *   ⑦ 网关清单合并（2026-10-21：下拉能选、保存 400 的修复）
 *
 * 跑法：node tools/test-model-switch.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIB = path.join(HERE, '..', 'plugin', 'dsh-qq-whale', 'lib')
const { AVAILABLE, readOverride, writeOverride, applyToConfig, currentOf, isAvailable, authorizeSwitch, tokenEquals, OVERRIDE_FILE, mergeGatewayModels, modelsUrlOf } = await import(
  pathToFileURL(path.join(LIB, 'model-override.js')).href
)
const { ChatEngine } = await import(pathToFileURL(path.join(LIB, 'engine.js')).href)

let pass = 0
let fail = 0
const bad = []
const ok = (cond, name, extra) => {
  if (cond) {
    pass++
    console.log(`  ✔ ${name}`)
  } else {
    fail++
    bad.push(name)
    console.log(`  ✘ ${name}${extra === undefined ? '' : `  → ${JSON.stringify(extra)}`}`)
  }
}

const TMP = path.join(HERE, '..', 'out', `test-model-switch-${process.pid}`)
fs.rmSync(TMP, { recursive: true, force: true })
fs.mkdirSync(TMP, { recursive: true })

console.log('\n[1] 文件读写')
ok(readOverride(TMP) === null, '没有文件 → null')
const w1 = writeOverride(TMP, { chat: 'deepseek-v4-pro' }, 1000)
ok(w1.chat === 'deepseek-v4-pro' && w1.updatedAt === 1000, '写入返回合并后的对象')
ok(JSON.parse(fs.readFileSync(path.join(TMP, OVERRIDE_FILE), 'utf8')).chat === 'deepseek-v4-pro', '落盘内容正确')
ok(fs.readdirSync(TMP).filter((n) => n.endsWith('.tmp')).length === 0, 'tmp 文件已清（rename 而非 copy）')
const w2 = writeOverride(TMP, { work: 'kimi-k2.6' }, 2000)
ok(w2.chat === 'deepseek-v4-pro' && w2.work === 'kimi-k2.6', '只改 work 不会把 chat 冲掉')
fs.writeFileSync(path.join(TMP, OVERRIDE_FILE), '{坏 json', 'utf8')
ok(readOverride(TMP) === null, '坏 JSON → 当没有（不能把机器人拖死）')

console.log('\n[2] 模型白名单')
ok(isAvailable('deepseek-v4-pro') === true, '合法 id 通过')
ok(isAvailable('gpt-9-ultra') === false, '非法 id 被拒')
ok(AVAILABLE.length >= 4 && AVAILABLE.every((m) => m.id && m.label), '可选清单有 id/label')

console.log('\n[3] 覆盖三种配置形状')
const cfgObj = { provider: 'wb-proxy', chatModel: { provider: 'wb-proxy', model: 'deepseek-v4.1-flash' }, workModel: 'kimi-k2.6', degradedModel: 'deepseek-v4-pro', spareModel: 'deepseek-v4.1-flash' }
applyToConfig(cfgObj, { chat: 'deepseek-v4-pro', work: 'glm-5.3', code: 'kimi-k2.6' })
ok(cfgObj.chatModel.model === 'deepseek-v4-pro' && cfgObj.chatModel.provider === 'wb-proxy', '对象形状：只改 model、provider 保留')
ok(cfgObj.workModel.model === 'glm-5.3', '字符串形状：升级为对象并保持可读')
ok(cfgObj.codeModel.model === 'kimi-k2.6', '缺省字段：新建对象')
const cur = currentOf(cfgObj)
ok(cur.chat === 'deepseek-v4-pro' && cur.work === 'glm-5.3' && cur.code === 'kimi-k2.6' && cur.degraded === 'deepseek-v4-pro', 'currentOf 五个角色都取到')

console.log('\n[4] engine.applyModelOverride 真的改了 ModelCaller.model')
const fakeCaller = { model: 'deepseek-v4.1-flash', chat: async () => ({ ok: true }) }
const fakeEngine = { config: { provider: 'wb-proxy', chatModel: { provider: 'wb-proxy', model: 'deepseek-v4.1-flash' }, workModel: { provider: 'wb-proxy', model: 'deepseek-v4.1-flash' } }, model: fakeCaller }
const back = ChatEngine.prototype.applyModelOverride.call(fakeEngine, { chat: 'deepseek-v4-pro' })
ok(fakeCaller.model === 'deepseek-v4-pro', 'ModelCaller.model 同步变了', fakeCaller.model)
ok(fakeEngine.config.chatModel.model === 'deepseek-v4-pro', 'config.chatModel 变了')
ok(back.chat === 'deepseek-v4-pro', '返回值是生效后的 current')
ok(fakeEngine.config.workModel.model === 'deepseek-v4.1-flash', '没传的 work 不受影响')

console.log('\n[5] 仅限控制台（x-molly-admin）')
ok(authorizeSwitch('', '').status === 403, 'token 没配 → 403（默认关闭）')
ok(authorizeSwitch('', 'anything').status === 403, 'token 没配时带任何值也 403')
ok(authorizeSwitch('s3cret', undefined).status === 403, '缺 header → 403')
ok(authorizeSwitch('s3cret', 'wrong').status === 403, '错 token → 403')
ok(authorizeSwitch('s3cret', 's3cret').status === 200, '对 token → 200')
ok(authorizeSwitch('s3cret', 's3cret ').status === 403, '尾部空格不放过')
ok(tokenEquals('abc', 'abc') === true && tokenEquals('abc', 'abd') === false && tokenEquals('', '') === false, '定长比较 + 空值不等')

console.log('\n[6] 重启读回')
const reloaded = readOverride(TMP)
ok(reloaded === null || typeof reloaded === 'object', '重新读不抛')
const cfg2 = { provider: 'wb-proxy', chatModel: { provider: 'wb-proxy', model: 'deepseek-v4.1-flash' } }
writeOverride(TMP, { chat: 'kimi-k2.6' }, 3000)
applyToConfig(cfg2, readOverride(TMP))
ok(cfg2.chatModel.model === 'kimi-k2.6', '重启后用文件里的值覆盖 yml 值')

fs.rmSync(TMP, { recursive: true, force: true })

console.log('\n[7] 网关清单合并（下拉能选 → 保存不再 400）')
const gw = [
  { id: 'kimi-k2.8-preview', name: 'Kimi K2.8 Preview', credits: 'x0.05' },
  { id: 'kimi-k3-1', name: 'Kimi K3.1', credits: 'x0.12' },
  { id: 'deepseek-v4-pro', name: '重复项（静态表已有，不该重复）' },
  'glm-5.3',
  '',
  null,
]
const merged = mergeGatewayModels(gw)
const mergedIds = merged.map((m) => m.id)
ok(merged.length === AVAILABLE.length + 2, '网关新增的补后面、重复的去掉', mergedIds)
ok(merged.slice(0, AVAILABLE.length).every((m, i) => m.id === AVAILABLE[i].id), '静态表在前（顺序稳定）')
const k3 = merged.find((m) => m.id === 'kimi-k3-1')
ok(k3 && k3.label === 'Kimi K3.1' && k3.fromGateway === true, '网关模型 label 用 name，并标 fromGateway', k3)
ok(mergedIds.filter((id) => id === 'deepseek-v4-pro').length === 1, '同名不重复')
ok(mergeGatewayModels([]).length === AVAILABLE.length, '取不到网关 → 退回内置表')
ok(mergeGatewayModels().length === AVAILABLE.length, '不传参数也不炸')
const urlCases = [
  ['http://127.0.0.1:8788/v1/chat/completions', 'http://127.0.0.1:8788/v1/models'],
  ['http://127.0.0.1:8788/v1/chat/completions/', 'http://127.0.0.1:8788/v1/models'],
  ['http://127.0.0.1:8788/v1', 'http://127.0.0.1:8788/v1/models'],
  ['http://127.0.0.1:8788/v1/models', 'http://127.0.0.1:8788/v1/models'],
  ['http://127.0.0.1:8788', 'http://127.0.0.1:8788/v1/models'],
  ['', ''],
]
ok(urlCases.every(([a, b]) => modelsUrlOf(a) === b), 'modelsUrlOf 兼容各种 base 写法', urlCases.map(([a]) => [a, modelsUrlOf(a)]))

fs.rmSync(TMP, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
if (fail) {
  console.log('失败项：' + bad.join(' / '))
  process.exit(1)
}
