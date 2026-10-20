# 参与开发

先说清楚这个仓库是什么，免得白花时间。

**它是一套可运行的 QQ 机器人框架**：一个 DSH 插件（`plugin/dsh-qq-whale/`）+ 一个本地控制台（`console/` + `tools/console-server.mjs`）+ 一堆运维脚本。它不是某个具体角色的成品——聊天人格在 `persona/core.md`，**没有**放进仓库（那是每个人自己的东西，见下文「不能提交的文件」）。

代码是能跑的，也经过了真机验证；但它是「一个人的项目长起来的样子」，不是精心设计的框架。有重复、有历史包袱、有些地方为了绕开平台限制写得很直白。接手前请有心理准备。

---

## 1. 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **≥ 22**（实测 24.21.0） | 用到了 ESM、`node:zlib`、Node SEA |
| 操作系统 | Windows 10/11 | 主要目标平台（计划任务、`Start-Process`、注册表都依赖 Windows） |
| DSH | 宿主 0.2.x | 插件靠它加载；控制台可以脱离 DSH 单独跑 |
| QQ | 一个能登录的账号 | 登录态由 NapCat 注入维持，不在本仓库 |

Linux/macOS 不是不能跑（`tools/console-server.mjs` 是纯 Node），但运维脚本（计划任务、看门狗、窗口操作）都是 Windows 专用，需要自己改。

---

## 2. 目录结构

```
plugin/dsh-qq-whale/     DSH 插件本体（lib 是逻辑，assets 是 Web UI 挂件，persona 是人格）
  lib/                   engine / commands / memory / onebot / web / persona / roles / ...
  assets/qq-widget.js    宿主 Web UI 里的小挂件（鲸鱼头按钮 + 面板）
  persona/core.md        ⚠️ 不入库，需自己写（参考 docs/ 里的说明）
console/                 控制台前端（index.html / console.js / console.css，纯原生 JS）
tools/                   启动器、看门狗、测试、打包、发布脚本
docs/                    架构、部署、协议、排错
config/                  示例配置
```

**模块怎么分工**（读代码前先看一眼，能省很多时间）：

- `engine.js` —— 最大的一块。消息进来到回复出去的完整链路：调度、上下文、记忆召回、投递、干活队列
- `commands.js` —— 「命令 xxx」走的那条路：命令解析、权限、干活会话、结果回传
- `onebot.js` —— OneBot 协议客户端 + 消息段归一化（图片/引用/@ 都在这里）
- `memory.js` —— 记忆存储与召回打分
- `persona.js` —— 系统提示词装配（人格 + 场景 + 记忆 + 硬约束）
- `session-router.js` —— 三个会话的路由（聊天 / 查询 / 改代码），复用了 `engine` 但模型与工具不同
- `roles.js` —— owner / adm / guest 三级角色与能力表
- `work-guard.js` —— 干活会话的写盘硬闸（受保护路径一律拒）

---

## 3. 本地跑起来

### 3.1 只跑控制台（最快上手，不需要 QQ）

```bash
node tools/console-server.mjs
# 然后打开 http://127.0.0.1:19392/
```

控制台会自己探测 DSH 宿主在哪个端口。宿主没起来也能开，页面会显示各模块「未连接」而不是崩掉——**这是刻意的设计**，排错时有用。

### 3.2 跑插件

1. 按 `docs/deploy.md` 把插件装进 DSH profile
2. 在 profile 的 `cordis.patch.yml` 里启用 bundle 与插件（`enabled: true`）
3. 用 `plugin_manager` 关一次再开一次，让宿主重新加载

**改代码后的生效规则（踩过的最多的坑）：**

- 改 `assets/*` → 切换一次插件就生效（每次请求都重新读盘）
- 改 `lib/*.js` → **必须重新加载插件**。Node 的 ESM 模块缓存是进程级的，`?rev=` 之类的查询串骗不过宿主
- 改完不生效、日志又是空的？先怀疑「插件加载失败被静默跳过」：把插件关一次再开一次，诊断会直接吐出完整调用栈

---

## 4. 改代码的规矩

几条被反复验证过的硬约束：

1. **不要从插件模块导出 `Config`**，除非它真的是 schemastery 对象。导出成普通对象会让插件管理界面显示 `unsupported`。
2. **默认导出的符号必须真实存在**，否则模块求值阶段就抛 `ReferenceError`，而且宿主只记一条日志——表现为「插件不见了」。
3. **路由返回 401 和 404 是两件事**：401 = 路由注册了但被鉴权拦住；404 = 压根没注册（通常是插件没加载成功）。
4. 时间一律用本地时区工具（`localDateKey()` / `localDateTime()`）。`toISOString()` 是 UTC，直接拿来当日期会差 8 小时。
5. 任何「写盘」路径都要能中途失败：先写临时文件再 `rename`，不要直接覆写。

