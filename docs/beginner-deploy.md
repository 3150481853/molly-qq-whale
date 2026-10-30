# 新手部署（Windows）：AI 代装 / 手动照抄两版

> 这份教程给**完全没装过**的人用。全程中文，只有 4 个软件：**Node.js → SnowLuma → QQ → DeepSeek Harness（DSH）**，最后装 Molly 插件。
>
> **先定一条硬规矩：所有下载、解压、配置、数据都放进同一个「工作区」文件夹，不要往桌面、下载、文档、C 盘用户目录里乱放。** 本教程统一用 `D:\Molly` 举例，你可以换成别的盘，但一旦选定就不要再改。

---

## 0. 先看这一页（3 分钟）

### 0.1 你需要提前准备什么

| 要准备 | 具体是什么 | 现在就要有吗 |
|---|---|---|
| Windows 10/11 电脑 | 64 位，能正常装软件 | 是 |
| 管理员权限 | 安装 Node、启动 SnowLuma 要用 | 是 |
| QQ 小号 | 专门给 Molly 用，**不要拿主号试** | 是 |
| QQ 小号的密码 | 登录时你自己输入，**不要发给 AI** | 是 |
| 模型 API | `baseURL`（到 `/v1` 为止）+ `API Key` + 模型名（如 `deepseek-chat`） | 是 |
| 工作区路径 | 例：`D:\Molly`（建议英文、无空格、不要放 OneDrive） | 是 |
| 磁盘空间 | 至少 5 GB 空闲 | 是 |
| 时间 | 30–60 分钟，第一次装建议留 1 小时 | 是 |

**先想清楚这三件事：**

1. **QQ 小号**：Molly 登录的是小号，你用主号私聊她。
2. **模型 API**：Molly 自己不产生智能，所有回复都要调用模型。没有 API，装完只会报错。
3. **预算**：每聊一句都在烧 token，几十块起步很常见。预算紧就先只跑私聊，别拉群。

### 0.2 工作区怎么放（最重要的一条）

以 `D:\Molly` 为例，最终目录应该长这样：

```
D:\Molly\
├─ downloads\              ← 所有安装包、zip 都放这里
├─ SnowLuma\               ← 解压 SnowLuma
├─ molly-qq-whale\         ← 解压/下载 Molly 仓库
├─ data\                   ← Molly 的记忆、表情包、作息等数据
│  └─ qq-whale\
├─ work\                   ← Molly 的工作沙箱
├─ logs\                   ← 需要自己留的日志
└─ DEPLOY-INFO.md          ← 装完后的部署记录（AI 路线自动生成）
```

**规则：**

- 下载的东西先放 `D:\Molly\downloads\`，解压到上面列出的对应目录；
- **不要**把 SnowLuma 解压到桌面、下载文件夹、`C:\Program Files`、OneDrive 同步目录；
- **不要**把 Molly 的数据放到仓库的 `.git` 里，也不要提交到 GitHub；
- 只有两类东西可以不在工作区：
  1. **Node.js 程序本体**：安装器默认在 `C:\Program Files\nodejs`；想全放工作区，可以在安装时改成 `D:\Molly\apps\nodejs`（保持 Add to PATH）；
  2. **DSH 程序本体和插件目录**：DSH 的配置固定在 `%USERPROFILE%\.dsh\`，插件必须装进它的 `node_modules`，这是 DSH 的规定，搬不走。下载的源文件仍然放工作区。

### 0.3 两条路线，只选一条

| 路线 | 适合谁 | 你要做什么 | 风险 |
|---|---|---|---|
| **A. AI 代装** | 没碰过命令行、想让 AI 一步步带 | 把第 1 部分的提示词发给 AI，按它说的点「继续」 | AI 可能跳步；提示词里已经写了硬性约束 |
| **B. 手动部署** | 想自己掌控每一步、或 AI 装到一半卡住 | 从第 2 部分开始，照着命令复制 | 容易抄错路径/缩进，按「看到什么算成功」逐条核对 |

> 两条路线**不要同时做**。AI 装到一半卡住，可以切到手动路线，但要先把已经装的东西记下来，避免重复安装（见第 4 部分「装错了怎么办」）。

---

## 第一部分：AI 部署（把提示词复制给 AI）

### 1.1 先让 AI 做「施工前清单」

把下面整段复制给你的 AI（DSH、ChatGPT、Claude 都行；要能读写本机文件、执行 PowerShell 的 AI 最好）：

```text
你是我的 Windows 部署助手。目标：在这台 Windows 10/11 上部署 molly-qq-whale
（https://github.com/3150481853/molly-qq-whale），接入我的 QQ 小号。

