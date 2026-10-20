# 接你自己的 API（模型后端配置指南）

> 这份文档解决一个问题：**我不想用 WorkBuddy，能不能接自己的 API？**
> 能。而且接了之后，这条链路比 `gateway-workbuddy.md` 那条稳定得多：没有加密凭据要解、没有客户端升级风险、不用怕"悄悄花钱"。

---

## 1. 先搞清楚有两条完全不同的链路

这个项目里「模型」出现在**两个地方**，很多人配错就是混了这两层：

| 链路 | 谁在用 | 配在哪 | 用途 |
|---|---|---|---|
| **A. QQ 聊天** | 插件自己直连 | `cordis.patch.yml` 里 `dsh-qq-whale` 的 `config` | QQ 里说话的那个"她" |
| **B. 干活会话** | DSH 宿主 | `cordis.patch.yml` 里 `llm-*` 插件的 `providers` | 命令执行、写代码、子 agent |

**A 走 `modelBackend`；B 走宿主 provider 配置。** 两者可以指向同一个服务，也可以完全不同 —— 例如 QQ 聊天用便宜的 flash，干活用强的模型。

如果你只想让 QQ 聊天用你的 API，只改 A 就行。想让"命令"也用，B 也得改。

---

## 2. A 链路：`modelBackend` 三选一

```yaml
- id: dsh-qq-whale
  name: 'dsh-qq-whale'
  config:
    modelBackend: wbai        # wbai | wb-proxy | dsh
```

| 值 | 含义 | 什么时候用 |
|---|---|---|
| `wbai` | 直连 WorkBuddy 桌面端凭据 | 有 WorkBuddy 账号 |
| `wb-proxy` | 连本地多账号池网关 | 有 `workbuddy2api-hub` 之类 |
| **`dsh`** | **走宿主 `ctx.llm`** | **接自己的 API —— 就是这个** |

选 `dsh` 之后，真正决定模型的是这两个字段：

```yaml
    modelBackend: dsh
    provider: my-openai          # 宿主 providers 里的 key，见第 3 节
    model: my-model-id           # 那个服务里的模型 id
    maxTokens: 1024
    temperature: 0.85
    reasoningEffort: ''          # 有的模型支持 low/medium/high，不支持就留空
```

**注意 `provider` 不是随便写的名字**，它必须和你宿主的 `llm-pi-ai`（或其它 llm 插件）里 `providers:` 下的 key 完全一致。填错的症状是启动日志里出现 `xxx 不可用 —— 消息会收到但无法回复`。

---

## 3. B 链路：在宿主里注册一个 OpenAI 兼容 provider

DSH 的 provider 配置长这样（`cordis.patch.yml`）：

```yaml
- id: llm-pi-ai
  name: "@deepseek-ai/dsh-llm-pi-ai"
  config:
    providers:
      my-openai:
        displayName: "我的 API"
        api: openai-completions
        baseURL: "https://your-endpoint.example.com/v1"
        headers:
          Authorization: "Bearer ${MY_API_KEY}"
        defaultInput: [ text ]
        models:
          - id: my-model-id
            contextWindow: 128000
```

逐字段说明：

| 字段 | 说明 |
|---|---|
| key（`my-openai`） | 你要给这家的名字。`dsh-qq-whale` 的 `provider` 填这个 |
| `api` | 接口形态。OpenAI 兼容就填 `openai-completions` |
| `baseURL` | **到 `/v1` 为止**，不要带 `/chat/completions`。客户端自己拼 |
| `headers` | 认证头。`${VAR}` 会从环境变量取 |
| `defaultInput` | 默认支持的输入类型。纯文本模型填 `[ text ]`，多模态填 `[ text, image ]` |
| `models[].id` | 服务端的模型 id，**必须和它 `/v1/models` 里的一致** |
| `models[].contextWindow` | 上下文窗口。填小了会被提前截断，填大了超限会 4xx |

**为什么 `baseURL` 只到 `/v1`**：这套适配器内部会拼 `/chat/completions`。你多写一段就变成 `/v1/chat/completions/chat/completions`，症状是 404 —— 而这个 404 长得非常像"服务没起来"。

---

## 4. 你的服务最少要满足什么

### 4.1 必需：`POST {baseURL}/chat/completions`

请求体（OpenAI 标准）：

```jsonc
{
  "model": "my-model-id",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "在吗" }
  ],
  "max_tokens": 1024,
  "temperature": 0.85,
  "stream": true
}
```

