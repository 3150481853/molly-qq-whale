# Molly QQ Whale

把一只「会记事的鲸鱼」接进 QQ —— 基于 DeepSeek Harness 的插件，给机器人一个稳定人设、长期记忆、表情包习惯，以及一个能看懂运行状态的控制台。

> 这是**框架**，不是某个具体角色。人设、记忆、表情包都由部署者自己写、自己长出来。
> 仓库里的 `persona/core.example.md`、`memory.example.json` 全是**结构示例**，不含任何真实个人数据。

---

## 它是什么

| 能力 | 说明 |
|---|---|
| 人设对话 | 一个 Markdown 文件就是她的人格；分段发消息、主动起话、按关系远近调整态度 |
| 长期记忆 | 从聊天里自动抽取事实/偏好/人物关系，带质量闸门，脏数据进「待核实区」等你审 |
| 表情包 | 会按语境挑图斗图；能从聊天里学新图；关键词就是文件名 |
| 查资料 | 需要事实时自己联网查，查不到就说查不到，不硬编 |
| 干活 | 群里 `命令 xxx` 交给独立的干活会话执行，产出回群 |
| 控制台 | 独立网页：运行状态、记忆增删改、表情包增删改、待核实区、执行块、日志 |
| 看门狗 | 掉线自动抢修 + 通知；带风控静默期，不硬刚 |

## 它刻意不做的事

- **不替你决定人设**：没有内置的任何「某某角色」，你觉得空就对了。
- **不越权改代码**：干活会话被限制在沙箱内，碰项目文件一律进审核队列等主人点头。
- **不上传任何数据**：所有记忆、表情包、日志都在本地。

---

## 环境要求

| 组件 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20（推荐 22/24） | 运行插件的宿主和工具脚本 |
| DeepSeek Harness | 见其文档 | 插件宿主 |
| NapCat | 最新 | 把 QQ 变成 OneBot 接口；需自行安装，本仓库不含 |
| 模型接口 | 任意 OpenAI 兼容 | 见 `docs/llm-adapter.md` |

## 三步跑起来

### 1. 装 NapCat 并登录 QQ

本仓库**不包含** NapCat。按它的官方文档装好，配好 OneBot WebSocket（默认 `ws://127.0.0.1:3001`）和 WebUI（默认 `127.0.0.1:6099`）。

### 2. 接上模型

复制 `config/config.example.json` 为 `config/config.json`，填你自己的接口地址和 key。
没有现成接口的话看 `docs/llm-adapter.md`（本地 ollama / vLLM 也能跑）。

### 3. 装插件、写人设

把 `plugin/dsh-qq-whale` 挂进你的 DSH profile，然后重载插件（或重启 DSH）。

编辑 `persona/core.md`（从 `persona/core.example.md` 复制一份改），写你自己想要的性格。
**不要照抄示例** —— 照抄出来的是别人家的角色。

---

## 目录结构

```
plugin/dsh-qq-whale/   插件本体（lib 逻辑 + assets 界面挂件）
console/               独立控制台前端
tools/                 启动器、看门狗、二维码、构建脚本、测试
persona/               人设文件（core.example.md 是模板）
config/                配置示例
docs/                  文档
```

## 文档

| 文档 | 讲什么 |
|---|---|
| `docs/deploy.md` | 完整部署流程 |
| `docs/INSTALL-AND-ROLLBACK.md` | 装坏了怎么退回 |
| `docs/llm-adapter.md` | 换成你自己的模型接口（含降档链七层的真实行为） |
| `docs/gateway-workbuddy.md` | 用某家网关账号跑（可选，只讲协议与坑） |
| `docs/persona-guide.md` | 人设怎么写 |
| `docs/memory-guide.md` | 记忆怎么长出来、怎么审 |
| `docs/github-upload.md` | 想自己发一份到 GitHub 看这个 |
| `docs/console-contract.md` | 控制台 API 契约 |

## 安全边界（重要）

- 干活会话的 cwd 固定在一个**沙箱目录**，不是你的项目目录。
- 写工具受保护路径清单约束：项目源码、插件安装目录、配置文件一律 `DENY`。
- 被拦下的改动进 `pending-code.json`，**必须主人点头**才执行。
- 机器人没有 `ask_user_question` 能力（QQ 里没人能点弹窗），单轮硬超时 180 秒。

## 许可

MIT，见 `LICENSE`。
