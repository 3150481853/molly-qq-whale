# AGENTS.md

给**改这个仓库的 AI** 看的：能直接执行的约束与检查，不写故事。人类向的说明在 `README.md`；踩坑背景在 `plugin/dsh-qq-whale/docs/MEMORY-OPTIMIZATION.md`。

## 地图

| 路径 | 是什么 |
|---|---|
| `plugin/dsh-qq-whale/lib/` | 主插件（QQ 通道 + 引擎 + 记忆）。`memory.js` 是记忆的唯一真相来源 |
| `plugin/dsh-qq-whale/lib/memory.js` | 七类记忆分片、写入、召回、衰减、改口、相对日期、计划判定 |
| `plugin/dsh-qq-whale/lib/sidecar.js` | 本地向量/重排服务的同步客户端（失败必须返回 `null`） |
| `plugin/dsh-qq-whale/lib/engine*.js` | 对话主循环、上下文拼装、决策 |
| `plugin/dsh-qq-pest/lib/` | 独立包（骂人模式），主包拿不到时自动降级 |
| `jasmine/` | 记忆底座（按需加载） |
| `tools/embed-server.py` | 向量 + 重排本地服务（stdlib + torch） |
| `tools/build-publish.mjs` | 生成发布副本（白名单复制 + 脱敏双闸） |
| `console/` | 本地控制台页面 |

## 硬约束

1. **零 npm 依赖。** 只用 Node 内置模块。新增 `dependencies` 视为破坏性改动。
2. **只走 `build-publish.mjs` 发布。** 白名单在 `tools/build-publish.mjs` 的 `DIRS` / `FILES`；新文件不登记就等于不发布，且下一次构建的孤儿清理会把它删掉。
3. **ESM。** 用 `import`，不要 `require`。绝对路径导入写 `file:///G:/...`，写 `G:/...` 会 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。
4. **`memory.js` 的 `MEMORY_KINDS` 是七类的唯一定义。** 别在别处硬编码类型列表；别新增类型而不改迁移/归档/预算相关分支。
5. **不要在生产库上跑测试。** 生产库默认 `${MOLLY_ROOT}\data\qq-whale`（见 `cordis.patch.yml` 的 `dataDir`）。测试用副本，或显式加 `--allow-prod` 并自知后果。
6. **不要两个进程同时写同一批分片。** 后写的覆盖先写的。改数据前先停插件；`check-prod` 这类自检脚本自己会 load+save。
7. **改完必须 `node --check`。** 仓库没有 CI，这是唯一的静态闸。

## 记忆系统不变量（改 recall / add 之前先读）

- `recall()` 是**同步**函数：链路上没有 `await` 的位置。需要外部服务时用同步 HTTP（`execFileSync('curl.exe', …)`），失败返回 `null` 并退回关键词。
- 条目字段（写盘形状）：`id, kind, who, qq, text, weight, at, hits, lastHitAt, lastActiveDay, edges, supersededBy, supersededAt, source, level, tense, dueAt, unfulfilled, mergedInto, repeats`。**判不出来就不写**，不要塞 `null`/`''` 占位（老库形状要能继续加载）。
- `supersededBy` 只在**取代者仍存在**时才降权（`liveIds` 判断）。否则旧条目永久背锅。
- `mergedInto` 的条目**不参与召回、不参与 IDF**（`active` 列表过滤）。
- 降权 ≠ 删除：`unfulfilled`、`superseded`、跨人、全群摘要都只乘系数，正文一律保留。
- 跨人条目：指标名太强会挤掉别人；只降分不够时（如全群摘要）要**同时排除出候选池**。
- 预算按**截断后长度**记账（`Math.min(len, entryChars)`），超长条目 `continue` 而非 `break`。

## 跑起来

```bash
# 语法
node --check plugin/dsh-qq-whale/lib/memory.js

# 单元测试（全部应 0 失败；test-memory.mjs / test-memory-race.mjs / test-memory-qq.mjs
#   是记忆库分片化之前的陈旧用例，已知失败，不是回归）
node tools/test-memory-graph.mjs
node tools/test-memory-pending.mjs
node tools/test-memory-quality.mjs
node tools/test-engine.mjs
node tools/test-command-fixes.mjs

# 发布副本（失败会 exit 1 且不出清单）
node tools/build-publish.mjs

# 向量/重排服务（可选，需 torch + transformers + 两个 bge 模型）
python tools/embed-server.py --port 8791 --models <models-dir>
curl -s http://127.0.0.1:8791/health   # {"ok":true,"dim":512,"rerank":true,"hits":N}
```

## 环境变量

| 变量 | 作用 |
|---|---|
| `MOLLY_EMBED_OFF=1` | 完全关闭向量/重排，只走关键词 |
| `MOLLY_EMBED_URL` / `MOLLY_EMBED_PYTHON` / `MOLLY_EMBED_SCRIPT` / `MOLLY_EMBED_MODELS` | 覆盖 sidecar 地址、解释器、脚本、模型目录 |
| `MOLLY_TENSE=0` | 关闭「计划 / 已发生」判定 |
| `MOLLY_TOPIC_MERGE=1` | 打开写入侧同题合并（默认关，实测中性） |
| `MOLLY_DATA_DIR` | 覆盖数据目录；指向生产库时自检脚本会拒绝执行（除非 `--allow-prod`） |

## 提交前清单

- [ ] `node --check` 通过
- [ ] 单元测试无**新增**失败（对比改动前的已知失败集）
- [ ] 召回行为变化有数字支撑（同一份语料、同一套判据、逐格对比），否则默认关闭并留开关
- [ ] 新文件已登记进 `tools/build-publish.mjs` 白名单
- [ ] `node tools/build-publish.mjs` 退出码 0，脱敏复检命中 0
- [ ] 文档同步：人类向改 `docs/MEMORY-OPTIMIZATION.md`，AI 向改本文件
