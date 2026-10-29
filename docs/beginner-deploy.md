# 新手部署：从零到她在群里开口（Windows，照着抄版）

> 这份教程假设你**什么都没装过**。每一步都写清了：要下载什么、放在哪个目录、点哪个文件、看到什么算成功、失败了怎么办。
> 全程大约 30–60 分钟，只有 4 个软件：**Node.js → SnowLuma → QQ → DeepSeek Harness（DSH）**。

---

## 0. 先看这三件事（30 秒）

1. **要有 QQ 小号**。用它当机器人，不要拿主号试（被封了很麻烦）。
2. **要有模型**。Molly 本身不会说话，她是把消息交给大模型生成回复的。没有可用的 API，装完只会报错。
3. **会花钱**。每聊一句都在烧 token，几十块起步很常见。预算紧张就先只跑私聊，别拉群。

准备好的东西：

| 要准备 | 从哪来 | 备注 |
|---|---|---|
| Windows 10/11 电脑 | —— | 教程按 Windows 写 |
| Node.js **24 LTS** | <https://nodejs.org/zh-cn/download> | 见第 1 步，**版本必须够新** |
| SnowLuma（QQ 接入框架） | 它的官方发布页，文件名形如 `SnowLuma-v2.x.x-win-x64.zip` | 本仓库**不附带**这个二进制 |
| QQ 客户端 | 你平时用的就行 | 建议专门准备一个小号 |
| 模型 API（key + 地址） | DeepSeek 官方 / 中转站 / 自建网关 | 见第 4 步的两种接法 |
| DeepSeek Harness（DSH）桌面版 | DSH 官方渠道 | 已有就跳过第 3 步 |

> 已经有 DSH、只想把 Molly 挂上去的，直接从第 2 步开始看。

---

## 1. 装 Node.js（唯一需要你手动装的环境）

**为什么必须装：** SnowLuma 是用 Node.js 跑的，没有 Node 它起不来。

1. 打开 <https://nodejs.org/zh-cn/download>
2. 选 **LTS** 那一栏的 **Windows 安装包 (.msi)**，下载后双击
3. 一路「下一步」，**不要**改安装路径（默认 `C:\Program Files\nodejs\` 就行），最后点「Install」

**版本要求：** SnowLuma 2.x 要求 **Node ≥ 24.22.1**（或 ≥ 26.12.1）。
如果你装的是 Node 22，启动时会看到这一句报错：

```
error: SnowLuma requires Node.js ^24.22.1 || >=26.12.1; found v22.x.x
```

→ 回官网下 **24 LTS** 重装一遍即可。

**验证装好了：**

1. 按 `Win + R`，输入 `cmd`，回车
2. 在黑框里输入：

```
node -v
```

3. 看到 `v24.22.x` 或更高 → 成功。

> 出错了怎么办：
> - 报「不是内部或外部命令」→ 安装时没勾 PATH，重装一次并保持默认选项；
> - 装完要**重新打开** cmd 窗口才认新命令。

---

## 2. 装 SnowLuma（QQ 的「翻译器」）

SnowLuma 负责两件事：**登录你的 QQ**、把 QQ 的消息转成插件能读的格式（OneBot 11）。

### 2.1 解压

把 `SnowLuma-v2.x.x-win-x64.zip` 解压到 **`D:\SnowLuma`**（示例；换成你自己的盘也行，但**不要放中文路径、不要放 OneDrive 同步目录**）。

解压完打开 `D:\SnowLuma`，你应该看到这些东西：

```
D:\SnowLuma\
├─ launcher.bat      ← 之后双击的就是它（别人说的「la」就是 launcher）
├─ index.mjs
├─ node.exe
├─ check-node-version.cjs
├─ client\           ← WebUI 页面
├─ config\           ← 配置都在这里
│   ├─ onebot.json   ← 第 2.2 步要改它
│   ├─ runtime.json
│   └─ webui.json
├─ native\
└─ logs\
```

### 2.2 改 `config\onebot.json`（关键一步）

用记事本打开 **`D:\SnowLuma\config\onebot.json`**，把**整个文件**替换成下面这段：

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

- 两处 `accessToken` **必须写成同一串**（随便定，比如 `molly-2026`，别用中文和空格）；
- `3001` 这个端口就是后面插件要连的地址：`ws://127.0.0.1:3001`；
- `3000` 是 HTTP 端口，用来探活，填了不亏。

### 2.3 启动 SnowLuma