硬性规则，必须遵守：
1. 全程用中文跟我说话。
2. 工作区固定为 D:\Molly。所有下载、解压、配置、数据、日志都放在这个工作区里；
   只有 Node.js 程序本体、DSH 程序本体和 DSH 插件目录可以按软件默认位置放，
   其他任何地方都不要写。每做一步都告诉我实际写到了哪个目录。
3. 动手之前先给我一份「施工前清单」，至少包含：
   - 要装/下载的软件清单，以及每个软件的官方下载地址；
   - 需要我提前准备的东西：QQ 小号、QQ 密码、模型 API 的 baseURL / key / 模型名；
   - 需要我做的交互：扫码登录、设 SnowLuma 密码、在 DSH 里填 API；
   - 预计耗时、会占多少磁盘。
   清单发完后停下来，等我说「继续」再开始，不要自己一口气装完。
4. 每一步开始前先说：这一步要做什么、要下载什么、会改哪个文件、成功后看到什么；
   等我说「继续」再执行。遇到需要下载的东西，先给官方地址，不要自己猜。
5. 不要向我索要 QQ 密码、API Key 的明文，也不要把它们写进聊天记录、
   命令历史或任何会提交到 GitHub 的文件。需要输入时让我自己在本机输入。
6. 先把仓库下载/解压到 D:\Molly\molly-qq-whale，完整读一遍
   D:\Molly\molly-qq-whale\docs\beginner-deploy.md 的「手动部署」部分，
   按里面的目录和配置来；不要自己发明路径。
7. 装完后生成 D:\Molly\DEPLOY-INFO.md，写清楚：
   - 每个软件的实际安装根目录；
   - 我以后要维护什么、怎么维护；
   - 所有本机网址和接口（127.0.0.1 的那些）；
   - 密码/令牌在哪里设置、忘了怎么重置。
   注意：不要写密码、API Key、OneBot Token 的明文。
8. 如果遇到 CMD 每 10~15 秒弹一次、端口被占、重复安装、插件不加载，
   先停下来做只读诊断，把证据列给我，不要用「再装一遍」覆盖。
9. 不要改我的系统代理、hosts、防火墙，不要装来源不明的软件。
10. 每完成一个阶段，给我一句「现在到哪了、下一步是什么」。
```

### 1.2 AI 应该先回你什么

正常情况下，AI 第一轮只应该回一份清单，而不是直接开始下载。清单里必须包含：

- Node.js 的官方下载地址（`https://nodejs.org/zh-cn/download`，要 **24 LTS**，不是 22）；
- SnowLuma 的官方发布页地址（它不随本仓库附带）；
- 你的模型 API 需要准备的 `baseURL` / `key` / 模型名；
- 需要你亲手做的三件事：QQ 扫码、设 SnowLuma WebUI 密码、在 DSH 里填 API；
- 最终目录树（应该和第 0.2 节一致）。

**如果 AI 没有给清单就开始装，直接回它：**「先停下来，按提示词第 3 条给我施工前清单，等我确认再动手。」

### 1.3 AI 部署的验收标准

装完后，让 AI 把下面这些逐条跑给你看，缺一条都不算完成：

| 验收项 | 应该看到什么 |
|---|---|
| Node 版本 | `node -v` 输出 `v24.22.x` 及以上（24 系列），或 `v26.12.x` 及以上 |
| SnowLuma 端口 | `netstat -ano \| findstr 3001` 有 `LISTENING` |
| SnowLuma WebUI | 浏览器能打开 `http://127.0.0.1:5099` |
| DSH 启动 | DSH 主界面能进，插件没有加载失败 |
| 插件存在 | `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-qq-whale\lib\boot.js` 存在 |
| 插件状态 | `http://127.0.0.1:<DSH 端口>/dsh-qq-whale/state` 返回 JSON，`enabled` 为 `true` |
| 收发消息 | 主号私聊小号说「在吗」，几秒内收到回复 |
| 部署记录 | `D:\Molly\DEPLOY-INFO.md` 已生成，且不含密码/密钥 |

### 1.4 AI 部署完成后，你手里应该有的东西

让 AI 把下面这张表填好发给你（同时写进 `DEPLOY-INFO.md`）：

