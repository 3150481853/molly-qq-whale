# Molly 控制台——打包与部署

本文覆盖三件事：**构建 exe**、**本机怎么用**、**搬到服务器怎么部署**。

对应产物：

| 文件 | 说明 |
| --- | --- |
| `dist/molly-console.exe` | 单文件服务端（Node SEA，89.4 MB / 93,779,456 字节，build `bc57e48c`，带三态启动器） |
| `dist/console.example.json` | 配置模板，改名为 `console.json` 使用 |
| `dist/console/` | 前端三件套（`index.html`、`console.js`、`console.css`）**不打进 exe**，构建时快照进来 |
| `tools/build-exe.mjs` | 构建脚本 |
| `tools/console-server.mjs` | exe 的源文件（ESM，改动后重新构建） |

> `dist/` 整个目录可直接搬走：拷过去、加一个 `console.json`、双击 exe，就完事。

---

## 1. 构建

```powershell
$node = '${HOME}\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node ${WORKSPACE}\qq-whale\tools\build-exe.mjs
```

脚本做这些事（**不需要 npm**，自己去 registry 拉 postject，解到 `dist/_build/pkg/` 用完即弃）：

1. 把 `tools/console-server.mjs` 的 5 行 `import ... from 'node:x'` 机械改写成 `require('node:x')`，生成 `dist/_build/console-sea.cjs`。**源文件不改**，`node tools/console-server.mjs` 仍按 ESM 跑。
2. `node --check` 自检转换结果。
3. `--experimental-sea-config` 生成 blob。
4. 复制当前 node.exe（89 MB）作为宿主。
5. postject 注入 blob。
6. **冒烟测试**：跑 `molly-console.exe --version`，非 0 就整体失败——不会给你一个坏 exe。

参数：

- `--keep` 保留 `dist/_build/`（排错用）
- `--offline` 不联网（要求 `dist/_build/pkg/node_modules/postject` 已就绪）

构建时长约 10–20 秒（大头是下载 postject 1.3 MB + 复制 89 MB node.exe）。

### 为什么是 SEA，不是 pkg

- pkg 已停止维护，且不支持 Node 24；SEA 是 Node 官方方案。
- Node 24.21 **没有** `--build-sea`（实测 `bad option`），最后一步注入仍需 postject。
- 注入后 postject 必报 `warning: The signature seems corrupted!`——这是因为往已签名的 node.exe 尾部追加了数据。**不影响运行**，但首次运行可能触发 SmartScreen「未知发布者」，点「仍要运行」即可。要去掉就买代码签名证书，属工程外开销，没做。

### ESM 限制（重要）

SEA 的入口当前**只按 CommonJS 执行**。在 `sea-config.json` 里写 `"mainFormat": "module"` 会被**静默忽略**，然后运行时报 `Cannot use import statement outside a module`。

所以 `console-server.mjs` 必须保持「只有裸 import，没有 export / import.meta / 动态 import」的形态。`build-exe.mjs` 的 `toCjs()` 会检查这一点：一旦源文件里出现它不认识的 ESM 语法，**构建直接失败并列出行号**，不会悄悄产出坏 exe。以后要加模块，要么继续用 `require` 风格的 ESM import，要么扩展 `toCjs()`。

---

## 2. 配置

三层优先级：**环境变量 > `console.json` > 内置默认值**。

配置文件查找顺序：

1. 环境变量 `MOLLY_CONSOLE_CONFIG` 指定的路径
2. `<exe 所在目录>\console.json`

文件不存在、或 JSON 写错，都**不阻断启动**，退回默认值继续跑（会在 `--version` 里标 `(不存在，用默认值)`）。

### 全部键 / 环境变量对照