1. **右键** `launcher.bat` → **以管理员身份运行**（SnowLuma 要注入 QQ，权限不够会静默失败）
2. 会弹出一个黑色窗口，别关它（关掉 = SnowLuma 停了）
3. 浏览器打开 <http://127.0.0.1:5099>，第一次会让你设一个 WebUI 密码，设完登录
4. 打开 QQ → 会弹出扫码窗口 → 用你的**小号**扫码登录

**成功的标志：**

- 黑窗口里出现日志，没有立刻退出；
- WebUI 里能看到你的 QQ 号、状态是「在线」；
- 在 cmd 里执行下面这句，`3001` 那一行显示 `LISTENING`：

```
netstat -ano | findstr 3001
```

> 出错了怎么办：
> - **双击后黑框一闪就没** → Node 没装好或版本太低，回第 1 步；
> - **QQ 没弹扫码 / WebUI 显示未连接** → 用管理员身份重开 `launcher.bat`；
> - **改了 onebot.json 不生效** → 改完要**完全退出** SnowLuma 再重新启动（关掉黑窗口 + 任务管理器里结束残留的 node.exe）。

---

## 3. 装 DSH 和 Molly 插件

### 3.1 装 DSH

去 DSH 官方渠道装 **DeepSeek Harness 桌面版**，装完先打开一次，确认能进主界面。

### 3.2 装插件（二选一）

**方式 A：一条命令（推荐）**

打开 PowerShell（`Win + R` → 输入 `powershell` → 回车），粘贴：

```powershell
dsh plugin --profile desktop add "github:3150481853/molly-qq-whale#path:/plugin/dsh-qq-whale"
```

等它跑完，看到成功提示即可。

**方式 B：手动复制（A 失败时用）**

1. 在 GitHub 下载仓库 zip 并解压，假设解压到 `D:\molly-qq-whale`；
2. 按 `Win + R`，输入 `%USERPROFILE%` 回车，进入 `...\.dsh\profiles\desktop\node_modules\`；
3. 把 `D:\molly-qq-whale\plugin\dsh-qq-whale` 整个文件夹复制进 `node_modules\`。

复制完确认这个路径存在（**必须看到 `lib\boot.js` 和 `cordis.patch.yml` 两个东西**）：

```
C:\Users\你\.dsh\profiles\desktop\node_modules\dsh-qq-whale\lib\boot.js
C:\Users\你\.dsh\profiles\desktop\node_modules\dsh-qq-whale\cordis.patch.yml
```

> 少任何一个，插件都会被 DSH **静默跳过**（不报错、也没反应）。这是最常见的坑。

---

## 4. 写配置（最容易错的一步，照抄）

### 4.1 找到文件

按 `Win + R` → 输入 `%USERPROFILE%` → 回车 → 依次进入：

```
.dsh\profiles\desktop\cordis.patch.yml
```

完整路径形如 `C:\Users\你\.dsh\profiles\desktop\cordis.patch.yml`。
**先用记事本打开，复制一份备份**（比如 `cordis.patch.yml.bak`）。

### 4.2 追加配置

用记事本（或 VSCode）打开，把下面这段**追加到文件最末尾**：

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
        dataDir: 'D:/molly-qq-whale'
        workSandboxDir: 'D:/molly-qq-work'
        memoryDir: 'D:/molly-qq-whale/data/qq-whale/memory'
        stickerDir: 'D:/molly-qq-whale/data/qq-whale/stickers'
        personaDir: 'D:/molly-qq-whale/plugin/dsh-qq-whale/persona'
        onebot:
          ws: 'ws://127.0.0.1:3001'
          token: '你刚才在 onebot.json 里填的那串密码'
```

**要改的只有这几处：**

| 字段 | 填什么 | 示例 |
|---|---|---|
| `selfId` | 机器人小号的 QQ 号 | `123456789` |
| `ownerUin` / `admUins` / `commanderUsers` | 你自己的 QQ 号（谁能指挥她） | `987654321` |
| `provider` / `model` | 见 4.3 | `deepseek` / `deepseek-chat` |
| `dataDir` 等四个目录 | 你解压仓库的位置 | `D:/molly-qq-whale` |
| `onebot.token` | 和第 2.2 步里的一模一样 | `molly-2026` |

格式要求（错了会启动失败）：

