# 把项目上传到 GitHub（从零开始）

> 这份文档假设你**从没用过 Git**，Windows 系统，**访问 github.com 不稳定**。
> 照着做，每一步都有「怎么确认自己做对了」。
>
> 全程**不会**让你改系统代理 —— 那条路会顺手影响别的程序。

---

## 0. 先说结论：大概要多久

| 步骤 | 时间 | 卡点概率 |
|---|---|---|
| 装 Git | 5 分钟 | 下载慢（用镜像解决） |
| 注册 GitHub + 开 2FA | 10 分钟 | **最容易卡在这**，见第 3 节 |
| 建仓库 | 2 分钟 | 低 |
| 本地提交推送 | 10 分钟 | 网络 + 认证 |
| 上传前自检 | 5 分钟 | **别跳，见第 7 节** |

---

## 1. 装 Git

### 1.1 为什么不能从官网下

`git-scm.com` 和 GitHub 的下载在部分网络环境里**直连不通**（能打开页面但下载卡住，或者干脆超时）。

所以用国内镜像。

### 1.2 从 npmmirror 下载（推荐）

打开这个地址，它会列出所有版本目录：

```
https://registry.npmmirror.com/-/binary/git-for-windows/
```

进去找最新稳定版（形如 `v2.x.y.windows.N/`），下载里面的：

```
Git-<版本>-64-bit.exe          ← 安装包，约 60~65 MB
```

完整 URL 形如（把 `<版本目录>` 和 `<安装包文件名>` 换成你在上一步目录里实际看到的）：

```
https://registry.npmmirror.com/-/binary/git-for-windows/<版本目录>/<安装包文件名>
```

举例：目录 `v2.56.windows` 里的安装包叫 `Git-64-bit.exe`（真实文件名带完整小版本号，以目录里看到的为准）。拼起来就是上面这个形状。

> 版本号会变，请以目录里实际最新的为准。

**怎么确认下载对了**：文件应该有 60 MB 左右。如果只有几百 KB，说明下到的是错误页（一个 HTML），删掉重下。

### 1.3 安装

一路「下一步」，但这几个地方注意：

- **「Adjusting your PATH environment」** 选 **`Git from the command line and also from 3rd-party software`**（默认第二项）。选错了命令行里就没有 `git` 命令；
- 换行符那一步选 **`Checkout as-is, commit Unix-style line endings`**（第二项），Windows 下也能用；
- 其它保持默认。

### 1.4 确认装好了

**关掉所有已经打开的终端**（PATH 是进程启动时读的，老窗口看不到新装的程序），开一个新的：

```powershell
git --version
```

应该输出 `git version 2.x.y.windows.N`。

如果报「无法将 git 项识别为 cmdlet」，说明 PATH 没配好：

- 先试绝对路径：`& "C:\Program Files\Git\cmd\git.exe" --version`
- 能跑 → 装好了，只是 PATH 没生效。把 `C:\Program Files\Git\cmd` 加进系统环境变量 PATH，或者直接用绝对路径。

### 1.5 一次性设好身份

Git 每次提交都要记录"谁提交的"，只需设一次：

```powershell
git config --global user.name "你的名字"
git config --global user.email "你的邮箱"
```

`user.email` **建议用你 GitHub 账号的主邮箱**，这样提交能关联到你的账号。

---

## 2. 注册 GitHub 并建仓库

### 2.1 注册

```
https://github.com/signup
```

要邮箱、用户名、密码。用户名会成为你仓库地址的一部分，**之后基本改不了**，选的时候想清楚。

### 2.2 建一个 Private 仓库

页面上右上角 `+` → **New repository**。

| 字段 | 填什么 |
|---|---|
| Repository name | 例如 `my-qq-bot`（只能字母数字 `-` `_`） |
| Description | 随便写 |
| **Visibility** | **选 `Private`** |
| Initialize this repository with | **全部不勾**（不要 README、不要 .gitignore、不要 license） |

**为什么必须选 Private**：

- 这个项目里有配置文件、可能有 token 残留；
- Public 仓库**全互联网可见**，而且**会被爬虫和搜索引擎收录**；
- 一旦公开过，即使之后改回 Private，**已经被人 fork 或缓存的内容收不回来**。