| 项目 | 实际值 |
|---|---|
| 工作区 | `D:\Molly`（或你选的实际路径） |
| Node.js 根目录 | 例：`C:\Program Files\nodejs` 或 `D:\Molly\apps\nodejs` |
| SnowLuma 根目录 | 例：`D:\Molly\SnowLuma` |
| Molly 仓库根目录 | 例：`D:\Molly\molly-qq-whale` |
| 插件安装目录 | `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-qq-whale` |
| DSH 配置 | `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` |
| Molly 数据 | `D:\Molly\data` |
| SnowLuma WebUI | `http://127.0.0.1:5099`，密码是你第一次设的那个 |
| DSH Web UI | `http://127.0.0.1:4739`（端口以 DSH 设置为准） |
| Molly 控制台 | `http://127.0.0.1:19392`（需要启动控制台才有） |
| OneBot HTTP / WS | `http://127.0.0.1:3000` / `ws://127.0.0.1:3001`，Token 在 `onebot.json` 里 |

---

## 第二部分：手动部署（照着抄）

> 下面每一步都写了「放哪里、点什么、看到什么算成功」。**不要跳步**，尤其不要跳过 2.2 的首次启动。

### 2.1 建工作区

1. 打开「此电脑」，选一个空间足够的盘（例：`D:`）；
2. 新建文件夹 `D:\Molly`；
3. 在 `D:\Molly` 里再建 `downloads`、`data`、`work`、`logs` 四个文件夹。

也可以在 PowerShell 里一次建好：

```powershell
New-Item -ItemType Directory -Force 'D:\Molly\downloads','D:\Molly\data','D:\Molly\work','D:\Molly\logs' | Out-Null
```

### 2.2 装 Node.js

**为什么必须装：** SnowLuma 是用 Node.js 跑的，没有 Node 它起不来。

1. 打开 <https://nodejs.org/zh-cn/download>
2. 选 **LTS** 那一栏的 **Windows 安装包 (.msi)**，下载到 `D:\Molly\downloads\`
3. 双击安装：
   - 想简单：一路「下一步」，默认装到 `C:\Program Files\nodejs\`；
   - 想全放工作区：在安装器里把路径改成 `D:\Molly\apps\nodejs`，并保持 **Add to PATH** 勾选；
   - 两种都可以，**记住你选的是哪个**，后面排查要用。
4. 装完**重新打开**一个 cmd 或 PowerShell 窗口（旧窗口不认新命令）。

**版本要求：** SnowLuma 2.x 只认两个区间：**Node 24.22.1 及以上的 24.x**，或 **Node 26.12.1 及以上**。Node 22、Node 25 都不行（会直接看到）：

```
error: SnowLuma requires Node.js ^24.22.1 || >=26.12.1; found v22.x.x
```

→ 回官网下 **24 LTS** 重装。

**验证：**

```powershell
node -v
```

看到 `v24.22.x` 或更高的 24.x → 成功；如果装成 `v25.x`，回官网换回 24 LTS 重装。

> 出错了怎么办：
> - 报「不是内部或外部命令」→ 安装时没勾 PATH，重装一次并保持默认选项；
> - 装完要**重新打开**窗口才认新命令。

### 2.3 装 SnowLuma（QQ 的「翻译器」）

SnowLuma 负责两件事：**登录你的 QQ**、把 QQ 消息转成插件能读的 OneBot 11 格式。

#### 2.3.1 解压

把 `SnowLuma-v2.x.x-win-x64.zip` 解压到 **`D:\Molly\SnowLuma`**。

解压完打开目录，**先看有没有 `config\onebot.json`**：

- **有** → 可以直接往下走，但仍然建议先按 2.3.2 启动一次，确认 SnowLuma 本身能跑；
- **没有** → 不要慌，也不要自己去网上找配置文件，**先按 2.3.2 启动一次**，让 SnowLuma 自己生成。

正常目录大致是：

```
D:\Molly\SnowLuma\
├─ launcher.bat      ← 之后双击的就是它（别人说的「la」就是 launcher）
├─ index.mjs
├─ node.exe
├─ check-node-version.cjs
├─ client\           ← WebUI 页面
├─ config\           ← 配置都在这里
├─ native\
└─ logs\
```

> 如果解压后没有 `config\onebot.json`，这是正常的：SnowLuma 第一次启动时才生成。**很多人卡在这里，以为下载坏了。**

#### 2.3.2 先启动一次，生成配置

1. **右键** `D:\Molly\SnowLuma\launcher.bat` → **以管理员身份运行**；
2. 会弹出一个黑色窗口，等它打印出 WebUI 地址（一般是 `http://127.0.0.1:5099`）；
3. 浏览器打开 `http://127.0.0.1:5099`：
   - 第一次会让你设 **WebUI 密码**，设一个你记得住的，记在密码管理器里；
   - 如果启动窗口打印了一串随机初始密码，就用那串登录，进去后立刻改成自己的；
