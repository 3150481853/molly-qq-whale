# dsh-qq-whale 安装与还原手册

> 这份文件是给**未来的你（或未来的我）**看的。装了什么、改了哪些文件、怎么一键还原，
> 全在这里。出问题时按「回滚」一节操作即可，不需要重新推理一遍。

最后更新：2026-10-17

---

## 一、这个插件是什么

`dsh-qq-whale` 让 QQ 号 **111111111（昵称 Molly）** 变成 DSH 的一条活人感聊天通道。
角色是「蓝色大肥鱼 / 鲸鱼娘」。

它做的事：

| 能力 | 模块 | 说明 |
|---|---|---|
| QQ 收发 | `lib/onebot.js` | OneBot11 正向 WebSocket 客户端，连 NapCat |
| 聊天生成 | `lib/wbai.js` | **直连** WorkBuddy 免费额度（deepseek-v4.1-flash），不依赖宿主存活 |
| 人设 | `persona/core.md` + `lib/persona.js` | 蓝色大肥鱼内核 + 四场景上下文 |
| 活人感 | `lib/aliveness.js` | 打字延迟、气泡间隔、抖动、"偶尔愣一下"长尾 |
| 主动联系 | `lib/engine.js#maybeProactive` | 三层闸门，不会刷屏 |
| 指令执行 | `lib/commands.js` | 「命令 」前缀 → 常驻 DSH agent 干活 |
| 进度播报 | `lib/progress.js` | 监听 todos 投影，实时推文字清单到 QQ |
| 表情包 | `lib/stickers.js` | 12 张鲸鱼娘素材，按标签匹配 |
| 偷学表情包 | `lib/sticker-learn.js` | 五道闸门，只从白名单用户/群学 QQ 表情 |
| 记忆 | `lib/memory.js` | 2-gram 检索 + IDF 加权 + 相关性阈值 |
| **先查再说** | `lib/research.js` | **2026-10-17 新增**。被问到事实性问题时委派干活会话去查，查到再用自己的话讲 |
| **当前模型显示** | `lib/web.js#snapshot().active` + `assets/qq-widget.js` | **2026-10-17 新增**。左下角挂件常驻显示"此刻谁在替她说话" |

---

## 二、装了/改了哪些东西（盘点）

### 1. DSH 插件本体

