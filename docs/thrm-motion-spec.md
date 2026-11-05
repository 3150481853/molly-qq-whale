# THRM 界面设计语言 & 过渡动效规格

> **用途**：照着这份文档能用原生 HTML/CSS/JS（无框架、无构建）复刻 THRM 的界面观感与动效手感。
> **逆向对象**：`C:\Program Files\THRM\THRM.exe`（18,869,760 B，WebView2 / Wails / Next.js 静态导出的单文件打包）。
> **逆向日期**：2026-11-05。**未修改 THRM 任何文件、未结束其进程**。
> **证据等级**：`[A]` 内嵌代码里逐字读到的常量/声明（给出字符索引）；`[B]` 由库缺省值推得（给出库源码常量 + 推理链）；`[C]` 推测（明确标注置信度）。

---

## 0. 速查表（实现者只看这一节也能开工）

| # | 过渡 | 时长 | 缓动 | 位移 | 缩放 | 透明度 | 其它 |
|---|---|---|---|---|---|---|---|
| 1 | 一级页面切换·进入 | **190ms** | `cubic-bezier(.22,1,.36,1)` | `translateY(18px)→0`（向下切页时；方向翻转时 −18px） | — | 0→1 | `mode="wait"`，与退出**串行** |
| 2 | 一级页面切换·退出 | **160ms** | `cubic-bezier(.22,1,.36,1)` | `0→translateY(-14px)` | — | 1→0 | 无交叉淡化 |
| 3 | 页面卡片错峰揭示 | **285ms** | `ease-out` | — | — | 0→1 | delay `80ms × 索引`，索引封顶 4 → 最晚 **320ms** |
| 4 | 折叠区展开/收起 | **300ms** | `cubic-bezier(.25,.1,.35,1)` | `height 0↔auto` | — | 0↔1 | 容器 `overflow:hidden` |
| 5 | 区块进入（面板级） | **200ms** | framer 缺省 `ease-in-out` `[B]` | `translateY(8px)→0` | — | 0→1 | 只出现 1 处（风扇曲线面板） |
| 6 | 弹窗·遮罩 | **200ms** | 同上 `[B]` | — | — | 0→1 | `rgba(0,0,0,.4)` + `backdrop-filter:blur(8px)` |
| 7 | 弹窗·面板 | **200ms** | 同上 `[B]` | — | **0.95→1** | 0→1 | `rounded:16px`、`shadow-xl` |
| 8 | Tooltip 进入 | **150ms** | `ease` | 从触发侧 **4px** 滑入 | **0.95→1** | 0→1 | 悬停延迟 **150ms** |
| 9 | Toast 进入/退出 | **400ms** | `ease` | `translateY(100%)→0` | 内容层 0.8→1（300ms） | 0→1 | 高度也 400ms；堆叠每层 +0.05 scale |
| 10 | 侧栏展开/收起 | **300ms** | `ease-out` | `width 216↔64px` | — | — | 标题栏 `left` 同步 300ms |
| 11 | Hover 反馈（卡/导航/按钮） | **150–200ms** | `ease` | `translateY(-1px)` 或 −2px | — | 颜色/背景 alpha | **没有按压缩放** |
| 12 | 加载环 | 1000ms | `linear` | 旋转 360° | — | — | 无限循环 |
| 13 | 呼吸点 `pulse-ring` | 1000ms | `cubic-bezier(.4,0,.6,1)` | — | **1→1.3** | 1→0 | 无限循环 |
| 14 | 图表扫光 | 5800ms | `ease-in-out` | `translateX(-65%)→65%` | — | 0→.65→0 | 仅冰川示例主题有 |
| 15 | 卡片拖拽排序落位 | **170ms** | `cubic-bezier(.22,1,.36,1)` | 跟随指针 | — | — | SortableJS `animation:170` |

**最重要的一条**：THRM 的页面切换不是淡入淡出交叉，而是 **先退后进、串行 350ms（160+190）**。这是它「稳」的根源；并行交叉会显得廉价。

---

## 1. 逆向方法与证据链

### 1.1 静态提取（主证据）
可执行文件尾部内嵌的是**未压缩**的 HTML/CSS/JS 文本（Next.js 静态导出 + 内联 chunk）。提取流程：

```powershell
$bytes = [IO.File]::ReadAllBytes('C:\Program Files\THRM\THRM.exe')
$s     = [Text.Encoding]::UTF8.GetString($bytes)        # 18,505,756 字符
$s.IndexOf('@keyframes page-card-fade')                  # 6800804
$s.Substring(6799800, 1400)                              # 按字符窗口取原文
```

- 全文落盘：`${MOLLY_ROOT}\qq-whale\out\thrm-recon\thrm-utf8.txt`
- 索引表：`${MOLLY_ROOT}\qq-whale\out\thrm-recon\indices.txt`（本文所有 `idx` 都是这个文件里的字符下标）
- 注意：**字符索引 ≠ 字节偏移**（UTF-8 中文占 3 字节），一律按字符 `Substring` 取窗口。
- 脚本：`indices.ps1` / `scan9.ps1` / `scan10.ps1` / `scan11.ps1`（同目录）。用 Windows PowerShell 5.1 跑：`powershell -NoProfile -ExecutionPolicy Bypass -File <path>`。本机没有 `pwsh` 7。

### 1.2 界面实测：本次不可行（已定位原因，非操作失误）
原计划是「切页时 20–30fps 连拍 + 逐帧量像素」校正代码常量。实测**在本会话权限下无法进行**：

| 尝试 | 结果 |
|---|---|
| `shot-pid.ps1 -ProcId 7976` | `window: -32000,-32000  size=237x39`，PNG 仅 166 B（空白） |
| 枚举全部窗口（`win-enum.ps1`） | 唯一主窗口 `hwnd=459840 title='THRM' visible=True **iconic=True**` |
| `ShowWindow(hwnd,9)` + `SetWindowPos` + `SetForegroundWindow` | 全部无效，仍 `iconic=True`，rect 不变 |
| `PrintWindow(hwnd,hdc,2)` | 返回 `False` |
| `WScript.Shell.AppActivate(7976)` | 返回 `False` |

**根因**：THRM 以**管理员权限**运行（`Win32_Process.ExecutablePath` 跨完整性级别读取为空，父进程为 `THRM Core.exe` pid 19428），而本会话 `amAdmin: False`。Windows UIPI 会**静默丢弃**低完整性进程的 `ShowWindow/SetWindowPos/PrintWindow/SendInput`，所以「恢复窗口 → 截图 → 点击 → 连拍」整条链路都断在第一步。审批被禁用，无法提权。

**复现方法（有管理员权限时照做）**：以管理员身份开一个 PowerShell → `ShowWindow(hwnd,9)` 再 `shot-pid.ps1` 连拍 → 用 `crop.ps1 -Zoom` 放大内容区 → 逐帧量首行卡片顶部像素的 y 坐标，用「半程位置」反解缓动曲线（第 50% 时间点应到达总位移的 ≈70–75%，对应 `cubic-bezier(.22,1,.36,1)`；若是线性则为 50%）。

因此本文**动效数值全部来自代码常量**（等级 A/B），没有逐帧实测数据；凡涉及「看起来的手感」处均标注为推断。