4. 看到 WebUI 登录页/主界面后，**把 SnowLuma 完全关掉**：
   - 关掉黑色窗口；
   - 打开任务管理器 → 详细信息 → 找到命令行里带 `SnowLuma` 的 `node.exe`，结束它（**不要**结束别的 node 进程）；
5. 回到 `D:\Molly\SnowLuma\config\`，这时应该出现 `onebot.json`。

> 如果第二次启动后仍然没有 `onebot.json`：
> - 看 `D:\Molly\SnowLuma\logs\` 里最新的日志，确认 SnowLuma 是真的启动成功，而不是一闪就退；
> - 仍然没有，就手动新建 `D:\Molly\SnowLuma\config\onebot.json`，内容用 2.3.3 的模板（SnowLuma 能读）。

#### 2.3.3 改 `config\onebot.json`

用记事本打开 **`D:\Molly\SnowLuma\config\onebot.json`**，把**整个文件**替换成：

```json
{
  "networks": {
    "httpServers": [
      {
        "name": "http-local",
        "enabled": true,
        "host": "127.0.0.1",
        "port": 3000,
        "accessToken": "换成你自己的一串密码",
        "messageFormat": "array",
        "reportSelfMessage": true
      }
    ],
    "httpClients": [],
    "wsServers": [
      {
        "name": "dsh-qq-whale",
        "enabled": true,
        "host": "127.0.0.1",
        "port": 3001,
        "role": "Universal",
        "accessToken": "换成你自己的一串密码",
        "messageFormat": "array",
        "reportSelfMessage": true
      }
    ],
    "wsClients": []
  },
  "musicSignUrl": ""
}
```

要点：

- 两处 `accessToken` **必须写成同一串**（例：`molly-2026-change-me`，别用中文和空格）；
- `3001` 是插件要连的 WebSocket 地址：`ws://127.0.0.1:3001`；
- `3000` 是 HTTP 端口，用来探活；
- 这两个端口都只绑 `127.0.0.1`，**不要改成 0.0.0.0 暴露到公网**。

#### 2.3.4 正式启动并登录 QQ

1. 再次**右键** `launcher.bat` → **以管理员身份运行**；
2. 不要关黑窗口（关掉 = SnowLuma 停了）；
3. 浏览器打开 `http://127.0.0.1:5099`，用刚才设的密码登录；
4. 打开 QQ → 按 SnowLuma 提示扫码 → 用**小号**登录；
5. 验证端口：

```powershell
netstat -ano | findstr 3001
```

看到 `LISTENING` 那一行 → 成功。

> 出错了怎么办：
> - **双击后黑框一闪就没** → Node 没装好或版本太低，回 2.2；
> - **QQ 没弹扫码 / WebUI 显示未连接** → 用管理员身份重开 `launcher.bat`；
> - **改了 `onebot.json` 不生效** → 完全退出 SnowLuma（黑窗口 + 任务管理器里的残留 node）再启动；
> - **启动后 CMD 每 10~15 秒弹一次** → 见第 4 部分，先别重装。

### 2.4 装 DSH 和 Molly 插件

#### 2.4.1 装 DSH

去 DSH 官方渠道安装 **DeepSeek Harness 桌面版**：

- 安装器允许改路径时，建议装到 `D:\Molly\apps\DSH`；
- 不允许改就用默认路径，但要记下实际装到了哪里；
- 装完先打开一次，确认能进主界面。

#### 2.4.2 下载/解压 Molly 仓库

1. 打开 <https://github.com/3150481853/molly-qq-whale>；
2. 点「Code → Download ZIP」，把 zip 放到 `D:\Molly\downloads\`；
3. 解压到 `D:\Molly\molly-qq-whale`（最终要能看到 `D:\Molly\molly-qq-whale\plugin\dsh-qq-whale`）。

#### 2.4.3 装插件

**方式 A：手动复制（推荐，下载内容都在工作区）**

在 PowerShell 里执行：

```powershell
# 先把旧插件备份掉，避免覆盖后出现嵌套目录
$dst = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-qq-whale"
if (Test-Path $dst) {
  Rename-Item $dst "$dst.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
}