**为什么"全部不勾"**：勾了 README 会先有一个提交，你本地推的时候要先 `pull` 合并，新手最容易在这一步懵。留空仓库，本地直接推最顺。

### 2.3 拿到仓库地址

建完之后页面上有 HTTPS 地址：

```
https://github.com/<你的用户名>/<仓库名>.git
```

复制下来，第 5 节要用。

---

## 3. 两步验证（2FA）怎么办 ← **最容易卡在这**

### 3.1 为什么必须要

GitHub 从 2023 年起，**贡献代码的账号必须开 2FA**。不开的话：

- 网页能登；
- 但 `git push` 会被拒，报 `Support for password authentication was removed` 之类的错。

### 3.2 你现在卡住的症状

> 「我在手机上登的，电脑端要 6 位验证码」

这是对的 —— 你在手机上配过 2FA，所以电脑登录时要你输入手机那个 App **此刻显示的 6 位数字**。

**这个数字不在短信里，在验证器 App 里。**

### 3.3 三种拿码方式

#### 方式 A：验证器 App（TOTP）—— 最常用

手机上应该有个 App（微软 Authenticator / Google Authenticator / 1Password / Bitwarden / 或者其它），里面有一条 `GitHub` 的条目，点开就是一个**每 30 秒刷新一次的 6 位数字**。

把它输进去就行。

**关键提醒**：

- 这个数字 30 秒变一次。**看准了立刻输**，别慢慢打字；
- 手机时间必须准。手机时间错了，算出来的码永远是错的 —— 去手机设置里把「自动设置时间」打开；
- 如果你的 App 里**找不到 GitHub 这一条**，说明当初扫码时用的不是这个 App，或者那个 App 的数据没了。走方式 C。

#### 方式 B：GitHub Mobile App 推送

如果你手机装了 **GitHub 官方 App** 并登录过，电脑端登录时它会**弹一个推送**到你手机，点「批准」就行，不用输数字。

前提：手机上 GitHub App 的**通知权限**打开了。没开的话收不到推送。

#### 方式 C：恢复码（recovery codes）

当初开 2FA 时 GitHub 让你**下载过一个 .txt 文件**，里面有 10 个一次性恢复码。找到它（可能在下载文件夹、可能被你存到网盘了），用一个输进去。

**每个恢复码只能用一次**，用完划掉。

如果既没有 App、也没有推送、也没有恢复码：

- GitHub 网页上还能登（如果那个会话还有效）→ 赶紧去 **Settings → Password and authentication** 里重置 2FA 或补一个新的验证器；
- 网页也登不上 → 只能走 GitHub 账号恢复流程，要等几天。

### 3.4 换设备 / 加一个验证器

在手机 A 上的验证器已经配好了，想在电脑上也生成码？

**不行** —— TOTP 的密钥只在当初扫码时给过一次。

正确做法：GitHub → Settings → Password and authentication → **Two-factor authentication** → 那里可以**重新配置**，会给你一个新的 QR 码，用新设备扫。老设备的码会失效。

> 想同时用多台设备：在**同一次配置**里，用多台设备同时扫同一个 QR 码（或把「setup key」那串密钥手抄下来，在多台设备里手动添加）。**配好之后再想加设备，就必须重配**。

### 3.5 建议：顺手把恢复码存好

开了 2FA 之后，去：

```
Settings → Password and authentication → Recovery codes
```

确认你手上有恢复码。**没有恢复码的 2FA 账号 = 手机丢了就永久失去账号。**

存哪：打印出来、放密码管理器、或者至少放到一个和手机**不同**的设备上。别只存在手机里。

---

## 4. 先检查：这个目录该不该上传

**在做任何 `git add` 之前**，先花五分钟确认没有敏感文件。

这个项目里**绝对不能上传**的东西：