| 路径 | 说明 |
|---|---|
| `${WORKSPACE}\qq-whale\plugin\dsh-qq-whale\` | **源码目录**（改这里） |
| `${HOME}\.dsh\profiles\desktop\node_modules\dsh-qq-whale\` | **安装位**（运行时用这里，从源码 copy 过去） |

同步命令（改完源码必须执行）：

```powershell
$src="${WORKSPACE}\qq-whale\plugin\dsh-qq-whale"
$dst="${HOME}\.dsh\profiles\desktop\node_modules\dsh-qq-whale"
Copy-Item "$src\lib\*" "$dst\lib\" -Force
Copy-Item "$src\persona\*" "$dst\persona\" -Force
Copy-Item "$src\package.json" "$dst\" -Force
```

### 2. DSH profile 的三处改动

| 文件 | 改动 |
|---|---|
| `${HOME}\.dsh\profiles\desktop\package.json` | `dependencies` 加 `"dsh-qq-whale": "file:D:/.../qq-whale/plugin/dsh-qq-whale"`；`dsh.profile.bundles` 末尾加 `"dsh-qq-whale"` |
| `${HOME}\.dsh\profiles\desktop\cordis.patch.yml` | 末尾追加 `- id: dsh-qq-whale` 配置块（约 60 行） |
| `${HOME}\.dsh\profiles\desktop\node_modules\dsh-qq-whale\` | 插件文件副本 |

### 3. 外部程序（DSH 之外，独立运行）

| 组件 | 路径 | 说明 |
|---|---|---|
| QQ 客户端 | `<REDACTED>\QQ\QQ.exe`（实际版本 `versions\9.9.26-44725`） | 用户原本就装的，**未修改** |
| NapCat | `qq-whale\napcat\`（v4.18.38） | 通过 `NapCatWinBootMain.exe` 注入 QQ，不覆盖 QQ 任何文件 |
| NapCat 配置 | `qq-whale\napcat\config\webui.json` | WebUI 端口 6099，token `${NAPCAT_TOKEN}` |
| OneBot 配置 | `qq-whale\napcat\config\onebot11.json` | WS 服务端 127.0.0.1:3001，token `${ONEBOT_TOKEN}` |

**NapCat 是怎么启动的**（关键，别忘）：

```powershell
$napcat="${WORKSPACE}\qq-whale\napcat"
$env:NAPCAT_LOAD_PATH      = "$napcat\loadNapCat.js"
$env:NAPCAT_INJECT_PATH    = "$napcat\NapCatWinBootHook.dll"
$env:NAPCAT_LAUNCHER_PATH  = "$napcat\NapCatWinBootMain.exe"
$env:NAPCAT_MAIN_PATH      = "$napcat\napcat.mjs"
$env:NAPCAT_PATCH_PACKAGE  = "$napcat\qqnt.json"
& "$napcat\NapCatWinBootMain.exe" "<REDACTED>\QQ\QQ.exe" "$napcat\NapCatWinBootHook.dll"
```

> 教训：`wrapper.node` **不是** node addon（没有 `napi_register_module_v1`），
> 不能 `process.dlopen`。只能走注入。别重走 dlopen 路线。

### 4. 数据目录（运行时产生，删了会丢记忆）

| 路径 | 内容 |
|---|---|
| `${HOME}\.dsh\qq-whale\memory\memory.json` + `memory.md` | 持久记忆 |
| `${HOME}\.dsh\qq-whale\stickers\` | （默认不在这，见下） |
| `${WORKSPACE}\qq-whale\stickers\` | 表情包图库 12 张 |
| `D:\...\qq-whale\stickers\学来的\` | 偷学来的表情包 |

---

## 三、还原点（备份）

已创建的完整备份目录（都在 profile 下，`.pre-*` 前缀）：

| 备份目录 | 时间 | 内容 |
|---|---|---|
| `.pre-qq-whale-20261017-140302\` | 装插件前 | `cordis.patch.yml`(16965B) + `package.json` |
| `.pre-qqcfg-20261017-144300\` | 调参前 | `cordis.patch.yml` |
| `.pre-market-backup-20261007-235306\` | 更早，插件市场相关 | `cordis.patch.yml` |

---

## 四、回滚（三种粒度，从轻到重）

### A. 只关掉插件，不动任何文件

在 `cordis.patch.yml` 的 `- id: dsh-qq-whale` 块里加一行：

```yaml
    enabled: false
