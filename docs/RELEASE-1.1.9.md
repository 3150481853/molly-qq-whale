# v1.1.9 正式版 发布说明（2026-11-26）

> 上一正式版：`v1.1.8`（2026-11-08）。
>
> 这一版 18 天里攒下的东西可以归成四句：**她手里终于有网了**（聊天面补只读搜索）、**游戏模式从「拨了没用」变成总闸**（SoVITS / 嵌入 sidecar / 识图浏览器 / 控制台弹窗 / 闲逛一律认它）、**内部日志再也不许出门**（DSML 假调用、伪造引用头、上下文统计回执）、以及新能力 **搜番**。另外修掉唱歌把 traceback 甩进群、控制台「点游戏模式界面就飞」这两个老毛病。

---

## 一、新能力：搜番（`#茉莉搜番` / 工具 `anime_find`）

> 主人 m03315：「我记得之前有给Molly做一个搜图功能吧，你看看能不能把这个加进去？」

- 新增 `lib/anime-find.js`（零依赖 ESM）。手打 `#茉莉搜番 进击的巨人` / `搜番 xxx` / `#番剧 xxx` 走 `maybeAnimeFind()`；私聊与 @ 里裸词也认。
- 同时注册成宿主工具 **`anime_find`**，描述里写清「问怎么样 / 值不值得看」「问有没有资源」「拿不准是哪个番」这几种该自己调——要不要查由她判断，主人不用记命令。
- 条目源：**AniBT 为主**（`api/seasons/anime`，200 / 0.8 秒，带评分与 bgmId），Bangumi v0 兜底。这台机器 `api.bgm.tv` 的 DNS 被污染到 Facebook 的 IP，直连必然失败，所以不能把宝押在 Bangumi 上。
- 磁力四家**并发**：ACG.RIP、蜜柑、动漫花园、nyaa，每源最多 3 条、按体积降序；传输按「代理 → 直连 → 中继」三条腿试，墙内站先直连，省掉一次必然失败的握手。
- 群里只发压缩后的 magnet：`magnet:?xt=urn:btih:<hash>&dn=≤40字`，tracker 全删——原样贴一条 1500 字的长 magnet 等于刷屏。
- 实测：`进击的巨人` 25.9 秒 → **6.06 秒**；`孤独摇滚` 34.3 秒 → **6.02 秒**，能出 AniBT 真 magnet（7.9GB / 4.8GB）与蜜柑的 `.torrent`。
- 顺手修掉一个死链 bug：`magnetFromTorrent()` 的 bencode 扫描原来把 `i12345e` 这种整数当字符串读飞，位子算错 → 真实 `.torrent` 换算出的 magnet 指向不存在的种子。改成正经的 `skipBencode()`（字典 / 列表 / 整数 / 字符串分开跳）。

## 二、新能力：聊天面只读搜索 `web_lookup`（+ 说话规矩）

> 主人 m04129 截图：群友连问两次「你说话之前不开联网搜索和思考吗」，她回的是「行，那我闭嘴。」

- **根因**：`lib/commands.js` 的 `CHAT_DENY_TOOLS` 里写着 `web_search` / `web_fetch` / `research` —— 聊天面真的没有网。她不是懒，是看不见外面。
- 新增 `lib/web-lookup.js`：工具名 **`web_lookup`**（故意不叫 `web_search`，既不与宿主同名工具混淆，也天然不在禁名单里，**deny 清单一行没动**）。复用 `lib/webview.js` 的 `searchBing()`（Bing RSS），默认 3 条、上限 5 条、8 秒超时；返回「查了「q」（Bing，N 条，Xs）」+ 标题 / 摘要 / 链接，并明说「以上是网页摘要，可能过时或有错；回答时按「我查到」说」。
- `lib/persona.js` 补两节：`# 事实先查再答`（最近的事 / 数字 / 价格 / 谁上市 / 产品版本 / 比赛结果，不确定就先查；**尤其别断言「XX 还没上市吧」这种否定句**）、`# 被指正的时候`（真错了就认，不许「行，那我闭嘴 / 那我不说了 / 随便你」——那不是幽默，是把天聊死）。
- 实测：`webLookup('Anthropic 上市 发行价 83 美元')` → ok / **321ms** / 3 条真实结果。

## 三、游戏模式：从「两个内存开关」做成总闸

> 主人 m04935：「你游戏模式能不能做好了，为什么开了游戏模式实际上啥用没有？」