### 1.3 技术栈事实 `[A]`（idx 6414150 许可证清单）
`framer-motion 13.1.1`、`radix-ui 1.6.7`、`class-variance-authority 0.7.1`、`clsx 2.1.1`、`lucide-react 1.33.0`、`next-themes 0.4.6`、`i18next 26.4.0`、`sonner`（toast）、`tailwindcss v4`（CSS-first，无 config 文件）、`tw-animate-css`、`Wails`（桌面壳，`--wails-draggable` 拖拽区）、`WebView2`（`%APPDATA%\THRM.exe\EBWebView`）。

→ **所有动效只有两个来源**：framer-motion（JS 驱动，可读常量）与 CSS `transition/@keyframes`。没有 GSAP / anime.js（`gsap`、`anime.js` 关键词命中 0）。

---

## 2. 设计语言

### 2.1 当前实际生效的主题（重要）
THRM 内置三档模式 `system / light / dark`（`BUILTIN_MODES = new Set(["system","light","dark"])`，idx 5797466），靠 `html.dark` class 切换；自定义主题走注入 `<style id="thrm-custom-theme-style">` + `html[data-theme="<id>"]`。

本机运行时状态（读 WebView2 LevelDB：`${HOME}\AppData\Roaming\THRM.exe\EBWebView\Default\Local Storage\leveldb\000003.log`）：
- `thrm.theme-bootstrap = {"version":1,"mode":"system"}`（**没有 theme 字段** → 未启用自定义主题）
- OS `AppsUseLightTheme=1` → 解析为**浅色**
- `thrm.locale = zh-CN`、`thrm.sidebar.expanded = "1"`（侧栏展开）
- `C:\Program Files\THRM\themes` 目录不存在

→ **用户看到的 THRM = 默认浅色主题**（蓝 `#2f6df6`）。第 5 节另附随包的「冰川蓝」示例主题（`data-theme="thrm"`），那是作者写在界面「系统设置 → 界面主题」里的**示例文件**，默认不生效——但它的玻璃/HUD 手法值得单独抄（见 2.9）。

### 2.2 颜色 token（浅色，`[A]` idx 6797409 附近）

| 语义 | 值 | 用途 |
|---|---|---|
| `--background` | `#f6f8fc` | 窗口底 |
| `--card` | `#ffffff` | 卡片/浮层表面 |
| `--card-foreground` | `#111827` | 卡内文字 |
| `--foreground` | `#111827` | 主文字 |
| `--muted` | `#edf2f9` | 次级填充/hover 底 |
| `--muted-foreground` | `#66758a` | 次级文字、图标 |
| `--border` | `#e1e7f0` | 常规描边 |
| `--input` | `#d3ddea` | 输入框描边 |
| `--ring` / `--primary` | `#2f6df6` | 主色（唯一强调色） |
| `--primary-foreground` | `#ffffff` | 主色上的文字 |
| `--destructive` | `#dc2626` | 危险 |
| `--accent` / `--accent-foreground` | `#edf2f9` / `#111827` | 选中态 |
| `--sidebar` | `#ffffff` | 侧栏底 |
| `--sidebar-accent` | `#eef4ff` | 侧栏 hover（带一点蓝） |
| `--sidebar-border` | `#e5ebf4` | 侧栏右边线 |
| `--chart-1..5` | `#90c5ff` `#3080ff` `#155dfc` `#1447e6` `#193cb8` | 图表 5 级蓝阶 |

**四档灰的实现方式**：只有两级实色（`#111827` 主文字 / `#66758a` 次级文字），第三、四档靠**透明度叠加**：`text-sidebar-foreground/62`、`bg-foreground/10`、`border-primary/15`、`bg-primary/10`。背景四档是 `#f6f8fc → #ffffff → #edf2f9 → #eef4ff`（越来越「实体/越来越蓝」）。

### 2.3 颜色 token（深色 `html.dark`，`[A]`）
`--background:#07090d`、`--card:#11161d`、`--foreground:#eef2f7`、`--muted:#1a2029`、`--muted-foreground:#98a2b3`、`--border:#232a35`、`--input:#2b3442`、`--primary`/`--ring:#ff4b26`（**深色下主色换成橙红**，这是有意为之的品牌反转）、`--primary-foreground:#fff7f3`、`--destructive:#ef4444`、`--accent:#1d232d`、`--sidebar:#0a0d12`、`--sidebar-accent:#171c24`、`--sidebar-border:#202631`。

### 2.4 圆角档位 `[A]`
基准 `--radius: .75rem` = **12px**，其余按倍数派生：`×0.6 = 7.2px`、`×1 = 12px`、`×1.4 = 16.8px`、`×1.8 = 21.6px`、`×2.2 = 26.4px`，外加 `999px`（胶囊）与 `50%`（圆点）；窗口按钮用 `6px`。

| 用途 | 圆角 |
|---|---|
| 窗口控制按钮 | `6px`（`rounded-md`） |
| 小控件 / 输入框 | `8px` |
| 导航项、状态胶囊（常规） | `12px`（`rounded-xl`） |
| 卡片、弹窗 | `16px`（`rounded-2xl`） |
| 大浮层（赞助弹层） | `26px`（= `×2.2`，`rounded-[26px]`） |
| 胶囊/紧凑标签 | `999px`（`rounded-full`） |

### 2.5 阴影档位 `[A]`
| 档 | 值 | 用途 |
|---|---|---|
| 0 · 边线 | `shadow-[1px_0_0_rgba(15,23,42,0.04)]` | 侧栏右侧 1px 硬阴影，比 border 更「工程感」 |
| 1 · 微 | `0 1px 2px rgb(0 0 0 / .05)`（`shadow-sm`） | 胶囊、数值 |
| 2 · 悬浮 | `0 4px 12px rgba(0,0,0,.1)` | 下拉、浮层 |
| 3 · 大浮层 | `0 18px 40px -12px #00000059` | 模态/大面板 |
| 4 · 卡片投影 | `0 14px 34px -16px #10182873` | 强调卡（带 `!important`，覆盖组件默认） |
| 内高光 | `inset 0 1px 0 rgba(255,255,255,.42)` / `.56` / `.74` | 所有「凸起」表面的顶边亮线 |

规律：**外层阴影一律「大偏移 + 负 spread」**（如 `-12px/-16px`），所以阴影很柔、几乎不外扩；亮感靠 `inset 0 1px 0 white` 一条线。

### 2.6 间距节奏 `[A]`
基数 `--spacing: .25rem`（4px）。实际用量集中：`4 / 6 / 8 / 10 / 12 / 14 / 16 / 20 / 24`。
- 卡片内边距 `p-4`（16px）；弹窗 `p-6`（24px）；胶囊 `px-3`（12px）
- 页面容器 `px-1 pb-2`（左右 4px，底部 8px）——**页面留白很紧**
- 侧栏导航项 `h-11`（44px）、图标列固定宽 `w-16`（64px，与收起态侧栏同宽）
- 侧栏头部 `h-[76px]`、标题栏 `h-10`（40px）

### 2.7 字阶 `[A]`
字体栈：`--font-ui-sans: "Manrope Variable"`（拉丁/数字）+ `--font-ui-cjk: "HarmonyOS Sans SC","HarmonyOS Sans","Microsoft YaHei","PingFang SC"`；`--default-font-family` 先西文后中文。`@font-face` 内嵌 HarmonyOS Sans SC 400 / 500-600 / 700 三个 woff2 子集。