```

或者直接在 `package.json` 的 `dsh.profile.bundles` 里删掉 `"dsh-qq-whale"`，重启 DSH。

### B. 恢复到"装插件之前"（保留其他所有插件）

```powershell
$prof="${HOME}\.dsh\profiles\desktop"
Copy-Item "$prof\.pre-qq-whale-20261017-140302\cordis.patch.yml" "$prof\cordis.patch.yml" -Force
Copy-Item "$prof\.pre-qq-whale-20261017-140302\package.json"      "$prof\package.json" -Force
# 然后重启 DSH
```

### C. 彻底清干净

```powershell
$prof="${HOME}\.dsh\profiles\desktop"
# 1. 配置回滚（同 B）
# 2. 删安装位
Remove-Item "$prof\node_modules\dsh-qq-whale" -Recurse -Force
# 3. 想连记忆一起删：
Remove-Item "$env:USERPROFILE\.dsh\qq-whale" -Recurse -Force
# 4. 源码目录（可选，建议留着）
# ${WORKSPACE}\qq-whale\
```

---

## 五、⚠️ 崩溃恢复陷阱（务必知道）

`cordis.patch.yml` 文件头有警告：**每次 DSH 启动失败，崩溃恢复会把该文件削回只剩
`ui-settings-account` / `ui-chat` / `ui-settings` 三项，并清掉 `package.json` 的
`dsh.profile.bundles`。**

**所以：看到 `cordis.patch.yml` 变短（几百行 → 几十行）＝上次启动失败了。**

判断方法：

```powershell
(Get-Content "${HOME}\.dsh\profiles\desktop\cordis.patch.yml").Count
# 正常应该在 600 行左右。变成 20~40 行就是被回滚了。
```

被回滚了就用「回滚 B」反向操作：把备份拷回去。

---

## 六、怎么验证它在正常工作

**最快一条命令**（会自动拉起 NapCat 并逐项检查）：

```powershell
& "${WORKSPACE}\qq-whale\tools\start-molly.ps1"
```

只看状态不启动：`& .\start-molly.ps1 -Status`
杀掉 QQ 重起：`& .\start-molly.ps1 -Restart`

**手工逐项验证：**

```powershell
# 1. NapCat 在线？
(Get-Process QQ -ErrorAction SilentlyContinue).Count        # 应该 4
(Test-NetConnection 127.0.0.1 -Port 3001 -InformationLevel Quiet)  # True
(Test-NetConnection 127.0.0.1 -Port 6099 -InformationLevel Quiet)  # True

# 2. 插件到底能不能被宿主加载？（11 项深度检查）
$node="${HOME}\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
& $node "${WORKSPACE}\qq-whale\tools\rollback.mjs" verify

# 3. 语法都过？
Get-ChildItem "${HOME}\.dsh\profiles\desktop\node_modules\dsh-qq-whale\lib\*.js" |
  ForEach-Object { & $node --check $_.FullName; if($LASTEXITCODE -eq 0){"OK $($_.Name)"} }

# 4. wbai 免费额度还能用？
cd "${WORKSPACE}\qq-whale\tools"
& $node ".\wbai-quick.mjs"
```

在 QQ 里私聊 Molly：

- 说句话 → 应该按真人节奏回（不是秒回）
- 「命令 列一下今天的待办」→ 应该先回一句"收到"，然后持续播报进度
- 发表情包 → 她可能跟着回一张鲸鱼娘

---

## 七、配置项速查

`cordis.patch.yml` 里 `- id: dsh-qq-whale` 块，常用项：

```yaml
allowedUsers:          # 谁能跟她聊
  - "222222222"
allowedGroups: []      # 哪些群放开（填群号）
groupAutoReply: true   # 群里被@是否回
proactiveEnabled: true # 主动找人聊
proactiveDailyCap: 3   # 每人每天最多主动几次
restWindows:           # 睡觉时间，这期间不主动说话
  - label: "睡觉"
    start: "01:30"
    end: "09:00"
commandPrefixes:       # 指令前缀
  - "命令 "
commanderUsers:        # 谁能让它干活
  - "222222222"
stickerLearn: true     # 偷学别人表情包

