# Molly 控制台 1.1.7 正式版 · 全部新增与改进

> 基线：`1.1.7-preview.1`（2026-10-30）
> 本版：`1.1.7`（2026-11-05）
> 范围：控制台前端、控制台后端、桌面外壳（Molly.exe）、记忆内核（jasmine）、插件侧唱歌链路

---

## 一、控制台外观：从「暖纸面」到「相对桌面的磨砂玻璃」

1. **真玻璃**：窗口背后是真实的桌面壁纸——由桌面外壳自绘（读注册表壁纸 → 按 `WallpaperStyle` 铺虚拟屏 → 1/4 分辨率渲染 + `BlurEffect` 半径 15 ≈ 全分辨率 60px），窗口移动/缩放只改 `ImageBrush.Viewbox`，不重算、不闪烁。
   - 之所以不是系统材质：Win11 23H2 上 `ACCENT_ENABLE_ACRYLICBLURBEHIND` / `ACCENT_ENABLE_BLURBEHIND` / `DwmExtendFrameIntoClientArea(-1)` 全部**返回成功但不生效**（画面纯白），Mica 染色过重，只有 `DWMWA_SYSTEMBACKDROP_TYPE=3` 生效却自带约 0.6 白雾且不可调。
2. **三层纱**：标题条（`#6BFCFBF8`，α .42）／页面 `.app`（α .34）／侧栏胶囊（纵向渐变 .33→.52）。标题条与页面共用同一张模糊底图，交界处亮度差 ≤2.4 灰阶（修前 8.9 / 31.1 / 4.9）。
3. **侧栏胶囊铺满左缘**：`margin:0; height:100vh; border-radius:0 18px 18px 0`，左上角不再有壁纸条；纱从顶部 .33 起、到 45% 收到 .50。
4. **分界线治理**（本版花时间最多的一项）：
   - 顶栏 `backdrop-filter` 在透明窗口里会把页面根背景（白）一起合成，必然压出一条白雾带 → 顶栏 `::before` 的 `backdrop-filter` 设为 `none`，改为 22px 渐变遮罩淡出；
   - 滚动条统一成「8/12px 命中区 + 4/6px 视觉、透明轨、无箭头、无白槽」的悬浮拇指；
   - 内容区改为自己滚（`.app` 与 `.main` 锁定 100vh），文字不再从顶栏下面穿过去。
5. **字体**：`--font` 首选从未安装的 Inter 换成 **MiSans → Noto Sans SC**，侧栏导航 15px / 31px 行高 / 500 字重，普通项墨色 .90、当前项 600 字重；品牌副标题、分组标题、搜索框同步提亮。
6. **切页过渡**（照 THRM 实测参数）：旧页 160ms `translateY(0→-14px)` 淡出 → 新页 190ms `translateY(18px→0)` 淡入，同为 `cubic-bezier(.22,1,.36,1)`，串行播放；卡片 285ms ease-out、每张 80ms 阶梯（封顶 320ms）；`prefers-reduced-motion` 全关。

## 二、控制台功能：找得到、点一下就执行

7. **命令面板升级**（`Ctrl+K`）：不再是「只搜页面」，现在同时搜**页面**和**执行块**，结果按「页面 / 执行 · 分类」分组，`↑↓` 移动、`Enter` 打开或执行。
   - 执行动作会跳到「所有执行块」对应卡片、高亮 1.8 秒后走同一套字段校验 / 危险确认 / 结果区——**不产生第二套写入通路**。
8. **Jasmine 记忆页（原「记忆」）**：正式更名「茉莉花记忆系统」，导航图标 ❀。
   - 三栏：左侧索引（类型 / 人物 Top12 / 权重档 / 时间桶）、中间列表（60 条/批 + 加载更多）、右侧详情抽屉；
   - 顶部四指标（总条数 / 今日新增 / 有身份占比 / 平均有效权重）+ 七类分布条 + 衰减口径提示；
   - 搜索空格分词 AND、命中高亮；六种排序（时间新→旧 / 旧→新、最近活跃、权重高→低 / 低→高、命中次数）；按日期看某一天；
   - 中栏常显滚动条，可以拖着逛，不用一直滚轮。