# 从工作区复制插件到 DSH 的插件目录
Copy-Item 'D:\Molly\molly-qq-whale\plugin\dsh-qq-whale' `
  "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\" -Recurse -Force
```

确认两个关键文件存在：

```powershell
Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-qq-whale\lib\boot.js"
Test-Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-qq-whale\cordis.patch.yml"
```

两个都输出 `True` 才算成功。少任何一个，插件会被 DSH **静默跳过**（不报错、也没反应）。

**方式 B：一条命令（可选）**

```powershell
dsh plugin --profile desktop add "github:3150481853/molly-qq-whale#path:/plugin/dsh-qq-whale"
```

这条命令会把插件下载到 DSH 自己的目录；如果你要严格把下载物放工作区，用方式 A。

### 2.5 写配置（最容易错的一步）

#### 2.5.1 找到配置文件

按 `Win + R` → 输入 `%USERPROFILE%` → 回车 → 依次进入：

```
.dsh\profiles\desktop\cordis.patch.yml
```

完整路径形如 `${HOME}\.dsh\profiles\desktop\cordis.patch.yml`。

**先备份**：复制一份，命名 `cordis.patch.yml.bak-日期`。

#### 2.5.2 追加配置

用记事本或 VSCode 打开，把下面这段**追加到文件最末尾**：

```yaml
- insert:
    - id: dsh-qq-whale
      name: 'dsh-qq-whale'
      config:
        selfId: '你的小号QQ号'
        ownerUin: '你自己的QQ号'
        admUins: ['你自己的QQ号']
        commanderUsers: ['你自己的QQ号']
        commandEnabled: true
        commandPrefixes: ['命令 ']
        modelBackend: dsh
        provider: '你的provider名'
        model: '你的模型名'
        dataDir: 'D:/Molly/data'
        workSandboxDir: 'D:/Molly/work'
        memoryDir: 'D:/Molly/data/qq-whale/memory'
        stickerDir: 'D:/Molly/data/qq-whale/stickers'
        personaDir: 'D:/Molly/molly-qq-whale/plugin/dsh-qq-whale/persona'
        onebot:
          ws: 'ws://127.0.0.1:3001'
          token: '<REDACTED>'
```

**要改的只有这几处：**

| 字段 | 填什么 | 示例 |
|---|---|---|
| `selfId` | 机器人小号的 QQ 号 | `123456789` |
| `ownerUin` / `admUins` / `commanderUsers` | 你自己的 QQ 号（谁能指挥她） | `987654321` |
| `provider` / `model` | 见 2.6 | `deepseek` / `deepseek-chat` |
| `dataDir` 等路径 | 你的工作区实际路径 | `D:/Molly/data` |
| `personaDir` | 仓库里人设目录 | `D:/Molly/molly-qq-whale/plugin/dsh-qq-whale/persona` |
| `onebot.token` | 和 2.3.3 里一模一样 | `molly-2026-change-me` |

格式要求（错了会启动失败）：

- **缩进只能用空格**，不能用 Tab；
- 冒号后面要有一个空格；
- 路径用 `/` 或 `\\`，不要写单个 `\`；
- 这是 YAML，多行内容别乱加引号。

#### 2.5.3 建好数据目录

```powershell
New-Item -ItemType Directory -Force `
  'D:\Molly\data\qq-whale\memory',`
  'D:\Molly\data\qq-whale\stickers',`
  'D:\Molly\work' | Out-Null
```

### 2.6 接上模型（二选一）

#### A. 用你自己的 OpenAI 兼容接口（推荐）

先在 DSH 里把 provider 配好：**DSH 设置 → 模型 / Provider → 新增**，填：

- `baseURL`：写到 `/v1` 为止，例如 `https://api.deepseek.com/v1`；
- `API Key`：你的 key；
- 模型名：例如 `deepseek-chat`；
- 给这个 provider 起一个名字，例如 `deepseek`。

然后插件配置里写：

```yaml
        modelBackend: dsh
        provider: 'deepseek'          # 你在 DSH 里给这个 provider 起的名字
        model: 'deepseek-chat'        # 模型 id
```

**baseURL 示例：**

- DeepSeek 官方：`https://api.deepseek.com/v1`
- 你自己的中转站：`https://你的中转站域名/v1`

#### B. 用 WorkBuddy 桌面端的免费额度

```yaml
        modelBackend: wbai
```

前提：电脑上装了 WorkBuddy 桌面端并已登录（默认路径 `<REDACTED>\WorkBuddy\WorkBuddy.exe`），否则会报「未找到 WorkBuddy 桌面端程序」。

