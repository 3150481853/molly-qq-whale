/**
 * 群命令白名单（commandGroups）单元测试。
 * 直接对**安装副本**里的 commands.js 做，确保测的是宿主真正加载的那份。
 */
import assert from 'node:assert'
import fs from 'node:fs'

const P = 'C:/Users/example/.dsh/profiles/desktop/node_modules/dsh-qq-whale/lib/commands.js'
const mod = await import('file:///' + P + '?t=' + Date.now())
const CE = mod.CommandExecutor || mod.default?.CommandExecutor || mod.default
if (!CE) {
  console.error('找不到 CommandExecutor 导出，实际导出：', Object.keys(mod))
  process.exit(1)
}

let pass = 0
let fail = 0
const t = (name, fn) => {
  try {
    fn()
    pass++
    console.log(' ok  ' + name)
  } catch (e) {
    fail++
    console.log('FAIL ' + name + ' — ' + e.message)
  }
}

function mk(config) {
  const o = Object.create(CE.prototype)
  o.config = { commandEnabled: true, commandPrefixes: ['命令 '], ...config }
  return o
}

const OWNER = '222222222'
const ADM = '333333333'
const GUEST = '456456456'
const G_TEST = '777777777'
const G_OTHER = '666666666'

const priv = (uin) => ({ message_type: 'private', user_id: uin })
const grp = (uin, gid) => ({ message_type: 'group', user_id: uin, group_id: gid })

const base = { commanderUsers: [OWNER, ADM], commandGroups: [G_TEST] }
const ex = mk(base)

t('私聊 主人 → 可下指令', () => assert.strictEqual(ex.isCommander(OWNER, priv(OWNER)), true))
t('私聊 adm → 可下指令', () => assert.strictEqual(ex.isCommander(ADM, priv(ADM)), true))
t('私聊 路人 → 不行', () => assert.strictEqual(ex.isCommander(GUEST, priv(GUEST)), false))
t('白名单群 主人 → 可下指令', () => assert.strictEqual(ex.isCommander(OWNER, grp(OWNER, G_TEST)), true))
t('白名单群 adm → 可下指令', () => assert.strictEqual(ex.isCommander(ADM, grp(ADM, G_TEST)), true))
t('白名单群 路人 → 不行（还是要是指挥官）', () =>
  assert.strictEqual(ex.isCommander(GUEST, grp(GUEST, G_TEST)), false))
t('非白名单群 主人 → 不行', () => assert.strictEqual(ex.isCommander(OWNER, grp(OWNER, G_OTHER)), false))
t('isCommandGroup 白名单群 → true', () => assert.strictEqual(ex.isCommandGroup(grp(OWNER, G_TEST)), true))
t('isCommandGroup 非白名单群 → false', () => assert.strictEqual(ex.isCommandGroup(grp(OWNER, G_OTHER)), false))
t('isCommandGroup 私聊 → false（私聊不走这道闸）', () =>
  assert.strictEqual(ex.isCommandGroup(priv(OWNER)), false))

t('commandGroups 为空时 群里一律不放行（默认安全）', () => {
  const e2 = mk({ commanderUsers: [OWNER], commandGroups: [] })
  assert.strictEqual(e2.isCommander(OWNER, grp(OWNER, G_TEST)), false)
  assert.strictEqual(e2.isCommandGroup(grp(OWNER, G_TEST)), false)
})

t('commandEnabled=false 时 私聊也不放行', () => {
  const e2 = mk({ commanderUsers: [OWNER], commandGroups: [G_TEST], commandEnabled: false })
  assert.strictEqual(e2.isCommander(OWNER, priv(OWNER)), false)
  assert.strictEqual(e2.isCommandGroup(grp(OWNER, G_TEST)), false)
})

t('群号是数字也能匹配（String 归一化）', () => {
  const e2 = mk({ commanderUsers: [OWNER], commandGroups: [777777777] })
  assert.strictEqual(e2.isCommander(OWNER, grp(OWNER, G_TEST)), true)
})

t('前缀解析：命令 xxx → task', () => assert.strictEqual(ex.matchPrefix('命令 统计一下'), '统计一下'))

// 源码级护栏：engine.js 的调度条件必须引用 isCommandGroup
t('engine.js 调度条件已接线 isCommandGroup', () => {
  const src = fs.readFileSync(P.replace('commands.js', 'engine.js'), 'utf8')
  assert.ok(/cmdScene[\s\S]{0,200}isCommandGroup/.test(src), 'engine.js 里没有 isCommandGroup 接线')
})

console.log(`\n${pass} passed / ${fail} failed`)
process.exit(fail ? 1 : 0)