9. **记忆衰减可见化**：内核一直是「读时算」（越过宽限后每 7 个活跃天 −0.5，按类设下限），但接口只回基础权重，界面永远显示 6。
   - 现在 `overview.memory` 带 `activeDays` / `activeDayKey`，前端按同一套公式算有效权重，掉权的条目显示 `w6 → 5.5`，详情里写清「空闲 N 活跃天 · 宽限 N 天 · 下限 N」。
   - 本机实测：活跃天 10 天、5,432 条、掉权 0 条（最长的也只空闲 10 活跃天，还没越过 14/7 天宽限）。
10. **关于页**（`#/about`）：THRM 风格的品牌卡 + 检查更新卡 + 数据卡 + 开发者与联系 + 版本与许可。
    - 「检查更新」= 前端 build 与服务端 build 的一致性检查（本机部署没有发版服务器）；
    - 更新日志自动抓 `docs/CHANGELOG.md` 最新一节的「改了什么」段。
11. **内部术语清理**：NapCat 字样从界面全部消失——设置页「后端切换（回滚备注）」卡删除、执行块右上角 `napcat/qr` 这类内部 id 换成中文分类胶囊（QQ / 插件 / 守护 / 进程…）、toast 改成动作中文标题、服务端 `backendName` 与 stop note 改写。

## 三、控制台后端