### 4.2 必需：**流式**（SSE）

服务端要能处理 `"stream": true`，按标准的 `data: {...}` 帧返回，最后一帧 `data: [DONE]`。

非流式也能接，但体验会明显差：你说一句话要等好几秒才有反应，而且"边想边说"的效果全没了。

### 4.3 强烈建议：`usage`

响应（或流的最后一帧）带 `usage`：

```jsonc
{ "usage": { "prompt_tokens": 812, "completion_tokens": 96, "total_tokens": 908 } }
```

没有 `usage` 的后果：本项目的积分记账（`budget.js` / `spare-budget.js`）只能记 0。你自己的服务如果不按量计费，这没影响；如果需要控额度，就必须给。

OpenAI 兼容的流式服务要把 `usage` 放在流末尾，记得在请求里带：

```jsonc
"stream_options": { "include_usage": true }
```

### 4.4 建议：`GET {baseURL}/models`

用于健康检查和模型列表。没有也能跑（会退化成"启动时不知道模型在不在"），但排错会难很多。

### 4.5 可选：多模态

只有你需要"看表情包 / 看别人发的图"时才需要。格式是 OpenAI 的块数组：

```jsonc
{
  "role": "user",
  "content": [
    { "type": "text", "text": "描述这张图" },
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,..." } }
  ]
}
```

不支持的话就把 provider 的 `defaultInput` 写成 `[ text ]`，别让它误以为能看图。

---

## 5. 本地服务接法

### 5.1 Ollama

```powershell
ollama serve
ollama pull qwen2.5:7b
```

宿主配置：

```yaml
    providers:
      ollama:
        displayName: "本地 Ollama"
        api: openai-completions
        baseURL: "http://127.0.0.1:11434/v1"
        headers: {}
        defaultInput: [ text ]
        models:
          - id: qwen2.5:7b
            contextWindow: 32768
```

插件侧：

```yaml
    modelBackend: dsh
    provider: ollama
    model: qwen2.5:7b
```

**两个坑**：

- Ollama 的模型 id 带冒号（`qwen2.5:7b`），YAML 里要用引号包起来，否则冒号后面会被当成新的一层；
- 默认上下文窗口比你以为的小得多，显式写 `contextWindow`，别让它猜。

### 5.2 vLLM

```bash
python -m vllm.entrypoints.openai.api_server \
  --model Qwen/Qwen2.5-7B-Instruct \
  --served-model-name my-model \
  --port 8000
```

```yaml
    providers:
      vllm:
        displayName: "本地 vLLM"
        api: openai-completions
        baseURL: "http://127.0.0.1:8000/v1"
        headers: {}
        defaultInput: [ text ]
        models:
          - id: my-model
            contextWindow: 32768
```

**`--served-model-name` 就是 `models[].id`**。忘了指定的话，id 会变成一大串带斜杠的路径，容易配错。

### 5.3 任意 OpenAI 兼容云服务

任何号称"OpenAI 兼容"的服务，把 `baseURL` + `Authorization` 填上就行：

```yaml
    providers:
      my-cloud:
        displayName: "我的云 API"
        api: openai-completions
        baseURL: "https://api.example.com/v1"
        headers:
          Authorization: "Bearer ${MY_API_KEY}"
        defaultInput: [ text ]
        models:
          - id: model-a
            contextWindow: 128000
```

**`${MY_API_KEY}` 从环境变量读**，别把 key 明文写进 yml —— 这份 yml 会被备份、被同步、被不小心发出去。

---

## 6. 降档链：为什么限流了还能继续说话

这是本项目和"直连 OpenAI" 最大的体验差别。降档链的完整顺序（按 engine.js 的实际实现）：

```
① 主脑：modelBackend 指定的模型
        │
        ├─ 非限流错误 ──▶ 直接放弃（不重试，这一轮不回复）
        │
        └─ 429 限流
              │
              ├─▶ ② 回退 wbai 直连     （只有 wb-proxy 后端有这一层）
              │
              ├─▶ ③ 换 flavor          （只有 wbai / wb-proxy 有；dsh 后端跳过）
              │
              ├─▶ ④ 低频重试           默认 4s → 9s → 18s
              │
              ├─▶ ⑤ 备用脑             便宜但收费的模型，有日限
              │
              ├─▶ ⑥ 降智接盘           换弱模型 + 砍上下文 + 要求说短
              │
              └─▶ ⑦ 说一句人话         保证不会静默
```