| token | px | 行高 | 用途 |
|---|---|---|---|
| `--text-xs` | 12 | 1.333 | Tooltip、脚注 |
| `--text-sm` | 14 | 1.428 | 导航项、正文 |
| `--text-base` | 16 | 1.5 | 默认 |
| `--text-lg` | 18 | 1.555 | 区块标题 |
| `--text-xl` | 20 | 1.4 | 卡片大数值 |
| `--text-2xl` | 24 | 1.333 | 页面标题 |

另有硬编码 `11px`（紧凑状态胶囊）、`13px`（常规状态胶囊）、`10px`（最小标签）、`15px`、`28px`。
字重 **400 / 500 / 600**（数值用 600）；数值统一 `tabular-nums`；标题 `tracking-tight`（−.025em）。
**关键**：中文界面里大量用 **13px / 11px 的小字 + font-medium**，不是常见的 14px 一刀切——这是它「仪表盘密度」的来源。

### 2.8 图标与卡片密度
- 图标：`lucide-react`，线性、圆头、`stroke-width: 2`。尺寸只有三档：**12px**（窗口按钮最大化/还原）、**14px**（窗口按钮、胶囊内小图标）、**18px**（导航项 `h-4.5 w-4.5`）。
- 12 列网格（`md:col-span-*`），首页默认布局：主状态卡 `12`、三张指标卡各 `4`、运行时长 `12`、曲线 `7`、历史 `5`；窄屏指标卡各 `6`。
- 卡片：`rounded-2xl border border-border/70 bg-card p-4`，hover 上浮 1px（见 3.7）。
- 状态胶囊：常规 `h-8 rounded-xl px-3 text-[13px]`；紧凑 `h-6 rounded-full px-2.5 text-[11px]`。

### 2.9 玻璃 / 半透明用法 `[A]`
THRM 不整体做「毛玻璃皮肤」，只在**浮层**上用，且用了就配 `backdrop-filter`：

| 元素 | 背景 | 模糊 |
|---|---|---|
| Tooltip | `bg-card/95` | `backdrop-blur-sm`（8px） |
| 赞助浮层 | `bg-popover/98` | `backdrop-blur-xl`（24px） |
| 弹窗遮罩 | `bg-black/40` | `backdrop-blur-sm`（8px） |
| 标题栏（冰川主题） | `color-mix(--background 80%, transparent)` | `blur(24px) saturate(118%)` |
| 主操作悬浮条（冰川主题） | `color-mix(--card 72%, transparent)` | `blur(14px) saturate(116%)` |

**Mica 模式**（Windows 原生毛玻璃，由 Wails `WindowBlurEnabled()` 决定）：根容器挂 `glacier-native-backdrop` 时，`body` 背景置空、窗口底变 `color-mix(--background 35%, transparent)`，侧栏/标题栏的背景与边线全部透明化，露出桌面模糊。同时 CSS 变量降级为 `--mica-content-surface: color-mix(in srgb, var(--background) 75%, transparent)`、`--mica-content-border: color-mix(in srgb, var(--border) 90%, transparent)`。

**自绘滚动条**：`--scrollbar-size:10px`；thumb `color-mix(in srgb, var(--foreground) 35%, transparent)`（深色 30%，hover 45%）；另有「浮层滚动条」模式：thumb 用 `height` + `translateY` 定位，滚动或悬停后显示，**1400ms 无操作淡出**。

### 2.10 可选：冰川蓝示例主题（`html[data-theme="thrm"]`）
默认主题已经是完整的浅色系统；冰川主题是**锦上添花**，如果要做「科技感更强」的版本可以直接借它的三招：

1. **背景三层**：`radial-gradient(circle at 78% 10%, rgba(150,207,255,.28), transparent 28rem)` + `radial-gradient(circle at 16% 92%, rgba(47,116,255,.12), transparent 24rem)` + `linear-gradient(135deg,#fbfdff,#f5faff 44%,#edf6ff)`，再叠 `::before` 蓝图网格（`rgba(47,116,255,.055)` 1px 线，`28px 28px` 格 + 180px 斜切线），用 `mask-image: linear-gradient(to bottom, transparent, black 10%, black 88%, transparent)` 上下渐隐。
2. **卡片内嵌 HUD 框**：`.glacier-card::before{inset:.7rem; border-radius:.65rem; border:1px …}` —— 卡片内再套一层细框，密度感立刻上来。
3. **顶边高光**：`box-shadow: inset 0 1px 0 rgba(255,255,255,.74), 0 10px 22px -24px rgba(47,116,255,.42)`。

它的主色 `#2f74ff`（比默认的 `#2f6df6` 亮一档），文字 `#13233e`，卡面 `#fbfdff`，描边 `#d9e9ff`。

---

## 3. 动效清单（逐项）

> 每一项给出：时长 / 缓动 / 位移 / 缩放 / 透明度 / 遮罩模糊 / 错峰；末尾「证据」是内嵌代码原文与字符索引。
> 标 `[B]` 的地方是 framer-motion 的库缺省值（代码未显式写）。

### 3.1 一级页面切换（侧栏 4 个 tab 之间的切换）★核心
- **机制**：`AnimatePresence mode="wait"` —— 旧页**完全退场后**新页才进场，**串行**，无交叉淡化。
- **进入**：190ms，`cubic-bezier(.22,1,.36,1)`，`y = +18px → 0`（向下切页）/ `−18px → 0`（向上切页），`opacity 0 → 1`。
- **退出**：160ms，同曲线，`y = 0 → −14px`（向下切页）/ `+14px`（向上切页），`opacity 1 → 0`。
- **无缩放、无模糊、无遮罩、无错峰**（错峰由 3.2 的卡片系统另外负责，但每次切页会重放）。
- **方向单位 `Q`**：只有三个值 `{−1, 0, +1}`（目标页索引 > 当前页 = +1）。`Q = 0` 时退化用 `8px / −6px`；`Q = 0` 出现在冷启动第一帧或同页刷新。
- **总时长 350ms**（160 + 190）；页面容器带 `will-change: transform`；切页时滚动位置归零。
- **冷启动不播进场动画**（`initial={false}`），首屏只播卡片错峰。

```js
// idx 6826636 起，逐字（压缩后的变量名）
ei={enter:e=>({opacity:0,y:0===e?8:18*e}),
    center:{opacity:1,y:0,transition:{duration:.19,ease:[.22,1,.36,1]}},
    exit:e=>({opacity:0,y:0===e?-6:-14*e,transition:{duration:.16,ease:[.22,1,.36,1]}})}
```
```jsx
// idx 6840526 / 6840703 / 6840763，逐字
<main className="mx-auto w-full max-w-[1120px] min-[1536px]:max-w-[1280px]
      min-[1800px]:max-w-[1440px] min-[2400px]:max-w-[1560px] min-w-0 overflow-hidden">
  <AnimatePresence mode="wait" initial={false} custom={Q}>
    <motion.div custom={Q} variants={ei} initial="enter" animate="center" exit="exit"
      data-page-reveal="cards"
      className="w-full min-w-0 px-1 pb-2 will-change-transform"
      children={({status:d,curve:u,control:p,about:m})[e]} key={e}/>
  </AnimatePresence>
</main>
```
tab 顺序（idx 6826632）：`["status","curve","control","about"]` → 界面中文标签为 **状态 / 曲线 / 设置 / 关于**（i18n 资源 `"tabs":{"status":"状态","curve":"曲线","control":"设置","about":"关于"}`，同段还有 `"status":{"connected":"已连接","offline":"离线","smartControl":"智能变频","manualMode":"手动模式"}`）。