12. **ROOT 推导修复（重要）**：打包成 SEA 后 `ROOT = EXE_DIR`，而桌面版把 `molly-console.exe` 放在 `dist\desktop\`，于是 `tools\watchdog.mjs`、`make-qr.mjs`、`start-molly.ps1`、`panel-data.mjs` 全部找不到——**「守护状态」报「脚本不存在」就是它**。
    - 改为从 exe 目录向上最多 5 层找 `tools\watchdog.mjs` 定位工作区，找不到才退回旧行为。
13. **LIVE 出厂策略**：源码直跑默认「演练」（不动 QQ 登录），打包 EXE 默认「真执行」（界面上这些动作本来就要二次确认），`MOLLY_CONSOLE_LIVE=0` 可退回演练。
14. **宿主端口探测加固**：DSH 端口每次重启都可能变。现在探到的地址写进 `out\dsh-host.json` 记住，优先复用；探活超时 700ms → 2000ms、状态抓取 1500 → 3000ms；失败结果只缓存 15 秒（原 30 秒），不再出现「插件不可达」挂半分钟。
15. **文案**：`backendName` 只分 `SnowLuma` / `回滚后端`；停止动作的说明写「只停了 QQ 客户端与 QQ 后端；DSH 宿主、网关、控制台本身没动」。

## 四、桌面应用（`Molly.exe`）

16. 从「开个浏览器窗口」改成**真正的桌面程序**：WPF + WebView2，单实例（第二次启动只把已有窗口提到最前）、任务栏图标、无系统标题栏、自绘 44px 标题条（可拖、双击最大化、三个窗口按钮常显 42% 不透明度）。
17. **关闭语义**：是=退出并停掉本窗口启动的后端；否=只关窗口、后端继续跑（下次直接复用）；取消=留下。
18. **后端自管**：同目录找 `molly-console.exe --no-browser` 拉起，只杀自己 spawn 且路径匹配的进程；桌面副本启动时用 `%LOCALAPPDATA%\Molly\Desktop\install-dir.txt` 记住安装目录。
19. **DSH 宿主桥**：DSH 的 web 地址带一次性授权 token，页面拿不到。改为页面 `postMessage('molly:open-dsh')` → 外壳把已在运行的 DSH 主窗口提到最前（实测前台窗口从 `THRM` 变成 `DeepSeek Harness`），不新开标签页、不绕授权。
20. **随 DSH 拉起**：`tools\start-dsh.ps1` 新增 `-DesktopExePath` 与 `Start-MollyDesktop`，优先拉桌面程序；失败才回退老的控制台 EXE（同样带 `--no-browser`，不再弹浏览器）。
21. 桌面只保留快捷方式 `Molly 控制台.lnk`（指向 `dist\desktop\Molly.exe`），不再放一份 exe 副本。

## 五、记忆内核与独立发包

22. `jasmine-memory` 升到 **0.4.0** 并首次公开发布：GitHub `3150481853/jasmine-memory`，tag `v0.4.0`，release 附 `jasmine-controller-0.4.0.zip`。
23. 新增**茉莉花控制台**（`jasmine-controller`）：零依赖单文件服务端 + 三页（记忆库 / 曲线 / 数据），只监听 `127.0.0.1`。
    - 缺省上限 20000（内核默认 2000 会 `prune()` 把旧记忆挪进归档簿）；
    - `/api/import` 认 jasmine bundle、`entries[]`、以及 Molly 的 `{ok,data:{entries[]}}` 三种形状；
    - 从 Molly 迁移时用 `max(lastActiveDay)` 兜底 `activeDays`，否则所有记忆都像「没掉过权」。
    - 真实数据验证：5,436 条 → `added 5435 / skipped 1`，活跃天 10，平均有效权重 5.7。
24. 内核测试 **47/47 通过**（含召回、冲突、预算、衰减、归档、原始账重建、周聚合、导入导出）。

## 六、插件侧：唱歌链路

25. **RVC 显存不足修复**：「点歌」在 8 GiB 卡上整段推理必然 `torch.OutOfMemoryError`（110 秒的《无人之岛》直接崩）。
    - 加 `PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`；超过 150 秒自动按 30 秒切片、0.35 秒三角交叉淡化拼接；单段 OOM 自动改分片重跑。
    - 实测：110 秒单段 94 秒跑完；40 秒强制分片 28.9 秒跑完、输出 39.97 秒。
26. **点歌入口补丁**：手打 `@Molly` （没有真 at）以前被门禁挡掉，请求落到普通聊天，模型的「行，等我去扒」又被随机读成三四秒语音——这就是「先来一条 4 秒语音、过一会儿才发歌」。
    - 现在群聊里手打 `@Molly` / 茉莉 / 莫莉 / 小鱼 也会进点歌；预告文案改「五六分钟」（实测 6 分钟）；
    - `parseSingRequest` 认「点歌 / 唱一下 / 唱一遍」，并清掉《》书名号与前缀。

---

## 验收记录

| 项目 | 结果 |
| --- | --- |
| 控制台 15 个页面 | 逐页点击正常、任一时刻只一个 section 可见、`window.onerror` 0、无横向溢出 |
| 命令面板 | 默认 24 条；`QQ` 6 条四段分组；`守护` 7 条且「守护状态」第一；`Enter` 执行返回 `成功 278 ms HTTP 200` |
| 记忆页 | 5,432 条、首行 137ms、`memory/list` 69ms/2.36MB、搜索与筛选/排序逐项核对 |
| 玻璃接缝 | 1.5 缩放窗口 y=66 处六列亮度差 ≤2.4（修前最大 31.1） |
| 滚动条 | 8/12px 命中区、4/6px 视觉、无箭头无白槽 |
| 桌面 | 单实例、关闭三选语义、自起后端 2 秒健康、DSH 前置成功 |
| 唱歌 | 110 秒出片、端到端 `ok:true` |
| jasmine | 47/47 测试通过；真实 5,435 条迁移成功 |

## 产物

| 文件 | 说明 |
| --- | --- |
| `dist\desktop\Molly.exe` | 桌面应用（自包含单文件） |
| `dist\desktop\molly-console.exe` | 控制台后端（Node SEA） |
| `dist\desktop\console\` | 前端三件套（与 `console\`、`dist\console\` 同步） |
| `out\jasmine-controller-0.4.0.zip` | 茉莉花控制台独立包 |

## 已知限制

- 窗口最左 6px 属于 `WindowChrome` 的 resize 边框，鼠标在那里是拉宽而不是点导航。
- 桌面壳里 `Ctrl+K` / 点侧栏偶发不响应（WebView2 焦点问题），点一下页面正文即恢复。
- 「检查更新」只比对前后端 build，没有远程发版源。
- 控制台无鉴权、只监听 `127.0.0.1`。

## 产物校验（2026-11-05 构建）

| 文件 | 字节 | SHA256 |
| --- | --- | --- |
| `Molly.exe` | 163,097,760 | `<REDACTED>` |
| `molly-console.exe` | 93,844,992 | `<REDACTED>` |
| `console.css` | 104,089 | `<REDACTED>` |
| `console.js` | 245,546 | `<REDACTED>` |
| `index.html` | 35,414 | `<REDACTED>` |
| `jasmine-controller-0.4.0.zip` | 81,559 | `<REDACTED>` |

> 桌面壳与后端都已按 1.1.7 重新构建并部署到 `dist\desktop\`；三份前端副本（`console\` / `dist\console\` / `dist\desktop\console\`）哈希一致。