**它之前为什么啥用没有**：`/gamemode` 只翻 `voiceEnabled` / `singingEnabled` 两个内存开关；DSH 一重启开关就丢（控制台不会补推），所以 drift 照样翻小黑盒、识图照样拉 headless Edge、控制台照样弹浏览器、SoVITS 照样吃 9GB。

- 新增 `lib/game-mode.js`（零依赖，唯一真源）：`gameModeState()` 四档信号 **runtime → engine → `game-mode.json` → `mem-config.json`**（3 秒缓存，`fresh` 可穿透）；`persistGameMode()` 落盘；`applyGameMode()` 真干活 —— 开：语音 / 点歌热禁用 + `watchdog-config.json` 的 `voiceKeepAlive=false` + 停 SoVITS + 停嵌入 sidecar；关：按 backup 还原 + 保活恢复 + 拉起 SoVITS。
- SoVITS 常以管理员身份运行，`Stop-Process` 会被拒 → 改走它自己的 `GET /control?command=exit` 优雅退出；退不掉才按端口强杀。
- 五个入口全部认它：`lib/drift.js`（闲逛每分钟 tick 直接跳过）、`lib/sidecar.js`（嵌入 sidecar 不再拉起）、私有钩子 `recognize.mjs`（过滤 `yandex/bing/google/lens` 这类浏览器引擎）、`tools/console-server.mjs`（`openAppWindow()` 不再弹 --app 窗口）、`lib/web.js`（总闸本体 + 5 秒看门狗对盘）。
- **连点开关不会打架**：`applyGameMode` 改成串行队列 + 后来居上（排队期间旧请求返回 `{superseded:true}`）；`stopSovits` 对「刚拉起 20 秒内」的实例先等端口监听再发 exit，避免「开关关了但它过一会儿自己起来」。
- **装进 `node_modules` 后也得找得到仓库根**：新增 `findRepoRoot()`（env `MOLLY_REPO_ROOT` → config → 从 `dataDir` 逐级往上试 `…` 与 `…/qq-whale` → 源码树），否则 `watchdog-config.json` 与 `tools/voice-sovits-start.ps1` 全报「读不到」，拨开关等于什么也没发生。

## 四、内部日志不许出门（三次真机事故的收口）

| 事故 | 现场 | 收口 |
| --- | --- | --- |
| 2026-11-20，群 666666666 | 气泡里出现 `</｜｜DSML｜｜ invoke>` / `</｜｜DSML｜｜ calls>`（全角竖线） | `persona-sanitize.js` 认全角/半角/空格变体的 DSML 标签与裸标记；行首伪造的「昵称（QQ 123）：」引用头一并砍掉 |
| 2026-11-26，同群 | 连发 5 颗：`📊 [ACP] acp_status result:` / `[acp-status]` / `ACTIVE SURFACE: …host=billion-context 0.1.216` / `CONTEXT BREAKDOWN` / `0 tool (0%) \| 2.5K text (100%) …` | 新增 ⑥b：行首允许先有任意表情再是 `[ACP]`；状态块与占比行按整行删；`persona.js` 补一条「统计报表属于内部日志，一句都别贴，也别自己编假表」 |
| 2026-11-19，群 125 | `❌ [ACP] Compression FAILED: …`（1.1.8 已修） | ⑥ 只认行首 `[ACP]` 的回执 |

## 五、唱歌：报错不进群，内存不够就唱短的

- 现场：点歌 110 秒，pymss 在注意力层要不到内存，群里收到的是被 `.slice(0,80)` 砍断的 traceback（`没弄成（退出码 1： x, _ = self.attention(q, k, v, mask=attn_mask) …）`）。
- `lib/bili-sing.js` 新增 `isMemoryish(text)`（认出 `out of memory` / `mem_virtual_alloc` / `error: 1455`）；内存崩且时长 > 50 秒 → 砍到 `min(45, 一半)` 重跑一次，结果带 `shortened`；traceback 只写日志，群里只说「内存不够，渲染崩了」/「渲染时出错了（退出码 N）」。
- **开唱前预检**（主人 m03208 批的）：`freeCommitMB()` 读「提交上限 − 已提交」（`os.freemem()` 只是物理空闲，页面文件够大时两者差一大截），缓存 10 秒；低于 `memoryGuardMB`（默认 3000）就直接唱短的。`singMemoryGuardMB: 0` 可关。

## 六、控制台四处