### 3.2 页面卡片错峰揭示（stagger）★核心
- **单个卡片**：`285ms`，`ease-out`，`opacity 0 → 1`（**只淡入，不位移、不缩放**）。
- **错峰间隔 80ms**，索引封顶 4：第 1 张 0ms、第 2 张 80ms、第 3 张 160ms、第 4 张 240ms、第 5 张起 320ms。
- **最后一张在 285 + 320 = 605ms 处结束**——所以切页的「整体观感时长」约 600ms，虽然动画本体只有 350ms。
- 用 `animation-fill-mode: both`，`animation-delay` 由 CSS 变量或 `:nth-child` 给。
- 挂载点就是 3.1 的 `motion.div`（`data-page-reveal="cards"`），所以**每次切页都重放一遍**。
- 桌面端（≥768px）用「行号」错峰（`--reveal-row`），移动端用「列号」（`--reveal-index`）。

```css
/* idx 6800804 起，逐字 */
@keyframes page-card-fade{0%{opacity:0}to{opacity:1}}
[data-page-reveal=cards]>*>*{animation:.285s ease-out both page-card-fade}
[data-page-reveal=cards]>*>*:nth-child(2){animation-delay:80ms}
[data-page-reveal=cards]>*>*:nth-child(3){animation-delay:.16s}
[data-page-reveal=cards]>*>*:nth-child(4){animation-delay:.24s}
[data-page-reveal=cards]>*>*:nth-child(5){animation-delay:.32s}
[data-page-reveal=cards]>*>[data-reveal-row]{animation-delay:calc(var(--reveal-index,0) * 80ms)}
@media (min-width:768px){
  [data-page-reveal=cards]>*>[data-reveal-row]{animation-delay:calc(var(--reveal-row,0) * 80ms)}
}
@media (prefers-reduced-motion:reduce){
  [data-page-reveal=cards]>*>*{animation:none}
}
```
DOM 形状：`页面容器 > 网格容器 > 卡片`（选择器是 `>*>*`，即孙元素）。错峰索引由 React 算出：`{"--reveal-row":Math.min(row,4), "--reveal-index":Math.min(col,4)}`（idx 6883142 附近）。

### 3.3 折叠区展开 / 收起
- **300ms**，`cubic-bezier(.25,.1,.35,1)`，`height 0 → auto`，同时 `opacity 0 → 1`；容器 `overflow: hidden`。
- 7 处相同写法（风扇曲线手动档位、灯效细节等）。
- 动画由 framer 对**非 transform 属性**的缺省值驱动（代码里没写 transition）。

```jsx
// idx 6529819 起（7 处）
<AnimatePresence>
  <motion.div initial={{opacity:0,height:0}} animate={{opacity:1,height:"auto"}}
              exit={{opacity:0,height:0}} className="overflow-hidden">
```
库缺省值（idx 6303974）：`eH={type:"keyframes", ease:[.25,.1,.35,1], duration:.3}`。
→ **移植时不要用 `height:auto`**（CSS 不能过渡 auto），改用 `grid-template-rows: 0fr → 1fr`（见 4.4）。

### 3.4 区块进入（面板级）
- **200ms**，`y: +8px → 0` + `opacity 0 → 1`；仅 1 处（风扇曲线右侧大面板，idx 6528348）。
- 代码只给了 `duration: .2`，未给 ease → framer 缺省 tween 缓动 `ease-in-out` `[B]`。

### 3.5 弹窗（自定义确认框）
- **遮罩**：200ms 淡入，`rgba(0,0,0,.4)` + `backdrop-filter: blur(8px)`。
- **面板**：200ms，`scale .95 → 1` + `opacity 0 → 1`，`transform-origin` 居中；圆角 16px，`shadow-xl`，最大宽 `24rem`（384px），内边距 24px。
- 无位移（不是从下方弹起）。

```jsx
// idx 6708304，逐字
<motion.div initial={{opacity:0}} animate={{opacity:1}} exit={{opacity:0}}
  className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"/>
<motion.div initial={{scale:.95,opacity:0}} animate={{scale:1,opacity:1}} exit={{scale:.95,opacity:0}}
  transition={{duration:.2}}
  className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-xl"/>
```

### 3.6 Tooltip / Popover / Dropdown
shadcn 组件走 `tw-animate-css` 的 `animate-in` 组合：
- **时长 150ms**（Tailwind 缺省 `--tw-duration: .15s`，`ease`）。
- **Tooltip**：`fade-in-0`（opacity 0→1）+ `zoom-in-95`（**scale .95 → 1**）+ 从触发侧 `slide-in-from-*-1`（**4px**）滑入。
- **悬停延迟 150ms**（`TooltipProvider delayDuration` 缺省 150，idx 5802792 有 12 处引用）。
- Tooltip 本体：`rounded-md`、`border border-border`、`bg-card/95`、`backdrop-blur-sm`、`px-3 py-1.5`、`text-xs`。
- Popover/赞助浮层同款 `animate-in fade-in-0 zoom-in-95`，圆角 26px、`bg-popover/98`、`backdrop-blur-xl`。

```css
/* tw-animate-css 内核，idx 6134121 附近 */
.animate-in{animation:enter var(--tw-animation-duration,var(--tw-duration,.15s)) var(--tw-ease,ease)}
.zoom-in-95{--tw-enter-scale:.95}
.slide-in-from-top-1{--tw-enter-translate-y:calc(1 * var(--spacing))}   /* 4px */
@keyframes enter{0%{opacity:var(--tw-enter-opacity,1);
  transform:translate3d(var(--tw-enter-translate-x,0),var(--tw-enter-translate-y,0),0)
            scale3d(var(--tw-enter-scale,1),var(--tw-enter-scale,1),1);
  filter:blur(var(--tw-enter-blur,0))}}
```

### 3.7 Hover / Press 反馈
**`whileHover` / `whileTap` 在整份 JS 里命中 0 次** → 所有反馈都是 CSS `transition`，且**没有按压缩放**（这是它的克制之处，抄的时候别加）。

| 元素 | 变化 | 时长/曲线 |
|---|---|---|
| 侧栏导航项 | 出现 `bg-primary/10` + `border-primary/15` 胶囊；未激活 `hover:bg-sidebar-accent`；文字 `foreground/62 → foreground` | `transition-colors 200ms` |
| 窗口按钮 | `hover:bg-foreground/10`；关闭/最小化 `hover:bg-red-500 hover:text-white` | `transition-colors` 150ms |
| 指标卡（冰川主题） | `translateY(-1px)` + 描边变 `color-mix(--primary 34%, --border)` | `180ms ease` |
| 通用上浮 | `hover:-translate-y-0.5`（**−2px**），仅在 `@media (hover:hover)` 下启用 | 150ms |
| Switch 滑块 | `translate-x-0 → translate-x-5`（20px） | 150ms `cubic-bezier(.4,0,.2,1)` |
| 图表扫光 | `translateX(-65%) → 65%`，`opacity 0 → .65 → 0` | 5800ms `ease-in-out` 无限 |

