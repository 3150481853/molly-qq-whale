# 后台黑 cmd 闪窗：根因与修复

> 用户投诉：时不时就有黑色 cmd 窗口弹出，全屏游戏时被打断。
> 状态：已修复并实测验证（2026-10-19）

## 一句话结论

计划任务 `Molly-Watchdog` 原来直接执行 `node.exe`。它以 InteractiveToken 身份跑在用户桌面会话里，
而 `node.exe` 是控制台子系统程序 —— Windows 必然给它分配一个真控制台窗口。
现改为 `wscript.exe //nologo //B` 启动一个 VBS，VBS 内部用 `sh.Run(cmd, 0, True)` 的 `SW_HIDE` 启动 node。
**黑窗消失，watchdog 功能与退出码语义全部保留。**

## 根因定位过程

### 1. 静态扫描（`tools/audit-blackwindow.ps1 -Audit`）
扫 210 个文件、命中 62 处 spawn/Start-Process。**唯一会被判"会开窗"的只有一处**：计划任务的 node.exe 直跑。

其余全部已经隐藏，逐一核对过：

| 位置 | 状态 |
|---|---|
| `tools/console-server.mjs:161,458,769,1080,1125` | `windowsHide: true` |
| `plugin/dsh-qq-whale/lib/wbai.js:93-97` | `windowsHide: true`（plugin 里唯一的 child_process） |
| `tools/watchdog.mjs:272,311,366,636` | 4 处 execFile 全部 `windowsHide: true` |
| `tools/start-console.ps1:193-198` | `-WindowStyle Hidden` |
| `tools/start-molly.ps1:141-144,183` | `-WindowStyle Hidden` |
| `tools/open-console-window.ps1:237-243` | `-WindowStyle Hidden` |
| `tools/make-desktop-shortcut.ps1:113` | lnk 参数含 `-WindowStyle Hidden` |

`open-console-window.ps1:189` 的 Edge 启动**故意不隐藏** —— 那是用户双击桌面图标时要看的窗口。

### 2. 动态取证：抓现行
`-Watch` 模式用 `EnumWindows` + `IsWindowVisible` + `GetClassName` 每 40ms 轮询一次全系统顶层窗口。
（不能用 `Get-Process.MainWindowTitle`：黑窗闪一下就没，只看主窗口会漏。）

**修复前**（`-TriggerTask ... -Watch -Seconds 45`）：
```
11:29:26.439  +NEW-CONSOLE  pid=58256  类=ConsoleWindowClass  标题='${HOME}\.dsh\...\node.exe'
```
当场抓到。

### 3. 修复前基线
系统静止 25 秒（666 次轮询）：可见顶层窗口 46 个，console 类 **0** 个，新增窗口 0。
→ 静止时无黑窗，黑窗必由触发引起，排除「其他软件在闪」。

## 修复

### 新增 `tools/watchdog-hidden.vbs`
全 ASCII、无 BOM（wscript 按系统 ANSI 代码页读，UTF-8 BOM 会让第一行解析失败）。

```vbscript
rc = sh.Run(cmd, 0, True)
```
- 第 2 参数 `0` = `SW_HIDE` —— **就是这一个数字消除黑框**
- 第 3 参数 `True` = 等待并取退出码 —— watchdog 用 0/1/2/3/4 表达巡检结论，
  任务的「上次运行结果」靠它；不等待的话永远是 0

全程 `On Error Resume Next`：VBScript 未捕获异常会让 wscript 弹**模态错误框**，
比黑框更糟。失败时写 `out/watchdog-launcher.log` 并 `WScript.Quit 4`。

### 计划任务动作
```
Execute   = C:\Windows\System32\wscript.exe
Arguments = //nologo //B "D:\...\qq-whale\tools\watchdog-hidden.vbs"
WorkDir   = D:\...\qq-whale\tools
```
主体/触发器/`RunLevel=Highest` 全部原样保留。

