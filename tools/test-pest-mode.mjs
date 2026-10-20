/**
 * 「骂人模式」真正的总闸（task-37）验收测试。
 *
 * 事故（2026-10-19 23:51 用户截图）：控制台把 pest 开关关掉后，她**照样**在群里
 * 骂 333333333。根子不是 pest 模块，而是 `persona/core.md` 里硬写着「往死里骂」
 * 那一节——它是系统提示词的一部分，开关根本碰不到它。
 *
 * 修法：那一节搬进 `persona/pest-mode.md`，`PersonaStore.systemPrompt({pestMode})`
 * 只在 true 时拼进去；`engine.buildSystemPrompt` 传 `this.pest?.enabled === true`。
 *
 * 这个测试盯四件事：
 *   1. pestMode=false 的提示词里**一个字**都不能有「333333333 / 出气筒 / 往死里骂」；
 *   2. pestMode=true 时那节在；
 *   3. pest-mode.md 缺失 / 读坏时**静默降级**，false/true 都不抛异常；
 *   4. engine 真的把 `pest.enabled` 传下去了（防只改 persona 没接线）。
 *
 * 跑法：
 *   & "${HOME}\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" `
 *     ${MOLLY_ROOT}\qq-whale\tools\test-pest-mode.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJ = path.resolve(HERE, '..')
const LIB = process.env.PEST_LIB_DIR || path.join(PROJ, 'plugin', 'dsh-qq-whale', 'lib')
const PERSONA = path.join(PROJ, 'plugin', 'dsh-qq-whale', 'persona')
const TMP = path.join(PROJ, 'out', 'test-pest-mode-data')

const { PersonaStore } = await import(pathToFileURL(path.join(LIB, 'persona.js')).href)
const { ChatEngine } = await import(pathToFileURL(path.join(LIB, 'engine.js')).href)

let pass = 0
let fail = 0
const failures = []

function ok(cond, name, extra) {
  if (cond) {
    pass++
    console.log(`  ✔ ${name}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  ✘ ${name}${extra === undefined ? '' : `（${extra}）`}`)
  }
}

/**
 * 出气筒换过人（原来 333333333，现在 444444444），所以断言不能写死号。
 * 目标号从 yml 的 pestTargets 兜底值里读；读不到才用当前默认。
 */
