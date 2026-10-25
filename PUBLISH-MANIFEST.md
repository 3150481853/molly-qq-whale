# PUBLISH MANIFEST

> 本副本由 `tools/build-publish.mjs` 生成，**勿手改**；要改就改源仓库再重新生成。

- 生成时间：2026-10-25T14:16:25.448Z
- 文件数：**165**
- 总体积：**2.77 MB**
- 脱敏复检：**命中 0**

## 顶层结构

| 路径 | 说明 |
|---|---|
| `plugin/dsh-qq-whale/` | 插件本体：`lib/` 逻辑代码、`assets/` 挂件、`package.json` |
| `console/` | 控制台前端四件套（index/console.js/console.css/molly.ico） |
| `tools/` | 运维与测试脚本（控制台服务、守护、构建、测试用例） |
| `docs/` | 安装、部署、契约文档（已脱敏） |
| `persona/core.example.md` | **示例人设**，部署时请写你自己的 |
| `config/*.example.*` | 配置样例，凭据全是 `${ENV}` 占位符 |
| `memory.example.json` | 记忆结构示例（3 条虚构内容） |

## 刻意不放进来的东西

| 不发的 | 原因 |
|---|---|
| `napcat/` | 第三方前端构建产物 + 含 token 的配置 |
| `out/`、`*.log` | 运行日志、审计产物、聊天截图 |
| `dist/` | 打包好的 exe（体积大、可重打） |
| `restore-points/`、`*.bak-*` | 历史快照，全是真实值 |
| `stickers/` | 表情包文件名自带真人关键词 |
| `persona/core.md` | 真实人设（已改成 `core.example.md`） |
| `memory.json` / `pending.json` / `gatekeeper.json` | 真实记忆与审批数据 |

## 被丢弃的文件（脱敏后仍不合格）

（无）

## 已就地替换成 `<REDACTED>` 的文件

- tools/start-molly.ps1
- tools/heartbeat-push.mjs
- tools/setup-quicklogin.ps1
- tools/snowluma-start.ps1
- tools/voice-sovits-start.ps1
- tools/scan-secrets.mjs
- tools/build-publish.mjs
- docs/INSTALL-AND-ROLLBACK.md
- docs/deploy.md
- docs/g-migration-contract.md
- docs/server-deploy-plan.md
- tools/test-workshop.mjs
（这些文件里有形似令牌/绝对路径的常量，已替换为占位符；功能不受影响，但如果你是原作者，请用真实值重新生成。）

## 你要做的

1. `git init` 后自己推；本脚本不执行任何 git 写操作。
2. 配置写在你 DSH profile 的 `cordis.patch.yml`（参考 `config/cordis.patch.example.yml`）；`config.example.json` 只是字段形状示例，插件不读它。
3. 写自己的 `persona/core.md`（参考 `core.example.md` 的结构）。
4. 首次运行前跑一次 `node tools/scan-secrets.mjs` 自查。