| `console.json` 键 | 环境变量 | 默认值 |
| --- | --- | --- |
| `host` | `MOLLY_CONSOLE_HOST` | `127.0.0.1` |
| `port` | `MOLLY_CONSOLE_PORT` | `19392` |
| `token` | `MOLLY_CONSOLE_TOKEN` | 空（不校验） |
| `consoleDir` | `MOLLY_CONSOLE_DIR` | `<exe目录>\console` |
| `pluginBase` | `MOLLY_PLUGIN_BASE` | 空（启动时自动探测） |
| `sidecar` | `MOLLY_SIDECAR` | `http://127.0.0.1:19391` |
| `napcat` | `MOLLY_NAPCAT` | `http://127.0.0.1:6099` |
| `root` | `MOLLY_ROOT` | 本机工作区 `...\qq-whale` |
| `dataDir` | `MOLLY_DATA_DIR` | `${HOME}\.dsh\qq-whale` |
| `outDir` | `MOLLY_OUT_DIR` | `<root>\out` |
| `nodeExe` | `MOLLY_NODE_EXE` | 本机 node 全路径 |

两点说明：

- `pluginBase` 两种写法都收：`http://127.0.0.1:7053` 或 `http://127.0.0.1:7053/dsh-qq-whale`（后者会自动剥掉后缀）。留空时会扫 7000–9000 端口找宿主，**只在本机有意义**。
- `token` 非空时，**所有**请求必须带 `x-molly-token` 头，否则 401。本机自用留空即可；**放到服务器上必须设**。

---

## 3. 本机用法

```powershell
dist\molly-console.exe            # 前台跑
dist\molly-console.exe --version  # 打印生效的路径和配置来源，排错先看这个
dist\molly-console.exe --help     # 全部参数与当前生效值
```

从 `dist/` 直接跑时，默认值就指向当前工作区，不用写 `console.json`。

### `dist/` 目录长什么样

```
dist/
├── molly-console.exe       ← 双击这个
├── console.json            ← 首次构建自动生成，之后构建不会覆盖你的修改
├── console.example.json    ← 模板（带注释的完整说明），想看全部键就查它
└── console/                ← 前端三件套，exe 运行时按此目录加载
    ├── index.html
    ├── console.js
    └── console.css
```

`console/` 是**构建时快照**：改了 `qq-whale/console/` 下的文件后，重新构建才会同步到 `dist/console/`。本机开发时 `dist/molly-console.exe` 默认读的就是 `dist/console/`，改了源目录不会自动生效——要么重新构建，要么直接用 `node tools/console-server.mjs`（后者读 `qq-whale/console/`，改完刷新页面即可）。

想要「双击即用」有两条路，都行，**别同时用**（服务只有一份，端口会撞）：

| 方式 | 跑什么 | 什么时候用 |
| --- | --- | --- |
| 双击 `dist\molly-console.exe` | exe 自带的三态启动（见下节） | 只想要成品，不折腾源码。已经起了会自动开窗，不会抢端口 |
| 双击 `qq-whale\console.cmd` | `tools\start-console.ps1` 管 node 进程 + 19392 | 在开发机上，改了 `tools/console-server.mjs` 想立刻生效（exe 要重新构建） |

`console.cmd` 认的是**源码路径**，exe 认的是 `dist\console\` 快照——两者读的前端目录不同，这是它们最主要的区别。

### 双击 exe 会发生什么（三种情况）

exe 启动时会先探测端口（端口来自 `console.json` 的 `port`，或环境变量 `MOLLY_CONSOLE_PORT`，默认 19392），**不会闷头抢端口，也不会杀任何进程**：

| 情况 | 判断依据 | 行为 | 退出码 |
| --- | --- | --- | --- |
| **① 端口空闲** | TCP 连不上 | 正常起服务，打印三行启动日志 | 一直跑到被关掉 |
| **② 端口已被 Molly 占着** | `GET /api/health` 返回 200 且 `ok:true` 且有 `version` 字段 | 打印 `控制台已经在运行：http://127.0.0.1:19392/（本次不再启动，直接给你开窗口）`，用 Edge 的 `--app=` 开一个独立窗口（复用 `out\edge-console-profile` 这个 profile） | **0** |
| **③ 端口被别的程序占着** | health 不通，或通了但没有 `version` 字段 | 打印 `端口 19392 被别的程序占了（pid=xxx，见控制台）` + 占用者进程名 + 换端口的两种办法 | **1** |

