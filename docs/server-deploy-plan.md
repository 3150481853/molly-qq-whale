# 服务器部署方案（域名已备案 · 等 443 放行后收口）

> 状态：~~搁置（2026-10-19 21:35「域名还没下来，先暂时搁置」）~~ → **2026-10-21 example.asia 备案通过，域名 80 通路已实测可用**；唯一卡点是安全组 **443/TCP 未放行**（HTTPS 收口条件）。
> 已投给服务器 DSH 的留言 #10（A 站点域名化 / B Caddy 域名块 / C 先签证书不跳转 / D 443 安全组 / E relayBase 收口），结论回填在 `STATE.md` 第 3 节「域名备案通过与服务器沟通」。
> 本文只记录已经查实的事实和域名到位后的执行清单，避免下次从零推演。
> 相关章节：手册 `## 8.az`（控制台 exe 与「什么能搬服务器」）。

## 1. 已查实的事实

### 1.1 服务器

| 项 | 值 |
|---|---|
| 公网 IP | **<REDACTED>**（2026-10-21 实测校正；旧值 <REDACTED> 是另一台 Ubuntu/nginx，80、443 开着但 `/molly/health` 404，别再拿它当中继） |
| 系统 | **Windows** |
| 已装 | DSH（但**没接入网关**） |
| 用途 | 用户写代码也在上面，**需要能调到网关** |
| 从家宽 `Test-Connection` | ping 不通（ICMP 被挡）；但 **80 端口可达**，`/molly/health` 200 |
| 端口实测（10-21 对 .68 复测） | **80 开 / 443 关 / 3389 开 / 22 关 / 7000 关 / 8788 关**；旧记录「80/443 开、3389 关」是误记 <REDACTED>（Ubuntu/nginx）那台 |

> 现状：**80 开、443 关**。备案已过，80 上可走 HTTP-01 签证书（不用 DNS-01、不用 Cloudflare）；但 443 未放行前不能开 80→443 跳转，否则整站打不开。443 放行即收口。

### 1.2 家里的网关（`${GATEWAY_DIR}`）

- 进程：`${HOME}\.workbuddy\binaries\python\versions\3.13.12\pythonw.exe "${GATEWAY_DIR}\wb_proxy.py" --port 8788`
- `GET /health` 实测（2026-10-19）：

```json
{"ok":true,"realm":"cn","accounts":5,"accounts_ready":5,
 "api_key_required":false,
 "uid":"0712488d-5643-4a27-9afc-e9e4c64bd226",
 "domain":"www.codebuddy.cn"}
```

- `GET /v1/usage` → 401 `panel password required`（面板密码 `admin`）
- 项目自带：`Dockerfile`、`docker-compose.yml`、`quick-deploy.sh`、`start-wb-proxy-lan.*`、`wb_atrest.py`（at-rest 凭据解密）、`wb_fingerprint.py`、`wb_ipintel.py`、`wb_egress.py`、`wb_realm_guard.py`、按账号绑定出口代理
- 远程客户端接入手册原文（`README.md:261-274`）：用配置器 CLI，在**客户端所在机器**跑
  ```
  curl -fsSL http://<网关>:8788/agents/cli -o wb_agents.py
  python wb_agents.py apply --client dsh --base-url https://gw.域名/v1 --key sk-xxxx
  ```

## 2. 目标架构：服务器做「展示 + 中转」，PC 做「执行」

```
手机 / 服务器上的 DSH
      │ HTTPS
      ▼
 Caddy（服务器 :443，自动证书）
   ├── molly.域名   → 服务器本机 19392 的 /watch 只读页（心跳存在服务器）
   ├── console.域名 → 127.0.0.1:18788 ──frp──┐
   └── gw.域名      → 127.0.0.1:18788 ──frp──┤
                                             │ 家里 PC 主动连出，
                                             │ 家宽不开任何端口
                        家里 PC ◄────────────┘
                          ├ 19392 控制台
                          └ 8788 网关 ──出站── 腾讯（IP 仍是家宽）
```

