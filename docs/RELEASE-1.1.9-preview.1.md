# v1.1.9-preview.1 发布说明（2026-11-19）

> 上一正式版：`v1.1.8`（2026-11-08）。本版把 1.1.8 之后攒下的四件事一次带上：**唱歌不再把 Python 报错甩进群**、**开唱前先看提交内存**、**表情包页自己滚动**、以及新能力 **搜番**（`#茉莉搜番` / 模型工具 `anime_find`）。另修掉一个会让磁力变死链的老 bug。

## 一、唱歌：报错不再进群，内存不够就唱短的

现场是这样的：点歌唱 110 秒，pymss 在注意力层要不到内存，进程以 `exit 1` 退出，群里收到的是

```
没弄成（退出码 1： x, _ = self.attention(q, k, v, mask=attn_mask) | ^^^^^^），换一首吧。
```

——一段被 `.slice(0,80)` 砍断的 traceback。主人看不懂，我们也没法从群里判断是哪一步崩的。

- `lib/bili-sing.js` 新增导出 `isMemoryish(text)`：认出 `out of memory` / `mem_virtual_alloc` / `error: 1455`（1455 = 页面文件太小）这类内存崩。
- 内存崩且时长 > 50 秒 → `_singWithFallback()` **砍到 `min(45, 一半)` 再跑一次**，结果带 `shortened`；traceback 只写日志。
- 群里只留人话：「内存不够，渲染崩了」/「渲染时出错了（退出码 N）」，`lib/engine.js` 那句的截断从 80 字收到 40 字。
- **开唱前先预检**（主人 m03208 批的）：`freeCommitMB({fresh})` 走 `Get-CimInstance Win32_OperatingSystem` 读「提交上限 − 已提交」（`os.freemem()` 只是物理空闲，页面文件够大时两者差一大截，不能替代），缓存 10 秒；低于 `memoryGuardMB`（默认 **3000**）就直接按 `min(45, 原时长)` 唱短的，不再让主人白等五分钟看它崩。`memoryGuardMB: 0` 可关闭。

## 二、控制台：表情包页网格自己滚动

999 张卡把整页拉长到几万像素，滑到一半就找不到搜索框。`console/console.css` 给 `.sticker-grid` 加了 `max-height: calc(100vh - 310px)` + 12px 实体滑道（照记忆页那套）；窄屏断点用 `max-width:900px`，**故意不用 1279.98**——桌面控制台默认窗口 1256px，用 1280 会把修正误关掉。

## 三、新能力：搜番

主人 m03315：「我记得之前有给Molly做一个搜图功能吧，你看看能不能把这个加进去？」——截图里是 DSH 插件 `@cocofhu/anime-find`。于是给她接了一条自己的搜番链路。

- 新增 `lib/anime-find.js`（零依赖 ESM），手打 `#茉莉搜番 进击的巨人` / `搜番 xxx` / `#番剧 xxx` 走 `maybeAnimeFind()`；私聊与 @ 里裸词也认。
- 同时注册成宿主工具 **`anime_find`**，描述里写清「问怎么样 / 值不值得看」「问有没有资源」「拿不准是哪个番」这几种该自己调——她判断要不要查，不用主人记命令。
- 条目源：**AniBT 为主**（`api/seasons/anime`，200/0.8 秒，带评分与 bgmId），Bangumi v0 兜底。这台机器 `api.bgm.tv` 的 DNS 被污染到 Facebook 的 IP，直连必然失败，所以不能把宝押在 Bangumi 上。
- 磁力源四家**并发**：ACG.RIP、蜜柑、动漫花园、nyaa，每源最多 3 条、按体积降序；传输按「代理 → 直连 → 中继」三条腿试，墙内站先直连，省掉一次必然失败的握手。
- 群里只发压缩后的 magnet：`magnet:?xt=urn:btih:<hash>&dn=≤40字`，几十个 tracker 全删——原样贴一条 1500 字的长 magnet 等于刷屏。
- 实测：`进击的巨人` 25.9 秒 → **6.06 秒**，`孤独摇滚` 34.3 秒 → **6.02 秒**；能出 AniBT 真 magnet（7.9GB / 4.8GB）与蜜柑的 `.torrent`。

## 四、顺手修的老 bug：`.torrent` 算出来的 infohash 是错的

`magnetFromTorrent()` 的 bencode 扫描原来把 `i12345e` 这种整数当成字符串读飞，位子算错 → 真实 `.torrent` 换算出来的 magnet 指向一个不存在的种子（发出去就是死链）。改成正经的 `skipBencode()`：字典/列表/整数/字符串分开跳。这次是测试逼出来的，不是猜的。

## 五、升级与验证

- 三处版本号已同步为 `1.1.9-preview.1`（`plugin/dsh-qq-whale/package.json`、`desktop/MollyDesktop.csproj`、`tools/console-server.mjs` 的 `FALLBACK_VERSION`）。
- 测试：`tools/test-anime-find.mjs` **30 过 / 0 挂**（离线）、`test-sing-oom.mjs` **17 过 / 0 挂**；引用/分条/去重/记忆那些老套件无回归。
- 生效方式：**重启一次 DSH 宿主**（`lib/engine.js`、`lib/main.js` 的改动不是热加载的）。
- 群验：发 `#搜番 进击的巨人` 看条目 + 磁力；或直接问「进击的巨人好看吗」看她自己有没有调 `anime_find`。

## 六、其它（不在插件代码里）

- 外置盘 G: 那台 WD My Passport 自 11-13 起反复掉盘（NTFS Event 140 / `0xc0000006`），已上 `D:\MollyGuard` 守护：每分钟探「盘 / DSH / 语音」三通道，出事推 PushPlus。那是运维脚本，不进仓库。