这七层是**依次尝试**的，前一层成功就不再往下走。

注意一个例外：**非限流的错误（401、404、500、超时等）不会走下面任何一层**，这一轮直接不回复，日志里记一条 `模型调用失败`。降档链是专门为「429 限流」设计的，不是万能兜底 —— 所以接完新服务第一件事是按第 8 节验通，别指望限流链救配置错误。

对应配置：

| 层 | 配置项 | 说明 |
|---|---|---|
| ① 主脑 | `model` | 你选的模型 |
| ② 回退 wbai | `gatewayToWbaiFallback` | 只在 `wb-proxy` 后端有意义 |
| ③ 换 flavor | 无（自动） | 只在 `wbai` / `wb-proxy` 后端下有意义；`dsh` 后端跳过 |
| ④ 重试 | `rateLimitRetryWaits` | 默认 `[4000, 9000, 18000]` |
| ⑤ 备用脑 | `spareEnabled` / `spareModel` / `spareDailyCap` | 日限按**积分**算，不是次数 |
| ⑥ 降智 | `creditFallbackTrae` / `rateLimitFallbackTrae` / `traeModel` | 降智 = 换弱模型 + 砍上下文 + 明确要求说短 |
| ⑦ 说人话 | 无（自动） | 兜底，一定会回一句 |

### 6.1 关于 `fallbackEnabled`：它现在不接线

`fallbackEnabled` / `fallbackProvider` / `fallbackModel` 这三个配置项在配置里是有的，启动时也会按它建一个模型调用对象，**但当前版本的代码里没有任何地方调用它**。也就是说：

- 填了它，不会真的触发跨 provider 兜底；
- 限流的最终结局是第 ⑦ 层 —— 说一句人话；
- 挂件上显示的"兜底模型"标签，只是把这个配置值原样显示出来，不代表它生效了。

配置项留着是为了以后接线，**现在改它没有任何效果**。真正会救场的三层是 ⑤ 备用脑、⑥ 降智、⑦ 说人话。

### 6.2 想让限流后还能聊，实际该配什么

既然跨 provider 兜底不生效，那"主模型挂了还能继续说话"就得靠另外两层：

1. **备用脑**（`spareEnabled`）：同一家上游的便宜模型，有独立日限。它是为 WorkBuddy 积分池设计的，接自己的 API 时可以开着，只要那个 provider 下确实有配置里写的模型；
2. **降智接盘**（`creditFallbackTrae` / `rateLimitFallbackTrae`）：走宿主侧的另一个 provider（默认 `trae`），这一层是真的会调用的。

如果你的 API 服务本身很稳、限流很少见，那两层都可以关掉，只留第 ⑦ 层说人话 —— 这是最省心的配置。

### 6.3 「降智」到底降了什么

不只是换模型，还做了三件事：

1. **砍上下文**：`traeContextLimit` 默认 12 轮，不再带满历史；
2. **砍输出**：`traeMaxTokens` 默认 512；
3. **改 system prompt**：明确写"你现在脑子不够用，先说重点、说短点"。

第 3 条是很多人想不到但很关键的一点 —— 只砍 token 不告诉她，她会按完整思路铺开长回复，然后被从**句子中间**截断，发出去就是半句话。这比不说话更难看。

### 6.4 用 `dsh` 后端时降档链还剩多少

`dsh` 后端下没有"回退 wbai"和"换 flavor"这两层（那不是同一个上游的概念），但重试、备用脑、降智、说人话**都还在**。

**最小可用配置**（只有一个模型，没有任何降档）：

```yaml
    modelBackend: dsh
    provider: my-openai
    model: my-model-id
    spareEnabled: false
    creditFallbackTrae: false
    rateLimitFallbackTrae: false
```

这样限流了就一直重试到 ④，然后直接说人话，不会切到你没配的东西上。

**带救场的配置**（限流后换弱模型接着说）：

```yaml
    modelBackend: dsh
    provider: my-openai
    model: my-model-id
    rateLimitRetryWaits: [4000, 9000]   # 重试间隔，别等太久
    spareEnabled: false                 # 备用脑是为 WorkBuddy 积分池设计的，接自己的 API 时关掉
    creditFallbackTrae: true            # 允许降智接盘
    rateLimitFallbackTrae: true         # 限流时也走降智
    traeProvider: my-backup             # 接谁的弱模型（默认 trae，换成你自己的 provider）
    traeModel: cheap-model-id           # 那个 provider 下的便宜模型
    traeMaxTokens: 512
    traeContextLimit: 12
```