三点的补充说明：

- **情况 ② 是幂等的**：双击多少次都只是把那个窗口叫到前面，不会起第二个服务、不会抢端口，19392 上原来那个进程的 pid 不变。如果这个 profile 里已经有同 URL 的 app 窗口，Edge 会**复用并聚焦**已有窗口而不是再开一个——这是预期行为，不是没生效。
- **情况 ② 会多等约 1.5 秒才退出**（`OPEN_SETTLE_MS = 1500`）。这是必须的：实测父进程 spawn 完立刻 `process.exit` 的话，Edge 的新 app 窗口根本起不来（进程被提前回收，新增窗口 0 个）；等 1.2 秒以上才稳定出窗口。别把这段延时当 bug 优化掉。
- **情况 ③ 用的是 `console.json` 的绝对路径**（SEA 模式下读的是 exe 同级的 `console.json`），提示里直接给出该文件路径，照着改 `port`，或临时 `set MOLLY_CONSOLE_PORT=19400` 再双击。

三态都能用 `--version` 之外的方式单独验证，最快的办法是换端口跑一遍：

```powershell
# 情况 ①（空端口）
$env:MOLLY_CONSOLE_PORT=19395; .\dist\molly-console.exe
# 情况 ②（19392 已经在跑，再双击一个）
.\dist\molly-console.exe
# 情况 ③（先拿别的程序占住一个端口）
node -e "require('http').createServer((q,s)=>s.end('x')).listen(19394)" &
$env:MOLLY_CONSOLE_PORT=19394; .\dist\molly-console.exe
```

从命令行跑时，情况 ②③ 结束后会 `按回车键关闭窗口…` 等最多 30 秒（**只有在交互式 TTY 下才等**；被 `Start-Process` 重定向、被计划任务拉起、被管道接走时 stdin 不是 TTY，会立刻退出，不会挂住自动化脚本）。

---

## 4. 部署到服务器

### 4.1 核心结论：**控制台服务端可以搬，插件动作不能搬**

这一点必须先说清楚，否则搬完会发现一半按钮是坏的。

控制台是**代理层**：它自己不存数据，25 个动作全部转给别的进程执行。分三类：

| 动作 | 实际执行者 | 能不能搬到服务器 |
| --- | --- | --- |
| `memory/*`、`stickers/*`（8 个） | DSH 宿主里的 dsh-qq-whale 插件 | ❌ 数据在 DSH 那台机的 `~/.dsh/qq-whale/` |
| `memory/pending`、`memory/pending/approve`、`memory/pending/reject`（3 个） | 同上（待核实区） | ❌ |
| `plugin/*`（6 个） | 同上 | ❌ |
| `napcat/*`、`process/start-napcat`（3 个） | NapCat（跑 QQ 的那台机） | ❌ |
| `watchdog/*`（5 个） | 本机 `tools/watchdog.mjs` + Windows 计划任务 | ❌ |
| `/api/health`、`/api/overview`、`/api/logs`、`/api/memory`、`/api/stickers`、静态页面 | 服务端自己 | ✅ |

合计 8 + 3 + 6 + 3 + 5 = 25 个动作，其中 **24 个必须留在本机**，只有 `/api/*` 里那几个只读聚合和静态页面能搬。

所以现实的做法是两种：

**方案 A（推荐）：服务端仍在本机，只把 nginx 挡在前面**
外网 → nginx（服务器）→ 反向代理回本机 19392（需要内网穿透 / 专线 / 或干脆不对外）。适合「我在外面想看一眼」。

**方案 B：把 exe 放服务器，只当只读看板**
`/api/overview` 等纯读接口需要 `pluginBase`/`sidecar` 能打到本机——除非有内网连通，否则它们会显示 `reachable: false`。**前端页面、`/api/health` 可以正常工作**。适合「只要一个能打开的页面」。