- **缩进只能用空格**，不能用 Tab；
- 冒号后面要有一个空格；
- 路径用 `/` 或 `\\`，不要写单个 `\`；
- 这个文件是 YAML，多行内容别乱加引号。

### 4.3 接上模型（两种，选一种）

**A. 用你自己的 OpenAI 兼容接口（推荐）**

先在 DSH 里把 provider 配好（DSH 设置 → 模型/Provider → 新增，填 baseURL 和 key），再让插件用它的名字：

```yaml
        modelBackend: dsh
        provider: 'deepseek'          # 你在 DSH 里给这个 provider 起的名字
        model: 'deepseek-chat'        # 模型 id
```

**baseURL 记得写到 `/v1` 为止**，例如：

- DeepSeek 官方：`https://api.deepseek.com/v1`
- 你自己的中转站：`https://你的中转站域名/v1`

**B. 用 WorkBuddy 桌面端的免费额度**

```yaml
        modelBackend: wbai
```

前提：你电脑上装了 WorkBuddy 桌面端并已登录（默认路径 `D:\APP\WorkBuddy\WorkBuddy.exe`），否则会报「未找到 WorkBuddy 桌面端程序」。

> 两种都不行？那就先别急着往下走——模型没接上，后面全是白装。

---

## 5. 启动，验收

1. **完全退出 DSH**（右下角托盘图标 → 退出），再重新打开；
2. 用你的**主号**私聊那个小号，随便说一句「在吗」；
3. 她应该过几秒回你（会像真人一样先「正在输入」一会儿）。

**没反应时按顺序查：**

1. SnowLuma 还在跑吗？（那个黑窗口还在、QQ 显示在线）
2. 配置里的 token 和 `config\onebot.json` 里的一致吗？
3. DSH 里插件加载了吗？——浏览器打开下面这个地址（端口以 DSH 设置为准，桌面版一般是 4739）：

```
http://127.0.0.1:4739/dsh-qq-whale/state
```

能返回一段 JSON 并且 `enabled` 为 `true`，说明插件活着；打不开或 404，回第 3.2 步检查那两个文件。

---

## 6. 常见问题速查

| 现象 | 多半是 | 怎么修 |
|---|---|---|
| 双击 `launcher.bat` 黑框一闪就没 | Node 没装/版本低 | 装 Node 24 LTS，`node -v` 确认 |
| SnowLuma 起不来，日志报 `EADDRINUSE` | 3000/3001 被占 | `netstat -ano \| findstr 3001` 找到进程，结束它 |
| QQ 扫码后 SnowLuma 显示未连接 | 权限不够 | 右键 `launcher.bat` → 以管理员身份运行 |
| 插件路由 404、完全没反应 | 插件被静默跳过 | 检查 `node_modules\dsh-qq-whale\` 里有没有 `lib\boot.js` 和 `cordis.patch.yml` |
| 收到消息但不回 | token 不一致 / 模型挂 | 对齐 token；DSH 里单独测一下 provider 能不能出字 |
| 报 `401` | key 错，或 baseURL 少了 `/v1` | 补全 `https://.../v1` |
| 报 `404 model not found` | 模型名写错 | 用服务商给的准确 id |
| 回复里出现「我发了张图」但没有图 | 表情包目录空 | 往 `stickerDir` 里放几张图，或重新启动 |

---

## 7. 更省事的办法：让 AI 替你装

把仓库地址丢给你的 AI（DSH 或别的都能），连下面这段一起发：

> 帮我在 Windows 上部署 `molly-qq-whale`（https://github.com/3150481853/molly-qq-whale）。
> 先完整读 `docs/beginner-deploy.md`，然后**一步一步来**：每步先说你要做什么、等我确认再做；
> 遇到要下载的东西，把官方下载地址给我，别自己猜；不要改我的系统设置。

提醒：让 AI 代装，它每一步思考也在烧 token，所以**先把模型/网关跑通再让它动手**。

---

## 8. 装完之后

- 人设：`plugin/dsh-qq-whale/persona/core.md` —— 决定她是什么性格的人，改这个文件（改完重启 DSH）；
- 记忆：默认存在 `dataDir` 下的 `data/qq-whale/memory\`，删掉就等于让她失忆；
- 表情包：放 `stickerDir` 里，她会按标签挑着发；
- 控制台（可选）：仓库里的 `console` 能看状态、改开关、看聊天记录，用法见 `docs/deploy.md`。

有问题先翻 `docs/INSTALL-AND-ROLLBACK.md`（排错与回滚），还是不行就把报错原文贴出来——**有原文才查得动**。