- **表情包页自己滚动**：999 张卡把整页拉长到几万像素，滑到一半找不到搜索框。`.sticker-grid` 加 `max-height: calc(100vh - 310px)` + 12px 实体滑道；窄屏断点用 `max-width:900px`（**故意不用 1279.98**——桌面控制台默认窗口 1256px，用 1280 会把修正误关掉）。
- **「点游戏模式界面就飞」**：真凶不是游戏模式，是 `overflow:hidden` 的元素**仍然可被 `focus`/`scrollIntoView` 编程滚动** —— 点开关时浏览器 `scrollIntoView` 把 `.app` 滚了 527px，玻璃模式下露出壁纸。§39 用 `position:fixed; inset:0` + `.content{contain:paint}` 收口（试过 `overflow:clip`，但那会让 `scrollIntoView` 全废，连带弄坏键盘导航的自动滚动，已否掉）。
- **「一周里的分布」全是绿的**：数据没错，画法错 —— 热力图只有四档 `step`，≥75% 一律最深绿。新增 `onHeatBg()`：≥99.5% 深绿 / ≥99% 浅绿 / ≥95% 琥珀 / 其余红 / 无采样浅灰，并加图例。
- **总览加「陌生人审批」卡**（主人 m02221）：`/api/overview` 补 `plugin.gatekeeper`（谁在等你批、最后一句、已放行/已拒绝）。只搬数据、不放批准按钮 —— 审批仍要在 QQ 私聊里回「1 / 0」。

## 七、运维：语音保活改「真合成自检」

> 主人 m02477：「为什么现在 Molly 的语音又掉了」。

端口在听、内部已经坏了（写盘被拒，连日志都写不动）这种半死状态撑了 8 天，而 `voiceAlive()` 只看 `/docs` 有没有 200。
`tools/voice-sovits-start.ps1` 新增 `Test-Synth()`（真发一句「嗯。」，拿到 >2KB 的 wav 才算活）与 `-Check` 模式；`tools/watchdog.mjs` 新增 `VOICE_DEEP_CHECK_MS = 10 分钟`、`voiceDeepOk()`，自检失败就当死处理、走重启路径。

## 八、升级与验证

- 三处版本号同步为 `1.1.9`：`plugin/dsh-qq-whale/package.json`、`desktop/MollyDesktop.csproj`、`tools/console-server.mjs` 的 `FALLBACK_VERSION`。
- 测试（全部离线，除探针）：`test-anime-find` 33 / `test-web-lookup` 46 / `test-game-mode` 21 / `test-drift-gamemode` 9 / `test-drift-gamemode-disk` 14 / `test-acp-leak` 9 / `test-sanitize` 38 / `test-dsml-leak` 8 / `test-sing-oom` 17 / `test-heat-scale` 15 / `test-quote-anchor` 51 / `test-split-reply` 8 / `test-relations-owner` 4 / `test-lane-dedupe` 18，全部 0 挂。
- 唯一红点：`test-command-fixes` **11 过 / 1 挂**，是 11-01 就有的历史遗留（`readLastAssistant()` 在「本轮还没产出」时会退回读到下一轮的回答）——本版没动那段逻辑，行为与 1.1.8 一致。
- **生效方式：重启一次 DSH 宿主**（`lib/engine.js`、`lib/main.js`、`lib/web.js`、`lib/drift.js`、`lib/sidecar.js` 都不是热加载的）。
- 群验建议：`#搜番 进击的巨人` → 条目 + 磁力；问一句「Anthropic 上市了吗，发行价多少」→ 她应该自己调 `web_lookup` 而不是瞎猜；拨一下控制台的游戏模式 → `9880` / `8791` 应当立刻停，关掉后 SoVITS 会重新拉起（20–40 秒）。

## 九、已知限制

- `api.bgm.tv` 在本机 DNS 被污染，Bangumi 评分只能在「有代理」时补齐；平时显示的是 AniBT 的评分（会明确标出来源，不编「0 人评分」）。
- 搜番依赖公开源，蜜柑 / 动漫花园偶尔超时；某源挂了会在结果里明说挂了哪家。
- 游戏模式期间识图只剩 saucenao / tracemoe 两个直连引擎，命中率会低一些（会提示「你在打游戏，浏览器类引擎这轮没开」）。
- 控制台 exe 与插件版本号是两套：exe 里烧的是 `FALLBACK_VERSION`，插件读自己的 `package.json`；两边都改成 `1.1.9` 才算齐。
