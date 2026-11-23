/**
 * 一周热力的配色（2026-11-23，主人 m04800）。
 *
 * 测的是 console.js 里的 onHeatBg()：它必须能把「97.9%」「81.3%」「100%」分出来。
 * 旧版只有 0/25/50/75/100 五档，97.9% 与 100% 都算 100% —— 画出来一整片深绿，
 * 跟上面按天的橙格子打脸。
 *
 * 直接从 console.js 抠出这个函数来测：console.js 是单文件 IIFE，没法 import。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(path.join(HERE, '..', 'console', 'console.js'), 'utf8')

let pass = 0
let fail = 0
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++
    console.log(`  ✔ ${name}`)
  } else {
    fail++
    console.log(`  ✘ ${name}${extra ? ' — ' + extra : ''}`)
  }
}

function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`console.js 里找不到 function ${name}()`)
  let i = src.indexOf('{', start)
  let depth = 0
  for (; i < src.length; i++) {
    const ch = src[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`${name}() 的花括号没闭合`)
}

const fnSrc = extractFn(SRC, 'onHeatBg')
// eslint-disable-next-line no-new-func
const onHeatBg = new Function(`${fnSrc}; return onHeatBg;`)()

const bgOf = (v) => onHeatBg(v).bg
const DARK = 'rgba(41,79,62,1)'
const LIGHT = 'rgba(41,79,62,.66)'
const AMBER = 'rgba(186,132,36,.72)'
const RED = 'rgba(163,58,48,.72)'
const GRAY = 'rgba(25,33,30,.05)'

console.log('— 档位 —')
ok('100% → 深绿', bgOf(1) === DARK)
ok('99.7% → 深绿', bgOf(0.997) === DARK)
ok('99.2% → 浅绿', bgOf(0.992) === LIGHT)
ok('97.9%（11-13 那天）→ 琥珀', bgOf(0.979) === AMBER)
ok('95% → 琥珀（边界含）', bgOf(0.95) === AMBER)
ok('94.9% → 红', bgOf(0.949) === RED)
ok('81.3%（周2 12:00）→ 红', bgOf(0.8131) === RED)
ok('0 → 浅灰', bgOf(0) === GRAY)
ok('null → 浅灰', bgOf(null) === GRAY)
ok('undefined → 浅灰', bgOf(undefined) === GRAY)
ok('字符串 "0.992" 也认', bgOf('0.992') === LIGHT)

console.log('— 关键：这三档必须互不相同 —')
const trio = new Set([bgOf(1), bgOf(0.979), bgOf(0.8131)])
ok('100% / 97.9% / 81.3% 三种颜色', trio.size === 3, [...trio].join(' | '))
ok('旧版会把 97.9% 与 100% 画成同色（这版不是）', bgOf(0.979) !== bgOf(1))

console.log('— 文案 —')
ok('每档都有话说', ['1', '0.992', '0.979', '0.9', '0'].every((v) => typeof onHeatBg(Number(v)).label === 'string' && onHeatBg(Number(v)).label.length > 0))
ok('0 档文案是「没有采样」', onHeatBg(0).label === '没有采样')

console.log(`\n${pass} 过 / ${fail} 挂`)
process.exit(fail ? 1 : 0)