> 模型没接上，后面全是白装。先在 DSH 里单独测一下 provider 能不能出字，再继续。

### 2.7 启动与验收

1. **完全退出 DSH**（右下角托盘图标 → 退出），再重新打开；
2. 确认 SnowLuma 还在跑（黑窗口还在、QQ 显示在线）；
3. 用你的**主号**私聊小号，发「在吗」；
4. 她应该过几秒回你（会像真人一样先「正在输入」一会儿）。

**没反应时按顺序查：**

1. SnowLuma 还在跑吗？`netstat -ano | findstr 3001` 有 `LISTENING` 吗？
2. 配置里的 token 和 `D:\Molly\SnowLuma\config\onebot.json` 里的一致吗？
3. DSH 里插件加载了吗？浏览器打开：

```
http://127.0.0.1:4739/dsh-qq-whale/state
```

能返回 JSON 且 `enabled` 为 `true`，说明插件活着；打不开或 404，回 2.4.3 检查那两个文件。

> DSH 的端口不一定是 4739：以 DSH 设置里显示的「本地服务 / Web UI」端口为准；本机换过端口时，把上面的 4739 换成实际端口。

### 2.8 启动 Molly 控制台（可选）

控制台能看状态、改开关、看聊天记录：

```powershell
cd 'D:\Molly\molly-qq-whale'
node tools\console-server.mjs
```

然后打开 `http://127.0.0.1:19392`。

- 默认**没有密码**，但只监听本机；
- 如果设置了环境变量 `MOLLY_CONSOLE_TOKEN`，请求需要带 `x-molly-token`；
- **不要**把 19392 映射到公网。

---

## 第三部分：所有网址、密码、接口（装完对照）

### 3.1 本机网址与密码

| 名称 | 地址 | 密码/登录方式 | 说明 |
|---|---|---|---|
| SnowLuma WebUI | `http://127.0.0.1:5099` | 你第一次打开时设的密码 | 看 QQ 在线状态、扫码、改 OneBot 配置 |
| DSH Web UI | `http://127.0.0.1:4739`（默认，实际端口以 DSH 设置/启动日志为准，每次启动可能不同） | 默认无密码 | 只管本机，不要暴露公网 |
| Molly 控制台 | `http://127.0.0.1:19392` | 默认无密码；设了 `MOLLY_CONSOLE_TOKEN` 才要令牌 | 需要先启动 `node tools\console-server.mjs` |
| OneBot HTTP | `http://127.0.0.1:3000` | `onebot.json` 里的 `accessToken` | 探活/调试用 |
| OneBot WebSocket | `ws://127.0.0.1:3001` | 同上 | Molly 插件连这个 |

**SnowLuma WebUI 密码忘了怎么办：**

1. 完全退出 SnowLuma（黑窗口 + 任务管理器里命令行带 `SnowLuma` 的 `node.exe`）；
2. 把 `D:\Molly\SnowLuma\config\webui.json` 改名备份，例如 `webui.json.bak-日期`；
3. 重新以管理员身份运行 `launcher.bat`；
4. 启动窗口会打印一串新的随机初始密码，用它登录，然后进设置改成你自己的；
5. 不要删 `config\onebot.json`，那是 QQ 接口配置，和 WebUI 密码无关。

**OneBot Token 忘了怎么办：**

打开 `D:\Molly\SnowLuma\config\onebot.json`，两处 `accessToken` 就是；插件配置里的 `onebot.token` 必须和它完全一致。

### 3.2 所有部署相关接口

| 接口 | 用途 | 要不要鉴权 |
|---|---|---|
| `http://127.0.0.1:<DSH 端口>/dsh-qq-whale/state` | 插件状态总览（`enabled` / `link` / `memory` / 失败列表） | 无 |
| `http://127.0.0.1:<DSH 端口>/dsh-qq-whale/sleep` | 作息窗口（`GET` 读，`POST` 写） | 无 |
| `http://127.0.0.1:19392/api/health` | 控制台健康检查（版本号） | 默认无 |
| `http://127.0.0.1:19392/api/overview` | 插件/记忆/预算总览 | 默认无 |
| `http://127.0.0.1:19392/api/logs?source=plugin&tail=200` | 看日志（`source` 可为 `plugin` / `watchdog` / `console` / `napcat` / `heartbeat`） | 默认无 |
| `http://127.0.0.1:19392/api/memory` | 记忆列表/检索 | 默认无 |
| `http://127.0.0.1:19392/api/stickers` | 表情包列表 | 默认无 |
| `http://127.0.0.1:19392/api/sleep` | 控制台代理的作息接口 | 默认无 |
| `http://127.0.0.1:19392/api/jasmine/tokens?days=7` | 茉莉花记忆系统的 token 账本（如果启用了 jasmine） | 默认无 |
| `https://api.deepseek.com/v1/chat/completions` | 模型 API（示例；以你的服务商为准） | `Authorization: Bearer <API Key>` |