### 干活会话的沙箱

`commands.js` 里的代码执行走的是**独立会话 + 沙箱目录**（默认 `${MOLLY_ROOT}\sandbox\qq-work`，可配）。`work-guard.js` 会在工具层硬拦对受保护路径的写操作——源码目录、插件安装目录、DSH 配置都在保护名单里。

**不要为了让某个功能跑通就放宽这道闸。** 这道闸存在的理由很具体：QQ 里的对话可以让机器人执行命令，而这些命令最终会落到文件系统上。

---

## 5. 测试

35 个纯 Node 测试脚本，零依赖，不需要 QQ、不需要网络：

```bash
node tools/test-engine.mjs
node tools/test-memory.mjs
node tools/test-sanitize.mjs
```

全跑一遍：

```powershell
Get-ChildItem tools\test-*.mjs | ForEach-Object { node $_.FullName }
```

每个脚本自己打印 `N passed / M failed` 并以退出码表示结果。**提交 PR 前请保证全绿**——这些测试里有一半是「上次真机上出过的 bug，用测试钉住别回来」，它们是这个仓库最值钱的部分。

测试写法约定：用 `Object.create(SomeClass.prototype)` 造假实例，**不要**另写一套假实现的接口。否则测试会自己给自己盖被子：假实现里没有的 bug，真实现里也测不出来。

---

## 6. 提交与 PR

```
main              稳定，能跑
feature/<短描述>   新功能
fix/<短描述>       bug 修复
```

一个 PR 请包含：

1. **改了什么**（一句话，别写「优化代码」）
2. **为什么要改**（是 bug 就贴现象，是功能就贴需求）
3. **怎么验证的**（跑了哪个测试，或者真机怎么复现/确认的）
4. 影响面（改了哪些文件，会不会影响正在跑的用户）

一次 PR 只做一件事。顺手重构请单开。

---

## 7. 不能提交的文件

`.gitignore` 已经挡住了主要几类，但请理解**为什么**——这些文件包含真实的第三方隐私，一旦推到公开仓库就无法撤回：

| 文件 / 目录 | 里面是什么 |
|---|---|
| `memory.json` / `memory.md` | 真人的记忆：QQ 号、名字、说过的话 |
| `pending.json` / `gatekeeper.json` / `relations.json` | 审批记录、陌生人申请、关系印象 |
| `stickers/` | 群友发的表情包原图 |
| `persona/core.md` | 角色人格（属于各自的部署者） |
| `pest.json` / `config.local.*` / `.env*` | 骂人模式的停止词、本地配置、token |
| `out/` / `dist/` / `*.log` / `*.bak-*` | 日志、构建产物、备份 |

提交前自查：

```bash
node tools/scan-secrets.mjs
```

它会扫真实 QQ 号、token、公网 IP、用户名等模式。**命中数必须是 0** 才推。

---

## 8. 准备发布一个版本

```bash
node tools/build-publish.mjs
```

这个脚本做三件事：按白名单从工作目录复制文件 → 把真实值替换成占位符 → **再扫一遍，有命中就拒绝产出**。产物在 `${MOLLY_ROOT}\publish\`（路径可改）。

原则：**白名单复制，不是黑名单排除**。漏掉一个文件的代价是隐私泄漏，宁可漏功能也不要漏文件。

---

## 9. 已知的坑（省你几小时）

- **PowerShell 5.1 读 UTF-8 会按 ANSI 解码**。判断 JSON/JS 文件是否损坏，一律用 Node 读，别用 `Get-Content`。`.ps1` 文件必须存成 **UTF-8 带 BOM**，而 `.js` 必须**不带 BOM**——两者规则相反。
- **`schtasks /TR` 会吃掉参数里的引号**。路径带空格时会静默失败，改用 `Register-ScheduledTask`。
- **改名/删除干活会话目录会让宿主报 `ENOENT`**。宿主进程持有旧路径句柄，改不回来。要换会话只能换 `sessionId`。
- **`wscript` 找不到 vbs 时弹的是操作系统级模态框**，脚本里的 `On Error Resume Next` 拦不住。所以计划任务的动作里必须带 `//B`。
- **Node SEA 的入口只按 CJS 执行**。`"mainFormat":"module"` 会被静默忽略，得先把 `import` 机械改写成 `require()`。

---

## 10. 提问

开 Issue，或者直接提 PR——这个项目没有正式的分工流程，能跑、能证明、能回滚，比流程重要。