> ⚠️ **注意：光有内网连通还不够。**
> 插件侧的 HTTP 路由有 Host 白名单（`lib/web.js` 的 `isTrustedRequest`），**只接受回环地址**。实测（`node:http` 直发，`Host` 头可伪造）：
>
> | 请求的 Host | `/dsh-qq-whale/state` | `/dsh-qq-whale/memory/list` |
> | --- | --- | --- |
> | `127.0.0.1:7053` | 200 | 200 |
> | `localhost:7053` | 200 | 200 |
> | `<REDACTED>:7053` | **403** | **403** |
> | `<REDACTED>:7053` | **403** | **403** |
> | `console.example.com` | **403** | **403** |
> | `molly.example.com:7053` | **403** | **403** |
>
> 另外两个横向对照也都是 403：内网 Host + 匹配的 `Origin`、回环 Host + 外站 `Origin`、回环 Host + `Sec-Fetch-Site: cross-site`。
>
> 所以把 `pluginBase` 写成内网 IP，网络是通的也一样全部 403。
> **console-server 必须和 DSH 宿主跑在同一台机器上**，跨机只能靠本机反代（方案 A）。
>
> 复现脚本：`qq-whale\out\_t-host-gate.mjs`（只发 GET，15 条断言）。

要真正把增删改搬到服务器，前提是把 DSH 插件和 NapCat 一起搬过去——那是另一件事，不在本文范围。

### 4.2 服务器上的最小部署

```bash
# 目录结构（exe + 前端 + 配置，三个都不能少）
/opt/molly/
├── molly-console.exe       # 注意：Windows exe，Linux 服务器跑不了
├── console/
│   ├── index.html
│   ├── console.js
│   └── console.css
└── console.json
```

> ⚠️ **平台限制**：SEA 产物就是「被注入的 node.exe」，是 **Windows x64 可执行文件**。要部署到 Linux 服务器，必须**在 Linux 上用 Linux 版 node 重新构建一次**（`build-exe.mjs` 是跨平台的，`process.execPath` 取的是构建机的 node）。不要直接把 Windows 的 exe 拷到 Linux。

`console.json`（服务器示例）：

```json
{
  "host": "127.0.0.1",
  "port": 19392,
  "token": "换成你自己的长随机串",
  "pluginBase": "",
  "consoleDir": "/opt/molly/console"
}
```

`host` 填 `127.0.0.1` 是故意的：**让 nginx 反代，不让 exe 直接对外**。

`pluginBase` 留**空串**也是故意的。原因见 4.1 的注意框：插件只接受回环 Host，填内网 IP 会被 403。
留空时 console-server 会自己去 7053 探宿主；探不到就退化成「插件不可达」，页面本身照常打开。**不要**在这里填 `http://<内网IP>:7053`，那是最容易犯、且症状最迷惑的错（页面能开、数据全空、动作全 403）。

启动（systemd）：

```ini
# /etc/systemd/system/molly-console.service
[Unit]
Description=Molly Console
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/molly
ExecStart=/opt/molly/molly-console
Restart=on-failure
RestartSec=5
# 配置走文件，不在这里塞 token（env 会被 ps 看到）
Environment=MOLLY_CONSOLE_HOST=127.0.0.1

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now molly-console
sudo systemctl status molly-console
```

### 4.3 nginx 反向代理

```nginx
server {
    listen 443 ssl http2;
    server_name molly.example.com;

    ssl_certificate     /etc/letsencrypt/live/molly.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/molly.example.com/privkey.pem;

    # 表情包上传：exe 侧上限 12 MB（请求体），nginx 必须给够，
    # 否则会被 nginx 先拒掉并返回一个 exe 根本看不到的 413。
    client_max_body_size 16m;

    location / {
        proxy_pass http://127.0.0.1:19392;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # /api/overview 内部要串行探测插件 + sidecar + napcat + watchdog，
        # 冷启动实测约 1.5 秒，留足余量。
        proxy_read_timeout 60s;
    }
}
```

