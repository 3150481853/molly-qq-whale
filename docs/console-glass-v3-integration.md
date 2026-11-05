# 玻璃 v3 · 集成与艺术终审（Lead 决策）

> 这份文件是 Lead（艺术总监）在两位子会话交付后执行的**最终集成清单**。
> 子会话的产出是「素材」，窗口层 + 页面层必须在这里合成一套，否则会出现双层纱、双层 44px、接缝线。

## 0. 一句话目标

窗口是**一片**玻璃：桌面壁纸被 DWM 磨砂，暖白纱只有一层，页面上没有任何横线/竖线/原生滚动条，
标题区与内容区是同一块表面，看不出哪里是「窗口」，哪里是「页面」。

## 1. 已确认的物理事实

- Win11 23H2，主屏 2560×1600 @150%。DWM `SYSTEMBACKDROP_TYPE=3`（系统亚克力）能真实透出壁纸（`out/c-v2-acrylic2.png`）。
- WebView2 需要 `DefaultBackgroundColor=Transparent` + WPF `CompositionTarget.BackgroundColor=Transparent` 才透。
- WebView2 是独立子 HWND：WPF 的按钮/文字**画不到它上面**，所以 WPF 必须自己占一行做标题条（当前 44px）。
- 磨砂染色 alpha 越低，壁纸颜色越明显：0x99（60%）已经发灰，0x33（20%）能看清壁纸色块。
- 原生滚动条（带 track 的）在所有可滚动区域都会画出一条竖线 —— 用户说的「分界线」主要就是它和顶栏硬底。

## 2. 结构的唯一正解

```
┌─────────────────────────────── 窗口（DWM acrylic，圆角 8）
│ 44px 标题条（WPF 画，只有一个背景：暖白纱 .58）    [− □ ×]
├─────────────────────────────── WebView2（页面）
│ 侧栏（rgba 白 .10 提亮）  │  顶栏（sticky，遮罩淡出）
│                           │  内容（卡片 rgba 白 .62）
└───────────────────────────────
```

- **暖白纱只有一层**：`.app` 上铺 `rgba(252,251,248,.58)`；WPF 标题条 `Background` 用**同一个颜色**。
  两层叠加会变成 0.82 的实底（现在 `gt-crop.png` 里标题条比页面灰一档，就是叠了两层）。
- **页面不再自己留 44px**：WPF 已经占了一整行，页面 `--drag-h` 必须是 `0px`（否则内容下移 88px）。
- 标题条里**不再放品牌字**（与侧栏 brand 重复）；只保留窗口按钮，默认 45% 可见、hover 100%。
  侧栏 brand 是唯一的产品标识。

## 3. 必改项（按文件）

### `desktop/MainWindow.xaml`
1. `Background="#99F8F3EA"` → `#94FCFBF8`（与页面 `.app` 纱同色同 alpha：252,251,248 @58%）。
2. 删掉标题条里的 `M / MOLLY` 品牌 StackPanel（第 37–48 行）。
3. 标题条内侧高光 `#73FFFFFF` 保留（玻璃边缘需要这一道），但改 `1,1,1,0` → `1,1,0,0`（只留上边）。
4. `WebView2 DefaultBackgroundColor="Transparent"` 保持。

### `desktop/App.xaml`
- `CaptionGlyph` 的 `Foreground` 从 `Transparent` 改成 `#73000000`（悬停区域能看见按钮），`CaptionButton:hover` 里再加亮。
- `CaptionCloseButton:hover` 红底保留。

### `console/console.css`
1. `html[data-shell="desktop"]{ --drag-h: 0px; }`（窗口层已经让位）。
2. `--v3-veil: rgba(252,251,248,.58)` 保持；`.app{ background: var(--v3-veil); }` 保持唯一一层。
3. 统计卡统一成一种材质：删掉 §27.6 里 6 条 `.stat.tint-*{...}` 覆盖，改为 `.stat{ background: var(--v3-card); }`，
   只保留左侧 2px 的色条（若有）——四张卡底色不同是现在最大的「不高级」来源。
4. 新增**唯一滚动条规则**（全文只此一处，别再给别的容器单独写）：
   ```css
   *{ scrollbar-width: thin; scrollbar-color: rgba(25,33,30,.18) transparent; }
   ::-webkit-scrollbar{ width: 10px; height: 10px; }
   ::-webkit-scrollbar-track{ background: transparent; }
   ::-webkit-scrollbar-thumb{ background: rgba(25,33,30,.16); border-radius: 99px;
     border: 3px solid transparent; background-clip: content-box; }
   ::-webkit-scrollbar-thumb:hover{ background: rgba(25,33,30,.30); }
   ::-webkit-scrollbar-corner{ background: transparent; }
   ```
