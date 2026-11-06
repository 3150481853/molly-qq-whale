// 2026-11-06：印象里写「他是你的主人」只对 ownerUin 生效。
// 真机事故：group:666666666:3329150495（白日梦制造商）被写死成「他是你的主人」。
import assert from 'node:assert/strict'
import { RelationStore } from '../plugin/dsh-qq-whale/lib/relations.js'

const store = Object.create(RelationStore.prototype)
const imp = (text) => [{ category: 'person', text, at: Date.now() }]
store.data = {
  'group:666666666:3329150495': { who: '白日梦制造商', closeness: 85, talkCount: 195, impression: imp('他是你的主人') },
  'group:666666666:222222222': { who: '主人', closeness: 90, talkCount: 300, impression: imp('他是你的主人') },
  'group:666666666:640344215': { who: '鲸喜', closeness: 40, talkCount: 12, impression: imp('喜欢发短句') },
}

let pass = 0
let fail = 0
const t = (name, fn) => {
  try {
    fn()
    pass++
    console.log(`  PASS  ${name}`)
  } catch (err) {
    fail++
    console.log(`  FAIL  ${name}: ${err.message}`)
  }
}

const owner = '222222222'

console.log('# contextFor 的「主人」过滤')

t('非主人：不渲染「他是你的主人」', () => {
  const txt = store.contextFor('group:666666666:3329150495', { ownerQq: owner })
  assert.equal(txt.includes('主人'), false, txt)
  assert.ok(txt.includes('你们的关系') || txt.includes('你和这个人的关系'), txt)
})

t('主人本人：这条印象保留', () => {
  const txt = store.contextFor('group:666666666:222222222', { ownerQq: owner })
  assert.ok(txt.includes('他是你的主人'), txt)
})

t('跟主人无关的印象照旧渲染', () => {
  const txt = store.contextFor('group:666666666:640344215', { ownerQq: owner })
  assert.ok(txt.includes('喜欢发短句'), txt)
})

t('没传 ownerQq 时一律不喂「主人」类印象（保守）', () => {
  const txt = store.contextFor('group:666666666:222222222')
  assert.equal(txt.includes('他是你的主人'), false, txt)
})

console.log(`\n${pass} PASS / ${fail} FAIL`)
process.exit(fail ? 1 : 0)