**关于 `x-molly-token`**：

exe 的 token 校验只是「防误触 / 防扫描器」级别，不是用户体系。上了公网建议两层：

1. nginx 层加 Basic Auth 或 IP 白名单（真正的边界）
2. exe 层设 `console.json` 的 `token`（纵深防御）

如果坚持用 header 方案，前端需要在每个请求上带 `x-molly-token`。当前 `console.js` **没有**读取 token 的能力，所以要对外暴露的话二选一：

- 用 nginx 注入：`proxy_set_header x-molly-token "你的token";`（这样 token 不出服务器，最省事）
- 或者 exe 侧留空 `token`，完全靠 nginx 的 Basic Auth 拦

> 推荐前者：`console.json` 里设 token，nginx 里用 `proxy_set_header` 注入，浏览器侧完全无感，也不需要改前端。

### 4.4 防火墙

```bash
# 只开 443，19392 只监听回环（host=127.0.0.1 已保证）
sudo ufw allow 443/tcp
sudo ufw deny 19392/tcp
```

---

## 5. 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 网页 503，日志有「找不到前端入口」 | `console/` 没放对位置。看 `--version` 里的 `consoleDir`，或用 `console.json` 的 `consoleDir` 指过去 |
| 页面能开但全是 `reachable: false` | exe 打不到插件 / sidecar / NapCat。检查 `pluginBase` 和网络连通性 |
| 页面能开、数据全空、**动作全 403** | `pluginBase` 填了**非回环**地址（如内网 IP）。插件只接受 `127.0.0.1` / `localhost` 的 Host，别的 Host 一律 403。把 `pluginBase` 留空，让服务自己探 7053（见 4.1） |
| 所有请求 401 | `console.json` 里设了 `token` 但请求没带 `x-molly-token` |
| 双击后窗口闪一下就没、服务也没起 | 分三种：**exit 0 + 「控制台已经在运行」** = 已有一个在跑，这是正常的（见第 3 节三态）；**exit 1 + 「端口被别的程序占了」** = 换端口；**exit 1 + 「启动失败：…」** = 其它错误，看后面的消息 |
| 明明没开控制台，双击却说「已经在运行」 | `/api/health` 能被别的服务冒充不太可能，但先 `curl http://127.0.0.1:19392/api/health` 看一眼返回的 `version` 是不是 `1.0.0`；确认是别人占的，就按第 3 节情况 ③ 换端口 |
| 上传表情包报 413 | nginx 的 `client_max_body_size` 太小；exe 侧上限 12 MB |
| 首次运行被 SmartScreen 拦 | 签名被 postject 破坏了，点「更多信息 → 仍要运行」 |
| 改了前端不生效 | 前端是**运行时**从 `consoleDir` 读的，不用重新打包，但浏览器有缓存——`consoleBuild()` 用 mtime+size 算 8 位哈希附在 `index.html` 的资源 URL 上，正常刷新就能拿到新的；顽固的话 Ctrl+F5 |

---

## 6. 改代码后重新构建

```powershell
# 1. 改 tools/console-server.mjs（保持只有裸 import）
# 2. 语法检查
& $node --check D:\...\qq-whale\tools\console-server.mjs
# 3. 重新打包（会自动做冒烟测试）
& $node D:\...\qq-whale\tools\build-exe.mjs
```

前端改动**不用**重新打包，直接替换 `console/` 下的文件即可。

---

## 7. 实测记录（2026-10-19）

**构建可复现**：连续三次独立构建（含一次删干净 `dist/` 从零开始），产物字节数完全一致 `93,767,168`，sha256 完全一致：

```
<REDACTED>
```

> 上面这组是 **20:24 之前那版**（前端快照 `dfc879f9`）的数据，旧 exe 已备份为 `dist/molly-console.exe.bak-20261019-2023`。
>
> **20:24 重新打包（前端定稿 `bc57e48c`）**：`93,770,240` 字节（比旧版 +3,072 B），sha256 `<REDACTED>`。体积只涨 3 KB，因为 `console/` 是**运行时按目录加载**、不打进 exe（见第 1 节）；涨的 3 KB 全部来自 `console-server.mjs` 那 3 个待核实区动作。