| 类型 | 例子 | 为什么 |
|---|---|---|
| 凭据文件 | `config.local.json`、`*.info` | 里面有 token / 加密凭据 |
| 运行数据 | `memory.json`、`pending.json`、`gatekeeper.json`、`relations.json` | 真实聊天记忆、真实 QQ 号 |
| 表情包目录 | `stickers/` | 文件名自带关键词（往往含真实人名/梗） |
| 人设正文 | `persona/core.md` | 写的是真实人物关系 |
| 日志/审计 | `out/`、`*.log` | 含真实 ID、路径、聊天内容 |
| 历史备份 | `*.bak-*`、`restore-points/` | 全是真实值 |
| 运行时 | `napcat/`、`node_modules/`、`dist/` | 体积大 + 含 token 的配置 |

**这份仓库应该有 `.gitignore`**，把这些排除掉。看一下根目录有没有 `.gitignore`，有就先确认里面列了上面这些。

自检命令（在仓库根目录跑）：

```powershell
git status --short
```

输出的就是**将要被提交的文件**。一条条看：

- 有没有 `memory.json`、`config.local.json`、`*.info`、`*.log`？
- 有没有 `out/`、`stickers/`、`node_modules/`？

**有就停下**，去改 `.gitignore`，然后 `git rm --cached <文件>` 把它们从暂存区移除（见 6.3 节）。

---

## 5. 五条命令

在项目根目录（有 `.gitignore` 的那一层）打开 PowerShell：

### 5.1 初始化仓库

```powershell
git init
```

**确认**：目录里出现一个隐藏的 `.git` 文件夹（`Get-ChildItem -Force` 能看到）。

### 5.2 把文件加进暂存区

```powershell
git add .
```

**确认**：

```powershell
git status --short
```

输出里应该有一堆以 `A `（added）开头的行。**这时候还没提交，还有机会后悔。**

### 5.3 提交

```powershell
git commit -m "init: 初始版本"
```

**确认**：输出里有一行 `N files changed, M insertions(+)`。

如果报 `Author identity unknown`，回到 1.5 节设 `user.name` / `user.email`。

### 5.4 关联远程仓库

```powershell
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
```

**确认**：

```powershell
git remote -v
```

应该输出两行（fetch / push），地址是你刚填的。

### 5.5 推送

```powershell
git push -u origin main
```

**第一次推送会弹一个浏览器窗口**，让你登录并授权 Git Credential Manager。**在浏览器里完成登录（含 2FA）**，然后回到终端，推送会自动继续。

推完之后：

- 终端显示 `branch 'main' set up to track 'origin/main'`；
- 去 GitHub 网页刷新，能看到文件了。

**`main` 还是 `master`**：Git 2.28+ 默认 `main`。如果你的 `git init` 建的是 `master`，把上面的 `main` 换成 `master`，或者先跑 `git branch -M main` 改名。

---

## 6. 常见错误与自救

### 6.1 `github.com:443` 连不上 / `Failed to connect`

具体表现：

```
fatal: unable to access 'https://github.com/xxx/yyy.git/':
Failed to connect to github.com port 443 after 21000 ms: Couldn't connect to server
```

**先确认是不是真连不上**：

```powershell
Test-NetConnection github.com -Port 443
```

`TcpTestSucceeded : False` 就是连不上。

**解法：给 git 单独配代理，不动系统代理。**

⚠️ **为什么不能改系统代理**：系统代理是全局的，改了会影响所有程序 —— 包括你正在跑的 QQ / 网关 / 各种守护进程。有些服务会对"来源 IP 突然变了"做风控，得不偿失。

**只让 git 走代理**（假设你的代理客户端在 `127.0.0.1:7890`，**换成你自己的端口**）：

```powershell
git config --global http.https://github.com.proxy http://127.0.0.1:7890
git config --global https.https://github.com.proxy http://127.0.0.1:7890
```

注意这几条配置**只对 github.com 生效**，其它地址不受影响。

**确认配好了**：

```powershell
git config --global --list
```

应该看到那两行。

**想撤掉**：

```powershell
git config --global --unset http.https://github.com.proxy
git config --global --unset https.https://github.com.proxy
```

**如果你没有代理**：那这条路走不通，改用 SSH（见 6.2 节），或者找一个国内可用的 Git 托管（Gitee 等）先备份着。