```css
/* idx 6832906：导航项 */
group/nav relative flex h-11 w-full cursor-pointer items-center rounded-xl text-left transition-colors duration-200
/* 激活胶囊 */
absolute inset-y-0 left-2.5 right-2.5 rounded-xl transition-colors duration-200
  → active: "border border-primary/15 bg-primary/10"; idle: "bg-transparent group-hover/nav:bg-sidebar-accent"
/* 指标卡 hover（冰川主题） */
.glacier-metric-card{transition:transform 180ms ease, border-color 180ms ease, box-shadow 180ms ease}
.glacier-metric-card:hover{transform:translateY(-1px);
  border-color:color-mix(in srgb, var(--primary) 34%, var(--border))}
```

### 3.8 侧栏折叠 + 标题栏跟随
- 侧栏宽度 **216px（展开）/ 64px（收起）**，`transition-[width] 300ms ease-out`。
- 标题栏是 `position:absolute; left: <侧栏宽>`，`transition-[left] 300ms ease-out` —— **两者同步同曲线**，所以视觉上是「标题栏被侧栏推开」。
- 收起时导航项只留图标（图标列固定 `w-16` = 64px，正好等于收起宽度），文字 `truncate` 消失，并改出右侧 Tooltip。
- 无淡入淡出——纯布局宽度动画。

```jsx
// idx 6835038 / 6836075 / 6836169 / 6828169
V = P ? 216 : 64            // P = localStorage['thrm.sidebar.expanded'] === "1"
<aside className="… border-r border-sidebar-border bg-sidebar
  shadow-[1px_0_0_rgba(15,23,42,0.04)] transition-[width] duration-300 ease-out" style={{width:V}}>
<div className="glacier-titlebar … transition-[left] duration-300 ease-out"
     style={{left:l, '--wails-draggable':'drag'}}>
```

### 3.9 Toast（sonner）
- 容器位移/淡入/高度/阴影：`transform .4s, opacity .4s, height .4s, box-shadow .2s`。
- 入场关键帧：`scale(.8) → scale(1)`，`300ms ease`；出场 `200ms ease`。
- 堆叠：每多一层 `scale` +0.05（`--scale: var(--toasts-before) * 0.05 + 1`），向上错位。

```css
[data-sonner-toast]{--y:translateY(100%);transition:transform .4s,opacity .4s,height .4s,box-shadow .2s}
[data-sonner-toast][data-mounted=true]{--y:translateY(0);opacity:1}
@keyframes sonner-fade-in{0%{opacity:0;transform:scale(.8)}100%{opacity:1;transform:scale(1)}} /* .3s ease forwards */
@keyframes sonner-fade-out{…}                                                              /* .2s ease forwards */
```

THRM 还对 sonner 做了自定义皮肤（`.cn-toast`，idx 6805371 前一段，逐字）——这套值可以直接抄：
```css
.cn-toast{border:1px solid color-mix(in srgb, var(--border) 88%, transparent);
  background: color-mix(in srgb, var(--popover) 96%, transparent);
  backdrop-filter: blur(8px) saturate(118%);
  border-radius: calc(var(--radius) + 2px);          /* = 14px */
  box-shadow: 0 14px 34px -16px #10182873}
.cn-toast-title{font-size:13px; font-weight:600; letter-spacing:.01em}
.cn-toast-description{margin-top:2px; font-size:12px; color:color-mix(in srgb,var(--popover-foreground) 76%,transparent)}
.cn-toast-action,.cn-toast-cancel{border-radius:8px; font-size:12px; font-weight:600}
```

### 3.10 循环 / 加载动效
| 名称 | 参数 | 用途 |
|---|---|---|
| `spin` | `1s linear infinite` | 风扇图标。**转速越高动画越快**，`animationDuration` 内联：RPM ≥4200 → `0.45s`；≥3200 → `0.7s`；≥2200 → `1s`；其余 → `1.35s`；RPM ≤0（停转）→ 不加动画。窗口失焦时 `animationPlayState: paused` |
| `pulse` | `2s cubic-bezier(.4,0,.6,1) infinite` | 状态点 |
| `pulse-ring` | `1s cubic-bezier(.4,0,.6,1) infinite`，`scale 1→1.3`，`opacity 1→0` | 「实时在线」外扩圈 |
| `sonner-spin` | `1.2s linear infinite` | Toast 里的加载图标 |
| `glacier-scan` | `5.8s ease-in-out infinite`，`translateX(−65%)→65%`，`opacity 0 / .65 / 0` | 图表扫光（仅冰川主题） |

`pulse-ring` 关键帧：`0%{opacity:1;transform:scale(1)} 100%{opacity:0;transform:scale(1.3)}`。

风扇图标组件（idx 6826498 附近，逐字）：
```js
// 转速 → 动画时长
t = fanData?.currentRpm; !(t<=0) ? (t>=4200?.45 : t>=3200?.7 : t>=2200?1:1.35) : 0
// 渲染
<span className={cn("inline-flex", e>0 && "animate-spin fan-spin")}
      style={{animationDuration:`${e}s`, animationPlayState: active ? "running" : "paused"}}>
```
「窗口不可见就暂停」这条值得抄进原生控制台：用 `document.visibilityState` 切换一个 `[data-paused]`，比让所有循环动画空转省电。

### 3.11 拖拽排序 + 浮层滚动条
- 首页卡片可拖拽重排（SortableJS）：落位动画 `animation: 170ms`，缓动 `cubic-bezier(0.22, 1, 0.36, 1)`；顺序持久化在 `localStorage['thrm.home.card-order']`。
- 浮层滚动条（idx 6804104 起，逐字）：宽 **8px**、`right:4px`、上下各留 **6px**、`transition: opacity .2s`；`.is-visible{opacity:1; pointer-events:auto}`；thumb 圆角 999px、`transition: background-color .2s`，hover 变深。thumb 位置用 `height` + `transform: translateY()` 驱动（不触发重排），滚动后显示、**1400ms 后淡出**。
- 常规滚动条（非浮层）：`--scrollbar-size: 10px`，thumb 内缩 2px `border` + `background-clip: padding-box`（形成「细轨 + 留白」的观感）。

### 3.12 无障碍：减少动效
`@media (prefers-reduced-motion: reduce)` 共 **4 处，全部定位**：
1. 卡片错峰 → `animation: none`
2. 图表扫光 → `animation: none; opacity: 0`
3. 指标卡 hover 位移 → `transform: none`
4. 风扇旋转 → `.fan-spin{animation:none}`

策略很清楚：**只关「装饰性/持续性」动效，不关「状态切换」**（页面切换、折叠、弹窗都不在 reduced-motion 名单里）。移植时照抄这个取舍即可。

### 3.13 负面清单：THRM 明确「没有」的动效
这些是同样重要的证据（命中数 0），抄的时候别自作聪明加：