| 子域名 | 指向 | 用途 |
|---|---|---|
| `molly.` | 服务器本机 | 手机看状态；PC 死了也能看 + 收到 PushPlus 告警 |
| `console.` | frp → 家里 19392 | 完整控制台（记忆/表情包增删改、待核实 approve/reject） |
| `gw.` | frp → 家里 8788 | 服务器 DSH、手机、笔记本调网关 |

### 为什么网关不搬服务器

1. **风控**：上游会看设备指纹/IP（项目自己就有 `wb_fingerprint.py` / `wb_ipintel.py`）。frp 进来，**真正出站仍是家宽**，风险不变。
2. **凭据**：token 在盘上是加密的（`wb_atrest.py` 解），密钥来自本机 WorkBuddy 的 `loggerGet()` ⇒ **拷不过去**，服务器上只能走 Web 登录重新认证。
3. **单点**：搬上去后服务器抖一下 Molly 立刻哑，而且人在外面修不了。

**什么时候才该搬**：当「服务器 7×24 独立用网关」比「Molly 稳定」更重要时。那时要做的是 Web 登录重新认证 + 绑定出口代理规避机房 IP。

## 3. 安全红线（暴露公网前必须做）

1. 网关当前 `api_key_required: false` ⇒ **任何人可无密钥调用**。必须用 `--lan` 模式重启（生成 API Key 写进 `accounts/settings.json`），DSH 侧填 key。
2. 面板密码默认 `admin`，必须改；**公网禁用 `?pwd=`**（README 原话：会留在浏览器历史与反代日志）。
3. 公网只暴露 `/v1` 和只读页；`/panel` 不给外网。
4. 手机页 `molly.` 保持只读；写操作只放 `console.`（带 `MOLLY_CONSOLE_TOKEN`）。
5. frps 端要点：`token`、只允许指定端口、`allow_ports` 收窄。

## 4. 域名到位后的执行清单

### Step 1 · 服务器侧（不需要改插件，零风险）

- [ ] 装 Caddy（Windows 服务）
- [ ] 把 `qq-whale\dist\molly-console.exe` + `console.json` 拷到服务器
- [ ] **开发 `/watch`（手机自适应只读页）+ `/api/ingest`（收心跳）+ 心跳落盘 + 超时告警** ← 唯一还没写的代码
- [ ] Caddy 反代三站点，`molly.` 指本机 19392

### Step 2 · PC 侧

- [ ] 开发心跳推送器（node，60 秒一次，POST 到 `https://molly.域名/api/ingest`，带 token）
  - 载荷：`link.state`、`bot`、`lastReplyAt`、今日积分、待核实条数、watchdog 状态、memory/sticker 计数
- [ ] 挂进计划任务，跟 watchdog 一起拉起
- [ ] frpc 常驻（`gw` + `console` 两条隧道）

### Step 3 · 网关对外

- [ ] 网关改 `--lan` 重启，取 API Key
- [ ] Caddy `gw.域名` 反代 `127.0.0.1:18788`
- [ ] 服务器 DSH 配远端网关：`python wb_agents.py apply --client dsh --base-url https://gw.域名/v1 --key sk-xxxx`
- [ ] 家里 DSH 保持 `127.0.0.1:8788` 不变（本地优先，远端只给服务器用）

## 5. 待开发清单（三块任务，域名到后可立刻派）

1. **服务器侧只读监控**：`/watch` 页 + `/api/ingest` + 心跳存储 + 死信告警（PushPlus）
2. **PC 侧心跳推送器** + 计划任务
3. **部署材料**：Caddy 配置 + frp 两端配置 + 照着能跑的部署文档

## 6. 回滚

全部是新增，回滚 = 停 Caddy + 删 frpc + 删 exe 目录。**不动网关、不动插件、不动 QQ**，所以对这轮已上线的功能零影响。