### 6.2 `Permission denied (publickey)`

这个错误只出现在 **SSH 地址**（`git@github.com:...`）上，HTTPS 地址不会。

**最简单的解法：改用 HTTPS。**

```powershell
git remote set-url origin https://github.com/<用户名>/<仓库名>.git
```

如果你确实想用 SSH，需要生成密钥并上传公钥：

```powershell
ssh-keygen -t ed25519 -C "你的邮箱"
```

一路回车（密码可以留空），然后把 `~\.ssh\id_ed25519.pub` 的内容整段复制，粘到 GitHub → Settings → **SSH and GPG keys** → New SSH key。

**注意**：`id_ed25519`（**没有** `.pub`）是**私钥**，永远不要发给任何人、不要提交到仓库。

### 6.3 `failed to push some refs` / `Updates were rejected`

两种完全不同的原因：

**原因一：远程有你本地没有的提交**（比如建仓库时勾了 README）

```powershell
git pull --rebase origin main
git push -u origin main
```

**原因二：你误提交了不该提交的文件**，想撤回。

```powershell
# 从暂存区移除（保留本地文件）
git rm --cached <文件>

# 如果是整个目录
git rm -r --cached out/

# 重新提交
git commit -m "chore: 移除不该提交的文件"

# 如果还没推送过，可以改写最后一个提交
git commit --amend
```

⚠️ **注意**：`git rm --cached` **只影响 git 的索引，不会删你本地文件**。

### 6.4 已经把敏感文件推上去了，怎么救

**按这个顺序，别跳步：**

#### 第 1 步（立刻）：把仓库改成 Private

GitHub → 仓库 → Settings → 最下面 **Danger Zone** → **Change visibility** → 改成 Private。

**这一步做之前不要做别的。** 公开状态下多待一分钟，被爬虫抓走的概率就多一分。

#### 第 2 步：确认泄露范围

```powershell
git log --all --oneline
git ls-files
```

`git ls-files` 列出所有被跟踪的文件 —— 确认到底哪些上去了。

#### 第 3 步：**假定这个凭据已经泄露，去换掉它**

这一步比清理 git 历史重要得多。

- token 泄露 → **去服务商后台作废它，重新发一个**；
- 密码泄露 → 改密码；
- 私钥泄露 → 重新生成一对，旧的删掉。

**清理 git 历史只是让"以后访问这个仓库的人看不到"，但已经抓走的数据你收不回来。** 所以必须换凭据。

#### 第 4 步：清理历史（可选，且有风险）

改写 git 历史要 `git filter-repo` 或 BFG，会**重写所有提交的哈希**。如果别人已经 clone 过，他们的仓库会全乱。

**如果你不确定怎么做，就别自己做。** 让懂的人帮你看，或者更省事：**删掉这个仓库，重新建一个干净的私有库，用正确的方式从第 5 节重来**。对于个人项目，这通常比重写历史快得多，也安全得多。

#### 第 5 步：加进 `.gitignore`

不管怎么处理历史，`.gitignore` 必须补上，否则下次还会传。

### 6.5 `LF will be replaced by CRLF` 警告

只是警告，不影响功能。

如果想消掉：

```powershell
git config --global core.autocrlf true
```

或者项目里放一个 `.gitattributes`：

```
* text=auto
```

---

## 7. 上传前自检清单（10 条）

**每次推之前过一遍。** 一条不过就别推。

- [ ] **1. 仓库是 Private** —— GitHub 网页 → Settings 确认。Public 的话先别推。
- [ ] **2. `git status --short` 逐条看过** —— 里面每个文件名你都认识，知道它为什么该在仓库里。
- [ ] **3. 没有 `config.local.json` / `*.info` / `*.env`** —— 这些是凭据，一个都不能进。
- [ ] **4. 没有 `memory.json` / `pending.json` / `gatekeeper.json` / `relations.json`** —— 真实记忆和审批数据。
- [ ] **5. 没有 `out/` / `*.log`** —— 日志里有完整路径、QQ 号、聊天片段。
- [ ] **6. 没有 `*.bak-*` / `restore-points/`** —— 历史备份里全是真实值。
- [ ] **7. 没有 `stickers/`** —— 表情包**文件名**本身就是关键词（往往真实到吓人）。
- [ ] **8. 没有 `persona/core.md`** —— 真实人设写的是真实的人；仓库里应该只放 `core.example.md`。
- [ ] **9.（可选）跑一次脱敏扫描** —— 如果项目里有 `tools/scan-secrets.mjs` 之类的脚本，跑一遍，把命中逐条确认。
- [ ] **10. 全局搜一遍自己的号** —— 你自己的 QQ 号、手机号、真实姓名，在仓库里搜一下，应该只在示例文件里以假数据出现。