**换目录实测（把整个 `dist/` 拷走）**：模拟用户真实操作——`Copy-Item dist → %TEMP%\molly-ship`（5 个文件），只加一个 `console.json`，不设任何 `MOLLY_*` 环境变量：

| 检查项 | 结果 |
| --- | --- |
| `molly-console.exe --version` | exit 0，`consoleDir`/`config` 均指向新目录，`molly-console 1.0.0 (sea)` |
| `GET /api/health` | 200 `{"ok":true,"version":"1.0.0","build":"dfc879f9",...}`（那次构建的前端快照是 `dfc879f9`；当前产物已重打为 `bc57e48c`，见下） |
| `GET /api/overview` | 200 **12961 B**，`plugin.link.state=online`、`plugin.link.ready=true`、`plugin.bot=Molly / 111111111`、`plugin.model=deepseek-v4.1-flash`、`plugin.memory.count=73`、`sidecar.reachable=true`、`napcat.isLogin=true`、`watchdog.taskEnabled=true` |
| `GET /` `/console.js` `/console.css` | 全 200（11178 / 88922 / 25203 B） |
| `GET /api/memory` | 200 7976 B |

**配置层**：

- `console.json` 生效（`pluginBase` 故意写成带 `/dsh-qq-whale` 后缀，验证自动剥离），无环境变量参与
- token 鉴权：无 token → 401，错 token → 401，对 token → 200，日志不含 token 明文（166 字符）
- 缺前端目录（只拷 exe）：打印 5 行中文指引说明往哪放，`/` → 503，但 `/api/health` 仍 200（能诊断）

**开发模式未被破坏**：构建脚本只在 `dist/_build/` 里生成 CJS 副本，源文件 `tools/console-server.mjs` 保持 6 行裸 `import`、零 `require(`、零 `import.meta`；`node --check` exit 0；现役 19392 的 node 实例仍 200 / `link=online`。

**受保护目标全程无损**：DSH 宿主 pid 68520 ALIVE、QQ.exe 4 个、NapCat 1 个、19391/19392/7053 各 1 个监听。

### 7.1 重新打包（20:24，前端定稿后）

前端三件套在 19:46-20:17 之间被反复改（`console.js` 87,409 → 103,018 B），旧 exe 里嵌的是 19:46 的旧快照。20:24 重新打了一次：

| 项 | 旧 | 新 |
| --- | --- | --- |
| 字节 | 93,767,168 | **93,770,240**（+3,072 B） |
| sha256 | `f5b08bbd…` | `ccb405bc…` |
| 前端快照 build | `dfc879f9` | **`bc57e48c`**（= 现役 19392） |
| 备份 | `dist/molly-console.exe.bak-20261019-2023` | `dist/molly-console.exe` |

换端口自检（`MOLLY_CONSOLE_PORT=19393`，不碰用户正在用的 19392，自检完进程已关、端口已释放）：

| 检查项 | 结果 |
| --- | --- |
| 冷启动到 `/api/health` 200 | **452 ms** |
| `build` | `bc57e48c` ✅ 与现役一致 |
| `__MOLLY_BUILD__` / 静态资源 `?v=` / health / overview | 四者全是 `bc57e48c` |
| `GET /` `/console.js` `/console.css` | 200（12362 / 103018 / 28494 B） |
| `GET /api/overview` | 200 13607 B，`link=online`、`bot=Molly`、`model=deepseek-v4.1-flash`、`memory.count=75`、`learner.memory={"added":0,"rejected":0,"pending":0,"dup":0,"queued":6}`、`sidecar.reachable=true`、`napcat.isLogin=true` |
| 动作数 | `data.available` = **25**（含待核实区 3 条） |
| `memory/pending` | 200 `count=6` |
| `approve` 无 confirm | 409 |
| `approve` 不存在 id | 404 |
| 关掉 exe 后 19393 | 0 监听 ✅ 已释放 |
| 19392 未受影响 | pid 37528 仍是旧进程，200 |