# —— 2026-10-17 新增 ——
researchEnabled: true        # 先查再说：被问事实性问题时真去查
researchTimeoutSeconds: 45   # 查资料最多等多久，超时当没查到
typingCharactersPerSecond: 7.5  # 打字速度（原来 3.5 太慢，用户嫌等）
```

### 回复延时口径

用户 m11614-2：「把回复延时调短点」。原来 `typingCharactersPerSecond: 3.5`
（模拟真人手机打字），实测 20 字要等 6 秒，群里看着像她卡住了。现在 7.5，
同样的 20 字约 2.7 秒——仍然不是秒回（秒回没有活人感），但不会让人等到走神。

想再快就往上调这个值；想更"真"就调回 3~4。抖动比例 `typingJitterRatio`
默认 0.35，控制节奏的不规律程度。

---

## 八、历史坑（别再踩）

1. **wrapper.node 不能 dlopen** —— 没有 node addon 导出表，只能用 NapCatWinBootMain 注入。
2. **PowerShell 写含中文的 .md/.js 会乱码** —— 必须
   `[System.IO.File]::WriteAllText($p, $code, [System.Text.UTF8Encoding]::new($false))`。
3. **`normalizeMessage(segs, selfId)` 第一个参数是 segments 数组**，不是 `{message: segs}`。
4. **wbai 网关没有工具通道** —— 模型输出工具调用文本会原样进聊天框，
   persona 里有硬性护栏禁止它这么干。
5. **指令不能靠模型分类** —— 模型会把纯情绪的话判成任务，只认显式前缀。
6. **记忆检索不能用 `split(/\s/)` 取词** —— 中文单字全被过滤，召回退化成权重排序。
7. **⚠️ 最坑的一次：插件被宿主静默跳过（2026-10-17）**
   现象：插件配置、bundles、依赖全都在，DSH 也照常启动，但所有插件路由 404、QQ 完全没反应，**控制台一个错误都没有**。
   根因：`node_modules\dsh-qq-whale\` 安装副本里缺了 `cordis.patch.yml`。宿主 `loadProfileDirectory()`
   读到 `dsh.bundle.patch` 指向的文件不存在就抛错，然后把这个 bundle 丢进 `skippedBundles`
   **静默跳过**（源码 `dsh-app-boot/lib/index.js:925-945`）。
   为什么缺：`package.json` 的 `files` 只列了 `[lib, persona, assets]`，同步时按目录拷就漏了根目录的 patch 文件。
   自查：`node tools\rollback.mjs verify` —— 它现在会逐项检查这个文件在不在。
   教训：**改了插件源码后，同步到安装副本要拷全**（`lib` / `persona` / `assets` / `cordis.patch.yml` / `package.json` 五样），别只拷 lib。

8. **宿主树里没有 node / pnpm 在 PATH 上（2026-10-17）**
   所有 `node --check` / 跑脚本的命令都会失败 `CommandNotFoundException`。
   正确姿势：用 Electron 当 node 跑——
   ```powershell
   $env:ELECTRON_RUN_AS_NODE='1'
   & '${APP_DIR}\DeepSeek Harness.exe' --check <file.js>
   & '${APP_DIR}\DeepSeek Harness.exe' <script.mjs>
   ```

9. **改完代码必须重载插件才生效（2026-10-17）**
   直接 `Copy-Item` 到安装副本不会触发热重载——`boot.js` 只在 apply 时才生成新的
   `gen-<rev>/` 目录。必须走：
   ```
   plugin_manager(action=set_plugin, target="include:dsh-qq-whale", enabled=false)
   plugin_manager(action=set_plugin, target="include:dsh-qq-whale", enabled=true)
   ```
   然后 `GET http://127.0.0.1:19387/dsh-qq-whale/state` 确认新字段出现
   （例如 `active` 字段在 2026-10-17 之前不存在）。
   
   注意：**`/dsh-qq-whale/*` 路由挂在宿主 webserver（19387），不是 NapCat 的 3001**。
   3001 是 OneBot WS，用 HTTP 打过去是 `426 Upgrade Required`。

10. **「先查再说」的判定表宁漏不滥（2026-10-17）**
    第一版把「为什么/怎么样/多少/是不是」都当成要查资料，实测把「你为啥不说话」
    「这是啥啊哈哈」全送进搜索，回复从秒级变十几秒，活人感直接塌。
    现在只认强信号（天气/时间/显式"查一下"/是什么是谁/新闻价格），
    并且 `CHAT_PATTERNS` 优先级最高、超过 40 字一律不查。
    回归自检：`tools\research-verdict-probe.mjs`（21 条用例，改表后必跑）。
8. **`.ps1` 脚本含中文必须带 UTF-8 BOM** —— 与 `.js` 规则相反。
   Windows PowerShell 5.1 无 BOM 时按 GBK 读 `.ps1`，中文全变乱码并导致语法错误（`字符串缺少终止符`）。
   写 `.js`/`.md`/`.json` 用无 BOM；写 `.ps1` 要 BOM。