**第 10 条的搜索方法**（在仓库根目录）：

```powershell
git grep -n "你的QQ号"
git grep -n "你的真实姓名"
```

有命中就逐个判断：是示例数据（改成假号）还是真的泄露（删）。

---

## 8. 之后怎么更新

改完文件：

```powershell
git add .
git commit -m "说明这次改了什么"
git push
```

**别用 `git add -A` 和 `git add .` 盲推** —— 每次 `git status --short` 看一眼再 add，是防止误传的唯一有效习惯。

---

## 排错

### 1. `git` 命令找不到

装是装好了，但 PATH 没生效。三个原因：

- **终端是装 Git 之前开的** —— 关掉重开。PATH 在进程启动时读取，老窗口永远看不到；
- **安装时 PATH 选项选错了** —— 重装，选「Git from the command line and also from 3rd-party software」；
- **PATH 里确实没有** —— 用绝对路径 `& "C:\Program Files\Git\cmd\git.exe" --version` 确认能跑，然后把 `C:\Program Files\Git\cmd` 加进环境变量。

**注意**：加完环境变量后，**所有已经打开的终端和程序都要重启**才能看到。

### 2. `git push` 一直卡着不动，也不报错

多半是被网络卡住但没到超时。

- 先 `Ctrl+C` 中断；
- `Test-NetConnection github.com -Port 443` 看通不通；
- 不通 → 按 6.1 节给 git 配代理（**只配 github.com，别动系统代理**）；
- 通了但还是卡 → 仓库大（比如带了 `node_modules`），先确认 `.gitignore` 生效了，`git ls-files | Measure-Object -Line` 看文件数对不对。

### 3. 每次 push 都要输密码 / 输完还是失败

两种可能：

- **输的是账号密码** —— GitHub 早在 2021 年就禁了密码认证。需要的是 **Personal Access Token**（Settings → Developer settings → Personal access tokens），或者直接走 Git Credential Manager 的浏览器授权流程（第 5.5 节的弹窗）；
- **Credential Manager 没装/没启动** —— Git for Windows 自带，重装 Git 时别取消勾选它。

走浏览器授权是最省事的：`git push` 时弹出的窗口里登录，之后 Git Credential Manager 会把凭据存到 Windows 凭据管理器，**下次不用再输**。

### 4. 电脑端登录要 6 位验证码，但我手机上收不到短信

**2FA 的 6 位码默认不是短信发的**，是验证器 App 里显示的。

- 手机上没有验证器 App → 看你当初用哪个 App 扫的码（微软 Authenticator / Google Authenticator / 1Password / Bitwarden …）；
- 找不到那条 GitHub 记录 → 走恢复码（第 3.3 节方式 C）；
- 都没有 → 网页上还能登就赶紧补一个新的验证器（第 3.4 节）；
- 网页也登不上 → 走 GitHub 账号恢复流程，要几天。

**验证码总是错误的另外两个原因**：手机时间不准（开自动时间）、30 秒过期了（重新看一眼再输）。

### 5. 推上去之后发现少了很多文件

`.gitignore` 排太多了。

```powershell
git check-ignore -v <某个没上去的文件>
```

它会告诉你**是哪一条规则**把它排掉的。改那条规则，然后 `git add` 重试。

另外注意：**空目录不会被 git 跟踪**。如果一个目录里所有文件都被 ignore 了，这个目录就不会出现在仓库里 —— 需要放一个 `.gitkeep` 占位。