function resolvePestTarget() {
  const yml = 'C:/Users/example/.dsh/profiles/desktop/cordis.patch.yml'
  try {
    const text = fs.readFileSync(yml, 'utf8')
    const m = text.match(/pestTargets:[^\n]*\n((?:\s+-\s*["']?\d+["']?\s*\n?)+)/)
    if (m) {
      const found = m[1].match(/\d{5,12}/g)
      if (found && found.length) return found[0]
    }
  } catch { /* yml 读不到就用默认，测试不该因此断 */ }
  return '444444444'
}

const PEST_TARGET = resolvePestTarget()
/** 历史上被骂过的号：关闭时**任何**一个都不许出现。 */
const LEGACY_TARGETS = ['333333333']
const FORBIDDEN = [...LEGACY_TARGETS, '出气筒', '往死里骂', '骂人模式']

function assertClean(text, label, force) {
  for (const word of FORBIDDEN) {
    ok(force ? !text.includes(word) : !text.includes(word), `${label} 不含「${word}」`)
  }
}

try {
  fs.rmSync(TMP, { recursive: true, force: true })

  /* ------------------------- [1] core.md 本身已经干净 ------------------------- */
  console.log('\n[1] core.md 里不再有那个号/那套设定')
  const core = fs.readFileSync(path.join(PERSONA, 'core.md'), 'utf8')
  assertClean(core, 'core.md', true)
  ok(fs.existsSync(path.join(PERSONA, 'pest-mode.md')), 'pest-mode.md 已建')

  const pestOnly = fs.readFileSync(path.join(PERSONA, 'pest-mode.md'), 'utf8')
  ok(pestOnly.includes(PEST_TARGET), 'pest-mode.md 里的目标号 = 配置里的 ' + PEST_TARGET)
  ok(pestOnly.includes('往死里骂'), 'pest-mode.md 里保留原指令文案')
  ok(/别骂了/.test(pestOnly) && /静音/.test(pestOnly), '「别骂了」的收敛信号已和 pest 静音对齐')

  /* ------------------------- [2] PersonaStore：关 = 一句都不加 ------------------------- */
  console.log('\n[2] PersonaStore.systemPrompt：pestMode 开关真的决定加不加')
  const store = new PersonaStore({ dir: PERSONA, logger: () => {} })

  const off = store.systemPrompt({ scene: 'group', userName: '某人', groupName: '测试群', pestMode: false })
  assertClean(off, 'pestMode:false 的提示词', true)
  ok(off.includes('蓝色大肥鱼'), '关掉时人设本体还在（不会因为少一节整体失效）')

  const on = store.systemPrompt({ scene: 'group', userName: '某人', groupName: '测试群', pestMode: true })
  ok(on.includes(PEST_TARGET), 'pestMode:true 时有目标号 ' + PEST_TARGET)
  ok(on.includes('出气筒'), 'pestMode:true 时有「出气筒」')
  ok(on.includes('往死里骂'), 'pestMode:true 时有「往死里骂」')
  ok(on.length > off.length, 'true 的输出确实更长（追加而不是替换）')

  const noArg = store.systemPrompt({ scene: 'private', userName: '某人' })
  assertClean(noArg, '不传 pestMode（默认 false）的提示词', true)

  /* ------------------------- [3] 文件缺失：静默降级，不抛 ------------------------- */
  console.log('\n[3] pest-mode.md 缺失 / 读坏：静默降级为「不追加」')
  fs.mkdirSync(TMP, { recursive: true })
  fs.writeFileSync(path.join(TMP, 'core.md'), core, 'utf8')
  const bare = new PersonaStore({ dir: TMP, logger: () => {} })
  let threw = null
  try {
    ok(bare.pestModeText === '', '缺失时 pestModeText 为空串（静默，不抛）')
    const bareOn = bare.systemPrompt({ scene: 'group', pestMode: true })
    assertClean(bareOn, '缺文件 + pestMode:true 的提示词', true)
    ok(bareOn.includes('蓝色大肥鱼'), '缺文件时人设本体照常输出')
    const bareOff = bare.systemPrompt({ scene: 'group', pestMode: false })
    ok(bareOff.length > 0, '缺文件 + pestMode:false 也正常出提示词')
  } catch (err) {
    threw = err
  }
  ok(threw === null, '缺文件时 false/true 都不抛异常', threw && threw.message)

  /* ------------------------- [4] engine 接线 ------------------------- */
  console.log('\n[4] engine.buildSystemPrompt 真的把 pest.enabled 传下去了')
  function makeEngine(pestEnabled) {
    const engine = Object.create(ChatEngine.prototype)
    engine.client = { self: { nickname: 'Molly' } }
    engine.persona = store
    engine.memory = { contextFor: () => '', recall: () => [] }
    engine.relations = { contextFor: () => '' }
    engine.memberRoster = () => ''
    engine.stickers = { catalogText: () => '' }
    engine.config = {}
    engine.pest = { enabled: pestEnabled }
    return engine
  }
  const conv = { history: [], relationKey: '' }

  const spOff = makeEngine(false).buildSystemPrompt({ scene: 'group', userName: '某人', conv })
  assertClean(spOff, 'engine 在 pest.enabled=false 时组出的提示词', true)
  ok(spOff.includes('蓝色大肥鱼'), '关掉时引擎侧人设完好')

  const spOn = makeEngine(true).buildSystemPrompt({ scene: 'group', userName: '某人', conv })
  ok(spOn.includes(PEST_TARGET) && spOn.includes('往死里骂'), 'engine 在 pest.enabled=true 时把骂人节拼进来了（含目标号）')

  const spNoPest = (() => {
    const e = makeEngine(false)
    e.pest = null
    return e.buildSystemPrompt({ scene: 'group', userName: '某人', conv })
  })()
  assertClean(spNoPest, 'pest 模块缺失（null）时的提示词', true)
} catch (err) {
  fail++
  failures.push('未捕获异常：' + err.message)
  console.error('\n未捕获异常：', err)
} finally {
  fs.rmSync(TMP, { recursive: true, force: true })
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`)
  if (fail) {
    console.log('失败项：')
    for (const f of failures) console.log(`  - ${f}`)
    process.exit(1)
  }
  process.exit(0)
}