> 3000 / 3001 / 19392 都只绑 `127.0.0.1`，是**本机接口**。要远程访问，自己加内网穿透/反向代理，并先加鉴权；不要直接把端口映射到公网。

### 3.3 每个软件装在哪、以后维护什么

| 软件/组件 | 安装或存放根目录 | 你以后要维护什么 | 怎么维护 |
|---|---|---|---|
| Node.js | `C:\Program Files\nodejs` 或 `D:\Molly\apps\nodejs` | 版本（24.22.1+ 的 24.x，或 26.12.1+） | 官网下新的 24 LTS 覆盖安装；`node -v` 验证 |
| SnowLuma | `D:\Molly\SnowLuma` | `config\`（OneBot/WebUI 密码）、QQ 登录、`logs\` | 改配置后重启；升级时保留 `config\` 和 `data\`，替换程序文件 |
| DSH | 安装时选的目录（建议 `D:\Molly\apps\DSH`） | 程序本体、模型 provider | DSH 内更新；配置在 `%USERPROFILE%\.dsh` |
| Molly 仓库 | `D:\Molly\molly-qq-whale` | 人设、文档、控制台前端 | 下载新版本替换代码；`data` 不要放仓库里 |
| Molly 插件 | `%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-qq-whale` | 不要手改；从工作区复制更新 | 重新复制整个文件夹；先备份旧目录 |
| Molly 数据 | `D:\Molly\data` | 记忆、表情包、作息、关系 | 定期备份整个目录；删记忆 = 让她失忆 |
| DSH 配置 | `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` | 插件配置、路径、token | 改前备份；YAML 缩进用空格 |
| SnowLuma 日志 | `D:\Molly\SnowLuma\logs` | 启动失败、端口冲突 | 出问题先看最新日志 |
| 部署记录 | `D:\Molly\DEPLOY-INFO.md` | 实际路径、网址、维护说明 | 装完就写；不要写密码/Key 明文 |

---

## 第四部分：装错了怎么办（重装/卸载/CMD 闪框）

### 4.1 先分清「装错」还是「装重了」

**装错的典型症状：**

- 插件目录里没有 `lib\boot.js` 或 `cordis.patch.yml`；
- `cordis.patch.yml` 缩进错、YAML 解析失败；
- 路径写成了 `D:\molly-qq-whale`，但实际解压到了 `D:\Molly\molly-qq-whale`；
- `onebot.token` 和 `onebot.json` 不一致；
- DSH 里 provider 名字和配置里不一致。

**装重的典型症状：**

- CMD 黑框每 10~15 秒弹一次；
- 任务管理器里有多个 `node.exe` 都在跑 SnowLuma；
- 两个不同目录各有一份 `SnowLuma` / `launcher.bat`；
- 开机后自动弹出黑框，但你并没有双击任何东西。

### 4.2 不要直接「再装一遍」

重装前先做三件事：

1. **备份**：把 `D:\Molly\data` 和 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml` 复制到 `D:\Molly\backup-日期\`；
2. **退出**：DSH 托盘退出；SnowLuma 关黑窗口，并在任务管理器结束命令行带 `SnowLuma` 的 `node.exe`（不要结束别的 node）；
3. **查重**：在 PowerShell 里只读检查，不要急着删：

```powershell
# 看还有哪些相关进程（只读）
Get-CimInstance Win32_Process |
  Where-Object { $_.CommandLine -match 'SnowLuma|launcher\.bat|dsh-qq-whale|molly-qq-whale' } |
  Select-Object ProcessId, Name, CommandLine | Format-List

# 看有没有相关计划任务（只读）
Get-ScheduledTask |
  Where-Object { $_.TaskName -match 'Molly|SnowLuma' } |
  Select-Object TaskName, State