| 没有 | 证据 |
|---|---|
| 按压缩放（`whileTap` / `active:scale*`） | `whileTap` 全局 0 命中；未见任何 `active:scale*` 类 |
| framer 的 `layoutId` 共享元素过渡（tab 指示器滑动） | `layoutId:` 全局 0 命中 |
| 列表增删/重排的 layout 动画 | 无 `layout` 属性；唯一重排动画来自 SortableJS 落位 170ms |
| 页面横向平移（左右滑） | 页面切换只有 y 轴；`slide-in-from-left/right` 只用于 tooltip/popover 的 4px |
| 骨架屏 shimmer / 内容加载占位动画 | 未见 `skeleton` + 扫光组合；加载态用 `spin` |
| 手势驱动的关闭/抽屉 | `swipe-out-*` 关键帧来自 sonner 的移动端手势，桌面场景未用 |
| 应用层弹簧动画 | 应用代码里 `type:"spring"` 0 命中；出现的 `stiffness/damping` 全部落在 framer 库缺省常量处（`ej`/scale 缺省等） |

---

## 4. 移植到原生 HTML/CSS/JS

### 4.1 总原则
1. **一切用 CSS 做，JS 只负责加/删 class**（切页需要一次 `animationend` 串联）。
2. **不要照抄 spring**（`stiffness:500 / damping:25`）：原生实现弹簧要写 JS 物理循环，收益极低。用 `cubic-bezier(.22,1,.36,1)` 近似——它是「快出、慢收」，与 `stiffness 500 / damping 25`（欠阻尼、约 350ms 稳定）的手感接近。
3. **页面切换保持「先退后进」**，这是最关键的一条。
4. 所有时长写进 CSS 变量，方便一处调。
5. 位移方向由「导航方向」决定：往列表下方切 → 新页从上下来（+18px），旧页往上走（−14px）。

### 4.2 可直接复制的 token 块
```css
:root{
  /* 颜色 */
  --bg:#f6f8fc; --card:#fff; --muted:#edf2f9; --accent:#eef4ff;
  --fg:#111827; --fg-2:#66758a; --border:#e1e7f0; --input:#d3ddea;
  --primary:#2f6df6; --primary-fg:#fff; --danger:#dc2626;
  --sidebar:#fff; --sidebar-hover:#eef4ff; --sidebar-border:#e5ebf4;
  /* 圆角 */
  --r-sm:8px; --r-md:12px; --r-lg:16px; --r-xl:26px; --r-pill:999px;
  /* 阴影 */
  --sh-1:0 1px 2px rgb(0 0 0 / .05);
  --sh-2:0 4px 12px rgba(0,0,0,.1);
  --sh-3:0 18px 40px -12px rgba(0,0,0,.35);
  --sh-4:0 14px 34px -16px rgba(16,24,40,.45);
  --inset-hi:inset 0 1px 0 rgba(255,255,255,.6);
  /* 间距 / 字阶 */
  --s:4px;
  --t-xs:12px; --t-sm:14px; --t-base:16px; --t-lg:18px; --t-xl:20px; --t-2xl:24px;
  /* 动效 */
  --d-fast:150ms; --d-hover:200ms; --d-exit:160ms; --d-enter:190ms;
  --d-collapse:300ms; --d-dialog:200ms; --d-card:285ms; --stagger:80ms;
  --e-out:cubic-bezier(.22,1,.36,1);       /* 主曲线：页面进出 */
  --e-std:cubic-bezier(.4,0,.2,1);         /* 控件默认 */
  --e-collapse:cubic-bezier(.25,.1,.35,1); /* 高度展开 */
  --e-hover:ease;
}
@media (prefers-color-scheme: dark){
  :root:not([data-theme="light"]){
    --bg:#07090d; --card:#11161d; --muted:#1a2029; --accent:#1d232d;
    --fg:#eef2f7; --fg-2:#98a2b3; --border:#232a35; --input:#2b3442;
    --primary:#ff4b26; --primary-fg:#fff7f3; --danger:#ef4444;
    --sidebar:#0a0d12; --sidebar-hover:#171c24; --sidebar-border:#202631;
  }
}
```

### 4.3 页面切换（等价 `AnimatePresence mode="wait"`）
```css
.page{will-change:transform}
.page[data-anim="in"]{animation:page-in var(--d-enter) var(--e-out) both}
.page[data-anim="out"]{animation:page-out var(--d-exit) var(--e-out) both}
@keyframes page-in {from{opacity:0;transform:translateY(var(--dy-in,18px))} to{opacity:1;transform:none}}
@keyframes page-out{from{opacity:1;transform:none} to{opacity:0;transform:translateY(var(--dy-out,-14px))}}
.page[data-anim="in"].dir-up  {--dy-in:-18px}
.page[data-anim="out"].dir-up {--dy-out:14px}
@media (prefers-reduced-motion:reduce){
  .page[data-anim]{animation-duration:1ms}
}
```
```js
const order = ['status','curve','control','about'];
let cur = 'status';
function go(next){
  if (next === cur) return;
  const dir  = order.indexOf(next) > order.indexOf(cur) ? 'down' : 'up';
  const oldEl = document.querySelector(`.page[data-page="${cur}"]`);
  const newEl = document.querySelector(`.page[data-page="${next}"]`);
  newEl.classList.toggle('dir-up', dir === 'up');
  const enter = () => {
    newEl.hidden = false;
    newEl.dataset.anim = 'in';
    newEl.addEventListener('animationend', () => { delete newEl.dataset.anim; }, {once:true});
    document.querySelector('main').scrollTop = 0;
  };
  if (!oldEl) return enter();               // 冷启动：只进不退（对应 initial={false}）
  oldEl.classList.toggle('dir-up', dir === 'up');
  oldEl.dataset.anim = 'out';
  oldEl.addEventListener('animationend', () => {
    oldEl.hidden = true; delete oldEl.dataset.anim;
    enter();                                 // 串行：退完再进
  }, {once:true});
  cur = next;
}
```
**要改手感就改三处**：`--d-enter`（190ms）、`--d-exit`（160ms）、`--dy-in/out`（18/−14）。想更「重」就把 enter 提到 240ms；想更「轻」用 160/140。

### 4.4 卡片错峰
```css
@keyframes card-in{from{opacity:0}to{opacity:1}}
.grid > .card{
  animation:card-in var(--d-card) ease-out both;
  animation-delay:calc(var(--i,0) * var(--stagger));
}
/* 或用 nth-child，不依赖 HTML 里的 --i */
.grid > .card:nth-child(2){animation-delay:80ms}
.grid > .card:nth-child(3){animation-delay:160ms}
.grid > .card:nth-child(4){animation-delay:240ms}
.grid > .card:nth-child(n+5){animation-delay:320ms}
@media (prefers-reduced-motion:reduce){.grid>.card{animation:none}}
```
JS 重新触发（切页回来时）：`grid.classList.remove('anim'); void grid.offsetWidth; grid.classList.add('anim');`

> 也可以把 stagger 换成 `translateY(6px)→0` 一起动，会更「现代」；THRM 原版**只淡入不位移**，我建议先照抄（更稳、更像仪表盘）。

### 4.5 折叠区（替代 `height: auto` 动画）
```css
.collapsible{display:grid;grid-template-rows:0fr;opacity:0;
  transition:grid-template-rows var(--d-collapse) var(--e-collapse),
             opacity var(--d-collapse) var(--e-collapse)}
.collapsible[data-open="true"]{grid-template-rows:1fr;opacity:1}
.collapsible > .inner{overflow:hidden;min-height:0}
```
`0fr → 1fr` 在现代浏览器（Chrome 106+/Safari 16+/Firefox 120+）可平滑过渡，**不需要 JS 量高度**。降级方案：`max-height: 0 → 900px`（有轻微「提前到位」感，不推荐）。