5. 侧栏/内容等所有 `overflow` 容器不要 `background` + `border` 同时出现（现在已清）。

### `tools/console-server.mjs` / 前端 `console.js`
- 桌面壳打开 URL 必须带 `?shell=desktop`；`data-shell` 由 `console.js` 初始化时写入（B 已做，需验证真实窗口里生效）。

## 4. 验收（缺一不可）

1. 真实壁纸下截图：`out/final-glass-window.png` —— 能看出壁纸颜色（不是灰雾），标题条与页面**无色差接缝**。
2. 表情包页滚到底 + 记忆页滚到底：右侧只有一条 4px 悬浮滑道，**没有任何 track 线**。
3. 顶栏滚动时：内容从模糊里化出来，没有一道横向亮线（对比 `out/v3-stickers-scrolled.png`）。
4. 四张统计卡同色；只有数值不同。
5. 1440 宽与 390 宽（`?shell=desktop` 关闭）都不能溢出。
6. 关掉磨砂（设置页开关）→ 退回 0.94 暖纸面，绝不能变黑。
7. 单实例、关闭语义、随 DSH 拉起：沿用 `dist/desktop` 现有行为，重打包后复测。

## 5. 最终落地状态（2026-11-04 18:2x）

磨砂路线最终**没用 DWM**：Win11 23H2 上 `ACCENT_ENABLE_ACRYLICBLURBEHIND` 返回成功但画面纯白，`DWMWA_SYSTEMBACKDROP_TYPE=3` 能采到壁纸却自带 ~0.6 不可调白雾。最后改成自绘——读注册表壁纸 → 1/4 分辨率渲染 + 高斯模糊 r=15 → 冻结整屏图，窗口移动只改 `Viewbox`。见 `desktop\WallpaperBackdrop.cs`、`docs\desktop-app.md` 的「玻璃外壳」一节。

验收记录（全部通过）：

| 项 | 证据 |
| --- | --- |
| 壁纸可见、无色阶接缝 | `out\v10-prod-overview.png`、`out\v10-corner.png`（x=60 列 y=12→70 单调过渡 #C0C0C8→#F2EFF0） |
| 表情包页无分界线、无滚动条槽 | `out\v11-stickers.png` |
| 浏览器模式退回暖纸 | `out\browser-mode.png`（Edge headless 1440x900） |
| 侧栏无竖线、激活项为药丸 | 同上两张 |`n| 侧栏纱向右淡出、与正文无材料边 | `out\v13-wide.png` |
| 生产进程 | `Molly.exe` pid 39124 + 后端 73012@19392，health ok |

`Molly.exe` 最终 SHA256：`<REDACTED>`（163093664 B）。
`console.css` 63046 字符，三份（源码 / `dist\console` / `dist\desktop\console`）SHA256 前缀 `1F849D05CCB3` 一致。

## 6. 后续三轮（2026-11-04 22:00–23:25）：把「那条线」彻底清干净

用户三次指同一症状（`m03686` 文字可读性、`m03797`/`m03852` 侧栏与顶栏交界、标题条下沿横线）。逐轮定位结果：

### 6.1 侧栏改成悬浮胶囊（§29，`console.css` 末尾）

`html[data-shell="desktop"][data-glass="true"] .sidebar`：`margin:10px 0 10px 10px`、`height:calc(100vh - 20px)`、`border-radius:18px`、`blur(22px) saturate(1.05)`，背景改成**上沿渐隐**的竖向渐变 `.02 → .20 → .40 → .50`（14%/34%/62% 三个节点），去掉 `0 1px 2px` 顶边阴影。页头副标题 `.page-sub` 加药丸底衬 `.60`。实测 x=30 列 y=44→y=120 亮度 221.8→245.3 单调，无台阶。

### 6.2 顶栏 `backdrop-filter` 是白雾来源（§27.16 ⑦ 第四次改）

`.topbar::before` 上的 `backdrop-filter: blur(18px)` 会让 Chromium 把页面根背景（白）一起合成进 backdrop，结果**顶栏带整体被压进一层白雾**：同一条竖列 x=900，带内 y=70 是 221，带外 y=200 就是 193.6。改成 `none` 后带状亮雾消失（自绘壁纸本来就是模糊的，静止时零差异）。

### 6.3 标题条与页面「两种材料」（WPF 侧）

`MainWindow.xaml` 的标题条 `TitleBar` 里加两个 Border：`TitleBarBackdrop`（画同一张模糊壁纸）+ `TitleBarVeil`（暖白纱）。刷子由 `WallpaperBackdrop.CreateBrushFor(window, element)` 生成——用元素自己的 `PointToScreen` 矩形重算 `Viewbox`（`ViewboxUnits=Absolute`、`Stretch=Fill`、`Scale=0.25`）；直接用整窗刷子会把整张壁纸压进 44px，永远对不上。

白纱最终取 `#6BFCFBF8`（α=0.42），比页面 `.app` 的 0.34 略厚——因为标题条那块底图比页面略暗，实测 0.34 时 y=66（1.5 缩放下的 44 CSS 边界）稳定差 6.3 级，0.42 后降到 -2.4/-0.4/-1.0/0/+0.9/-0.6（x=300/600/900/1200/1400/1900）。