**`//B` 不能少**（这是验证阶段抓到的第二个 bug）：
VBS 文件缺失时，不加 `//B` 的 wscript 会弹一个「Windows Script Host」模态对话框
（窗口类 `#32770`）并一直停住等人点确定 —— 比黑框更糟。
加 `//B` 后静默失败、返回错误码 1。实测对照：

| 场景 | 不加 //B | 加 //B |
|---|---|---|
| VBS 缺失 | 进程挂住等弹窗 | 立即退出 code=1，无窗口 |

## 验证结果

| 项目 | 结果 |
|---|---|
| 代码侧 spawn 是否全隐藏 | 是，62 处逐个人工核对 |
| **修复前**抓现行 | 抓到 `+NEW-CONSOLE`，pid 58256，标题=node.exe 全路径 |
| 修复后 · 手动触发 ×3（60s 监控，1505 次轮询） | 新增窗口 0，新增 console 0，焦点切换 0 |
| 修复后 · **自然时钟触发**（700s 监控，17523 次轮询，覆盖 11:40:02 与 11:40:40 两个触发点） | 新增窗口 0，新增 console 0，焦点切换 0 |
| 触发是否真的执行了 | 是 —— 三次手动触发各写一行 `watchdog.log`（11:31:47 / :50 / :53）；自然触发写 11:40:02 |
| `LastTaskResult` | 0（正常） |
| watchdog 功能是否被破坏 | 未被破坏，日志持续写入，177 行 → 146 行持续更新 |
| VBS 缺失（抗损毁） | `//B` 后静默失败 code=1，**0 个新窗口** |
| 全系统计划任务扫描 | 只有 `Molly-Watchdog` 属于本项目；另两个 `dsregcmd` 是 Windows 自带且已 Disabled |
| 启动项扫描 | 24 项全是第三方托盘程序，与本项目无关 |
| 断线自动恢复路径 | `watchdog.mjs:635` 调 `start-molly.ps1 -Restart` 带 `windowsHide: true`；`captureOfflineSnapshot` 的取证命令同样隐藏 |
| 抢焦点行为 | 后台进程无任何 `SetForegroundWindow` 调用 |

冷路径（`checkStatus → runLoginDoctor(['status'])`）每次巡检都会 spawn 一个 node 子进程。
自然触发那 700 秒里出现 0 个 console 窗口，说明 `windowsHide: true` 在这条链路里确实生效。

## 备份与还原

改动前已导出到 `out/`：

| 文件 | 内容 |
|---|---|
| `Molly-Watchdog.task.xml.current-20261019.xml` | 改后现状（wscript + //B） |
| `Molly-Watchdog.task.xml.restore-original.xml` | 改前原貌（node.exe 直跑），可直接注册还原 |
| `Molly-Watchdog.task.clean-backup.xml` | 首次干净备份 |
| `Molly-Watchdog.action-backup.json` | 动作/主体/触发器快照 |
| `Molly-Watchdog.还原说明.txt` | 还原步骤 |

还原（会让黑窗回来，非必要别做）：
```powershell
Register-ScheduledTask -TaskName 'Molly-Watchdog' `
  -Xml (Get-Content "<...restore-original.xml>" -Raw) -Force
```

## 复现验证方法

```powershell
# 静态审计
.\tools\audit-blackwindow.ps1 -Audit

# 触发一次计划任务并实时监控是否开窗
.\tools\audit-blackwindow.ps1 -TriggerTask 'Molly-Watchdog' -Times 3 -Watch -Seconds 60

# 只监控（不触发）
.\tools\audit-blackwindow.ps1 -Watch -Seconds 700
```

## 遗留观察（不属本任务范围）

- `out/offline-*.json` 掉线取证快照里的 `config` 字段完整包含 `notify.token`
  （`tools/watchdog.mjs:453` 把整个 cfg 序列化进去了）。目前只有一条 2026-10-19 00:40 的记录，
  但每次真实掉线都会新增一条。建议后续把 `config.notify.token` 脱敏。
- 这台机器系统时间显示为 2026-10-19，任务计划程序的 `LastRunTime` 比实际执行时刻晚约 9 秒
  （`NextRunTime` 同样偏移），属任务计划程序自身记录偏差，不影响触发与功能。