### 4.6 弹窗
```css
.overlay{position:fixed;inset:0;z-index:50;background:rgba(0,0,0,.4);
  backdrop-filter:blur(8px);animation:fade-in var(--d-dialog) ease-in-out both}
.dialog{width:min(384px,calc(100vw - 32px));border-radius:var(--r-lg);background:var(--card);
  border:1px solid var(--border);padding:24px;box-shadow:var(--sh-3);
  animation:pop-in var(--d-dialog) var(--e-out) both;transform-origin:center}
@keyframes fade-in{from{opacity:0}}
@keyframes pop-in{from{opacity:0;transform:scale(.95)}}
```
关闭：加 `.is-closing` 用同样关键帧反向（`animation-direction: reverse`），`animationend` 后移除节点。

### 4.7 Tooltip
```css
.tip{position:absolute;opacity:0;transform:scale(.95) translateY(4px);
  transition:opacity var(--d-fast) ease, transform var(--d-fast) ease;
  background:color-mix(in srgb,#fff 95%,transparent);backdrop-filter:blur(8px);
  border:1px solid var(--border);border-radius:var(--r-sm);padding:6px 12px;
  font-size:12px;box-shadow:var(--sh-2);pointer-events:none}
.tip[data-open="true"]{opacity:1;transform:none}
```
```js
let t; el.addEventListener('pointerenter', () => t = setTimeout(show, 150)); // 150ms 悬停延迟
el.addEventListener('pointerleave', () => { clearTimeout(t); hide(); });
```

### 4.8 建议参数表（最终取值）
| 场景 | 建议值 |
|---|---|
| 页面进入 | `translateY(18px)→0` + `opacity 0→1`，**190ms**，`cubic-bezier(.22,1,.36,1)` |
| 页面退出 | `→translateY(-14px)` + `opacity 1→0`，**160ms**，同曲线（串行，不重叠） |
| 卡片错峰 | `opacity 0→1`，**285ms** `ease-out`，`80ms` 间隔，封顶 4 档（320ms） |
| 弹窗 | 遮罩淡入 + 面板 `scale(.95→1)` 淡入，**200ms**，`cubic-bezier(.22,1,.36,1)` |
| 折叠 | `grid-template-rows 0fr→1fr` + 淡入，**300ms**，`cubic-bezier(.25,.1,.35,1)` |
| Tooltip | `scale(.95→1)` + 4px 位移 + 淡入，**150ms**，悬停延迟 **150ms** |
| Toast | `translateY(100%→0)` + 淡入，**400ms**；内容 `scale(.8→1)` 300ms |
| 侧栏折叠 | `width 216↔64px`，**300ms** `ease-out`；标题栏 left 同步 |
| hover | 颜色 150–200ms；上浮 `translateY(-1px)` 180ms `ease` |
| 按下 | **不做缩放**（THRM 没有） |
| 加载环 | `1s linear` 旋转 |

### 4.9 做不到 / 不建议照搬
| 项 | 原因 | 替代 |
|---|---|---|
| framer `spring(stiffness:500, damping:25)` | 需要 JS 物理循环才能完全一致 | `cubic-bezier(.22,1,.36,1)`；确实想要弹性用 `cubic-bezier(.34,1.56,.64,1)`（会过冲，慎用） |
| `height: 0 → auto` | CSS 不可过渡 auto | `grid-template-rows: 0fr→1fr` |
| `mode="wait"` 的淡入淡出交叉 | 那是 `mode="sync"` 的行为，THRM 没用 | 照抄串行即可 |
| Mica / `WindowBlurEnabled()` | 需要原生宿主窗口背景模糊 | Web 里用 `backdrop-filter` 只能模糊**页面内**内容；或直接固定纯色背景 |
| `data-theme` 多主题系统 | THRM 走注入 `<style>` 的做法，复杂度高 | 用 `[data-theme]` + CSS 变量覆盖，够用 |
| HarmonyOS Sans SC woff2 | 字体随包分发，有授权问题 | 系统字体栈 `system-ui, "Microsoft YaHei", "PingFang SC"`；数字用 `Manrope`/`Inter`（若可引入） |
| SortableJS 拖拽 | 有依赖 | 原生 HTML5 DnD 或 `pointerdown` 手写；落位动画 170ms 同曲线 |
| sonner 的 `--swipe-amount-*` 手势关闭 | 桌面端没有意义 | 不做 |
| 5.8s 扫光 | 长时间循环动效在低端机耗电 | 用 `transform` 而非 `left`，并 `prefers-reduced-motion` 关闭 |

---

## 5. 证据清单

### 5.1 截图 / 帧图
**无**。THRM 以管理员权限运行，本会话为非管理员，UIPI 使 `ShowWindow / PrintWindow / SendInput` 全部失效（详见 1.2）。唯一的产物 `${MOLLY_ROOT}\qq-whale\out\thrm-recon\live-01.png` 是 166 B 的空白图，**不可作为证据**。

