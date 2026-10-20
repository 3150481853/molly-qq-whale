# G 盘搬迁预演 · 契约

> 目标：**随时能搬**。本轮只做「预演」——把东西完整复制到 `${MOLLY_ROOT}\`、在副本里改路径、验证副本能独立跑起来，**生产环境（C:/D: 上正在跑的 Molly、QQ、DSH、网关）一个字都不动**。
> 用户 2026-10-19 22:55：「现在先再进行一次搬迁到G盘的预演，做好随时搬迁准备」。

## 1. 磁盘事实（实测 2026-10-19）

| 盘 | 剩余 | 已用 |
|---|---|---|
| C: | 20.8 GB | 199.2 GB |
| D: | 49.8 GB | 656.4 GB |
| **G:** | **500.1 GB** | 1362.9 GB |

`G:\` 根很乱（游戏/学习资料/虚拟机），**只允许新建 `${MOLLY_ROOT}\` 这一棵目录，不许动 G 盘其它任何东西**。

## 2. 各组件体量（实测）

| 组件 | 现位置 | 体量 | 文件数 | 搬不搬 |
|---|---|---|---|---|
| 工作区项目 | `${WORKSPACE}\qq-whale` | 3.08 GB | 12188 | **搬**（可排除 dist/out） |
| DSH 家目录 | `${HOME}\.dsh` | 0.90 GB | 36581 | **搬** |
| QQ 安装 | `<REDACTED>\QQ` | 5.20 GB | 20187 | **搬** |
| 网关 | `${GATEWAY_DIR}` | 0.01 GB | 335 | **搬**（小，顺手） |
| WorkBuddy 客户端 | `<REDACTED>\WorkBuddy` | 1.21 GB | 7304 | **不搬**（凭据 at-rest 密钥绑它，不动为上） |
| Python 3.10 | `D:\Python3.10` | **15.28 GB** | **314156** | **不搬**（只有二维码脚本用它，路径写进文档即可） |
| DSH 桌面程序 | `${APP_DIR}` | 1.02 GB | 7814 | **不搬**（它是宿主，代码在 app.asar 里；搬它要重装） |

必须搬的总量 ≈ **9.2 GB**（不含 dist/out 会更小）。

## 3. 目标布局（副本里就这么摆）

```
${MOLLY_ROOT}\
├── app\
│   ├── qq-whale\              ← 原 ${WORKSPACE}\qq-whale
│   ├── dsh-home\              ← 原 ${HOME}\.dsh
│   ├── workbuddy2api-hub\     ← 原 ${GATEWAY_DIR}
│   └── QQ\                    ← 原 <REDACTED>\QQ
├── out\                       ← 预演产物（日志/校验清单）
└── README-MIGRATION.md        ← 搬迁后怎么看、怎么起、怎么回滚
```

## 4. 铁律（违反即失败）

1. **只读源、只写副本**。任何对 `${HOME}\.dsh`、`<REDACTED>\QQ`、`${GATEWAY_DIR}`、`${WORKSPACE}` 的写操作都不允许。
2. **不许启动 QQ / NapCat**（会抢登录态、把现在在线的 Molly 顶掉）。副本里的 QQ 目录只做静态校验。
3. **不许重启 DSH 宿主、不许 `set_plugin` 重载**。预演不能动线上。
4. **不许 `start-molly.ps1 -Restart`**（会杀掉正在登录的 QQ）。
5. 副本里**只改路径常量**，不许改行为逻辑。
6. 副本允许在主端口以外的端口试跑（`MOLLY_CONSOLE_PORT=19399`），**不许占用 19391/19392/19393**。
7. 复制 `.dsh` 时源是活的（DSH 正在写 session），**允许不一致**；验收不要求逐字节相等，要求「客户端能起来 + 关键配置在」。真割接时必须先停 DSH 再复制——这条要写进报告。

## 5. 必须盘点的路径（这是本次真正的产出）

穷举下列位置里出现的绝对路径，逐条判定「搬后要改成什么」：

- `qq-whale\plugin\dsh-qq-whale\{lib,assets,persona,index.js,boot.js,package.json}`
- `qq-whale\tools\*.ps1|*.mjs|*.cjs|*.cmd|*.bat|*.vbs`
- `qq-whale\console\*`、`qq-whale\console.cmd`、`qq-whale\dist\*`
- `${HOME}\.dsh\profiles\desktop\cordis.patch.yml`（含 `workCwd`、`bskPath`、`qq-whale` 插件条目）
- `${HOME}\.dsh\profiles\desktop\package.json` / `pnpm-workspace.yaml`
- `${HOME}\.dsh\qq-whale\*.json`（config / budget-settings / watchdog-config / metrics / gatekeeper）
- `${HOME}\.dsh\.workbuddy-catalog.json`、`settings.yaml`、`.credentials.yaml`
- 计划任务 `Molly-Watchdog` 的 Action / WorkingDirectory
- 桌面快捷方式 `${HOME}\Desktop\Molly 控制台.lnk`
- 用户级环境变量（`DSH_HOME`、`PATH` 里跟这些路径相关的项）
- 网关 `${GATEWAY_DIR}\accounts\settings.json` 里是否有绝对路径

对每条给出：`文件:行` → `现值` → `搬后值` → `不改会怎样`。

结论必须包含一个 **`rewrite-table.json`**（供脚本消费）：
```json
{"rules":[{"from":"C:\\Users\\example\\.dsh","to":"G:\\Molly\\app\\dsh-home","files":["..."],"kind":"prefix"}]}
```

## 6. 验收门槛（缺一不可）

1. `${MOLLY_ROOT}` 下四个组件都在，`robocopy` 退出码 ≤ 7。
2. 副本里所有 `.js` `node --check` 通过；所有 `.ps1` 用 `Parser::ParseFile` errors=0；`.ps1` 带 BOM。
3. 副本里 `tools\console-server.mjs` 用 `MOLLY_CONSOLE_PORT=19399` 能起来，`GET /api/health` 200，打完收掉。
4. 副本里插件 lib 能用 `node -e "import(...)"` 装载成功（不挂宿主，只验证模块求值不炸）。
5. 副本里 `watchdog.mjs --status`（只读）能读到配置并输出，不真跑抢修。
6. 全量比对：源 vs 副本 的 `qq-whale\plugin` 全树 hash 一致（排除 dist/out/napcat 日志）。
7. 输出「真割接还差哪几步」清单（至少覆盖：停 DSH → 复制 → 改路径 → 改计划任务 → 改快捷方式 → 起 DSH → 起 QQ/NapCat → 扫码 → 验收）。

## 7. 回滚

预演阶段回滚 = `Remove-Item ${MOLLY_ROOT} -Recurse -Force`。生产零影响。

## 8. 交付物

- `${MOLLY_ROOT}\`（完整副本）
- `qq-whale\docs\g-migration-manifest.md`（路径盘点 + 判定 + 割接清单）
- `qq-whale\tools\migrate-to-g.ps1`（`-DryRun` / `-Copy` / `-Rewrite` / `-Verify` 四态，幂等）
- `qq-whale\out\rewrite-table.json`
- `${MOLLY_ROOT}\README-MIGRATION.md`