### 6.4 终态与产物

| 项 | 值 |
| --- | --- |
| 接缝（y=66 物理，多列） | ≤2.4 级（原 8.9 / 31.1 / 4.9） |
| 证据 | `out\seam-fixG.png`（整窗）、`out\seam-fixG-top.png`（2× 裁剪）、`out\seam-fixG-scroll.png`（滚动时顶栏） |
| `Molly.exe` | 163093664 B，SHA256 `<REDACTED>` |
| `console.css` | 75920 B，三份副本 SHA256 `<REDACTED>` |
| 服务端 build | `cb14da88`（改前端文件即变，页面 4 秒轮询自动 reload） |

注意事项：
- 标题条白纱 α 与页面 `.app` 纱**不是一个数**（0.42 vs 0.34），以后调纱要两个一起看着调；`WindowGlass.TitleBarVeilArgb`（0x57FCFBF8）只给 DWM 回退路线用。
- 别再给 `.topbar` 加 `backdrop-filter`：在这台机器上它等于给顶栏带加白雾。
- 量接缝前先确认缩放：2040 宽窗口是 1.5 倍，44 CSS 边界在**物理 y=66**；1360 窗口才是 y=44。
## 7. 左栏铺满（2026-11-04 第五次改）

用户要求：「把左上角这个往下拉伸到左边那一块都是这样」。

- `§29` 的侧栏胶囊去掉四边 10px 留白：`margin:0`、`height:100vh`、`border-radius: 0 18px 18px 0`，
  玻璃一直铺到窗口左/上/下边缘，只留右侧 18px 收口 → 左栏从顶到底是一整块，L 形缝隙消失。
- 同时**去掉侧栏的 `backdrop-filter`**：透明 WebView2 里它拿不到可模糊的东西，却会把侧栏提成独立合成层，
  顶边冒出一层中性白雾（实测 1360x880 窗口 y=44 处 +12 灰阶、颜色被洗成 177,177,179）。
  改纯半透明渐变后，顶边与标题条齐平（2040x1320 窗口 y=66 处逐行差 ≤1）。
- 纱的起始浓度从 `.02` 抬到 `.33`（`.33 → .42@18% → .50@45% → .52`），因为少了合成层那层白雾后，
  顶部只剩 .app 的 .34，与标题条不等高。
## 8. 侧栏字号与字体（2026-11-05，第六次改）

用户反馈「左侧栏的字有点小有点糊，可读性一般」。两条独立原因：

1. **字体栈首选未安装**：--font 第一位是 `"Inter"`，本机没有安装，中文实际回落到 Microsoft YaHei；13px 的雅黑在没有 ClearType 的透明窗口里发灰发糊。改为
   `--font: "MiSans", "Noto Sans SC", "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;`
   （本机 MiSans / Noto Sans SC 各字重齐全）。
2. **字号与墨色**：§32 把桌面壳导航提到 15px / 500、墨色 `rgba(18,26,22,.90)`（激活 600 / `#0c1310`），分组标题 11.5px、脚注 11.5px。

为了在放大字号后仍让 15 个导航项一屏放下，同时压缩了纵向节奏：`.nav-item` 31px、`.brand` 64px、分组标题 `6px 16px 1px / line-height 1.2`、`.nav` 底部 26px 渐隐 mask。实测（1256x774 视口）`.nav` scroll 670 / client 605；1360x880 窗口下基本正好放下，`关于` 与 `高级操作` 均无需滚动。

另注：窗口最左 6px 有一条极淡的竖向条纹，属于 WPF `WindowChrome` 的 resize 边框区域（`ResizeBorderThickness=6`）与自绘壁纸的接缝，不是页面元素，暂未处理。