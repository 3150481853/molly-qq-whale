/**
 * 真实模型连通性测试。
 *
 * 直接调 DSH 的 llm 服务，用 workbuddy-ai / deepseek-v4.1-flash 跑一句，
 * 确认：① 凭据还有效 ② 分片协议对得上 ③ 免费额度确实在走。
 *
 * 为什么要单独测：插件里的 collectStream 依赖分片格式，格式对不上会静默拿到空文本，
 * 这种 bug 在 QQ 里表现为「收到消息但没反应」，最难查。
 */

import path from 'node:path'
import fs from 'node:fs'

const PROFILE = 'C:/Users/example/.dsh/profiles/desktop'

// —— 用真实 host 提供的 services 启动一个最小 cordis 根 ——
const cordisUrl = new URL(`file:///${PROFILE}/node_modules/cordis/lib/index.mjs`.replace(/\\/g, '/')).href
console.log('[boot] cordis:', cordisUrl)

const { Context } = await import(cordisUrl).catch(async (e) => {
  console.error('[boot] 直接 import cordis 失败:', e.message)
  // 退回 CommonJS 形态
  const { createRequire } = await import('node:module')
  const require = createRequire(PROFILE + '/package.json')
  return require('cordis')
})

console.log('[boot] Context:', typeof Context)

const ctx = new Context()

// 只挂 llm 相关的包
const pkgs = [
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-credentials',
  '@deepseek-ai/dsh-workbuddy-connect',
]
for (const p of pkgs) {
  try {
    const mod = await import(new URL(`file:///${PROFILE}/node_modules/${p}/lib/index.js`.replace(/\\/g, '/')).href)
    const plugin = mod.default || mod
    const name = mod.name || plugin.name || p
    console.log('[boot] 挂载', p, '→', name, typeof plugin.apply)
    if (plugin.apply) ctx.plugin({ name, apply: plugin.apply, inject: plugin.inject, Config: plugin.Config })
  } catch (e) {
    console.warn('[boot] 挂载失败', p, e.message)
  }
}

await new Promise((r) => setTimeout(r, 3000))

console.log('[boot] llm 服务:', typeof ctx.llm)
if (!ctx.llm) {
  console.error('[boot] llm 未就绪，退出')
  process.exit(1)
}

console.log('[boot] providers:', JSON.stringify(ctx.llm.listProviders?.()?.map?.((p) => p.provider || p) ?? 'n/a'))

const ac = new AbortController()
const t0 = Date.now()
let text = ''
let finish = null
let errors = []

try {
  const stream = ctx.llm.stream({
    provider: 'workbuddy-ai',
    model: 'deepseek-v4.1-flash',
    maxTokens: 200,
    temperature: 0.85,
    signal: ac.signal,
    messages: [
      { role: 'system', content: '你是一条蓝色大肥鱼，懒、馋、爱吃白饭。说话短、口语化，不超过两句。' },
      { role: 'user', content: '你是谁？' },
    ],
  })
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta') text += chunk.text || ''
    else if (chunk.type === 'reasoning-delta') process.stdout.write('〔思考〕')
    else if (chunk.type === 'finish') finish = chunk.reason
    else if (chunk.type === 'usage') console.log('[usage]', JSON.stringify(chunk.usage))
  }
} catch (e) {
  errors.push(e?.message || String(e))
}

console.log('\n=== 结果 ===')
console.log('耗时:', Date.now() - t0, 'ms')
console.log('文本:', JSON.stringify(text))
console.log('finish:', JSON.stringify(finish))
if (errors.length) console.log('错误:', errors.join(' | '))
process.exit(0)