```

如果看到两份不同目录的 `launcher.bat`，或者两个 `node.exe` 都在跑 SnowLuma，**先只保留一份**，另一份改名备份，不要直接删数据。

### 4.3 彻底重来（保留数据）

1. 按 4.2 退出所有相关进程；
2. 备份 `D:\Molly\data` 和 `cordis.patch.yml`；
3. 把旧插件目录改名：`node_modules\dsh-qq-whale` → `dsh-qq-whale.bak-日期`；
4. 从 `cordis.patch.yml` 里删掉旧的 `- insert:` 那一段（或恢复备份）；
5. 把 SnowLuma 旧目录改名 `SnowLuma.bak-日期`，重新解压一份到 `D:\Molly\SnowLuma`；
6. 按第 2 部分从 2.3 重新做；
7. 成功后再删除 `.bak` 目录，避免以后误启动旧副本。

> **不要删** `D:\Molly\data`，除非你确定不要记忆和表情包了。

### 4.4 CMD 每 10~15 秒弹一次

这类问题**通常不是 Molly 本身**，而是重复安装、重复启动项或别的软件在轮询。先让 AI 只读诊断，不要直接重装：

```text
我的 Windows 上 CMD 黑框每 10~15 秒自动弹一次，可能和 SnowLuma / DSH / Molly 的重复安装有关。
请先只读诊断：列出所有相关进程的完整命令行、相关计划任务、启动项、以及重复的安装目录；
把证据列给我，等我确认后再删。不要结束无关进程，不要改系统设置。
```

常见原因：

- 同一份 SnowLuma 被解压到两个目录，两个 `launcher.bat` 都在开机启动；
- 旧版本卸载不干净，计划任务/启动项还指向已经不存在的目录；
- 某个硬件/手机助手类软件每几秒调用一次 `tasklist`（这类不是 Molly，排查时看命令行）。

确认是重复项后，**只删除你确认过的那一个**，保留正在用的那一份；不确定就把命令行和目录发出来再问。

---

## 第五部分：常见问题速查

| 现象 | 多半是 | 怎么修 |
|---|---|---|
| 双击 `launcher.bat` 黑框一闪就没 | Node 没装/版本低 | 装 Node 24 LTS，`node -v` 确认 |
| 解压后没有 `config\onebot.json` | 还没首次启动 | 按 2.3.2 启动一次再关闭，配置会生成 |
| 启动后 CMD 每 10~15 秒弹一次 | 重复安装/启动项 | 按 4.4 只读诊断，别重装 |
| SnowLuma 起不来，日志报 `EADDRINUSE` | 3000/3001 被占 | `netstat -ano \| findstr 3001` 找到进程，确认后结束 |
| QQ 扫码后 SnowLuma 显示未连接 | 权限不够 | 右键 `launcher.bat` → 以管理员身份运行 |
| 插件路由 404、完全没反应 | 插件被静默跳过 | 检查 `node_modules\dsh-qq-whale\` 里有没有 `lib\boot.js` 和 `cordis.patch.yml` |
| 收到消息但不回 | token 不一致 / 模型挂 | 对齐 token；DSH 里单独测 provider 能不能出字 |
| 报 `401` | key 错，或 baseURL 少了 `/v1` | 补全 `https://.../v1` |
| 报 `404 model not found` | 模型名写错 | 用服务商给的准确 id |
| 回复里出现「我发了张图」但没有图 | 表情包目录空 | 往 `stickerDir` 里放几张图，或重新启动 |
| 改了配置不生效 | 没重启对应程序 | SnowLuma 改完要重启；DSH 改完要完全退出再开 |
| 控制台 19392 打不开 | 没启动控制台 | `cd D:\Molly\molly-qq-whale`，`node tools\console-server.mjs` |

---

## 第六部分：装完之后

- **人设**：`D:\Molly\molly-qq-whale\plugin\dsh-qq-whale\persona\core.md` —— 决定她是什么性格，改完重启 DSH；
- **记忆**：`D:\Molly\data\qq-whale\memory\` —— 删掉就等于让她失忆，先备份；
- **表情包**：`D:\Molly\data\qq-whale\stickers\` —— 放图片进去，她会按标签挑着发；
- **控制台**：`http://127.0.0.1:19392` —— 看状态、改开关、看记忆；
- **排错文档**：`docs/INSTALL-AND-ROLLBACK.md`（排错与回滚）、`docs/deploy.md`（控制台/打包细节）；
- **部署记录**：自己维护一份 `D:\Molly\DEPLOY-INFO.md`，写清路径、网址、维护方式，**不要写密码/Key 明文**。

还是不行，就把**报错原文**和**你实际用的路径**一起贴出来——有原文才查得动。
