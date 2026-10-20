/**
 * 兼容别名：真正的薄壳在 `boot.js`。
 *
 * 历史原因：`package.json` 的 `main` 原本是 `lib/index.js`，宿主的内部加载器
 * 会按模块标识把第一次求值的结果缓存一整个进程生命周期 —— 所以哪怕后来把
 * `main` 改成新文件、往 URL 上挂 `?rev=`，重载拿到的还是最早的旧实例，改代码
 * 必须重启 DSH（而 DSH 重启会连带掉 QQ 注入进程，很贵）。
 *
 * 现在入口是 `lib/boot.js`（新路径 = 新标识）。这个文件只作为别名留着，
 * 避免别处仍按 `lib/index.js` 引用时断掉。
 */

export * from './boot.js'
export { default } from './boot.js'
