/**
 * dsh-qq-pest —— 出气筒（骂人模式）独立插件包（阶段 2 拆包试点）
 *
 * 这个包只做一件事：把从 dsh-qq-whale 搬出来的 PestKeeper 暴露成宿主服务 `qqPest`，
 * 供主包按需接管；它自己**不挂任何 timer、不碰 OneBot、不发消息**。
 * 为什么要拆：pest 是纯本地状态机（停止词/额度/对象），没有 QQ 依赖，
 * 是最适合先试拆的叶子。engine.js 里那四处判定本轮刻意不动（留阶段 3），
 * 只要主包把 `engine.pest` 换成这里 createKeeper() 的实例，判定逻辑原样生效。
 *
 * 跨包约定（两侧都只认这两个服务名，禁止直接 import 对方文件）：
 *   - 本包 apply：ctx.set('qqPest', api)；再尝试 ctx.get('qqWhale')?.attachPest(api)
 *   - 主包 apply：ctx.set('qqWhale', state)，state.attachPest(api) 负责接线
 *
 * 降级：主包没加载 / 还没就绪时，本包照样把 qqPest 挂上（主包稍后会来取），
 * 但绝不自己启 tick、绝不读盘 —— 单纯待命。
 */
import {
  PestKeeper,
  detectInjection,
  isStopWord,
  pickStopWord,
  readPestSettings,
  writePestSettings,
  STOP_WORD_POOL,
  PEST_SETTINGS_FILE,
} from './pest.js'

export const name = 'dsh-qq-pest'
export const version = '0.1.0'

/** 不声明 inject：故意让本包独立成活，主包不在也能安全待命。 */
export const inject = []

/** 宿主 logger 千奇百怪，统一包一层，保证 console.log 永远不炸。 */
function makeLogger(ctx) {
  const raw = ctx?.logger
  return (level, msg) => {
    try {
      if (typeof raw === 'function') raw(level, `[qq-pest] ${msg}`)
      else if (typeof raw?.[level] === 'function') raw[level](`[qq-pest] ${msg}`)
      else if (typeof console?.[level] === 'function') console[level](`[qq-pest] ${msg}`)
    } catch {
      /* 日志失败不影响业务 */
    }
  }
}

/**
 * 暴露给主包的接口。createKeeper 是唯一「有副作用」的入口（构造实例），
 * 其余都是原样转发，主包拿到的行为和拆包前完全一致。
 */
export function createApi() {
  return {
    package: name,
    version,
    // 类与纯函数原样透出：主包要判词、要直接 new 都行
    PestKeeper,
    detectInjection,
    isStopWord,
    pickStopWord,
    readPestSettings,
    writePestSettings,
    STOP_WORD_POOL,
    PEST_SETTINGS_FILE,
    /**
     * 造一个 keeper 实例。
     * @param {object} opts 与 PestKeeper 构造参数一致（dir/logger/targets/dailyCap/...）
     */
    createKeeper(opts = {}) {
      return new PestKeeper(opts)
    },
  }
}

export function apply(ctx, config = {}) {
  const logger = makeLogger(ctx)
  const api = createApi()

  // ① 先挂服务：即使主包没来，别的模块（控制台/测试）也能 get 到
  //
  // ⚠️ 必须用 ctx.provide，不能用 ctx.set：
  //    DSH 里「跨插件可见的服务」由 provide 注册（生态里 clearai/statusRotator/market
  //    全这么写），ctx.set 只往当前 context 上挂属性、ctx.get 取不到，也不会出现在
  //    宿主的 Service 目录里。set 保留为老宿主兜底。
  let exposed = false
  let undefine = null
  try {
    if (typeof ctx?.provide === 'function') {
      undefine = ctx.provide('qqPest', api)
      exposed = true
    } else if (typeof ctx?.set === 'function') {
      ctx.set('qqPest', api)
      exposed = true
    }
  } catch (err) {
    logger('warn', `暴露 qqPest 服务失败：${err?.message || err}`)
  }

  // ② 主包在就直接接线；不在就待命（不挂 tick、不读盘）
  let whale = null
  try {
    whale = typeof ctx?.get === 'function' ? ctx.get('qqWhale') : null
  } catch {
    whale = null
  }
  let attached = false
  if (whale && typeof whale.attachPest === 'function') {
    try {
      attached = whale.attachPest(api) === true
      logger(
        attached ? 'info' : 'warn',
        attached
          ? '出气筒实现已交给主包接管（engine.pest 已替换）'
          : '主包暂时没接过出气筒（接口不完整/引擎未就绪），功能保持关闭',
      )
    } catch (err) {
      logger('warn', `交给主包接管时出错（主包会把出气筒功能整体关闭）：${err?.message || err}`)
    }
  } else {
    logger('info', '主包 dsh-qq-whale 还没就绪：pest 已挂成 qqPest 服务，待命不挂 tick')
  }

  logger('info', `出气筒包已加载（${attached ? '已接管' : '待命'}｜服务 ${exposed ? 'qqPest 已暴露' : '未暴露'}）`)

  // ③ 卸载：撤掉服务；主包下次 apply 会因为拿不到 qqPest 而进入「功能关闭」态
  //    provide 返回的注销函数在 fiber 卸载时通常已自动生效，再调一次是幂等的；
  //    老宿主走 set 路径时才需要手动 set undefined。
  return () => {
    try {
      if (typeof undefine === 'function') undefine()
      else if (typeof ctx?.set === 'function') ctx.set('qqPest', undefined)
    } catch {
      /* 卸载失败不抛 */
    }
    logger('info', '出气筒包已卸载')
  }
}

export default { name, version, inject, apply }