注意 `traeProvider` / `traeModel` 这两个名字虽然带 trae，但填什么 provider 都行 —— 它们指的是"降智时用哪个模型"，不是"必须用 trae"。

**一个真机上踩过的坑**：降级模型不要配成"同一家 provider 的另一个模型"。同一家的不同模型常常共用一份额度，主模型 429 的时候兄弟模型一样 429，结果配了也没用。要换就换个上游。

---

## 7. 三个会话各自的模型（干活链路专用）

`dsh-qq-whale` 还有一组配置，用来指定**三种会话**分别用哪个模型：

```yaml
    chatModel: { provider: "my-openai", model: "cheap-model" }    # 闲聊
    workModel: { provider: "my-openai", model: "strong-model" }   # 干活
    codeModel: { provider: "my-openai", model: "code-model" }     # 写代码
```

这三个**只影响干活会话**（`ctx.agents.create` 的 agentOptions），不影响 QQ 里裸聊走的那条路 —— 后者用的是第 2 节的 `model`。

老写法 `workModel: 'kimi-k2.6'`（纯字符串）仍然兼容，会退化成"用当前 provider + 这个 model"。

---

## 8. 检查清单：接完怎么验

按顺序，一步不过就别往下：

1. **服务本身通**：`curl {baseURL}/models` 返回 200 + JSON；
2. **模型 id 对得上**：返回的 `data[].id` 里有你写的那个；
3. **非流式能回**：`POST /chat/completions` 加 `"stream": false`，拿到完整 JSON；
4. **流式能回**：`"stream": true`，能看到 `data:` 帧、最后有 `[DONE]`；
5. **usage 有值**：流最后一帧或非流式响应的 `usage.total_tokens > 0`；
6. **DSH 认得这个 provider**：宿主日志里没有 `xxx 不可用`；
7. **QQ 里有回复**：私聊发一句，能收到（不是"消息会收到但无法回复"）。

哪一步断了，对应的排错在文末。

---

## 排错

### 1. `xxx 不可用 —— 消息会收到但无法回复`

启动日志里出现这句，说明 provider 建不起来。三种原因：

- **`provider` 名字写错**：必须和宿主 `llm-pi-ai` 的 `providers:` key 完全一致（大小写敏感）；
- **宿主根本没注册这个 provider**：去 `cordis.patch.yml` 的 `llm-pi-ai` 块里确认；
- **改完 yml 没重载插件**：改了 `dsh-qq-whale` 的 config 需要重载插件；改 `llm-pi-ai` 的 providers 通常需要重启宿主。

### 2. 404，但 `curl` 直接测服务是通的

95% 是 `baseURL` 写多了或写少了。规则：**到 `/v1` 为止**。

- 多了：`https://x.example.com/v1/chat/completions` → 会变成 `.../chat/completions/chat/completions`
- 少了：`https://x.example.com` → 会变成 `https://x.example.com/chat/completions`（缺 `/v1`）

先用 `curl {你的 baseURL}/models` 试，这个能通就说明 baseURL 对了。

### 3. 有回复，但"看图"一直说看不到

两个地方要同时改：

1. provider 的 `defaultInput` 要包含 `image`；
2. `models[].input` 没被单独钉成 `[ text ]`。

有一个模型层级会覆盖 provider 层级 —— 如果某个模型单独写了 `input: [ text ]`，那它永远不吃图，provider 写什么都没用。

### 4. 回复被从句子中间截断

`maxTokens` 太小。注意区分：

- **正常用完**：模型自己说完了，`finish_reason` 是 `stop`；
- **被截断**：`finish_reason` 是 `length`，回复结尾是半句话。

`length` 就调大 `maxTokens`。但也别设太大 —— 有的服务对 `max_tokens` 加上下文有总额限制，会直接 400。

### 5. 降级后还是不通 / 反而更慢

按这个顺序查：

- 你改的是不是 `fallbackProvider`？**它不接线，改了没效果**，见 6.1；
- `rateLimitRetryWaits` 是不是设得太长？默认 `[4s,9s,18s]` 最坏要等 31 秒才降级，用户会觉得"她不理我了"。想更快就改短。
- `spareEnabled` 开着但 `spareModel` 指向一个不存在的模型？接自己的 API 时建议直接 `spareEnabled: false`。