> **一个重要坑**：`/api/health` 的 `build` 只由 `console/console.js` + `console.css` 的 `mtime:size` 决定，**与 `console-server.mjs` 无关**。所以「改完后端、build 没变」是正常的；判断后端改动有没有生效，要看 `data.available` 的动作数，不要看 build。
>
> 反过来，`fs.copyFileSync` **会保留 mtime**（实测差 0 ms），所以 `dist/console/` 快照的 build 才会和源目录算出来的完全一致——这是重新打包能对上 `bc57e48c` 的前提。

### 7.2 三态启动器（20:48，exe 已重打）

`console-server.mjs` 的启动段改成了三态探测（见第 3 节「双击 exe 会发生什么」）。旧 exe 已备份为 `dist/molly-console.exe.bak-20261019-2048`。

| 项 | 旧（20:24 版） | 新（20:48 版） |
| --- | --- | --- |
| 字节 | 93,770,240 | **93,779,456**（+9,216 B） |
| sha256 | `ccb405bc…` | `<REDACTED>` |
| 前端快照 build | `bc57e48c` | **`bc57e48c`**（没动前端，应该不变 ✅） |

涨的 9 KB 全是启动器代码（`net` 探端口、`netstat` 取 pid、`tasklist` 取进程名、找 Edge/Chrome、`--app` 开窗、`pauseIfInteractive`）——`console/` 仍不打进 exe。

三态实测（用 `spawnSync` 直接取 `status`，`Start-Process -PassThru` 的 `.ExitCode` 在进程已退出后可能读到空值，不可靠）：

| 情况 | 端口 | exit | 用时 | 关键输出 |
| --- | --- | --- | --- | --- |
| ① 空闲 | 19395 | —（常驻） | 到 health 200 = **310 ms** | `build=bc57e48c` ✅ |
| ② 已被 Molly 占 | 19392 | **0** | 1906 ms | `控制台已经在运行：http://127.0.0.1:19392/（本次不再启动，直接给你开窗口）` + `[console] 已用 msedge.exe 打开独立窗口（pid=37908）` |
| ③ 被非 Molly 占 | 19394（哑服务，返回 `{"ok":true,"hello":"not-molly"}` 无 `version`） | **1** | 1238 ms | 三行：`端口 19394 被别的程序占了（pid=77232，见控制台）` / `[console] 占用者进程：node.exe` / `[console] 换个端口：改 …\dist\console.json 的 port，或设环境变量 MOLLY_CONSOLE_PORT` |

三种情况共同验证到的：

- **19392 的 pid 37528 全程存活**，监听数始终为 1，没有被杀也没被重启。
- **情况 ③ 的哑进程活得好好的**（判断完就退，没碰占用者）。
- **情况 ② 真的开出了新窗口**：`EnumWindows` 枚举可见顶层窗口，`*Molly*` 标题的窗口数从 1 变 2（新 hwnd `43849310`，pid 53000 是已预热的 Edge 主进程）。测试开的窗口已用 `WM_CLOSE` 关掉，用户原生窗口 `hwnd=7279820` 保留。
- **情况 ② 的 1.5 秒延时是必需品**，实测对照：父进程 spawn 完立刻 `process.exit` → 新增窗口 **0**；等 1200 ms → 新增窗口 **1**；`detached:true` + 立刻退 → 新增窗口 **0**（detached 不是解药）。这条写死在 `OPEN_SETTLE_MS` 常量上，注释里有数据，别当性能问题优化掉。

一个环境细节：三态 ② 若该 profile 里**已经有**同 URL 的 app 窗口，Edge 会复用/聚焦它而不是再开一个。所以「窗口数没变」不代表没生效，要结合退出码和 stdout 判断。