### 5.2 代码证据（绝对路径）
| 文件 | 内容 |
|---|---|
| `${MOLLY_ROOT}\qq-whale\out\thrm-recon\thrm-utf8.txt` | THRM.exe 的 UTF-8 全文（18,505,756 字符），所有 `idx` 指向它 |
| `${MOLLY_ROOT}\qq-whale\out\thrm-recon\indices.txt` | 关键常量 → 字符索引对照表 |
| `${MOLLY_ROOT}\qq-whale\out\thrm-recon\shell-region.txt` | AppShell 区原文（idx 6826900 起 9800 字符）：侧栏/标题栏/页面容器 |
| `${MOLLY_ROOT}\qq-whale\out\thrm-recon\glacier-theme.css.txt` | 冰川示例主题全文（idx 6040000 起 38000 字符） |
| `${MOLLY_ROOT}\qq-whale\out\thrm-recon\scan9.txt` / `scan10.txt` / `scan11.txt` | 第 9–11 轮扫描结果（AnimatePresence / tab 顺序 / Switch） |
| `${MOLLY_ROOT}\qq-whale\out\thrm-extract\` | 用户先前抽出的 4 份样本（a/b/c/d） |

### 5.3 关键索引（可直接 `Substring` 复现）
| idx | 内容 |
|---|---|
| 5797389 | 主题 bootstrap 内联脚本（`thrm.theme-bootstrap`） |
| 6053294 | 冰川示例主题文档头（钩子类名清单） |
| 6066260 / 6066504 | `.glacier-chart-canvas::before` 扫光 / `glacier-scan 5.8s` |
| 6293556 | `eT({duration:e=300, …, ease:n="easeInOut"})`（framer 缺省缓动） |
| 6303883 / 6303974 | `ej={spring,500,25}` / `eH={keyframes,[.25,.1,.35,1],.3}` |
| 6414150 | 依赖版本清单（framer-motion 13.1.1） |
| 6528348 / 6529819 | 区块进入 `{opacity:0,y:8}` / 折叠区 `{opacity:0,height:0}` |
| 6708304 | 弹窗 `{scale:.95,opacity:0}` + `duration:.2` |
| 6714209 / 6714391 | `--ease-out` / `--default-transition-duration:.15s` |
| 6797409 | `--mica-content-surface`（Mica 变量） |
| 6800804 / 6800857 / 6801370 | `@keyframes page-card-fade` / 错峰规则 / `--reveal-row*80ms` |
| 6801530 | `.glacier-native-backdrop`（Mica 降级） |
| 6801923 | `glacier-status-chip`（10 处） |
| 6804104 | `app-overlay-scrollbar`（8px、`top/bottom:6px`、`opacity .2s`） |
| 6805371 | `.fan-spin` reduced-motion + `.cn-toast` 自定义皮肤 |
| 6805371 | `.fan-spin` reduced-motion + `.cn-toast` 自定义皮肤 |
| 6805254 | `.animate-pulse-ring` |
| 6826498 | 风扇图标组件（RPM→`animationDuration` 公式、失焦暂停） |
| 6826632 / 6826636 | tab 顺序 `["status","curve","control","about"]` / `ei` variants |
| 6828169 / 6836075 | 标题栏 `transition-[left] 300ms` / 侧栏 `transition-[width] 300ms` |
| 6832906 / 6835038 | 导航项 `h-11 rounded-xl transition-colors 200ms` / 宽度 `216:64` |
| 6840526 / 6840703 / 6840763 | `main max-w-[1120px]` / `mode="wait"` / `custom:Q,variants:ei` |
| 6882886 / 6905376 / 6886313 | 卡片顺序 key / SortableJS `animation:170` / `cubic-bezier(.22,1,.36,1)` |
| 7181810 | Switch `translate-x-5` |
| 7626258 / 7627917 | `[data-sonner-toast]`（62 处）/ `sonner-fade-in` |

---

## 6. 置信度

| 结论 | 等级 | 说明 |
|---|---|---|
| 页面切换 190/160ms、18/−14px、`.22,1,.36,1` | **A** | 逐字常量，反复核对 3 次 |
| `mode="wait"` 串行、冷启动不播 | **A** | 组件属性逐字 |
| 卡片错峰 285ms + 80ms×索引（封顶 4） | **A** | 原始 CSS 逐字 |
| 折叠 300ms + `[.25,.1,.35,1]` | **A/B** | keyframes 是库缺省，非应用显式写；数值确定 |
| 弹窗 200ms / scale .95 | **A**（时长）/ **B**（缓动） | 只给 `duration`，缓动取库缺省 easeInOut |
| 区块进入 200ms + y8 | **A**（数值）/ **B**（缓动） | 同上 |
| Tooltip 150ms + 4px + scale .95 | **A** | tw-animate-css 常量 + `--tw-duration` 缺省 |
| 侧栏 216/64 + 300ms ease-out | **A** | 逐字 |
| 「没有按压缩放」 | **A（强）** | `whileTap` 全局命中 0 |
| 手感/观感描述 | **C** | 无逐帧实测，无法量化 |

**未解项**：
1. 没有逐帧实测数据（受 UIPI 限制）——有管理员权限时可补，方法见 1.2。
2. 深色模式下的实际观感未验证（本机为浅色）。
3. `--radius` 的倍数档位（`.6/1.4/1.8/2.2`）具体映射到哪些 Tailwind 类未逐一确认，只确认了实际渲染尺寸。

---

## 7. 落地到 Molly 控制台（2026-11-05 已实施）

按本文第 0 节速查表 1/2/3 三条，移植进 `${MOLLY_ROOT}\qq-whale\console\`（无框架原生 HTML/CSS/JS），没有引入任何库。

### 7.1 已经做的

| THRM 条目 | Molly 实现 | 代码位置 |
|---|---|---|
| #1 页面进入 190ms `cubic-bezier(.22,1,.36,1)` `translateY(18px)→0` + 淡入 | `@keyframes molly-page-enter`，`.page.is-entering` | `console.css` §33 |
| #2 页面退出 160ms 同曲线 `0→-14px` 淡出，与新页**串行** | `@keyframes molly-page-leave`，`.page.is-leaving`；`PAGE_LEAVE_MS = 160` 后才 `hidden=true` 并给新页挂 `is-entering` | `console.js` `switchPageTo()` |
| #3 卡片错峰 285ms `ease-out`、间隔 80ms、封顶 | `@keyframes molly-page-in`（只做 opacity，不做位移），`--reveal-i` 由 JS 写，`animation-delay: calc(var(--reveal-i) * 80ms)`，索引封顶 6 | `console.css` §33 + `console.js` `revealPage()` |
| #11 Hover 只有 150–200ms 位移/变色，**没有按压缩放** | 沿用既有 `.nav-item` / `.card` hover，未新增缩放 | —— |
| 无障碍：`prefers-reduced-motion` 关闭动效 | CSS 里三个 keyframes 全部 `animation: none`；JS 里 `prefReduceMotion()` 为真时跳过串行，直接切页 | 两处 |
| 材质：卡片「负 spread 大偏移 + 顶部 inset 白线」 | 玻璃卡加 `inset 0 1px 0 rgba(255,255,255,.55)` + `0 18px 36px -26px rgba(30,45,35,.28)` | `console.css` §33 末 |

### 7.2 刻意没做的

- **`whileHover` / `whileTap` / `layoutId`**：THRM 自己命中数为 0（见 2.x），Molly 也不加按压缩放和共享元素过渡。
- **spring 弹性**：THRM 的弹性是 framer 缺省常量，应用层从未显式配置；用等价的 CSS 曲线即可，不手搓物理弹簧。
- **配色/字阶全套照搬**：THRM 是冷蓝 shadcn，Molly 是暖纸墨绿，换皮会毁掉既有身份。只借「节奏」和「材质手法」，不借调色板。
- **侧栏 216↔64px 折叠**：Molly 侧栏是玻璃胶囊，折叠会破坏玻璃分块，未引入。

### 7.3 验收数据（ego 浏览器 + 桌面 WebView2 双端）

一次从「总览」切到「关于」的采样（`classList` 快照，桌面端 build `2b0c45c9`）：

```text
0ms    overview[is-revealing]
90ms   overview[is-revealing is-leaving]      ← 退出动画中，新页仍 hidden
180ms  about[is-entering is-revealing]        ← 160ms 后换页，新页开始进入
480ms  about[is-revealing]                    ← 收敛
```

- 计算样式实测：`animation-name: molly-page-in`、`duration: 0.285s`、`delay: 0s/0.08s/0.16s/0.24s`、`easing: cubic-bezier(0, 0, 0.2, 1)`；`.page-head` 不参与（`animation-name: none`）。
- 15 个页面逐个点击：全部 `page -> ok`（任一时刻只有一个 `section` 可见），`window.onerror` 0 条，1256 视口 `scrollWidth == clientWidth`。
- 连点 4 个导航项（间隔 40ms）后：`visible: [overview]`、`stuck: []` —— 定时器不打架、不残留 `is-leaving`。

### 7.4 复用建议

1. 动画只挂在**页面级**与**页面直接子元素**上，别挂到列表行——4 秒轮询重绘会把行级动画变成抽搐。
2. 串行换页必须用**两个**定时器物（换页定时器 / 收尾渲染），共用一个会被后一次调用清掉（本实现第一版就踩了这个坑：页面永远停在 `is-leaving`）。
3. `hidden` 与动画互斥：`hidden` 的元素不合成，动画等于空跑；所以「先播完再 `hidden`、`hidden=false` 之后才挂 `is-entering`」。