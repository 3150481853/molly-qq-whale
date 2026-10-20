/**
 * test-engine-text.mjs —— Stage 3 Step 1 的单元测试。
 *
 * 只测搬出去的六个纯函数：文案/格式必须和搬之前**逐字**一致，
 * 随机池必须能被 `rand` 钉死，engine.js 里必须只剩一行转发。
 *
 * 跑法：node tools/test-engine-text.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  titleFor,
  rateLimitLine,
  withDegradedNote,
  speakerLabel,
  stickerFallback,
  stripGroupCardSuffix,
} from '../plugin/dsh-qq-whale/lib/engine-text.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ENGINE = path.join(HERE, '..', 'plugin', 'dsh-qq-whale', 'lib', 'engine.js')

let pass = 0
const fails = []
function t(name, fn) {
  try {
    fn()
    pass++
    console.log('  ok   ' + name)
  } catch (err) {
    fails.push(name)
    console.log('  FAIL ' + name + '\n       ' + String(err?.message || err).split('\n')[0])
  }
}

// ── titleFor ──
t('1. titleFor：只有名单第一个（唯一主人）有称呼', () => {
  const ctx = { owners: ['10001', '20002'], ownerTitle: '主人，' }
  assert.equal(titleFor('10001', ctx), '主人，')
  assert.equal(titleFor(10001, ctx), '主人，', '数字号也要认')
  assert.equal(titleFor('20002', ctx), '', '审批人没有称呼')
  assert.equal(titleFor('', ctx), '')
  assert.equal(titleFor('10001', { owners: [], ownerTitle: 'x' }), '')
  assert.equal(titleFor('10001', { owners: ['10001'], ownerTitle: undefined }), '')
})

// ── rateLimitLine ──
const LIMIT_LINES = [
  '等下……我这边嘴被堵住了，缓一会儿再跟你说',
  '白饭不够了，脑子转不动，容我歇一下',
  '唔，这会儿轮不上我说话，等会再讲',
]
t('2. rateLimitLine：三句话必须逐字一致，rand 可钉', () => {
  assert.equal(rateLimitLine(() => 0), LIMIT_LINES[0])
  assert.equal(rateLimitLine(() => 0.5), LIMIT_LINES[1])
  assert.equal(rateLimitLine(() => 0.99), LIMIT_LINES[2])
  assert.ok(LIMIT_LINES.includes(rateLimitLine()))
})

// ── withDegradedNote ──
t('3. withDegradedNote：补丁逐字一致 + 幂等', () => {
  const out = withDegradedNote('内核')
  assert.ok(out.startsWith('内核\n\n# 现在的情况\n'), '必须在原文后换两行')
  assert.ok(out.includes('脑子转得比平时慢'))
  assert.ok(out.includes('**说短一点，一句话能说完就别铺垫**'))
  assert.equal(withDegradedNote(out), out, '第二次调用不能再叠一段')
  assert.ok(withDegradedNote('').startsWith('\n\n# 现在的情况\n'), '空串也走同一段补丁')
  assert.ok(withDegradedNote(null).startsWith('\n\n# 现在的情况\n'))
})

// ── speakerLabel ──
t('4. speakerLabel：名字+QQ 都写全，缺什么省什么', () => {
  assert.equal(speakerLabel({ who: '团子', userId: '123' }), '团子（QQ 123）：')
  assert.equal(speakerLabel({ who: '团子' }), '团子：')
  assert.equal(speakerLabel({ userId: 123 }), 'QQ 123：')
  assert.equal(speakerLabel({}), '')
  assert.equal(speakerLabel(null), '')
  assert.equal(speakerLabel({ who: '  团子  ', userId: ' 9 ' }), '团子（QQ 9）：', '两端空白要去掉')
})

// ── stickerFallback ──
const FALLBACK_LINES = [
  '（找图找了半天，没找到合适的）',
  '表情包找不到了，气死',
  '算了不发图了',
  '图库里没这张，我先记下来',
  '嗯…（翻遍图库）',
]
t('5. stickerFallback：五句话逐字一致，rand 可钉', () => {
  FALLBACK_LINES.forEach((want, i) => {
    assert.equal(stickerFallback(() => (i + 0.1) / 5), want)
  })
  assert.ok(FALLBACK_LINES.includes(stickerFallback()))
})

// ── stripGroupCardSuffix ──
t('6. stripGroupCardSuffix：剥完为止，默认后缀也认', () => {
  assert.equal(stripGroupCardSuffix('Molly（在想…）'), 'Molly')
  assert.equal(stripGroupCardSuffix('Molly（在想…）（在想…）'), 'Molly')
  assert.equal(stripGroupCardSuffix('Molly'), 'Molly')
  assert.equal(stripGroupCardSuffix('  Molly  '), 'Molly', '首尾空白要 trim')
  // 既有语义（Step 1 只搬家、不改行为）：先判 endsWith 再 trim，
  // 所以「后缀前面/后面带空格」的脏名片剥不掉——这是原实现的边界，不在本步修。
  assert.equal(stripGroupCardSuffix('  Molly（在想…）  '), 'Molly（在想…）')
  assert.equal(stripGroupCardSuffix('Molly【忙】', { thinkingSuffix: '【忙】' }), 'Molly')
  assert.equal(stripGroupCardSuffix('Molly【忙】（在想…）', { thinkingSuffix: '【忙】' }), 'Molly')
  assert.equal(stripGroupCardSuffix(null), '')
  // 防御：后缀清空时不能死循环（上限 10 次）
  assert.equal(stripGroupCardSuffix('Molly', { thinkingSuffix: '' }), 'Molly')
})

// ── 搬家验收：engine.js 里只剩转发，没有旧实现 ──
t('7. engine.js 只剩一行转发：话术池/剥后缀逻辑已不在引擎里', () => {
  const src = fs.readFileSync(ENGINE, 'utf8')
  assert.equal(src.includes('白饭不够了，脑子转不动'), false, '限流话术池不应留在 engine.js')
  assert.equal(src.includes('表情包找不到了，气死'), false, '兜底话术池不应留在 engine.js')
  assert.equal(src.includes('你今天的白饭额度用完了'), false, '降智补丁不应留在 engine.js')
  assert.equal((src.match(/engineText\./g) || []).length, 6, '六个转发各一次')
  for (const fn of ['titleFor', 'rateLimitLine', 'withDegradedNote', 'speakerLabel', 'stickerFallback', 'stripGroupCardSuffix']) {
    assert.ok(new RegExp(`engineText\\.${fn}\\(`).test(src), `engine.js 应转发 ${fn}`)
  }
})

console.log('')
console.log(`${pass} passed, ${fails.length} failed`)
if (fails.length) process.exit(1)
