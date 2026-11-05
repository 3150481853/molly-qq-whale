# Molly 桌面应用（原生窗口）

Molly 现在是一个真正的桌面程序，而不是"启动 HTTP 服务再打开浏览器"的快捷方式：
`dist\desktop\Molly.exe` 用 WPF 开一个自己的窗口，窗口里用 WebView2 内嵌控制台页面，
有独立标题栏、任务栏图标、单实例行为和关闭/退出语义。

## 组成

| 角色 | 文件 | 说明 |
| --- | --- | --- |
| 窗口壳 | `dist\desktop\Molly.exe` | .NET 8 WPF 单文件自包含发布（约 163 MB），同目录 `console.json` 决定端口 |
| 后端 | `dist\desktop\molly-console.exe` | 原来的 Node SEA 控制台服务，由窗口壳按需拉起（`--no-browser`） |
| 前端 | `dist\desktop\console\` | 控制台静态页面（`index.html` / `console.js` / `console.css`） |

源码在 `desktop\`：

- `MollyDesktop.csproj`：`net8.0-windows`、`UseWPF`、`AssemblyName=Molly`、WebView2 `1.0.3650.58`
- `App.xaml.cs`：单实例 Mutex `Local\Molly.Desktop.5B60BA14-97C4-4237-B846-9C6F37A5D2E1`，第二个实例只负责把已有窗口唤到前台然后退出；`ShutdownMode=OnExplicitShutdown`
- `MainWindow.xaml(.cs)`：窗口、状态面板、WebView2、健康检查、后端拉起与回收
- `Assets\Molly.ico`：由 `desktop\tools\make-icon.py`（Pillow）生成的墨绿圆角 + 暖纸 M 图标

## 启动流程

1. 读同目录 `console.json`（`host` / `port` / `token`）。**该文件必须无 BOM**，Node 后端不认 BOM。
2. 请求 `GET /api/health`；健康就直接复用，不重复起后端。
3. 不健康时，在同目录 `Start-Process molly-console.exe --no-browser`，最多等约 20 秒健康检查。
4. 健康后 `CoreWebView2.Navigate(http://127.0.0.1:<port>/)`，状态面板收起。
5. 失败时显示诊断面板（错误原因 + 「重试」/「诊断信息」按钮），不会静默白屏。

窗口尺寸按当前显示器物理工作区与 DPI 自动收敛（`FitToScreen()`，默认 1360 DIP 宽、最多占工作区 92%），
在 2560×1600 / 150% 缩放的主屏上实测为 2040×1320 @ (260,104)，完整可见。

## 关闭行为

点窗口 × 时询问：

- **是**：退出 Molly，并停止「本次由窗口自己拉起」的后端（路径必须匹配同目录 `molly-console.exe`，绝不误杀别的进程）
- **否**（默认）：仅关窗口，后台服务继续跑，下次启动直接复用
- **取消**：留在窗口

实现细节：`Closing` 里先 `e.Cancel = true` 弹窗，决定后用 `Dispatcher.BeginInvoke(Close)` 排队关闭 ——
在 Closing 回调里直接 `Close()` 会被 WPF 以 `VerifyNotClosing` 拒绝。退出期间 `_shuttingDown`/`App.ShuttingDown`
会短路所有可见性更新，避免出现"Molly 遇到未处理错误"的假崩溃弹窗。

## 随 DSH 启动

`tools\start-dsh.ps1` 已接入：

1. `Start-MollyDesktop $consoleCfg`：已有 Molly 进程则跳过；否则拉起 `dist\desktop\Molly.exe`（管理员计划任务下经 `explorer.exe` 以普通用户身份打开，避免窗口提权），最多等 `-ConsoleWaitSeconds` 秒后端健康。
2. 窗口/后端没起来才回退 `Start-MollyConsole`（无窗口后端，带 `--no-browser`，不再弹浏览器）。
3. 之后继续原来的 DSH 幂等检查，控制台失败永远不影响 DSH 退出码。

参数：`-DesktopExePath`（默认 `<repo>\dist\desktop\Molly.exe`）、`-ConsoleExePath`、`-ConsoleConfigPath`、`-SkipConsole`。

## 构建与发布

```powershell
# SDK 已下载到 out\dotnet-sdk（8.0.418，含 WindowsDesktop 运行时）
& '${MOLLY_ROOT}\qq-whale\out\dotnet-sdk\dotnet.exe' publish '${MOLLY_ROOT}\qq-whale\desktop\MollyDesktop.csproj' `
  -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true `
  -o '${MOLLY_ROOT}\qq-whale\dist\desktop'
```

发布后把 `dist\molly-console.exe`、`dist\console\`、`console.json` 放到 `dist\desktop\` 同目录，
并删掉 `*.xml`、`*.pdb` 之类的发布碎屑。当前 `Molly.exe` SHA256：

```
<REDACTED>
```

## 玻璃外壳（v3：相对桌面的壁纸磨砂）

三层叠出来的"一整块玻璃"，任何一层缺席都会露出接缝：

| 层 | 谁负责 | 关键值 |
| --- | --- | --- |
| 模糊壁纸 | `desktop\WallpaperBackdrop.cs`（自绘） | 读 `HKCU\Control Panel\Desktop\WallPaper`，1/4 分辨率渲染 + `BlurEffect` r=15（≈全分辨率 60px），冻结成整屏图；窗口只换 `Viewbox`，不重算 |
| 页面面纱 | `console\console.css` §27.16 | `--v3-veil: rgba(252,251,248,.42)`、卡片 `--v3-card: rgba(255,255,255,.70)` |
| 标题条面纱 | `desktop\MainWindow.xaml(.cs)` | `WindowGlass.TitleBarVeilArgb = 0x6BFCFBF8`（42%，必须与 `--v3-veil` 同值） |

- **`?shell=desktop` 契约**：`MainWindow.xaml.cs` 的 `ShellUri()` 给 URL 加 `shell=desktop`；`console.js` 只认这个查询参数才给 `<html>` 打 `data-shell="desktop"`。缺了它，§27 全部桌面壳规则（透明底、统一面纱、无分隔线）都不生效——这是踩过的最深的坑。
- **顶栏**：blur 挂在 `.topbar::before`（`z-index: 0`），配 22px 渐变遮罩（0→56% 实、72% .88、88% .4、100% 透明）；`.topbar` 自身背景全透明、blur 关掉，`.topbar > *` 提到 `z-index: 1`。两个坑：① `z-index` 负值时 Chromium 不采样其后的内容，等于没模糊；② 直接把 `blur(16px)` 挂 `.topbar` 会把 64+22=86px 一刀切平，被抹平的一段与下方恢复纹理处形成横向台阶——那正是用户说的「分界线」。
- **标题条左下**：`SidebarVeil`（236px 宽）把侧栏那层同色纱延续进标题条；纱本身是向右淡出的渐变（`.34 → 62% → .16@86% → 0`），与 `console.css` §27.16 ⑥b 同参数，所以侧栏与正文之间**没有一条边**，只有深浅。窗口宽度 < 900 DIP 时侧栏收起，`UpdateSidebarVeil()` 会同步把这块藏掉。
- **滚动条**：`::-webkit-scrollbar` 8px 命中 / 4px 视觉、透明轨、无按钮（console.css §27.15）；侧栏 `.nav` 在桌面壳下彻底隐去滚动条。
- 关掉磨砂（设置 → 外观）时：`ApplyGlass()` 走 `GlassRoute.None`，整窗回到 #FBFBFA 暖纸面，`SidebarVeil` 折叠。
- 浏览器直接打开 `http://127.0.0.1:19392/`（没有 `shell=desktop`）时由 §27.17 兜底回暖纸不透明——见 `out\browser-mode.png`。

## 回滚

- 只停桌面窗口：关掉 Molly 窗口即可，后端仍在跑。
- 回到"无窗口后端"旧行为：`start-dsh.ps1 -SkipConsole`，或把 `dist\desktop\Molly.exe` 移走 —— 脚本会自动回退。
- 完全回到改造前：用 `${MOLLY_ROOT}\backup\console-redesign-20261103-230744` 里的 50 个原文件 + `SHA256.csv` 还原。

## 排障（2026-11-04 修复的三处硬问题）

### 1. 「守护失败：脚本不存在 `dist\desktop\tools\watchdog.mjs`」

`tools\console-server.mjs` 原来用 `IS_SEA ? EXE_DIR : path.resolve(HERE, '..')` 当仓库根。桌面版把后端放在 `dist\desktop\`，于是根目录被算成 `dist\desktop`，`tools\`、`out\`、`start-molly.ps1`、`panel-data.mjs` 全部指向不存在的路径——受影响的不止守护，还有「重新登录（napcat/qr）」「进程启动」「日志/二维码落盘」。

现在改成向上找锚点，不硬编码绝对路径：

```js
function findWorkspaceRoot(startDir) { /* 最多上溯 5 层，找带 tools\watchdog.mjs 的目录 */ }
const ROOT = pick('MOLLY_ROOT', 'root', IS_SEA ? (findWorkspaceRoot(EXE_DIR) || EXE_DIR) : path.resolve(HERE, '..'));
```

排障口诀：**任何「脚本不存在 / 文件找不到」都先看 `ROOT` 推导**，用 `POST /api/action/watchdog/status` 能直接看到它拼出来的绝对路径。

### 2. 「插件不可达：没探到 DSH 宿主端口」

宿主端口探测原来单端口 700ms 超时、探空结果也缓存 30 秒——DSH 在跑模型时偶发一次超时，界面就会连续半分钟显示不可达。现在：单端口 2500ms、探到长缓存 3 分钟、探空只缓存 15 秒、探到的地址写进 `out\dsh-host.json`，下次启动先试它（不必再扫 90 个端口）。`/api/overview` 抓 `/dsh-qq-whale/state` 也从 1500ms 提到 3000ms。

### 3. 「重新登录/重启 QQ 直接 409」

那是开发保护：源码直跑默认只演练。现在按运行形态分流——打包成 EXE（SEA）默认就是生产态（界面上这些动作本来就有二次确认），源码直跑仍需 `MOLLY_CONSOLE_LIVE=1`。要退回演练：给进程置 `MOLLY_CONSOLE_LIVE=0`。破坏性动作依旧受 `confirm: true` 闸门保护。

## 已知限制

- `console.json` 的 `token` 目前为空；若启用后端 token 鉴权，WebView 内的请求还没注入 `x-molly-token`，需要补一层 `WebResourceRequested` 注入。
- 窗口不驻留托盘，「否」= 关窗口留后端；如需托盘图标要再加 NotifyIcon。
- 应用自身冷启动到页面可见约 2–4 秒（WebView2 首次初始化 + 后端健康）。
- 玻璃路线是本机实测的最优解（自绘壁纸 + 1/4 分辨率模糊 15px ≈ 全分辨率 60px）；壁纸读不到时自动回退系统亚克力（`DWMWA_SYSTEMBACKDROP_TYPE=3`，自带约六成白雾）。

## 当前产物（2026-11-04 19:20）

| 文件 | 大小 | SHA256 |
| --- | --- | --- |
| `dist\desktop\Molly.exe` | 163,093,664 | `<REDACTED>` |
| `dist\desktop\molly-console.exe` | 93,844,992 | `<REDACTED>` |
| `console\console.css`（= dist 两份副本） | 63,297 字符 | `A9C995D47F06…` |

## 排障（2026-11-04 23:25 追加）：标题条与页面之间那条横线

症状：窗口标题条那 44px 与页面之间有一条横贯全宽的色阶/材料差。

排查顺序（都做过，按有效性排序）：

1. **先量，别猜。** `Add-Type -AssemblyName System.Drawing` 逐点取 `0.299R+0.587G+0.114B`。**注意缩放**：2040 宽窗口是 1.5 倍，44 CSS 的边界在物理 **y=66**；1360 宽窗口才是 y=44。量错行会得出「已经修好」的错误结论。
2. **标题条必须自己画同一张模糊壁纸。** 只靠 `Window.Background` 不够——标题区显示的是另一层底图。做法见 `WallpaperBackdrop.CreateBrushFor(window, element)`：用元素自己的 `PointToScreen` 矩形算 `Viewbox`（`ViewboxUnits=Absolute`、`Stretch=Fill`），直接套整窗刷子会把整张壁纸压进 44px 高的一条。
3. **白纱要单独配。** 标题条 `TitleBarVeil` 用 `#6BFCFBF8`（α=0.42），页面 `.app` 用 0.34。两者不是同一个数是因为标题条那块底图略暗；实测 0.34 时边界稳定差 6.3 级，0.42 后 ≤2.4 级。
4. **顶栏不要加 `backdrop-filter`。** `.topbar::before` 上的 `blur(18px)` 会让 Chromium 把页面根背景（白）一起合成进 backdrop，顶栏带被压进一层白雾（带内 221 / 带外 193）。

验证：`out\seam-fixG.png`（整窗）、`out\seam-fixG-top.png`（2× 裁剪）、`out\seam-fixG-scroll.png`（滚动时顶栏内容不糊、不撞字）。

当前产物：`dist\desktop\Molly.exe` 163093664 B，SHA256 `<REDACTED>`。
## 宿主桥：从页面把 DSH 窗口提到最前（2026-11-05）

**背景**：控制台「任务与研究 → DSH 工作台」原先直接 `window.open('http://127.0.0.1:8816/')`，DSH 的网页版只认它自己带 token 的地址，于是新窗口只有一行
`dsh web authentication required; reopen the URL printed by dsh web.`。token 拿不到（`~/.dsh` 配置、插件 state、DTE 进程命令行里都没有），也不该去绕它的鉴权。

**做法**：桌面外壳提供一条单向宿主桥，页面只负责"喊一声"，窗口操作全部在 WPF 侧。

| 侧 | 实现 |
|---|---|
| 页面 | `console.js` 的 `renderWork()` 检测 `window.chrome.webview.postMessage` 是否存在；存在时按钮改文案「切到 DSH 工作台」、去掉 `target`，点击发 `postMessage('molly:open-dsh')` 并 toast；不存在（普通浏览器）保持「打开 DSH 工作台 ↗」新窗口。 |
| 外壳 | `MainWindow.xaml.cs` 订阅 `web.WebMessageReceived`，`OnWebMessageReceived` 校验长度 ≤512 后 `raw.Contains("molly:open-dsh")` → `BringDshToFront()`：按进程名 `DeepSeek Harness` 找可见主窗口，最小化则 `ShowWindow(SW_RESTORE)`，再 `ShowWindow(SW_SHOW)` + `SetForegroundWindow`；找不到弹框提示"DSH 没在运行"。 |

**验收**（2026-11-05，CDP 在 WebView2 内实测）：

- 桌面端 `bridge: true`、按钮文案「切到 DSH 工作台」、`target: null`、hint 为桌面版文案；浏览器端 `bridge` 假、文案带 ↗、`target="_blank"`。
- 点一次按钮，前台窗口从 `THRM | THRM` 变为 `DeepSeek Harness | 重构并优化控制台界面 — DeepSeek Harness` —— 桥真的把 DSH 提到了最前，且没有再打开任何报错页。

**排障**：想在 WebView2 里跑 JS，用 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9333'` 启动 Molly，然后 `http://127.0.0.1:9333/json/list` 取 `webSocketDebuggerUrl`，PowerShell 的 `ClientWebSocket` 发 `Runtime.evaluate` 即可。这个环境变量只在测试时加，不要写进出厂配置。
## 复制到桌面单独启动（2026-11-05）

以前把 `Molly.exe` 单独复制到桌面会停在「未找到 Molly 后端」：它旁边没有 `molly-console.exe` 和 `console\`。

现在启动时会按两级找后端：

1. 本程序目录（`Molly.exe` 所在目录）里有没有 `molly-console.exe`；
2. 没有就读「上次记住的安装目录」：`%LOCALAPPDATA%\Molly\Desktop\install-dir.txt`，每次成功拉起后端时写入，读到后还会校验该目录里同时存在 `molly-console.exe` 与 `console\`。

命中第 2 级时，后端从那个目录启动，诊断信息里会显示「后端目录：…」。指针文件坏了只是退回旧行为，不影响正常安装目录启动。

实测：从 `${HOME}\Desktop\Molly.exe` 启动 → 自动用 `${MOLLY_ROOT}\qq-whale\dist\desktop\molly-console.exe` 起后端（pid 41924，19392），页面数据正常（24.71/300、5,422 条记忆、931 张表情、54,592 条消息、模型 deepseek-v4.1-flash），截图 `out\desktop-copy-fixed2.png`。

2026-11-05 之后桌面只留快捷方式 `Molly 控制台.lnk`（`TargetPath=${MOLLY_ROOT}\qq-whale\dist\desktop\Molly.exe`、`WorkingDirectory=${MOLLY_ROOT}\qq-whale\dist\desktop`、`IconLocation=<exe>,0`），桌面上的 155 MB 独立副本已删除——快捷方式永远跟着 `dist\desktop` 的更新走，不会再出现「复制过去就失效」的情况。

仍保留指针兜底：万一以后又把 `Molly.exe` 复制到别处（U 盘、临时目录），只要 `%LOCALAPPDATA%\Molly\Desktop\install-dir.txt` 还在，它照样能找到真后端。
## 储存与占用（2026-11-05）

偏好设置 → 储存与占用 可以看四组进程实际占了多少，并调三个策略：重排按需加载（默认开，空闲 5 分钟自动卸掉，实测回收约 620 MB）、语音服务空闲退出（默认 10 分钟，本机没启用）、内存守卫（系统紧张时先卸重排）。还有「最小化时挂起窗口」——它省的是 CPU 与电量，**不省内存**，别指望它降占用。配置写在 `<后端目录>\out\mem-config.json`，桌面壳和侧车启动时都会读它。