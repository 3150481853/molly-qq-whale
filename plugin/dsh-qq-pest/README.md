# dsh-qq-pest

QQ「出气筒」（骂人模式）的独立插件包 —— **阶段 2 拆包试点**，代码从 `dsh-qq-whale@0.4.x` 里的 `lib/pest.js` 原样搬来（一行没改，随时可 diff 验证）。

## 为什么拆它

pest 是纯本地状态机：停止词、对象、日额度、休息时段、落盘 `pest-settings.json`。它不碰 OneBot、不发消息、不依赖模型，是四个叶子里最适合先试拆的。

## 边界

- 本包**不挂 timer**、不读 QQ、不发消息；只提供 `PestKeeper` 等实现。
- 主包 `dsh-qq-whale` 通过宿主服务 `qqPest` 取到实现，把 `engine.pest` 换成这里 `createKeeper()` 的实例；`engine.js` 里四处判定一行不用改（留阶段 3 再迁）。
- 主包没加载时：本包照样暴露 `qqPest`，然后待命（不启 tick）。

## 跨包接口（宿主服务，不是 import）

本包 `apply`：

```js
ctx.set('qqPest', {
  package, version,
  PestKeeper, detectInjection, isStopWord, pickStopWord,
  readPestSettings, writePestSettings, STOP_WORD_POOL, PEST_SETTINGS_FILE,
  createKeeper(opts)          // → new PestKeeper(opts)
})
ctx.get('qqWhale')?.attachPest(api)   // 主包在就立刻接管
```

主包 `apply`：`ctx.set('qqWhale', state)`，`state.attachPest(api)` 负责建实例并替换 `engine.pest`。

## 配置

零依赖、零配置项。keeper 的参数（dir/targets/dailyCap/intervalMinutes/restWindows）全部由主包按原 `config` 传进来，保证拆包前后行为一致。

## 回滚

见 `docs/` 或 lead 的回滚命令：把本包从 profile `package.json` 的 `dependencies`/`dsh.profile.bundles` 与 `cordis.patch.yml` 摘掉，重启宿主；主包会自动退回内置实现（`state.pestSource === 'builtin'`）。
